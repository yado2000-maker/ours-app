# Pricing Tiers v2 — Launch with Free + Premium, Infrastructure-Ready for Family+

**Status:** Design approved 2026-04-15. Supersedes the pricing sections of `2026-04-12-one-sheli-one-price-design.md`. Implementation plan (`2026-04-15-pricing-tiers-v2-plan.md`) is a future followup — blocked on morning-briefing delivery and iCount terminal activation.

## ⚠️ User-facing copy review gate

Every message this design proposes sending to real users — beta-sunset DMs, paywall prompts, morning-briefing opt-in, referral-reward copy, upgrade CTAs — is **draft illustration only**. Nothing goes live in WhatsApp, SMS, email, or the web app without Yaron's explicit per-string approval. Implementation must:

1. Never hardcode final copy from this document.
2. Keep all user-facing strings in `src/locales/he.js` / `en.js` or equivalent, so they can be reviewed as a block.
3. Surface every new outbound-message template to Yaron for review before the code path that uses it is deployed.
4. Hebrew strings in this plan (beta-sunset messages, paywall prompts, etc.) are placeholders — treat them as intent sketches, not production copy.

---

## Context

**Why this change is being made.** Sheli's original pricing (Free 30 actions → Premium 9.90 → Family+ 24.90) was designed before the 1:1 direct-message channel existed. Premium was pitched as "unlimited messages in the group chat." Now that 1:1 is live (2026-04-12) and auto-creates personal households, we need a pricing model that:

1. Works for solo users, couples, roommates, and full families under a single product ("One Sheli, One Price" — the 2026-04-12 positioning principle stays intact).
2. Reflects the reality that `BETA_MODE=true` has been blocking the paywall, so we have zero paying customers and full freedom to redesign before enforcement.
3. Doesn't prematurely paywall the 1:1-per-member lever, since we only have ~2-3 weeks of 1:1 activation data and can't yet defend it as a purchase driver.
4. Keeps the billing/subscription/entitlement plumbing ready for a future Family+ tier without shipping it now — one conversion decision for users, simpler landing page, sharper pitch.

**The strategic decision, in one line:** Launch with **Free + Premium only.** Build Family+ infrastructure silently. Turn Family+ on once 1:1 member-channel retention is proven and per-member briefing is built (~6-8 weeks post-launch).

---

## Tier structure

### Launch (Free + Premium only, Family+ dark)

| | Free | Premium (9.90 ILS/mo) |
|---|---|---|
| Actions/month | **40** (up from 30) | Unlimited |
| Channels | Group and/or 1:1 (no restriction) | Group and/or 1:1 (no restriction) |
| Morning briefing | **5 free** (lifetime), then opt-in paywall | **Unlimited** at household level |
| Smart reminders | ✅ Unlimited | ✅ Unlimited |
| Voice transcription (≤30s) | ✅ | ✅ |
| Family memories | Basic (household-wide cap) | Basic (household-wide cap) |
| Rotations (order/duty) | ✅ | ✅ |
| Group nudge (family discovery) | ✅ once | ✅ once |

**Design intent:** Free is generous enough to maximize activation but tight enough that engaged users hit the decision point. Premium's only headline is *unlimited + briefing*. If a user is in enough love with Sheli to hit 40 actions OR wants the morning-briefing habit kept alive, they convert. Clean, honest, no feature bloat.

### Future (Family+ launches once validated)

**Target price: ~19.90 ILS/mo** (provisional — final decision locked at Family+ launch, 6-8 weeks out, based on Premium conversion data and value density).

Pricing rationale: 2x over Premium (9.90 → 19.90) is the clean SaaS ladder ratio (YouTube, Spotify, Netflix all sit near 1.8-2x for their family upgrades). The original 24.90 (2.5x) creates an unusually steep barrier that likely suppresses conversion. Starting lower gives more signal per month and leaves room to raise if member-1:1 earns it — with "founder price" grandfathering for early Family+ subscribers.

| Added in Family+ (~19.90 ILS/mo, TBD) |
|---|
| Up to 3 groups (divorced co-parents, multi-home, blended families) |
| **Per-member morning briefings** — each member sets their own time and scope |
| **Per-member memory depth** — 30 memories/member (vs household-wide cap in Free/Premium) |
| **Personal 1:1 Sheli for every member** — when 1:1 retention data earns this paywall (~Week 6-8 post-launch) |
| Early/beta access to new features |

**Long-term pitch once Family+ ships:** "Sheli for everyone at home." Every member of the family gets their own assistant with their own memory and their own morning briefing. This is Vision C from the brainstorming session — personal-assistant-per-member — and it's the defensible moat for scaling beyond the founder-centric household.

---

## Infrastructure to build NOW (even though Family+ isn't sold yet)

