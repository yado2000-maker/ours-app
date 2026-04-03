# Sheli (שלי) — Smart AI for Your Life Together

## Architecture
- **Frontend:** React 19 + Vite 8, deployed on Vercel (sheli.ai)
- **Backend:** Supabase (project: wzwwtghtnkapdwlgnrxr, region: eu-central-2)
- **AI:** Two-stage pipeline for WhatsApp bot (Haiku 4.5 classifier → Sonnet 4 reply generator); Sonnet 4 via /api/chat (web app)
- **WhatsApp Bot:** Supabase Edge Function (whatsapp-webhook), Whapi.Cloud provider
- **Auth:** Supabase Auth (Google OAuth + email/password)
- **Bot phone:** +972 55-517-5553 (eSIM Plus virtual number, WhatsApp Business)

## Key Files
- `src/App.jsx` — Main app (refactored from 1,435-line monolith)
- `src/lib/supabase.js` — Supabase client + V2 data functions (loadHousehold, saveTask, saveAllTasks, loadMessages, insertMessage, etc.) + toDb/fromDb field mappers
- `src/lib/household-detect.js` — Auto-detect household for returning users
- `src/lib/prompt.js` — Claude AI system prompt for web app chat
- `src/components/Icons.jsx` — 27 custom SVG icons (stroke-based, currentColor)
- `supabase/functions/whatsapp-webhook/index.ts` — WhatsApp bot Edge Function (modular source, not deployed directly)
- `supabase/functions/whatsapp-webhook/index.inlined.ts` — **Production deployment file** (~1,800 lines, all 6 modules inlined + group management + batching)
- `supabase/functions/_shared/haiku-classifier.ts` — Stage 1: Haiku intent classifier (9 intents, ~$0.0003/call)
- `docs/plans/2026-04-03-learning-system-design.md` — Two-stream learning system design (approved)
- `docs/plans/2026-04-03-learning-system-plan.md` — Learning system implementation plan (10 tasks, 3 phases)
- `supabase/functions/_shared/reply-generator.ts` — Stage 2: Sonnet reply generator (Sheli personality)
- `supabase/functions/_shared/ai-classifier.ts` — Old monolithic Sonnet classifier (kept as fallback for medium-confidence escalation)
- `supabase/functions/_shared/action-executor.ts` — DB action executor (6 action types incl. assign_task)
- `supabase/functions/_shared/whatsapp-provider.ts` — Provider abstraction (Whapi.Cloud + Meta Cloud API)
- `tests/classifier_eval.py` — Classifier eval runner (120 cases, Python, batch-of-5 for Tier 1 rate limits)
- `tests/classifier-test-cases.ts` — 120 test fixtures for intent classifier (TypeScript reference)

## Database: Normalized V2 Tables (migration completed 2026-04-02)
- **Schema:** `households_v2`, `tasks`, `shopping_items`, `events`, `household_members`, `messages`, `ai_usage`, `subscriptions`, `referrals`, `whatsapp_*`, `reminder_queue`
- **All FKs cascade** from `households_v2` — deleting a household clears all child data
- **Web app + WhatsApp bot both read/write V2 tables only** — no blob, no dual-write
- **Old `households` blob table still exists** (not dropped) but is unused — safe to drop when confident
- **Field mapping:** DB uses snake_case (`assigned_to`), JS uses camelCase (`assignedTo`). `toDb`/`fromDb` mappers in supabase.js handle the boundary.
- **Messages** stored in Supabase `messages` table (moved from localStorage 2026-04-02)
- **Bulk AI writes** use delete+insert (not upsert) — AI returns full arrays, so replace-all is simpler
- **Realtime:** 5 channels (tasks, shopping_items, events, households_v2, messages) with 3s echo debounce
- **CRITICAL — silent upsert RLS failure:** Supabase `.upsert()` checks INSERT policy first, even for existing rows. If INSERT policy is stricter than UPDATE, upserts fail silently. All INSERT policies currently relaxed to `auth.uid() IS NOT NULL` (tighten before launch).

