# Rotations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let families define recurring turn-based chores and ordering (shower turns, dishes, laundry) that auto-assign and track whose turn it is.

**Architecture:** New `rotations` table stores rotation definitions. Bot detects rotation intent, creates/queries rotations. Materialized as real tasks (duty) or events (order) via on-demand logic. DB trigger advances duty rotations on completion.

**Tech Stack:** Supabase (Postgres, RLS, pg triggers), Deno Edge Function (TypeScript), React (Vite), existing Haiku/Sonnet pipeline.

**Design doc:** `docs/plans/2026-04-09-rotations-design.md`

---

### Task 1: Create `rotations` table + alter tasks/events

**Files:**
- Create migration via Supabase MCP tool

**Step 1: Run migration**

```sql
-- Create rotations table
CREATE TABLE rotations (
  id              text PRIMARY KEY,
  household_id    text NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  title           text NOT NULL,
  type            text NOT NULL CHECK (type IN ('order', 'duty')),
  members         jsonb NOT NULL,
  current_index   integer NOT NULL DEFAULT 0,
  frequency       jsonb,
  active          boolean NOT NULL DEFAULT true,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Add rotation_id to tasks and events
ALTER TABLE tasks ADD COLUMN rotation_id text REFERENCES rotations(id);
ALTER TABLE events ADD COLUMN rotation_id text REFERENCES rotations(id);

-- RLS policies (same pattern as other tables)
ALTER TABLE rotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rotations_select" ON rotations FOR SELECT USING (is_household_member(household_id));
CREATE POLICY "rotations_insert" ON rotations FOR INSERT WITH CHECK (is_household_member(household_id));
CREATE POLICY "rotations_update" ON rotations FOR UPDATE USING (is_household_member(household_id));
CREATE POLICY "rotations_delete" ON rotations FOR DELETE USING (is_household_member(household_id));

-- Service role bypass for Edge Function
-- (Edge Function uses service_role key, bypasses RLS)

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.rotations;

-- Index for common queries
CREATE INDEX idx_rotations_household ON rotations(household_id) WHERE active = true;
CREATE INDEX idx_tasks_rotation ON tasks(rotation_id) WHERE rotation_id IS NOT NULL;
CREATE INDEX idx_events_rotation ON events(rotation_id) WHERE rotation_id IS NOT NULL;
```

**Step 2: Create DB trigger for duty rotation advance**

```sql
-- When a task with rotation_id is marked done, advance the rotation pointer
CREATE OR REPLACE FUNCTION advance_duty_rotation()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire when task goes from not-done to done, and has a rotation_id
  IF NEW.done = true AND (OLD.done = false OR OLD.done IS NULL) AND NEW.rotation_id IS NOT NULL THEN
    UPDATE rotations
    SET current_index = (current_index + 1) % jsonb_array_length(members)
    WHERE id = NEW.rotation_id
      AND type = 'duty'
      AND active = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_advance_duty_rotation
  AFTER UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION advance_duty_rotation();
```

**Step 3: Verify migration**

Run via Supabase MCP: `list_tables` to confirm `rotations` table exists.
Run: `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'rotation_id'` to confirm column added.

**Step 4: Commit**

Update CLAUDE.md database schema section to document `rotations` table and new columns.

---

### Task 2: Rollback earlier multi-task changes, keep dedup fix

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:93` (remove `tasks?` from interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:493-496` (remove turn patterns that reference tasks array)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:545-548` (remove tasks[] examples)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:580` (remove tasks[] JSON rule)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:688-695` (remove multi-task reply summary)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:3325-3333` (remove tasks[] loop in haikuEntitiesToActions)
- Modify: `supabase/functions/_shared/haiku-classifier.ts` (same rollbacks)
- Modify: `supabase/functions/_shared/action-executor.ts` (keep dedup fix only)
- Modify: `supabase/functions/_shared/reply-generator.ts` (same rollbacks)

**Step 1: Remove `tasks[]` from ClassificationOutput interface**

In `index.inlined.ts:93`, remove:
```typescript
    tasks?: Array<{ title: string; person?: string }>;
```

In `_shared/haiku-classifier.ts:22`, remove same line.

**Step 2: Rewrite turn patterns in classifier prompt to use `rotation` entity instead of `tasks[]`**

