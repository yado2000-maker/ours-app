# Override Detection + instruct_bot Intent — Design Doc

**Date:** 2026-04-09
**Status:** Approved
**Trigger:** Goldberg family messages that Sheli missed — override phrasings classified as `ignore`, explanatory messages teaching Sheli how to manage rotations went unrecognized.

## Problem 1: Override Detection

Messages like "היום גילעד בתורות למקלחת" should override the current rotation pointer but were classified as `ignore`. The classifier doesn't recognize override phrasings when an active rotation exists.

### Fix

**Classifier prompt additions:**
- Add override patterns: "[person] בתורות ל[activity]", "היום [person] ב[activity]", "[person] [activity] היום", "[person] ראשון ב[activity] היום"
- All turn synonyms treated equally: תור, תורות, תורנות, תורן
- Classifier already sees ACTIVE ROTATIONS in context — when person + activity matches an active rotation + "היום", classify as override
- New entity: `override: { title: string, person: string }`

**haikuEntitiesToActions:**
- When `e.override` exists, produce `override_rotation` action (executor already implemented)

**Examples to add:**
```
[אמא]: "היום גילעד בתורות למקלחת" → override
[אבא]: "היום אביב שוטף כלים" → override (when rotation exists for כלים)
[אמא]: "גילעד ראשון במקלחת היום" → override
[אבא]: "אביב תורן כלים היום" → override
```

## Problem 2: Explanatory Messages → `instruct_bot` Intent

Messages like "ככה יום אביב יום גילעד" or the frustrated "אבל את אמורה לנהל את התורות — אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד" are the parent *teaching* Sheli a rule. Not a command, not social chatter — an instruction.

### New Intent: `instruct_bot`

**Definition:** Parent explaining a rule, pattern, or management preference to Sheli. Conversational/explanatory tone rather than direct command.

**Distinguishing signals:**
- Conversational tone: "ככה", "כזה", "אמורה ל", "צריך לנהל את זה ככה ש..."
- Past tense: "אמרתי ש...", "הסברתי ש..."
- Frustration/repetition: "אבל את אמורה ל...", "שוב, ..."
- Clarification: explaining after Sheli didn't act on previous messages

**vs `add_task`:** Direct command format with clear names + activity = `add_task`. Explanatory/teaching phrasing = `instruct_bot`.

### Confirm-then-Act Flow

1. Haiku classifies as `instruct_bot` (confidence >= 0.70)
2. Routed to Sonnet which parses the instruction into a structured action + generates confirmation question
3. Pending action stored in `pending_confirmations` table (NOT executed yet)
4. Sheli replies: "הבנתי! תורות מקלחת: גילעד ← אביב, מתחלפים כל יום. נכון?"
5. Confirmation detection (pre-classifier, regex/keyword — no AI cost):
   - Affirmative (כן, נכון, בדיוק, יאללה, אוקי, ok, 👍, כמובן, מדויק, yes) → execute, mark `confirmed`
   - Negative (לא, לא נכון, טעות, הפוך, שגוי, no) → mark `rejected`, Sheli asks for clarification
   - Unrelated message → leave pending, continue normal classification
6. Auto-confirm: if no reply within 3 hours, execute automatically (pg_cron or pg_net check)

### New Table: `pending_confirmations`

```sql
CREATE TABLE pending_confirmations (
  id              text PRIMARY KEY,
  household_id    text NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  group_id        text NOT NULL,
  action_type     text NOT NULL,       -- "create_rotation", "override_rotation", etc.
  action_data     jsonb NOT NULL,      -- full action payload to execute
  confirmation_text text NOT NULL,     -- what Sheli asked
  created_by      text,                -- sender name
  expires_at      timestamptz NOT NULL, -- created_at + 3 hours
  status          text NOT NULL DEFAULT 'pending', -- pending | confirmed | expired | rejected
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pending_confirmations_all" ON pending_confirmations 
  FOR ALL USING (is_household_member(household_id));
```

### Sonnet Extraction for `instruct_bot`

Reply generator receives special action summary:
```
The user is explaining a rule/pattern to Sheli: "{raw_text}".
Parse this into a structured action. If it describes a rotation, extract rotation entity.
Reply with a confirmation question in Hebrew — be specific about what you understood.
Include hidden <!--PENDING_ACTION:{"action_type":"create_rotation","action_data":{...}}--> block.
```

Sonnet returns visible confirmation text + hidden action payload (same pattern as reminder extraction).

### Confirmation pre-classifier check

In the webhook handler, BEFORE Haiku classification:
1. Check `pending_confirmations` for this group where `status = 'pending'` and `expires_at > now()`
2. If exists and message matches affirmative pattern → execute action, reply "מעולה, סידרתי! ✓", return
3. If exists and message matches negative pattern → mark rejected, reply asking for clarification, return
4. Otherwise → continue normal Haiku classification

### Auto-confirm via pg_cron

Add to existing `fire-reminders` cron job (runs every minute):
```sql
-- Auto-confirm expired pending confirmations
UPDATE pending_confirmations 
SET status = 'expired' 
WHERE status = 'pending' AND expires_at < now();
```

For each expired row, fire the action via `pg_net` HTTP POST (same pattern as reminders) or handle in the next webhook call.

**Simpler alternative:** Check in webhook handler — if a pending confirmation is past `expires_at`, execute it on the next message from that group. Avoids pg_net complexity. Downside: won't fire if the group is quiet, but that's acceptable — if nobody is chatting, the rotation setup can wait.

**Recommendation:** Simpler alternative (check in webhook handler). Add pg_cron later if needed.

### Stream B Family Learning Integration

When a confirmed `instruct_bot` action creates a rotation, also log the pattern in `household_patterns`:
- `pattern_type: "rotation_preference"`
- `pattern_key: rotation title`
- `pattern_value: description of the rule ("daily alternating shower turns")`

This feeds into the FAMILY PATTERNS section in future classifier prompts, so Sheli remembers the family's preferences even if the rotation is deleted and recreated.

## Files to Change

1. **DB migration** — `pending_confirmations` table
2. **index.inlined.ts** — ClassificationOutput (add `override` entity + `instruct_bot` intent), classifier prompt (override patterns, turn synonyms, instruct_bot intent + examples), haikuEntitiesToActions (override entity routing), webhook handler (confirmation pre-check), reply generator (instruct_bot action summary with hidden PENDING_ACTION block), pending confirmation executor
3. **_shared/ files** — mirror classifier + reply generator changes
4. **tests/classifier-test-cases.ts** — override + instruct_bot test cases
