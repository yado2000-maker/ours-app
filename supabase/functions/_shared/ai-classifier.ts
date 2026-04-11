// AI Classifier — Determines if WhatsApp messages are actionable
// and extracts structured data (tasks, shopping items, events)

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

export interface ClassifiedAction {
  type: "add_task" | "add_shopping" | "add_event" | "complete_task" | "complete_shopping" | "add_reminder" | "assign_task" | "create_rotation" | "override_rotation";
  data: Record<string, unknown>;
}

export interface ClassificationResult {
  respond: boolean;
  reply: string;
  actions: ClassifiedAction[];
}

interface HouseholdContext {
  householdName: string;
  members: Array<{ name: string; phone?: string }>;
  language: string;
  currentTasks: Array<{ id: string; title: string; assigned_to: string | null; done: boolean }>;
  currentShopping: Array<{ id: string; name: string; qty: string | null; got: boolean }>;
  currentEvents: Array<{ id: string; title: string; assigned_to: string | null; scheduled_for: string }>;
}

export async function buildHouseholdContext(householdId: string): Promise<HouseholdContext | null> {
  // Fetch household info
  const { data: household } = await supabase
    .from("households_v2")
    .select("name, lang")
    .eq("id", householdId)
    .single();

  if (!household) return null;

  // Fetch members with phone mapping
  const { data: members } = await supabase
    .from("household_members")
    .select("display_name")
    .eq("household_id", householdId);

  const { data: phoneMap } = await supabase
    .from("whatsapp_member_mapping")
    .select("member_name, phone_number")
    .eq("household_id", householdId);

  // Fetch current state
  const [tasksRes, shoppingRes, eventsRes] = await Promise.all([
    supabase.from("tasks").select("id, title, assigned_to, done").eq("household_id", householdId),
    supabase.from("shopping_items").select("id, name, qty, got").eq("household_id", householdId),
    supabase.from("events").select("id, title, assigned_to, scheduled_for").eq("household_id", householdId)
      .gte("scheduled_for", new Date().toISOString()),
  ]);

  const memberList = (members || []).map((m) => {
    const phone = phoneMap?.find((p) => p.member_name === m.display_name)?.phone_number;
    return { name: m.display_name, phone };
  });

  return {
    householdName: household.name,
    members: memberList,
    language: household.lang || "he",
    currentTasks: tasksRes.data || [],
    currentShopping: shoppingRes.data || [],
    currentEvents: eventsRes.data || [],
  };
}