Replace the turn-related patterns (lines ~493-496) and examples (lines ~545-548) — these will be rewritten in Task 3 with the `rotation` entity format.

**Step 3: Revert multi-task reply summary**

In `index.inlined.ts` reply generator (~line 688) and `_shared/reply-generator.ts`, revert `case "add_task":` to original single-task form:
```typescript
    case "add_task":
      actionSummary = `A task was just created: "${e.title || e.raw_text}"${e.person ? ` assigned to ${e.person}` : ""}.`;
      break;
```

**Step 4: Revert haikuEntitiesToActions**

In `index.inlined.ts` (~line 3325) and keep only the single-task path:
```typescript
    case "add_task":
      actions.push({
        type: "add_task",
        data: { title: e.title || e.raw_text, assigned_to: e.person || null },
      });
      break;
```

**Step 5: Keep dedup fix**

The task dedup refinement (same title + different assignee = not duplicate) in both `index.inlined.ts` and `_shared/action-executor.ts` stays — it's correct for rotation-generated tasks.

**Step 6: Commit**

```
git commit -m "refactor: rollback multi-task array, prepare for rotation entity"
```

---

### Task 3: Add `rotation` entity to classifier + new action types

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:74` (ClassificationOutput interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:422` (buildClassifierPrompt)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:3320` (haikuEntitiesToActions)
- Modify: `supabase/functions/_shared/haiku-classifier.ts`

**Step 1: Add `rotation` to ClassificationOutput interface**

In `index.inlined.ts` at the `entities` block (~line 91), add:

```typescript
    rotation?: {
      title: string;
      type: "order" | "duty";
      members: string[];
      frequency?: { type: "daily" } | { type: "interval"; days: number } | { type: "weekly"; days: string[] };
    };
```

Same change in `_shared/haiku-classifier.ts`.

**Step 2: Add rotation patterns + examples to Haiku classifier prompt**

In `buildClassifierPrompt` (~line 491), add after the reminder pattern:

```
- "תור/תורות" (turns), "סדר" (order), "סבב/תורנות" (duty rotation) = add_task with rotation entity
- ROTATION DETECTION: when message names an activity + multiple people in sequence, create a rotation:
  - Ordering activities (מקלחת, אמבטיה, shower) → type "order" (who goes first, advances daily)
  - Chore activities (כלים, כביסה, זבל, ניקיון, dishes, laundry, trash) → type "duty" (whose job, advances on completion)
  - When ambiguous, default to "duty"
- "מי בתור ל...?" = question (about existing rotation)
- Override: "[person] [activity] היום" when rotation exists = add_task with override intent
```

Add examples after existing examples:

```
[אמא]: "תורות מקלחת: דניאל ראשון, נועה, יובל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["דניאל","נועה","יובל"]},"raw_text":"תורות מקלחת: דניאל ראשון, נועה, יובל"}}
[אבא]: "תורנות כלים: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"כלים","type":"duty","members":["נועה","יובל","דניאל"]},"raw_text":"תורנות כלים: נועה, יובל, דניאל"}}
[אמא]: "סדר מקלחות: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["נועה","יובל","דניאל"]},"raw_text":"סדר מקלחות: נועה, יובל, דניאל"}}
[אבא]: "כל יום שני ורביעי תורנות כביסה: דניאל, נועה" → {"intent":"add_task","confidence":0.90,"entities":{"rotation":{"title":"כביסה","type":"duty","members":["דניאל","נועה"],"frequency":{"type":"weekly","days":["mon","wed"]}},"raw_text":"כל יום שני ורביעי תורנות כביסה: דניאל, נועה"}}
[אבא]: "מי בתור למקלחת?" → {"intent":"question","confidence":0.90,"entities":{"raw_text":"מי בתור למקלחת?"}}
[אמא]: "היום יובל שוטף כלים" → (if rotation for כלים exists) override, otherwise regular add_task
```

Add JSON output rule (~line 580):

```
- For add_task with ROTATION (turns/duty for multiple people): include "rotation" object with title, type ("order"|"duty"), members array (preserve order), and optional frequency. Do NOT use title/person fields when rotation is present.
```

**Step 3: Add `create_rotation` and `override_rotation` to haikuEntitiesToActions**

In `haikuEntitiesToActions` (~line 3320), modify the `add_task` case:

```typescript
    case "add_task":
      // Check for rotation entity first
      if (e.rotation) {
        actions.push({
          type: "create_rotation",
          data: {
            title: e.rotation.title,
            rotation_type: e.rotation.type,
            members: e.rotation.members,
            frequency: e.rotation.frequency || null,
          },
        });
      } else {
        actions.push({
          type: "add_task",
          data: { title: e.title || e.raw_text, assigned_to: e.person || null },
        });
      }
      break;
