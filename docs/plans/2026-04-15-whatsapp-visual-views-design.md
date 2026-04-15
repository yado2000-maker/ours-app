# Design: Visual Data Views in WhatsApp ("השבוע" + companion views)

**Date:** 2026-04-15
**Status:** Approved (brainstorm). Ready for implementation plan.
**Target location once plan mode exits:** `docs/plans/2026-04-15-whatsapp-visual-views-design.md`

---

## Context

Users have to leave WhatsApp and click through to `sheli.ai` to see their data in any structured form. The bot's existing `question` intent answers inline via Sonnet ([supabase/functions/whatsapp-webhook/index.inlined.ts:920](supabase/functions/whatsapp-webhook/index.inlined.ts:920)) but its output is conversational prose with a trailing URL suggestion — not a scannable view. The result: users default to the web app for anything organized, which contradicts the WhatsApp-first product thesis.

We ship four visual data views that live natively inside WhatsApp, plus a proactive Sunday-morning digest for the primary view. Users get scannable structured information without opening a browser, and Sheli gains a weekly "setting the tone" moment that converts her from reactive assistant to proactive family partner.

## Goals

1. Let users see household data inside WhatsApp in scannable visual form — zero click-through.
2. Preserve Sheli's warm assistant tone (not a dashboard).
3. Be proactive once a week (Sunday 07:30 Israel time) so planning isn't user-initiated.
4. Gracefully degrade when content is sparse — never send an empty-looking digest.
5. Cost no more per message than the current classifier path.

## Non-goals

- Replace the web app (it still owns editing, month view, deep retrospectives).
- Build a general WhatsApp dashboard. We ship four specific views, not interactive UI.
- Interactive Cloud-API elements (buttons, list messages). Not on Whapi; revisit at Meta migration.
- Additional proactive pushes (Thursday mid-week etc.). Start with Sunday only.

---

## The four views (v1)

| View | Headline | Primary trigger phrases | Format | Proactive | Audience default |
|------|----------|------------------------|--------|-----------|------------------|
| Forward weekly | `השבוע` | "השבוע", "סיכום השבוע", "איך נראה השבוע", "מה יש לנו השבוע", "מה קורה השבוע", "אפשר לראות את הלו"ז", "איפה רשימת המשימות", "תני לי את רשימת התזכורות", "calendar", "week" | **Hybrid text/image** per threshold | ✅ Sunday 07:30 | Group → household • 1:1 → personal |
| Retrospective | `שבוע שעבר` | "מה עשינו", "מי עשה מה", "השבוע שעבר" | Text only | ❌ | Same as above |
| Shopping | `קניות` | "קניות", "רשימת קניות", "מה בקניות" | Text only (emoji per item, grouped by category) | ❌ | Shared (one list household-wide) |
| Today | `היום` | "היום", "מה היום", "what's today" | Text only (3-5 lines) | ❌ | Same as weekly |

**Naming rule (applies to all views):** no possessive pronouns in headlines. "השבוע" not "השבוע שלנו", "קניות" not "רשימת הקניות שלנו". The group context already scopes ownership.

---

## השבוע — deep specification

### Content

Included:
- **Events**: `events` rows where `scheduled_for` is inside the time-horizon window.
- **Open tasks**: `tasks` where `done = false` and `due_at` is inside the window. Undated tasks go in a "📌 ללא תאריך" bucket at the bottom (cap 5, then "ועוד X").
- **Rotations**: current rotation holder per day, inlined with the day's items. Today's rotation gets a `← היום` marker.

Excluded:
- Completed items (past events, done tasks) — these are the retrospective view's job.
- Shopping (own view).
- Reminders (internal mechanism; weekly items already include any with dates).
- Family memories.

Per-day overflow cap: **7 items**, then "ועוד X ביום [name]".
Days with zero items are omitted entirely (no empty "שלישי" rows).

### Content threshold ladder

Count = events + open tasks with dates in window + undated open tasks. Rotations don't count toward threshold (they always appear if a household has any).

