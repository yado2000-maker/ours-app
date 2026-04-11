// Action Executor — Creates/updates records in Supabase based on AI classification

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { ClassifiedAction } from "./ai-classifier.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const uid4 = () => Math.random().toString(36).slice(2, 6);

// ─── Normalization & Dedup Helpers ───

const CONTAINER_PREFIXES = /^(בקבוק|בקבוקי|חבילת|חבילות|שקית|שקיות|קופסת|קופסאות|פחית|פחיות|ארגז|שלישיית)\s+/;
const QTY_PREFIX = /^(\d+\.?\d*)\s+/;
const DESCRIPTOR_SUFFIX = /\s+(ליטר|מ"ל|מל|גרם|ג'|קילו|ק"ג|יחידות|זוגות)(\s+.+)?$/;
const REPEATED_LETTERS = /(.)\1{2,}/g; // 3+ repeated chars → collapse to 2

interface ParsedProduct {
  name: string;       // Core product name (for comparison)
  qty: string | null;  // Extracted quantity
  fullName: string;    // Original text (for display)
}

function extractProduct(text: string): ParsedProduct {
  let remaining = text.trim();
  const fullName = remaining;

  // Extract leading quantity
  let qty: string | null = null;
  const qtyMatch = remaining.match(QTY_PREFIX);
  if (qtyMatch) {
    qty = qtyMatch[1];
    remaining = remaining.slice(qtyMatch[0].length);
  }

  // Strip container prefixes
  remaining = remaining.replace(CONTAINER_PREFIXES, "");

  // Strip trailing descriptors (ליטר וחצי, 500 מל, etc.)
  remaining = remaining.replace(DESCRIPTOR_SUFFIX, "");

  // Collapse repeated letters (ספרייייט → ספריט)
  remaining = remaining.replace(REPEATED_LETTERS, "$1$1");

  return {
    name: remaining.trim(),
    qty,
    fullName,
  };
}

