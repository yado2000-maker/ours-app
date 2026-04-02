# V2 Database Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the dual-write/dual-read blob pattern and cut over to normalized V2 Supabase tables only.

**Architecture:** Strip `sbGet`/`sbSet` (old blob), remove merge logic, make each mutation write directly to its V2 table. Add messages to Supabase. Add `toDb`/`fromDb` field mappers at the DB boundary. Add Realtime channels for `households_v2` and `messages`.

**Tech Stack:** React 19, Vite 8, Supabase JS v2, Vercel

**Design doc:** `docs/plans/2026-04-02-v2-db-migration-design.md`

**Key files (read before starting):**
- `src/lib/supabase.js` — data layer (has both old blob + V2 functions)
- `src/App.jsx` — main app (dual-write save, dual-read boot, dual Realtime)
- `src/lib/household-detect.js` — household auto-detection (has blob fallback)

---

## Pre-flight

### Task 0: DB policy + Realtime setup

**Why:** The reset flow needs a DELETE policy on `households_v2`, and new Realtime channels need publications enabled.

**Step 1: Add DELETE policy on households_v2**

Use Supabase MCP `apply_migration` tool:
```sql
CREATE POLICY "Founders can delete household"
ON public.households_v2 FOR DELETE
USING (created_by = auth.uid());
```

**Step 2: Check Realtime publications**

Run via `execute_sql`:
```sql
SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

If `households_v2` or `messages` are missing, add them:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.households_v2;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
```

**Step 3: Verify**

Run via `execute_sql`:
```sql
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'households_v2';
```
Expected: should now include a DELETE policy.

---

## Phase 1: Clean up `supabase.js`

### Task 1: Add `toDb` / `fromDb` field mappers

**Files:**
- Modify: `src/lib/supabase.js`

**Step 1: Add mapper functions and maps after the existing imports/client setup (after line 5)**

```js
// ── Field mappers: camelCase (JS) <-> snake_case (DB) ──
const TASK_MAP = { assignedTo: 'assigned_to', completedBy: 'completed_by', completedAt: 'completed_at' };
const EVENT_MAP = { assignedTo: 'assigned_to', scheduledFor: 'scheduled_for' };

const toDb = (obj, map) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[map[k] || k] = v;
  }
  return out;
};

const fromDb = (obj, map) => {
  const rev = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[rev[k] || k] = v;
  }
  return out;
};
```

**Step 2: Verify** — no behavioral change yet, just adding utilities. App should still load normally.

---

### Task 2: Refactor existing V2 functions to use mappers

**Files:**
- Modify: `src/lib/supabase.js`

**Step 1: Refactor `loadHousehold` to apply `fromDb` on tasks and events**

Replace the return block so `tasks` and `events` come back in camelCase:

```js
export const loadHousehold = async (hhId) => {
  const [hhRes, membersRes, tasksRes, shoppingRes, eventsRes] = await Promise.all([
    supabase.from("households_v2").select("*").eq("id", hhId).single(),
    supabase.from("household_members").select("*").eq("household_id", hhId),
    supabase.from("tasks").select("*").eq("household_id", hhId),
    supabase.from("shopping_items").select("*").eq("household_id", hhId),
    supabase.from("events").select("*").eq("household_id", hhId),
  ]);

  if (!hhRes.data) return null;

  return {
    hh: {
      id: hhRes.data.id,
      name: hhRes.data.name,
      lang: hhRes.data.lang || "he",
      members: (membersRes.data || []).map(m => ({ id: m.id, name: m.display_name, userId: m.user_id })),
    },
    tasks: (tasksRes.data || []).map(t => fromDb(t, TASK_MAP)),
    shopping: shoppingRes.data || [],
    events: (eventsRes.data || []).map(e => fromDb(e, EVENT_MAP)),
  };
};
```

**Step 2: Refactor `saveTask` to use `toDb`**

```js
export const saveTask = async (hhId, task) => {
  const row = { household_id: hhId, ...toDb(task, TASK_MAP) };
  if (!row.done) row.done = false;
  const { error } = await supabase.from("tasks").upsert(row);
  if (error) console.error("[saveTask]", error);
};
```

**Step 3: Refactor `saveEvent` to use `toDb`**

```js
export const saveEvent = async (hhId, event) => {
  const row = { household_id: hhId, ...toDb(event, EVENT_MAP) };
  const { error } = await supabase.from("events").upsert(row);
  if (error) console.error("[saveEvent]", error);
};
```

