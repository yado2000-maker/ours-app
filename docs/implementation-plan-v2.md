> ⚠️ **SUPERSEDED** by [V3 Implementation Plan](implementation-plan-v3.md) (2026-04-05)

# Ours App v2: WhatsApp-First Implementation Plan

## Executive Summary

### What Changed

v1 was a web-app-first approach: build a polished PWA, add auth, add payments, then market it. The fundamental problem with v1 was the **2nd member problem** -- the product has zero value with one person, but asking someone to download an app, create an account, and invite their family is a 5-minute friction wall that kills >90% of potential activations.

v2 flips the architecture. **Ours is now an AI family member that lives inside the WhatsApp family group.** The web app becomes the dashboard/settings layer, not the primary interface.

### Why This Is Better

1. **Activation in 10 seconds, not 5 minutes.** One family member adds a phone number to their existing WhatsApp group. Done. The entire family (3-8 people) is now using Ours. No downloads, no signups, no invitations.

2. **The 2nd member problem is solved by default.** When Ours joins a family group, every member of that group can interact with it immediately. There is no "invite your spouse" step.

3. **WhatsApp is where Israeli families already live.** 99% of the Israeli population uses WhatsApp. Every family already has a group. Ours meets them where they are instead of asking them to go somewhere new.

4. **The viral loop is built into the product.** Every WhatsApp group Ours joins exposes 3-8 family members. If even one person in another family sees it working and asks "what is that?", the answer is "add this number to your group." That is a 10-second conversion.

5. **Try before you pay.** Free tier includes the WhatsApp bot with limited actions (30/month) so families experience the magic firsthand. Once they see Ours organizing their group — tasks tracked, shopping lists maintained, events captured — the upgrade to unlimited is a no-brainer. People pay to keep something they already love, not to try something they haven't seen.

### What Stays The Same

- Solo founder, bootstrap budget ($0-500/mo initially, scaling with revenue)
- Israel-first, Hebrew primary
- 12-month target: 10K paid subscribers
- Freemium model
- Supabase backend, Vercel frontend, Claude AI
- Agent team of 7 specialized AI assistants

---

## Updated Pricing

| Tier | Price | What You Get |
|------|-------|--------------|
| **Free** | 0 | WhatsApp bot in ONE group with **30 actions/month** (tasks, shopping items, events created). Web dashboard included. Full experience — just limited volume. Enough to feel the magic for 1-2 weeks of normal use. |
| **Premium** | 19.90 ILS/mo (~$5.50) | **Unlimited actions.** Morning briefing. Smart reminders. Google Calendar sync. End-of-day summary. The bot never stops helping. |
| **Family+** | 34.90 ILS/mo (~$9.50) | Everything in Premium + bot in **MULTIPLE groups** (divorced parents, grandparents, extended family). Weekly AI family report. Priority response time. Advanced features (meal planning, budget suggestions). |

**Why prices are higher than v1:** The WhatsApp bot costs ~$29/mo in API fees (Whapi.Cloud) plus Claude API usage per group. At 19.90 ILS/mo, break-even is approximately 20 paid subscribers for the API cost alone. The value delivered is also significantly higher -- an always-on AI family assistant vs. a web app you have to remember to open.

**Conversion psychology:** The free tier includes the WhatsApp bot because that's where the "aha moment" lives. A family must FEEL Ours organizing their group before they'll pay. 30 free actions gives ~1-2 weeks of normal use. When the counter hits zero mid-week and Ours says "I've used my free actions this month — upgrade to keep me helping your family" — they've already experienced the value. This is fundamentally different from gating the bot behind a paywall and asking people to pay for something they've never tried.

**Price justification for Israeli market:** 19.90 ILS/mo is less than a single cup of coffee at Aroma. Family+ at 34.90 ILS/mo is less than a single Wolt delivery fee. For a service that runs your family's logistics daily, this is impulse-purchase pricing.

---

## Phase 1: Foundation (Months 1-2)

### Week 1-2: Code Refactoring -- DONE

Already completed:
- Split monolithic `App.jsx` (1,435 lines) into proper component tree
- Added React Router, extracted hooks, separated Supabase client
- Bilingual i18n system (HE/EN) extracted into locale files
- CSS extracted from template literals

### Week 2-3: Database Schema + Auth -- DONE

Already completed:
- Supabase Auth with email/password + Google OAuth
- Normalized relational schema (profiles, households, tasks, shopping_items, events, messages, ai_usage, subscriptions, referrals)
- RLS policies on every table
- Member selector for shared devices

### Week 3-4: WhatsApp Bot Prototype (Whapi.Cloud Sandbox)

**Goal:** Bot joins a WhatsApp group, reads messages, responds to direct mentions.

**Technical stack:**
- **Whapi.Cloud** sandbox (free) for prototyping, $29/mo annual plan for production
- **Webhook receiver:** Vercel serverless function (`/api/whatsapp/webhook`)
- **Message queue:** Supabase table `whatsapp_messages` (store all group messages for context)
- **Bot identity:** Israeli phone number (purchased via Whapi.Cloud or existing SIM)

