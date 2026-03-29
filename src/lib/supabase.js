import { createClient } from "@supabase/supabase-js";

const SB_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co";
const SB_KEY = "sb_publishable_w5_9MXaM2XAZRk2b8rquoQ_kFpcUMTA";
export const supabase = createClient(SB_URL, SB_KEY);

export const sbGet = async (hhId) => {
  const { data } = await supabase
    .from("households")
    .select("data")
    .eq("id", hhId)
    .single();
  return data?.data || null;
};

export const sbSet = async (hhId, data) => {
  await supabase
    .from("households")
    .upsert({ id: hhId, data, updated_at: new Date().toISOString() });
};

export const lsGet = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
export const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

export const uid8 = () => Math.random().toString(36).slice(2, 10);
export const uid  = () => Math.random().toString(36).slice(2, 6);

// ─── Normalized table functions (v2 — used by both web app AND WhatsApp bot) ───

// Load household + all related data from normalized tables
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
      members: (membersRes.data || []).map(m => ({ id: m.id, name: m.display_name })),
    },
    tasks: tasksRes.data || [],
    shopping: (shoppingRes.data || []).map(s => ({
      ...s,
      // Normalize field names: DB uses "got", app uses "got" — already matching
    })),
    events: eventsRes.data || [],
  };
};

// Save a single task
export const saveTask = async (hhId, task) => {
  const { error } = await supabase.from("tasks").upsert({
    id: task.id,
    household_id: hhId,
    title: task.title,
    assigned_to: task.assignedTo || task.assigned_to || null,
    done: task.done || false,
    completed_by: task.completedBy || task.completed_by || null,
    completed_at: task.completedAt || task.completed_at || null,
  });
  if (error) console.error("[saveTask]", error);
};

// Save a single shopping item
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

// Save a single event
export const saveEvent = async (hhId, event) => {
  const { error } = await supabase.from("events").upsert({
    id: event.id,
    household_id: hhId,
    title: event.title,
    assigned_to: event.assignedTo || event.assigned_to || null,
    scheduled_for: event.scheduledFor || event.scheduled_for,
  });
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

// Save all tasks (used when AI chat returns a full array)
export const saveAllTasks = async (hhId, tasks) => {
  // Delete existing, insert fresh — simplest approach for AI-returned arrays
  await supabase.from("tasks").delete().eq("household_id", hhId);
  if (tasks.length > 0) {
    const rows = tasks.map(t => ({
      id: t.id,
      household_id: hhId,
      title: t.title,
      assigned_to: t.assignedTo || t.assigned_to || null,
      done: t.done || false,
      completed_by: t.completedBy || t.completed_by || null,
      completed_at: t.completedAt || t.completed_at || null,
    }));
    await supabase.from("tasks").insert(rows);
  }
};

export const saveAllShopping = async (hhId, items) => {
  await supabase.from("shopping_items").delete().eq("household_id", hhId);
  if (items.length > 0) {
    const rows = items.map(s => ({
      id: s.id,
      household_id: hhId,
      name: s.name,
      qty: s.qty || null,
      category: s.category || "Other",
      got: s.got || false,
    }));
    await supabase.from("shopping_items").insert(rows);
  }
};

export const saveAllEvents = async (hhId, events) => {
  await supabase.from("events").delete().eq("household_id", hhId);
  if (events.length > 0) {
    const rows = events.map(e => ({
      id: e.id,
      household_id: hhId,
      title: e.title,
      assigned_to: e.assignedTo || e.assigned_to || null,
      scheduled_for: e.scheduledFor || e.scheduled_for,
    }));
    await supabase.from("events").insert(rows);
  }
};