```

**Step 4: Commit**

```
git commit -m "feat: add rotation entity to classifier + action types"
```

---

### Task 4: Implement `create_rotation` and `override_rotation` in action executor

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:1201` (executeActions)
- Modify: `supabase/functions/_shared/action-executor.ts`

**Step 1: Add `create_rotation` handler in executeActions**

After the existing action cases (~line 1370), add:

```typescript
        case "create_rotation": {
          const { title, rotation_type, members, frequency } = action.data as {
            title: string;
            rotation_type: "order" | "duty";
            members: string[];
            frequency?: object;
          };

          // Dedup: check if active rotation with same title exists
          const { data: existingRotations } = await supabase
            .from("rotations")
            .select("id, title, members, type")
            .eq("household_id", householdId)
            .eq("active", true);

          const rotMatch = (existingRotations || []).find((r: any) =>
            r.title.trim().toLowerCase() === title.trim().toLowerCase()
          );

          if (rotMatch) {
            // Update existing rotation (new members/type)
            const { error } = await supabase.from("rotations")
              .update({ members: JSON.stringify(members), type: rotation_type, frequency: frequency ? JSON.stringify(frequency) : null, current_index: 0 })
              .eq("id", rotMatch.id);
            if (error) throw error;
            summary.push(`Rotation-updated: "${title}" (${members.join(" ← ")})`);
          } else {
            const { error } = await supabase.from("rotations").insert({
              id: uid4() + uid4(),  // 8-char
              household_id: householdId,
              title,
              type: rotation_type,
              members: JSON.stringify(members),
              current_index: 0,
              frequency: frequency ? JSON.stringify(frequency) : null,
              active: true,
            });
            if (error) throw error;
            summary.push(`Rotation: "${title}" (${rotation_type}) → ${members.join(" ← ")}`);
          }
          break;
        }

        case "override_rotation": {
          const { title, person } = action.data as { title: string; person: string };

          const { data: rotations } = await supabase
            .from("rotations")
            .select("id, members, type")
            .eq("household_id", householdId)
            .eq("active", true);

          const rot = (rotations || []).find((r: any) =>
            r.title.trim().toLowerCase() === title.trim().toLowerCase()
          );

          if (rot) {
            const members = typeof rot.members === "string" ? JSON.parse(rot.members) : rot.members;
            const idx = members.findIndex((m: string) => m === person);
            if (idx >= 0) {
              const { error } = await supabase.from("rotations")
                .update({ current_index: idx })
                .eq("id", rot.id);
              if (error) throw error;
              summary.push(`Rotation-override: "${title}" → ${person}`);
            } else {
              summary.push(`Rotation-override-failed: "${person}" not in rotation "${title}"`);
            }
          } else {
            summary.push(`Rotation-not-found: "${title}"`);
          }
          break;
        }
```

**Step 2: Add `create_rotation` reply summary in buildReplyPrompt**

In the reply generator (~line 687), add a new case before the default:

```typescript
    case "add_task":
      if (e.rotation) {
        const membersList = e.rotation.members.join(" ← ");
        const typeLabel = e.rotation.type === "order" ? "סדר" : "תורנות";
        actionSummary = `A rotation was created: "${e.rotation.title}" (${typeLabel}). Members in order: ${membersList}. First turn: ${e.rotation.members[0]}. Reply should confirm the rotation and announce whose turn it is today.`;
      } else {
        actionSummary = `A task was just created: "${e.title || e.raw_text}"${e.person ? ` assigned to ${e.person}` : ""}.`;
      }
      break;
```

**Step 3: Same changes in `_shared/action-executor.ts` and `_shared/reply-generator.ts`**

Mirror all changes in the modular reference files.

**Step 4: Commit**

```
git commit -m "feat: implement create_rotation + override_rotation in action executor"
```

---

