# Landing Page Update — Group + Expenses + FAQ Refresh

**Date:** 2026-04-16
**Status:** Approved
**Approach:** B (Unified Story) with refinements

## Problem

After the "One Sheli, One Price" rewrite (2026-04-12), the landing page is 100% personal-assistant framing. Group/family organizing — Sheli's original moat (shared shopping list from different phones) — is invisible except buried in one FAQ answer. The new expenses feature isn't shown at all.

## Goals

1. Restore group/family organizer messaging alongside the personal assistant angle
2. Showcase expenses as a new value prop
3. Refresh FAQ copy for accuracy and tone

## Changes

### 1. Hero Mock — Avatar Change

Replace the generic `"ש"` text avatar with Sheli's actual PNG icon.

```
Before: <div class="wa-mock-avatar wa-mock-avatar-sheli">{c.mockAvatar}</div>
After:  <img src="/icons/icon-192.png" class="wa-mock-avatar wa-mock-avatar-sheli" />
```

Mock messages stay exactly as they are (shopping, reminder, voice, calendar).

### 2. Remove QR Code

Delete the entire QR block (`landing-qr` link + image + label). Reclaims vertical space.

### 3. Bridge One-Liner (NEW)

Positioned below the free badge, above the sign-in link.

- **HE:** `רק לעצמך או לכל המשפחה ביחד: שלי עושה לכם סדר בחיים`
- **EN:** `Just for you or the whole family: Sheli puts your life in order`

Styling: `14px`, `var(--warm)`, centered, `max-width: 340px`, `line-height: 1.5`. Gentle — not a section title.

### 4. Features — Add 6th Card (Expenses)

New card appended after the "learning" card.

**HE:**
- Icon: `ExpenseFeatureIcon` (new SVG — coin/receipt, stroke-based, currentColor)
- Title: `מעקב הוצאות`
- Subtitle: `"שילמתי 85 על פיצה" — ושלי רושמת. עוקבת אחרי הוצאות ומעדכנת אתכם כשתרצו`

**EN:**
- Title: `Expense tracking`
- Subtitle: `"I paid 85 for pizza" — and Sheli logs it. Tracks expenses and updates you when you want`

### 5. "שלי לכל המשפחה" — New Section

Placed between Features and How It Works.

**Title:**
- HE: `שלי לכל המשפחה`
- EN: `Sheli for the whole family`

**3 items (icon + title + subtitle, vertical list):**

| # | Icon | HE Title | HE Subtitle | EN Title | EN Subtitle |
|---|------|----------|-------------|----------|-------------|
| 1 | Cart | רשימת קניות משותפת | אבא מוסיף חלב מהעבודה, אמא מוסיפה ביצים מהדרך. הכל ברשימה אחת | Shared shopping list | Dad adds milk from work, mom adds eggs on the go. One list for everyone |
| 2 | Broom | מטלות בית וילדים | מי מוריד זבל? מי אוסף מהחוג? שלי מחלקת ועוקבת | House chores & kids | Who takes out the trash? Who picks up from practice? Sheli assigns and tracks |
| 3 | Group | הוסיפו שלי לקבוצה | הוסיפו את שלי לקבוצת ווטסאפ של המשפחה — וכולם מסודרים | Add Sheli to the group | Add Sheli to your family WhatsApp group — everyone stays organized |

Layout: Same visual rhythm as "How it works" steps but with small thematic icons instead of step numbers. Background: `var(--white)` to differentiate from the features section above.

### 6. FAQ Copy Updates

**Q1 — "איך שלי עובדת?"** (unchanged question, new answer)

HE:
> שלי היא פיתוח ישראלי המבוסס על בינה מלאכותית - בעצם היא עוזרת חכמה בווטסאפ שמבינה עברית רגילה. כתבו "חלב" והיא תוסיף לרשימה, "תזכירי לי..." והיא תזכיר בזמן. שלי עובדת בצ'אט אישי ובקבוצות, לבד או עם כל מי שגר בבית. היא לומדת את הסגנון שלכם עם הזמן: כינויים, מוצרים קבועים, הרגלים.

EN (no Israeli context):
> Sheli is an AI-powered smart assistant on WhatsApp that understands natural language. Say "milk" and it's on the list, say "remind me..." and she'll remind you on time. Sheli works in private chat and in groups, alone or with everyone in your home. She learns your style over time: nicknames, regular products, routines.

**Q2 — Question renamed + answer updated**

HE question: `אפליקציה לצפייה נוחה בכל הרשימות שלכם` (was: "יש גם אפליקציה?")
HE answer:
> רשימת הקניות, המטלות, התזכורות, התקציב ולוח האירועים מתעדכנים בזמן אמת, גם מהווטסאפ וגם מהאפליקציה - אין יותר נוח מזה!

EN question: `An app for easy viewing of all your lists` (was: "Is there also an app?")
EN answer:
> Your shopping list, tasks, reminders, budget and calendar sync in real time, from both WhatsApp and the app — it doesn't get easier than this!

**Q4 — "מה עם הפרטיות?" — answer updated**

HE:
> שלי שומרת למשך 30 יום את הודעות הטקסט ואת ההודעות הקוליות הקצרות שתשלחו אליה. היא לא שומרת תמונות או וידאו. לאחר 30 יום, כל המידע נמחק אלא אם תבקשו אחרת משלי. המידע שלכם שמור ומאובטח ורק אתם רואים אותו. אף אחד אחר לא - כולל אותנו.

EN:
> Sheli stores text messages and short voice messages you send her for 30 days. She doesn't store photos or videos. After 30 days, all data is deleted unless you ask Sheli otherwise. Your data is secure and only you can see it. Nobody else — including us.

**Q3, Q5, Q6** — unchanged.

### 7. Unchanged Sections

- How it works (3 steps)
- Bottom CTA
- Language toggle

## Page Flow (Final)

```
Wordmark + tagline
WhatsApp mock (Sheli PNG avatar, same messages)
CTA button
Free badge
Bridge one-liner                    ← NEW
Sign-in link
─────────────────────────────────────
Features (6 cards incl. expenses)   ← EXPANDED
─────────────────────────────────────
"שלי לכל המשפחה" (3 items)          ← NEW
─────────────────────────────────────
How it works (3 steps)
FAQ (6 questions, 3 answers updated) ← UPDATED
Bottom CTA
```

## New Assets Required

- `ExpenseFeatureIcon` in `Icons.jsx` — coin/receipt SVG, stroke-based, currentColor
- 3 small icons for family section: cart (reuse `ShoppingFeatureIcon`), broom (reuse `ChoresFeatureIcon`), group (new `FamilyGroupIcon`)