## Supabase Gotchas
- **RLS blocks everything when auth.uid() is NULL** — Supabase client with publishable key + auth session sends JWT. If JWT is stale/expired, auth.uid() returns NULL and all RLS policies fail silently.
- **Clock skew warning** (`Session as retrieved from URL was issued in the future`) — indicates JWT timestamp mismatch. Can cause auth.uid() to be NULL. Fix: clear localStorage and re-authenticate.
- **RLS is currently RELAXED for development** — most tables use `auth.uid() IS NOT NULL` instead of membership checks. Tighten before launch.
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

## WhatsApp Bot Gotchas
- **1-on-1 AND group support (v8)** — Bot accepts both `@g.us` (group) and `@s.whatsapp.net` (direct). Different AI behavior per chat type:
  - **Direct (1-on-1):** Respond to EVERY message — personal assistant mode. Resolve household via `whatsapp_member_mapping` phone lookup.
  - **Group:** Only respond when mentioned by name ("שלי"), message is actionable (task/shopping/event), or question directed at bot. Skip social noise.
  - **Unknown direct user:** Gets welcome message explaining how to connect via group or app.
- **Whapi.Cloud sends outgoing messages back as webhooks** — must skip bot's own phone number early in handler
- **Bot phone: 972555175553** — set as `BOT_PHONE_NUMBER` env var in Edge Function secrets
- **Edge Function deployment: single inlined file** — Supabase Edge Functions don't support cross-function shared imports. The `_shared/` files are for development reference; the deployed `index.inlined.ts` has everything inlined (~1,800 lines).
- **Deploying: Dashboard paste (not CLI)** — File is too large (65KB) for MCP `deploy_edge_function`. Supabase CLI blocked by Windows Security. Deploy via: Dashboard → Edge Functions → whatsapp-webhook → Code → select all → paste `index.inlined.ts` → Deploy updates. Ensure Settings → Verify JWT is OFF.
- **Supabase Management API** — `curl -H "Authorization: Bearer sbp_..." https://api.supabase.com/v1/projects/wzwwtghtnkapdwlgnrxr/functions` works for listing/metadata but not source upload.
- **Shopping message batching** — 5s window for rapid-fire shopping items. Uses `amILastPendingMessage()` (checks by messageId, NOT timestamp — avoids clock skew). 30s TTL prevents stale pending messages.
- **Group lifecycle management** — Bot auto-setup on group join (intro message, create household, auto-link via phone mapping, pre-map participants). Member add/remove handlers. Bot remove = soft-disable.
- **Quiet hours** — `isQuietHours()`: nightly 22:00-07:00 + Shabbat (Friday 15:00 – Saturday 19:00) Israel timezone. Suppresses proactive messages only, reactive replies always work.
- **Compound Hebrew product names** — Classifier prompt includes examples (חלב אורז, שמן זית, נייר טואלט) to prevent splitting. Categories always assigned per item.
- **Default shopping category: "אחר"** (Hebrew) not "Other" (English) — web app groups by Hebrew categories
- **Hebrew NLP patterns in prompt** — iteratively improved. Each misclassification becomes a new pattern.
- **"NOT A TASK" distinction** — requests for info ("שלח קוד", "מה הסיסמא") are NOT tasks. Only household chores/to-dos.
- **Duplicate handling** — bot asks "כבר ברשימה, להוסיף עוד?" instead of silently adding or ignoring
- **Whapi trial: 4 days, 5 chats, 150 msgs/day** — upgrade to $29/mo or migrate to Meta Cloud API
- **Bot identity: "Sheli" (שלי)** — feminine Hebrew verbs (הוספתי, בדקתי). Classifier prompt updated from "Ours" to "Sheli".
- **Anthropic API Tier 1: 5 req/min** — Batch eval runner uses 5-at-a-time with 65s pause between batches. 120 cases take ~26 min. Add $5 credits to get Tier 2 (50 req/min).
- **Only Python available in bash** — No Node.js/Deno in Git Bash on this machine. Test runners must be Python. `npm`/`node` only work from PowerShell.
- **Inlined file is what's deployed** — Always edit `index.inlined.ts` for production changes. The modular `_shared/` files are dev reference. Must regenerate inlined file after any modular change.

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

### 9 Intent Types
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

### Classification values in `whatsapp_messages.classification`
`haiku_ignore`, `haiku_actionable`, `haiku_low_confidence`, `haiku_reply_only`, `sonnet_escalated`, `sonnet_escalated_social`, `batch_pending`, `batch_actionable`, `batch_empty`, `direct_address_reply`, `skipped_non_text`, `usage_limit_reached`

