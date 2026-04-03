// ============================================================================
// WhatsApp Webhook Edge Function — INLINED VERSION
// Auto-generated from modular sources on 2026-04-03
//
// This file combines all code from:
//   1. supabase/functions/_shared/whatsapp-provider.ts
//   2. supabase/functions/_shared/haiku-classifier.ts
//   3. supabase/functions/_shared/reply-generator.ts
//   4. supabase/functions/_shared/ai-classifier.ts
//   5. supabase/functions/_shared/action-executor.ts
//   6. supabase/functions/whatsapp-webhook/index.ts
//
// Supabase Edge Functions don't support cross-function shared imports,
// so this single file is what gets deployed via deploy_edge_function.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── Shared Supabase Client ───
// (ai-classifier.ts, action-executor.ts, and index.ts each created their own —
//  consolidated here into one shared instance)

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

// ─── WhatsApp Provider Types (from whatsapp-provider.ts) ───

interface IncomingMessage {
  messageId: string;
  groupId: string;
  senderPhone: string;
  senderName: string;
  text: string;
  type: "text" | "image" | "sticker" | "voice" | "video" | "document" | "reaction" | "other";
  timestamp: number;
}

interface OutgoingMessage {
  groupId: string;
  text: string;
}

interface GroupEvent {
  type: "group_event";
  groupId: string;
  subtype: "add" | "remove" | "promote" | "demote";
  participants: string[]; // phone numbers (without @s.whatsapp.net)
  actorPhone: string;     // who performed the action
  timestamp: number;
}

interface WhatsAppProvider {
  name: string;
  verifyWebhook(req: Request): Promise<boolean>;
  parseIncoming(body: unknown): IncomingMessage | null;
  parseGroupEvent?(body: unknown): GroupEvent | null;
  sendMessage(msg: OutgoingMessage): Promise<boolean>;
  sendTemplate?(groupId: string, template: string, params: Record<string, string>): Promise<boolean>;
}

// ─── Haiku Classifier Types (from haiku-classifier.ts) ───

interface ClassificationOutput {
  intent:
    | "add_task"
    | "add_shopping"
    | "add_event"
    | "complete_task"
    | "complete_shopping"
    | "ignore"
    | "question"
    | "claim_task"
    | "info_request";
  confidence: number; // 0.0 - 1.0
  entities: {
    person?: string;
    items?: Array<{ name: string; qty?: string; category?: string }>;
    title?: string;
    time_raw?: string;
    time_iso?: string;
    task_id?: string;
    item_id?: string;
    raw_text: string;
  };
}

interface ClassifierContext {
  members: string[];
  openTasks: Array<{ id: string; title: string; assigned_to: string | null }>;
  openShopping: Array<{ id: string; name: string; qty: string | null }>;
  today: string; // ISO date "2026-04-02"
  dayOfWeek: string; // Hebrew day name "רביעי"
}

// ─── Reply Generator Types (from reply-generator.ts) ───

interface ReplyContext {
  householdName: string;
  members: string[];
  language: string;
  currentTasks: Array<{ id: string; title: string; assigned_to: string | null; done: boolean }>;
  currentShopping: Array<{ id: string; name: string; qty: string | null; got: boolean }>;
  currentEvents: Array<{ id: string; title: string; assigned_to: string | null; scheduled_for: string }>;
}

interface ReplyResult {
  reply: string;
  model: string;
}

// ─── AI Classifier Types (from ai-classifier.ts) ───

interface ClassifiedAction {
  type: "add_task" | "add_shopping" | "add_event" | "complete_task" | "complete_shopping";
  data: Record<string, unknown>;
}

interface ClassificationResult {
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

// ============================================================================
// WHATSAPP PROVIDER (from whatsapp-provider.ts)
// ============================================================================

// ─── Whapi.Cloud Provider (Interim) ───

class WhapiProvider implements WhatsAppProvider {
  name = "whapi";
  private apiUrl: string;
  private token: string;

  constructor() {
    this.apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
    this.token = Deno.env.get("WHAPI_TOKEN") || "";
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    // Whapi uses a simple bearer token for webhook verification
    const authHeader = req.headers.get("authorization");
    const webhookToken = Deno.env.get("WHAPI_WEBHOOK_TOKEN");
    if (!webhookToken) return true; // Skip verification if no token set (dev mode)
    return authHeader === `Bearer ${webhookToken}`;
  }

