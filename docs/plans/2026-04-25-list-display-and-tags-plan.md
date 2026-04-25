# List Display Recovery + Free-Form Tags — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Tier 1 ships separately and immediately as a hot-fix; this plan covers Tier 1 + Tier 2 + Tier 3.

**Goal:** Two coupled rebuilds, both surfaced by the Bat-Chen 2026-04-18 conversation:

1. **Stop the "Sheli forgot half my list" failure mode.** DB integrity ≠ user-perceived integrity. When Sheli's reply truncates a 25-item list to 13 items mid-line, the user reads it as data loss, complains "שכחת משימות", Sheli blind-re-adds, DB bloats with duplicates, the next display still looks incomplete, repeat. The relationship dies in 4 turns.
2. **Make user-defined lists ("tags") a first-class primitive, free-form.** Today the only "lists" Sheli supports are an implicit two-way split based on the title prefix `[עבודה]` or `[בית]`. Real users want: "amazon shopping", "trader joe's", "פרויקט הסלון", "before flight", "חתונה של דנה", anything. The current `tasks` schema has no category column at all — categories live in title strings. This plan adds a real `tags TEXT[]` column to `tasks`, `shopping_items`, and `events`, with classifier + display + UX support.

**Why now:** Bat-Chen 2026-04-18 case showed both failures in a single 60-min conversation. 51 tasks landed in DB; user's mental model said "Sheli lost everything." She tried 6 different rephrasings, each one made it worse. Conversation ended with her saying "את לא עובדת כל כך טוב" and giving up. This is what the post-incident write-up should NOT need to be filed for again.

**Architecture:** Three tiers, deployable independently.

- **Tier 1 — prompt-only.** Lives in `ONBOARDING_1ON1_PROMPT` + `buildReplyPrompt` + `SHARED_*` constants. No schema, no classifier change, no migration. Ships in one Edge Function deploy. Closes ~80% of the user-visible pain by changing how Sheli renders + responds to "missing items" complaints. **Hot-fix; ships before this plan is merged.**
- **Tier 2 — schema + classifier + reply.** Add `tags TEXT[]` to `tasks`, `shopping_items`, `events`. Backfill from existing prefix-strings. Add `due_date DATE` to `tasks` so day-of-week info ("X - יום ב") becomes a real date + auto-reminder, not a string suffix. Update Haiku classifier to emit `tags` and `due_date`. Update Sonnet to display by tag.
- **Tier 3 — UX polish.** Deep-link from WhatsApp to filtered web view. One-time cleanup of Bat-Chen's `hh_batchen_recov` data (dedupe re-adds, normalize day-suffix tasks).

**Tech stack:** Supabase Edge Function (Deno, `index.inlined.ts`), Postgres (`tasks`, `shopping_items`, `events`, `reminder_queue`, new GIN indexes), React web app (`src/components/TasksView.jsx`, `ShoppingView.jsx`, new tag chip filter UI), Vite SPA. No new infrastructure.

---

## Hard constraints

1. **Free-form tags, no taxonomy lockdown.** Tags are TEXT[]. Whatever the user types, Sheli stores. Lower-case canonical comparison (`LOWER()` for matching), original case preserved for display. No moderation, no allowlist. Edge cases: emoji-only tags ✅ allowed; empty string ❌ rejected client-side; >50 chars ❌ rejected.
2. **Migration is additive.** Existing `[עבודה]` / `[בית]` prefix tasks keep working through Tier 2 — old prefix-string display path stays alive until backfill confirms parity. No breaking change for existing households.
3. **Kill switches stay ON during Tier 1 deploy.** Same paste-corruption + esbuild parse-check ritual. Tier 1 is a 1:1-only change for the personal-channel handler + group reply prompt; outbound is unaffected.
4. **No mass re-rendering of stale lists.** Tier 3's Bat-Chen cleanup is a manual SQL migration — does NOT broadcast to her or trigger any outbound. She gets at most ONE operator-sent recovery DM, and only if she initiates contact again.
5. **esbuild parse-check mandatory** before any deploy:
   ```
   npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
     --bundle --platform=neutral --format=esm --target=esnext \
     --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
     --outfile=/tmp/bundle_test.js
   ```
