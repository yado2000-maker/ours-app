import { supabase } from "./supabase.js";

/**
 * Try to find an existing household for the authenticated user.
 * Checks multiple strategies in order:
 *   1) household_members by user_id
 *   2) households_v2 created_by
 *   3) Old blob households table (solo founder / testing)
 *   4) If only ONE household exists, suggest it (for early testing phase)
 */
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

export async function detectHousehold(userId, userEmail) {
  // Method 1: Check household_members for this user_id (3s timeout)
  try {
    const { data: membership } = await withTimeout(
      supabase.from("household_members").select("household_id").eq("user_id", userId).limit(1).single(),
      3000
    ) || {};

    if (membership?.household_id) {
      return await withTimeout(loadHouseholdInfo(membership.household_id), 3000);
    }
  } catch {
    // No membership found — continue
  }

  // Method 2: Check households_v2 created_by (3s timeout)
  try {
    const { data: created } = await withTimeout(
      supabase.from("households_v2").select("id, name").eq("created_by", userId).limit(1).single(),
      3000
    ) || {};

    if (created) {
      return await withTimeout(loadHouseholdInfo(created.id), 3000);
    }
  } catch {
    // Not a creator — continue
  }

  // Methods 3-4 removed: they grabbed ANY household without ownership check.
  // Only Methods 1-2 (membership + created_by) are safe.

  return null;
}

/**
 * Load full household info (name, lang, members) from both v2 tables
 * and old blob as fallback.
 */
async function loadHouseholdInfo(hhId) {
  try {
    const [hhRes, membersRes] = await Promise.all([
      supabase.from("households_v2").select("id, name, lang").eq("id", hhId).single(),
      supabase.from("household_members").select("display_name").eq("household_id", hhId),
    ]);

    if (hhRes.data) {
      return {
        id: hhRes.data.id,
        name: hhRes.data.name,
        lang: hhRes.data.lang || "he",
        members: (membersRes.data || []).map((m) => ({ name: m.display_name })),
      };
    }

    // Fallback: try old blob table
    const { data: old } = await supabase
      .from("households")
      .select("id, data")
      .eq("id", hhId)
      .single();

    if (old?.data?.hh) {
      return {
        id: hhId,
        name: old.data.hh.name,
        lang: old.data.hh.lang || "he",
        members: (old.data.hh.members || []).map((m) => ({ name: m.name })),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Join a household by code (verify it exists, then return info).
 * Throws if not found.
 */
export async function joinByCode(code) {
  const info = await loadHouseholdInfo(code);
  if (!info) throw new Error("Household not found");
  return info;
}
