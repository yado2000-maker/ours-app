# Fresh-session prompt — webhook gap fix (1:1 phones missing from DB)

Copy-paste below into a fresh Claude Code session in `ours-app`. This is a **planning prompt**, not an implementation prompt — produce a written plan and get approval before touching the Edge Function.

---

I'm Yaron, building Sheli (שלי) — a Hebrew WhatsApp family-assistant bot. We're in the recovery window after a WhatsApp anti-spam ban (2026-04-17) triggered by a viral FB post that pushed 1,500+ inbound 1:1 signups in <24h. All outbound is paused via the 3-layer kill switch; landing CTAs route to `/waitlist`; Cloud API migration is on the roadmap but not shipped.

During the ban-recovery audit we found a silent loss pattern that is **leaking paying-candidate users**. This session's job is to produce a written plan to close it.

## The bug in one paragraph

Of 15 recent 1:1 phone numbers visible in Whapi `/chats` during the viral-post window, **only 7 have any row in `whatsapp_messages`**. The Edge Function returns 200 on every request and `get_logs` shows no errors, yet ~50% of incoming 1:1 messages never land in the DB. Because the webhook returns 200, neither Whapi nor Supabase retries. The users never get the waitlist redirect, never appear on the admin dashboard, and are silently lost.

At current economics (Premium 9.90 ILS / Family+ 19.90 ILS household tiers), every lost phone is roughly one lost paying-candidate household. At the viral-post scale this is the single highest-leverage reliability bug in the product.

## Repo / stack quick-ref (read before proposing anything)

- Repo: `/home/user/ours-app` (active branch `claude/analyze-shelley-pmf-tn0X9`)
- Supabase project: `wzwwtghtnkapdwlgnrxr` (EU, supabase MCP available)
- Edge Function: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~7,900 lines, deploy via Supabase Dashboard paste — NOT via MCP deploy; see CLAUDE.md "Deploying: Cursor paste to Dashboard")
- WhatsApp provider: Whapi.Cloud (v149 at last deploy). Meta Cloud API provider class exists in file but not yet wired to production.
- Project memory: session `20260418d` + `project_outbound_drain_v3` + `feedback_trust_incident_data_over_policy`. Bug-hunt prompt at `docs/plans/2026-04-19-bug-hunt-prompt.md` is the sibling to this one.
- CLAUDE.md TODO entry "🚨 Webhook message gap" has the field data and suspect list. Read it first.

## What's already known about this bug

From CLAUDE.md and the 2026-04-18 audit:

> Messages are dying between webhook entry (`Deno.serve`) and `logMessage` call. Candidates:
> - `parseIncoming` returning null for specific payload shapes (quoted / reply / forwarded)
> - Whapi history-sync messages showing in `/chats` without being webhooked at all
> - Dedup hitting first-time messages with a `messageId` that matches something already logged
> Needs: verbose `console.log` at each early-return site in `Deno.serve` handler (lines 5277–5590 of `index.inlined.ts`), redeploy, live test with a phone we know drops (Liad `+972 52-424-8151` is a reliable repro).

Partial instrumentation already exists:
- `[Webhook:DIAG]` one-line summary on every webhook (index.inlined.ts:5325) logs top-level keys, msg count, m0 fields
- `[WhapiProvider:DIAG] parseIncoming null` lines at 240 and 257 log the two null-return paths in the Whapi parser
- `[Webhook:DIAG] empty-text skip` at 5547 logs empty-text drops

These were landed during the 2026-04-18 audit but have NOT yet been used to close the loop on the 50% gap — nobody has grepped prod logs for a known-drop phone and reconciled against `/chats`.

## Early-return map — Deno.serve (index.inlined.ts:5277 onward)

Every one of these exit paths is a candidate silent drop. The plan needs to cover every one.

