# Option 1: Cloud API Migration — Design

**Date:** 2026-04-18
**Status:** Approved, ready for implementation planning
**Execution branch:** `option-1-cloud-migration` (to be created)
**Related sessions:** 2026-04-18d (ban recovery), 2026-04-18e (architecture decision brainstorm)

---

## 1. Goal

Migrate Sheli from Whapi-only transport to Meta Cloud API as primary transport, while:

- Preserving the product promise: punctual reminders fire on time.
- Preserving Sheli's warmth in reactive (in-window) conversation.
- Cutting ban-risk exposure under Meta's 2026 "AI Provider" policy by reframing Sheli externally as a **family task coordination utility**, not an AI assistant.
- Adding **forward-to-task** as a flagship compliance-positive feature (user-initiated, deterministic outcome).

## 2. Why now

The 2026-04-18 ban on `55-517-5553` and the same-day competitive research produced three load-bearing findings:

1. **Zapia** (5.5M users, $12M funded, Cloud API + Claude Haiku) was banned Dec 22 2025 under the AI Provider policy despite proper infrastructure. **Cloud API is not a compliance shield**; positioning is.
2. **Boti** (direct Hebrew competitor, same Whapi/linked-device class as Sheli) has run 5 years ban-free on a strictly reactive, no-AI-chat, no-proactive-outbound architecture.
3. Sheli's current shape (Whapi + proactive reminders + AI-flavored personality + "smart helper" framing) combines the worst risk factors of both patterns. The April ban was structurally overdetermined, not bad luck.

Option 1 is the "walk between the drops" path: keep the product, shift infra + framing, accept template discipline for proactive outbound.

## 3. Architecture

**Single bot number on Meta Cloud API** (new phone, registered post-verification).

Two outbound modes, both on the same number:

| Mode | Trigger | Format | Content |
|---|---|---|---|
| Reactive | User message received within last 24h | Free-form text | Sonnet-generated with Sheli's voice. Personality, family memory callbacks, emoji, warmth — all preserved. Identical to today's UX. |
| Proactive | Scheduled job or system-initiated | Pre-approved Utility template | Deterministic text with variables. Warm tone survives in template wording (see §6). |

**Transition period:** current number `55-517-5553` on Whapi serves existing beta users in **reactive-only, Boti-formula mode** during migration (no proactive outbound of any kind). Sunsetted when ≥80% of households migrate.

**End state:** one number, Cloud API only, Whapi retired.

## 4. Positioning — selective edits

Words in/out:

- **Keep:** smart (חכמה), helper (עוזרת), assistant, organizer (מארגנת), family coordination
- **Drop:** AI (בינה מלאכותית), LLM, chatbot, "powered by ChatGPT," anything implying open-ended Q&A

Surfaces to edit:

1. **Meta Business verification description** — highest-leverage single piece of copy. Must read as "family task and list coordination service with WhatsApp interface." Zero AI language.
2. **Landing page body** — audit for "AI/בינה" mentions, swap to "smart" or drop.
3. **Landing page family-memory card** — **replace** with forward-to-task card (copy in §5).
4. **FB launch post template** — rewrite once, reuse.
5. **App store / web manifest descriptions** — same sweep.
6. **Bot WhatsApp business profile bio** — short utility framing.

Taglines "העוזרת החכמה שלכם בווטסאפ" / "Your smart helper on WhatsApp" survive as-is (no "AI" in them).

**Family memory feature stays in the product**, but is externally packaged as "shared family notes" (if mentioned at all). Not a headline feature.

## 5. Feature decisions

| Feature | Decision | Rationale |
|---|---|---|
| Forward-to-task | **ADD (MVP batch)** | User-initiated, deterministic, textbook utility feature. Replaces family-memory card on landing page as flagship demo. Mentioned as a short 💡 line in `welcome_direct` and reactive opening message. |
| Expenses | **KEEP** | Fits "family task utility" framing cleanly (shared expense log). Textbook utility category, not AI-flavored. |
| Family memory | **KEEP, repackaged** | Feature stays; external framing shifts to "shared notes." No marketing as "AI remembers." |
| Proactive reminders (reminder_queue firing) | **KEEP via template** | Core product promise. Delivered via `reminder_fire` template. |
| Morning briefing | **KEEP, template ready** | Future feature, template authored now for Meta approval. |
| Re-engagement nudges | **RETIRE** | Marginal value + highest anti-spam risk pattern. Let users self-engage via web app. |
| Welcome blast to list signups | **RETIRE** | This was the April ban trigger. Users only get `welcome_direct` after they initiate contact via WhatsApp. |
| Recovery queue (post-ban retry) | **RETIRE** | Superseded by Cloud API's reliability + Meta's own retry. |

