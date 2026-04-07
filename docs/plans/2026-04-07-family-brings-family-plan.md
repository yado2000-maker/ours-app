# Family Brings Family — Referral System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a viral referral loop where families invite other families via WhatsApp, and both get 1 free month of Premium when the referred family hits 10 actions.

**Architecture:** Referral codes stored on `households_v2`, links redirect via Vercel edge (`/api/r/[code]`) to WhatsApp. The bot detects codes in 1:1 messages, tracks referrals in a new `referrals` table, and rewards both families by setting `free_until` on `subscriptions`. The web app MenuPanel gets a new referral section with share buttons.

**Tech Stack:** Supabase (Postgres migrations), Vercel serverless (redirect), Deno Edge Function (WhatsApp bot), React (MenuPanel)

**Design doc:** `docs/plans/2026-04-07-family-brings-family-design.md`

---

## Phase 1: Database Foundation

### Task 1: Run DB Migrations

**Files:**
- Create: Supabase migration (via MCP `apply_migration` tool)

**Step 1: Apply migration — referral_code column + referrals table + free_until + referral_announced**

Run via Supabase MCP `apply_migration`:

```sql
-- 1. Referral code on households
ALTER TABLE households_v2 ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_households_referral_code ON households_v2(referral_code);

-- 2. Free month tracking on subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS free_until TIMESTAMPTZ;

-- 3. Referral announcement tracking
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS referral_announced BOOLEAN DEFAULT false;

-- 4. Referrals tracking table
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referring_household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  referred_household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | completed
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referring ON referrals(referring_household_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_household_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);

-- 5. RLS policies for referrals (relaxed for dev, same pattern as other tables)
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "referrals_select" ON referrals FOR SELECT USING (true);
CREATE POLICY "referrals_insert" ON referrals FOR INSERT WITH CHECK (true);
CREATE POLICY "referrals_update" ON referrals FOR UPDATE USING (true);

-- 6. Add referral_code to onboarding_conversations (stores code from 1:1 first message)
ALTER TABLE onboarding_conversations ADD COLUMN IF NOT EXISTS referral_code TEXT;
```

**Step 2: Backfill referral codes for existing households**

```sql
-- Generate 6-char alphanumeric codes for all households without one
UPDATE households_v2
SET referral_code = upper(substr(md5(random()::text), 1, 6))
WHERE referral_code IS NULL;
```

**Step 3: Verify migration**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'households_v2' AND column_name = 'referral_code';

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'referrals';

SELECT count(*) FROM households_v2 WHERE referral_code IS NOT NULL;
```

**Step 4: Commit**
```bash
git add docs/plans/2026-04-07-family-brings-family-plan.md
git commit -m "docs: add Family brings Family referral implementation plan"
```

---

## Phase 2: Vercel Redirect

### Task 2: Create Referral Link Redirect

**Files:**
- Create: `api/r/[code].js`

**Step 1: Create the serverless redirect function**

The redirect function receives `sheli.ai/r/ABC123` and redirects to `wa.me/972555175553?text=שלום+ABC123`.

```javascript
// api/r/[code].js
export default function handler(req, res) {
  const { code } = req.query;
  if (!code || !/^[A-Za-z0-9]{4,8}$/.test(code)) {
    return res.redirect(302, "https://sheli.ai");
  }
  const waUrl = `https://wa.me/972555175553?text=${encodeURIComponent("שלום " + code)}`;
  return res.redirect(302, waUrl);
}
```

**Step 2: Update vercel.json to enable the API route**

No changes needed — Vercel auto-detects `api/` directory. The existing `vercel.json` only has `{"regions": ["fra1"]}`.

**Step 3: Test locally**

Open `http://localhost:5173/api/r/ABC123` — should redirect to `wa.me/972555175553?text=שלום+ABC123`.
Note: Vite dev server won't serve Vercel serverless functions. Test after deploy or with `vercel dev`.

**Step 4: Commit**
```bash
git add api/r/[code].js
git commit -m "feat: add referral link redirect /r/[code] → WhatsApp"
```

---

## Phase 3: WhatsApp Bot — Referral Logic

All changes in this phase go into `supabase/functions/whatsapp-webhook/index.inlined.ts`.

### Task 3: Add Referral Code Generation

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (near line 1524)

**Step 1: Add `generateReferralCode()` helper**

Insert after `generateHouseholdId()` (line 1526):

```typescript
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
```

**Step 2: Generate referral code in `handleBotAddedToGroup`**

After household creation (line 1591, inside the `if (!householdId)` block), add referral code:

```typescript
// After: console.log(`[GroupMgmt] Created new household ${householdId} (${groupName})`);
// Generate referral code for new household
const refCode = generateReferralCode();
await supabase.from("households_v2").update({ referral_code: refCode }).eq("id", householdId);
console.log(`[GroupMgmt] Referral code ${refCode} assigned to ${householdId}`);
```

Also generate for auto-linked households that don't have one yet:

```typescript
// After: householdId = existingMapping.household_id; (line 1572)
// Ensure linked household has a referral code
const { data: hhData } = await supabase.from("households_v2").select("referral_code").eq("id", householdId).single();
if (hhData && !hhData.referral_code) {
  const refCode = generateReferralCode();
  await supabase.from("households_v2").update({ referral_code: refCode }).eq("id", householdId);
}
```

**Step 3: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: generate referral codes on household creation"
```

---

### Task 4: Detect Referral Code in 1:1 Messages

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `handleDirectMessage` (line 1386)

**Step 1: Add referral code extraction**

At the top of `handleDirectMessage`, after the non-text skip (line 1393), before the household check:

```typescript
  // 0. Check if first message contains a referral code (from sheli.ai/r/ABC123 redirect)
  const referralMatch = message.text.match(/\b([A-Z0-9]{6})\b/);
  const possibleReferralCode = referralMatch ? referralMatch[1] : null;
```

**Step 2: Store referral code when creating onboarding conversation**

Modify the insert at line 1424:

```typescript
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
```

**Step 3: Create referral row when bot joins referred family's group**

In `handleBotAddedToGroup`, after creating the household and whatsapp_config (around line 1613), add:

```typescript
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
        // Create referral row (pending — completes when referred family hits 10 actions)
        const refId = "ref_" + Math.random().toString(36).slice(2, 10);
        await supabase.from("referrals").insert({
          id: refId,
          referring_household_id: referrer.id,
          referred_household_id: householdId,
          referral_code: onboardingRef.referral_code,
          status: "pending",
        });
        console.log(`[GroupMgmt] Referral created: ${referrer.id} → ${householdId} (code: ${onboardingRef.referral_code})`);
      }
    }
  }
```

**Step 4: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: detect referral codes in 1:1 and create referral rows on group join"
```

---

### Task 5: Update `checkUsageLimit` to Honor `free_until`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `checkUsageLimit` (line 2418)

**Step 1: Add free_until check**

Replace the subscription check block (lines 2422-2430):

```typescript
  // Check if household has an active subscription OR active referral reward
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
```

This is backward-compatible — if `free_until` is NULL or in the past, falls through to the existing free tier counting.

