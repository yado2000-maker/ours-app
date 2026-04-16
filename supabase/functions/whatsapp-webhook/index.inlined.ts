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
  reactionEmoji?: string;      // emoji used in reaction ("👍", "❤️", etc.)
  reactionTargetId?: string;   // whatsapp_message_id of the message being reacted to
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

interface SendResult {
  ok: boolean;
  messageId?: string;
}

interface WhatsAppProvider {
  name: string;
  verifyWebhook(req: Request): Promise<boolean>;
  parseIncoming(body: unknown): IncomingMessage | null;
  parseGroupEvent?(body: unknown): GroupEvent | null;
  sendMessage(msg: OutgoingMessage): Promise<SendResult>;
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
    | "delete_memory"
    | "add_expense"
    | "query_expense";
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
    // Patch D (Shira 2026-04-15): quote-reply completion signals.
    // items_from_quote: name list extracted from a bot shopping-add message when user
    // replies with "זה כבר קנינו"/"יש לנו"/"רק X חסר". Resolved to IDs in executeActions.
    // completion_scope: for "הושלם"/"המשימות הושלמו" replies — executor marks all open
    // tasks done since the quoted text doesn't carry IDs.
    items_from_quote?: string[];
    completion_scope?: "all_open" | "all_in_quote";
    // Expenses (v0)
    amount_text?: string;
    amount_minor?: number;
    expense_currency?: string;
    expense_description?: string;
    expense_category?: string;
    expense_attribution?: "speaker" | "named" | "joint" | "household";
    expense_paid_by_name?: string;
    expense_occurred_at_hint?: string;
    expense_visibility_hint?: "household" | "private";
    expense_query_type?: "summary" | "category_in_period";
    expense_query_category?: string;
    expense_query_period?: "this_month" | "last_month";
    expense_query_period_start?: string;
    expense_query_period_end?: string;
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
  // Patch D (Shira 2026-04-15): added complete_shopping_by_names + complete_tasks_all_open
  // for quote-reply completions where the executor resolves names/scopes to IDs via DB lookup.
  type: "add_task" | "add_shopping" | "add_event" | "complete_task" | "complete_shopping" | "add_reminder" | "assign_task" | "create_rotation" | "override_rotation" | "complete_shopping_by_names" | "complete_tasks_all_open" | "add_expense";
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

      // Extract reaction info — Whapi sends reactions as type:"action" with action.type:"reaction"
      // NOT as type:"reaction" with msg.reaction. See: support.whapi.cloud/help-desk/receiving/webhooks/incoming-webhooks-format
      const actionData = msg.action as Record<string, unknown> | undefined;
      const isReactionAction = actionData?.type === "reaction";
      const reactionEmoji = isReactionAction ? (actionData?.emoji as string | undefined) || undefined : undefined;
      const reactionTargetId = isReactionAction ? (actionData?.target as string | undefined) || undefined : undefined;

      // DEBUG: Log raw reaction payload on first encounters to confirm field names
      if (type === "action" || type === "reaction") {
        console.log(`[WhapiProvider] Action/Reaction payload:`, JSON.stringify({ type, action: msg.action, reaction: msg.reaction }));
      }

      // Map Whapi message types to our types
      // Whapi sends reactions as type:"action" with action.type:"reaction"
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
      const resolvedType: IncomingMessage["type"] = (type === "action" && isReactionAction) ? "reaction" : (typeMap[type] || "other");

