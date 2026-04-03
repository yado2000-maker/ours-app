# Sheli Learning System — Two-Stream Design

**Date:** 2026-04-03
**Status:** Approved
**Author:** Yaron + Claude

## Problem

Sheli's Haiku classifier is stateless — each message gets the same global prompt plus current open items. No memory of past interactions, no learned vocabulary, no feedback loop. When the bot makes a mistake (splits "חלב אורז" into two items, assigns wrong category, misses a family nickname), the fix only happens if a developer manually updates the global prompt.

## Goals

1. Sheli improves for ALL users over time (global learning)
2. Sheli improves for EACH family specifically (per-family learning)
3. Corrections are low-friction — mostly automatic, occasionally explicit
4. Cost impact: <$0.0001 per message additional

## Architecture: Two Learning Streams

```
Message → Haiku Classifier ──→ Action → User interacts with result
              ↑                                    ↓
    ┌─────────┴──────────┐              ┌──────────────────┐
    │ GLOBAL prompt       │              │ Feedback signals  │
    │ + FAMILY patterns   │              │ (3 types)         │
    └─────────┬──────────┘              └────────┬─────────┘
              │                                   │
              │                    ┌──────────────┴──────────────┐
              │              Stream A                      Stream B
              │              (global)                      (family)
              │              Weekly Claude                 Auto-update
              │              review → approve              household_patterns
              │              → update prompt               → inject per call
              │                    │                              │
              └────────────────────┴──────────────────────────────┘
```

### Stream A: Global Learning (all users)

Aggregated corrections across all families are analyzed weekly by Claude. Patterns that appear across multiple households become candidates for the global classifier prompt.

**Examples:**
- "שמן זית" split by 8 families → add to compound names list
- "קרם לחות" miscategorized by 5 families → add category example
- New Hebrew slang emerging across families → add to patterns

**Process:**
1. Weekly batch: query all corrections from past 7 days
2. Claude analyzes: groups by pattern, proposes prompt improvements
3. Results saved to `global_prompt_proposals` table
4. Founder reviews + approves (simple script or web UI)
5. Approved changes appended to global classifier prompt

### Stream B: Family-Specific Learning (per household)

Each family accumulates patterns from their specific usage. These are injected into the Haiku prompt as a `FAMILY PATTERNS:` section (~200 extra tokens).

**Examples:**
- "אבוש" = דויד (nickname only this family uses)
- "אחרי הגן" = 16:15 (their specific pickup time)
- חלב → always category "חלב וביצים" (their preference)
- Recurring weekly: חלב, ביצים, לחם

## Layer 1: Store Full Classification Data (Foundation)

### Database Change

Add `classification_data` JSONB column to `whatsapp_messages`:

```sql
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS classification_data JSONB;
```

### What Gets Stored

On every Haiku classification, store the full output:

```json
{
  "intent": "add_shopping",
  "confidence": 0.95,
  "entities": {
    "items": [{"name": "חלב אורז", "category": "חלב וביצים"}],
    "raw_text": "חלב אורז"
  }
}
```

### Impact
- Zero behavior change — just data capture
- Enables all future learning layers
- ~100 bytes per message additional storage

## Layer 2: Feedback Loop (Three Signal Types)

### Signal 1: Implicit (from app actions)

| User Action | Within | Signal | Logged As |
|-------------|--------|--------|-----------|
| Deletes item bot created | 5 min | False positive — bot shouldn't have acted | `false_positive` |
| Edits item name | 5 min | Name was wrong (e.g., "שמן" → "שמן זית") | `name_fix` |
| Edits item category | 5 min | Category was wrong | `category_fix` |
| Manually adds item bot ignored | 10 min | False negative — bot missed something | `false_negative` |

**Detection:** Realtime subscription on `shopping_items`, `tasks`, `events` watches for deletes/updates. If a row created by the bot (identifiable by `created_at` matching a recent `whatsapp_messages.created_at`) is modified within the time window, log a correction.