**Step 2: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: checkUsageLimit honors free_until from referral rewards"
```

---

### Task 6: Add Proactive Referral Announcement at 10th Action

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — new function + call site

**Step 1: Add `maybeSendReferralAnnouncement()` function**

Insert after `maybeSendDashboardLink` (after line 2516):

```typescript
async function maybeSendReferralAnnouncement(groupId: string, householdId: string, usageCount: number) {
  // Only trigger at exactly 10 actions
  if (usageCount !== 10) return;

  try {
    // Check if already announced
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("referral_announced")
      .eq("group_id", groupId)
      .single();

    if (!cfg || cfg.referral_announced) return;

    // Get referral code
    const { data: hh } = await supabase
      .from("households_v2")
      .select("referral_code")
      .eq("id", householdId)
      .single();

    if (!hh?.referral_code) return;

    // Skip during quiet hours
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
```

**Step 2: Call it from the main webhook handler**

After the `maybeSendSoftWarning` call (line 2076), add:

```typescript
    // 7c. Referral announcement at 10 actions (one-time, skip quiet hours)
    if (!usage.isPaid) {
      await maybeSendReferralAnnouncement(message.groupId, householdId, usage.count);
    }
```

**Step 3: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: proactive referral announcement at 10th action"
```

---

### Task 7: Add Reward Logic When Referred Family Hits 10 Actions

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — new function + call site

**Step 1: Add `maybeCompleteReferral()` function**

Insert after `maybeSendReferralAnnouncement`:

```typescript
async function maybeCompleteReferral(householdId: string, usageCount: number) {
  // Only trigger at exactly 10 actions
  if (usageCount !== 10) return;

  try {
    // Check if this household was referred (pending referral exists)
    const { data: referral } = await supabase
      .from("referrals")
      .select("id, referring_household_id, referred_household_id")
      .eq("referred_household_id", householdId)
      .eq("status", "pending")
      .single();

    if (!referral) return;

    console.log(`[Referral] Completing referral ${referral.id}: ${referral.referring_household_id} → ${householdId}`);

    // Mark referral as completed
    await supabase
      .from("referrals")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", referral.id);

    // Grant 1 free month to BOTH households
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    for (const hhId of [referral.referring_household_id, referral.referred_household_id]) {
      // Upsert subscription with free_until (extend if already has one)
      const { data: existingSub } = await supabase
        .from("subscriptions")
        .select("id, free_until")
        .eq("household_id", hhId)
        .single();

      if (existingSub) {
        // Extend: if existing free_until is in the future, add 30 days from THAT date
        const currentFreeUntil = existingSub.free_until ? new Date(existingSub.free_until) : new Date();
        const baseDate = currentFreeUntil > new Date() ? currentFreeUntil : new Date();
        const newFreeUntil = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

        await supabase
          .from("subscriptions")
          .update({ free_until: newFreeUntil })
          .eq("id", existingSub.id);
      } else {
        // Create subscription row
        await supabase.from("subscriptions").insert({
          household_id: hhId,
          status: "active",
          plan: "free",
          free_until: thirtyDaysFromNow,
        });
      }
    }

    // Send celebration messages to both groups
    // Referred family's group
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

    // Referring family's group
    const { data: referringConfig } = await supabase
      .from("whatsapp_config")
      .select("group_id")
      .eq("household_id", referral.referring_household_id)
      .eq("bot_active", true)
      .single();

    if (referringConfig) {
      // Get referred family name for personalized message
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

    console.log(`[Referral] Reward granted: both ${referral.referring_household_id} and ${householdId} get 30 days free`);
  } catch (err) {
    console.error("[maybeCompleteReferral] Error:", err);
  }
}
```

**Step 2: Call it from the main webhook handler**

After the referral announcement call (added in Task 6), add:

```typescript
    // 7d. Complete referral reward if this household was referred and just hit 10 actions
    if (!usage.isPaid) {
      await maybeCompleteReferral(householdId, usage.count);
    }
```

**Step 3: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: reward both families when referred household hits 10 actions"
```

---

## Phase 4: Web App

### Task 8: Update `loadHousehold` to Return Referral Code

**Files:**
- Modify: `src/lib/supabase.js` (line 46-49)

**Step 1: Add referralCode to household return**

In the `loadHousehold` return object (line 46), add `referralCode`:

```javascript
  return {
    hh: {
      id: hhRes.data.id,
      name: hhRes.data.name,
      lang: hhRes.data.lang || "he",
      referralCode: hhRes.data.referral_code || null,
      members: (membersRes.data || []).map(m => ({ id: m.id, name: m.display_name, userId: m.user_id })),
    },
    // ... rest unchanged
  };
```

**Step 2: Add `loadReferralStats` function**

After `loadHousehold`, add:

```javascript
export const loadReferralStats = async (hhId) => {
  const { data, error } = await supabase
    .from("referrals")
    .select("id, status")
    .eq("referring_household_id", hhId);
  if (error) { console.error("[loadReferralStats]", error); return { sent: 0, completed: 0 }; }
  const rows = data || [];
  return { sent: rows.length, completed: rows.filter(r => r.status === "completed").length };
};
```

**Step 3: Commit**
```bash
git add src/lib/supabase.js
git commit -m "feat: loadHousehold returns referralCode + add loadReferralStats"
```

---

### Task 9: Add Referral Section to MenuPanel + Locale Strings

**Files:**
- Modify: `src/components/modals/MenuPanel.jsx` (after line 595)
- Modify: `src/locales/he.js`
- Modify: `src/locales/en.js`

**Step 1: Add locale strings**

In `src/locales/he.js`, before the closing `};`:

```javascript
  // Referral
  menuReferral: "משפחה מביאה משפחה",
  menuReferralDesc: "הזמינו משפחה נוספת לשלי — שתי המשפחות מקבלות חודש פרימיום חינם!",
  menuReferralShare: "שתפו בווטסאפ",
  menuReferralCopy: "העתיקו קישור",
  menuReferralCopied: "הועתק!",
  menuReferralStats: (sent, completed) => `הזמנתם: ${sent} משפחות · ${completed} הופעלו`,
```

In `src/locales/en.js`, before the closing `};`:

```javascript
  // Referral
  menuReferral: "Family brings Family",
  menuReferralDesc: "Invite another family to Sheli — both families get 1 free month of Premium!",
  menuReferralShare: "Share on WhatsApp",
  menuReferralCopy: "Copy link",
  menuReferralCopied: "Copied!",
  menuReferralStats: (sent, completed) => `Invited: ${sent} families · ${completed} activated`,
```

**Step 2: Add state + effect to MenuPanel**

At the top of the MenuPanel component, add:

```javascript
import { loadReferralStats } from "../../lib/supabase.js";