  parseIncoming(body: unknown): IncomingMessage | null {
    try {
      const data = body as Record<string, unknown>;

      // Whapi webhook format: https://whapi.readme.io/reference/webhooks
      const messages = (data.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const chatId = msg.chat_id as string || "";

      // Only process group messages (group IDs end with @g.us)
      if (!chatId.endsWith("@g.us")) return null;

      const from = msg.from as string || "";
      const fromName = msg.from_name as string || from;
      const text = (msg.text as Record<string, string>)?.body || "";
      const type = msg.type as string || "text";
      const id = msg.id as string || "";
      const timestamp = (msg.timestamp as number) || Math.floor(Date.now() / 1000);

      // Map Whapi message types to our types
      const typeMap: Record<string, IncomingMessage["type"]> = {
        text: "text",
        image: "image",
        sticker: "sticker",
        ptt: "voice",
        audio: "voice",
        video: "video",
        document: "document",
        reaction: "reaction",
      };

      return {
        messageId: id,
        groupId: chatId,
        senderPhone: from.replace("@s.whatsapp.net", ""),
        senderName: fromName,
        text: text,
        type: typeMap[type] || "other",
        timestamp,
      };
    } catch (err) {
      console.error("[WhapiProvider] Parse error:", err);
      return null;
    }
  }

  parseGroupEvent(body: unknown): GroupEvent | null {
    try {
      const data = body as Record<string, unknown>;
      const messages = (data.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const type = msg.type as string || "";

      // Whapi sends group events as type "action" with subtypes: add, remove, promote, demote
      if (type !== "action") return null;

      const chatId = msg.chat_id as string || "";
      if (!chatId.endsWith("@g.us")) return null;

      const subtype = msg.subtype as string || "";
      const validSubtypes = ["add", "remove", "promote", "demote"];
      if (!validSubtypes.includes(subtype)) return null;

      const action = msg.action as Record<string, unknown> || {};
      const rawParticipants = (action.participants || []) as string[];
      const participants = rawParticipants.map((p: string) => p.replace("@s.whatsapp.net", ""));

      const from = msg.from as string || "";
      const timestamp = (msg.timestamp as number) || Math.floor(Date.now() / 1000);

      return {
        type: "group_event",
        groupId: chatId,
        subtype: subtype as GroupEvent["subtype"],
        participants,
        actorPhone: from.replace("@s.whatsapp.net", ""),
        timestamp,
      };
    } catch (err) {
      console.error("[WhapiProvider] parseGroupEvent error:", err);
      return null;
    }
  }

  async sendMessage(msg: OutgoingMessage): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/messages/text`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: msg.groupId,
          body: msg.text,
        }),
      });
      return res.ok;
    } catch (err) {
      console.error("[WhapiProvider] Send error:", err);
      return false;
    }
  }
}

// ─── Meta Cloud API Provider (Target) ───

class MetaCloudProvider implements WhatsAppProvider {
  name = "meta";
  private phoneNumberId: string;
  private accessToken: string;
  private appSecret: string;

  constructor() {
    this.phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID") || "";
    this.accessToken = Deno.env.get("META_ACCESS_TOKEN") || "";
    this.appSecret = Deno.env.get("META_APP_SECRET") || "";
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    // Meta uses HMAC-SHA256 signature verification
    const signature = req.headers.get("x-hub-signature-256") || "";
    if (!signature || !this.appSecret) return false;

    const body = await req.clone().text();
    const key = new TextEncoder().encode(this.appSecret);
    const data = new TextEncoder().encode(body);
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const hex = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    return hex === signature;
  }

  parseIncoming(body: unknown): IncomingMessage | null {
    try {
      const data = body as Record<string, unknown>;
      const entry = ((data.entry || []) as Array<Record<string, unknown>>)[0];
      if (!entry) return null;

      const changes = ((entry.changes || []) as Array<Record<string, unknown>>)[0];
      if (!changes) return null;

      const value = changes.value as Record<string, unknown>;
      const messages = (value.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const contacts = (value.contacts || []) as Array<Record<string, unknown>>;
      const contact = contacts[0] || {};

      const from = msg.from as string || "";
      const text = (msg.text as Record<string, string>)?.body || "";
      const type = msg.type as string || "text";
      const id = msg.id as string || "";
      const timestamp = parseInt(msg.timestamp as string || "0");

      // For groups, the group_id is in the metadata
      const groupId = (msg as Record<string, unknown>).group_id as string || "";

      return {
        messageId: id,
        groupId,
        senderPhone: from,
        senderName: (contact.profile as Record<string, string>)?.name || from,
        text,
        type: type as IncomingMessage["type"],
        timestamp,
      };
    } catch (err) {
      console.error("[MetaCloudProvider] Parse error:", err);
      return null;
    }
  }

  async sendMessage(msg: OutgoingMessage): Promise<boolean> {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: msg.groupId,
            type: "text",
            text: { body: msg.text },
          }),
        }
      );
      return res.ok;
    } catch (err) {
      console.error("[MetaCloudProvider] Send error:", err);
      return false;
    }
  }
}

// ─── Provider Factory ───

function createProvider(): WhatsAppProvider {
  const providerType = Deno.env.get("WHATSAPP_PROVIDER") || "whapi";
  switch (providerType) {
    case "meta": return new MetaCloudProvider();
    case "whapi": return new WhapiProvider();
    default: return new WhapiProvider();
  }
}

// ============================================================================
// HAIKU CLASSIFIER (from haiku-classifier.ts)
// ============================================================================

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function buildClassifierPrompt(ctx: ClassifierContext): string {
  const tasksStr =
    ctx.openTasks.length === 0
      ? "(none)"
      : ctx.openTasks
          .map(
            (t) =>
              `• ${t.title}${t.assigned_to ? ` → ${t.assigned_to}` : ""} (id:${t.id})`
          )
          .join("\n");

  const shoppingStr =
    ctx.openShopping.length === 0
      ? "(empty)"
      : ctx.openShopping
          .map((s) => `• ${s.name}${s.qty ? ` ×${s.qty}` : ""} (id:${s.id})`)
          .join("\n");

  const hebrewDays = [
    "ראשון",
    "שני",
    "שלישי",
    "רביעי",
    "חמישי",
    "שישי",
    "שבת",
  ];
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ctx.today);
    d.setDate(d.getDate() + i);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${hebrewDays[d.getDay()]} = ${iso}${i === 0 ? " (today)" : ""}`;
  }).join(", ");