The whole point of launching with two tiers is that the third tier's scaffolding is invisible to users but real in code. Concretely:

1. **`subscriptions.tier` enum column** — values `free | premium | family_plus`. Today only `free` and `premium` are assigned; `family_plus` exists but no one can select it.
2. **Central `hasFeature(household, feature)` helper** — a single function read by action-executor, briefing scheduler, group onboarding, etc. Adding Family+ later becomes a data flip, not a code change. Features to gate day 1: `unlimited_actions`, `unlimited_briefing`. Features to gate day N: `multi_group`, `per_member_briefing`, `deep_memory`, `member_1on1`.
3. **`household_members.briefing_preferences` JSONB** — store per-member briefing time + scope even though today only the household-level setting is surfaced in UI. The data model is per-member from day 1; the UI gate is tier-driven.
4. **`households_v2.parent_household_id`** nullable FK — lets a Family+ subscriber link 2-3 households under one billing relationship. Today `NULL` everywhere; no behavior change.
5. **Tier enforcement sits behind a single middleware** in `index.inlined.ts` — currently `BETA_MODE` short-circuits all paywall checks. Replace with tier-aware logic that respects `is_beta_family=true` for the grandfathering window, then switches over cleanly.

**No public mention of Family+ anywhere.** Not on the landing page, not in MenuPanel, not in bot replies. It exists in code only. The moment we market it prematurely, we create debt: vapor promises to the first wave of paid users.

---

## Rollout sequencing

Premium can't be sold until the product is ready for it. Four prerequisites:

1. **Morning briefing shipped** — Premium's only headline feature beyond "unlimited." Selling Premium without briefing is vaporware. This is already the top roadmap item per the 2026-04-12 design.
2. **iCount terminal activated** — CLAUDE.md flags this as still pending. No charging is possible until this lands. iCount API v3 client work and the `icount-webhook` Edge Function are already in place; the blocker is the terminal approval itself.
3. **Upgrade flow UI** — in the web app (MenuPanel → "Upgrade" CTA, already has the shell) and in-chat (WhatsApp message with one-tap payment link when user hits 40 actions or their 5th free briefing). iCount payment link lives in `ICOUNT_PAYMENT_LINK` env var.
4. **Tier-enforcement middleware + grandfather logic** — replaces `BETA_MODE` short-circuit with a tier check that honors `is_beta_family=true` flag for 60 days post-launch.

### Beta family sunset (60 days, then convert)

> **Copy in this section is DRAFT — requires Yaron's explicit approval before the first message is sent to any real beta family.**

- **Day 0 (launch day):** `BETA_MODE=false` for new signups. Beta families (those with `is_beta_family=true`, set on existing households) continue getting Premium features free, but see a one-time WhatsApp message announcing the 60-day grandfather window and thanking them for trying Sheli. [**Copy TBD — user approval required.**]
- **Day 30 (reminder):** Sheli sends a soft mid-point message noting the halfway mark and offering the upgrade link. [**Copy TBD — user approval required.**]
- **Day 55 (final):** Final reminder 5 days before flip. [**Copy TBD — user approval required.**]
- **Day 60:** `is_beta_family` flag cleared. Household reverts to Free (40 actions/mo, 5 briefings). If they were actively using more, they hit the paywall naturally.

Intent sketches (NOT final copy) to inform the eventual drafting pass:
- Day 0 — warm thank-you + timeline transparency + "everything stays free until day 60"
- Day 30 — casual halfway mention + upgrade CTA
- Day 55 — "heads-up, 5 days left" + upgrade CTA

All three messages must respect quiet hours (22:00-07:00 + Shabbat per CLAUDE.md) and feminine-first-person Sheli voice.

**Rationale:** respects early-adopter loyalty, gives 2 months to build the upgrade habit, avoids bait-and-switch. Cost in forgone revenue: ~10-20 households × 2 months × 9.90 ILS = ~300 ILS. Negligible for the goodwill.

---

## Free tier interactions that need revisiting

- **Referral ("Family brings Family") trigger:** Currently rewards at 10 actions with "30 days free." With Free at 40 actions/mo, 30 days free means nothing to someone who hasn't hit the paywall. Proposed shift (defer to separate design; flagging here):
  - Trigger: still at 10 actions (good engagement signal).
  - Reward: **1 month of Premium free** for both the referrer and the referee, applied the moment either becomes a paying candidate. Referrer gets a clear perk; referee gets briefing unlocked.
- **Morning briefing paywall copy:** After 5 free briefings, Sheli asks whether the user wants to keep them — upgrade prompt references Premium only (no Family+ mention). [**Copy TBD — user approval required.** The 2026-04-12 design contained a draft sketch which needs re-review.]
- **Action-limit paywall copy:** When user hits 40, the upgrade prompt should lead with the briefing + unlimited combo, not just "you ran out." Frame loss-of-proactivity, not loss-of-capacity. [**Copy TBD — user approval required.**]