| Open items | Sunday push | On-demand reply |
|------------|-------------|-----------------|
| 0-2 | ⛔ Skip silently (no message sent) | One-line inline text, no structured view (example: "שבוע רגוע — רק כביסה ביום ראשון 😌") |
| 3-7 | 📝 Text digest | Structured text |
| 8+ | 🖼️ Image + short text caption "📅 השבוע" | Structured image |

**New-household override** (founder joined < 14 days ago): minimum 5 items for Sunday push. Below 5 in first two weeks, push is skipped silently. First impressions matter more than habit formation.

### Time horizon

Computed from current Israel time at query time. Constant `WEEK_FLIP_SATURDAY_HOUR = 17`.

| Window on … | Shows |
|-------------|-------|
| Sunday–Thursday (any time) | Today → Saturday 23:59 (this week) |
| Friday (all day) | Friday + Saturday + "ושבוע הבא" peek (Sun–Tue of next week) |
| Saturday 00:00–16:59 | Saturday + "ושבוע הבא" peek |
| Saturday 17:00–23:59 | Pivot entirely: next Sun–Sat (full next week) |

The Sunday 07:30 push always lands Sunday, so it always runs in "full fresh week" mode (Sun-Sat).

### Audience scope

Default behavior (the "context-aware" rule):
- **Group chat**: household view — all members' events + tasks, each line labeled with assignee.
- **1:1 chat**: personal view — only events/tasks where `assigned_to = sender` + sender's rotations. Plus "📌 לא משובץ" section (capped 5, neutral listing, no claim-pressure language — these are household facts, not assignments-in-waiting).

Phrase override (works in both chat types):
- "השבוע שלי" / "מה לי השבוע" → `filter_scope: "personal"`.
- "השבוע של אמא" / "מה לאמא השבוע" → `filter_scope: "personal", filter_person: "אמא"`.

Ambiguity path: when Haiku confidence on `filter_scope` is < 0.7, escalate to Sonnet to ask ("רוצים השבוע של כולם או שלך?"). Rare. ~$0.01 per ambiguity.

### Text layout (reference rendering)

```
📅 השבוע

ראשון 20/4
  🧺 כביסה — אמא
  🍽️ תורנות כלים — גילעד   ← היום
  09:00 ישיבה — אמא

שני 21/4
  18:00 אימון — אבא
  🍳 הכנת ארוחת שישי — אמא

רביעי 23/4
  14:00 שיעור גיטרה — אביב
  🛒 ארגון מקרר — גילעד

חמישי 24/4
  19:00 הורים-מורים — אבא

📌 ללא תאריך:
  • לתאם טכנאי — אבא
  • להזמין ספרים — אמא
```

### Image visual brief

- **Palette** (design system v2, [docs/plans/2026-04-06-design-system.md]()): coral `#E8725C` for date badges, forest green `#2AB673` for rotations/today markers, teal-gray `#1E2D2D` for text, warm white `#FAFCFB` background, light gray `#E5EAE8` for day separators.
- **Typography**: Heebo 600 for day headers, Heebo 400 for items, Nunito 700 for the English "sheli" footer. Fonts embedded in the Vercel route at build time.
- **Dimensions**: 1080 × 1536 px (portrait, WhatsApp-native). Margins 48 px, day-gutter 12 px.
- **Layout**: single column, days stacked vertically. Each day = pill-shaped coral date badge, then items bulleted below. Today's day gets a green "היום" pill on the right.
- **Personal labels**: " — גילעד" in 70% opacity teal-gray, smaller font, right-aligned inside each item row.
- **Rotations**: icon (🍽️, 🚿, etc.) + green text, visually distinct from tasks.
- **Footer**: centered `sheli` wordmark (small, 60% opacity) + household name. **No URL**, no "open in app" CTA — the image *is* the view.
- **Empty-day handling**: days with 0 items omitted entirely.
- **RTL critical**: root container `direction: rtl`; Hebrew text right-to-left; dates ("20/4") render LTR inline via explicit Unicode bidi. QA checkpoint: no mirrored glyphs, numbers render correctly inside Hebrew phrases.