  return `You are a Hebrew family WhatsApp message classifier. Classify each message into exactly ONE intent.

INTENTS:
- ignore: Social noise (greetings, reactions, emojis, jokes, chatter, forwarded messages, status updates). ~80% of messages.
- add_shopping: Adding item(s) to shopping list. Bare nouns, "צריך X", "נגמר X", "אין X".
- add_task: Creating a household chore/to-do. "צריך ל...", "[person] [activity] [time]", maintenance requests.
- add_event: Scheduling a specific date/time event. Appointments, classes, dinners, meetings.
- complete_task: Marking an existing task as done. Past tense of open task, "סיימתי", "בוצע".
- complete_shopping: Confirming purchase of a list item. "קניתי", "יש", "לקחתי".
- question: Asking about household state (tasks, schedule, list). "מה צריך?", "מי אוסף?", "מה יש היום?".
- claim_task: Self-assigning an existing open task. "אני אעשה", "אני לוקח/ת", "אני יכול".
- info_request: Asking for information that is NOT a household task. Passwords, phone numbers, prices, codes.

MEMBERS: ${ctx.members.join(", ")}
TODAY: ${ctx.today} (${ctx.dayOfWeek})
UPCOMING: ${upcomingDays}

OPEN TASKS:
${tasksStr}

SHOPPING LIST:
${shoppingStr}

HEBREW PATTERNS:
- Bare noun ("חלב") = add_shopping
- "[person] [activity] [time]" ("נועה חוג 5") = add_task
- "מי [verb]?" = question (not add_task)
- "אני [verb]" matching an open task = claim_task
- Past tense matching open task ("שטפתי כלים") = complete_task
- "קניתי X" / "יש X" matching shopping item = complete_shopping
- Greetings, emojis, reactions, "סבבה", "אמן", "בהצלחה" = ignore
- "מה הסיסמא?", "שלח קוד" = info_request (NOT add_task)
- Hebrew time: "ב5" = 17:00, "בצהריים" = ~12:00, "אחרי הגן" = ~16:00, "לפני שבת" = Friday PM

SHOPPING CATEGORIES (ALWAYS assign one):
פירות וירקות, חלב וביצים, בשר ודגים, מאפים, מזווה, מוצרים קפואים, משקאות, ניקוי ובית, טיפוח, אחר

COMPOUND PRODUCT NAMES — keep as ONE item, do NOT split:
- "חלב אורז" = rice milk (ONE item in חלב וביצים)
- "חלב שקדים" = almond milk (ONE item in חלב וביצים)
- "חלב סויה" = soy milk (ONE item in חלב וביצים)
- "שמן זית" = olive oil (ONE item in מזווה)
- "חמאת בוטנים" = peanut butter (ONE item in מזווה)
- "נייר טואלט" = toilet paper (ONE item in ניקוי ובית)
- "סבון כלים" = dish soap (ONE item in ניקוי ובית)
- "קרם לחות" = moisturizer (ONE item in טיפוח)
- Rule: if two+ words form a single product name, keep them together

HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday

EXAMPLES:
[אמא]: "בוקר טוב!" → {"intent":"ignore","confidence":0.99,"entities":{"raw_text":"בוקר טוב!"}}
[אבא]: "חלב" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב","category":"חלב וביצים"}],"raw_text":"חלב"}}
[אמא]: "חלב אורז" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב אורז","category":"חלב וביצים"}],"raw_text":"חלב אורז"}}
[אבא]: "נייר טואלט וסבון כלים" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"נייר טואלט","category":"ניקוי ובית"},{"name":"סבון כלים","category":"ניקוי ובית"}],"raw_text":"נייר טואלט וסבון כלים"}}
[אמא]: "נועה חוג 5" → {"intent":"add_task","confidence":0.90,"entities":{"person":"נועה","title":"חוג","time_raw":"5","raw_text":"נועה חוג 5"}}
[אבא]: "שטפתי את הכלים" → {"intent":"complete_task","confidence":0.95,"entities":{"task_id":"t1a2","raw_text":"שטפתי את הכלים"}}
[אמא]: "מה צריך מהסופר?" → {"intent":"question","confidence":0.95,"entities":{"raw_text":"מה צריך מהסופר?"}}
[נועה]: "אני אסדר את הארון" → {"intent":"claim_task","confidence":0.90,"entities":{"person":"נועה","task_id":"t5c6","raw_text":"אני אסדר את הארון"}}
[אמא]: "יום שלישי ארוחת ערב אצל סבתא" → {"intent":"add_event","confidence":0.92,"entities":{"title":"ארוחת ערב אצל סבתא","time_raw":"יום שלישי","raw_text":"יום שלישי ארוחת ערב אצל סבתא"}}
[יונתן]: "מה הסיסמא של הוויי פיי?" → {"intent":"info_request","confidence":0.95,"entities":{"raw_text":"מה הסיסמא של הוויי פיי?"}}
[אמא]: "קניתי חלב וביצים" → {"intent":"complete_shopping","confidence":0.95,"entities":{"item_id":"s1a2","raw_text":"קניתי חלב וביצים"}}

RULES:
- Respond with ONLY a JSON object. No other text, no markdown.
- Always include raw_text in entities.
- For complete_task/complete_shopping/claim_task: match against open tasks/shopping IDs above.
- For add_event: include time_raw (Hebrew expression) and time_iso (ISO 8601 with +03:00) if resolvable.
- For add_shopping: extract items into the items array. ALWAYS include category per item. Keep compound product names as ONE item (e.g., "חלב אורז" is ONE item, not two).
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action).`;
}

async function classifyIntent(
  message: string,
  sender: string,
  context: ClassifierContext,
  apiKey?: string
): Promise<ClassificationOutput> {
  const key = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";
  const systemPrompt = buildClassifierPrompt(context);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: `[${sender}]: ${message}` }],
      }),
    });

    if (!res.ok) {
      console.error(
        "[HaikuClassifier] API error:",
        res.status,
        await res.text()
      );
      return fallbackIgnore(message);
    }

    const data = await res.json();
    const raw = (data.content?.[0]?.text || "{}")
      .replace(/```json\n?|```/g, "")
      .trim();

    try {
      const parsed = JSON.parse(raw);
      return {
        intent: parsed.intent || "ignore",
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        entities: {
          ...parsed.entities,
          raw_text: message,
        },
      };
    } catch {
      console.error("[HaikuClassifier] JSON parse error:", raw);
      return fallbackIgnore(message);
    }
  } catch (err) {
    console.error("[HaikuClassifier] Fetch error:", err);
    return fallbackIgnore(message);
  }
}

function fallbackIgnore(message: string): ClassificationOutput {
  return {
    intent: "ignore",
    confidence: 0.0,
    entities: { raw_text: message },
  };
}

// ============================================================================
// SONNET REPLY GENERATOR (from reply-generator.ts)
// ============================================================================

const SONNET_MODEL = "claude-sonnet-4-20250514";

