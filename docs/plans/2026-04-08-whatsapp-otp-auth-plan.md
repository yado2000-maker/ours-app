# WhatsApp OTP Authentication — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable phone OTP authentication using WhatsApp (via Whapi.Cloud) as primary delivery channel, with Vonage SMS as fallback.

**Architecture:** Supabase Send SMS Hook intercepts OTP generation → Edge Function checks WhatsApp presence via Whapi → delivers OTP via WhatsApp DM or Vonage SMS fallback → existing AuthScreen UI handles the rest unchanged.

**Tech Stack:** Supabase Auth (Send SMS Hook), Deno Edge Functions, Whapi.Cloud API, Vonage SMS API

**Design doc:** `docs/plans/2026-04-08-whatsapp-otp-auth-design.md`

---

### Task 1: Create `otp-sender` Edge Function

**Files:**
- Create: `supabase/functions/otp-sender/index.ts`

**Step 1: Create the Edge Function file**

```typescript
// supabase/functions/otp-sender/index.ts
// WhatsApp OTP delivery via Whapi.Cloud + Vonage SMS fallback
// Called by Supabase Auth "Send SMS" hook

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WHAPI_URL = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
const WHAPI_TOKEN = Deno.env.get("WHAPI_TOKEN") || "";
const VONAGE_API_KEY = Deno.env.get("VONAGE_API_KEY") || "";
const VONAGE_API_SECRET = Deno.env.get("VONAGE_API_SECRET") || "";
const VONAGE_SENDER = Deno.env.get("VONAGE_SENDER") || "Sheli";
const HOOK_SECRET = Deno.env.get("OTP_HOOK_SECRET") || "";

// ─── Phone Normalization ───

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  return "972" + digits;
}

// ─── WhatsApp Check (Whapi.Cloud) ───

async function checkWhatsApp(phone: string): Promise<boolean> {
  try {
    const res = await fetch(`${WHAPI_URL}/contacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHAPI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blocking: "wait",
        contacts: [phone],
        force_check: false,
      }),
    });
    if (!res.ok) {
      console.error("[OTP] Whapi contact check failed:", res.status);
      return false;
    }
    const data = await res.json();
    const contact = data.contacts?.[0];
    return contact?.status === "valid";
  } catch (err) {
    console.error("[OTP] Whapi contact check error:", err);
    return false; // Fall back to SMS on any error
  }
}

// ─── Send via WhatsApp (Whapi.Cloud) ───

async function sendWhatsApp(phone: string, otp: string): Promise<boolean> {
  const body = `🔐 קוד האימות לאפליקציית שלי: *${otp}*\nהקוד תקף ל-10 דקות.`;
  try {
    const res = await fetch(`${WHAPI_URL}/messages/text`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHAPI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: `${phone}@s.whatsapp.net`,
        body,
      }),
    });
    if (!res.ok) {
      console.error("[OTP] Whapi send failed:", res.status, await res.text());
      return false;
    }
    console.log("[OTP] WhatsApp OTP sent to", phone);
    return true;
  } catch (err) {
    console.error("[OTP] Whapi send error:", err);
    return false;
  }
}

// ─── Send via Vonage SMS (fallback) ───

async function sendSMS(phone: string, otp: string): Promise<boolean> {
  const text = `Sheli: ${otp} - קוד אימות לאפליקציית שלי`;
  try {
    const params = new URLSearchParams({
      api_key: VONAGE_API_KEY,
      api_secret: VONAGE_API_SECRET,
      from: VONAGE_SENDER,
      to: phone,
      text,
    });
    const res = await fetch("https://rest.nexmo.com/sms/json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await res.json();
    const status = data.messages?.[0]?.status;
    if (status !== "0") {
      console.error("[OTP] Vonage SMS failed:", data.messages?.[0]);
      return false;
    }
    console.log("[OTP] SMS OTP sent to", phone);
    return true;
  } catch (err) {
    console.error("[OTP] Vonage SMS error:", err);
    return false;
  }
}

// ─── Logging ───

async function logOtpDelivery(phone: string, channel: "whatsapp" | "sms", success: boolean) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) return;
    const sb = createClient(supabaseUrl, serviceKey);
    await sb.from("whatsapp_messages").insert({
      group_id: `${phone}@s.whatsapp.net`,
      sender_phone: "system",
      sender_name: "Sheli OTP",
      message_text: `OTP sent via ${channel}`,
      classification: "otp_sent",
      classification_data: { channel, success, phone },
    });
  } catch (err) {
    console.error("[OTP] Log error (non-fatal):", err);
  }
}

