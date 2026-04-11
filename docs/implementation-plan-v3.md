# Sheli v3: WhatsApp-Native Implementation Plan

> **Replaces:** [V2 Implementation Plan](implementation-plan-v2.md) (2026-04-05)
> **Status:** Active
> **Author:** Yaron + Claude

---

## Executive Summary

### V2 → V3: What Changed

**V2** was a web-first pivot to WhatsApp: build the bot, gate it behind a paywall, sign up users in the app before they try WhatsApp. It had internal contradictions — the conversion psychology section said "try before you pay" while the conversion flow put a paywall before the group add.

**V3** resolves these contradictions and commits fully to the WhatsApp-native thesis:

1. **Pricing:** Premium drops from 19.90 → **9.90 ILS/mo**. Family+ from 34.90 → **24.90 ILS/mo**. At zero social proof, 9.90 is a reflex buy — families don't deliberate on less than 10 shekels.

2. **Onboarding:** No signup before value. The flow is: landing page → wa.me → 1:1 chat with Sheli → user adds Sheli to family group → free tier works for ~2 weeks → upgrade prompt. Email/account captured organically via dashboard link or payment.

3. **Two entry points:** Landing page is a clean marketing asset for cold traffic (SEO, ads, word of mouth). WhatsApp users get a separate fast path to the dashboard via phone auth.

4. **Meta Cloud API in Phase 1:** Moved from Phase 3 to reduce costs. Apply for OBA immediately, implement while waiting, cut over when approved. Saves $12/mo Whapi cost.

### What Stays The Same

- Solo founder, bootstrap budget ($0-500/mo initially)
- Israel-first, Hebrew primary
- Freemium model (30 free actions → paid)
- Supabase backend, Vercel frontend, Claude AI
- 12-month horizon to profitability

### What's Already Built

The bot is live and working. This plan focuses on completing the monetization loop and growth engine, not rebuilding what exists.

- ✅ WhatsApp bot — group messages, 10 intents, two-stage Haiku→Sonnet pipeline (91.7% accuracy, ~$0.50/group/mo)
- ✅ Group auto-setup — `handleBotAddedToGroup()` creates household, maps members, sends intro
- ✅ Free tier enforcement — `checkUsageLimit()` counts 30 actions/month, `sendUpgradePrompt()` at limit
- ✅ Learning system — corrections → `household_patterns` → injected into Haiku prompt
- ✅ Shopping batching — 5-second window for rapid-fire items
- ✅ Direct address detection — @שלי forces reply in all routing branches
- ✅ Quick undo — "תמחקי"/"בטלי" within 60s undoes last action
- ✅ Group lifecycle — bot join, member add/remove, bot remove handlers
- ✅ Quiet hours — 22:00-07:00 nightly, Shabbat (Friday 15:00 – Saturday 19:00)
- ✅ Web app — 7 screens (loading→welcome→auth→join-or-create→setup→connect-wa→chat)
- ✅ Supabase V2 DB — normalized tables, realtime on 5 channels, RLS (relaxed for dev)
- ✅ PostHog analytics — 20+ custom events
- ✅ Sentry error tracking
- ✅ Vercel auto-deploy from main branch
- ✅ Fabrication guardrail — GROUNDING rule prevents Sheli from inventing fake events (2026-04-11)
- ✅ Family memory system — auto-capture, explicit save/recall/delete, scope filtering, eviction (2026-04-11)

---

## Updated Pricing

| Tier | Price | What You Get |
|------|-------|-------------|
| **Free** | 0 | Sheli in **1 group**, **30 actions/month**, web dashboard |
| **Premium** | **9.90 ILS/mo** (~$2.70) | Unlimited actions, morning briefing, end-of-day summary, smart reminders |
| **Family+** | **24.90 ILS/mo** (~$6.80) | Everything in Premium + **up to 3 groups**, weekly AI family report |

### Feature Gating

| Feature | Free | Premium (9.90) | Family+ (24.90) |
|---------|------|----------------|-----------------|
| WhatsApp bot | 1 group | 1 group | Up to 3 groups |
| Monthly actions | 30 | Unlimited | Unlimited |
| Web dashboard | Yes | Yes | Yes |
| Morning briefing (07:00) | No | Yes | Yes |
| End-of-day summary (20:00) | No | Yes | Yes |
| Smart reminders | No | Yes | Yes |
| Google Calendar sync | No | Yes (Phase 3) | Yes (Phase 3) |
| Weekly family report | No | No | Yes |

### Why 9.90 Not 19.90