### Task 5: Inject rotation state into question/reply context

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:3298` (buildReplyCtx)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:735` (question state context)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:422` (buildClassifierPrompt — add rotations to OPEN TASKS section)

**Step 1: Fetch rotations in buildReplyCtx**

In `buildReplyCtx` (~line 3302), add rotations to the parallel query:

```typescript
  const [membersRes, tasksRes, shoppingRes, eventsRes, rotationsRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to, done").eq("household_id", householdId),
    supabase.from("shopping_items").select("id, name, qty, got").eq("household_id", householdId),
    supabase.from("events").select("id, title, assigned_to, scheduled_for").eq("household_id", householdId)
      .gte("scheduled_for", new Date().toISOString()),
    supabase.from("rotations").select("id, title, type, members, current_index, frequency")
      .eq("household_id", householdId).eq("active", true),
  ]);
```

Add `currentRotations` to the return value and the `ReplyContext` interface.

**Step 2: Add rotation state to question reply context**

In the question state context block (~line 735), add:

```typescript
    // Add rotation state
    const rotations = ctx.currentRotations || [];
    const rotationStr = rotations.length === 0 ? "(none)" : rotations.map((r: any) => {
      const members = typeof r.members === "string" ? JSON.parse(r.members) : r.members;
      const current = members[r.current_index] || members[0];
      const typeLabel = r.type === "order" ? "סדר" : "תורנות";
      return `${r.title} (${typeLabel}): ${members.join(" ← ")} (today: ${current})`;
    }).join("\n");

    stateContext += `\nActive rotations: ${rotationStr}`;
```

**Step 3: Add rotation context to classifier prompt**

In `buildClassifierPrompt` (~line 475), after SHOPPING LIST section, add:

```typescript
  // Fetch and format rotation state for classifier
  const rotationsStr = ctx.activeRotations
    ? ctx.activeRotations.length === 0
      ? "(none)"
      : ctx.activeRotations.map(r => {
          const current = r.members[r.current_index] || r.members[0];
          return `• ${r.title} (${r.type}): ${r.members.join(" ← ")} (current: ${current})`;
        }).join("\n")
    : "(none)";
```

Add to prompt string after SHOPPING LIST:
```
ACTIVE ROTATIONS:
${rotationsStr}
```

Update `ClassifierContext` interface to include `activeRotations`.

**Step 4: Fetch rotations in classifier context builder**

In the function that builds classifier context (~line 3270), add rotation fetch to the parallel query:

```typescript
    supabase.from("rotations").select("id, title, type, members, current_index")
      .eq("household_id", householdId).eq("active", true),
