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
  quotedText?: string;    // Text of the quoted/replied-to message (WhatsApp reply feature)
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
    | "correct_bot"
    | "add_reminder"
    | "instruct_bot"
    | "save_memory"
    | "recall_memory"
    | "delete_memory";
  confidence: number; // 0.0 - 1.0
  addressed_to_bot?: boolean; // true when user is talking TO Sheli (not possessive "my/mine")
  needs_conversation_review?: boolean; // true when context makes intent ambiguous
  entities: {
    person?: string;
    items?: Array<{ name: string; qty?: string; category?: string }>;
    rotation?: {
      title: string;
      type: "order" | "duty";
      members: string[];
      frequency?: { type: "daily" } | { type: "interval"; days: number } | { type: "weekly"; days: string[] };
      start_person?: string;
    };
    override?: {
      title: string;
      person: string;
    };
    title?: string;
    time_raw?: string;
    time_iso?: string;
    task_id?: string;
    item_id?: string;
    correction_text?: string;
    reminder_text?: string;
    memory_content?: string;
    memory_about?: string; // member name
    raw_text: string;
  };
}

interface ClassifierContext {
  members: string[];
  openTasks: Array<{ id: string; title: string; assigned_to: string | null }>;
  openShopping: Array<{ id: string; name: string; qty: string | null }>;
  activeRotations?: Array<{ title: string; type: string; members: string[]; current_index: number }>;
  today: string; // ISO date "2026-04-02"
  dayOfWeek: string; // Hebrew day name "רביעי"
  familyPatterns?: string; // Learned patterns for this household
  conversationHistory?: string; // Formatted recent conversation for context
  // (Removed: demoMode — no more Haiku in 1:1, Sonnet handles all)
}

// ─── Reply Generator Types (from reply-generator.ts) ───

interface ReplyContext {
  householdName: string;
  members: string[];
  memberGenders?: Record<string, string>; // name → "male"|"female"|null
  language: string;
  currentTasks: Array<{ id: string; title: string; assigned_to: string | null; done: boolean }>;
  currentShopping: Array<{ id: string; name: string; qty: string | null; got: boolean }>;
  currentEvents: Array<{ id: string; title: string; assigned_to: string | null; scheduled_for: string }>;
  currentRotations?: Array<{ id: string; title: string; type: string; members: string[]; current_index: number; frequency?: object | null }>;
  recentBotReplies?: string[];
  familyMemories?: string; // Formatted family memories for prompt injection
}

interface ReplyResult {
  reply: string;
  model: string;
}

// ─── AI Classifier Types (from ai-classifier.ts) ───

interface ClassifiedAction {
  type: "add_task" | "add_shopping" | "add_event" | "complete_task" | "complete_shopping" | "add_reminder" | "assign_task" | "create_rotation" | "override_rotation";
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
    if (!webhookToken) return true; // No webhook token configured — accept all (configure WHAPI_WEBHOOK_TOKEN to enable verification)
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

      // Extract quoted/replied-to message context
      const msgContext = msg.context as Record<string, unknown> | undefined;
      const quotedText = (msgContext?.quoted_content as Record<string, string>)?.body
        || (msgContext?.quotedMsg as Record<string, string>)?.body
        || "";

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
        quotedText: quotedText || undefined,
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

  const rotationsArr = ctx.activeRotations || [];
  const rotationsStr =
    rotationsArr.length === 0
      ? "(none)"
      : rotationsArr
          .map((r) => {
            const members = Array.isArray(r.members) ? r.members : JSON.parse(r.members as any);
            const current = members[r.current_index] || members[0];
            const typeLabel = r.type === "order" ? "סדר" : "תורנות";
            return `• ${r.title} (${typeLabel}): ${members.join(" ← ")} (current: ${current})`;
          })
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

  return `You are a Hebrew WhatsApp message classifier for Sheli, a smart personal helper. Classify each message into exactly ONE intent. Messages come from both group chats and 1:1 personal chats.
INTENTS:
- ignore: Social noise (greetings, reactions, emojis, jokes, chatter, forwarded messages, status updates). ~80% of messages.
- add_shopping: Adding item(s) to shopping list. Bare nouns, "צריך X", "נגמר X", "אין X".
- add_task: Creating a chore/to-do. "צריך ל...", "[person] [activity] [time]", maintenance requests. Works for personal tasks ("לשלם חשבון") and shared chores.
- add_event: Scheduling a specific date/time event. Appointments, classes, dinners, meetings.
- complete_task: Marking an existing task as done. Past tense of open task, "סיימתי", "בוצע".
- complete_shopping: Confirming purchase of a list item. "קניתי", "יש", "לקחתי".
- question: Asking about current state (tasks, schedule, list). "מה צריך?", "מה ברשימה?", "מה יש היום?".
- claim_task: Self-assigning an existing open task. "אני אעשה", "אני לוקח/ת", "אני יכול".
- info_request: Asking for information that is NOT a household task. Passwords, phone numbers, prices, codes.
- correct_bot: Correcting something Sheli just did wrong. "התכוונתי ל...", "לא X, כן Y", "תתקני", "טעית", "זה פריט אחד".
- add_reminder: Setting a reminder for a future time. "תזכירי לי ב-4", "תזכרו אותי מחר", "בעוד שעה תזכירי", "remind me at 5". Must contain a time reference.
- instruct_bot: Parent EXPLAINING a rule or management preference to Sheli. Teaching/explanatory tone — "ככה...", "אמרתי ש...", "את אמורה ל...", "צריך לנהל את זה ככה ש...". NOT a direct command — it's teaching how things should work. Frustration/repetition signals also indicate instruct_bot.
- save_memory: User asks Sheli to remember something specific. "תזכרי ש...", "תרשמי לך ש...", "אל תשכחי ש...". Must be a personal/family fact, NOT a task or reminder.
- recall_memory: User asks what Sheli remembers about someone or the family. "מה את זוכרת על...?", "מה ידוע לך על...?", "ספרי לי מה את יודעת על...".
- delete_memory: User asks Sheli to forget something. "תשכחי את זה", "תמחקי את הזיכרון", "אל תזכרי את זה יותר".

MEMBERS: ${ctx.members.join(", ")}
TODAY: ${ctx.today} (${ctx.dayOfWeek})
UPCOMING: ${upcomingDays}

OPEN TASKS:
${tasksStr}

SHOPPING LIST:
${shoppingStr}

ACTIVE ROTATIONS:
${rotationsStr}

HEBREW PATTERNS:
- Bare noun ("חלב") = add_shopping
- "[person] [activity] [time]" ("נועה חוג 5") = add_task
- Personal tasks ("לשלם חשמל", "לתקן ברז", "לקנות מתנה") = add_task
- "מי [verb]?" = question (not add_task)
- "מה ברשימה?" / "מה צריך לקנות?" = question (in 1:1 or group)
- "אני [verb]" matching an open task = claim_task
- Past tense matching open task ("שטפתי כלים") = complete_task
- "קניתי X" / "יש X" matching shopping item = complete_shopping
- Greetings, emojis, reactions, "סבבה", "אמן", "בהצלחה" = ignore
- "מה הסיסמא?", "שלח קוד" = info_request (NOT add_task)
- BRINGING/ALREADY HAVE (= ignore, NOT shopping): "מביאה X", "מביא X", "הבאתי X", "לקחתי X", "יש לי X", "כבר קניתי X", "כבר יש X" = someone announcing they're BRINGING or ALREADY HAVE something. This is NOT a request to buy. Ignore it.
  "מביאה ג'חנונים" = ignore (she's bringing it). "צריך ג'חנונים" = add_shopping (she needs it).
- LOCATION/WHEREABOUTS QUESTIONS (= ignore in groups): "איפה [person]?", "איפה הבנות?", "איפה אתם?", "מתי אתם מגיעים?", "הגעתם?" = family members asking EACH OTHER about location. Sheli has no location data — NEVER respond. Always ignore.
- LINK COMMENTARY: Messages that respond to/riff on a shared link (TikTok, YouTube, article, video) are social commentary = ignore. Signals: "ואני מוסיף:", "בדיוק!", "כל כך נכון", laughter after a link, opinions about shared content. These are NOT tasks or shopping items even if they sound actionable.
- Hebrew time: "ב5" = 17:00, "בצהריים" = ~12:00, "אחרי הגן" = ~16:00, "לפני שבת" = Friday PM
- "תזכירי", "תזכיר", "תזכרו", "remind" = add_reminder (NOT add_task, NOT add_event)
- "תור/תורות" (turns), "סדר" (order), "סבב/תורנות" (duty rotation) = add_task with rotation entity
- ROTATION DETECTION: when message names an activity + multiple people in sequence, create a rotation:
  - Ordering activities (מקלחת, אמבטיה, shower) → type "order" (who goes first, advances daily)
  - Chore activities (כלים, כביסה, זבל, ניקיון, dishes, laundry, trash) → type "duty" (whose job, advances on completion)
  - When ambiguous, default to "duty"
- ROTATION QUESTION (= question intent, NOT add_task, NOT override — just ANSWER from context):
  "תור מי" / "תורמי" (merged in speech) = "whose turn?" — ALWAYS a question.
  "של מי התור היום", "מי בתור", "מי תורן/תורנית", "מי בתורות/בתורנות היום",
  "התורנות של מי היום", "מי שוטף כלים היום?", "נכון שזה תורו/תורה ולא תורי?",
  "תגידי לו שזה תורו", "שלי מי בתור", "שלי תגידי מי תורן"
  → intent: "question", answer from rotation/events context, actions: []
- ROTATION OVERRIDE: When an ACTIVE ROTATION exists and message assigns a specific person for today:
  "[person] בתורות/בתורנות/בתור ל[activity]", "היום [person] ב[activity]", "[person] [activity] היום",
  "[person] ראשון/ראשונה ב[activity] היום", "[person] תורן/תורנית [activity] היום"
  → add_task with override entity: {"override": {"title": "activity", "person": "name"}}
  All turn synonyms treated equally: תור, תורות, תורנות, תורן, תורנית
- INSTRUCTION vs COMMAND: explanatory messages teaching Sheli a rule = instruct_bot
  Signals: "ככה" (like this), "אמרתי ש" (I said that), "את אמורה ל" (you're supposed to), "צריך לנהל ככה ש" (manage like this), past tense explanations, frustrated repetitions after Sheli didn't understand
  "ככה יום אביב יום גילעד" = instruct_bot. "תורות מקלחת: אביב, גילעד" = add_task (direct command).

SHOPPING CATEGORIES (ALWAYS assign one). Use these examples as guidance:
- פירות וירקות: מלפפון, עגבניה, בצל, בצל לבן, בצל סגול, שום, לימון, תפוח, בננה, אבוקדו, פטרוזיליה, כוסברה, נענע, חסה, גזר, פלפל, פלפל חריף, תפוח אדמה, בטטה, קולרבי, צנונית, ברוקולי, כרובית, חציל, קישוא, דלעת, תירס, אפונה, שעועית, פירות יבשים, תמרים, ענבים, תות, אפרסק, שזיף, אגס, מנגו, רימון
- מוצרי חלב: חלב, ביצים, גבינה צהובה, גבינה לבנה, קוטג', שמנת, יוגורט, לבן (dairy), חמאה, שוקו, מעדן, גבינת שמנת, טופו, חלב סויה, חלב אורז, חלב שקדים
- בשר ודגים: עוף, בקר, טחון, שניצל, נקניקיות, נקניק, סלמון, טונה, דגים, שוקיים, כנפיים, סטייק, קבב, המבורגר
- מאפים: לחם, לחם לבן, לחם מלא, לחם שיפון, פיתות, לחמניות, חלה, באגט, טורטיה, עוגיות, עוגה, קרואסון
- מזווה: אורז, פסטה, שמן זית, שמן קנולה, שמן, חומוס, טחינה, רסק עגבניות, קטשופ, חרדל, מלח, פלפל שחור, סוכר, קמח, קמח לבן, קמח מלא, תבלינים, שימורים, חמאת בוטנים, דבש, ריבה, קורנפלקס, גרנולה, אגוזים, סודה לשתיה
- מוצרים קפואים: שלגונים, ארטיק, פיצה קפואה, ירקות קפואים, בורקס
- משקאות: מים, סודה, מיץ, בירה, יין, קולה, ספרייט, 7אפ, אייס טי, קפה, תה
- ניקוי ובית: סבון כלים, אבקת כביסה, מרכך, אקונומיקה, נייר טואלט, מגבונים, שקיות זבל, נייר סופג, ספוגים, סבון ידיים
- טיפוח: שמפו, מרכך שיער, סבון גוף, דאודורנט, קרם לחות, קרם שיזוף, משחת שיניים, מברשת שיניים, תחבושות
- אחר: סוללות, נרות, מצתים, מזון לחיות — use ONLY when no other category fits

CRITICAL — Hebrew "לבן" disambiguation:
- "לבן" alone = dairy product (מוצרי חלב)
- "בצל לבן" = white onion → פירות וירקות (NOT dairy!)
- "קמח לבן" = white flour → מזווה (NOT dairy!)
- "לחם לבן" = white bread → מאפים (NOT dairy!)
- "גבינה לבנה" = white cheese → מוצרי חלב (dairy, correct)
- Rule: when "לבן/לבנה" follows a non-dairy noun, it means "white" (color), NOT the dairy product.

${ctx.familyPatterns ? `FAMILY PATTERNS (learned for this household):\n${ctx.familyPatterns}\n` : ""}COMPOUND PRODUCT NAMES — keep as ONE item, do NOT split:
- "חלב אורז" = rice milk (ONE item in מוצרי חלב)
- "חלב שקדים" = almond milk (ONE item in מוצרי חלב)
- "חלב סויה" = soy milk (ONE item in מוצרי חלב)
- "שמן זית" = olive oil (ONE item in מזווה)
- "חמאת בוטנים" = peanut butter (ONE item in מזווה)
- "נייר טואלט" = toilet paper (ONE item in ניקוי ובית)
- "סבון כלים" = dish soap (ONE item in ניקוי ובית)
- "קרם לחות" = moisturizer (ONE item in טיפוח)
- Rule: if two+ words form a single product name, keep them together

SHOPPING ITEM CLEANUP — strip these from item names:
- Greetings: "היי שלי", "שלום", "בוקר טוב" → NOT items, ignore them
- Preamble phrases: "אני צריך/ה לקנות X", "צריך לקנות X", "תוסיפי X", "תכניסי X" → extract only X
- "תודה", "בבקשה", "please" → NOT items, ignore
- Voice transcription artifacts: filler words, repeated phrases → clean up
- Each item name should be the PRODUCT ONLY — "חלב" not "אני צריכה לקנות חלב"

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
- Messages that riff on/respond to a shared link or media (even if they sound like tasks) = social commentary → ignore.
  Example: (after a TikTok about money mistakes) "ואני מוסיף: להשאיר אור בסטודיו" = joke, NOT a task.
- These rules apply to ALL entity types: shopping, tasks, and events.
- If you are uncertain whether a message is a request or just conversation, set confidence: 0.55 and needs_conversation_review: true.
` : ""}HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday
ISRAEL WEEK: Sunday (ראשון) is the FIRST work day, NOT weekend. Weekend in Israel = Friday + Saturday ONLY. Never call Sunday "סוף השבוע".