6. **Commit before Dashboard paste.** Paste-corruption scan post-deploy via Latin+Hebrew+Latin regex (see CLAUDE.md 2026-04-22 lesson).
7. **Branch.** Tier 1 hot-fix → `claude/list-display-hotfix`. Tier 2 + 3 → `claude/free-form-tags`.
8. **Scope — touches:** `index.inlined.ts` (prompts + classifier embed), one DB migration per tier, Haiku classifier prompt section in `_shared/haiku-classifier.ts`, `src/components/TasksView.jsx` + `ShoppingView.jsx` + new `TagFilter.jsx`, `src/lib/supabase.js` (toDb/fromDb mappers add `tags`). Does NOT touch: outbound queue, reminders cron, prompts unrelated to add_task / add_shopping / question / list-display, billing, Cloud API migration.

---

## Static analysis findings (pre-implementation)

1. **`tasks` table currently has no category column** (verified via Bat-Chen investigation 2026-04-25). Columns are: `id, household_id, title, done, assigned_to, created_at`. Categories ride inside `title` as `[עבודה] X` / `[בית] X` prefix. ~150 rows across the prod corpus use this prefix. The migration backfills these into a structured `tags` column, leaving title cleaned.
2. **`shopping_items` already has a `category` column** for the canonical food-category emoji headers (מוצרי חלב, פירות וירקות, etc.) — this is DIFFERENT from user-defined tags. `category` is one-of-N taxonomy for emoji rendering; `tags` is free-form for user-defined lists. They coexist without conflict.
3. **`events` has no tag column today.** Same treatment: add `tags TEXT[]`. Use case: "תוסיפי ליומן הבר-מצווה של אריאל" + later "תציגי את כל האירועים של אריאל" → filter by tag.
4. **Sonnet's `existingItems` JSON in the 1:1 context block already includes all current tasks/shopping/events.** No fetch race. The 11:38 "שכחת משימות" loop in the Bat-Chen convo proves Sonnet had the data and chose not to use it for comparison — purely a prompt-discipline issue, fixable in Tier 1.
5. **Haiku classifier today emits `add_task` with no tag info.** Tier 2 adds `entities.tags: string[]` to the schema. Backwards-compatible: tags omitted when no list anchor in the user message.
6. **WhatsApp message practical limit ~4096 chars per body.** Sheli's hits truncation well before that — visible cuts at ~500-1000 chars suggest Sonnet's `max_tokens` is the actual bottleneck, not WhatsApp. Tier 1 sidesteps this by capping inline list length at 7 items regardless of token budget.

---

## Tier 1 — Hot-fix (prompt-only, ~2 hours)

> **Already in flight as a separate hot-fix branch `claude/list-display-hotfix` — this section documents what shipped so a fresh session can verify it landed before starting Tier 2.**

### 1.1 New shared constant: `SHARED_LIST_DISPLAY_RULES`

Inserted into the `SHARED_*` block at the top of `index.inlined.ts`. Interpolated into both `buildReplyPrompt` and `ONBOARDING_1ON1_PROMPT`.

