// WhatsApp Webhook Handler — Two-stage pipeline (Haiku classify → Sonnet reply)
// Stage 1: Every message → Haiku classifier (cheap, fast)
// Stage 2: Actionable messages only → Sonnet reply generator (personality-accurate)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createProvider, type GroupEvent } from "../_shared/whatsapp-provider.ts";
import { classifyIntent, type ClassificationOutput, type ClassifierContext } from "../_shared/haiku-classifier.ts";
import { generateReply, type ReplyContext } from "../_shared/reply-generator.ts";
import { classifyMessages } from "../_shared/ai-classifier.ts"; // Sonnet fallback for low-confidence
import { executeActions } from "../_shared/action-executor.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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
    const haikuCtx = await buildClassifierContext(householdId);
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

      await storePendingBatch(message, classification, householdId);
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));

      if (!(await amILastPendingMessage(message.groupId, message.messageId))) {
        console.log(`[Batch] Not last message, deferring to newer invocation`);
        return new Response("OK", { status: 200 });
      }

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
      const replyCtx = await buildReplyContext(householdId);
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
    const replyCtx = await buildReplyContext(householdId);
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

// ─── Two-Stage Pipeline Helpers ───

async function buildClassifierContext(householdId: string): Promise<ClassifierContext> {
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

async function buildReplyContext(householdId: string): Promise<ReplyContext> {
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

// ─── Quiet Hours (groundwork for proactive features) ───
function isQuietHours(): boolean {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const hour = israelTime.getHours();
  const day = israelTime.getDay();
  if (hour >= 22 || hour < 7) return true;
  if (day === 5 && hour >= 15) return true;
  if (day === 6 && hour < 19) return true;
  return false;
}

// ─── Message Batching (shopping items, 5-second window) ───

const BATCH_WINDOW_MS = 5000;

async function storePendingBatch(
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
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
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("whatsapp_message_id")
    .eq("group_id", groupId)
    .eq("batch_status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data?.whatsapp_message_id === myMessageId;
}

async function claimAndProcessBatch(
  groupId: string,
  householdId: string,
  prov: typeof provider,
  senderName: string,
): Promise<void> {
  const { data: pending, error: claimError } = await supabase
    .from("whatsapp_messages")
    .update({ batch_status: "processing" })
    .eq("group_id", groupId)
    .eq("batch_status", "pending")
    .select("id, message_text, sender_name");

  if (claimError || !pending || pending.length === 0) return;

  console.log(`[Batch] Claimed ${pending.length} messages for group ${groupId}`);

  const allItems: Array<{ name: string; qty?: string; category?: string }> = [];
  for (const msg of pending) {
    const ctx = await buildClassifierContext(householdId);
    const cls = await classifyIntent(msg.message_text, msg.sender_name, ctx);
    if (cls.entities.items) {
      allItems.push(...cls.entities.items);
    } else if (cls.entities.raw_text) {
      allItems.push({ name: cls.entities.raw_text.trim() });
    }
  }

  if (allItems.length === 0) {
    await supabase
      .from("whatsapp_messages")
      .update({ batch_status: "processed", classification: "batch_empty" })
      .eq("group_id", groupId)
      .eq("batch_status", "processing");
    return;
  }

  const actions = [{ type: "add_shopping" as const, data: { items: allItems } }];
  const { summary } = await executeActions(householdId, actions);
  console.log(`[Batch] Executed:`, summary);
  await incrementUsage(householdId);

  const itemNames = allItems.map((i) => i.name);
  const itemList = itemNames.length <= 2
    ? itemNames.join(" ו")
    : itemNames.slice(0, -1).join(", ") + " ו" + itemNames[itemNames.length - 1];
  await prov.sendMessage({ groupId, text: `🛒 הוספתי ${itemList} לרשימה` });

  await supabase
    .from("whatsapp_messages")
    .update({ batch_status: "processed", classification: "batch_actionable" })
    .eq("group_id", groupId)
    .eq("batch_status", "processing");
}

// ─── Group Management ───

import type { WhatsAppProvider } from "../_shared/whatsapp-provider.ts";

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
    if (!res.ok) return null;
    const data = await res.json();
    const participants = ((data.participants || []) as Array<Record<string, string>>).map((p) => ({
      phone: (p.id || "").replace("@s.whatsapp.net", ""),
      name: p.name || p.id || "",
    }));
    return { name: data.subject || data.name || "משפחה", participants };
  } catch (err) {
    console.error("[fetchGroupInfo] Error:", err);
    return null;
  }
}

function generateHouseholdId(): string {
  return "hh_" + Math.random().toString(36).slice(2, 10);
}

async function handleBotAddedToGroup(groupId: string, prov: typeof provider) {
  console.log(`[GroupMgmt] Bot added to group ${groupId}`);

  const { data: existingConfig } = await supabase
    .from("whatsapp_config").select("household_id, bot_active").eq("group_id", groupId).single();

  if (existingConfig) {
    if (!existingConfig.bot_active) {
      await supabase.from("whatsapp_config").update({ bot_active: true }).eq("group_id", groupId);
    }
    await prov.sendMessage({ groupId, text: INTRO_MESSAGE });
    return;
  }

  const groupInfo = await fetchGroupInfo(groupId);
  const groupName = groupInfo?.name || "משפחה";
  const participants = groupInfo?.participants || [];
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  const humanParticipants = participants.filter((p) => p.phone !== botPhone);

  let householdId: string | null = null;
  if (humanParticipants.length > 0) {
    const phones = humanParticipants.map((p) => p.phone);
    const { data: existingMapping } = await supabase
      .from("whatsapp_member_mapping").select("household_id").in("phone_number", phones).limit(1).single();
    if (existingMapping) householdId = existingMapping.household_id;
  }

  if (!householdId) {
    householdId = generateHouseholdId();
    const { error } = await supabase.from("households_v2").insert({ id: householdId, name: groupName, lang: "he" });
    if (error) {
      await prov.sendMessage({ groupId, text: INTRO_MESSAGE });
      return;
    }
  }

  await supabase.from("whatsapp_config").insert({ household_id: householdId, group_id: groupId, bot_active: true, language: "he" });
  for (const p of humanParticipants) await upsertMemberMapping(householdId, p.phone, p.name);
  await prov.sendMessage({ groupId, text: INTRO_MESSAGE });
}

async function handleMemberAdded(groupId: string, phones: string[]) {
  const { data: config } = await supabase.from("whatsapp_config").select("household_id").eq("group_id", groupId).single();
  if (!config) return;
  const groupInfo = await fetchGroupInfo(groupId);
  const participantMap = new Map((groupInfo?.participants || []).map((p) => [p.phone, p.name]));
  for (const phone of phones) await upsertMemberMapping(config.household_id, phone, participantMap.get(phone) || phone);
}

async function handleMemberRemoved(groupId: string, phones: string[]) {
  const { data: config } = await supabase.from("whatsapp_config").select("household_id").eq("group_id", groupId).single();
  if (!config) return;
  for (const phone of phones) {
    await supabase.from("whatsapp_member_mapping").delete().eq("household_id", config.household_id).eq("phone_number", phone);
  }
}

async function handleBotRemoved(groupId: string) {
  await supabase.from("whatsapp_config").update({ bot_active: false }).eq("group_id", groupId);
}

async function handleGroupEvent(event: GroupEvent, prov: typeof provider) {
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  const isBotEvent = event.participants.includes(botPhone);
  switch (event.subtype) {
    case "add":
      if (isBotEvent) await handleBotAddedToGroup(event.groupId, prov);
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