function buildSystemPrompt(ctx: HouseholdContext): string {
  const isHe = ctx.language === "he";
  const today = new Date();
  const hebrewDayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const englishDayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayNames = isHe ? hebrewDayNames : englishDayNames;

  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name = dayNames[d.getDay()];
    return `${name} = ${iso}${i === 0 ? " (today)" : ""}`;
  }).join(", ");

  const langInstructions = isHe
    ? `ALWAYS respond in Hebrew. Warm and direct, like a helpful family member.
Use plural imperative: "הוספתי", "סימנתי", "הזכרתי" — not singular.
Keep responses SHORT — 1-2 lines max. No filler. This is WhatsApp, not email.`
    : `Respond in English. Warm and direct, like a helpful family member.
Keep responses SHORT — 1-2 lines max. This is WhatsApp, not email.`;

  const memberNames = ctx.members.map((m) => m.name).join(", ");

  const openTasks = ctx.currentTasks.filter((t) => !t.done);
  const tasksStr = openTasks.length === 0
    ? "(none)"
    : openTasks.map((t) => `• ${t.title}${t.assigned_to ? ` → ${t.assigned_to}` : ""} (id:${t.id})`).join("\n");

  const needShopping = ctx.currentShopping.filter((s) => !s.got);
  const shoppingStr = needShopping.length === 0
    ? "(empty)"
    : needShopping.map((s) => `• ${s.name}${s.qty ? ` ×${s.qty}` : ""} (id:${s.id})`).join("\n");

  const eventsStr = ctx.currentEvents.length === 0
    ? "(none)"
    : ctx.currentEvents.map((e) => `• ${e.title}${e.assigned_to ? ` → ${e.assigned_to}` : ""} @ ${e.scheduled_for} (id:${e.id})`).join("\n");

  const hebrewPatterns = isHe ? `
HEBREW FAMILY CHAT PATTERNS — critical for correct classification:

1. IMPLICIT SHOPPING: A bare noun or short phrase = "add to shopping list."
   "חלב" → add milk. "3 חלב" → add 3 milks. "עוד חלב" → add more milk.

2. IMPLICIT TASKS: "[person] [activity] [time]" = task assignment.
   "נועה חוג 5" → "Pick up Noa from activity at 5pm"

3. QUESTION = UNASSIGNED TASK: "מי אוסף?" → Create task, no assignee.

4. CONFIRMATION = TASK CLAIM: "אני" or "אני לוקח/ת" after a task → assign to speaker.

5. HEBREW TIME: "ב5" = 17:00. "בצהריים" = ~12:00-14:00. "אחרי הגן" = ~16:00. "לפני שבת" = Friday before sunset.

6. SKIP THESE — not actionable: greetings ("בוקר טוב"), goodnight ("לילה טוב"), reactions ("😂","👍"), photos without text, forwarded messages, memes, social chatter, "אמן", "בהצלחה".

7. MIXED HEBREW-ENGLISH: "יש meeting ב-3" → Event at 15:00. "צריך milk" → Shopping: milk.

8. ABBREVIATIONS: "סבבה" = OK/confirmation. "בנט"/"בט" = meanwhile. "תיכף" = soon. "אחלה" = great.

HEBREW DAY NAMES:
יום ראשון = Sunday, יום שני = Monday, יום שלישי = Tuesday, יום רביעי = Wednesday, יום חמישי = Thursday, יום שישי = Friday, שבת = Saturday
` : "";

  return `You are Ours — an AI family assistant in the ${ctx.householdName} WhatsApp group.
${langInstructions}

Members: ${memberNames}
Today: ${today.toISOString().slice(0, 10)} (${dayNames[today.getDay()]})
Upcoming days: ${upcomingDays}

CURRENT TASKS:
${tasksStr}

CURRENT SHOPPING LIST:
${shoppingStr}

UPCOMING EVENTS:
${eventsStr}
${hebrewPatterns}

YOUR JOB: Read the WhatsApp messages below. Decide if any are ACTIONABLE (contain a task, shopping item, event, or task completion). If so, extract the actions and write a SHORT confirmation reply.

If messages are purely social (greetings, jokes, photos, reactions, family chat) — set respond=false and take no actions. MOST messages will be social — don't over-classify.

Respond ONLY as this JSON — no other text:
{
  "respond": true/false,
  "reply": "your short message (only if respond=true)",
  "actions": [
    {"type": "add_task", "data": {"title": "...", "assigned_to": "name or null"}},
    {"type": "add_shopping", "data": {"items": [{"name": "...", "qty": "1", "category": "..."}]}},
    {"type": "add_event", "data": {"title": "...", "assigned_to": "name or null", "scheduled_for": "ISO 8601"}},
    {"type": "complete_task", "data": {"id": "task_id"}},
    {"type": "complete_shopping", "data": {"id": "item_id"}}
  ]
}

${isHe ? 'Shopping categories (Hebrew): פירות וירקות, חלב וביצים, בשר ודגים, מאפים, מזווה, מוצרים קפואים, משקאות, ניקוי ובית, מוצרים מחנות הטבע, אחר' : 'Shopping categories: Produce, Dairy, Meat, Bakery, Pantry, Frozen, Drinks, Household, Health Store, Other'}

Generate 4-char alphanumeric IDs for new items.`.trim();
}

export async function classifyMessages(
  householdId: string,
  messages: Array<{ sender: string; text: string; timestamp: number }>
): Promise<ClassificationResult> {
  const ctx = await buildHouseholdContext(householdId);
  if (!ctx) {
    return { respond: false, reply: "", actions: [] };
  }

  const systemPrompt = buildSystemPrompt(ctx);

  // Format messages for Claude
  const formattedMsgs = messages
    .map((m) => `[${m.sender}]: ${m.text}`)
    .join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: formattedMsgs }],
      }),
    });

    if (!res.ok) {
      console.error("[AI Classifier] API error:", res.status, await res.text());
      return { respond: false, reply: "", actions: [] };
    }

    const data = await res.json();
    const raw = (data.content?.[0]?.text || "{}").replace(/```json\n?|```/g, "").trim();

    try {
      const parsed = JSON.parse(raw);
      return {
        respond: !!parsed.respond,
        reply: parsed.reply || "",
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    } catch {
      console.error("[AI Classifier] JSON parse error:", raw);
      return { respond: false, reply: "", actions: [] };
    }
  } catch (err) {
    console.error("[AI Classifier] Fetch error:", err);
    return { respond: false, reply: "", actions: [] };
  }
}
