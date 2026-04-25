# Whapi Reconciliation Cron — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This is the deferred Tier C from `docs/plans/2026-04-20-webhook-gap-fix-plan.md`. Read that plan first to understand H4 (Whapi history-sync / persistent-toggle drops) before starting.

**Goal:** Close the H4 silent-drop gap (Whapi-side webhook drops with no Edge Function trace) by reconciling against Whapi's `/messages/list` cache every 15 minutes and replaying anything our DB never saw. Bound worst-case drop latency to ≤15 min, eliminate the need for manual `import_whapi_backlog.py` runs after every Whapi blip.

**Why now:** 2026-04-25 incident — Whapi's "Persistent webhook" toggle flipped off mid-day, dropped Michael's two `קניות -` messages in the new סקסופון group (and possibly others). Confirmed root cause; no in-pipeline fix possible because the drop is upstream of `Deno.serve`. Reconciliation is the only structural cure on Whapi-class infra. Cloud API migration (Option 1, separate plan) eliminates H4 entirely but is weeks out — this plan is the bridge.

**Architecture:** New Edge Function `whapi-reconciliation` triggered by pg_cron every 15 min. Calls Whapi `/messages/list?time_from=<25min ago>` (overlap = belt-and-suspenders against clock skew + Whapi pagination). For each message returned, checks `whatsapp_messages` by `whatsapp_message_id`; if no row exists, re-POSTs to the bot's existing webhook URL with a reconciliation-marker header that skips signature verification. The webhook's normal classification → action pipeline runs, including outbound replies via `sendAndLog`. Idempotent (any pre-existing row → skip), rate-limited (≤20 replays per cycle), kill-switchable (`bot_settings.reconciliation_paused`).

**Tech stack:** Supabase Edge Function (Deno, new + existing), Postgres (`whatsapp_messages`, `bot_settings`, new `reconciliation_runs`), pg_cron + `net.http_post`. Whapi `/messages/list` API. No app/UI surface.

---

## Hard constraints

1. **Kill switches stay ON during initial deploy.** New flag `bot_settings.reconciliation_paused = 'true'` defaults the function to a no-op. Flip to `false` manually after observing one paused run end-to-end. Same pattern as `outbound_paused`.
2. **No double-fire.** Reconciliation MUST skip any message whose `whatsapp_message_id` already has a row in `whatsapp_messages` — regardless of classification. The bot already processed it; replaying would re-execute actions.
3. **No mass-messaging in cycle one.** Per-cycle hard cap of 20 replays. If Whapi returns more, log a `reconciliation_overflow` warning and process newest 20. Older gaps require manual `import_whapi_backlog.py`. Prevents anti-spam exposure if Whapi suddenly dumps a 4-hour backlog.
4. **Dashboard paste only** for `whatsapp-webhook` edits. New `whapi-reconciliation` function CAN deploy via MCP `deploy_edge_function` (small file, fits in `content` arg).
5. **esbuild parse-check both files** before requesting deploy:
   ```
   npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
     --bundle --platform=neutral --format=esm --target=esnext \
     --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
     --outfile=/tmp/bundle_test.js
   npx --yes esbuild supabase/functions/whapi-reconciliation/index.ts \
     --bundle --platform=neutral --format=esm --target=esnext \
     --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
     --outfile=/tmp/recon_test.js
   ```
6. **Commit before Dashboard paste** for `index.inlined.ts`. Paste-corruption scan (`Latin+Hebrew+Latin` regex) post-deploy mandatory per the 2026-04-22 lesson.
7. **Branch.** Create `claude/whapi-reconciliation-cron` off `origin/main`. Do not piggyback on any other open PR.
8. **Scope — touches:** `supabase/functions/whapi-reconciliation/index.ts` (NEW), `supabase/functions/whatsapp-webhook/index.inlined.ts` (one new branch in `Deno.serve`), one DB migration (new table + new flag), one pg_cron schedule. Does NOT touch: dedup window, signature verification for non-reconciliation paths, `outbound_queue`, `drain_outbound_queue`, reminders, classification, prompts.
9. **Non-goal — replay actions for messages already classified.** If a row exists with classification `received` (i.e., Edge Function logged it but crashed before classifier finished), reconciliation will NOT retry it. That's a different gap (in-function failure, covered by Tier B logExit instrumentation) and reactivating those without idempotency on actions could double-fire. Document this as a known limitation.

---

## Static analysis findings

