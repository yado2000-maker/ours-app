# Webhook Gap Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the ~50% silent-drop gap between Whapi webhook entry (`Deno.serve`) and the DB row in `whatsapp_messages`, so every inbound 1:1 message during the Cloud-API migration window is observable, reconcilable, and recoverable.

**Architecture:** Two-phase, data-driven. Phase 1 = measurement: add uniquely-prefixed `[Webhook:EXIT:*]` logs at every early-return in `Deno.serve` and `handleDirectMessage`, ship, grep for a reliable-drop phone. Phase 2 = minimum viable fix for whichever hypothesis the data implicates (Tier A), plus handler-wide observability insurance that audit-logs every currently-silent `handleDirectMessage` exit (Tier B — shipped with Phase 1 because the change is one-line-per-site and risk is zero). Tier C (Whapi `/messages/list` reconciliation cron) only if data shows history-sync drops (H4).

**Tech stack:** Supabase Edge Function (Deno), Whapi.Cloud provider, Postgres (`whatsapp_messages`, `onboarding_conversations`). `index.inlined.ts` is ~7.9k lines; deploy is Cursor → Ctrl+A → Dashboard paste. Pre-deploy: `npx --yes esbuild ...`. Kill switch 4-layer stays ON.

---

## Hard constraints

1. **Kill switches stay ON.** `BOT_SILENT_MODE=true`, `bot_settings.{outbound_paused,nudges_paused,reminders_paused}='true'`. Instrumentation is kill-switch-safe: `console.log` + `logMessage` (DB write only) trigger zero `net.http_post`.
2. **No mass-messaging.** Tier C (if needed) is DB-write-only at first. User-visible fan-out needs a separate plan.
3. **Dashboard paste only.** MCP `deploy_edge_function` fails on file size.
4. **esbuild parse-check mandatory** before any deploy request:
   ```
   npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
     --bundle --platform=neutral --format=esm --target=esnext \
     --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
     --outfile=/tmp/bundle_test.js
   ```
5. **Commit before Dashboard paste.** Paste deploys from local file; uncommitted state vanishes on machine death or `main` merge.
6. **Branch check.** User says active branch is `claude/analyze-shelley-pmf-tn0X9`. Verify; if on `main`, `git checkout -b claude/webhook-gap-fix`.
7. **Scope.** Touches ONLY `index.inlined.ts` (+ optional Tier C migration/Edge Function). Do NOT touch: dedup semantics without data, pricing, Cloud API migration, recurring reminders, `drain_outbound_queue`, any pg_cron job.

---

## Static analysis findings (pre-measurement)

1. **H3 is pre-confirmed statically.** Four branches in `handleDirectMessage` exit WITHOUT calling `logMessage` on the inbound: 4228 (waitlist-new), 4248 (waitlist-reping), 4280 (joined-safety), 4314 (admit-welcome). Every new 1:1 phone from the FB viral window hits 4228 and leaves no row. This alone plausibly covers most of 15-vs-7.
2. **`"unknown"` sentinel row EXISTS** (`households_v2.id='unknown'`). `logMessage(…, "unknown")` succeeds. CLAUDE.md's "FK fails for unknown" gotcha is historical; Task 1.0 re-verifies.

Measurement still runs to quantify H1 (dedup collision), H2 (parse null), H4 (history-sync), H5 (signature false-negative).

---

## Exit-site inventory

**`Deno.serve` (lines from HEAD-of-`main`, re-verify before Task 1.2):**

| Line | Code | Branch | Already logs? |
|------|------|--------|---------------|
| 5290 | `verify-fail` | GET verify fail | no |
| 5295 | `non-post` | Non-POST | no |
| 5303 | `sig-invalid` | Signature bad | `console.warn` |
| 5332 | — | Group event | inside handler |
| 5341 | `parse-null` | parseIncoming null | sub-cause @ 240/257 |
| 5357 | `dedup-hit` | Duplicate msg_id | basic console.log |
| 5371 | — | Manual operator | logMessage |
| 5414 | — | Long voice | logMessage |
| 5422 | — | Voice transcribe fail | logMessage |
| 5465 | `reaction-non-sheli` | Reaction elsewhere | no |
| 5474 | `reaction-unknown-emoji` | Unknown emoji on Sheli | no |
| 5504 | — | Reaction confirm/reject | logMessage |
| 5528 | — | Reaction feedback | logMessage |
| 5535 | — | Non-text skip | logMessage |
| 5548 | — | Empty text | `[Webhook:DIAG]` |
| 5563 | — | /command | logMessage |
| 5583 | `identity-deflect` | Prompt-injection | no (outbound only) |
| 5589 | `direct-handoff` | → handleDirectMessage | deferred |

**`handleDirectMessage`:**

