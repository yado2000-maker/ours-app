// ============================================================================
// OTP Sender Edge Function
//
// Handles two paths:
// 1. OTP delivery (Supabase Auth hook) — verify webhook signature, normalize
//    phone, check WhatsApp availability, send via WhatsApp or fall back to SMS.
// 2. Bridge message (POST with action: "bridge") — send WhatsApp onboarding
//    nudge to users who just authenticated via the web app.
//
// Env vars:
//   WHAPI_API_URL, WHAPI_TOKEN, VONAGE_API_KEY, VONAGE_API_SECRET,
//   VONAGE_SENDER, OTP_HOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

// ─── Shared Clients & Config ───

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const WHAPI_API_URL = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
const WHAPI_TOKEN = Deno.env.get("WHAPI_TOKEN") || "";
const VONAGE_API_KEY = Deno.env.get("VONAGE_API_KEY") || "";
const VONAGE_API_SECRET = Deno.env.get("VONAGE_API_SECRET") || "";
const VONAGE_SENDER = Deno.env.get("VONAGE_SENDER") || "Sheli";
const OTP_HOOK_SECRET = Deno.env.get("OTP_HOOK_SECRET") || "";

// ─── OTP Message Templates ───

function otpWhatsAppMessage(otp: string): string {
  return `🔐 קוד האימות לאפליקציית שלי: *${otp}*\nהקוד תקף ל-10 דקות.`;
}

function otpSmsMessage(otp: string): string {
  return `Sheli: ${otp} - קוד אימות לאפליקציית שלי`;
}

const BOT_PHONE = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
const BRIDGE_MESSAGE = `✅ התחברת בהצלחה לשלי!\nרוצים שאעזור גם לשאר הבית? הוסיפו אותי לקבוצת הווטסאפ שלכם 👇\nhttps://wa.me/${BOT_PHONE}`;

// ─── Phone Number Normalization ───

function normalizePhone(raw: string): string {
  // Strip everything except digits
  let digits = raw.replace(/[^\d]/g, "");

  // Handle Israeli numbers: convert leading 0 to 972
  if (digits.startsWith("0") && digits.length === 10) {
    digits = "972" + digits.slice(1);
  }

  // Strip leading 972 duplicate (e.g., 972972...)
  if (digits.startsWith("972972")) {
    digits = digits.slice(3);
  }

  // Ensure starts with country code (assume 972 for 9-digit numbers)
  if (digits.length === 9 && !digits.startsWith("972")) {
    digits = "972" + digits;
  }

  return digits;
}

// ─── Webhook Signature Verification ───

function verifyWebhookSignature(req: Request, body: string): boolean {
  if (!OTP_HOOK_SECRET) {
    console.error("[OTP] CRITICAL: No OTP_HOOK_SECRET configured");
    return false;
  }

  const webhookId = req.headers.get("webhook-id");
  const webhookTimestamp = req.headers.get("webhook-timestamp");
  const webhookSignature = req.headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.error("[OTP] Missing webhook verification headers");
    return false;
  }

  try {
    // OTP_HOOK_SECRET format: "v1,whsec_<base64>" — strip the "v1,whsec_" prefix
    let secret = OTP_HOOK_SECRET;
    if (secret.startsWith("v1,whsec_")) {
      secret = secret.slice("v1,whsec_".length);
    } else if (secret.startsWith("whsec_")) {
      secret = secret.slice("whsec_".length);
    }

    const wh = new Webhook(secret);
    wh.verify(body, {
      "webhook-id": webhookId,
      "webhook-timestamp": webhookTimestamp,
      "webhook-signature": webhookSignature,
    });
    return true;
  } catch (err) {
    console.error("[OTP] Webhook signature verification failed:", err);
    return false;
  }
}

// ─── Fetch with timeout ───

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// ─── WhatsApp Contact Check ───

async function hasWhatsApp(phone: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${WHAPI_API_URL}/contacts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHAPI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blocking: "wait",
        contacts: [phone],
        force_check: false,
      }),
    });

    if (!res.ok) {
      console.error("[OTP] Whapi contacts check failed:", res.status, await res.text());
      return false;
    }

    const data = await res.json();
    const contact = data.contacts?.[0];
    return contact?.status === "valid";
  } catch (err) {
    console.error("[OTP] Whapi contacts check error:", err);
    return false;
  }
}

// ─── Send via WhatsApp ───

