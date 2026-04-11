import { createClient } from "@supabase/supabase-js";

const SB_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6d3d0Z2h0bmthcGR3bGducnhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMTg2NDYsImV4cCI6MjA4OTc5NDY0Nn0.P8NlRjUciAewFvKsaPAxL_x_5FHuGyQXIcrTKmxyd9g";
export const supabase = createClient(SB_URL, SB_KEY);

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

export const lsGet = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
export const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

export const uid8 = () => Math.random().toString(36).slice(2, 10);
// M15 fix: uid() was 4-char (~1.6M combos). Now 8-char (~2.8T combos) to prevent collisions.
export const uid  = () => Math.random().toString(36).slice(2, 10);

// ─── Normalized table functions (v2) ───

export const loadHousehold = async (hhId) => {
  const [hhRes, membersRes, tasksRes, shoppingRes, eventsRes, rotationsRes] = await Promise.all([
    supabase.from("households_v2").select("*").eq("id", hhId).single(),
    supabase.from("household_members").select("*").eq("household_id", hhId),
    supabase.from("tasks").select("*").eq("household_id", hhId),
    supabase.from("shopping_items").select("*").eq("household_id", hhId),
    supabase.from("events").select("*").eq("household_id", hhId),
    supabase.from("rotations").select("*").eq("household_id", hhId).eq("active", true),
  ]);
  if (!hhRes.data) return null;
  return {
    hh: {
      id: hhRes.data.id,
      name: hhRes.data.name,
      lang: hhRes.data.lang || "he",
      referralCode: hhRes.data.referral_code || null,
      members: (membersRes.data || []).map(m => ({ id: m.id, name: m.display_name, userId: m.user_id })),
    },
    tasks: (tasksRes.data || []).map(t => fromDb(t, TASK_MAP)),
    shopping: shoppingRes.data || [],
    events: (eventsRes.data || []).map(e => fromDb(e, EVENT_MAP)),
    rotations: (rotationsRes.data || []).map(r => ({
      ...r,
      members: typeof r.members === "string" ? JSON.parse(r.members) : r.members,
      frequency: r.frequency && typeof r.frequency === "string" ? JSON.parse(r.frequency) : r.frequency,
    })),
  };
};

export const loadReferralStats = async (hhId) => {
  const { data, error } = await supabase
    .from("referrals")
    .select("id, status")
    .eq("referrer_household_id", hhId);
  if (error) { console.error("[loadReferralStats]", error); return { sent: 0, completed: 0 }; }
  const rows = data || [];
  return { sent: rows.length, completed: rows.filter(r => r.status === "completed").length };
};

export const loadSubscription = async (hhId) => {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status, free_until")
    .eq("household_id", hhId)
    .maybeSingle();
  if (error) { console.error("[loadSubscription]", error); return null; }
  if (!data) return null;
  // Referral reward: free_until in the future counts as premium
  const isFreeReward = data.free_until && new Date(data.free_until) > new Date();
  const effectivePlan = (data.status === "active" && data.plan !== "free") ? data.plan
    : isFreeReward ? "premium" : "free";
  return { ...data, effectivePlan };
};

export const saveTask = async (hhId, task) => {
  const row = { household_id: hhId, ...toDb(task, TASK_MAP) };
  if (!row.done) row.done = false;
  const { error } = await supabase.from("tasks").upsert(row);
  if (error) console.error("[saveTask]", error);
};

export const saveShoppingItem = async (hhId, item) => {
  const row = {
    id: item.id,
    household_id: hhId,
    name: item.name,
    qty: item.qty || null,
    category: item.category || "אחר",
    got: item.got || false,
  };
  // Audit trail: who checked off this item and when
  if (item.got) {
    row.got_by = item.gotBy || null;
    row.got_at = item.gotAt || new Date().toISOString();
  } else {
    row.got_by = null;
    row.got_at = null;
  }
  const { error } = await supabase.from("shopping_items").upsert(row);
  if (error) console.error("[saveShoppingItem]", error);
};

export const saveEvent = async (hhId, event) => {
  const row = { household_id: hhId, ...toDb(event, EVENT_MAP) };
  const { error } = await supabase.from("events").upsert(row);
  if (error) console.error("[saveEvent]", error);
};

// Delete from normalized tables
export const deleteTask = async (hhId, taskId) => {
  await supabase.from("tasks").delete().eq("id", taskId).eq("household_id", hhId);
};

export const deleteShoppingItem = async (hhId, itemId) => {
  await supabase.from("shopping_items").delete().eq("id", itemId).eq("household_id", hhId);
};

export const deleteEvent = async (hhId, eventId) => {
  await supabase.from("events").delete().eq("id", eventId).eq("household_id", hhId);
};

// Bulk operations
export const clearDoneTasks = async (hhId) => {
  await supabase.from("tasks").delete().eq("household_id", hhId).eq("done", true);
};

export const clearGotShopping = async (hhId) => {
  await supabase.from("shopping_items").delete().eq("household_id", hhId).eq("got", true);
};

// ─── Safe bulk-write: upsert all items, then delete orphans ───
// This avoids the delete-then-insert race that loses data if the insert fails.
// Pattern: upsert the full list, then delete any rows NOT in the list.

export const saveAllTasks = async (hhId, tasks) => {
  if (tasks.length === 0) {
    await supabase.from("tasks").delete().eq("household_id", hhId);
    return;
  }
  const rows = tasks.map(t => ({ household_id: hhId, ...toDb(t, TASK_MAP), done: t.done || false }));
  const { error: upsertErr } = await supabase.from("tasks").upsert(rows);
  if (upsertErr) { console.error("[saveAllTasks] upsert failed:", upsertErr); return; }
  // Only delete orphans AFTER upsert succeeds
  const ids = tasks.map(t => t.id).filter(Boolean);
  if (ids.length > 0) {
    await supabase.from("tasks").delete().eq("household_id", hhId).not("id", "in", `(${ids.join(",")})`);
  }
};

export const saveAllShopping = async (hhId, items) => {
  if (items.length === 0) {
    await supabase.from("shopping_items").delete().eq("household_id", hhId);
    return;
  }
  const rows = items.map(s => ({
    id: s.id, household_id: hhId, name: s.name,
    qty: s.qty || null, category: s.category || "אחר", got: s.got || false,
    got_by: s.got ? (s.gotBy || null) : null,
    got_at: s.got ? (s.gotAt || null) : null,
  }));
  const { error: upsertErr } = await supabase.from("shopping_items").upsert(rows);
  if (upsertErr) { console.error("[saveAllShopping] upsert failed:", upsertErr); return; }
  const ids = items.map(s => s.id).filter(Boolean);
  if (ids.length > 0) {
    await supabase.from("shopping_items").delete().eq("household_id", hhId).not("id", "in", `(${ids.join(",")})`);
  }
};

export const saveAllEvents = async (hhId, events) => {
  if (events.length === 0) {
    await supabase.from("events").delete().eq("household_id", hhId);
    return;
  }
  const rows = events.map(e => ({ household_id: hhId, ...toDb(e, EVENT_MAP) }));
  const { error: upsertErr } = await supabase.from("events").upsert(rows);
  if (upsertErr) { console.error("[saveAllEvents] upsert failed:", upsertErr); return; }
  const ids = events.map(e => e.id).filter(Boolean);
  if (ids.length > 0) {
    await supabase.from("events").delete().eq("household_id", hhId).not("id", "in", `(${ids.join(",")})`);
  }
};

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
