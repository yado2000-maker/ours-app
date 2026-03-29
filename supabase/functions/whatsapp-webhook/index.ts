// WhatsApp Webhook Handler — The main entry point for all incoming messages
// Receives webhooks from Whapi.Cloud (or Meta Cloud API), classifies messages
// via Claude AI, executes actions, and sends replies.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createProvider } from "../_shared/whatsapp-provider.ts";
import { classifyMessages } from "../_shared/ai-classifier.ts";
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

    // 2. Parse the incoming message
    const body = await req.json();
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

    // 5. Log the raw message
    await logMessage(message, "received", householdId);

    // 6. Update member mapping (learn who's who by phone number)
    await upsertMemberMapping(householdId, message.senderPhone, message.senderName);

    // 7. Check usage limits (free tier: 30 actions/month)
    const usageOk = await checkUsageLimit(householdId);

    // 8. Classify with AI
    const classification = await classifyMessages(householdId, [
      {
        sender: message.senderName,
        text: message.text,
        timestamp: message.timestamp,
      },
    ]);

    // 9. If not actionable, skip
    if (!classification.respond || classification.actions.length === 0) {
      console.log(`[Webhook] Social message from ${message.senderName}, skipping`);
      await logMessage(message, "classified_social", householdId);
      return new Response("OK", { status: 200 });
    }

    // 10. Check if usage limit exceeded (only count actionable messages)
    if (!usageOk) {
      // Send upgrade prompt instead of acting
      const lang = config.language || "he";
      const upgradeMsg = lang === "he"
        ? `היי ${getHouseholdNameCached(householdId) || "משפחה"} 👋\nהשתמשתם ב-30 הפעולות החינמיות החודשיות שלכם.\nשדרגו ל-Premium כדי שאמשיך לעזור ללא הגבלה — 19.90 ₪ לחודש.\n🔗 ours-app-eta.vercel.app/upgrade`
        : `Hey ${getHouseholdNameCached(householdId) || "family"} 👋\nYou've used your 30 free actions this month.\nUpgrade to Premium to keep me helping — $5.50/month.\n🔗 ours-app-eta.vercel.app/upgrade`;

      await provider.sendMessage({ groupId: message.groupId, text: upgradeMsg });
      await logMessage(message, "usage_limit_reached", householdId);
      return new Response("OK", { status: 200 });
    }

    // 11. Execute actions (create tasks, shopping items, events)
    const { summary } = await executeActions(householdId, classification.actions);
    console.log(`[Webhook] Executed ${summary.length} actions:`, summary);

    // 12. Increment usage counter
    await incrementUsage(householdId);

    // 13. Send reply to group
    if (classification.reply) {
      const sent = await provider.sendMessage({
        groupId: message.groupId,
        text: classification.reply,
      });
      console.log(`[Webhook] Reply sent: ${sent}`);
    }

    // 14. Log completion
    await logMessage(message, "processed", householdId);

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
    await supabase.from("whatsapp_member_mapping").upsert(
      {
        household_id: householdId,
        phone_number: phone,
        member_name: name,
      },
      { onConflict: "household_id,phone_number" }
    );
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
    .eq("classification", "processed")
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