### Signal 2: Explicit WhatsApp Commands

| User Message | Action | Signal |
|-------------|--------|--------|
| "תמחקי" / "בטלי" / "לא" (within 60s of bot reply) | Undo last bot action | `explicit_reject` |

**Detection:** After sending a reply, Sheli tracks the `last_bot_action` per group (message ID + action details). If the next message from any user matches rejection patterns within 60s, undo and log.

### Signal 3: @ Mention Corrections

| User Message | Action | Signal |
|-------------|--------|--------|
| "@שלי התכוונתי לשמן זית" | Undo wrong + redo correct + reply | `mention_correction` |
| "@שלי תתקני, זה פריט אחד" | Undo split + merge + reply | `mention_correction` |

**Detection:** New `correct_bot` intent in classifier (see below). Richest signal — user explains exactly what went wrong.

### Storage: `classification_corrections` Table

```sql
CREATE TABLE public.classification_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  message_id UUID REFERENCES whatsapp_messages(id),
  correction_type TEXT NOT NULL,  -- false_positive, false_negative, name_fix, category_fix, explicit_reject, mention_correction
  original_data JSONB,            -- what the bot did (intent, entities, action)
  corrected_data JSONB,           -- what the user wanted (inferred or explicit)
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Layer 3a: Family-Specific Patterns (Stream B)

### Storage: `household_patterns` Table

```sql
CREATE TABLE public.household_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,     -- nickname, time_expr, category_pref, compound_name, recurring_item
  pattern_key TEXT NOT NULL,      -- the trigger (e.g., "אבוש", "אחרי הגן", "חלב")
  pattern_value TEXT NOT NULL,    -- the resolution (e.g., "דויד", "16:15", "חלב וביצים")
  confidence REAL DEFAULT 0.5,   -- 0.0-1.0, increases with repeated confirmation
  hit_count INT DEFAULT 1,       -- times this pattern was observed
  last_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE(household_id, pattern_type, pattern_key)
);
```

### Pattern Types

| Type | Key | Value | Example |
|------|-----|-------|---------|
| `nickname` | Family name/word | Member display_name | "אבוש" → "דויד" |
| `time_expr` | Hebrew time phrase | Specific time | "אחרי הגן" → "16:15" |
| `category_pref` | Item name | Preferred category | "חלב" → "חלב וביצים" |
| `compound_name` | First word | Full compound name | "חלב" + "אורז" → "חלב אורז" |
| `recurring_item` | Item name | Frequency | "חלב" → "weekly" |

### Prompt Injection

Loaded per-request from `household_patterns` and injected into the Haiku prompt:

```
FAMILY PATTERNS (learned for this household):
- Nicknames: "אבוש" = דויד
- Times: "אחרי הגן" = 16:15
- Categories: חלב → חלב וביצים, אגוזי מלך → מזווה
- Compound names: חלב אורז (one item), שמן זית (one item)
- Recurring: חלב, ביצים, לחם (weekly)
```

~200 extra tokens, negligible cost increase.

### Auto-Derivation

After each correction:
1. Extract the pattern (e.g., user changed category from "אחר" to "חלב וביצים" for "חלב")
2. Upsert into `household_patterns` with `confidence += 0.1`, `hit_count += 1`
3. Patterns with `confidence < 0.3` and `hit_count < 2` are not injected (too uncertain)
4. Patterns decay: if not seen for 90 days, `confidence -= 0.1` per month

## Layer 3b: Global Prompt Improvement (Stream A)

### Weekly Batch Job

A scheduled script (or Claude Code session) runs weekly:

1. **Query:** All corrections from the past 7 days across all households
2. **Aggregate:** Group by pattern — e.g., "שמן זית was split" appeared 8 times across 5 households
3. **Claude Analyze:** Send aggregated corrections to Claude with prompt:
   - "Here are this week's classification errors. Propose additions to the global classifier prompt."
4. **Store:** Save proposals to `global_prompt_proposals` table
5. **Review:** Founder approves/rejects via simple script (`python review_proposals.py`)
6. **Apply:** Approved proposals are appended to the global prompt sections (compound names, categories, patterns)

### Storage: `global_prompt_proposals` Table

```sql
CREATE TABLE public.global_prompt_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  proposal_type TEXT NOT NULL,     -- compound_name, category_rule, pattern, hebrew_slang
  proposal_text TEXT NOT NULL,     -- the actual prompt addition
  evidence_count INT NOT NULL,    -- how many corrections support this
  household_count INT NOT NULL,   -- across how many families
  status TEXT DEFAULT 'pending',  -- pending, approved, rejected
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## @ Mention Handling

