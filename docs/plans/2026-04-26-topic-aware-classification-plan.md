# Topic-Aware Classification — Plan

**Date:** 2026-04-26
**Author:** Claude (with Yaron)
**Status:** Draft, awaiting redirect

## Problem (in one breath)

Sheli treats tags as flat metadata; users treat them as sub-lists. When a user types **"להוסיף לקניות בית מרקחת"** their mental model is "*pharmacy* is the LIST I'm buying for, not the THING I'm buying" — but Sonnet adds "בית מרקחת" as an item with category "אחר". Same gap for "Amazon", "פרויקטים ליוסי", "מתנות ליום הולדת". Compounded today (2026-04-26) by the user above who tried to retag existing items via "**להעביר ל shopping**" and got a confidently wrong "they're already in your shopping list".

The bot's hierarchy needs to become **list → topic → item** instead of **list → item (+optional tags)**.

## Design principles

1. **Topic ≠ item**. Some words read as containers (places, vendors, project labels), others as content (food, household supplies). Sheli should distinguish.
2. **Topic-name awareness from household state**. If "בית מרקחת" already exists as a tag in this household, future mentions of it should resolve to the topic, not be re-added as an item.
3. **Three operations, not one**. Today only `add_*` accepts tags. We need: (a) create-topic-with-first-item, (b) add-item-to-existing-topic, (c) move-existing-items-to-topic.
4. **Ask when ambiguous, but only once**. Constant clarification feels robotic. Strong signals (place/vendor/known-tag) → infer; weak signals → ask once and remember the answer for this household.
5. **Bot replies must name the topic**. When an item lands in topic X, Sheli says "הוספתי חיתולים לרשימת בית מרקחת ✓" — makes the hierarchy feel real to the user.
6. **No schema migration**. Reuse `tags TEXT[]`. Topics are emergent from tag values.

## Tier 1 — Classifier hardening (~2 hours)

**Goal**: teach Haiku + Sonnet that some words are topics, not items.

### 1.1 Topic-vs-item heuristics in Haiku prompt
Add a TOPIC NAMES block to the classifier prompt with named examples:
- **Places/vendors** (almost always topics): בית מרקחת, אמזון, Amazon, שופרסל, איקאה, IKEA, רמי לוי, Costco, ויקטוריה'ס סיקרט, KSP.
- **Project labels** (almost always topics): פרויקטים ל[name], מתנות ל[event], חתונה, יום הולדת, [name]-related compound nouns ("פרויקט הסלון", "אריזה לטיול").
- **Hebrew construct cues**: "רשימת X" → X is a topic. "תוסיפי לרשימת X את Y" → X=topic, Y=item.

### 1.2 Existing-tag lookup
Before classifying any short item-candidate (1-3 Hebrew words, no quantity modifier, no compound food noun), check if the candidate matches an existing tag in `currentTasks/Shopping/Events.tags`. If yes, treat as topic by default.

Implementation: pass `existing_tags: string[]` from `ctx` into Haiku's prompt context. Sonnet already has it via the items snapshot.

### 1.3 New entity field on add_*
Extend Haiku's `add_task` / `add_shopping` schema with:
```json
"is_topic_creation": false,    // user asked to create a new topic, not add an item
"topic": "בית מרקחת"            // the topic name if items should be tagged with it
```

`is_topic_creation=true` triggers a different bot reply ("יצרתי רשימת בית מרקחת ✓ מה להוסיף?") and creates no item row. `topic` populates `entities.tags=[topic]` for downstream executor.

### 1.4 Acceptance
- 10 new test cases in classifier eval covering: `"תוסיפי בית מרקחת"` → is_topic_creation=true; `"תוסיפי לרשימת בית מרקחת חיתולים"` → topic="בית מרקחת", item="חיתולים"; `"חיתולים לבית מרקחת"` → same; existing tag "אמזון" + `"תוסיפי שמן זית לאמזון"` → topic-aware.
- No regression on the existing 120-case suite.
- Live test on the user above (retroactive check via DB query).