```
LIST DISPLAY — STRICT FORMAT, NO VARIANTS:

1. SAME RENDERING EVERY TIME. The user's mental model is "this is my list" —
   if you render it differently each turn, they think it's different data.
   Canonical format:
     <category emoji + name on its own line>
     <item 1, no bullet, no dash>
     <item 2>
     <blank line>
     <next category if any>
   Never use • ☐ — \\* as bullets in Hebrew RTL — they break visually.
   Never use bold ** when an emoji header would do. Never invent prose
   intros like "הנה הרשימה שלך:" — just send the list.

2. INLINE-DISPLAY BUDGET: 7 ITEMS MAX. If the list has 8+ items, do NOT
   inline them. Instead reply:
     "יש לך {N} פריטים ב-{tag/category}. מציגה את 7 הראשונים:
     <items 1-7>
     הרשימה ארוכה מדי לווטסאפ, אפשר לראות את כולה באפליקציה Sheli.ai 📋"
   The 7-item limit is hard. Do NOT stretch it because "this list is
   important". Truncating mid-line is the WORST failure mode — it makes
   the user think items were lost.

3. NEVER CUT MID-LINE OR MID-WORD. If you sense the budget is tight,
   stop CLEANLY at item N and explicitly note "הכל באפליקציה Sheli.ai".
   The Bat-Chen 2026-04-18 incident shipped because Sheli sent
   "...להזכיר ל" with no closer. Banned forever.

4. MULTIPLE LISTS IN ONE TURN: pick ONE list. If the user asked
   for two ("תציגי שתי הרשימות"), reply "{N1} בעבודה, {N2} בבית —
   באיזו להתחיל?" and wait. Do NOT try to fit both in one message.
```

### 1.2 New shared constant: `SHARED_MISSING_ITEMS_RULES`

Inserted alongside `SHARED_LIST_DISPLAY_RULES`.

```
MISSING-ITEMS COMPLAINT — COMPARE-BEFORE-READD:

When the user says any of: "שכחת", "חסר", "פספסת", "לא רשמת", "missing",
"you forgot", "didn't add" — DO NOT blind-re-add the items they then
mention. The Bat-Chen 2026-04-18 incident: 4 "שכחת" turns in a row →
Sheli "remembered" + re-added each time → DB bloated with duplicates →
display still looked incomplete (because of separate truncation bug)
→ user gave up.

Correct response, ALWAYS:
  "רשום אצלי {N} משימות ב-{list}. תגידי לי איזה מהן חסרות
  ואני אבדוק 🙈 — או אפשר לראות את הכל באפליקציה Sheli.ai 📋"
WAIT for the user to specify what's missing. Compare against
existingItems before adding ANYTHING. If a named item IS already in
existingItems, reply "X כבר אצלי 👍" and do NOT add a duplicate. Only
add items that are genuinely absent.

This rule overrides the default "always be helpful" instinct. Blind
re-adding is the most damaging failure pattern Sheli has — it lies to
the user (we DID record it) AND corrupts data (now there are two).
```

### 1.3 Extension to `SHARED_GROUNDING_RULES`: ban fake bug claims

Append:
```
NO FAKE-BUG CLAIMS — ABSOLUTE RULE:
NEVER say "יש לי באג", "אני לא עובדת כמו שצריך", "יש בעיה טכנית",
"אני מנסה לתקן 🔧", "the system has a bug", or any variation that
blames an internal failure for output the user didn't like.
There is no bug — your reply was either truncated, mis-rendered, or
the user is asking about data that genuinely doesn't exist.

When the user complains about output quality, the honest framings are:
  "הרשימה ארוכה — חתכתי באמצע. sheli.ai מציג את הכל 📋"
  "סורי, זה לא ברור לי — תוכלי לכתוב שוב מה את צריכה?"
  "רשום אצלי X — אם זה לא מה שאת רואה, אפשר לראות הכל באפליקציה Sheli.ai"

Bat-Chen 2026-04-18: Sheli said "אוקיי יש לי באג 🙈" + "אני מנסה לתקן"
when nothing was broken — just truncated. The user lost trust within
two messages. NEVER again.
```

### 1.4 Tier 1 acceptance