```

Parse `members` JSONB and pass as `activeRotations` in context.

**Step 5: Commit**

```
git commit -m "feat: inject rotation state into classifier + reply context"
```

---

### Task 6: On-demand materialization for duty rotations

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (new function + integration in add_task flow)

**Step 1: Add `materializeRotation` function**

Add new helper function after `haikuEntitiesToActions`:

```typescript
async function materializeDutyRotation(
  householdId: string,
  rotation: { id: string; title: string; members: any; current_index: number }
): Promise<{ taskId: string; assignedTo: string } | null> {
  const members = typeof rotation.members === "string" ? JSON.parse(rotation.members) : rotation.members;
  const assignedTo = members[rotation.current_index] || members[0];

  // Dedup: check if a task for this rotation already exists today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: existing } = await supabase
    .from("tasks")
    .select("id")
    .eq("household_id", householdId)
    .eq("rotation_id", rotation.id)
    .eq("done", false);

  if (existing && existing.length > 0) {
    return null; // Already materialized and not done
  }

  const taskId = Math.random().toString(36).slice(2, 10);
  const { error } = await supabase.from("tasks").insert({
    id: taskId,
    household_id: householdId,
    title: rotation.title,
    assigned_to: assignedTo,
    done: false,
    rotation_id: rotation.id,
  });

  if (error) {
    console.error("[Rotation] Materialize error:", error);
    return null;
  }
  return { taskId, assignedTo };
}
```

**Step 2: Integrate with on-demand add_task flow**

In `executeActions`, in the `add_task` case (~line 1211), before creating a new task, check if a matching rotation exists:

```typescript
        case "add_task": {
          const { title, assigned_to } = action.data as { title: string; assigned_to?: string };

          // Check if this task matches an active duty rotation
          const { data: matchingRotation } = await supabase
            .from("rotations")
            .select("id, title, type, members, current_index")
            .eq("household_id", householdId)
            .eq("active", true)
            .eq("type", "duty");

          const rotMatch = (matchingRotation || []).find((r: any) =>
            r.title.trim().toLowerCase() === title.trim().toLowerCase()
          );

          if (rotMatch) {
            // Materialize from rotation instead of creating standalone task
            const result = await materializeDutyRotation(householdId, rotMatch);
            if (result) {
              summary.push(`Task: "${title}" → ${result.assignedTo} (rotation)`);
            } else {
              summary.push(`Task-exists: "${title}" (rotation, not yet done)`);
            }
            break;
          }

          // ... existing dedup + insert logic ...
```

**Step 3: Commit**

```
git commit -m "feat: on-demand materialization for duty rotations"
```

---

### Task 7: Web app — load rotations + show in WeekView

**Files:**
- Modify: `src/lib/supabase.js:36` (loadHousehold — add rotations fetch)
- Modify: `src/App.jsx:264` (add Realtime channel for rotations)
- Modify: `src/App.jsx:418` (toggleTask — no change needed, DB trigger handles advance)
- Modify: `src/components/WeekView.jsx:3` (add rotation entries to schedule)

**Step 1: Add `loadRotations` to supabase.js and include in loadHousehold**

In `supabase.js`, add to the `loadHousehold` parallel query (~line 37):

```javascript
    supabase.from("rotations").select("*").eq("household_id", hhId).eq("active", true),
```

Add to return object:
```javascript
    rotations: (rotationsRes.data || []).map(r => ({
      ...r,
      members: typeof r.members === "string" ? JSON.parse(r.members) : r.members,
      frequency: r.frequency && typeof r.frequency === "string" ? JSON.parse(r.frequency) : r.frequency,
    })),
```

**Step 2: Add Realtime channel for rotations**

In `App.jsx` (~line 270), add after existing channels:

```javascript
    const ch6 = supabase.channel(`rotations-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rotations", filter: `household_id=eq.${hhId}` }, reloadRotations)
      .subscribe();
```

Add `reloadRotations` function and `rotations` state. Add `ch6` to cleanup.

**Step 3: Compute rotation schedule in WeekView**

In `WeekView.jsx`, add a new prop `rotations` and compute weekly entries:

```javascript
export default function WeekView({ tasks, events, rotations, t, lang, onDeleteEvent }) {
  // ... existing code ...

  // Compute rotation entries for the week
  (rotations || []).forEach(rot => {
    const members = rot.members;
    const baseIndex = rot.current_index || 0;

    days.forEach((day, dayIdx) => {
      // For order rotations: compute daily rotation offset from today
      if (rot.type === "order") {
        const todayIdx = days.findIndex(d => d.toDateString() === new Date().toDateString());
        const offset = dayIdx - (todayIdx >= 0 ? todayIdx : 0);
        const memberIdx = ((baseIndex + offset) % members.length + members.length) % members.length;
        const d = day.getDay();
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push({
          id: `rot-${rot.id}-${dayIdx}`,
          title: rot.title,
          assignedTo: members[memberIdx],
          scheduledFor: day.toISOString(),
          _type: "rotation-order",
        });
      }

      // For duty rotations with frequency: only show if schedule matches
      if (rot.type === "duty" && rot.frequency) {
        let showDay = false;
        if (rot.frequency.type === "daily") showDay = true;
        if (rot.frequency.type === "weekly") {
          const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
          showDay = rot.frequency.days.includes(dayNames[day.getDay()]);
        }
        // interval type: more complex, skip for now (future)

        if (showDay) {
          const todayIdx = days.findIndex(d => d.toDateString() === new Date().toDateString());
          const offset = dayIdx - (todayIdx >= 0 ? todayIdx : 0);
          const memberIdx = ((baseIndex + offset) % members.length + members.length) % members.length;
          const d = day.getDay();
          if (!byDay[d]) byDay[d] = [];
          byDay[d].push({
            id: `rot-${rot.id}-${dayIdx}`,
            title: rot.title,
            assignedTo: members[memberIdx],
            scheduledFor: day.toISOString(),
            _type: "rotation-duty",
          });
        }
      }
    });
  });
```

Render rotation chips with a small rotation icon/badge (e.g. a circular arrow or different color):

```jsx
{item._type === "rotation-order" || item._type === "rotation-duty" ? (
  <>
    {item.assignedTo && <div className="week-task-who">{item.assignedTo}</div>}
    <div className="week-task-time" style={{color: "var(--accent)", fontSize: 10}}>
      {item._type === "rotation-order" ? "סדר" : "תורנות"}
    </div>
  </>
) : /* existing rendering */ }
```

**Step 4: Pass rotations to WeekView from App.jsx**

Where WeekView is rendered (~line 814), add `rotations={rotations}` prop.

**Step 5: Commit**

```
git commit -m "feat: load rotations in web app, show in WeekView schedule"
```

---

### Task 8: Add rotation patterns to Sonnet fallback prompt

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:961` (hebrewPatterns in Sonnet prompt)

**Step 1: Add turn pattern to Sonnet fallback**

In the `hebrewPatterns` section (~line 961), add as pattern 8 (renumber existing 8→9):

```
8. TURNS/ROTATION: "תורות מקלחת: דניאל, נועה, יובל" = create rotation (add_task with rotation entity).
   "תור של דניאל למקלחת" = single task or query. "מי בתור ל...?" = question about rotation.
   "תורנות כלים" = duty rotation (chore). "סדר מקלחות" = order rotation (sequence).
```

**Step 2: Commit**

```
git commit -m "feat: add rotation patterns to Sonnet fallback classifier"
```

---

### Task 9: Add test cases for rotation classification

**Files:**
- Modify: `tests/classifier-test-cases.ts`

**Step 1: Replace the 4 multi-task test cases with rotation-specific ones**

Replace the turn/rotation section at end of `ADD_TASK_CASES` with:

```typescript
  // ─── Rotation patterns ───
  {
    input: "תורות מקלחת: דניאל ראשון, נועה, יובל",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "מקלחת", type: "order", members: ["דניאל", "נועה", "יובל"] } },
    notes: "Order rotation — shower turns for 3 kids",
  },
  {
    input: "תורנות כלים: נועה, יובל, דניאל",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "כלים", type: "duty", members: ["נועה", "יובל", "דניאל"] } },
    notes: "Duty rotation — dishes chore",
  },
  {
    input: "סדר מקלחות: נועה, יובל, דניאל",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "מקלחת", type: "order", members: ["נועה", "יובל", "דניאל"] } },
    notes: "Order rotation — alternative phrasing",
  },
  {
    input: "מי בתור למקלחת?",
    sender: "נועה",
    expectedIntent: "question",
    notes: "'Whose turn' is a question about rotation, not a task",
  },
  {
    input: "היום יובל שוטף כלים",
    sender: "אמא",
    expectedIntent: "add_task",
    notes: "Override — specific person for today's duty (when rotation exists)",
  },
  {
    input: "כל יום שני ורביעי תורנות כביסה: דניאל, נועה",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "כביסה", type: "duty", members: ["דניאל", "נועה"] } },
    notes: "Duty rotation with weekly frequency",
  },
