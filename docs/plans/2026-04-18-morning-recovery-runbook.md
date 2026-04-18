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

Via the Supabase MCP tool in Claude Code, in order:

1. Apply `supabase/migrations/2026_04_18_welcome_queue.sql`
2. Apply `supabase/migrations/2026_04_18_outbound_queue_recovery.sql`
3. Apply `supabase/migrations/2026_04_18_outbound_queue_groups.sql`
   (adds `chat_id` + `household_id` columns, surrogate `id` PK,
   `recovery_group` message type, drain function that routes to group chat_id)

Verify in Supabase SQL editor:

```sql
SELECT table_name FROM information_schema.tables WHERE table_name = 'outbound_queue';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'outbound_queue' AND column_name IN ('chat_id','household_id','id');
SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'drain_%';
```

Expected: all three columns present, cron job `drain_outbound_queue_every_minute`
scheduled `* * * * *`. The check constraint must accept
`message_type IN ('welcome','recovery','recovery_group')`.

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

Export both 1:1 AND group chats from the WhatsApp Business app on the bot phone:

1. On the phone: open each chat → menu (⋮) → More → Export chat → **Without media**.
2. Send each `.txt` to your PC.
3. **1:1 files:** rename to `{phone}_{name}.txt` (digits only, e.g. `972544848291_Noam.txt`).
4. **Group files:** any filename works but they MUST be listed in `manifest.json` (see below).
5. Drop all `.txt` files into `recovery_exports/` at repo root.

### 5a. Create `recovery_exports/manifest.json` for groups

Groups can't be disambiguated from a filename — create `recovery_exports/manifest.json`:

```json
{
  "files": [
    {
      "path": "goldberg_family.txt",
      "type": "group",
      "group_id": "<real JID from whatsapp_config, e.g. 120363xxxxxxxx@g.us>",
      "existing_household_id": "hh_xxx",
      "group_name": "Goldberg"
    },
    {
      "path": "new_group_yesterday.txt",
      "type": "group",
      "group_id": null,
      "existing_household_id": null,
      "group_name": "Some new group from the wave"
    },
    {
      "path": "972544848291_Noam.txt",
      "type": "direct",
      "phone": "972544848291",
      "display_name": "Noam"
    }
  ]
}
```

Rules:
- **Existing beta group** (Goldberg, La Familia, etc.): set `existing_household_id` so messages
  merge into the current household — NO duplicate is created.
- **New group from the wave** (no prior household, no JID captured): leave both
  `group_id` and `existing_household_id` as `null`. A fresh household is created
  with a synthetic `group_id = "group_synthetic_<uuid>"` flagged
  `{synthetic_group: true, awaiting_real_jid: true}` in metadata. The real JID
  gets reconciled later when a live webhook arrives.
- **1:1 files** don't need a manifest entry — filename inference still works.
  Adding them to the manifest only lets you override phone/display_name if the
  filename is missing parts.

Find a group's real JID via SQL before writing the manifest:

```sql
SELECT household_id, group_id, household_name
FROM whatsapp_config wc
JOIN households_v2 h ON h.id = wc.household_id
WHERE wc.group_id IS NOT NULL;
```

### 5b. Run the importer

```bash
python scripts/import_chat_exports.py --dry-run
python scripts/import_chat_exports.py
```