- [ ] esbuild parse-check on `index.inlined.ts` clean.
- [ ] Three new constants (`SHARED_LIST_DISPLAY_RULES`, `SHARED_MISSING_ITEMS_RULES`, addendum to `SHARED_GROUNDING_RULES`) interpolated into both `buildReplyPrompt` and `ONBOARDING_1ON1_PROMPT`.
- [ ] Manual test: send "תציגי רשימת משימות" to a household with 15+ tasks → reply shows 7 + "הכל באפליקציה Sheli.ai", no truncation, no bullets.
- [ ] Manual test: tell Sheli "שכחת משימות" with no specifics → reply asks user to specify, does NOT add anything.
- [ ] Manual test: ask "למה הרשימה לא מלאה?" → no "יש לי באג" anywhere in reply.

---

## Tier 2 — Free-form tags + due_date schema (~5 hours)

### 2.0 Schema migration

File: `supabase/migrations/2026_04_27_free_form_tags_and_due_date.sql`

```sql
-- Free-form user-defined tags. NULL or empty array = untagged.
ALTER TABLE tasks          ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE events         ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN indexes for "find all items tagged X" queries.
CREATE INDEX IF NOT EXISTS tasks_tags_idx          ON tasks          USING GIN (tags);
CREATE INDEX IF NOT EXISTS shopping_items_tags_idx ON shopping_items USING GIN (tags);
CREATE INDEX IF NOT EXISTS events_tags_idx         ON events         USING GIN (tags);

-- Due date for tasks. Day-of-week phrases ("X - יום ב") materialize here.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;
CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks (household_id, due_date)
  WHERE due_date IS NOT NULL;
```

**Acceptance:** Migration applies clean. `\d+ tasks` shows the new columns. Existing rows unaffected.

### 2.1 Backfill prefix-string → tags

```sql
-- Convert "[עבודה] X" / "[בית] X" / "[work] X" / "[home] X" prefixes
-- (case-insensitive, with or without trailing space) into structured
-- tags + cleaned title. One-shot; idempotent because we strip the
-- prefix from title in the same UPDATE.
UPDATE tasks
SET
  tags = ARRAY[lower(matches[1])],
  title = trim(matches[2])
FROM (
  SELECT id, regexp_match(title, '^\[(.+?)\]\s*(.+)$') AS matches
  FROM tasks
  WHERE title ~ '^\[.+?\]'
    AND tags = '{}'
) AS m
WHERE tasks.id = m.id AND m.matches IS NOT NULL;
```

**Acceptance:** Spot-check `SELECT title, tags FROM tasks WHERE 'עבודה' = ANY(tags) LIMIT 5` returns rows where title NO LONGER starts with `[עבודה]`. `tags @> ARRAY['עבודה']` finds them all. Count of `title ~ '^\['` should drop to ~0.

### 2.2 Haiku classifier — emit `tags` and `due_date`

File: `_shared/haiku-classifier.ts` (and the embedded version in `index.inlined.ts`).

Add to `add_task` / `add_shopping` / `add_event` entity schemas:
```
"tags": ["<tag1>", "<tag2>"]   // user-named lists, lowercase
"due_date": "YYYY-MM-DD" | null  // tasks only — when user names a day
```

Prompt examples:
```
[user]: "תוסיפי לרשימת עבודה לסגור פגישה עם רובי" →
  add_task with entities.tags=["עבודה"], title="לסגור פגישה עם רובי"

[user]: "add to my amazon list — שמן זית" →
  add_shopping with entities.tags=["amazon"], items=[{name:"שמן זית"}]

[user]: "תוסיפי לרשימת פרויקט הסלון לקנות וילון" →
  add_task with entities.tags=["פרויקט הסלון"], title="לקנות וילון"

[user]: "לארוז לנסיעה - יום שבת" →
  add_task with entities.tags=[] (no list anchor), title="לארוז לנסיעה",
  due_date="<this Saturday's date>"

[user]: "תוסיפי לרשימת בית לקנות פרקט - יום ב" →
  add_task with entities.tags=["בית"], title="לקנות פרקט",
  due_date="<this Monday's date>"

[user]: "תוסיפי משימה לבטל מנקה" →
  add_task with entities.tags=[], title="לבטל מנקה" (no anchor, no day)
```

