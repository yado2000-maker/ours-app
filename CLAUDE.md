# sheli (שלי) — Your Smart Helper on WhatsApp

## Architecture
- **Frontend:** React 19 + Vite 8, deployed on Vercel (sheli.ai)
- **Backend:** Supabase (project: wzwwtghtnkapdwlgnrxr, region: eu-central-2)
- **AI:** Two-stage pipeline for WhatsApp bot (Haiku 4.5 classifier → Sonnet 4 reply generator); Sonnet 4 via /api/chat (web app)
- **WhatsApp Bot:** Supabase Edge Function (whatsapp-webhook), Whapi.Cloud provider. Handles both group + 1:1 direct messages.
- **Landing Page:** LandingPage.jsx — bilingual HE/EN toggle, two-path routing: sheli.ai (cold traffic), ?source=wa (WA users skip to auth)
- **1:1 Onboarding:** Bot handles direct messages (handleDirectMessage) with state machine (WELCOME→WAITING→ONBOARDED→ACTIVE) + pattern-based Q&A
- **Auth:** Supabase Auth (Google OAuth + email/password + phone OTP via WhatsApp/Vonage)
- **Billing:** iCount (icount.co.il) — invoicing + CC processing + standing orders. API v3 at `api.icount.co.il/api/v3.php` (SID-based auth). Terminal not yet activated (beta mode).
- **Bot phone:** +972 55-517-5553 (eSIM Plus virtual number, WhatsApp Business)

## Key Files
- `src/App.jsx` — Main app (refactored from 1,435-line monolith)
- `src/lib/supabase.js` — Supabase client + V2 data functions (loadHousehold, saveTask, saveAllTasks, loadMessages, insertMessage, etc.) + toDb/fromDb field mappers
- `src/lib/household-detect.js` — Auto-detect household for returning users
- `src/lib/prompt.js` — Claude AI system prompt for web app chat
- `src/components/Icons.jsx` — 30 custom SVG icons (stroke-based, currentColor) incl. ExpenseFeatureIcon, FamilyGroupIcon, KidsIcon
- `supabase/functions/whatsapp-webhook/index.ts` — WhatsApp bot Edge Function (modular source, not deployed directly)
- `supabase/functions/whatsapp-webhook/index.inlined.ts` — **Production deployment file** (~2,200 lines, all 6 modules inlined + group management + batching + 7 SHARED_* prompt constants)
- `supabase/functions/_shared/haiku-classifier.ts` — Stage 1: Haiku intent classifier (9 intents, ~$0.0003/call)
- `docs/plans/2026-04-03-learning-system-design.md` — Two-stream learning system design (approved)
- `docs/plans/2026-04-03-learning-system-plan.md` — Learning system implementation plan (10 tasks, 3 phases)
- `supabase/functions/_shared/reply-generator.ts` — Stage 2: Sonnet reply generator (Sheli personality)
- `supabase/functions/_shared/ai-classifier.ts` — Old monolithic Sonnet classifier (kept as fallback for medium-confidence escalation)
- `supabase/functions/_shared/action-executor.ts` — DB action executor (6 action types incl. assign_task)
- `supabase/functions/_shared/whatsapp-provider.ts` — Provider abstraction (Whapi.Cloud + Meta Cloud API)
- `supabase/functions/otp-sender/index.ts` — Phone OTP delivery via Supabase Send SMS Hook (WhatsApp primary via Whapi.Cloud, Vonage SMS fallback, post-auth bridge message)
- `tests/classifier_eval.py` — Classifier eval runner (120 cases, Python, batch-of-5 for Tier 1 rate limits)
- `tests/classifier-test-cases.ts` — 120 test fixtures for intent classifier (TypeScript reference)
- `src/components/LandingPage.jsx` — Bilingual landing page (hero, WA mock, 6 feature cards, family section, FAQ)
- `src/styles/landing.css` — Landing page styles (mobile-first, RTL)
- `public/qr-whatsapp.svg` — QR code linking to wa.me/972555175553
- `supabase/functions/icount-webhook/index.ts` — iCount payment webhook handler
- `src/components/ExpensesView.jsx` — Read-only expenses tab (per-currency totals, category/period filters, RTL)
- `docs/plans/2026-04-16-expenses-design.md` — Expenses feature design (approved)
- `docs/plans/2026-04-16-expenses-plan.md` — Expenses implementation plan (12 tasks, completed)
- `docs/implementation-plan-v3.md` — **Active** implementation plan (replaces V2)
- `scripts/import_whapi_backlog.py` — Capability A: Whapi `/messages/list` backfill, QR-safe (exits clean if channel unpaired). Handles both 1:1 and group chats; `import_batch` buffers all pages first then runs per-group resolution tracking (a group message on page 2 might resolve a page-1 ask).
- `scripts/import_chat_exports.py` — Capability B: parse WhatsApp Business `.txt` exports, materialise tasks/shopping/events/reminders/expenses, idempotent. Supports 1:1 files (`{phone}_{name}.txt` filename inference) AND groups (require entry in `recovery_exports/manifest.json` — no way to infer group identity from filename).
- `scripts/plan_recovery_messages.py` — Capability C: Sonnet-generated recovery messages, stages to `outbound_queue`. Two buckets: groups first (`message_type='recovery_group'`, unified per-group Sonnet message addressing each unresolved user by name), 1:1 after (`message_type='recovery'`). CLI: `--groups-only`, `--direct-only`, `--group-spread-hours`, `--direct-start-offset-hours`.
- `scripts/_common.py` — shared helpers for recovery scripts (Supabase REST, Haiku/Sonnet, sha1 dedup IDs)
- `tests/test_recovery.py` — 30 offline unit tests for recovery toolchain (parse regexes, system-msg skip, ~ prefix, per-message resolution, unified group generator, schedule spread, dedup IDs)
- `docs/plans/2026-04-18-welcome-throttle-plan.md` — welcome-throttle implementation plan
- `docs/plans/2026-04-18-morning-recovery-runbook.md` — ordered ban-lift playbook (apply migrations → deploy → re-pair → import → plan → re-enable webhook → monitor) with rollback section