function buildReplyPrompt(
  classification: ClassificationOutput,
  ctx: ReplyContext,
  sender: string
): string {
  const isHe = ctx.language === "he";

  const langInstructions = isHe
    ? `ALWAYS respond in Hebrew. You are Sheli (שלי) — the organized older sister.
Warm, capable, occasionally a little cheeky. Direct and short — 1-2 lines max.
Use gender-neutral plural ("תוסיפו", "בדקו") when addressing the household.
When referring to YOURSELF, ALWAYS use FEMININE forms: "הוספתי", "סימנתי", "בדקתי".
Use names naturally. Give credit when tasks are done.
Occasional dry humor when natural: "חלב? שלישי השבוע".
Emoji when natural — like a 30-year-old Israeli woman would.
Never nag. Never over-explain. Never sound like a chatbot.`
    : `Respond in English. Warm and direct, like a helpful family member.
Keep responses SHORT — 1-2 lines max.`;

  const memberNames = ctx.members.join(", ");

  // Build context about what action was taken
  let actionSummary = "";
  const e = classification.entities;

  switch (classification.intent) {
    case "add_task":
      actionSummary = `A task was just created: "${e.title || e.raw_text}"${e.person ? ` assigned to ${e.person}` : ""}.`;
      break;
    case "add_shopping":
      if (e.items && Array.isArray(e.items)) {
        const itemNames = e.items.map((i: { name: string }) => i.name).join(", ");
        actionSummary = `Shopping item(s) added to the list: ${itemNames}.`;
      } else {
        actionSummary = `A shopping item was added from: "${e.raw_text}".`;
      }
      break;
    case "add_event":
      actionSummary = `An event was scheduled: "${e.title || e.raw_text}"${e.time_raw ? ` at ${e.time_raw}` : ""}.`;
      break;
    case "complete_task":
      actionSummary = `A task was marked as done${e.task_id ? ` (id: ${e.task_id})` : ""}.`;
      break;
    case "complete_shopping":
      actionSummary = `A shopping item was marked as purchased${e.item_id ? ` (id: ${e.item_id})` : ""}.`;
      break;
    case "claim_task":
      actionSummary = `${sender} claimed a task${e.task_id ? ` (id: ${e.task_id})` : ""}.`;
      break;
    case "question":
      actionSummary = `${sender} is asking a question about household state.`;
      break;
    case "info_request":
      actionSummary = `${sender} is requesting information (not a household task).`;
      break;
    default:
      actionSummary = `Message from ${sender}: "${e.raw_text}".`;
  }

  // For questions, include current state so Sheli can answer
  let stateContext = "";
  if (classification.intent === "question") {
    const openTasks = ctx.currentTasks.filter((t) => !t.done);
    const needShopping = ctx.currentShopping.filter((s) => !s.got);

    stateContext = `
CURRENT STATE (use this to answer the question):
Open tasks: ${openTasks.length === 0 ? "(none)" : openTasks.map((t) => `${t.title}${t.assigned_to ? ` → ${t.assigned_to}` : ""}`).join(", ")}
Shopping needed: ${needShopping.length === 0 ? "(empty)" : needShopping.map((s) => `${s.name}${s.qty ? ` ×${s.qty}` : ""}`).join(", ")}
Upcoming events: ${ctx.currentEvents.length === 0 ? "(none)" : ctx.currentEvents.map((e) => `${e.title}${e.assigned_to ? ` → ${e.assigned_to}` : ""} @ ${e.scheduled_for}`).join(", ")}`;
  }

  return `You are Sheli (שלי) — the AI family assistant for ${ctx.householdName}.
${langInstructions}

Members: ${memberNames}
Sender: ${sender}

ACTION JUST TAKEN: ${actionSummary}
${stateContext}

Write a SHORT WhatsApp confirmation reply (1-2 lines max). Be warm but brief.
For questions: answer based on the current state above.
For info_request: say you don't have that info and suggest asking a family member.

Reply with ONLY the message text — no JSON, no formatting, no quotes.`;
}

async function generateReply(
  classification: ClassificationOutput,
  sender: string,
  ctx: ReplyContext,
  apiKey?: string
): Promise<ReplyResult> {
  const key = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";

  // Skip reply for ignore intent (should never be called, but safety)
  if (classification.intent === "ignore") {
    return { reply: "", model: "none" };
  }

  const systemPrompt = buildReplyPrompt(classification, ctx, sender);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 256,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Generate a reply for: [${sender}]: ${classification.entities.raw_text}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error("[ReplyGenerator] API error:", res.status, await res.text());
      return { reply: "", model: SONNET_MODEL };
    }

    const data = await res.json();
    const reply = (data.content?.[0]?.text || "").trim();

    return { reply, model: SONNET_MODEL };
  } catch (err) {
    console.error("[ReplyGenerator] Fetch error:", err);
    return { reply: "", model: SONNET_MODEL };
  }
}

// ============================================================================
// AI CLASSIFIER — Sonnet fallback (from ai-classifier.ts)
// ============================================================================

