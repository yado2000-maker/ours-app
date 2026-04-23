# Design — `update_event` / `update_reminder` in group path

**Date:** 2026-04-23
**Author:** brainstormed with Yaron, session resumes handoff from prior worktree
**Status:** approved, ready for writing-plans

## Problem

Group path has no UPDATE capability for events or reminders. Corrections like "תתקני שיחה עם סאם להיום" or "תעבירי את התזכורת ל-18:00" currently route through `handleCorrection`, which delete+reinserts via re-classification. Partial failures leak state (duplicate rows, orphans) and there's no way to express "change only the time." Live incident on 2026-04-23 in Roi's household produced a double-inserted `בדיקת דירה` on both Fri and Sat plus a user-visible `Event-exists:` debug token leak.

The 1:1 path already has a working table-driven CRUD handler at `index.inlined.ts:5078-5134` covering `update_shopping / update_task / update_event / update_reminder / remove_*`, driven by Sonnet-emitted `<!--ACTIONS:-->` blocks. The group path does not use Sonnet-ACTIONS at all.

## Decision — Option B, gated on `correct_bot`

Route `correct_bot`-classified group messages through a new dedicated Sonnet call that emits structured JSON (update / remove / clarify). Bypass the old `handleCorrection` delete+reinsert entirely. Extract the 1:1 CRUD handler into a shared helper `executeCrudAction(householdId, action, logPrefix)` and call it from both paths.

Rejected alternatives:
- **Haiku-driven intents** — weaker on ambiguous Hebrew corrections + relative-date parsing.
- **Always-on Sonnet-ACTIONS in group** — pays the Sonnet cost on every message where Haiku was sufficient.
- **Hybrid** — more moving parts, no material benefit over B.

## Control flow

```
inbound → Haiku classify → intent == correct_bot?
   ├─ yes → handleCorrection_v2
   │         ├─ gather candidates: recent events (last 24h) + active reminders (sent=false), max 10
   │         ├─ gather context: last 15 min of group messages + last 5 Sheli replies
   │         ├─ Sonnet call via buildCorrectionPrompt → structured JSON
   │         ├─ dispatch:
   │         │   ├─ update → executeCrudAction
   │         │   ├─ remove → executeCrudAction
   │         │   └─ clarify → sendAndLog clarification, no DB change
   │         └─ reply with apology + confirmation summary
   └─ no → existing flow (haikuEntitiesToActions → executeActions)
```

- Old `handleCorrection` at L11367-11481 is **deleted**, not wrapped. No silent-drift fallback.
- Shopping batching unaffected — `correct_bot` already bypasses it.
- `classification` stays `correction_applied` on success; new values `correction_clarify` and `correction_error` for observability.

## Sonnet prompt + output schema

**New function:** `buildCorrectionPrompt(correctionMessage, recentContext, candidateRows, recentSheliActions)` → returns Hebrew-first prompt with:

- Last 15 min of group messages (newest last, sender names).
- Last 5 Sheli replies with relative timestamps.
- Candidate rows injected as `[<id>] <type>: "<title>" — <when>`, max 10.
- The correction text verbatim.
- Instruction to return exactly one JSON object.

**Three output shapes:**

```json
{"action":"update","target_id":"abc12345","target_type":"event","new_scheduled_for":"2026-04-25T09:00:00+03:00","new_title":null}
{"action":"remove","target_id":"def67890","target_type":"reminder"}
{"action":"clarify","reason":"ambiguous_target","ask":"לאיזה בדיקה התכוונת — של שישי או של שבת?"}
```

**Prompt rules:**
- Never invent a `target_id` not in the candidate list → `clarify`.
- ISO 8601 with explicit `+03:00` / `+02:00` offset (DST-aware per `toIsraelTimeStr`).
- Omit or null fields that don't change.
- `clarify.ask` is the exact Hebrew message sent back to the group.

**Server-side validation:**
- Strict `JSON.parse` with try/catch; malformed → generic clarify.
- Validate `target_id` ∈ candidate list before dispatch; mismatch → clarify.
- Validate ISO timestamp in range (not in past >1 day, not >2 years future) → clarify.

## Shared CRUD helper

Extracted from L5078-5134:

```ts
async function executeCrudAction(
  householdId: string,
  action: CrudAction,
  logPrefix: string,
): Promise<{ ok: boolean; summary: string; error?: string }>
```

Supported actions: `update_event`, `update_reminder`, `remove_event`, `remove_reminder`.

**Two safety guards added during extraction (benefit 1:1 too):**
1. Explicit `household_id` in every WHERE clause — defense in depth beyond RLS.
2. `sent = false` guard on reminder updates — updating a fired reminder is a no-op with Hebrew message "התזכורת כבר נשלחה, לא יכולה לשנות".

**Remove semantics:**
- `remove_event` → hard DELETE.
- `remove_reminder` → soft-cancel (`sent = true, metadata.cancelled_by_user = true`) to preserve audit trail per existing reminder-cancel convention.

**Return drives reply:** `{ok:true, summary}` → Sheli says summary with "סליחה" prefix; `{ok:false, error:"not_found"}` → "לא מצאתי את השורה הזאת"; `{ok:false, error:"already_sent"}` → "התזכורת כבר נשלחה".

## Context fed to Sonnet (Q3 decision)

Full situational awareness (option D):
- Last N=10 group messages in time window ≤15 min.
- Target row(s): all candidate events + reminders, not just the one `handleCorrection` guesses — Sonnet picks.
- Last 5 Sheli replies to the group, with "לפני X דק'" timestamps.

Rationale: Roi incident showed Sheli herself is part of the thread. Without her recent action context, "תתקני להיום" can't resolve against "הוספתי מחר" from 2 minutes prior.

## Testing

8 integration tests in new `TestCorrectBotV2` class in `tests/test_webhook.py`, pattern per `TestPrivateDmReminders`:

1. Time-only update preserves id.
2. Date-only update preserves id.
3. Reminder time shift preserves id, `sent=false`.
4. Remove event — hard delete, no redo, apology.
5. Ambiguous multi-match — clarify, no DB change.
6. Regression: `Event-exists:` debug token never in outbound.
7. Fired reminder — no-op, "כבר נשלחה".
8. Malformed Sonnet JSON (mocked) — clarify fallback.

TDD: write all 8 first, confirm red, implement to green.

## Rollout

1. Stay on current worktree.
2. esbuild parse-check after every `index.inlined.ts` edit.
3. Dashboard paste → fetch deployed via `mcp__f5337598__get_edge_function` → paste-corruption regex scan.
4. Smoke test on `972552482290` in a test group (3 corrections: time, date, remove).
5. Monitor `whatsapp_messages` for 24h: count `correction_applied` / `correction_clarify` / `correction_error`.
6. No feature flag. Rollback = `git revert` + re-paste.

## Cost

~$0.01 per correction × estimated 5-10 corrections/day across all households = ~$0.05-0.10/day. Negligible.

## Out of scope

- `update_task` / `update_shopping` in group — delete+reinsert remains acceptable for whole-record changes.
- Multi-row corrections — clarify, one row at a time.
- `complete_task` / `claim_task` corrections — existing mention-correction path handles these.
- Monthly recurrence schema (tracked separately).
- Bug 6 (`add_event` +1 day drift on "מחר") (tracked separately).

## Acceptance

All 8 integration tests pass. Roi-style incident reproduced in test harness and fixed. No `Event-exists:` token in any outbound reply. `correction_applied` / `correction_clarify` / `correction_error` visible in `whatsapp_messages` for post-deploy observability.