1. **`whatsapp_message_id` is the right idempotency key.** Existing `Deno.serve` dedup uses it, the import script uses it, recovery scripts use it. PostgreSQL has no UNIQUE on it (per CLAUDE.md schema notes; verify in Task 0.0), but a SELECT-by-id is fast — gist index on `(whatsapp_message_id, created_at DESC)` if pg_stat shows it's hot.
2. **`scripts/import_whapi_backlog.py` already implements the Whapi `/messages/list` call + dedup logic.** Port it to TypeScript inside the new Edge Function. It handles 1:1 + group chats, paginates, exits clean if Whapi `/health ≠ AUTH`. Use it as the reference implementation.
3. **Webhook signature verification lives in `Deno.serve` early.** Need a CONDITIONAL bypass: when header `X-Sheli-Reconciliation: <SECRET>` matches env `RECONCILIATION_SECRET`, skip sig verify. Secret stored in Edge Function env vars (same place as `WHAPI_TOKEN`). Reconciliation function reads same env, sets header on each replay POST.
4. **pg_cron + net.http_post is the established pattern.** `drain_outbound_queue` and `fire_due_reminders` both use it. New schedule `whapi_reconciliation_every_15_min` follows the same shape.
5. **Whapi `/messages/list` cache window is ~30 days** per CLAUDE.md. 15-min cron with 25-min `time_from` overlap = 10-min safety margin against pagination/clock-skew misses.

---

## Tasks

### Phase 0: Verify assumptions (~30 min)

#### 0.0 Verify dedup column + Whapi state
Run the two checks below. If either fails, halt and reassess.

```sql
-- (a) Confirm whatsapp_message_id has at least an index, ideally unique-ish behavior
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'whatsapp_messages'
  AND indexdef ILIKE '%whatsapp_message_id%';

-- (b) Confirm bot_settings table shape matches outbound_paused pattern
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'bot_settings';
```

```bash
# (c) Confirm Whapi /health returns AUTH (not QR/LAUNCH).
# Use existing import_whapi_backlog.py script — it short-circuits if not AUTH.
python scripts/import_whapi_backlog.py --dry-run --since "$(date -u -d '5 min ago' +%s)"
```

**Acceptance:** dedup column has at least a btree index, `bot_settings` is `(key text, value text)`, Whapi `/health = AUTH`.

---

### Phase 1: Database scaffolding (~45 min)

#### 1.0 Migration: `bot_settings` flag + `reconciliation_runs` table

File: `supabase/migrations/2026_04_25_whapi_reconciliation_cron.sql`

```sql
-- Kill switch — defaults to TRUE so first deploy is a no-op.
INSERT INTO bot_settings (key, value)
VALUES ('reconciliation_paused', 'true')
ON CONFLICT (key) DO NOTHING;

-- Telemetry — one row per cron run.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  whapi_state     TEXT,                  -- AUTH / QR / LAUNCH / ERROR
  time_from_unix  BIGINT,                -- the --since cutoff used
  whapi_returned  INT NOT NULL DEFAULT 0,  -- messages from Whapi /messages/list
  already_seen    INT NOT NULL DEFAULT 0,  -- skipped because row already exists
  replayed        INT NOT NULL DEFAULT 0,  -- POSTed back to webhook
  overflow        BOOLEAN NOT NULL DEFAULT FALSE,  -- hit per-cycle cap
  error           TEXT,
  notes           JSONB
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx
  ON reconciliation_runs (started_at DESC);

-- RLS: service_role only (consistent with outbound_queue, bot_settings).
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
```

**Acceptance:** Migration applies cleanly via `mcp__f5337598-..__apply_migration`. `SELECT key, value FROM bot_settings WHERE key='reconciliation_paused'` returns `'true'`. `\d reconciliation_runs` shows the columns.

#### 1.1 Verify whatsapp_message_id lookup index
If Phase 0 showed no index, add one:
```sql
CREATE INDEX IF NOT EXISTS whatsapp_messages_msg_id_idx
  ON whatsapp_messages (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;
```
**Acceptance:** `EXPLAIN SELECT 1 FROM whatsapp_messages WHERE whatsapp_message_id = 'X'` shows an Index Scan, not Seq Scan.

---

### Phase 2: New `whapi-reconciliation` Edge Function (~3 hr)