---

## Architecture (Approach B: hybrid bot + Vercel render)

### Classifier changes

Extend Haiku prompt in `supabase/functions/_shared/haiku-classifier.ts` with two new intents:

```ts
// show_view — routes to deterministic formatter, no Sonnet call
intent: "show_view"
entities: {
  view_type: "weekly" | "retrospective" | "shopping" | "today",
  filter_scope: "personal" | "household" | null,  // null → context-aware default
  filter_person: string | null,                   // member name when explicitly filtered
}

// view_feedback — feedback/complaint on a just-sent view, escalates to Sonnet with view context
intent: "view_feedback"
entities: {
  // none — Sonnet reads last-sent view from household state
}

// opt_out_digest / opt_in_digest — toggles weekly_digest_enabled flag
intent: "opt_out_digest" | "opt_in_digest"
```

Seed phrases added for `show_view: weekly`: סיכום השבוע, איך נראה השבוע, מה יש לנו השבוע, מה קורה השבוע, אפשר לראות את הלו"ז, איפה רשימת המשימות, תני לי את רשימת התזכורות, השבוע, calendar, week, what's this week.

Seed phrases added for `view_feedback`: "התקציר לא נכון", "חסר לי משהו", "למה אין את X", "רוצה לראות גם Y", "זה מבלבל", "לא טוב".

**Cost impact**: ~5 extra tokens per classification ≈ $0.00003 per message. Net cost DOWN vs current `question` path, because `show_view` is templated (no Sonnet call) and `question` always invokes Sonnet.

### Data queries

New file `supabase/functions/_shared/view-data.ts` with four helpers:

```
fetchWeeklyView(householdId, filterScope, filterPerson, now)
  → { days: [{ date, items: [...], rotation: Rotation | null }], undated: Task[], meta: { total, horizonKind } }

fetchRetrospectiveView(householdId, filterScope, filterPerson, now)
  → { completedTasks: Task[], purchasedShopping: ShoppingItem[], windowStart, windowEnd }

fetchShoppingView(householdId)
  → { byCategory: Array<{ category: string, items: ShoppingItem[] }>, total: number }

fetchTodayView(householdId, filterScope, filterPerson, now)
  → { events: Event[], tasks: Task[], rotationToday: Rotation | null }
```

All queries run as service-role, filter by `household_id` (FK cascade already ensures isolation). Time-horizon math (including Fri/Sat 17:00 pivot) lives inside `fetchWeeklyView`.

### Text formatters

New file `supabase/functions/_shared/view-formatters.ts` with four pure functions, one per view. Deterministic, unit-testable. Each takes the query output + sender context and returns a string ready for `provider.sendMessage`.

### Image rendering

New Vercel route: `api/weekly-image.js`
- Uses `@vercel/og` (Satori underneath).
- Edge runtime (cold start budget < 500 ms).
- Auth: service-role JWT (Supabase) validated server-side.
- Request body: `{ household_id, as_of_date, filter_scope, filter_person }`. No raw data over the wire — endpoint queries Supabase itself.
- Response: PNG buffer, 1080×1536.
- Fonts: Nunito + Heebo embedded at build time via cached `fetch` with `next: { revalidate: 31536000 }`.

Provider extension: new method `sendImage(to, imageBase64, caption)` in [supabase/functions/_shared/whatsapp-provider.ts](supabase/functions/_shared/whatsapp-provider.ts), posts to Whapi `/messages/image` with base64 body. No public URL. Nothing persisted image-side.

### Sunday push pipeline

Reuses the existing pg_cron pattern used for reminders.