**What to build:**
1. Whapi.Cloud account setup, sandbox channel creation
2. Webhook endpoint that receives all group messages
3. Message parser: detect @Ours mentions, detect Hebrew task-like phrases ("צריך לקנות חלב", "מי מביא את הילדים"), detect questions directed at the bot
4. Basic response flow: message received -> classify intent -> generate response -> send via Whapi API
5. Group metadata sync: store group name, member list, map to Supabase household

**Database additions:**
```sql
whatsapp_groups (id, group_jid, household_id, phone_number, added_at, active)
whatsapp_members (id, group_id, wa_phone, wa_name, mapped_user_id)
whatsapp_messages (id, group_id, sender_phone, content, timestamp, processed, intent_class)
bot_responses (id, message_id, response_text, sent_at, delivery_status)
```

**Key decisions:**
- Bot reads ALL messages in the group (needed for context) but only responds when mentioned or when it detects an actionable item
- Messages stored for 30 days, then purged (privacy)
- Bot introduces itself when first added to a group with a short Hebrew message explaining what it can do

**Cost:** $0 (sandbox). $29/mo when going live (Month 3).

**Deliverable:** Bot that can join a test family group, acknowledge messages, and respond to "add milk to the shopping list" in Hebrew.

### Week 5-6: Bot AI Classifier + Action Executor

**Goal:** Bot understands family conversation and takes structured actions.

**Intent classification (Claude Haiku for speed, ~50ms):**
| Intent | Example | Action |
|--------|---------|--------|
| `add_task` | "מישהו צריך לקחת את נועה מהחוג ב-4" | Create task, assign if name mentioned |
| `add_shopping` | "צריך חלב, ביצים, ולחם" | Parse items, add to shopping list |
| `add_event` | "יום שלישי ארוחת ערב אצל סבתא" | Create calendar event |
| `query_tasks` | "מה יש לעשות היום?" | List today's open tasks |
| `query_shopping` | "מה צריך מהסופר?" | Send current shopping list |
| `mark_done` | "לקחתי את הילדים" | Mark task as completed |
| `chit_chat` | "בוקר טוב!" | Friendly response (no DB action) |
| `ignore` | Unrelated family chatter | Do nothing, stay silent |

**Critical design principle: Ours is a LISTENER first, responder second.** It should NOT respond to every message. It should be more like a helpful family member who speaks up when relevant, not a chatbot that hijacks every conversation. Default behavior: silent unless mentioned or unless high-confidence actionable item detected.

**Proactive features (respond without being asked):**
- Detect "I'll do it" or "I'm on my way" and auto-assign/update tasks
- If someone asks "where is X?" and X just messaged their location, relay it
- Daily summary: if no one asked, still send a brief "3 tasks left today" at 7 PM

**Action executor flow:**
```
Message -> Classify (Haiku) -> Route:
  - If actionable: Execute DB operation -> Confirm in group ("Added milk to the list")
  - If query: Fetch data -> Format Hebrew response -> Send
  - If chit_chat + @Ours: Generate friendly response (Sonnet)
  - If ignore: Do nothing
```

**Cost:** Claude Haiku per message classification (~$0.001/message). Sonnet for complex responses (~$0.01/response). At 100 messages/day/group: ~$3/mo/group in AI costs.

**Deliverable:** Bot that correctly classifies 90%+ of Hebrew family messages and executes CRUD operations on tasks, shopping, and events.

### Week 7-8: Web Dashboard

**Goal:** Web app shows everything the bot captured, with settings and household management.

The web app is NOT the primary product anymore. It is the **control panel**:
- View tasks, shopping lists, events (all captured by the WhatsApp bot)
- Edit/delete items the bot created
- Manage household settings (bot behavior, notification preferences)
- View AI-generated weekly summary
- Manage subscription and billing
- Add/remove WhatsApp groups
- Map WhatsApp group members to household profiles

**New pages/views:**
1. **Dashboard** -- today's tasks, shopping list, upcoming events (all synced from bot)
2. **WhatsApp Settings** -- connected groups, bot behavior toggles (proactive mode on/off, quiet hours, response language)
3. **Household Management** -- members, roles, link WhatsApp identities to accounts
4. **Activity Feed** -- chronological log of everything the bot captured and did
5. **Subscription** -- current plan, upgrade to Premium/Family+

**Feature gating:**
- Free: Full web dashboard, 10 AI messages/day (web chat only), no WhatsApp bot
- Premium: Everything + WhatsApp bot in 1 group
- Family+: Everything + WhatsApp bot in multiple groups + weekly report

### Week 8: Stripe Integration + Feature Gating

**Stripe setup (same as v1, adjusted for new tiers):**
- `create-checkout` Edge Function (ILS currency, 3 price IDs)
- `stripe-webhook` Edge Function (subscription lifecycle)
- `customer-portal` Edge Function (self-service management)

**Gating logic:**
```
Free: web_access=true, whatsapp_bot=false, ai_messages_daily=10
Premium: web_access=true, whatsapp_bot=true, max_groups=1, ai_messages_daily=unlimited
Family+: web_access=true, whatsapp_bot=true, max_groups=5, ai_messages_daily=unlimited, weekly_report=true
```

**The paywall moment:** User adds Ours to their WhatsApp group for free. Bot works beautifully for ~2 weeks (30 actions). Then Ours sends a gentle message: "היי משפחת כהן, השתמשתם ב-30 הפעולות החינמיות החודשיות שלכם. שדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה — 19.90 ₪ לחודש." The family has already experienced the value. The upgrade is to KEEP something they love, not to TRY something unknown.