### `whatsapp_messages` batch columns (added 2026-04-03)
- `batch_id` (TEXT) — groups messages into shopping batches
- `batch_status` (TEXT) — `pending` → `processing` → `processed` (or `superseded`)
- `classification_data` (JSONB) — full Haiku output (planned, Phase 1 of learning system)

### Known weaknesses
- **`complete_task` at 60%** — implicit Hebrew completions ("בוצע", "טיפלתי בזה") without conversational context are genuinely ambiguous. Caught by Sonnet escalation in production.
- **Full English in Hebrew group** — "pasta and cheese" classified as ignore. Rare edge case.
- **Compound Hebrew names** — mostly fixed with prompt examples, but novel compounds may still split. Each correction improves the prompt.

### Learning System (designed, implementation pending)
- **Design:** `docs/plans/2026-04-03-learning-system-design.md`
- **Plan:** `docs/plans/2026-04-03-learning-system-plan.md` (10 tasks, 3 phases)
- **Stream A (global):** Weekly Claude review of corrections → propose prompt improvements → founder approves
- **Stream B (per-family):** `household_patterns` table → nicknames, time expressions, category preferences → injected into Haiku prompt (~200 extra tokens)
- **Feedback signals:** Implicit (delete within 5 min), explicit ("תמחקי"), @שלי corrections ("@שלי התכוונתי לשמן זית")
- **New intent planned:** `correct_bot` — undo wrong action + redo correctly + log for learning
- **New tables planned:** `classification_corrections`, `household_patterns`, `global_prompt_proposals`

## RTL / Hebrew Design Rules
- `dir="rtl"` on parent flips flexbox automatically — most layouts "just work"
- Arrows: forward = ← in RTL, → in LTR. Back = → in RTL, ← in LTR.
- `letter-spacing: 0` on Hebrew text (uppercase letter-spacing breaks Hebrew)
- Font: Heebo for Hebrew, DM Sans for English, Cormorant Garamond for headings (serif)
- WhatsApp mock on welcome screen: force `direction: ltr` on bubble layout (WhatsApp always shows your msgs on right), inner text gets `direction: rtl` for Hebrew
- CSS logical properties: use `padding-inline-end` not `padding-right`, `inset-inline-end` not `right`

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
- **Canonical codebase:** `C:\Users\yarond\Downloads\claude code\ours-app\` — all editing happens here
- **Git repo for commits:** `C:\Users\yarond\Downloads\claude code\ours-app-git\` — copy changed files here, commit, push
- **Deploy process:** Edit in `ours-app` → copy changed files to `ours-app-git` → commit → push → Vercel auto-deploys
- **Note:** `ours-app` has `.git` init'd but `ours-app-git` is the one connected to GitHub with full history. `ours-app-deploy` folder is superseded (merged into `ours-app` on 2026-04-02).
- **PowerShell quirks:** `npm`/`git` not available in bash shell
- **Browser cache aggressive** — always `Ctrl+Shift+R` after deploy, or `localStorage.clear(); location.reload()` for clean state

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — Production build
- `python tests/classifier_eval.py` — Run 120-case Haiku classifier eval (~26 min Tier 1, ~4 min Tier 2, needs ANTHROPIC_API_KEY)
- Edge Function deploy: use `mcp__f5337598__deploy_edge_function` MCP tool (not CLI), deploy `index.inlined.ts` not `index.ts`
- DB migrations: use `mcp__f5337598__apply_migration` MCP tool

## Agent Skills
- `product-manager` — Conversion, onboarding, feature prioritization, Hebrew CTA copy
- `app-designer` — Full design system (tokens, typography, spacing, RTL rules, animation, anti-patterns)

## Key Business Decisions
- **WhatsApp-first:** Bot in family group is primary interface, web app is dashboard
- **Freemium:** 30 free actions/month, then upgrade prompt IN the WhatsApp group
- **Pricing:** Free / Premium 19.90 ILS / Family+ 34.90 ILS
- **Israel-first:** Hebrew primary, expand to US via Facebook Messenger (free bot API)
- **Interim WhatsApp API:** Whapi.Cloud ($29/mo) → migrate to Meta Cloud API (official Groups API, Oct 2025)