function isSameProduct(a: string, b: string): boolean {
  const na = a.replace(REPEATED_LETTERS, "$1$1").trim();
  const nb = b.replace(REPEATED_LETTERS, "$1$1").trim();
  if (na === nb) return true;
  if (na.length >= 2 && nb.length >= 2) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

const TASK_FILLER = /^(את\s+|ה|ל|ב)/;

function normalizeTaskTitle(text: string): string {
  return text
    .trim()
    .replace(TASK_FILLER, "")
    .replace(REPEATED_LETTERS, "$1$1")
    .trim();
}

function isSameTask(a: string, b: string): boolean {
  const na = normalizeTaskTitle(a);
  const nb = normalizeTaskTitle(b);
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

function isSameEvent(
  existingTitle: string,
  newTitle: string,
  existingDate: string,
  newDate: string
): boolean {
  const eDate = existingDate.slice(0, 10); // "YYYY-MM-DD"
  const nDate = newDate.slice(0, 10);
  if (eDate !== nDate) return false;
  return isSameTask(existingTitle, newTitle);
}

export async function executeActions(
  householdId: string,
  actions: ClassifiedAction[]
): Promise<{ success: boolean; summary: string[] }> {
  const summary: string[] = [];
  let success = true;

  for (const action of actions) {
    try {
      switch (action.type) {
        case "add_task": {
          const { title, assigned_to } = action.data as { title: string; assigned_to?: string };

          // Check for existing similar open task
          const { data: existingTasks } = await supabase
            .from("tasks")
            .select("id, title, assigned_to")
            .eq("household_id", householdId)
            .eq("done", false);

          const taskMatch = (existingTasks || []).find((existing: any) => {
            if (!isSameTask(existing.title, title)) return false;
            // Same title + different assignee = different task (e.g. turns/rotation)
            if (assigned_to && existing.assigned_to && assigned_to !== existing.assigned_to) return false;
            return true;
          });

          if (taskMatch) {
            summary.push(`Task-exists: "${taskMatch.title}"`);
          } else {
            const { error } = await supabase.from("tasks").insert({
              id: uid4(),
              household_id: householdId,
              title,
              assigned_to: assigned_to || null,
              done: false,
            });
            if (error) throw error;
            summary.push(`Task: "${title}"${assigned_to ? ` → ${assigned_to}` : ""}`);
          }
          break;
        }

        case "add_shopping": {
          const { items } = action.data as {
            items: Array<{ name: string; qty?: string; category?: string }>;
          };

          // Fetch existing open shopping items for dedup
          const { data: existingItems } = await supabase
            .from("shopping_items")
            .select("id, name, qty, category")
            .eq("household_id", householdId)
            .eq("got", false);

          for (const item of items || []) {
            const parsed = extractProduct(item.name);

            // Check for existing similar product
            const match = (existingItems || []).find((existing: any) => {
              const existingParsed = extractProduct(existing.name);
              return isSameProduct(parsed.name, existingParsed.name);
            });

            if (match) {
              // Duplicate found — decide: update or skip
              const incomingQty = item.qty || parsed.qty;
              const existingQty = match.qty;
              const updates: Record<string, any> = {};

              if (incomingQty && incomingQty !== existingQty) {
                updates.qty = incomingQty;
              }
              if (item.name.length > match.name.length) {
                updates.name = item.name;
              }

              if (Object.keys(updates).length > 0) {
                const { error: updateError } = await supabase.from("shopping_items")
                  .update(updates)
                  .eq("id", match.id);
                if (updateError) throw updateError;
                summary.push(`Shopping-updated: "${match.name}" → qty ${updates.qty || existingQty}`);
              } else {
                summary.push(`Shopping-exists: "${match.name}"`);
              }
            } else {
              // No duplicate — INSERT as usual
              const { error } = await supabase.from("shopping_items").insert({
                id: uid4(),
                household_id: householdId,
                name: item.name,
                qty: item.qty || parsed.qty || null,
                category: item.category || "אחר",
                got: false,
              });
              if (error) throw error;
              summary.push(`Shopping: "${item.name}"${(item.qty || parsed.qty) ? ` ×${item.qty || parsed.qty}` : ""}`);
            }
          }
          break;
        }

        case "add_event": {
          const { title, assigned_to, scheduled_for } = action.data as {
            title: string;
            assigned_to?: string;
            scheduled_for: string;
          };

          // Check for existing similar event on same date
          const datePrefix = scheduled_for.slice(0, 10); // "YYYY-MM-DD"
          const { data: existingEvents } = await supabase
            .from("events")
            .select("id, title, scheduled_for")
            .eq("household_id", householdId)
            .gte("scheduled_for", `${datePrefix}T00:00:00`)
            .lte("scheduled_for", `${datePrefix}T23:59:59`);

          const eventMatch = (existingEvents || []).find((existing: any) =>
            isSameEvent(existing.title, title, existing.scheduled_for, scheduled_for)
          );

          if (eventMatch) {
            summary.push(`Event-exists: "${eventMatch.title}"`);
          } else {
            const { error } = await supabase.from("events").insert({
              id: uid4(),
              household_id: householdId,
              title,
              assigned_to: assigned_to || null,
              scheduled_for: scheduled_for,
            });
            if (error) throw error;
            summary.push(`Event: "${title}" @ ${scheduled_for}`);
          }
          break;
        }

        case "complete_task": {
          const { id } = action.data as { id: string };
          const { error } = await supabase
            .from("tasks")
            .update({ done: true, completed_at: new Date().toISOString() })
            .eq("id", id)
            .eq("household_id", householdId);
          if (error) throw error;
          summary.push(`Completed task: ${id}`);
          break;
        }

        case "complete_shopping": {
          const { id } = action.data as { id: string };
          const { error } = await supabase
            .from("shopping_items")
            .update({ got: true })
            .eq("id", id)
            .eq("household_id", householdId);
          if (error) throw error;
          summary.push(`Got shopping item: ${id}`);
          break;
        }

        case "assign_task": {
          const { id, assigned_to } = action.data as { id: string; assigned_to: string };
          const { error } = await supabase
            .from("tasks")
            .update({ assigned_to })
            .eq("id", id)
            .eq("household_id", householdId);
          if (error) throw error;
          summary.push(`Assigned task ${id} → ${assigned_to}`);
          break;
        }

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
            const { error } = await supabase.from("rotations")
              .update({ members: JSON.stringify(members), type: rotation_type, frequency: frequency ? JSON.stringify(frequency) : null, current_index: 0 })
              .eq("id", rotMatch.id);
            if (error) throw error;
            summary.push(`Rotation-updated: "${title}" (${members.join(" ← ")})`);
          } else {
            const rotId = Math.random().toString(36).slice(2, 10);
            const { error } = await supabase.from("rotations").insert({
              id: rotId,
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

        default:
          console.warn(`[ActionExecutor] Unknown action type: ${action.type}`);
      }
    } catch (err) {
      console.error(`[ActionExecutor] Error executing ${action.type}:`, err);
      success = false;
    }
  }

  return { success, summary };
}
