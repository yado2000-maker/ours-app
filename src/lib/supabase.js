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
