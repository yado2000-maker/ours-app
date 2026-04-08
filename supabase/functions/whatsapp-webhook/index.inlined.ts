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
  groupId: string;          // Group JID for groups, phone number for direct messages (reply-to address)
  senderPhone: string;
  senderName: string;
  text: string;
  type: "text" | "image" | "sticker" | "voice" | "video" | "document" | "reaction" | "other";
  timestamp: number;
  chatType: "group" | "direct";
  mediaUrl?: string;      // Audio file URL (for voice messages)
  mediaId?: string;       // Whapi media ID (for downloading via API)
  mediaDuration?: number;  // Duration in seconds (for voice messages)
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
    | "info_request"
    | "correct_bot";
  confidence: number; // 0.0 - 1.0
  addressed_to_bot?: boolean; // true when user is talking TO Sheli (not possessive "my/mine")
  needs_conversation_review?: boolean; // true when context makes intent ambiguous
  entities: {
    person?: string;
    items?: Array<{ name: string; qty?: string; category?: string }>;
    title?: string;
    time_raw?: string;
    time_iso?: string;
    task_id?: string;
    item_id?: string;
    correction_text?: string;
    raw_text: string;
  };
}

interface ClassifierContext {
  members: string[];
  openTasks: Array<{ id: string; title: string; assigned_to: string | null }>;
  openShopping: Array<{ id: string; name: string; qty: string | null }>;
  today: string; // ISO date "2026-04-02"
  dayOfWeek: string; // Hebrew day name "רביעי"
  familyPatterns?: string; // Learned patterns for this household
  conversationHistory?: string; // Formatted recent conversation for context
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
    if (!webhookToken) return false; // SECURITY: fail-closed — reject all if token not configured
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

      // Determine chat type: group (@g.us) or direct (@s.whatsapp.net)
      let chatType: "group" | "direct";
      let groupId: string;
      if (chatId.endsWith("@g.us")) {
        chatType = "group";
        groupId = chatId;
      } else if (chatId.endsWith("@s.whatsapp.net")) {
        chatType = "direct";
        groupId = chatId.replace("@s.whatsapp.net", ""); // Phone number as reply-to address
      } else {
        return null; // Unknown chat format
      }

      const from = msg.from as string || "";
      // SECURITY: sanitize sender name to prevent prompt injection
      const rawName = msg.from_name as string || from;
      const fromName = rawName.replace(/[\x00-\x1f\x7f\[\]{}]/g, "").slice(0, 50);
      const text = (msg.text as Record<string, string>)?.body || "";
      const type = msg.type as string || "text";
      const id = msg.id as string || "";
      const timestamp = (msg.timestamp as number) || Math.floor(Date.now() / 1000);

      // Extract media info for voice messages (ptt = push-to-talk, audio = audio file)
      const audioData = (msg.ptt || msg.audio || msg.voice) as Record<string, unknown> | undefined;
      const mediaUrl = (audioData?.link as string | undefined) || undefined;
      const mediaId = audioData?.id as string | undefined;
      const mediaDuration = (audioData?.seconds ?? audioData?.duration) as number | undefined;

      // Map Whapi message types to our types
      const typeMap: Record<string, IncomingMessage["type"]> = {
        text: "text",
        image: "image",
        sticker: "sticker",
        ptt: "voice",
        audio: "voice",
        voice: "voice",
        video: "video",
        document: "document",
        reaction: "reaction",
      };

      return {
        messageId: id,
        groupId,
        senderPhone: from.replace("@s.whatsapp.net", ""),
        senderName: fromName,
        text: text,
        type: typeMap[type] || "other",
        timestamp,
        chatType,
        mediaUrl,
        mediaId,
        mediaDuration,
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
- correct_bot: Correcting something Sheli just did wrong. "התכוונתי ל...", "לא X, כן Y", "תתקני", "טעית", "זה פריט אחד".

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

${ctx.familyPatterns ? `FAMILY PATTERNS (learned for this household):\n${ctx.familyPatterns}\n` : ""}COMPOUND PRODUCT NAMES — keep as ONE item, do NOT split:
- "חלב אורז" = rice milk (ONE item in חלב וביצים)
- "חלב שקדים" = almond milk (ONE item in חלב וביצים)
- "חלב סויה" = soy milk (ONE item in חלב וביצים)
- "שמן זית" = olive oil (ONE item in מזווה)
- "חמאת בוטנים" = peanut butter (ONE item in מזווה)
- "נייר טואלט" = toilet paper (ONE item in ניקוי ובית)
- "סבון כלים" = dish soap (ONE item in ניקוי ובית)
- "קרם לחות" = moisturizer (ONE item in טיפוח)
- Rule: if two+ words form a single product name, keep them together

${ctx.conversationHistory ? `
RECENT CONVERSATION (oldest first, for context):
${ctx.conversationHistory}

CONVERSATION CONTEXT RULES:
- Read the RECENT CONVERSATION to understand the CURRENT MESSAGE in context.
- A message that REFERS to a previously mentioned product/task/event is NOT a new request.
  Example: "אין ספרייט" after someone asked for Sprite = status update → ignore.
- A message correcting/updating a previous request is NOT a new add.
  Example: "לא 2, צריך 3" = quantity update on most recent item, not new item.
- A message between family members ABOUT an item is social chatter → ignore.
  Example: "גור יש רק 7אפ" = telling Gur something, not requesting the bot.
- Only classify as actionable when the sender is clearly REQUESTING the bot to act.
- These rules apply to ALL entity types: shopping, tasks, and events.
- If you are uncertain whether a message is a request or just conversation, set confidence: 0.55 and needs_conversation_review: true.
` : ""}HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday

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
[אמא]: "התכוונתי לשמן זית, לא לשמן וזית" → {"intent":"correct_bot","confidence":0.95,"entities":{"correction_text":"שמן זית","raw_text":"התכוונתי לשמן זית, לא לשמן וזית"}}
[אבא]: "שלי טעית, זה דבר אחד" → {"intent":"correct_bot","confidence":0.90,"entities":{"correction_text":"","raw_text":"שלי טעית, זה דבר אחד"}}

CRITICAL — "שלי" DISAMBIGUATION:
"שלי" is BOTH the bot's name AND Hebrew for "my/mine".
Include "addressed_to_bot": true/false in your JSON output.
Set addressed_to_bot: true ONLY when the user is talking TO Sheli.

POSSESSIVE "שלי" (= "my/mine") — addressed_to_bot: false:
- After any noun: "האוטו שלי", "הטלפון שלי", "הבית שלי", "החדר שלי"
- After endearments: "אהובים שלי", "יקרים שלי", "חיים שלי", "נשמה שלי"
- After family: "אמא שלי", "אבא שלי", "אחות שלי", "הילדים שלי"
- After body parts: "הראש שלי", "היד שלי", "הגב שלי"
- Claiming ownership: "זה שלי", "שלי!" (answering "של מי?")
- Possessive phrases: "הצד שלי", "התור שלי", "הבחירה שלי"

NAME "שלי" (= talking to the bot) — addressed_to_bot: true:
- Direct address at start: "שלי, מה צריך?"
- Direct address at end: "מה שלומך שלי?"
- After greeting/thanks: "היי שלי", "תודה שלי"
- With feminine imperative directed at bot: "תזכירי לי שלי", "אל תשכחי שלי"
- Calling the bot: "שלי?"

When in doubt between name and possessive, prefer possessive (false silence > false reply).

RULES:
- Respond with ONLY a JSON object. No other text, no markdown.
- Always include raw_text in entities and addressed_to_bot (true/false).
- For complete_task/complete_shopping/claim_task: match against open tasks/shopping IDs above.
- For add_event: include time_raw (Hebrew expression) and time_iso (ISO 8601 with +03:00) if resolvable.
- For add_shopping: extract items into the items array. ALWAYS include category per item. Keep compound product names as ONE item (e.g., "חלב אורז" is ONE item, not two).
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action).
- For correct_bot: extract what the user MEANT in correction_text. This is about fixing Sheli's last action.
- If conversation context makes your classification uncertain, include "needs_conversation_review": true in your response.`;
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
        addressed_to_bot: parsed.addressed_to_bot || false,
        needs_conversation_review: parsed.needs_conversation_review || false,
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
    case "ignore":
      actionSummary = `${sender} addressed Sheli directly with a social/praise message: "${e.raw_text}". Respond warmly and personally — thank them, acknowledge the compliment, or chat briefly. Do NOT ask "what can I help with" or "what's going on".`;
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

EMOJI ENERGY: Mirror the sender's emotional temperature naturally.
- If they send hearts/love emoji (❤️💕😍) → respond with warmth, include a heart or love emoji back.
- If they're excited (!!!🎉🔥) → match the energy, celebrate with them.
- If they're dry and matter-of-fact → keep it clean, no forced emoji.
- If they seem frustrated → be empathetic and calm, skip the smiley faces.
Read the room like a real person would.

OUT-OF-SCOPE REQUESTS: When someone asks about weather, news, sports scores, trivia, recipes, directions, general knowledge, or anything outside household management (${isHe ? "מטלות, קניות, אירועים" : "tasks, shopping, events"}):
- Deflect warmly. Acknowledge the question. Redirect to what you CAN do.
- NEVER repeat the same phrasing. Vary your response structure EVERY time.
- ${isHe ? 'Use "מטלות" (NOT "משימות") when describing what you do.' : ""}
- Stay in Sheli's voice: warm, slightly cheeky, human.
${isHe ? `Example vibes (create your OWN each time — never copy these verbatim):
  "אוי, את זה אני לא יודעת 🤷‍♀️ אבל אם צריך לזכור משהו — אני פה!"
  "חח הלוואי! מטלות, קניות ואירועים — שם אני גאונה 😄"
  "סורי, לא התחום שלי 😅 יש משהו בבית שצריך לסדר?"` : `Example vibes (create your OWN each time — never copy these verbatim):
  "Ha, I wish I knew! I'm great at tasks, shopping lists, and family events though 😄"
  "That's outside my wheelhouse 🤷‍♀️ But need to add something to the list?"
  "Sorry, not my area! I'm your household brain — chores, shopping, and scheduling."`}

For info_request: say you don't have that info and suggest asking a family member.

QUESTIONS ABOUT SHELI HERSELF: When asked about privacy, data, learning, or how you work:
${isHe ? `- פרטיות: "אני לא שומרת תמונות או וידאו. אני כן שומעת הודעות קוליות קצרות — תקליטו לי רשימת קניות או מטלות בדיוק כמו הודעה רגילה. אני לא שומרת את ההקלטה, רק את התוכן. הכל נמחק אוטומטית אחרי 30 יום."
- למידה: "אני לומדת את הסגנון שלכם! כינויים, מוצרים, שעות — ככל שתשתמשו יותר, אבין אתכם טוב יותר."
- מי רואה: "רק בני הבית שלכם. כל משפחה מנותקת לחלוטין."
- להפסיק: "פשוט תוציאו אותי מהקבוצה. הכל נמחק אוטומטית, בלי התחייבות."` : `- Privacy: "I don't store photos or videos. I can listen to short voice messages — record your shopping list or tasks just like a text. I don't save the recording, only its content. Everything is auto-deleted after 30 days."
- Learning: "I learn your family's style! Nicknames, products, schedules — the more you use me, the better I understand you."
- Who sees data: "Only your household members. Each family is completely isolated."
- Stopping: "Just remove me from the group. All data is auto-deleted, no commitment."`}
Paraphrase naturally — never repeat the exact same wording twice.

Reply with ONLY the message text — no JSON, no formatting, no quotes.`;
}