- **Reflex buy:** Under the 10-shekel psychological barrier. Families don't deliberate.
- **Zero social proof:** Easier to get the first 100 paying families when the price is a non-decision.
- **Cost structure supports it:** Haiku pipeline costs ~$0.50/group/mo. At 9.90 ILS (~$2.70), margin is ~$2.20/group.
- **Can raise later:** "Founding family" pricing at 9.90, new signups at 14.90 once product-market fit is proven.
- **Annual option:** 99 ILS/year (2 months free) — clean number, attractive.

---

## Two Entry Points, One Product

The landing page is a **marketing asset** — its only job is converting cold visitors to WhatsApp users. WhatsApp users who already have Sheli in their group need a different, faster path. Keeping these separate ensures the landing page stays focused as SEO and paid traffic grow.

### Path A — Cold Traffic (SEO, marketing, word of mouth)

```
1. User sees Facebook post / referral / story
2. Visits sheli.ai → clean landing page (Hebrew, RTL, WhatsApp mock, single CTA)
3. Taps green CTA "הוסיפו את שלי לווטסאפ" → opens wa.me/972555175553
4. 1:1 chat: Sheli greets, explains "add me to your family group" with step-by-step
5. User adds Sheli to family WhatsApp group
6. handleBotAddedToGroup fires → household created, members mapped, intro sent
7. Family uses Sheli freely (30 actions/month, full experience)
8. After 10 messages OR 24 hours (whichever first): dashboard link sent in group
9. At action #25: soft warning "5 actions left this month"
10. At action #30: upgrade prompt with Stripe Payment Link (9.90 ₪/mo)
11. User taps link → Stripe Checkout → webhook confirms → unlimited
```

### Path B — Existing WhatsApp User (dashboard link from Sheli)

```
1. Sheli sends dashboard link in group: sheli.ai?source=wa
2. User clicks → boot effect detects ?source=wa → SKIPS landing page → auth screen
3. User taps "Continue with phone number" → enters phone → OTP → authenticated
4. detectHousehold() matches phone → whatsapp_member_mapping → auto-links to household
5. User sees their family's dashboard (tasks, shopping, events)
```

`?source=wa` param in boot effect skips landing (few lines in App.jsx). Phone auth via Supabase + Twilio OTP. Household auto-detection via phone→member_mapping lookup. Email/Google auth remains as fallback — `?join=HOUSEHOLD_ID` still works for those paths.

### Path C — Viral Fast Path

```
1. Family member sees Sheli in friend's group → asks "what is that?"
2. Gets phone number → adds to own group
3. handleBotAddedToGroup fires → same flow from Path A step 6
```

### Key Insight

No signup before value. Landing page stays focused on cold conversion. Email/phone captured organically via dashboard link (Path B) or payment (Path A step 10).

---

## Phase 1: Core Loop — First 10 Families (Weeks 1-3)

**Goal:** Complete the end-to-end loop from landing page → WhatsApp → free trial → payment.

### 1.1 Update Pricing Constants (30 minutes)

Replace all hardcoded 19.90/34.90 references with new pricing.

**Files:**
- `supabase/functions/whatsapp-webhook/index.inlined.ts` — `sendUpgradePrompt()`: 19.90 ₪ → 9.90 ₪, $5.50 → $2.70
- `supabase/functions/whatsapp-webhook/index.ts` — same
- `CLAUDE.md` — pricing line
- `docs/plans/2026-04-04-landing-page-design.md` — FAQ pricing

### 1.2 Build 1:1 Onboarding Handler (3 days)

**The highest-impact new feature.** Currently `parseIncoming()` has `if (!chatId.endsWith("@g.us")) return null;` — this single line drops all direct messages.

**Changes:**
- Remove the `@g.us` filter, add `chatType: "group" | "direct"` to `IncomingMessage`
- Route direct messages to new `handleDirectMessage()` before group pipeline
- New `onboarding_conversations` table (phone, state, household_id, message_count, created_at)
- State machine: WELCOME → WAITING → ONBOARDED → ACTIVE
- When `handleBotAddedToGroup()` fires, check if adder's phone has onboarding entry → send 1:1 confirmation
- 24h follow-up nudge via pg_cron for WAITING state entries (optional, can defer)

**1:1 welcome message:**
```
היי! 👋 אני שלי — העוזרת החכמה של הבית.
הוסיפו אותי לקבוצת הווטסאפ המשפחתית:

📱 קבוצה → הגדרות → הוסיפו משתתף → חפשו 055-517-5553

יש שאלה? אני כאן!
```

**Files:** `index.inlined.ts`, `index.ts`, `whatsapp-provider.ts`
**DB migration:** `onboarding_conversations` table

