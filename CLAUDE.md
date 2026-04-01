# Sheli (שלי) — Smart AI for Your Life Together

## Architecture
- **Frontend:** React 19 + Vite 8, deployed on Vercel (sheli.ai)
- **Backend:** Supabase (project: wzwwtghtnkapdwlgnrxr, region: eu-central-2)
- **AI:** Claude Sonnet 4 via Anthropic API, proxied through /api/chat (Vercel serverless)
- **WhatsApp Bot:** Supabase Edge Function (whatsapp-webhook), Whapi.Cloud provider
- **Auth:** Supabase Auth (Google OAuth + email/password)
- **Bot phone:** +972 55-517-5553 (eSIM Plus virtual number, WhatsApp Business)

## Key Files
- `src/App.jsx` — Main app (refactored from 1,435-line monolith)
- `src/lib/supabase.js` — Supabase client + data functions (sbGet/sbSet for old blob, loadHousehold for normalized tables)
- `src/lib/household-detect.js` — Auto-detect household for returning users
- `src/lib/prompt.js` — Claude AI system prompt for web app chat
- `src/components/Icons.jsx` — 27 custom SVG icons (stroke-based, currentColor)
- `supabase/functions/whatsapp-webhook/index.ts` — WhatsApp bot Edge Function (deployed separately via Supabase MCP)
- `supabase/functions/_shared/` — Source files for provider/classifier/executor (reference only — deployed version is single inlined file)

## Database: Dual Data Layer (Migration Period)
- **Old:** `households` table with JSON blob (`data` column containing {hh, tasks, shopping, events})
- **New:** Normalized tables (`households_v2`, `tasks`, `shopping_items`, `events`, `household_members`, etc.)
- **WhatsApp bot writes to NEW tables only**
- **Web app reads from BOTH and merges by ID** (loadData function in boot useEffect)
- **Web app writes to BOTH** (dual-write in save function)
- **CRITICAL:** The user picker's onClick must NOT reload data from sbGet — data is already merged in state

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
- **Edge Function deployment: single inlined file** — Supabase Edge Functions don't support cross-function shared imports. The `_shared/` files are for development reference; the deployed `index.ts` has everything inlined.
- **Redeploying requires the FULL file content** via `deploy_edge_function` MCP tool
- **Hebrew NLP patterns in prompt** — iteratively improved. Each misclassification becomes a new pattern.
- **"NOT A TASK" distinction** — requests for info ("שלח קוד", "מה הסיסמא") are NOT tasks. Only household chores/to-dos.
- **Duplicate handling** — bot asks "כבר ברשימה, להוסיף עוד?" instead of silently adding or ignoring
- **Whapi trial: 4 days, 5 chats, 150 msgs/day** — upgrade to $29/mo or migrate to Meta Cloud API
- **Bot identity: "Sheli" (שלי)** — feminine Hebrew verbs (הוספתי, בדקתי). Classifier prompt updated from "Ours" to "Sheli".

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
- **Deploy clone:** `C:\Users\yarond\Downloads\claude code\ours-app-deploy\` — working copy with all changes
- **Git clone:** `C:\Users\yarond\Downloads\claude code\ours-app-git\` — clean git repo for commits
- **Deploy process:** Edit files in deploy clone → copy changed files to git clone → commit → push → Vercel auto-deploys
- **PowerShell quirks:** `npm`/`git` not available in bash shell, use `mcp__Windows-MCP__PowerShell`
- **Browser cache aggressive** — always `Ctrl+Shift+R` after deploy, or `localStorage.clear(); location.reload()` for clean state

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — Production build
- Edge Function deploy: use `mcp__f5337598__deploy_edge_function` MCP tool (not CLI)
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