```

**Step 2: Commit**

```
git commit -m "test: add rotation classification test cases"
```

---

### Task 10: Update CLAUDE.md with rotation documentation

**Files:**
- Modify: `CLAUDE.md` (ours-app)

**Step 1: Add rotations to DB schema section**

Document `rotations` table, `rotation_id` columns on tasks/events, the DB trigger, and the two rotation types.

**Step 2: Add rotation WhatsApp flows**

Document: create, query, override, on-demand materialization, completion advance.

**Step 3: Add rotation gotchas**

- `members` field is JSONB — parse if string
- DB trigger advances duty rotation on task completion (no client-side logic needed)
- Order rotations advance by calendar day, duty by completion
- Dedup: one active rotation per title per household
- Override sets `current_index`, doesn't create a new rotation

**Step 4: Commit**

```
git commit -m "docs: add rotation system to CLAUDE.md"
```

---

## Execution Dependencies

```
Task 1 (DB migration) ─── must be first
Task 2 (rollback)     ─── can parallel with Task 1
Task 3 (classifier)   ─── after Task 2
Task 4 (executor)     ─── after Task 1 + Task 3
Task 5 (context)      ─── after Task 1 + Task 4
Task 6 (materialize)  ─── after Task 4
Task 7 (web app)      ─── after Task 1 (independent of bot tasks)
Task 8 (Sonnet)       ─── after Task 3
Task 9 (tests)        ─── after Task 3
Task 10 (docs)        ─── last
```