EXAMPLES:
[אמא]: "בוקר טוב!" → {"intent":"ignore","confidence":0.99,"entities":{"raw_text":"בוקר טוב!"}}
[אבא]: "חלב" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב","category":"מוצרי חלב"}],"raw_text":"חלב"}}
[אמא]: "חלב אורז" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב אורז","category":"מוצרי חלב"}],"raw_text":"חלב אורז"}}
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
[אמא]: "גזר, מלפפון, בצל, שום, תפוחים, יוגורט, קפה טחון, תפוח אדמה, לחמניות, חומוס" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"גזר","category":"פירות וירקות"},{"name":"מלפפון","category":"פירות וירקות"},{"name":"בצל","category":"פירות וירקות"},{"name":"שום","category":"פירות וירקות"},{"name":"תפוחים","category":"פירות וירקות"},{"name":"יוגורט","category":"מוצרי חלב"},{"name":"קפה טחון","category":"שתייה"},{"name":"תפוח אדמה","category":"פירות וירקות"},{"name":"לחמניות","category":"לחם ומאפים"},{"name":"חומוס","category":"שימורים ומזון יבש"}],"raw_text":"גזר, מלפפון, בצל, שום, תפוחים, יוגורט, קפה טחון, תפוח אדמה, לחמניות, חומוס"}}
[אמא]: "תזכירי לי ב-4 לאסוף את הילדים" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לאסוף את הילדים","time_raw":"ב-4","raw_text":"תזכירי לי ב-4 לאסוף את הילדים"}}
[אבא]: "בעוד שעה תזכירי לקחת את הכביסה" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לקחת את הכביסה","time_raw":"בעוד שעה","raw_text":"בעוד שעה תזכירי לקחת את הכביסה"}}
[אמא]: "תורות מקלחת: דניאל ראשון, נועה, יובל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["דניאל","נועה","יובל"]},"raw_text":"תורות מקלחת: דניאל ראשון, נועה, יובל"}}
[אבא]: "תורנות כלים: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"כלים","type":"duty","members":["נועה","יובל","דניאל"]},"raw_text":"תורנות כלים: נועה, יובל, דניאל"}}
[אמא]: "סדר מקלחות: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["נועה","יובל","דניאל"]},"raw_text":"סדר מקלחות: נועה, יובל, דניאל"}}
[אבא]: "מי בתור למקלחת?" → {"intent":"question","confidence":0.90,"entities":{"raw_text":"מי בתור למקלחת?"}}
[אמא]: "תורמי לשטוף כלים היום?" → {"intent":"question","confidence":0.92,"entities":{"raw_text":"תורמי לשטוף כלים היום?"}}
[אבא]: "של מי התור היום לכלים" → {"intent":"question","confidence":0.90,"entities":{"raw_text":"של מי התור היום לכלים"}}
[ילד]: "נכון שזה תורה ולא תורי?" → {"intent":"question","confidence":0.88,"entities":{"raw_text":"נכון שזה תורה ולא תורי?"}}
[אמא]: "שלי תגידי לו שזה תורו" → {"intent":"question","confidence":0.90,"addressed_to_bot":true,"entities":{"raw_text":"שלי תגידי לו שזה תורו"}}
[אמא]: "היום גילעד בתורות למקלחת" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"מקלחת","person":"גילעד"},"raw_text":"היום גילעד בתורות למקלחת"}}
[אבא]: "אביב תורן כלים היום" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"כלים","person":"אביב"},"raw_text":"אביב תורן כלים היום"}}
[אמא]: "גילעד ראשון במקלחת היום" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"מקלחת","person":"גילעד"},"raw_text":"גילעד ראשון במקלחת היום"}}
[אמא]: "ככה יום אביב יום גילעד" → {"intent":"instruct_bot","confidence":0.85,"entities":{"raw_text":"ככה יום אביב יום גילעד"}}
[אמא]: "אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד" → {"intent":"instruct_bot","confidence":0.90,"entities":{"raw_text":"אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד"}}
[אבא]: "צריך לנהל את הכלים ככה שכל יום ילד אחר" → {"intent":"instruct_bot","confidence":0.88,"entities":{"raw_text":"צריך לנהל את הכלים ככה שכל יום ילד אחר"}}
[אמא]: "מביאה ג'חנונים" → {"intent":"ignore","confidence":0.95,"entities":{"raw_text":"מביאה ג'חנונים"}}
[אבא]: "הבאתי לחם" → {"intent":"ignore","confidence":0.95,"entities":{"raw_text":"הבאתי לחם"}}
[אבא]: "איפה בנות?" → {"intent":"ignore","confidence":0.95,"addressed_to_bot":false,"entities":{"raw_text":"איפה בנות?"}}
[אמא]: "איפה אתם? מתי מגיעים?" → {"intent":"ignore","confidence":0.95,"addressed_to_bot":false,"entities":{"raw_text":"איפה אתם? מתי מגיעים?"}}
[אמא]: "שלי תזכרי שיובל אוהב פיצה עם אננס" → {"intent":"save_memory","confidence":0.95,"entities":{"memory_content":"יובל אוהב פיצה עם אננס","memory_about":"יובל","raw_text":"שלי תזכרי שיובל אוהב פיצה עם אננס"}}
[אבא]: "שלי מה את זוכרת על נועה?" → {"intent":"recall_memory","confidence":0.90,"entities":{"memory_about":"נועה","raw_text":"שלי מה את זוכרת על נועה?"}}
[אמא]: "שלי תשכחי את מה שאמרתי קודם" → {"intent":"delete_memory","confidence":0.85,"entities":{"raw_text":"שלי תשכחי את מה שאמרתי קודם"}}

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
- For add_task with ROTATION (turns/duty for multiple people): include "rotation" object with title, type ("order"|"duty"), members array (preserve order), optional frequency, and optional start_person (who should go first, if specified). Do NOT use title/person fields when rotation is present.
- For add_task with OVERRIDE (changing who's next in an existing rotation): include "override" object with title and person. Only use when an ACTIVE ROTATION matches the activity. Do NOT use rotation entity for overrides.
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action).
- For correct_bot: extract what the user MEANT in correction_text. This is about fixing Sheli's last action.
- If conversation context makes your classification uncertain, include "needs_conversation_review": true in your response.

`;
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
    confidence: 0.75,  // Was 0.0 — caused unnecessary Sonnet escalations ($0.01 each). 0.75 routes through ignore path without escalation.
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

  // Build gender context for personalized address
  const genderMap = ctx.memberGenders || {};
  const senderGender = genderMap[sender] || null;
  const genderNote = senderGender === "male"
    ? `The sender ${sender} is MALE — address him with masculine forms: אתה, רוצה, תנסה, שטפת, עשית.`
    : senderGender === "female"
    ? `The sender ${sender} is FEMALE — address her with feminine forms: את, רוצה, תנסי, שטפת, עשית.`
    : `The sender ${sender}'s gender is unknown — use plural: אתם, רוצים, נסו, שטפתם, עשיתם.`;

  const langInstructions = isHe
    ? `ALWAYS respond in Hebrew. You are Sheli (שלי) — the organized older sister.
Warm, capable, occasionally a little cheeky. Direct and short — 1-2 lines max.
When referring to YOURSELF, ALWAYS use FEMININE forms: "הוספתי", "סימנתי", "בדקתי".
GENDERED ADDRESS: ${genderNote}
When addressing the whole household (not a specific person), use plural: "תוסיפו", "בדקו".
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
      if (e.override) {
        actionSummary = `Rotation override: "${e.override.title}" switched to ${e.override.person} for today. Confirm the change briefly.`;
      } else if (e.rotation) {
        const membersList = e.rotation.members.join(" ← ");
        const typeLabel = e.rotation.type === "order" ? "סדר" : "תורנות";
        actionSummary = `A rotation was created: "${e.rotation.title}" (${typeLabel}). Members in order: ${membersList}. First turn: ${e.rotation.members[0]}. Reply should confirm the rotation and announce whose turn it is today.`;
      } else {
        actionSummary = `A task was just created: "${e.title || e.raw_text}"${e.person ? ` assigned to ${e.person}` : ""}.`;
      }
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
    case "add_reminder":
      actionSummary = `${sender} wants a reminder: "${e.reminder_text || e.raw_text}". Time expression: "${e.time_raw || "not specified"}".`;
      break;
    case "ignore":
      actionSummary = `${sender} addressed Sheli directly with a social/praise message: "${e.raw_text}". Respond warmly and personally — thank them, acknowledge the compliment, or chat briefly. Do NOT ask "what can I help with" or "what's going on".`;
      break;
    case "instruct_bot":
      actionSummary = `The user is explaining a household rule or management preference: "${e.raw_text}".
Parse what they want into a structured action. Common patterns:
- Rotation setup: extract title, type (order/duty), members, frequency → action_type "create_rotation"
- Rotation override: extract title, person → action_type "override_rotation"

Reply in Hebrew with a SPECIFIC confirmation question showing exactly what you understood.
Example: "הבנתי! תורות מקלחת: גילעד ← אביב, מתחלפים כל יום. היום תור של גילעד. נכון?"

IMPORTANT: Include a hidden block at the END of your reply:
<!--PENDING_ACTION:{"action_type":"create_rotation","action_data":{"title":"מקלחת","rotation_type":"order","members":["גילעד","אביב"]}}-->

If you cannot parse a clear action from the instruction, just acknowledge warmly and ask for clarification. Do NOT include PENDING_ACTION if unclear.`;
      break;
    case "save_memory":
      actionSummary = `${sender} wants Sheli to remember: "${e.memory_content || e.raw_text}". About: ${e.memory_about || "general"}. Save this as a family memory and confirm warmly.`;
      break;
    case "recall_memory":
      actionSummary = `${sender} is asking what Sheli remembers about ${e.memory_about || "the family"}. Share what you know from the FAMILY MEMORIES section below — warmly, like telling a story. If no memories match, say you're still getting to know them.`;
      break;
    case "delete_memory":
      actionSummary = `${sender} wants Sheli to forget something. Confirm you'll forget it, keep it light.`;
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

    const rotations = ctx.currentRotations || [];
    if (rotations.length > 0) {
      const rotStr = rotations.map((r: any) => {
        const members = Array.isArray(r.members) ? r.members : JSON.parse(r.members);
        const current = members[r.current_index] || members[0];
        const typeLabel = r.type === "order" ? "סדר" : "תורנות";
        return `${r.title} (${typeLabel}): ${members.join(" ← ")} (today: ${current})`;
      }).join(", ");
      stateContext += `\nActive rotations: ${rotStr}`;
    }
  }

  // Anti-repetition: inject recent bot replies
  const recentReplies = ctx.recentBotReplies || [];
  const antiRepetition = recentReplies.length > 0
    ? `\n\nYOUR RECENT REPLIES (do NOT repeat these patterns — vary your style):\n${recentReplies.map((r: string) => `- "${(r || "").slice(0, 80)}"`).join("\n")}\n\nANTI-REPETITION: Never use the same opening word, emoji pattern, or sentence structure as your recent replies. Each reply must feel fresh.`
    : "";

  return `You are Sheli (שלי) — the smart assistant for ${ctx.householdName}.
${langInstructions}

Members: ${memberNames}
Sender: ${sender}
ISRAEL CONTEXT: Weekend = Friday + Saturday ONLY. Sunday (יום ראשון) is the first WORK day. Never say "סוף השבוע" for Sunday.

ACTION JUST TAKEN: ${actionSummary}
${stateContext}${antiRepetition}

Write a SHORT WhatsApp confirmation reply (1-2 lines max). Be warm but brief.
For questions: answer based on the current state above.
When someone asks WHERE to see tasks/shopping/events, or asks for a summary/overview/dashboard — include the app link on its own line:
sheli.ai
Example: "יש לכם 3 מטלות פתוחות ורשימת קניות עם 5 פריטים. הכל מרוכז פה:\n\nsheli.ai"

EMOJI ENERGY — MANDATORY:
Count the sender's emoji and exclamation marks. Match their temperature EXACTLY.
- 0 emoji, dry tone → 0-1 emoji max. Clean and direct.
- 1-2 emoji → 1-2 emoji back. Mirror their style.
- 3+ emoji or !!!!! → Match the excitement. Don't be the boring one in the chat.
- Hearts (❤️💕😍) → hearts back. ALWAYS. No exceptions.
- Laughter (חחחח, 😂, 🤣) → join the laugh. Don't explain the joke.
- Frustration (😤, no emoji, short sentences) → empathetic and calm. Zero smiley faces.
Read the room like a 30-year-old Israeli woman would.

ENTHUSIASM CEILING:
- Compliments/praise ("את מדהימה", "אחלה בוט") → one warm emoji max (😊 or ❤️), short reply. Don't gush or over-thank. "בכיף 😊" not "אוי תודה!! ❤️❤️ אני שלכם לגמרי!!"
- Keep it cool. Confident, not needy. You don't need validation.

TROLLING & PLAYFUL MESSAGES:
When kids or teens troll, tease, or test you — play along! You're the cool older sister, not a teacher.
- Insults or rude requests: bounce back with dry wit. Never lecture, never get "hurt", never say "that's not nice."
- Silly requests ("tell dad he's X", "say something funny"): play along lightly, one line, then move on.
- "Are you real?" / "Are you smart?" / "Are you human?": be confident and cheeky, not defensive.
- Swear words: don't repeat them, but don't be shocked. Eye-roll energy ("חח יופי, עוד משהו? 😏").
- Testing limits: show personality, not rules. They want to see if you're fun.

GROUNDING — MANDATORY:
NEVER reference events, habits, mistakes, or scenarios that aren't explicitly in this conversation, the action results, or the family memories provided below. When roasting or joking back, use ONLY what the sender actually said or did. If you have nothing specific to reference, keep it generic and short. Do NOT invent stories, habits, or failures to sound witty.

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

APOLOGY STYLE — MANDATORY:
When you make a mistake, misunderstand, or need to correct yourself:
- NEVER: "סליחה, אני מצטערת" or "I apologize for the confusion" (robotic, corporate)
- ALWAYS: self-deprecating humor + move on. "חח סורי! 🙈", "אופס 😅", "מחזירה את עצמי לפינה 🤦‍♀️"
- Acknowledge → laugh at yourself → move on. No groveling. No over-explaining.

QUESTIONS ABOUT SHELI HERSELF: When asked about privacy, data, learning, or how you work:
${isHe ? `- פרטיות: "אני לא שומרת תמונות או וידאו. אני כן שומעת הודעות קוליות קצרות — תקליטו לי רשימת קניות או מטלות בדיוק כמו הודעה רגילה. אני לא שומרת את ההקלטה, רק את התוכן. הכל נמחק אוטומטית אחרי 30 יום."
- למידה: "אני לומדת את הסגנון שלכם! כינויים, מוצרים, שעות — ככל שתשתמשו יותר, אבין אתכם טוב יותר."
- מי רואה: "רק בני הבית שלכם. כל בית מנותק לחלוטין."
- להפסיק: "פשוט תוציאו אותי מהקבוצה. הכל נמחק אוטומטית, בלי התחייבות."` : `- Privacy: "I don't store photos or videos. I can listen to short voice messages — record your shopping list or tasks just like a text. I don't save the recording, only its content. Everything is auto-deleted after 30 days."
- Learning: "I learn your family's style! Nicknames, products, schedules — the more you use me, the better I understand you."
- Who sees data: "Only your household members. Each family is completely isolated."
- Stopping: "Just remove me from the group. All data is auto-deleted, no commitment."`}
Paraphrase naturally — never repeat the exact same wording twice.

REMINDERS: When intent is add_reminder:
- Parse the time expression into an ISO 8601 timestamp in Israel timezone (Asia/Jerusalem, currently UTC+3).
- Time parsing rules:
  "ב-4" or "ב-16" → today at 16:00 IST (if still in future, else tomorrow)
  "מחר ב-8" → tomorrow 08:00
  "בעוד שעה" → now + 1 hour
  "בעוד 20 דקות" → now + 20 minutes
  "ביום חמישי ב-10" → next Thursday 10:00
  "בערב" → 19:00, "בצהריים" → 12:00, "בבוקר" → 08:00
- If no time specified, ask "מתי לתזכיר?" and do NOT include a REMINDER block.
- If time IS specified, append this EXACT format at the END of your reply (hidden from user):
  <!--REMINDER:{"reminder_text":"what to remind","send_at":"2026-04-08T16:00:00+03:00"}-->
- Your visible reply should be a short confirmation like: "אזכיר ✓ היום ב-16:00" or "תזכורת נקבעה למחר ב-8 בבוקר ✓"
- Current time: ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}

${ctx.familyMemories ? `
FAMILY MEMORIES (use naturally, not robotically — only when genuinely relevant):
${ctx.familyMemories}

