# Meta Business Verification + Positioning Copy

**Status:** Draft audit + recommended copy, 2026-04-19
**Owner:** Yaron (operational edits in Meta Business Manager)
**Context:** Plan refinement R0 / new Task 4.0. This is the highest-leverage single copy surface in the whole Option 1 Cloud API migration — the Meta reviewer reads this page when deciding verification approval + template category decisions. Every word shapes the risk surface.

**See also:**
- `docs/plans/2026-04-18-option-1-cloud-api-migration-design.md` §4 (positioning — words in/out)
- `C:\Users\yarond\.claude\plans\refine-planning-of-the-eventual-stearns.md` Refinement R0

---

## Positioning principle (from design §4)

| Keep | Drop |
|---|---|
| smart (חכמה) | AI (בינה מלאכותית) |
| helper (עוזרת) | LLM |
| assistant | chatbot |
| organizer (מארגנת) | "powered by ChatGPT" |
| family coordination | anything implying open-ended Q&A |
| utility / task management | "general-purpose assistant" |

**Frame Sheli as:** family task and list coordination service with WhatsApp interface.
**Do NOT frame Sheli as:** AI assistant, AI chatbot, LLM-powered anything.

Recall: Zapia (5.5M users, $12M funded, Cloud API + Claude Haiku) was banned Dec 22 2025 under Meta's "AI Provider" policy despite proper infrastructure. Cloud API is not a compliance shield — positioning is.

---

## 1. Meta Business Manager — Business Settings → Business Info

### 1.1 Legal business name

**Recommended:** keep whatever is already registered with Israeli authorities (עוסק פטור / חברה). Don't edit.

### 1.2 Display name

**Recommended:** `Sheli`
- Avoid `Sheli AI` / `Sheli Bot` / `Sheli Assistant` — any of these read as "AI chat product" to the reviewer.
- `Sheli` alone is neutral and matches the landing page wordmark.

### 1.3 Business description (English) — under 512 chars

**Recommended:**

> Sheli is a family task coordination service for WhatsApp. Households use Sheli to manage shared shopping lists, chore assignments, event reminders, and household expenses through chat. The WhatsApp interface delivers scheduled reminders, list updates, and confirmations. Behind the scenes, Sheli organizes tasks by category, deadline, and family member. Website: https://sheli.ai

**Why this wording works:**
- Leads with "family task coordination service" — a recognized utility category.
- Enumerates concrete utility features: shopping lists, chores, reminders, expenses.
- "Scheduled reminders, list updates, confirmations" = template-eligible Utility categories that Meta approves without AI-product flags.
- Zero AI / LLM / chatbot language.
- Ends on a clear web URL — reviewer can verify the product claim against a utility-framed landing page.

**Banned words in this field (audit current submission, strip any of):** AI, artificial intelligence, LLM, chatbot, machine learning, GPT, Claude, ChatGPT, assistant (borderline — prefer "helper" or drop entirely), smart (borderline — keep if needed but not in leading sentence).

### 1.4 Business description (Hebrew)

**Recommended:**

> שלי היא שירות לתיאום משימות משפחתיות בווטסאפ. משפחות משתמשות בשלי לניהול רשימות קניות משותפות, חלוקת מטלות, תזכורות לאירועים ומעקב הוצאות משק בית — הכל דרך ווטסאפ. שלי שולחת תזכורות מתוזמנות, עדכוני רשימות ואישורים. הכרטיס הראשי: https://sheli.ai

**Banned words in Hebrew field:** בינה מלאכותית, AI, LLM, צ'אטבוט, ChatGPT, "עוזרת בינה מלאכותית".

### 1.5 Category / Sub-category / Vertical

**Recommended:**
- **Primary category:** Productivity
- **Sub-category:** Household Services OR Task Management (whichever the Meta UI offers)
- **Vertical:** Productivity / Lifestyle

**Do NOT pick:**
- AI / Artificial Intelligence (if offered)
- Technology / Software (too generic + triggers AI-product scrutiny)
- Communication / Messaging (implies chat-product, Meta scores stricter)

### 1.6 Website URL

**Recommended:** `https://sheli.ai`