**Tag normalization rule (in prompt):** lowercase the tag string. Strip leading/trailing whitespace. Preserve internal spaces ("פרויקט הסלון" stays multi-word). Synonyms — work / עבודה / job — stay separate; user can later say "merge work into עבודה" but Sheli does NOT auto-merge.

**Acceptance:** Run `tests/test_webhook.py` with 10 new test cases covering tagged adds. All pass. No regression on existing untagged cases.

### 2.3 Sonnet display — query by tag

In `buildReplyPrompt` `case "question"`:
- If user's question text matches `/(תציגי|הראי|מה ב)\s*(רשימת|רשימה של)?\s*(.+)/`, treat it as a list query. Extract list name → lowercase → query `existingItems` filtered by `tags @> ARRAY[<name>]`.
- If list name is `"בית"` / `"home"` AND zero results, fall back to legacy prefix scan (transitional). Log a `legacy_prefix_fallback` notes-line in classification_data so we can phase out the fallback later.

`SHARED_LIST_DISPLAY_RULES` already enforces the format. `tags`-aware query just feeds it the right subset.

### 2.4 Auto-reminder for tasks with `due_date`

When `add_task` lands with non-null `due_date`, the action handler ALSO inserts a `reminder_queue` row:
```ts
{
  household_id: hh,
  send_at: due_date + '09:00 IL',
  message_text: title + ' (היום)',
  reminder_type: 'user',
  group_id: <chat group_id or phone@s.whatsapp.net for 1:1>,
  metadata: { source: 'task_due_date', task_id }
}
```

**Default time configurable** via env `TASK_DUE_DATE_REMINDER_TIME` (default "09:00"). User can override per-task in a follow-up: "תזכירי לי על X ב-15 במקום 9".

**Acceptance:** Add a task with `due_date = tomorrow` → row appears in `reminder_queue` with `send_at = tomorrow 09:00 IL`. Quiet-hours rules from `fire_due_reminders_inner` v3 apply (no special handling). Verify via `tests/test_webhook.py` integration test.

### 2.5 Web app — tag filter UI

Files: `src/components/TasksView.jsx`, `ShoppingView.jsx`, new `src/components/TagFilter.jsx`.

- Above each list, render horizontal scrollable chip row of distinct tags (sorted by usage count). "All" chip = no filter; selected chip filters to items where `tags @> [selected]`.
- Untagged items always visible under "All" chip; hidden under any specific tag chip.
- New-item input gains a small `+ tag` affordance (autocompletes from existing tags in the household).
- Edit-task / edit-shopping form has a multi-select tag field.

**Acceptance:** A household with 3 tagged + 2 untagged tasks shows "All (5) | עבודה (2) | בית (1)" chips. Clicking עבודה filters to those 2. RTL layout intact. Mobile-friendly.

### 2.6 Tier 2 acceptance

- [ ] Migration applied prod, all three tables have `tags` column + GIN index, `tasks.due_date` exists.
- [ ] Backfill complete: 0 tasks with `[עבודה]` / `[בית]` prefix in title; equivalent count tagged via `tags`.
- [ ] Classifier eval: 95%+ pass rate on 10 new tagged-add test cases + no regression on existing 120-case suite.
- [ ] Sonnet display: "תציגי רשימת עבודה" returns only `tags @> ['עבודה']` items, format matches Tier 1 rules.
- [ ] Auto-reminder: a `due_date`-tagged task creates a reminder visible in the user's daily briefing.
- [ ] Web app: tag chips render, filter works, edit form supports tag changes. Lighthouse score unchanged.

---

## Tier 3 — UX polish + Bat-Chen cleanup (~3 hours)

### 3.0 Deep-link from WhatsApp to filtered web view

When `SHARED_LIST_DISPLAY_RULES` triggers the "הכל באפליקציה Sheli.ai" footer, append a query string:
```
sheli.ai/tasks?tag=<tag>      // for tagged list
sheli.ai/tasks                // for "all"
sheli.ai/shopping?tag=<tag>
```

