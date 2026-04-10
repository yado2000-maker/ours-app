import { supabase } from "./supabase.js";

/**
 * Try to find an existing household for the authenticated user.
 * Checks in order:
 *   1) household_members by user_id
 *   2) households_v2 created_by
 */
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

export async function detectHousehold(userId, userEmail, userPhone) {
  // Method 0: RPC link_user_to_household — SECURITY DEFINER, bypasses RLS
  // Links auth user to their household member row via phone or created_by match
  // Retry once on failure/timeout (cold-start resilience)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: linkedHhId, error: rpcErr } = await withTimeout(
        supabase.rpc("link_user_to_household", { p_phone: userPhone || "", p_email: userEmail || "" }),
        5000
      ) || {};

      if (rpcErr) {
        console.warn(`[Detect] RPC attempt ${attempt + 1} error:`, rpcErr.message);
        if (attempt === 0) continue; // retry once
      }

      if (linkedHhId) {
        console.log("[Detect] RPC linked to household:", linkedHhId);
        return await withTimeout(loadHouseholdInfo(linkedHhId), 3000);
      }
      break; // null result = no match, don't retry
    } catch (e) {
      console.warn(`[Detect] RPC attempt ${attempt + 1} failed:`, e.message);
      if (attempt === 0) continue; // retry once
    }
  }

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

  return null;
}

/**
 * Load full household info (name, lang, members) from v2 tables.
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
