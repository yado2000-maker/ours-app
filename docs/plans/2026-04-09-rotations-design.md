# Rotations / Turns System — Design Doc

**Date:** 2026-04-09
**Status:** Approved
**Trigger:** Goldberg family trying to set shower turns for kids — Sheli didn't understand

## Problem

Families assign recurring duties and ordering (shower turns, dishes, laundry, trash) to kids. Sheli has no concept of rotation — can only create one-off tasks. Parents want to say "תורות מקלחת: דניאל, נועה, יובל" and have Sheli track whose turn it is, auto-advance, and answer "מי בתור?"

## Two Rotation Types

### Order Rotation (e.g. shower — who goes first)
- **Purpose:** Determines sequence, not responsibility. Everyone showers — the question is who goes first.
- **Advances:** By calendar day, regardless of completion.
- **Materializes as:** Event in schedule. Not in task list (nothing to mark done).
- **Frequency:** Always daily (implicit).
- **Lookahead:** Full week computable via index math.

### Duty Rotation (e.g. dishes, laundry, trash)
- **Purpose:** Assigns responsibility. One person does the chore.
- **Advances:** When the generated task is marked done. Same person stays on duty until completed.
- **Materializes as:** Task in task list AND schedule.
- **Frequency:** Optional. `null` = on-demand (family decides when it needs doing). Can also be `daily`, `interval` (every N days), or `weekly` (specific days).
- **Lookahead:** Today only (future depends on completion). Schedule shows projected assignments for future days.

### Assignment Mode
- **Beta:** Auto-assign only. Sheli creates tasks pre-assigned to the current person.
- **Future:** "Suggest" mode for teenagers — Sheli announces whose turn it is but task is unassigned until someone claims it.

## Data Model

### New table: `rotations`

```sql
CREATE TABLE rotations (
  id              text PRIMARY KEY,
  household_id    text NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  title           text NOT NULL,
  type            text NOT NULL CHECK (type IN ('order', 'duty')),
  members         jsonb NOT NULL,  -- ["דניאל", "נועה", "יובל"]
  current_index   integer NOT NULL DEFAULT 0,
  frequency       jsonb,           -- null | {"type":"daily"} | {"type":"interval","days":3} | {"type":"weekly","days":["sun","wed"]}
  active          boolean NOT NULL DEFAULT true,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- RLS: is_household_member(household_id)
-- Realtime: ALTER PUBLICATION supabase_realtime ADD TABLE public.rotations;
```

### Altered tables

```sql
ALTER TABLE tasks ADD COLUMN rotation_id text REFERENCES rotations(id);
ALTER TABLE events ADD COLUMN rotation_id text REFERENCES rotations(id);
```

### `current_index` semantics

- `members[current_index]` = whose turn it is today (or currently, for on-demand duty).
- Order rotations: `current_index` advances once daily on first materialization of new day.
- Duty rotations: `current_index` advances when the task with matching `rotation_id` is marked done.
- Override sets `current_index` to the named person's position in the array.

## WhatsApp Bot Integration

### Classifier changes

Rotation keywords added to Haiku classifier prompt: "תור/תורות" (turns), "סדר" (order), "סבב/תורנות" (rotation/duty).

Classifier output adds `rotation` entity:
```json
{
  "intent": "add_task",
  "confidence": 0.92,
  "entities": {
    "rotation": {
      "title": "מקלחת",
      "type": "order",
      "members": ["דניאל", "נועה", "יובל"]
    },
    "raw_text": "תורות מקלחת: דניאל ראשון, נועה, יובל"
  }
}
```

Type detection heuristics:
- Sequencing activities (מקלחת, אמבטיה) → `order`
- Chores (כלים, כביסה, זבל, ניקיון, סידור) → `duty`
- Ambiguous → default to `duty`

### New action types

**`create_rotation`** — Insert into `rotations` table. Reply: "סידרתי תורנות כלים: דניאל ← נועה ← יובל. היום תור של דניאל"