async function buildHouseholdContext(householdId: string): Promise<HouseholdContext | null> {
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

function buildSonnetClassifierPrompt(ctx: HouseholdContext): string {
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

async function classifyMessages(
  householdId: string,
  messages: Array<{ sender: string; text: string; timestamp: number }>
): Promise<ClassificationResult> {
  const ctx = await buildHouseholdContext(householdId);
  if (!ctx) {
    return { respond: false, reply: "", actions: [] };
  }

  const systemPrompt = buildSonnetClassifierPrompt(ctx);

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

// ============================================================================
// ACTION EXECUTOR (from action-executor.ts)
// ============================================================================

const uid4 = () => Math.random().toString(36).slice(2, 6);

async function executeActions(
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

// ============================================================================
// GROUP MANAGEMENT (join/leave/intro)
// ============================================================================

const INTRO_MESSAGE = `היי! 👋 אני שלי, העוזרת החכמה של הבית.

אני יכולה לעזור עם:
✅ משימות - "צריך לאסוף את הילדים ב-4"
🛒 קניות - "חלב, ביצים ולחם"
📅 אירועים - "יום שישי ארוחה אצל סבא וסבתא"
❓ שאלות - "מה צריך לעשות היום?"

פשוט כתבו בקבוצה ואני אטפל בזה! 🏠`;

interface GroupInfo {
  name: string;
  participants: Array<{ phone: string; name: string }>;
}

async function fetchGroupInfo(groupId: string): Promise<GroupInfo | null> {
  try {
    const apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
    const token = Deno.env.get("WHAPI_TOKEN") || "";

    const res = await fetch(`${apiUrl}/groups/${groupId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[fetchGroupInfo] HTTP ${res.status} for ${groupId}`);
      return null;
    }

    const data = await res.json();
    const participants = ((data.participants || []) as Array<Record<string, string>>).map((p) => ({
      phone: (p.id || "").replace("@s.whatsapp.net", ""),
      name: p.name || p.id || "",
    }));

    return {
      name: data.subject || data.name || "משפחה",
      participants,
    };
  } catch (err) {
    console.error("[fetchGroupInfo] Error:", err);
    return null;
  }
}

function generateHouseholdId(): string {
  return "hh_" + Math.random().toString(36).slice(2, 10);
}

async function handleBotAddedToGroup(groupId: string, provider: WhatsAppProvider) {
  console.log(`[GroupMgmt] Bot added to group ${groupId}`);

  // 1. Check if group already linked (re-add scenario)
  const { data: existingConfig } = await supabase
    .from("whatsapp_config")
    .select("household_id, bot_active")
    .eq("group_id", groupId)
    .single();

  if (existingConfig) {
    // Re-activate if it was disabled
    if (!existingConfig.bot_active) {
      await supabase
        .from("whatsapp_config")
        .update({ bot_active: true })
        .eq("group_id", groupId);
      console.log(`[GroupMgmt] Re-activated bot for group ${groupId}`);
    }
    // Send intro message on re-add
    await provider.sendMessage({ groupId, text: INTRO_MESSAGE });
    return;
  }

  // 2. Fetch group info (name + participants)
  const groupInfo = await fetchGroupInfo(groupId);
  const groupName = groupInfo?.name || "משפחה";
  const participants = groupInfo?.participants || [];

  // 3. Auto-link: check if any participant's phone is already mapped to a household
  let householdId: string | null = null;
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  const humanParticipants = participants.filter((p) => p.phone !== botPhone);

  if (humanParticipants.length > 0) {
    const phones = humanParticipants.map((p) => p.phone);
    const { data: existingMapping } = await supabase
      .from("whatsapp_member_mapping")
      .select("household_id")
      .in("phone_number", phones)
      .limit(1)
      .single();

    if (existingMapping) {
      householdId = existingMapping.household_id;
      console.log(`[GroupMgmt] Auto-linked to existing household ${householdId}`);
    }
  }

  // 4. Create new household if no match
  if (!householdId) {
    householdId = generateHouseholdId();
    const { error } = await supabase.from("households_v2").insert({
      id: householdId,
      name: groupName,
      lang: "he",
    });
    if (error) {
      console.error(`[GroupMgmt] Failed to create household:`, error);
      // Still send intro even if household creation fails
      await provider.sendMessage({ groupId, text: INTRO_MESSAGE });
      return;
    }
    console.log(`[GroupMgmt] Created new household ${householdId} (${groupName})`);
  }

  // 5. Create whatsapp_config
  const { error: configError } = await supabase.from("whatsapp_config").insert({
    household_id: householdId,
    group_id: groupId,
    bot_active: true,
    language: "he",
  });
  if (configError) {
    console.error(`[GroupMgmt] Failed to create config:`, configError);
  }

  // 6. Pre-map all participants
  for (const p of humanParticipants) {
    await upsertMemberMapping(householdId, p.phone, p.name);
  }
  console.log(`[GroupMgmt] Pre-mapped ${humanParticipants.length} participants`);

  // 7. Send introduction message
  await provider.sendMessage({ groupId, text: INTRO_MESSAGE });
  console.log(`[GroupMgmt] Intro message sent to ${groupId}`);
}

async function handleMemberAdded(groupId: string, phones: string[]) {
  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("household_id")
    .eq("group_id", groupId)
    .single();

  if (!config) return;

  // Fetch group info to get names for new members
  const groupInfo = await fetchGroupInfo(groupId);
  const participantMap = new Map(
    (groupInfo?.participants || []).map((p) => [p.phone, p.name])
  );

  for (const phone of phones) {
    const name = participantMap.get(phone) || phone;
    await upsertMemberMapping(config.household_id, phone, name);
  }
  console.log(`[GroupMgmt] Added ${phones.length} member(s) to household ${config.household_id}`);
}

async function handleMemberRemoved(groupId: string, phones: string[]) {
  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("household_id")
    .eq("group_id", groupId)
    .single();

  if (!config) return;

  // Remove from whatsapp_member_mapping only (preserve household_members for task history)
  for (const phone of phones) {
    await supabase
      .from("whatsapp_member_mapping")
      .delete()
      .eq("household_id", config.household_id)
      .eq("phone_number", phone);
  }
  console.log(`[GroupMgmt] Removed ${phones.length} member mapping(s) from household ${config.household_id}`);
}

async function handleBotRemoved(groupId: string) {
  console.log(`[GroupMgmt] Bot removed from group ${groupId}`);
  await supabase
    .from("whatsapp_config")
    .update({ bot_active: false })
    .eq("group_id", groupId);
}

async function handleGroupEvent(event: GroupEvent, provider: WhatsAppProvider) {
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  const isBotEvent = event.participants.includes(botPhone);

  switch (event.subtype) {
    case "add":
      if (isBotEvent) await handleBotAddedToGroup(event.groupId, provider);
      else await handleMemberAdded(event.groupId, event.participants);
      break;
    case "remove":
      if (isBotEvent) await handleBotRemoved(event.groupId);
      else await handleMemberRemoved(event.groupId, event.participants);
      break;
    default:
      console.log(`[GroupEvent] Ignoring ${event.subtype} event`);
  }
}

// ============================================================================
// MESSAGE BATCHING (shopping items, 5-second window)
// ============================================================================

const BATCH_WINDOW_MS = 5000; // 5 seconds

async function storePendingBatch(
  message: IncomingMessage,
  classification: ClassificationOutput,
  householdId: string,
): Promise<string> {
  const batchId = Math.random().toString(36).slice(2, 10);
  await supabase.from("whatsapp_messages").insert({
    household_id: householdId,
    group_id: message.groupId,
    sender_phone: message.senderPhone,
    sender_name: message.senderName,
    message_text: message.text,
    message_type: message.type,
    whatsapp_message_id: message.messageId,
    classification: "batch_pending",
    batch_id: batchId,
    batch_status: "pending",
  });
  return batchId;
}

async function amILastPendingMessage(groupId: string, myMessageId: string): Promise<boolean> {
  // Find the most recent pending message for this group
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("whatsapp_message_id")
    .eq("group_id", groupId)
    .eq("batch_status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  // If I'm the newest pending message, I process the batch
  return data?.whatsapp_message_id === myMessageId;
}

async function claimAndProcessBatch(
  groupId: string,
  householdId: string,
  provider: WhatsAppProvider,
  senderName: string,
): Promise<void> {
  // Atomically claim all pending messages for this group (max 30s old to skip stale)
  const staleCutoff = new Date(Date.now() - 30000).toISOString();
  const { data: pending, error: claimError } = await supabase
    .from("whatsapp_messages")
    .update({ batch_status: "processing" })
    .eq("group_id", groupId)
    .eq("batch_status", "pending")
    .gte("created_at", staleCutoff)
    .select("id, message_text, sender_name");

  if (claimError || !pending || pending.length === 0) {
    console.log(`[Batch] No pending messages to claim for ${groupId}`);
    return;
  }

  console.log(`[Batch] Claimed ${pending.length} messages for group ${groupId}`);

  // Extract shopping items from each message by re-classifying as a batch
  const allItems: Array<{ name: string; qty?: string; category?: string }> = [];
  for (const msg of pending) {
    // Quick Haiku classify each message to extract items
    const ctx = await buildClassifierCtx(householdId);
    const cls = await classifyIntent(msg.message_text, msg.sender_name, ctx);
    if (cls.entities.items) {
      allItems.push(...cls.entities.items);
    } else if (cls.entities.raw_text) {
      // Fallback: treat the raw text as a single item name
      allItems.push({ name: cls.entities.raw_text.trim() });
    }
  }

  if (allItems.length === 0) {
    console.log(`[Batch] No items extracted, skipping`);
    await supabase
      .from("whatsapp_messages")
      .update({ batch_status: "processed", classification: "batch_empty" })
      .eq("group_id", groupId)
      .eq("batch_status", "processing");
    return;
  }

  // Execute add_shopping for all items
  const actions = [{
    type: "add_shopping" as const,
    data: { items: allItems },
  }];
  const { summary } = await executeActions(householdId, actions);
  console.log(`[Batch] Executed:`, summary);
  await incrementUsage(householdId);

  // Generate a single reply covering all items
  const itemNames = allItems.map((i) => i.name);
  const itemList = itemNames.length <= 2
    ? itemNames.join(" ו")
    : itemNames.slice(0, -1).join(", ") + " ו" + itemNames[itemNames.length - 1];
  const batchReply = `🛒 הוספתי ${itemList} לרשימה`;
  await provider.sendMessage({ groupId, text: batchReply });

  // Mark all batch messages as processed
  await supabase
    .from("whatsapp_messages")
    .update({ batch_status: "processed", classification: "batch_actionable" })
    .eq("group_id", groupId)
    .eq("batch_status", "processing");
}

// ============================================================================
// MAIN WEBHOOK HANDLER (from index.ts)
// ============================================================================

const provider = createProvider();

Deno.serve(async (req: Request) => {
  // ── Handle webhook verification (Meta requires GET for verification) ──
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = Deno.env.get("META_VERIFY_TOKEN");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[Webhook] Meta verification successful");
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── Only accept POST ──
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // 1. Verify webhook signature
    const isValid = await provider.verifyWebhook(req);
    if (!isValid) {
      console.warn("[Webhook] Invalid signature");
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Parse the incoming webhook body
    const body = await req.json();

    // 2a. Check for group events (join/leave/promote/demote) before message parsing
    const groupEvent = provider.parseGroupEvent?.(body);
    if (groupEvent) {
      await handleGroupEvent(groupEvent, provider);
      return new Response("OK", { status: 200 });
    }

    // 2b. Parse as regular message
    const message = provider.parseIncoming(body);

    if (!message) {
      // Not a parseable message (status update, receipt, etc.)
      return new Response("OK", { status: 200 });
    }

    // 3. Skip non-text messages (photos, stickers, voice notes)
    if (message.type !== "text") {
      console.log(`[Webhook] Skipping ${message.type} message from ${message.senderName}`);
      await logMessage(message, "skipped_non_text");
      return new Response("OK", { status: 200 });
    }

    // 3b. Skip bot's own messages (Whapi sends outgoing messages back as webhooks)
    const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
    if (message.senderPhone === botPhone || message.senderPhone === botPhone.replace("+", "")) {
      return new Response("OK", { status: 200 });
    }

    // 4. Look up household by WhatsApp group ID
    const { data: config } = await supabase
      .from("whatsapp_config")
      .select("household_id, bot_active, language")
      .eq("group_id", message.groupId)
      .single();

    if (!config || !config.bot_active) {
      console.log(`[Webhook] No active config for group ${message.groupId}`);
      return new Response("OK", { status: 200 });
    }

    const householdId = config.household_id;

    // 4b. Populate household name cache (for upgrade prompts)
    if (!householdNameCache[householdId]) {
      const { data: hh } = await supabase.from("households_v2").select("name").eq("id", householdId).single();
      if (hh?.name) householdNameCache[householdId] = hh.name;
    }

    // 5. Log the raw message
    await logMessage(message, "received", householdId);

    // 6. Update member mapping (learn who's who by phone number)
    await upsertMemberMapping(householdId, message.senderPhone, message.senderName);

    // 7. Check usage limits (free tier: 30 actions/month)
    const usageOk = await checkUsageLimit(householdId);

    // ─── STAGE 1: Haiku Classification (fast, cheap) ───
    const haikuCtx = await buildClassifierCtx(householdId);
    const classification = await classifyIntent(
      message.text,
      message.senderName,
      haikuCtx
    );

    console.log(`[Webhook] Haiku: intent=${classification.intent} conf=${classification.confidence.toFixed(2)} from ${message.senderName}`);

    // 8. Route based on intent + confidence
    const CONFIDENCE_HIGH = 0.70;
    const CONFIDENCE_LOW = 0.50;
    const isActionable = classification.intent !== "ignore" && classification.intent !== "info_request";

    // 8a. Shopping batch: collect rapid-fire shopping items into one reply
    if (classification.intent === "add_shopping" && classification.confidence >= CONFIDENCE_HIGH) {
      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId);
        return new Response("OK", { status: 200 });
      }

      // Store as pending batch item
      await storePendingBatch(message, classification, householdId);

      // Wait for batch window
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));

      // Check if I'm the most recent pending message (last-message-wins)
      if (!(await amILastPendingMessage(message.groupId, message.messageId))) {
        // A newer invocation will handle the batch — exit silently
        console.log(`[Batch] Not last message, deferring to newer invocation`);
        return new Response("OK", { status: 200 });
      }

      // We ARE the last message — claim and process the full batch
      await claimAndProcessBatch(message.groupId, householdId, provider, message.senderName);
      return new Response("OK", { status: 200 });
    }

    // If ignore with high confidence → stop (no Sonnet call)
    if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH) {
      await logMessage(message, "haiku_ignore", householdId);
      return new Response("OK", { status: 200 });
    }

    // Low confidence → escalate to Sonnet for full re-classification (fallback)
    if (classification.confidence < CONFIDENCE_LOW) {
      console.log(`[Webhook] Low confidence (${classification.confidence.toFixed(2)}), treating as ignore`);
      await logMessage(message, "haiku_low_confidence", householdId);
      return new Response("OK", { status: 200 });
    }

    // Medium confidence (0.50-0.69) → escalate to Sonnet full classification
    if (classification.confidence < CONFIDENCE_HIGH && isActionable) {
      console.log(`[Webhook] Medium confidence, escalating to Sonnet`);
      const sonnetResult = await classifyMessages(householdId, [
        { sender: message.senderName, text: message.text, timestamp: message.timestamp },
      ]);

      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        await logMessage(message, "sonnet_escalated_social", householdId);
        return new Response("OK", { status: 200 });
      }

      // Sonnet says actionable — check usage, execute, reply
      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId);
        return new Response("OK", { status: 200 });
      }

      const { summary } = await executeActions(householdId, sonnetResult.actions);
      console.log(`[Webhook] Sonnet escalation executed ${summary.length} actions:`, summary);
      await incrementUsage(householdId);
      if (sonnetResult.reply) {
        await provider.sendMessage({ groupId: message.groupId, text: sonnetResult.reply });
      }
      await logMessage(message, "sonnet_escalated", householdId);
      return new Response("OK", { status: 200 });
    }

    // Non-actionable intents (question, info_request) — generate reply only, no DB writes
    if (!isActionable && classification.intent !== "ignore") {
      const replyCtx = await buildReplyCtx(householdId);
      const { reply } = await generateReply(classification, message.senderName, replyCtx);
      if (reply) {
        await provider.sendMessage({ groupId: message.groupId, text: reply });
      }
      await logMessage(message, "haiku_reply_only", householdId);
      return new Response("OK", { status: 200 });
    }

    // ─── High confidence actionable → execute via Haiku entities ───

    // 9. Check usage limit
    if (!usageOk) {
      await sendUpgradePrompt(message.groupId, householdId, config.language);
      await logMessage(message, "usage_limit_reached", householdId);
      return new Response("OK", { status: 200 });
    }

    // 10. Convert Haiku entities to ClassifiedAction format and execute
    const actions = haikuEntitiesToActions(classification);
    const { summary } = await executeActions(householdId, actions);
    console.log(`[Webhook] Haiku executed ${summary.length} actions:`, summary);

    // 11. Increment usage counter
    await incrementUsage(householdId);

    // 12. Generate personality reply via Sonnet (Stage 2)
    const replyCtx = await buildReplyCtx(householdId);
    const { reply } = await generateReply(classification, message.senderName, replyCtx);
    if (reply) {
      await provider.sendMessage({ groupId: message.groupId, text: reply });
      console.log(`[Webhook] Reply sent`);
    }

    // 13. Log completion
    await logMessage(message, "haiku_actionable", householdId);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