For 1:1 files this:
- Creates `households_v2` + `whatsapp_member_mapping` + `onboarding_conversations` if missing.
- Inserts every message (inbound + Yaron's manual replies) into `whatsapp_messages`.
- Haiku-classifies inbound user text.
- Materialises real `tasks` / `shopping_items` / `events` / `reminder_queue` /
  `expenses` rows so items show up in the app. Past reminders get `fired_at =
  scheduled_for`, `status='fired'` — bot won't re-fire.
- Tags `onboarding_conversations.context.recovery_state` as `handled_manually` |
  `needs_recovery` | `noise_only`.

For group files this:
- Looks up or creates the household per manifest rules (existing vs synthetic).
- Adds `household_members` + `whatsapp_member_mapping` rows for each distinct
  sender (phone NULL for unknown senders — they'll get populated when a live
  message arrives).
- Skips WhatsApp system messages ("X added Y", encryption notice, "X left").
  Strips the `~` prefix WhatsApp shows for unsaved contacts.
- Runs **per-message resolution tracking**: for each inbound user message,
  checks whether the NEXT bot/manual reply within 30 min actually addresses
  THIS specific ask. Stores `classification_data.recovery_state` = one of:
  - `handled` — a subsequent bot/manual reply resolves this user's ask
  - `needs_recovery` — no reply within 30 min, OR reply addressed a different user
  - `low_intent` — ignore/noise/reaction (skipped from recovery entirely)
- Materialises CMS rows ONLY for `needs_recovery` actionable messages (keeps
  the group's view tidy — things that were handled live aren't re-added).

Re-running is a no-op (deterministic synthetic IDs + existence checks before every write).

---

## 6. Plan personalised recovery messages (Capability C)

```bash
python scripts/plan_recovery_messages.py --dry-run --start-hour 9
python scripts/plan_recovery_messages.py --start-hour 9
```

This runs **two buckets** in one invocation:

**Groups first (scheduled ban_lift + 1h, spread across ~2h):**
- Finds households with ≥1 group message flagged `recovery_state='needs_recovery'`
  in the ban window.
- Deduplicates unresolved users by `sender_name`.
- Calls Sonnet ONCE per group to produce ONE unified Hebrew message (≤8 lines)
  that addresses each unresolved user by name.
  - 1 unresolved user → short personalised message.
  - 2-5 unresolved users → unified message with ≤1 line per user.
  - >5 unresolved users → short generic "חזרתי 🙈" welcome-back (no roll-call;
    avoids a wall-of-text Sonnet output in rare edge cases).
- Inserts ONE row with `message_type='recovery_group'`, `chat_id=<group_jid>`,
  `phone_number=NULL`, `household_id=<hh>`. The drain function routes to the
  group chat via `chat_id` when set.

**1:1 after (scheduled ban_lift + 2.5h, spread across ~2.5h):**
- Finds 1:1 users with `backlog_imported_user` rows.
- Skips `handled_manually`, `noise_only`, already-queued.
- Calls Sonnet per-user for ONE personalised message (≤4 lines).
- Inserts rows with `message_type='recovery'`, `phone_number=<phone>`,
  `chat_id=NULL`.

**Rate limit: `drain_outbound_queue` enforces ≤6 sends per rolling hour** across
ALL message types (welcomes + 1:1 recoveries + group recoveries share one bucket).
The drain function sorts groups first within each tick, so if the rate cap is
saturated, groups (which unblock multiple users per send) go before 1:1 and
welcomes.

Split-execution flags if you want to stage in waves:
- `--groups-only` — queue groups only
- `--direct-only` — queue 1:1 only
- `--group-spread-hours 2` — control group spread window
- `--direct-start-offset-hours 1.5` — delay 1:1 start relative to group start

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
-- What's queued vs sent in the last hour (by type)
SELECT message_type, sent_at IS NOT NULL AS sent, COUNT(*)
FROM outbound_queue
WHERE queued_at > now() - interval '12 hours'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 1:1 recoveries that have gone out
SELECT phone_number, sent_at, substring(body, 1, 60) AS preview
FROM outbound_queue
WHERE message_type = 'recovery' AND sent_at IS NOT NULL
ORDER BY sent_at DESC LIMIT 20;

-- Group recoveries that have gone out
SELECT chat_id, household_id, sent_at,
       (metadata->>'unresolved_user_names') AS users,
       substring(body, 1, 80) AS preview
FROM outbound_queue
WHERE message_type = 'recovery_group' AND sent_at IS NOT NULL
ORDER BY sent_at DESC LIMIT 20;

-- Abandoned (3+ attempts, never sent)
SELECT id, phone_number, chat_id, message_type, attempts, scheduled_for
FROM outbound_queue
WHERE sent_at IS NULL AND attempts >= 3;

-- Global rate-cap sanity — must be ≤6 in any rolling hour
SELECT date_trunc('minute', sent_at) AS minute, COUNT(*)
FROM outbound_queue
WHERE sent_at > now() - interval '2 hours'
GROUP BY 1 ORDER BY 1 DESC;

-- Bot reply funnel — any new webhook traffic classified weirdly?
SELECT classification, COUNT(*)
FROM whatsapp_messages
WHERE created_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;

-- Expected outbound volume for first 4h post-ban-lift:
-- Group recoveries:   min(N_groups, 24)      -- capped by 6/hr * 4h
-- 1:1 recoveries:     remaining slots after groups saturate
-- Live welcomes:      real-time, share the same 24-slot bucket
-- With ~5 beta groups + ~30 1:1 users expected, the 24-slot cap is NOT
-- saturated — all group recoveries should send within hour 1-2, all 1:1
-- recoveries within hour 2-4.

---

## Rollback

**If a group recovery message misfires in a family group (wrong names, weird tone,
accidental @s, etc.) — act fast, blast radius is the entire group:**

1. **Stop the drain immediately:**

   ```sql
   SELECT cron.unschedule('drain_outbound_queue_every_minute');
   ```

2. **Clear unsent group recoveries only** (keeps 1:1 queue intact for investigation):

   ```sql
   UPDATE outbound_queue
      SET sent_at = now(), attempts = 99
    WHERE sent_at IS NULL
      AND message_type = 'recovery_group';
   ```

3. **Investigate**: inspect `body`, `metadata->unresolved_user_names`, and the
   source messages in `whatsapp_messages` for the affected `household_id`:

   ```sql
   SELECT sender_name, message_text, classification_data
   FROM whatsapp_messages
   WHERE household_id = 'hh_xxx'
     AND classification = 'backlog_imported_user'
     AND (classification_data->>'recovery_state') = 'needs_recovery'
   ORDER BY created_at ASC;
   ```

4. **Re-enable drain** after investigation:

   ```sql
   SELECT cron.schedule('drain_outbound_queue_every_minute', '* * * * *',
     $cron$ SELECT public.drain_outbound_queue(); $cron$);
   ```

**If ALL recovery messages misfire or WhatsApp flags the bot again:**

1. Stop the drain (as above).

2. **Clear the queue entirely:**

   ```sql
   UPDATE outbound_queue SET sent_at = now(), attempts = 99
   WHERE sent_at IS NULL;
   ```

3. **Clear the Whapi webhook URL** from the Whapi dashboard (stops inbound).

4. **Revert Edge Function**: re-deploy the prior `index.inlined.ts` from
   `git show 9164bdf:supabase/functions/whatsapp-webhook/index.inlined.ts`
   via Dashboard paste.

**If imported data looks wrong and we want to undo Capability B**:

```sql
-- Messages imported from chat exports (1:1 AND group)
DELETE FROM whatsapp_messages
WHERE classification IN ('backlog_imported_user', 'manual_reply_imported')
  AND created_at < '2026-04-18';

-- Households created by the importer (all have "(recovered)" in the name)
DELETE FROM households_v2 WHERE name LIKE '%(recovered)';

-- Synthetic groups with no real JID yet (if we over-created)
DELETE FROM households_v2
WHERE metadata->>'synthetic_group' = 'true'
  AND metadata->>'recovered_from_export' = 'true';
```

(The `households_v2` FK cascades clean up tasks/shopping/events/reminders/expenses.)

---

## Post-mortem tasks (after fires are out)

- Delete the sensitive exports from `recovery_exports/` (they contain real user names + phones + Hebrew PII).
- Write session note to `.claude/projects/.../memory/session_20260418b.md` summarising what shipped, how many users recovered, churn rate.
- Decide cutover date for Meta Cloud API migration now that Whapi has proven fragile under load.
