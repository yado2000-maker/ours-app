# V2 Database Migration Design

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Remove dual-write/dual-read pattern — cut over to normalized V2 tables only

## Context

The app currently has a **dual data layer** (migration period):
- **Old:** `households` table — single JSONB blob containing `{hh, tasks, shopping, events}`
- **New:** Normalized tables — `households_v2`, `tasks`, `shopping_items`, `events`, `household_members`, `messages`, etc.

The web app **reads from BOTH** (merges by ID in `loadData()`) and **writes to BOTH** (dual-write in `save()`). The WhatsApp bot writes only to new tables. This migration removes the old blob path entirely.

### Current Code (deploy baseline, now in ours-app)

**`supabase.js`** already has:
- `sbGet`/`sbSet` — old blob functions (TO REMOVE)
- `loadHousehold(hhId)` — reads from all V2 tables in parallel
- `saveTask`, `saveShoppingItem`, `saveEvent` — individual upserts with inline `camelCase || snake_case` fallback
- `deleteTask`, `deleteShoppingItem`, `deleteEvent` — individual deletes
- `clearDoneTasks`, `clearGotShopping` — bulk deletes
- `saveAllTasks`, `saveAllShopping`, `saveAllEvents` — bulk upserts (for AI responses)

**`App.jsx`** already has:
- `loadData()` — reads from BOTH sources, merges by ID with `normalizeTask`/`normalizeEvent` (TO SIMPLIFY)
- `save()` — writes to BOTH old blob AND V2 tables (TO REPLACE with direct V2 writes)
- Dual Realtime — old `households` channel + new per-table channels (TO SIMPLIFY)
- `handleSetup()` — writes to BOTH `households` and `households_v2` (TO SIMPLIFY)
- `doReset()` — deletes from BOTH `households` and `households_v2` (TO SIMPLIFY)
- `handleRenameHousehold()` — writes to BOTH via `save()` and direct `households_v2.update()` (TO SIMPLIFY)
- Messages still in localStorage (TO MOVE to Supabase)

**`household-detect.js`** already has:
- Method 1: `household_members` by `user_id` (KEEP)
- Method 2: `households_v2` by `created_by` (KEEP)
- Blob fallback in `loadHouseholdInfo()` (TO REMOVE)

## Decision Log

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Multi-table writes | Individual upserts + optimistic UI (no transactions) | App already does optimistic updates; failure window is tiny at household scale |
| Realtime | 5 individual channels (tasks, shopping, events, household, messages) | Each table update refreshes only its own state; Supabase handles multiple channels well |
| Messages | Move from localStorage to Supabase `messages` table | Cross-device sync is expected; table already exists |
| Household ID generation | Client-side `uid8()` | Join link flow needs ID immediately; server-generated adds unnecessary round-trip |
| AI response sync | Delete-and-reinsert per table | AI returns full arrays (not deltas); arrays are small; avoids complex diffing |
| Data migration | None | V2 tables contain test data only; no V1 blob data to preserve |
| CamelCase/snake_case | Consolidate existing inline fallbacks into clean `toDb`/`fromDb` mappers | Replace `t.assignedTo || t.assigned_to` pattern with proper boundary transform |

## V2 Schema (Existing)

```
households_v2    (id, name, lang, created_by, created_at, updated_at)
household_members (id:uuid, household_id, user_id:uuid, display_name, role, joined_at)
tasks            (id, household_id, title, assigned_to, done, completed_by, completed_at, created_at)
shopping_items   (id, household_id, name, qty, category, got, created_at)
events           (id, household_id, title, assigned_to, scheduled_for, created_at)
messages         (id:uuid, household_id, user_id:uuid, role, content, created_at)
ai_usage         (id:uuid, household_id, usage_date, message_count)
```

All child tables FK to `households_v2.id` with `ON DELETE CASCADE`.

## RLS Policies (Existing + Needed)

**Existing:** INSERT on data tables uses `is_household_member(household_id)` which checks `household_members.user_id = auth.uid()`. SELECT/UPDATE/DELETE on tasks, shopping, events require `auth.uid() IS NOT NULL`. households_v2 UPDATE is founder-only (`created_by = auth.uid()`).