Audit the landing page matches the utility framing before submitting — reviewer will click through. Landing should lead with shopping/reminders/family coordination, not AI/smart helper. (Landing audit is plan Tasks 1-3; if those haven't shipped yet, consider deferring verification re-review until after.)

### 1.7 Contact email

**Recommended:** a bot-support-style email, not Yaron's personal.
- Good: `support@sheli.ai`, `hello@sheli.ai`
- Bad: `yaron@gmail.com` — looks like an individual developer, not a business.

Set up `hello@sheli.ai` as a forward to Yaron's real inbox if not already.

### 1.8 Profile picture

**Recommended:** the coral→pink gradient "sheli" wordmark icon from `/public/icons/icon.svg`.

**Do NOT use:**
- Robot imagery (🤖 or similar)
- Brain imagery
- Sparkles / magic wand (reads as "AI product")
- Any ChatGPT-style conversation bubble iconography

The current gradient wordmark is neutral and utility-framed — good as-is.

### 1.9 Physical address

Required for some Meta verification flows. Use a valid Israeli business address (home office is fine for עוסק פטור).

---

## 2. WhatsApp Business Profile (separate from the Business Manager page)

Each WhatsApp phone number has its own "About" / "Bio" on its WhatsApp Business profile, visible to users. This must be updated on BOTH numbers:
- Old: `+972 55-517-5553` (Whapi, legacy)
- New: Cloud API number once registered

### 2.1 About / Bio text (Hebrew)

**Recommended, unified across both numbers:**

> `שלי — מארגנת מטלות, קניות ותזכורות למשפחה בווטסאפ`

**Alt option (slightly warmer):**

> `שלי — רשימות קניות, תזכורות ומטלות משותפות למשפחה`

**Why:** matches the Business description positioning, uses the verb "מארגנת" (organizer) instead of "עוזרת" where possible to emphasize utility, mentions the three textbook-utility features (shopping/reminders/tasks). Stays under the WhatsApp 139-char bio limit.

### 2.2 Business hours

Optional in WhatsApp profile. If set: "24/7" is fine — matches the reminder/list-delivery reality. Don't describe support hours that imply human staff.

### 2.3 Profile name

**Recommended:** `Sheli` (same as Business Manager display name).

---

## 3. Audit checklist (Yaron to run in Meta Business Manager)

Before submitting updates:

- [ ] Legal business name — unchanged.
- [ ] Display name — is it `Sheli`? If not, edit to `Sheli`.
- [ ] Business description EN — matches §1.3 above? Zero banned words?
- [ ] Business description HE — matches §1.4? Zero banned words?
- [ ] Category / sub-category — Productivity + Household Services / Task Management?
- [ ] Vertical — Productivity / Lifestyle?
- [ ] Website URL — `https://sheli.ai`?
- [ ] Contact email — bot-support style, not personal?
- [ ] Profile picture — utility-framed, no robot/brain/sparkles?
- [ ] Physical address — present and valid?

After submitting:

- [ ] Open WhatsApp Business app on `55-517-5553`, update About/Bio to §2.1 recommended text.
- [ ] Update profile name to `Sheli` if different.
- [ ] Screenshot the final Meta Business page (all fields visible).
- [ ] Screenshot the final WhatsApp Business profile.
- [ ] Paste both screenshots below in §4.

---

## 4. Snapshots (post-edit)

_To be filled in by Yaron after applying the edits. This becomes the pre-Cloud-API-launch baseline for future comparison._

### 4.1 Meta Business Manager → Business Info (after edits)

_Paste screenshot or field-by-field summary here._

### 4.2 WhatsApp Business profile on `+972 55-517-5553` (after edits)

_Paste screenshot here._

### 4.3 WhatsApp Business profile on new Cloud API number (after registration in plan Task 19)

_Paste screenshot here when applicable._

---

## 5. When to apply these edits

**Best:** Today/tomorrow, before the Meta reviewer picks up the current verification submission. This avoids review round-trips that would slip the Cloud API end-state timeline.

**Worst case:** If the reviewer has already picked up the submission and some fields are locked, edit what you can now and submit the rest as a post-approval amendment. Description, category, and bio are typically always editable; legal name and business type may be locked during active review.

**Timing note:** This is independent of the `55-517-5553` 24h restriction lift tonight at 18:10 — no need to wait. The Meta Business page edits can happen any time.

---

## 6. Template approval — forward reference

The 6 templates submitted in plan Task 18 (`reminder_fire`, `event_fire`, `welcome_direct`, `welcome_group`, `morning_briefing`, `number_change_notice`) all have bodies in `supabase/functions/_shared/templates.ts` once that file is created (plan Task 6). The `welcome_direct` body was refined in the plan-refinement document — it now includes 4 concrete usage examples and the forward-to-task tip line. Ensure the version pasted into Meta Business Manager → Message Templates matches the refined version, not the original design-doc §6.3 version.