#### 2.0 Skeleton + env-var loading
File: `supabase/functions/whapi-reconciliation/index.ts`

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHAPI_TOKEN = Deno.env.get("WHAPI_TOKEN")!;
const WHAPI_API_URL = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL")!;        // bot's own webhook URL
const RECONCILIATION_SECRET = Deno.env.get("RECONCILIATION_SECRET")!;
const PER_CYCLE_CAP = Number(Deno.env.get("RECONCILIATION_CAP") || "20");
const OVERLAP_MINUTES = 25;  // 15-min cron + 10-min safety
```

**Acceptance:** All env vars throw clearly on `undefined`. Secret value generated fresh (`openssl rand -hex 32`) and added to BOTH `whatsapp-webhook` and `whapi-reconciliation` Edge Function env vars (same value).

#### 2.1 Kill-switch + Whapi /health gate
```typescript
async function shouldRun(supabase): Promise<{run: boolean, reason: string}> {
  const { data } = await supabase
    .from("bot_settings").select("value").eq("key", "reconciliation_paused").single();
  if (data?.value === "true") return { run: false, reason: "kill_switch" };

  const health = await fetch(`${WHAPI_API_URL}/health`, {
    headers: { Authorization: `Bearer ${WHAPI_TOKEN}` },
  });
  const j = await health.json();
  if (j.status?.text !== "AUTH") return { run: false, reason: `whapi_${j.status?.text}` };

  return { run: true, reason: "ok" };
}
```

**Acceptance:** With flag `'true'`, function logs the kill_switch reason and exits with `replayed=0`. With flag `'false'` and Whapi unauthenticated, exits with `whapi_QR` or `whapi_LAUNCH`.

#### 2.2 Whapi `/messages/list` pagination
```typescript
async function fetchSince(timeFromUnix: number): Promise<WhapiMessage[]> {
  const out: WhapiMessage[] = [];
  let offset = 0;
  const COUNT = 100;
  while (true) {
    const url = `${WHAPI_API_URL}/messages/list?count=${COUNT}&offset=${offset}&time_from=${timeFromUnix}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${WHAPI_TOKEN}` }});
    const j = await r.json();
    const batch = j.messages || [];
    out.push(...batch);
    if (batch.length < COUNT) break;
    offset += COUNT;
    if (out.length > 500) break;  // hard ceiling — anything bigger is operational, not cron
  }
  return out;
}
```

**Acceptance:** With a 1-hour `time_from` against an active prod Whapi, returns the actual message count seen in `whatsapp_messages` for that window ± a small margin (Whapi system events).

#### 2.3 Idempotency check
```typescript
async function alreadyHave(supabase, msgIds: string[]): Promise<Set<string>> {
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("whatsapp_message_id")
    .in("whatsapp_message_id", msgIds);
  return new Set((data || []).map(r => r.whatsapp_message_id));
}
```

**Acceptance:** Given a list of 100 message IDs where 95 are in DB and 5 aren't, returns a Set of size 95. Verify with a SQL fixture.

#### 2.4 Replay POST
```typescript
async function replayMessage(msg: WhapiMessage): Promise<{ok: boolean, status: number}> {
  const r = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sheli-Reconciliation": RECONCILIATION_SECRET,
    },
    // Reconstruct the same body Whapi would have sent. Whapi posts as
    // {messages: [...], event: {...}}. Wrap accordingly.
    body: JSON.stringify({ messages: [msg], event: { type: "messages", event: "post" } }),
  });
  return { ok: r.ok, status: r.status };
}
```

**Acceptance:** Manually crafted test message POSTed → webhook → row appears in `whatsapp_messages`. Same test with unset header → 401/403.

#### 2.5 Main loop + telemetry insert
Wrap 2.1–2.4 with structured logging into `reconciliation_runs`:
- `started_at` on entry
- `finished_at`, counts, `error` on exit (try/catch wrapped)
- If `whapi_returned > PER_CYCLE_CAP`, sort newest-first, set `overflow = true`, replay top N

**Acceptance:** One row per invocation in `reconciliation_runs`, never throws unhandled. `notes` JSONB carries any per-message error from `replayMessage` so investigation is one query.

---

### Phase 3: Webhook-side replay header (~30 min)

#### 3.0 Add reconciliation bypass in `Deno.serve`
File: `supabase/functions/whatsapp-webhook/index.inlined.ts`

Find the signature verification block (search for `sig-invalid` exit code) and add a conditional bypass BEFORE it:

```typescript
const reconciliationHeader = req.headers.get("X-Sheli-Reconciliation");
const isReconciliation = reconciliationHeader != null
  && reconciliationHeader === Deno.env.get("RECONCILIATION_SECRET");