### Phase 1 Cost Summary

| Item | Monthly Cost |
|------|-------------|
| Supabase (free tier) | $0 |
| Vercel (hobby) | $0 |
| Claude API (development) | ~$20 |
| Whapi.Cloud (sandbox then $29/mo) | $0-29 |
| Domain + misc | ~$10 |
| **Total** | **$30-59/mo** |

---

## Phase 2: Launch & Early Traction (Months 3-4)

### 2.1 The "Try It in 10 Seconds" Hook

The entire marketing strategy centers on one message: **"Add this number to your family WhatsApp group. That's it."**

**Landing page structure:**
1. Hero: "Ours -- AI that manages your family" (Hebrew: "שלנו -- הבינה המלאכותית שמנהלת את המשפחה")
2. 30-second demo video: real WhatsApp group, someone says "צריך חלב וביצים", bot adds to shopping list, family member at the store asks "מה צריך?", bot sends the list
3. CTA: "Add Ours to your family group" -> phone number + QR code
4. Below: web dashboard screenshots showing the control panel
5. Pricing section: Free (web only) vs. Premium (WhatsApp bot)

### 2.2 Israeli Market Launch Strategy

**Facebook parent groups (primary channel):**
- Target: 20+ Israeli parenting groups (50K-350K members each)
- Approach: NOT spam. Founder joins groups, participates genuinely for 2 weeks, then shares personal story: "I built something because my wife and I kept losing track of who's picking up the kids"
- Key message: "It lives inside your WhatsApp group, you don't download anything"
- Include screenshot of real (staged) WhatsApp conversation with the bot

**WhatsApp viral sharing:**
- Every family that activates Ours gets a shareable link/QR
- Weekly family summary includes "Powered by Ours" footer with link
- When someone in a non-Ours group asks "what app is that?", any family member can share the number

**Content marketing (Hebrew):**
- SEO targets: "ניהול משימות משפחה", "רשימת קניות משותפת", "בוט WhatsApp למשפחה", "בינה מלאכותית למשפחה"
- 2 blog posts/week on family organization tips (Hebrew)
- Instagram/TikTok: short clips of WhatsApp bot in action

**Product Hunt Israel:** Launch listing once 50+ families are active.

### 2.3 Free-to-Premium Conversion Flow

```
1. User sees post in Facebook group
2. Visits landing page (10 sec video)
3. Signs up for free account (email or Google)
4. Explores web dashboard -- sees the value proposition
5. Clicks "Add Ours to WhatsApp" -> Paywall
6. Pays 19.90 ILS/mo (impulse price)
7. Adds phone number to family WhatsApp group
8. Bot introduces itself to the family
9. Entire family is now using Ours
```

**Alternative fast path (viral):**
```
1. Family member sees Ours bot in friend's WhatsApp group
2. Asks "what is that?"
3. Gets the phone number
4. Adds to their own family group -> Paywall intercept
5. Pays and activates
```

### 2.4 PostHog Analytics (same as v1, updated events)

Instrument: `signup`, `dashboard_viewed`, `whatsapp_paywall_shown`, `subscription_started`, `bot_added_to_group`, `bot_first_response`, `bot_action_executed`, `family_member_interacted`, `weekly_report_opened`, `referral_shared`

**North Star Metric (updated):** Weekly Active WhatsApp Groups with 2+ unique senders

### Phase 2 Cost Summary

| Item | Monthly Cost |
|------|-------------|
| Supabase Pro | $25 |
| Vercel Pro | $20 |
| Claude API (30 paying groups) | ~$90 |
| Whapi.Cloud | $29 |
| PostHog (free tier) | $0 |
| Sentry | $0 |
| Marketing (micro-influencers) | $100-200 |
| **Total** | **$264-364/mo** |

**Revenue at 30 paid (end of Month 3):** 30 x 19.90 ILS = ~$165/mo. Still burning money, but unit economics work at scale.

---

## Phase 3: Growth Engine (Months 5-8)

### 3.1 Migrate to Meta Cloud API

**Timeline:**
- Month 3: Apply for Official Business Account (OBA) via Meta Business Manager
- Month 3-4: OBA verification process (2-4 weeks typically, can take longer)
- Month 5: If approved, begin migration from Whapi.Cloud to Meta Cloud API
- Month 5-6: Parallel operation (both APIs active), gradual migration

**Why migrate:**
- Meta Cloud API: 1,000 free conversations/month, then $0.02-0.05/conversation (significantly cheaper at scale)
- Higher reliability and official Meta support
- Green checkmark verified business badge (trust signal)
- Better rate limits and no intermediary dependency

**If OBA is rejected:** Stay on Whapi.Cloud. The $29/mo fixed cost is acceptable up to ~200 groups. Beyond that, negotiate volume pricing or consider alternative providers (360dialog, Twilio).

### 3.2 Proactive Features (Premium Only)

These are the features that make Ours feel like a family member, not a chatbot:

**Morning Briefing (7:00 AM):**
> "בוקר טוב! היום:
> - נועה: חוג ריקוד ב-16:00 (אמא אוספת)
> - רשימת קניות: 4 פריטים (חלב, ביצים, לחם, גבינה)
> - יום הולדת של סבתא מחר -- לא שכחתם?"