Web app: read `?tag=<x>` on mount, pre-select the chip. URL-encode multi-word tags ("פרויקט הסלון" → `%D7%A4%D7%A8...`).

**Acceptance:** Click the link from a WhatsApp message on phone → web app opens with that filter active. Back button returns to "All". No extra page-load latency.

### 3.1 Bat-Chen `hh_batchen_recov` cleanup

One-time SQL migration. NOT broadcast to her — silent fix.

```sql
-- (a) Dedupe the 11:37–11:38 "שכחת" loop re-adds. Heuristic: same-title
--     pairs created within 5 minutes, keep oldest, delete newer.
WITH dups AS (
  SELECT t1.id AS keep_id, t2.id AS drop_id
  FROM tasks t1
  JOIN tasks t2 ON t1.household_id = t2.household_id
                AND t1.title = t2.title
                AND t1.created_at < t2.created_at
                AND t2.created_at - t1.created_at < INTERVAL '5 minutes'
  WHERE t1.household_id = 'hh_batchen_recov'
)
DELETE FROM tasks WHERE id IN (SELECT drop_id FROM dups);

-- (b) Normalize day-suffix tasks. "X - יום ב" → title="X", due_date=<Mon>.
--     Only run AFTER Tier 2 ships. Manual day→date map seeded for the
--     specific Bat-Chen tasks (her conversation referenced 21.4-26.4 IL
--     calendar week).
UPDATE tasks SET
  title = regexp_replace(title, '\s*-?\s*יום\s+\S+\s*$', ''),
  due_date = CASE
    WHEN title ILIKE '%- יום א%'   THEN '2026-04-19'
    WHEN title ILIKE '%- יום ב%'   THEN '2026-04-20'
    WHEN title ILIKE '%- יום ג%'   THEN '2026-04-21'
    WHEN title ILIKE '%- יום ד%'   THEN '2026-04-22'
    WHEN title ILIKE '%- יום ה%'   THEN '2026-04-23'
    WHEN title ILIKE '%- יום ו%'   THEN '2026-04-24'
    WHEN title ILIKE '%- שבת הבא%' THEN '2026-04-25'
    WHEN title ILIKE '%- היום%'    THEN '2026-04-18'
    ELSE NULL
  END
WHERE household_id = 'hh_batchen_recov'
  AND title ~ '\s*-\s*יום\s+\S+\s*$';
```

**Acceptance:** Bat-Chen's task count drops to ~38 (51 - ~13 dups). Day-suffix tasks have clean titles + `due_date` populated. 0 reminders auto-created (the dates are mostly past — `fire_due_reminders_inner` skips past-due rows).

### 3.2 Operator recovery DM template (manual)

Drafted for Yaron to send manually if Bat-Chen returns:
```
היי בת חן, סורי על הבלגן בשבת. סידרתי הכל אצלי —
הרשימות מחולקות נכון, התאריכים יושבים על המשימות.
הכל פה: sheli.ai 📋
```

**Acceptance:** Template lives in `docs/recovery-templates.md` (new file). Not auto-sent. Yaron decides.

### 3.3 Tier 3 acceptance

- [ ] Deep links work on phone + desktop, RTL intact.
- [ ] Bat-Chen `hh_batchen_recov` cleanup migration applied. Manual SQL spot-check confirms task count + due_date populated correctly.
- [ ] Recovery DM template committed. NOT auto-sent.
- [ ] Plan deprecation note added: when Cloud API migration ships, this plan's Tier 1 truncation rules can relax (Cloud API supports much longer messages reliably).

---

## Test plan

### Unit (during Tier 2)
- Classifier emits correct `tags` + `due_date` for the 10 new test cases.
- Tag normalization (lowercase, trim) is consistent.
- `tasks.tags` GIN index is hit on `WHERE tags @> ARRAY[...]` queries (`EXPLAIN`).