async function sendWhatsApp(phone: string, text: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${WHAPI_API_URL}/messages/text`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHAPI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: `${phone}@s.whatsapp.net`,
        body: text,
      }),
    });

    if (!res.ok) {
      console.error("[OTP] Whapi send failed:", res.status, await res.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("[OTP] Whapi send error:", err);
    return false;
  }
}

// ─── Send via Vonage SMS ───

async function sendSms(phone: string, text: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      api_key: VONAGE_API_KEY,
      api_secret: VONAGE_API_SECRET,
      from: VONAGE_SENDER,
      to: phone,
      text: text,
    });

    const res = await fetchWithTimeout("https://rest.nexmo.com/sms/json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      console.error("[OTP] Vonage HTTP error:", res.status, await res.text());
      return false;
    }

    const data = await res.json();
    const status = data.messages?.[0]?.status;
    if (status !== "0") {
      console.error("[OTP] Vonage SMS failed, status:", status, "error:", data.messages?.[0]?.["error-text"]);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[OTP] Vonage send error:", err);
    return false;
  }
}

// ─── Logging (fire-and-forget, never blocks response) ───

function logDelivery(
  phone: string,
  channel: "whatsapp" | "sms",
  messageType: "otp" | "bridge",
  success: boolean,
): void {
  // Fire-and-forget — don't await
  supabase.from("whatsapp_messages").insert({
    household_id: "unknown",
    group_id: `${phone}@s.whatsapp.net`,
    sender_phone: "system",
    sender_name: "Sheli OTP",
    message_text: `[${messageType}] via ${channel}${success ? "" : " (FAILED)"}`,
    message_type: "text",
    whatsapp_message_id: `otp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    classification: `otp_${messageType}_${channel}`,
  }).then(({ error }) => {
    if (error) console.error("[OTP] Log insert error:", error);
  });
}

// ─── OTP Delivery Handler ───

async function handleOtpDelivery(
  phone: string,
  otp: string,
): Promise<{ success: boolean; channel: string }> {
  const normalizedPhone = normalizePhone(phone);
  console.log(`[OTP] Delivering to ${normalizedPhone}`);

  // Step 1: Check if phone has WhatsApp
  const hasWA = await hasWhatsApp(normalizedPhone);

  if (hasWA) {
    // Step 2a: Try WhatsApp first
    const whatsappMsg = otpWhatsAppMessage(otp);
    const sent = await sendWhatsApp(normalizedPhone, whatsappMsg);
    if (sent) {
      logDelivery(normalizedPhone, "whatsapp", "otp", true);
      return { success: true, channel: "whatsapp" };
    }
    // WhatsApp send failed — fall through to SMS
    console.warn("[OTP] WhatsApp send failed, falling back to SMS");
    logDelivery(normalizedPhone, "whatsapp", "otp", false);
  }

  // Step 2b: SMS fallback (or primary if no WhatsApp)
  const smsMsg = otpSmsMessage(otp);
  const smsSent = await sendSms(normalizedPhone, smsMsg);
  logDelivery(normalizedPhone, "sms", "otp", smsSent);

  if (!smsSent) {
    console.error("[OTP] Both WhatsApp and SMS failed for:", normalizedPhone);
    return { success: false, channel: "none" };
  }

  return { success: true, channel: "sms" };
}

// ─── Bridge Message Handler ───

async function handleBridge(phone: string): Promise<{ success: boolean }> {
  const normalizedPhone = normalizePhone(phone);
  console.log(`[Bridge] Sending onboarding nudge to ${normalizedPhone}`);

  // Bridge only goes via WhatsApp — if no WA, skip silently
  const hasWA = await hasWhatsApp(normalizedPhone);
  if (!hasWA) {
    console.log("[Bridge] No WhatsApp for this number, skipping");
    return { success: true }; // Not an error — user just doesn't have WA
  }

  const sent = await sendWhatsApp(normalizedPhone, BRIDGE_MESSAGE);
  logDelivery(normalizedPhone, "whatsapp", "bridge", sent);
  return { success: sent };
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { http_code: 405, message: "Method not allowed" } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Read body once (needed for both signature verification and parsing)
    const bodyText = await req.text();
    const payload = JSON.parse(bodyText);

    // ─── Route: Bridge message (requires valid Supabase JWT) ───
    if (payload.action === "bridge" && payload.phone) {
      // Authenticate: require valid Supabase session token
      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: { http_code: 401, message: "Auth required for bridge" } }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.split(" ")[1]);
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: { http_code: 401, message: "Invalid token" } }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }

      const result = await handleBridge(payload.phone);
      if (!result.success) {
        return new Response(JSON.stringify({ error: { http_code: 500, message: "Bridge message delivery failed" } }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // ─── Route: OTP delivery (Supabase Auth hook) ───

    // ALWAYS verify Standard Webhooks signature for OTP path
    if (!verifyWebhookSignature(req, bodyText)) {
      return new Response(JSON.stringify({ error: { http_code: 401, message: "Invalid webhook signature" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extract phone and OTP from hook payload
    const phone = payload.user?.phone;
    const otp = payload.sms?.otp;

    if (!phone || !otp) {
      console.error("[OTP] Missing phone or otp in payload:", JSON.stringify(payload).slice(0, 200));
      return new Response(JSON.stringify({ error: { http_code: 400, message: "Missing phone or otp" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await handleOtpDelivery(phone, otp);

    if (!result.success) {
      return new Response(JSON.stringify({ error: { http_code: 500, message: "OTP delivery failed" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Supabase Auth hook expects empty object on success
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[OTP] Unhandled error:", err);
    return new Response(JSON.stringify({ error: { http_code: 500, message: "Internal server error" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