---

## Critical files to modify (for downstream implementation plan)

Day 1 (launch with Free + Premium):

- `supabase/functions/whatsapp-webhook/index.inlined.ts` — replace `BETA_MODE` checks with tier middleware; add upgrade-prompt generator for 40-action and 5-briefing thresholds.
- `src/components/modals/MenuPanel.jsx` — wire real upgrade CTA to iCount payment link, show plan badge from `subscriptions.tier`.
- `src/lib/supabase.js` — add tier-aware helpers (`getTier`, `hasFeature`).
- `src/components/LandingPage.jsx` — pricing section with only Free + Premium cards.
- Supabase migration — add `subscriptions.tier` enum, `households_v2.parent_household_id`, `household_members.briefing_preferences` JSONB, `households_v2.is_beta_family` boolean.
- `supabase/functions/icount-webhook/index.ts` — confirm it sets `tier=premium` on successful payment.
- New file: `supabase/functions/_shared/entitlements.ts` (then inline into `index.inlined.ts`) — central `hasFeature` resolver.

Day N (Family+ launch — separate plan):
- Landing page Family+ card.
- MenuPanel "Upgrade to Family+" flow.
- Per-member briefing scheduler (pg_cron + per-member preference read).
- Member 1:1 authorization UI + bot-side gate.
- Multi-group household linker.

---

## Verification plan

Once the Day 1 implementation lands, verify end-to-end:

1. **Free tier enforcement:** Create a test household, send 40 actions (mix of tasks/shopping/events in 1:1 and group), confirm the 41st triggers the upgrade prompt. Confirm the 41st action is NOT silently dropped — it should be rejected with a clear Hebrew message. [**Upgrade-prompt copy TBD — user approval required.**]
2. **Briefing paywall:** Trigger 5 morning briefings (manually via pg_cron or a test function), confirm the 6th sends the opt-in upgrade message instead of the briefing. [**Opt-in copy TBD — user approval required.**]
3. **Tier check from helper:** In a Supabase SQL console, toggle a test household's `subscriptions.tier` between `free` and `premium`, send a test message, confirm the bot honors the tier (unlimited vs 40-cap).
4. **Beta grandfather:** Set `is_beta_family=true` on a test household, trigger the middleware, confirm it behaves like Premium. Manually set `is_beta_family=false`, confirm it reverts to Free enforcement on the next action.
5. **iCount upgrade flow (staging):** End-to-end — user clicks upgrade link → completes iCount payment → `icount-webhook` updates `subscriptions.tier=premium` → bot stops showing upgrade prompts. Use the iCount sandbox before terminal is activated.
6. **Admin dashboard:** Confirm tier distribution shows correctly in `/admin` — free / premium / family_plus counts. `family_plus` should be 0 at launch.
7. **Landing page:** Pricing section renders Free + Premium cards only. No leak of Family+ anywhere (check HE and EN, mobile and desktop).
8. **Referral reward compatibility:** Existing referral code flow still works, but the reward description ("1 month of Premium") reflects the new model — flag separately if the 30-days-free copy still appears anywhere.

---

## Summary table

| Decision | Value |
|---|---|
| Free tier | 40 actions, 5 briefings, reminders, voice, rotations |
| Premium | 9.90 ILS/mo, unlimited actions, unlimited briefing |
| Family+ price (target) | ~19.90 ILS/mo, final decision locked at Family+ launch |
| Family+ at launch | Built in infrastructure, NOT sold |
| Family+ future spine | Per-member 1:1 Sheli + per-member briefing + memory depth + multi-group |
| Family+ trigger | Member-1:1 retention validated + per-member briefing shipped + real demand |
| Beta sunset | 60-day grandfather, 3 soft messages at day 0/30/55, revert day 60 |
| Blocking launch prerequisites | Morning briefing, iCount terminal, upgrade flow UI, tier middleware |

---

## Not in scope for this design

- **Google Calendar sync** — Phase 3 per 2026-04-12 design, unrelated to tier redesign.
- **Weekly digest / end-of-day summary** — punted out of Premium to keep it narrow; can land in Family+ later without a re-pricing.
- **Premium pricing psychology testing (9.90 vs 12.90 vs 14.90)** — separate experiment once we have conversion data.
- **Family+ price finalization** — deliberately deferred. The 19.90 figure is the working assumption but the locked price is decided at Family+ launch based on actual Premium conversion curves.
- **Annual billing** — nice-to-have but iCount standing orders + 9.90/mo works fine for launch.
- **International pricing (USD)** — no non-Israel users yet; Phase 3+.