// ─── Helper Functions ───

async function logMessage(
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
  classification: string,
  householdId?: string
) {
  try {
    await supabase.from("whatsapp_messages").insert({
      household_id: householdId || "unknown",
      group_id: message.groupId,
      sender_phone: message.senderPhone,
      sender_name: message.senderName,
      message_text: message.text,
      message_type: message.type,
      whatsapp_message_id: message.messageId,
      classification,
    });
  } catch (err) {
    console.error("[logMessage] Error:", err);
  }
}

async function upsertMemberMapping(householdId: string, phone: string, name: string) {
  try {
    // Skip the bot's own messages (phone matches the bot's number)
    const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "";
    if (phone === botPhone || phone === botPhone.replace("+", "")) return;

    // Skip if name is just a phone number (no real name from WhatsApp)
    if (/^\d+$/.test(name)) return;

    // 1. Update phone→name mapping
    await supabase.from("whatsapp_member_mapping").upsert(
      {
        household_id: householdId,
        phone_number: phone,
        member_name: name,
      },
      { onConflict: "household_id,phone_number" }
    );

    // 2. Auto-add to household_members if not already there (so AI knows the family)
    const { data: existing } = await supabase
      .from("household_members")
      .select("id")
      .eq("household_id", householdId)
      .eq("display_name", name)
      .single();

    if (!existing) {
      await supabase.from("household_members").insert({
        household_id: householdId,
        display_name: name,
        role: "member",
      });
      console.log(`[Members] Auto-added "${name}" to household ${householdId}`);
    }
  } catch (err) {
    console.error("[upsertMemberMapping] Error:", err);
  }
}

