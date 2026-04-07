# Family Brings Family — Referral System Design

**Date:** 2026-04-07
**Status:** Approved
**Goal:** Viral referral loop — families invite other families, both get 1 free month of Premium. Entire flow lives in WhatsApp.

## The Viral Loop

```
Use Sheli → Love it (10 actions) → Sheli shares referral link in group →
Family member forwards to friend → Friend adds Sheli → Friend's family
hits 10 actions → BOTH families get 1 free month → Month ending →
Sheli reminds + promotes another referral → Loop
```

## 1. Referral Flow

```
REFERRING FAMILY                              REFERRED FAMILY
     │                                              │
     ├─ Sheli announces referral in group           │
     │  (after 10th action, one-time)               │
     │  "...sheli.ai/r/ABC123"                      │
     │                                              │
     │  OR: Menu → "משפחה מביאה משפחה"              │
     │  → Share referral link                       │
     │                                              │
     ├─ Family member forwards/shares link ─────────┤
     │                                              │
     │                                    User taps sheli.ai/r/ABC123
     │                                    → Vercel redirect → wa.me/...?text=שלום+ABC123
     │                                              │
     │                                    1:1 chat: Sheli detects code
     │                                    → Stores in onboarding_conversations.referral_code
     │                                              │
     │                                    User adds Sheli to family group
     │                                    → handleBotAddedToGroup fires
     │                                    → referrals row created (pending)
     │                                              │
     │                                    Referred family uses Sheli...
     │                                    → Action #10 triggers reward
     │                                              │
     ├─ BOTH get 1 free month Premium ◄─────────────┤
     │  Sheli announces in BOTH groups              │
```

**Key principle:** Entire flow stays in WhatsApp. No app login required. Referral link → WhatsApp → 1:1 onboarding → group add.

## 2. Referral Code & Link

- **Code format:** 6 alphanumeric chars, generated on household creation (e.g., `A3K9M2`)
- **Stored in:** `households_v2.referral_code` (new column, unique index)
- **Link format:** `sheli.ai/r/ABC123` → Vercel edge redirect → `wa.me/972555175553?text=שלום+ABC123`
- **Code detection:** 1:1 handler extracts code from first message text, stores in `onboarding_conversations.referral_code`

## 3. WhatsApp Proactive Announcement

**Trigger:** After the family's 10th action (same counter as free tier). One-time — tracked via `whatsapp_config.referral_announced`.

**Message:**
```
🎁 משפחה מביאה משפחה!
אהבתם את שלי? שתפו עם משפחה נוספת —
שתי המשפחות מקבלות חודש פרימיום במתנה!

שלחו את הקישור: sheli.ai/r/ABC123
```

**Why at action #10:** They've used Sheli enough to be fans, but haven't hit the 30-action paywall yet. "Love it" phase, not "frustrated" phase.

## 4. Menu Integration

New section in MenuPanel after existing "Invite" section:

```
🎁 משפחה מביאה משפחה
הזמינו משפחה נוספת לשלי — שתי המשפחות מקבלות חודש פרימיום חינם!

[שתפו בווטסאפ]   [העתיקו קישור]

הזמנתם: 2 משפחות · 1 הופעלו
```

- Share buttons reuse existing invite pattern (WhatsApp share + copy link)
- Mini-counter shows referred count + activated count
- Referral link displayed: `sheli.ai/r/ABC123`

## 5. Reward Logic

**Trigger:** When referred household reaches 10 actions. Checked inside `incrementUsage()`.

**Reward mechanics:**
- Set `subscriptions.free_until = now() + 30 days` on BOTH households
- If already on paid plan: extend `free_until` by 30 days (don't override paid status)
- If on free tier: set free_until, enabling Premium features for 30 days

**Announcements on reward activation:**

Referring family's group:
```
🎉 משפחת כהן הצטרפו בזכותכם! חודש פרימיום במתנה לשתי המשפחות!
```

Referred family's group:
```
🎉 חודש פרימיום במתנה! המשיכו להשתמש בשלי ללא הגבלה.
```

**Stacking:** Multiple referrals stack — refer 3 families, get 3 free months. No cap initially.

## 6. Free Month Expiry Flow

**3 days before expiry** — Sheli sends reminder in the group:

```
💎 שימו לב — חודש הפרימיום החינמי שלכם מסתיים בעוד 3 ימים.
רוצים להמשיך ללא הגבלה? 9.90 ₪ לחודש בלבד.
🔗 [payment link]

או הזמינו עוד משפחה וקבלו חודש נוסף במתנה! 🎁
sheli.ai/r/ABC123
```

**On expiry day:** Revert to free tier (30 actions/month). No hard cutoff message — they hit the regular action counter, and at action #25 the existing soft warning kicks in.

**Implementation:** pg_cron job daily at 10:00 IST. Query: `subscriptions WHERE free_until BETWEEN now() AND now() + interval '3 days'`. Send reminder once (tracked via classification log or timestamp check).

**Viral loop in the expiry message:** The reminder promotes another referral — "invite another family for another free month." Free month ending → share → another free month → expires → share again.

## 7. Database Changes

```sql
-- 1. Referral code on households
ALTER TABLE households_v2 ADD COLUMN referral_code TEXT UNIQUE;
CREATE INDEX idx_households_referral_code ON households_v2(referral_code);

-- 2. Free month tracking on subscriptions
ALTER TABLE subscriptions ADD COLUMN free_until TIMESTAMPTZ;

-- 3. Referral announcement tracking
ALTER TABLE whatsapp_config ADD COLUMN referral_announced BOOLEAN DEFAULT false;

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
CREATE INDEX idx_referrals_referring ON referrals(referring_household_id);
CREATE INDEX idx_referrals_referred ON referrals(referred_household_id);
CREATE INDEX idx_referrals_code ON referrals(referral_code);
```

## 8. Free Tier Check Update

Current `checkUsageLimit` only checks `subscriptions.status === "active"`. Update:

```
isPaid = subscription.status === "active" OR subscription.free_until > now()
```

Referral reward recipients bypass the 30-action limit without needing a real payment.

## 9. Touchpoints Summary

| When | What | Where |
|------|------|-------|
| Household created | Generate 6-char referral code | `handleBotAddedToGroup` |
| 10th action | Sheli announces referral link in group | WhatsApp group |
| Anytime | Menu shows referral section with share buttons | Web app menu |
| Referred family hits 10 actions | Grant 1 free month to BOTH families | `incrementUsage` check |
| 3 days before free month ends | Reminder + payment link + referral link | WhatsApp group (cron) |
| Free month expires | Silent revert to free tier | `checkUsageLimit` |
| Action #25 (free tier) | Existing soft warning | WhatsApp group |
| Action #30 (free tier) | Existing upgrade prompt | WhatsApp group |

## 10. Anti-Gaming

- **Reward only after 10 real actions** — can't just add and remove
- **One referral per referred household** — even if multiple people from referring family share the link
- **Code is tied to household, not user** — prevents multi-account gaming
- **No self-referral** — check that referring ≠ referred household
- **Future consideration:** Cap at 12 free months/year if abuse detected (not implemented initially)
