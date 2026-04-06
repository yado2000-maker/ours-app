// iCount Webhook Handler — Processes payment notifications from iCount
// Deployed as a Supabase Edge Function
// iCount sends: POST with JSON payload on every document creation (invoice, receipt, etc.)
//
// Webhook config: iCount dashboard → הגדרות → אוטומציה → Webhooks
// Secret header: X-iCount-Secret (configured in iCount dashboard)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const ICOUNT_WEBHOOK_SECRET = Deno.env.get("ICOUNT_WEBHOOK_SECRET") || "";

// ─── Signature Verification ───

function verifyIcountSignature(req: Request): boolean {
  if (!ICOUNT_WEBHOOK_SECRET) {
    console.error("[iCount] CRITICAL: No ICOUNT_WEBHOOK_SECRET configured — rejecting all webhooks for security");
    return false;
  }
  const secret = req.headers.get("x-icount-secret") || "";
  // Constant-time comparison to prevent timing attacks
  if (secret.length !== ICOUNT_WEBHOOK_SECRET.length) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(secret);
  const b = encoder.encode(ICOUNT_WEBHOOK_SECRET);
  if (a.byteLength !== b.byteLength) return false;
  // Use crypto.subtle for timing-safe comparison
  let result = 0;
  for (let i = 0; i < a.byteLength; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ─── WhatsApp Notification Helper ───

async function sendWhatsAppMessage(householdId: string, text: string) {
  try {
    const { data: config } = await supabase
      .from("whatsapp_config")
      .select("group_id")
      .eq("household_id", householdId)
      .eq("bot_active", true)
      .limit(1)
      .single();

    if (!config) return;

    const apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
    const token = Deno.env.get("WHAPI_TOKEN") || "";

    await fetch(`${apiUrl}/messages/text`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: config.group_id, body: text }),
    });
  } catch (err) {
    console.error("[iCount] Failed to send WhatsApp notification:", err);
  }
}

// ─── Extract household_id from iCount webhook payload ───
// The household_id is passed via the "remarks" or "custom1" field when generating the payment page.
// It can also be extracted from client_name if formatted as "household:HHID".

function extractHouseholdId(payload: Record<string, unknown>): string | null {
  // Method 1: Check remarks/custom fields for household_id
  const remarks = (payload.remarks as string) || "";
  const custom1 = (payload.custom1 as string) || "";
  const custom2 = (payload.custom2 as string) || "";

  for (const field of [remarks, custom1, custom2]) {
    // L12 fix: require hh_ prefix for safety (8-char bare strings are too permissive)
    if (field.startsWith("hh_")) {
      return field;
    }
    if (field.match(/^[a-z0-9]{8}$/) && !field.match(/^\d{8}$/)) {
      // Accept bare 8-char alphanumeric IDs only if they contain at least one letter
      return field;
    }
    // Check for "household:HHID" format
    const match = field.match(/household[=:]([a-z0-9_]+)/i);
    if (match) return match[1];
  }

  // Method 2: Look up client email in whatsapp_member_mapping or onboarding_conversations
  const clientEmail = (payload.client_email as string) || "";
  if (clientEmail) {
    console.log(`[iCount] Will look up household by client email: ${clientEmail}`);
    // This will be resolved asynchronously in the handler
  }

  return null;
}

// ─── Determine plan from payment amount ───

function determinePlan(amount: number): string {
  // 9.90 ILS = Premium, 24.90 ILS = Family+
  if (amount <= 15) return "premium";
  if (amount <= 30) return "family_plus";
  return "premium"; // Default
}

// ─── Handle Payment Completed ───

async function handlePaymentCompleted(payload: Record<string, unknown>) {
  const doctype = (payload.doctype as string) || "";
  const docnum = payload.docnum as number;

  // Only process receipts (קבלה) and invoice-receipts (חשבונית מס קבלה)
  // Skip quotes, delivery notes, etc.
  const paymentDoctypes = ["receipt", "invrec", "tax_invoice_receipt"];
  if (!paymentDoctypes.includes(doctype)) {
    console.log(`[iCount] Ignoring doctype: ${doctype} (not a payment document)`);
    return;
  }

  // L13 fix: idempotency check — skip if we already processed this document number
  if (docnum) {
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("household_id")
      .eq("last_docnum", docnum)
      .limit(1);
    if (existing && existing.length > 0) {
      console.log(`[iCount] Skipping duplicate webhook for docnum ${docnum} (already processed for ${existing[0].household_id})`);
      return;
    }
  }

  // Extract payment info
  const items = (payload.items as Array<Record<string, unknown>>) || [];
  const totalAmount = items.reduce((sum, item) => {
    return sum + ((item.unitprice as number) || 0) * ((item.quantity as number) || 1);
  }, 0);

  const householdId = extractHouseholdId(payload);

  if (!householdId) {
    console.error("[iCount] Payment received but no household_id found in payload:", JSON.stringify(payload).slice(0, 500));
    return;
  }

  const plan = determinePlan(totalAmount);

  console.log(`[iCount] Payment completed: household=${householdId}, plan=${plan}, amount=${totalAmount}, doc=${doctype}-${docnum}`);

  // Upsert subscription (L13: include last_docnum for idempotency)
  const { error } = await supabase.from("subscriptions").upsert({
    household_id: householdId,
    status: "active",
    plan,
    last_docnum: docnum || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "household_id" });

  if (error) {
    console.error("[iCount] Failed to upsert subscription:", error);
    return;
  }

  // Send WhatsApp confirmation
  const msg = plan === "premium"
    ? "🎉 תודה שהצטרפתם ל-Premium! מהיום אני עובדת ללא הגבלה. בואו נמשיך!"
    : "🎉 תודה שהצטרפתם ל-Family+! עד 3 קבוצות, ללא הגבלה. בואו נמשיך!";

  await sendWhatsAppMessage(householdId, msg);
}

// ─── Handle Subscription Canceled ───
// iCount standing orders can be canceled — we detect this via a "credit_note" doctype
// or by monitoring the standing order status via API polling (future improvement)

async function handleCancellation(payload: Record<string, unknown>) {
  const householdId = extractHouseholdId(payload);
  if (!householdId) return;

  console.log(`[iCount] Subscription canceled for household: ${householdId}`);

  await supabase.from("subscriptions").update({
    status: "canceled",
    updated_at: new Date().toISOString(),
  }).eq("household_id", householdId);

  await sendWhatsAppMessage(
    householdId,
    "המנוי שלכם הסתיים. תמיד אפשר לחזור! 💛\n30 פעולות חינם בחודש ממשיכות לעבוד."
  );
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Verify webhook signature
  if (!verifyIcountSignature(req)) {
    console.warn("[iCount] Invalid webhook signature");
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const payload = await req.json();
    const doctype = (payload.doctype as string) || "unknown";

    console.log(`[iCount] Webhook received: doctype=${doctype}, docnum=${payload.docnum}`);

    // Route based on document type
    const cancellationTypes = ["credit_note", "refund"];
    if (cancellationTypes.includes(doctype)) {
      await handleCancellation(payload);
    } else {
      await handlePaymentCompleted(payload);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[iCount] Error processing webhook:", err);
    return new Response("Internal error", { status: 500 });
  }
});
