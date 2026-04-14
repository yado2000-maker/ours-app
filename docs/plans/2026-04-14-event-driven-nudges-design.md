# Event-Driven Onboarding Nudges

## Problem
Current nudge system fires 3 cron jobs/day (09:00, 12:30, 21:00) with generic feature-tip copy. 0% response rate across all users. The messages are informational ("ידעתם שאם כותבים לי...") and give users no reason to reply.

## Design
Replace timer-based nudges with **contextual nudges tied to real calendar moments**. Each message has a built-in reason ("מחר שישי", "שבוע חדש") and ends with a one-answer question.

**Goals:**
1. Get users to **perform one more action** (prove value)
2. Then convert to **family group** (real activation)

## Nudge Triggers

### Weekly triggers

| Trigger | Cron (UTC) | Israel time | Eligible days |
|---------|-----------|-------------|---------------|
| **Thursday pre-Shabbat** | `0 7 * * 4` | Thu 10:00 | Every Thursday |
| **Sunday new week** | `0 5 * * 0` | Sun 08:00 | Every Sunday |
| **Mid-week** | `0 9 * * 2,3` | Tue/Wed 12:00 | Tue or Wed (pick one per user per week) |

### Seasonal triggers (manual or holiday-table driven)

| Trigger | When | Notes |
|---------|------|-------|
| **Erev chag** | Day before major holidays, 10:00 | Rosh Hashana, Pesach, Sukkot, Yom Kippur |
| **Back to school** | Late August / early September | One-time annual |
| **Clock change** | Day of DST switch | Twice per year |

## Message Copy

### Thursday pre-Shabbat (rotate randomly)
- "חמישי שמח! 🛒 צריך שאכין רשימה לסופר למחר?"
- "מחר יום שישי — מה צריך מהסופר?"
- "הסופ\"ש בדרך סוף סוף! מה חסר במקרר? שלחו לי ואני מסדרת את הרשימה לסופר"

### Sunday new week (rotate randomly)
- "שבוע טוב! מה צריך לעשות השבוע? שמחה לעזור 📋"
- "יאללה שבוע חדש — יש משהו שחשוב לא לשכוח?"

### Mid-week (rotate randomly)
- "אמצע שבוע — הכל בשליטה או חסר משהו מהסופר?"
- "בודקת שהכל טוב 😊 צריכים משהו?"

### If user HAS items in DB (override any of the above)
- "יש לכם {N} דברים ברשימה — רוצים להוסיף לפני שיוצאים לסופר?"
- "עוד מעט שישי ויש לכם רשימה פתוחה. חסר משהו?"

### Erev chag
- "ערב חג מחר! צריכים עזרה עם הרשימות? 🕯️"
- "חג בפתח — שולחו לי מה צריך ואני מסדרת"

### Seasonal
- "ספטמבר! 🎒 רוצים שאעזור עם רשימת קניות לפתיחת השנה?"
- "הלילה מזיזים שעון — רוצים שאזכיר?"

## Decay Cadence

| Phase | Duration | Max nudges | Which triggers fire |
|-------|----------|-----------|-------------------|
| **Active** | Days 1-7 since last interaction | Up to 2/week | All weekly triggers |
| **Cooling** | Weeks 2-3 | 1/week | Thu + Sun only |
| **Seasonal** | Week 4+ | Holidays + seasonal only | Erev chag, back-to-school, clock change |

- **No hard goodbye message.** Natural fade to seasonal.
- **Any reply at any phase resets to Active.**
- Quiet hours + Shabbat guard still respected.

## Implementation

### Replace 4 cron jobs with 1

**Delete:** jobs 9, 10, 11, 12 (`fire_onboarding_nudge` calls)

**Add:** 1 daily cron at `0 5 * * *` (08:00 IST):
```sql
SELECT fire_contextual_nudge();
```

### New DB columns on `onboarding_conversations`
- `nudge_phase` — `active` / `cooling` / `seasonal` (default: `active`)
- `last_interaction_at` — timestamp of last USER message (distinct from `updated_at` which nudges also touch)
- `nudges_this_week` — integer, reset every Sunday by the nudge function

### `fire_contextual_nudge()` logic

```
1. Determine today's trigger type (day-of-week → thu/sun/midweek, or holiday lookup)
2. If no trigger applies today → return 0
3. Query eligible users:
   - state IN ('sleeping', 'nudging', 'chatting')
   - last_interaction_at < now() - interval '6 hours' (not actively chatting)
   - Quiet hours / Shabbat check
   - Phase budget check:
     - active (last_interaction < 7d): nudges_this_week < 2
     - cooling (7d-21d): nudges_this_week < 1 AND trigger IN (thu, sun)
     - seasonal (>21d): only holiday/seasonal triggers
4. For each user:
   - Check if they have items in DB → use items-aware copy
   - Else → pick random message from today's trigger pool
   - Send via Whapi
   - Update nudge_count, last_nudge_at, nudges_this_week
5. Return count
```

### State transitions
- `chatting` → `sleeping` (after 3h, existing hourly cron — unchanged)
- `sleeping` → eligible for nudges (existing behavior)
- Any user reply → `last_interaction_at = now()`, `nudge_phase = 'active'`, `nudges_this_week = 0`

### What stays unchanged
- Group nudge ("add Sheli to your family group") — separate mechanism, fires from webhook handler
- `transition_to_sleeping` hourly cron — unchanged
- `fire_due_reminders` every-minute cron — unchanged
- Nudge messages still bypass webhook handler (sent from DB via `net.http_post`)

## Verification
- After deploying, check `SELECT * FROM cron.job` — should have 1 nudge job, not 4
- On Thursday, verify eligible users get the pre-Shabbat nudge
- Confirm `nudges_this_week` resets on Sunday
- Confirm any user reply resets phase to active
- Confirm quiet hours / Shabbat still blocks nudges