// Inside the component, after existing state declarations:
const [referralCopied, setReferralCopied] = useState(false);
const [referralStats, setReferralStats] = useState({ sent: 0, completed: 0 });

const referralCode = household?.referralCode;
const referralLink = referralCode ? `https://sheli.ai/r/${referralCode}` : "";

useEffect(() => {
  if (household?.id) {
    loadReferralStats(household.id).then(setReferralStats);
  }
}, [household?.id]);
```

**Step 3: Add referral section JSX**

Insert after the invite section divider (line 595, after the `<div style={{ height: 1, ... }} />`) and BEFORE the WhatsApp Bot section (line 601):

```jsx
        {/* 4b. Family brings Family */}
        {referralCode && (
          <>
            <div className="section-head" style={{ marginBottom: 8 }}>
              {t.menuReferral}
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
              {t.menuReferralDesc}
            </div>
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: "var(--cream)",
                border: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--warm)",
                wordBreak: "break-all",
                direction: "ltr",
                marginBottom: 8,
                userSelect: "all",
              }}
            >
              {referralLink}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(referralLink);
                    setReferralCopied(true);
                    analytics.track("referral_link_copied");
                    setTimeout(() => setReferralCopied(false), 2000);
                  } catch {}
                }}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 10,
                  background: referralCopied ? "var(--green)" : "var(--coral)",
                  color: "#fff",
                  border: "none",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "background 0.2s",
                }}
              >
                {referralCopied ? t.menuReferralCopied : t.menuReferralCopy}
              </button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(
                  isHe
                    ? "היי! תנסו את שלי — עוזרת חכמה למשפחה בווטסאפ 🏠\n" + referralLink
                    : "Hey! Try Sheli — a smart family helper on WhatsApp 🏠\n" + referralLink
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => analytics.track("referral_link_shared_wa")}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 10,
                  background: "#25D366",
                  color: "#fff",
                  border: "none",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textDecoration: "none",
                  textAlign: "center",
                  display: "block",
                }}
              >
                {t.menuReferralShare}
              </a>
            </div>
            {(referralStats.sent > 0) && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
                {typeof t.menuReferralStats === "function"
                  ? t.menuReferralStats(referralStats.sent, referralStats.completed)
                  : ""}
              </div>
            )}
            <div style={{ height: 1, background: "var(--border)", margin: "0 0 16px" }} />
          </>
        )}
```

**Step 4: Commit**
```bash
git add src/components/modals/MenuPanel.jsx src/locales/he.js src/locales/en.js
git commit -m "feat: add Family brings Family referral section to MenuPanel"
```

---

### Task 10: Add Referral Q&A to Onboarding

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — ONBOARDING_QA array (line 1333)

**Step 1: Add referral Q&A pair**

Add to the ONBOARDING_QA array:

```typescript
  {
    patterns: [/הפנ|referral|הזמנ.*משפחה|משפחה מביאה|invite.*family|חודש.*חינם.*הזמנ/i],
    answer: "🎁 משפחה מביאה משפחה!\nכל משפחה שמצטרפת דרככם — שתיכם מקבלות חודש פרימיום במתנה.\nהקישור שלכם נמצא בתפריט האפליקציה 😊",
  },
```

**Step 2: Commit**
```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: add referral Q&A to onboarding"
```

---

## Phase 5: Final

### Task 11: Test End-to-End

**Manual testing checklist:**

1. **DB:** Verify all existing households have referral codes: `SELECT count(*) FROM households_v2 WHERE referral_code IS NULL`
2. **Redirect:** Visit `sheli.ai/r/TESTCODE` → verify it redirects to WhatsApp
3. **Menu:** Open web app → Menu → verify referral section shows with correct code and share buttons
4. **Copy link:** Click "Copy link" → verify clipboard contains `https://sheli.ai/r/XXXXXX`
5. **WhatsApp share:** Click WhatsApp share → verify pre-filled message contains referral link
6. **1:1 detection:** Send "שלום ABC123" to bot in 1:1 → verify code is stored in `onboarding_conversations.referral_code`
7. **Referral creation:** After referred user adds bot to group → verify `referrals` row exists with status=pending
8. **10-action announcement:** After 10th action in a group → verify referral announcement sent (one-time)
9. **Reward:** After referred family's 10th action → verify both families get `free_until` set, messages sent

### Task 12: Deploy

1. Copy changed `index.inlined.ts` → Supabase Dashboard → Deploy (Cursor paste method)
2. Push to `main` → Vercel auto-deploys web app + redirect function
3. Verify Supabase Edge Function logs for errors
4. Verify `sheli.ai/r/TESTCODE` redirect works in production