### 1.3 Build Landing Page + Two-Path Routing (2 days)

Implement the approved design from `docs/plans/2026-04-04-landing-page-plan.md`.

- Create `src/components/LandingPage.jsx`
- Create `src/styles/landing.css`
- Update `src/App.jsx`:
  - Replace `<WelcomeScreen>` with `<LandingPage>` in `screen === "welcome"` branch
  - Add `?source=wa` detection in boot effect: if present, skip landing → go straight to auth
- Update FAQ pricing to 9.90
- Keep WelcomeScreen.jsx as reference

**Key principle:** Landing page is ONLY for cold traffic. WhatsApp users never see it.

### 1.4 Stripe Payment Links (2 days)

Use Stripe Payment Links (not full Checkout Session integration) for maximum simplicity.

**Setup:**
- Create Stripe account with ILS currency
- Products: "Sheli Premium" (9.90 ILS/mo recurring), "Sheli Family+" (24.90 ILS/mo recurring)
- Generate Payment Links with `client_reference_id` passthrough
- Add link URLs to Edge Function env vars

**Edge Function changes:**
- Update `sendUpgradePrompt()` to include Stripe Payment Link with household_id as `client_reference_id`
- New `stripe-webhook` Edge Function: handles `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
- On successful payment: update `subscriptions` table, send confirmation in WhatsApp group

**DB migration:** Add `stripe_customer_id`, `stripe_subscription_id` to `subscriptions` table

### 1.5 Phone-Based Auth for WhatsApp Users (1-2 days)

Add phone number as third auth method alongside email/Google. The natural auth for WhatsApp users — same phone they already use with Sheli.

**Setup:**
- Enable phone auth provider in Supabase dashboard
- Configure Twilio SMS provider (~$0.05-0.08/SMS to Israel)

**AuthScreen changes (`src/components/AuthScreen.jsx`):**
- Add "Continue with phone number" option
- Phone input → Supabase `signInWithOtp({ phone })` → OTP screen → `verifyOtp()` → authenticated
- Israeli phone format: +972 prefix, validate 10-digit local format

**Household auto-detection (`src/lib/household-detect.js`):**
- Extend `detectHousehold()` to query `whatsapp_member_mapping` by phone
- Phone match → return that household (no `?join=` param needed)
- Phone match takes priority over email match

**Why now:** Makes dashboard link work WITHOUT URL params. Sheli sends plain `sheli.ai?source=wa` → user enters phone → auto-matched to household.

### 1.6 Dashboard Link from Bot (1 day)

After 10 group messages or 24 hours since bot joined (whichever first), send dashboard link.

**Implementation:**
- Add `dashboard_link_sent BOOLEAN DEFAULT false`, `first_message_at TIMESTAMPTZ` to `whatsapp_config`
- Check after each processed message: if `!dashboard_link_sent && (message_count >= 10 || now - first_message_at > 24h)`
- Send: "📊 רוצים לראות הכל במקום אחד? sheli.ai?source=wa"
- Set `dashboard_link_sent = true`

### 1.7 Soft Warning at Action #25 (2 hours)

Extend `checkUsageLimit()` to return count alongside boolean. At 25-29, send one-time soft warning.

**Message:** "נשארו לכם 5 פעולות חינמיות החודש. רוצים להמשיך בלי הגבלה? 9.90 ₪ לחודש 🔗"

Track via `soft_warning` classification in `whatsapp_messages` — check if already sent this month.

### 1.8 Meta Cloud API Migration (Week 2-3, parallel)

Whapi Sandbox (5 chats, 150 msgs/day) will break once 1:1 conversations start — each 1:1 counts as a chat.

**Timeline:**
- **Day 1 (immediate):** Apply for Official Business Account (OBA) via Meta Business Manager. Takes 2-4 weeks.
- **Week 2:** Complete `MetaCloudProvider` implementation. Stub exists in `whatsapp-provider.ts` (constructor, env vars, `verifyWebhook()` done). Need `parseIncoming()` and `sendMessage()`.
- **Week 3:** Once OBA approved → test → parallel run with Whapi → cut over.
- **Fallback:** If OBA delayed, use Whapi Starter ($12/mo) as bridge.

**Why Phase 1, not Phase 3:** Sandbox breaks with 1:1 handler. Meta gives 1,000 free conversations/month. Provider abstraction already exists.

### Phase 1 Dependency Order

```
Day 1: Apply for Meta OBA (takes 2-4 weeks, zero effort)
1.1 (pricing) ─────────────────────────────────→ 1.4 (Stripe needs correct prices)
1.2 (1:1 handler) ──── independent ─────────────→ deploy
1.3 (landing page + routing) ── independent ────→ deploy
1.4 (Stripe) ── depends on 1.1 ────────────────→ deploy
1.5 (phone auth) ── independent ────────────────→ deploy
1.6 (dashboard link) ── benefits from 1.5 ─────→ deploy
1.7 (soft warning) ── independent ──────────────→ deploy
1.8 (Meta API) ─── parallel, depends on OBA ───→ cut over when approved
```

### Phase 1 Costs (10 families)

| Item | Monthly |
|------|---------|
| Supabase free | $0 |
| Vercel hobby | $0 |
| Claude API (~10 groups) | ~$10 |
| Meta Cloud API (1K free convos) | $0 |
| Whapi Starter (bridge if Meta OBA delayed) | $0-12 |
| Twilio SMS (OTP, ~10 families) | ~$0.50 |
| Stripe fees (~3 paid × 9.90 ILS) | ~$0.50 |
| **Total** | **~$11-23/mo** |

### Phase 1 Success Metrics

- 10 families have Sheli in their group
- 3+ families converted to Premium
- 1:1 → group add conversion rate > 50%
- Landing page → wa.me click rate > 30%
- Meta Cloud API live (or Whapi Starter as bridge)

---

## Phase 2: Growth Engine — 100 Families (Weeks 4-8)

### 2.1 Morning Briefing — Premium Only (Week 4-5)

Daily 07:00 IST message to Premium/Family+ groups.

- New Edge Function: `supabase/functions/daily-briefing/index.ts`
- pg_cron job: `0 4 * * *` (04:00 UTC = 07:00 IST)
- Content: Today's tasks, upcoming events, shopping list count
- Respects quiet hours (Shabbat)

### 2.2 End-of-Day Summary — Premium Only (Week 5)

Daily 20:00 IST message (pg_cron `0 17 * * *`).

- Same Edge Function, different schedule
- Content: Tasks completed today (by whom), remaining items, tomorrow preview

### 2.3 Referral Mechanism (Week 6-7)

- 6-char referral code per household (stored in `households_v2.referral_code`)
- Link format: `sheli.ai/r/ABCD12` → Vercel redirect → `wa.me/972555175553?text=שלום+ABCD12`
- 1:1 handler detects referral code in first message → stores in `onboarding_conversations.referral_code`
- Reward: Both families get 1 free month after referred family completes 10 actions
- Track in `referrals` table (already exists in schema)

### 2.4 Meta API Stabilization (Week 4)

Meta Cloud API should be live from Phase 1.8. If OBA was delayed and still on Whapi Starter ($12/mo), escalate — explore alternative Meta BSP (360dialog, etc.).

### 2.5 RLS Tightening (Week 7-8)

Before going beyond beta families, tighten RLS policies from `auth.uid() IS NOT NULL` to proper membership checks. Critical for multi-household security.

### Phase 2 Revenue (100 families, 30% conversion)

- 25 Premium × 9.90 ILS = 247.50 ILS (~$68/mo)
- 5 Family+ × 24.90 ILS = 124.50 ILS (~$34/mo)
- **MRR: ~$102/mo**
- Cost: ~$80-120/mo → approaching break-even

---

## Phase 3: Scale — 1,000 Families (Weeks 9-16)

### 3.1 Google Calendar Sync (Weeks 9-11)

- OAuth flow in web dashboard
- New Edge Function: `supabase/functions/google-calendar-sync/index.ts`
- Bidirectional: Sheli events → Google Calendar, Google events → morning briefing
- New table: `google_calendar_connections`

### 3.2 Smart Reminders (Weeks 11-12)

- Extend classifier to extract time commitments ("I'll do it at 4")
- Use `reminder_queue` table (exists in schema)
- pg_cron checks every 15 minutes, sends reminder 30 min before

### 3.3 Stream A Global Learning (Week 12-13)

- Weekly pg_cron: Claude Sonnet reviews `classification_corrections` → proposes prompt improvements
- Store in `global_prompt_proposals` (table exists)
- Founder reviews and approves via web dashboard

### 3.4 Weekly Family Report — Family+ Only (Week 13-14)

- Friday 14:00 IST (before Shabbat)
- Task distribution analysis, shopping patterns, family engagement
- New Edge Function or extend daily-briefing

### Phase 3 Revenue (1,000 families, 25% conversion)

- 200 Premium × 9.90 ILS = 1,980 ILS (~$541/mo)
- 50 Family+ × 24.90 ILS = 1,245 ILS (~$340/mo)
- **MRR: ~$881/mo**
- Cost: ~$300-500/mo → profitable

---

## Phase 4: Scale & Expand (Months 5-12)

### 4.1 Multi-Language Expansion

- **Russian (Month 9):** ~1.2M Russian-speaking Israelis. Grandparent scheduling use case.
- **Arabic (Month 10):** ~2M Arabic-speaking Israelis. Large family-centric households.
- **English (Month 11):** Anglo Israeli communities first (100K+), test before broader market.

### 4.2 Multi-Channel US Expansion

Facebook Messenger — free bot API, no per-message fees. Same 10-second onboarding: "Add Sheli to your family Messenger group."

Provider abstraction already exists in `whatsapp-provider.ts` — add `MessengerProvider` following the same interface.

### 4.3 Advanced Features

- Meal planning ("What should we cook this week?")
- Budget suggestions (track spending from shopping completions)
- Smart scheduling ("When can the whole family meet?")
- Gamified chores for kids (points, weekly MVP)

### 4.4 Pricing Optimization

- A/B test: 9.90 vs 14.90 ILS/mo for new signups
- Annual discount: 99 ILS/year (2 months free)
- Family+ bundle adjustments

### 4.5 Infrastructure Scaling

- Self-hosted WhatsApp Business API (Baileys) at >1,000 groups
- Dedicated Supabase instance at 5,000+ active groups
- Claude API optimization: batch classification, response caching, Haiku for all classification

### Phase 4 Revenue (10,000 families, 25% conversion)

- 2,000 Premium × 9.90 ILS = ~$5,400/mo
- 500 Family+ × 24.90 ILS = ~$3,400/mo
- **MRR: ~$8,800/mo**

---

## Milestones

| Week | Free Families | Paid | MRR (USD) | Key Milestone |
|------|--------------|------|-----------|---------------|
| 3 | 20 | 3 | $8 | Phase 1 live, first payments, Meta API live |
| 6 | 80 | 15 | $41 | Proactive messages, referrals starting |
| 8 | 150 | 30 | $82 | Referral engine live |
| 12 | 500 | 125 | $341 | Calendar sync live |
| 16 | 1,000 | 250 | $683 | Phase 3 complete, profitable |
| 24 | 3,000 | 750 | $2,050 | Multi-language launch |
| 36 | 8,000 | 2,000 | $5,470 | US expansion started |
| 48 | 15,000 | 3,750 | $10,250 | Sustainable business |

**Kill criteria:** <10 paid by Week 8 → reassess product-market fit entirely.

---

## Current Infrastructure

| Service | Status | Cost |
|---------|--------|------|
| Supabase | Free tier | $0 |
| Vercel | Free tier | $0 |
| Meta Cloud API | Phase 1 target (1K free convos/mo) | $0 |
| Whapi.Cloud | Sandbox → bridge if Meta OBA delayed | $0-12/mo |
| Claude API (Haiku + Sonnet) | Active | ~$10-25/mo |
| Twilio (SMS OTP) | Phase 1 | ~$0.50/mo |
| PostHog | Free tier | $0 |
| Sentry | Free tier | $0 |
| Domain (sheli.ai) | Active | ~$10/year |

---

## V2 → V3 Change Log

| Area | V2 | V3 | Why |
|------|----|----|-----|
| Premium price | 19.90 ILS | **9.90 ILS** | Reflex buy at zero social proof stage |
| Family+ price | 34.90 ILS | **24.90 ILS** | Aligns with lower premium tier |
| Free tier | Contradictory (bot vs no bot) | **Bot in 1 group, 30 actions** | Resolves V2 internal contradiction |
| Onboarding | App-first (signup → paywall → WA) | **WA-first (wa.me → group → free trial)** | No signup before value |
| Landing page | Combined cold + warm traffic | **Cold traffic only** | Keep marketing asset focused |
| Dashboard entry | Same as landing | **?source=wa → skip landing → phone auth** | Different intent, different path |
| Auth | Email/Google only | **+ Phone auth via Twilio OTP** | Natural for WA users, auto-resolves household |
| Meta Cloud API | Phase 3 (Week 9-11) | **Phase 1 (Week 2-3)** | Whapi Sandbox breaks with 1:1; cost savings |
| WhatsApp cost | $29/mo Whapi annual | **$0 Meta (1K free convos)** | OBA + free tier covers early stage |
| 1:1 messages | Not addressed | **Onboarding conversation handler** | Bridges wa.me → group add gap |
| Paywall placement | Before group add | **After 30 actions (try before pay)** | Resolves V2 internal contradiction |
| Soft warning | Not in plan | **At action #25** | Gentle nudge before hard paywall |
| Dashboard link | Not in plan | **After 10 msgs or 24h** | Organic email/phone capture |