1. **New table** `weekly_digest_queue`:
   ```sql
   CREATE TABLE weekly_digest_queue (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     household_id UUID REFERENCES households_v2(id) ON DELETE CASCADE,
     scheduled_for TIMESTAMPTZ NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, skipped, failed
     skip_reason TEXT,                         -- below_threshold, opted_out, inactive_household, send_failed
     item_count INT,                           -- for observability
     sent_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
2. **Cron job** (pg_cron, Sunday 07:00 Israel time) enqueues one row per household where `weekly_digest_enabled = true` AND `bot_active = true`.
3. **Worker** (Edge Function, runs every 5 min, picks up pending rows where `scheduled_for <= now()`): for each, call `fetchWeeklyView` → apply threshold ladder → send image/text/skip → write `sent_at` or `skip_reason`.

### Opt-out mechanism

- New column on `households_v2`: `weekly_digest_enabled BOOLEAN DEFAULT TRUE`.
- Classifier catches opt-out phrases → `opt_out_digest` intent → toggles flag → Sheli confirms: "בסדר, לא אשלח תקציר שבועי. תמיד אפשר לשאול 'השבוע' ואראה לכם."
- Opt-back-in phrases → `opt_in_digest` → flag true → confirm.

### View feedback handler

When `view_feedback` classifies, the router:

1. Reads `whatsapp_config.last_view_sent_*` (new columns: `last_view_type`, `last_view_sent_at`, `last_view_content_hash`, `last_view_item_count`, `last_view_scope`).
2. Passes to Sonnet with prompt approximately:
   > YOU SENT [weekly view, 20min ago, 12 items, household scope].
   > USER NOW SAYS: '[message]'.
   >
   > Respond warmly. Pick ONE of three paths:
   > **(a) Re-render** — if you clearly understand a tweak they want (different scope, missing item type, different time window). Emit `<!--RERENDER:{"view_type":"weekly","filter_scope":"personal",...}-->` tail block; the router re-calls fetch + send.
   > **(b) Clarify** — if the request is ambiguous but you can imagine what they might want. Ask one short warm clarifying question.
   > **(c) Escalate to founder** — if you genuinely can't tell what they want, OR the request is beyond what a re-render can fix (bug report, missing feature, data looks wrong, angry tone). Reply warmly: "בדיוק עכשיו אני לא בטוחה — אני אבדוק עם ירון ואחזור אליכם 🙏" (or English equivalent). Emit `<!--FLAG_FOR_FOUNDER:{"reason":"...","severity":"low|medium|high"}-->` tail block; the router writes to the review queue.

3. Sonnet outputs exactly one path. Router parses the tail block:
   - `RERENDER` → call `fetchWeeklyView(...)` with new params → send new view (text or image per threshold).
   - `FLAG_FOR_FOUNDER` → insert row into `view_feedback_review` queue (new table).
   - No tail block → clarify-only path; nothing further.

4. **Review queue**: new table `view_feedback_review` (`household_id`, `sender_phone`, `user_message`, `last_view_type`, `last_view_content_hash`, `sonnet_reason`, `severity`, `reviewed_at`, `resolved_at`, `notes`). Surfaced in admin dashboard — Yaron sees counts, severity, and message content. One-click "reply to family" action that sends a bot message on Yaron's behalf ("ירון חזר אליך בקשר ל…"), optionally with a fix summary.

5. **SLA target**: high-severity flags surface in admin dashboard within 5 minutes of classification; low/medium surface within the next daily email digest (out of scope for v1 — v1 ships just the dashboard surface, email digest can follow).

The three-path design means Sheli never gaslights a user ("I fixed it!" when she didn't) and never stonewalls them ("I can't help with that"). Every feedback gets a warm response, and genuine problems reach Yaron without the user having to know they did.

### Admin observability

Extend admin dashboard with two new sections in [src/components/AdminDashboard.jsx](src/components/AdminDashboard.jsx):

**"Weekly digest" section:**
- Last Sunday's sent / skipped / failed counts.
- Skip reasons breakdown (below_threshold, opted_out, inactive, send_failed).
- Sunday-over-Sunday trend chart.
- Opt-out rate (new column + existing `weekly_digest_enabled`).
- Per-household preview button (calls `api/weekly-image.js` with household override).

**"View feedback queue" section (founder-flag inbox):**
- Unresolved flags sorted by severity, newest first.
- Each row shows: household name, sender phone, user message, last-view metadata (type + timestamp + item count + scope), Sonnet's reason string.
- Actions per row:
  - "Reply to family" — sends a bot message on Yaron's behalf with prefix "ירון חזר אליך בקשר ל...".
  - "Mark resolved" — closes the flag with optional notes.
  - "Preview the view they saw" — re-renders the exact view that was sent (via `last_view_content_hash` snapshot if we persist content, or best-effort via `last_view_type + last_view_sent_at`).
- Counts: open flags, resolved this week, avg time-to-resolve.

---

## Rollout phases

Each phase independently shippable.

**Phase 1 — Text foundation (3-4 days)**
1. Classifier extended with `show_view`, `view_feedback`, `opt_out_digest`, `opt_in_digest` + seed phrases.
2. `view-data.ts` with `fetchAllEvents(householdId, window)` helper (source-abstraction seam — see Forward Compatibility section) **plus** four view fetchers that consume it.
3. `view-formatters.ts` with four text formatters. Each accepts an abstract `Event` shape and branches on `visibility` (`public` / `busy` / `private`) — v1 only emits `public`, but the branches exist.
4. Router wiring in `index.inlined.ts` — `show_view` → fetch → format → send; `view_feedback` → Sonnet escalation with three-path response; opt-out → toggle + confirm.
5. `households_v2.weekly_digest_enabled` column + migration.
6. `whatsapp_config.last_view_*` columns for feedback context.
7. `view_feedback_review` table + admin dashboard feedback-queue surface.

**Phase 2 — Sunday push (text only) (1-2 days)**
7. `weekly_digest_queue` table + pg_cron schedule.
8. Worker that fetches + formats + sends text at tiers 3-7 (skips silently at 0-2, text at 3+ regardless of 8+ image tier for now).
9. End-to-end test with staging household.

**Phase 3 — Image rendering (3-4 days)**
10. Vercel `api/weekly-image.js` with `@vercel/og` + embedded fonts.
11. `sendImage` method in `whatsapp-provider.ts`.
12. Threshold ladder upgrade: tier 8+ routes to image, fallback to text if image send fails.
13. RTL QA: render on 3 real households with varied content density.

**Phase 4 — Admin observability + polish (1 day)**
14. Admin dashboard Weekly-digest section.
15. Per-household preview endpoint.
16. First production Sunday push to beta families (all 5 or a subset).

**Total estimate: 8-11 days** of implementation work across phases.

---

## Verification / test plan

**Unit tests** (new `tests/view_data_test.py` via Supabase test client):
- `fetchWeeklyView` horizon math for each day-of-week + boundary times (Friday any hour, Saturday 16:59, Saturday 17:00).
- Personal filter returns zero items from other members.
- Unassigned tasks appear only in personal 1:1 view, capped at 5.
- Rotation appears exactly once per week, current holder correct.
- Threshold counts: events + dated tasks + undated tasks summed correctly.

**Integration tests** (extend [tests/test_webhook.py](tests/test_webhook.py)):
- Each `show_view` trigger phrase classifies to correct intent + view_type.
- Group message in multi-member household returns household-scoped response.
- 1:1 message returns personal-scoped response.
- "השבוע שלי" from group returns personal-filtered (override works).
- 0-item week in 1:1 returns one-line inline reply, not structured view.
- Opt-out flips flag; next Sunday dry-run shows household skipped with `opted_out`.
- `view_feedback` triggers Sonnet; mock Sonnet verifies last-view context is injected.

**Manual QA**:
- Render `api/weekly-image.js` in preview deploy with 3 content densities (3 items, 8 items, 20+ items). Visually verify RTL, overflow, day-omission, today marker, rotation styling.
- Whapi image send succeeds on a test WhatsApp group.
- Sunday push dry-run at 07:30 on 2 beta households — verify image arrives, text caption right, no duplicate sends.

**Dogfood window**: run Phase 1-3 on the founder's personal household for one full week before wider beta rollout.

---

## Telemetry / success criteria (2 weeks post-launch)

| Metric | Target | Interpretation |
|--------|--------|----------------|
| `show_view` calls per household per week | ≥ 3 | Users actually use the views |
| `show_view: weekly` image render share | ≥ 40% of `show_view: weekly` triggers | Households have enough content for image tier |
| Sunday push opt-out rate | ≤ 10% | Not feeling spammy |
| Image send success rate | ≥ 98% | Whapi + Vercel pipeline stable |
| `filter_scope` ambiguity rate (Sonnet asks) | ≤ 20% of weekly calls | Default routing is correctly guessing intent |
| Web-app visits within 2 hours of a `show_view` call | flat or down | Views are replacing URL click-through |
| `view_feedback` intent rate | ≤ 5% of `show_view` calls | Views mostly land right the first time |
| `view_feedback` → re-render path share | ≥ 60% of feedbacks | Sonnet understands most tweak requests |
| `view_feedback` → founder-flag path share | ≤ 15% of feedbacks | Genuine issues are rare; most requests are tweaks |
| Median time founder-flag → resolution (replied or fixed) | ≤ 24h | Review queue isn't a black hole |

Breakdown by view_type in admin dashboard so we learn which views are most used.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Image layout breaks on long Hebrew names | Auto-truncate at 20 chars with "…" in formatter layer (shared by text + image) |
| Satori missing CSS features we want | Accept constraint up front; design to Satori's subset |
| Whapi image send fails (rate/media restrictions) | Fall back to text version of same view; never silent-fail |
| Sunday push feels repetitive for households with mostly recurring items | Phase 4 consideration: vary intro caption. Accepted for v1. |
| `@vercel/og` cold start > 3s | Edge runtime + font preload; if still slow, precompute at 07:25 for all households, cache 10 min |
| Users in both a group and 1:1 with Sheli get duplicate Sunday pushes | Rule: push goes to household's `primary_chat_id` only (group if one exists, else 1:1). One push per `households_v2.id`. |
| Personal 1:1 view leaks others' data (bug) | Explicit unit tests on `fetchWeeklyView(filterScope="personal", filterPerson="X")` asserting no other-person rows |
| Opt-outs look like churn in metrics | Track `weekly_digest_enabled=false` separately from `bot_active=false`; opt-out keeps household active |
| Classifier misroutes "רשימת המשימות" / "רשימת התזכורות" to weekly when user wanted all-tasks view | Watch `classification_data` + `view_feedback` corrections; if frequent, add `show_view: all_tasks` in v2 |
| Stale `assigned_to` (member removed, task still references name) | Formatters replace stale names with "לא משובץ" label; also surfaced via admin preview |

---

## Forward compatibility: Google Calendar (Phase 3 roadmap)

GCal integration is committed (see `Submit Google OAuth consent screen for review` in CLAUDE.md TODOs) but not in this v1. However, the view design must be GCal-ready so we don't rewrite `fetchWeeklyView` when it ships. The following assumptions are baked in:

### Source abstraction (design-level, not implementation in v1)

The view layer conceptually treats events as coming from a **unified "event sources" layer**, not the `events` table directly. In v1, that layer is a thin wrapper returning only `events` rows. In Phase 3, the same wrapper also returns GCal rows.

Concretely:
- `fetchWeeklyView` calls an internal `fetchAllEvents(householdId, window)` helper (even in v1) rather than querying `events` directly.
- In v1, `fetchAllEvents` is literally `SELECT * FROM events WHERE household_id = $1 AND scheduled_for BETWEEN ...`.
- In Phase 3, `fetchAllEvents` is extended to also query `gcal_events` (new table, to be designed later) and merge+dedup by `external_id`.
- No schema assumptions in the formatter/image layer about where an event came from.

### Event fields that will need to evolve

The `events` table (v1) should be considered the ancestor of a future unified shape. Planning now for Phase 3 shape:

```
Event {
  id, household_id, title, scheduled_for, duration_minutes,
  assigned_to,                 // member display_name or null
  source,                      // "sheli" | "gcal" (v1: always "sheli")
  external_id,                 // null in v1; GCal event ID in Phase 3
  external_calendar_id,        // null in v1; which GCal calendar it came from
  visibility,                  // "public" | "busy" | "private" (v1: always "public")
  is_recurring_instance,       // false in v1; true for GCal-expanded occurrences
  recurring_parent_id,         // null in v1
}
```

**v1 action**: we don't add these columns yet (YAGNI). But the `fetchAllEvents` layer returns rows that *could* carry them. Formatter code uses only the fields it needs, doesn't assume absence of others.

### Privacy/visibility — the interesting Phase 3 decision

When GCal events arrive, some are work meetings or private appointments. The view shouldn't leak details by default. Three visibility tiers:

- **`public`**: shown with title ("09:00 ישיבה — אמא"). All v1 native events are public.
- **`busy`**: shown without title ("09:00–10:00 עסוקה — אמא"). Respects the member's calendar setting that marked it "private to others." Still counts toward threshold.
- **`private`**: hidden entirely from household view; shown to the event owner only in 1:1 personal view.

Phase 3 will need to define default mappings from GCal's `visibility` + `transparency` fields to these three tiers.

### Dedup strategy (when GCal arrives)

A task that Sheli pushes to a user's GCal (future feature) might flow back as a GCal event. Dedup rule: if a `gcal_events` row has an `external_id` that matches a `sheli_events.gcal_synced_id`, prefer the `gcal_events` version (freshest from Google); mark the `sheli_events` row as synced.

### Recurring events

GCal recurring series are materialized into individual occurrences inside the time-horizon window. `fetchAllEvents` handles expansion; formatters receive flat rows.

### Connection scope

GCal connection is per-user (OAuth token per member), not per-household. The view must know which members are connected:
- In **group view**: shows connected members' public/busy events. Non-connected members show only their Sheli-native events.
- In **1:1 personal view**: shows only the sender's events (public + busy + private, since it's their own private context).

### Threshold impact

Busy-only events count toward the 3/8 threshold (they consume calendar real estate). Private events do *not* count in group view (they're hidden there). This could make threshold counts unstable across scopes; the per-scope count is computed per-query.

### Future views enabled by GCal (v2+ — not in this design)

- "מתי אנחנו פנויים?" — cross-member free/busy intersection.
- "יש התנגשות ביום חמישי" — proactive conflict detection.
- "אמא עסוקה עד 14:00" — today view enhancement with busy blocks.

These are explicitly out of scope for v1 but the source abstraction makes them additive, not disruptive.

### Concrete v1 design changes to accommodate this

1. **Create `fetchAllEvents(householdId, window)` helper** in `view-data.ts` even though it's just a thin `events` query. All four view-data fetchers use it. Non-negotiable — this is the source-abstraction seam.
2. **Formatters must not reference `events.title` directly.** They take an `Event` shape and render. If `visibility === "busy"`, render without title. In v1 this branch is dead code, but it exists.
3. **Don't use "event" in user-facing text when "item" works.** The weekly view mixes events + tasks + rotations; calling the whole thing "events" paints us into a corner when GCal events arrive with a narrower meaning.
4. **`last_view_content_hash`** in `whatsapp_config` should include a source-attribution field when GCal ships, so feedback handler can later distinguish "Sonnet, you showed me my private doctor appointment in the group chat" from "Sonnet, this task isn't mine."

### Phase 3 migration sketch (for reference, not in scope)

When GCal ships:
1. Add columns to `events` (or new `gcal_events` table).
2. Extend `fetchAllEvents` to union + dedup.
3. Formatter gets a `visibility` branch for the busy-only path.
4. Opt-in OAuth flow per member (separate from this design).
5. Settings UI for "which calendars to show in household view."
6. Admin dashboard adds a "GCal connections" column.

None of this disturbs v1 code beyond the helper seam above.

---

## Open questions (to revisit post-launch)

1. 1:1 personal view image — same template with "השבוע" headline, or a slimmer variant?
2. Retrospective view — group auto-post Saturday afternoon vs on-demand only? v1 is on-demand only; revisit after 4 weeks of data.
3. Empty retrospective phrasing — confirmed as "אין עדיין מה לסכם" (warm, not apologetic).
4. Should `view_feedback` write every entry to a review queue for weekly human triage, or just log? v1: log to `view_feedback_review`; review when volume warrants.
5. Add "שבוע הבא" as a distinct view (separate from the Friday-onwards peek inside השבוע)? Not in v1.
6. **GCal Phase 3**: how to present busy-only events — just time + "עסוקה" or include duration bar? Decide with design mockups when Phase 3 begins.
7. **GCal Phase 3**: default visibility mapping for imported events — conservative (treat all as busy unless user opts public) or permissive (import public as public)?
8. **GCal Phase 3**: should Sheli-created events auto-sync to the owner's GCal? Likely yes with per-user toggle, but UX flow to be designed.

---

## Critical files — new or modified

| File | Change |
|------|--------|
| `supabase/functions/_shared/haiku-classifier.ts` | Add `show_view`, `view_feedback`, `opt_out_digest`, `opt_in_digest` intents + seed phrases |
| `supabase/functions/_shared/reply-generator.ts` | Extend Sonnet prompt for `view_feedback` with last-view context |
| `supabase/functions/_shared/view-data.ts` (new) | Four fetch helpers with horizon math + scope filtering |
| `supabase/functions/_shared/view-formatters.ts` (new) | Four text formatters |
| `supabase/functions/_shared/whatsapp-provider.ts` | Add `sendImage(to, base64, caption)` method |
| `supabase/functions/whatsapp-webhook/index.inlined.ts` | Route `show_view` → format → send; route `view_feedback` → Sonnet; route opt-in/out → flag toggle; add `last_view_*` tracking |
| `api/weekly-image.js` (new) | Vercel route, @vercel/og rendering, service-role auth |
| `src/components/AdminDashboard.jsx` | New "Weekly digest" section |
| Supabase migrations (new) | `weekly_digest_queue` table; `view_feedback_review` table; `households_v2.weekly_digest_enabled`; `whatsapp_config.last_view_type`, `last_view_sent_at`, `last_view_content_hash`, `last_view_item_count`, `last_view_scope` columns |
| pg_cron schedule (new) | Sunday 07:00 enqueue job |
| `tests/test_webhook.py` | Extend with `show_view` cases, scope cases, opt-out cases, feedback case |
| `tests/view_data_test.py` (new) | Horizon math, scope filtering, threshold counting |

---

## Notes on existing patterns reused

- **Two-stage pipeline**: Haiku classifies, deterministic templated replies skip Sonnet, Sonnet invoked only for ambiguity / feedback. Identical pattern to existing `show_view` vs `correct_bot` routing.
- **Reply templating**: Text formatters follow the existing convention of returning a single string ready for `provider.sendMessage`. No new abstraction.
- **pg_cron + queue**: Reuses exact pattern from `reminder_queue` (see `supabase/functions/_shared/` reminder worker). Sunday push is one more scheduled message type, not a new system.
- **Bot → Vercel for heavy work**: Pattern already exists for [api/chat.js](api/chat.js) (Sonnet reply generator called from bot). Image rendering is the same shape: bot POSTs with auth, Vercel returns binary/text, bot hands off to Whapi.
- **Admin preview**: Dashboard patterns already established for debugging (existing admin views in [src/components/AdminDashboard.jsx](src/components/AdminDashboard.jsx)).

---

*Brainstorm complete 2026-04-15. Next step: invoke `superpowers:writing-plans` to generate the detailed, task-by-task implementation plan.*