## Database: Normalized V2 Tables (migration completed 2026-04-02)
- **Await all deletes before Realtime re-fetch** — Non-awaited `supabase.delete()` races with Realtime `postgres_changes`. Bulk deletes (clear cart, clear done) fire N events; trailing events slip past 3s debounce → items reappear. Pattern: `lastSaveRef = now(); await delete(); lastSaveRef = now();`
- **Schema:** `households_v2`, `tasks`, `shopping_items`, `events`, `household_members`, `messages`, `ai_usage`, `subscriptions`, `referrals`, `whatsapp_*`, `reminder_queue`, `onboarding_conversations`, `family_memories`
- `onboarding_conversations` — 1:1 chat state machine (phone, state, household_id, message_count, referral_code)
- `family_memories` — Narrative context for Sheli personality. Fields: `id`, `household_id` (FK CASCADE), `member_phone`, `memory_type` (moment/personality/preference/nickname/quote/about_sheli), `content`, `context`, `source` (auto_detected/explicit_save/correction), `scope` (group/direct), `importance` (0.0-1.0), `created_at`, `last_used_at`, `use_count`, `active`. RLS enabled, no policies (service_role only). Max 10/member + 10 household-wide. 2-day freshness gate + 24hr cooldown before Sonnet can reference.
- `expenses` — Household expense tracking. Fields: `id` (TEXT PK), `household_id` (TEXT FK CASCADE), `amount_minor` (INTEGER, minor currency units — agorot/cents), `currency` (TEXT, ILS/USD/EUR/GBP), `description`, `category`, `paid_by`, `attribution` (speaker/named/joint/household), `occurred_at`, `visibility` (household/private), `source`, `source_message_id`, `logged_by_phone`, `edited`, `deleted`, `deleted_at`. RLS enabled, `is_household_member`. Realtime enabled. Soft-delete forever (money audit trail).
- `whatsapp_config` added columns: `dashboard_link_sent`, `first_message_at`, `group_message_count`
- `subscriptions` added column: `stripe_customer_id` (legacy name, used for any payment provider)
- RPC: `increment_group_message_count(p_group_id)` — atomic counter for dashboard link trigger
- **All FKs cascade** from `households_v2` — deleting a household clears all child data
- **Web app + WhatsApp bot both read/write V2 tables only** — no blob, no dual-write
- **Old `households` blob table still exists** (not dropped) but is unused — safe to drop when confident
- **Field mapping:** DB uses snake_case (`assigned_to`), JS uses camelCase (`assignedTo`). `toDb`/`fromDb` mappers in supabase.js handle the boundary.
- **Messages** stored in Supabase `messages` table (moved from localStorage 2026-04-02)
- **Bulk AI writes use upsert→prune** (not delete→insert). `saveAllTasks/Shopping/Events` upsert first, then delete orphans only after upsert succeeds. If upsert fails, existing data is untouched. (Fixed 2026-04-06, was delete→insert which lost data on network failure.)
- **Realtime:** 5 channels (tasks, shopping_items, events, households_v2, messages) with 3s echo debounce
- **RLS tightened (2026-04-08):** All tables now use `is_household_member(household_id)` for CRUD. Upsert-safe: INSERT WITH CHECK and UPDATE USING use the same `is_household_member` check, so upserts pass both paths identically. `household_members` INSERT uses `(user_id = auth.uid() OR is_household_member(household_id))` to allow self-join and founder adding members. Bot-only tables (`classification_corrections`, `global_prompt_proposals`, `household_patterns`) have RLS enabled with no policies (service_role only).
- **Supabase upsert RLS gotcha (historical):** `.upsert()` checks INSERT policy first, even for existing rows. Fixed by making INSERT and UPDATE use the same check (`is_household_member`). Previously all INSERT policies were relaxed to `auth.uid() IS NOT NULL`.
- `outbound_queue` (2026-04-18, extended for groups same day; drain hardened same day, migration `2026_04_18_drain_outbound_queue_v3.sql`) — Rate-limited Whapi outbound carrier. Columns: `id` UUID PK (surrogate), `phone_number` TEXT nullable, `chat_id` TEXT nullable (group JIDs or `group_synthetic_*`), `household_id` TEXT nullable, `display_name`, `scheduled_for`, `template_variant` (nullable SMALLINT 1-3), `body` TEXT, `message_type` TEXT (`welcome`|`recovery`|`recovery_group`), `metadata` JSONB, `sent_at`, `attempts`, `queued_at`. Partial UNIQUE index on `(phone_number) WHERE message_type='welcome' AND phone_number IS NOT NULL` preserves the 1:1 welcome `ON CONFLICT (phone_number)` upsert semantic. `render_shape` CHECK: welcome→template+phone, recovery→body+phone, recovery_group→body+chat_id. RLS enabled, no policies (service_role only). Drained by `drain_outbound_queue()` SQL function via pg_cron `* * * * *` — hard cap **10 sends per rolling hour** across ALL message types (bumped from 6 on 2026-04-18 post-incident; avg 1 every 6 min, safely below the ~50-in-minutes burst that triggered the 2026-04-17 ban). Drain routes via `COALESCE(chat_id, phone_number || '@s.whatsapp.net')` and locates rows by surrogate `id`. **Drain sort priority (v3):** welcome=0, recovery=1, recovery_group=2 — real-time new users drain before yesterday's backlog. Within type, oldest `queued_at` first (window-preserving — protects welcomes closest to 24h customer-care expiry). `FOR UPDATE SKIP LOCKED` race-safe. pg_net fire-and-forget; HTTP failures don't auto-retry (optimistic `sent_at`, `attempts<3` gate). Old `welcome_queue` name aliased via forwarder `drain_welcome_queue()`.
- **Drain v3 safety rails (2026-04-18)** — four pre-send checks before each Whapi call:
  1. **24h customer-care-window expiry** (welcomes only): if `queued_at < NOW() - 23h30m`, mark `attempts=99` + `metadata.superseded_reason='24h_customer_care_window_expired'`. A welcome past-window is proactive outreach, riskier.
  2. **Cross-channel operator dedup**: skip if any operator (bot `972555175553` or Yaron's personal `972525937316` — hardcoded `v_operator_phones` array) replied in ANY chat the target participates in within 24h. Chats = target's 1:1 (`phone@s.whatsapp.net`) ∪ group_id from `metadata.household_id` via `whatsapp_config` ∪ group_ids from `whatsapp_member_mapping` for target phone. Prevents נעמי-style pattern where operator resolves in family group but Sheli DMs the same topic.
  3. **Body preference**: if `body IS NOT NULL` use it, else for welcomes call `render_welcome_template(variant, display_name)`. Lets Edge Function queue-time-generate unique Sonnet welcomes in `body` to lower text-similarity signal.
  4. **Empty-msg guard**: any empty `v_msg` increments attempts without sending.
- **`outbound_queue.metadata.superseded_reason` convention** — reserved values: `24h_customer_care_window_expired`, `operator already engaged this user (cross-channel) within 24h`, `bot or operator already replied within 24h` (pre-v3), `emergency_halt_<reason>` (manual SQL UPDATE with `attempts=99`). Count superseded reasons anytime with `SELECT metadata->>'superseded_reason', COUNT(*) FROM outbound_queue WHERE attempts=99 GROUP BY 1`.
- **Welcome-body generation** — `handleDirectMessage` calls `generateUniqueWelcome(displayName, firstMessage)` before the `outbound_queue.upsert`. Sonnet model `claude-sonnet-4-20250514`, max_tokens=256, ~$0.01/welcome, 2-3s latency. Returns null on API failure; drain falls back to SQL template. Unique bodies dramatically reduce the text-similarity signal the WhatsApp anti-spam classifier scores during outbound bursts.
- **Migrations must apply in this exact order:** (1) `2026_04_18_welcome_queue.sql` creates `welcome_queue` + first drain, (2) `2026_04_18_outbound_queue_recovery.sql` ALTER-renames → `outbound_queue`, adds body/metadata + recovery type, (3) `2026_04_18_outbound_queue_groups.sql` swaps PK to surrogate UUID, adds chat_id+household_id, allows NULL phone, adds recovery_group + group-first drain sort. Each file ASSUMES prior state; NEVER run 2 or 3 alone.
- **Recovery imports use sha1 synthetic message IDs** — `import-{sha1(phone_or_groupid|name|ts_iso|text)[:12]}`. WhatsApp `.txt` exports strip real message IDs; idempotency comes from content-hashing. For group messages where the sender's phone isn't known, the dedup key includes `name:<sender_name>` instead. Deterministic → re-running the importer on the same file is a no-op.
- **Group recovery per-message state lives in JSONB** — `whatsapp_messages.classification_data->>'recovery_state'` ∈ `{handled, needs_recovery, low_intent}`. No schema migration needed. 30-min window to next bot reply; `reply_resolves_ask()` uses word-overlap fast-path then Sonnet yes/no judge only when needed. Planner queries `classification_data->>'recovery_state'=eq.needs_recovery` to build the unified group message's unresolved-user list.
- **recovery_exports/manifest.json** — optional for 1:1 (filename inference fallback), REQUIRED for groups. Schema: `{"files":[{"path","type":"direct"|"group","phone?","group_id?","existing_household_id?","group_name?","display_name?"},...]}`. Existing beta groups MUST set `existing_household_id` to prevent duplicate household creation. New groups with neither `group_id` nor `existing_household_id` get a synthetic group_id + metadata `{synthetic_group:true, awaiting_real_jid:true}`.
- **Past reminders imported from backlog** must be inserted with `sent=true, sent_at=send_at` (correct column names — see `reminder_queue schema reality` under WhatsApp Bot Gotchas). If inserted with `sent=false` and a past `send_at`, the reminder cron will fire them today, producing phantom reminders for yesterday's events.
- **WhatsApp chat export format differs between platforms** — iOS / WhatsApp Business app: `[DD.MM.YYYY, HH:MM:SS] Sender: body` (bracketed, colon-separated time, seconds). Android / WhatsApp Web: `DD/MM/YYYY, HH:MM - Sender: body` (no brackets, dash separator, no seconds). `scripts/import_chat_exports.py` only parses the iOS format; `scripts/preprocess_whatsapp_exports.py` converts Android exports → iOS format + generates `recovery_exports/manifest.json` (normalizes filenames too: strips "WhatsApp Chat with " prefix, maps known households by Hebrew group name, slugifies unknowns to ASCII).

## Supabase Gotchas
- **RLS blocks everything when auth.uid() is NULL** — Supabase client with publishable key + auth session sends JWT. If JWT is stale/expired, auth.uid() returns NULL and all RLS policies fail silently.
- **Clock skew warning** (`Session as retrieved from URL was issued in the future`) — indicates JWT timestamp mismatch. Can cause auth.uid() to be NULL. Fix: clear localStorage and re-authenticate.
- **RLS tightened for launch (2026-04-08)** — all core tables use `is_household_member(household_id)`. See security audit: `docs/plans/2026-04-08-security-audit-design.md`.
- **Use JWT anon key, NOT publishable key** — `sb_publishable_...` format causes 406 errors on raw REST calls (PostgREST rejects non-JWT tokens). Always use the legacy `eyJhbG...` anon JWT. Both are available in the project.
- **Edge Functions use service_role key** (bypasses RLS). Web app uses anon JWT key (goes through RLS).
- **Realtime must be explicitly enabled** per table: `ALTER PUBLICATION supabase_realtime ADD TABLE public.tablename;`
- **`household_members` has `USING (true)` fallback policy** — needed because clock skew made auth-based policies unreliable

## React / Boot Flow Gotchas
- **Boot useEffect tracks by `lastSessionId` ref** — re-runs when session changes (null → valid), skips token refreshes
- **1.5-second auth timeout** — if getSession hangs (incognito/fresh), resolves with null after 1.5s → welcome screen
- **Functional setState for screen transitions** — `setScreen(prev => prev === "loading" ? "welcome" : prev)` prevents overwriting active screens
- **Modals render OUTSIDE `.app` div** (in React fragment) — they DON'T inherit font-family from `.app[dir="rtl"]`. Must set fontFamily explicitly on `.modal` class.
- **StrictMode double-renders in dev** but not production — don't debug prod issues assuming double-render
- **Guard refs need `try/finally`** — `setupRunning.current = true` must be reset in `finally` or the action permanently locks.
- **Sign-out must clear localStorage** — `sheli-hhid`, `sheli-user`, `sheli-founder` persist across sessions, causing cross-user data leaks if not cleared.
- **`send()` must use refs, not state** — `tasksRef.current` not `tasks` inside async `send()` to avoid stale closures on rapid sends.
- **`analytics.track()` does NOT exist** — `analytics` object only has named methods. For custom events: `import { analytics, track } from "../../lib/analytics.js"` and call `track("event_name")` directly.
- **Password reset hash** — Don't strip URL hash before Supabase `onAuthStateChange` processes the recovery token. Listen for `PASSWORD_RECOVERY` event first.
- **Landing page → auth language** — Landing is Hebrew-only; call `setLang("he")` before `setScreen("auth")`.
- **`uid()` generates 8-char IDs** — was 4-char (collision risk at ~1300 items). AI prompt also requests 8-char IDs.
- **Realtime handlers query own table only** — not `loadHousehold()` which queries all 5 tables. Each channel reloads just its table.
- **API proxy (`api/chat.js`)** — Auth-protected (Supabase JWT), model-whitelisted (Sonnet/Haiku only), rate-limited (20/min/user), max_tokens capped (4096). Env var: `ANTHROPIC_API_KEY` (NOT `VITE_` prefix — server-only).

## Design System (v2, 2026-04-06)
- **Primary:** Coral `#E8725C` (brand, wordmark, badges, step numbers)
- **Accent:** Green `#2AB673` (Sheli's voice, confirmations, nav indicator)
- **WhatsApp CTA:** Muted forest green `#2D8E6F` (not neon WhatsApp green)
- **Dark text:** Teal-gray `#1E2D2D` (cool neutral, not brown) — reserve for TEXT only, too harsh for button backgrounds
- **Button backgrounds:** Use `var(--warm)` (#4A5858) — softer teal-gray that matches palette
- **Never use coral on pink backgrounds** — zero luminance contrast. Use `var(--warm)` or `var(--dark)` on coral/pink cards.
- **Background:** `#FAFCFB` (cool white, not beige)
- **Wordmark:** lowercase "sheli" in Nunito 800, coral→pink gradient (`#E8725C → #D4507A`) with drop shadow
- **Icon:** `/public/icons/icon.svg` — gradient rounded square with white "sheli" wordmark
- **Fonts:** Nunito (EN body + wordmark), Heebo (HE body). Cormorant Garamond removed.
- **Taglines:** HE "העוזרת החכמה שלכם בווטסאפ" / EN "Your smart helper on WhatsApp"
- **Dark theme:** Cool teal-gray (`#141A1A` bg, `#1C2424` cards, `#2A3636` borders) — not warm brown
- **Design doc:** `docs/plans/2026-04-06-design-system.md`

## Analytics
- **PostHog (web app only):** 22 custom events wired via `src/lib/analytics.js`. Key: `VITE_POSTHOG_KEY` (build-time, redeploy required). Dashboard: `us.posthog.com/project/372561`
- **WhatsApp bot analytics:** NOT in PostHog. Query `whatsapp_messages` table in Supabase — `classification` column tracks intent routing (`haiku_actionable`, `batch_actionable`, `haiku_ignore`, etc.)
- **Ad blockers (ABP, uBlock) block PostHog** — `us-assets.i.posthog.com` is on block lists. Test analytics in incognito (no extensions).
- **`person_profiles: "identified_only"`** — anonymous pageview events are captured, but custom events only associate with persons after `identifyUser()` call (post-auth).

## שלי Name Detection (3-layer, 2026-04-06)
- **Layer 1 (regex, pre-classifier):** High-confidence patterns only — שלי at start of message, after greeting/thanks, standalone at end, @mention. Cross-message "של מי" check (90s window) prevents "mine!" false positives.
- **Layer 2 (Haiku classifier):** `addressed_to_bot: boolean` field in classification output. Hebrew grammar guidance in prompt (possessive vs name patterns). When in doubt, prefer possessive.
- **Layer 3 (Sonnet reply):** Emoji energy matching (mirror sender's emotional temperature). Out-of-scope deflection (weather/trivia → varied friendly redirect, HE+EN). Self-knowledge answers (privacy, learning, pricing).
- **Design doc:** `docs/plans/2026-04-06-sheli-name-detection-design.md`

## WhatsApp Bot Gotchas
- **Whapi.Cloud:** Developer Premium ($12/mo), unlimited messages/chats. Paid until 2026-05-07. **Transient webhook drops possible** — one message silently lost during FB launch (2026-04-16, "Individual Proxy Connection: Needs Attention"). No retry mechanism. If a user reports silence, check DB for their phone first, then Whapi webhook logs.
- **Solo groups (user + bot, 2 participants) give ~zero ban-risk benefit vs 1:1 DMs.** Research 2026-04-18: no Meta or BSP doc distinguishes them. Block/report/reply-rate signals identical. Activity density still 1:1. Value is psychological/UX only (habit, pinned lists, family upgrade path), not anti-spam. Do NOT design them as ban mitigation.
- **WhatsApp restriction screen mechanics** — Deterministic countdown (e.g. 23:36:06 → 00:00). During restriction: CAN reply to incoming msgs in existing chats, CAN answer calls, CANNOT start new chats. Linked devices all show "Logged out". **"Link a device" button stays visible but pressing during restriction extends the ban.** Wait for countdown to zero before any reconnect. Reason shown: "sign of spam, automated or bulk messaging" = anti-spam classifier fired, not policy-doc violation.
- **Punctual reminders structurally require Cloud API + Utility templates.** No clever hack exists on Whapi. Every surviving punctual-reminder product (Any.do, Reminder Bot) runs Cloud API. Utility category explicitly lists "appointment reminders" / "payment reminders". Parameterized (`{{1}}=reminder_text`). FREE inside 24h service window; ~$0.01-0.02/msg Israel outside window. Template approval: minutes–24h. At ~200 users × 1 reminder/day ≈ $30/mo.
- **Meta Cloud API migration caveats** — Business verification and phone registration are separate gates. Registering a number is a one-way door: it can never return to WhatsApp Business app, and chat history does not migrate. Cannot register a number currently under an anti-spam restriction. Moving bot phone 55-517-5553 = no manual-app fallback in future incidents; consider registering a DIFFERENT number on Cloud API and keeping 55-517-5553 on Whapi for reactive.
- **WhatsApp anti-spam triggered at ~40 auto-replies/hour (2026-04-17 ban)** — viral FB post drove 500+ 1:1 signups in <24h, bot phone (+972 55 517 5553) hit WhatsApp's anti-spam classifier, restricted for 24h, linked device unpaired. Post-ban hard rule: **all auto-welcomes + mass outbound go through `outbound_queue` at ≤10/hr globally.** Do NOT add a second outbound path that bypasses the drain. If a new feature needs to send to many users (nudges, campaigns, etc.), extend `outbound_queue.message_type` instead.
- **New 1:1 users go through welcome-throttle** (since 2026-04-18): first message classified via Haiku. Actionable intent (add_shopping/task/reminder/event/expense at conf≥0.6) → `context.first_message_intro=true` + falls through to Sonnet which prepends one-line intro. Else → row in `outbound_queue` with `message_type='welcome'`, 30-90s jitter, random template variant 1-3. State `welcome_queued` transitions to `chatting` like `welcomed` on next reply.
- **Whapi `/health` states:** `AUTH` = paired & operational. `QR` = linked device unpaired, needs QR scan from bot phone via Whapi dashboard. `LAUNCH` = still booting. Scripts that touch Whapi must check `/health` first and exit cleanly when != AUTH (see `scripts/import_whapi_backlog.py`).
- **After any ban/restriction, linked device is unpaired** — Whapi webhook URL also often cleared by Whapi itself. Re-pair QR FIRST, then re-add webhook URL, then monitor. Importers read `/messages/list?time_from=<unix>` to backfill the blackout window (Whapi keeps ~30 days of history).
- **WhatsApp Business app chat export** is the always-works fallback when Whapi backfill fails. Menu → More → Export chat → Without media → produces `.txt` with `[DD.MM.YYYY, HH:MM:SS] Sender: body` lines. Phone number is stripped from the body; filename convention `{phone}_{name}.txt` carries it.
- **BOT_SILENT_MODE env var guards sendAndLog + notifyAdmin only** — `drain_outbound_queue()` is a Postgres function that calls `net.http_post` directly, bypassing the Edge Function. A database-level `bot_settings.outbound_paused` flag (migration `2026_04_19_outbound_kill_switch.sql`) defends the drain path; starts `true` by default after ban recovery and must be explicitly flipped to `false` to resume. Schedule the cron only after the flag is flipped.
- **1-on-1 AND group support (v8)** — Bot accepts both `@g.us` (group) and `@s.whatsapp.net` (direct). Different AI behavior per chat type:
  - **Direct (1-on-1):** Respond to EVERY message — personal assistant mode. Resolve household via `whatsapp_member_mapping` phone lookup. **Full capabilities active (2026-04-12):** auto-creates household on first action, writes to real DB tables (tasks, shopping_items, events, reminder_queue), reminders fire via pg_cron to `phone@s.whatsapp.net`.
  - **Group:** Only respond when mentioned by name ("שלי"), message is actionable (task/shopping/event), or question directed at bot. Skip social noise.
  - **Unknown direct user:** Gets welcome message explaining how to connect via group or app.
- **Whapi.Cloud sends outgoing messages back as webhooks** — must skip bot's own phone number early in handler
- **Bot phone: 972555175553** — set as `BOT_PHONE_NUMBER` env var in Edge Function secrets
- **WhatsApp @mention = numeric LID** — `@שלי` in the group becomes `@138844095676524` in message text (WhatsApp Linked Device ID). Detection must match LID, phone number, Hebrew text "שלי", AND English spelling variants (Sheli/Shelly/Shelley). Bot LID: `138844095676524`, configurable via `BOT_WHATSAPP_LID` env var.
- **Edge Function deployment: single inlined file** — Supabase Edge Functions don't support cross-function shared imports. The `_shared/` files are for development reference; the deployed `index.inlined.ts` has everything inlined (~2,130 lines).
- **Deploying: Cursor paste to Dashboard** — File is ~82KB, too large for MCP `deploy_edge_function` or Notepad. Open in Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → Code tab → paste → Deploy. Ensure Settings → Verify JWT is OFF.
- **Pre-deploy parse check — run esbuild locally FIRST.** Supabase's Edge Function bundler gives cryptic error messages (e.g. "Identifier cannot follow number" for unescaped backticks in template literals). Replicate the bundler locally in 40ms with: `npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js`. Any syntax error will point to exact line+column. The `--external:jsr:*` flags skip the unresolvable Deno imports (jsr:@supabase/...); they're only import-resolution noise, not syntax. If esbuild succeeds, Supabase will bundle too. Add this to the pre-push workflow when editing `index.inlined.ts`.
- **Nested backticks inside Sonnet prompt template literals break the bundler.** The entire Sonnet/Haiku prompt bodies are large template literals. Writing \`[example, 6d ago]: text\` inside will prematurely close the outer literal and throw a misleading parse error at the digit adjacent to the inner backtick. Rule: inside any prompt template literal, NEVER use backticks for example formatting — use plain text, straight quotes, or angle brackets. If you really need backticks in the prompt, escape each one as `\\\``. Hit 2026-04-15 during Shira bug-fix deploy; the cryptic error was "Identifier cannot follow number at line 1563:207" where `6d` sat right after an inner backtick. Numeric separators (`60_000`) are fine — that was a red herring.
- **Supabase Management API** — `curl -H "Authorization: Bearer sbp_..." https://api.supabase.com/v1/projects/wzwwtghtnkapdwlgnrxr/functions` works for listing/metadata but not source upload.
- **Shopping message batching** — 5s window for rapid-fire shopping items. Uses `amILastPendingMessage()` (checks by messageId, NOT timestamp — avoids clock skew). 30s TTL prevents stale pending messages.
- **Group lifecycle management** — Bot auto-setup on group join (intro message, create household, auto-link via phone mapping, pre-map participants). Member add/remove handlers. Bot remove = soft-disable.
- **Quiet hours** — `isQuietHours()` guards dashboard links + soft warnings: nightly 22:00-07:00 + Shabbat (Friday 15:00 – Saturday 19:00) Israel timezone. Reactive replies always work.
- **`maybeSendSoftWarning` column names** — must use `message_text` and `whatsapp_message_id` (matching `logMessage`), not `text`/`message_id`.
- **Empty actions for actionable intents** — When Haiku classifies `complete_task` but can't find the task_id, ask for clarification instead of false "done!" reply.
- **Message length cap: 500 chars** — Truncated before classifier to prevent prompt injection + cost amplification. Empty messages skipped entirely.
- **Batch processor uses stored `classification_data`** — No re-classification. Reads items from stored Haiku output (halves API cost).
- **`add_event` time fallback: 18:00 today** — Not `new Date()` (which creates a "past/now" event when time can't be parsed).
- **Upgrade prompt uses `ICOUNT_PAYMENT_LINK`** env var — Not Stripe. Billing provider is iCount.
- **Compound Hebrew product names** — Classifier prompt includes examples (חלב אורז, שמן זית, נייר טואלט) to prevent splitting. Categories always assigned per item.
- **Default shopping category: "אחר"** (Hebrew) not "Other" (English) — web app groups by Hebrew categories
- **Hebrew NLP patterns in prompt** — iteratively improved. Each misclassification becomes a new pattern.
- **"NOT A TASK" distinction** — requests for info ("שלח קוד", "מה הסיסמא") are NOT tasks. Only household chores/to-dos.
- **Duplicate handling** — bot asks "כבר ברשימה, להוסיף עוד?" instead of silently adding or ignoring
- **Whapi Sandbox (free):** 150 msgs/day, 5 chats, 1K requests. Sufficient for testing. Upgrade to $12/mo for production or migrate to Meta Cloud API.
- **Bot identity: "Sheli" (שלי)** — feminine Hebrew verbs (הוספתי, בדקתי). Classifier prompt updated from "Ours" to "Sheli".
- **Anthropic API Tier 1: 5 req/min** — Batch eval runner uses 5-at-a-time with 65s pause between batches. 120 cases take ~26 min. Add $5 credits to get Tier 2 (50 req/min).
- **Only Python available in bash** — No Node.js/Deno in Git Bash on this machine. Test runners must be Python. `npm`/`node` only work from PowerShell.
- **`add_reminder` has no dedicated action-executor path** — relies on Sonnet emitting `<!--REMINDER:{...}-->` block in reply text. If Sonnet returns empty, reminder is silently lost. Haiku-entity fallback (`index.inlined.ts` ~line 4440) now rebuilds the reminder from `classification.entities.reminder_text + time_iso` when the Sonnet block is missing. Added 2026-04-13.
- **"לפני X" (before X) ≠ "ב-X" (at X)** — "לפני" means fire WITH BUFFER before the deadline, not AT it. Default buffer: 1 hour for hour-specific deadlines ("לפני השעה 16" → 15:00). Rule is in both classifier prompts. Honor the user's word choice.
- **Third-person reminders supported** — "תזכירי ל[person]..." is a valid `add_reminder`. `reminder_text` should include target name (fires into group chat for everyone, so phrasing matters). Example: `{reminder_text: "אמא — להביא חלב"}`.
- **Observability trap: `classification` ≠ "reply sent"** — `whatsapp_messages.classification` is logged regardless of whether `provider.sendMessage` actually fired. Always check `ai_responded` column for real delivery. Silent Sonnet replies produce `classification="direct_address_reply"` + `ai_responded=false`.
- **Bot-silence diagnosis pattern** — `SELECT classification, classification_data, ai_responded FROM whatsapp_messages WHERE message_text ILIKE '%...%' ORDER BY created_at DESC`. `classification_data` JSONB contains full Haiku output (intent, confidence, addressed_to_bot, entities).
- **Inlined file is what's deployed** — Always edit `index.inlined.ts` for production changes. The modular `_shared/` files are dev reference. Must regenerate inlined file after any modular change.
- **Shared prompt constants (anti-drift)** — 7 `SHARED_*` constants (`SHARED_EMOJI_RULES`, `SHARED_TROLLING_RULES`, `SHARED_GROUNDING_RULES`, `SHARED_APOLOGY_RULES`, `SHARED_APP_RULES`, `SHARED_SHELI_QUESTIONS`, `SHARED_HEBREW_GRAMMAR`) are interpolated into both `buildReplyPrompt` (group) and `ONBOARDING_1ON1_PROMPT` (1:1). Edit once = applies everywhere. Added 2026-04-16 after a live bug where 1:1 prompt didn't know about sheli.ai web app.
- **Hebrew name map (`hebrewizeName`)** — 130+ Israeli English→Hebrew name map near top of inlined file. Strips trailing 's' (WhatsApp possessive: "Gilads"→"גלעד"). Case-insensitive. Falls back to original if not found. Used in welcome messages and onboarding greetings.
- **Voice message support:** <=30s voice messages transcribed via Groq Whisper (`whisper-large-v3`, auto-detect language). Transcribed text injected into existing pipeline (identical to typed text). >30s skipped. Env var: `GROQ_API_KEY`. Free tier: 28,800 sec/day.
- **Whapi voice payload:** Whapi sends `type: "voice"` (not `"ptt"`). Audio data under `msg.voice` with `id` (media ID), `seconds` (duration), `mime_type`. No direct download `link` — fetch via `GET /media/{mediaId}` with bearer token + `Accept: audio/ogg`. TypeMap covers `ptt`, `audio`, and `voice` → internal `"voice"` type.
- **Family memories:** Sonnet auto-captures memorable moments via `<!--MEMORY:-->` block (max 3/day). Memories injected into Sonnet reply context after 2-day aging. Three explicit intents: `save_memory`, `recall_memory`, `delete_memory`. Scoped: group memories visible everywhere, direct memories stay in 1:1. 10/member capacity with score-based eviction. 24hr cooldown between uses.
- **Fabrication guardrail:** GROUNDING rule in Sonnet prompt — never reference events not in conversation or provided context.
- **`IncomingMessage` field names** — Use `message.messageId` (not `message.id`) and `message.senderPhone` (not `message.senderId`). TypeScript won't error on missing properties — they silently return `undefined`.
- **`whatsapp_member_mapping` columns** — `phone_number` and `member_name` (NOT `phone` / `display_name`). `household_members` uses `display_name`. The two tables have different column names for the same concept.
- **`whatsapp_member_mapping` UNIQUE is COMPOSITE** `(household_id, phone_number)`, NOT `phone_number` alone (2026-04-18 bug — `ensureOnboardingHousehold` had `onConflict: "phone_number"` which silently failed every insert because no matching unique exists, leaving all new 1:1 users unmapped while Sonnet kept replying "רשמתי!"). Use plain INSERT with a fresh `hhId` (never collides) or `onConflict: "household_id,phone_number"` for retries. A phone CAN belong to multiple households (personal + family group), which is why the composite matters.
- **`reminder_queue` schema reality** — column names diverge from what `import_chat_exports.py` materialize was originally written against. Actual: `send_at` (NOT `scheduled_for`), `sent` boolean + `sent_at` timestamp (NOT `status`/`fired_at`), `group_id` is NOT NULL (for 1:1 use `"{phone}@s.whatsapp.net"`; for group use real JID), `reminder_type` CHECK allows only `event|briefing|summary|nudge|user` (no `rotation`, no `recurring`). The importer's reminder materialize path is currently wrapped in try/except so it doesn't abort, but chat-export reminders don't actually land — open TODO to rewrite that path with correct column names.
- **`households_v2.metadata` JSONB** column exists (added migration 2026-04-18) — used by recovery tooling for `{"recovered_from_export": true, ...}` tagging. The rollback-section docs + importer code referenced this column before it was actually in the schema.
- **`whatsapp_messages.sender_phone` is NULLABLE** (2026-04-18) — group backlog messages where the sender has no known phone mapping insert with `sender_phone=NULL` and populate later when a live message arrives.
- **1:1 path has NO Haiku classification** — Direct messages go straight to Sonnet via `ONBOARDING_1ON1_PROMPT`. Only group messages go through Haiku classifier. `classification_data` is null for 1:1 messages.
- **Webhook logs twice per message** — `logMessage` is called once as `received` (early) and again with the actual classification (after Haiku/Sonnet). Both rows share the same `whatsapp_message_id`. This is by design, not a dedup failure.
- **UTC times in Sonnet context** — Always convert `send_at` / `scheduled_for` to Israel time before injecting into prompts. Raw UTC causes Sonnet to misread "13:00 UTC" as "1 PM local" and create phantom duplicate items. Use `toIsraelTimeStr()`.
- **Classifier is example-driven, not rule-driven** — Adding a RULE to the Haiku prompt ("strip תוסיפי prefix") doesn't work without a matching EXAMPLE (`"תוסיפי חלב" → add_shopping`). Always add both.
- **`countHouseholdActions(householdId)`** — Returns total items across tasks + shopping + events + reminders. Reusable for nudge threshold AND future paywall.
- **Expense "שילמתי עליו" ≠ "שילמתי לו"** — "עליו" (treating someone socially) = ignore. "לו" (direct payment to person) = add_expense. Neither is add_task.
- **Expense tense rule** — PAST (שילמתי, עלה, יצא לנו, שרפתי) = add_expense. PRESENT (עולה, המחיר) = ignore. FUTURE (לשלם, צריך לשלם) = add_task. "תזכירי לי לשלם" = add_reminder.
- **"קניתי" 2-rule system** — "קניתי X ב-[amount]" = ALWAYS add_expense (any item + price). "קניתי X" (no amount) = check shopping list → complete_shopping if match, ignore if not.
- **Multi-currency expenses** — default ILS for Hebrew speakers. Explicit "יורו"/"דולר"/"€"/"$" overrides. Never sum across currencies in queries or web view. amount_minor stores in minor units (agorot/cents).
- **1:1 expense privacy** — 1:1 expenses default to `visibility='private'`. Full visibility preference flow ("למשפחה או בינינו?") is Phase 2. Group expenses are always `visibility='household'`.
- **Expense without amount** — "שילמתי חשמל" (no number) → Sheli asks "כמה עלה?" → user replies with number → Haiku uses conversation history to carry the description. Added as CONVERSATION CONTEXT RULE in Haiku prompt.
- **NEVER use `sed -i` on source files** — Windows Git Bash `sed` corrupts file encoding invisibly (bash reads OK, editors show empty). Use `iconv` or the Edit tool for line-ending changes.
- **Bot replies logged to DB** — All `sendMessage` calls go through `sendAndLog()` wrapper. Bot messages stored in `whatsapp_messages` with `sender_phone = BOT_PHONE`, `ai_responded = true`, and `in_reply_to` linking to the triggering user message. `replyType` labels: action_reply, confirmation_ask/accept/reject, direct_reply, nudge, error_fallback, etc.
- **Emoji reactions routed** — 👍💪✅👌❤️🔥 = confirm (execute pending action or log positive feedback). 😂😤👎❌🤦😡 = wrong (reject pending action or log negative feedback to classification_corrections). All other emoji on Sheli messages = skip. Reactions on non-Sheli messages = skip (social noise).
- **`sendMessage` returns `SendResult`** — `{ ok: boolean, messageId?: string }`. Whapi message ID parsed from response. Used for `pending_confirmations.bot_message_id` (reaction matching).

## Phone OTP Auth (deployed 2026-04-08)
- **Architecture:** Supabase Send SMS Hook → `otp-sender` Edge Function → WhatsApp (Whapi.Cloud) primary, Vonage SMS fallback
- **Cost:** ~$0/OTP via WhatsApp (flat $12/mo Whapi), ~$0.057/SMS via Vonage fallback
- **OTP expiry:** 600 seconds (10 minutes), 6 digits
- **Bridge message:** After phone-auth, new users without a household get WhatsApp DM nudging them to add Sheli to family group
- **Edge Function secrets (otp-sender):** `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_SENDER` (Sheli), `OTP_HOOK_SECRET` (from Supabase Send SMS Hook). Shares `WHAPI_TOKEN`, `WHAPI_API_URL`, `BOT_PHONE_NUMBER`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` with whatsapp-webhook.
- **Vonage provider:** Configured as Supabase Phone Auth provider (real credentials). Hook overrides it, but Vonage kicks in if hook is disabled.
- **Phase 2:** Migrate to Meta Cloud API for WhatsApp OTP (adds auto-fill, $0.0053/msg). Design: `docs/plans/2026-04-08-whatsapp-otp-auth-design.md`

## WhatsApp Bot — Two-Stage Pipeline (deployed 2026-04-03)

### Architecture
```
Message → Pre-filter (skip media/bot msgs) → Haiku Classifier ($0.0003) → Route:
  intent=ignore + conf≥0.70     → STOP (no Sonnet, 80% of messages)
  actionable + conf≥0.70        → Execute actions + Sonnet reply ($0.01)
  conf 0.50-0.69                → Escalate to full Sonnet classification (fallback)
  conf<0.50                     → Treat as ignore, log for review
```
- **Models:** `claude-haiku-4-5-20251001` (classifier), `claude-sonnet-4-20250514` (reply generator + fallback)
- **Cost:** ~$0.50/household/month (down from ~$1.62 all-Sonnet). ~70% reduction.
- **Accuracy:** 91.7% on 120 test cases (target was 85%). `ignore` 100%, `add_event` 100%, `question` 100%.

### 15 Intent Types
| Intent | Action | DB Operation |
|--------|--------|-------------|
| `ignore` | No action, no reply | — |
| `add_task` | Create task | INSERT tasks |
| `add_shopping` | Add to shopping list | INSERT shopping_items |
| `add_event` | Schedule event | INSERT events |
| `complete_task` | Mark task done | UPDATE tasks.done=true |
| `complete_shopping` | Mark item purchased | UPDATE shopping_items.got=true |
| `claim_task` | Self-assign task | UPDATE tasks.assigned_to (via assign_task action) |
| `question` | Reply with household state | Sonnet reply only, no DB write |
| `info_request` | Reply "I don't have that info" | Sonnet reply only, no DB write |
| `correct_bot` | Undo wrong + redo correct | DELETE + INSERT + log to classification_corrections |
| `save_memory` | Remember a family fact | INSERT family_memories (importance 0.8) |
| `recall_memory` | Share what Sheli remembers | Sonnet reply from FAMILY MEMORIES context |
| `delete_memory` | Forget something | UPDATE family_memories.active=false |
| `add_expense` | Log a payment | INSERT expenses (amount_minor, currency, attribution, visibility) |
| `query_expense` | Answer spend question | Aggregate expenses by currency → Sonnet reply |

### Classification values in `whatsapp_messages.classification`
`haiku_ignore`, `haiku_actionable`, `haiku_low_confidence`, `haiku_reply_only`, `sonnet_escalated`, `sonnet_escalated_social`, `batch_pending`, `batch_actionable`, `batch_empty`, `direct_address_reply`, `skipped_non_text`, `usage_limit_reached`, `correction_applied`, `explicit_undo`, `skipped_long_voice`, `voice_transcription_failed`, `reaction_positive`, `reaction_negative`, `reaction_confirmed`, `reaction_rejected`

### Bot reply `replyType` labels (in `whatsapp_messages.classification` for bot-sent rows)
`action_reply`, `sonnet_escalated_reply`, `direct_address_reply`, `confirmation_ask`, `confirmation_accept`, `confirmation_reject`, `confirmation_accept_reaction`, `confirmation_reject_reaction`, `quick_undo_reply`, `back_off_reply`, `emoji_reaction`, `direct_reply`, `onboarding_reply`, `group_mgmt`, `nudge`, `error_fallback`, `batch_reply`, `long_voice_reply`, `dedup_reply`, `clarification`

### `whatsapp_messages` columns (learning system, added 2026-04-04)
- `batch_id` (TEXT) — groups messages into shopping batches
- `batch_status` (TEXT) — `pending` → `processing` → `processed` (or `superseded`)
- `classification_data` (JSONB) — full Haiku output stored on every classification

### Known weaknesses
- **`complete_task` at 60%** — implicit Hebrew completions ("בוצע", "טיפלתי בזה") without conversational context are genuinely ambiguous. Caught by Sonnet escalation in production.
- **Full English in Hebrew group** — "pasta and cheese" classified as ignore. Rare edge case.
- **Compound Hebrew names** — mostly fixed with prompt examples, but novel compounds may still split. Each correction now auto-learns via `household_patterns`.

### Learning System (implemented 2026-04-04)
- **Design:** `docs/plans/2026-04-03-learning-system-design.md`
- **Plan:** `docs/plans/2026-04-03-learning-system-plan.md` (10 tasks, 3 phases — all complete)
- **@שלי direct address:** Detected pre-classifier. Forces a reply in ALL routing branches (ignore, low-conf, medium-conf). Strips mention before classification.
- **`correct_bot` intent:** No confidence threshold — corrections always routed to `handleCorrection()` which does undo → re-classify correction_text → redo → log.
- **Quick undo:** "תמחקי"/"בטלי"/"לא נכון" within 60s of bot action undoes it instantly (pre-classifier, no Haiku call).
- **Stream B (per-family):** `household_patterns` table → nicknames, time expressions, category preferences, compound names → injected into Haiku prompt as FAMILY PATTERNS section (~200 extra tokens). Auto-derived from corrections.
- **Stream A (global):** Weekly Claude review of `classification_corrections` → `global_prompt_proposals` (future, not yet implemented).
- **New tables:** `classification_corrections`, `household_patterns`, `global_prompt_proposals`

## RTL / Hebrew Design Rules
- `dir="rtl"` on parent flips flexbox automatically — most layouts "just work"
- **Hebrew CTAs: always gender-free plural** — "המשיכו" (not "המשך"), "הירשמו" (not "הירשם"), "התחברו" (not "התחבר"). Masculine plural = universal form in modern Hebrew UX.
- Arrows: forward = ← in RTL, → in LTR. Back = → in RTL, ← in LTR.
- `letter-spacing: 0` on Hebrew text (uppercase letter-spacing breaks Hebrew)
- Font: Heebo for Hebrew, Nunito for English. Cormorant Garamond removed (too "luxury editorial" for a family app).
- **Hebrew copy:** use "מטלות" not "משימות" (tasks — משימות sounds military). Sheli speaks feminine first-person ("הוספתי" not "הוסף").
- **Copywriting skill:** `.claude/skills/copywriting.md` — guidelines for taglines, CTAs, FAQ, bot messages, social media (HE+EN).
- WhatsApp mock on welcome screen: force `direction: ltr` on bubble layout (WhatsApp always shows your msgs on right), inner text gets `direction: rtl` for Hebrew
- CSS logical properties: use `padding-inline-end` not `padding-right`, `inset-inline-end` not `right`
- **Arrows in WhatsApp messages:** ASCII arrows (`->`, `<-`, `→`, `←`) render unpredictably in RTL. Use numbered steps instead.
- **Section titles in Hebrew:** Use Heebo font (not Cormorant Garamond). Cormorant Garamond is ONLY for the English "Sheli" wordmark.

## Landing Page
- **Two entry points:** sheli.ai (LandingPage for cold traffic), `sheli.ai?source=wa` (skips landing → auth for WA dashboard users)
- **wa.me pre-filled text:** `wa.me/972555175553?text=היי%20שלי!` — user taps Send, bot responds with welcome
- **Page flow (2026-04-16):** Wordmark → tagline → bridge one-liner (2-line) → WA mock (Sheli PNG avatar) → CTA → free badge → sign-in → Features (6 cards incl. expenses) → "שלי לכל המשפחה" (3 items) → How it works → FAQ (6 Qs, Israeli dev context) → Bottom CTA
- **QR code removed** (2026-04-16) — `public/qr-whatsapp.svg` still exists but no longer rendered. Reclaimed vertical space.
- **Bridge line:** HE "רק לעצמך או לכל המשפחה ביחד / שלי עושה סדר בחיים", EN "Just for you or the whole family / Sheli keeps it all together". Two lines via `<br>`, font-weight 400.
- **Family section:** 3 items between Features and How It Works — shared shopping (cart icon), chores & rotations (kids icon), add to group (group icon). Background `var(--white)`.
- **1:1 Q&A:** `ONBOARDING_QA` array in index.inlined.ts — pattern-matched answers for pricing, features, privacy, etc. Zero AI cost.
- **1:1 Welcome message (`getOnboardingWelcome`):** Hebrewized name → intro → capabilities (shopping, tasks, expenses, reminders, voice) → family group CTA → example CTAs (reminders first, shopping second). Reminders lead because they're the #1 first action for new users (FB launch data, 2026-04-16).

## iCount API (Billing)
- **API v3 base URL:** `https://api.icount.co.il/api/v3.php` (NOT apiv3.icount.co.il which is Stoplight docs UI only)
- **Auth:** POST `/auth/login` with `Authorization: Bearer <token>` + `{"cid":"034322354"}` → returns SID. All calls use SID.
- **Payment pages:** Need `paypage_id` from dashboard. Generate via POST `/paypage/generate_sale`.
- **Webhook:** POST to our URL with `X-iCount-Secret` header. Configured in הגדרות → אוטומציה → Webhooks.
- **Company ID:** 034322354 (שלי AI)
- **npm wrapper:** `@bizup-pay/icount` — revealed the real API URL (not in official docs)

## Payment Provider Research (Israel)
- **Stripe:** NOT available for Israeli merchants. Workaround: Stripe Atlas $500 US LLC.
- **Paddle:** Doesn't support ILS currency. Eliminated.
- **Flat per-txn fees kill 9.90 ILS:** PayMe (₪1.20), Invoice4U (₪1.20), BlueSnap ($0.30) all eat 12-13%.
- **iCount built-in terminal:** Best rate found — 0.5%+VAT, no flat fee. ₪199 setup + ₪30/mo + ₪30/mo standing orders.
- **עוסק פטור:** Revenue < ₪120K/year qualifies. Register free at mas.gov.il.

## User Flow (7 screens)
```
Loading → Welcome (lang + features + WhatsApp mock) → Auth (signin/signup/forgot/check-email/reset) → JoinOrCreate (auto-detect/code/create) → Setup (members, skip lang if known) → ConnectWhatsApp → Chat
```
- **Founder auto-selected** — after setup, founder is set as current user (no picker)
- **Picker only for joiners** — returning users or code-join users see the member picker
- **Auth modes:** signin, signup (with password confirm), check-email (auto-poll), forgot, forgot-sent, reset-password (with confirm)

## Git / Deploy Workflow
- **GitHub repo:** yado2000-maker/ours-app (public, brand name: Sheli)
- **Vercel auto-deploys from `main`** — push to main triggers build
- **Vite SPA catch-all shadows API routes** — `api/r/[code].js` serves at `/api/r/:code`. For clean URLs like `/r/:code`, add rewrite in `vercel.json`: `{ "source": "/r/:code", "destination": "/api/r/:code" }`
- **Codebase + Git:** `C:\Users\yarond\Downloads\claude code\ours-app\` — single folder, edit + commit + push here. `ours-app-git` is retired (merged 2026-04-11).
- **Deploy process:** Edit → commit → push → Vercel auto-deploys. Edge Functions: paste `index.inlined.ts` to Supabase Dashboard.
- **Edge Function hot-fix: commit to branch IMMEDIATELY after Dashboard paste.** (2026-04-18 lesson.) Dashboard paste deploys from your local file contents — if you leave `index.inlined.ts` uncommitted, the live prod fix vanishes the moment anyone else deploys from `main`, or if your machine dies. Pattern: paste → verify deploy → `git add supabase/functions/whatsapp-webhook/index.inlined.ts` → commit on feature branch → push to origin. Then decide "merge to main" as a SEPARATE step (accumulate related fixes + open one coherent PR). Commit locks git state; merge controls when main sees it.
- **Pre-deploy esbuild parse-check is safe but not sufficient** — passes on syntactically valid code that has runtime bugs (2026-04-18: `onConflict` spec wrong but parseable; env-loader empty-string check wrong but parseable). For high-stakes edits, add console logs at the patched call sites and watch `get_logs` after deploy.
- **`.env` file** — Project root, gitignored. Contains `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`. Required for integration tests and classifier eval.
- **PowerShell quirks:** `npm`/`git` not available in bash shell
- **Browser cache aggressive** — always `Ctrl+Shift+R` after deploy, or `localStorage.clear(); location.reload()` for clean state

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — Production build
- `python tests/classifier_eval.py` — Run 120-case Haiku classifier eval (~26 min Tier 1, ~4 min Tier 2, needs ANTHROPIC_API_KEY)
- `python tests/test_webhook.py` — Run 47-case webhook integration tests (~5 min, needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env). Tests classification, DB writes, dedup, edge cases against production Edge Function.
- `python -m unittest tests.test_recovery -v` — 16 offline unit tests for the recovery toolchain (~2 s, no network). Covers filename/timestamp parsing, recovery-state heuristic, schedule spread, dedup IDs.
- `python scripts/import_whapi_backlog.py [--dry-run] [--since <unix>]` — Capability A. Backfill Whapi messages from ban window. Exits clean if channel in QR state.
- `python scripts/import_chat_exports.py [--dry-run] [--dir recovery_exports] [--file path]` — Capability B. Import WhatsApp Business `.txt` exports (1:1 via filename inference OR groups via `manifest.json` entry). Skips WhatsApp system messages, strips `~` unsaved-contact prefix, annotates each group user message with per-message `recovery_state`, materialises real CMS rows for `needs_recovery` actionable intents, idempotent.
- `python scripts/plan_recovery_messages.py [--dry-run] [--start-hour 9] [--spread-hours 4] [--group-spread-hours 2] [--direct-start-offset-hours 1.5] [--groups-only] [--direct-only] [--limit N]` — Capability C. Stage Sonnet-generated recovery messages in `outbound_queue`. Groups go first (one unified message per group, addressing unresolved users by name; generic "חזרתי 🙈" fallback for >5 users). Drainer sends at **10/hr** global cap (bumped from 6 on 2026-04-18 post-ban-recovery incident). Drain sort priority v3: welcome → recovery → recovery_group (was inverse until 2026-04-18 ordering fix).
- Edge Function deploy: `index.inlined.ts` (~89KB) too large for MCP tool. Deploy via Supabase Dashboard paste (Cursor → Ctrl+A, Ctrl+C → Dashboard → Code → paste → Deploy). Verify JWT = OFF.
- `icount-webhook` Edge Function: separate function, deploy via Dashboard. Verify JWT = OFF. Env var: `ICOUNT_WEBHOOK_SECRET`.
- Vite dev server: port **5173** (not 3000). launch.json uses `"C:\\Program Files\\nodejs\\node.exe"` as runtimeExecutable.
- DB migrations: use `mcp__f5337598__apply_migration` MCP tool
- Diagnose bot silence on a specific message: `SELECT classification, classification_data, ai_responded FROM whatsapp_messages WHERE message_text ILIKE '%<text>%' ORDER BY created_at DESC LIMIT 5;` — `classification_data` JSONB has full Haiku output, `ai_responded` shows actual delivery.

## Testing
- **Integration tests (`test_webhook.py`):** 47 end-to-end tests via real Edge Function. Tests classification + DB state. ~94% pass rate (3 flaky due to LLM non-determinism). Run before user acquisition pushes.
- **Classifier eval (`classifier_eval.py`):** 120 Haiku-only test cases. Currently OUT OF SYNC with production prompt (missing add_reminder, compound names, etc.). Superseded by integration tests for regression coverage.
- **LLM non-determinism:** ~6% of integration tests are flaky — same input classifies differently across runs. Ambiguous Hebrew messages at confidence boundaries. Not code bugs. Accept as known variance.

## Agent Skills
- `product-manager` — Conversion, onboarding, feature prioritization, Hebrew CTA copy
- `app-designer` — Full design system (tokens, typography, spacing, RTL rules, animation, anti-patterns)

## Key Business Decisions
- **WhatsApp-first:** Bot in family group is primary interface, web app is dashboard
- **Freemium:** 30 free actions/month, then upgrade prompt IN the WhatsApp group
- **Pricing:** Free / Premium 9.90 ILS / Family+ 24.90 ILS
- **Israel-first:** Hebrew primary, expand to US via Facebook Messenger (free bot API)
- **WhatsApp API:** Whapi.Cloud Sandbox (free, limited) → Meta Cloud API (apply for OBA, Phase 1)
- **Billing provider:** iCount (icount.co.il) — 0.5% + ₪0.22/standing order charge, auto חשבונית מס. Terminal not yet activated.
- **Beta mode:** `BETA_MODE=true` env var on whatsapp-webhook disables 30-action paywall. Remove to activate monetization.
- **Referral system:** "Family brings Family" — referral code on `households_v2`, Vercel redirect `/r/:code` → WhatsApp, bot detects code in 1:1, rewards both families 30 days free at 10 actions. Design: `docs/plans/2026-04-07-family-brings-family-design.md`
- **Implementation plan:** V3 active (`docs/implementation-plan-v3.md`), V2 superseded
- **Admin Channels section** (2026-04-13): `admin_channel_stats(p_days)` RPC + Channels section in `AdminDashboard.jsx` showing 1:1/group/both breakdown, group-nudge conversion, and 7d retention by channel. Plan: `docs/plans/2026-04-13-admin-channels-section.md`.
- **Meta "AI Providers" policy (Oct 2025, enforced Jan 15 2026)** — WhatsApp Business Platform terms ban third-party services where AI is "primary (rather than incidental or ancillary) functionality". Enforcement at Meta's sole discretion. "Task-specific utility" carve-out (appointment reminders, payment reminders, order confirmations, authentication) is safe; "general-purpose AI chatbot" is not. Killed Zapia (5.5M users, Cloud API) Dec 22 2025. Affects Sheli's Business verification wording, template category choice, landing page copy. Lead externally with utility (shopping/reminders/family coordination), not AI.

## Competitive Landscape (researched 2026-04-18)

- **Boti** (boti.bot, bot #972-55-9847775) — Direct Hebrew/Israeli competitor. Solo operator Aminadav Glickshtein, Pardes Hanna. Likely self-hosted Baileys (same linked-device class as Whapi). **5 years no documented bans.** Survival formula: 100% reactive, DM-only, no AI chat (menu + regex), no groups, no proactive outbound (no briefings/nudges/recovery). 5 NIS/mo. ~50-150K realistic users (Play Store 100K+ installs, Telegram community 1.8K — marketing claims of "hundreds of thousands" are soft). Lesson: everything Sheli differentiates on (groups, AI, proactive) is exactly what adds ban risk — can't out-Boti Boti on compliance.
- **Any.do WhatsApp** — Cloud API + Utility templates. Paid tier only (Premium/Family/Workspace). Region-blocked in Meta-sanctioned countries (Pakistan/Iran/Bangladesh/Nigeria/Algeria/Tunisia) — Cloud API fingerprint. Fires reminders at exact time.
- **Reminder Bot** (reminderbot.co) — "Powered by WhatsApp's official API" = Cloud API.
- **Zapia** (LatAm, 5.5M users, $12M funded, Google Cloud Run + Vertex + Claude Haiku on Cloud API) — **Banned from WhatsApp Dec 22, 2025** under Meta's "AI Providers" policy. EU antitrust investigating. **Cloud API does NOT protect against that policy.** Positioning (utility vs AI assistant) is the discriminator, not infrastructure.
- **Wareminders / SKEDit** — Device-side automation: messages send from user's OWN WhatsApp account (user scans their own QR). No bot phone = no bot ban surface. Alternative architecture worth knowing.

### Positioning implication

Meta's "AI Providers" discretion killed a $12M/5.5M-user product despite Cloud API compliance. Sheli must be framed as **"family task coordination utility"** not "AI assistant" — in Business verification, landing page copy, template category choice, FB post framing. Current tagline "העוזרת החכמה שלכם" is policy-risky; Boti's "השליח שלך" (your messenger) is safer positioning. Keep AI personality in-chat (delight), lead externally with shopping/reminders/family coordination (utility).

### The three survival architectures (2026)

1. **Cloud API + Utility templates** (Any.do, Reminder Bot) — paid, regulated, templates, punctual. ~$0.15/user/month.
2. **Device-side automation** (Wareminders, SKEDit) — no bot phone, user's own phone sends.
3. **Unofficial linked-device API (Whapi-class) + 100% reactive** (Boti) — sub-2% ban rate reactive-only, 15-30% if proactive. Means no punctual reminders.

Sheli currently attempts #3 with proactive reminders → bans. Decision pending.

## TODO
- **Structural outbound redesign — DECIDED (session 2026-04-18e): Option 1 Cloud API migration.** Design: `docs/plans/2026-04-18-option-1-cloud-api-migration-design.md`. Plan: `docs/plans/2026-04-18-option-1-cloud-api-migration-plan.md`. 23 tasks across 6 phases. Execution on `option-1-cloud-migration` branch once prerequisites clear (24h restriction lifts, Meta verification completes, new phone acquired).
- **🚨 Webhook message gap — ~50% of new 1:1 phones don't land in DB** (2026-04-18). Edge Function returns 200 on every request, `get_logs` shows no errors, but of 15 recent 1:1 phones Whapi visible in `/chats`, only 7 had records in `whatsapp_messages`. Messages dying between webhook entry (`Deno.serve`) and `logMessage` call — candidates: `parseIncoming` returning null for specific payload shapes (quoted/reply/forwarded), Whapi history-sync messages showing in `/chats` without being webhooked, or dedup hitting first-time messages with a `messageId` that matches something already logged. Needs: verbose `console.log` at each early-return site in `Deno.serve` handler (lines 4788-4813 of `index.inlined.ts`), redeploy, live test with a phone we know drops (Liad `+972 52-424-8151` is a reliable repro).
- **Sheli time-parsing +1 day bug** (2026-04-18). Hebrew weekday references parse off-by-one: נעה asked "Saturday night / motzei Shabbat" → Sunday 20:30, "Monday morning" → Tuesday 09:00. Both exactly +1 day. Systemic. Repro: "תזכירי לי במוצאי שבת ב-20:30" on a Saturday — expected send_at=today 20:30 IL, actual=tomorrow 20:30. Probably in `parseReminderTime` (index.inlined.ts ~line 3292) TZ handling OR Sonnet prompt's date math. Check the "if target < now, add 1 day" branch — may be adding a day even when the target IS today (TZ comparison error).
- **Recurring reminders have no first-class support** (2026-04-18). Cohen family dish-washing rotation currently lives as 7 one-shot `reminder_queue` rows through Fri 2026-04-24 (tagged `reference_id LIKE 'recov_cohen_rotation_%'`). Next Saturday 25.04 it stops firing. Options to evaluate: (a) new `rrule` TEXT column + weekly pg_cron that materializes next-7-days rows, (b) Sonnet classifier learns "תזכורות חוזרות" intent and auto-rebatches, (c) accept manual weekly refresh. Decision needed before 2026-04-25.
- **`import_chat_exports.py` reminder materialize uses wrong column names** (2026-04-18). Path inserts `scheduled_for`, `status='fired'`, `fired_at` — actual `reminder_queue` schema uses `send_at`, `sent` boolean, `sent_at`. Currently wrapped in try/except so it doesn't abort, but reminders from chat-export imports don't materialize. Fix by updating the insert to use correct columns + derive `group_id` as `"{phone}@s.whatsapp.net"` for 1:1 or pass real JID for groups.
- **Whapi group removal webhook unreliable** — Ventura family removed Sheli from group but `handleBotRemoved` never fired (`bot_active` stayed true). Manually fixed. Investigate: does Whapi send `remove` events for bot removal? Check webhook payload format, event subtype matching, and add logging/alerting for missed removal events.
- **Submit Google OAuth consent screen for review** — Calendar API requires sensitive scope (`calendar.events`). Google review takes 2-6 weeks. Submit now so it's approved by the time we build Google Calendar sync (Phase 3). Needs: privacy policy URL, terms of service URL, OAuth consent screen config in Google Cloud Console, video walkthrough of the permission flow.
- **Admin dashboard: Morning briefing stats** — design doc §9 metric deferred from admin-channels-section plan. Needs new columns on `onboarding_conversations` (briefing_count, briefing_opted_out) AND the briefing free-tier feature itself. Revisit when briefing ships.
- **Admin dashboard: Revenue per channel** — design doc §9 metric deferred from admin-channels-section plan. Currently 0 paying subs makes the metric uninformative. Revisit at ≥10 paying subscriptions.
- **Admin dashboard: Deduplicate `funnel_counts` from `admin_channel_stats`** — the RPC returns `funnel_counts` (duplicating `admin_funnel_stats`) but the frontend ignores it. Tracked as a JSX `NOTE` comment in the Channels section. Remove the field from `admin_channel_stats` SQL in a future cleanup pass.
- **Resync `tests/classifier_eval.py` embedded prompt with production classifier** — eval script has a stripped-down copy of the Haiku prompt missing `add_reminder` entirely + many recent rules. Superseded by `test_webhook.py` integration tests for regression coverage, but still useful for isolated Haiku-only testing if resynced.
- **Classifier prompt duplication between Haiku + Sonnet** — `add_reminder` time-parsing rules are duplicated in Haiku intent prompt and Sonnet reply prompt. Sonnet↔1:1 drift is now fixed via `SHARED_*` constants (2026-04-16), but Haiku prompt shares NO constants with Sonnet — Haiku rules must still be updated separately.
- **Auto-reminder on `add_event` — product assessment needed before shipping.** Today `add_event` inserts into `events` only; no companion `reminder_queue` row is created. Shira 2026-04-15 session: Sheli replied "הזכרתי את כל האירועים" implying reminders existed, none did — trust-breaking. Interim fix shipping now: drop the "הזכרתי" wording for `add_event` replies (Sheli says "הוספתי ליומן" instead). Full auto-reminder deferred. Open design questions: (1) spam risk on recurring weekly classes (חוג/שיעור) vs. one-shot appointments (תור/רופא) — whitelist or blacklist? (2) all-day events default to 00:00 so `scheduled_for - 1h` = 23:00 prev day, wrong; need "morning-of" rule for all-day. (3) quiet-hours (22:00–07:00 + Shabbat) silently drop reminders — need pre-send-early or post-send-late policy. (4) events added minutes before their scheduled time shouldn't re-nudge. Revisit with usage data: count explicit "תזכירי לי" asks that follow an `add_event` within 10min — that's demand signal for auto-reminders. See session 2026-04-15 bug investigation.
- **Backfill +3h-corrupted events** — 3 events in household `hh_x1eaqbbm` (`46kj`, `cvsp`, `4iq1`) were stored with a naive-ISO timezone bug: Sonnet emitted `"2026-04-12T12:00:00"` (no offset), PG parsed as UTC, stored 3h late in IST. All 3 have already passed — leaving them alone. Investigate if other households have the same drift once Patch B ships. Query: `SELECT household_id, id, title, scheduled_for FROM events WHERE created_at < '2026-04-15' ORDER BY created_at DESC;` — compare with original classification_data in `whatsapp_messages`.
- **Reconcile shopping category source of truth — bot prompt ↔ app prompt** — `supabase/functions/whatsapp-webhook/index.inlined.ts:1504` writes `מוצרי חלב` + `טיפוח`; `src/lib/prompt.js:75` + `src/locales/he.js` cats list expects `חלב וביצים` + `מוצרים מחנות הטבע`. Drift silently hid 8 items across 2-3 households (2026-04-15 — Adi Kaye missed steak + 4 dairy + 1 toiletries from her "need to buy" view). Frontend now tolerant (renders unknown cats as tail), but picking ONE canonical list and having both sides read from it would prevent the cosmetic oddness of bot-added items appearing under bot-name categories at the bottom. Consider a shared constants file imported by both app + Edge Function, or just update bot prompts to match the app. Session 2026-04-15.
- **Haiku prompt hardening — category hallucinations** — classifier occasionally writes `בשר` or `חמוצים` — categories that don't exist in EITHER the bot's prompt or the app's `t.cats`. Hallucinated shortening / wrong pluralization. Add 2-3 negative examples in the Haiku prompt (e.g. "NOT `בשר` — use `בשר ודגים`"). Low urgency now that frontend renders unknowns, but still shows up weirdly for users.
- **Sonnet date-parsing hardening (REMINDER block)** — 3 real-user reminders in 30 days had `send_at` off by one day (Daniel "ברביעי הקרוב", אורלי "ברביעי 29.4", plus an earlier Amitay case). `buildReplyPrompt` REMINDERS section needs explicit examples for day-name + "הקרוב" + "היום בערב" patterns. Consider post-parse sanity check: when Sonnet emits a REMINDER with send_at referencing a day name in the user text, recompute what date that day maps to from `message.created_at` and verify match; if not, prefer Haiku's `time_iso`. Session 2026-04-15 audit.
- **test_webhook.py runner — don't short-circuit on intent mismatch** — `run_test` at `tests/test_webhook.py:672` returns immediately when `actual_intent != expected_intent` and never runs `db_check`. Means: when Haiku flakes but the rescue helper DOES save a reminder to DB, the test fails on intent alone and we can't see the rescue worked. Change to: collect all check results (intent, reply_pattern, db_check), report compound pass/fail. Session 2026-04-15.
- **1:1 `handleDirectMessage` silent-drop audit** — the silent-drop fix (2026-04-15, v124) only touched group-handler paths. Audit shows the 1:1 path is currently saving reminders correctly (Daniel + חביב both landed), but symmetric structural review is worth doing before more 1:1 traffic arrives. Check if any `respond=true + actions=[]` branch in the 1:1 handler strips REMINDER blocks without saving.
- **Expense QA re-check (2026-04-16)** — 25 expense tests at 68% (17/25). Remaining failures: (1) 6 "No rows" — Haiku classifies intent correctly but sometimes omits amount from entities; amount fallback + currency fallback + confidence boost deployed but not yet validated (version propagation lag). Re-run `python tests/test_webhook.py --category Expenses` in a fresh session to verify improvement. (2) 2 query_expense tests flake — "שלי כמה הוצאנו בחודש שעבר" and "שלי כמה שילמנו על חשמל" route to `direct_address_reply` instead of `query_expense`. (3) neg_task flaky — "צריך לשלם ארנונה" sometimes classified as ignore instead of add_task. Changes deployed: expense rescue (verb+number regex → bypass Sonnet escalation), treating exclusion, full currency list in prompt (שקל/שקלים/ש"ח/שח/₪/אירו/יורו/€/דולר/דולרים/$/פאונד/£/ין/¥), JPY in CURRENCY_MAP, 7 new classifier examples, confidence boost for medium-conf add_expense.