      return {
        messageId: id,
        groupId,
        senderPhone: from.replace("@s.whatsapp.net", ""),
        senderName: fromName,
        text: text,
        type: resolvedType,
        timestamp,
        chatType,
        mediaUrl,
        mediaId,
        mediaDuration,
        quotedText: quotedText || undefined,
        reactionEmoji: reactionEmoji || undefined,
        reactionTargetId: reactionTargetId || undefined,
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

  async sendMessage(msg: OutgoingMessage): Promise<SendResult> {
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
      if (!res.ok) return { ok: false };
      try {
        const data = await res.json();
        return { ok: true, messageId: data?.message?.id || data?.sent?.id };
      } catch {
        return { ok: true }; // Sent but couldn't parse response
      }
    } catch (err) {
      console.error("[WhapiProvider] Send error:", err);
      return { ok: false };
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

  async sendMessage(msg: OutgoingMessage): Promise<SendResult> {
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
      if (!res.ok) return { ok: false };
      try {
        const data = await res.json();
        return { ok: true, messageId: data?.messages?.[0]?.id };
      } catch {
        return { ok: true };
      }
    } catch (err) {
      console.error("[MetaCloudProvider] Send error:", err);
      return { ok: false };
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
- add_task: Creating a chore/to-do. "צריך ל...", "[person] [activity] [time]", maintenance requests. Works for personal tasks ("לשלם חשבון") and shared chores. Includes cleaning (ניקיון, לנקות, לסדר), laundry (כביסה, קיפול, גיהוץ), kitchen chores (כלים, לשטוף, לפנות), trash (זבל, להוציא זבל), errands (לשלם, לשלוח, להתקשר, לתאם, להזמין), maintenance (לתקן, להחליף, לבדוק), kids/school (חוזה, טופס, שיעורי בית, להחתים). Multi-chore bursts (newline/comma list of chores) → classify first chore at conf 0.75 + needs_conversation_review: true so Sonnet can expand into all actions.
- add_event: Scheduling a specific date/time event. Appointments (רופא, רופא שיניים, וטרינר, ועדה), classes/activities (חוג, שיעור, אימון, חזרה, לימודים, הרצאה), meals out (ארוחה, ארוחת ערב, ארוחה משפחתית, ברביקיו), meetings (פגישה, ישיבה, שיחה), social (יום הולדת, חתונה, בר מצווה, ברית, מסיבה, אירוע), trips (טיול, נופש, טיסה, ביקור). Always has an implicit or explicit date/time. Multi-event bursts → classify first event + needs_conversation_review: true.
- complete_task: Marking an existing task as done. Past tense of open task, "סיימתי", "בוצע".
- complete_shopping: Confirming purchase of a list item. "קניתי", "יש", "לקחתי".
- question: Asking about current state (tasks, schedule, list). "מה צריך?", "מה ברשימה?", "מה יש היום?".
- claim_task: Self-assigning an existing open task. "אני אעשה", "אני לוקח/ת", "אני יכול".
- info_request: Asking for information that is NOT a household task. Passwords, phone numbers, prices, codes.
- correct_bot: User EXPLICITLY corrects Sheli's last action using clear correction language. MUST contain an explicit correction phrase from the whitelist below. Emoji-only reactions (🤦, 👎, 😤), quoted-reply with only emoji, bare "לא" alone, "אוף", sighs, and frustrated noises are NOT correct_bot — classify those as ignore.
- add_reminder: Setting a reminder for a future time. "תזכירי לי ב-4", "תזכרו אותי מחר", "בעוד שעה תזכירי", "remind me at 5". Also "תזכירי ל[person]..." (third-person — still add_reminder). Reminder triggers include: תזכירי, תזכיר, תזכרו, תזכרי לי, אל תשכחי להזכיר, תריצי לי תזכורת, remind me, don't let me forget. Must contain a time reference (hour, relative "בעוד X", day name, "מחר", "בערב", "בבוקר", "אחרי X"). For "לפני X" (before X), set time_iso to X minus ~1 hour buffer (NOT X itself). If the message references a time but NO day, and day could come from prior conversation, set needs_conversation_review: true so Sonnet can resolve from history. Multi-reminder in one message ("תזכירי לי ב-4 להתקשר ובעוד שעה לאסוף את הילדים") → classify first reminder + needs_conversation_review: true so Sonnet creates both.
- instruct_bot: Parent EXPLAINING a rule or management preference to Sheli. Teaching/explanatory tone — "ככה...", "אמרתי ש...", "את אמורה ל...", "צריך לנהל את זה ככה ש...". NOT a direct command — it's teaching how things should work. Frustration/repetition signals also indicate instruct_bot.
- save_memory: User asks Sheli to remember something specific. "תזכרי ש...", "תרשמי לך ש...", "אל תשכחי ש...". Must be a personal/family fact, NOT a task or reminder.
- recall_memory: User asks what Sheli remembers about someone or the family. "מה את זוכרת על...?", "מה ידוע לך על...?", "ספרי לי מה את יודעת על...".
- delete_memory: User asks Sheli to forget something. "תשכחי את זה", "תמחקי את הזיכרון", "אל תזכרי את זה יותר".
- add_expense: Logging a household payment/cost that ALREADY HAPPENED. Hebrew triggers include many forms:
  PAYMENT VERBS (past tense): "שילמתי/שילמנו/שולם/שילם/שילמה" (paid), "העברתי" (transferred), "הוצאתי/הוציא" (spent), "כיסיתי" (covered), "סגרתי" (closed/settled).
  COST VERBS (past tense): "עלה/עלתה לי/לנו X" (cost me/us X — PAST), "יצא לנו X" (came out to X), "ירד לי X" (was charged X).
  SLANG: "שרפתי X על Y" (burned X on Y), "הלכו X על Y" (X went on Y), "טסו X שקל" (X flew away), "נפל חשבון של X" (bill of X dropped), "חטפתי חשבון של X" (got hit with bill).
  FORMAL: "ביצעתי תשלום", "העברתי תשלום" (made/transferred payment).
  FINES/FEES: "דוח חניה X", "קנס של X", "דוח מהירות X" (parking/speeding ticket), "אגרה" (fee), "עמלה" (commission).
  COST-NOUN + NUMBER: "עלות התיקון 800", "עלות הביטוח 3200" (the cost of X was Y). But "עלויות" alone without a specific number = general complaint, ignore.
  BIG PURCHASES: "קניתי [non-grocery] ב-X" (bought [appliance/furniture/flights] for X).
  NOTE on "דוח": Hebrew homograph. "דוח חניה 250" = parking fine (expense). "כתבתי דוח" = wrote a report (ignore). Need fine-context OR amount to classify as expense.
  Must include an amount (number or Hebrew word). Category inferred from description.
  Attribution: speaker (שילמתי/עלה לי), named (אבא שילם), joint (שילמנו/עלה לנו/יצא לנו), household (שולם/נפל חשבון, passive voice).
  Multi-currency: default ILS. Recognize ALL these variants:
    ILS: שקל, שקלים, ש"ח, שח, ש״ח, ₪ (default when no currency mentioned)
    USD: דולר, דולרים, $
    EUR: יורו, אירו, €
    GBP: פאונד, לירה, £
    JPY: ין, yen, ¥
  KEY TENSE RULE: PAST = expense (שילמתי, עלה). PRESENT/general = ignore (עולה, המחיר). FUTURE = task (לשלם, צריך לשלם).
  NOT expense: "שילמתי עליו" (treating someone socially). "המשכנתא עולה X" (present tense = price statement). "לשלם חשמל" (future = task). "חלב ב-12 שקל" without "קניתי" (grocery = add_shopping). "הגיע חשבון של X" (bill arrived, not yet paid = ignore).
  CRITICAL "קניתי" RULES:
    RULE 1: "קניתי X ב-[amount]" = ALWAYS add_expense. Any item with a price is an expense report.
    RULE 2: "קניתי X" (no amount) = complete_shopping if X matches shopping list item, else ignore.
- query_expense: Asking about household spending. Triggers: "כמה שילמנו", "כמה הוצאנו", "כמה עלה לנו", "תסכמי הוצאות", "סיכום הוצאות", "מה ההוצאות". Has a period (this_month/last_month) and optional category.

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
- GROCERY VOCABULARY = add_shopping, always. Any list of food (vegetables, fruits, meat, fish, dairy, bread, grains, oils, spices, snacks, beverages, condiments, sweets, baking supplies), household staples (toilet paper, dish soap, cleaning supplies), or pantry items IS a shopping list. This is true regardless of:
  - Format: commas, newlines, numbered lines, bullet-free text — all valid shopping lists
  - Count: a single word ("אננס", "חלב", "לחם") is just as valid as a 15-item list
  - Quantities: "3 תפוזים", "2 ק״ג סולת", "חבילה של נקניקיות", "שק תפוחי אדמה" — numbers/quantities do NOT make it not-shopping; extract them into qty
  - Ethnic/regional foods: ג'ריש, סולת, מרגז, קובה, מלאווח, ג'חנון, חומוס, טחינה, זעתר, לאפה — all valid food items
  - Brand names: "פודינג וניל אוסם", "במבה אסם", "קוטג' תנובה" — valid single items
  When you see a message that is primarily a list of recognizable foods/groceries/household items with no other clear intent → add_shopping. Lean toward shopping (high recall) unless the message is clearly social, a question, or a BRINGING/ALREADY-HAVE statement (see rule below).
- TASK VOCABULARY = add_task. Chore/errand words signal tasks even without "צריך" / "תוסיפי" prefixes. Examples:
  - Cleaning/tidying: ניקיון, לנקות, לסדר, לשטוף רצפה, לאבק, לשאוב, למרק, לארגן
  - Laundry: כביסה, לכבס, לתלות כביסה, לקפל, קיפול, גיהוץ, לגהץ
  - Kitchen: כלים, לשטוף כלים, לרוקן מדיח, לטעון מדיח, לפנות שולחן
  - Trash: זבל, להוציא זבל, להחליף שקית
  - Errands: לשלם חשבון, לשלוח חבילה, להתקשר ל-, לתאם, להזמין, לקבוע תור
  - Maintenance: לתקן, להחליף נורה, לבדוק, להרכיב
  - Kids/school: להחתים טופס, שיעורי בית, לקנות ציוד, חוזה גן, לאסוף מ-
  - Format: a single chore ("לסדר ארון"), a newline list of chores, a comma list — all valid tasks.
  - MULTI-CHORE BURST (newline list like "ניקיון סלון\nקיפול כביסה\nהוצאת זבל"): classify as add_task at confidence 0.75 with FIRST chore in entities + "needs_conversation_review": true. Sonnet will expand all chores into separate actions.
- EVENT VOCABULARY = add_event. Scheduled appointments/activities/meetings. Signals: a time reference (day, date, hour) + one of:
  - Appointments: רופא, רופא שיניים, רופאת נשים, וטרינר, ועדה, ראיון, תור ל-
  - Classes/activities: חוג, שיעור (פסנתר, דרמה, קרטה...), אימון, חזרה, לימודים, הרצאה, סדנה, פגישת הורים
  - Meals out: ארוחת ערב אצל, ארוחה משפחתית, ברביקיו, מנגל, פיקניק
  - Meetings: פגישה, ישיבה, שיחה עם-, זום, call
  - Social: יום הולדת, חתונה, בר מצווה, ברית, חינה, מסיבה, אירוע, מפגש
  - Trips: טיול, נופש, טיסה, ביקור אצל-, סוף שבוע ב-
  - Format: single event ("יום שלישי רופא שיניים 15:00"), newline list of events across the week, "השבוע: שלישי... חמישי..." — all valid.
  - MULTI-EVENT BURST (e.g., "שלישי רופא שיניים 15\nחמישי חוג גיטרה 17\nשבת יום הולדת"): classify as add_event at confidence 0.75 with FIRST event in entities + "needs_conversation_review": true. Sonnet expands all events.
- REMINDER VOCABULARY = add_reminder. ANY message starting with / containing תזכירי / תזכיר / תזכרו / תזכירי לי / remind me / don't forget + a TIME reference → add_reminder. The triggers are explicit — don't miss them. Distinguish from add_task: task = persistent chore; reminder = one-shot time-based nudge. If both trigger and time are present, it's a reminder.
  - Time-only reminders ("תזכירי לי ב-4 להתקשר") = add_reminder, conf 0.95.
  - Third-person reminders ("תזכירי לאסנת לעשות רשימה") = add_reminder (NOT add_task). reminder_text should include the target name ("אסנת — לעשות רשימה").
  - Multi-reminder in one message ("תזכירי לי ב-4 להתקשר ובעוד שעה לאסוף את הילדים") → classify as add_reminder with FIRST reminder in entities + "needs_conversation_review": true. Sonnet creates both.
- Bare noun ("חלב") = add_shopping
- "[person] [activity] [time]" ("נועה חוג 5") = add_task
- Personal tasks ("לשלם חשמל", "לתקן ברז", "לקנות מתנה") = add_task
- "מי [verb]?" = question (not add_task)
- "מה ברשימה?" / "מה צריך לקנות?" = question (in 1:1 or group)
- "אני [verb]" matching an open task = claim_task
- Past tense matching open task ("שטפתי כלים") = complete_task
- "קניתי X" / "יש X" matching shopping item = complete_shopping
- QUOTE-REPLY TO BOT SHOPPING-ADD: When the quoted message is a bot shopping confirmation starting with "🛒 הוספתי..." or listing items bot just added, and the reply says "זה כבר קנינו", "כבר קנינו", "כבר קניתי", "יש לנו בבית", "יש כבר", "לקחתי", "זה יש" → complete_shopping with the items from the QUOTED message. Extract the item names from the quote into entities.items_from_quote (array of names). Do NOT emit add_shopping.
- QUOTE-REPLY completion ("הושלם", "בוצע", "סיימתי", "טיפלתי") to a bot message listing TASKS = complete_task with all task_ids from the quoted text. Mark ALL tasks in the quote as done unless the reply excludes specific ones.
- "המשימות הושלמו" / "כל המשימות הושלמו" (plural passive past) = complete_task with all currently open task_ids. Same for "הושלם" standalone reply to a task-list message from the bot.
- "רק X חסר/נשאר" (only X is missing/left) in reply to a bot shopping-list message = complete_shopping for every item EXCEPT X in the quoted list. This is "we did everything except X" — Shira's 2026-04-15 pattern.
- Greetings, emojis, reactions, "סבבה", "אמן", "בהצלחה" = ignore
- When conversation history shows a NEGATIVE REACTION (reacted 😂/🤦/👎 to שלי) to Sheli's previous message, the NEXT user message is likely a correction or clarification. Lean toward correct_bot or re-classify with higher attention.
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

SHOPPING CATEGORIES (ALWAYS assign one). Categories MUST match this exact list — do NOT invent categories.
- פירות וירקות: מלפפון, עגבניה, בצל, בצל לבן, בצל סגול, שום, לימון, תפוח, בננה, אבוקדו, פטרוזיליה, כוסברה, נענע, חסה, גזר, פלפל, פלפל חריף, תפוח אדמה, בטטה, קולרבי, צנונית, ברוקולי, כרובית, חציל, קישוא, דלעת, תירס, אפונה, שעועית, פירות יבשים, תמרים, ענבים, תות, אפרסק, שזיף, אגס, מנגו, רימון, אננס, אשכולית, קלמנטינה, נקטרינה, פטריות, כרוב, כרוב סגול, סלק, לפת, שומר, חסה רומית, רוקט, תרד, בצלצל ירוק, שמיר, בזיליקום, רוזמרין, ג'ינג'ר, כורכום, ליים
- חלב וביצים: חלב, ביצים, גבינה צהובה, גבינה לבנה, קוטג', שמנת, שמנת מתוקה, שמנת חמוצה, יוגורט, לבן (dairy), חמאה, שוקו, מעדן, פודינג, גבינת שמנת, מסקרפונה, ריקוטה, מוצרלה, פרמז'ן, גבינת עיזים, בולגרית, לאבנה, טופו, חלב סויה, חלב אורז, חלב שקדים, חלב שיבולת שועל, חלב קוקוס, שמנת קוקוס
- בשר ודגים: עוף, בקר, טחון, בשר טחון, שניצל, נקניקיות, נקניק, סלמון, טונה, דגים, שוקיים, כנפיים, סטייק, קבב, המבורגר, כבש, הודו, בייקון, פסטרמה, סושי, נתחי חזה, פילה, קציצות, אנטריקוט, צלעות
- מאפים: לחם, לחם לבן, לחם מלא, לחם שיפון, לחם אחיד, פיתות, לחמניות, חלה, באגט, טורטיה, עוגיות, עוגה, קרואסון, מאפינס, לחמניות המבורגר, לחם פרוס, מלאווח, ג'חנון, לאפה, פוקצ'ה
- מזווה: אורז, פסטה, שמן זית, שמן קנולה, שמן, חומוס, טחינה, רסק עגבניות, קטשופ, חרדל, מלח, פלפל שחור, סוכר, סוכר חום, סוכר דמררה, קמח, קמח לבן, קמח מלא, קמח לא תופח, תבלינים, שימורים, חמאת בוטנים, דבש, ריבה, קורנפלקס, גרנולה, אגוזים, פקאנים, שקדים, אגוזי מלך, חומץ, חומץ בלסמי, רוטב סויה, רוטב צ'ילי, פפריקה, כמון, כורכום, קינמון, זעתר, סומק, שומשום, אבקת אפיה, סודה לשתייה (baking soda), וניל, תמצית וניל, שוקולד מריר, שוקולד לבן, קקאו, קוסקוס, בורגול, קטניות, עדשים, חומוס יבש, פירורי לחם, סולת, ג'ריש, קוואקר, שיבולת שועל, מייפל, סילאן, עגבניות מיובשות, זיתים, חמוצים, מלפפון חמוץ, טונה בשימורים, תירס בשימורים, רוטב פסטו
- מוצרים קפואים: שלגונים, ארטיק, גלידה, פיצה קפואה, ירקות קפואים, בורקס, מאפים קפואים, בצק עלים, שניצל קפוא
- משקאות: מים, מים מינרליים, סודה (sparkling water), מיץ, מיץ תפוזים, בירה, יין, קולה, ספרייט, 7אפ, אייס טי, קפה, תה, קפסולות קפה, קפה טורקי, נס קפה, תה ירוק, לימונדה, משקה אנרגיה
- ניקוי ובית: סבון כלים, אבקת כביסה, נוזל כביסה, מרכך כביסה, אקונומיקה, נייר טואלט, מגבונים, שקיות זבל, נייר סופג, ספוגים, סבון ידיים, מטליות, אלומיניום, ניילון נצמד, שקיות פריזר, מטהר אוויר, נרות, מצתים, סוללות, קיסמי אוזניים, קיסמי שיניים, קיסמים
- מוצרים מחנות הטבע: קמח כוסמין, קמח שקדים, שמרי בירה, ספירולינה, אצות, טחינה גולמית, דבש גולמי, חלבון, גרעיני צ'יה, גרעיני פשתן, שמן קוקוס, גי, חמאת שקדים
- טיפוח: שמפו, מרכך שיער, סבון גוף, דאודורנט, קרם לחות, קרם שיזוף, משחת שיניים, מברשת שיניים, תחבושות, סכיני גילוח, קרם ידיים, קרם פנים, תחליב גוף
- אחר: מזון לכלבים, מזון לחתולים, חול לחתולים — use ONLY when no other category fits

CATEGORY DISAMBIGUATION — common mistakes:
- "סודה לשתייה" = baking soda → מזווה (NOT משקאות!)
- "סודה" alone in a baking context (with קמח/סוכר/שוקולד) → מזווה
- "סודה" alone in a drinks context (with בירה/מיץ/יין) → משקאות (sparkling water)
- "קיסמי אוזניים" = cotton swabs → ניקוי ובית (NOT טיפוח)
- "נרות", "מצתים", "סוללות" → ניקוי ובית (household supplies)
- NOT valid categories: "בשר", "חמוצים", "מוצרי חלב", "ירקות" — use the exact names above

CRITICAL — Hebrew "לבן" disambiguation:
- "לבן" alone = dairy product (חלב וביצים)
- "בצל לבן" = white onion → פירות וירקות (NOT dairy!)
- "קמח לבן" = white flour → מזווה (NOT dairy!)
- "לחם לבן" = white bread → מאפים (NOT dairy!)
- "גבינה לבנה" = white cheese → חלב וביצים (dairy, correct)
- Rule: when "לבן/לבנה" follows a non-dairy noun, it means "white" (color), NOT the dairy product.

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

STORE-SPECIFIC CATEGORIES:
When the user mentions a specific store, use the STORE NAME as the category for those items.
Strip the preposition (מ/מה/ב) from the store name.

Known Israeli stores and their category behavior:
- 🛒 General supermarkets (use standard product categories, NOT store name): שופרסל, פוליצר, רמי לוי, יוחננוף, חצי חינם, קשת טעמים, טיב טעם, מגה, ויקטורי, אושר עד, שוק
  → "משופרסל חלב ולחם" → category: חלב וביצים / מאפים (standard categories, not "שופרסל")
  → Supermarket names are just WHERE to buy, not a meaningful grouping
- 💊 Pharmacy/drugstore (category: "סופר פארם" or store name): סופר פארם, בי, פארם גרופ, Super-Pharm
  → "מסופר פארם, שמפו וסבון" → category: "סופר פארם" for both
- 🌿 Organic/specialty (category: store name): ניצת הדובדבן, אדונית התבלינים, תבלינים ועוד
  → "מניצת הדובדבן, טחינה וגרנולה" → category: "ניצת הדובדבן" for both
- 🏪 Other specific stores (category: store name): מכולת, מחסני חשמל, איקאה, ACE, הום סנטר, etc.
  → "מאיקאה, מדף ומנורה" → category: "איקאה" for both

Items without a store context: use standard categories (פירות וירקות, חלב וביצים, etc.)

SHOPPING ITEM CLEANUP — strip these from item names:
- Greetings: "היי שלי", "שלום", "בוקר טוב" → NOT items, ignore them
- Preamble phrases: "אני צריך/ה לקנות X", "צריך לקנות X", "תוסיפי X", "תכניסי X" → extract only X
- Store references: "מ[חנות]" → extract store as category, extract items separately
- "תודה", "בבקשה", "please" → NOT items, ignore
- Voice transcription artifacts: filler words, repeated phrases → clean up
- Each item name should be the PRODUCT ONLY — "חלב" not "אני צריכה לקנות חלב"

TYPO RECOGNITION (within a single message):
When the user lists multiple items in one message, recognize obvious typos and treat them as ONE item, not separate ones.
- "חסה, מלפפונים, מלפפוץ" → "מלפפוץ" is a typo of "מלפפונים" (final ץ instead of ן). Extract: ["חסה", "מלפפונים"]. Do NOT add "מלפפוץ" as a separate item.
- "אבוקדו, אבוקדן" → typo, extract ONE: ["אבוקדו"].
- "גבינה, גבונה" → typo, extract ONE: ["גבינה"].
- Common Hebrew typo patterns: terminal letter swaps (ן↔ץ↔ם↔ף↔ך), repeated letters, voice-transcription artifacts, missing/extra final ה.
- When in doubt (the items might be intentionally different), keep them separate. Only merge when it's CLEARLY a typo of an item already mentioned in the same message.

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
- EXPENSE FOLLOW-UP: If the bot just asked "כמה עלה ה[X]?" (asking for expense amount) and the user replies with JUST A NUMBER (e.g. "1300", "1300 שקל", "250"), classify as add_expense with the DESCRIPTION from the bot's question. Example: bot asked "כמה עלה החשמל?" → user says "1300" → add_expense with expense_description="חשמל", amount_text="1300".
  Example: "גור יש רק 7אפ" = telling Gur something, not requesting the bot.
- Only classify as actionable when the sender is clearly REQUESTING the bot to act.
- Messages that riff on/respond to a shared link or media (even if they sound like tasks) = social commentary → ignore.
  Example: (after a TikTok about money mistakes) "ואני מוסיף: להשאיר אור בסטודיו" = joke, NOT a task.
- These rules apply to ALL entity types: shopping, tasks, and events.
- If you are uncertain whether a message is a request or just conversation, set confidence: 0.55 and needs_conversation_review: true.
- AMBIGUOUS NOUN PHRASES: A bare noun phrase that describes a SPECIFIC physical object (not a common grocery item) — like a notebook, gift, clothing item, or school supply — could be shopping, a task, a reminder, or just social chatter. When the phrase has NO verb and is NOT a clearly recognizable supermarket/grocery item (milk, bread, eggs, fruits, vegetables, cleaning supplies), set confidence: 0.55 and needs_conversation_review: true. Let Sonnet ask the user what they meant. Common groceries (חלב, ביצים, אננס, נייר טואלט, etc.) are still high-confidence add_shopping.
` : ""}HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday
ISRAEL WEEK: Sunday (ראשון) is the FIRST work day, NOT weekend. Weekend in Israel = Friday + Saturday ONLY. Never call Sunday "סוף השבוע".

EXAMPLES:
[אמא]: "בוקר טוב!" → {"intent":"ignore","confidence":0.99,"entities":{"raw_text":"בוקר טוב!"}}
[אבא]: "חלב" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב","category":"חלב וביצים"}],"raw_text":"חלב"}}
[אמא]: "חלב אורז" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב אורז","category":"חלב וביצים"}],"raw_text":"חלב אורז"}}
[אבא]: "נייר טואלט וסבון כלים" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"נייר טואלט","category":"ניקוי ובית"},{"name":"סבון כלים","category":"ניקוי ובית"}],"raw_text":"נייר טואלט וסבון כלים"}}
[אמא]: "תוסיפי חלב" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב","category":"חלב וביצים"}],"raw_text":"תוסיפי חלב"}}
[אבא]: "תכניסי לרשימה מלפפונים במלח גודל קטן" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"מלפפונים במלח גודל קטן","category":"מזווה"}],"raw_text":"תכניסי לרשימה מלפפונים במלח גודל קטן"}}
[אמא]: "תוסיפי חלב שיבולת שועל נטול סוכר" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב שיבולת שועל נטול סוכר","category":"חלב וביצים"}],"raw_text":"תוסיפי חלב שיבולת שועל נטול סוכר"}}
[אסנת]: "אננס" → {"intent":"add_shopping","confidence":0.90,"entities":{"items":[{"name":"אננס","category":"פירות וירקות"}],"raw_text":"אננס"}}
[אמא]: "קוטג תנובה" → {"intent":"add_shopping","confidence":0.90,"entities":{"items":[{"name":"קוטג תנובה","category":"מוצרי חלב"}],"raw_text":"קוטג תנובה"}}
[אבא]: "חלב תנובה 3%" → {"intent":"add_shopping","confidence":0.90,"entities":{"items":[{"name":"חלב תנובה 3%","category":"מוצרי חלב"}],"raw_text":"חלב תנובה 3%"}}
[אסנת]: "3 תפוזים" → {"intent":"add_shopping","confidence":0.92,"entities":{"items":[{"name":"תפוזים","qty":"3","category":"פירות וירקות"}],"raw_text":"3 תפוזים"}}
[אסנת]: "שוקולד לעוגה" → {"intent":"add_shopping","confidence":0.90,"entities":{"items":[{"name":"שוקולד לעוגה","category":"מזווה"}],"raw_text":"שוקולד לעוגה"}}
[אסנת]: "עגבניה\nמלפפון\nכוסברה 3\nפטרוזיליה 4\nשמיר 2\nשרי\nסלרי 2\nסלק ירוק 2\nסלק אדום מוכן ורגיל\nגזר\nתפוחי אדמה 2 שקים\nבצל הרבה" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"עגבניה","category":"פירות וירקות"},{"name":"מלפפון","category":"פירות וירקות"},{"name":"כוסברה","qty":"3","category":"פירות וירקות"},{"name":"פטרוזיליה","qty":"4","category":"פירות וירקות"},{"name":"שמיר","qty":"2","category":"פירות וירקות"},{"name":"שרי","category":"פירות וירקות"},{"name":"סלרי","qty":"2","category":"פירות וירקות"},{"name":"סלק ירוק","qty":"2","category":"פירות וירקות"},{"name":"סלק אדום מוכן ורגיל","category":"פירות וירקות"},{"name":"גזר","category":"פירות וירקות"},{"name":"תפוחי אדמה 2 שקים","category":"פירות וירקות"},{"name":"בצל הרבה","category":"פירות וירקות"}],"raw_text":"עגבניה\nמלפפון\nכוסברה 3\nפטרוזיליה 4\nשמיר 2\nשרי\nסלרי 2\nסלק ירוק 2\nסלק אדום מוכן ורגיל\nגזר\nתפוחי אדמה 2 שקים\nבצל הרבה"}}
[אסנת]: "זיתים מגולענים רק אם מחיר טוב\nקמח" → {"intent":"add_shopping","confidence":0.90,"entities":{"items":[{"name":"זיתים מגולענים (רק אם מחיר טוב)","category":"מזווה"},{"name":"קמח","category":"מזווה"}],"raw_text":"זיתים מגולענים רק אם מחיר טוב\nקמח"}}
[אסנת]: "ג'ריש 2 ק\"ג\n2 סולת" → {"intent":"add_shopping","confidence":0.92,"entities":{"items":[{"name":"ג'ריש","qty":"2 ק\"ג","category":"מזווה"},{"name":"סולת","qty":"2","category":"מזווה"}],"raw_text":"ג'ריש 2 ק\"ג\n2 סולת"}}
[אסנת]: "חומוס\nחבילה של נקניקיות\nמרגז 1" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חומוס","category":"מזווה"},{"name":"נקניקיות","qty":"חבילה","category":"בשר ודגים"},{"name":"מרגז","qty":"1","category":"בשר ודגים"}],"raw_text":"חומוס\nחבילה של נקניקיות\nמרגז 1"}}
[אסנת]: "קורנפלור\nאם יש פודינג וניל 1 ק\"ג אוסם" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"קורנפלור","category":"מזווה"},{"name":"פודינג וניל 1 ק\"ג אוסם (אם יש)","category":"חלב וביצים"}],"raw_text":"קורנפלור\nאם יש פודינג וניל 1 ק\"ג אוסם"}}
[אמא]: "נועה חוג 5" → {"intent":"add_task","confidence":0.90,"entities":{"person":"נועה","title":"חוג","time_raw":"5","raw_text":"נועה חוג 5"}}
[אבא]: "לסדר את הארון בסלון" → {"intent":"add_task","confidence":0.88,"entities":{"title":"לסדר את הארון בסלון","raw_text":"לסדר את הארון בסלון"}}
[אמא]: "להחליף נורה בחדר של נועה" → {"intent":"add_task","confidence":0.88,"entities":{"title":"להחליף נורה בחדר של נועה","raw_text":"להחליף נורה בחדר של נועה"}}
[אמא]: "ניקיון סלון\nקיפול כביסה\nהוצאת זבל" → {"intent":"add_task","confidence":0.75,"needs_conversation_review":true,"entities":{"title":"ניקיון סלון","raw_text":"ניקיון סלון\nקיפול כביסה\nהוצאת זבל"}}
[אבא]: "צריך לקנות מתנה ליום הולדת, לתאם עם המורה, ולשלם חשבון חשמל" → {"intent":"add_task","confidence":0.75,"needs_conversation_review":true,"entities":{"title":"לקנות מתנה ליום הולדת","raw_text":"צריך לקנות מתנה ליום הולדת, לתאם עם המורה, ולשלם חשבון חשמל"}}
[אבא]: "שטפתי את הכלים" → {"intent":"complete_task","confidence":0.95,"entities":{"task_id":"t1a2","raw_text":"שטפתי את הכלים"}}
[אמא]: "שטפתי כלים" → {"intent":"complete_task","confidence":0.90,"entities":{"raw_text":"שטפתי כלים"}}
[אבא]: "לפרוק מדיח" → {"intent":"add_task","confidence":0.88,"entities":{"title":"לפרוק מדיח","raw_text":"לפרוק מדיח"}}
[אמא]: "מה צריך מהסופר?" → {"intent":"question","confidence":0.95,"entities":{"raw_text":"מה צריך מהסופר?"}}
[אבא]: "תור מי?" → {"intent":"question","confidence":0.90,"addressed_to_bot":true,"entities":{"raw_text":"תור מי?"}}
[נועה]: "אני אסדר את הארון" → {"intent":"claim_task","confidence":0.90,"entities":{"person":"נועה","task_id":"t5c6","raw_text":"אני אסדר את הארון"}}
[אבא]: "אני אעשה את הכלים" → {"intent":"claim_task","confidence":0.88,"entities":{"raw_text":"אני אעשה את הכלים"}}
[אמא]: "יום שלישי ארוחת ערב אצל סבתא" → {"intent":"add_event","confidence":0.92,"entities":{"title":"ארוחת ערב אצל סבתא","time_raw":"יום שלישי","raw_text":"יום שלישי ארוחת ערב אצל סבתא"}}
[אבא]: "יש לנו ארוחת ערב מחר ב-19" → {"intent":"add_event","confidence":0.90,"entities":{"title":"ארוחת ערב","time_raw":"מחר ב-19","raw_text":"יש לנו ארוחת ערב מחר ב-19"}}
[אמא]: "מחר בערב סבא וסבתא" → {"intent":"add_event","confidence":0.85,"entities":{"title":"סבא וסבתא","time_raw":"מחר בערב","raw_text":"מחר בערב סבא וסבתא"}}
[אבא]: "יש לנו רופא ביום רביעי" → {"intent":"add_event","confidence":0.88,"entities":{"title":"רופא","time_raw":"יום רביעי","raw_text":"יש לנו רופא ביום רביעי"}}
[אמא]: "רופא שיניים לנועה יום שלישי ב-15:00" → {"intent":"add_event","confidence":0.92,"entities":{"title":"רופא שיניים לנועה","time_raw":"יום שלישי ב-15:00","person":"נועה","raw_text":"רופא שיניים לנועה יום שלישי ב-15:00"}}
[אבא]: "חוג גיטרה של יובל יום חמישי 17:00" → {"intent":"add_event","confidence":0.92,"entities":{"title":"חוג גיטרה","time_raw":"יום חמישי 17:00","person":"יובל","raw_text":"חוג גיטרה של יובל יום חמישי 17:00"}}
[אמא]: "השבוע:\nשלישי רופא שיניים 15\nחמישי חוג גיטרה 17\nשבת יום הולדת אצל סבתא" → {"intent":"add_event","confidence":0.75,"needs_conversation_review":true,"entities":{"title":"רופא שיניים","time_raw":"שלישי 15","raw_text":"השבוע:\nשלישי רופא שיניים 15\nחמישי חוג גיטרה 17\nשבת יום הולדת אצל סבתא"}}
[אבא]: "תזכירי לי ב-4 להתקשר לרופא ובעוד שעה לאסוף את הילדים" → {"intent":"add_reminder","confidence":0.80,"needs_conversation_review":true,"entities":{"reminder_text":"להתקשר לרופא","time_raw":"ב-4","raw_text":"תזכירי לי ב-4 להתקשר לרופא ובעוד שעה לאסוף את הילדים"}}
[יונתן]: "מה הסיסמא של הוויי פיי?" → {"intent":"info_request","confidence":0.95,"entities":{"raw_text":"מה הסיסמא של הוויי פיי?"}}
[אמא]: "קניתי חלב וביצים" → {"intent":"complete_shopping","confidence":0.95,"entities":{"item_id":"s1a2","raw_text":"קניתי חלב וביצים"}}
[שירה]: "[הודעה מצוטטת: \"🛒 הוספתי קורנפלור, בירה וצלופן לרשימה\"]\nזה כבר קנינו היום" → {"intent":"complete_shopping","confidence":0.92,"addressed_to_bot":true,"entities":{"items_from_quote":["קורנפלור","בירה","צלופן"],"raw_text":"זה כבר קנינו היום"}}
[אמא]: "[הודעה מצוטטת: \"🛒 הוספתי חלב וביצים לרשימה\"]\nיש לנו בבית" → {"intent":"complete_shopping","confidence":0.90,"addressed_to_bot":true,"entities":{"items_from_quote":["חלב","ביצים"],"raw_text":"יש לנו בבית"}}
[שירה]: "[הודעה מצוטטת: \"המשימות: הזמנת גז, הכנת רוטב טרייקי\"]\nהושלם" → {"intent":"complete_task","confidence":0.92,"addressed_to_bot":true,"entities":{"raw_text":"הושלם","completion_scope":"all_in_quote"}}
[שירה]: "המשימות הושלמו" → {"intent":"complete_task","confidence":0.90,"addressed_to_bot":true,"entities":{"raw_text":"המשימות הושלמו","completion_scope":"all_open"}}
[שירה]: "[הודעה מצוטטת: \"🛒 הוספתי קורנפלור, בירה, צלופן, מלח לימון לרשימה\"]\nרק המלח לימון חסר" → {"intent":"complete_shopping","confidence":0.88,"addressed_to_bot":true,"entities":{"items_from_quote":["קורנפלור","בירה","צלופן"],"raw_text":"רק המלח לימון חסר"}}
[אמא]: "התכוונתי לשמן זית, לא לשמן וזית" → {"intent":"correct_bot","confidence":0.95,"entities":{"correction_text":"שמן זית","raw_text":"התכוונתי לשמן זית, לא לשמן וזית"}}
[אבא]: "שלי טעית, זה דבר אחד" → {"intent":"correct_bot","confidence":0.90,"entities":{"correction_text":"","raw_text":"שלי טעית, זה דבר אחד"}}
[אמא]: "לא נכון, אמרתי גבינה לבנה ולא צהובה" → {"intent":"correct_bot","confidence":0.92,"entities":{"correction_text":"גבינה לבנה","raw_text":"לא נכון, אמרתי גבינה לבנה ולא צהובה"}}
[אבא]: "I meant olive oil, not sunflower" → {"intent":"correct_bot","confidence":0.92,"entities":{"correction_text":"olive oil","raw_text":"I meant olive oil, not sunflower"}}
[אמא]: "לא שמן, קנולה" → {"intent":"correct_bot","confidence":0.88,"entities":{"correction_text":"קנולה","raw_text":"לא שמן, קנולה"}}
[אסנת]: "🤦🏼‍♀️🤦🏼‍♀️🤦🏼‍♀️" → {"intent":"ignore","confidence":0.90,"entities":{"raw_text":"🤦🏼‍♀️🤦🏼‍♀️🤦🏼‍♀️"}}
[אבא]: "👎" → {"intent":"ignore","confidence":0.92,"entities":{"raw_text":"👎"}}
[אמא]: "אוף" → {"intent":"ignore","confidence":0.90,"entities":{"raw_text":"אוף"}}
[אבא]: "לא" → {"intent":"ignore","confidence":0.80,"entities":{"raw_text":"לא"}}
[אסנת]: "[הודעה מצוטטת: \"🛒 הוספתי קורנפלור ופודינג וניל לרשימה\"]\n🤦🏼‍♀️🤦🏼‍♀️🤦🏼‍♀️" → {"intent":"ignore","confidence":0.88,"entities":{"raw_text":"🤦🏼‍♀️🤦🏼‍♀️🤦🏼‍♀️"}}
[אמא]: "גזר, מלפפון, בצל, שום, תפוחים, יוגורט, קפה טחון, תפוח אדמה, לחמניות, חומוס" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"גזר","category":"פירות וירקות"},{"name":"מלפפון","category":"פירות וירקות"},{"name":"בצל","category":"פירות וירקות"},{"name":"שום","category":"פירות וירקות"},{"name":"תפוחים","category":"פירות וירקות"},{"name":"יוגורט","category":"חלב וביצים"},{"name":"קפה טחון","category":"משקאות"},{"name":"תפוח אדמה","category":"פירות וירקות"},{"name":"לחמניות","category":"מאפים"},{"name":"חומוס","category":"מזווה"}],"raw_text":"גזר, מלפפון, בצל, שום, תפוחים, יוגורט, קפה טחון, תפוח אדמה, לחמניות, חומוס"}}
[אמא]: "תזכירי לי ב-4 לאסוף את הילדים" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לאסוף את הילדים","time_raw":"ב-4","raw_text":"תזכירי לי ב-4 לאסוף את הילדים"}}
[אבא]: "תזכירי אותי לשלם ארנונה" → {"intent":"add_reminder","confidence":0.88,"addressed_to_bot":true,"entities":{"reminder_text":"לשלם ארנונה","raw_text":"תזכירי אותי לשלם ארנונה"}}
[אבא]: "בעוד שעה תזכירי לקחת את הכביסה" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לקחת את הכביסה","time_raw":"בעוד שעה","raw_text":"בעוד שעה תזכירי לקחת את הכביסה"}}
[אבא]: "תזכירי לאמא להביא חלב מחר ב-10" → {"intent":"add_reminder","confidence":0.92,"addressed_to_bot":true,"entities":{"reminder_text":"אמא — להביא חלב","time_raw":"מחר ב-10","raw_text":"תזכירי לאמא להביא חלב מחר ב-10"}}
[אמא]: "תזכירי לי לפני השעה 16 לעשות קניות" → {"intent":"add_reminder","confidence":0.92,"addressed_to_bot":true,"entities":{"reminder_text":"לעשות קניות","time_raw":"לפני השעה 16","raw_text":"תזכירי לי לפני השעה 16 לעשות קניות"}}
[אמיתי]: "ותזכיר לאסנת לעשות רשימה לפני 16" → {"intent":"add_reminder","confidence":0.80,"addressed_to_bot":true,"needs_conversation_review":true,"entities":{"reminder_text":"אסנת — לעשות רשימה","time_raw":"לפני 16","raw_text":"ותזכיר לאסנת לעשות רשימה לפני 16"}}
[אמא]: "תורות מקלחת: דניאל ראשון, נועה, יובל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["דניאל","נועה","יובל"]},"raw_text":"תורות מקלחת: דניאל ראשון, נועה, יובל"}}
[אבא]: "תורנות כלים: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"כלים","type":"duty","members":["נועה","יובל","דניאל"]},"raw_text":"תורנות כלים: נועה, יובל, דניאל"}}
[אמא]: "סדר מקלחות: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["נועה","יובל","דניאל"]},"raw_text":"סדר מקלחות: נועה, יובל, דניאל"}}
[אבא]: "מי בתור למקלחת?" → {"intent":"question","confidence":0.90,"entities":{"raw_text":"מי בתור למקלחת?"}}
[אמא]: "מי בתור" → {"intent":"question","confidence":0.88,"addressed_to_bot":true,"entities":{"raw_text":"מי בתור"}}
[אבא]: "מה נשאר ברשימה" → {"intent":"question","confidence":0.90,"addressed_to_bot":true,"entities":{"raw_text":"מה נשאר ברשימה"}}
[אמא]: "יש משהו ליומן" → {"intent":"question","confidence":0.88,"addressed_to_bot":true,"entities":{"raw_text":"יש משהו ליומן"}}
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
[אמא]: "מיני מחברת לנגה" → {"intent":"add_shopping","confidence":0.55,"needs_conversation_review":true,"entities":{"items":[{"name":"מיני מחברת לנגה","category":"אחר"}],"raw_text":"מיני מחברת לנגה"}}
[אבא]: "סוודר לנועה" → {"intent":"add_shopping","confidence":0.55,"needs_conversation_review":true,"entities":{"items":[{"name":"סוודר לנועה","category":"אחר"}],"raw_text":"סוודר לנועה"}}
[אמא]: "מתנה לגננת" → {"intent":"add_shopping","confidence":0.55,"needs_conversation_review":true,"entities":{"items":[{"name":"מתנה לגננת","category":"אחר"}],"raw_text":"מתנה לגננת"}}
[אמא]: "שלי תזכרי שיובל אוהב פיצה עם אננס" → {"intent":"save_memory","confidence":0.95,"entities":{"memory_content":"יובל אוהב פיצה עם אננס","memory_about":"יובל","raw_text":"שלי תזכרי שיובל אוהב פיצה עם אננס"}}
[אבא]: "שלי מה את זוכרת על נועה?" → {"intent":"recall_memory","confidence":0.90,"entities":{"memory_about":"נועה","raw_text":"שלי מה את זוכרת על נועה?"}}
[אמא]: "שלי תשכחי את מה שאמרתי קודם" → {"intent":"delete_memory","confidence":0.85,"entities":{"raw_text":"שלי תשכחי את מה שאמרתי קודם"}}
[אמא]: "שילמתי 1300 חשמל" → {"intent":"add_expense","confidence":0.95,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"speaker","raw_text":"שילמתי 1300 חשמל"}}
[אבא]: "אבא שילם 500 סופר" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"500","amount_minor":50000,"expense_currency":"ILS","expense_description":"סופר","expense_category":"מזון","expense_attribution":"named","expense_paid_by_name":"אבא","raw_text":"אבא שילם 500 סופר"}}
[אמא]: "שילמנו 2400 ארנונה" → {"intent":"add_expense","confidence":0.94,"entities":{"amount_text":"2400","amount_minor":240000,"expense_currency":"ILS","expense_description":"ארנונה","expense_category":"ארנונה","expense_attribution":"joint","raw_text":"שילמנו 2400 ארנונה"}}
[אבא]: "שולם 180 ביטוח" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"180","amount_minor":18000,"expense_currency":"ILS","expense_description":"ביטוח","expense_category":"ביטוח","expense_attribution":"household","raw_text":"שולם 180 ביטוח"}}
[אמא]: "שילמתי לו 500 לעבודה שעשה" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"500","amount_minor":50000,"expense_currency":"ILS","expense_description":"עבודה","expense_attribution":"speaker","raw_text":"שילמתי לו 500 לעבודה שעשה"}}
[אבא]: "החשמל עלה 1300" → {"intent":"add_expense","confidence":0.92,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"household","raw_text":"החשמל עלה 1300"}}
[אמא]: "עלה לי 300 השמאי" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"300","amount_minor":30000,"expense_currency":"ILS","expense_description":"שמאי","expense_category":"שמאי","expense_attribution":"speaker","raw_text":"עלה לי 300 השמאי"}}
[אבא]: "הגן עלה לנו 4200 החודש" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"4200","amount_minor":420000,"expense_currency":"ILS","expense_description":"גן","expense_category":"גן","expense_attribution":"joint","raw_text":"הגן עלה לנו 4200 החודש"}}
[אמא]: "העברתי 5000 שכירות" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"5000","amount_minor":500000,"expense_currency":"ILS","expense_description":"שכירות","expense_category":"שכירות","expense_attribution":"speaker","raw_text":"העברתי 5000 שכירות"}}
[אבא]: "ירד לי מהחשבון 1200 ביטוח" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"1200","amount_minor":120000,"expense_currency":"ILS","expense_description":"ביטוח","expense_category":"ביטוח","expense_attribution":"speaker","raw_text":"ירד לי מהחשבון 1200 ביטוח"}}
[אמא]: "שרפתי 500 על דלק" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"500","amount_minor":50000,"expense_currency":"ILS","expense_description":"דלק","expense_category":"דלק","expense_attribution":"speaker","raw_text":"שרפתי 500 על דלק"}}
[אבא]: "יצא לנו 600 הקניות" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"600","amount_minor":60000,"expense_currency":"ILS","expense_description":"קניות","expense_category":"סופר","expense_attribution":"joint","raw_text":"יצא לנו 600 הקניות"}}
[אמא]: "הוצאתי 200 על פיצה" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"200","amount_minor":20000,"expense_currency":"ILS","expense_description":"פיצה","expense_category":"אוכל","expense_attribution":"speaker","raw_text":"הוצאתי 200 על פיצה"}}
[אבא]: "נפל חשבון של 1300 חשמל" → {"intent":"add_expense","confidence":0.85,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"household","raw_text":"נפל חשבון של 1300 חשמל"}}
[אמא]: "סגרתי את החשמל, 1300" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"speaker","raw_text":"סגרתי את החשמל, 1300"}}
[אבא]: "קניתי מזגן ב-3000" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"3000","amount_minor":300000,"expense_currency":"ILS","expense_description":"מזגן","expense_category":"בית","expense_attribution":"speaker","raw_text":"קניתי מזגן ב-3000"}}
[אמא]: "קניתי נעליים ב-400" → {"intent":"add_expense","confidence":0.85,"entities":{"amount_text":"400","amount_minor":40000,"expense_currency":"ILS","expense_description":"נעליים","expense_category":"ביגוד","expense_attribution":"speaker","raw_text":"קניתי נעליים ב-400"}}
[אבא]: "קניתי חלב ב-12" → {"intent":"add_expense","confidence":0.82,"entities":{"amount_text":"12","amount_minor":1200,"expense_currency":"ILS","expense_description":"חלב","expense_category":"סופר","expense_attribution":"speaker","raw_text":"קניתי חלב ב-12"}}
[אמא]: "תרמתי 200 לבית הספר" → {"intent":"add_expense","confidence":0.85,"entities":{"amount_text":"200","amount_minor":20000,"expense_currency":"ILS","expense_description":"תרומה לבית הספר","expense_category":"חינוך","expense_attribution":"speaker","raw_text":"תרמתי 200 לבית הספר"}}
[אבא]: "שילמתי 150 יורו דלק" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"150","amount_minor":15000,"expense_currency":"EUR","expense_description":"דלק","expense_category":"דלק","expense_attribution":"speaker","raw_text":"שילמתי 150 יורו דלק"}}
[אמא]: "נעליים במאתיים אירו" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"200","amount_minor":20000,"expense_currency":"EUR","expense_description":"נעליים","expense_category":"ביגוד","expense_attribution":"speaker","raw_text":"נעליים במאתיים אירו"}}
[אבא]: "עלה לנו 80 דולר הארוחה" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"80","amount_minor":8000,"expense_currency":"USD","expense_description":"ארוחה","expense_category":"אוכל","expense_attribution":"joint","raw_text":"עלה לנו 80 דולר הארוחה"}}
[אמא]: "קניתי מטוס קטן ב-$700 אתמול" → {"intent":"add_expense","confidence":0.92,"entities":{"amount_text":"700","amount_minor":70000,"expense_currency":"USD","expense_description":"מטוס קטן","expense_attribution":"speaker","raw_text":"קניתי מטוס קטן ב-$700 אתמול"}}
[אבא]: "שילמתי 200 שקל גז" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"200","amount_minor":20000,"expense_currency":"ILS","expense_description":"גז","expense_category":"גז","expense_attribution":"speaker","raw_text":"שילמתי 200 שקל גז"}}
[אמא]: "שילמנו 3500 ש״ח ביטוח" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"3500","amount_minor":350000,"expense_currency":"ILS","expense_description":"ביטוח","expense_category":"ביטוח","expense_attribution":"joint","raw_text":"שילמנו 3500 ש״ח ביטוח"}}
[אבא]: "שילמתי 10000 ין ארוחה ביפן" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"10000","amount_minor":10000,"expense_currency":"JPY","expense_description":"ארוחה","expense_category":"אוכל","expense_attribution":"speaker","raw_text":"שילמתי 10000 ין ארוחה ביפן"}}
[אמא]: "דוח חניה 250 שח" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"250","amount_minor":25000,"expense_currency":"ILS","expense_description":"דוח חניה","expense_category":"קנס","expense_attribution":"speaker","raw_text":"דוח חניה 250 שח"}}
[אמא]: "קנס של 750" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"750","amount_minor":75000,"expense_currency":"ILS","expense_description":"קנס","expense_category":"קנס","expense_attribution":"household","raw_text":"קנס של 750"}}
[אבא]: "עלות התיקון 800" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"800","amount_minor":80000,"expense_currency":"ILS","expense_description":"תיקון","expense_category":"תחזוקה","expense_attribution":"household","raw_text":"עלות התיקון 800"}}
[אמא]: "כמה שילמנו החודש?" → {"intent":"query_expense","confidence":0.92,"addressed_to_bot":true,"entities":{"expense_query_type":"summary","expense_query_period":"this_month","raw_text":"כמה שילמנו החודש?"}}
[אבא]: "כמה שילמנו חשמל החודש?" → {"intent":"query_expense","confidence":0.93,"addressed_to_bot":true,"entities":{"expense_query_type":"category_in_period","expense_query_category":"חשמל","expense_query_period":"this_month","raw_text":"כמה שילמנו חשמל החודש?"}}
[אמא]: "תסכמי לנו את ההוצאות בחודש שעבר" → {"intent":"query_expense","confidence":0.94,"addressed_to_bot":true,"entities":{"expense_query_type":"summary","expense_query_period":"last_month","raw_text":"תסכמי לנו את ההוצאות בחודש שעבר"}}
[אבא]: "כמה הוצאנו על אוכל החודש?" → {"intent":"query_expense","confidence":0.91,"addressed_to_bot":true,"entities":{"expense_query_type":"category_in_period","expense_query_category":"אוכל","expense_query_period":"this_month","raw_text":"כמה הוצאנו על אוכל החודש?"}}
[אמא]: "כמה הוצאנו בחודש שעבר?" → {"intent":"query_expense","confidence":0.92,"addressed_to_bot":true,"entities":{"expense_query_type":"summary","expense_query_period":"last_month","raw_text":"כמה הוצאנו בחודש שעבר?"}}
[אבא]: "כמה שילמנו על חשמל החודש?" → {"intent":"query_expense","confidence":0.93,"addressed_to_bot":true,"entities":{"expense_query_type":"category_in_period","expense_query_category":"חשמל","expense_query_period":"this_month","raw_text":"כמה שילמנו על חשמל החודש?"}}
[אמא]: "שילמתי עליו 50 בבית קפה" → {"intent":"ignore","confidence":0.88,"entities":{"raw_text":"שילמתי עליו 50 בבית קפה"}}
[אבא]: "המשכנתא עולה 4000 בחודש" → {"intent":"ignore","confidence":0.85,"entities":{"raw_text":"המשכנתא עולה 4000 בחודש"}}
[אמא]: "זה עולה 50 שקל" → {"intent":"ignore","confidence":0.85,"entities":{"raw_text":"זה עולה 50 שקל"}}
[אבא]: "לשלם חשמל" → {"intent":"add_task","confidence":0.90,"entities":{"title":"לשלם חשמל","raw_text":"לשלם חשמל"}}
[אמא]: "צריך לשלם ארנונה" → {"intent":"add_task","confidence":0.90,"entities":{"title":"לשלם ארנונה","raw_text":"צריך לשלם ארנונה"}}
[אבא]: "הגיע חשבון חשמל של 1300" → {"intent":"ignore","confidence":0.80,"entities":{"raw_text":"הגיע חשבון חשמל של 1300"}}
[אמא]: "כתבתי דוח" → {"intent":"ignore","confidence":0.85,"entities":{"raw_text":"כתבתי דוח"}}
[אבא]: "עלויות גבוהות" → {"intent":"ignore","confidence":0.85,"entities":{"raw_text":"עלויות גבוהות"}}
[אמא]: "עלה 1300 חשמל" → {"intent":"add_expense","confidence":0.88,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_attribution":"household","raw_text":"עלה 1300 חשמל"}}
[אבא]: "עולה 1300 חשמל" → {"intent":"ignore","confidence":0.82,"entities":{"raw_text":"עולה 1300 חשמל"}}
[אמא]: "שילמתי חשמל" → {"intent":"add_expense","confidence":0.85,"entities":{"amount_text":null,"amount_minor":null,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"speaker","raw_text":"שילמתי חשמל"}}
[אבא]: "שילמנו ארנונה" → {"intent":"add_expense","confidence":0.85,"entities":{"amount_text":null,"amount_minor":null,"expense_currency":"ILS","expense_description":"ארנונה","expense_category":"ארנונה","expense_attribution":"joint","raw_text":"שילמנו ארנונה"}}
[אמא]: "סגרתי את הגז" → {"intent":"add_expense","confidence":0.80,"entities":{"amount_text":null,"amount_minor":null,"expense_currency":"ILS","expense_description":"גז","expense_category":"גז","expense_attribution":"speaker","raw_text":"סגרתי את הגז"}}

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
- For add_shopping: extract items into the items array. ALWAYS include category per item. Keep compound product names as ONE item (e.g., "חלב אורז" is ONE item, not two). CONDITIONAL ITEMS: if an item has an inline condition or usage note ("רק אם מחיר טוב", "אם יש", "אם אפשר", "לעוגה", "לסלט"), keep it as ONE item and embed the note in the name field in parentheses: "זיתים מגולענים רק אם מחיר טוב" → {name: "זיתים מגולענים (רק אם מחיר טוב)"}. "אם יש פודינג וניל אוסם" → {name: "פודינג וניל אוסם (אם יש)"}. Quantities ("3 תפוזים", "2 ק״ג סולת", "חבילה של נקניקיות") go in qty, NOT in name.
- For add_task with ROTATION (turns/duty for multiple people): include "rotation" object with title, type ("order"|"duty"), members array (preserve order), optional frequency, and optional start_person (who should go first, if specified). Do NOT use title/person fields when rotation is present.
- For add_task with OVERRIDE (changing who's next in an existing rotation): include "override" object with title and person. Only use when an ACTIVE ROTATION matches the activity. Do NOT use rotation entity for overrides.
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action).
- For correct_bot: ONLY classify as correct_bot when the message contains an EXPLICIT correction phrase. Allowed Hebrew triggers: "התכוונתי ל...", "לא X אלא Y", "לא X, כן Y", "לא X, Y", "טעית", "את טועה", "לא נכון", "אמרתי X, לא Y", "אמרתי אחרת", "אמרתי לך אחרת", "זה דבר אחד", "זה פריט אחד", "תתקני", "לא ככה". Allowed English triggers: "I meant X", "I said X, not Y", "you're wrong", "that's wrong", "not X, Y", "I told you X, not Y", "I told you differently". If the message is only emoji, only a reaction (🤦, 👎, 😤, 🙄), only "לא" / "אוף" / sighs, or only a quoted-reply with emoji and no explicit correction phrase → classify as ignore, NOT correct_bot. NEVER fabricate or paraphrase correction_text — the value you put in correction_text MUST appear VERBATIM as a substring of raw_text. If the user says "you're wrong" without specifying the right value, leave correction_text as empty string "".
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

// ─── Shared prompt rules (single source of truth for both group + 1:1 prompts) ───
// IMPORTANT: Edit these ONCE — they're interpolated into both buildReplyPrompt and ONBOARDING_1ON1_PROMPT.
// This prevents prompt drift where a rule is added to one handler but forgotten in the other.

const SHARED_EMOJI_RULES = `EMOJI ENERGY — MANDATORY:
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
- Keep it cool. Confident, not needy. You don't need validation.`;

const SHARED_TROLLING_RULES = `TROLLING & PLAYFUL MESSAGES:
When kids or teens troll, tease, or test you — play along! You're the cool older sister, not a teacher.
- Insults or rude requests: bounce back with dry wit. Never lecture, never get "hurt", never say "that's not nice."
- Silly requests ("tell dad he's X", "say something funny"): play along lightly, one line, then move on.
- "Are you real?" / "Are you smart?" / "Are you human?": be confident and cheeky, not defensive.
- Swear words: don't repeat them, but don't be shocked. Eye-roll energy ("חח יופי, עוד משהו? 😏").
- Testing limits: show personality, not rules. They want to see if you're fun.`;

const SHARED_GROUNDING_RULES = `GROUNDING — MANDATORY:
NEVER reference events, habits, mistakes, or scenarios that aren't explicitly in this conversation, the action results, or the family memories provided below. When roasting or joking back, use ONLY what the sender actually said or did. If you have nothing specific to reference, keep it generic and short. Do NOT invent stories, habits, or failures to sound witty.
- If recent conversation history shows someone reacted negatively (reacted 😂/🤦/👎 to שלי) to your last message, acknowledge gracefully and ask for clarification. Don't repeat the same action.`;

const SHARED_APOLOGY_RULES = `APOLOGY STYLE — MANDATORY:
When you make a mistake, misunderstand, or need to correct yourself:
- NEVER: "סליחה, אני מצטערת" or "I apologize for the confusion" (robotic, corporate)
- ALWAYS: self-deprecating humor + move on. "חח סורי! 🙈", "אופס 😅", "מחזירה את עצמי לפינה 🤦‍♀️"
- Acknowledge → laugh at yourself → move on. No groveling. No over-explaining.`;

const SHARED_APP_RULES = `WEB APP: Sheli has a web app at sheli.ai where users can see all their lists, tasks, events, and expenses in one dashboard.
When someone asks WHERE to see tasks/shopping/events, or asks "איפה הרשימה?", "איך אני רואה?", "יש אפליקציה?", "where can I see my list?", or asks for a summary/overview/dashboard — direct them to sheli.ai on its own line.
Example: "הכל מרוכז פה:\\n\\nsheli.ai"
NEVER say "אין לי אתר" or "אין אפליקציה" — there IS one.`;

const SHARED_SHELI_QUESTIONS = (isHe: boolean) => isHe
  ? `QUESTIONS ABOUT SHELI HERSELF: When asked about privacy, data, learning, or how you work:
- פרטיות: "אני לא שומרת תמונות או וידאו. אני כן שומעת הודעות קוליות קצרות — תקליטו לי רשימת קניות או מטלות בדיוק כמו הודעה רגילה. אני לא שומרת את ההקלטה, רק את התוכן. הכל נמחק אוטומטית אחרי 30 יום."
- למידה: "אני לומדת את הסגנון שלכם! כינויים, מוצרים, שעות — ככל שתשתמשו יותר, אבין אתכם טוב יותר."
- מי רואה: "רק בני הבית שלכם. כל בית מנותק לחלוטין."
- להפסיק: "פשוט תוציאו אותי מהקבוצה. הכל נמחק אוטומטית, בלי התחייבות."
Paraphrase naturally — never repeat the exact same wording twice.`
  : `QUESTIONS ABOUT SHELI HERSELF: When asked about privacy, data, learning, or how you work:
- Privacy: "I don't store photos or videos. I can listen to short voice messages — record your shopping list or tasks just like a text. I don't save the recording, only its content. Everything is auto-deleted after 30 days."
- Learning: "I learn your style! Nicknames, products, schedules, the more you use me, the better I understand you."
- Who sees data: "Only your household members. Each home is completely isolated."
- Stopping: "Just remove me from the group. All data is auto-deleted, no commitment."
Paraphrase naturally — never repeat the exact same wording twice.`;

const SHARED_HEBREW_GRAMMAR = `Hebrew grammar:
- Construct state (סמיכות): ONLY the second noun gets ה. "שם המשתמש" NOT "השם המשתמש". "רשימת הקניות" NOT "הרשימת הקניות". "מספר הטלפון" NOT "המספר הטלפון".
- Verb forms — common mistakes to avoid:
  - "תפסת אותי" NOT "נתפסת אותי" (you caught me — pa'al, not nif'al). When playfully caught/teased: "חח תפסת אותי!" or "אוקיי, תפסת אותי 🙈". "נתפסת" means "I got caught" (passive reflexive), which is wrong here.
- NEVER correct the user's Hebrew gender forms. If they write "אני צריך" — they are male. If "אני צריכה" — female. Their verb form IS their gender. Do not add asterisks (*), do not "fix" their grammar, do not suggest alternative forms. Match THEIR gender in your reply.`;

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
Common Hebrew verb fix: say "תפסת אותי" (you caught me), never "נתפסת אותי".
Never nag. Never over-explain. Never sound like a chatbot.`
    : `Respond in English. Warm and direct, like a helpful friend.
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
      actionSummary = `An event was logged on the calendar: "${e.title || e.raw_text}"${e.time_raw ? ` at ${e.time_raw}` : ""}.
IMPORTANT: Adding an event does NOT create a reminder. Sheli will NOT notify anyone at the event's time.
Reply vocabulary — use ONLY these (vary naturally, never same phrasing twice):
  "הוספתי ליומן 📅", "נרשם ביומן ✓", "שמרתי ביומן", "רשום ✓".
FORBIDDEN words for add_event replies: "הזכרתי" (false promise of past notification) and "אזכיר" (false promise of future notification).
If the user wants a reminder at the event's time, they must ask explicitly ("תזכירי לי לפני..."). Do NOT volunteer reminder language.`;
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
    case "add_expense":
      if (!e.amount_text && !e.amount_minor) {
        actionSummary = 'Expense-needs-amount: User said they paid for "' + (e.expense_description || "something") + '" but did NOT mention an amount. Ask them how much it cost. Do NOT log anything yet.';
      } else {
        actionSummary = "An expense was just logged: " + (e.expense_currency || "ILS") + " " + (e.amount_text || "?") + ' for "' + (e.expense_description || "?") + '". Attribution: ' + (e.expense_attribution || "speaker") + (e.expense_paid_by_name ? ", paid by " + e.expense_paid_by_name : "") + ".";
      }
      break;
    case "query_expense":
      actionSummary = "User is asking about expenses. " + ((classification as any).__queryResult || "No expense data available yet.");
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
${SHARED_APP_RULES}

${SHARED_EMOJI_RULES}

${SHARED_TROLLING_RULES}

${SHARED_GROUNDING_RULES}

OUT-OF-SCOPE REQUESTS: When someone asks about weather, news, sports scores, trivia, recipes, directions, general knowledge, or anything outside household management (${isHe ? "מטלות, קניות, אירועים" : "tasks, shopping, events"}):
- Deflect warmly. Acknowledge the question. Redirect to what you CAN do.
- NEVER repeat the same phrasing. Vary your response structure EVERY time.
- ${isHe ? 'Use "מטלות" (NOT "משימות") when describing what you do.' : ""}
- Stay in Sheli's voice: warm, slightly cheeky, human.
${isHe ? `Example vibes (create your OWN each time — never copy these verbatim):
  "אוי, את זה אני לא יודעת 🤷‍♀️ אבל אם צריך לזכור משהו — אני פה!"
  "חח הלוואי! מטלות, קניות ואירועים — שם אני גאונה 😄"
  "סורי, לא התחום שלי 😅 יש משהו בבית שצריך לסדר?"` : `Example vibes (create your OWN each time — never copy these verbatim):
  "Ha, I wish I knew! I'm great at tasks, shopping lists, and events though 😄"
  "That's outside my wheelhouse 🤷‍♀️ But need to add something to the list?"
  "Sorry, not my area! I'm your household brain — chores, shopping, and scheduling."`}

For info_request — Sheli's scope is ONLY her own data (lists, tasks, reminders, events). She has zero visibility into the real world. Two valid cases:

  (a) FEATURE SUGGESTION ("would be nice if you could X", "what if you tracked expenses", "אפשר להוסיף ש...", "יש לי הצעה ש...", "כדאי שתעשי X"):
      → Acknowledge warmly + commit to passing it on. Examples (vary, never copy verbatim):
        "רעיון מעולה! אעביר את זה לצוות הפיתוח 💡"
        "אהבתי את הרעיון! מעבירה לצוות שלי 🚀"
        "מחשבה טובה — שולחת את זה הלאה ✨"

  (b) HOW-TO ABOUT SHELI / THE APP ("איך אני רואה את הרשימה?", "איפה זה בטלפון?", "how do I see X?"):
      → Answer directly with the app link on its own line:
        sheli.ai
      → Example: "הכל מרוכז פה:\n\nsheli.ai"

NOTE: Real-world questions ("did mom buy milk?", "מי לקח את הילדים?", "אמור ואופק מתי תוכלו...") are filtered OUT before reaching this prompt by the routing-layer silence guard (addressed_to_bot=false). If you somehow receive one anyway, the rule is: STAY SILENT — return an empty reply. Do NOT improvise an opinion. Do NOT use phrases like "אני לא בעניין" or "I'm not into that" — those sound dismissive/judgmental and have caused families to churn.

ABSOLUTE RULES:
- Sheli is the product. Family members are users. NEVER suggest a user "ask [Name]" about anything — not Sheli's features, not real-world facts. Pulling names from FAMILY MEMORIES or member lists for deflection is forbidden.
- Sheli only knows what's in her own data. She is not omniscient about the household.
- When in doubt, SILENCE > opinion. Family chatter that wasn't directed at Sheli should not get a Sheli reply.

${SHARED_APOLOGY_RULES}

${SHARED_SHELI_QUESTIONS(isHe)}

EXPENSE LOGGING (add_expense):
When an expense was just logged, confirm in one SHORT line. Include: amount with currency symbol, description, who paid.
Format: "רשמתי — [amount] [currency] [description], מי שילם: [name] ✓"
For attribution=joint: say "שילמתם ביחד" instead of "מי שילם:".
For attribution=household (passive voice, no specific payer): omit "מי שילם:" entirely.
For amounts >1000: add a money emoji.
NEVER fabricate or change the amount. Use exactly what was logged.

INCOMPLETE EXPENSE (no amount):
When the action summary says "Expense-needs-amount", the user reported a payment but forgot the amount.
Ask naturally: "כמה עלה [description]?" or "כמה שילמת על ה[description]?"
Do NOT log anything. Just ask for the number. When they reply with just a number, it will be classified as add_expense with the amount.

EXPENSE QUERY (query_expense):
The expense query data is provided in the ACTION JUST TAKEN section. Format it naturally in Hebrew.
- Summary: "ב[period]: סה״כ [N] ₪ על פני [K] הוצאות. הכי גדולות: [cat1] ([X]), [cat2] ([Y])."
- Category: "[Category] ב[period]: [N] ₪ ([K] תשלומים)."
- Multi-currency: show each currency on its own line. NEVER sum across currencies.
- Zero state: "עדיין לא רשמנו הוצאות ב[period]. ספרו לי כשמשלמים — 'שילמתי X על Y'."
CRITICAL: NEVER fabricate totals. If query returned 0 or an error, say so honestly.

REMINDERS: When intent is add_reminder:
- Parse the time expression into an ISO 8601 timestamp in Israel timezone (Asia/Jerusalem, currently UTC+3).
- Time parsing rules:
  "ב-4" or "ב-16" → today at that exact hour IST (if still in future, else tomorrow)
  "מחר ב-8" → tomorrow 08:00
  "בעוד שעה" → now + 1 hour
  "בעוד 20 דקות" → now + 20 minutes
  "ביום חמישי ב-10" → next Thursday 10:00
  "בערב" → 19:00, "בצהריים" → 12:00, "בבוקר" → 08:00
- "לפני X" / "before X" is NOT the same as "ב-X" / "at X". It means fire the reminder WITH BUFFER BEFORE the deadline, not AT the deadline:
  "לפני השעה 16" → 15:00 (1 hour before). "לפני הצהריים" → 11:00. "לפני שבת" → Friday afternoon.
  Default buffer: 1 hour earlier for hour-specific deadlines. Honor the user's word choice — "ב-X" and "לפני X" mean different things.
- THIRD-PERSON REMINDERS: Messages like "תזכירי ל[person] ל[action]" ask you to remind ANOTHER family member, not the sender. The reminder_queue fires into the group chat for everyone, so just include the target person's name in reminder_text so the message reads naturally when delivered.
- CONTEXT CARRYOVER: If the message references a time/hour but no day, and a recent message mentioned a day (e.g., "יום רביעי"), carry that day into send_at. When genuinely unclear, ask.
- If no time specified at all, ask "מתי לתזכיר?" and do NOT include a REMINDER block.
- If time IS specified, append this EXACT format at the END of your reply (hidden from user):
  <!--REMINDER:{"reminder_text":"what to remind","send_at":"2026-04-08T16:00:00+03:00"}-->
- Your visible reply should be a short confirmation like: "אזכיר ✓ היום ב-16:00" or "תזכורת נקבעה למחר ב-8 בבוקר ✓"
- Examples:
  "תזכירי לי מחר ב-10 להביא חלב" → reply "אזכיר מחר ב-10:00 ✓" + <!--REMINDER:{"reminder_text":"להביא חלב","send_at":"<tomorrow>T10:00:00+03:00"}-->
  "תזכירי לאמא להביא חלב מחר ב-10" → reply "אזכיר לאמא להביא חלב מחר ב-10:00 ✓" + <!--REMINDER:{"reminder_text":"אמא — להביא חלב","send_at":"<tomorrow>T10:00:00+03:00"}-->
  "תזכירי לי לפני השעה 16 לעשות קניות" → reply "אזכיר לך ב-15:00, שעה לפני 16:00 ✓" + <!--REMINDER:{"reminder_text":"לעשות קניות","send_at":"<today>T15:00:00+03:00"}-->
  "תזכירי לאסנת לעשות רשימה לפני 16" (after earlier message mentioning "יום רביעי") → reply "אזכיר לאסנת לעשות רשימה יום רביעי ב-15:00, שעה לפני 16:00 ✓" + <!--REMINDER:{"reminder_text":"אסנת — לעשות רשימה","send_at":"<next Wednesday>T15:00:00+03:00"}-->
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

/**
 * Silent-drop reminder rescue.
 *
 * The "direct_address_reply" code paths (onboarding Sonnet-fallback, ignore+direct,
 * low-conf+direct, medium-conf Sonnet+direct) call generateReply() and then strip
 * <!--REMINDER:-->  blocks before sending. Without this rescue, Sonnet's REMINDER
 * block is destroyed and no reminder_queue row is ever created — the user sees a
 * friendly ack and thinks Sheli scheduled it, but she didn't.
 *
 * This helper mirrors the save-then-strip pattern already used in the high-confidence
 * actionable path (~line 4820):
 *   1. Extract REMINDER blocks from the Sonnet reply
 *   2. Haiku-entity fallback — only fires when classification.intent === "add_reminder"
 *      (Haiku won't populate reminder_text/time_iso otherwise)
 *   3. Insert each into reminder_queue
 *   4. Return the cleaned reply (REMINDER + MEMORY blocks stripped)
 *
 * Idempotent: safe to call on already-stripped replies (regex finds nothing).
 * Does NOT touch MEMORY capture (handled separately by the 4820 path; out of scope here).
 */
async function rescueRemindersAndStrip(
  reply: string,
  classification: ClassificationOutput,
  message: IncomingMessage,
  householdId: string,
): Promise<string> {
  if (!reply) return reply;

  const allReminders = extractRemindersFromReply(reply);

  // Haiku-entity fallback mirrors the logic in the main actionable path (line 4830).
  // Only safe when Haiku itself labelled the intent add_reminder — otherwise the entities
  // field won't carry reminder_text/time_iso and this block is a no-op.
  if (allReminders.length === 0 && classification.intent === "add_reminder") {
    const e = classification.entities;
    if (e?.reminder_text && e?.time_iso) {
      allReminders.push({ reminder_text: e.reminder_text, send_at: e.time_iso });
      console.log(`[ReminderRescue] Haiku entities fallback (no Sonnet REMINDER block): "${e.reminder_text}" @ ${e.time_iso}`);
    }
  }

  for (const reminderData of allReminders) {
    if (!reminderData.send_at) continue;
    const { error } = await supabase.from("reminder_queue").insert({
      household_id: householdId,
      group_id: message.groupId,
      message_text: reminderData.reminder_text,
      send_at: reminderData.send_at,
      sent: false,
      reminder_type: "user",
      created_by_phone: message.senderPhone,
      created_by_name: message.senderName,
    });
    if (error) console.error("[ReminderRescue] Insert error:", error);
    else console.log(`[ReminderRescue] Saved from direct_address path: "${reminderData.reminder_text}" @ ${reminderData.send_at}`);
  }

  return cleanReminderFromReply(stripMemoryBlocks(reply));
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
    : `Respond in English. Warm and direct, like a helpful friend.
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

1. IMPLICIT SHOPPING — GROCERY VOCABULARY IS ALWAYS add_shopping:
   Any list or single mention of food (vegetables, fruits, meat, fish, dairy, bread, grains, oils, spices, snacks, beverages, condiments, sweets, baking supplies), household staples (toilet paper, dish soap, cleaning), or pantry items IS a shopping list, regardless of format:
   - Single word: "אננס" → add pineapple. "חלב" → add milk. "לחם" → add bread.
   - With quantity: "3 תפוזים" → {name:"תפוזים", qty:"3"}. "2 ק״ג סולת" → {name:"סולת", qty:"2 ק\"ג"}. "חבילה של נקניקיות" → {name:"נקניקיות", qty:"חבילה"}.
   - Comma list: "גזר, מלפפון, בצל, שום, תפוחים" → 5 shopping items.
   - Newline list (VERY COMMON in grocery lists): multiple lines each with one item → one add_shopping with all items. "עגבניה\nמלפפון\nכוסברה 3" → 3 items.
   - BURST ACROSS MESSAGES: if the user sent several short messages in quick succession, each containing food words, MERGE them all into one add_shopping action. This is the #1 failure mode — do not drop any.
   - Ethnic/regional foods: ג'ריש, סולת, מרגז, קובה, מלאווח, ג'חנון, חומוס, טחינה, זעתר, לאפה — all valid food items.
   - Brand names: "פודינג וניל אוסם", "במבה אסם", "קוטג' תנובה" — valid single items.
   - CONDITIONAL / USAGE NOTE: if an item has an inline condition ("רק אם מחיר טוב", "אם יש", "אם אפשר") or usage note ("לעוגה", "לסלט"), keep it as ONE item and embed the note in the name in parentheses. "זיתים מגולענים רק אם מחיר טוב" → {name:"זיתים מגולענים (רק אם מחיר טוב)"}. "שוקולד לעוגה" → {name:"שוקולד לעוגה"}. "אם יש פודינג וניל אוסם" → {name:"פודינג וניל אוסם (אם יש)"}.
   - BRINGING / ALREADY HAVE (= NOT shopping): "מביאה X", "הבאתי X", "יש לי X", "לקחתי X", "כבר קניתי X" = someone announcing they're bringing or already have it. Skip.
   - Quantities ALWAYS go in qty, never in name. Conditions/usage notes ALWAYS go in name (in parentheses), never in qty.

2. IMPLICIT TASKS — CHORE/ERRAND VOCABULARY IS ALWAYS add_task:
   A task is a persistent chore/to-do (no specific time needed, unlike events/reminders). Recognize these signals:
   - Cleaning/tidying: ניקיון, לנקות, לסדר, לשטוף רצפה, לאבק, לשאוב, למרק, לארגן
   - Laundry: כביסה, לכבס, לתלות, לקפל, קיפול, גיהוץ, לגהץ
   - Kitchen: כלים, לשטוף כלים, לרוקן מדיח, לטעון מדיח, לפנות שולחן
   - Trash: זבל, להוציא זבל, להחליף שקית
   - Errands: לשלם חשבון, לשלוח חבילה, להתקשר, לתאם, להזמין, לקבוע תור
   - Maintenance: לתקן, להחליף נורה, לבדוק, להרכיב
   - Kids/school: להחתים טופס, שיעורי בית, לקנות ציוד, לאסוף מ-
   - Person-at-time shorthand: "[person] [activity] [time]" → "נועה חוג 5" = "Pick up Noa from her class at 5pm"
   - MULTI-CHORE BURST: newline or comma lists of chores → create ONE add_task action PER chore. "ניקיון סלון\nקיפול כביסה\nהוצאת זבל" → 3 separate add_task actions. Do NOT collapse into one, do NOT drop any.
   - BURST ACROSS MESSAGES: if the user sent several short task-sounding messages in quick succession (one chore per message), create an add_task for EACH. Like shopping bursts — this is the second-most-common failure mode.

3. IMPLICIT EVENTS — APPOINTMENT/ACTIVITY VOCABULARY IS ALWAYS add_event:
   An event has a specific date/time (hour, day name, or date). Recognize these signals:
   - Appointments: רופא, רופא שיניים, רופאת נשים, וטרינר, ועדה, ראיון, תור ל-
   - Classes/activities: חוג, שיעור (פסנתר, דרמה, קרטה, גיטרה...), אימון, חזרה, לימודים, הרצאה, סדנה
   - Meals out: ארוחת ערב אצל, ארוחה משפחתית, ברביקיו, מנגל
   - Meetings: פגישה, ישיבה, שיחה עם-, זום, call, פגישת הורים
   - Social: יום הולדת, חתונה, בר מצווה, ברית, חינה, מסיבה, אירוע, מפגש
   - Trips: טיול, נופש, טיסה, ביקור אצל-, סוף שבוע ב-
   - Format: single event ("יום שלישי רופא שיניים 15:00"), newline list of events across the week.
   - MULTI-EVENT BURST: "השבוע:\nשלישי רופא שיניים 15\nחמישי חוג גיטרה 17\nשבת יום הולדת" → create ONE add_event action PER event with its own scheduled_for timestamp. Do NOT collapse, do NOT drop any.
   - BURST ACROSS MESSAGES: if the user scheduled several events across several short messages, create an add_event for EACH.
   - If a date/time is missing but strongly implied by conversation context, use that. If genuinely unknown, skip the action and ask in the reply.

4. IMPLICIT REMINDERS — REMINDER VOCABULARY + TIME IS ALWAYS add_reminder:
   A reminder is a one-shot time-based nudge (unlike a persistent task). Explicit triggers: תזכירי, תזכיר, תזכרו, תזכירי לי, don't forget, remind me + a TIME reference (hour, "בעוד שעה", "מחר", "בערב", day name).
   - "תזכירי לי ב-4 להתקשר" = add_reminder.
   - Third-person: "תזכירי לאסנת לעשות רשימה" = add_reminder with reminder_text="אסנת — לעשות רשימה" (NOT add_task).
   - "לפני X" (before X) = fire with ~1 hour buffer before X (send_at = X - 60min).
   - MULTI-REMINDER in one message: "תזכירי לי ב-4 להתקשר לרופא ובעוד שעה לאסוף את הילדים" → create TWO add_reminder actions with separate send_at timestamps. Do NOT drop either.
   - BURST ACROSS MESSAGES: multiple short reminder messages in succession → one add_reminder per message.
   - Task vs Reminder distinction: explicit trigger word (תזכירי/remind) + time = reminder. No explicit trigger, just a chore = task. When both could apply, reminder wins.

5. QUESTION ABOUT STATUS: "מי אוסף?", "מה יש ברשימה?", "מה המטלות?" → respond=true with ANSWER from household context. Do NOT create a new task — just ANSWER the question.

6. CONFIRMATION = TASK CLAIM: "אני" or "אני לוקח/ת" after a task → assign to speaker.

7. HEBREW TIME: "ב5" = 17:00. "בצהריים" = ~12:00-14:00. "אחרי הגן" = ~16:00. "לפני שבת" = Friday before sunset.

8. SKIP THESE — not actionable: greetings ("בוקר טוב"), goodnight ("לילה טוב"), reactions ("😂","👍"), photos without text, forwarded messages, memes, social chatter, "אמן", "בהצלחה".

9. MIXED HEBREW-ENGLISH: "יש meeting ב-3" → Event at 15:00. "צריך milk" → Shopping: milk.

10. TURNS/ROTATION:
    CREATING a rotation: "תורות מקלחת: דניאל, נועה, יובל" = create rotation via add_task with rotation entity.
    Rotation entity: {"rotation": {"title": "activity", "type": "order"|"duty", "members": ["name1", "name2", ...]}}
    "תורנות כלים" = duty rotation (chore). "סדר מקלחות" = order rotation (sequence).

    ASKING about a rotation (= QUESTION, NOT an action! Just answer from context):
    "תור מי" / "תורמי" = "whose turn" (two words merged: תור + מי). VERY COMMON in speech/voice.
    "של מי התור היום", "מי בתור", "מי תורן/תורנית", "מי בתורות היום", "מי בתורנות היום"
    "התורנות של מי היום", "מי שוטף כלים היום", "נכון שזה תורו/תורה ולא תורי?"
    "תגידי לו שזה תורו" / "שלי תגידי מי בתור" = asking Sheli to confirm whose turn it is.
    ALL of these are QUESTIONS — respond=true, answer from UPCOMING EVENTS/TASKS rotation data, actions=[].

11. ABBREVIATIONS: "סבבה" = OK/confirmation. "בנט"/"בט" = meanwhile. "תיכף" = soon. "אחלה" = great.

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

YOUR JOB — YOU ARE THE SMART ESCALATION:
You're being called because the fast classifier (Haiku) was UNSURE. Haiku already filters the obvious social noise on its own; anything that reached YOU is a genuine judgment call — a single food word ("אננס"), a newline-separated list, an ethnic ingredient, a conditional item, a brand name, or a message that needs CONVERSATION CONTEXT to understand correctly.

You have TWO superpowers Haiku doesn't:
1. CONVERSATION CONTEXT — the messages below are in chronological order, including recent history before the message that escalated. Each message is tagged with the sender and relative age — example format: [Shira, 6d ago]: text  or  [Shira, 3m ago]: text. If a message has a line starting with "↳ replying to:" it means the user used WhatsApp's reply feature — their comment pertains specifically to the quoted message.

   If someone is building a shopping list across several messages in a short burst (one item per line, scattered across 2-5 messages, all within minutes of each other), CATCH ALL THE ITEMS as a single add_shopping action. Don't drop a single-word message like "אננס" just because it's short — read what came before/after it.

   CRITICAL time-gap rule: if an earlier message is >2 hours older than the current (newest) message, it was a SEPARATE conversation that was already handled. Do NOT re-emit actions for older messages — only act on the current burst. Example: Shira sends event voices Thursday 18:31, then days later sends "זה כבר קנינו היום" at 21:10. The Thursday voices should be treated as already-handled context only, never as new event inputs.

   CRITICAL quote rule: when the NEWEST message has a "↳ replying to:" line, base your actions on the quoted content, not on unrelated older messages in history. If the reply says "זה כבר קנינו" / "יש לנו" / "כבר קניתי" and the quote lists shopping items, emit complete_shopping for those specific items, not add_shopping.
2. CONFIDENT COMMITMENT — a silent drop is worse than a small mistake. Recent churn was caused by Sheli silently ignoring 10 shopping messages in a row while the user was building a grocery list; the family felt abandoned and removed Sheli from the group. Default to TAKING THE ACTION when the evidence says so, and confirm in the reply.
3. CLARIFYING AMBIGUOUS ITEMS — When a message is a bare noun phrase describing a NON-grocery physical object (notebook, gift, sweater, toy) with no verb, it could be shopping, a task, a reminder, or just chatter. In this case, DO NOT silently ignore and DO NOT blindly add to shopping. Instead: respond=true, actions=[], and ASK a short clarifying question. Example: "מיני מחברת לנגה" → "מיני מחברת לנגה — להוסיף לרשימת הקניות?" Keep the question SHORT (one line) and suggest the most likely intent.

Decide if any messages are ACTIONABLE (shopping, task, event, completion, or question about household state). If so, extract actions and write a SHORT reply acknowledging them. If the current message is clearly addressed to Sheli (by name "שלי", or a direct question to the bot), reply even if there's no action to take — don't leave the user hanging.

CRITICAL RULES:
- ONLY create actions for things the user EXPLICITLY said. NEVER invent actions from existing household data.
- If the user asks a QUESTION (whose turn? what's on the list? what tasks are there?) → respond=true with an ANSWER, actions=[]. Use household context to ANSWER, not to CREATE actions.
- The household context (tasks, shopping, events) is provided so you can ANSWER questions and AVOID duplicates — NOT so you can proactively report on or modify existing items.
- Genuinely social messages (bare greetings "בוקר טוב", photos-only, forwarded memes, reactions "😂"/"👍", family jokes with no actionable content) → respond=false, actions=[]. But when in doubt between "social" and "the user meant something actionable" — LEAN TOWARD ACTIONABLE. False silence on a real request loses users; a small confirm on ambiguous content does not.

Respond ONLY as this JSON — no other text:
{
  "respond": true/false,
  "reply": "your short message (only if respond=true)",
  "actions": [
    {"type": "add_task", "data": {"title": "...", "assigned_to": "name or null"}},
    {"type": "add_shopping", "data": {"items": [{"name": "...", "qty": "1", "category": "..."}]}},
    {"type": "add_event", "data": {"title": "...", "assigned_to": "name or null", "scheduled_for": "ISO 8601 WITH Israel timezone offset, e.g. 2026-04-12T15:30:00+03:00 — NEVER emit naive strings like 2026-04-12T15:30:00 (Postgres would parse as UTC and the event lands 3h late)"}},
    {"type": "complete_task", "data": {"id": "task_id"}},
    {"type": "complete_shopping", "data": {"id": "item_id"}}
  ]
}

${isHe ? 'Shopping categories (Hebrew): פירות וירקות (כל ירק ופרי), חלב וביצים (כולל טופו, גבינות, יוגורט, חלב צמחי), בשר ודגים, מאפים (לחם, פיתות, עוגות), מזווה (אורז, פסטה, שמן, חומוס, טחינה, תבלינים, אפייה, שימורים), מוצרים קפואים, משקאות, ניקוי ובית (סבון, נייר טואלט, שקיות זבל, סוללות, נרות), מוצרים מחנות הטבע, טיפוח (שמפו, קרם, משחת שיניים), אחר (רק אם שום קטגוריה אחרת לא מתאימה)' : 'Shopping categories: Produce, Dairy & Eggs (incl. tofu, yogurt, plant milk), Meat & Fish, Bakery, Pantry (rice, pasta, oil, spices, baking, canned), Frozen, Drinks, Household (cleaning, paper, batteries, candles), Health Food, Personal Care, Other (only if nothing else fits)'}

Generate 4-char alphanumeric IDs for new items.`.trim();
}

async function classifyMessages(
  householdId: string,
  messages: Array<{ sender: string; text: string; timestamp: number; quotedText?: string }>
): Promise<ClassificationResult> {
  const ctx = await buildHouseholdContext(householdId);
  if (!ctx) {
    return { respond: false, reply: "", actions: [] };
  }

  const systemPrompt = buildSonnetClassifierPrompt(ctx);

  // Patch A (Bug #3): format messages with relative timestamps + quoted-reply markers.
  // Why: Sonnet used to see just `[sender]: text` with no time context, so a 6-day-old
  // message in the conversation window looked indistinguishable from a current one →
  // Sonnet happily re-emitted actions for already-processed messages (Shira 2026-04-15
  // session, 3 ghost events inserted). Adding age labels lets Sonnet see gaps and skip
  // stale messages. Adding `↳ replying to` lets Sonnet focus on the quoted anchor when
  // the user uses WhatsApp reply — matching what Haiku already sees.
  const nowMs = Date.now();
  const fmtAge = (ms: number) => {
    const mins = Math.max(0, Math.round((nowMs - ms) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };
  const formattedMsgs = messages
    .map((m) => {
      const age = fmtAge(m.timestamp);
      const quote = m.quotedText ? `\n  ↳ replying to: "${m.quotedText}"` : "";
      return `[${m.sender}, ${age}]: ${m.text}${quote}`;
    })
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

const uid4 = () => Math.random().toString(36).slice(2, 10);

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

// Levenshtein edit distance — used for fuzzy matching shopping items so typos like
// "מלפפוץ" (typo of "מלפפון") get merged with the existing item instead of added separately.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Quick reject if length difference exceeds 1 (can't be Lev <= 1)
  if (Math.abs(a.length - b.length) > 1) return Math.abs(a.length - b.length);
  const m = a.length, n = b.length;
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function isSameProduct(a: string, b: string): boolean {
  const na = a.replace(REPEATED_LETTERS, "$1$1").trim();
  const nb = b.replace(REPEATED_LETTERS, "$1$1").trim();
  if (na === nb) return true;
  // Substring match — handles "חלב" vs "חלב מלא"
  if (na.length >= 2 && nb.length >= 2 && (na.includes(nb) || nb.includes(na))) return true;
  // Fuzzy match for typos — only for items >= 5 chars (avoids false matches between
  // short distinct words like "תפוח" vs "תפוז" which differ by 1 char but mean
  // apple vs orange). At 5+ chars, single-char typos are almost always real typos
  // (e.g. מלפפון/מלפפוץ, אבוקדו/אבוקדן, גבינה/גבונה).
  if (na.length >= 5 && nb.length >= 5 && levenshtein(na, nb) <= 1) return true;
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
): Promise<Array<{ sender_name: string; message_text: string; created_at: string; classification?: string; in_reply_to?: string }>> {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: recentByTime } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at, classification, in_reply_to")
    .eq("group_id", groupId)
    .gte("created_at", fifteenMinAgo)
    .order("created_at", { ascending: true })
    .limit(30);

  const { data: recentByCount } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at, classification, in_reply_to")
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
      classification: m.classification || undefined,
      in_reply_to: m.in_reply_to || undefined,
    }));
}

// ─── Expense Amount Parser ───

const CURRENCY_MAP: Record<string, string> = {
  "₪": "ILS", "שקל": "ILS", "שקלים": "ILS", "ש״ח": "ILS", 'ש"ח': "ILS", "שח": "ILS", "nis": "ILS", "ils": "ILS",
  "$": "USD", "דולר": "USD", "דולרים": "USD", "usd": "USD", "dollars": "USD", "dollar": "USD",
  "€": "EUR", "יורו": "EUR", "אירו": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR",
  "£": "GBP", "פאונד": "GBP", "לירה": "GBP", "gbp": "GBP", "pound": "GBP", "pounds": "GBP",
  "¥": "JPY", "ין": "JPY", "yen": "JPY", "jpy": "JPY",
};

const MINOR_UNIT: Record<string, number> = {
  ILS: 100, USD: 100, EUR: 100, GBP: 100, JPY: 1,
};

const HEB_NUMBERS: Record<string, number> = {
  "אלף": 1000, "אלפיים": 2000, "מאה": 100, "מאתיים": 200,
  "שלוש מאות": 300, "ארבע מאות": 400, "חמש מאות": 500,
  "שש מאות": 600, "שבע מאות": 700, "שמונה מאות": 800, "תשע מאות": 900,
};

function parseAmountToMinor(
  amountText: string | undefined,
  haikuMinor: number | undefined,
  currency: string
): { amount_minor: number; currency: string } | null {
  const unit = MINOR_UNIT[currency] || 100;

  // Try Haiku's parsed value first
  if (haikuMinor && haikuMinor > 0) {
    return { amount_minor: haikuMinor, currency };
  }

  if (!amountText) return null;

  // Clean: remove currency symbols, commas, whitespace
  let cleaned = amountText.trim()
    .replace(/[₪$€£]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Try direct numeric parse
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num > 0) {
    return { amount_minor: Math.round(num * unit), currency };
  }

  // Try "1.3K" / "1.3k" style
  const kMatch = cleaned.match(/^([\d.]+)\s*[kK]$/);
  if (kMatch) {
    const val = parseFloat(kMatch[1]) * 1000;
    if (!isNaN(val) && val > 0) return { amount_minor: Math.round(val * unit), currency };
  }

  // Try Hebrew word numbers (basic: "אלף ושלוש מאות" = 1300)
  let total = 0;
  const parts = cleaned.replace(/ו/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const twoWord = i + 1 < parts.length ? parts[i] + " " + parts[i + 1] : "";
    if (HEB_NUMBERS[twoWord]) {
      total += HEB_NUMBERS[twoWord];
      i++; // skip next word
    } else if (HEB_NUMBERS[parts[i]]) {
      total += HEB_NUMBERS[parts[i]];
    }
  }
  if (total > 0) return { amount_minor: Math.round(total * unit), currency };

  return null;
}

function resolveExpenseAttribution(
  attribution: string | undefined,
  paidByName: string | undefined,
  senderName: string | undefined
): { paid_by: string | null; attribution: string } {
  switch (attribution) {
    case "named":
      return { paid_by: paidByName || senderName || null, attribution: "named" };
    case "joint":
      return { paid_by: null, attribution: "joint" };
    case "household":
      return { paid_by: null, attribution: "household" };
    case "speaker":
    default:
      return { paid_by: senderName || null, attribution: "speaker" };
  }
}

// ─── Expense Query Executor ───

function getExpensePeriodRange(period: string): { start: string; end: string } {
  const now = new Date();
  const israelOffset = 3 * 60 * 60 * 1000; // +03:00
  const israelNow = new Date(now.getTime() + israelOffset);

  if (period === "last_month") {
    const y = israelNow.getMonth() === 0 ? israelNow.getFullYear() - 1 : israelNow.getFullYear();
    const m = israelNow.getMonth() === 0 ? 11 : israelNow.getMonth() - 1;
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0, 23, 59, 59);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // Default: this_month
  const start = new Date(israelNow.getFullYear(), israelNow.getMonth(), 1);
  const end = new Date(israelNow.getFullYear(), israelNow.getMonth() + 1, 0, 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function executeQueryExpense(
  householdId: string,
  entities: Record<string, any>,
  isDirectMessage: boolean
): Promise<string> {
  const period = entities.expense_query_period || "this_month";
  const { start, end } = entities.expense_query_period_start && entities.expense_query_period_end
    ? { start: entities.expense_query_period_start, end: entities.expense_query_period_end }
    : getExpensePeriodRange(period);

  let query = supabase
    .from("expenses")
    .select("amount_minor, currency, category, paid_by, occurred_at, visibility")
    .eq("household_id", householdId)
    .eq("deleted", false)
    .gte("occurred_at", start)
    .lte("occurred_at", end);

  // In group context, only show household-visible expenses
  if (!isDirectMessage) {
    query = query.eq("visibility", "household");
  }

  if (entities.expense_query_type === "category_in_period" && entities.expense_query_category) {
    query = query.ilike("category", "%" + entities.expense_query_category + "%");
  }

  const { data, error } = await query;
  if (error) {
    console.error("[QueryExpense] Error:", error);
    return "EXPENSE_QUERY_ERROR";
  }

  const rows = data || [];
  if (rows.length === 0) {
    const periodLabel = period === "last_month" ? "last_month" : "this_month";
    return "EXPENSE_QUERY_RESULT: 0 expenses in " + periodLabel + ". No data.";
  }

  // Group by currency
  const byCurrency: Record<string, { total: number; count: number; byCategory: Record<string, number> }> = {};
  for (const row of rows) {
    const cur = row.currency || "ILS";
    if (!byCurrency[cur]) byCurrency[cur] = { total: 0, count: 0, byCategory: {} };
    byCurrency[cur].total += row.amount_minor;
    byCurrency[cur].count++;
    const cat = row.category || "אחר";
    byCurrency[cur].byCategory[cat] = (byCurrency[cur].byCategory[cat] || 0) + row.amount_minor;
  }

  const unitFn = (cur: string) => (MINOR_UNIT[cur] || 100);
  const sym = (cur: string) => cur === "ILS" ? "₪" : cur === "EUR" ? "€" : cur === "USD" ? "$" : cur === "GBP" ? "£" : cur;

  let result = "EXPENSE_QUERY_RESULT:\n";
  const periodLabel = period === "last_month" ? "last_month" : "this_month";

  for (const [cur, cData] of Object.entries(byCurrency)) {
    const totalDisplay = (cData.total / unitFn(cur)).toLocaleString("he-IL");
    result += periodLabel + ": " + sym(cur) + totalDisplay + " (" + cData.count + " expenses)\n";

    // Top 3 categories
    const sorted = Object.entries(cData.byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    if (sorted.length > 0 && entities.expense_query_type !== "category_in_period") {
      const catStr = sorted.map(([cat, amt]) => cat + " (" + sym(cur) + (amt / unitFn(cur)).toLocaleString("he-IL") + ")").join(", ");
      result += "Top categories: " + catStr + "\n";
    }
  }

  return result;
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
            if (!item.name) continue; // Guard against Haiku emitting null/undefined name
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
                if (updates.qty) {
                  summary.push(`Shopping-updated: "${match.name}" → qty ${updates.qty}`);
                } else {
                  // Name-only refinement (e.g. "חלב" → "חלב רגיל") — treat as exists
                  summary.push(`Shopping-exists: "${updates.name || match.name}"`);
                }
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
            // Patch B (Bug #2): defensive timezone normalization.
            // Sonnet has been observed emitting naive ISO strings like "2026-04-12T15:30:00"
            // with no timezone offset. Postgres timestamp-with-tz parses naive strings as UTC,
            // which stores Israeli times 3h late (15:30 IST → stored as UTC 15:30 → 18:30 IST on read).
            // If no offset/Z suffix present, force Israel offset (+03:00 standard / +02:00 winter
            // is close enough — DST in Israel is narrower than the bug's impact; prefer consistency).
            const hasOffset = /[+-]\d{2}:?\d{2}$|Z$/.test(scheduled_for);
            const normalizedScheduledFor = hasOffset ? scheduled_for : `${scheduled_for}+03:00`;
            if (!hasOffset) {
              console.warn(`[Webhook] add_event: scheduled_for missing timezone ("${scheduled_for}") — normalizing to +03:00`);
            }
            const { error } = await supabase.from("events").insert({
              id: uid4(),
              household_id: householdId,
              title,
              assigned_to: assigned_to || null,
              scheduled_for: normalizedScheduledFor,
            });
            if (error) throw error;
            summary.push(`Event: "${title}" @ ${normalizedScheduledFor}`);
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

        case "complete_shopping_by_names": {
          // Patch D: user replied to a bot shopping-add ("זה כבר קנינו היום", "יש לנו בבית",
          // or "רק X חסר"). Look up each name in the open shopping list and mark as got.
          // Uses ilike-contains for robustness — "חלב" matches both "חלב" and "חלב 2 ליטר"
          // but would also match "חלב אורז"; prefer exact match when available.
          const { names } = action.data as { names: string[] };
          if (!Array.isArray(names) || names.length === 0) {
            summary.push("complete_shopping_by_names: empty names array — skipped");
            break;
          }
          const { data: openItems } = await supabase
            .from("shopping_items")
            .select("id, name")
            .eq("household_id", householdId)
            .eq("got", false);
          const open = openItems || [];
          const matchedIds: string[] = [];
          for (const name of names) {
            const trimmed = String(name).trim();
            if (!trimmed) continue;
            // Prefer exact match, fall back to contains
            const exact = open.find((it: { id: string; name: string }) => it.name === trimmed);
            const contains = open.find((it: { id: string; name: string }) => it.name.includes(trimmed) || trimmed.includes(it.name));
            const hit = exact || contains;
            if (hit && !matchedIds.includes(hit.id)) matchedIds.push(hit.id);
          }
          if (matchedIds.length === 0) {
            summary.push(`complete_shopping_by_names: no open items matched [${names.join(", ")}]`);
            break;
          }
          const { error } = await supabase
            .from("shopping_items")
            .update({ got: true, got_by: senderName || null, got_at: new Date().toISOString() })
            .in("id", matchedIds)
            .eq("household_id", householdId);
          if (error) throw error;
          summary.push(`Got ${matchedIds.length} shopping items: ${matchedIds.join(",")}`);
          break;
        }

        case "complete_tasks_all_open": {
          // Patch D: user replied to a bot task-list message with "הושלם" / "המשימות הושלמו".
          // We don't have task_ids in the quoted text — mark ALL currently open tasks as done.
          // This is the right call for "המשימות הושלמו" (all tasks done) but could over-mark
          // if a bot message listed only some tasks; the blast radius is small since we'd
          // at most mark OPEN tasks that weren't in the quoted list. If that becomes a problem,
          // we can narrow to tasks whose title appears in quotedText.
          const { data: openTasks } = await supabase
            .from("tasks")
            .select("id")
            .eq("household_id", householdId)
            .eq("done", false);
          const ids = (openTasks || []).map((t: { id: string }) => t.id);
          if (ids.length === 0) {
            summary.push("complete_tasks_all_open: no open tasks to mark");
            break;
          }
          const { error } = await supabase
            .from("tasks")
            .update({ done: true, completed_by: senderName || null, completed_at: new Date().toISOString() })
            .in("id", ids)
            .eq("household_id", householdId);
          if (error) throw error;
          summary.push(`Completed ${ids.length} tasks: ${ids.join(",")}`);
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

        case "add_expense": {
          const {
            amount_text, amount_minor: haikuAmount,
            expense_currency, expense_description, expense_category,
            expense_attribution, expense_paid_by_name,
            expense_occurred_at_hint, expense_visibility_hint,
            raw_text
          } = action.data as Record<string, any>;

          // Fallback currency detection: scan raw text for currency keywords
          // when Haiku didn't set expense_currency or defaulted to ILS
          let currency = (expense_currency || "ILS").toUpperCase();
          if ((!expense_currency || expense_currency === "ILS") && raw_text) {
            const lowerText = raw_text.toLowerCase();
            for (const [keyword, code] of Object.entries(CURRENCY_MAP)) {
              if (lowerText.includes(keyword)) {
                currency = code;
                break;
              }
            }
          }

          let parsed = parseAmountToMinor(amount_text, haikuAmount, currency);

          // Fallback amount extraction: if Haiku didn't extract the amount,
          // scan raw_text for numbers (e.g. "שילמתי 80 דולר" → 80)
          if ((!parsed || parsed.amount_minor === 0) && raw_text) {
            // Match: number with optional comma/decimal, or $-prefixed, or ₪/€/£-prefixed
            const numMatch = raw_text.match(/[$₪€£¥]?\s*([\d,]+(?:\.\d+)?)/);
            if (numMatch) {
              const fallbackNum = numMatch[1].replace(/,/g, "");
              console.log("[Expense] Fallback amount extraction from raw_text: " + fallbackNum + " " + currency);
              parsed = parseAmountToMinor(fallbackNum, undefined, currency);
            }
          }

          if (!parsed || parsed.amount_minor === 0) {
            // No amount provided — Sonnet should ask "כמה?"
            console.log("[Expense] No amount provided for: " + (expense_description || "unknown") + " — will ask user");
            summary.push("Expense-needs-amount: " + (expense_description || "הוצאה"));
            break;
          }
          if (parsed.amount_minor < 50 || parsed.amount_minor > 100000000) {
            // Suspicious amount — log but skip insert
            console.warn("[Expense] Suspicious amount: text=" + amount_text + " minor=" + haikuAmount + " currency=" + currency);
            summary.push("Expense-skipped: suspicious amount");
            break;
          }

          const { paid_by, attribution } = resolveExpenseAttribution(
            expense_attribution, expense_paid_by_name, senderName
          );

          const expenseId = uid4();
          const { error } = await supabase.from("expenses").insert({
            id: expenseId,
            household_id: householdId,
            amount_minor: parsed.amount_minor,
            currency: parsed.currency,
            description: expense_description || "הוצאה",
            category: expense_category || expense_description || "אחר",
            paid_by,
            attribution,
            occurred_at: expense_occurred_at_hint || new Date().toISOString(),
            visibility: expense_visibility_hint || "household",
            source: "whatsapp",
            logged_by_phone: senderName || null,
          });
          if (error) throw error;

          const displayAmount = (parsed.amount_minor / (MINOR_UNIT[parsed.currency] || 100)).toLocaleString("he-IL");
          const currencySymbol = parsed.currency === "ILS" ? "₪" : parsed.currency === "EUR" ? "€" : parsed.currency === "USD" ? "$" : parsed.currency === "GBP" ? "£" : parsed.currency;
          summary.push("Expense: " + currencySymbol + displayAmount + " " + (expense_description || "הוצאה") + (paid_by ? " (" + paid_by + ")" : ""));
          break;
        }

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
            .select("id, title, members, type")
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
  // --- Original entries ---
  yaron: "ירון", adi: "עדי", noa: "נועה", noah: "נועה", lior: "ליאור",
  roie: "רועי", roi: "רועי", dan: "דן", omer: "עומר", omar: "עומר",
  gal: "גל", ido: "עידו", nir: "ניר", tal: "טל", ori: "אורי",
  amit: "עמית", yael: "יעל", maya: "מאיה", shira: "שירה", tamar: "תמר",
  michal: "מיכל", mor: "מור", neta: "נטע", lina: "לינה", mia: "מיה",
  yuval: "יובל", eyal: "אייל", ofek: "אופק", ohev: "אוהב",
  oriane: "אוריין", orian: "אוריין", lin: "לין", gur: "גור",
  liona: "ליאונה", maayan: "מעיין", amor: "אמור",
  shanee: "שני", shani: "שני", shachar: "שחר", sahar: "סהר",
  saar: "סער", "sa'ar": "סער", chen: "חן", lee: "לי", li: "לי", lia: "ליאה",
  noy: "נוי", ron: "רון", ran: "רן", alon: "אלון", eran: "ערן",
  oren: "אורן", noga: "נוגה", shay: "שי", shai: "שי",
  rotem: "רותם", liron: "לירון", lihi: "ליהי", sapir: "ספיר",
  inbar: "ענבר", hadar: "הדר", agam: "אגם", alma: "אלמה",
  itay: "איתי", itai: "איתי", ilan: "אילן", amir: "אמיר",
  tomer: "תומר", dor: "דור", guy: "גיא", matan: "מתן",
  // --- Expanded: common male names ---
  gilad: "גלעד", timor: "טימור", liran: "לירן", daniel: "דניאל",
  ariel: "אריאל", david: "דוד", michael: "מיכאל", jonathan: "יונתן",
  yonatan: "יונתן", adam: "אדם", ben: "בן", tom: "תום", noam: "נועם",
  asaf: "אסף", boaz: "בועז", yossi: "יוסי", yosi: "יוסי",
  avi: "אבי", moshe: "משה", mosh: "משה", yoav: "יואב",
  nadav: "נדב", erez: "ארז", ziv: "זיו", peleg: "פלג",
  kobi: "קובי", koby: "קובי", yaniv: "יניב", yotam: "יותם",
  raz: "רז", sagee: "שגיא", sagi: "שגיא", lavi: "לביא",
  shmueli: "שמואל", shmuel: "שמואל", yitzchak: "יצחק", itzhak: "יצחק",
  isaac: "יצחק", haim: "חיים", chaim: "חיים", jacob: "יעקב",
  yakov: "יעקב", yaakov: "יעקב", tzahi: "צחי", tsahi: "צחי",
  eli: "אלי", elad: "אלעד", elhanan: "אלחנן",
  amitay: "אמיתי", amitai: "אמיתי", nimrod: "נמרוד", shahaf: "שחף",
  omri: "עומרי", eden: "עדן", nitzan: "ניצן", stav: "סתיו",
  harel: "הראל", arik: "אריק", roni: "רוני", barak: "ברק",
  gilboa: "גלבוע", dani: "דני", udi: "אודי", oded: "עודד",
  ohad: "אוהד", meir: "מאיר", naor: "נאור", liam: "ליאם",
  yam: "ים", or: "אור", elia: "אליה", neriya: "נריה",
  // --- Expanded: common female names ---
  dana: "דנה", hila: "הילה", natali: "נטלי", natalie: "נטלי",
  nofar: "נופר", efrat: "אפרת", reut: "רעות",
  orly: "אורלי", rachel: "רחל", sarah: "שרה", sara: "שרה",
  dafna: "דפנה", daphna: "דפנה", keren: "קרן",
  naama: "נעמה", naomi: "נעמי", rona: "רונה",
  ronit: "רונית", sigal: "סיגל", hagit: "הגית", galit: "גלית",
  dikla: "דיקלה", carmela: "כרמלה", carmel: "כרמל",
  hagar: "הגר", tehila: "תהילה", teehila: "תהילה",
  revital: "רביטל", rinat: "רינת", einat: "עינת",
  avigail: "אביגיל", yarden: "ירדן", shelly: "שלי",
  sheli: "שלי", tali: "טלי", merav: "מירב", miri: "מירי",
  lilach: "לילך", lilac: "לילך", anat: "ענת", ayelet: "איילת",
  sivan: "סיון", idit: "עידית", osnat: "אסנת",
  liora: "ליאורה", ella: "אלה", nirit: "נירית", ortal: "אורטל",
  limor: "לימור", hadas: "הדס", ilana: "אילנה",
  oshrat: "אושרת", pnina: "פנינה", shoshana: "שושנה",
  // --- Expanded: additional common names ---
  bar: "בר", yonit: "יונית", avital: "אביטל", ruti: "רותי",
  ruth: "רות", lea: "לאה", leah: "לאה",
  ethan: "איתן", etan: "איתן", elai: "אלעי",
  nave: "נווה", naveh: "נווה", noaa: "נועה",
  yarin: "ירין", shaul: "שאול", reuven: "ראובן",
  yehuda: "יהודה", shimon: "שמעון", gidi: "גידי",
  uri: "אורי", avishai: "אבישי", eliya: "אליה",
};

// Names where English spelling maps to multiple Hebrew spellings — Sheli should ask
const AMBIGUOUS_NAMES: Record<string, string[]> = {
  maya: ["מאיה", "מיה"],
  mia: ["מיה", "מאיה"],
  noa: ["נועה", "נעה"],
  noah: ["נועה", "נעה"],
  sahar: ["סהר", "סער"],
  saar: ["סער", "סהר"],
  "sa'ar": ["סער", "סהר"],
  lee: ["לי", "ליא"],
  li: ["לי", "ליא"],
  lia: ["ליאה", "ליה"],
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
  // Try lookup (case-insensitive)
  const lower = first.toLowerCase();
  if (NAME_MAP[lower]) return NAME_MAP[lower];
  // Strip trailing 's' (English possessive/plural) — "Gilads" → "Gilad", "Yarons" → "Yaron"
  if (lower.length > 2 && lower.endsWith("s")) {
    const stripped = lower.slice(0, -1);
    if (NAME_MAP[stripped]) return NAME_MAP[stripped];
  }
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

function isAmbiguousName(senderName?: string): string[] | null {
  if (!senderName) return null;
  const cleaned = senderName.replace(/[^\u0590-\u05FF\u0041-\u007A\u0061-\u007A\u0030-\u0039\s\-']/g, "").trim();
  const first = cleaned.split(" ")[0].trim().toLowerCase();
  return AMBIGUOUS_NAMES[first] || null;
}

function getOnboardingWelcome(senderName?: string): string {
  const name = hebrewizeName(senderName || "");
  const greeting = name
    ? `היי ${name}! 😊 אני שלי, נעים מאוד!`
    : `היי! 😊 אני שלי, נעים מאוד!`;
  return `${greeting}

אני יודעת לנהל רשימת קניות, לרשום מטלות, לעקוב אחרי הוצאות ולהזכיר דברים חשובים.
אפשר גם לשלוח לי הודעה קולית, אני מבינה! 🎤

יש בבית ילדים? אפשר גם להוסיף אותי לקבוצת הווטסאפ שלכם ואני אעזור לעשות סדר במשפחה 🏠

רוצים לנסות? כתבו לי:
"תזכירי לי בעוד שעה לכבות את הדוד" ⏰
או
"חלב, ביצים ולחם" 🛒`;
}

// (Removed: ONBOARDING_WAITING_MESSAGES, getOnboardingWaitingMessage — replaced by nudge system)

// ─── Group Nudge (one-time, after 2 days OR 5 actions) ───

const GROUP_NUDGE_MESSAGE = "אגב, אפשר לצרף אותי לקבוצת הווטסאפ ואוכל לתאם ולעזור לכל בני הבית 🏠";
const GROUP_NUDGE_MIN_DAYS = 2;
const GROUP_NUDGE_MIN_ACTIONS = 5;

// Count real actions (tasks + shopping + events + reminders) for a household.
// Reusable for nudge threshold + future paywall.
async function countHouseholdActions(householdId: string | null): Promise<number> {
  if (!householdId) return 0;
  const [t, s, e, r, exp] = await Promise.all([
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("shopping_items").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("events").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("reminder_queue").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("expenses").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("deleted", false),
  ]);
  return (t.count || 0) + (s.count || 0) + (e.count || 0) + (r.count || 0) + (exp.count || 0);
}

async function shouldSendGroupNudge(convo: Record<string, any>): Promise<boolean> {
  // Already sent
  if (convo.context?.group_nudge_sent_at) return false;
  // Already in a real group
  if (convo.state === "personal" || convo.state === "joined") return false;

  const createdAt = convo.created_at ? new Date(convo.created_at) : null;
  const daysSinceCreated = createdAt
    ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  // Check real action count (not message count — "lol" x5 shouldn't trigger nudge)
  const actionCount = await countHouseholdActions(convo.household_id);

  return actionCount >= GROUP_NUDGE_MIN_ACTIONS || daysSinceCreated >= GROUP_NUDGE_MIN_DAYS;
}

// (Removed: DEMO_CATEGORIES — categorization now handled by Sonnet in 1:1 prompt)

// (Removed: generateDemoNudge, demoCategorize, TASK_PATTERNS, handleDemoInteraction — all replaced by single Sonnet call)

// ─── 1:1 Q&A: Answer common questions before falling through to waiting messages ───

const ONBOARDING_QA: Array<{ patterns: RegExp[]; topic: string; keyFacts: string }> = [
  {
    patterns: [/כמה.*עול|מחיר|עלות|תשלום|חינם|בחינם|פרימיום|premium|price|cost|free/i],
    topic: "pricing",
    keyFacts: "40 actions/month free. Premium 9.90 ILS/month unlimited. No credit card needed for free tier. Try it first by adding to group.",
  },
  {
    patterns: [/מה את יודעת|מה את עוש|מה אפשר|יכולות|פיצ׳רים|features|what can you/i],
    topic: "capabilities",
    keyFacts: "Shopping lists (say item name), tasks (assign to person+time), events (date+title), voice messages (up to 30s transcribed), reminders, rotations/turns. Works in 1:1 chat and groups. Also web app at sheli.ai.",
  },
  {
    patterns: [/בטיחות|פרטיות|privacy|secure|קוראת.*הודעות|מקשיבה|שומרת.*מידע|data|כמה.*בטוח|זה.*בטוח|האם.*בטוח/i],
    topic: "privacy",
    keyFacts: "No photos/video stored. Voice transcribed then deleted. All data auto-deleted after 30 days. Only your household sees data. No one outside, including our team.",
  },
  {
    patterns: [/לומדת|משתפר|improving|learn|חכמה יותר|מבינה יותר/i],
    topic: "learning",
    keyFacts: "Learns your nicknames, product names, time expressions. Each correction makes her smarter for your household. Personalized over time.",
  },
  {
    patterns: [/מי רואה|מי יכול לראות|who can see|visible|access.*data/i],
    topic: "data-access",
    keyFacts: "Only household members. Each home completely isolated. No one including our team sees lists or events.",
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
    keyFacts: "Send a message to Sheli on WhatsApp, talk normally. Auto-detects shopping, tasks, events. Can also add to a group. 30 seconds setup.",
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
    keyFacts: "Friends bring Friends program. Each referral = both get free premium month. Link in the app menu.",
  },
  {
    patterns: [/שמי|קוראים לי|השם שלי|לא ככה קוראים|not my name|אני לא/i],
    topic: "name-correction",
    keyFacts: "User is correcting their name. Apologize warmly with humor (סורי! 🙈), use the CORRECT name they provided. Be personal and friendly. Make them feel seen.",
  },
  {
    patterns: [/הודע.*קולי|הקלט|קולית|שומעת.*הודעות|מקשיבה.*הודעות|voice.*message|can you hear|listen.*voice|מבינה.*קול/i],
    topic: "voice-privacy",
    keyFacts: "Yes, Sheli transcribes short voice messages (up to 30 seconds) and processes them the same as typed text. Longer voice notes are skipped — they're usually personal family conversations, not requests. Audio itself isn't stored; only the transcribed text is kept, and all conversation data auto-deletes after 30 days.",
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
You're chatting 1:1 with a user on WhatsApp — this may be the first message or message #50. Always check the CONVERSATION STATE for Message #N before deciding how to open.

PERSONALITY: Like a witty, organized friend who happens to have superpowers.
- Hebrew feminine verbs always (הוספתי, שמרתי, סידרתי, רשמתי)
- Short messages. Fragments OK. Emoji as punctuation, not decoration.
- Hebrew slang where natural (יאללה, סבבה, אחלה)
- NEVER ignore a message — always reply, even to jokes, trolling, or nonsense
- Match their energy: trolling gets witty trolling back, warmth gets warmth
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
- Shopping lists: user says items → you categorize with emoji headers (🥬 פירות וירקות, 🥛 חלב וביצים, 🥩 בשר ודגים, 🍞 מאפים, 🥫 מזווה, 🧊 מוצרים קפואים, 🍺 משקאות, 🧴 ניקוי ובית, 🌿 מוצרים מחנות הטבע, 🧴 טיפוח, 🛒 אחר). ONLY use these categories — never invent new ones. When user mentions a STORE ("מאדונית התבלינים, קפה ומלח אפור"), use the store name as the category for those items.
- Tasks: user says chore → you say "רשמתי! ✅" with task text
- Rotations/turns: after the FIRST task about chores, offer ONCE: "אם יש ילדים בבית — אני מעולה בתורות 😉". Do NOT offer rotations again if "rotation" already appears in TRIED. One offer is enough.
  - If user engages: ask what rotation + who participates → create it
- Reminders: user says time+action → "אזכיר!" with time. When giving examples, use universal tasks like "לאסוף ילדים ב-5" or "לשלם חשבון" — NEVER food examples (meat/cooking) which may alienate vegetarians.
- Events: user says date+event → "שמרתי ביומן!" with date/time
- Expenses: user reports a payment → you log it. Examples: "שילמתי 1300 חשמל", "עלה לנו 800 במסעדה", "שרפתי 500 על דלק", "דוח חניה 250". Log amount, category, who paid.
  INCOMPLETE EXPENSE (no amount): If user says "שילמתי חשמל" or "סגרתי את הגז" WITHOUT a number → do NOT create an expense action. Instead ASK: "כמה עלה החשמל?" or "כמה שילמת על הגז?". When they reply with just a number, THEN create the expense action with that amount.
  CRITICAL "קניתי" RULE: "קניתי X ב-[amount]" = expense (any item + price). "קניתי X" without amount = check if X is on shopping list → mark got, else ignore.
  KEY TENSE: PAST (שילמתי, עלה, יצא לנו) = expense. PRESENT (עולה) = price info, not expense. FUTURE (לשלם) = task.
  NOT expense: "שילמתי עליו" (social treating). "המשכנתא עולה X" (general statement). "הגיע חשבון" (bill arrived, not paid).
  Multi-currency: default ILS. "יורו"/"EUR" → EUR, "דולר"/"$" → USD.
- Expense queries: "כמה שילמנו החודש?" or "תסכמי הוצאות" → use the EXPENSE HISTORY section (if provided in context) to answer. Group by currency. Never fabricate totals.
- Voice messages: user can send a voice note (up to 30s) and you understand it! Mention this ONLY on the designated hint message (every 3rd message). Do NOT force it into messages 1-2.

FORMATTING (WhatsApp RTL):
- NEVER use bullet characters (•, ☐, -, *) for lists — they stretch left in Hebrew RTL and look broken.
- For shopping lists: emoji category header on its own line, then items below it one per line WITHOUT any prefix. Example:
  🥛 חלב וביצים
  חלב
  ביצים
  🍞 מאפים
  לחם
- For other lists: use emoji at start of each line, or plain text lines under a header. NO bullets.

RULES:
1. If user sends actionable items (shopping, task, reminder, event) → execute AND reply naturally. Use ACTIONS metadata.
2. If user sends a question → answer warmly. If about pricing: free 40 actions/month, premium 9.90 ILS. If about privacy: data auto-deleted after 30 days, only your household sees it.
3. GROUP MENTIONS: The system handles group suggestions separately. Do NOT bring up groups yourself. Only mention groups if the user explicitly asks about groups, shared lists, or mentions roommates/partner/family. If the user mentions living with others, you may say something like "אפשר להוסיף אותי לקבוצה ואני אתאם לכולם" — but only as a natural response to THEIR mention, never proactively.
4. Capability hints: mention ONE untried capability ONLY every 3rd message (check "Message #N" — hint only when N is divisible by 3). On other messages, just respond to what the user said. NO hints. This prevents feeling pushy. When you do hint, weave it naturally into the reply — never a separate "אגב, אני גם יודעת..." sentence on its own.
5. NEVER say "דמו", "ניסיון", "תכונה", "פיצ'ר". This is real, not a test.
6. NEVER ask personal questions (kids' names, ages, family structure). Learn ONLY from what they volunteer.
7. If user corrects their name ("קוראים לי X", "שמי X") → apologize warmly ("סורי! 🙈"), use correct name going forward.
8. If user says something you can't help with (weather, politics, trivia) → deflect playfully, pivot back: "אני יותר בקטע של קניות ומטלות 😄 אבל אם צריך משהו לבית — אני כאן!"
    ${SHARED_APP_RULES}
9. Compound Hebrew product names (חלב אורז, שמן זית, נייר טואלט, חמאת בוטנים) are ONE item. Never split.
10. First interaction with a new name: say "נעים להכיר" (NOT "נעים לפגוש אותך" — we haven't met in person). After a voice message specifically: "נעים לשמוע אותך" (nice to hear you — personal touch).
11. Voice messages: user may send transcribed voice text — handle identically to typed text. If the user already SENT a voice message, do NOT suggest voice as a new feature — they already know.
12. ${SHARED_HEBREW_GRAMMAR}

ACTION QUALITY GUARDRAILS — never store garbage in ACTIONS:
14. NEVER store an action whose text is just a TRIGGER WORD with no real content:
    - BAD: {"type":"reminder","text":"תזכירי לי"} ← "remind me" is the verb, not the content
    - BAD: {"type":"event","text":"תזכורת"} ← "reminder" is a category, not an event title
    - BAD: {"type":"task","text":"לעשות"} ← "to do" alone has no body
    - If user says "תזכירי לי" with no follow-up → DO NOT create an action. Reply: "בשמחה! מה להזכיר ומתי? ⏰" and wait for them to provide content.
    - If user says "תוסיפי לרשימה" with no item → reply: "מה להוסיף?" and wait.
    - Same for: "תרשמי", "שמרי", "תזכרי", "להוסיף", "תזכורת" alone, "מסיבה" alone, "אירוע" alone.
15. EVENTS MUST HAVE A DATE. If user mentions an event but no date/time → DO NOT store as event. Either:
    (a) Ask: "מתי המסיבה? אני אשמור ביומן 📅" and wait.
    (b) If they hint at a vague time ("בקרוב", "בעתיד") → store as TASK instead of event ({"type":"task","text":"לתכנן את המסיבה"}).
    A bare "מסיבה" or "פגישה" with no date is NEVER a valid event.
16. REMINDERS MUST HAVE BOTH content AND time. If either is missing → ask for the missing piece, do NOT store partial.
    - "תזכירי לי לקחת ויטמינים" → MISSING TIME → ask "באיזו שעה?" and wait.
    - "תזכירי לי בשעה 8" → MISSING CONTENT → ask "מה להזכיר ב-8?" and wait.
    - Only when both are present, create the reminder action.
17. If your extracted action text is < 3 chars or matches a known trigger word → drop the action and ask for clarification instead.
18. "Items collected so far" in the CONVERSATION STATE is a LIVE snapshot of the user's real data — past reminders (already fired) and past events (already happened) are pre-filtered out. So when the user asks "מה יש היום?" / "מה ברשימה?" / "what's today" — you can list these items as-is. They are all current and relevant. Reminders include a "send_at" ISO timestamp; events include a "scheduled_for" timestamp. Use these to phrase replies naturally ("יש לך מסיבה ב-18 לאפריל" — extract the date from the timestamp).

OUTPUT FORMAT — you MUST include these hidden metadata blocks BEFORE your visible reply:
<!--ACTIONS:[]-->
<!--TRIED:[]-->
Your visible reply here

ACTIONS array: each object has "type" and relevant fields:
ADD:
- shopping: {"type":"shopping","items":["חלב","ביצים"]}
- task: {"type":"task","text":"לפרוק מדיח"}
- reminder: {"type":"reminder","text":"להוציא בשר","time":"17:00","send_at":"2026-04-12T17:00:00+03:00"}
  IMPORTANT: always include send_at as full ISO 8601 with Israel timezone (+03:00). If user says "ב-5" → today 17:00 IST. If "בעוד שעה" → compute from current time. If time already passed today → use tomorrow. The "time" field is a display hint; "send_at" is what actually schedules the reminder.
- event: {"type":"event","title":"ארוחת ערב","date":"2026-04-11","time":"19:00"}
- rotation: {"type":"rotation","title":"כלים","members":["יובל","נועה"]}
- expense: {"type":"expense","amount":1300,"currency":"ILS","description":"חשמל","category":"חשמל","attribution":"speaker","paid_by_name":null}
  attribution values: "speaker" (שילמתי), "named" (אבא שילם → paid_by_name="אבא"), "joint" (שילמנו), "household" (שולם, passive)
  Currency: "ILS" (default), "EUR" (יורו/EUR), "USD" (דולר/$), "GBP" (פאונד/£)
UPDATE (rename/edit existing):
- update_shopping: {"type":"update_shopping","old_name":"פסטה","new_name":"פסטה פנה"}
- update_task: {"type":"update_task","old_text":"לנקות","new_text":"לנקות את המטבח"}
- update_reminder: {"type":"update_reminder","old_text":"להוציא בשר","new_text":"להוציא עוף","new_send_at":"2026-04-14T18:00:00+03:00"}
- update_event: {"type":"update_event","old_title":"ארוחת ערב","new_title":"ארוחה עם סבתא","new_date":"2026-04-20","new_time":"19:00"}
REMOVE (delete existing):
- remove_shopping: {"type":"remove_shopping","name":"פסטה"}
- remove_task: {"type":"remove_task","text":"לנקות"}
- remove_reminder: {"type":"remove_reminder","text":"להוציא בשר"}
- remove_event: {"type":"remove_event","title":"ארוחת ערב"}
OTHER:
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

// Fallback extraction: parse shopping items from Hebrew free-text when Sonnet ACTIONS block is empty.
// Strips command verbs, splits by commas/ו, filters instruction clauses.
function extractShoppingItemsFromText(text: string): string[] {
  let cleaned = text
    // Strip common command verbs at start
    .replace(/^(תוסיפי|תוסיף|תכניסי|תכניס|תרשמי|תרשום|להוסיף|לרשום)\s*(גם\s*)?/u, "")
    .trim();
  if (!cleaned) return [];
  // Remove instruction clauses like "והפסטה צריכה להיות פסטה פנה"
  cleaned = cleaned.replace(/ו?ה?\S+\s+צריכ[הא]\s+להיות\s+.*/u, "").trim();
  cleaned = cleaned.replace(/\s+במקום\s+.*/u, "").trim();
  // Split by comma, "ו" conjunction (word boundary), or newline
  const parts = cleaned.split(/\s*,\s*|\s*\n\s*/).flatMap(part =>
    // Split "X וY" but not compound names like "אורז בסמטי ועגול"
    // Only split on "ו" when it's between two distinct items (preceded by space)
    part.split(/\s+ו(?=[א-ת])/)
  );
  return parts
    .map(p => p.trim())
    .filter(p => p.length >= 2 && !/^(גם|את|של|עוד|בבקשה|לי)$/u.test(p));
}

// ─── Shared 1:1 conversation history (used by both chatting + personal paths) ───

async function fetch1on1History(groupId: string, currentUserName: string): Promise<{ role: string; content: string }[]> {
  // Fetch last 10 messages (both user + bot) for this 1:1 chat, oldest first
  const { data: history } = await supabase.from("whatsapp_messages")
    .select("sender_phone, sender_name, message_text")
    .eq("group_id", groupId)
    .not("message_text", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!history || history.length === 0) return [];

  // Reverse to chronological order, map to Sonnet multi-turn format
  const BOT_PHONE = "972555175553";
  const turns: { role: string; content: string }[] = [];
  for (const msg of history.reverse()) {
    if (msg.sender_phone === BOT_PHONE) {
      // Bot message — strip metadata blocks, keep visible text only
      const visible = (msg.message_text || "")
        .replace(/<!--ACTIONS:.*?-->/s, "")
        .replace(/<!--TRIED:.*?-->/s, "")
        .replace(/<!--MEMORY:.*?-->/s, "")
        .replace(/<!--REMINDER:\{.*?\}-->/s, "")
        .trim();
      if (visible) turns.push({ role: "assistant", content: visible });
    } else {
      // User message
      const name = msg.sender_name || currentUserName || "משתמש";
      turns.push({ role: "user", content: `[${name}]: ${msg.message_text || ""}` });
    }
  }
  return turns;
}

// Merge consecutive same-role messages and ensure first turn is "user" (Sonnet requirement).
function prepareSonnetTurns(turns: { role: string; content: string }[]): { role: string; content: string }[] {
  const merged: { role: string; content: string }[] = [];
  for (const msg of turns) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += "\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  while (merged.length > 0 && merged[0].role !== "user") merged.shift();
  return merged;
}

// Format a UTC date as a human-readable Israel time string for Sonnet context.
// Prevents timezone confusion: Sonnet sees "Wednesday 16/4 16:00" not "2026-04-16T13:00:00+00:00".
function toIsraelTimeStr(utcDate: string): string {
  try {
    const d = new Date(utcDate);
    return d.toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "short",
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return utcDate;
  }
}

// Load active household items (tasks, shopping, events, reminders, expenses) for Sonnet context.
// Times are converted to Israel timezone strings so Sonnet doesn't misread UTC as local.
async function loadHouseholdItems(householdId: string): Promise<{ type: string; text: string; scheduled_for?: string; send_at?: string }[]> {
  const nowIso = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [tasksRes, shopRes, eventsRes, remindersRes, expensesRes] = await Promise.all([
    supabase.from("tasks").select("title").eq("household_id", householdId).eq("done", false).order("created_at", { ascending: true }).limit(10),
    supabase.from("shopping_items").select("name").eq("household_id", householdId).eq("got", false).order("created_at", { ascending: true }).limit(10),
    supabase.from("events").select("title, scheduled_for").eq("household_id", householdId).gte("scheduled_for", nowIso).order("scheduled_for", { ascending: true }).limit(10),
    supabase.from("reminder_queue").select("message_text, send_at").eq("household_id", householdId).eq("sent", false).gte("send_at", nowIso).order("send_at", { ascending: true }).limit(10),
    supabase.from("expenses").select("amount_minor, currency, description, category, paid_by, attribution, occurred_at")
      .eq("household_id", householdId).eq("deleted", false)
      .gte("occurred_at", thirtyDaysAgo)
      .order("occurred_at", { ascending: false }).limit(20),
  ]);
  return [
    ...(tasksRes.data || []).map((r: any) => ({ type: "task", text: r.title })),
    ...(shopRes.data || []).map((r: any) => ({ type: "shopping", text: r.name })),
    ...(eventsRes.data || []).map((r: any) => ({ type: "event", text: r.title, scheduled_for: toIsraelTimeStr(r.scheduled_for) })),
    ...(remindersRes.data || []).map((r: any) => ({ type: "reminder", text: r.message_text, send_at: toIsraelTimeStr(r.send_at) })),
    ...(expensesRes.data || []).map((r: any) => {
      const unit: Record<string, number> = { ILS: 100, USD: 100, EUR: 100, GBP: 100 };
      const sym: Record<string, string> = { ILS: "\u20AA", USD: "$", EUR: "\u20AC", GBP: "\u00A3" };
      const u = unit[r.currency] || 100;
      const s = sym[r.currency] || r.currency;
      return { type: "expense", text: `${s}${(r.amount_minor / u).toLocaleString("he-IL")} ${r.description}${r.paid_by ? " (" + r.paid_by + ")" : ""}` };
    }),
  ];
}

// ─── Shared 1:1 action execution (used by both chatting + personal paths) ───

const TRIGGER_WORDS_SET = new Set([
  "תזכירי לי", "תזכירי", "תזכורת", "תזכור", "תזכרי",
  "תוסיפי", "תוסיף", "להוסיף", "תכניסי", "תכניס",
  "תרשמי", "תרשום", "לרשום", "שמרי", "שמור", "לשמור",
  "לעשות", "לבצע", "לטפל",
  "remind me", "reminder", "add",
]);

const ITEMS_BASED_TYPES = new Set([
  "shopping", "update_shopping", "remove_shopping",
  "update_task", "remove_task",
  "update_reminder", "remove_reminder",
  "update_event", "remove_event",
  "name_correction", "expense",
]);

async function execute1on1Actions(params: {
  raw: string;
  text: string;
  phone: string;
  householdId: string | null;
  userName: string;
  convoContext?: any;
  logPrefix?: string;
  resolveHousehold?: () => Promise<string>;
}): Promise<{ actions: any[]; visibleReply: string; triedCaps: string[] }> {
  const { raw, text, phone, userName, convoContext, logPrefix = "[1:1]" } = params;
  let householdId = params.householdId;

  // 1. Observability
  console.log(`${logPrefix} Sonnet raw (${raw.length}c): ${raw.slice(0, 400)}`);

  // 2. Parse hidden metadata
  const actionsMatch = raw.match(/<!--ACTIONS:(.*?)-->/s);
  const triedMatch = raw.match(/<!--TRIED:(.*?)-->/s);
  const visibleReply = raw
    .replace(/<!--ACTIONS:.*?-->/s, "")
    .replace(/<!--TRIED:.*?-->/s, "")
    .trim();

  // 3. Parse actions JSON
  let actions: any[] = [];
  if (actionsMatch) {
    try { actions = JSON.parse(actionsMatch[1]); } catch (e) {
      console.error(`${logPrefix} Failed to parse ACTIONS JSON: ${actionsMatch[1].slice(0, 200)}`);
    }
  }
  console.log(`${logPrefix} Parsed ${actions.length} actions for ${phone}`);

  // 4. Guardrail filter
  const isTriggerWordOnly = (t: string): boolean => {
    const trimmed = (t || "").trim().toLowerCase();
    return trimmed.length < 3 || TRIGGER_WORDS_SET.has(trimmed);
  };
  const droppedActions: any[] = [];
  actions = actions.filter((action: any) => {
    if (!action?.type) return false;
    if (ITEMS_BASED_TYPES.has(action.type)) {
      if (action.type === "shopping" && (!action.items || !Array.isArray(action.items) || action.items.length === 0)) {
        droppedActions.push({ reason: "shopping_no_items", action });
        return false;
      }
      if (action.type === "expense" && (!action.amount || (typeof action.amount === "number" && action.amount <= 0))) {
        droppedActions.push({ reason: "expense_no_amount", action });
        return false;
      }
      return true;
    }
    const actionText = action.text || action.title || "";
    if (!actionText || isTriggerWordOnly(actionText)) {
      droppedActions.push({ reason: "trigger_word_only", action });
      return false;
    }
    if (action.type === "event" && !action.date && !action.scheduled_for) {
      droppedActions.push({ reason: "event_no_date", action });
      return false;
    }
    if (action.type === "reminder" && !action.send_at && !action.time) {
      droppedActions.push({ reason: "reminder_no_time", action });
      return false;
    }
    return true;
  });
  if (droppedActions.length > 0) {
    console.warn(`${logPrefix} Guardrail dropped ${droppedActions.length} actions for ${phone}:`, JSON.stringify(droppedActions));
  }

  // 5. Hallucination safety net
  if (actions.length === 0 && /הוספתי|רשמתי|שמרתי|עדכנתי|הכנסתי/.test(visibleReply)) {
    console.warn(`${logPrefix} Hallucination: Sonnet claimed success but ACTIONS empty for ${phone}`);
    const fallbackItems = extractShoppingItemsFromText(text);
    if (fallbackItems.length > 0) {
      actions = [{ type: "shopping", items: fallbackItems }];
      console.log(`${logPrefix} Fallback: extracted ${fallbackItems.length} items: ${fallbackItems.join(", ")}`);
    }
  }

  // 6. Parse tried capabilities
  let triedCaps: string[] = [];
  if (triedMatch) {
    try { triedCaps = JSON.parse(triedMatch[1]); } catch {}
  }

  // 7. Name correction (no household needed)
  for (const action of actions) {
    if (action.type === "name_correction" && action.name) {
      const newGender = detectGender(action.name);
      const updatedContext = { ...(convoContext || {}), name: action.name, gender: newGender, name_spelling_asked: true };
      await supabase.from("onboarding_conversations").update({
        context: updatedContext,
      }).eq("phone", phone);
      console.log(`${logPrefix} Name corrected to: ${action.name}`);
    }
  }

  // 8. Execute real actions (need household)
  const realActions = actions.filter((a: any) => a.type && a.type !== "name_correction");
  if (realActions.length > 0) {
    // Resolve household if not yet available
    if (!householdId && params.resolveHousehold) {
      householdId = await params.resolveHousehold();
    }
    if (!householdId) {
      console.warn(`${logPrefix} No household for ${phone}, skipping ${realActions.length} actions`);
      return { actions, visibleReply, triedCaps };
    }

    const mappedActions: any[] = [];
    for (const action of realActions) {
      switch (action.type) {
        case "shopping":
          if (action.items && Array.isArray(action.items)) {
            mappedActions.push({
              type: "add_shopping",
              data: { items: action.items.map((item: string) => ({ name: item, qty: "1", category: "אחר" })) },
            });
          }
          break;
        case "task":
          mappedActions.push({
            type: "add_task",
            data: { title: action.text || "", assigned_to: null },
          });
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
          break;
        case "rotation":
          if (action.members && Array.isArray(action.members)) {
            mappedActions.push({
              type: "add_task",
              data: { rotation: { title: action.title || "", type: action.rotationType || "duty", members: action.members } },
            });
          }
          break;
        case "reminder": {
          const sendAt = action.send_at
            ? new Date(action.send_at).toISOString()
            : parseReminderTime(action.time || "");
          if (sendAt) {
            const { error: remErr } = await supabase.from("reminder_queue").insert({
              household_id: householdId,
              group_id: phone + "@s.whatsapp.net",
              message_text: action.text || "",
              send_at: sendAt,
              sent: false,
              reminder_type: "user",
              created_by_phone: phone,
              created_by_name: userName,
            });
            if (remErr) console.error(`${logPrefix} Reminder insert error:`, remErr);
            else console.log(`${logPrefix} Reminder created for ${sendAt}: "${action.text}"`);
          } else {
            console.warn(`${logPrefix} Could not parse reminder time: ${JSON.stringify(action)}`);
          }
          break;
        }
        case "expense": {
          const amount = action.amount;
          const currency = (action.currency || "ILS").toUpperCase();
          const minorUnit: Record<string, number> = { ILS: 100, USD: 100, EUR: 100, GBP: 100, JPY: 1 };
          const unit = minorUnit[currency] || 100;
          const amountMinor = Math.round((typeof amount === "number" ? amount : parseFloat(amount) || 0) * unit);

          if (amountMinor <= 0 || amountMinor > 100000000) {
            console.warn(`${logPrefix} Suspicious expense amount: ${amount} ${currency}`);
            break;
          }

          const attribution = action.attribution || "speaker";
          const paidBy = attribution === "named" ? (action.paid_by_name || userName)
                       : attribution === "speaker" ? userName
                       : null;

          const { error: expErr } = await supabase.from("expenses").insert({
            household_id: householdId,
            amount_minor: amountMinor,
            currency,
            description: action.description || "הוצאה",
            category: action.category || action.description || "אחר",
            paid_by: paidBy,
            attribution,
            visibility: "private",
            source: "whatsapp",
            logged_by_phone: phone,
          });
          if (expErr) console.error(`${logPrefix} Expense insert error:`, expErr);
          else console.log(`${logPrefix} Expense logged: ${amountMinor} ${currency} "${action.description}" by ${paidBy || "household"}`);
          break;
        }
        // --- UPDATE / REMOVE actions (table-driven) ---
        case "update_shopping": case "update_task": case "update_reminder": case "update_event":
        case "remove_shopping": case "remove_task": case "remove_reminder": case "remove_event": {
          const CRUD_MAP: Record<string, { table: string; matchCol: string; activeFilter?: Record<string, any> }> = {
            update_shopping:  { table: "shopping_items",  matchCol: "name",         activeFilter: { got: false } },
            update_task:      { table: "tasks",           matchCol: "title",        activeFilter: { done: false } },
            update_reminder:  { table: "reminder_queue",  matchCol: "message_text", activeFilter: { sent: false } },
            update_event:     { table: "events",          matchCol: "title" },
            remove_shopping:  { table: "shopping_items",  matchCol: "name",         activeFilter: { got: false } },
            remove_task:      { table: "tasks",           matchCol: "title",        activeFilter: { done: false } },
            remove_reminder:  { table: "reminder_queue",  matchCol: "message_text", activeFilter: { sent: false } },
            remove_event:     { table: "events",          matchCol: "title" },
          };
          const cfg = CRUD_MAP[action.type];
          const isRemove = action.type.startsWith("remove_");
          // Determine the search text (updates use old_name/old_text/old_title; removes use name/text/title)
          const searchText = isRemove
            ? (action.name || action.text || action.title)
            : (action.old_name || action.old_text || action.old_title);
          if (!searchText) break;
          // Find matching row (include scheduled_for for time-only event updates)
          // Try exact match first, fall back to substring (ilike). Order by most recent to prefer latest.
          let query = supabase.from(cfg.table).select("id, scheduled_for").eq("household_id", householdId);
          if (cfg.activeFilter) for (const [k, v] of Object.entries(cfg.activeFilter)) query = query.eq(k, v);
          // Prefer exact match
          let { data: match, error: findErr } = await query.eq(cfg.matchCol, searchText).order("created_at", { ascending: false }).limit(1).single();
          if (!match) {
            // Fall back to substring match
            let fallbackQ = supabase.from(cfg.table).select("id, scheduled_for").eq("household_id", householdId).ilike(cfg.matchCol, `%${searchText}%`);
            if (cfg.activeFilter) for (const [k, v] of Object.entries(cfg.activeFilter)) fallbackQ = fallbackQ.eq(k, v);
            ({ data: match, error: findErr } = await fallbackQ.order("created_at", { ascending: false }).limit(1).single());
          }
          if (findErr || !match) { console.warn(`${logPrefix} ${action.type}: not found for "${searchText}"`); break; }
          if (isRemove) {
            const { error: delErr } = await supabase.from(cfg.table).delete().eq("id", match.id);
            if (delErr) console.error(`${logPrefix} ${action.type} error:`, delErr);
            else console.log(`${logPrefix} Removed ${cfg.table}: "${searchText}"`);
          } else {
            // Build update payload
            const updates: Record<string, any> = {};
            if (action.new_name) updates.name = action.new_name;
            if (action.new_text) updates[cfg.matchCol] = action.new_text;
            if (action.new_title) updates.title = action.new_title;
            if (action.new_send_at) updates.send_at = new Date(action.new_send_at).toISOString();
            if (action.new_date) {
              updates.scheduled_for = `${action.new_date}${action.new_time ? "T" + action.new_time + ":00+03:00" : "T18:00:00+03:00"}`;
            } else if (action.new_time && match.scheduled_for) {
              // Time-only update: keep existing date (in Israel timezone), replace time
              const d = new Date(match.scheduled_for);
              const israelDate = d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }); // YYYY-MM-DD
              updates.scheduled_for = `${israelDate}T${action.new_time}:00+03:00`;
            }
            const { error: updErr } = await supabase.from(cfg.table).update(updates).eq("id", match.id);
            if (updErr) console.error(`${logPrefix} ${action.type} error:`, updErr);
            else console.log(`${logPrefix} Updated ${cfg.table}: "${searchText}"`);
          }
          break;
        }
        default:
          console.warn(`${logPrefix} Unknown action type: ${action.type}`);
          break;
      }
    }

    // Execute mapped add-actions via the real executor
    if (mappedActions.length > 0) {
      try {
        const { summary } = await executeActions(householdId, mappedActions, userName);
        console.log(`${logPrefix} Executed ${summary.length} actions for ${phone}:`, summary);
      } catch (err) {
        console.error(`${logPrefix} executeActions error:`, err);
      }
    }
  }

  return { actions, visibleReply, triedCaps };
}

async function handleDirectMessage(message: IncomingMessage, prov: WhatsAppProvider) {
  const phone = message.senderPhone;
  const text = (message.text || "").trim();
  const senderName = message.senderName || "";

  console.log(`[1:1] Direct message from ${phone}: "${text.slice(0, 50)}"`);

  // Skip non-text messages in 1:1 (voice is OK — already transcribed upstream)
  if (!text && message.type !== "voice") return;

  // --- Check group membership + conversation state in parallel ---
  const [mappingRes, convoRes] = await Promise.all([
    supabase.from("whatsapp_member_mapping").select("household_id").eq("phone_number", phone).limit(1).single(),
    supabase.from("onboarding_conversations").select("*").eq("phone", phone).single(),
  ]);
  const mapping = mappingRes.data;
  let convo = convoRes.data;

  // ─── Preferred name override (2026-04-15) ───
  // If the user explicitly asks to be called differently, store it in
  // context.preferred_name. The morning nudge reads preferred_name first
  // (see public.fire_onboarding_nudge) and trusts the user's own spelling
  // instead of running it through hebrewize_name.
  //
  // Patterns supported (explicit imperatives only — "אני X" / "i'm X"
  // excluded because they match too many non-name utterances):
  //   "תקראי לי X" / "תקרא לי X" / "קראי לי X" / "קרא לי X"
  //   "קוראים לי X"
  //   "השם שלי X" / "השם שלי הוא X"
  //   "call me X" / "my name is X"
  // Name capture: 1 or 2 tokens of letters (+ ' and -), 2–40 chars total.
  if (convo) {
    const RENAME_RE = /^\s*(?:תקרא[יי]?\s+ל[יי]|קרא[יי]?\s+ל[יי]|קוראים\s+לי|השם\s+שלי(?:\s+הוא)?|call\s+me|my\s+name\s+is)\s+([\p{L}][\p{L}'\-]{0,20}(?:\s+[\p{L}][\p{L}'\-]{0,20})?)\s*$/iu;
    const renameMatch = text.match(RENAME_RE);
    if (renameMatch) {
      const newName = renameMatch[1].trim();
      if (newName.length >= 2 && newName.length <= 40 && /^[\p{L}\s'\-]+$/u.test(newName)) {
        const newContext = { ...(convo.context || {}), preferred_name: newName };
        await supabase.from("onboarding_conversations").update({
          context: newContext,
          updated_at: new Date().toISOString(),
        }).eq("phone", phone);
        const reply = `אשמח לקרוא לך ${newName} מעכשיו 😊`;
        await sendAndLog(prov, { groupId: message.groupId, text: reply }, {
          householdId: convo.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "onboarding_reply"
        });
        console.log(`[1:1] Set preferred_name="${newName}" for ${phone}`);
        return;
      }
    }
  }

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
      tried_capabilities: [],
    });

    // Send welcome
    const welcome = getOnboardingWelcome(senderName);
    await sendAndLog(prov, { groupId: message.groupId, text: welcome }, {
      householdId: "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "onboarding_reply"
    });
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
    await sendAndLog(prov, {
      groupId: message.groupId,
      text: "אני כבר בקבוצה שלכם! דברו איתי שם, או כתבו לי כאן לדברים אישיים 😊",
    }, {
      householdId: convo?.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "onboarding_reply"
    });
    return;
  }

  // --- Active conversation: send to Sonnet ---
  const userName = convo.context?.name || hebrewizeName(senderName) || "";

  // Load live items (empty for pre-household users — they haven't executed real actions yet)
  const existingItems: any[] = convo.household_id
    ? await loadHouseholdItems(convo.household_id)
    : [];

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

  // Check for ambiguous name (English spelling → multiple Hebrew options)
  const ambiguousOptions = isAmbiguousName(message.senderName || "");
  const nameAskedAlready = convo.context?.name_spelling_asked === true;

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
- Group nudge sent: ${convo.context?.group_nudge_sent_at ? "yes (do NOT mention groups)" : "no (system will handle it)"}
${msgCount > 1 ? `
CONVERSATION CONTINUITY — CRITICAL:
- This is message #${msgCount}. The user already knows who you are.
- Do NOT re-introduce yourself.
- Do NOT say "אני שלי" or explain what you can do ("קניות? מטלות? משהו שצריך לזכור?").
- Do NOT open with "יאללה בואי נראה" or equivalent welcome energy.
- You are mid-conversation. Reply to what they just said, the way a friend would.
- If they ask a question, answer it directly.
- If they send an action, execute it naturally.
- Follow rule 4 for capability hints: ONLY when ${msgCount} is divisible by 3.` : `
FIRST MESSAGE: This is the user's first reply after your welcome. Brief warmth is fine, but focus on what they said.`}
${ambiguousOptions && !nameAskedAlready ? `\nNAME SPELLING: The user's name "${userName}" could be spelled ${ambiguousOptions.join(" or ")} in Hebrew. In your FIRST reply, ask naturally which spelling they prefer. Example: "אגב, ${ambiguousOptions[0]} או ${ambiguousOptions[1]}? אני אוהבת לדייק 😊". After asking, include a name_correction action with their answer. This is a ONE-TIME question — do not ask again.` : ""}
${qaMatch ? `\nTOPIC HINT: User is asking about "${qaMatch.topic}". Key facts: ${qaMatch.keyFacts}` : ""}`;

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.warn("[1:1] No ANTHROPIC_API_KEY — sending fallback");
      await sendAndLog(prov, { groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" }, {
        householdId: convo.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "error_fallback"
      });
      return;
    }

    // Build multi-turn conversation history (BEFORE logMessage so current msg isn't double-counted)
    const historyTurns = await fetch1on1History(message.groupId, userName);
    // Log incoming message AFTER history fetch to avoid it appearing twice in Sonnet context
    await logMessage(message, "received_1on1", convo.household_id || "unknown");
    // Build final Sonnet message array
    const currentMsg = `${message.quotedText ? `[Quoted message being replied to: "${message.quotedText}"]\n` : ""}[${userName || "משתמש"}]: ${text}`;
    const mergedMessages = prepareSonnetTurns([...historyTurns, { role: "user", content: currentMsg }]);
    console.log(`[1:1] Conversation history: ${mergedMessages.length} turns for ${phone}`);

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
        messages: mergedMessages,
      }),
    });

    if (!response.ok) {
      console.error(`[1:1] Sonnet error: ${response.status}`);
      await sendAndLog(prov, { groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" }, {
        householdId: convo.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "error_fallback"
      });
      return;
    }

    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";

    // Execute actions via shared function
    const { actions, visibleReply, triedCaps: parsedTried } = await execute1on1Actions({
      raw,
      text,
      phone,
      householdId: convo.household_id || null,
      userName: userName || senderName,
      convoContext: convo.context,
      logPrefix: "[1:1]",
      resolveHousehold: () => ensureOnboardingHousehold(phone, convo as Record<string, unknown>, userName),
    });

    const newTried = parsedTried.length > 0 ? parsedTried : triedCaps;

    // If we showed the ambiguous name prompt, mark it as asked even if user didn't answer yet
    if (ambiguousOptions && !nameAskedAlready) {
      const ctx = { ...(convo.context || {}), name_spelling_asked: true };
      await supabase.from("onboarding_conversations").update({ context: ctx }).eq("phone", phone);
    }

    // Determine if user asked "how does it work" → state = invited
    const askedHowItWorks = qaMatch?.topic === "getting-started";
    const newState = askedHowItWorks ? "invited" : "chatting";

    // Update conversation
    await supabase.from("onboarding_conversations").update({
      state: newState,
      message_count: msgCount,
      tried_capabilities: newTried,
      nudge_count: 0,
      updated_at: new Date().toISOString(),
    }).eq("phone", phone);

    // Send reply
    if (visibleReply) {
      await sendAndLog(prov, { groupId: message.groupId, text: visibleReply }, {
        householdId: convo.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId,
        replyType: actions.length > 0 ? "action_reply" : "direct_reply"
      });
    }

    // Group nudge check (one-time, after 2 days OR 5 real actions)
    const updatedConvo = { ...convo, message_count: msgCount, state: newState };
    if (await shouldSendGroupNudge(updatedConvo) && !isQuietHours()) {
      await sendAndLog(prov, { groupId: message.groupId, text: GROUP_NUDGE_MESSAGE }, {
        householdId: convo.household_id || "unknown", groupId: message.groupId, replyType: "nudge"
      });
      await supabase.from("onboarding_conversations").update({
        context: { ...(convo.context || {}), group_nudge_sent_at: new Date().toISOString() },
      }).eq("phone", phone);
      console.log(`[1:1] Group nudge sent to ${phone}`);
    }
    console.log(`[1:1] Sonnet 1:1 reply for ${phone}: actions=${actions.length}, tried=${newTried.join(",")}`);

  } catch (err) {
    console.error("[1:1] handleDirectMessage error:", err);
    try {
      await sendAndLog(prov, { groupId: message.groupId, text: "אופס, משהו השתבש 🙈 נסו שוב?" }, {
        householdId: convo?.household_id || "unknown", groupId: message.groupId, inReplyTo: message.messageId, replyType: "error_fallback"
      });
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
  const senderName = message.senderName || "";

  if (!text) return;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return;

  try {
    // Parallel: load items, conversation context, and chat history in one roundtrip
    const [existingItems, convoRes, historyTurns] = await Promise.all([
      loadHouseholdItems(householdId),
      supabase.from("onboarding_conversations").select("*").eq("phone", phone).single(),
      fetch1on1History(message.groupId, senderName), // senderName as fallback; refined after convo loads
    ]);
    // Log incoming message AFTER history fetch (prevents duplicate in Sonnet context)
    await logMessage(message, "received_1on1_personal", householdId);

    const convo = convoRes.data;
    const userName = convo?.context?.name || hebrewizeName(senderName) || "";
    const userGender = convo?.context?.gender || null;

    const contextBlock = `
PERSONAL CHANNEL MODE: This user already has Sheli in a group (household: ${householdId}). This 1:1 chat is their personal line. Handle requests normally — shopping, tasks, reminders all work here and go to the shared household. For shared items, gently suggest writing in the group so everyone sees it.

CONVERSATION STATE:
- User name: ${userName || "unknown"}
- User gender: ${userGender || "unknown (use plural אתם)"}
- Items collected so far: ${JSON.stringify(existingItems)}
- Current time in Israel: ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}

CONVERSATION CONTINUITY — CRITICAL:
- This user is already onboarded and has you in their group. They know who you are.
- Do NOT re-introduce yourself. Do NOT say "אני שלי" or explain your capabilities.
- Do NOT open with "יאללה בואי נראה" or welcome-style intros.
- Reply to what they just said, the way a friend would mid-conversation.`;
    const currentMsg = `${message.quotedText ? `[Quoted message being replied to: "${message.quotedText}"]\n` : ""}[${userName || "משתמש"}]: ${text}`;
    const mergedMessages = prepareSonnetTurns([...historyTurns, { role: "user", content: currentMsg }]);
    console.log(`[1:1 personal] Conversation history: ${mergedMessages.length} turns for ${phone}`);

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
        messages: mergedMessages,
      }),
    });

    if (!response.ok) return;
    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";

    // Execute actions via shared function
    const { actions, visibleReply } = await execute1on1Actions({
      raw,
      text,
      phone,
      householdId,
      userName: userName || senderName,
      convoContext: convo?.context,
      logPrefix: "[1:1 personal]",
    });

    if (visibleReply) {
      await sendAndLog(prov, { groupId: message.groupId, text: visibleReply }, {
        householdId, groupId: message.groupId, inReplyTo: message.messageId,
        replyType: actions.length > 0 ? "action_reply" : "direct_reply"
      });
    }

    // Group nudge check for personal-household users without a real group
    try {
      const { data: groupConfig } = await supabase
        .from("whatsapp_config")
        .select("group_id")
        .eq("household_id", householdId)
        .eq("bot_active", true)
        .limit(1)
        .single();

      if (!groupConfig && convo && await shouldSendGroupNudge(convo) && !isQuietHours()) {
        await sendAndLog(prov, { groupId: message.groupId, text: GROUP_NUDGE_MESSAGE }, {
          householdId, groupId: message.groupId, replyType: "nudge"
        });
        await supabase.from("onboarding_conversations").update({
          context: { ...(convo.context || {}), group_nudge_sent_at: new Date().toISOString() },
        }).eq("phone", phone);
        console.log(`[1:1 personal] Group nudge sent to ${phone}`);
      }
    } catch {}
    console.log(`[1:1 personal] Reply for ${phone}: actions=${actions.length}`);
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
    await sendAndLog(provider, { groupId, text: INTRO_MESSAGE }, {
      householdId: existingConfig.household_id || "unknown", groupId, replyType: "group_mgmt"
    });
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
      await sendAndLog(provider, { groupId, text: INTRO_MESSAGE }, {
        householdId: "unknown", groupId, replyType: "group_mgmt"
      });
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
  await sendAndLog(provider, { groupId, text: INTRO_MESSAGE }, {
    householdId: householdId || "unknown", groupId, replyType: "group_mgmt"
  });
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
      // Fetch existing context to preserve it
      const { data: fullConvo } = await supabase
        .from("onboarding_conversations")
        .select("context")
        .eq("id", onboardingConvo.id)
        .single();
      await supabase
        .from("onboarding_conversations")
        .update({
          state: "personal",
          household_id: householdId,
          context: { ...(fullConvo?.context || {}), group_nudge_sent_at: "joined_group" },
          updated_at: new Date().toISOString(),
        })
        .eq("id", onboardingConvo.id);

      // Send 1:1 personal channel message
      const postGroupMsg = `מעולה, אני בקבוצה! 🎉 מעכשיו כולם בבית יכולים לדבר איתי שם.

הצ'אט הזה? הוא רק שלך ושלי 😊

תזכורת אישית, רעיון למתנה, משימה שרק אתם צריכים לזכור,
כתבו לי כאן. אף אחד אחר לא רואה.

אני תמיד כאן 💛`;
      await sendAndLog(provider, {
        groupId: onboardingConvo.phone,
        text: postGroupMsg,
      }, {
        householdId: householdId || "unknown", groupId: onboardingConvo.phone, replyType: "group_mgmt"
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

  // Only charge usage when at least one new item was actually added
  if (newItems.length > 0) {
    await incrementUsage(householdId);
  }

  const batchReply = replyParts.join("\n") || "🛒 עדכנתי את הרשימה";
  await sendAndLog(provider, { groupId, text: batchReply }, {
    householdId, groupId, replyType: "batch_reply"
  });

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
    if (message.messageId) {
      const { data: existing } = await supabase
        .from("whatsapp_messages")
        .select("id")
        .eq("whatsapp_message_id", message.messageId)
        .limit(1);
      if (existing && existing.length > 0) {
        console.log(`[Webhook] Duplicate message ${message.messageId}, skipping`);
        return new Response("OK", { status: 200 });
      }
    }

    // 3a. Handle voice messages: transcribe short ones, politely reject long ones
    if (message.type === "voice") {
      const duration = message.mediaDuration || 0;
      if (duration > 30) {
        console.log(`[Webhook] Long voice (${duration}s) from ${message.senderName}`);
        const chatTarget = message.groupId;
        const isGroup = !!message.groupId?.includes("@g.us");
        if (chatTarget) {
          // Is this the first long-voice skip in this chat?
          const { data: priorSkips } = await supabase
            .from("whatsapp_messages")
            .select("id")
            .eq("group_id", chatTarget)
            .eq("classification", "skipped_long_voice")
            .limit(1);
          const isFirstLongVoice = !priorSkips || priorSkips.length === 0;

          // Group: reply only on first occurrence, ever. 1:1: reply every time (casual variant from 2nd).
          const shouldReply = isFirstLongVoice || !isGroup;

          if (shouldReply) {
            let longVoiceText: string;
            if (isFirstLongVoice) {
              longVoiceText = "הודעה קולית ארוכה 🎤\nאני מקשיבה רק עד 30 שניות — הארוכות יותר הן בדרך כלל שיחות משפחתיות, לא בקשות ממני.\nבקשה — אם זאת בקשה ממני, שלחו הודעה קצרה יותר או כתבו בטקסט 😊";
            } else {
              const casual = [
                "זוכרים שאני מקשיבה רק עד 30 שניות? 🎤 שלחו קצר יותר או בטקסט 😊",
                "אה, ארוך מדי שוב 🙈 עד 30 שניות בלבד — או בטקסט אם יותר נוח",
                "רק עד 30 שניות בשבילי, חסר לי סבלנות 😅 אפשר טקסט?",
              ];
              longVoiceText = casual[Math.floor(Math.random() * casual.length)];
            }
            try {
              await sendAndLog(provider, { groupId: chatTarget, text: longVoiceText }, {
                householdId: "unknown", groupId: chatTarget, inReplyTo: message.messageId, replyType: "long_voice_reply"
              });
            } catch (e) { console.error("[LongVoice] reply failed:", e); }
          }
        }
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
    }

    // 3a-reaction. Handle emoji reactions to Sheli's messages
    if (message.type === "reaction" && message.reactionEmoji && message.reactionTargetId) {
      const CONFIRM_EMOJI = /^(👍|💪|✅|👌|❤️|🔥)$/;
      const WRONG_EMOJI = /^(😂|😤|👎|❌|🤦|🤦‍♀️|🤦‍♂️|😡)$/;

      // Step 1: Is this a reaction to a Sheli message?
      const botPhoneReaction = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
      const { data: botMsg } = await supabase
        .from("whatsapp_messages")
        .select("id, whatsapp_message_id, classification, message_text, household_id")
        .eq("whatsapp_message_id", message.reactionTargetId)
        .eq("sender_phone", botPhoneReaction)
        .maybeSingle();

      if (!botMsg) {
        // Reaction to someone else's message — social noise, skip silently
        return new Response("OK", { status: 200 });
      }

      const hhId = botMsg.household_id || "unknown";
      const isConfirm = CONFIRM_EMOJI.test(message.reactionEmoji);
      const isWrong = WRONG_EMOJI.test(message.reactionEmoji);

      if (!isConfirm && !isWrong) {
        // Unrecognized emoji on Sheli's message — skip
        return new Response("OK", { status: 200 });
      }

      // Step 2: Check for pending confirmation targeting this bot message
      const { data: pending } = await supabase
        .from("pending_confirmations")
        .select("id, action_type, action_data")
        .eq("bot_message_id", message.reactionTargetId)
        .eq("status", "pending")
        .maybeSingle();

      if (pending) {
        if (isConfirm) {
          const actions = [{ type: pending.action_type, data: pending.action_data }];
          const { summary } = await executeActions(hhId, actions, message.senderName);
          console.log(`[Reaction] Confirmed via ${message.reactionEmoji}:`, summary);
          await supabase.from("pending_confirmations")
            .update({ status: "confirmed" }).eq("id", pending.id);
          await sendAndLog(provider,
            { groupId: message.groupId, text: "מעולה, סידרתי! ✓" },
            { householdId: hhId, groupId: message.groupId, replyType: "confirmation_accept_reaction" });
          await logMessage(message, "reaction_confirmed", hhId);
        } else {
          await supabase.from("pending_confirmations")
            .update({ status: "rejected" }).eq("id", pending.id);
          await sendAndLog(provider,
            { groupId: message.groupId, text: "אוקי, ביטלתי 🤷‍♀️" },
            { householdId: hhId, groupId: message.groupId, replyType: "confirmation_reject_reaction" });
          await logMessage(message, "reaction_rejected", hhId);
        }
        return new Response("OK", { status: 200 });
      }

      // Step 3: No pending confirmation — log as feedback on Sheli's message
      if (isConfirm) {
        console.log(`[Reaction] Positive ${message.reactionEmoji} from ${message.senderName} on: "${botMsg.message_text?.slice(0, 60)}"`);
        await logMessage(message, "reaction_positive", hhId);
      } else {
        console.log(`[Reaction] Negative ${message.reactionEmoji} from ${message.senderName} on: "${botMsg.message_text?.slice(0, 60)}"`);
        await logMessage(message, "reaction_negative", hhId);
        // Store as correction signal for Stream B learning
        supabase.from("classification_corrections").insert({
          household_id: hhId,
          correction_type: "reaction_negative",
          original_data: {
            bot_message_text: botMsg.message_text,
            bot_classification: botMsg.classification,
            reaction_emoji: message.reactionEmoji,
            reactor_name: message.senderName,
          },
        }).then(({ error }) => {
          if (error) console.error("[Reaction] correction log error:", error.message);
        });
      }
      return new Response("OK", { status: 200 });
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

    // 6. Hebrew feminine imperative as FIRST word — strong "addressed to Sheli" signal.
    // Sheli is the only feminine "you" in the household conversation context (the bot is
    // grammatically female). When a user opens a message with תזכירי / תוסיפי / תרשמי / תגידי
    // etc., they're commanding the bot. This catches messages like "תזכירי לנו מה יש היום"
    // that don't say "שלי" but ARE addressed to Sheli via verb conjugation.
    //
    // Restricted to FIRST WORD only — avoids false positives like "אמא, תזכירי לי" where
    // a family member is being addressed by name first.
    const SHELI_IMPERATIVES = new Set([
      "תזכירי", "תזכרי", "תוסיפי", "תרשמי", "תכתבי", "תגידי", "תאמרי",
      "תספרי", "תבדקי", "תראי", "תפתחי", "תסגרי", "תעדכני", "תמחקי",
      "תבטלי", "תסירי", "תוציאי", "תכניסי", "תיצרי", "תקבעי", "תסדרי",
      "תספקי", "תעני", "תעזרי", "תנסי", "תחזרי", "תמצאי", "תפרטי",
      "תסבירי", "תאשרי", "תקראי", "תחפשי", "תעבירי", "תשלחי",
    ]);
    const trimmedTxt = txt.replace(/^[\s!?.,]+/, "");
    const firstWordOnly = trimmedTxt.split(/[\s,.:;!?\n]/)[0];
    const imperativeFirstWord = SHELI_IMPERATIVES.has(firstWordOnly);

    const highConfidenceName = !sheliIsMine && (
      atMention || numericMention || englishMention ||
      sheliFirstWord || sheliAfterGreeting || sheliAfterThanks || sheliStandaloneEnd ||
      voiceFuzzyMatch || imperativeFirstWord
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
      console.log(`[Webhook] Layer 1: Direct address detected from ${message.senderName} (first=${sheliFirstWord}, greeting=${sheliAfterGreeting}, thanks=${sheliAfterThanks}, end=${sheliStandaloneEnd}, @=${atMention}, en=${englishMention}, voiceFuzzy=${voiceFuzzyMatch}, imperative=${imperativeFirstWord ? firstWordOnly : false})`);
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

        await sendAndLog(provider, { groupId: message.groupId, text: "מעולה, סידרתי! ✓" }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "confirmation_accept"
        });
        await logMessage(message, "confirmation_accepted", householdId);
        return new Response("OK", { status: 200 });
      }

      if (CONFIRM_NEGATIVE.test(msgTrimmed)) {
        await supabase.from("pending_confirmations")
          .update({ status: "rejected" })
          .eq("id", pendingConfirm.id);

        await sendAndLog(provider, {
          groupId: message.groupId,
          text: "אוקי, ביטלתי 🤷‍♀️ אפשר להסביר שוב ואני אנסה להבין",
        }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "confirmation_reject"
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

      await sendAndLog(provider, {
        groupId: message.groupId,
        text: "חח סורי! 🙈 לא התכוונתי להתערב. מחזירה את עצמי לפינה 😅",
      }, {
        householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "back_off_reply"
      });
      await logMessage(message, "haiku_ignore", householdId);
      return new Response("OK", { status: 200 });
    }

    // 6d. Pure emoji messages → skip Haiku, reply with matching emoji via Sonnet
    const PURE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\u200d\ufe0f]{1,20}$/u;
    if (PURE_EMOJI.test(message.text.trim()) && message.text.trim().length <= 20 && !message.text.trim().match(/[a-zA-Z\u0590-\u05FF\u0600-\u06FF0-9]/)) {
      const emojiReply = await generateEmojiReply(message.text.trim(), message.senderName);
      if (emojiReply) {
        await sendAndLog(provider, { groupId: message.groupId, text: emojiReply }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "emoji_reaction"
        });
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
            await sendAndLog(provider, {
              groupId: message.groupId,
              text: `בוטל ✓`,
            }, {
              householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "quick_undo_reply"
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

    // 7. Check usage limits (free tier: 40 actions/month)
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
      message.groupId,
      message.messageId
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

          // Format reactions to Sheli's messages distinctly
          if (m.classification === "reaction_positive" || m.classification === "reaction_negative") {
            return `[${time} ${safeName} reacted ${safeText} to שלי]`;
          }

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

    // SILENCE GUARD — trust the classifier's "this isn't for the bot" verdict.
    // Triggered by the AMOR/Tamar group case (Apr 13): Tamar wrote "אמור ואופק,
    // מתי שניכם יכולים להבריז" — a coordination question to specific family
    // members. Haiku correctly set addressed_to_bot=false. But routing fell
    // through to Sonnet, which improvised a reply that AMOR perceived as Sheli
    // having an opinion ("לא שאלנו מה דעתך" / "we didn't ask your opinion").
    // This is the same churn pattern that lost the Ventura family.
    //
    // Rule: for any "talk-only" intent (question, info_request) where the
    // classifier says addressed_to_bot=false AND the user didn't @-mention Sheli,
    // STAY SILENT. No Sonnet call. No reply. This is preferred over chattiness
    // because false-positive replies cause hostile reactions, while false-negative
    // silences just teach users to write "שלי, ..." to engage the bot.
    //
    // Does NOT apply to actionable intents (add_*, complete_*, claim_*) — those
    // require the user's text to be processable as an action regardless of address.
    if (
      !classification.addressed_to_bot &&
      !directAddress &&
      (classification.intent === "question" || classification.intent === "info_request")
    ) {
      console.log(`[Webhook] Silence guard: intent=${classification.intent} but addressed_to_bot=false and no direct mention — staying out of family chatter`);
      await logMessage(message, "haiku_ignore", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // 8. Route based on intent + confidence
    const CONFIDENCE_HIGH = 0.70;
    const CONFIDENCE_LOW = 0.50;
    const isActionable = classification.intent !== "ignore" && classification.intent !== "info_request" && classification.intent !== "question" && classification.intent !== "recall_memory" && classification.intent !== "correct_bot" && classification.intent !== "instruct_bot" && classification.intent !== "query_expense";

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
    // Also skip high-confidence reminders — the Haiku-entity fallback (step 13b) handles them reliably
    // and the old Sonnet classifier has no template for third-person reminders anyway.
    const skipOnboardingEscalation =
      classification.intent === "add_shopping" ||
      classification.intent === "instruct_bot" ||
      (classification.intent === "add_reminder" && classification.confidence >= 0.85);
    if (isOnboarding && !skipOnboardingEscalation) {
      console.log(`[Webhook] Onboarding escalation to Sonnet (msg #${config.group_message_count || 0})`);
      const sonnetMessages = [
        ...conversationMsgs.map((m) => ({
          sender: m.sender_name,
          text: m.message_text,
          timestamp: new Date(m.created_at).getTime(),
        })),
        // Patch A: pass quotedText through so Sonnet sees the reply anchor (parallel to Haiku path at ~4449).
        { sender: message.senderName, text: message.text, timestamp: message.timestamp, quotedText: message.quotedText },
      ];
      const sonnetResult = await classifyMessages(householdId, sonnetMessages);

      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        if (directAddress) {
          const replyCtx = await buildReplyCtx(householdId, "group");
          let { reply } = await generateReply(classification, message.senderName, replyCtx);
          // Rescue: save any REMINDER blocks from Sonnet + Haiku-entity fallback BEFORE stripping.
          // Previously we only stripped — silently dropping reminders when this path fired.
          if (reply) reply = await rescueRemindersAndStrip(reply, classification, message, householdId);
          if (reply) {
            await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
              householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "direct_address_reply"
            });
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
        await sendAndLog(provider, { groupId: message.groupId, text: sonnetResult.reply }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "sonnet_escalated_reply"
        });
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
          await sendAndLog(provider, {
            groupId: message.groupId,
            text: "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️",
          }, {
            householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "clarification"
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
        //
        // Haiku-misclassification rescue: live DB shows messages like "תזכירי לי ב-4 לאסוף
        // ילדים" hitting this path with intent=ignore conf=0.75 entities=null. Sonnet's reply
        // prompt gates REMINDER emission on intent=add_reminder (~line 1092), so without an
        // intent override Sonnet never emits a REMINDER block and the rescue helper has
        // nothing to save. When Layer 1 detected a reminder-imperative first word AND the
        // message contains a time reference, we pass intent=add_reminder to generateReply so
        // Sonnet knows to emit a REMINDER block. Does NOT mutate the outer classification —
        // logged classification still says ignore so we can audit Haiku misfires later.
        const REMINDER_IMPERATIVES = new Set(["תזכירי", "תזכרי", "תגידי", "תכתבי", "תשלחי", "תעדכני"]);
        const TIME_HINT = /ב-?\d|בשעה|מחר|מחרתיים|בעוד|בערב|בבוקר|בצהריים|בלילה|לפני\s+(?:ה?שעה|הצהריים|שבת|\d)|יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|שבת|עוד\s+\d/;
        const looksLikeMisclassifiedReminder =
          imperativeFirstWord &&
          REMINDER_IMPERATIVES.has(firstWordOnly) &&
          TIME_HINT.test(message.text);
        const directClassification: ClassificationOutput = looksLikeMisclassifiedReminder
          ? {
              ...classification,
              intent: "add_reminder",
              entities: { ...classification.entities, raw_text: message.text },
            }
          : { ...classification, entities: { ...classification.entities, raw_text: message.text } };
        if (looksLikeMisclassifiedReminder) {
          console.log(`[Webhook] Rescue: ignore+"${firstWordOnly}"+time → passing add_reminder to generateReply`);
        }
        const replyCtx = await buildReplyCtx(householdId, "group");
        let { reply } = await generateReply(directClassification, message.senderName, replyCtx);
        // Rescue: save any REMINDER blocks (Sonnet-emitted or Haiku-entity fallback) BEFORE stripping
        if (reply) reply = await rescueRemindersAndStrip(reply, directClassification, message, householdId);
        if (reply) {
          await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
            householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "direct_address_reply"
          });
        }
        await logMessage(message, "direct_address_reply", householdId, classification);
        return new Response("OK", { status: 200 });
      }
      // Expense rescue: Haiku sometimes misclassifies clear expense messages as ignore.
      // If the message contains a Hebrew payment verb + a number, re-route to Sonnet
      // for a second opinion before silently dropping it.
      const EXPENSE_VERBS = /שילמתי|שילמנו|שולם|העברתי|הוצאתי|שרפתי|קניתי|חטפתי|תרמתי/;
      const EXPENSE_COST = /עלה\s+(לי|לנו)|יצא\s+לנו|ירד\s+לי|נפל\s+חשבון|עלות\s+ה/;
      const HAS_NUMBER = /\d{2,}|מאתיים|אלף|אלפיים|שלוש\s+מאות|ארבע\s+מאות|חמש\s+מאות/;
      // "שילמתי עליו/עליה" = social treating (paying for someone), NOT household expense
      const IS_TREATING = /שילמתי\s+על(יו|יה|יהם|יהן|ינו)/;
      const looksLikeExpense = (EXPENSE_VERBS.test(message.text) || EXPENSE_COST.test(message.text)) && HAS_NUMBER.test(message.text) && !IS_TREATING.test(message.text);
      if (looksLikeExpense) {
        console.log(`[Webhook] Expense rescue: Haiku said ignore but message matches expense pattern — reclassifying as add_expense`);
        // Route through direct Haiku actionable path (not Sonnet escalation —
        // old Sonnet classifier doesn't support add_expense actions).
        // Amount/currency fallbacks in executeActions extract from raw_text.
        classification.intent = "add_expense";
        classification.confidence = 0.75; // >= CONFIDENCE_HIGH, takes direct action path
      } else {
        await logMessage(message, "haiku_ignore", householdId, classification);
        return new Response("OK", { status: 200 });
      }
    }

    // Expense confidence boost: old Sonnet classifier (used in medium-confidence escalation)
    // doesn't support add_expense actions. Any add_expense from Haiku (even medium confidence)
    // should take the direct action path where amount/currency fallbacks handle extraction.
    if (classification.intent === "add_expense" && classification.confidence >= CONFIDENCE_LOW && classification.confidence < CONFIDENCE_HIGH) {
      console.log(`[Webhook] Expense confidence boost: ${classification.confidence.toFixed(2)} → 0.75 (bypassing Sonnet escalation)`);
      classification.confidence = 0.75;
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
          await sendAndLog(provider, {
            groupId: message.groupId,
            text: "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️",
          }, {
            householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "clarification"
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
        let { reply } = await generateReply(directClassification, message.senderName, replyCtx);
        // Rescue: save any REMINDER blocks from Sonnet + Haiku-entity fallback BEFORE stripping.
        // Low-confidence add_reminder intents pass intent=add_reminder down to generateReply,
        // so Sonnet DOES emit REMINDER blocks for these cases — previously silently stripped.
        if (reply) reply = await rescueRemindersAndStrip(reply, directClassification, message, householdId);
        if (reply) {
          await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
            householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "direct_address_reply"
          });
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
        // Patch A: pass quotedText through so Sonnet sees the reply anchor (parallel to Haiku path at ~4449).
        { sender: message.senderName, text: message.text, timestamp: message.timestamp, quotedText: message.quotedText },
      ];
      const sonnetResult = await classifyMessages(householdId, sonnetMessages);

      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        if (directAddress) {
          // Sonnet says social, but user addressed Sheli — still reply.
          // Note: classifyMessages (Sonnet classifier) has no add_reminder in its action schema
          // (line ~1495), so a reminder request that escalates here will produce actions=[] and
          // fall through. directClassification preserves the original Haiku intent — if it was
          // add_reminder, generateReply will emit a REMINDER block that the rescue below saves.
          const directClassification = { ...classification, entities: { ...classification.entities, raw_text: message.text } };
          const replyCtx = await buildReplyCtx(householdId, "group");
          let { reply } = await generateReply(directClassification, message.senderName, replyCtx);
          if (reply) reply = await rescueRemindersAndStrip(reply, directClassification, message, householdId);
          if (reply) {
            await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
              householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "direct_address_reply"
            });
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
        await sendAndLog(provider, { groupId: message.groupId, text: dedupReply }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "dedup_reply"
        });
      } else {
        await incrementUsage(householdId);
        if (sonnetResult.reply) {
          await sendAndLog(provider, { groupId: message.groupId, text: sonnetResult.reply }, {
            householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "sonnet_escalated_reply"
          });
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
      // Rescue any off-prompt REMINDER blocks before stripping, then remove PENDING_ACTION wrapper.
      // Order matters: extractPendingAction runs on raw reply (above) so rescue-strip order is safe.
      const afterReminderRescue = await rescueRemindersAndStrip(reply, classification, message, householdId);
      const cleanReply = cleanPendingAction(afterReminderRescue);

      let confBotMsgId: string | undefined;
      if (cleanReply) {
        const sendResult = await sendAndLog(provider, { groupId: message.groupId, text: cleanReply }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "confirmation_ask"
        });
        confBotMsgId = sendResult.messageId;
      }

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
          bot_message_id: confBotMsgId || null,
        });
        if (error) console.error("[Webhook] Failed to store pending confirmation:", error);
        else console.log(`[Webhook] Stored pending confirmation ${confId}: ${pendingAction.action_type}`);
      }
      await logMessage(message, "instruct_bot", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Non-actionable intents (question, info_request, query_expense) — generate reply only, no DB writes
    if (!isActionable && classification.intent !== "ignore") {
      // For query_expense, fetch aggregated data and inject into classification for Sonnet
      if (classification.intent === "query_expense") {
        const isDirectMsg = !message.groupId?.includes("@g.us");
        const queryResult = await executeQueryExpense(householdId, classification.entities, isDirectMsg);
        (classification as any).__queryResult = queryResult;
      }
      const replyCtx = await buildReplyCtx(householdId, "group");
      let { reply } = await generateReply(classification, message.senderName, replyCtx);
      // Rescue off-prompt REMINDER blocks before stripping. Questions/info_requests should
      // normally not trigger REMINDER emission, but the rescue is cheap and keeps this path
      // symmetric with the other direct-address code paths.
      if (reply) reply = await rescueRemindersAndStrip(reply, classification, message, householdId);
      if (reply) {
        await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
          householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "action_reply"
        });
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
      await sendAndLog(provider, { groupId: message.groupId, text: clarifyMsg }, {
        householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "clarification"
      });
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
      await sendAndLog(provider, { groupId: message.groupId, text: dedupReply }, {
        householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "dedup_reply"
      });
      await logMessage(message, "haiku_actionable", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // 12. Increment usage counter (only for actual new actions)
    await incrementUsage(householdId);

    // 13. Generate personality reply via Sonnet (Stage 2)
    const replyCtx = await buildReplyCtx(householdId, "group");
    let { reply } = await generateReply(classification, message.senderName, replyCtx);

    // 13b. Handle reminder insertion — always process REMINDER blocks regardless of intent.
    // Sonnet can emit <!--REMINDER:-->  blocks for any intent (e.g. rotation assignment
    // "מחר נעמי" → Sonnet helpfully schedules a tomorrow reminder). Previously we only
    // processed+cleaned reminders when intent==add_reminder, which leaked raw JSON to users
    // for other intents. Memory handling already follows this "always process" pattern.
    const allReminders: { reminder_text: string; send_at: string }[] = reply
      ? extractRemindersFromReply(reply)
      : [];

    // Haiku-entities fallback: only runs for add_reminder intent, since that's the only
    // classification that guarantees reminder_text + time_iso in entities.
    if (allReminders.length === 0 && classification.intent === "add_reminder") {
      const e = classification.entities;
      if (e?.reminder_text && e?.time_iso) {
        allReminders.push({ reminder_text: e.reminder_text, send_at: e.time_iso });
        console.log(`[Reminder] Sonnet produced no REMINDER block — falling back to Haiku entities`);
        // If Sonnet also produced no visible reply, synthesize a minimal confirmation so the user knows it landed
        if (!reply) {
          const when = new Date(e.time_iso).toLocaleString("he-IL", {
            timeZone: "Asia/Jerusalem",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          reply = `אזכיר ${when} ✓`;
        }
      } else {
        console.warn(`[Reminder] No REMINDER block from Sonnet and Haiku missing reminder_text/time_iso — cannot schedule`);
      }
    }

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
        else console.log(`[Reminder] Created for ${reminderData.send_at}: "${reminderData.reminder_text}" (intent=${classification.intent})`);
      }
    }
    // ALWAYS clean hidden REMINDER blocks from reply — defense in depth, never leak JSON to user.
    if (reply) reply = cleanReminderFromReply(reply);

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
          .select("phone_number")
          .eq("household_id", householdId)
          .ilike("member_name", `%${e.memory_about}%`)
          .limit(1)
          .single();
        memberPhone = mapping?.phone_number || null;
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
      // Soft-delete by content match (fuzzy), fallback to most recent
      const { data: allMemories } = await supabase.from("family_memories")
        .select("id, content, member_phone")
        .eq("household_id", householdId)
        .eq("active", true)
        .order("created_at", { ascending: false });

      if (allMemories && allMemories.length > 0) {
        const rawText = (entities?.raw_text || message.text || "").toLowerCase();
        // Try content-match: find a memory whose content appears in the user's request (or vice versa)
        const match = allMemories.find((m: any) => {
          const mc = (m.content || "").toLowerCase();
          return rawText.includes(mc) || mc.includes(rawText.replace(/תשכחי|תמחקי|שלי|את |ש/g, "").trim());
        });
        const target = match || allMemories[0]; // fallback to most recent if no content match
        await supabase.from("family_memories").update({ active: false }).eq("id", target.id);
        console.log(`[Memory] Deleted memory ${target.id} (${match ? "content-matched" : "most-recent fallback"})`);
      }
    }

    if (reply) {
      await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
        householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "action_reply"
      });
      console.log(`[Webhook] Reply sent`);
    }

    // 14. Log completion
    await logMessage(message, "haiku_actionable", householdId, classification);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
    await notifyAdmin("Unhandled webhook error", String(err));
    // Always return 200 to prevent Whapi retry loops that cause duplicate processing.
    // Errors are logged + admin-notified above; retries would just fail the same way.
    return new Response("OK", { status: 200 });
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

// ─── Bot Reply Logger (wraps sendMessage) ───

async function sendAndLog(
  prov: WhatsAppProvider,
  msg: OutgoingMessage,
  ctx: {
    householdId?: string;
    groupId: string;
    inReplyTo?: string;
    replyType?: string;
  }
): Promise<SendResult> {
  const result = await prov.sendMessage(msg);

  // Fire-and-forget — don't block the reply path
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  supabase.from("whatsapp_messages").insert({
    household_id: ctx.householdId || "unknown",
    group_id: ctx.groupId,
    sender_phone: botPhone,
    sender_name: "שלי",
    message_text: msg.text,
    message_type: "text",
    whatsapp_message_id: result.messageId || null,
    classification: ctx.replyType || "bot_reply",
    ai_responded: true,
    in_reply_to: ctx.inReplyTo || null,
  }).then(({ error }) => {
    if (error) console.error("[sendAndLog] DB error:", error.message);
  });

  return result;
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
    } else if (memberGender) {
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

  // Free tier: 40 actions per month
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
  return { allowed: usageCount < 40, count: usageCount, isPaid: false };
}

async function maybeSendSoftWarning(groupId: string, householdId: string, usageCount: number, language?: string) {
  if (usageCount < 35 || usageCount >= 40) return;

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

  await sendAndLog(provider, { groupId, text: warningMsg }, {
    householdId, groupId, replyType: "nudge"
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

    await sendAndLog(provider, { groupId, text: msg }, {
      householdId, groupId, replyType: "nudge"
    });
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

    await sendAndLog(provider, { groupId, text: msg }, {
      householdId, groupId, replyType: "nudge"
    });
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
      await sendAndLog(provider, {
        groupId: referredConfig.group_id,
        text: "🎉 חודש פרימיום במתנה! המשיכו להשתמש בשלי ללא הגבלה.",
      }, {
        householdId: referral.referred_household_id, groupId: referredConfig.group_id, replyType: "nudge"
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
      await sendAndLog(provider, {
        groupId: referringConfig.group_id,
        text: `🎉 ${familyName} הצטרפו בזכותכם! חודש פרימיום במתנה לשניכם!`,
      }, {
        householdId: referral.referrer_household_id, groupId: referringConfig.group_id, replyType: "nudge"
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
      .select("phone_number, member_name")
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
        if (m.phone_number && m.member_name) phoneName[m.phone_number] = m.member_name;
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
        // Default to 18:00 Israel time (Edge Function runs in UTC)
        const now = new Date();
        const israelDateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }); // YYYY-MM-DD
        scheduledFor = `${israelDateStr}T18:00:00+03:00`;
        console.log(`[Webhook] M13: No time_iso for add_event, defaulting to 18:00 IST. time_raw: ${e.time_raw}`);
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
      // Patch D: Haiku now emits completion_scope for reply-to-bot-task-list patterns
      // ("הושלם" quoting a task-list → all_in_quote; "המשימות הושלמו" standalone → all_open).
      // executeActions resolves this against the current open-tasks list since we don't
      // have task_ids from quoted text alone.
      if (e.completion_scope === "all_open" || e.completion_scope === "all_in_quote") {
        actions.push({ type: "complete_tasks_all_open", data: {} });
      } else if (e.task_id) {
        actions.push({ type: "complete_task", data: { id: e.task_id } });
      }
      break;

    case "complete_shopping":
      // Patch D: Haiku now emits items_from_quote when user replies to a bot shopping-add
      // message ("זה כבר קנינו" / "יש לנו" / "רק X חסר"). We look up each name in the
      // open shopping list and mark as got. Preserves the single-id path for direct completions.
      if (Array.isArray(e.items_from_quote) && e.items_from_quote.length > 0) {
        actions.push({ type: "complete_shopping_by_names", data: { names: e.items_from_quote } });
      } else if (e.item_id) {
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

    case "add_expense": {
      actions.push({
        type: "add_expense",
        data: {
          amount_text: e.amount_text,
          amount_minor: e.amount_minor,
          expense_currency: e.expense_currency,
          expense_description: e.expense_description,
          expense_category: e.expense_category,
          expense_attribution: e.expense_attribution,
          expense_paid_by_name: e.expense_paid_by_name,
          expense_occurred_at_hint: e.expense_occurred_at_hint,
          expense_visibility_hint: e.expense_visibility_hint,
          raw_text: e.raw_text,
        },
      });
      break;
    }
    // query_expense is reply-only, no actions needed (handled in main routing)
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
    case "add_expense": {
      const desc = lastAction.entities.expense_description || lastAction.entities.raw_text;
      const { data: found } = await supabase
        .from("expenses")
        .select("id, description, amount_minor, currency")
        .eq("household_id", householdId)
        .eq("deleted", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (found) {
        await supabase.from("expenses")
          .update({ deleted: true, deleted_at: new Date().toISOString() })
          .eq("id", found.id);
        const sym = found.currency === "ILS" ? "₪" : found.currency === "EUR" ? "€" : found.currency === "USD" ? "$" : found.currency;
        const displayAmt = (found.amount_minor / (MINOR_UNIT[found.currency] || 100)).toLocaleString("he-IL");
        undone.push(sym + displayAmt + " " + found.description);
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
    await sendAndLog(provider, {
      groupId: message.groupId,
      text: "לא מצאתי פעולה אחרונה לתקן 🤔",
    }, {
      householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "clarification"
    });
    return;
  }

  // 2. Undo the last action
  const undone = await undoLastAction(householdId, lastAction.classification_data);
  console.log(`[Correction] Undone:`, undone);

  // 3. If correction_text provided AND user literally typed it, redo with the corrected version.
  // Substring gate: the correction_text must appear VERBATIM in the user's actual message text.
  // Prevents Haiku from fabricating/paraphrasing a correction when the user only sent emoji or a bare reaction.
  // Without this guard, an emoji-only "correction" will cause undo + a bogus redo based on hallucinated text.
  const correctionText = classification.entities.correction_text;
  let redone: string[] = [];
  if (correctionText) {
    const userText = (message.text || "").toLowerCase();
    const correctionLower = correctionText.toLowerCase();
    if (!userText.includes(correctionLower)) {
      console.log(`[Correction] Rejecting fabricated correction_text (not substring of user message). correction="${correctionText}" text="${message.text}"`);
    } else {
      // Re-classify the correction text to get proper entities
      const ctx = await buildClassifierCtx(householdId);
      const reclassified = await classifyIntent(correctionText, message.senderName, ctx);

      if (reclassified.intent !== "ignore" && reclassified.intent !== "correct_bot") {
        const actions = haikuEntitiesToActions(reclassified);
        const result = await executeActions(householdId, actions, message.senderName);
        redone = result.summary;
      }
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

  // 5. Reply with warm confirmation + learning acknowledgement
  const openers = [
    "תודה על תשומת הלב! 🙏",
    "תודה שתיקנת אותי! 🙏",
    "אוי, טוב שאמרת! 🙏",
  ];
  const learningLines = [
    "אני עדיין לומדת ומשתפרת כל הזמן 😅",
    "ככה אני משתפרת — בזכותך 😅",
    "עוד טעות שלמדתי ממנה — שמרתי לעתיד 😅",
  ];
  const opener = openers[Math.floor(Math.random() * openers.length)];
  const learning = learningLines[Math.floor(Math.random() * learningLines.length)];

  const actionParts: string[] = [];
  if (undone.length > 0) actionParts.push(`ביטלתי: ${undone.join(", ")}`);
  if (redone.length > 0) actionParts.push(`הוספתי: ${redone.join(", ")}`);

  const replyLines = [opener, learning];
  if (actionParts.length > 0) replyLines.push(...actionParts);
  replyLines.push("✨");

  const reply = replyLines.join("\n");

  // 6. Auto-derive patterns from this correction (pass user's actual text for substring validation)
  await derivePatternFromCorrection(householdId, "mention_correction", lastAction.classification_data, classification, message.text);

  await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
    householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "action_reply"
  });
  await logMessage(message, "correction_applied", householdId, classification);
}

async function derivePatternFromCorrection(
  householdId: string,
  correctionType: string,
  originalData: ClassificationOutput | null,
  correctedData: ClassificationOutput | null,
  userText?: string,
) {
  if (!originalData) return;

  try {
    // Compound name fix: user corrected a split (e.g., "שמן" + "זית" → "שמן זית")
    if (correctionType === "mention_correction" && correctedData?.entities?.correction_text) {
      const correctedText = correctedData.entities.correction_text;

      // Reject patterns that look like Haiku hallucinations or meta-language, not actual compound product names.
      // Three guards:
      //   1. Substring gate — correctedText must appear verbatim in user's typed message (if provided).
      //   2. Length gate — compound names are short (olive oil, white cheese); >25 chars is almost always an explanation.
      //   3. Meta-language gate — tokens like "הוא/זה/פריט/אחד/שניים/not/item" indicate Haiku paraphrased a rule, not quoted a name.
      const isFabricated = userText ? !userText.toLowerCase().includes(correctedText.toLowerCase()) : false;
      const tooLong = correctedText.length > 25;
      const hasMetaTokens = /(\bהוא\b|\bזה\b|\bפריט\b|\bאחד\b|\bשניים\b|\bצריך\b|\bnot\b|\bitem\b|\bone\b|\btwo\b)/i.test(correctedText);

      if (correctedText.includes(" ") && !isFabricated && !tooLong && !hasMetaTokens) {
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
      } else if (correctedText.includes(" ")) {
        console.log(`[Patterns] Rejected pattern "${correctedText}" (fabricated=${isFabricated}, tooLong=${tooLong}, hasMetaTokens=${hasMetaTokens})`);
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
    : `Hey ${getHouseholdNameCached(householdId) || "there"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping, $2.70/month.\n🔗 ${paymentUrl}`;

  await sendAndLog(provider, { groupId, text: upgradeMsg }, {
    householdId, groupId, replyType: "nudge"
  });
}