// Existing signature check, gated on !isReconciliation:
if (!isReconciliation && !verifySignature(req, body)) {
  console.warn("[Webhook:EXIT:sig-invalid]", ...);
  return new Response("invalid signature", { status: 401 });
}
```

For observability, add an early `console.log("[Webhook:DIAG] reconciliation_replay=true msg_id=...")` so logs distinguish replays from organic webhooks.

**Acceptance:** Manual `curl` POST without sig but with correct `X-Sheli-Reconciliation` header → 200, message processed. Without header OR wrong secret → 401. Existing organic webhook flow (real Whapi-signed POST) unaffected.

#### 3.1 Pre-deploy parse check + commit
```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(webhook): allow reconciliation cron to bypass sig verify via X-Sheli-Reconciliation header"
```

**Acceptance:** esbuild clean, commit lands on `claude/whapi-reconciliation-cron` branch.

---

### Phase 4: pg_cron schedule (~30 min)

#### 4.0 Schedule (still paused via flag)
File: `supabase/migrations/2026_04_25_whapi_reconciliation_cron_schedule.sql`

```sql
-- Schedule every 15 min. Function reads kill-switch flag itself, so the
-- cron firing is harmless when paused — just a no-op telemetry row.
SELECT cron.schedule(
  'whapi_reconciliation_every_15_min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whapi-reconciliation',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

**Note:** `current_setting('app.settings.service_role_key')` requires a Postgres-level setting Yaron may already have configured (used by `drain_outbound_queue`). If not, hardcode the service-role key as a Postgres secret variable per Supabase docs. Match the pattern of existing crons exactly.

**Acceptance:** `SELECT * FROM cron.job WHERE jobname = 'whapi_reconciliation_every_15_min'` returns one row, `active = true`. After 15 min, `reconciliation_runs` has one row with `notes->>'reason' = 'kill_switch'`.

---

### Phase 5: Manual test trigger (~15 min)

#### 5.0 Add SQL helper for ad-hoc backfill
For one-off recovery (replacing manual `import_whapi_backlog.py`):

```sql
CREATE OR REPLACE FUNCTION run_whapi_reconciliation_now(p_minutes INT DEFAULT 60)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_request_id BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whapi-reconciliation',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('overlap_minutes', p_minutes)
  ) INTO v_request_id;
  RETURN v_request_id;
END;
$$;
```

Edge Function should accept `overlap_minutes` from body (defaults to env `OVERLAP_MINUTES`).

**Acceptance:** `SELECT run_whapi_reconciliation_now(120)` triggers a 2-hour backfill regardless of cron schedule. Telemetry row appears with `time_from_unix` = NOW - 2h.

---

### Phase 6: Rollout (~2 hr — including monitoring)

#### 6.0 Deploy paused
1. Deploy `whapi-reconciliation` via MCP `deploy_edge_function`.
2. Paste `index.inlined.ts` (sig-verify bypass) into Supabase Dashboard, post-paste corruption scan.
3. Apply migrations 1.0 + 4.0 (cron + table). Cron starts firing immediately, but flag is `'true'` so it's no-op.
4. Wait 30 min. Verify `reconciliation_runs` has 2 rows, both `replayed=0`, `notes->>'reason' = 'kill_switch'`. Verify webhook traffic unaffected.

**Acceptance:** No regression in `whatsapp_messages` ingestion rate. No errors in `reconciliation_runs.error`.

#### 6.1 Synthetic drop test
1. Disable Whapi persistent webhook toggle for ~3 min.
2. Send 2 test messages from a known phone to the bot 1:1.
3. Re-enable persistent webhook.
4. Verify the 2 messages do NOT appear in `whatsapp_messages` (proves the drop).
5. Flip flag: `UPDATE bot_settings SET value='false' WHERE key='reconciliation_paused'`.
6. Manually trigger: `SELECT run_whapi_reconciliation_now(15)`.
7. Verify messages now appear in `whatsapp_messages`, classified normally, and Sheli replied to them.
8. Flip flag back to `'true'` if any concern, else leave `'false'`.

**Acceptance:** End-to-end recovery works on a real Whapi drop.

#### 6.2 Activate
1. `UPDATE bot_settings SET value='false' WHERE key='reconciliation_paused';`
2. Monitor `reconciliation_runs` for 4 cycles (1 hour). Expect `replayed = 0` on most runs (drops are rare).
3. Set up a daily SQL spot-check (manual or admin dashboard): `SELECT date_trunc('day', started_at) AS day, SUM(replayed), SUM(overflow::int) FROM reconciliation_runs GROUP BY 1 ORDER BY 1 DESC LIMIT 7`.

**Acceptance:** 4 consecutive non-paused runs with `error IS NULL`, `replayed >= 0`, `overflow = false`.

---

## Test plan

### Unit-level (run during Phase 2)
- `alreadyHave` returns correct subset for mixed seen/unseen IDs (SQL fixture).
- `fetchSince` paginates correctly when Whapi returns >100 messages (mock or use a real wide window).
- `replayMessage` POSTs the right body shape; intercept with a temporary local listener.
- Kill-switch read returns `true`/`false` based on flag value.

### Integration (Phase 6.1)
- Synthetic drop test described above.

### Regression
- Existing webhook traffic unaffected — measured by comparing `whatsapp_messages` insert rate per hour for 24h pre- and post-deploy. No statistically significant delta expected.
- No new outbound bursts triggered by reconciliation. Verify `outbound_queue` size doesn't spike post-replay (it shouldn't, because replays use the same `sendAndLog` path which respects `BOT_SILENT_MODE` and `outbound_paused`).