// ─── Main Handler ───

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    // Verify webhook signature from Supabase
    const payload = await req.text();
    let hookData: { user: { phone: string }; sms: { otp: string } };

    if (HOOK_SECRET) {
      const base64Secret = HOOK_SECRET.replace("v1,whsec_", "");
      const headers = Object.fromEntries(req.headers);
      const wh = new Webhook(base64Secret);
      hookData = wh.verify(payload, headers) as typeof hookData;
    } else {
      // Dev mode: no signature verification
      hookData = JSON.parse(payload);
    }

    const phone = normalizePhone(hookData.user.phone);
    const otp = hookData.sms.otp;

    console.log("[OTP] Delivering OTP to", phone);

    // Try WhatsApp first
    const hasWhatsApp = await checkWhatsApp(phone);
    let sent = false;
    let channel: "whatsapp" | "sms" = "whatsapp";

    if (hasWhatsApp) {
      sent = await sendWhatsApp(phone, otp);
    }

    // Fallback to SMS if WhatsApp failed or unavailable
    if (!sent) {
      channel = "sms";
      sent = await sendSMS(phone, otp);
    }

    // Log delivery (async, non-blocking)
    logOtpDelivery(phone, channel, sent);

    if (!sent) {
      return new Response(
        JSON.stringify({ error: { http_code: 500, message: "Failed to deliver OTP via both channels" } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[OTP] Handler error:", err);
    return new Response(
      JSON.stringify({ error: { http_code: 500, message: err.message || "Internal error" } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
```

**Step 2: Verify file created**

Run: `ls -la supabase/functions/otp-sender/index.ts`
Expected: File exists

**Step 3: Commit**

```bash
git add supabase/functions/otp-sender/index.ts
git commit -m "feat: add otp-sender Edge Function (WhatsApp + Vonage SMS fallback)"
```

---

### Task 2: Sign up for Vonage and configure secrets

**This is a manual task — cannot be automated.**

**Step 1: Create Vonage account**
- Go to https://dashboard.nexmo.com/sign-up
- Sign up with email
- Note the API Key and API Secret from the dashboard homepage

**Step 2: Add Edge Function secrets in Supabase Dashboard**
- Go to Supabase Dashboard → Edge Functions → `otp-sender` → Secrets
- Add these env vars:
  - `VONAGE_API_KEY` = (from Vonage dashboard)
  - `VONAGE_API_SECRET` = (from Vonage dashboard)
  - `VONAGE_SENDER` = `Sheli`
- Verify existing secrets are present:
  - `WHAPI_TOKEN` (already set for whatsapp-webhook)
  - `WHAPI_API_URL` (already set, or defaults to https://gate.whapi.cloud)
  - `SUPABASE_URL` (auto-set by Supabase)
  - `SUPABASE_SERVICE_ROLE_KEY` (auto-set by Supabase)

**Step 3: Note the OTP hook secret**
- After enabling the Send SMS Hook in Task 3, copy the generated secret
- Add it as `OTP_HOOK_SECRET` in Edge Function secrets

---

### Task 3: Enable Phone Auth + Send SMS Hook in Supabase Dashboard

**This is a manual dashboard configuration task.**

**Step 1: Enable Phone Provider**
- Supabase Dashboard → Authentication → Providers
- Enable **Phone** provider
- Select any SMS provider from dropdown (e.g., Twilio — credentials won't be used since hook overrides)
- Fill in dummy values if required by the form (the hook intercepts before they're used)
- Save

**Step 2: Configure Send SMS Hook**
- Supabase Dashboard → Authentication → Hooks
- Find **Send SMS** hook
- Enable it
- Set type: **HTTP**
- Set URI: `https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/otp-sender`
- Copy the auto-generated hook secret
- Save

**Step 3: Add hook secret to Edge Function**
- Go to Edge Functions → `otp-sender` → Secrets
- Add: `OTP_HOOK_SECRET` = the value copied from Step 2 (format: `v1,whsec_...`)

---

### Task 4: Deploy `otp-sender` Edge Function

**Step 1: Deploy via Supabase Dashboard**

The `otp-sender` function is small enough (~160 lines) for MCP deployment, unlike `whatsapp-webhook` (~2,100 lines).

Try MCP deploy first:
```
Use mcp__f5337598__deploy_edge_function with:
  project_id: "wzwwtghtnkapdwlgnrxr"
  name: "otp-sender"
  entrypoint_path: "index.ts"
  verify_jwt: false  (Supabase Auth calls with webhook signature, not JWT)
  files: [{ name: "index.ts", content: <full content of otp-sender/index.ts> }]
```

If MCP fails (file too large), deploy via Dashboard:
- Open `supabase/functions/otp-sender/index.ts` in editor
- Ctrl+A, Ctrl+C
- Supabase Dashboard → Edge Functions → Create → name: "otp-sender"
- Paste → Deploy
- Settings → Verify JWT = **OFF**

**Step 2: Verify deployment**

Run: `curl -s https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/otp-sender -X GET`
Expected: `{"error":"Method not allowed"}` (405 — confirms function is reachable)

---

### Task 5: Test OTP flow end-to-end

**Step 1: Test with a known WhatsApp number**

Open the Sheli web app (localhost:5173 or sheli.ai):
1. Click "Sign in" → Phone tab
2. Enter a phone number that has WhatsApp (e.g., your own)
3. Click "Send code"
4. Check WhatsApp DM from Sheli — should receive:
   ```
   🔐 קוד האימות לאפליקציית שלי: *XXXXXX*
   הקוד תקף ל-10 דקות.
   ```
5. Enter the 6-digit code → Verify → should authenticate

**Step 2: Check Edge Function logs**

Supabase Dashboard → Edge Functions → `otp-sender` → Logs
Expected: `[OTP] WhatsApp OTP sent to 972XXXXXXXXX`

**Step 3: Check delivery log in database**

```sql
SELECT * FROM whatsapp_messages
WHERE classification = 'otp_sent'
ORDER BY created_at DESC
LIMIT 5;
```

Expected: Row with `classification_data` showing `{ channel: "whatsapp", success: true }`

**Step 4: Test SMS fallback (optional)**

To test Vonage SMS fallback, temporarily make the WhatsApp check fail:
- Use a landline number or a number not on WhatsApp
- Or temporarily comment out the WhatsApp send in the Edge Function

Verify SMS arrives with: `Sheli: XXXXXX - קוד אימות לאפליקציית שלי`

**Step 5: Commit test results**

If any code adjustments were needed during testing, commit them.

---

### Task 6: Add post-auth bridge message for new users

**Files:**
- Modify: `src/App.jsx` (boot flow, after household detection fails)

**Step 1: Add bridge trigger after no-household detection**

In `src/App.jsx`, find the boot flow where `detectHousehold` returns null (around line 139-155). After the user is authenticated but has no household, trigger a WhatsApp bridge message.

Add a helper function near the top of App.jsx:

```javascript
async function sendOtpBridge(phone) {
  if (!phone) return;
  try {
    const res = await fetch("https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/otp-sender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bridge",
        phone,
      }),
    });
    if (res.ok) console.log("[Boot] OTP bridge sent");
  } catch (err) {
    console.warn("[Boot] OTP bridge failed (non-fatal):", err);
  }
}
```

Then in the boot flow, after `detectHousehold` returns null and the user authenticated via phone:

```javascript
// After detectHousehold returns null and user has phone
if (!detected && session.user.phone) {
  sendOtpBridge(session.user.phone); // Fire-and-forget, non-blocking
}
```

**Step 2: Add bridge handler to `otp-sender` Edge Function**

Add a secondary code path in the Edge Function for the bridge action (before the webhook verification):

```typescript
// ─── Bridge Message (post-auth, no webhook signature) ───
// Called from web app after successful phone auth for users without a household

if (req.method === "POST") {
  const contentType = req.headers.get("content-type") || "";
  // Detect bridge request (has action field, no webhook headers)
  if (!req.headers.get("webhook-id")) {
    try {
      const body = await req.clone().json();
      if (body.action === "bridge" && body.phone) {
        const phone = normalizePhone(body.phone);
        const hasWhatsApp = await checkWhatsApp(phone);
        if (hasWhatsApp) {
          const bridgeMsg = "✅ התחברת בהצלחה לשלי!\nרוצה שאעזור לכל המשפחה? הוסיפו אותי לקבוצת הוואטסאפ שלכם 👇\nhttps://wa.me/972555175553";
          await sendWhatsAppRaw(phone, bridgeMsg);
          console.log("[OTP] Bridge message sent to", phone);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    } catch { /* not a bridge request, fall through to hook handler */ }
  }
}
```

Add `sendWhatsAppRaw` helper (like `sendWhatsApp` but with custom text):

```typescript
async function sendWhatsAppRaw(phone: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${WHAPI_URL}/messages/text`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHAPI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: `${phone}@s.whatsapp.net`, body: text }),
    });
    return res.ok;
  } catch (err) {
    console.error("[OTP] WhatsApp raw send error:", err);
    return false;
  }
}
```

**Step 3: Commit**

```bash
git add src/App.jsx supabase/functions/otp-sender/index.ts
git commit -m "feat: add post-auth WhatsApp bridge message for new users"
```

---

### Task 7: Update CLAUDE.md and deploy

**Files:**
- Modify: `CLAUDE.md` (ours-app)

**Step 1: Add OTP sender to architecture section**

Add to the Architecture file tree:
```
supabase/functions/otp-sender/index.ts    # Phone OTP delivery (WhatsApp + Vonage SMS fallback)
```

Add to Key Files section:
```
- `supabase/functions/otp-sender/index.ts` — Phone OTP delivery via Supabase Send SMS Hook (WhatsApp primary, Vonage SMS fallback)
```

Add to Environment section:
```
# OTP Sender (Edge Function secrets)
VONAGE_API_KEY=<from Vonage dashboard>
VONAGE_API_SECRET=<from Vonage dashboard>
VONAGE_SENDER=Sheli
OTP_HOOK_SECRET=<auto-generated by Supabase Send SMS Hook>
# WHAPI_TOKEN and WHAPI_API_URL — shared with whatsapp-webhook
```

Update Auth line:
```
- **Auth:** Supabase Auth (Google OAuth + email/password + phone OTP via WhatsApp/Vonage)
```

**Step 2: Deploy web app**

Push to main for Vercel auto-deploy (the only frontend change is the bridge trigger in App.jsx).

**Step 3: Re-deploy otp-sender Edge Function**

If any changes were made during testing in Task 5 or Task 6, re-deploy.

**Step 4: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with OTP sender architecture"
```

---

## Summary

| Task | Type | Time Estimate |
|------|------|--------------|
| 1. Create otp-sender Edge Function | Code | ~10 min |
| 2. Vonage signup + secrets | Manual | ~15 min |
| 3. Enable Phone Auth + Hook | Manual (dashboard) | ~5 min |
| 4. Deploy Edge Function | Deploy | ~5 min |
| 5. Test end-to-end | Testing | ~15 min |
| 6. Post-auth bridge message | Code | ~10 min |
| 7. Update docs + deploy | Docs/deploy | ~5 min |

**Total: ~65 minutes**

**Dependencies:**
- Task 1 → Task 4 (must create before deploy)
- Task 2 → Task 5 (need Vonage creds for fallback testing)
- Task 3 → Task 5 (hook must be configured before testing)
- Task 4 → Task 5 (must deploy before testing)
- Task 5 → Task 6 (ensure OTP works before adding bridge)