| Line | Code | Branch | Inbound logged? |
|------|------|--------|-----------------|
| 4068 | `dm-non-text` | Non-text+non-voice | no |
| 4137 | `dm-rename` | Preferred-name shortcut | no |
| 4162 | `dm-personal-handoff` | → handlePersonalChannelMessage | yes (@4529) |
| 4228 | `dm-waitlist-new` | New-user waitlist | **NO — HIGH** |
| 4248 | `dm-waitlist-reping` | Re-ping | **NO — HIGH** |
| 4280 | `dm-joined-safety` | joined/personal safety | **NO** |
| 4314 | `dm-admit-welcome` | Post-/admit welcome | **NO** |

Active-path inbound log lives at 4402 (`received_1on1`).

---

## Task 1.0 — Branch + sentinel verify

**Steps:**
1. `git branch --show-current`. If not on `claude/webhook-gap-fix`, create: `git checkout -b claude/webhook-gap-fix`. NEVER commit to `main`.
2. Verify sentinel:
   ```sql
   SELECT id, name FROM households_v2 WHERE id = 'unknown';
   ```
   Expect: 1 row. If 0, STOP and tell Yaron — Tier B needs a one-line migration to restore it first.
3. esbuild baseline (zero-change build, see constraints). Expect clean.
4. No commit yet.

---

## Task 1.1 — Add `logExit()` helper

**Files:** `supabase/functions/whatsapp-webhook/index.inlined.ts` (insert just above `Deno.serve`, ~line 5276).

**Insert:**
```typescript
// ── Exit diagnostics (webhook-gap-fix 2026-04-20) ──
// One line per webhook exit. Single grep '[Webhook:EXIT:' reconstructs
// the full drop inventory. Cross-ref with whatsapp_messages + Whapi /chats.
function logExit(
  code: string,
  body: unknown,
  message: { messageId?: string; senderPhone?: string; groupId?: string; chatType?: string; type?: string } | null = null,
  extra: Record<string, unknown> = {}
) {
  try {
    const b = body as Record<string, unknown>;
    const m0 = (Array.isArray(b?.messages) ? (b.messages as any[])[0] : null) as Record<string, unknown> | null;
    const row = {
      code,
      msg_id: message?.messageId ?? m0?.id ?? null,
      from: message?.senderPhone ?? m0?.from ?? null,
      chat: message?.groupId ?? m0?.chat_id ?? null,
      chat_type: message?.chatType ?? null,
      type: message?.type ?? m0?.type ?? null,
      body_keys: Object.keys(b || {}).slice(0, 8),
      ...extra,
    };
    console.log(`[Webhook:EXIT:${code}] ${JSON.stringify(row)}`);
  } catch (_) { /* diag must never throw */ }
}
```

**Steps:**
1. Add via Edit tool.
2. esbuild parse-check → clean.
3. `git commit -m "feat(webhook): add logExit helper for gap-fix measurement"`

---

## Task 1.2 — Instrument `Deno.serve` exits

For each site listed "Already logs? no" in the inventory, add **one** `logExit(...)` line immediately ABOVE the existing `return new Response(...)`. Do NOT remove existing `console.log`/`console.warn`.

**Exact additions (9 sites):**

1. L5290 `verify-fail`: `logExit("verify-fail", {}, null, { mode, token_prefix: (token || "").slice(0,4) });`
2. L5295 `non-post`: `logExit("non-post", {}, null, { method: req.method });`
3. L5303 `sig-invalid`: `logExit("sig-invalid", {}, null, { has_auth: !!req.headers.get("authorization") });`
4. L5341 `parse-null`: `logExit("parse-null", body);`
5. L5357 `dedup-hit`: `logExit("dedup-hit", body, message, { existing_id: existing[0]?.id });`
6. L5465 `reaction-non-sheli`: `logExit("reaction-non-sheli", body, message, { target_id: message.reactionTargetId });`
7. L5474 `reaction-unknown-emoji`: `logExit("reaction-unknown-emoji", body, message, { emoji: message.reactionEmoji });`
8. L5583 `identity-deflect`: add `logExit("identity-deflect", body, message);` before the existing `await sendAndLog(...)`.
9. L5589 `direct-handoff`: add `logExit("direct-handoff", body, message);` before `await handleDirectMessage(...)`.

**Steps:**
1. Apply via Edit tool (one Edit per site; include enough context to make `old_string` unique).
2. esbuild parse-check → clean.
3. `git commit -m "feat(webhook): instrument Deno.serve exit sites for gap measurement"`

---

## Task 1.3 — Instrument `handleDirectMessage` + Tier B

Branches 4228/4248/4280/4314 currently eat the inbound silently. Add `await logMessage(message, "dm_<code>", convo?.household_id || "unknown")` AND `logExit(...)` at each. Sentinel verified in 1.0 makes `"unknown"` safe.

**Exact additions (7 sites):**

