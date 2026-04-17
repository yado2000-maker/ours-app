# 2026-04-18 Morning Recovery Runbook

Ban lifts ~08:40 IL. Run these in order. Each step is idempotent — safe to re-run if interrupted.

---

## 0. Pre-flight (do once, before 08:40)

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app"
git checkout claude/trusting-elbakyan-c75021
git log --oneline -10
```

Confirm commits include:
- `feat(bot): welcome-throttle queue + combined first-action reply ...`
- `feat(bot): outbound_queue schema + WhatsApp chat export importer ...`
- `feat(bot): personalized recovery planner via Sonnet`
- `test(bot): offline coverage for importers and recovery planner`

Ensure `.env` at repo root has: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `WHAPI_TOKEN`.

Confirm `pip install requests` has been done.

Run the offline tests (should be 16/16 OK, ~2s):

```bash
python -m unittest tests.test_recovery -v
```

---

## 1. Apply DB migrations (ban still in effect, but prep DB now)

Via the Supabase MCP tool in Claude Code:

1. Apply `supabase/migrations/2026_04_18_welcome_queue.sql`
2. Apply `supabase/migrations/2026_04_18_outbound_queue_recovery.sql`

Verify in Supabase SQL editor:

```sql
SELECT table_name FROM information_schema.tables WHERE table_name = 'outbound_queue';
SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'drain_%';
```

Expected: `outbound_queue` present, cron job `drain_outbound_queue_every_minute` scheduled `* * * * *`.

---

## 2. Deploy the new Edge Function code

1. Open `supabase/functions/whatsapp-webhook/index.inlined.ts` in Cursor.
2. Ctrl+A, Ctrl+C.
3. Supabase Dashboard → Edge Functions → `whatsapp-webhook` → Code → paste → Deploy.
4. Settings → Verify JWT = **OFF**.

**DO NOT** re-enable the Whapi webhook URL yet.

---

## 3. ~08:40 IL — Ban lifts. Re-pair the bot phone

The ban unpaired the linked device. Whapi channel is in `QR` state.

1. Whapi dashboard → channel → scan QR from the bot phone's WhatsApp Business app.
2. Wait for status to flip to `AUTH`.
3. Verify:

```bash
curl -s -H "Authorization: Bearer $WHAPI_TOKEN" https://gate.whapi.cloud/health | python -m json.tool
```

Expected: `"status": {"text": "AUTH", ...}`.

---

## 4. Import Whapi backlog (Capability A)

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app"
python scripts/import_whapi_backlog.py --dry-run
python scripts/import_whapi_backlog.py
```

- If Whapi returns `QR`/`LAUNCH` the script exits cleanly with a log line. Don't panic — Capability B alone recovers the critical 30 chats.
- If successful: paginates `/messages/list?time_from=1776404520` (2026-04-17 05:42 UTC), dedupes on `whatsapp_message_id`, Haiku-classifies inbound user messages.

---

## 5. Import WhatsApp chat exports (Capability B — always works)

Export the ~30 manually-handled chats from the WhatsApp Business app on the bot phone:

1. On the phone: open each chat → menu (⋮) → More → Export chat → **Without media**.
2. Send each `.txt` to your PC.
3. Rename to `{phone}_{name}.txt` (digits only in phone, e.g. `972544848291_Noam.txt`).
4. Drop into `recovery_exports/` at repo root.

Then:

```bash
python scripts/import_chat_exports.py --dry-run
python scripts/import_chat_exports.py
```

This:
- Creates `households_v2` + `whatsapp_member_mapping` + `onboarding_conversations` for each user if missing.
- Inserts every message (inbound + Yaron's manual replies) into `whatsapp_messages`.
- Haiku-classifies inbound user text.
- Materialises real `tasks` / `shopping_items` / `events` / `reminder_queue` / `expenses` rows so the items show up in the app for the user.
- Past reminders are inserted with `fired_at = scheduled_for`, `status='fired'` — bot won't re-fire.
- Tags `onboarding_conversations.context.recovery_state` as `handled_manually` | `needs_recovery` | `noise_only`.

Re-running is a no-op (deterministic synthetic IDs + existence checks before every write).

---

## 6. Plan personalised recovery messages (Capability C)

```bash
python scripts/plan_recovery_messages.py --dry-run --start-hour 9
python scripts/plan_recovery_messages.py --start-hour 9
```

This:
- Finds users with `backlog_imported_user` rows in the ban window.
- Skips `handled_manually`, `noise_only`, and anyone already staged.
- Calls Sonnet per-user for ONE personalised Hebrew message (≤4 lines, SHARED_* rule parity).
- Inserts into `outbound_queue` with `message_type='recovery'`, staggered `scheduled_for` across 4h starting at 09:00 IL.

**Rate limit is enforced by `drain_outbound_queue`** (6/hour global). Spreading schedule values just makes the queue pretty.

---

## 7. Re-enable the Whapi webhook

Once steps 1–6 have run cleanly:

1. Whapi dashboard → channel → Settings → Webhook URL → set to:
   `https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook`
2. Save.

New messages start flowing. The welcome-throttle from the prior commit caps auto-welcomes at 6/hr. Recovery messages share the same 6/hr bucket.

---

## 8. Monitor for the first hour

SQL to watch (run every 5–10 min):

```sql
-- What's queued vs sent in the last hour
SELECT message_type, sent_at IS NOT NULL AS sent, COUNT(*)
FROM outbound_queue
WHERE queued_at > now() - interval '12 hours'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Which recovery messages have gone out
SELECT phone_number, sent_at, substring(body, 1, 60) AS preview
FROM outbound_queue
WHERE message_type = 'recovery' AND sent_at IS NOT NULL
ORDER BY sent_at DESC LIMIT 20;

-- Abandoned (3+ attempts, never sent)
SELECT phone_number, message_type, attempts, scheduled_for
FROM outbound_queue
WHERE sent_at IS NULL AND attempts >= 3;

-- Bot reply funnel — any new webhook traffic classified weirdly?
SELECT classification, COUNT(*)
FROM whatsapp_messages
WHERE created_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;
```

---

## Rollback

**If a recovery message misfires or WhatsApp flags the bot again:**

1. **Stop the drain immediately:**

   ```sql
   SELECT cron.unschedule('drain_outbound_queue_every_minute');
   ```

2. **Clear the queue:**

   ```sql
   UPDATE outbound_queue SET sent_at = now(), attempts = 99
   WHERE sent_at IS NULL;
   ```

3. **Clear the Whapi webhook URL** from the Whapi dashboard (stops inbound).

4. **Revert Edge Function**: re-deploy the prior `index.inlined.ts` from `git show 9164bdf:supabase/functions/whatsapp-webhook/index.inlined.ts` via Dashboard paste.

**If imported data looks wrong and we want to undo Capability B**:

```sql
-- Messages imported from chat exports
DELETE FROM whatsapp_messages
WHERE classification IN ('backlog_imported_user', 'manual_reply_imported')
  AND created_at < '2026-04-18';

-- Households created by the importer (they all have "(recovered)" in the name)
DELETE FROM households_v2 WHERE name LIKE '%(recovered)';
```

(The `households_v2` FK cascades will clean up tasks/shopping/events/reminders/expenses tied to those households.)

---

## Post-mortem tasks (after fires are out)

- Delete the sensitive exports from `recovery_exports/` (they contain real user names + phones + Hebrew PII).
- Write session note to `.claude/projects/.../memory/session_20260418b.md` summarising what shipped, how many users recovered, churn rate.
- Decide cutover date for Meta Cloud API migration now that Whapi has proven fragile under load.
