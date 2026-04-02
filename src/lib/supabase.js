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
export const uid  = () => Math.random().toString(36).slice(2, 6);

// ─── Normalized table functions (v2) ───

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

export const saveTask = async (hhId, task) => {
  const row = { household_id: hhId, ...toDb(task, TASK_MAP) };
  if (!row.done) row.done = false;
  const { error } = await supabase.from("tasks").upsert(row);
  if (error) console.error("[saveTask]", error);
};

export const saveShoppingItem = async (hhId, item) => {
  const { error } = await supabase.from("shopping_items").upsert({
    id: item.id,
    household_id: hhId,
    name: item.name,
    qty: item.qty || null,
    category: item.category || "Other",
    got: item.got || false,
  });
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

export const saveAllTasks = async (hhId, tasks) => {
  await supabase.from("tasks").delete().eq("household_id", hhId);
  if (tasks.length === 0) return;
  const rows = tasks.map(t => ({ household_id: hhId, ...toDb(t, TASK_MAP), done: t.done || false }));
  const { error } = await supabase.from("tasks").insert(rows);
  if (error) console.error("[saveAllTasks]", error);
};

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

export const saveAllEvents = async (hhId, events) => {
  await supabase.from("events").delete().eq("household_id", hhId);
  if (events.length === 0) return;
  const rows = events.map(e => ({ household_id: hhId, ...toDb(e, EVENT_MAP) }));
  const { error } = await supabase.from("events").insert(rows);
  if (error) console.error("[saveAllEvents]", error);
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