1. **L4068 `dm-non-text`:**
   ```typescript
   if (!text && message.type !== "voice") {
     logExit("dm-non-text", null, message);
     return;
   }
   ```
2. **L4137 `dm-rename`** (add before the existing `return;`):
   ```typescript
   await logMessage(message, "dm_rename", convo?.household_id || "unknown");
   logExit("dm-rename", null, message, { new_name: newName });
   ```
3. **L4162 `dm-personal-handoff`** (handlePersonalChannelMessage already logs @4529 — just record the handoff):
   ```typescript
   logExit("dm-personal-handoff", null, message, { hh: mapping.household_id });
   ```
4. **L4228 `dm-waitlist-new` (HIGH RISK):**
   ```typescript
   await logMessage(message, "dm_waitlist_new", "unknown");
   logExit("dm-waitlist-new", null, message, { ref: validReferralCode });
   ```
5. **L4248 `dm-waitlist-reping`:**
   ```typescript
   await logMessage(message, "dm_waitlist_reping", "unknown");
   logExit("dm-waitlist-reping", null, message, { count: (convo.message_count || 0) + 1 });
   ```
6. **L4280 `dm-joined-safety`:**
   ```typescript
   await logMessage(message, "dm_joined_safety", convo?.household_id || "unknown");
   logExit("dm-joined-safety", null, message, { state: convo.state });
   ```
7. **L4314 `dm-admit-welcome`:**
   ```typescript
   await logMessage(message, "dm_admit_welcome", convo.household_id || "unknown");
   logExit("dm-admit-welcome", null, message);
   ```

**Steps:**
1. Apply via Edit tool.
2. esbuild parse-check → clean.
3. `git commit -m "feat(webhook): instrument+log handleDirectMessage exits (Tier B)"`

---

## Task 1.4 — Ship measurement + Tier B

1. `git push -u origin claude/webhook-gap-fix`.
2. **STOP.** Message Yaron: "Branch `claude/webhook-gap-fix` pushed, esbuild passes. Please paste `supabase/functions/whatsapp-webhook/index.inlined.ts` to Supabase Dashboard → Edge Functions → whatsapp-webhook → Code → Deploy. Verify JWT = OFF. Reply when deployed."
3. After deploy confirmed, sanity query:
   ```sql
   SELECT classification, COUNT(*) FROM whatsapp_messages
   WHERE created_at > NOW() - INTERVAL '15 minutes' AND classification LIKE 'dm_%'
   GROUP BY 1;
   ```
   Expect: ≥0 rows (any positive is proof; zero is fine if no new 1:1s arrived).

---

## Task 2.0 — Reconciliation query (runbook, no code)

Paste into Supabase SQL editor. Swap phone list from Whapi Dashboard → Chats.

```sql
WITH probe(phone) AS (
  SELECT unnest(ARRAY[
    '972524248151',  -- Liad (reliable repro)
    -- paste more phones here, no @s.whatsapp.net suffix
  ]::text[])
),
hits AS (
  SELECT DISTINCT sender_phone
  FROM whatsapp_messages
  WHERE created_at > NOW() - INTERVAL '24 hours' -- tune window
    AND sender_phone IS NOT NULL
)
SELECT p.phone,
       CASE WHEN h.sender_phone IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM probe p
LEFT JOIN hits h ON h.sender_phone = p.phone
ORDER BY status DESC, phone;
```

Acceptance: Liad's phone `MISSING` pre-deploy, `OK` after test message post-deploy.

---

## Task 2.1 — Hypothesis validation

Wait ≥1h of organic traffic OR request a Liad test. Classify each hypothesis before any fix.

**H1 — Dedup collision on history-sync replay:**
- Log signal: `[Webhook:EXIT:dedup-hit]` with `from` matching a known-drop phone.
- SQL: for a `dedup-hit` `msg_id`, confirm the existing row is >24h old AND same phone.
  ```sql
  SELECT id, created_at, classification, sender_phone, household_id
  FROM whatsapp_messages WHERE whatsapp_message_id = '<msg_id from log>';
  ```
- CONFIRMED if: known-drop phone hits dedup AND existing row is stale.

**H2 — parseIncoming null on non-standard payload:**
- Log signal: `[Webhook:EXIT:parse-null]`. Cross-ref `[WhapiProvider:DIAG]` @ 240/257.
- Tally: grep logs; dominant `body_keys` shape.
- CONFIRMED if: `parse-null` >5% of POSTs AND dominant shape ≠ standard `messages`/`event`.

**H3 — handleDirectMessage silent exits:**
- Pre-confirmed statically. Measure magnitude:
  ```sql
  SELECT classification, COUNT(*) FROM whatsapp_messages
  WHERE created_at > NOW() - INTERVAL '24 hours' AND classification LIKE 'dm_%'
  GROUP BY 1 ORDER BY 2 DESC;
  ```