**Smart Reminders:**
- Bot notices "I'll take the kids at 4" was said 3 hours ago -> at 3:30 PM sends "reminder: you said you'd pick up the kids at 4"
- Recurring task detection: if "buy milk" appears every week, suggest making it recurring

**End-of-Day Summary (9:00 PM):**
> "סיכום היום:
> - 5 משימות הושלמו (3 על ידי אמא, 2 על ידי אבא)
> - נשארו 2 פריטים ברשימת הקניות
> - מחר: 2 אירועים ביומן"

**Weekly AI Report (Family+ only, Friday afternoon):**
- Task distribution analysis ("Mom completed 65% of tasks this week")
- Shopping spending patterns
- Family engagement metrics
- Gentle nudges ("Dad hasn't been assigned any tasks this week -- want to balance the load?")

### 3.3 Google Calendar Sync (Premium)

- Bidirectional sync with Google Calendar
- Events added via WhatsApp appear in Google Calendar
- Google Calendar events appear in the bot's morning briefing
- Family members can each connect their own calendar
- Conflict detection: "Both parents have meetings at 3 PM -- who picks up the kids?"

### 3.4 Gamified Chores for Kids

- Assign tasks to kids via WhatsApp: "@Ours give Noaa 3 tasks today"
- Kids confirm completion in the group: "I cleaned my room!"
- Point system visible on web dashboard
- Weekly "family MVP" announcement in the group
- Parent-defined rewards at point thresholds

### 3.5 Referral Program

- "Invite another family -> both get 1 month free Premium"
- Share mechanism: bot sends a formatted WhatsApp message with referral link
- Track via `referrals` table, auto-apply credit
- Referral visible in web dashboard

### 3.6 Viral Loop Math

Every WhatsApp group Ours joins contains 3-8 family members. Each family member is in 5-15 other WhatsApp groups (friends, work, extended family). Conservative model:

- 1 paying family = 1 group = 5 members exposed
- Each member mentions Ours in 1 other group per month
- 5 mentions -> 2 people check the landing page -> 0.5 sign up for free -> 0.15 convert to paid
- **Viral coefficient k = 0.15** (conservative, but consistent)
- With 500 paid families: 500 x 0.15 = 75 new paid families/month from virality alone
- Growth becomes self-sustaining around 300-500 paid families

### Phase 3 Cost Summary

| Item | Monthly Cost |
|------|-------------|
| Supabase Pro | $25 |
| Vercel Pro | $20 |
| Claude API (500 groups) | ~$1,500 |
| WhatsApp API (Meta or Whapi) | $29-200 |
| PostHog | $0-50 |
| Sentry | $26 |
| Marketing | $300-500 |
| Part-time CS help | $500 |
| **Total** | **$2,400-2,821/mo** |

**Revenue at 500 paid (Month 6):** 500 x 19.90 ILS = ~$2,750/mo. Approaching break-even.

---

## Multi-Channel Expansion Strategy

### Multi-Channel Architecture (US Market Expansion)

The US market doesn't use WhatsApp like Israel. US families use iMessage (50% - iPhone users), Facebook Messenger (108M users, #1 messaging app), SMS/RCS, and Discord. Ours must be platform-agnostic.

**Architecture:** The AI brain, database, action executor, and proactive features are 100% shared. Only the messaging transport layer changes per market. The provider abstraction layer in the WhatsApp bot technical spec was designed for exactly this.

```
MessagingProvider interface:
  WhatsAppProvider  → Israel (primary)
  MessengerProvider → US (primary) — FREE bot API, no per-message fees
  RCSProvider       → US (fallback) — $0.01-0.03/msg, works on all phones
  DiscordProvider   → US teens/gamers
```