### Forward-to-task landing page card (replaces family-memory card)

- **HE title:** "העברת הודעות חכמה בלחיצה"
- **HE body:** "לחצו 'העבר' על כל הודעת ווטסאפ עם פרטי פגישה, רשימת קניות או תזכורת - ואני אוסיף אוטומטית."
- **EN title:** "Smart message forwarding"
- **EN body:** "Forward any WhatsApp message - meeting details, a shopping list, a reminder - Sheli turns it into a task automatically."
- **Icon:** forward/arrow-in (new SVG needed in `Icons.jsx`).

## 6. Template library (Hebrew, final, for Meta approval)

All templates submitted as **Utility category** in Hebrew (primary) + English (secondary for future non-IL expansion).

### 6.1 `reminder_fire` — scheduled reminder firing
```
⏰ היי, תזכורת: {{1}}
```
**Variable:** `{{1}}` = reminder text

### 6.2 `event_fire` — upcoming event reminder
```
📅 בעוד {{1}}: {{2}}
```
**Variables:** `{{1}}` = time delta ("שעה", "30 דק'", "רבע שעה"), `{{2}}` = event title
**Example render:** `📅 בעוד שעה: פגישה עם רינה`

### 6.3 `welcome_direct` — 1:1 first contact from bot (proactive bridge)
```
היי {{1}}! אני שלי, נעים מאד! 🧡

כתבו לי מה צריך לקנות, מה להזכיר לכם ואיזה מטלות יש לכם - ואני אסדר הכל.

💡 אפשר גם להעביר אליי כל הודעת ווטסאפ ואוסיף למשימות.

רוצים את כל המשפחה? הוסיפו אותי לווטסאפ המשפחתי ואסדר הכל לכולם
```
**Variable:** `{{1}}` = Hebrewized first name (via `hebrewizeName` map)

### 6.4 `welcome_group` — bot added to new group
```
שלום לכולם! אני שלי, נעים מאד! 🧡

כתבו לי מה צריך לקנות, מה להזכיר לכם ואיזה מטלות יש לכם - ואני אסדר הכל למשפחה.

לצפייה ברשימות: sheli.ai
```
**No variables** — static body.

### 6.5 `morning_briefing` — daily briefing (template ready, feature future)
```
בוקר טוב! מה להיום: {{1}}.
```
**Variable:** `{{1}}` = summary string ("3 מטלות ופגישה אחת")
**Firing rules:** Skip Shabbat + quiet hours at scheduler level.

### 6.6 `number_change_notice` — migration comms
```
היי זאת שלי! עברתי למספר חדש: {{1}}.

שמרו את המספר והוסיפו לקבוצת הווטסאפ המשפחתית במקום הישן.
```
**Variable:** `{{1}}` = new phone number (formatted)
**Usage:** Only sent to users who re-engage with old number during transition window. Never blasted cold.

### Template policy
- All templates immutable once approved. Revisions = new template with new ID, new 24-72h approval window.
- Initial submission batch: all 6 templates submitted simultaneously to parallelize approval.
- Fallback: if any template rejected, refine copy and resubmit. Migration proceeds on approved templates.

## 7. Opening message (reactive, in-window, free-form)

When a user lands via landing page CTA (`wa.me/972...?text=היי%20שלי!`) and sends the pre-filled message, they open the 24h customer-service window. Reply is free-form, not a template. Use deterministic text matching `welcome_direct` voice (minus the name variable, since cold contacts have no name yet):

```
היי! אני שלי, נעים מאד! 🧡

כתבו לי מה צריך לקנות, מה להזכיר לכם ואיזה מטלות יש לכם - ואני אסדר הכל.

💡 אפשר גם להעביר אליי כל הודעת ווטסאפ ואוסיף למשימות.

רוצים את כל המשפחה? הוסיפו אותי לווטסאפ המשפחתי ואסדר הכל לכולם
```

## 8. Long-list response pattern — deterministic, not Sonnet

Replaces today's Sonnet prose generation for "תן לי את כל המטלות / הקניות / ההוצאות" queries.

| Item count | Format |
|---|---|
| ≤5 | Full list inline, Sheli voice preserved. `"יש לכם 3 מטלות: ..."` |
| 6–10 | Full list, line-broken bullets. |
| >10 | Top 5 by priority + web link. `"יש לכם 23 מטלות. הנה 5 הדחופות: ...\n\nהרשימה המלאה: sheli.ai/tasks"` |