**Step 4: Refactor `saveAllTasks` to delete + insert (per design decision)**

```js
export const saveAllTasks = async (hhId, tasks) => {
  await supabase.from("tasks").delete().eq("household_id", hhId);
  if (tasks.length === 0) return;
  const rows = tasks.map(t => ({ household_id: hhId, ...toDb(t, TASK_MAP), done: t.done || false }));
  const { error } = await supabase.from("tasks").insert(rows);
  if (error) console.error("[saveAllTasks]", error);
};
```

**Step 5: Refactor `saveAllEvents` to delete + insert**

```js
export const saveAllEvents = async (hhId, events) => {
  await supabase.from("events").delete().eq("household_id", hhId);
  if (events.length === 0) return;
  const rows = events.map(e => ({ household_id: hhId, ...toDb(e, EVENT_MAP) }));
  const { error } = await supabase.from("events").insert(rows);
  if (error) console.error("[saveAllEvents]", error);
};
```

**Step 6: Refactor `saveAllShopping` to delete + insert**

```js
export const saveAllShopping = async (hhId, items) => {
  await supabase.from("shopping_items").delete().eq("household_id", hhId);
  if (items.length === 0) return;
  const rows = items.map(s => ({
    id: s.id, household_id: hhId, name: s.name,
    qty: s.qty || null, category: s.category || "Other", got: s.got || false,
  }));
  const { error } = await supabase.from("shopping_items").insert(rows);
  if (error) console.error("[saveAllShopping]", error);
};
```

**Step 7: Verify** — App should still work identically (dual-write still active in App.jsx). The V2 path is now cleaner.

---

### Task 3: Add message functions

**Files:**
- Modify: `src/lib/supabase.js`

**Step 1: Add `loadMessages` and `insertMessage` at the end of the file (before the closing)**

```js
// ── Messages (v2) ──
export const loadMessages = async (hhId, userId) => {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("household_id", hhId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) console.error("[loadMessages]", error);
  return (data || []).map(m => ({ role: m.role, content: m.content, ts: new Date(m.created_at).getTime() }));
};

export const insertMessage = async (hhId, userId, msg) => {
  const { error } = await supabase.from("messages").insert({
    household_id: hhId,
    user_id: userId,
    role: msg.role,
    content: msg.content,
  });
  if (error) console.error("[insertMessage]", error);
};
```

**Step 2: Verify** — no behavioral change, functions not yet called.

---

### Task 4: Remove `sbGet` and `sbSet`

**Files:**
- Modify: `src/lib/supabase.js`

**Step 1: Delete the `sbGet` function (lines ~7-14)**

**Step 2: Delete the `sbSet` function (lines ~16-21)**

**Step 3: Update the exports** — remove `sbGet` and `sbSet` from any export. Add `loadMessages` and `insertMessage` to exports.

**DO NOT run/verify yet** — App.jsx still imports these. This will break until Task 5 completes.

---

## Phase 2: Rewrite `App.jsx`

### Task 5: Update imports and remove `save()`

**Files:**
- Modify: `src/App.jsx`

**Step 1: Update import line (line 4)**

Remove `sbGet, sbSet` from the import. Add `loadMessages, insertMessage`:

```js
import { supabase, lsGet, lsSet, uid8, loadHousehold, saveTask, saveShoppingItem, saveEvent, deleteTask, deleteShoppingItem, deleteEvent, clearDoneTasks, clearGotShopping, saveAllTasks, saveAllShopping, saveAllEvents, loadMessages, insertMessage } from "./lib/supabase.js";
```

**Step 2: Delete the entire `save()` function** (currently ~lines 302-326)

Delete the block starting with `// ── Persist (writes to BOTH old JSON blob AND new normalized tables) ──` through the closing `};` of `save`.

**DO NOT run yet** — many functions still call `save()`. Continue to Task 6.

---

### Task 6: Rewrite boot `loadData()`

**Files:**
- Modify: `src/App.jsx`

**Step 1: Replace `loadData` inside the boot `useEffect`**

Find the `loadData` function (defined inside `bootAsync`, ~lines 81-139). Replace the entire function with:

```js
const loadData = async (id) => {
  const v2 = await loadHousehold(id);
  if (!v2) return null;

  // Load messages for authenticated user
  let msgs = [];
  try {
    msgs = await loadMessages(id, session.user.id);
  } catch (e) { console.warn("[Boot] loadMessages:", e.message); }

  return { ...v2, msgs };
};
```