**`override_rotation`** — Update `current_index` for matching rotation. Reply: "עדכנתי — היום יובל שוטף כלים"

### Existing intents enhanced

**`question` ("מי בתור למקלחת?")** — Active rotations injected into Sonnet reply context:
```
ACTIVE ROTATIONS:
• מקלחת (order): דניאל ← נועה ← יובל (today: דניאל)
• כלים (duty): נועה ← יובל ← דניאל (today: נועה, not done)
```

**`add_task` on-demand duty** — When someone says "צריך לשטוף כלים" and a duty rotation exists for "כלים", materialize a task assigned to the current person instead of creating an unassigned task.

**`complete_task` for rotation task** — When a task with `rotation_id` is marked done, advance `current_index = (current_index + 1) % members.length`.

## Materialization Logic

### Trigger points
1. WhatsApp: someone asks "מי בתור?" or mentions a rotation activity
2. WhatsApp: duty frequency triggers (daily/interval/weekly schedule via pg_cron)
3. Web app: WeekView renders current week

### `materializeRotation(rotation, date)`
1. Dedup: check if task/event with this `rotation_id` exists for today → skip if yes
2. For ORDER: calculate `index = (current_index + dayOffset) % members.length`, INSERT event
3. For DUTY: INSERT task with `assigned_to = members[current_index]`, `rotation_id`

### Order rotation day offset
Schedule can show full week without advancing the pointer:
```
Day 0 (today, index=0): דניאל
Day 1 (tomorrow):       נועה   (index+1) % 3
Day 2:                  יובל   (index+2) % 3
```
`current_index` advances once daily on first materialization of new day.

### Duty rotation frequency scheduling
For rotations with `frequency`:
- `daily`: pg_cron job at 07:00 IST materializes today's task
- `interval`: pg_cron checks `last materialized + N days <= today`
- `weekly`: pg_cron checks if today's day-of-week is in the list
- `null` (on-demand): no auto-materialization, only when family mentions it

## Web App Changes

### WeekView (schedule)
- New function `getRotationWeek(householdId, startOfWeek, endOfWeek)` computes rotation entries
- Order rotations: all 7 days computed (pure math)
- Duty rotations: today = actual assignment, future = projected (assumes timely completion)
- Rendered as "virtual events" merged into existing calendar, with a small rotation icon or badge
- No new Realtime channel needed — materialized tasks/events use existing subscriptions

### TasksView (task list)
- Duty rotation tasks appear as normal tasks (they ARE normal tasks, just with `rotation_id`)
- Marking done triggers rotation advance (handled in `toggleTask` or via Realtime + DB trigger)

### No new screens
- No rotation management UI for beta
- WhatsApp creates/manages rotations
- Web displays results in existing views

## Task completion → rotation advance

Two paths for advancing duty rotations on completion:

1. **WhatsApp:** `complete_task` action executor checks `rotation_id`, advances `current_index`
2. **Web app:** `toggleTask()` marks done → need to also advance rotation. Options:
   - (a) DB trigger on tasks update where `done=true AND rotation_id IS NOT NULL`
   - (b) Client-side: after `saveTask`, call `advanceRotation(rotation_id)`

**Recommendation:** DB trigger (option a) — single source of truth, works for both WhatsApp and web.

## Rollback of earlier multi-task changes

The `tasks[]` array support added to the classifier earlier in this session should be **replaced** by the `rotation` entity. Multi-task creation from a single message is no longer needed — the rotation system handles "תורות מקלחת: דניאל, נועה, יובל" properly.

However, the **task dedup refinement** (same title + different assignee = not a duplicate) should be **kept** — it's correct independent of rotations.

## Future (not in beta)
- "Suggest" mode for teenagers (claim-based assignment)
- Web UI for managing rotations (edit members, reorder, pause)
- Rotation history/stats ("דניאל שטף כלים 12 פעם החודש")
- Stream A global prompt learning from rotation patterns