| Line  | Branch                                   | Current logging                  | Known risk                                      |
|-------|------------------------------------------|----------------------------------|-------------------------------------------------|
| 5290  | GET verification fail                    | none                             | low (wrong mode/token — benign)                 |
| 5295  | Non-POST method                          | none                             | low                                             |
| 5303  | Invalid webhook signature                | `console.warn` only              | medium (mis-configured `WHAPI_WEBHOOK_TOKEN`?)  |
| 5332  | Group event dispatched                   | inside `handleGroupEvent`        | medium (mis-classified as group event)          |
| 5341  | `parseIncoming` returned null            | sub-cause in parseIncoming:DIAG  | **HIGH — prime suspect**                        |
| 5357  | Duplicate message_id                     | `[Webhook] Duplicate...` log     | **HIGH — first-time msg collisions?**           |
| 5371  | Bot-self message                         | `[Webhook] Manual operator...`   | low (legitimate)                                |
| 5414  | Long voice (>30s)                        | full log                         | low                                             |
| 5422  | Voice transcription failed               | full log                         | low                                             |
| 5535  | Non-text / non-voice type early exit     | depends on branch                | medium                                          |
| 5548  | Empty text after trim                    | `[Webhook:DIAG] empty-text skip` | medium (text-extraction bug?)                   |
| 5563  | Admin `/command` handled                 | `admin_command` logMessage       | low                                             |
| 5583  | Identity probe / injection deflect       | full log                         | low                                             |
| 5589  | `handleDirectMessage` branch taken       | internal to handler              | **HIGH — handler has its own early returns**    |

Plus `handleDirectMessage` itself (line 4060) has internal early returns at 4068 (non-text+non-voice), 4137 (rename shortcut), 4162 (mapping-found personal), 4228 (new user waitlist redirect), 4248 (re-ping), 4280 (joined/personal safety). Any of those that land WITHOUT calling `logMessage` are invisible silent exits.

## Hypotheses to test — ranked

**H1 (most likely): Dedup collision on Whapi history-sync.** When Whapi re-pairs after the ban it replays messages. If a replay shares `messageId` with a previously logged row, the 5349-5358 dedup block swallows the "new" message. But we can't verify without a log line on the swallow path that includes the sender_phone and group_id. Today the log says only "Duplicate message {id}".

**H2: `parseIncoming` returns null for non-standard payload shapes.** Whapi sends quoted replies, forwards, reply-to-my-message, system events, and edited messages. The parser only handles `messages[0]` — any envelope without `messages[]` or with an unknown `chat_id` suffix falls through. Diagnostic already exists (240, 257); it has not been analyzed at volume.

**H3: `handleDirectMessage` early-returns without audit logging.** Several branches (waitlist-redirect, re-ping, joined-safety) call `sendAndLog` but NOT `logMessage`. `sendAndLog` refuses to audit-log when `householdId === "unknown"` (fixed 2026-04-19 to prevent FK violations). So for brand-new unknown-phone users, we send the waitlist redirect but never record the INCOMING message. Re-check 4173-4228: is the inbound logged? If not, this alone accounts for most of the gap.

**H4: Whapi history-sync messages never hit the webhook.** Whapi's `/chats` endpoint shows conversations visible via the linked device even if the webhook was detached at the time of delivery. After re-pairing, some messages may only appear via `/messages/list` polling, not via push. If true, the "fix" isn't webhook instrumentation — it's a reconciliation cron that compares `/chats` members vs `whatsapp_messages` phones and backfills via `/messages/list`.

**H5: Signature verification occasional false negatives.** If `WHAPI_WEBHOOK_TOKEN` is mis-set and requests fail verification, they 401 instead of 200. `console.warn` fires but doesn't carry the sender phone. Cross-check with Whapi dashboard delivery stats.

H3 and H1 together probably cover the majority. H4 is the wildcard that would change the fix class entirely.

## What I want from this session

Produce a written plan at `docs/plans/2026-04-20-webhook-gap-fix-plan.md` with this structure:

1. **Measurement phase (non-destructive).** Add verbose `console.log` lines at every early-return site in `Deno.serve` AND every early-return in `handleDirectMessage`. Each log line must include: `sender_phone`, `group_id`, `message_id`, `chat_type`, `type`, `body_keys` (JSON.stringify top-level keys). One line per exit, unique prefix (`[Webhook:EXIT:<code>]`) so a single grep reconstructs the full drop inventory. esbuild parse-check before asking to deploy. Commit on current branch before asking for Dashboard paste.
2. **Reconciliation query.** A Supabase SQL block that, given a list of phones from Whapi `/chats`, returns which ones have zero rows in `whatsapp_messages` in the last N hours. Runnable by me without code changes.
3. **Hypothesis validation.** For each of H1-H5, state the specific log-line pattern or SQL query that proves or disproves it. Don't pre-commit to a fix before the data tells us which hypothesis is real.
4. **Fix tiers.**
   - **Tier A (must ship):** whichever branch(es) the data implicates. Minimum viable patch — don't rewrite the handler.
   - **Tier B (should ship):** add `logMessage` to every `handleDirectMessage` early-return that currently exits silently, so future gaps are observable even if logic is buggy. Pure observability insurance.
   - **Tier C (nice-to-have, park if scope creeps):** Whapi `/messages/list` reconciliation cron to backfill history-sync drops. Only needed if H4 holds.
5. **Acceptance test.** Specific repro with Liad's phone (`+972 52-424-8151`) — or a freshly-sourced reliable-drop phone if Liad's behavior has shifted. Define what "fixed" looks like: all inbound messages from a test phone produce at least one row in `whatsapp_messages` within 5 seconds, AND the drop rate computed by the reconciliation query in step 2 drops below 5% over a 24h window.
6. **Rollout + rollback.** esbuild-verify locally → commit → Dashboard paste → watch `get_logs` for 10 minutes → run reconciliation query. Rollback = revert the commit + re-paste.
7. **Risks + non-goals.** Explicitly: do NOT extend `handleDirectMessage` logic. Do NOT change dedup semantics without data. Do NOT enable any outbound that's currently kill-switched. Do NOT touch the Cloud API migration path (separate branch, separate plan).

## Constraints (hard)

- Kill switches remain ON. Measurement-phase logging does not un-pause outbound. If the plan ever needs to flip `BOT_SILENT_MODE` or `bot_settings.outbound_paused`, call it out explicitly at the top of that section and require my approval.
- Never mass-message users. Reconciliation backfill (if H4) is a DB-write-only path at first — no user-facing replies. Any user-visible message requires a separate plan.
- Edge Function deploy is Dashboard-paste only. MCP `deploy_edge_function` will fail (file too large). Supabase CLI is not installed.
- esbuild parse-check is mandatory before any deploy request: `npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js`. Don't ask for a deploy if it fails.
- Commit-before-deploy: Dashboard paste deploys from your local file. Uncommitted local changes that land live can be lost on any future machine-death or `main` merge. Pattern: commit on `claude/analyze-shelley-pmf-tn0X9` (current branch) → then request Dashboard paste.
- Don't start on any other TODO. This plan is scoped to the webhook gap only. Family+ pricing, Cloud API migration, recurring reminders — all out of scope.

## How to work today

1. Read CLAUDE.md end-to-end (it's long; skim if you must, but the gotchas matter).
2. Read the Deno.serve handler from line 5277 to 5600 and `handleDirectMessage` from 4060 to 4500. Map every early return yourself — don't trust my table above if your read differs.
3. Read migrations `2026_04_18_drain_outbound_queue_v3.sql` and `2026_04_19_outbound_kill_switch.sql` for kill-switch context (so you don't accidentally suggest anything that bypasses them).
4. Inspect `whatsapp_messages` schema in Supabase to confirm column names (sender_phone nullable, household_id NOT NULL + FK, etc.) before proposing queries.
5. Write the plan file. Keep it under 400 lines. Numbered tasks. Each task = a concrete command, SQL, or diff — no vague "investigate X" items.
6. When you're done, post the plan path + a 5-bullet summary in chat. Don't start executing any task. I'll read, give feedback, and approve tier by tier.

**Time budget for the plan itself: ~45 minutes of reading + ~30 minutes of writing. If the plan is going longer, the scope is wrong — come back and ask.**