Priority order:
- **Tasks:** due date ascending (oldest overdue first)
- **Shopping:** most recently added
- **Events:** chronological upcoming
- **Expenses:** never dump in chat — always web link, regardless of count (money audit trail + multi-currency would be confusing inline)

Implementation: new module `_shared/list-renderer.ts`, deterministic formatting, no LLM call. Called from both group + 1:1 reactive paths.

## 9. Forward-to-task design

**Detection:** inbound Whapi payload currently includes `context` object with forwarding metadata; Cloud API payload has `forwarded: true` flag on message object. Webhook handler checks both.

**Flow:**
1. Incoming message with forward flag → skip Haiku intent classification (deterministic route).
2. Forwarded body sent to Haiku with specialized prompt: "Extract task title, optional due date/time, optional category. Return JSON."
3. Action executor creates `task` row with:
   - `title` = Haiku extracted title (fallback: first 80 chars of forward)
   - `due_date` = parsed if present
   - `source = 'forward'`
   - `source_message_id` = message ID of original forward
   - `notes` = full forwarded body (for user reference)
4. In-window free-form confirmation: `"הוספתי מההודעה ששלחת: {{title}} ✅"`

**Edge cases:**
- Long forwards (>500 chars): truncate to first 500 for classifier, store full body in notes field.
- Media forwards (image/voice/PDF): MVP handles text forwards only. Media forwards reply `"אני עוד לא יודעת לקרוא תמונות - שלחו לי את הפרטים כטקסט ואוסיף."`
- Multi-task forwards ("1. X 2. Y 3. Z"): MVP creates one task with the full text; Haiku splitting deferred to post-MVP.

## 10. Infrastructure changes

### New files
- `supabase/functions/_shared/cloud-api-provider.ts` — mirrors existing `whatsapp-provider.ts` interface, implements Meta Cloud API `sendMessage` + `sendTemplate`.
- `supabase/functions/_shared/templates.ts` — typed registry of approved template IDs + variable shapes. Wrong variable count = compile error.
- `supabase/functions/_shared/list-renderer.ts` — deterministic list formatting with cap + web link.
- `supabase/functions/_shared/forward-handler.ts` — forward detection + task extraction.
- `src/components/Icons.jsx` — add `ForwardIcon` SVG.

### Modified files
- `supabase/functions/whatsapp-webhook/index.inlined.ts` — provider selection at top (Cloud API for new-number cohort, Whapi for legacy), forward detection in webhook handler, list-renderer integration for long-list queries.
- Reminder firing function (`reminder_queue` pg_cron) — switches from Sonnet prose generation to `sendTemplate('reminder_fire', { reminderText })`.
- `outbound_queue` table — add `template_id TEXT` and `template_variables JSONB` columns. Drain function chooses Whapi or Cloud API based on recipient cohort.
- `src/components/LandingPage.jsx` — replace family-memory card with forward-to-task card. Audit body copy for "AI/בינה" language.

### Retired code paths
- `generateNudgeMessage` and associated pg_cron nudge job.
- Welcome blast drain logic (welcomes now only sent in response to user-initiated contact).
- Recovery queue retry daemon.

### Schema changes
```sql
ALTER TABLE outbound_queue ADD COLUMN template_id TEXT;
ALTER TABLE outbound_queue ADD COLUMN template_variables JSONB;
ALTER TABLE outbound_queue ADD COLUMN transport TEXT DEFAULT 'whapi' CHECK (transport IN ('whapi', 'cloud_api'));

ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'chat';
-- source values: 'chat', 'forward', 'web', 'voice'
ALTER TABLE tasks ADD COLUMN source_message_id TEXT;
```

### Unchanged
- Haiku classifier + prompts (modulo forward-bypass)
- Sonnet reply generator (reactive in-window only)
- All V2 DB schema for tasks/shopping/events/expenses/reminders
- Web app, auth, expenses pipeline, family memory pipeline, learning system

## 11. Migration sequence (compressed ~3-4 weeks)