**Expansion timeline:**
- Phase 1-2 (Month 1-6): WhatsApp only → Israel market
- Phase 3 (Month 6-9): Add Facebook Messenger → US market entry. Cost: FREE (Meta doesn't charge for Messenger bots). Effort: 1-2 weeks (similar API to WhatsApp, same Meta ecosystem).
- Phase 4 (Month 9-12): Add SMS/RCS → US universal fallback. Cost: ~$0.01-0.03/msg. Effort: 2-3 weeks.
- Phase 5 (Month 12+): Apple Messages for Business → premium iMessage integration

**US market entry strategy:**
1. Israeli Anglo community (English-speaking Israelis) — already use WhatsApp, test English language
2. US families via Facebook Messenger — "Add Ours to your family Messenger group" — same 10-second onboarding
3. SMS/RCS for iPhone-only families — "Text this number to add Ours to your family"

**Key insight:** Messenger being free makes US expansion CHEAPER than Israel.

---

## Phase 4: Scale & Expand (Months 9-12)

### 4.1 Multi-Language Expansion

**Russian (Month 9):** ~1.2M Russian-speaking Israelis. Many older immigrants manage grandparent duties. WhatsApp bot that speaks Russian for scheduling grandparent pickups/visits.

**Arabic (Month 10):** ~2M Arabic-speaking Israelis. Family-centric culture with large households. WhatsApp is dominant platform.

**English (Month 11):** Anglo Israeli communities first (100K+ English-speaking immigrants). Test messaging and pricing before broader English market.

### 4.2 Advanced AI Features

- **Meal planning:** "What should we cook this week?" -> generates weekly menu based on family preferences, dietary restrictions, adds ingredients to shopping list
- **Budget suggestions:** Track spending from shopping list completions, suggest savings
- **Smart scheduling:** "When can the whole family meet this week?" -> analyzes all connected calendars
- **Homework helper:** Kids can ask the bot study questions in the family group (Family+ only)

### 4.3 Offline-First Shopping List

The web app's shopping list should work offline (service worker + IndexedDB), syncing when connectivity returns. This is critical for inside-store usage where cellular signal can be spotty.

### 4.4 Pricing Optimization

- A/B test: 19.90 vs. 24.90 vs. 14.90 ILS/mo for Premium
- A/B test: annual discount (199 ILS/year = 2 months free)
- A/B test: Family+ bundled features
- Test free trial duration: 7 days vs. 14 days vs. 30 days of Premium

### 4.5 Infrastructure Scaling

- Evaluate moving from Whapi.Cloud to self-hosted WhatsApp Business API (Baileys library) for cost reduction at >1,000 groups
- Claude API cost optimization: batch classification, cache common responses, use Haiku for all classification (reserve Sonnet for complex conversations)
- Consider dedicated Supabase instance at 5,000+ active groups

### Phase 4 Cost Summary

| Item | Monthly Cost |
|------|-------------|
| Supabase (dedicated or team) | $25-599 |
| Vercel Pro | $20 |
| Claude API (5,000+ groups) | ~$8,000-12,000 |
| WhatsApp API | $200-500 |
| PostHog Growth | $50-350 |
| Sentry | $26 |
| Marketing (influencers + ads) | $1,000-2,000 |
| Part-time help (CS + content) | $1,500 |
| **Total** | **$10,821-16,995/mo** |

**Revenue at 10,000 paid (Month 12):**
- 8,000 Premium x 19.90 ILS = ~$43,800/mo
- 2,000 Family+ x 34.90 ILS = ~$19,200/mo
- **Total MRR: ~$63,000/mo**
- **Net margin: ~73-83%**

---

## Updated Metrics & Milestones

| Month | Free Users | Paid Subs | MRR (USD) | Conv % | Churn % | Active Groups |
|-------|-----------|-----------|-----------|--------|---------|---------------|
| 1-2 | 50 (beta) | 0 | $0 | -- | -- | 5 (test) |
| 3 | 300 | 30 | $165 | 10% | -- | 30 |
| 4 | 800 | 80 | $440 | 10% | 5% | 80 |
| 5 | 2,000 | 250 | $1,375 | 12.5% | 5% | 250 |
| 6 | 5,000 | 500 | $2,750 | 10% | 4% | 500 |
| 7 | 8,000 | 1,000 | $5,500 | 12.5% | 4% | 1,000 |
| 8 | 12,000 | 2,000 | $11,000 | 16.7% | 3.5% | 2,000 |
| 9 | 16,000 | 3,500 | $19,250 | 21.9% | 3% | 3,500 |
| 10 | 20,000 | 5,500 | $30,250 | 27.5% | 3% | 5,500 |
| 11 | 25,000 | 7,500 | $41,250 | 30% | 2.5% | 7,500 |
| 12 | 30,000 | 10,000 | $63,000* | 33% | 2.5% | 10,000 |

*Month 12 assumes mix of Premium and Family+ subscribers.

### Why WhatsApp-First Accelerates Growth vs. v1

**v1 required:** See ad -> visit site -> sign up -> explore app -> invite family member -> wait for them to sign up -> both actively use app. Each step loses 50-70% of users. Effective conversion from impression to active household: <1%.

**v2 requires:** See bot in friend's group (or see post) -> add phone number to existing group -> entire family activated instantly. Two steps, not seven. The "invite your family" step is eliminated entirely because the family is already in the group.

**Specific acceleration factors:**
1. **Zero-download activation.** No app install means no App Store friction, no storage concerns, no "I'll do it later."
2. **Passive exposure = marketing.** Every message the bot sends in a group is seen by all members. Family members organically talk about it to friends.
3. **Network effects compound.** At 500 active groups x 5 members = 2,500 people seeing Ours daily. Some percentage mentions it in other contexts.
4. **Churn is structurally lower.** Unsubscribing means removing a family member from the group -- psychologically harder than uninstalling an app nobody notices is gone.
5. **Conversion rate is higher.** The paywall hits AFTER the family has experienced Ours working in their group for ~2 weeks. They're not paying for a promise — they're paying to keep a service they already depend on. This is the Spotify/Netflix model: let them use it, then ask them to pay to continue.

**Kill criteria (updated):** If <50 paid by Month 4, the WhatsApp-first thesis is wrong. Reassess everything.

---

## Updated AI Agent Team

### Agent 1: Shipwright -- Product Development

**v1 role:** Build web app features.
**v2 additions:**
- Build WhatsApp webhook receiver and message processing pipeline
- Implement intent classifier and action executor
- Design message queue and rate limiting for WhatsApp API
- Build web dashboard as control panel for bot activity
- Implement feature gating between free/premium/family+
- Handle WhatsApp API migration (Whapi.Cloud -> Meta Cloud API)

### Agent 2: Herald -- Content & Marketing

**v1 role:** Blog posts and social media content.
**v2 additions:**
- Write WhatsApp bot onboarding messages (the first message the bot sends when it joins a group)
- Create "how to add Ours to your group" tutorial content
- Draft bot personality and tone guidelines (warm, helpful, Hebrew-native, not robotic)
- Produce demo video showing real WhatsApp conversation with bot
- Write Facebook group seeding posts (authentic, not spammy)

### Agent 3: Sentinel -- Analytics & Reporting

**v1 role:** PostHog + Stripe metrics.
**v2 additions:**
- Track WhatsApp-specific metrics: messages processed/day, intent classification accuracy, response latency, group activation rate
- Monitor bot error rates (failed responses, incorrect classifications)
- Track viral coefficient: how many new groups from each existing group
- Alert on WhatsApp API failures or rate limiting
- Cost-per-group tracking (Claude API + WhatsApp API costs)

### Agent 4: Concierge -- Customer Support

**v1 role:** Email support drafting.
**v2 additions:**
- Handle users who message the Ours phone number directly (not in a group) -- redirect to onboarding
- Draft responses for common WhatsApp bot issues ("bot isn't responding", "how do I remove the bot", "bot is too chatty")
- Support in WhatsApp format (short messages, emoji-appropriate) not just email
- Escalation path: when bot encounters a message it cannot classify, flag for human review

### Agent 5: Scout -- Market Intelligence

**v1 role:** SEO and competitor monitoring.
**v2 additions:**
- Monitor WhatsApp bot competitors: Sense AI (family assistant bot), Ollie AI (scheduling bot), any new entrants
- Track Meta WhatsApp Business API policy changes (critical -- policy shifts could impact the product)
- Monitor Whapi.Cloud pricing and reliability
- Research WhatsApp bot best practices from other verticals (e-commerce, customer service) that can apply to family management

### Agent 6: Guardian -- QA & Testing

**v1 role:** Playwright web app testing.
**v2 additions:**
- Test WhatsApp message flows end-to-end: send message in test group -> verify bot response -> verify DB updated -> verify web dashboard reflects change
- Test Hebrew NLP edge cases: slang, abbreviations, voice-to-text typos, mixed Hebrew-English
- Test rate limiting and error handling (what happens when Whapi.Cloud is down?)
- Test privacy: verify bot does not leak data between groups, verify message purge after 30 days
- Test paywall flow: free user adds bot to group -> bot works (30 actions) -> limit reached -> paywall message in group -> payment via web dashboard -> unlimited unlocked

### Agent 7: Ambassador -- Community Management

**v1 role:** Social media community engagement.
**v2 additions:**
- Seed Israeli parent Facebook groups with authentic posts about the WhatsApp bot experience
- Identify and recruit 5-10 "founding families" for beta testing (friends, family, trusted contacts)
- Collect WhatsApp-native testimonials (screenshots of real bot interactions, with permission)
- Manage the "Ours community" WhatsApp group (power users, feedback, feature requests)
- Coordinate with micro-influencers who can demo the bot in their own family groups

### Daily Founder Workflow (30 min non-dev, updated)

| Time | Task | Agent |
|------|------|-------|
| 3 min | Check WhatsApp bot health (errors, latency) | Sentinel |
| 3 min | Review new group activations + churn | Sentinel |
| 5 min | Review/approve content queue | Herald |
| 5 min | Review/send support messages | Concierge |
| 14 min | Dev work on priority feature | Shipwright |

---

## Risks & Mitigations

### Existing Risks (updated)

| Risk | Impact | Mitigation |
|------|--------|------------|
| Nobody pays | Fatal | The paywall hits after families have used 30 free actions (~2 weeks). If they still won't pay, the bot isn't delivering enough value in their daily routine. Validate with 10 beta families before marketing spend. |
| Low viral coefficient (k<0.15) | Growth stalls | Product is inherently visible to all group members. If even that does not generate word-of-mouth, the product is not impressive enough. Fix the bot's responses. |
| AI costs spiral | Margin pressure | Use Haiku for classification ($0.001/msg), Sonnet only for complex queries. At 10K groups: ~$10K/mo vs ~$63K/mo revenue = manageable. Cache common responses. |
| Security incident | Trust destroyed | Phase 1 auth + RLS. WhatsApp messages stored encrypted, purged after 30 days. Bot never shares data between groups. |
| Solo founder burnout | Everything stops | Agent team reduces ops to 30 min/day. Hire PT help by Month 5. WhatsApp bot runs autonomously -- less manual ops than web-first. |

### New Risks (WhatsApp-specific)

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Whapi.Cloud goes down or changes pricing** | Service interruption for all users. $29/mo could jump to $100+. | Medium | Begin Meta Cloud API OBA application in Month 3 as primary migration target. Keep Whapi.Cloud as fallback. Evaluate 360dialog and Twilio as alternatives. Never depend on a single WhatsApp API provider. |
| **Meta rejects OBA application** | Stuck on Whapi.Cloud (higher cost, less reliable). No green checkmark. | Medium | Whapi.Cloud works fine up to 500+ groups. Reapply with stronger business documentation. Consider applying through a different Meta Business Manager account. Many companies get approved on second attempt. |
| **WhatsApp policy changes** | Meta could restrict bots in groups, limit message types, or ban non-official bots. | Low-Medium | As of January 2026, WhatsApp explicitly allows task-specific bots in groups. Ours fits squarely within the "productivity/utility" category Meta encourages. Stay on official APIs (not gray-market). Monitor policy announcements weekly (Scout agent). Have email/web fallback for core functionality. |
| **Claude API costs at scale with proactive features** | Morning briefing + end-of-day summary + smart reminders for 10K groups = potentially $15K+/mo in Claude costs. | High | Haiku for all classification and simple responses. Sonnet only for complex multi-turn conversations. Template common responses (morning briefing is mostly structured data, not creative generation). Cache at household level. Budget ceiling: Claude costs must stay under 25% of revenue. |
| **Users feel surveilled by bot reading all messages** | Privacy backlash. Families remove bot. Bad press. | Medium-High | This is the #1 perception risk. Mitigations: (1) Bot ONLY processes messages to extract tasks/events/shopping -- it does not store or analyze personal conversations. (2) Clear privacy policy in Hebrew displayed when bot joins. (3) "What does Ours know?" command shows exactly what data is stored. (4) 30-day message purge. (5) Bot explicitly ignores messages that are not actionable. (6) Option to pause bot listening without removing from group. |
| **WhatsApp rate limiting** | Slow bot responses during peak hours (7-9 AM, 5-8 PM Israel time). | Medium | Message queue with priority system. Batch non-urgent responses. Whapi.Cloud handles rate limiting internally. Meta Cloud API has generous limits for verified businesses (80 messages/second). |
| **Phone number ban/block** | If users report the bot number as spam, WhatsApp could ban it. | Low | Use official business APIs (not personal number). Maintain high response quality. Never send unsolicited messages to individuals. Follow all WhatsApp commerce policies. Keep a backup number ready. |

---

## First 30 Days -- Updated Execution Order

**Context:** Refactoring, database schema, and auth are already done. The 30 days start from WhatsApp bot development.

### Days 1-3: Whapi.Cloud Setup + Webhook

- Create Whapi.Cloud account, activate sandbox
- Purchase or assign Israeli phone number for bot
- Build Vercel serverless endpoint: `POST /api/whatsapp/webhook`
- Verify webhook receives messages from sandbox test group
- Store raw messages in `whatsapp_messages` Supabase table
- **Deliverable:** Messages from test WhatsApp group appear in Supabase

### Days 4-7: Intent Classifier + Hebrew NLP

- Build Claude Haiku-based intent classifier for Hebrew family messages
- Test with 100+ example messages across all intent categories
- Handle edge cases: voice-to-text artifacts, mixed Hebrew/English, emoji-heavy messages, slang
- Achieve >85% classification accuracy on test set
- **Deliverable:** JSON output of `{intent, confidence, entities}` for any Hebrew message

### Days 8-12: Action Executor + Response Sender

- Wire intent classifier to Supabase CRUD operations (create task, add shopping item, create event)
- Build Hebrew response templates for each action type
- Implement response sending via Whapi.Cloud API
- Add rate limiting (max 1 response per 30 seconds to avoid spam feeling)
- Add "quiet hours" logic (no proactive messages between 10 PM and 7 AM)
- **Deliverable:** Send "צריך חלב" in test group -> bot adds milk to shopping list and confirms

### Days 13-16: Group Management + Member Mapping

- Build group join/leave handlers
- Implement bot introduction message (sent once when bot joins a group)
- Map WhatsApp group members to Supabase profiles (by phone number)
- Handle group metadata changes (name changes, member additions/removals)
- **Deliverable:** Bot joins a new group, introduces itself, and maps all members

### Days 17-20: Web Dashboard (Control Panel)

- Build dashboard page showing bot-captured data (tasks, shopping, events)
- Build WhatsApp settings page (connected groups, bot behavior toggles)
- Build activity feed (chronological log of bot actions)
- Wire real-time updates (Supabase realtime subscriptions)
- **Deliverable:** Web app shows everything the WhatsApp bot has captured

### Days 21-24: Stripe + Feature Gating

- Set up Stripe with 3 price tiers (Free/Premium/Family+)
- Build checkout flow triggered by "Add Ours to WhatsApp" button
- Implement subscription webhook handlers
- Gate WhatsApp bot activation behind Premium subscription
- **Deliverable:** Free user -> clicks "Add to WhatsApp" -> pays -> bot activates in their group

### Days 25-27: Landing Page + Demo Video

- Build Hebrew landing page with WhatsApp bot value proposition
- Record demo video: real WhatsApp group interaction with bot
- SEO meta tags, OG images, service worker
- **Deliverable:** Landing page at ours.co.il (or similar) with conversion flow

### Days 28-30: Beta Testing + Polish

- Recruit 5-10 beta families (friends, family)
- Monitor bot performance across real conversations for 48 hours
- Fix classification errors, adjust response tone
- Load test: simulate 50 concurrent groups
- PostHog + Sentry integration
- **Deliverable:** 5+ families actively using bot in real WhatsApp groups with <5% error rate

---

## Verification Criteria

### Phase 1 (End of Month 2)

- [ ] WhatsApp bot receives messages from groups and classifies intent correctly >85% of the time
- [ ] Bot executes CRUD on tasks, shopping, events via WhatsApp commands
- [ ] Web dashboard displays all bot-captured data in real-time
- [ ] Stripe checkout works: free -> pay -> bot activates in group
- [ ] 5+ beta families using the bot daily
- [ ] Bot responds in <3 seconds (message received to response sent)
- [ ] Privacy: messages purged after 30 days, no cross-group data leakage

### Phase 2 (End of Month 4)

- [ ] 30+ paying subscribers
- [ ] Landing page converts >5% of visitors to free signups
- [ ] Free-to-paid conversion rate >8%
- [ ] Bot handles >95% of common family messages without errors
- [ ] At least 1 organic sign-up per day from word-of-mouth (no paid ads)
- [ ] Net Promoter Score >40 from beta families
- [ ] WhatsApp bot uptime >99.5%

### Phase 3 (End of Month 8)

- [ ] 2,000+ paying subscribers
- [ ] MRR >$11,000
- [ ] Monthly churn <4%
- [ ] Viral coefficient k >0.15 (measured: new paid from referrals / existing paid)
- [ ] Proactive features (morning briefing, reminders) active for Premium users
- [ ] Google Calendar sync working bidirectionally
- [ ] Meta Cloud API migration complete (or Whapi.Cloud still working fine)
- [ ] Claude API costs <25% of revenue

### Phase 4 (End of Month 12)

- [ ] 10,000+ paying subscribers
- [ ] MRR >$55,000
- [ ] Monthly churn <3%
- [ ] Multi-language support (Russian or Arabic live)
- [ ] English beta testing with Anglo Israeli community
- [ ] Part-time team in place (CS + content)
- [ ] Unit economics: LTV/CAC > 5x

---

## Honest Assessment: What Is Hard

1. **Hebrew NLP accuracy.** Hebrew is morphologically complex. Voice-to-text Hebrew on WhatsApp is messy. Getting >90% classification accuracy on real family conversations will require weeks of iteration and a robust test set.

2. **Privacy perception.** An AI reading all family messages is genuinely creepy to some people. The mitigation plan is solid, but some families will refuse on principle. This limits TAM.

3. **Bot personality.** The bot must feel like a helpful family member, not a corporate chatbot. It must know when to speak and when to shut up. Getting this wrong makes families remove the bot within days. This is a design problem, not an engineering problem, and it is harder.

4. **Claude API costs at scale.** Processing every message in every group through even Haiku adds up. At 10K groups x 100 messages/day = 1M messages/day x $0.001 = $1,000/day = $30,000/month just for classification. Need aggressive caching and smart filtering to make this work.

5. **WhatsApp API dependency.** The entire business depends on WhatsApp group API access continuing to work and be affordable. This is a platform risk with no perfect mitigation.

6. **Solo founder executing all of this.** Even with an AI agent team, the WhatsApp bot is a fundamentally different product than a web app. It requires backend message processing, NLP, real-time message queuing, and platform API expertise. The agent team helps, but the founder is still the only human making decisions, testing with real families, and handling the unexpected.

---

## Hebrew NLP Strategy

Hebrew presents unique challenges for an AI family assistant:

**The 4x Token Cost Problem:** Hebrew is tokenized per letter (~4 tokens/word vs ~1 token/word in English). Every API call costs 4x more in Hebrew. Mitigations:
- Haiku filter: skip 70-80% of social messages cheaply ($0.0001/msg vs $0.003)
- 30-second message batching: 60% fewer API calls
- Anthropic prompt caching: 90% discount on the family context (which is 80% of token cost)
- Result: per-message cost drops from ~$0.01 to ~$0.001-0.003 even in Hebrew

**Morphological Complexity:** Hebrew has 70M valid word forms vs English's 1M. A single root generates thousands of forms. Solution: Claude already handles Hebrew morphology well (93.34% accuracy in benchmarks, above GPT-4's 92%). The system prompt adds family-specific context that resolves most ambiguity.