---

## Rollback

**Per-layer flips** (in order of preference):
1. `UPDATE bot_settings SET value='true' WHERE key='reconciliation_paused'` — instant no-op, telemetry continues.
2. `SELECT cron.unschedule('whapi_reconciliation_every_15_min')` — stops the cron firing entirely.
3. `DROP FUNCTION run_whapi_reconciliation_now(INT)` — disables manual triggers.
4. Revert the `index.inlined.ts` sig-verify bypass (delete branch, redeploy prior version). The new function and table can stay — they're harmless.
5. Worst case: drop the Edge Function via Dashboard. Migration tables + cron entry are pure data; can stay forever or be deleted in a cleanup pass.

If reconciliation causes a double-fire incident: flag-pause IMMEDIATELY (~30s), then SELECT from `reconciliation_runs` joining `whatsapp_messages` to identify which msg_ids were replayed wrongly. Manual fixup case-by-case.

---

## Open questions / future work

1. **Replay for already-classified-but-no-action messages.** If a message logged as `received` then `Deno.serve` crashed before classification, reconciliation skips it (pre-existing row). Tier B `[Webhook:EXIT:*]` instrumentation already alerts on this; if it becomes common we'd need a separate "stale-classification re-run" path. Out of scope here.
2. **Group joins via reconciliation.** If Whapi returns a group event we missed (`handleBotAddedToGroup` never fired), the replay POST should hit the group-event branch. Verify in Phase 6.1 by adding the bot to a fresh group during the drop window. If it doesn't auto-setup, file a follow-up.
3. **Voice + image messages.** Reconciliation replays the message metadata, but Whapi may have already cycled the media URL. Voice/image media downloads have a TTL. If reconciliation hits a `media-not-found`, log it as `notes.media_expired` and skip. Most replays will be text and unaffected.
4. **Cloud API migration kills this whole layer.** Once Cloud API is live, Meta retries failed webhooks for 7 days natively. Reconciliation function + cron + table can be removed in the migration cleanup. Annotate this plan in the Cloud API migration plan as a deprecation step.
5. **Per-phone replay rate limit.** PER_CYCLE_CAP=20 is global. If one user sends a 50-message burst during a drop, only 20 replay. Future: per-phone cap of 5 + global cap of 20. Defer until observed.

---

## Acceptance criteria for "plan complete"

- [ ] All 6 phases executed; tasks 0.0 → 6.2 ticked off.
- [ ] Synthetic drop test (6.1) passes end-to-end.
- [ ] `reconciliation_runs` has 4+ consecutive successful rows with `error IS NULL`.
- [ ] `bot_settings.reconciliation_paused = 'false'` (active mode).
- [ ] CLAUDE.md updated with: kill-switch flag (`reconciliation_paused`), the new cron, the `run_whapi_reconciliation_now()` helper, and reference to this plan.
- [ ] Memory file `project_whapi_reconciliation.md` written (entry in `MEMORY.md` index).
- [ ] PR opened, reviewed, merged. Branch deleted from origin.
