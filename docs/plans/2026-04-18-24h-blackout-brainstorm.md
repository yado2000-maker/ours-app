# Fresh-session prompt — 24h WhatsApp ban blackout brainstorm

Copy-paste below into a fresh Claude Code session in `ours-app`.

---

I'm Yaron, building Sheli — Hebrew WhatsApp family-assistant bot.

## Situation

As of 2026-04-18 evening IL, we're in a **24-hour WhatsApp Business linked-device restriction**.

- **Bot phone** (+972 55-517-5553): can still send/receive messages from **my physical phone** (the WhatsApp Business app), but Whapi's linked device connection is severed. No programmatic access for ~24h.
- **Whapi dashboard**: channel status = QR (connection broken). Do NOT re-scan the QR during the restriction window — scanning would likely extend/permanent the ban.
- **Our webhook**: URL is saved in Whapi, but Whapi isn't pushing anything because there's nothing to push.
- **Silent mode** (`BOT_SILENT_MODE=true` env var) is deployed as belt-and-suspenders — any outbound attempt via `sendAndLog` gets suppressed + audit-logged. When the ban lifts, this prevents accidental reboot-floods.
- **`drain_outbound_queue` cron** is unscheduled. **`fire-reminders` cron** is unscheduled. Nothing proactive will fire.
- **Web app** (sheli.ai): fully functional. DB is fine. Users signed up there can still manage their data.
- **User impact**: we had a growing backlog of 1:1 new users and active beta families (5+ households). "100 to 1000 active users" is the scale we're scared of losing to churn during blackout.
- **Revenue impact**: we're in beta mode, but trust is the product. Users who message Sheli and get silence for 24h may never come back.

## Read first

- Memory: `session_20260418c` (morning recovery execution), `session_20260418d` (evening incident), `feedback_trust_incident_data_over_policy`
- Repo: `C:/Users/yarond/Downloads/claude code/ours-app`, active branch `claude/trusting-elbakyan-c75021`
- CLAUDE.md
- Recent commits on active branch

## The brainstorm I need

We have ~24 hours of WhatsApp blackout. Help me figure out:

### 1. How to keep users engaged and informed without outbound WhatsApp

What's possible with: web app, my personal WhatsApp (manual typing only, ~20-30/hr safe cap), email (if we have addresses), SMS (not wired up), social media, SEO landing page, new users still signing up on sheli.ai?

Constraints:
- Zero automated outbound from bot phone (ban).
- Zero automated outbound from Yaron's personal phone (would trigger the same anti-spam signal).
- Manual typing from me is fine at human pace but I can only do ~20-30/hr without burning out.
- Users outside the beta don't have email addresses stored.
- Users inside the beta DO have email addresses (via Supabase auth).

### 2. How to capture user intent while Whapi is dark

Users are presumably still messaging Sheli. Messages go to the bot phone but Whapi can't see them. We lose the data. Brainstorm:
- Can we pull message history from the bot phone manually at end of ban? (WhatsApp Business export? screenshots? iCloud backup?)
- Should I manually log key user asks into the DB via the web app as I see them on my phone?
- Is there a path via a secondary Whapi channel on a different number to proxy messages (too risky)?

### 3. How to prep a safe restart at hour 24

- Silent mode stays on for the first 2-3 hours after reconnect
- Manual triage of `silent_mode_suppressed` rows
- Drain cron stays OFF for 48-72h after ban lifts
- Slow ramp of reactive replies only
- What specific verification steps before flipping BOT_SILENT_MODE=false?
- How to handle users whose data was lost during blackout — do we apologize and ask them to re-share? or silently resume?

### 4. Structural changes to prevent the next ban

The cycle was: ban → recovery campaign → ban → silent mode. Clearly we're too aggressive.
- Should we move to Meta's official Cloud API (vs Whapi)? Cost + approval tradeoffs.
- Should we shard across multiple phone numbers — one per household? Technically complex, expensive, but isolates ban risk.
- Should we add a second fallback number as backup?
- Should we drastically reduce drain velocity (3/hr instead of 10/hr) permanently?
- Should proactive outbound be entirely eliminated from the system, and all user re-engagement come from web push notifications instead?

### 5. Leveraging the 24h for other work

- Implement prompt caching for Haiku classifier (deferred; ~80-90% ITPM + cost reduction)
- Fix deferred bugs from `docs/plans/2026-04-19-bug-hunt-prompt.md`
- Implement `update_reminder` intent properly (avoid duplicate-reminder bug from today)
- Plan-time dedup in `scripts/plan_recovery_messages.py`
- Move Whapi token + operator phones from hardcoded to a settings/vault layer

## How I want this session to run

- Start with the brainstorm (options + tradeoffs, not implementation).
- Prioritize by: user-trust-impact × feasibility within 24h.
- Don't jump to code until we agree on the shape.
- Be honest about what's impossible or ban-risky.

Constraints on anything you propose:
- **Zero outbound from bot phone**. Full stop.
- **Manual typing from me** is the only "send message" tool.
- **Don't propose re-scanning Whapi QR during the ban window.**
- **Don't propose workarounds that silently circumvent WhatsApp** (extending the ban).
- **Trust my incident data over Meta policy docs.**

Top priorities in rough order:
1. User communication (what do users see during blackout? how do we reduce churn?)
2. Safe restart plan at hour 24
3. Structural fix so this doesn't recur at 10x scale

Go.