async function checkUsageLimit(householdId: string): Promise<boolean> {
  // Check if household has an active subscription
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, plan")
    .eq("household_id", householdId)
    .eq("status", "active")
    .single();

  if (sub && sub.plan !== "free") return true; // Paid users have no limit

  // Free tier: 30 actions per month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("household_id", householdId)
    .in("classification", ["haiku_actionable", "sonnet_escalated", "batch_actionable"])
    .gte("created_at", startOfMonth.toISOString());

  return (count || 0) < 30;
}

async function incrementUsage(householdId: string) {
  try {
    await supabase.rpc("increment_ai_usage", { p_household_id: householdId });
  } catch (err) {
    console.error("[incrementUsage] Error:", err);
  }
}

// Simple in-memory cache for household names (refreshed per request lifecycle)
const householdNameCache: Record<string, string> = {};
function getHouseholdNameCached(householdId: string): string | null {
  return householdNameCache[householdId] || null;
}

// ─── Quiet Hours (no proactive messages, only replies) ───
// Nightly: 10 PM - 7 AM Israel time
// Shabbat: Friday 15:00 - Saturday 19:00 Israel time
// During quiet hours: bot still executes actions + replies to direct commands.
// Suppresses ONLY proactive/unsolicited messages (morning briefings, reminders, summaries).
function isQuietHours(): boolean {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const hour = israelTime.getHours();
  const day = israelTime.getDay(); // 0=Sun, 5=Fri, 6=Sat

  // Nightly quiet hours: 10 PM - 7 AM
  if (hour >= 22 || hour < 7) return true;

  // Shabbat: Friday 15:00+ through Saturday before 19:00
  if (day === 5 && hour >= 15) return true;  // Friday from 3 PM
  if (day === 6 && hour < 19) return true;   // Saturday until 7 PM

  return false;
}

