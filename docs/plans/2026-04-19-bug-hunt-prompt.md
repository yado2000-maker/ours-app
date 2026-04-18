# Fresh-session prompt — bug hunt 2026-04-19

Copy-paste below into a fresh Claude Code session in `ours-app`.

---

I'm Yaron, building Sheli (שלי) — a Hebrew WhatsApp family-assistant bot.
Yesterday (2026-04-18) we did a long incident-response session that
hardened the outbound queue + fixed several silent-drop bugs. Session
summary is in memory `session_20260418d`, commit `caa58d8` on branch
`claude/trusting-elbakyan-c75021` (pushed).

Today's session is **bug hunting**. Sheli is live, beta families are
using her, and I want to find and fix whatever broke overnight or
what's still hiding.

## Stack quick-ref (read memory + CLAUDE.md first)

- Repo: `C:/Users/yarond/Downloads/claude code/ours-app`
- Active branch: `claude/trusting-elbakyan-c75021` (lots of uncommitted
  history on main-relative; do not force-merge)
- Supabase project: `wzwwtghtnkapdwlgnrxr` (EU, use the supabase MCP)
- Edge Function: `supabase/functions/whatsapp-webhook/index.inlined.ts`
  (~420KB, deploy via Supabase Dashboard paste — NOT via MCP deploy)
- Outbound drain: SQL function `drain_outbound_queue()`, pg_cron every min,
  10/hr cap. Current state in `supabase/migrations/2026_04_18_drain_outbound_queue_v3.sql`
- WhatsApp provider: Whapi.Cloud (webhook v149 at last deploy)

## Where to start

Read these first, in order:
1. Project memory `session_20260418d` and `project_outbound_drain_v3`
   — state of play
2. `feedback_trust_incident_data_over_policy` — do not wave away my
   incident data with policy docs
3. `CLAUDE.md` in repo root — all conventions, gotchas, and anti-patterns
4. Last 3 git commits on `claude/trusting-elbakyan-c75021`

## Bug hunt — specific things to look for

These are active suspicion areas. Triage + propose, don't execute
destructively without confirming.

### 1. Drain — did the unhalted 21 + today's welcomes actually land cleanly?

```sql
-- Overnight drain health
SELECT
  message_type,
  COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at > NOW() - INTERVAL '12 hours') AS sent_last_12h,
  COUNT(*) FILTER (WHERE attempts = 99) AS superseded_total,
  COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts < 3) AS still_pending,
  COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts >= 3) AS dead_letter
FROM outbound_queue GROUP BY 1;

-- Superseded reasons (should show cross-channel guard firing)
SELECT metadata->>'superseded_reason' AS reason, COUNT(*)
FROM outbound_queue WHERE attempts = 99 GROUP BY 1 ORDER BY 2 DESC;

-- Any still-pending rows stuck past their scheduled_for?
SELECT id, message_type, scheduled_for, queued_at, attempts, phone_number
FROM outbound_queue
WHERE sent_at IS NULL AND attempts < 3 AND scheduled_for < NOW() - INTERVAL '2 hours'
ORDER BY scheduled_for LIMIT 10;
```

### 2. Haiku 429s — is the retry path actually firing in production?

Check Supabase Edge Function logs (Dashboard → Logs tab, NOT the MCP
`get_logs` which only returns access logs). Filter for:
- `[HaikuClassifier] 429 rate-limited — retrying after`
- `[HaikuClassifier] 429 retry succeeded`
- `sonnet_escalated_reply` in `whatsapp_messages.classification`

If retries aren't firing: maybe we got Tier 2 bumped overnight (Yaron's
sales email from yesterday) and 429s disappeared. Great if so —
but verify, don't assume.

### 3. Day anchor in Sonnet — are reminders landing on correct dates?

```sql
-- Reminders scheduled today (post-deploy). Cross-reference with user messages.
SELECT rq.id, rq.message_text, rq.send_at,
  (rq.send_at AT TIME ZONE 'Asia/Jerusalem')::timestamp AS send_at_il,
  rq.sent, rq.reference_id
FROM reminder_queue rq
WHERE rq.created_at > '2026-04-18T14:00:00Z'
ORDER BY rq.created_at DESC LIMIT 20;
```

Look for send_at dates that don't match what the user asked. Any
"off by 1 day" pattern returning means `buildDayAnchor` isn't in the
Sonnet prompt path for that message route.

### 4. Welcome Sonnet body — are they actually unique?

```sql
-- Sample 10 recent welcome bodies. Expect distinct wording per row.
SELECT id, phone_number, LEFT(body, 120) AS body_preview, queued_at
FROM outbound_queue
WHERE message_type = 'welcome'
  AND body IS NOT NULL
  AND queued_at > NOW() - INTERVAL '12 hours'
ORDER BY queued_at DESC LIMIT 10;
```

If 10 rows show 3-variant-template-like similarity, `generateUniqueWelcome`
is failing silently and falling back. Check Edge Function logs for
`[WelcomeGen]` warnings.

### 5. Cross-channel dedup false positives

The guard could over-skip — marking recoveries as superseded when they
shouldn't be. For users in family groups where operator activity is
NORMAL (chatty group), any recovery to a 1:1 will be skipped even if
the user's specific ask was never addressed. Check:

```sql
-- How many recovery-type rows got skipped by cross-channel in the last 12h?
SELECT phone_number, metadata->>'superseded_reason' AS reason
FROM outbound_queue
WHERE attempts = 99
  AND message_type IN ('recovery', 'recovery_group')
  AND metadata->>'superseded_at' > (NOW() - INTERVAL '12 hours')::text;
```

If any of those users messaged me in the last 48h with an unresolved
ask, we over-skipped. Tradeoff: currently biased toward under-messaging
(safer). If we're missing real recoveries, consider narrowing the
cross-channel window from 24h to 12h or 6h.

### 6. Onboarding state machine drift

`onboarding_conversations.state = "welcome_queued"` rows that are
still `welcome_queued` hours later mean the queue drained but the
state didn't advance. Check:

```sql
SELECT phone, state, message_count, updated_at
FROM onboarding_conversations
WHERE state = 'welcome_queued'
  AND updated_at < NOW() - INTERVAL '2 hours'
ORDER BY updated_at DESC LIMIT 10;
```

If many: either drain is not triggering any state update (it shouldn't,
directly), or the user never sent a 2nd message after the welcome (which
is fine but masks drained/undrained status). handleDirectMessage advances
state on 2nd user message.

## Known deferrals (not bugs, just parked)

- Plan-time dedup in `scripts/plan_recovery_messages.py`
- Prompt caching refactor for Haiku classifier
- Operator phones → settings table (currently hardcoded in drain)
- Recurring reminders as first-class feature (vitamins + Cohen dish)
- Whapi token → Supabase Vault (already exposed in committed migrations)
- `update_reminder` intent when user corrects a just-made reminder

These are visible in memory + CLAUDE.md. Don't start on them
unless specifically asked — they're each 1-2hr focused work.

## How to work today

- Propose before executing anything destructive. Show SQL diffs first.
- esbuild parse-check BEFORE asking to deploy Edge Function
  (`npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js`)
- Never mass-message users. 10/hr drain cap is non-negotiable.
- When you fix something, commit with a descriptive message on the
  active branch. Don't touch main directly.
- If you discover a bug in my incident data interpretation, say so —
  but my field data beats policy docs (see `feedback_trust_incident_data_over_policy`).

Start by running items 1-6 above in parallel where possible, then
report a prioritized punch list. Don't start fixing until we agree
on priority.
