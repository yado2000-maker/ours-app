# Handoff: ship `update_event` + `update_reminder` in the group path

**Context date:** 2026-04-23. Copy this whole file as the opening prompt to a fresh session.

---

## What Sheli is (30 seconds)

Sheli (שלי) is a Hebrew-first family-coordination WhatsApp bot. Users add her to a family group (or DM her 1:1), and she records tasks, shopping items, events, reminders, and expenses via Hebrew natural-language messages. She fires time-based reminders back into the chat. The bot is a single Supabase Edge Function (Deno / TypeScript). Classification is a two-stage pipeline: Haiku 4.5 classifier → Sonnet 4 reply generator.

- **Repo root:** `C:\Users\yarond\Downloads\claude code\ours-app\`
- **Deployed file (prod):** `supabase/functions/whatsapp-webhook/index.inlined.ts` — ONE ~11,500-line file, this is what actually ships.
- **Project CLAUDE.md:** read `CLAUDE.md` at repo root first — it has dozens of production gotchas; your changes must respect them.
- **Supabase project id:** `wzwwtghtnkapdwlgnrxr` (use MCP tool `mcp__f5337598__execute_sql` / `mcp__f5337598__get_edge_function` / `mcp__f5337598__deploy_edge_function`).
- **Deploy path:** paste `index.inlined.ts` into Supabase Dashboard → Edge Functions → `whatsapp-webhook` → Code → Deploy. Paste-corruption is a known issue (see "Known traps" below).

## The bug you're fixing

When a user says "תתקני שיחה עם סאם — היום" ("fix: call with Sam is today") after Sheli already saved the event for tomorrow, today Sheli responds with a warm "thanks for correcting me!" but **the event's `scheduled_for` is never updated**. Similarly, "תעבירי את התזכורת ל-18:00" on an existing reminder doesn't update — it might delete+reinsert, might not, and in partial-failure cases creates duplicates.

**Root cause:** the group path's `handleCorrection` + `executeActions` has no `update_event` or `update_reminder` capability. It only does raw delete + reinsert via `undoLastAction` + re-classify(correction_text) + execute. If either leg fails, state drifts. There's also no way to express "change only the time" without deleting the whole row.

Live example from 2026-04-23 in Roi's household (`hh_u11z4jt1`):

- 12:35 — add_event: `בדיקת דירה בהנטקה @ Fri 08:00`.
- 12:35:45 — partner says "ב-9:00 שעון ישראל". Classified as `correct_bot`. Handler undoes the bedika entirely (cancels, doesn't reschedule to 09:00).
- 12:36 — Tsahi says "לא לבטל — יש בדיקת דירה ב-08:00 מחר". Handler reclassifies as `add_event`, inserts a NEW row at Sat 08:00 (wrong day, separate bug). Event is now on both Fri and Sat via two separate inserts.
- 12:40 — Tsahi says "תתקני שיחה עם סאם — היום". Handler produces reply containing leaked debug token `הוספתי: Event-exists: "שיחה עם סאם..."`. Zero DB change.

The debug-token leak and the silent-ack were already fixed today in commit `a8e2280` — but the underlying "there is no update-action wiring" issue remains. That's your job.

## What's already wired (do not break)

**1:1 path has all 4 update actions working.** `execute1on1Actions` (around line 4765) parses Sonnet-emitted `<!--ACTIONS:-->` blocks and runs them through a unified table-driven CRUD handler at **lines 5078–5134**. The handler covers:

- `update_shopping`: `{"type":"update_shopping","old_name":"פסטה","new_name":"פסטה פנה"}`
- `update_task`: `{"type":"update_task","old_text":"...","new_text":"..."}`
- `update_event`: `{"type":"update_event","old_title":"...","new_title":"...","new_date":"2026-04-20","new_time":"19:00"}`
- `update_reminder`: `{"type":"update_reminder","old_text":"...","new_text":"...","new_send_at":"..."}`

Plus matching `remove_*`. Protocol documented in `ONBOARDING_1ON1_PROMPT` around **lines 4429–4446**.

**The 1:1 prompt already teaches Sonnet how to emit these.** Do not retrain that side.

## What's missing (your work)

**Group path doesn't use Sonnet-emitted ACTIONS at all.** The group pipeline is:

```
inbound msg → Haiku classify → haikuEntitiesToActions() (L11074) → executeActions() (L3217)
```

Sonnet runs *after* actions have already been executed, purely to generate a reply. It has no hook to emit `update_*` — nothing would read it. `executeActions` has `case "add_event"`, `add_task`, `complete_task`, `claim_task`, etc., but ZERO `update_*` or `remove_*`.

Meanwhile `handleCorrection` (line ~11367 → 11481) is a separate path that handles `correct_bot`-classified messages by delete+reinsert, bypassing the whole `executeActions` flow.

## Design decision — pick ONE (this is the only real thinking)

### Option A — Haiku-driven: add `update_event` / `update_reminder` intents

- Haiku classifier learns 2 new intents with structured entities: `{old_identifier (title-like), new_scheduled_for, new_send_at, new_title, new_text}`.
- `haikuEntitiesToActions` gains two new branches.
- `executeActions` gains two new cases that fuzzy-match the old row by title (`isSameEvent` / `isSameTask` already exist), then UPDATE by `id`.
- `handleCorrection` is **unchanged** — it's orthogonal to direct update requests.

**Pros:** consistent with the rest of the group pipeline. Cheap (~$0.0003/call).
**Cons:** Haiku misclassifies ambiguous "fix X"/"change Y" more often than Sonnet would. Entities for "new_date" need DAY ANCHOR awareness. More prompt examples needed.

### Option B — Sonnet-ACTIONS in group: unify group + 1:1 paths

- Teach `buildReplyPrompt` (L1505) to emit `<!--ACTIONS:-->` blocks for updates (and optionally all other CRUD).
- After Sonnet returns, parse ACTIONS and dispatch through a shared CRUD helper extracted from `execute1on1Actions` lines 5078–5134.
- `haikuEntitiesToActions` untouched; group-path still prefers Haiku for adds/completes.
- `handleCorrection` could optionally consult Sonnet for the "did the user want an update?" decision, or stay as-is.

**Pros:** unifies group+1:1 into one CRUD contract. Sonnet is better at reading "תתקני את שיחה עם סאם להיום" and producing a structured update. No Haiku prompt changes.
**Cons:** group path currently skips Sonnet for actionable intents (cost / latency). You'd be adding a Sonnet call where Haiku was sufficient. Need to think through when to fire the Sonnet-ACTIONS path: only for `correct_bot`? Only when the reply text seems to imply an update? Always?

### Recommended

**Option B, gated.** Route `correct_bot` in group mode through a Sonnet call that emits structured ACTIONS when an update is intended, delete+reinsert when it's a pure mention-correction. Keep `handleCorrection`'s current delete+reinsert as the fallback. Extract the 1:1 CRUD handler (L5078-5134) into a shared helper `executeCrudAction(householdId, action, logPrefix)` that both paths call.

Brainstorm first — use the `superpowers:brainstorming` skill to validate this recommendation with the user before coding. The decision affects cost, latency, and which LLM reads the correction. It's reasonable to disagree with me.

## Acceptance criteria

End-to-end, in a group chat, all of these must succeed (write integration tests in `tests/test_webhook.py` — see the existing `TestPrivateDmReminders` class at ~line 2100 for the pattern):

1. Original: `add_event "בדיקת שיניים ביום ד' ב-14:00"`. Correction: `"תתקני לבדיקת שיניים ב-15:00"`. → same event id remains; `scheduled_for` hour becomes 15:00; title unchanged; no duplicate row.
2. Original: `add_event "ארוחה עם סבתא בחמישי"`. Correction: `"תתקני — זה לא חמישי, זה שבת"`. → same id; `scheduled_for` date becomes Saturday; no duplicate.
3. Original: `add_reminder "תזכירי לי מחר ב-8 לקחת ויטמין"`. Correction: `"תעבירי ל-9"`. → same reminder_queue row; `send_at` hour becomes 09:00; `sent=false` preserved; no second insert.
4. Ambiguous: `add_event "ארוחת ערב ב-19:00"`. User says `"תבטלי את זה"` (no new info). → row deleted; NO redo; warm apology only if delete succeeded (current `hasAnyChange` gate from commit `a8e2280` must keep working).
5. Typo-correction: `add_shopping "שמן זית"` saved as two items `[שמן, זית]`. User says `"שמן זית ביחד"`. → old two rows deleted, one row `שמן זית` inserted. This is the existing mention-correction path; must not regress.
6. The `Event-exists:` debug token must never appear in a user-visible reply (regression test — this was fixed today via `translateExecutorSummaryForUser`; confirm the update path doesn't reintroduce the leak).

## Files you will touch

- `supabase/functions/whatsapp-webhook/index.inlined.ts` — single-file edit.
  - Function to extract: the CRUD dispatcher at **L5078–5134**.
  - Function to extend: `executeActions` at **L3217–3757**.
  - Function to rewrite: `handleCorrection` at **L11367–11481** (may become a thin wrapper).
  - Prompt to extend (if Option A): Haiku classifier prompt around **L638+**.
  - Prompt to extend (if Option B): `buildReplyPrompt` around **L1505+** — add the UPDATE/REMOVE blocks the 1:1 prompt already has at **L4429–4446**.

- `tests/test_webhook.py` — add a `TestUpdateActions` class with cases 1–6.

- Optional: `docs/plans/2026-04-23-update-event-reminder-design.md` with your chosen option and rationale.

## Known traps (read CLAUDE.md for full list)

- **Pre-deploy parse check — mandatory.** Run from repo root:
  ```
  npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
  ```
  Supabase's bundler gives cryptic errors; esbuild locally surfaces the real line+column.

- **Nested backticks inside Sonnet/Haiku prompt template literals break the bundler.** Use plain/straight quotes inside prompt strings, never inner backticks.

- **Paste-corruption on Dashboard deploy.** Cursor→Dashboard paste reproducibly injects a stray `ש` mid-identifier in the mixed Hebrew/ASCII sections. After deploy, fetch the deployed source via `mcp__f5337598__get_edge_function` and scan with Python: `re.compile(r"[A-Za-z]{2,}[\u0590-\u05FF]+[A-Za-z]{2,}")`. Hits in code = re-paste. Hits in comments (documenting this exact trap) = fine.

- **Edge Function file is ~630KB / ~173k tokens.** The `Read` tool caps at 25k tokens per read. Use `offset`/`limit`. Do not try to pass the whole file to `deploy_edge_function` via Read — that MCP path fails. Use Dashboard paste.

- **Israel timezone + DST.** Use `toIsraelTimeStr` (L4711) and `formatTimeWithDayLabel` (added today, near L4728) for context rendering. For parsing user-relative time ("מחר", "היום"), use `buildDayAnchor` (L4674) which is DST-safe.

- **`reminder_queue.group_id` has two shapes.** Groups store the full JID `120363...@g.us`. 1:1 reminders store `{phone}@s.whatsapp.net`. `whatsapp_messages.group_id` stores the BARE phone for 1:1. Normalize with `split_part(group_id, '@', 1)` for cross-table comparisons.

- **`reminder_queue` schema reality:** `send_at` (not `scheduled_for`), `sent` boolean + `sent_at` timestamp (not `status`). `reminder_type` CHECK allows `event|briefing|summary|nudge|user` only.

- **Outbound is rate-limited and `bot_settings.outbound_paused` is a recovery flag.** Don't add new send paths. User-initiated reminders fire via `fire_due_reminders_inner()` pg_cron, gated by `bot_settings.reminders_paused`.

- **Never send WhatsApp messages to real users during development.** Respect `BOT_SILENT_MODE` and use the test phone `972552482290`.

## Workflow (do this in order)

1. Read `CLAUDE.md` end to end.
2. Read the file sections I cited above (don't speed-read — the existing code has subtle patterns like `isSameEvent`, `isSameTask`, `toDb`/`fromDb`, `sendAndLog` that you must preserve).
3. Use the `superpowers:brainstorming` skill to decide Option A vs B with the user. Don't skip this — the cost/latency tradeoff matters and the user will have an opinion.
4. Write the plan to `docs/plans/2026-04-23-update-event-reminder-design.md` and `docs/plans/2026-04-23-update-event-reminder-plan.md` (design doc first, plan second — see `superpowers:writing-plans`).
5. Implement behind the `superpowers:test-driven-development` skill — write the 6 integration tests first, confirm they fail, then implement.
6. Parse check → commit → open PR. DO NOT deploy to prod without the user saying "deploy".
7. If/when deployed: fetch source via MCP, run the paste-corruption regex, and verify all 6 markers landed (test names, CRUD helper name, new cases in `executeActions`).

## Current state of recent commits on the branch

Main branch has commits `a8e2280` (4 live bugs fixed) and the latest pronoun-discipline commit. The worktree at `.claude\worktrees\suspicious-leavitt-5aa111\` is where this work happens. Don't `git reset` anything you didn't add yourself.

## Out of scope

- Monthly recurrence schema (different deferred task — see `docs/plans/` for pointers).
- Bug 6 (`add_event` +1 day drift on "מחר") — being fixed separately.
- Sheli's `what's coming up` day-label hallucination — fixed today via `formatTimeWithDayLabel`.
- Expanding Haiku intents beyond update_event / update_reminder (no update_task/update_shopping — those already work in 1:1 via Sonnet ACTIONS; group users can accept delete+reinsert for those since the content is the whole record, not a field subset).

Good luck. Ask the user before making any structural choice; do not deploy without explicit go-ahead.