// ─── Two-Stage Pipeline Helpers ───
// (Renamed to avoid collision with buildHouseholdContext from ai-classifier)

async function buildClassifierCtx(householdId: string): Promise<ClassifierContext> {
  const hebrewDays = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  const [membersRes, tasksRes, shoppingRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to").eq("household_id", householdId).eq("done", false),
    supabase.from("shopping_items").select("id, name, qty").eq("household_id", householdId).eq("got", false),
  ]);

  return {
    members: (membersRes.data || []).map((m) => m.display_name),
    openTasks: (tasksRes.data || []).map((t) => ({ id: t.id, title: t.title, assigned_to: t.assigned_to })),
    openShopping: (shoppingRes.data || []).map((s) => ({ id: s.id, name: s.name, qty: s.qty })),
    today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    dayOfWeek: hebrewDays[today.getDay()],
  };
}

async function buildReplyCtx(householdId: string): Promise<ReplyContext> {
  const { data: household } = await supabase
    .from("households_v2").select("name, lang").eq("id", householdId).single();

  const [membersRes, tasksRes, shoppingRes, eventsRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to, done").eq("household_id", householdId),
    supabase.from("shopping_items").select("id, name, qty, got").eq("household_id", householdId),
    supabase.from("events").select("id, title, assigned_to, scheduled_for").eq("household_id", householdId)
      .gte("scheduled_for", new Date().toISOString()),
  ]);

  return {
    householdName: household?.name || "משפחה",
    members: (membersRes.data || []).map((m) => m.display_name),
    language: household?.lang || "he",
    currentTasks: tasksRes.data || [],
    currentShopping: shoppingRes.data || [],
    currentEvents: eventsRes.data || [],
  };
}

function haikuEntitiesToActions(classification: ClassificationOutput) {
  const e = classification.entities;
  const actions: Array<{ type: string; data: Record<string, unknown> }> = [];

  switch (classification.intent) {
    case "add_task":
      actions.push({
        type: "add_task",
        data: { title: e.title || e.raw_text, assigned_to: e.person || null },
      });
      break;

    case "add_shopping":
      if (e.items && Array.isArray(e.items)) {
        actions.push({
          type: "add_shopping",
          data: { items: e.items },
        });
      } else {
        actions.push({
          type: "add_shopping",
          data: { items: [{ name: e.raw_text, qty: "1", category: "אחר" }] },
        });
      }
      break;

    case "add_event":
      actions.push({
        type: "add_event",
        data: {
          title: e.title || e.raw_text,
          assigned_to: e.person || null,
          scheduled_for: e.time_iso || new Date().toISOString(),
        },
      });
      break;

    case "complete_task":
      if (e.task_id) {
        actions.push({ type: "complete_task", data: { id: e.task_id } });
      }
      break;

    case "complete_shopping":
      if (e.item_id) {
        actions.push({ type: "complete_shopping", data: { id: e.item_id } });
      }
      break;

    case "claim_task":
      if (e.task_id && e.person) {
        actions.push({ type: "assign_task", data: { id: e.task_id, assigned_to: e.person } });
      }
      break;
  }

  return actions;
}

async function sendUpgradePrompt(groupId: string, householdId: string, language?: string) {
  const lang = language || "he";
  const upgradeMsg = lang === "he"
    ? `היי ${getHouseholdNameCached(householdId) || "משפחה"} 👋\nהשתמשתם ב-30 הפעולות החינמיות החודשיות שלכם.\nשדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה — 19.90 ₪ לחודש.\n🔗 sheli.ai/upgrade`
    : `Hey ${getHouseholdNameCached(householdId) || "family"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping — $5.50/month.\n🔗 sheli.ai/upgrade`;

  await provider.sendMessage({ groupId, text: upgradeMsg });
}