**Step 2: Update all `loadData` consumers to use messages from Supabase**

Find where `loadData` results are consumed (3 places in boot: join flow, localStorage flow, auto-detect flow). In each, after setting tasks/shopping/events, replace:

```js
// OLD:
const msgs = lsGet("sheli-msgs") || {};
setAllMsgs(msgs);
```

With:
```js
// NEW:
if (data.msgs?.length > 0) {
  setAllMsgs({ [session.user.id]: data.msgs });
}
```

For the join flow (which doesn't load messages), just skip the message set.

For the auto-detect background load, also load messages:
```js
loadData(detected.id).then(data => {
  if (data) {
    setHouseholdS(data.hh); setLang(data.hh.lang || "en");
    setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
    if (data.msgs?.length > 0) setAllMsgs({ [session.user.id]: data.msgs });
  }
}).catch(e => console.warn("[Boot] Background load:", e));
```

**Step 3: Update message keying**

The `msgs` variable (line ~47) currently uses `allMsgs[user.id]` where `user.id` is the member picker ID. With Supabase messages, key by auth user ID instead. Find:
```js
const msgs = user ? (allMsgs[user.id] || []) : [];
```
Replace with:
```js
const msgs = session?.user?.id ? (allMsgs[session.user.id] || []) : [];
```

**Step 4: Verify** — App should boot and show data from V2 tables only. Messages will be empty (none in DB yet) but the app shouldn't crash.

---

### Task 7: Rewrite Realtime subscriptions

**Files:**
- Modify: `src/App.jsx`

**Step 1: Replace the entire Realtime `useEffect`** (currently ~lines 243-299)

```js
// ── Realtime sync (V2 tables only) ──
useEffect(() => {
  if (screen !== "chat") return;
  const hhId = lsGet("sheli-hhid");
  if (!hhId) return;
  const authUserId = session?.user?.id;

  const reloadTasks = async () => {
    if (Date.now() - lastSaveRef.current < 3000) return;
    const v2 = await loadHousehold(hhId);
    if (v2) setTasksS(v2.tasks);
  };
  const reloadShopping = async () => {
    if (Date.now() - lastSaveRef.current < 3000) return;
    const v2 = await loadHousehold(hhId);
    if (v2) setShoppingS(v2.shopping);
  };
  const reloadEvents = async () => {
    if (Date.now() - lastSaveRef.current < 3000) return;
    const v2 = await loadHousehold(hhId);
    if (v2) setEventsS(v2.events);
  };
  const reloadHousehold = async () => {
    if (Date.now() - lastSaveRef.current < 3000) return;
    const v2 = await loadHousehold(hhId);
    if (v2) setHouseholdS(v2.hh);
  };
  const reloadMessages = async () => {
    if (!authUserId || Date.now() - lastSaveRef.current < 3000) return;
    const msgs = await loadMessages(hhId, authUserId);
    if (msgs) setAllMsgs(prev => ({ ...prev, [authUserId]: msgs }));
  };

  const ch1 = supabase.channel(`tasks-${hhId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `household_id=eq.${hhId}` }, reloadTasks)
    .subscribe();
  const ch2 = supabase.channel(`shopping-${hhId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${hhId}` }, reloadShopping)
    .subscribe();
  const ch3 = supabase.channel(`events-${hhId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `household_id=eq.${hhId}` }, reloadEvents)
    .subscribe();
  const ch4 = supabase.channel(`household-${hhId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "households_v2", filter: `id=eq.${hhId}` }, reloadHousehold)
    .subscribe();
  const ch5 = supabase.channel(`messages-${hhId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `household_id=eq.${hhId}` }, reloadMessages)
    .subscribe();

  return () => {
    supabase.removeChannel(ch1);
    supabase.removeChannel(ch2);
    supabase.removeChannel(ch3);
    supabase.removeChannel(ch4);
    supabase.removeChannel(ch5);
  };
}, [screen]);
```

**Step 2: Verify** — Realtime should still work for tasks/shopping/events (same channels, same tables). New household and messages channels added.

---

### Task 8: Rewrite mutation handlers (remove `save()` calls)

**Files:**
- Modify: `src/App.jsx`

**Step 1: Rewrite `toggleTask`**

```js
const toggleTask = async (id) => {
  const n = tasks.map(x => {
    if (x.id !== id) return x;
    const nowDone = !x.done;
    return { ...x, done: nowDone, completedBy: nowDone ? user.name : null, completedAt: nowDone ? new Date().toISOString() : null };
  });
  setTasksS(n);
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  const updated = n.find(x => x.id === id);
  if (hhId && updated) saveTask(hhId, updated);
};
```

**Step 2: Rewrite `claimTask`**

```js
const claimTask = async (id, name) => {
  const n = tasks.map(x => x.id === id ? { ...x, assignedTo: name } : x);
  setTasksS(n);
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  const updated = n.find(x => x.id === id);
  if (hhId && updated) saveTask(hhId, updated);
};
```

**Step 3: Rewrite `toggleShop`**

```js
const toggleShop = async (id) => {
  const n = shopping.map(x => x.id === id ? { ...x, got: !x.got } : x);
  setShoppingS(n);
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  const updated = n.find(x => x.id === id);
  if (hhId && updated) saveShoppingItem(hhId, updated);
};
```

**Step 4: Rewrite `deleteItem`**

```js
const deleteItem = async (type, id) => {
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  if (type === "task") {
    setTasksS(tasks.filter(x => x.id !== id));
    if (hhId) deleteTask(hhId, id);
  } else {
    setShoppingS(shopping.filter(x => x.id !== id));
    if (hhId) deleteShoppingItem(hhId, id);
  }
};
```

**Step 5: Rewrite `clearDone` and `clearGot`**

```js
const clearDone = async () => {
  setTasksS(tasks.filter(x => !x.done));
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  if (hhId) clearDoneTasks(hhId);
};
const clearGot = async () => {
  setShoppingS(shopping.filter(x => !x.got));
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  if (hhId) clearGotShopping(hhId);
};
```

**Step 6: Rewrite `deleteEvent`**

```js
const deleteEventFn = async (id) => {
  setEventsS(events.filter(x => x.id !== id));
  const hhId = lsGet("sheli-hhid");
  lastSaveRef.current = Date.now();
  if (hhId) deleteEvent(hhId, id);
};
```
Note: rename to `deleteEventFn` to avoid conflict with imported `deleteEvent`.

**Step 7: Verify** — Toggle tasks, check/uncheck shopping items, delete items. All should persist across page reloads (V2 tables only).

---

### Task 9: Rewrite menu handlers (remove `save()` calls)

**Files:**
- Modify: `src/App.jsx`

**Step 1: Rewrite `handleRenameUser`**

```js
const handleRenameUser = async (newName) => {
  if (!newName || newName === user.name) return;
  const updatedMembers = household.members.map(m =>
    m.id === user.id ? { ...m, name: newName } : m
  );
  const updatedHh = { ...household, members: updatedMembers };
  const updatedUser = { ...user, name: newName };
  setHouseholdS(updatedHh); setUser(updatedUser);
  lsSet("sheli-user", updatedUser);
  lastSaveRef.current = Date.now();
  supabase.from("household_members").update({ display_name: newName }).eq("id", user.id).catch(e => console.error("[renameUser]", e));
};
```

**Step 2: Rewrite `handleRenameHousehold`**

```js
const handleRenameHousehold = async (newName) => {
  if (!newName || !household) return;
  const updatedHh = { ...household, name: newName };
  setHouseholdS(updatedHh);
  lastSaveRef.current = Date.now();
  supabase.from("households_v2").update({ name: newName }).eq("id", household.id).catch(e => console.error("[renameHH]", e));
};
```

**Step 3: Rewrite `handleAddMember`**

```js
const handleAddMember = async (name) => {
  if (!name || !household) return;
  const newMember = { id: uid8(), name };
  const updatedHh = { ...household, members: [...household.members, newMember] };
  setHouseholdS(updatedHh);
  lastSaveRef.current = Date.now();
  supabase.from("household_members").insert({ household_id: household.id, display_name: name, role: "member" }).catch(e => console.error("[addMember]", e));
};
```

**Step 4: Rewrite `handleRemoveMember`** — already V2-only, just remove the `save()` call.

```js
const handleRemoveMember = async (memberId) => {
  if (!household) return;
  const updatedHh = { ...household, members: household.members.filter(m => m.id !== memberId) };
  setHouseholdS(updatedHh);
  lastSaveRef.current = Date.now();
  supabase.from("household_members").delete().eq("id", memberId).eq("household_id", household.id).catch(e => console.error("[removeMember]", e));
};
```

**Step 5: Rewrite `switchLang`**

```js
const switchLang = async (l) => {
  setLang(l);
  if (household) {
    const updated = { ...household, lang: l };
    setHouseholdS(updated);
    lastSaveRef.current = Date.now();
    supabase.from("households_v2").update({ lang: l }).eq("id", household.id).catch(e => console.error("[switchLang]", e));
  }
};
```

**Step 6: Verify** — Rename user, rename household, switch language. All should persist.

---

### Task 10: Rewrite `send()` (AI chat + messages to Supabase)

**Files:**
- Modify: `src/App.jsx`

**Step 1: Rewrite the `send` function**

Key changes: messages go to Supabase instead of localStorage, use `session.user.id` for keying, save arrays via V2 bulk functions.

```js
const send = async (text) => {
  const content = (text || input).trim();
  if (!content || busy || !user) return;
  const authUserId = session?.user?.id;
  const hhId = lsGet("sheli-hhid");
  const uMsg = { role: "user", content, ts: Date.now() };
  const prev = allMsgs[authUserId] || [];
  const updated = [...prev, uMsg];
  const nextAll = { ...allMsgs, [authUserId]: updated };
  setAllMsgs(nextAll); setInput(""); setBusy(true); setTab("chat");

  // Save user message to Supabase
  if (hhId && authUserId) insertMessage(hhId, authUserId, uMsg).catch(e => console.warn("[send] msg:", e));

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1200,
        system: buildPrompt(household, tasks, shopping, events, user, lang),
        messages: updated.slice(-20).map(m => ({ role: m.role, content: m.content })),
      })
    });
    const data = await res.json();
    const raw = (data.content?.[0]?.text || "{}").replace(/```json\n?|```/g, "").trim();
    let parsed = { message: t.genericError, tasks, shopping };
    try { parsed = JSON.parse(raw); } catch { parsed.message = raw || parsed.message; }

    const aMsg = { role: "assistant", content: parsed.message, ts: Date.now() };
    const finalMsgs = [...updated, aMsg];
    const finalAll = { ...nextAll, [authUserId]: finalMsgs };

    // Merge AI response with current state
    const mergeLists = (aiList, current) => {
      if (!Array.isArray(aiList)) return current;
      if (aiList.length === 0 && current.length > 0) return current;
      const aiIds = new Set(aiList.map(x => x.id));
      const kept = current.filter(x => !aiIds.has(x.id) && x.id);
      return [...aiList, ...kept];
    };
    const newTasks = mergeLists(parsed.tasks, tasks);
    const newShop = mergeLists(parsed.shopping, shopping);
    const newEvents = mergeLists(parsed.events, events);
    setAllMsgs(finalAll); setTasksS(newTasks); setShoppingS(newShop); setEventsS(newEvents);

    // Save assistant message + data to V2
    lastSaveRef.current = Date.now();
    if (hhId && authUserId) insertMessage(hhId, authUserId, aMsg).catch(e => console.warn("[send] aMsg:", e));
    if (hhId) {
      if (Array.isArray(parsed.tasks)) saveAllTasks(hhId, newTasks).catch(e => console.warn("[send] tasks:", e));
      if (Array.isArray(parsed.shopping)) saveAllShopping(hhId, newShop).catch(e => console.warn("[send] shop:", e));
      if (Array.isArray(parsed.events)) saveAllEvents(hhId, newEvents).catch(e => console.warn("[send] events:", e));
    }
  } catch {
    const aMsg = { role: "assistant", content: t.networkError, ts: Date.now() };
    setAllMsgs({ ...nextAll, [authUserId]: [...updated, aMsg] });
  }
  setBusy(false);
  setTimeout(() => inputRef.current?.focus(), 50);
};
```

**Step 2: Verify** — Send a chat message. Verify response appears. Check Supabase `messages` table has 2 new rows (user + assistant). Verify tasks/shopping created by AI appear in V2 tables.

---

### Task 11: Rewrite `handleSetup()` (remove blob write)

**Files:**
- Modify: `src/App.jsx`

**Step 1: Replace `handleSetup`**

Remove `sbSet` call. Ensure founder gets `user_id` in `household_members`. `created_by` set on `households_v2`.

```js
const handleSetup = async (hh) => {
  if (setupRunning.current) return;
  setupRunning.current = true;

  const hhId = uid8();
  hh.id = hhId;
  lsSet("sheli-hhid", hhId);
  lsSet("sheli-founder", true);

  // Navigate immediately
  setHouseholdS(hh); setLang(hh.lang || "en");
  setTasksS([]); setShoppingS([]); setEventsS([]);
  const founder = hh.members[0];
  if (founder) {
    lsSet("sheli-user", founder);
    setUser(founder);
  }
  setScreen("connect-wa");

  // Write to V2 only (non-blocking)
  const authUserId = session?.user?.id;
  supabase.from("households_v2").insert({
    id: hhId, name: hh.name, lang: hh.lang || "he", created_by: authUserId,
  }).catch(e => console.warn("[Setup] v2:", e));

  // Insert founder FIRST (RLS needs this for subsequent inserts)
  if (founder) {
    await supabase.from("household_members").insert({
      household_id: hhId, display_name: founder.name, role: "founder", user_id: authUserId,
    }).catch(e => console.warn("[Setup] founder:", e));
  }
  // Then other members
  for (const member of hh.members.slice(1)) {
    supabase.from("household_members").insert({
      household_id: hhId, display_name: member.name, role: "member",
    }).catch(e => console.warn("[Setup] member:", e));
  }
};
```

**Step 2: Verify** — Create a new household. Check `households_v2` and `household_members` in Supabase. Old `households` table should NOT get a new row.

---

### Task 12: Rewrite `doReset()` (remove blob delete)

**Files:**
- Modify: `src/App.jsx`

**Step 1: Replace `doReset`**

```js
const doReset = async () => {
  const hhId = lsGet("sheli-hhid");
  if (hhId) {
    try {
      await supabase.from("households_v2").delete().eq("id", hhId);
    } catch (e) { console.warn("[Reset]", e); }
  }
  localStorage.removeItem("sheli-hhid");
  localStorage.removeItem("sheli-msgs");
  localStorage.removeItem("sheli-user");
  localStorage.removeItem("sheli-founder");
  localStorage.removeItem("sheli-onboarded");
  setHousehold(null); setUser(null); setAllMsgs({}); setTasksS([]); setShoppingS([]); setEventsS([]); setInput("");
  setShowMenu(false); setScreen("setup");
};
```

**Step 2: Verify** — Reset household. Check `households_v2` row is gone. Cascade should have cleared all child tables.

---

## Phase 3: Clean up `household-detect.js`

### Task 13: Remove blob fallback

**Files:**
- Modify: `src/lib/household-detect.js`

**Step 1: In `loadHouseholdInfo()`, remove the blob fallback block** (lines ~68-83):

```js
// DELETE this entire block:
// Fallback: try old blob table
// const { data: old } = await supabase.from("households").select("id, data")...
```

The function should only try `households_v2` + `household_members`.

**Step 2: Verify** — Sign out and back in. Auto-detect should still find the household via V2 tables.

---

## Phase 4: Final verification

### Task 14: Full smoke test

**Step 1: Fresh browser (incognito)**
- Sign up new account
- Create household with 2 members
- Verify: `households_v2` has new row, `household_members` has 2 rows, `households` (blob) has NO new row

**Step 2: Chat test**
- Send a message asking to add a task and a shopping item
- Verify: tasks + shopping_items tables updated, `messages` table has user + assistant rows

**Step 3: Mutation test**
- Toggle task done/undone
- Check/uncheck shopping item
- Delete a task, delete a shopping item
- Clear all done tasks
- Verify all changes persist in V2 tables after page reload

**Step 4: Multi-device test**
- Open same account in 2 browser tabs
- Toggle a task in tab 1 → should appear in tab 2 via Realtime
- Send a chat in tab 1 → messages should sync to tab 2

**Step 5: Settings test**
- Rename user, rename household, switch language
- Verify persists in `household_members` and `households_v2`

**Step 6: Reset test**
- Reset household
- Verify `households_v2` row gone, cascade clears all child rows
- Verify app returns to setup screen

**Step 7: Join flow test**
- Create household → share join link → open in incognito
- Verify joiner can authenticate, gets linked to household

### Task 15: Commit

```bash
git add src/lib/supabase.js src/App.jsx src/lib/household-detect.js
git commit -m "feat: V2 DB migration — remove blob, use normalized tables only

Remove sbGet/sbSet dual-write pattern. All data now reads/writes
to normalized V2 tables (tasks, shopping_items, events,
household_members, households_v2, messages).

- Add toDb/fromDb field mappers for camelCase/snake_case boundary
- Move chat messages from localStorage to Supabase messages table
- Add Realtime channels for households_v2 and messages
- Remove blob fallback from household-detect.js
- Delete+insert for AI response sync (replaces upsert)
"
```
