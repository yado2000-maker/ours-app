# 1:1 Personal Channel Strategy — "One Sheli, One Price"

## Context

Sheli currently supports both group (family) and 1:1 (direct) WhatsApp channels. The 1:1 channel has full capabilities (shopping, tasks, events, reminders, rotations) with auto-household creation. However, the entire business model — pricing, referrals, billing, learning — is wired around **households as the atomic unit**, and positioning targets families exclusively.

**Problem:** Some users would rather use Sheli as a personal assistant — singles, single parents with small kids, people who want both personal and family channels. The current family-only positioning excludes them. The question: should 1:1 be a separate product, a funnel, or included?

**Decision:** "One Sheli, One Price" — personal and family are both just "Sheli." No separate product lines, no separate pricing. Whether you're a single person or a family of 5, the same tiers apply. Simplicity wins at this stage; segment later with data.

---

## 1. Product Model

### Pricing (unchanged structure, broadened positioning)

| Tier | Price | What's included |
|------|-------|----------------|
| Free | 0 | 30 actions/month across all channels (group + 1:1). Keep at 30 for now, revisit with data. |
| Premium | 9.90 ILS/mo | Unlimited actions, morning briefing, end-of-day summary, smart reminders |
| Family+ | 24.90 ILS/mo | All Premium + up to 3 groups (multi-household families, divorced co-parents) |

### User types mapped to existing infrastructure

| User type | Household | Channels | Code changes |
|-----------|-----------|----------|-------------|
| Single person | Personal household (auto-created) | 1:1 only | None — already works |
| Couple/roommates | Shared household | Group + optional 1:1 | None |
| Family | Family household | Group + optional 1:1 per member | None |
| Single parent | Personal → family household | 1:1 first, adds group later | None |
| Divorced co-parent | Two households (Family+ tier) | Group per home + personal 1:1 | None |

**Key insight:** The "household" concept already stretches to include "just me" without any code change. The change is positioning and copy, not architecture.

---

## 2. Morning Briefing as Conversion Hook

**Current plan:** Morning briefing gated behind Premium (Phase 2).

**New approach:** Morning briefing starts FREE, then converts to Premium.

### Applies to ALL channels (group + 1:1)

Morning briefing is not 1:1-only — it works everywhere. In groups, briefing goes to the group chat. In 1:1, briefing goes to the personal chat.

### Flow:
1. When a user/household has enough tasks/events/reminders for a meaningful briefing, start sending morning briefings (07:30 IST default, user can change the time)
2. First 5 briefings are free — user builds the habit
3. After 5, Sheli asks: "נהנים מהסיכום הבוקר? 😊 רוצים להמשיך לקבל? עם פרימיום אין הגבלה [link]"
4. User opts in (pays) or opts out (briefings stop, no resentment)
5. Users who opt out can re-enable later from chat ("שלי, אני רוצה סיכום בוקר")
6. Users can change briefing time: "שלי, שלחי סיכום ב-8 בבוקר" → updates preference

### Opt-in/opt-out respect:
- **Never assume everyone wants briefings** — some users find proactive messages annoying
- After the free taste, the question is genuine: "do you want this?"
- "לא תודה" → briefings stop, no follow-up, no guilt
- User preference stored in `onboarding_conversations.context` or `household_members` preferences

### Why this works:
- Classic "value-first paywall" — let the feature sell itself through experienced value
- The user feels the LOSS of the briefing (habit built in ~5 days), not just the promise
- Respects users who don't want it (no spam perception)
- Converts the highest-intent users naturally

---

## 3. Onboarding — Group Nudge Strategy

**Old behavior:** Sheli nudges 1:1 users toward adding a family group (default behavior).

**New behavior:** Sheli is equally happy with 1:1-only users. Group suggestion is ONE mention, then respect the choice.

### Trigger: 2 days OR 5 actions, whichever comes first

After the trigger, Sheli sends ONE casual mention:
> "אם גרים איתך עוד אנשים, אפשר להוסיף אותי לקבוצה של הבית ואני יכולה לתאם הכל בין כולם 🏡"

Then **never again** (unless the user explicitly mentions family/partner/roommate in future messages).

### Context-responsive mentions (additive, not replacing the one-time nudge):
- User mentions "בן/בת זוג" → "רוצים שאני אעזור לשניכם? תוסיפו אותי לקבוצה 😊"
- User mentions "הילדים" → same organic suggestion
- User never mentions others → never suggest again after the one-time mention

---

## 4. Marketing & Positioning

### Copy changes

**Hero tagline:**
- Current: "העוזרת החכמה של הבית והמשפחה"
- **New:**
  ```
  שלי
  העוזרת החכמה שלכם בווטסאפ
  ```
  - "שלכם" (plural) works for any gender, any household size
  - "בווטסאפ" is now the top selling point — positions WhatsApp-native as the key differentiator
  - The value prop: just send a quick message and Sheli takes care of it

**Sub-line:**
- Current: none / family-specific
- **New: "לכם ולבית"** (for you and the home — universal, warm, avoids "alone" or "family")