### Integration (`tests/test_webhook.py`, after Tier 2)
- Add 12 new test cases covering tagged adds, tagged display queries, due_date adds, and the "שכחת" comparison flow. Target 90%+ pass rate.
- Regression: full 120-case existing suite must stay above its current pass rate.

### End-to-end (after Tier 2 deploy)
- Synthetic Bat-Chen replay: send the same 60-message script through the bot in a test household. Verify NO truncation, NO blind re-add, list display deterministic. Compare output side-by-side with the original transcript.

### UI (after Tier 2.5 / Tier 3.0)
- Tag chips render correctly RTL + LTR, mobile + desktop.
- Deep links open with correct filter pre-applied.

---

## Rollback

**Per-tier reversibility:**

- **Tier 1 (prompt-only):** revert the `index.inlined.ts` shared-constants block. No data risk. ~5 min.
- **Tier 2 (schema):** the new columns default to empty array / NULL — leaving them in place after a rollback is harmless. To fully revert: `DROP COLUMN tags` on the three tables (loses the backfilled tag info), `DROP COLUMN due_date` on `tasks`. Classifier prompt revert in same Edge Function deploy.
- **Tier 3 (cleanup):** SQL data migration is destructive (deletes dup rows). NOT reversible without a backup. Take a `pg_dump` of `hh_batchen_recov`-scoped rows BEFORE running 3.1.

**Mid-incident kill switches:**
- Tier 2 misclassification spam: revert classifier prompt (single edit, redeploy). Existing rows with `tags` populated stay intact; new adds won't get tags until reverted.
- Tier 3 cleanup wrong: restore from `pg_dump` snapshot.

---

## Open questions / future work

1. **Tag synonym merge.** A user might create both "work" and "עבודה" without realizing they're the same conceptually. Future feature: "merge tag X into Y" command. Out of scope for this plan.
2. **Tag suggestions during add.** Sonnet could ask "לאיזה רשימה?" when a task is added without a tag, if the household has 3+ active tags. Risk: chatty. Defer.
3. **Tags on reminders, expenses, family_memories?** Tier 2 covers tasks/shopping/events. Reminders inherit context from their parent task (via `recurrence_parent_id` or task linkage), so probably don't need their own tag column. Expenses already have a `category` field and `attribution`. Family memories have their own `memory_type`. Revisit if user demand surfaces.
4. **Tag-based household sharing.** "שתפי את רשימת amazon עם יונתן" — share a single tag's items with one household member. Requires per-tag visibility model. Way out of scope.
5. **Per-tag mute / per-tag notification time.** "תזכירי על משימות work רק בימי עבודה" — non-trivial. Future.
6. **Cloud API migration deprecates the truncation rule.** Once Cloud API is live, message bodies can be much longer reliably. The 7-item inline cap from Tier 1 should be re-evaluated — maybe relax to 15. Annotate in the Cloud API migration plan.

---

## Acceptance criteria for "plan complete"

- [ ] Tier 1 hot-fix shipped on its own branch + PR (separate from this plan PR).
- [ ] Tier 2 migration applied, backfill verified, classifier + Sonnet updated, web app tag UI live.
- [ ] Tier 3 deep links live, Bat-Chen cleanup applied, recovery template committed.
- [ ] Bat-Chen replay test passes end-to-end with no truncation or blind re-add.
- [ ] CLAUDE.md updated with: `tags TEXT[]` schema, `due_date` schema, `SHARED_LIST_DISPLAY_RULES`, `SHARED_MISSING_ITEMS_RULES`, the no-fake-bug rule, and reference to this plan + the Bat-Chen 2026-04-18 incident.
- [ ] Memory files written: `feedback_truncation_is_the_lie.md`, `feedback_compare_before_readd.md`, `project_free_form_tags.md` (entries in `MEMORY.md` index).
- [ ] PRs reviewed, merged. Branches deleted from origin.
