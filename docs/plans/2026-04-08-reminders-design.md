# Reminders — Design

**Date:** 2026-04-08
**Status:** Draft
**Priority:** High (users asking for it)

## Overview

Users can set reminders in natural Hebrew/English. Sheli stores them and sends a message in the family group at the specified time.

## User Experience

**In group:**
```
User: "תזכירי לי לאסוף את הילדים ב-4"
Sheli: "אזכיר בקבוצה היום ב-16:00 ✓"

[At 16:00]
Sheli: "⏰ תזכורת: לאסוף את הילדים"
```

**In 1:1:**
```
User: "תזכירי לי מחר ב-8 לקנות חלב"
Sheli: "אזכיר! שימו לב — התזכורת תישלח בקבוצה המשפחתית ✓"
```

**Time expressions (Hebrew examples):**
- "ב-4" / "ב-16:00" → today at 16:00 (if in future, else tomorrow)
- "מחר ב-8 בבוקר" → tomorrow 08:00
- "בעוד שעה" → now + 1 hour
- "בעוד 20 דקות" → now + 20 minutes
- "ביום חמישי ב-10" → next Thursday 10:00
- "מחר בערב" → tomorrow 19:00

## Architecture

```
Message → Haiku classifier (intent: add_reminder, conf >= 0.70)
  → Sonnet extracts: reminder_text, send_at (ISO timestamp), mentioned_person
  → INSERT reminder_queue
  → Sheli confirms with parsed time

pg_cron (every 1 minute):
  → SELECT unsent reminders WHERE send_at <= now()
  → pg_net HTTP POST to Whapi (send message to group)
  → UPDATE sent = true, sent_at = now()
```

## DB: reminder_queue (already exists)

| Column | Type | Purpose |
|--------|------|---------|
| id | uuid | PK |
| household_id | text | FK to households_v2 |
| group_id | text | WhatsApp group JID |
| message_text | text | What to remind |
| send_at | timestamptz | When to fire |
| sent | boolean | Already sent? |
| sent_at | timestamptz | When actually sent |
| reminder_type | text | "user" (future: "briefing", "chore_rotation") |
| reference_id | text | Optional: task/event ID |
| created_at | timestamptz | When created |

**New column needed:** `created_by_phone` (text) — who requested the reminder (for "@name" in the message).

## Classifier Changes

Add `add_reminder` as 11th intent in Haiku classifier:
- Patterns: תזכירי, תזכיר, תזכרו, remind me, reminder, בעוד X דקות, תעירי אותי
- Confidence typically high (explicit request)

## Sonnet Reply Generator Changes

When intent = `add_reminder`, Sonnet extracts structured data:
```json
{
  "reminder_text": "לאסוף את הילדים",
  "send_at": "2026-04-08T16:00:00+03:00",
  "mentioned_person": "גור" // optional
}
```

**Timezone:** Always Israel (Asia/Jerusalem, UTC+3 / UTC+2 DST). All times interpreted as Israel time.

## Cron Job

- **Extension:** pg_cron + pg_net (both available, need enabling)
- **Schedule:** Every 1 minute
- **Query:** `SELECT * FROM reminder_queue WHERE sent = false AND send_at <= now()`
- **Action:** HTTP POST to Whapi API (send text to group_id)
- **Cleanup:** Mark sent = true, sent_at = now()
- **Safety:** Skip reminders older than 24 hours (stale)

## 1:1 Handling

When reminder detected in 1:1 (direct message):
1. Look up user's household via `whatsapp_member_mapping`
2. If found: create reminder targeting the group, confirm with "התזכורת תישלח בקבוצה"
3. If not found: tell user to add Sheli to group first

## Edge Cases

- **No time specified:** "תזכירי לקנות חלב" → ask "מתי לתזכיר?"
- **Past time:** "ב-8" when it's 10am → interpret as tomorrow 08:00
- **Vague time:** "בערב" → 19:00, "בצהריים" → 12:00, "בבוקר" → 08:00
- **Cancel:** "תבטלי את התזכורת" → mark sent = true (skip it)
- **List:** "מה התזכורות שלי?" → show pending reminders

## Implementation Steps

1. Enable pg_cron + pg_net extensions
2. Add `created_by_phone` column to reminder_queue
3. Add `add_reminder` intent to Haiku classifier
4. Add reminder extraction to Sonnet reply generator
5. Add reminder action to action executor
6. Create pg_cron job (every minute, fire due reminders via Whapi)
7. Handle 1:1 reminder requests
8. Handle cancel/list commands