**Name pun preserved:** "שלכם ושלי" (yours and mine/Sheli's) works for singles too

### Landing page adjustments
- Feature grid: show personal use cases alongside family ones
- **Add reminders as a featured capability** — currently missing from feature grid. "תזכורות חכמות" with example: "שלי, תזכירי לי לקחת את הכביסה בעוד שעה"
- **Explain Sheli's learning moat** — a feature section about how Sheli learns and understands you over time. "שלי לומדת ומבינה אתכם" — she remembers your patterns, nicknames, preferences. The longer you use her, the smarter she gets.
- WhatsApp mock: alternate between single-person and family conversation examples
- FAQ additions:
  - "אני גר/ה לבד, שלי מתאימה לי?" → "בטח! שלי מתאימה לכל מי שרוצה קצת יותר סדר בחיים"
  - "אני גר/ה עם שותפים, שלי יכולה לעזור?" → "בטח! תוסיפו את שלי לקבוצת הדירה ואני אתאם הכל — מי קונה חלב, תור למקלחת, ומי שוטף כלים 🧹"
- **Update CTAs** — all CTAs on landing page must reflect the broadened positioning:
  - Hero CTA: should invite to try Sheli (not "add to family group")
  - Feature section CTAs: "נסו עכשיו" / "שלחו הודעה לשלי" — action-oriented, not family-specific
  - Bottom CTA: same wa.me link, universal wording
  - Ensure CTA copy uses plural gender-free forms ("התחילו", "נסו", "שלחו")
- No separate marketing channels — same wa.me link, same landing page, same bot

---

## 5. Retention for 1:1-Only Users

**Challenge:** Family groups have built-in social retention (if one member stops, others keep the conversation alive). Singles have no such social gravity.

### Retention levers (ordered by impact):
1. **Morning briefing (free hook → Premium)** — Makes Sheli the first thing they see each morning
2. **Proactive reminders** — Already built (reminder_queue + pg_cron). Singles benefit most.
3. **Smart follow-ups** (future) — "קנית את החלב?" 24h after adding. High-impact for solo users.
4. **Weekly digest (Premium)** — "השבוע עשית 12 דברים, סימנת 8 ✅"
5. **Context memory** — Sheli remembers patterns. Long-term moat.

### What's NOT needed for singles (gracefully hidden):
- Rotation/turns system — irrelevant, but doesn't break
- Task assignment — Sheli auto-assigns to "you"
- Family+ tier — irrelevant for singles

---

## 6. Implementation Principle

**Do NOT force current processes onto the new 1:1 module.** The existing 1:1 handler (`handleDirectMessage`) and onboarding flow were written incrementally over weeks with family-first assumptions baked into every layer. Rather than patching 35 things onto that foundation:

- **Rewrite the 1:1 handler cleanly** — apply all lessons learned, gotchas, and patterns from the project (state machine races, nudge timing, quiet hours, batching, memory aging, etc.) but design it fresh for a "personal + family" world.
- **Don't retrofit** — if a prompt, message template, or state transition was designed around "get them into a group ASAP", replace the logic, don't just change the copy.
- **Carry forward what works** — auto-household creation, action execution, voice transcription, Q&A matching — these are solid. Reuse the mechanics, rethink the framing.

This applies to the landing page too — don't just swap 13 strings. Rethink the page structure with "personal + family" as the native framing, then rewrite the sections.

---

## 7. Full Touchpoint Audit — 35 Instances Across 12 Files

### A. Landing Page (`src/components/LandingPage.jsx`)
1. **Hero tagline HE** → "שלי / העוזרת החכמה שלכם בווטסאפ"
2. **Hero tagline EN** → "Sheli — Your smart helper on WhatsApp"
3. **Main CTA** "הוסיפו את שלי לקבוצה" → "שלחו הודעה לשלי" (universal, not group-specific)
4. **Shopping feature subtitle** "אמרו 'חלב' בקבוצה..." → "כתבו 'חלב' לשלי..." (works for 1:1 too)
5. **Step 1 title** "הוסיפו את שלי לקבוצת הווטסאפ" → "שלחו הודעה לשלי בווטסאפ" 
6. **Step 1 subtitle** "לחצו על הכפתור ושלי מצטרפת לקבוצה שלכם" → "לחצו על הכפתור ושלי מתחילה לעזור"
7. **Calendar feature EN** "organizes the family calendar" → "organizes your calendar"
8. **FAQ "how to start"** — update to mention both group and personal options
9. **Add new feature: reminders** "תזכורות חכמות"
10. **Add new feature: Sheli learns** "שלי לומדת ומבינה אתכם"
11. **Add FAQ: singles** "אני גר/ה לבד..."
12. **Add FAQ: roommates** "אני גר/ה עם שותפים..."
13. **All CTAs** — plural gender-free forms ("התחילו", "נסו", "שלחו")

### B. Auth Screen (`src/components/AuthScreen.jsx`)
14. **Tagline HE+EN** — same as hero tagline update

### C. Setup Screen (`src/components/Setup.jsx`)
15. **Tagline EN** — "Your smart helper on WhatsApp"

### D. Welcome Screen (`src/components/WelcomeScreen.jsx`)
16. **Tagline HE+EN** — same update
17. **WhatsApp mock group name** "הקבוצה של הבית" → keep (still relevant) but consider adding personal chat variant
18. **Shopping feature** "אמרו 'חלב' בקבוצה" → "כתבו 'חלב' לשלי"

### E. JoinOrCreate (`src/components/JoinOrCreate.jsx`)
19. **Error message** "לא מצאנו משפחה" → "לא מצאנו בית" / "No family found" → "No household found"
20. **Phone lookup text** "נמצא את המשפחה" → "נמצא את הבית שלכם" / "find your family" → "find your home"

### F. Locale Strings (`src/locales/he.js` + `src/locales/en.js`)
21. **waSettingsSub** — remove "family" phrasing, keep "home/WhatsApp group"
22. **menuInviteDesc** — "בני הבית" → keep (neutral enough) or "חברי הבית"
23. **menuWaDesc** — same as waSettingsSub
24. **menuReferral title** "משפחה מביאה משפחה" → "חברים מביאים חברים" (friends bring friends — works for all)
25. **menuReferralDesc** — "הזמינו משפחה" → "הזמינו מישהו" (invite someone)
26. **menuReferralShare** — "שלחו למשפחה" → "שלחו לחברים" / "Send to friends"
27. **menuReferralStats** — "families" → "people" / "households"

### G. OTP Bridge Message (`supabase/functions/otp-sender/index.ts`)
28. **Bridge message** — "רוצה שאעזור לכל המשפחה?" → "רוצים שאעזור גם לשאר הבית? הוסיפו אותי לקבוצת הווטסאפ"

### H. Referral Share Text (`src/components/modals/MenuPanel.jsx`)
29. **Share text HE** — "עוזרת חכמה למשפחה" → "עוזרת חכמה בווטסאפ"
30. **Share text EN** — "smart family helper" → "smart helper on WhatsApp"

### I. Bot Prompts (`index.inlined.ts`)
31. **Classifier examples** — add solo-user test cases alongside family ones
32. **1:1 Sonnet prompt** — remove group-push bias, Sheli should feel complete in 1:1

### J. Documentation & Config
33. **CLAUDE.md taglines** — update to new taglines
34. **`.claude/skills/copywriting.md`** — update "family coordination app" to "personal + family helper"
35. **CSS comment in `app.css`** — minor: "warm family" → "warm personal"

---

## 8. Code Changes Summary

### New features to build:
1. **Morning briefing** — pg_cron job at 07:30 IST (configurable per user). Send to both group and 1:1 channels. Track briefing count, stop after 5 free. Preference field for opt-in/opt-out and custom time.
2. **Group nudge timing** — change from current nudge schedule to "2 days OR 5 actions, once only" trigger in 1:1 handler.

### Copy/positioning updates (35 instances above):
3. **Landing page** — hero, CTAs, features, FAQ (13 changes)
4. **Auth/Setup/Welcome screens** — tagline updates (5 changes)
5. **JoinOrCreate** — neutral wording (2 changes)
6. **Locale strings** — referral and settings copy (7 changes)
7. **Bot messages** — bridge message, share text, prompts (5 changes)
8. **Docs** — CLAUDE.md, skills, CSS comments (3 changes)

### No code changes needed:
- Billing (per-household already works for singles)
- Free tier limit (keep at 30, revisit with data)
- Referral mechanics (works for singles referring singles or families — just update copy)
- Action execution (all capabilities already work in 1:1)
- Household auto-creation (already built)

---

## 9. Admin Dashboard Changes

The admin dashboard needs to reflect the 1:1-as-first-class-channel reality:

### New metrics:
- **Channel breakdown:** How many households are 1:1-only vs group vs both
- **1:1 onboarding funnel:** Welcome → First action → 5 actions → Group add (or stayed 1:1)
- **Morning briefing stats:** How many sent (free vs paid), opt-out rate, conversion rate at the paywall moment
- **Group nudge conversion:** How many 1:1 users saw the nudge → how many added a group

### Updated existing metrics:
- **Active households:** Split by type (personal / group / both)
- **Retention cohorts:** Separate curves for 1:1-only vs group users (expect different retention shapes)
- **Revenue per channel:** Which channel drives more Premium conversions

### Dashboard location:
- Extend existing admin dashboard (`/admin` route) with a new "Channels" tab/section

---

## 10. Verification

- [ ] Confirm 1:1 auto-household creation works for new users (test with fresh phone number)
- [ ] Verify 30-action limit fires correctly for 1:1-only households
- [ ] Test that referral codes work when shared between singles (no group involved)
- [ ] Verify morning briefing can be sent to 1:1 chats (not just groups)
- [ ] Landing page renders correctly with new copy (Hebrew RTL, both mobile and desktop)
- [ ] Confirm group nudge fires once and only once at the right trigger point