- If `dm_waitlist_*` sum ≥30% of 1:1 inbound, Tier B alone closes most of the gap.

**H4 — Whapi history-sync bypasses webhook:**
- Run Task 2.0 24h post-deploy. If phones STILL `MISSING` AND no `[Webhook:EXIT:*]` lines for them anywhere → H4 confirmed. Tier C becomes required.

**H5 — Signature false-negatives:**
- Log signal: `[Webhook:EXIT:sig-invalid]` volume.
- Cross-check Whapi Dashboard → Delivery stats.
- CONFIRMED if both show matching 401s. Fix = env var re-verify. No code change.

**Deliverable:** one line per hypothesis in chat — `[CONFIRMED, N/24h]` / `[RULED OUT, 0/24h]` / `[INCONCLUSIVE]` — plus single-sentence Tier A recommendation. Wait for Yaron approval before Task 3.0.

---

## Task 3.0 — Tier A fix (data-driven, gated on 2.1 approval)

Branch based on what 2.1 confirmed:

- **H3 alone:** Tier A = no-op. Jump to 4.0.
- **H1 confirmed:** Narrow dedup from `whatsapp_message_id` alone to `(whatsapp_message_id, sender_phone)` AND `existing.created_at > NOW() - INTERVAL '30 minutes'`. Rationale: real dupes arrive within seconds; 24h-old match is history-sync replay. **Requires careful review of the 5344 `sendAndLog`-bounce comment** — dedup is load-bearing for that path.
- **H2 confirmed:** Add a second parse path for the observed `body_keys` shape. Keep existing path intact. Specific diff TBD after data.
- **H4 confirmed:** Skip A, go to 3.1.
- **H5 confirmed:** env var fix only (no code).

Structure for whichever fires: diff → esbuild → commit → Dashboard paste → re-measure with 2.0.

---

## Task 3.1 — Tier C reconciliation cron (gated on H4 CONFIRMED)

**DO NOT IMPLEMENT without a separate brainstorming + plan pass.** Sketch only:

- New `supabase/migrations/*_whapi_reconcile_state.sql` — `whapi_reconcile_state(chat_id TEXT PK, last_message_ts BIGINT, last_run_at TIMESTAMPTZ)`.
- New small Edge Function `whapi-reconcile` (small = MCP deploy works) that polls Whapi `GET /chats` then `GET /messages/list?chat_id=…&time_from=…` per chat, INSERTs missing rows into `whatsapp_messages` with `classification='reconciled_history_sync'`, `household_id='unknown'`.
- 10-min pg_cron schedule.
- **DB-write-only.** Any follow-up user-facing outreach goes through `outbound_queue` at ≤10/hr in a separate plan.

Failure modes to think through in the sibling plan: rate limits, cursor drift, phantom dupes, partial pagination.

---

## Task 4.0 — Acceptance

Ask Yaron to text "בדיקה" from Liad (+972 52-424-8151) or a freshly-sourced drop phone.

**All three must hold:**
1. `SELECT … FROM whatsapp_messages WHERE sender_phone='972524248151' ORDER BY created_at DESC LIMIT 1;` returns a fresh row within 5s.
2. `[Webhook:EXIT:dm-waitlist-new]` (or whichever branch) visible in Dashboard logs within 10s.
3. 24h-window drop rate from Task 2.0 < 5%.

If ≥5%, Tier A/C didn't cover the full cause — return to 2.1. `@superpowers:verification-before-completion` applies.

---

## Task 4.1 — PR

Open PR from `claude/webhook-gap-fix` to `main`. Body:
- Phase 1 shipped (logExit + 9 Deno.serve + 7 handleDirectMessage sites + 4 Tier B logMessage inserts)
- Phase 2: [one checkbox per hypothesis outcome, from 2.1]
- Pre-deploy drop rate X%, post-deploy Y%, Liad test OK.

---

## Rollback

Pure logging + 4 `logMessage` calls on verified sentinel. Revert and re-paste if needed:
```bash
git revert <commit sha>
git push
# then Dashboard paste reverted file
```
Optional DB cleanup: `DELETE FROM whatsapp_messages WHERE classification LIKE 'dm_%' AND created_at > '<deploy_ts>'`. Not required — `dm_*` values are forward-compatible with every existing reader.

---

## Risks accepted

- +1 log line per webhook POST. At <500 1:1/day this is noise-floor.
- `dm_*` rows tied to `"unknown"` sentinel — invisible to household-scoped admin queries (feature, not bug: these users have no household yet).

## Non-goals (do NOT expand)

- No kill-switch flips.
- No `parseIncoming` change without H2 CONFIRMED.
- No welcome/recovery/outbound re-enable.
- No Cloud API migration touch.
- No `handleDirectMessage` refactor — only additions.
- No other parked TODO (pricing, Calendar, recurring reminders).