| Phase | Duration | Actions |
|---|---|---|
| **0. Positioning pre-work** | Days 0–2 | Ship landing-page edits (forward-to-task card, AI-language sweep). Meta Business verification blurb rewritten. Whapi `55-517-5553` locked to reactive-only Boti formula. |
| **1. Template authoring** | Days 2–3 | All 6 templates submitted simultaneously for Meta approval. |
| **2. Infra build (parallel to approval)** | Days 2–7 | `CloudApiProvider`, `templates.ts`, `list-renderer.ts`, forward handler built + tested in staging. Branch: `option-1-cloud-migration`. |
| **3. New number + Cloud API setup** | Days 5–7 | Acquire new phone, register with Cloud API, complete business verification. |
| **4. Template approval + staging validation** | Days 3–8 | Meta approves templates (24–72h each). Staging send tests for each template. |
| **5. Cutover: new-user onboarding → Cloud API** | Day 8 | Landing page CTA points to new number. Existing users still on legacy Whapi. |
| **6. Group migration comms** | Days 8–18 | Manually post `number_change_notice` (as free-form in each beta family group since bot is a group member and inside conversation). One family per day. Add new number to each group. |
| **7. Whapi sunset** | Days 18–28 | Whapi `55-517-5553` outbound disabled completely. Kept passively receiving for any stragglers, forwarding them to new number. |
| **8. Full decommission** | Day 28+ | Whapi subscription cancelled when ≥80% migrated. |

## 12. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Meta template rejection | All templates Utility-category + informational. If rejected, refine copy (not structure) and resubmit. Migration proceeds on approved subset; missing templates block only their specific feature. |
| Meta Business verification delayed | Current submission blocked on phone restriction. Once restriction lifts, verification historically clears in 3–5 business days. Timeline assumes this holds. |
| Beta users don't migrate to new number | Accept churn on inactive users. For active users in groups, in-group manual announcement catches them inside a conversation context (no proactive cold outreach). Historical group retention > 70%. |
| Second ban on new number | Lower risk because: (a) positioning shift removes AI-Provider framing, (b) templated proactive + in-window reactive avoids anti-spam patterns, (c) no welcome-blast ever again. If it still happens, fall back to Boti formula permanently. |
| In-window free-form replies still flagged as "AI chat" | Mitigations: no self-positioning as AI, bot profile framed as utility, reactive replies always tied to user action (confirmation, list response, question about household state). |
| Template immutability bites us | Each template wording reviewed by user before submission (this doc). Any production learning after approval = new template ID with incremented suffix (`reminder_fire_v2`). |
| Whapi number carries users who never migrate | Keep it alive in reactive-only mode beyond 28 days if needed. Mid-term (3–6 months) forward incoming messages to new number via a short deterministic reply: `"עברתי למספר {{new}}. כתבו לי שם 🧡"`. |

## 13. Testing

- **Integration tests (`test_webhook.py`):** extend fixtures to include `forwarded: true` payloads. Add cases for each new intent/surface. Update transport assertions to assert Cloud API calls in cutover cohort.
- **Template send tests:** dedicated script `tests/test_templates.py` sends each template to a test number in staging, verifies rendered output.
- **List renderer unit tests:** count boundaries (5, 6, 10, 11), priority ordering per item type, web link formatting.
- **Forward handler tests:** clean text forward, long text forward (>500), media forward, multi-line list forward.
- **Parity test:** same input message through both Whapi and Cloud API providers → same user-visible outcome (modulo template vs free-form for proactive).

## 14. Execution branch

- Branch: `option-1-cloud-migration` off `main`.
- All code, schema migrations, landing page edits live on branch until cutover.
- Staged merges:
  - Landing page + positioning edits merge first (can ship independently of infra).
  - Infra (CloudApiProvider, templates, list-renderer, forward handler) merges before new number goes live.
  - Cutover flip (provider selection logic) merges at Day 8.
  - Whapi deprecation + code removal merges at Day 28+.
- Design doc lives on `main` in `docs/plans/`.

## 15. Success criteria

- All 6 templates approved by Meta.
- New Cloud API number verified and live.
- Zero proactive outbound from Whapi for 14 consecutive days before sunset.
- ≥80% of beta households message the new number at least once.
- Zero second-ban events during and after migration.
- Reminder-firing success rate on new number ≥95% (matches current Whapi baseline).
- Forward-to-task extraction accuracy ≥85% on a 20-case Hebrew fixture set.

## 16. Open questions / future work

- **Forward-to-task for media:** images, voice, PDF. Deferred to post-MVP.
- **Multi-task forward splitting:** Haiku can split "1. X 2. Y 3. Z" into separate tasks. Deferred.
- **Morning briefing feature:** template ready, feature (content generation + send scheduling) builds later.
- **Non-IL expansion:** English template versions submitted in parallel but not activated; activated when expansion warrants.
- **Expense query templates:** if we ever need proactive expense summaries (e.g., weekly), a `weekly_expense_summary` template is future work.