### Direct Address Detection

**Pre-classifier check** (before Haiku):
- Detect `@שלי` or `שלי` at message start, after comma, or as tagged participant
- Set `directAddress = true` → **forces a response regardless of intent**
- Strip the `@שלי` / `שלי` prefix before classification

### New Intent: `correct_bot`

Added to the Haiku classifier's intent list:

| Intent | Triggers | Entities |
|--------|----------|----------|
| `correct_bot` | "התכוונתי ל...", "לא X, כן Y", "תתקני", "טעית", correction language after @שלי | `{ correction_text, original_ref }` |

### Behavior by Intent + Direct Address

| directAddress | Intent | Behavior |
|---------------|--------|----------|
| true | `correct_bot` | Undo last action + redo correctly + reply "סורי! תיקנתי" + log correction |
| true | `question` | Answer (existing behavior) |
| true | `ignore` (praise/chat) | Sonnet generates personality reply ("תודה! 😊") |
| true | any actionable | Execute + reply (existing behavior) |
| false | any | Existing behavior unchanged |

## Incremental Build Order

| Phase | What | Depends On | Effort |
|-------|------|------------|--------|
| 1 | Store `classification_data` JSONB on every message | Nothing | Small — add column + store JSON |
| 2 | `@שלי` direct address detection + forced reply | Nothing | Small — pre-classifier check |
| 3 | `correct_bot` intent + undo/redo logic | Phase 2 | Medium — new intent + action |
| 4 | Implicit feedback (delete-within-5min detection) | Phase 1 | Medium — Realtime watcher or DB trigger |
| 5 | `household_patterns` table + prompt injection | Phase 1 + (3 or 4) | Medium — new table + query + inject |
| 6 | Explicit "תמחקי" undo command | Phase 1 | Small — pattern match + undo |
| 7 | Weekly global review batch job | Phase 4 or 5 | Medium — Claude batch + review script |
| 8 | Pattern auto-derivation from corrections | Phase 5 | Medium — correction → pattern logic |

**MVP (Phases 1-3):** Store data + @שלי always replies + corrections understood. Already useful.
**V1 (Phases 1-6):** Full feedback loop + per-family patterns. Sheli visibly improves per family.
**V2 (Phase 7-8):** Global learning loop. Sheli improves for all users from collective intelligence.

## Cost Impact

| Component | Additional Cost per Message |
|-----------|---------------------------|
| Store classification_data | ~0 (100 bytes storage) |
| Load household_patterns | ~$0.00001 (one DB query) |
| Extra prompt tokens (~200) | ~$0.00005 |
| Weekly Claude batch | ~$0.50/week total (not per message) |
| **Total per message** | **~$0.00006** |

At 10,000 messages/day across all households: ~$0.60/day = ~$18/month. Negligible vs current AI costs.

## Success Metrics

- **Classification accuracy** improves from 91.7% → 95%+ within 30 days of launch
- **Corrections per family** decrease over time (Sheli makes fewer mistakes per household)
- **Global prompt grows** by 5-10 new patterns per week from real family data
- **Time to correct** <2 seconds (undo + redo on @שלי correction)
