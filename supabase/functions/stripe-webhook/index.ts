// Stripe Webhook Handler — Processes subscription lifecycle events
// Deployed as a separate Supabase Edge Function
// Stripe sends: checkout.session.completed, customer.subscription.deleted, invoice.payment_failed

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

// ─── Stripe Signature Verification ───

async function verifyStripeSignature(payload: string, signature: string): Promise<boolean> {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("[Stripe] No webhook secret configured — skipping verification");
    return true;
  }

  const parts = signature.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    if (key === "t") acc.timestamp = value;
    if (key === "v1") acc.signatures.push(value);
    return acc;
  }, { timestamp: "", signatures: [] as string[] });

  if (!parts.timestamp || parts.signatures.length === 0) return false;

  const signedPayload = `${parts.timestamp}.${payload}`;
  const key = new TextEncoder().encode(STRIPE_WEBHOOK_SECRET);
  const data = new TextEncoder().encode(signedPayload);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  const expectedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

  return parts.signatures.includes(expectedSig);
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
    console.error("[Stripe] Failed to send WhatsApp notification:", err);
  }
}

// ─── Event Handlers ───

async function handleCheckoutCompleted(session: Record<string, unknown>) {
  const householdId = session.client_reference_id as string;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  if (!householdId) {
    console.error("[Stripe] checkout.session.completed without client_reference_id");
    return;
  }

  // Determine plan from amount in agorot.
  // 1490 = Premium monthly (14.90 ILS), 14900 = Premium annual (149 ILS), 2490 = Family+ monthly (24.90 ILS).
  // Legacy: 990 (9.90 ILS) still resolves to premium for any grandfathered charges.
  const amountTotal = (session.amount_total as number) || 0;
  let plan: "premium" | "family_plus" = "premium";
  let billingPeriod: "monthly" | "annual" = "monthly";
  if (amountTotal >= 14000 && amountTotal <= 16000) {
    billingPeriod = "annual"; // ~149 ILS
  } else if (amountTotal >= 2000 && amountTotal < 4000) {
    plan = "family_plus"; // ~24.90 ILS
  }
  console.log(`[Stripe] Resolved amount=${amountTotal} → plan=${plan}, period=${billingPeriod}`);

  console.log(`[Stripe] Checkout completed: household=${householdId}, plan=${plan}, customer=${customerId}`);

  // Upsert subscription
  const { error } = await supabase.from("subscriptions").upsert({
    household_id: householdId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    status: "active",
    plan,
    updated_at: new Date().toISOString(),
  }, { onConflict: "household_id" });

  if (error) {
    console.error("[Stripe] Failed to upsert subscription:", error);
    return;
  }

  // Send confirmation in WhatsApp group
  const msg = plan === "premium"
    ? "🎉 תודה שהצטרפתם ל-Premium! מהיום אני עובדת ללא הגבלה. בואו נמשיך!"
    : "🎉 תודה שהצטרפתם ל-Family+! עד 3 קבוצות, ללא הגבלה. בואו נמשיך!";

  await sendWhatsAppMessage(householdId, msg);
}

async function handleSubscriptionDeleted(subscription: Record<string, unknown>) {
  const subscriptionId = subscription.id as string;

  console.log(`[Stripe] Subscription deleted: ${subscriptionId}`);

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("household_id")
    .eq("stripe_subscription_id", subscriptionId)
    .single();

  if (!sub) {
    console.warn("[Stripe] No subscription found for:", subscriptionId);
    return;
  }

  await supabase.from("subscriptions").update({
    status: "canceled",
    updated_at: new Date().toISOString(),
  }).eq("stripe_subscription_id", subscriptionId);

  await sendWhatsAppMessage(
    sub.household_id,
    "המנוי שלכם הסתיים. תמיד אפשר לחזור! 💛\n40 פעולות חינם בחודש ממשיכות לעבוד."
  );
}

async function handlePaymentFailed(invoice: Record<string, unknown>) {
  const subscriptionId = invoice.subscription as string;

  console.log(`[Stripe] Payment failed for subscription: ${subscriptionId}`);

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("household_id")
    .eq("stripe_subscription_id", subscriptionId)
    .single();

  if (!sub) return;

  await supabase.from("subscriptions").update({
    status: "past_due",
    updated_at: new Date().toISOString(),
  }).eq("stripe_subscription_id", subscriptionId);

  await sendWhatsAppMessage(
    sub.household_id,
    "⚠️ לא הצלחתי לגבות את התשלום החודשי. עדכנו את אמצעי התשלום כדי להמשיך ליהנות מ-Premium.\n🔗 sheli.ai/billing"
  );
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature") || "";

  const isValid = await verifyStripeSignature(payload, signature);
  if (!isValid) {
    console.warn("[Stripe] Invalid webhook signature");
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    const event = JSON.parse(payload);
    console.log(`[Stripe] Event: ${event.type}`);

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`[Stripe] Ignoring event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Stripe] Error processing event:", err);
    return new Response("Internal error", { status: 500 });
  }
});