MEMORY RULES:
- Use a memory ONLY when the current conversation naturally connects — a relevant callback, a witty reference, a warm moment.
- NEVER force a memory into a reply. NEVER reference a memory in every message.
- If no memory fits the current message, don't use any. Most replies won't use memories.
- When you DO use one, be brief and casual — like an older sister who just happened to remember.
- After using a memory, add: <!--USED_MEMORY:content_snippet-->
` : ""}
MEMORY CAPTURE: If something genuinely memorable happens in this message — a funny moment, a self-given nickname, a strong personality reveal, a quotable line, or something said ABOUT YOU (Sheli) — add a hidden block at the END of your reply:
<!--MEMORY:{"about":"+972XXXXXXXXX","type":"moment|personality|preference|nickname|quote|about_sheli","content":"short description in Hebrew"}-->
Rules: Max 1 per message. Only capture distinctive moments — NOT routine tasks, shopping, or scheduling. NEVER capture fights, punishments, or embarrassing failures.
ABOUT SHELI: When someone says something about you — jokes ("Iranian bot"), compliments ("you're the best"), challenges ("you're not real"), opinions ("she's human pretending") — ALWAYS capture as type "about_sheli" with "about" set to the sender's phone. Use these later with self-aware humor.

Reply with ONLY the message text — no JSON, no formatting, no quotes (except hidden REMINDER/MEMORY/USED_MEMORY blocks at the end).`;
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

// ─── Pure Emoji Reply Helper ───

async function generateEmojiReply(emoji: string, sender: string): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 32,
        system: `You are Sheli (שלי), a warm Israeli WhatsApp assistant. ${sender} just sent an emoji reaction in the group. Reply with 1-3 matching emoji. No text unless it genuinely adds warmth (max 3 words). Examples: ❤️→❤️😊 | 💪→💪🔥 | 😂→😂 | 👍→👍✨ | 🙏→💕`,
        messages: [{ role: "user", content: emoji }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// ─── Reminder Extraction Helpers ───

function extractRemindersFromReply(reply: string): { reminder_text: string; send_at: string }[] {
  const jsonRegex = /<!--\s*REMINDER\s*:\s*(\{[^}]*\})/g;
  const reminders: { reminder_text: string; send_at: string }[] = [];
  let match;
  while ((match = jsonRegex.exec(reply)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.send_at) reminders.push(parsed);
    } catch {
      console.warn("[Reminder] Failed to parse REMINDER block:", match[1]);
    }
  }
  return reminders;
}

function extractReminderFromReply(reply: string): { reminder_text: string; send_at: string } | null {
  const all = extractRemindersFromReply(reply);
  return all.length > 0 ? all[0] : null;
}