## Tier 2 — Retag intent (~1.5 hours)

**Goal**: enable "move existing items to topic X" via natural language.

### 2.1 New action type
Extend `executeCrudAction` (already handles update_/remove_) with:
```ts
update_task_tags:     { add_tags?: string[], remove_tags?: string[] }
update_shopping_tags: { add_tags?: string[], remove_tags?: string[] }
```

When `add_tags` is set, fetch existing row, merge `tags` array (deduped via `normalizeTags`), update. `remove_tags` filters out matching values.

### 2.2 Bulk variant
Sonnet can target multiple rows: "להעביר את כל הקניות של הילדים לרשימת בית מרקחת". New action shape:
```ts
bulk_update_tags: {
  table: "tasks" | "shopping_items",
  filter: { ids?: string[], where_tag?: string },  // either explicit ids or "everything currently tagged X"
  add_tags?: string[],
  remove_tags?: string[],
}
```

`gatherCorrectionCandidates` is the existing pattern for "Sonnet picks IDs from a recent set" — extend with a `bulk_targets` flag that includes more rows when the user phrasing implies bulk.

### 2.3 Sonnet rules + examples
New SECTION in `buildReplyPrompt` and `ONBOARDING_1ON1_PROMPT`:
```
RETAG OPERATIONS:
- "להעביר X ל[topic]" / "תוסיפי תג Y ל[items]" / "[items] שייכים ל[topic]" → emit update_*_tags or bulk_update_tags
- "תורידי את התג X מ[items]" → remove_tags
- Topic creation by retag: if [topic] doesn't exist yet as a tag, ALSO emit a confirmation phrase: "יצרתי את הרשימה X ✓"
```

### 2.4 Acceptance
- "להעביר ל shopping" (after user has tagged items "shopping") → bulk_update_tags fires + Sheli replies "העברתי X פריטים לרשימת shopping ✓".
- "תורידי את הבית מרקחת מהאספירין" → removes tag "בית מרקחת" from item "אספירין".
- `update_task_tags` and `update_shopping_tags` round-trip in unit tests.

## Tier 3 — Topic-aware replies + ambiguity ask (~1 hour)

**Goal**: when Sheli adds an item to a topic, she NAMES the topic. When she's unsure, she asks once.

### 3.1 Reply rules
In all add_task/add_shopping confirmations, if `tags.length > 0`, append the topic name:
- "הוספתי חיתולים לרשימת בית מרקחת ✓"
- "רשמתי לסגור פגישה עם רובי — בנושא עבודה ✓"

If no tags, current "הוספתי לקניות ✓" remains. Wording variations: "ברשימת X", "בנושא X", "לרשימת X" — vary naturally.

### 3.2 Single-word ambiguity ask
When the user sends a SHORT message that's a single noun and the noun matches no existing tag AND isn't in the canonical-shopping-item list (חלב/לחם/ביצים/etc.), Sheli asks ONCE:

```
"בית מרקחת" — להוסיף לקניות כפריט (משהו לקנות), או ליצור רשימה חדשה לפריטים שאת קונה בבית מרקחת?
```

Save the answer to `household_patterns` so future mentions of "בית מרקחת" don't re-ask. (`household_patterns` already exists from the learning system, has the right shape — extend with a `tag_decision` row type.)

### 3.3 Acceptance
- New 1:1 user types "אמזון" with no context → Sheli asks the disambiguation question.
- Same user replies "רשימה חדשה" → "אמזון" stored as tag-decision in household_patterns + Sheli says "סבבה, יצרתי לך רשימת אמזון ✓ מה להוסיף?".
- Future "אמזון" in same household → no re-ask, treated as topic.

## Tier 4 — Web app polish (~30 min)

**Goal**: the dashboard reinforces the same hierarchical model.