async function generateReply(
  classification: ClassificationOutput,
  sender: string,
  ctx: ReplyContext,
  apiKey?: string
): Promise<ReplyResult> {
  const key = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";

  // Note: "ignore" intent can reach here via @שלי direct address override
  // The caller decides when to invoke generateReply — no guard needed here

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

// ─── Normalization & Dedup Helpers ───

const CONTAINER_PREFIXES = /^(בקבוק|בקבוקי|חבילת|חבילות|שקית|שקיות|קופסת|קופסאות|פחית|פחיות|ארגז|שלישיית)\s+/;
const QTY_PREFIX = /^(\d+\.?\d*)\s+/;
const DESCRIPTOR_SUFFIX = /\s+(ליטר|מ"ל|מל|גרם|ג'|קילו|ק"ג|יחידות|זוגות)(\s+.+)?$/;
const REPEATED_LETTERS = /(.)\1{2,}/g;

interface ParsedProduct {
  name: string;
  qty: string | null;
  fullName: string;
}

function extractProduct(text: string): ParsedProduct {
  let remaining = text.trim();
  const fullName = remaining;

  let qty: string | null = null;
  const qtyMatch = remaining.match(QTY_PREFIX);
  if (qtyMatch) {
    qty = qtyMatch[1];
    remaining = remaining.slice(qtyMatch[0].length);
  }

  remaining = remaining.replace(CONTAINER_PREFIXES, "");
  remaining = remaining.replace(DESCRIPTOR_SUFFIX, "");
  remaining = remaining.replace(REPEATED_LETTERS, "$1$1");

  return { name: remaining.trim(), qty, fullName };
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
  return text.trim().replace(TASK_FILLER, "").replace(REPEATED_LETTERS, "$1$1").trim();
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

function isSameEvent(existingTitle: string, newTitle: string, existingDate: string, newDate: string): boolean {
  if (existingDate.slice(0, 10) !== newDate.slice(0, 10)) return false;
  return isSameTask(existingTitle, newTitle);
}

// ─── Conversation Context Fetcher ───

async function fetchRecentConversation(
  groupId: string,
  excludeMessageId?: string
): Promise<Array<{ sender_name: string; message_text: string; created_at: string }>> {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: recentByTime } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .gte("created_at", fifteenMinAgo)
    .order("created_at", { ascending: true })
    .limit(30);

  const { data: recentByCount } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(10);

  const byTime = recentByTime || [];
  const byCount = (recentByCount || []).reverse();
  const base = byTime.length >= byCount.length ? byTime : byCount;

  const ids = new Set(base.map((m: any) => m.id));
  const other = byTime.length >= byCount.length ? byCount : byTime;
  for (const m of other) {
    if (!ids.has(m.id)) {
      base.push(m);
      ids.add(m.id);
    }
  }

  return base
    .filter((m: any) => m.id !== excludeMessageId && m.message_text)
    .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at))
    .slice(-30)
    .map((m: any) => ({
      sender_name: m.sender_name || "?",
      message_text: m.message_text,
      created_at: m.created_at,
    }));
}

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

          const { data: existingTasks } = await supabase
            .from("tasks")
            .select("id, title, assigned_to")
            .eq("household_id", householdId)
            .eq("done", false);

          const taskMatch = (existingTasks || []).find((existing: any) =>
            isSameTask(existing.title, title)
          );

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

          const { data: existingItems } = await supabase
            .from("shopping_items")
            .select("id, name, qty, category")
            .eq("household_id", householdId)
            .eq("got", false);

          for (const item of items || []) {
            const parsed = extractProduct(item.name);

            const match = (existingItems || []).find((existing: any) => {
              const existingParsed = extractProduct(existing.name);
              return isSameProduct(parsed.name, existingParsed.name);
            });

            if (match) {
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

          const datePrefix = scheduled_for.slice(0, 10);
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

// ─── 1:1 Onboarding Handler ───

const ONBOARDING_WELCOME = `היי! 👋 אני שלי - העוזרת החכמה של המשפחה, נעים מאוד!
הוסיפו אותי לקבוצת הווטסאפ המשפחתית שלכם ואני אתחיל לעזור מיד - אני יודעת להכין רשימת קניות, לרשום ולחלק מטלות ומשימות, להזכיר לכם על אירועים, הסעות ולנהל את הלו"ז המשפחתי :)

איך?
1. שמרו את המספר שלי באנשי הקשר
2. היכנסו לקבוצת הווטסאפ של הבית
3. הגדרות
4. הוסיפו משתתף
5. חפשו "שלי"

אני כאן לכל שאלה או בקשה!`;

const ONBOARDING_WAITING_MESSAGES = [
  "עוד לא הספקתם להוסיף אותי? 😊\n\nשמרו את המספר שלי באנשי הקשר, ואז:\n1. קבוצת הווטסאפ של הבית\n2. הגדרות\n3. הוסיפו משתתף\n4. חפשו \"שלי\"",
  "אני מחכה בסבלנות! 😄\nברגע שתוסיפו אותי לקבוצה, אני מתחילה לעזור עם קניות, מטלות ואירועים.\n\n1. שמרו את המספר באנשי הקשר\n2. קבוצה\n3. הגדרות\n4. הוסיפו משתתף\n5. חפשו \"שלי\"",
  "רוצים לשאול משהו לפני שמוסיפים אותי? אני כאן! 😊\n\nאם יש שאלות, שאלו. אם מוכנים, הוסיפו אותי לקבוצת הווטסאפ המשפחתית 💪",
];

function getOnboardingWaitingMessage(msgCount: number): string {
  const idx = Math.min(msgCount - 2, ONBOARDING_WAITING_MESSAGES.length - 1);
  return ONBOARDING_WAITING_MESSAGES[Math.max(0, idx)];
}

// ─── 1:1 Q&A: Answer common questions before falling through to waiting messages ───

const ONBOARDING_QA: Array<{ patterns: RegExp[]; answer: string }> = [
  {
    patterns: [/כמה.*עול|מחיר|עלות|תשלום|חינם|בחינם|פרימיום|premium|price|cost|free/i],
    answer: "30 פעולות בחודש בחינם! אם תרצו להמשיך בלי הגבלה, Premium עולה 9.90 ₪ לחודש 😊\n\nאבל קודם כל, הוסיפו אותי לקבוצה ותראו איך זה עובד!",
  },
  {
    patterns: [/מה את יודעת|מה את עוש|מה אפשר|יכולות|פיצ׳רים|features|what can you/i],
    answer: "אני יודעת:\n🛒 רשימת קניות - אמרו \"חלב\" ואני מוסיפה\n✅ מטלות - \"לאסוף את נועה ב-5\" ואני רושמת ומחלקת\n📅 אירועים - \"יום שלישי ארוחת ערב אצל סבתא\"\n\nהכל קורה ישר בקבוצת הווטסאפ, בלי אפליקציות נוספות!",
  },
  {
    patterns: [/בטוח|בטיחות|פרטיות|privacy|secure|קוראת.*הודעות|מקשיבה|שומרת.*מידע|data/i],
    answer: "אני לא שומרת תמונות או וידאו 🔒 הודעות קוליות קצרות? אני שומעת ומתרגמת לטקסט — לא שומרת את ההקלטה עצמה, רק את התוכן.\n\nכל המידע נמחק אוטומטית אחרי 30 יום. שיחות אישיות? אני לא רואה אותן בכלל.\n\nהפרטיות שלכם חשובה לי!",
  },
  {
    patterns: [/לומדת|משתפר|improving|learn|חכמה יותר|מבינה יותר/i],
    answer: "כן! אני לומדת את הסגנון של המשפחה שלכם 🧠\n\nכינויים, שמות מוצרים, שעות קבועות — ככל שתשתמשו יותר, אבין אתכם טוב יותר. כל משפחה מקבלת חוויה מותאמת אישית!",
  },
  {
    patterns: [/מי רואה|מי יכול לראות|who can see|visible|access.*data/i],
    answer: "רק בני הבית שלכם! כל משפחה מנותקת לחלוטין 🔐\n\nאף אחד — כולל הצוות שלנו — לא רואה את הרשימות או האירועים שלכם.",
  },
  {
    patterns: [/להפסיק|לצאת|למחוק|לעזוב|remove|stop|delete|cancel|unsubscribe/i],
    answer: "פשוט הוציאו אותי מהקבוצה, וזהו! כל המידע נמחק אוטומטית. בלי התחייבות, בלי שאלות 👋\n\nאם תרצו לחזור — תמיד אשמח!",
  },
  {
    patterns: [/איך.*עובד|איך.*מתחיל|how.*work|how.*start/i],
    answer: "פשוט מאוד!\n1. שמרו את המספר שלי באנשי הקשר\n2. הוסיפו אותי לקבוצת הווטסאפ המשפחתית\n3. דברו כרגיל - אני מזהה קניות, מטלות ואירועים אוטומטית\n\nזהו! אני מתחילה לעזור מהרגע שאני בקבוצה 🚀",
  },
  {
    patterns: [/קבוצ.*קיימ|existing.*group|כבר.*קבוצ/i],
    answer: "כן! פשוט הוסיפו אותי לכל קבוצת ווטסאפ קיימת. לא צריך ליצור קבוצה חדשה 👍",
  },
  {
    patterns: [/תודה|thanks|thank you|מגניב|אחלה|סבבה|cool|great/i],
    answer: "בכיף! 😊 מחכה לכם בקבוצה!",
  },
  {
    patterns: [/שלום|היי|הי|בוקר טוב|ערב טוב|hello|hi|hey/i],
    answer: "היי! 😊 שמחה שפנית! יש לך שאלה, או שנתחיל? הוסיפו אותי לקבוצת הווטסאפ המשפחתית ואני מתחילה לעזור!",
  },
  {
    patterns: [/הפנ|referral|הזמנ.*משפחה|משפחה מביאה|invite.*family|חודש.*חינם.*הזמנ/i],
    answer: "🎁 משפחה מביאה משפחה!\nכל משפחה שמצטרפת דרככם — שתיכם מקבלות חודש פרימיום במתנה.\nהקישור שלכם נמצא בתפריט האפליקציה 😊",
  },
];

function matchOnboardingQA(text: string): string | null {
  const cleaned = text.trim();
  for (const qa of ONBOARDING_QA) {
    for (const pattern of qa.patterns) {
      if (pattern.test(cleaned)) return qa.answer;
    }
  }
  return null;
}

async function handleDirectMessage(message: IncomingMessage, prov: WhatsAppProvider) {
  const phone = message.senderPhone;
  console.log(`[1:1] Direct message from ${phone}: "${message.text.slice(0, 50)}"`);

  // Skip non-text messages in 1:1 (voice is OK — already transcribed upstream)
  if (message.type !== "text" && message.type !== "voice") {
    return;
  }

  // 0. Check if first message contains a referral code (from sheli.ai/r/ABC123 redirect → "שלום ABC123")
  const referralMatch = message.text.match(/(?:שלום|שלי|shalom|hey|hi)\s+([A-Z0-9]{6})\b/i);
  const possibleReferralCode = referralMatch ? referralMatch[1].toUpperCase() : null;

  // 1. Check if this phone already has a household (already onboarded via group)
  const { data: mapping } = await supabase
    .from("whatsapp_member_mapping")
    .select("household_id")
    .eq("phone_number", phone)
    .limit(1)
    .single();

  if (mapping) {
    // Already in a group — redirect with varied response
    const redirectReplies = [
      "היי, כתבו לי בקבוצה ואני אטפל בזה 😊",
      "אני בקבוצה! שלחו לי שם ואעדכן הכל",
      "היי! עדכנו אותי בקבוצה ואני על זה 👍",
      "כתבו לי בקבוצה המשפחתית, שם אני עובדת 🙂",
      "היי! אני פעילה בקבוצה — שלחו שם ואני אעזור",
      "אני בקבוצה שלכם! כתבו לי שם 😊",
    ];
    const reply = redirectReplies[Math.floor(Math.random() * redirectReplies.length)];
    await prov.sendMessage({
      groupId: message.groupId,
      text: reply,
    });
    await supabase
      .from("onboarding_conversations")
      .upsert({ phone, state: "active", household_id: mapping.household_id, updated_at: new Date().toISOString() }, { onConflict: "phone" });
    return;
  }

  // 2. Get or create onboarding conversation
  const { data: convo } = await supabase
    .from("onboarding_conversations")
    .select("*")
    .eq("phone", phone)
    .single();

  if (!convo) {
    // First message — send welcome
    // If message contains a referral code, validate and store it
    let validReferralCode: string | null = null;
    if (possibleReferralCode) {
      const { data: referrer } = await supabase
        .from("households_v2")
        .select("id")
        .eq("referral_code", possibleReferralCode)
        .single();
      if (referrer) {
        validReferralCode = possibleReferralCode;
        console.log(`[1:1] Referral code ${possibleReferralCode} validated (household ${referrer.id})`);
      }
    }

    await supabase.from("onboarding_conversations").insert({
      phone,
      state: "welcome",
      message_count: 1,
      referral_code: validReferralCode,
    });
    await prov.sendMessage({ groupId: message.groupId, text: ONBOARDING_WELCOME });
    console.log(`[1:1] New onboarding conversation for ${phone}${validReferralCode ? ` (referred by ${validReferralCode})` : ""}`);
    return;
  }

  // 3. Increment message count
  const newCount = (convo.message_count || 0) + 1;
  await supabase
    .from("onboarding_conversations")
    .update({ message_count: newCount, updated_at: new Date().toISOString() })
    .eq("id", convo.id);

  // 4. Check for Q&A match (answers questions regardless of state)
  const qaAnswer = matchOnboardingQA(message.text);
  if (qaAnswer) {
    // Transition to waiting if still in welcome
    if (convo.state === "welcome") {
      await supabase.from("onboarding_conversations").update({ state: "waiting", updated_at: new Date().toISOString() }).eq("id", convo.id);
    }
    await prov.sendMessage({ groupId: message.groupId, text: qaAnswer });
    console.log(`[1:1] Q&A match for ${phone}: "${message.text.slice(0, 30)}"`);
    return;
  }

  // 5. Handle based on current state (no Q&A match — send waiting reminders)
  switch (convo.state) {
    case "welcome":
      // Transition to waiting, send first reminder
      await supabase.from("onboarding_conversations").update({ state: "waiting", updated_at: new Date().toISOString() }).eq("id", convo.id);
      await prov.sendMessage({ groupId: message.groupId, text: getOnboardingWaitingMessage(newCount) });
      break;

    case "waiting":
      // Send varied reminders
      await prov.sendMessage({ groupId: message.groupId, text: getOnboardingWaitingMessage(newCount) });
      break;

    case "onboarded":
    case "active":
      // Already in a group — redirect
      await prov.sendMessage({
        groupId: message.groupId,
        text: "היי! 👋 אני כבר בקבוצה שלכם — כתבו לי שם ואני אעזור!",
      });
      break;
  }
}

// ─── Group Introduction ───

const INTRO_MESSAGE = `היי! 👋 אני שלי, העוזרת החכמה של המשפחה.

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

function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
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
      // Ensure linked household has a referral code
      const { data: hhData } = await supabase.from("households_v2").select("referral_code").eq("id", householdId).single();
      if (hhData && !hhData.referral_code) {
        const refCode = generateReferralCode();
        await supabase.from("households_v2").update({ referral_code: refCode }).eq("id", householdId);
        console.log(`[GroupMgmt] Referral code ${refCode} assigned to existing household ${householdId}`);
      }
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
    // Generate referral code for new household
    const refCode = generateReferralCode();
    await supabase.from("households_v2").update({ referral_code: refCode }).eq("id", householdId);
    console.log(`[GroupMgmt] Referral code ${refCode} assigned to ${householdId}`);
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

  // 8. Notify any pending 1:1 onboarding conversations that their group is now active
  for (const p of humanParticipants) {
    const { data: onboardingConvo } = await supabase
      .from("onboarding_conversations")
      .select("id, phone")
      .eq("phone", p.phone)
      .in("state", ["welcome", "waiting"])
      .single();

    if (onboardingConvo) {
      await supabase
        .from("onboarding_conversations")
        .update({ state: "onboarded", household_id: householdId, updated_at: new Date().toISOString() })
        .eq("id", onboardingConvo.id);

      // Send 1:1 confirmation to the user who added Sheli
      await provider.sendMessage({
        groupId: onboardingConvo.phone,
        text: "מעולה! 🎉 הצטרפתי לקבוצה! אני מתחילה לעזור — פשוט כתבו בקבוצה כרגיל ואני אסדר הכל.",
      });
      console.log(`[1:1] Notified ${p.phone} — onboarding complete, joined group ${groupId}`);
    }
  }

  // 9. Check if any participant came through a referral
  for (const p of humanParticipants) {
    const { data: onboardingRef } = await supabase
      .from("onboarding_conversations")
      .select("referral_code")
      .eq("phone", p.phone)
      .not("referral_code", "is", null)
      .single();

    if (onboardingRef?.referral_code) {
      // Find referring household
      const { data: referrer } = await supabase
        .from("households_v2")
        .select("id")
        .eq("referral_code", onboardingRef.referral_code)
        .single();

      if (referrer && referrer.id !== householdId) {
        // Check no existing referral for this pair
        const { data: existing } = await supabase
          .from("referrals")
          .select("id")
          .eq("referred_household_id", householdId)
          .single();

        if (!existing) {
          await supabase.from("referrals").insert({
            referrer_household_id: referrer.id,
            referred_household_id: householdId,
            referral_code: onboardingRef.referral_code,
            status: "pending",
          });
          console.log(`[GroupMgmt] Referral created: ${referrer.id} → ${householdId} (code: ${onboardingRef.referral_code})`);
        }
      }
    }
  }
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
    classification_data: JSON.parse(JSON.stringify(classification)),
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
    .select("id, message_text, sender_name, classification_data");

  if (claimError || !pending || pending.length === 0) {
    console.log(`[Batch] No pending messages to claim for ${groupId}`);
    return;
  }

  console.log(`[Batch] Claimed ${pending.length} messages for group ${groupId}`);

  // M14 fix: extract items from STORED classification data (no re-classification)
  const allItems: Array<{ name: string; qty?: string; category?: string }> = [];
  for (const msg of pending) {
    const stored = msg.classification_data as Record<string, unknown> | null;
    const entities = stored?.entities as Record<string, unknown> | null;

    if (entities?.items && Array.isArray(entities.items)) {
      allItems.push(...(entities.items as Array<{ name: string; qty?: string; category?: string }>));
    } else if (entities?.raw_text) {
      allItems.push({ name: (entities.raw_text as string).trim() });
    } else {
      // Fallback: treat the message text itself as a single item
      allItems.push({ name: msg.message_text.trim() });
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

  // Generate reply accounting for dedup outcomes
  const newItems = summary.filter((s) => s.startsWith("Shopping:"));
  const updatedItems = summary.filter((s) => s.includes("Shopping-updated:"));
  const existsItems = summary.filter((s) => s.includes("Shopping-exists:"));

  const replyParts: string[] = [];
  if (newItems.length > 0) {
    const names = newItems.map((s) => s.match(/"(.+?)"/)?.[1]).filter(Boolean);
    const nameList = names.length <= 2
      ? names.join(" ו")
      : names.slice(0, -1).join(", ") + " ו" + names[names.length - 1];
    replyParts.push(`🛒 הוספתי ${nameList} לרשימה`);
  }
  if (updatedItems.length > 0) {
    for (const s of updatedItems) {
      const match = s.match(/"(.+?)" → qty (.+)/);
      if (match) replyParts.push(`עדכנתי ${match[1]} ל-${match[2]}`);
    }
  }
  if (existsItems.length > 0) {
    const names = existsItems.map((s) => s.match(/"(.+?)"/)?.[1]).filter(Boolean);
    replyParts.push(`${names.join(", ")} כבר ברשימה 👍`);
  }

  const batchReply = replyParts.join("\n") || "🛒 עדכנתי את הרשימה";
  await provider.sendMessage({ groupId, text: batchReply });

  // Mark all batch messages as processed
  await supabase
    .from("whatsapp_messages")
    .update({ batch_status: "processed", classification: "batch_actionable" })
    .eq("group_id", groupId)
    .eq("batch_status", "processing");
}

// ─── Quick Undo Patterns (pre-classifier, no Haiku call needed) ───
// Layer 1: Keyword undo — these words/phrases always mean "undo last action"
const UNDO_KEYWORDS = /(?:^|\s)(תמחקי|בטלי|תבטלי|עזבי|עזוב|תשכחי|ביטול|לא נכון|בעצם לא|אל תקנו|יש כבר|עזבי מזה|לא לא)(?:\s|$)/;
// Layer 2: Negation + item name — "לא צריך חלב" only undoes if bot just added "חלב"
const UNDO_NEGATIONS = /(?:לא צריך|אל תקנו|יש כבר|אין צורך|לא רוצה)/;

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

    // 3. Skip bot's own messages (Whapi sends outgoing messages back as webhooks)
    const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
    if (message.senderPhone === botPhone || message.senderPhone === botPhone.replace("+", "")) {
      return new Response("OK", { status: 200 });
    }

    // 3.1 SECURITY: Deduplicate messages (prevent replay + Whapi retry double-processing)
    if (message.id) {
      const { data: existing } = await supabase
        .from("whatsapp_messages")
        .select("id")
        .eq("whatsapp_message_id", message.id)
        .limit(1);
      if (existing && existing.length > 0) {
        console.log(`[Webhook] Duplicate message ${message.id}, skipping`);
        return new Response("OK", { status: 200 });
      }
    }

    // 3a. Handle voice messages: transcribe short ones, skip long ones
    if (message.type === "voice") {
      const duration = message.mediaDuration || 0;
      if (duration > 30) {
        console.log(`[Webhook] Skipping long voice (${duration}s) from ${message.senderName}`);
        await logMessage(message, "skipped_long_voice");
        return new Response("OK", { status: 200 });
      }

      console.log(`[Webhook] Transcribing ${duration}s voice from ${message.senderName}`);
      const transcribed = await transcribeVoice(message.mediaUrl, message.mediaId);
      if (!transcribed) {
        console.log(`[Webhook] Transcription failed for ${message.senderName}`);
        await logMessage(message, "voice_transcription_failed");
        return new Response("OK", { status: 200 });
      }

      // Inject transcribed text — from here the pipeline treats it as a typed message
      message.text = transcribed;
      console.log(`[Webhook] Transcribed voice: "${transcribed.slice(0, 80)}..."`);
    }

    // 3b. Skip all non-text/non-voice messages (photos, stickers, video, etc.)
    if (message.type !== "text" && message.type !== "voice") {
      console.log(`[Webhook] Skipping ${message.type} message from ${message.senderName}`);
      await logMessage(message, "skipped_non_text");
      return new Response("OK", { status: 200 });
    }

    // 3c. Cap message length to prevent prompt injection + cost amplification
    // WhatsApp allows 65K chars; we only need ~500 for any reasonable household message
    if (message.text && message.text.length > 500) {
      console.log(`[Webhook] Truncating long message (${message.text.length} chars) from ${message.senderName}`);
      message.text = message.text.slice(0, 500);
    }

    // 3d. Skip empty/whitespace-only messages
    if (!message.text || !message.text.trim()) {
      return new Response("OK", { status: 200 });
    }

    // 3e. Route direct (1:1) messages to onboarding handler
    if (message.chatType === "direct") {
      await handleDirectMessage(message, provider);
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

    // 4b. Populate household name cache (for upgrade prompts) — L8: with TTL
    if (!getHouseholdNameCached(householdId)) {
      const { data: hh } = await supabase.from("households_v2").select("name").eq("id", householdId).single();
      if (hh?.name) householdNameCache[householdId] = { name: hh.name, ts: Date.now() };
    }

    // 5. Log the raw message
    await logMessage(message, "received", householdId);

    // 6. Update member mapping (learn who's who by phone number)
    await upsertMemberMapping(householdId, message.senderPhone, message.senderName);

    // 6a. Dashboard link: send after 10 messages or 24h (whichever first)
    // L6 fix: suppress proactive messages during quiet hours (late night + Shabbat)
    if (!isQuietHours()) {
      await maybeSendDashboardLink(message.groupId, householdId, config);
    }

    // 6b. Detect @שלי direct address — forces a response regardless of intent
    // WhatsApp converts @mentions to numeric IDs: @שלי becomes @<LID> or @<phone>
    // (botPhone already declared in step 3b)
    // ─── Layer 1: Smart שלי detection (H6 fix — replaces broken regex) ───
    // High-confidence NAME patterns only. Ambiguous cases left for Haiku (Layer 2).
    const botLid = Deno.env.get("BOT_WHATSAPP_LID") || "138844095676524";
    const txt = message.text.trim();

    // Explicit @mention or numeric mention — always the bot's name
    const numericMention = txt.includes(`@${botPhone}`) || txt.includes(`@${botLid}`);
    const atMention = /@שלי/.test(txt);

    // English name variants (these are unambiguous — no possessive meaning in English)
    const englishMention = /(?:^|[\s,])@?she(?:li|lly|lli|ly|lei|ley|lee)(?:[\s,:!?.)]|$)/i.test(txt);

    // Hebrew high-confidence NAME patterns:
    // 1. שלי as first word: "שלי מה צריך?"
    const sheliFirstWord = /^\s*שלי[\s,!?]/.test(txt);
    // 2. After greeting: "היי שלי", "שלום שלי"
    const sheliAfterGreeting = /^(היי|הי|שלום|יו|הלו|בוקר טוב|ערב טוב)\s+שלי\b/i.test(txt);
    // 3. After thanks: "תודה שלי"
    const sheliAfterThanks = /תודה\s+שלי\b/.test(txt);
    // 4. Standalone at end after punctuation: "מישהו? שלי?"
    const sheliStandaloneEnd = /[?!]\s+שלי[?!.\s]*$/.test(txt);

    // Check for "של מי" context — cross-message "mine!" detection
    let sheliIsMine = false;
    const isBareSheli = /^\s*שלי[!.\s]*$/.test(txt); // standalone "שלי!" message
    if (isBareSheli) {
      // Look at recent messages for "של מי" question
      const ninetySecsAgo = new Date(Date.now() - 90000).toISOString();
      const { data: recent } = await supabase
        .from("whatsapp_messages")
        .select("message_text")
        .eq("group_id", message.groupId)
        .gte("created_at", ninetySecsAgo)
        .order("created_at", { ascending: false })
        .limit(3);
      if (recent?.some((m: { message_text: string }) => m.message_text && /של מי/.test(m.message_text))) {
        sheliIsMine = true; // "שלי!" = "mine!" answering "של מי?"
        console.log(`[Webhook] "שלי" is "mine!" (answering recent "של מי?" question)`);
      }
    }

    const highConfidenceName = !sheliIsMine && (
      atMention || numericMention || englishMention ||
      sheliFirstWord || sheliAfterGreeting || sheliAfterThanks || sheliStandaloneEnd
    );
    // For ambiguous cases (שלי mid-sentence), directAddress stays false — Haiku Layer 2 decides
    let directAddress = highConfidenceName;

    const cleanedText = directAddress
      ? txt
          .replace(/@?שלי[\s,:]*/, "")
          .replace(/@?she(?:li|lly|lli|ly|lei|ley|lee)[\s,:]*/i, "")
          .replace(new RegExp(`@${botPhone}\\s*`), "")
          .replace(new RegExp(`@${botLid}\\s*`), "")
          .trim()
      : txt;

    if (directAddress) {
      console.log(`[Webhook] Layer 1: Direct address detected from ${message.senderName} (first=${sheliFirstWord}, greeting=${sheliAfterGreeting}, thanks=${sheliAfterThanks}, end=${sheliStandaloneEnd}, @=${atMention}, en=${englishMention})`);
    }

    // 6c. Quick undo: if message matches rejection/negation pattern, undo last bot action
    const isUndoKeyword = UNDO_KEYWORDS.test(message.text.trim());
    // For item-specific negation, we need the last action to check item names
    let isItemNegation = false;
    let undoLastActionRef: Awaited<ReturnType<typeof getLastBotAction>> | null = null;
    if (!isUndoKeyword && UNDO_NEGATIONS.test(message.text)) {
      undoLastActionRef = await getLastBotAction(message.groupId, householdId);
      if (undoLastActionRef) {
        const items = undoLastActionRef.classification_data?.entities?.items;
        if (items && items.some((item: { name: string }) => message.text.includes(item.name))) {
          isItemNegation = true;
        }
      }
    }

    if (isUndoKeyword || isItemNegation) {
      const lastAction = undoLastActionRef || await getLastBotAction(message.groupId, householdId);
      if (lastAction) {
        const sixtySecsAgo = Date.now() - 60000;
        if (new Date(lastAction.created_at).getTime() > sixtySecsAgo) {
          const undone = await undoLastAction(householdId, lastAction.classification_data);
          if (undone.length > 0) {
            await provider.sendMessage({
              groupId: message.groupId,
              text: `בוטל ✓`,
            });
            await supabase.from("classification_corrections").insert({
              household_id: householdId,
              message_id: lastAction.messageId,
              correction_type: "explicit_reject",
              original_data: lastAction.classification_data,
            });
            await logMessage(message, "explicit_undo", householdId);
            return new Response("OK", { status: 200 });
          }
        }
      }
      // If no recent action to undo, fall through to normal classification
    }

    // 7. Check usage limits (free tier: 30 actions/month)
    const usage = await checkUsageLimit(householdId);
    const usageOk = usage.allowed;

    // 7b. Soft warning at 25 actions (L6: skip during quiet hours)
    if (!usage.isPaid && !isQuietHours()) {
      await maybeSendSoftWarning(message.groupId, householdId, usage.count, config.language);
    }

    // 7c. Referral announcement at 10 actions + reward check (one-time, skip quiet hours)
    if (!usage.isPaid) {
      await maybeSendReferralAnnouncement(message.groupId, householdId, usage.count);
      await maybeCompleteReferral(householdId, usage.count);
    }

    // ─── STAGE 1: Haiku Classification (fast, cheap) ───

    // Fetch recent conversation for context injection
    const conversationMsgs = await fetchRecentConversation(
      message.groupId || message.senderId,
      message.id
    );
    const conversationHistory = conversationMsgs.length > 0
      ? conversationMsgs.map((m) => {
          const time = new Date(m.created_at).toLocaleTimeString("he-IL", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Jerusalem",
          });
          // SECURITY: sanitize stored names/text to prevent second-order prompt injection
          const safeName = (m.sender_name || "?").replace(/[\x00-\x1f\x7f\[\]{}]/g, "").slice(0, 50);
          const safeText = (m.message_text || "").slice(0, 500);
          return `[${time} ${safeName}]: ${safeText}`;
        }).join("\n")
      : undefined;

    const haikuCtx = await buildClassifierCtx(householdId);
    haikuCtx.conversationHistory = conversationHistory;

    const classification = await classifyIntent(
      cleanedText || message.text,
      message.senderName,
      haikuCtx
    );

    console.log(`[Webhook] Haiku: intent=${classification.intent} conf=${classification.confidence.toFixed(2)} addressed=${classification.addressed_to_bot} contextReview=${classification.needs_conversation_review} from ${message.senderName}`);

    // Layer 2 merge: if Haiku says addressed_to_bot and Layer 1 didn't catch it, upgrade directAddress
    if (classification.addressed_to_bot && !directAddress) {
      directAddress = true;
      console.log(`[Webhook] Layer 2: Haiku detected שלי as bot name (Layer 1 missed it)`);
    }

    // 8. Route based on intent + confidence
    const CONFIDENCE_HIGH = 0.70;
    const CONFIDENCE_LOW = 0.50;
    const isActionable = classification.intent !== "ignore" && classification.intent !== "info_request" && classification.intent !== "correct_bot";

    // 8a. Shopping batch: collect rapid-fire shopping items into one reply
    if (classification.intent === "add_shopping" && classification.confidence >= CONFIDENCE_HIGH) {
      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId, classification);
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

    // 8b. Correction: user is fixing something Sheli did wrong
    // No confidence threshold — corrections are always explicit and should always get a reply
    if (classification.intent === "correct_bot") {
      await handleCorrection(message, classification, householdId, provider);
      return new Response("OK", { status: 200 });
    }

    // If ignore with high confidence → stop (no Sonnet call)
    // UNLESS directly addressed or context-uncertain — then escalate to Sonnet
    if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH && !classification.needs_conversation_review) {
      if (directAddress) {
        // Direct address overrides ignore — generate a personality reply
        // Use original text (with שלי) so Sonnet sees the full context
        const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
        const replyCtx = await buildReplyCtx(householdId);
        const { reply } = await generateReply(directClassification, message.senderName, replyCtx);
        if (reply) {
          await provider.sendMessage({ groupId: message.groupId, text: reply });
        }
        await logMessage(message, "direct_address_reply", householdId, classification);
        return new Response("OK", { status: 200 });
      }
      await logMessage(message, "haiku_ignore", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Low confidence → normally treat as ignore, BUT direct address always gets a reply
    if (classification.confidence < CONFIDENCE_LOW) {
      if (directAddress) {
        console.log(`[Webhook] Low confidence but direct address — forcing reply`);
        const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
        const replyCtx = await buildReplyCtx(householdId);
        const { reply } = await generateReply(directClassification, message.senderName, replyCtx);
        if (reply) {
          await provider.sendMessage({ groupId: message.groupId, text: reply });
        }
        await logMessage(message, "direct_address_reply", householdId, classification);
        return new Response("OK", { status: 200 });
      }
      console.log(`[Webhook] Low confidence (${classification.confidence.toFixed(2)}), treating as ignore`);
      await logMessage(message, "haiku_low_confidence", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Medium confidence OR context-uncertain → escalate to Sonnet with full conversation
    if (
      (classification.confidence < CONFIDENCE_HIGH && isActionable) ||
      classification.needs_conversation_review
    ) {
      console.log(`[Webhook] Escalating to Sonnet (conf=${classification.confidence.toFixed(2)}, contextReview=${classification.needs_conversation_review})`);
      const sonnetMessages = [
        ...conversationMsgs.map((m) => ({
          sender: m.sender_name,
          text: m.message_text,
          timestamp: new Date(m.created_at).getTime(),
        })),
        { sender: message.senderName, text: message.text, timestamp: message.timestamp },
      ];
      const sonnetResult = await classifyMessages(householdId, sonnetMessages);

      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        if (directAddress) {
          // Sonnet says social, but user addressed Sheli — still reply
          const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
          const replyCtx = await buildReplyCtx(householdId);
          const { reply } = await generateReply(directClassification, message.senderName, replyCtx);
          if (reply) {
            await provider.sendMessage({ groupId: message.groupId, text: reply });
          }
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }
        await logMessage(message, "sonnet_escalated_social", householdId);
        return new Response("OK", { status: 200 });
      }

      // Sonnet says actionable — check usage, execute, reply
      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId, classification);
        return new Response("OK", { status: 200 });
      }

      const { summary: sonnetSummary } = await executeActions(householdId, sonnetResult.actions);
      console.log(`[Webhook] Sonnet escalation executed ${sonnetSummary.length} actions:`, sonnetSummary);

      // Check if all actions were deduped
      const sonnetAllDeduped = sonnetSummary.length > 0 && sonnetSummary.every(
        (s) => s.includes("-exists:") || s.includes("-updated:")
      );

      if (sonnetAllDeduped) {
        const dedupMessages: string[] = [];
        for (const s of sonnetSummary) {
          if (s.includes("Shopping-exists:")) {
            const name = s.match(/"(.+?)"/)?.[1] || "";
            dedupMessages.push(`${name} כבר ברשימה`);
          } else if (s.includes("Shopping-updated:")) {
            const m = s.match(/"(.+?)" → qty (.+)/);
            if (m) dedupMessages.push(`עדכנתי ${m[1]} ל-${m[2]}`);
          } else if (s.includes("Task-exists:")) {
            const name = s.match(/"(.+?)"/)?.[1] || "";
            dedupMessages.push(`"${name}" כבר במטלות`);
          } else if (s.includes("Event-exists:")) {
            const name = s.match(/"(.+?)"/)?.[1] || "";
            dedupMessages.push(`"${name}" כבר ביומן`);
          }
        }
        const dedupReply = "👍 " + dedupMessages.join("\n");
        await provider.sendMessage({ groupId: message.groupId, text: dedupReply });
      } else {
        await incrementUsage(householdId);
        if (sonnetResult.reply) {
          await provider.sendMessage({ groupId: message.groupId, text: sonnetResult.reply });
        }
      }
      await logMessage(message, "sonnet_escalated", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Non-actionable intents (question, info_request) — generate reply only, no DB writes
    if (!isActionable && classification.intent !== "ignore") {
      const replyCtx = await buildReplyCtx(householdId);
      const { reply } = await generateReply(classification, message.senderName, replyCtx);
      if (reply) {
        await provider.sendMessage({ groupId: message.groupId, text: reply });
      }
      await logMessage(message, "haiku_reply_only", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // ─── High confidence actionable → execute via Haiku entities ───

    // 9. Check usage limit
    if (!usageOk) {
      await sendUpgradePrompt(message.groupId, householdId, config.language);
      await logMessage(message, "usage_limit_reached", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // 10. Convert Haiku entities to ClassifiedAction format and execute
    const actions = haikuEntitiesToActions(classification);

    // H7 fix: if Haiku classified as actionable but couldn't extract entity IDs,
    // the actions array is empty. Don't execute + don't send a false "done!" reply.
    // Instead, escalate to Sonnet for better entity extraction, or ask for clarification.
    if (actions.length === 0 && ["complete_task", "complete_shopping", "claim_task"].includes(classification.intent)) {
      console.log(`[Webhook] H7: ${classification.intent} with no actionable entities — asking for clarification`);
      const clarifyMsg = (config.language === "he")
        ? `לא מצאתי בדיוק למה את/ה מתכוון/ת 🤔 אפשר לפרט?`
        : `I'm not sure which one you mean 🤔 Can you be more specific?`;
      await provider.sendMessage({ groupId: message.groupId, text: clarifyMsg });
      await logMessage(message, "haiku_actionable", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    const { summary } = await executeActions(householdId, actions);
    console.log(`[Webhook] Haiku executed ${summary.length} actions:`, summary);

    // 11. Check for dedup outcomes
    const allDeduped = summary.length > 0 && summary.every(
      (s) => s.includes("-exists:") || s.includes("-updated:")
    );

    if (allDeduped) {
      // Everything was a duplicate — send dedup reply, no Sonnet call needed
      const dedupMessages: string[] = [];
      for (const s of summary) {
        if (s.includes("Shopping-exists:")) {
          const name = s.match(/"(.+?)"/)?.[1] || "";
          dedupMessages.push(`${name} כבר ברשימה`);
        } else if (s.includes("Shopping-updated:")) {
          const match = s.match(/"(.+?)" → qty (.+)/);
          if (match) dedupMessages.push(`עדכנתי ${match[1]} ל-${match[2]}`);
        } else if (s.includes("Task-exists:")) {
          const name = s.match(/"(.+?)"/)?.[1] || "";
          dedupMessages.push(`"${name}" כבר במטלות`);
        } else if (s.includes("Event-exists:")) {
          const name = s.match(/"(.+?)"/)?.[1] || "";
          dedupMessages.push(`"${name}" כבר ביומן`);
        }
      }
      const dedupReply = "👍 " + dedupMessages.join("\n");
      await provider.sendMessage({ groupId: message.groupId, text: dedupReply });
      await logMessage(message, "haiku_actionable", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // 12. Increment usage counter (only for actual new actions)
    await incrementUsage(householdId);

    // 13. Generate personality reply via Sonnet (Stage 2)
    const replyCtx = await buildReplyCtx(householdId);
    const { reply } = await generateReply(classification, message.senderName, replyCtx);
    if (reply) {
      await provider.sendMessage({ groupId: message.groupId, text: reply });
      console.log(`[Webhook] Reply sent`);
    }

    // 14. Log completion
    await logMessage(message, "haiku_actionable", householdId, classification);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

// ─── Helper Functions ───

async function transcribeVoice(mediaUrl: string | undefined, mediaId: string | undefined): Promise<string | null> {
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
  if (!GROQ_API_KEY) {
    console.error("[Voice] GROQ_API_KEY not set");
    return null;
  }

  if (!mediaUrl && !mediaId) {
    console.error("[Voice] No media URL or media ID available");
    return null;
  }

  try {
    // 1. Download audio — either from direct link or via Whapi media API
    let audioBlob: Blob;
    if (mediaUrl) {
      const audioResponse = await fetch(mediaUrl);
      if (!audioResponse.ok) {
        console.error("[Voice] Failed to download audio from link:", audioResponse.status);
        return null;
      }
      audioBlob = await audioResponse.blob();
    } else {
      // No direct link — download via Whapi GET /media/{mediaId}
      const apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
      const token = Deno.env.get("WHAPI_TOKEN") || "";
      const mediaResponse = await fetch(`${apiUrl}/media/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "audio/ogg",
        },
      });
      if (!mediaResponse.ok) {
        console.error("[Voice] Whapi media download failed:", mediaResponse.status, await mediaResponse.text());
        return null;
      }
      audioBlob = await mediaResponse.blob();
    }

    // 2. Build multipart form data for Groq Whisper API
    // No language hint — Whisper auto-detects Hebrew, English, or mixed.
    const formData = new FormData();
    formData.append("file", audioBlob, "voice.ogg");
    formData.append("model", "whisper-large-v3");

    // 3. Call Groq Whisper API (OpenAI-compatible endpoint)
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      console.error("[Voice] Groq API error:", response.status, await response.text());
      return null;
    }

    const result = await response.json();
    return result.text?.trim() || null;
  } catch (err) {
    console.error("[Voice] Transcription error:", err);
    return null;
  }
}

async function logMessage(
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
  classification: string,
  householdId?: string,
  classificationData?: ClassificationOutput | null
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
      classification_data: classificationData ? JSON.parse(JSON.stringify(classificationData)) : null,
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

async function checkUsageLimit(householdId: string): Promise<{ allowed: boolean; count: number; isPaid: boolean }> {
  // Beta mode: skip usage limits for early testing families
  if (Deno.env.get("BETA_MODE") === "true") return { allowed: true, count: 0, isPaid: true };

  // Check if household has an active subscription or referral reward
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, plan, free_until")
    .eq("household_id", householdId)
    .eq("status", "active")
    .single();

  if (sub && sub.plan !== "free") return { allowed: true, count: 0, isPaid: true };

  // Check referral reward: free_until still in the future
  if (sub?.free_until && new Date(sub.free_until) > new Date()) {
    return { allowed: true, count: 0, isPaid: true };
  }

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

  const usageCount = count || 0;
  return { allowed: usageCount < 30, count: usageCount, isPaid: false };
}

async function maybeSendSoftWarning(groupId: string, householdId: string, usageCount: number, language?: string) {
  if (usageCount < 25 || usageCount >= 30) return;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count: warningsSent } = await supabase
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("household_id", householdId)
    .eq("classification", "soft_warning")
    .gte("created_at", startOfMonth.toISOString());

  if ((warningsSent || 0) > 0) return;

  const remaining = 30 - usageCount;
  const lang = language || "he";
  const warningMsg = lang === "he"
    ? `נשארו לכם ${remaining} פעולות חינמיות החודש. רוצים להמשיך בלי הגבלה? 9.90 ₪ לחודש 🔗 sheli.ai/upgrade`
    : `You have ${remaining} free actions left this month. Want unlimited? $2.70/month 🔗 sheli.ai/upgrade`;

  await provider.sendMessage({ groupId, text: warningMsg });
  // M2 fix: use correct column names (matching logMessage function)
  await supabase.from("whatsapp_messages").insert({
    whatsapp_message_id: `warning_${Date.now()}`,
    group_id: groupId,
    household_id: householdId,
    sender_phone: "system",
    sender_name: "system",
    message_text: warningMsg,
    classification: "soft_warning",
  });
  console.log(`[Webhook] Soft warning sent to ${groupId} (${remaining} actions remaining)`);
}

async function maybeSendDashboardLink(groupId: string, householdId: string, config: Record<string, unknown>) {
  try {
    await supabase.rpc("increment_group_message_count", { p_group_id: groupId });

    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("dashboard_link_sent, first_message_at, group_message_count")
      .eq("group_id", groupId)
      .single();

    if (!cfg || cfg.dashboard_link_sent) return;

    const messageCount = cfg.group_message_count || 0;
    const firstMsgTime = cfg.first_message_at ? new Date(cfg.first_message_at as string).getTime() : Date.now();
    const hoursSinceFirst = (Date.now() - firstMsgTime) / (1000 * 60 * 60);

    if (messageCount >= 10 || hoursSinceFirst >= 24) {
      const lang = (config.language as string) || "he";
      const msg = lang === "he"
        ? `📊 רוצים לראות הכל במקום אחד?\nמטלות, קניות ואירועים — הכל בדשבורד אחד.\n🔗 sheli.ai?source=wa`
        : `📊 Want to see everything in one place?\nTasks, shopping, and events — all in one dashboard.\n🔗 sheli.ai?source=wa`;

      await provider.sendMessage({ groupId, text: msg });
      await supabase
        .from("whatsapp_config")
        .update({ dashboard_link_sent: true })
        .eq("group_id", groupId);
      console.log(`[Webhook] Dashboard link sent to group ${groupId} (msgs=${messageCount}, hours=${hoursSinceFirst.toFixed(1)})`);
    }
  } catch (err) {
    console.error("[maybeSendDashboardLink] Error:", err);
  }
}

async function incrementUsage(householdId: string) {
  try {
    await supabase.rpc("increment_ai_usage", { p_household_id: householdId });
  } catch (err) {
    console.error("[incrementUsage] Error:", err);
  }
}

// ─── Referral: proactive announcement at 10th action ───

async function maybeSendReferralAnnouncement(groupId: string, householdId: string, usageCount: number) {
  if (usageCount < 10) return;

  try {
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("referral_announced")
      .eq("group_id", groupId)
      .single();

    if (!cfg || cfg.referral_announced) return;

    const { data: hh } = await supabase
      .from("households_v2")
      .select("referral_code")
      .eq("id", householdId)
      .single();

    if (!hh?.referral_code) return;
    if (isQuietHours()) return;

    const msg = `🎁 משפחה מביאה משפחה!\nאהבתם את שלי? שתפו עם משפחה נוספת —\nשתי המשפחות מקבלות חודש פרימיום במתנה!\n\nשלחו את הקישור: sheli.ai/r/${hh.referral_code}`;

    await provider.sendMessage({ groupId, text: msg });
    await supabase
      .from("whatsapp_config")
      .update({ referral_announced: true })
      .eq("group_id", groupId);
    console.log(`[Referral] Announcement sent to ${groupId} (code: ${hh.referral_code})`);
  } catch (err) {
    console.error("[maybeSendReferralAnnouncement] Error:", err);
  }
}

// ─── Referral: reward when referred family hits 10 actions ───

async function maybeCompleteReferral(householdId: string, usageCount: number) {
  if (usageCount < 10) return;

  try {
    const { data: referral } = await supabase
      .from("referrals")
      .select("id, referrer_household_id, referred_household_id")
      .eq("referred_household_id", householdId)
      .eq("status", "pending")
      .single();

    if (!referral) return;

    console.log(`[Referral] Completing referral ${referral.id}: ${referral.referrer_household_id} → ${householdId}`);

    await supabase
      .from("referrals")
      .update({ status: "completed", rewarded_at: new Date().toISOString() })
      .eq("id", referral.id);

    // Grant 1 free month to BOTH households
    for (const hhId of [referral.referrer_household_id, referral.referred_household_id]) {
      const { data: existingSub } = await supabase
        .from("subscriptions")
        .select("id, free_until")
        .eq("household_id", hhId)
        .single();

      if (existingSub) {
        const currentFreeUntil = existingSub.free_until ? new Date(existingSub.free_until) : new Date();
        const baseDate = currentFreeUntil > new Date() ? currentFreeUntil : new Date();
        const newFreeUntil = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await supabase.from("subscriptions").update({ free_until: newFreeUntil }).eq("id", existingSub.id);
      } else {
        const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await supabase.from("subscriptions").insert({
          household_id: hhId,
          status: "active",
          plan: "free",
          free_until: thirtyDaysFromNow,
        });
      }
    }

    // Send celebration to referred family's group
    const { data: referredConfig } = await supabase
      .from("whatsapp_config")
      .select("group_id")
      .eq("household_id", referral.referred_household_id)
      .eq("bot_active", true)
      .single();

    if (referredConfig) {
      await provider.sendMessage({
        groupId: referredConfig.group_id,
        text: "🎉 חודש פרימיום במתנה! המשיכו להשתמש בשלי ללא הגבלה.",
      });
    }

    // Send celebration to referring family's group
    const { data: referringConfig } = await supabase
      .from("whatsapp_config")
      .select("group_id")
      .eq("household_id", referral.referrer_household_id)
      .eq("bot_active", true)
      .single();

    if (referringConfig) {
      const { data: referredHh } = await supabase
        .from("households_v2")
        .select("name")
        .eq("id", referral.referred_household_id)
        .single();

      const familyName = referredHh?.name || "משפחה חדשה";
      await provider.sendMessage({
        groupId: referringConfig.group_id,
        text: `🎉 ${familyName} הצטרפו בזכותכם! חודש פרימיום במתנה לשתי המשפחות!`,
      });
    }

    console.log(`[Referral] Reward granted: both ${referral.referrer_household_id} and ${householdId} get 30 days free`);
  } catch (err) {
    console.error("[maybeCompleteReferral] Error:", err);
  }
}

// L8 fix: in-memory cache with 5-minute TTL (isolate persists across requests in Deno Deploy)
const householdNameCache: Record<string, { name: string; ts: number }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
function getHouseholdNameCached(householdId: string): string | null {
  const entry = householdNameCache[householdId];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { delete householdNameCache[householdId]; return null; }
  return entry.name;
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

  const [membersRes, tasksRes, shoppingRes, patternsRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to").eq("household_id", householdId).eq("done", false),
    supabase.from("shopping_items").select("id, name, qty").eq("household_id", householdId).eq("got", false),
    supabase.from("household_patterns").select("pattern_type, pattern_key, pattern_value")
      .eq("household_id", householdId).gte("confidence", 0.3)
      .order("hit_count", { ascending: false }).limit(20),
  ]);

  // Build family patterns string for prompt injection
  let familyPatterns = "";
  const patterns = patternsRes.data;
  if (patterns && patterns.length > 0) {
    const byType: Record<string, string[]> = {};
    for (const p of patterns) {
      if (!byType[p.pattern_type]) byType[p.pattern_type] = [];
      byType[p.pattern_type].push(`"${p.pattern_key}" = ${p.pattern_value}`);
    }
    const sections: string[] = [];
    if (byType.nickname) sections.push(`Nicknames: ${byType.nickname.join(", ")}`);
    if (byType.time_expr) sections.push(`Times: ${byType.time_expr.join(", ")}`);
    if (byType.category_pref) sections.push(`Categories: ${byType.category_pref.join(", ")}`);
    if (byType.compound_name) sections.push(`Compound names (ONE item): ${byType.compound_name.join(", ")}`);
    if (byType.recurring_item) sections.push(`Recurring: ${byType.recurring_item.join(", ")}`);
    familyPatterns = sections.join("\n");
  }

  return {
    members: (membersRes.data || []).map((m) => m.display_name),
    openTasks: (tasksRes.data || []).map((t) => ({ id: t.id, title: t.title, assigned_to: t.assigned_to })),
    openShopping: (shoppingRes.data || []).map((s) => ({ id: s.id, name: s.name, qty: s.qty })),
    today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    dayOfWeek: hebrewDays[today.getDay()],
    familyPatterns,
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

    case "add_event": {
      // M13 fix: if no time_iso, default to 18:00 today (not "right now")
      // This is better than new Date() which creates a past-looking event
      let scheduledFor = e.time_iso;
      if (!scheduledFor) {
        const today = new Date();
        today.setHours(18, 0, 0, 0); // Default to 6 PM
        scheduledFor = today.toISOString();
        console.log(`[Webhook] M13: No time_iso for add_event, defaulting to 18:00 today. time_raw: ${e.time_raw}`);
      }
      actions.push({
        type: "add_event",
        data: {
          title: e.title || e.raw_text,
          assigned_to: e.person || null,
          scheduled_for: scheduledFor,
        },
      });
      break;
    }

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

// ─── Correction Helpers (undo/redo for correct_bot) ───

async function getLastBotAction(groupId: string, householdId: string): Promise<{
  messageId: string;
  classification_data: ClassificationOutput;
  created_at: string;
} | null> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("id, whatsapp_message_id, classification_data, created_at")
    .eq("group_id", groupId)
    .eq("household_id", householdId)
    .in("classification", ["haiku_actionable", "sonnet_escalated", "batch_actionable"])
    .gte("created_at", fiveMinAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!data || !data.classification_data) return null;
  return {
    // L9 fix: use WhatsApp message ID for correction auditing, fallback to DB row ID
    messageId: data.whatsapp_message_id || data.id,
    classification_data: data.classification_data as ClassificationOutput,
    created_at: data.created_at,
  };
}

async function undoLastAction(householdId: string, lastAction: ClassificationOutput): Promise<string[]> {
  const undone: string[] = [];

  switch (lastAction.intent) {
    case "add_shopping": {
      const items = lastAction.entities.items || [];
      for (const item of items) {
        // Find the most recent matching item, then delete by ID
        const { data: found } = await supabase
          .from("shopping_items")
          .select("id, name")
          .eq("household_id", householdId)
          .eq("name", item.name)
          .eq("got", false)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        if (found) {
          await supabase.from("shopping_items").delete().eq("id", found.id);
          undone.push(`"${found.name}"`);
        }
      }
      break;
    }
    case "add_task": {
      const title = lastAction.entities.title || lastAction.entities.raw_text;
      const { data: found } = await supabase
        .from("tasks")
        .select("id, title")
        .eq("household_id", householdId)
        .eq("title", title)
        .eq("done", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (found) {
        await supabase.from("tasks").delete().eq("id", found.id);
        undone.push(`"${found.title}"`);
      }
      break;
    }
    case "add_event": {
      const title = lastAction.entities.title || lastAction.entities.raw_text;
      const { data: found } = await supabase
        .from("events")
        .select("id, title")
        .eq("household_id", householdId)
        .eq("title", title)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (found) {
        await supabase.from("events").delete().eq("id", found.id);
        undone.push(`"${found.title}"`);
      }
      break;
    }
  }
  return undone;
}

async function handleCorrection(
  message: IncomingMessage,
  classification: ClassificationOutput,
  householdId: string,
  provider: WhatsAppProvider,
): Promise<void> {
  // 1. Find the last bot action
  const lastAction = await getLastBotAction(message.groupId, householdId);

  if (!lastAction) {
    await provider.sendMessage({
      groupId: message.groupId,
      text: "לא מצאתי פעולה אחרונה לתקן 🤔",
    });
    return;
  }

  // 2. Undo the last action
  const undone = await undoLastAction(householdId, lastAction.classification_data);
  console.log(`[Correction] Undone:`, undone);

  // 3. If correction_text provided, redo with the corrected version
  const correctionText = classification.entities.correction_text;
  let redone: string[] = [];
  if (correctionText) {
    // Re-classify the correction text to get proper entities
    const ctx = await buildClassifierCtx(householdId);
    const reclassified = await classifyIntent(correctionText, message.senderName, ctx);

    if (reclassified.intent !== "ignore" && reclassified.intent !== "correct_bot") {
      const actions = haikuEntitiesToActions(reclassified);
      const result = await executeActions(householdId, actions);
      redone = result.summary;
    }
  }

  // 4. Log the correction for learning
  await supabase.from("classification_corrections").insert({
    household_id: householdId,
    message_id: lastAction.messageId,
    correction_type: "mention_correction",
    original_data: lastAction.classification_data,
    corrected_data: classification,
  });

  // 5. Reply with confirmation
  const replyParts: string[] = [];
  if (undone.length > 0) replyParts.push(`ביטלתי: ${undone.join(", ")}`);
  if (redone.length > 0) replyParts.push(`הוספתי: ${redone.join(", ")}`);
  const reply = replyParts.length > 0
    ? `סורי! 😅 ${replyParts.join(". ")}`
    : "סורי! תיקנתי 😅";

  // 6. Auto-derive patterns from this correction
  await derivePatternFromCorrection(householdId, "mention_correction", lastAction.classification_data, classification);

  await provider.sendMessage({ groupId: message.groupId, text: reply });
  await logMessage(message, "correction_applied", householdId, classification);
}

async function derivePatternFromCorrection(
  householdId: string,
  correctionType: string,
  originalData: ClassificationOutput | null,
  correctedData: ClassificationOutput | null,
) {
  if (!originalData) return;

  try {
    // Compound name fix: user corrected a split (e.g., "שמן" + "זית" → "שמן זית")
    if (correctionType === "mention_correction" && correctedData?.entities?.correction_text) {
      const correctedText = correctedData.entities.correction_text;
      if (correctedText.includes(" ")) {
        await supabase.from("household_patterns").upsert({
          household_id: householdId,
          pattern_type: "compound_name",
          pattern_key: correctedText,
          pattern_value: correctedText,
          confidence: 0.8,
          hit_count: 1,
          last_seen: new Date().toISOString(),
        }, { onConflict: "household_id,pattern_type,pattern_key" });
        console.log(`[Patterns] Learned compound name: "${correctedText}" for ${householdId}`);
      }
    }

    // Category fix: if corrected items have a different category than original
    if (correctedData?.entities?.items?.[0]?.category) {
      const item = correctedData.entities.items[0];
      if (item.category && item.category !== "אחר") {
        await supabase.from("household_patterns").upsert({
          household_id: householdId,
          pattern_type: "category_pref",
          pattern_key: item.name,
          pattern_value: item.category,
          confidence: 0.7,
          hit_count: 1,
          last_seen: new Date().toISOString(),
        }, { onConflict: "household_id,pattern_type,pattern_key" });
        console.log(`[Patterns] Learned category: "${item.name}" → ${item.category} for ${householdId}`);
      }
    }
  } catch (err) {
    console.error("[derivePatternFromCorrection] Error:", err);
  }
}

async function sendUpgradePrompt(groupId: string, householdId: string, language?: string) {
  const lang = language || "he";
  // L11 fix: use iCount payment URL (not Stripe — billing provider is iCount)
  const upgradeLink = Deno.env.get("ICOUNT_PAYMENT_LINK") || "sheli.ai/upgrade";
  const paymentUrl = upgradeLink.includes("?")
    ? `${upgradeLink}&hh=${householdId}`
    : `${upgradeLink}?hh=${householdId}`;

  const upgradeMsg = lang === "he"
    ? `היי ${getHouseholdNameCached(householdId) || "משפחה"} 👋\nהשתמשתם ב-30 הפעולות החינמיות החודשיות שלכם.\nשדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה — 9.90 ₪ לחודש.\n🔗 ${paymentUrl}`
    : `Hey ${getHouseholdNameCached(householdId) || "family"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping — $2.70/month.\n🔗 ${paymentUrl}`;

  await provider.sendMessage({ groupId, text: upgradeMsg });
}
