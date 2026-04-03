// Action Executor — Creates/updates records in Supabase based on AI classification

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { ClassifiedAction } from "./ai-classifier.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const uid4 = () => Math.random().toString(36).slice(2, 6);

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
          const { error } = await supabase.from("tasks").insert({
            id: uid4(),
            household_id: householdId,
            title,
            assigned_to: assigned_to || null,
            done: false,
          });
          if (error) throw error;
          summary.push(`Task: "${title}"${assigned_to ? ` → ${assigned_to}` : ""}`);
          break;
        }

        case "add_shopping": {
          const { items } = action.data as {
            items: Array<{ name: string; qty?: string; category?: string }>;
          };
          for (const item of items || []) {
            const { error } = await supabase.from("shopping_items").insert({
              id: uid4(),
              household_id: householdId,
              name: item.name,
              qty: item.qty || null,
              category: item.category || "אחר",
              got: false,
            });
            if (error) throw error;
            summary.push(`Shopping: "${item.name}"${item.qty ? ` ×${item.qty}` : ""}`);
          }
          break;
        }

        case "add_event": {
          const { title, assigned_to, scheduled_for } = action.data as {
            title: string;
            assigned_to?: string;
            scheduled_for: string;
          };
          const { error } = await supabase.from("events").insert({
            id: uid4(),
            household_id: householdId,
            title,
            assigned_to: assigned_to || null,
            scheduled_for: scheduled_for,
          });
          if (error) throw error;
          summary.push(`Event: "${title}" @ ${scheduled_for}`);
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
