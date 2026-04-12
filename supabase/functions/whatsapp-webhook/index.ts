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

// ─── Quick Undo Patterns (pre-classifier, no Haiku call needed) ───
const UNDO_KEYWORDS = /(?:^|\s)(תמחקי|בטלי|תבטלי|עזבי|עזוב|תשכחי|ביטול|לא נכון|בעצם לא|אל תקנו|יש כבר|עזבי מזה|לא לא)(?:\s|$)/;
const UNDO_NEGATIONS = /(?:לא צריך|אל תקנו|יש כבר|אין צורך|לא רוצה)/;

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

    // 3c. Route direct (1:1) messages to onboarding handler
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

    // 4b. Populate household name cache (for upgrade prompts)
    if (!householdNameCache[householdId]) {
      const { data: hh } = await supabase.from("households_v2").select("name").eq("id", householdId).single();
      if (hh?.name) householdNameCache[householdId] = hh.name;
    }

    // 5. Log the raw message
    await logMessage(message, "received", householdId);

    // 6. Update member mapping (learn who's who by phone number)
    await upsertMemberMapping(householdId, message.senderPhone, message.senderName);

    // 6a. Dashboard link: send after 10 messages or 24h (whichever first)
    await maybesSendDashboardLink(message.groupId, householdId, config);

    // 6b. Detect @שלי direct address — forces a response regardless of intent
    // WhatsApp converts @mentions to numeric IDs: @שלי becomes @<LID> or @<phone>
    // (botPhone already declared in step 3b)
    const botLid = Deno.env.get("BOT_WHATSAPP_LID") || "138844095676524";
    const hebrewMention = /(?:^|[\s,])@?שלי(?:[\s,:!?.)]|$)/.test(message.text);
    const englishMention = /(?:^|[\s,])@?she(?:li|lly|lli|ly|lei|ley|lee)(?:[\s,:!?.)]|$)/i.test(message.text);
    const numericMention = message.text.includes(`@${botPhone}`) || message.text.includes(`@${botLid}`);
    const directAddress = hebrewMention || englishMention || numericMention;
    const cleanedText = directAddress
      ? message.text
          .replace(/@?שלי[\s,:]*/, "")
          .replace(/@?she(?:li|lly|lli|ly|lei|ley|lee)[\s,:]*/i, "")
          .replace(new RegExp(`@${botPhone}\\s*`), "")
          .replace(new RegExp(`@${botLid}\\s*`), "")
          .trim()
      : message.text;

    if (directAddress) {
      console.log(`[Webhook] Direct address detected from ${message.senderName} (hebrew=${hebrewMention}, english=${englishMention}, numeric=${numericMention})`);
    }

    // 6c. Quick undo: if message matches rejection/negation pattern, undo last bot action
    const isUndoKeyword = UNDO_KEYWORDS.test(message.text.trim());
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
            await provider.sendMessage({ groupId: message.groupId, text: `בוטל ✓` });
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
    }

    // 7. Check usage limits (free tier: 30 actions/month)
    const usage = await checkUsageLimit(householdId);
    const usageOk = usage.allowed;

    // 7b. Soft warning at 25 actions
    if (!usage.isPaid) {
      await maybeSendSoftWarning(message.groupId, householdId, usage.count, config.language);
    }

    // ─── STAGE 1: Haiku Classification (fast, cheap) ───
    const haikuCtx = await buildClassifierContext(householdId);
    const classification = await classifyIntent(
      cleanedText || message.text,
      message.senderName,
      haikuCtx
    );

    console.log(`[Webhook] Haiku: intent=${classification.intent} conf=${classification.confidence.toFixed(2)} from ${message.senderName}`);

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

      await storePendingBatch(message, classification, householdId);
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));

      if (!(await amILastPendingMessage(message.groupId, message.messageId))) {
        console.log(`[Batch] Not last message, deferring to newer invocation`);
        return new Response("OK", { status: 200 });
      }

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
    // UNLESS directly addressed — then always reply
    if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH) {
      if (directAddress) {
        const replyCtx = await buildReplyContext(householdId);
        const { reply } = await generateReply(classification, message.senderName, replyCtx);
        if (reply) {
          await provider.sendMessage({ groupId: message.groupId, text: reply });
        }
        await logMessage(message, "direct_address_reply", householdId, classification);
        return new Response("OK", { status: 200 });
      }
      await logMessage(message, "haiku_ignore", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Low confidence → escalate to Sonnet for full re-classification (fallback)
    if (classification.confidence < CONFIDENCE_LOW) {
      if (directAddress) {
        console.log(`[Webhook] Low confidence but direct address — forcing reply`);
        const replyCtx = await buildReplyContext(householdId);
        const { reply } = await generateReply(classification, message.senderName, replyCtx);
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

    // Medium confidence (0.50-0.69) → escalate to Sonnet full classification
    if (classification.confidence < CONFIDENCE_HIGH && isActionable) {
      console.log(`[Webhook] Medium confidence, escalating to Sonnet`);
      const sonnetResult = await classifyMessages(householdId, [
        { sender: message.senderName, text: message.text, timestamp: message.timestamp },
      ]);

      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        if (directAddress) {
          const replyCtx = await buildReplyContext(householdId);
          const { reply } = await generateReply(classification, message.senderName, replyCtx);
          if (reply) {
            await provider.sendMessage({ groupId: message.groupId, text: reply });
          }
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }
        await logMessage(message, "sonnet_escalated_social", householdId, classification);
        return new Response("OK", { status: 200 });
      }

      // Sonnet says actionable — check usage, execute, reply
      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId, classification);
        return new Response("OK", { status: 200 });
      }

      const { summary } = await executeActions(householdId, sonnetResult.actions);
      console.log(`[Webhook] Sonnet escalation executed ${summary.length} actions:`, summary);
      await incrementUsage(householdId);
      if (sonnetResult.reply) {
        await provider.sendMessage({ groupId: message.groupId, text: sonnetResult.reply });
      }
      await logMessage(message, "sonnet_escalated", householdId, classification);
      return new Response("OK", { status: 200 });
    }

    // Non-actionable intents (question, info_request) — generate reply only, no DB writes
    if (!isActionable && classification.intent !== "ignore") {
      const replyCtx = await buildReplyContext(householdId);
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
    await logMessage(message, "haiku_actionable", householdId, classification);

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

  // Check if household has an active subscription
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, plan")
    .eq("household_id", householdId)
    .eq("status", "active")
    .single();

  if (sub && sub.plan !== "free") return { allowed: true, count: 0, isPaid: true };

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
  // Send soft warning at 25 actions (once per month)
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

  if ((warningsSent || 0) > 0) return; // Already sent this month

  const remaining = 30 - usageCount;
  const lang = language || "he";
  const warningMsg = lang === "he"
    ? `נשארו לכם ${remaining} פעולות חינמיות החודש. רוצים להמשיך בלי הגבלה? 9.90 ₪ לחודש 🔗 sheli.ai/upgrade`
    : `You have ${remaining} free actions left this month. Want unlimited? $2.70/month 🔗 sheli.ai/upgrade`;

  await provider.sendMessage({ groupId, text: warningMsg });
  await supabase.from("whatsapp_messages").insert({
    message_id: `warning_${Date.now()}`,
    group_id: groupId,
    household_id: householdId,
    sender_phone: "system",
    sender_name: "system",
    text: warningMsg,
    classification: "soft_warning",
  });
  console.log(`[Webhook] Soft warning sent to ${groupId} (${remaining} actions remaining)`);
}

async function incrementUsage(householdId: string) {
  try {
    await supabase.rpc("increment_ai_usage", { p_household_id: householdId });
  } catch (err) {
    console.error("[incrementUsage] Error:", err);
  }
}

async function maybesSendDashboardLink(groupId: string, householdId: string, config: Record<string, unknown>) {
  try {
    // Atomically increment message count + set first_message_at
    await supabase.rpc("increment_group_message_count", { p_group_id: groupId });

    // Fetch current state
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("dashboard_link_sent, first_message_at, group_message_count")
      .eq("group_id", groupId)
      .single();

    if (!cfg || cfg.dashboard_link_sent) return;

    const messageCount = cfg.group_message_count || 0;
    const firstMsgTime = cfg.first_message_at ? new Date(cfg.first_message_at as string).getTime() : Date.now();
    const hoursSinceFirst = (Date.now() - firstMsgTime) / (1000 * 60 * 60);

    // Send dashboard link after 10 messages OR 24 hours
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

  const [membersRes, tasksRes, shoppingRes, patternsRes] = await Promise.all([
    supabase.from("household_members").select("display_name").eq("household_id", householdId),
    supabase.from("tasks").select("id, title, assigned_to").eq("household_id", householdId).eq("done", false),
    supabase.from("shopping_items").select("id, name, qty").eq("household_id", householdId).eq("got", false),
    supabase.from("household_patterns").select("pattern_type, pattern_key, pattern_value")
      .eq("household_id", householdId).gte("confidence", 0.3)
      .order("hit_count", { ascending: false }).limit(20),
  ]);

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
  const stripeLink = Deno.env.get("STRIPE_PREMIUM_LINK") || "sheli.ai/upgrade";
  const paymentUrl = stripeLink.includes("?")
    ? `${stripeLink}&client_reference_id=${householdId}`
    : `${stripeLink}?client_reference_id=${householdId}`;

  const upgradeMsg = lang === "he"
    ? `היי ${getHouseholdNameCached(householdId) || "משפחה"} 👋\nהשתמשתם ב-30 הפעולות החינמיות החודשיות שלכם.\nשדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה — 9.90 ₪ לחודש.\n🔗 ${paymentUrl}`
    : `Hey ${getHouseholdNameCached(householdId) || "family"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping — $2.70/month.\n🔗 ${paymentUrl}`;

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

// ─── 1:1 Onboarding Handler ───

const ONBOARDING_WELCOME = `היי! 👋 אני שלי, נעים מאוד!

אני יודעת לנהל רשימת קניות, לסדר מטלות ולהזכיר דברים חשובים.
אפשר גם לשלוח לי הודעה קולית, אני מבינה! 🎤

גרים עם עוד מישהו? אפשר גם להוסיף אותי לקבוצת הווטסאפ שלכם 🏠

רוצים לנסות? נסו לכתוב:
"חלב, ביצים ולחם"
או
"תזכירי לי לקנות ברוקולי וגבינה" 🛒`;

const ONBOARDING_WAITING_MESSAGES = [
  "עוד לא הספקתם להוסיף אותי? 😊\n\nשמרו את המספר שלי באנשי הקשר, ואז:\n1. קבוצת הווטסאפ של הבית\n2. הגדרות\n3. הוסיפו משתתף\n4. חפשו \"שלי\"",
  "אני מחכה בסבלנות! 😄\nברגע שתוסיפו אותי לקבוצה, אני מתחילה לעזור עם קניות, מטלות ואירועים.\n\n1. שמרו את המספר באנשי הקשר\n2. קבוצה\n3. הגדרות\n4. הוסיפו משתתף\n5. חפשו \"שלי\"",
  "רוצים לשאול משהו לפני שמוסיפים אותי? אני כאן! 😊\n\nאם יש שאלות, שאלו. אם מוכנים, הוסיפו אותי לקבוצת הווטסאפ המשפחתית 💪",
];

function getOnboardingWaitingMessage(msgCount: number): string {
  const idx = Math.min(msgCount - 2, ONBOARDING_WAITING_MESSAGES.length - 1);
  return ONBOARDING_WAITING_MESSAGES[Math.max(0, idx)];
}

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
    patterns: [/בטוח|בטיחות|פרטיות|privacy|secure|קוראת.*הודעות|מקשיבה/i],
    answer: "אני מזהה רק הודעות שקשורות לקניות, מטלות ואירועים. שיחות חברתיות, תמונות, סטטוסים ומדיה? מתעלמת לחלוטין 🔒\n\nהפרטיות שלכם חשובה לי!",
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

async function handleDirectMessage(message: IncomingMessage, prov: typeof provider) {
  const phone = message.senderPhone;
  console.log(`[1:1] Direct message from ${phone}: "${message.text.slice(0, 50)}"`);

  // Skip non-text messages in 1:1
  if (message.type !== "text") {
    return;
  }

  // 1. Check if this phone already has a household (already onboarded via group)
  const { data: mapping } = await supabase
    .from("whatsapp_member_mapping")
    .select("household_id")
    .eq("phone_number", phone)
    .limit(1)
    .single();

  if (mapping) {
    // Already in a group — redirect
    await prov.sendMessage({
      groupId: message.groupId,
      text: "היי! 👋 אני כבר בקבוצה שלכם — כתבו לי שם ואני אעזור!",
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
    await supabase.from("onboarding_conversations").insert({
      phone,
      state: "welcome",
      message_count: 1,
    });
    await prov.sendMessage({ groupId: message.groupId, text: ONBOARDING_WELCOME });
    console.log(`[1:1] New onboarding conversation for ${phone}`);
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

// Type import for 1:1 handler
import type { IncomingMessage } from "../_shared/whatsapp-provider.ts";

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

  // Notify any pending 1:1 onboarding conversations that their group is now active
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
      await prov.sendMessage({
        groupId: onboardingConvo.phone,
        text: "מעולה! 🎉 הצטרפתי לקבוצה! אני מתחילה לעזור — פשוט כתבו בקבוצה כרגיל ואני אסדר הכל.",
      });
      console.log(`[1:1] Notified ${p.phone} — onboarding complete, joined group ${groupId}`);
    }
  }
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

// ─── Correction Helpers (undo/redo for correct_bot + explicit undo) ───

async function getLastBotAction(groupId: string, householdId: string): Promise<{
  messageId: string;
  classification_data: ClassificationOutput;
  created_at: string;
} | null> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("id, classification_data, created_at")
    .eq("group_id", groupId)
    .eq("household_id", householdId)
    .in("classification", ["haiku_actionable", "sonnet_escalated", "batch_actionable"])
    .gte("created_at", fiveMinAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!data || !data.classification_data) return null;
  return {
    messageId: data.id,
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
        const { data: found } = await supabase
          .from("shopping_items").select("id, name")
          .eq("household_id", householdId).eq("name", item.name).eq("got", false)
          .order("created_at", { ascending: false }).limit(1).single();
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
        .from("tasks").select("id, title")
        .eq("household_id", householdId).eq("title", title).eq("done", false)
        .order("created_at", { ascending: false }).limit(1).single();
      if (found) {
        await supabase.from("tasks").delete().eq("id", found.id);
        undone.push(`"${found.title}"`);
      }
      break;
    }
    case "add_event": {
      const title = lastAction.entities.title || lastAction.entities.raw_text;
      const { data: found } = await supabase
        .from("events").select("id, title")
        .eq("household_id", householdId).eq("title", title)
        .order("created_at", { ascending: false }).limit(1).single();
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
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
  classification: ClassificationOutput,
  householdId: string,
  prov: typeof provider,
): Promise<void> {
  const lastAction = await getLastBotAction(message.groupId, householdId);
  if (!lastAction) {
    await prov.sendMessage({ groupId: message.groupId, text: "לא מצאתי פעולה אחרונה לתקן 🤔" });
    return;
  }

  const undone = await undoLastAction(householdId, lastAction.classification_data);
  console.log(`[Correction] Undone:`, undone);

  const correctionText = classification.entities.correction_text;
  let redone: string[] = [];
  if (correctionText) {
    const ctx = await buildClassifierContext(householdId);
    const reclassified = await classifyIntent(correctionText, message.senderName, ctx);
    if (reclassified.intent !== "ignore" && reclassified.intent !== "correct_bot") {
      const actions = haikuEntitiesToActions(reclassified);
      const result = await executeActions(householdId, actions);
      redone = result.summary;
    }
  }

  await supabase.from("classification_corrections").insert({
    household_id: householdId,
    message_id: lastAction.messageId,
    correction_type: "mention_correction",
    original_data: lastAction.classification_data,
    corrected_data: classification,
  });

  await derivePatternFromCorrection(householdId, "mention_correction", lastAction.classification_data, classification);

  const replyParts: string[] = [];
  if (undone.length > 0) replyParts.push(`ביטלתי: ${undone.join(", ")}`);
  if (redone.length > 0) replyParts.push(`הוספתי: ${redone.join(", ")}`);
  const reply = replyParts.length > 0 ? `סורי! 😅 ${replyParts.join(". ")}` : "סורי! תיקנתי 😅";

  await prov.sendMessage({ groupId: message.groupId, text: reply });
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
      }
    }
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
      }
    }
  } catch (err) {
    console.error("[derivePatternFromCorrection] Error:", err);
  }
}