### 4.1 Auto-tag on filter-active create
When a tag filter is active and the user uses NewItemInput, the new item should auto-inherit that tag. Today: it doesn't.

Code: read `activeTag` from `useTagFilter()`, pass into NewItemInput as `defaultTags={activeTag ? [activeTag] : []}`. NewItemInput pre-fills its tag editor.

### 4.2 Topic header instead of plain "All"
When a tag chip is active, the section heading above items should say "**רשימת בית מרקחת**" instead of the generic "Shopping List". Sells the hierarchy.

### 4.3 Acceptance
- Filter to "בית מרקחת" → "+ נושא" still says "+ נושא" but the chip starts pre-filled with "בית מרקחת". Add an item → it lands tagged.
- Heading reflects active tag.

## Tier 5 — Optional, defer

- **Topic management page** (`/topics` or in-app): list all topics in the household, rename, merge, delete (with cascade to retag/untag items). Probably needed eventually but a Tier 5 item — most users will get along with the inline chips.
- **Topic icons / colors**: a future visual delight. Not load-bearing.
- **Cross-list topics**: a topic can span tasks AND shopping AND events (e.g., "חתונה"). Unified view of "everything tagged חתונה". Tier 5+.

## Risks / unknowns

1. **Classifier regression**: adding more disambiguation logic risks lowering accuracy on cases that already work. Mitigate by running the full 120-case suite + the new 10 cases together.
2. **The "is this a topic?" judgment is fuzzy**. Some words are genuinely ambiguous ("חתונה" — is it a wedding gift you're buying, or a topic for everything wedding-related?). The single-word ambiguity ask handles this — better to ASK ONCE than guess wrong forever.
3. **household_patterns table** already has classification_corrections columns; extending it for tag_decisions needs a small migration (likely a new `pattern_type` value, no schema change).
4. **Bulk retag is destructive-ish**. Confirm before bulk-tagging 20+ rows: "סימנתי 23 פריטים בנושא בית מרקחת. אם זה לא נכון, תגידי 'בטלי' ואחזיר".
5. **The URL parameter `?tag=X`** stays in English — backward compat with existing WhatsApp deep links. Don't rename until we have a transition strategy.

## Test plan

- **Unit**: classifier eval +10 cases (Tier 1.4 list).
- **Integration**: `tests/test_webhook.py` adds a TestTopicAwareClassification class with the 10 cases from 1.4 + 5 cases from 2.4 + 3 cases from 3.3.
- **Live smoke (post-deploy)**: replay the 2026-04-26 user above (the one who said "להעביר ל shopping") in a test household. Expected: classifier emits bulk_update_tags, Sheli replies with topic-aware confirmation.

## Total estimate

- Tier 1: ~2h (classifier)
- Tier 2: ~1.5h (retag intent)
- Tier 3: ~1h (replies + ask)
- Tier 4: ~0.5h (web polish)
- Tests + deploy + verify: ~1h

**~6 hours one focused session**, splittable into Tier 1 first (highest immediate value) → ship → observe traffic → continue.

## Decision points for Yaron

1. **Ship in tiers or all-in-one?** Recommend tiers (T1 ships standalone value).
2. **household_patterns extension or a new table?** Recommend extending — table already exists, schema's flexible JSONB.
3. **Should `is_topic_creation=true` actually create an empty list, or wait for the first item?** Recommend wait — creating an empty topic with no items feels weird. The first add binds the topic into existence.
4. **The single-word ambiguity ask threshold**: should "בית מרקחת" trigger it for users with NO existing tags (where there's nothing to compare against)? Recommend yes — at the very start of a user's life with Sheli, asking once teaches the hierarchy. After 10+ tags exist, the existing-tag-lookup handles it.
5. **The retag confirmation threshold for bulk operations**: at how many rows do we add the "23 items, say 'cancel' if wrong" footer? Recommend 5+.

Redirect when ready.
