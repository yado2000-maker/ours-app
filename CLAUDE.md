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
- **`.env` file** — Project root, gitignored. Contains `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`. Required for integration tests and classifier eval.
- **PowerShell quirks:** `npm`/`git` not available in bash shell
- **Browser cache aggressive** — always `Ctrl+Shift+R` after deploy, or `localStorage.clear(); location.reload()` for clean state

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — Production build
- `python tests/classifier_eval.py` — Run 120-case Haiku classifier eval (~26 min Tier 1, ~4 min Tier 2, needs ANTHROPIC_API_KEY)
- `python tests/test_webhook.py` — Run 47-case webhook integration tests (~5 min, needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env). Tests classification, DB writes, dedup, edge cases against production Edge Function.
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

## TODO
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
