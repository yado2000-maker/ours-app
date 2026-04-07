# Conversation-Aware Classification & Dedup

**Date:** 2026-04-07
**Status:** Approved
**Problem:** Bot classifies each message in isolation. Family chatter about shopping/tasks gets misclassified as new requests. Duplicate items pile up.

## Problem Examples

1. "גור יש רק 7אפ. אין ספרייט" → Bot added "ספרייט" (should ignore — telling Gur there's no Sprite)
2. "בקבוק ספרייט", "ספרייט ליטר וחצי", "ספרייט" → three separate items (should be one, updated)
3. "לא 2, צריך 3" → Bot adds new item instead of updating quantity on previous item

## Design

### 1. Conversation Context Injection

**New function: `fetchRecentConversation(groupId)`**

```sql
-- Fetch whichever returns MORE messages (OR logic, cap at 30):
SELECT sender_name, message_text, classification, created_at
FROM whatsapp_messages
WHERE group_id = :groupId
  AND (
    created_at > now() - interval '15 minutes'   -- all recent messages
    OR id IN (                                     -- OR last 10 regardless of age
      SELECT id FROM whatsapp_messages
      WHERE group_id = :groupId
      ORDER BY created_at DESC LIMIT 10
    )
  )
ORDER BY created_at ASC   -- chronological for natural reading
LIMIT 30                  -- safety cap
```

**Why OR (whichever is higher):** In a quiet group, the last relevant exchange may be 45 min old — still important context. In a burst, 18 messages in 5 min are all relevant.

**Injected into Haiku prompt:**

```
RECENT CONVERSATION (oldest first):
[20:11 ירדן]: צריך לקנות מעדן הגולן מריר, מעדן הגולן חלב ובקבוק ספרייט
[20:12 מאמי שלי]: 2 ביצים חסה
[20:12 שלי]: הוספתי ביצים וחסה לרשימה 🛒
[20:12 גור אהוב שלי]: ליטר וחצי ספרייייט בבקשה
[20:12 שלי]: הוספתי ספרייט ליטר וחצי לרשימה 🛒

CURRENT MESSAGE (classify this):
[20:14 ירדן]: גור יש רק 7אפ. אין ספרייט
```

### 2. Updated Classifier Prompt

Add to Haiku system prompt:

```
CONVERSATION CONTEXT RULES:
- Read the RECENT CONVERSATION to understand the current message IN CONTEXT.
- A message that REFERS to a previously mentioned product/task/event is NOT a new request.
  Examples: "אין ספרייט" after someone asked for Sprite = status update (ignore).
- A message correcting/updating a previous request is NOT a new add request.
  Examples: "לא 2, צריך 3" = update quantity on the most recently discussed item.
- A message between family members ABOUT an item is social chatter (ignore).
  Examples: "גור יש רק 7אפ" = telling Gur something, not requesting.
- Only classify as actionable when the sender is clearly REQUESTING the bot to act.
- These rules apply to ALL entity types: shopping items, tasks, and events.
- If you are uncertain whether a message is a request or conversation, set:
  confidence: 0.55, needs_conversation_review: true
```

**New output field:** `needs_conversation_review: boolean` — explicit uncertainty signal.

### 3. Sonnet Escalation (Updated)

```
Escalate to Sonnet WITH full conversation window when ANY of:
  1. confidence 0.50-0.69 AND actionable intent     (existing rule)
  2. needs_conversation_review === true              (NEW — context ambiguity)
```

When escalating, pass the same conversation window (not just the single message like today). Sonnet makes the final call with full context.

### 4. Dedup Logic (All Entity Types)

Before inserting any entity, check for existing similar items. Runs inside `executeActions`.

#### 4a. Shopping Items — Quantity-Aware Merge

```
Incoming: "3 ספרייט"
Existing on list (got=false): "ספרייט" (qty: null)

1. extractProduct("3 ספרייט") → { name: "ספרייט", qty: "3", descriptor: null }
2. isSameProduct("ספרייט", "ספרייט") → true
3. Action: UPDATE existing item → qty = "3"
4. Reply: "עדכנתי ספרייט ל-3 ברשימה 👍"
```

**Dedup behavior matrix:**

| Existing | Incoming | Action | Reply |
|----------|----------|--------|-------|
| ספרייט (qty: null) | 3 ספרייט | UPDATE qty → "3" | עדכנתי ספרייט ל-3 |
| ספרייט (qty: "2") | 3 ספרייט | UPDATE qty → "3" | עדכנתי ספרייט ל-3 |
| בקבוק ספרייט | ספרייט ליטר וחצי | UPDATE name (more specific) | עדכנתי לספרייט ליטר וחצי |
| ספרייט (qty: "3") | ספרייט (qty: null) | SKIP | ספרייט כבר ברשימה 👍 |

#### 4b. Tasks — Title Similarity

```
Before INSERT tasks:
  SELECT id, title FROM tasks WHERE household_id = :hhid AND done = false

  If normalized existing.title ≈ normalized new.title → SKIP
  Reply: "המטלה כבר קיימת 👍"
```

#### 4c. Events — Title + Date Match

```
Before INSERT events:
  SELECT id, title, scheduled_for FROM events
  WHERE household_id = :hhid
    AND DATE(scheduled_for) = DATE(:new_scheduled_for)

  If normalized title match → SKIP
  Reply: "האירוע כבר ביומן 👍"
```

### 5. Normalization Functions

**`extractProduct(text)`** — Parses raw text into structured parts:
```
"3 בקבוקי ספרייט ליטר וחצי"
→ { name: "ספרייט", qty: "3", descriptor: "ליטר וחצי", prefix: "בקבוקי" }
```

- Strip leading numbers → qty
- Strip common container prefixes (בקבוק/בקבוקי, חבילת, שקית, קופסת) → prefix
- Strip trailing descriptors (ליטר, גרם, קילו + number) → descriptor
- Remainder → name
- Collapse repeated letters (ספרייייט → ספרייט)

**`isSameProduct(a, b)`** — Compares product names only:
- Normalize both (collapse letters, trim, lowercase)
- `a.includes(b) || b.includes(a)` → match
- Ignores qty, descriptor, prefix — those are preserved in DB

**`normalizeTaskTitle(text)`** — For tasks:
- Remove common filler (את, ה, ל, ב prefixes on first word)
- Trim, lowercase
- Compare with inclusion check

### 6. Data Flow

```
Message arrives
    │
    ├─ fetchRecentConversation(groupId)        ← NEW (OR logic, cap 30)
    ├─ buildClassifierCtx(householdId)         (existing)
    │
    ▼
Haiku classifies WITH conversation context
    │
    ├─ ignore + high conf           → STOP
    ├─ actionable + high conf       → Execute with dedup → Reply
    ├─ needs_conversation_review    → Sonnet WITH conversation  ← NEW
    ├─ medium conf (0.50-0.69)      → Sonnet WITH conversation  ← UPDATED
    └─ low conf (<0.50)             → ignore, log

Sonnet escalation (receives full conversation window):
    ├─ actionable                   → Execute with dedup → Reply
    └─ ignore/social                → STOP

Execute action (all entity types):
    ├─ Dedup: extractProduct + isSameProduct    ← NEW
    ├─ Match + new qty/descriptor → UPDATE      ← NEW
    ├─ Match + no new info → SKIP + "כבר ברשימה"← NEW
    └─ No match → INSERT as usual
```

### 7. Cost Impact

| Component | Current | After |
|-----------|---------|-------|
| Haiku context tokens | ~300 | ~500 (+200 for conversation) |
| Haiku cost/msg | ~$0.0003 | ~$0.0004 |
| Sonnet escalation rate | ~5-10% | ~10-15% (adds context-uncertain) |
| DB queries/msg | 4 | 5 (+1 for recent messages) |
| Net monthly/household | ~$0.50 | ~$0.60 |

### 8. What This Fixes

| Problem | Fix |
|---------|-----|
| "אין ספרייט" added as item | Haiku sees prior Sprite exchange → ignore |
| "גור יש רק 7אפ" added as item | Haiku sees it's addressed to family member → ignore |
| 3x Sprite variants on list | Dedup normalizes → UPDATE existing instead of INSERT |
| "לנקות מטבח" added twice as task | Task dedup catches normalized match → skip |
| "ארוחת ערב ביום שישי" added twice | Event dedup on title + date → skip |
| "לא 2, צריך 3" adds new item | Haiku with context → classify as update, not add |