**Needed:** DELETE policy on `households_v2` for reset flow: `DELETE WHERE created_by = auth.uid()`.

**Sequencing constraint:** `household_members` row with `user_id = auth.uid()` must exist before any INSERT into data tables (tasks, shopping, events, messages).

## Files Changed

| File | Changes |
|------|---------|
| `src/lib/supabase.js` | Remove `sbGet`/`sbSet`. Add `toDb`/`fromDb` mappers. Add `loadMessages`, `insertMessage`. Refactor `loadHousehold` to also load messages. |
| `src/App.jsx` | Remove `save()`, dual-read `loadData()`, old Realtime channel. Rewrite boot to V2-only. Each mutation writes directly to its table. Messages to Supabase. Add messages Realtime channel. |
| `src/lib/household-detect.js` | Remove blob fallback from `loadHouseholdInfo()`. |

Components (`TasksView`, `ShoppingView`, `WeekView`, `Setup`, `AuthScreen`, `MenuPanel`, `JoinOrCreate`, `WelcomeScreen`, `Icons`) are untouched. State shapes are preserved.

## Design: `supabase.js`

### Remove

- `sbGet(hhId)` — blob read
- `sbSet(hhId, data)` — blob write + timeout wrapper

### Add: Field Mappers

Replace the scattered `t.assignedTo || t.assigned_to` pattern with clean boundary functions:

```js
const TASK_MAP = { assignedTo: 'assigned_to', completedBy: 'completed_by', completedAt: 'completed_at' }
const EVENT_MAP = { assignedTo: 'assigned_to', scheduledFor: 'scheduled_for' }

function toDb(obj, map)   // { assignedTo: "X" } -> { assigned_to: "X" }
function fromDb(obj, map) // { assigned_to: "X" } -> { assignedTo: "X" }
```

### Refactor Existing Functions

- `loadHousehold(hhId)` — already loads from V2. Add `fromDb` transform on tasks/events (remove need for `normalizeTask`/`normalizeEvent` in App.jsx).
- `saveTask`, `saveShoppingItem`, `saveEvent` — replace inline `t.assignedTo || t.assigned_to` with `toDb()`.
- `saveAllTasks`, `saveAllShopping`, `saveAllEvents` — same `toDb()` refactor. Change from upsert to **delete + insert** (AI returns full arrays; delete-and-reinsert is cleaner per approved design).

### Add: Message Functions

```js
loadMessages(hhId, userId)       -> select from messages where household_id and user_id, order by created_at
insertMessage(hhId, userId, msg) -> insert into messages { household_id, user_id, role, content }
```

### Keep

- `lsGet(key)` / `lsSet(key, val)` — for theme, hhid, user, founder flag
- `uid8()` / `uid()` — for client-side ID generation
- `deleteTask`, `deleteShoppingItem`, `deleteEvent` — already V2-only
- `clearDoneTasks`, `clearGotShopping` — already V2-only

## Design: App.jsx

### Boot Sequence

Remove `loadData()` with its dual-read + merge logic. Replace with V2-only load:

```
loadData(hhId, authUserId):
  const [hh, members, tasks, shopping, events, messages] = await Promise.all([
    loadHousehold(hhId),     // households_v2 only
    loadMembers(hhId),       // household_members only
    loadTasks(hhId),         // tasks only (fromDb applied)
    loadShopping(hhId),      // shopping_items only
    loadEvents(hhId),        // events only (fromDb applied)
    loadMessages(hhId, authUserId)  // NEW: from Supabase
  ])
  -> setHousehold({ ...hh, members })
  -> setTasks, setShopping, setEvents
  -> setAllMsgs({ [userId]: messages })  // from Supabase, not localStorage
```

Remove: `sbGet` call, `mergeById()`, `normalizeTask()`, `normalizeEvent()`, old blob fallback.

### Realtime Subscriptions

Remove old `households` channel. Keep the 3 V2 channels (tasks, shopping, events). Add 2 more:

- `channel-tasks` — already exists. Keep as-is but refactor `reloadFromTables` to per-table reload.
- `channel-shopping` — already exists. Same refactor.
- `channel-events` — already exists. Same refactor.
- `channel-household` — NEW: UPDATE on `households_v2` -> reload household + members.
- `channel-messages` — NEW: INSERT on `messages` -> reload messages for current user.

Same 3s echo debounce via `lastSaveRef`.

### Write Operations

**Remove:** `save()` function entirely.

**Each action writes directly to its table (optimistic UI preserved):**

| Action | DB Call |
|--------|---------|
| `toggleTask(id)` | `saveTask(hhId, { id, done, completedBy, completedAt })` |
| `claimTask(id, name)` | `saveTask(hhId, { id, assignedTo: name })` |
| `toggleShop(id)` | `saveShoppingItem(hhId, { id, got })` |
| `deleteItem("task", id)` | `deleteTask(hhId, id)` |
| `deleteItem("shop", id)` | `deleteShoppingItem(hhId, id)` |
| `deleteEvent(id)` | `deleteEvent(hhId, id)` |
| `clearDone()` | `clearDoneTasks(hhId)` |
| `clearGot()` | `clearGotShopping(hhId)` |
| `handleRenameUser()` | `upsertMember(hhId, { id, display_name })` (remove blob save) |
| `handleRenameHousehold()` | `updateHousehold(hhId, { name })` (remove blob save + duplicate V2 call) |
| `handleAddMember()` | existing `household_members.insert()` (remove blob save) |
| `handleRemoveMember()` | existing `household_members.delete()` (remove blob save) |
| `switchLang(l)` | `updateHousehold(hhId, { lang: l })` (remove blob save) |

**AI chat response:**
```
send() ->
  insertMessage(hhId, authUserId, { role: "user", content })
  ... fetch Claude ...
  insertMessage(hhId, authUserId, { role: "assistant", content: parsed.message })
  saveAllTasks(hhId, newTasks)       // delete+insert, only if array
  saveAllShopping(hhId, newShop)     // delete+insert, only if array
  saveAllEvents(hhId, newEvents)     // delete+insert, only if array
```

Remove: `save()` call, localStorage message writes.

### Setup Flow

Remove blob write. Keep V2 writes (already there):
```
handleSetup(hh) ->
  insert into households_v2 { id: hhId, name, lang, created_by: auth.uid() }
  insert into household_members (one per member, founder gets user_id: auth.uid())
  // Remove: sbSet(hhId, { hh, tasks: [], shopping: [], events: [] })
```

**Critical:** Founder's `household_members` row with `user_id = auth.uid()` must be inserted first (RLS requirement for subsequent data writes).

### Reset Flow

Remove blob delete. Keep V2 delete (cascade handles everything):
```
doReset() ->
  supabase.from("households_v2").delete().eq("id", hhId)  // cascades all child rows
  // Remove: supabase.from("households").delete().eq("id", hhId)
  clear localStorage
  reset all state
```

### Join Flow (JoinOrCreate)

Already links auth user to household_members with `user_id: session.user.id`. No changes needed — already V2-only.

### User Picker

Remove: `sbGet` reload on picker click (line ~361 in old version). Data is already loaded in state from boot.
Deploy version already fixed this — picker just sets user from state.

## Design: `household-detect.js`

Remove blob fallback (lines 68-83) from `loadHouseholdInfo()`:
```
// Remove this block:
// const { data: old } = await supabase.from("households").select("id, data").eq("id", hhId).single();
// if (old?.data?.hh) { ... }
```

Keep Methods 1-2 (membership + created_by) which are already V2-only.

## DB Changes Needed

1. **Add DELETE policy on `households_v2`:**
   ```sql
   CREATE POLICY "Founders can delete household"
   ON households_v2 FOR DELETE
   USING (created_by = auth.uid());
   ```

2. **Enable Realtime on `households_v2` and `messages`** (if not already):
   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE public.households_v2;
   ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
   ```

## Out of Scope

- Migrating V1 blob data (test data only, no migration needed)
- Changing component props/shapes
- Modifying AI prompt field names
- Subscription/referral/WhatsApp tables (not touched by App.jsx)
- Dropping the `households` (blob) table (can be done later as cleanup)