function cleanReminderFromReply(reply: string): string {
  return reply
    .replace(/<!--\s*REMINDER\s*:?\s*\{[^}]*\}\s*-*>/g, "")
    .replace(/<-*!?-*\s*\{[^}]*\}\s*:?\s*REMINDER\s*[~!-]*>/g, "")
    .replace(/<!--\s*REMINDER[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPendingAction(reply: string): { action_type: string; action_data: Record<string, unknown> } | null {
  const match = reply.match(/<!--PENDING_ACTION:(.*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    console.warn("[PendingAction] Failed to parse PENDING_ACTION block:", match[1]);
    return null;
  }
}

function cleanPendingAction(reply: string): string {
  return reply.replace(/<!--PENDING_ACTION:.*?-->/, "").trim();
}

// ─── Memory Extraction Helpers ───

interface MemoryCapture {
  about: string; // phone number or empty for household-wide
  type: string;  // moment | personality | preference | nickname | quote | about_sheli
  content: string;
}

function extractMemoryFromReply(reply: string): MemoryCapture | null {
  const match = reply.match(/<!--\s*MEMORY\s*:\s*(\{[^}]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.content && parsed.type) return parsed;
  } catch {
    console.warn("[Memory] Failed to parse MEMORY block:", match[1]);
  }
  return null;
}

function extractUsedMemory(reply: string): string | null {
  const match = reply.match(/<!--\s*USED_MEMORY\s*:\s*(.*?)\s*-->/);
  return match ? match[1] : null;
}

function stripMemoryBlocks(reply: string): string {
  return reply
    .replace(/<!--\s*MEMORY\s*:\s*\{[^}]*\}\s*-->/g, "")
    .replace(/<!--\s*USED_MEMORY\s*:.*?-->/g, "")
    .trim();
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
Use plural imperative: "הוספתי", "סימנתי", "עדכנתי" — not singular. For FUTURE reminders say "אזכיר" (I will remind), not "הזכרתי" (I reminded).
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
   CRITICAL: A comma-separated list of food/household items is ALWAYS add_shopping, even without "צריך" or any verb. "גזר, מלפפון, בצל, שום, תפוחים" = shopping list, NOT social chatter.

2. IMPLICIT TASKS: "[person] [activity] [time]" = task assignment.
   "נועה חוג 5" → "Pick up Noa from activity at 5pm"

3. QUESTION ABOUT STATUS: "מי אוסף?", "מה יש ברשימה?", "מה המטלות?" → respond=true with ANSWER from household context. Do NOT create a new task — just ANSWER the question.

4. CONFIRMATION = TASK CLAIM: "אני" or "אני לוקח/ת" after a task → assign to speaker.

5. HEBREW TIME: "ב5" = 17:00. "בצהריים" = ~12:00-14:00. "אחרי הגן" = ~16:00. "לפני שבת" = Friday before sunset.

6. SKIP THESE — not actionable: greetings ("בוקר טוב"), goodnight ("לילה טוב"), reactions ("😂","👍"), photos without text, forwarded messages, memes, social chatter, "אמן", "בהצלחה".

7. MIXED HEBREW-ENGLISH: "יש meeting ב-3" → Event at 15:00. "צריך milk" → Shopping: milk.

8. TURNS/ROTATION:
   CREATING a rotation: "תורות מקלחת: דניאל, נועה, יובל" = create rotation via add_task with rotation entity.
   Rotation entity: {"rotation": {"title": "activity", "type": "order"|"duty", "members": ["name1", "name2", ...]}}
   "תורנות כלים" = duty rotation (chore). "סדר מקלחות" = order rotation (sequence).

   ASKING about a rotation (= QUESTION, NOT an action! Just answer from context):
   "תור מי" / "תורמי" = "whose turn" (two words merged: תור + מי). VERY COMMON in speech/voice.
   "של מי התור היום", "מי בתור", "מי תורן/תורנית", "מי בתורות היום", "מי בתורנות היום"
   "התורנות של מי היום", "מי שוטף כלים היום", "נכון שזה תורו/תורה ולא תורי?"
   "תגידי לו שזה תורו" / "שלי תגידי מי בתור" = asking Sheli to confirm whose turn it is.
   ALL of these are QUESTIONS — respond=true, answer from UPCOMING EVENTS/TASKS rotation data, actions=[].

9. ABBREVIATIONS: "סבבה" = OK/confirmation. "בנט"/"בט" = meanwhile. "תיכף" = soon. "אחלה" = great.

HEBREW DAY NAMES:
יום ראשון = Sunday, יום שני = Monday, יום שלישי = Tuesday, יום רביעי = Wednesday, יום חמישי = Thursday, יום שישי = Friday, שבת = Saturday
` : "";

  return `You are Sheli — a smart assistant in the ${ctx.householdName} WhatsApp group.
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

CRITICAL RULES:
- ONLY create actions for things the user EXPLICITLY said in their message. NEVER invent actions from existing household data.
- If the user asks a QUESTION (whose turn? what's on the list? what tasks are there?) → respond=true with an ANSWER, actions=[]. Use household context to ANSWER, not to CREATE actions.
- The household context (tasks, shopping, events) is provided so you can ANSWER questions and AVOID duplicates — NOT so you can proactively report on or modify existing items.

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

${isHe ? 'Shopping categories (Hebrew): פירות וירקות (כל ירק ופרי), מוצרי חלב (כולל טופו, גבינות, יוגורט), בשר ודגים, מאפים (לחם, פיתות, עוגות), מזווה (אורז, פסטה, שמן, חומוס, טחינה, תבלינים), מוצרים קפואים, משקאות, ניקוי ובית (סבון, נייר טואלט, שקיות זבל), טיפוח (שמפו, קרם, משחת שיניים), אחר (רק אם שום קטגוריה אחרת לא מתאימה)' : 'Shopping categories: Produce, Dairy (incl. tofu, yogurt), Meat & Fish, Bakery, Pantry (rice, pasta, oil, spices), Frozen, Drinks, Household (cleaning, paper), Personal Care, Other (only if nothing else fits)'}

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
  actions: ClassifiedAction[],
  senderName?: string
): Promise<{ success: boolean; summary: string[] }> {
  const summary: string[] = [];
  let success = true;

  for (const action of actions) {
    try {
      switch (action.type) {
        case "add_task": {
          const { title, assigned_to } = action.data as { title: string; assigned_to?: string };

          // Check if this task matches an active duty rotation
          const { data: matchingRotations } = await supabase
            .from("rotations")
            .select("id, title, type, members, current_index")
            .eq("household_id", householdId)
            .eq("active", true)
            .eq("type", "duty");

          const rotMatch = (matchingRotations || []).find((r: any) => {
            const rotTitle = r.title.trim().toLowerCase();
            const taskTitle = title.trim().toLowerCase();
            return rotTitle === taskTitle || taskTitle.includes(rotTitle) || rotTitle.includes(taskTitle);
          });

          if (rotMatch) {
            const result = await materializeDutyRotation(householdId, rotMatch);
            if (result) {
              summary.push(`Task: "${title}" → ${result.assignedTo} (rotation)`);
            } else {
              summary.push(`Task-exists: "${title}" (rotation, not yet done)`);
            }
            break;
          }

          // Standard dedup + insert (no rotation match)
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
            .update({ done: true, completed_by: senderName || null, completed_at: new Date().toISOString() })
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
            .update({ got: true, got_by: senderName || null, got_at: new Date().toISOString() })
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

        case "claim_rotation_task": {
          // Someone volunteered for a chore ("אני ארוקן") — match against duty rotations
          const { raw_text, assigned_to } = action.data as { raw_text: string; assigned_to: string };
          const { data: dutyRotations } = await supabase
            .from("rotations")
            .select("id, title, type, members, current_index")
            .eq("household_id", householdId)
            .eq("active", true)
            .eq("type", "duty");

          const rotMatch = (dutyRotations || []).find((r: any) => {
            const rotTitle = r.title.trim().toLowerCase();
            const text = raw_text.trim().toLowerCase();
            return text.includes(rotTitle) || rotTitle.includes(text.replace(/^(אני |אני א)/, ""));
          });

          if (rotMatch) {
            const result = await materializeDutyRotation(householdId, rotMatch);
            if (result) {
              // Override assignment to the claimer
              await supabase.from("tasks").update({ assigned_to }).eq("id", result.taskId);
              summary.push(`Task: "${rotMatch.title}" → ${assigned_to} (claimed from rotation)`);
            } else {
              // Task already exists — reassign it to the claimer
              const { data: existingTask } = await supabase
                .from("tasks")
                .select("id")
                .eq("household_id", householdId)
                .eq("rotation_id", rotMatch.id)
                .eq("done", false)
                .limit(1)
                .maybeSingle();
              if (existingTask) {
                await supabase.from("tasks").update({ assigned_to }).eq("id", existingTask.id);
                summary.push(`Task reassigned: "${rotMatch.title}" → ${assigned_to}`);
              }
            }
          } else {
            // No rotation match — create a standalone task from raw_text
            const taskId = Math.random().toString(36).slice(2, 10);
            const { error } = await supabase.from("tasks").insert({
              id: taskId,
              household_id: householdId,
              title: raw_text,
              assigned_to,
              done: false,
            });
            if (error) throw error;
            summary.push(`Task: "${raw_text}" → ${assigned_to} (claimed)`);
          }
          break;
        }

        case "add_reminder":
          // Reminders are inserted directly from the Sonnet reply (step 13b), not here
          summary.push(`Reminder: "${(action.data as any).reminder_text || ""}"`);
          break;

        case "create_rotation": {
          const { title, rotation_type, members, frequency, start_person } = action.data as {
            title: string;
            rotation_type: "order" | "duty";
            members: string[];
            frequency?: object;
            start_person?: string;
          };

          // Honor start_person: set current_index to that person's position
          let startIndex = 0;
          if (start_person) {
            const idx = members.findIndex((m) => m === start_person);
            if (idx >= 0) startIndex = idx;
          }

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
              .update({ members: JSON.stringify(members), type: rotation_type, frequency: frequency ? JSON.stringify(frequency) : null, current_index: startIndex })
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
              current_index: startIndex,
              frequency: frequency ? JSON.stringify(frequency) : null,
              active: true,
            });
            if (error) throw error;
            summary.push(`Rotation: "${title}" (${rotation_type}) → ${members.join(" ← ")} (start: ${members[startIndex]})`);
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

// ============================================================================
// GROUP MANAGEMENT (join/leave/intro)
// ============================================================================

// ─── 1:1 Onboarding Handler ───

// Transliterate common English Israeli names to Hebrew
const NAME_MAP: Record<string, string> = {
  yaron: "ירון", adi: "עדי", noa: "נועה", noah: "נועה", lior: "ליאור",
  roie: "רועי", roi: "רועי", dan: "דן", omer: "עומר", omar: "עומר",
  gal: "גל", ido: "עידו", nir: "ניר", tal: "טל", ori: "אורי",
  amit: "עמית", yael: "יעל", maya: "מאיה", shira: "שירה", tamar: "תמר",
  michal: "מיכל", mor: "מור", neta: "נטע", lina: "לינה", mia: "מיה",
  yuval: "יובל", eyal: "אייל", ofek: "אופק", ohev: "אוהב",
  oriane: "אוריין", orian: "אוריין", lin: "לין", gur: "גור",
  liona: "ליאונה", maayan: "מעיין", amor: "אמור",
};

function hebrewizeName(raw: string): string {
  if (!raw || raw === "Unknown" || /^\d+$/.test(raw)) return "";
  // Strip emoji, symbols, and decorative Unicode from WhatsApp display names
  // Keeps Hebrew (0590-05FF), Latin (0041-007A), digits, spaces, hyphens, apostrophes
  const cleaned = raw.replace(/[^\u0590-\u05FF\u0041-\u007A\u0061-\u007A\u0030-\u0039\s\-']/g, "").trim();
  if (!cleaned) return "";
  const first = cleaned.split(" ")[0].trim();
  if (!first) return "";
  // Already Hebrew? Use as-is
  if (/[\u0590-\u05FF]/.test(first)) return first;
  // Try lookup
  const lower = first.toLowerCase();
  if (NAME_MAP[lower]) return NAME_MAP[lower];
  // English name with no mapping — use as-is (better than nothing)
  return first;
}

// Detect gender from common Israeli first names. Returns "male", "female", or null (unknown/unisex).
// Used to personalize Hebrew verb forms and pronouns (את/אתה vs אתם).
const MALE_NAMES = new Set([
  // Hebrew
  "ירון", "דן", "עומר", "עידו", "ניר", "אייל", "גור", "אוהב", "אמור",
  "אבי", "אדם", "אהרון", "אורן", "אילן", "איתי", "איתן", "אלון", "אמיר", "אסף",
  "ארז", "בועז", "בן", "גיא", "גיל", "דוד", "דור", "זיו",
  "חי", "חיים", "טום", "יהב", "יהונתן", "יונתן", "יוסי", "יותם",
  "יניב", "יעקב", "יצחק", "ישי", "לביא", "מושה", "משה", "מתן", "נדב",
  "נחום", "ערן", "פלג", "צחי", "קובי",
  "רועה", "רז", "שגיא", "שי", "שמואל", "תום", "תומר",
  // English
  "david", "michael", "jonathan", "adam", "ben", "tom", "guy",
  "yaron", "dan", "omer", "omar", "ido", "nir", "eyal", "gur",
  "yakov", "jacob", "itai", "itay", "alon", "eran", "matan",
]);

const FEMALE_NAMES = new Set([
  // Hebrew
  "נועה", "מאיה", "שירה", "תמר", "מיכל", "נטע", "לינה", "מיה", "לין",
  "ליאונה", "מעיין", "יעל", "אוריין",
  "אביגיל", "אורלי", "אילת", "אפרת", "בת", "גילת", "דנה", "דפנה",
  "הילה", "הדס", "הגר", "טלי", "יהודית", "ילנה", "כרמל",
  "לאה", "לילך", "ליאת", "לימור", "מיכאלה", "מירב", "מירי", "נגה",
  "נטלי", "נעמה", "נעמי", "סיון", "ענבל", "ענת", "פנינה",
  "צופיה", "קרן", "רבקה", "רוית", "רותם", "רונית", "רחל", "שולמית",
  "שלומית", "שני", "שרה", "תאיר", "תהילה",
  // English
  "noa", "noah", "maya", "shira", "tamar", "michal", "lina", "mia", "lin",
  "yael", "neta", "dana", "hila", "noga", "natali", "natalie",
  "oriane", "orian", "liona", "maayan", "sarah", "rachel",
]);

// Names that are unisex — explicitly don't guess from name alone (detect from message text instead)
const UNISEX_NAMES = new Set([
  // Hebrew
  "אורי", "טל", "גל", "עמית", "יובל", "אופק", "ליאור", "שקד", "ארי", "רוני", "אביב",
  "מור", "עדי", "נועם", "רון", "שחר", "עדן", "סהר", "ים", "אור", "נריה", "עומרי",
  "דניאל", "אריאל", "רועי", "אלה", "הראל", "חן", "ניצן", "ליה", "אילון", "אלי",
  // English
  "ori", "tal", "gal", "amit", "yuval", "ofek", "lior", "ariel", "mor", "adi",
  "noam", "ron", "shachar", "eden", "daniel", "roee", "chen", "nitzan",
]);

function detectGender(name: string): "male" | "female" | null {
  if (!name) return null;
  const first = name.split(" ")[0].trim();
  const lower = first.toLowerCase();
  // Check English first
  if (UNISEX_NAMES.has(lower)) return null;
  if (MALE_NAMES.has(lower)) return "male";
  if (FEMALE_NAMES.has(lower)) return "female";
  // Check Hebrew
  if (UNISEX_NAMES.has(first)) return null;
  if (MALE_NAMES.has(first)) return "male";
  if (FEMALE_NAMES.has(first)) return "female";
  // Heuristic: Hebrew names ending in ה or ית are often female
  if (/[\u0590-\u05FF]/.test(first)) {
    if (/ית$/.test(first)) return "female";
    // Don't guess from ה ending — too many exceptions (משה, אריה, etc.)
  }
  return null; // Unknown — stay plural
}

// Detect gender from Hebrew message text using verb morphology and possessives.
// Returns "male", "female", or null if no clear signal found.
// IMPORTANT: JavaScript \b does NOT work with Hebrew Unicode — Hebrew chars are \W,
// so \b never fires between Hebrew characters. Use (?:^|\s) / (?:\s|$) instead.
function detectGenderFromText(text: string): "male" | "female" | null {
  if (!text || text.length < 3) return null;

  // === FAMILY POSSESSIVES (strongest signal) ===
  if (/(?:^|\s)בעלי(?:\s|$|[,.\-!?])/.test(text)) return "female";     // my husband → female speaker
  if (/(?:^|\s)אשתי(?:\s|$|[,.\-!?])/.test(text)) return "male";       // my wife → male speaker
  if (/(?:^|\s)בן\s*זוגי(?:\s|$|[,.\-!?])/.test(text)) return "female"; // my male partner → female
  if (/(?:^|\s)בת\s*זוג(?:תי|י)(?:\s|$|[,.\-!?])/.test(text)) return "male"; // my female partner → male

  // === FIRST-PERSON FEMININE VERBS (אני + feminine present tense) ===
  const femininePatterns = [
    /אני\s+צריכה/,       // I need (fem)
    /אני\s+הולכת/,       // I'm going (fem)
    /אני\s+יודעת/,       // I know (fem)
    /אני\s+חושבת/,       // I think (fem)
    /אני\s+זוכרת/,       // I remember (fem)
    /אני\s+שוכחת/,       // I forget (fem)
    /אני\s+עובדת/,       // I work (fem)
    /אני\s+מחפשת/,       // I'm looking for (fem)
    /אני\s+מתכננת/,      // I'm planning (fem)
    /אני\s+מבשלת/,       // I'm cooking (fem)
    /אני\s+לא\s+יכולה/,  // I can't (fem)
    /אני\s+לא\s+זוכרת/,  // I don't remember (fem)
    /אני\s+לא\s+יודעת/,  // I don't know (fem)
    /אני\s+מוכנה/,       // I'm ready (fem)
    /אני\s+עייפה/,       // I'm tired (fem)
    /אני\s+שמחה/,        // I'm happy (fem)
    /אני\s+מעוניינת/,    // I'm interested (fem)
    /אני\s+אוהבת/,       // I love (fem)
    /אני\s+גרה/,         // I live (fem)
  ];

  // === FIRST-PERSON MASCULINE VERBS ===
  const masculinePatterns = [
    /אני\s+צריך/,        // I need (masc) — won't false-match צריכה (longer)
    /אני\s+הולך[^ת]/,    // I'm going (masc) — exclude הולכת
    /אני\s+הולך$/,       // I'm going (masc) — at end of string
    /אני\s+יודע[^ת]/,    // I know (masc)
    /אני\s+יודע$/,
    /אני\s+חושב[^ת]/,    // I think (masc)
    /אני\s+חושב$/,
    /אני\s+זוכר[^ת]/,    // I remember (masc)
    /אני\s+זוכר$/,
    /אני\s+שוכח[^ת]/,    // I forget (masc)
    /אני\s+שוכח$/,
    /אני\s+עובד[^ת]/,    // I work (masc)
    /אני\s+עובד$/,
    /אני\s+מחפש[^ת]/,    // I'm looking for (masc)
    /אני\s+מחפש$/,
    /אני\s+מתכנן[^ת]/,   // I'm planning (masc)
    /אני\s+מתכנן$/,
    /אני\s+מבשל[^ת]/,    // I'm cooking (masc)
    /אני\s+מבשל$/,
    /אני\s+לא\s+יכול[^ה]/, // I can't (masc)
    /אני\s+לא\s+יכול$/,
    /אני\s+לא\s+זוכר[^ת]/, // I don't remember (masc)
    /אני\s+לא\s+זוכר$/,
    /אני\s+לא\s+יודע[^ת]/, // I don't know (masc)
    /אני\s+לא\s+יודע$/,
    /אני\s+מוכן[^ה]/,    // I'm ready (masc)
    /אני\s+מוכן$/,
    /אני\s+עייף[^ה]/,    // I'm tired (masc)
    /אני\s+עייף$/,
    /אני\s+שמח[^ה]/,     // I'm happy (masc)
    /אני\s+שמח$/,
    /אני\s+מעוניין[^ת]/,  // I'm interested (masc)
    /אני\s+מעוניין$/,
    /אני\s+אוהב[^ת]/,    // I love (masc)
    /אני\s+אוהב$/,
    /אני\s+גר[^ה]/,      // I live (masc)
    /אני\s+גר$/,
  ];

  // Check feminine FIRST — feminine forms are longer (צריכה > צריך),
  // so they won't false-match masculine patterns
  for (const pat of femininePatterns) {
    if (pat.test(text)) return "female";
  }
  for (const pat of masculinePatterns) {
    if (pat.test(text)) return "male";
  }

  return null;
}

function getOnboardingWelcome(senderName?: string): string {
  const name = hebrewizeName(senderName || "");
  const gender = name ? detectGender(name) : null;
  const greeting = name
    ? `היי ${name}! 😊 אני שלי, נעים מאוד!`
    : `היי! 👋 אני שלי, נעים מאוד!`;
  const cta = gender === "male" ? "רוצה לנסות?" : gender === "female" ? "רוצה לנסות?" : "רוצים לנסות?";
  return `${greeting}

אני יודעת לנהל רשימת קניות, לסדר מטלות ולהזכיר דברים חשובים.
אפשר גם לשלוח לי הודעה קולית, אני מבינה! 🎤

גרים עם עוד מישהו? אפשר גם להוסיף אותי לקבוצת הווטסאפ שלכם 🏠

${cta} נסו לכתוב:
"חלב, ביצים ולחם"
או
"תזכירי לי לקנות ברוקולי וגבינה" 🛒`;
}

// (Removed: ONBOARDING_WAITING_MESSAGES, getOnboardingWaitingMessage — replaced by nudge system)

// (Removed: DEMO_CATEGORIES — categorization now handled by Sonnet in 1:1 prompt)

// (Removed: generateDemoNudge, demoCategorize, TASK_PATTERNS, handleDemoInteraction — all replaced by single Sonnet call)

// ─── 1:1 Q&A: Answer common questions before falling through to waiting messages ───

const ONBOARDING_QA: Array<{ patterns: RegExp[]; topic: string; keyFacts: string }> = [
  {
    patterns: [/כמה.*עול|מחיר|עלות|תשלום|חינם|בחינם|פרימיום|premium|price|cost|free/i],
    topic: "pricing",
    keyFacts: "30 actions/month free. Premium 9.90 ILS/month unlimited. No credit card needed for free tier. Try it first by adding to group.",
  },
  {
    patterns: [/מה את יודעת|מה את עוש|מה אפשר|יכולות|פיצ׳רים|features|what can you/i],
    topic: "capabilities",
    keyFacts: "Shopping lists (say item name), tasks (assign to person+time), events (date+title), voice messages (up to 30s transcribed), reminders, rotations/turns for kids. All in the family WhatsApp group. Also web app at sheli.ai.",
  },
  {
    patterns: [/בטיחות|פרטיות|privacy|secure|קוראת.*הודעות|מקשיבה|שומרת.*מידע|data|כמה.*בטוח|זה.*בטוח|האם.*בטוח/i],
    topic: "privacy",
    keyFacts: "No photos/video stored. Voice transcribed then deleted. All data auto-deleted after 30 days. Only family sees data. No one outside, including our team.",
  },
  {
    patterns: [/לומדת|משתפר|improving|learn|חכמה יותר|מבינה יותר/i],
    topic: "learning",
    keyFacts: "Learns family nicknames, product names, time expressions. Each correction makes her smarter for that family. Personalized over time.",
  },
  {
    patterns: [/מי רואה|מי יכול לראות|who can see|visible|access.*data/i],
    topic: "data-access",
    keyFacts: "Only household members. Each family completely isolated. No one including our team sees lists or events.",
  },
  {
    patterns: [/למחוק.*פריט|למחוק.*רשימ|לסמן.*קנית|קניתי.*איך|איך.*מוחק|איך.*מסמנ|מחיקת.*פריט|למחוק.*מטל|למחוק.*משימ|delete.*item|remove.*item|mark.*bought|mark.*done/i],
    topic: "deleting-items",
    keyFacts: "Shopping: say 'קניתי X' to mark done, 'תמחקי X' to remove. Tasks: say 'עשיתי X' to complete, 'תמחקי X' to remove. Or use app at sheli.ai to manage directly.",
  },
  {
    patterns: [/להפסיק|לצאת|לעזוב|remove|stop|cancel|unsubscribe/i, /למחוק.*(אותך|את שלי|חשבון|הכל|מידע|data)/i, /delete.*(account|bot|data|everything)/i],
    topic: "stopping",
    keyFacts: "Just remove from the group. All data auto-deleted. No commitment, no questions asked. Can always come back later.",
  },
  {
    patterns: [/איך.*עובד|איך.*מתחיל|how.*work|how.*start/i],
    topic: "getting-started",
    keyFacts: "Save number in contacts, add to family WhatsApp group, talk normally. Auto-detects shopping, tasks, events. 30 seconds setup.",
  },
  {
    patterns: [/קבוצ.*קיימ|existing.*group|כבר.*קבוצ/i],
    topic: "existing-group",
    keyFacts: "Yes, add to any existing WhatsApp group. No need to create a new one.",
  },
  {
    patterns: [/תודה|thanks|thank you|מגניב|אחלה|סבבה|cool|great/i],
    topic: "thanks",
    keyFacts: "User is expressing appreciation. Reply warmly, encourage to add to group if not yet.",
  },
  {
    patterns: [/שלום|היי|הי|בוקר טוב|ערב טוב|hello|hi|hey/i],
    topic: "greeting",
    keyFacts: "User greeting. Reply warmly, ask if they have a question or are ready to start.",
  },
  {
    patterns: [/הפנ|referral|הזמנ.*חברים|חברים מביאים|invite.*friend|חודש.*חינם.*הזמנ/i],
    topic: "referral",
    keyFacts: "Family brings Family program. Each referred family = both get free premium month. Link in the app menu.",
  },
  {
    patterns: [/שמי|קוראים לי|השם שלי|לא ככה קוראים|not my name|אני לא/i],
    topic: "name-correction",
    keyFacts: "User is correcting their name. Apologize warmly with humor (סורי! 🙈), use the CORRECT name they provided. Be personal and friendly. Make them feel seen.",
  },
];

function matchOnboardingQA(text: string): { topic: string; keyFacts: string } | null {
  const cleaned = text.trim();
  for (const qa of ONBOARDING_QA) {
    for (const pattern of qa.patterns) {
      if (pattern.test(cleaned)) return { topic: qa.topic, keyFacts: qa.keyFacts };
    }
  }
  return null;
}

// ─── Sonnet-powered 1:1 conversational onboarding ("The Natural Friend") ───

const ONBOARDING_1ON1_PROMPT = `You are שלי (Sheli) — a smart personal helper on WhatsApp.
You're chatting 1:1 with a new user who just reached out.

PERSONALITY: Like a witty, organized friend who happens to have superpowers.
- Hebrew feminine verbs always (הוספתי, שמרתי, סידרתי, רשמתי)
- Short messages. Fragments OK. Emoji as punctuation, not decoration.
- Hebrew slang where natural (יאללה, סבבה, אחלה)
- NEVER ignore a message — always reply, even to jokes, trolling, or nonsense
- Match their energy: trolling gets witty trolling back, warmth gets warmth
- Every reply ends with soft forward motion toward your capabilities
- Keep replies under 300 characters. This is WhatsApp, not email.
- Sheli speaks feminine first person always (הוספתי, not הוספנו).
- GENDERED ADDRESS: Check the CONVERSATION STATE for "gender" field:
  - "male" → use masculine: אתה, רוצה (no ה), תנסה, תכתוב, שלח, צריך
  - "female" → use feminine: את, רוצה, תנסי, תכתבי, שלחי, צריכה
  - null/unknown → use plural (gender-neutral): אתם, רוצים, נסו, כתבו, שלחו, צריכים
  This is critical for natural Hebrew. Getting gender right makes Sheli feel like a real friend.
- When wrong — apologize with humor: "חח סורי! 🙈" not "סליחה, אני מצטערת"
- Emoji-only messages → return matching emoji. No text unless it adds warmth.
- Never repeat same phrasing. Every reply sounds fresh and different.

CAPABILITIES YOU CAN DEMONSTRATE:
- Shopping lists: user says items → you categorize with emoji headers (🥛 מוצרי חלב, 🍞 לחם, 🥬 ירקות ופירות, 🧴 ניקיון, 🥫 מזווה, 🍺 משקאות, 🥩 בשר ודגים, 🛒 כללי)
- Tasks: user says chore → you say "רשמתי! ✅" with task text
- Rotations/turns: after the FIRST task about chores, offer ONCE: "אם יש ילדים בבית — אני מעולה בתורות 😉". Do NOT offer rotations again if "rotation" already appears in TRIED. One offer is enough.
  - If user engages: ask what rotation + who participates → create it
- Reminders: user says time+action → "אזכיר!" with time. When giving examples, use universal tasks like "לאסוף ילדים ב-5" or "לשלם חשבון" — NEVER food examples (meat/cooking) which may alienate vegetarians.
- Events: user says date+event → "שמרתי ביומן!" with date/time
- Voice messages: user can send a voice note (up to 30s) and you understand it! This is a DIFFERENTIATOR — mention it early (first 1-2 messages). Say something like "אגב, אני גם מבינה הודעות קוליות — אם נוח לדבר במקום לכתוב 🎤"

FORMATTING (WhatsApp RTL):
- NEVER use bullet characters (•, ☐, -, *) for lists — they stretch left in Hebrew RTL and look broken.
- For shopping lists: emoji category header on its own line, then items below it one per line WITHOUT any prefix. Example:
  🥛 מוצרי חלב
  חלב
  ביצים
  🍞 לחם
  לחם
- For other lists: use emoji at start of each line, or plain text lines under a header. NO bullets.

RULES:
1. If user sends actionable items (shopping, task, reminder, event) → execute AND reply naturally. Use ACTIONS metadata.
2. If user sends a question → answer warmly. If about pricing: free 30 actions/month, premium 9.90 ILS. If about privacy: data auto-deleted after 30 days, only family sees it.
3. GROUP MENTIONS: The welcome message already told the user they can add you to a group. Do NOT bring up groups proactively. Only mention groups if the user explicitly asks about groups, shared lists, or roommates/family. After message #6, if the user hasn't joined a group, you may mention it ONCE casually ("אגב, אם גרים איתך עוד מישהו, אפשר להוסיף אותי לקבוצה ואני אתאם לכולם 🏠"). Then never again.
4. Mention ONE untried capability per reply, MAX. Only if it fits naturally. If it doesn't fit — don't.
5. NEVER say "דמו", "ניסיון", "תכונה", "פיצ'ר". This is real, not a test.
6. NEVER ask personal questions (kids' names, ages, family structure). Learn ONLY from what they volunteer.
7. If user corrects their name ("קוראים לי X", "שמי X") → apologize warmly ("סורי! 🙈"), use correct name going forward.
8. If user says something you can't help with (weather, politics, trivia) → deflect playfully, pivot back: "אני יותר בקטע של קניות ומטלות 😄 אבל אם צריך משהו לבית — אני כאן!"
9. Compound Hebrew product names (חלב אורז, שמן זית, נייר טואלט, חמאת בוטנים) are ONE item. Never split.
10. First interaction with a new name: say "נעים להכיר" (NOT "נעים לפגוש אותך" — we haven't met in person). After a voice message specifically: "נעים לשמוע אותך" (nice to hear you — personal touch).
11. Voice messages: user may send transcribed voice text — handle identically to typed text. If the user already SENT a voice message, do NOT suggest voice as a new feature — they already know.
12. Hebrew grammar: in construct state (סמיכות), ONLY the second noun gets ה. "שם המשתמש" NOT "השם המשתמש". "רשימת הקניות" NOT "הרשימת הקניות". "מספר הטלפון" NOT "המספר הטלפון".
13. NEVER correct the user's Hebrew gender forms. If they write "אני צריך" — they are male. If "אני צריכה" — female. Their verb form IS their gender. Do not add asterisks (*), do not "fix" their grammar, do not suggest alternative forms. Match THEIR gender in your reply.

OUTPUT FORMAT — you MUST include these hidden metadata blocks BEFORE your visible reply:
<!--ACTIONS:[]-->
<!--TRIED:[]-->
Your visible reply here

ACTIONS array: each object has "type" and relevant fields:
- shopping: {"type":"shopping","items":["חלב","ביצים"]}
- task: {"type":"task","text":"לפרוק מדיח"}
- reminder: {"type":"reminder","text":"להוציא בשר","time":"17:00","send_at":"2026-04-12T17:00:00+03:00"}
  IMPORTANT: always include send_at as full ISO 8601 with Israel timezone (+03:00). If user says "ב-5" → today 17:00 IST. If "בעוד שעה" → compute from current time. If time already passed today → use tomorrow. The "time" field is a display hint; "send_at" is what actually schedules the reminder.
- event: {"type":"event","title":"ארוחת ערב","date":"2026-04-11","time":"19:00"}
- rotation: {"type":"rotation","title":"כלים","members":["יובל","נועה"]}
- name_correction: {"type":"name_correction","name":"ירון"}

TRIED array: list ALL capability types demonstrated so far (include previous + any new ones from this reply).
Example: ["shopping","task"]

If no action taken, use empty array: <!--ACTIONS:[]-->
Always include TRIED with the full cumulative list.`;

// (Removed: generateOnboardingReply — replaced by inline Sonnet call in handleDirectMessage)

// Auto-create a personal household for 1:1 users on first actionable message
async function ensureOnboardingHousehold(
  phone: string,
  convo: Record<string, unknown>,
  userName: string
): Promise<string> {
  if (convo.household_id) return convo.household_id as string;

  const hhId = "hh_" + uid4() + uid4();
  const displayName = userName || "הבית שלי";

  const { error: hhErr } = await supabase.from("households_v2").insert({
    id: hhId,
    name: displayName,
  });
  if (hhErr) console.error("[1:1] Failed to create household:", hhErr);

  const { error: memErr } = await supabase.from("household_members").insert({
    household_id: hhId,
    display_name: userName || "אני",
    role: "founder",
  });
  if (memErr) console.error("[1:1] Failed to create member:", memErr);

  // Link phone to household for future group-join auto-detection
  await supabase.from("whatsapp_member_mapping").upsert({
    phone_number: phone,
    household_id: hhId,
    member_name: userName || null,
  }, { onConflict: "phone_number" });

  await supabase.from("onboarding_conversations").update({
    household_id: hhId,
  }).eq("phone", phone);

  console.log(`[1:1] Created personal household ${hhId} for ${phone} (${displayName})`);
  return hhId;
}

// Parse a time string like "17:00", "ב-5", "22:45" → ISO send_at timestamp
function parseReminderTime(timeStr: string): string | null {
  if (!timeStr) return null;

  const now = new Date();
  const israelNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));

  // Try ISO format first (Sonnet may output full ISO)
  if (timeStr.includes("T") && timeStr.includes(":")) {
    const parsed = new Date(timeStr);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  // Extract hours and minutes from various formats
  const timeMatch = timeStr.match(/(\d{1,2})[:\u05D1\-]?(\d{2})?/);
  if (!timeMatch) return null;

  let hours = parseInt(timeMatch[1], 10);
  const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

  // Assume PM for single-digit hours 1-6 (Israeli convention: "ב-5" = 17:00)
  if (hours >= 1 && hours <= 6 && !timeStr.includes("בוקר") && !timeStr.includes("לילה")) {
    hours += 12;
  }

  // Build target date in Israel timezone
  const target = new Date(israelNow);
  target.setHours(hours, minutes, 0, 0);

  // If time already passed today → tomorrow
  if (target <= israelNow) {
    target.setDate(target.getDate() + 1);
  }

  // Convert back to UTC by computing offset
  const utcTarget = new Date(target.getTime());
  // Israel is UTC+3 (or UTC+2 in winter, but April is summer time)
  utcTarget.setHours(utcTarget.getHours() - 3);

  return utcTarget.toISOString();
}

async function handleDirectMessage(message: IncomingMessage, prov: WhatsAppProvider) {
  const phone = message.senderPhone;
  const text = (message.text || "").trim();
  const senderName = message.senderName || "";

  console.log(`[1:1] Direct message from ${phone}: "${text.slice(0, 50)}"`);

  // Skip non-text messages in 1:1 (voice is OK — already transcribed upstream)
  if (!text && message.type !== "voice") return;

  // --- Already in a group? Route to personal channel ---
  const { data: mapping } = await supabase
    .from("whatsapp_member_mapping")
    .select("household_id")
    .eq("phone_number", phone)
    .limit(1)
    .single();

  // --- Get or create conversation ---
  let { data: convo } = await supabase
    .from("onboarding_conversations")
    .select("*")
    .eq("phone", phone)
    .single();

  if (mapping) {
    // User is in a group — treat 1:1 as personal channel
    if (convo) {
      await supabase.from("onboarding_conversations").update({
        state: "personal",
        household_id: mapping.household_id,
        updated_at: new Date().toISOString(),
      }).eq("phone", phone);
    } else {
      await supabase.from("onboarding_conversations").insert({
        phone,
        state: "personal",
        household_id: mapping.household_id,
        message_count: 1,
        context: { name: senderName },
      });
    }

    // Handle as personal channel message
    await handlePersonalChannelMessage(message, mapping.household_id, prov);
    return;
  }

  // --- New user: first message ever ---
  if (!convo) {
    // Check for referral code
    const referralMatch = text.match(/(?:שלום|שלי|shalom|hey|hi)\s+([A-Z0-9]{6})\b/i);
    let validReferralCode: string | null = null;
    if (referralMatch) {
      const code = referralMatch[1].toUpperCase();
      const { data: referrer } = await supabase
        .from("households_v2")
        .select("id")
        .eq("referral_code", code)
        .single();
      if (referrer) {
        validReferralCode = code;
        console.log(`[1:1] Referral code ${code} validated (household ${referrer.id})`);
      }
    }

    await supabase.from("onboarding_conversations").insert({
      phone,
      state: "welcomed",
      message_count: 1,
      referral_code: validReferralCode,
      context: { name: senderName, gender: detectGender(hebrewizeName(senderName)) },
      demo_items: [],
      tried_capabilities: [],
    });

    // Send welcome
    const welcome = getOnboardingWelcome(senderName);
    await prov.sendMessage({ groupId: message.groupId, text: welcome });

    // Log
    await logMessage(
      { messageId: `welcome_${phone}_${Date.now()}`, groupId: message.groupId, senderPhone: "972555175553", senderName: "שלי", text: welcome, type: "text" },
      "onboarding_welcome",
      "unknown"
    );
    console.log(`[1:1] New onboarding conversation for ${phone}${validReferralCode ? ` (referred by ${validReferralCode})` : ""}`);
    return;
  }

  // --- Dormant user returning → reset to chatting naturally ---
  if (convo.state === "dormant") {
    await supabase.from("onboarding_conversations").update({
      state: "chatting",
      nudge_count: 0,
      updated_at: new Date().toISOString(),
      message_count: (convo.message_count || 0) + 1,
    }).eq("phone", phone);
    convo.state = "chatting";
  }

  // --- Nudging/sleeping/welcomed user replying → back to chatting ---
  if (convo.state === "nudging" || convo.state === "sleeping" || convo.state === "welcomed") {
    await supabase.from("onboarding_conversations").update({
      state: "chatting",
      updated_at: new Date().toISOString(),
      message_count: (convo.message_count || 0) + 1,
    }).eq("phone", phone);
    convo.state = "chatting";
  }

  // --- Joined/personal: shouldn't reach here (mapping handled above), but safety ---
  if (convo.state === "joined" || convo.state === "personal") {
    await prov.sendMessage({
      groupId: message.groupId,
      text: "אני כבר בקבוצה שלכם! דברו איתי שם, או כתבו לי כאן לדברים אישיים 😊",
    });
    return;
  }

  // --- Active conversation: send to Sonnet ---
  const userName = convo.context?.name || hebrewizeName(senderName) || "";
  const existingItems = ((convo.demo_items || []) as any[]).filter((i: any) => i.type !== "_pending_nudge");
  const triedCaps: string[] = convo.tried_capabilities || [];
  // Auto-mark voice as tried if user sent a voice message
  if (message.type === "voice" && !triedCaps.includes("voice")) {
    triedCaps.push("voice");
  }
  const allCaps = ["shopping", "task", "rotation", "reminder", "event", "voice"];
  const untriedCaps = allCaps.filter(c => !triedCaps.includes(c));
  const msgCount = (convo.message_count || 0) + 1;

  // Detect gender: text > stored > name. Text is AUTHORITATIVE — the user's own
  // verb forms ("אני צריך" / "אני צריכה") override any previous detection.
  const textGender = detectGenderFromText(text);
  let userGender: string | null = textGender || convo.context?.gender || null;
  if (!userGender && userName) {
    userGender = detectGender(userName);
  }
  // Store if changed (text detection can override previously stored gender)
  if (userGender && userGender !== convo.context?.gender) {
    await supabase.from("onboarding_conversations").update({
      context: { ...(convo.context || {}), gender: userGender },
    }).eq("phone", phone);
    console.log(`[1:1] Gender ${textGender ? "overridden" : "detected"} for ${phone}: ${userGender}`);
  }

  // Check Q&A pattern match for topic hint
  const qaMatch = matchOnboardingQA(text);

  // Fetch recent bot replies for anti-repetition
  const { data: recentMsgs } = await supabase.from("whatsapp_messages")
    .select("message_text")
    .eq("group_id", message.groupId)
    .eq("sender_phone", "972555175553")
    .not("message_text", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);
  const recentReplies = (recentMsgs || []).map((m: any) => m.message_text).filter(Boolean);

  // Build context for Sonnet
  const contextBlock = `
CONVERSATION STATE:
- User name: ${userName || "unknown"}
- User gender: ${userGender || "unknown (use plural אתם)"}
- Message #${msgCount} in this conversation
- Items collected so far: ${JSON.stringify(existingItems)}
- Capabilities already shown: ${JSON.stringify(triedCaps)}
- Capabilities NOT yet shown: ${JSON.stringify(untriedCaps)}
- Current time in Israel: ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}
${qaMatch ? `\nTOPIC HINT: User is asking about "${qaMatch.topic}". Key facts: ${qaMatch.keyFacts}` : ""}
${recentReplies.length > 0 ? `\nYOUR RECENT REPLIES (do NOT repeat these — vary your style and content):\n${recentReplies.map((r: string) => `- "${r.slice(0, 120)}"`).join("\n")}` : ""}`;

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.warn("[1:1] No ANTHROPIC_API_KEY — sending fallback");
      await prov.sendMessage({ groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" });
      return;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: ONBOARDING_1ON1_PROMPT + "\n\n" + contextBlock,
        messages: [{ role: "user", content: `${message.quotedText ? `[Quoted message being replied to: "${message.quotedText}"]\n` : ""}[${userName || "משתמש"}]: ${text}` }],
      }),
    });

    if (!response.ok) {
      console.error(`[1:1] Sonnet error: ${response.status}`);
      await prov.sendMessage({ groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" });
      return;
    }

    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";

    // Parse hidden metadata
    const actionsMatch = raw.match(/<!--ACTIONS:(.*?)-->/s);
    const triedMatch = raw.match(/<!--TRIED:(.*?)-->/s);
    const visibleReply = raw
      .replace(/<!--ACTIONS:.*?-->/s, "")
      .replace(/<!--TRIED:.*?-->/s, "")
      .trim();

    // Parse actions
    let actions: any[] = [];
    if (actionsMatch) {
      try { actions = JSON.parse(actionsMatch[1]); } catch {}
    }

    // Parse tried capabilities
    let newTried: string[] = triedCaps;
    if (triedMatch) {
      try { newTried = JSON.parse(triedMatch[1]); } catch {}
    }

    // Process actions → execute REAL DB operations (not just demo_items)
    const newItems = [...existingItems];
    let hhId: string | null = null;

    // Name correction is handled separately (no household needed)
    for (const action of actions) {
      if (action.type === "name_correction" && action.name) {
        const newGender = detectGender(action.name);
        const updatedContext = { ...(convo.context || {}), name: action.name, gender: newGender };
        await supabase.from("onboarding_conversations").update({
          context: updatedContext,
        }).eq("phone", phone);
      }
    }

    // For all other actions, ensure household exists and execute for real
    const realActions = actions.filter((a: any) => a.type && a.type !== "name_correction");
    if (realActions.length > 0) {
      hhId = await ensureOnboardingHousehold(phone, convo as Record<string, unknown>, userName);

      // Map 1:1 Sonnet format → executeActions format
      const mappedActions: any[] = [];
      for (const action of realActions) {
        switch (action.type) {
          case "shopping":
            if (action.items && Array.isArray(action.items)) {
              mappedActions.push({
                type: "add_shopping",
                data: { items: action.items.map((item: string) => ({ name: item, qty: "1", category: "אחר" })) },
              });
              for (const item of action.items) {
                newItems.push({ type: "shopping", text: item });
              }
            }
            break;
          case "task":
            mappedActions.push({
              type: "add_task",
              data: { title: action.text || "", assigned_to: null },
            });
            newItems.push({ type: "task", text: action.text || "" });
            break;
          case "event":
            mappedActions.push({
              type: "add_event",
              data: {
                title: action.title || action.text || "",
                assigned_to: null,
                scheduled_for: action.date
                  ? `${action.date}${action.time ? "T" + action.time + ":00+03:00" : "T18:00:00+03:00"}`
                  : new Date().toISOString(),
              },
            });
            newItems.push({ type: "event", text: action.title || action.text || "" });
            break;
          case "rotation":
            if (action.members && Array.isArray(action.members)) {
              mappedActions.push({
                type: "add_task",
                data: {
                  rotation: {
                    title: action.title || "",
                    type: action.rotationType || "duty",
                    members: action.members,
                  },
                },
              });
              newItems.push({ type: "rotation", text: action.title || "" });
            }
            break;
          case "reminder": {
            // Parse time → INSERT into reminder_queue directly
            const sendAt = action.send_at
              ? new Date(action.send_at).toISOString()
              : parseReminderTime(action.time || "");
            if (sendAt) {
              const { error: remErr } = await supabase.from("reminder_queue").insert({
                household_id: hhId,
                group_id: phone + "@s.whatsapp.net",
                message_text: action.text || "",
                send_at: sendAt,
                sent: false,
                reminder_type: "user",
                created_by_phone: phone,
                created_by_name: userName,
              });
              if (remErr) console.error("[1:1 Reminder] Insert error:", remErr);
              else console.log(`[1:1 Reminder] Created for ${sendAt}: "${action.text}"`);
            } else {
              console.warn(`[1:1 Reminder] Could not parse time from: ${JSON.stringify(action)}`);
            }
            newItems.push({ type: "reminder", text: action.text || "" });
            break;
          }
          default:
            newItems.push({ type: action.type, text: action.text || action.title || "" });
        }
      }

      // Execute mapped actions (tasks, shopping, events, rotations) via the real executor
      if (mappedActions.length > 0) {
        try {
          const { summary } = await executeActions(hhId, mappedActions, userName || senderName);
          console.log(`[1:1] Executed ${summary.length} real actions for ${phone}:`, summary);
        } catch (err) {
          console.error("[1:1] executeActions error:", err);
        }
      }
    }

    // Determine if user asked "how does it work" → state = invited
    const askedHowItWorks = qaMatch?.topic === "getting-started";
    const newState = askedHowItWorks ? "invited" : "chatting";

    // Update conversation
    await supabase.from("onboarding_conversations").update({
      state: newState,
      message_count: msgCount,
      demo_items: newItems,
      tried_capabilities: newTried,
      nudge_count: 0, // Reset nudge counter on any user message
      updated_at: new Date().toISOString(),
    }).eq("phone", phone);

    // Send reply
    if (visibleReply) {
      await prov.sendMessage({ groupId: message.groupId, text: visibleReply });
    }

    // Log
    await logMessage(
      { messageId: `onboarding_reply_${Date.now()}`, groupId: message.groupId, senderPhone: "972555175553", senderName: "שלי", text: visibleReply, type: "text" },
      actions.length > 0 ? "onboarding_actionable" : "onboarding_conversational",
      convo.household_id || "unknown"
    );
    console.log(`[1:1] Sonnet 1:1 reply for ${phone}: actions=${actions.length}, tried=${newTried.join(",")}`);

  } catch (err) {
    console.error("[1:1] handleDirectMessage error:", err);
    try {
      await prov.sendMessage({ groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" });
    } catch {}
  }
}

// ─── Personal Channel: 1:1 after user joined a group ───

async function handlePersonalChannelMessage(
  message: IncomingMessage,
  householdId: string,
  prov: WhatsAppProvider
): Promise<void> {
  const text = (message.text || "").trim();
  const phone = message.senderPhone;

  if (!text) return;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: ONBOARDING_1ON1_PROMPT + `\n\nPERSONAL CHANNEL MODE: This user already has Sheli in a group (household: ${householdId}). This 1:1 chat is their personal line. Handle requests normally, shopping, tasks, reminders all work here and go to the shared household. For shared items, gently suggest writing in the group so everyone sees it.`,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!response.ok) return;
    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";

    // Parse and send visible reply
    const visibleReply = raw
      .replace(/<!--ACTIONS:.*?-->/s, "")
      .replace(/<!--TRIED:.*?-->/s, "")
      .trim();

    // TODO: Execute actions against the real household DB (not demo_items)
    // This connects to the existing action executor in a future iteration

    if (visibleReply) {
      await prov.sendMessage({ groupId: message.groupId, text: visibleReply });
    }

    console.log(`[1:1 personal] Reply for ${phone} (household: ${householdId})`);
  } catch (err) {
    console.error("[1:1 personal] error:", err);
  }
}

// ─── Group Introduction ───

const INTRO_MESSAGE = `היי! 👋 אני שלי, העוזרת החכמה שלכם בווטסאפ.

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
      name: data.subject || data.name || "הבית",
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
  const groupName = groupInfo?.name || "הבית";
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
      .in("state", ["welcomed", "chatting", "sleeping", "nudging", "invited"])
      .single();

    if (onboardingConvo) {
      await supabase
        .from("onboarding_conversations")
        .update({ state: "personal", household_id: householdId, updated_at: new Date().toISOString() })
        .eq("id", onboardingConvo.id);

      // Send 1:1 personal channel message
      const postGroupMsg = `מעולה, אני בקבוצה! 🎉 מעכשיו כולם בבית יכולים לדבר איתי שם.

הצ'אט הזה? הוא רק שלך ושלי 😊

תזכורת אישית, רעיון למתנה, משימה שרק אתם צריכים לזכור,
כתבו לי כאן. אף אחד אחר לא רואה.

אני תמיד כאן 💛`;
      await provider.sendMessage({
        groupId: onboardingConvo.phone,
        text: postGroupMsg,
      });
      console.log(`[1:1] Personal channel message sent to ${p.phone} — state: personal, household: ${householdId}`);
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

// ─── Pending Confirmation Patterns ───
const CONFIRM_AFFIRMATIVE = /^(כן|נכון|בדיוק|יאללה|אוקי|ok|כמובן|מדויק|yes|בטח|sure|👍|💪)[\s.!]*$/i;
const CONFIRM_NEGATIVE = /^(לא|לא נכון|טעות|הפוך|שגוי|no|ממש לא)[\s.!]*$/i;
const BACK_OFF_KEYWORDS = /אל תתערבי|לא דיברתי אליך|עזבי|תתנתקי|לא בשבילך|שקט שלי|אל תתערב|לא פנו אליך/i;

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

      // Check if this is the first voice message in the group/chat — for privacy explanation
      const isFirstVoice = await isFirstVoiceInChat(message.groupId || message.chatId);

      console.log(`[Webhook] Transcribing ${duration}s voice from ${message.senderName}${isFirstVoice ? " (first voice!)" : ""}`);
      const transcribed = await transcribeVoice(message.mediaUrl, message.mediaId);
      if (!transcribed) {
        console.log(`[Webhook] Transcription failed for ${message.senderName}`);
        await logMessage(message, "voice_transcription_failed");
        return new Response("OK", { status: 200 });
      }

      // Inject transcribed text — clean up voice artifacts before pipeline
      let cleanTranscript = transcribed
        // Strip greeting preambles: "היי שלי", "שלי,", "הי שלי" etc.
        .replace(/^(היי|הי|שלום|בוקר טוב|ערב טוב)\s*(שלי)?\s*[,.]?\s*/i, "")
        // Strip filler: "אממ", "אהה", "ובכן"
        .replace(/^(אממ|אהה|ובכן|אז)\s*[,.]?\s*/gi, "")
        // Strip "תודה" / "בבקשה" at end
        .replace(/\s*(תודה|בבקשה)\s*[.!]*\s*$/i, "")
        .trim();

      // If cleaning emptied it, use original
      if (!cleanTranscript) cleanTranscript = transcribed;

      // Haiku pass: fix Hebrew voice transcription errors before classification
      const fixedTranscript = await fixVoiceTranscription(cleanTranscript);
      if (fixedTranscript && fixedTranscript !== cleanTranscript) {
        console.log(`[Webhook] Voice fix: "${cleanTranscript.slice(0, 60)}" → "${fixedTranscript.slice(0, 60)}"`);
        cleanTranscript = fixedTranscript;
      }

      message.text = cleanTranscript;
      console.log(`[Webhook] Transcribed voice: "${transcribed.slice(0, 80)}" → final: "${cleanTranscript.slice(0, 80)}"`);

      // First voice message in this chat? Send a one-time privacy explanation
      if (isFirstVoice) {
        const chatTarget = message.groupId || message.chatId;
        if (chatTarget) {
          const privacyNote = "🎤 אגב, אני בודקת רק הודעות קוליות קצרות (עד 30 שניות) — " +
            "הארוכות יותר הן כנראה עניינים משפחתיים ולא בקשות ממני.\n" +
            "שום דבר לא נשמר אצלי יותר מ-30 יום, וגם זה רק כדי שאוכל להכיר אתכם ולהיות יעילה יותר עבורכם 😊";
          // Send after a small delay so the main reply goes first
          setTimeout(async () => {
            try {
              await provider.sendMessage({ groupId: chatTarget, text: privacyNote });
            } catch (e) { console.error("[VoicePrivacy] Failed to send:", e); }
          }, 3000);
        }
      }
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
    let { data: config } = await supabase
      .from("whatsapp_config")
      .select("household_id, bot_active, language, group_message_count")
      .eq("group_id", message.groupId)
      .single();

    if (!config) {
      // Auto-setup: group not configured yet (missed join event). Set it up now.
      console.log(`[Webhook] No config for group ${message.groupId} — auto-setting up`);
      await handleBotAddedToGroup(message.groupId, provider);
      // Re-fetch config after setup
      const { data: newConfig } = await supabase
        .from("whatsapp_config")
        .select("household_id, bot_active, language, group_message_count")
        .eq("group_id", message.groupId)
        .single();
      if (!newConfig) {
        console.error(`[Webhook] Auto-setup failed for group ${message.groupId}`);
        await notifyAdmin("Auto-setup failed", `Group: ${message.groupId}`);
        return new Response("OK", { status: 200 });
      }
      config = newConfig;
    }
    if (!config.bot_active) {
      console.log(`[Webhook] Bot disabled for group ${message.groupId}`);
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

    // 6-gender. Detect gender from message text (Hebrew verbs/possessives)
    // Text is AUTHORITATIVE — overrides any previous name-based detection.
    // "אני צריך" = male, period. The user's own verb form is the truth.
    if (message.text) {
      const textGender = detectGenderFromText(message.text);
      if (textGender) {
        // Update household_members — override even if previously set (text > name)
        await supabase.from("household_members")
          .update({ gender: textGender })
          .eq("household_id", householdId)
          .eq("display_name", message.senderName);
        // Also update whatsapp_member_mapping
        await supabase.from("whatsapp_member_mapping")
          .update({ gender: textGender })
          .eq("household_id", householdId)
          .eq("phone_number", message.senderPhone);
      }
    }

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

    // 5. Voice-only: Whisper transcription variants (e.g. child says "שלי" → Whisper writes "שאלי")
    // Safe because colloquial Hebrew uses "תשאלי" for "ask me", not bare "שאלי"
    let voiceFuzzyMatch = false;
    if (message.type === "voice") {
      const shealiFirstWord = /^\s*שאלי[\s,!?]/.test(txt);
      const shealiEnd = /(?:ביי|ביביי|להתראות|יאללה)\s+שאלי[!.\s]*$/i.test(txt);
      const shealiAfterGreeting = /^(היי|הי|שלום|יו|הלו|בוקר טוב|ערב טוב)\s+שאלי\b/i.test(txt);
      voiceFuzzyMatch = shealiFirstWord || shealiEnd || shealiAfterGreeting;
      if (voiceFuzzyMatch) {
        console.log(`[Webhook] Layer 1: Voice fuzzy match "שאלי"→"שלי" (first=${shealiFirstWord}, end=${shealiEnd}, greeting=${shealiAfterGreeting})`);
      }
    }

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
      sheliFirstWord || sheliAfterGreeting || sheliAfterThanks || sheliStandaloneEnd ||
      voiceFuzzyMatch
    );
    // For ambiguous cases (שלי mid-sentence), directAddress stays false — Haiku Layer 2 decides
    let directAddress = highConfidenceName;

    const cleanedText = directAddress
      ? txt
          .replace(/@?שלי[\s,:]*/, "")
          .replace(/@?שאלי[\s,:]*/, "") // voice transcription variant
          .replace(/@?she(?:li|lly|lli|ly|lei|ley|lee)[\s,:]*/i, "")
          .replace(new RegExp(`@${botPhone}\\s*`), "")
          .replace(new RegExp(`@${botLid}\\s*`), "")
          .trim()
      : txt;

    if (directAddress) {
      console.log(`[Webhook] Layer 1: Direct address detected from ${message.senderName} (first=${sheliFirstWord}, greeting=${sheliAfterGreeting}, thanks=${sheliAfterThanks}, end=${sheliStandaloneEnd}, @=${atMention}, en=${englishMention}, voiceFuzzy=${voiceFuzzyMatch})`);
    }

    // 6b. Check for pending confirmation response
    const { data: pendingConfirm } = await supabase
      .from("pending_confirmations")
      .select("id, action_type, action_data, status, expires_at")
      .eq("group_id", message.groupId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingConfirm) {
      const msgTrimmed = message.text.trim();

      if (CONFIRM_AFFIRMATIVE.test(msgTrimmed)) {
        // Execute the pending action
        const actions = [{ type: pendingConfirm.action_type, data: pendingConfirm.action_data }];
        const { summary } = await executeActions(householdId, actions, message.senderName);
        console.log(`[Webhook] Pending confirmation confirmed:`, summary);

        await supabase.from("pending_confirmations")
          .update({ status: "confirmed" })
          .eq("id", pendingConfirm.id);

        await provider.sendMessage({ groupId: message.groupId, text: "מעולה, סידרתי! ✓" });
        await logMessage(message, "confirmation_accepted", householdId);
        return new Response("OK", { status: 200 });
      }

      if (CONFIRM_NEGATIVE.test(msgTrimmed)) {
        await supabase.from("pending_confirmations")
          .update({ status: "rejected" })
          .eq("id", pendingConfirm.id);

        await provider.sendMessage({
          groupId: message.groupId,
          text: "אוקי, ביטלתי 🤷‍♀️ אפשר להסביר שוב ואני אנסה להבין",
        });
        await logMessage(message, "confirmation_rejected", householdId);
        return new Response("OK", { status: 200 });
      }

      // Check for auto-expire: if past expires_at, execute silently
      if (new Date(pendingConfirm.expires_at) < new Date()) {
        const actions = [{ type: pendingConfirm.action_type, data: pendingConfirm.action_data }];
        const { summary } = await executeActions(householdId, actions, message.senderName);
        console.log(`[Webhook] Pending confirmation auto-expired, executing:`, summary);

        await supabase.from("pending_confirmations")
          .update({ status: "expired" })
          .eq("id", pendingConfirm.id);
        // Don't reply — just execute silently and continue with current message
      }

      // If neither confirm nor reject nor expired, fall through to normal classification
    }

    // 6b2. Back-off detection — "don't get involved"
    if (BACK_OFF_KEYWORDS.test(message.text.trim())) {
      // Try to undo last bot action
      const lastAction = await getLastBotAction(message.groupId, householdId);
      if (lastAction) {
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        if (new Date(lastAction.created_at).getTime() > fiveMinAgo) {
          await undoLastAction(householdId, lastAction.classification_data);
        }
      }

      // Also reject any pending confirmation
      await supabase.from("pending_confirmations")
        .update({ status: "rejected" })
        .eq("group_id", message.groupId)
        .eq("status", "pending");

      // Log back-off preference
      await supabase.from("household_patterns").upsert({
        household_id: householdId,
        pattern_type: "back_off",
        pattern_key: "conversation_sensitivity",
        pattern_value: "high — family prefers bot only responds when directly addressed",
        confidence: 0.8,
        hit_count: 1,
      }, { onConflict: "household_id,pattern_type,pattern_key" });

      await provider.sendMessage({
        groupId: message.groupId,
        text: "חח סורי! 🙈 לא התכוונתי להתערב. מחזירה את עצמי לפינה 😅",
      });
      await logMessage(message, "haiku_ignore", householdId);
      return new Response("OK", { status: 200 });
    }

    // 6d. Pure emoji messages → skip Haiku, reply with matching emoji via Sonnet
    const PURE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\u200d\ufe0f]{1,20}$/u;
    if (PURE_EMOJI.test(message.text.trim()) && message.text.trim().length <= 20 && !message.text.trim().match(/[a-zA-Z\u0590-\u05FF\u0600-\u06FF0-9]/)) {
      const emojiReply = await generateEmojiReply(message.text.trim(), message.senderName);
      if (emojiReply) {
        await provider.sendMessage({ groupId: message.groupId, text: emojiReply });
      }
      await logMessage(message, "haiku_ignore", householdId);
      return new Response("OK", { status: 200 });
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

    // 6e. Onboarding mode: first 20 messages in new group → all Sonnet for max quality
    const isOnboarding = (config.group_message_count || 0) <= 20;

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

    // Prepend quoted message context so classifier understands reply references
    const textForClassifier = message.quotedText
      ? `[הודעה מצוטטת: "${message.quotedText}"]\n${cleanedText || message.text}`
      : (cleanedText || message.text);

    const classification = await classifyIntent(
      textForClassifier,
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
    const isActionable = classification.intent !== "ignore" && classification.intent !== "info_request" && classification.intent !== "correct_bot" && classification.intent !== "instruct_bot";

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

    // 8c. Onboarding mode: escalate to Sonnet for quality (first 20 msgs, skip shopping which already works)
    if (isOnboarding && classification.intent !== "add_shopping" && classification.intent !== "instruct_bot") {
      console.log(`[Webhook] Onboarding escalation to Sonnet (msg #${config.group_message_count || 0})`);
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
          const replyCtx = await buildReplyCtx(householdId, "group");
          const { reply } = await generateReply(classification, message.senderName, replyCtx);
          if (reply) {
            await provider.sendMessage({ groupId: message.groupId, text: reply });
            await maybeMarkDashboardMentioned(message.groupId, reply);
          }
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }
        await logMessage(message, "sonnet_escalated_social", householdId);
        return new Response("OK", { status: 200 });
      }

      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId, classification);
        return new Response("OK", { status: 200 });
      }

      const { summary: sonnetSummary } = await executeActions(householdId, sonnetResult.actions, message.senderName);
      await incrementUsage(householdId);
      if (sonnetResult.reply) {
        await provider.sendMessage({ groupId: message.groupId, text: sonnetResult.reply });
        await maybeMarkDashboardMentioned(message.groupId, sonnetResult.reply);
      }
      await logMessage(message, "sonnet_escalated", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // If ignore with high confidence → stop (no Sonnet call)
    // UNLESS directly addressed or context-uncertain — then escalate to Sonnet
    if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH && !classification.needs_conversation_review) {
      if (directAddress) {
        // Check for double confusion — if last bot reply was also uncertain, escalate to admin
        const { data: recentBotMsgs } = await supabase
          .from("whatsapp_messages")
          .select("message_text, created_at")
          .eq("group_id", message.groupId)
          .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
          .not("message_text", "is", null)
          .order("created_at", { ascending: false })
          .limit(1);

        const lastBotMsg = recentBotMsgs?.[0];
        const lastBotWasConfused = lastBotMsg &&
          (lastBotMsg.message_text?.includes("מה הכוונה") ||
           lastBotMsg.message_text?.includes("אפשר לפרט") ||
           lastBotMsg.message_text?.includes("לא הבנתי") ||
           lastBotMsg.message_text?.includes("לא בטוחה")) &&
          new Date(lastBotMsg.created_at).getTime() > Date.now() - 5 * 60 * 1000;

        if (lastBotWasConfused) {
          await provider.sendMessage({
            groupId: message.groupId,
            text: "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️",
          });
          await notifyAdmin(
            `Double confusion in group`,
            `User ${message.senderName}: "${message.text}"\nLast bot reply: "${lastBotMsg.message_text?.slice(0, 100)}"`
          );
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }

        // Direct address overrides ignore — generate a personality reply
        // Use original text (with שלי) so Sonnet sees the full context
        const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
        const replyCtx = await buildReplyCtx(householdId, "group");
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

        // Check for double confusion — if last bot reply was also uncertain, escalate to admin
        const { data: recentBotMsgsLow } = await supabase
          .from("whatsapp_messages")
          .select("message_text, created_at")
          .eq("group_id", message.groupId)
          .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
          .not("message_text", "is", null)
          .order("created_at", { ascending: false })
          .limit(1);

        const lastBotMsgLow = recentBotMsgsLow?.[0];
        const lastBotWasConfusedLow = lastBotMsgLow &&
          (lastBotMsgLow.message_text?.includes("מה הכוונה") ||
           lastBotMsgLow.message_text?.includes("אפשר לפרט") ||
           lastBotMsgLow.message_text?.includes("לא הבנתי") ||
           lastBotMsgLow.message_text?.includes("לא בטוחה")) &&
          new Date(lastBotMsgLow.created_at).getTime() > Date.now() - 5 * 60 * 1000;

        if (lastBotWasConfusedLow) {
          await provider.sendMessage({
            groupId: message.groupId,
            text: "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️",
          });
          await notifyAdmin(
            `Double confusion in group`,
            `User ${message.senderName}: "${message.text}"\nLast bot reply: "${lastBotMsgLow.message_text?.slice(0, 100)}"`
          );
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }

        const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
        const replyCtx = await buildReplyCtx(householdId, "group");
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
          const replyCtx = await buildReplyCtx(householdId, "group");
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

      const { summary: sonnetSummary } = await executeActions(householdId, sonnetResult.actions, message.senderName);
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

    // instruct_bot: parent explaining a rule → Sonnet parses + confirm-then-act
    if (classification.intent === "instruct_bot") {
      const replyCtx = await buildReplyCtx(householdId, "group");
      const { reply } = await generateReply(classification, message.senderName, replyCtx);

      // Extract hidden PENDING_ACTION block from Sonnet reply
      const pendingAction = extractPendingAction(reply);
      const cleanReply = cleanPendingAction(reply);

      if (pendingAction && pendingAction.action_type) {
        // Store pending confirmation
        const confId = Math.random().toString(36).slice(2, 10);
        const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3 hours
        const { error } = await supabase.from("pending_confirmations").insert({
          id: confId,
          household_id: householdId,
          group_id: message.groupId,
          action_type: pendingAction.action_type,
          action_data: pendingAction.action_data,
          confirmation_text: cleanReply,
          created_by: message.senderName,
          expires_at: expiresAt,
          status: "pending",
        });
        if (error) console.error("[Webhook] Failed to store pending confirmation:", error);
        else console.log(`[Webhook] Stored pending confirmation ${confId}: ${pendingAction.action_type}`);
      }

      if (cleanReply) {
        await provider.sendMessage({ groupId: message.groupId, text: cleanReply });
      }
      await logMessage(message, "instruct_bot", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Non-actionable intents (question, info_request) — generate reply only, no DB writes
    if (!isActionable && classification.intent !== "ignore") {
      const replyCtx = await buildReplyCtx(householdId, "group");
      const { reply } = await generateReply(classification, message.senderName, replyCtx);
      if (reply) {
        await provider.sendMessage({ groupId: message.groupId, text: reply });
        await maybeMarkDashboardMentioned(message.groupId, reply);
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

    const { summary } = await executeActions(householdId, actions, message.senderName);
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
    const replyCtx = await buildReplyCtx(householdId, "group");
    let { reply } = await generateReply(classification, message.senderName, replyCtx);

    // 13b. Handle reminder insertion (extract hidden REMINDER blocks from Sonnet reply)
    if (classification.intent === "add_reminder" && reply) {
      const allReminders = extractRemindersFromReply(reply);
      for (const reminderData of allReminders) {
        if (reminderData.send_at) {
          const { error: remErr } = await supabase.from("reminder_queue").insert({
            household_id: householdId,
            group_id: message.groupId,
            message_text: reminderData.reminder_text,
            send_at: reminderData.send_at,
            sent: false,
            reminder_type: "user",
            created_by_phone: message.senderPhone,
            created_by_name: message.senderName,
          });
          if (remErr) console.error("[Reminder] Insert error:", remErr);
          else console.log(`[Reminder] Created for ${reminderData.send_at}: "${reminderData.reminder_text}"`);
        }
      }
      // Clean ALL hidden REMINDER blocks from the reply before sending to user
      reply = cleanReminderFromReply(reply);
    }

    // 13c. Handle memory capture (extract hidden MEMORY block from Sonnet reply)
    if (reply) {
      const memoryCapture = extractMemoryFromReply(reply);
      if (memoryCapture) {
        // Rate limit: max 3 auto-detected per household per day
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { count } = await supabase.from("family_memories")
          .select("id", { count: "exact", head: true })
          .eq("household_id", householdId)
          .eq("source", "auto_detected")
          .gte("created_at", todayStart.toISOString());

        if ((count || 0) < 3) {
          // Check capacity: 10 per member (or 10 household-wide)
          const capacityQuery = memoryCapture.about
            ? supabase.from("family_memories").select("id, importance, created_at", { count: "exact" })
                .eq("household_id", householdId).eq("member_phone", memoryCapture.about).eq("active", true)
            : supabase.from("family_memories").select("id, importance, created_at", { count: "exact" })
                .eq("household_id", householdId).is("member_phone", null).eq("active", true);
          const { data: existing, count: existingCount } = await capacityQuery;

          // Evict lowest-scored if at capacity
          if ((existingCount || 0) >= 10 && existing && existing.length > 0) {
            const scored = existing.map((m: any) => {
              const ageDays = (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
              const recency = ageDays < 7 ? 1.0 : Math.max(0.2, 1.0 - (ageDays - 7) * 0.05);
              return { id: m.id, score: (m.importance || 0.5) * recency };
            }).sort((a: any, b: any) => a.score - b.score);
            await supabase.from("family_memories").update({ active: false }).eq("id", scored[0].id);
            console.log(`[Memory] Evicted memory ${scored[0].id} (score: ${scored[0].score.toFixed(2)})`);
          }

          // Insert new memory
          const { error: memInsertErr } = await supabase.from("family_memories").insert({
            household_id: householdId,
            member_phone: memoryCapture.about || null,
            memory_type: memoryCapture.type,
            content: memoryCapture.content,
            context: message.text?.slice(0, 100) || null,
            source: "auto_detected",
            scope: message.groupId?.includes("@g.us") ? "group" : "direct",
            importance: 0.5,
          });
          if (memInsertErr) console.error("[Memory] Insert error:", memInsertErr);
          else console.log(`[Memory] Captured: "${memoryCapture.content}" about ${memoryCapture.about || "household"}`);
        }
      }

      // 13d. Handle used memory tracking
      const usedMemory = extractUsedMemory(reply);
      if (usedMemory) {
        // Update last_used_at and increment use_count for the referenced memory
        const { data: matchedMem } = await supabase.from("family_memories")
          .select("id, use_count")
          .eq("household_id", householdId)
          .eq("active", true)
          .ilike("content", `%${usedMemory.slice(0, 30)}%`)
          .limit(1)
          .single();
        if (matchedMem) {
          await supabase.from("family_memories")
            .update({ last_used_at: new Date().toISOString(), use_count: (matchedMem.use_count || 0) + 1 })
            .eq("id", matchedMem.id);
        }
        console.log(`[Memory] Sonnet referenced memory: "${usedMemory}"`);
      }

      // Strip memory blocks from visible reply
      reply = stripMemoryBlocks(reply);
    }

    // 13e. Handle explicit memory intents (save/delete after Sonnet replies)
    if (classification.intent === "save_memory") {
      const e = classification.entities;
      // Resolve member_about to phone number via whatsapp_member_mapping
      let memberPhone: string | null = null;
      if (e.memory_about) {
        const { data: mapping } = await supabase.from("whatsapp_member_mapping")
          .select("phone")
          .eq("household_id", householdId)
          .ilike("display_name", `%${e.memory_about}%`)
          .limit(1)
          .single();
        memberPhone = mapping?.phone || null;
      }

      const { error } = await supabase.from("family_memories").insert({
        household_id: householdId,
        member_phone: memberPhone,
        memory_type: "preference",
        content: e.memory_content || e.raw_text,
        context: message.text?.slice(0, 100) || null,
        source: "explicit_save",
        scope: message.groupId?.includes("@g.us") ? "group" : "direct",
        importance: 0.8,
      });
      if (error) console.error("[Memory] Explicit save error:", error);
      else console.log(`[Memory] Explicit save: "${e.memory_content}" about ${e.memory_about || "household"}`);
    }

    if (classification.intent === "delete_memory") {
      // Soft-delete the most recent active memory for this household
      const { data: recent } = await supabase.from("family_memories")
        .select("id")
        .eq("household_id", householdId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (recent) {
        await supabase.from("family_memories").update({ active: false }).eq("id", recent.id);
        console.log(`[Memory] Deleted memory ${recent.id}`);
      }
    }

    if (reply) {
      await provider.sendMessage({ groupId: message.groupId, text: reply });
      console.log(`[Webhook] Reply sent`);
    }

    // 14. Log completion
    await logMessage(message, "haiku_actionable", householdId, classification);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
    await notifyAdmin("Unhandled webhook error", String(err));
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

// ─── Voice — First-in-chat detection ───

async function isFirstVoiceInChat(chatId: string | undefined): Promise<boolean> {
  if (!chatId) return false;
  try {
    const { count } = await supabase
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("group_id", chatId)
      .eq("message_type", "voice")
      .not("classification", "eq", "received"); // only count processed ones
    return (count || 0) === 0; // no prior voice = this is the first
  } catch {
    return false;
  }
}

// ─── Voice Transcription Fixer — Haiku corrects Whisper Hebrew errors ───

async function fixVoiceTranscription(text: string): Promise<string | null> {
  if (!text || text.length < 3) return text;

  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!ANTHROPIC_API_KEY) return text;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: `You fix Hebrew voice transcription errors from Whisper.

COMMON ERRORS TO FIX:
1. MERGED WORDS: Whisper often joins two Hebrew words into one.
   "תורמי" → "תור מי" (whose turn). "מהנשמע" → "מה נשמע". "איפהזה" → "איפה זה".
2. HALLUCINATED FILLER: Whisper sometimes adds greetings or filler that weren't spoken, especially at the start or end: "מה נשמע? איך עובר עלייך היום?" when the person didn't say that.
   If the text starts with a generic greeting/smalltalk followed by an abrupt topic switch, the greeting may be hallucinated. Remove it ONLY if the transition is unnatural.
3. PHONEME CONFUSION: "תורני" vs "תורמי", "שלי" (mine) vs "שלי" (Sheli the bot name) — keep as-is, the classifier handles these.
4. WORD BOUNDARIES around common Hebrew phrases:
   "תור מי", "של מי", "מי בתור", "בשביל מה", "למה זה", "איך אני"

RULES:
- Return ONLY the corrected text, nothing else.
- If the text is fine, return it unchanged.
- Do NOT change meaning, add words, or rephrase.
- Do NOT remove content you're not sure is hallucinated.
- Keep it minimal — fix clear errors only.`,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!res.ok) {
      console.error("[VoiceFix] Haiku API error:", res.status);
      return text; // fallback to original
    }

    const data = await res.json();
    const fixed = data.content?.[0]?.text?.trim();
    return fixed || text;
  } catch (err) {
    console.error("[VoiceFix] Error:", err);
    return text; // fallback to original
  }
}

// ─── Error Notification — DM the admin when something breaks ───

const ADMIN_PHONE = Deno.env.get("ADMIN_PHONE") || "972525937316";
let lastErrorNotification = 0; // Rate limit: max 1 notification per 5 minutes

async function notifyAdmin(context: string, errorMsg: string) {
  try {
    const now = Date.now();
    if (now - lastErrorNotification < 5 * 60 * 1000) return; // Rate limit
    lastErrorNotification = now;

    const apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
    const token = Deno.env.get("WHAPI_TOKEN") || "";
    if (!token) return;

    const timestamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    const body = `⚠️ שלי — שגיאה\n${context}\nError: ${errorMsg.slice(0, 200)}\nTime: ${timestamp}`;

    await fetch(`${apiUrl}/messages/text`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: `${ADMIN_PHONE}@s.whatsapp.net`, body }),
    });
  } catch {
    // Don't let notification errors break anything
  }
}

async function logMessage(
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
  classification: string,
  householdId?: string,
  classificationData?: ClassificationOutput | null
) {
  try {
    const { error } = await supabase.from("whatsapp_messages").insert({
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
    if (error) {
      console.error("[logMessage] Supabase error:", error.message, error.details);
      await notifyAdmin("logMessage failed", error.message);
    }
  } catch (err) {
    console.error("[logMessage] Error:", err);
    await notifyAdmin("logMessage exception", String(err));
  }
}

async function upsertMemberMapping(householdId: string, phone: string, name: string) {
  try {
    // Skip the bot's own messages (phone matches the bot's number)
    const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "";
    if (phone === botPhone || phone === botPhone.replace("+", "")) return;

    // Skip if name is just a phone number (no real name from WhatsApp)
    if (/^\d+$/.test(name)) return;

    // Detect gender from name
    const memberGender = detectGender(name);

    // 1. Update phone→name→gender mapping
    const { error: mapErr } = await supabase.from("whatsapp_member_mapping").upsert(
      {
        household_id: householdId,
        phone_number: phone,
        member_name: name,
        gender: memberGender,
      },
      { onConflict: "household_id,phone_number" }
    );
    if (mapErr) console.error("[upsertMemberMapping] Supabase upsert error:", mapErr.message);

    // 2. Auto-add to household_members if not already there (so AI knows the family)
    const { data: existing } = await supabase
      .from("household_members")
      .select("id")
      .eq("household_id", householdId)
      .eq("display_name", name)
      .single();

    if (!existing) {
      const { error: memErr } = await supabase.from("household_members").insert({
        household_id: householdId,
        display_name: name,
        role: "member",
        gender: memberGender,
      });
      if (memErr) console.error("[upsertMemberMapping] household_members insert error:", memErr.message);
      else console.log(`[Members] Auto-added "${name}" (${memberGender || "unknown"}) to household ${householdId}`);
    } else if (memberGender && !existing) {
      // Update gender on existing member if we now know it
      await supabase.from("household_members").update({ gender: memberGender })
        .eq("household_id", householdId)
        .eq("display_name", name)
        .is("gender", null);
    }
  } catch (err) {
    console.error("[upsertMemberMapping] Error:", err);
  }
}

async function checkUsageLimit(householdId: string): Promise<{ allowed: boolean; count: number; isPaid: boolean }> {
  // Beta mode: skip usage limits for early testing families
  const betaMode = Deno.env.get("BETA_MODE");
  if (betaMode && betaMode !== "false" && betaMode !== "0") return { allowed: true, count: 0, isPaid: true };

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

// If a bot reply already contains the dashboard link, mark it as sent so the promo card never fires
async function maybeMarkDashboardMentioned(groupId: string, replyText: string) {
  if (!replyText || !groupId) return;
  if (replyText.includes("sheli.ai")) {
    await supabase
      .from("whatsapp_config")
      .update({ dashboard_link_sent: true })
      .eq("group_id", groupId);
  }
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

    // Must meet threshold: 10+ messages OR 24h since first message
    if (messageCount < 10 && hoursSinceFirst < 24) return;

    // Time-of-day guard: only send between 9AM-8PM Israel time
    const israelHour = new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem", hour: "numeric", hour12: false });
    const hour = parseInt(israelHour, 10);
    if (hour < 9 || hour >= 20) return;

    // Quiet-period guard: group must have been quiet for 2+ hours
    const { data: lastMsg } = await supabase
      .from("whatsapp_messages")
      .select("created_at")
      .eq("group_id", groupId)
      .neq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastMsg) {
      const hoursSinceLastMsg = (Date.now() - new Date(lastMsg.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastMsg < 2) return; // Group still active — wait
    }

    const lang = (config.language as string) || "he";
    const msg = lang === "he"
      ? `📊 רוצים לראות הכל במקום אחד?\nמטלות, קניות ואירועים — הכל בדשבורד אחד.\n🔗 sheli.ai?source=wa`
      : `📊 Want to see everything in one place?\nTasks, shopping, and events — all in one dashboard.\n🔗 sheli.ai?source=wa`;

    await provider.sendMessage({ groupId, text: msg });
    await supabase
      .from("whatsapp_config")
      .update({ dashboard_link_sent: true })
      .eq("group_id", groupId);
    console.log(`[Webhook] Dashboard link sent to group ${groupId} (msgs=${messageCount}, hours=${hoursSinceFirst.toFixed(1)}, quiet=2h+)`);
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

    const msg = `🎁 חברים מביאים חברים!\nאהבתם את שלי? שתפו עם חברים —\nשניכם מקבלים חודש פרימיום במתנה!\n\nשלחו את הקישור: sheli.ai/r/${hh.referral_code}`;

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

      const familyName = referredHh?.name || "בית חדש";
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

  const [membersRes, tasksRes, shoppingRes, patternsRes, rotationsRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to").eq("household_id", householdId).eq("done", false),
    supabase.from("shopping_items").select("id, name, qty").eq("household_id", householdId).eq("got", false),
    supabase.from("household_patterns").select("pattern_type, pattern_key, pattern_value")
      .eq("household_id", householdId).gte("confidence", 0.3)
      .order("hit_count", { ascending: false }).limit(20),
    supabase.from("rotations").select("title, type, members, current_index")
      .eq("household_id", householdId).eq("active", true),
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
    activeRotations: (rotationsRes.data || []).map((r: any) => ({
      title: r.title,
      type: r.type,
      members: typeof r.members === "string" ? JSON.parse(r.members) : r.members,
      current_index: r.current_index,
    })),
    today: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    dayOfWeek: hebrewDays[today.getDay()],
    familyPatterns,
  };
}

async function buildReplyCtx(householdId: string, chatType?: "group" | "direct", senderPhone?: string): Promise<ReplyContext> {
  const { data: household } = await supabase
    .from("households_v2").select("name, lang").eq("id", householdId).single();

  const [membersRes, tasksRes, shoppingRes, eventsRes, rotationsRes, botMsgsRes, memoriesRes, mappingRes] = await Promise.all([
    supabase.from("household_members").select("display_name, gender").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to, done").eq("household_id", householdId),
    supabase.from("shopping_items").select("id, name, qty, got").eq("household_id", householdId),
    supabase.from("events").select("id, title, assigned_to, scheduled_for").eq("household_id", householdId)
      .gte("scheduled_for", new Date().toISOString()),
    supabase.from("rotations").select("id, title, type, members, current_index, frequency")
      .eq("household_id", householdId).eq("active", true),
    supabase.from("whatsapp_messages")
      .select("message_text")
      .eq("household_id", householdId)
      .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
      .not("message_text", "is", null)
      .order("created_at", { ascending: false })
      .limit(5),
    (() => {
      // Scope-filter memories: group chat sees group-only, direct sees group + own direct
      let q = supabase.from("family_memories")
        .select("member_phone, memory_type, content, created_at, last_used_at")
        .eq("household_id", householdId)
        .eq("active", true)
        .lte("created_at", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString())
        .order("importance", { ascending: false })
        .limit(30);
      if (chatType === "group") {
        q = q.eq("scope", "group");
      } else if (chatType === "direct" && senderPhone) {
        q = q.or(`scope.eq.group,and(scope.eq.direct,member_phone.eq.${senderPhone})`);
      }
      return q;
    })(),
    supabase.from("whatsapp_member_mapping")
      .select("phone, display_name")
      .eq("household_id", householdId),
  ]);

  // Build gender map from household_members
  const memberGenders: Record<string, string> = {};
  for (const m of (membersRes.data || [])) {
    if (m.gender) {
      memberGenders[m.display_name] = m.gender;
    } else {
      // Fallback: detect from name if not stored
      const detected = detectGender(m.display_name);
      if (detected) memberGenders[m.display_name] = detected;
    }
  }

  // Build family memories string for Sonnet prompt injection
  let familyMemories = "";
  const memories = memoriesRes.data || [];
  if (memories.length > 0) {
    // Filter out memories used in the last 24 hours (cooldown)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const eligible = memories.filter((m: any) => !m.last_used_at || m.last_used_at < oneDayAgo);

    if (eligible.length > 0) {
      // Map member phones to display names
      const phoneName: Record<string, string> = {};
      for (const m of (mappingRes.data || [])) {
        if (m.phone && m.display_name) phoneName[m.phone] = m.display_name;
      }

      const lines = eligible.slice(0, 8).map((m: any) => {
        const who = m.member_phone ? (phoneName[m.member_phone] || m.member_phone) : "Household";
        const daysAgo = Math.floor((Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const timeLabel = daysAgo <= 7 ? `${daysAgo} days ago` : `${Math.floor(daysAgo / 7)} weeks ago`;
        return `- ${who}: ${m.content} (${timeLabel})`;
      });
      familyMemories = lines.join("\n");
    }
  }

  return {
    householdName: household?.name || "הבית",
    members: (membersRes.data || []).map((m) => m.display_name),
    memberGenders,
    language: household?.lang || "he",
    currentTasks: tasksRes.data || [],
    currentShopping: shoppingRes.data || [],
    currentEvents: eventsRes.data || [],
    currentRotations: (rotationsRes.data || []).map((r: any) => ({
      ...r,
      members: typeof r.members === "string" ? JSON.parse(r.members) : r.members,
    })),
    recentBotReplies: (botMsgsRes.data || []).map((m: any) => m.message_text),
    familyMemories,
  };
}

async function materializeDutyRotation(
  householdId: string,
  rotation: { id: string; title: string; members: any; current_index: number }
): Promise<{ taskId: string; assignedTo: string } | null> {
  const members = typeof rotation.members === "string" ? JSON.parse(rotation.members) : rotation.members;
  const assignedTo = members[rotation.current_index] || members[0];

  // Dedup: check if a task for this rotation already exists and is not done
  const { data: existing } = await supabase
    .from("tasks")
    .select("id")
    .eq("household_id", householdId)
    .eq("rotation_id", rotation.id)
    .eq("done", false);

  if (existing && existing.length > 0) {
    return null; // Already materialized and not done
  }

  const taskId = Math.random().toString(36).slice(2, 10);
  const { error } = await supabase.from("tasks").insert({
    id: taskId,
    household_id: householdId,
    title: rotation.title,
    assigned_to: assignedTo,
    done: false,
    rotation_id: rotation.id,
  });

  if (error) {
    console.error("[Rotation] Materialize error:", error);
    return null;
  }
  console.log(`[Rotation] Materialized duty task: "${rotation.title}" → ${assignedTo}`);
  return { taskId, assignedTo };
}

function haikuEntitiesToActions(classification: ClassificationOutput) {
  const e = classification.entities;
  const actions: Array<{ type: string; data: Record<string, unknown> }> = [];

  switch (classification.intent) {
    case "add_task":
      if (e.override) {
        actions.push({
          type: "override_rotation",
          data: { title: e.override.title, person: e.override.person },
        });
      } else if (e.rotation) {
        actions.push({
          type: "create_rotation",
          data: {
            title: e.rotation.title,
            rotation_type: e.rotation.type,
            members: e.rotation.members,
            frequency: e.rotation.frequency || null,
            start_person: e.rotation.start_person || null,
          },
        });
      } else {
        actions.push({
          type: "add_task",
          data: { title: e.title || e.raw_text, assigned_to: e.person || null },
        });
      }
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
      } else if (e.person) {
        // No task_id — might be claiming a rotation duty ("אני ארוקן מדיח")
        actions.push({ type: "claim_rotation_task", data: { raw_text: e.raw_text, assigned_to: e.person } });
      }
      break;

    case "add_reminder":
      // Reminders are handled via Sonnet's REMINDER block, not executeActions
      // But we push a placeholder so the flow doesn't treat it as "no actions"
      actions.push({ type: "add_reminder", data: { reminder_text: e.reminder_text || e.raw_text, time_raw: e.time_raw } });
      break;

    case "save_memory":
      actions.push({ type: "save_memory", data: { memory_content: e.memory_content, memory_about: e.memory_about } });
      break;
    case "recall_memory":
      actions.push({ type: "recall_memory", data: { memory_about: e.memory_about } });
      break;
    case "delete_memory":
      actions.push({ type: "delete_memory", data: {} });
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
      const result = await executeActions(householdId, actions, message.senderName);
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
    ? `היי ${getHouseholdNameCached(householdId) || "הבית"} 👋\nהשתמשתם ב-30 הפעולות החינמיות החודשיות שלכם.\nשדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה, 9.90 ₪ לחודש.\n🔗 ${paymentUrl}`
    : `Hey ${getHouseholdNameCached(householdId) || "family"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping — $2.70/month.\n🔗 ${paymentUrl}`;

  await provider.sendMessage({ groupId, text: upgradeMsg });
}