**Casual Hebrew Chat Patterns:** The system prompt teaches Claude 8 specific patterns Israeli families use in WhatsApp:
1. Bare nouns = shopping items ("חלב" → add milk)
2. [person] [activity] [time] = task ("נועה חוג 5" → pick up Noa at 5)
3. Questions about who = unassigned tasks ("מי אוסף?" → create unassigned pickup task)
4. "אני" after a task question = task claim
5. Israeli time formats ("ב5" = 17:00, "אחרי הגן" = ~16:00, "לפני שבת" = Friday before sunset)
6. Ignore: photos, stickers, forwarded memes, greetings, goodnight messages
7. Mixed Hebrew-English ("יש meeting ב-3" → Event at 15:00)
8. Abbreviations ("סבבה" = OK/confirmation, "בנט" = meanwhile, "תיכף" = soon)

**Why Hebrew-first is a moat:** If the AI works with Hebrew family chat (the hard case), English works out of the box. Any US competitor adding Hebrew later faces the same challenges we've already solved.

**Iterative improvement:** Every failed classification becomes a new pattern in the prompt. Over 3-6 months, the prompt becomes an incredibly valuable, proprietary asset.

---

*Plan version: v2.0*
*Date: March 29, 2026*
*Author: Yaron (with Claude agent team)*
*Status: Active -- WhatsApp-first pivot*
*Supersedes: v1.0 (web-app-first approach)*
