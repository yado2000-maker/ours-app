# Landing Page Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add group/family messaging, expenses feature card, and FAQ refresh to the landing page.

**Architecture:** Content-level changes to `LandingPage.jsx` (CONTENT object + JSX) + new icons in `Icons.jsx` + new CSS in `landing.css`. No new files, no new components — everything lives in existing files.

**Tech Stack:** React 19, CSS, SVG icons

**Design doc:** `docs/plans/2026-04-16-landing-page-update-design.md`

---

### Task 1: Add ExpenseFeatureIcon and FamilyGroupIcon to Icons.jsx

**Files:**
- Modify: `src/components/Icons.jsx:647-666` (after LearningFeatureIcon)

**Step 1: Add ExpenseFeatureIcon (coin with ILS symbol)**

Add after `LearningFeatureIcon` (line ~666), before the UTILITY section:

```jsx
/** Coin with shekel — expense tracking feature highlight */
export function ExpenseFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Coin circle */}
      <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="1.5" />
      {/* Shekel symbol ₪ simplified as two vertical lines with connecting strokes */}
      <path
        d="M10 9V17.5C10 18.88 11.12 20 12.5 20M18 19V10.5C18 9.12 16.88 8 15.5 8"
        stroke={accent}
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

**Step 2: Add FamilyGroupIcon (three people)**

Add right after `ExpenseFeatureIcon`:

```jsx
/** Three people — family group feature highlight */
export function FamilyGroupIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Center person */}
      <circle cx="14" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 22C9 18.69 11.24 16 14 16C16.76 16 19 18.69 19 22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Left person (smaller) */}
      <circle cx="6.5" cy="11" r="2.2" stroke={accent} strokeWidth="1.3" opacity="0.7" />
      <path d="M3 22C3 19.5 4.57 17.5 6.5 17.5" stroke={accent} strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
      {/* Right person (smaller) */}
      <circle cx="21.5" cy="11" r="2.2" stroke={accent} strokeWidth="1.3" opacity="0.7" />
      <path d="M25 22C25 19.5 23.43 17.5 21.5 17.5" stroke={accent} strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}
```

**Step 3: Verify no syntax errors**

Run: `cd "C:/Users/yarond/Downloads/claude code/ours-app" && npx vite build --logLevel error 2>&1 | head -5`
Expected: no errors (or clean build output)

**Step 4: Commit**

```bash
git add src/components/Icons.jsx
git commit -m "feat(landing): add ExpenseFeatureIcon and FamilyGroupIcon SVGs"
```

---

### Task 2: Update LandingPage.jsx — Import new icons

**Files:**
- Modify: `src/components/LandingPage.jsx:1-10` (imports)

**Step 1: Update the import line**

Change line 3-9 from:
```jsx
import {
  ShoppingFeatureIcon,
  CalendarFeatureIcon,
  ChoresFeatureIcon,
  ReminderFeatureIcon,
  LearningFeatureIcon,
  ChevronRightIcon,
} from "./Icons.jsx";
```

To:
```jsx
import {
  ShoppingFeatureIcon,
  CalendarFeatureIcon,
  ChoresFeatureIcon,
  ReminderFeatureIcon,
  LearningFeatureIcon,
  ExpenseFeatureIcon,
  FamilyGroupIcon,
  ChevronRightIcon,
} from "./Icons.jsx";
```

**Step 2: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): import new icons for expenses and family section"
```

---

### Task 3: Update CONTENT object — Hero changes (avatar, remove QR, add bridge)

**Files:**
- Modify: `src/components/LandingPage.jsx:19-113` (CONTENT object)

**Step 1: Remove mockAvatar from both languages and add bridge line**

In the `he` object (~line 26), remove:
```
mockAvatar: "ש",
```

In the `he` object, add after `freeBadge`:
```
bridge: "רק לעצמך או לכל המשפחה ביחד: שלי עושה לכם סדר בחיים",
```

Remove these two lines from `he`:
```
qrLabel: "או סרקו את הקוד",
```

In the `en` object (~line 73), remove:
```
mockAvatar: "S",
```

In the `en` object, add after `freeBadge`:
```
bridge: "Just for you or the whole family: Sheli puts your life in order",
```

Remove from `en`:
```
qrLabel: "or scan the code",
```

**Step 2: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): add bridge one-liner, remove QR/avatar content keys"
```

---

### Task 4: Update CONTENT object — Add expenses feature card

**Files:**
- Modify: `src/components/LandingPage.jsx:40-46` (he features array) and `87-93` (en features array)

**Step 1: Add 6th feature to HE array**

After the learning card (line ~45), add:
```jsx
{ Icon: ExpenseFeatureIcon, title: "מעקב הוצאות", subtitle: "\u0022שילמתי 85 על פיצה\u0022 — ושלי רושמת. עוקבת אחרי הוצאות ומעדכנת אתכם כשתרצו" },
```

**Step 2: Add 6th feature to EN array**

After the EN learning card (line ~92), add:
```jsx
{ Icon: ExpenseFeatureIcon, title: "Expense tracking", subtitle: "\u0022I paid 85 for pizza\u0022 — and Sheli logs it. Tracks expenses and updates you when you want" },
```

**Step 3: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): add expenses feature card to both languages"
```

---

### Task 5: Update CONTENT object — Add family section content

**Files:**
- Modify: `src/components/LandingPage.jsx` (CONTENT he and en objects)

**Step 1: Add familyTitle and familyItems to HE object**

Add after the `features` array in `he`:
```jsx
familyTitle: "שלי לכל המשפחה",
familyItems: [
  { Icon: ShoppingFeatureIcon, title: "רשימת קניות משותפת", subtitle: "אבא מוסיף חלב מהעבודה, אמא מוסיפה ביצים מהדרך. הכל ברשימה אחת" },
  { Icon: ChoresFeatureIcon, title: "מטלות בית וילדים", subtitle: "מי מוריד זבל? מי אוסף מהחוג? שלי מחלקת ועוקבת" },
  { Icon: FamilyGroupIcon, title: "הוסיפו שלי לקבוצה", subtitle: "הוסיפו את שלי לקבוצת ווטסאפ של המשפחה — וכולם מסודרים" },
],
```

**Step 2: Add familyTitle and familyItems to EN object**

Add after the `features` array in `en`:
```jsx
familyTitle: "Sheli for the whole family",
familyItems: [
  { Icon: ShoppingFeatureIcon, title: "Shared shopping list", subtitle: "Dad adds milk from work, mom adds eggs on the go. One list for everyone" },
  { Icon: ChoresFeatureIcon, title: "House chores & kids", subtitle: "Who takes out the trash? Who picks up from practice? Sheli assigns and tracks" },
  { Icon: FamilyGroupIcon, title: "Add Sheli to the group", subtitle: "Add Sheli to your family WhatsApp group — everyone stays organized" },
],
```

**Step 3: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): add family section content to both languages"
```

---

### Task 6: Update CONTENT object — FAQ copy refresh

**Files:**
- Modify: `src/components/LandingPage.jsx` (faq arrays in both he and en)

**Step 1: Update HE FAQ**

Replace the `faq` array in `he` with:
```jsx
faq: [
  { q: "איך שלי עובדת?", a: "שלי היא פיתוח ישראלי המבוסס על בינה מלאכותית - בעצם היא עוזרת חכמה בווטסאפ שמבינה עברית רגילה. כתבו \u0022חלב\u0022 והיא תוסיף לרשימה, \u0022תזכירי לי...\u0022 והיא תזכיר בזמן. שלי עובדת בצ\u0027אט אישי ובקבוצות, לבד או עם כל מי שגר בבית. היא לומדת את הסגנון שלכם עם הזמן: כינויים, מוצרים קבועים, הרגלים." },
  { q: "אפליקציה לצפייה נוחה בכל הרשימות שלכם", a: "רשימת הקניות, המטלות, התזכורות, התקציב ולוח האירועים מתעדכנים בזמן אמת, גם מהווטסאפ וגם מהאפליקציה - אין יותר נוח מזה!" },
  { q: "כמה זה עולה?", a: "חינם לגמרי עד 40 פעולות בחודש, כל חודש!\nצריכים יותר? פרימיום ללא הגבלה ב-9.90 \u20AA לחודש בלבד." },
  { q: "מה עם הפרטיות?", a: "שלי שומרת למשך 30 יום את הודעות הטקסט ואת ההודעות הקוליות הקצרות שתשלחו אליה. היא לא שומרת תמונות או וידאו. לאחר 30 יום, כל המידע נמחק אלא אם תבקשו אחרת משלי. המידע שלכם שמור ומאובטח ורק אתם רואים אותו. אף אחד אחר לא - כולל אותנו." },
  { q: "איך מתחילים? ואיך מפסיקים?", a: "שלחו הודעה לשלי בווטסאפ, היא מתחילה לעזור מיד. רוצים שכולם בבית ישתתפו? הוסיפו אותה לקבוצת ווטסאפ. רוצים להפסיק? פשוט תפסיקו לכתוב. כל המידע נמחק אוטומטית, בלי התחייבות." },
  { q: "למי שלי מתאימה?", a: "לכולם! גרים לבד? שלי מנהלת לכם קניות, תזכורות וסידורים. עם שותפים? הוסיפו אותה לקבוצת הדירה והיא תתאם מי קונה, מי מנקה, הכל. משפחה? שלי מנהלת את כל הבית." },
],
```

**Step 2: Update EN FAQ**

Replace the `faq` array in `en` with:
```jsx
faq: [
  { q: "How does Sheli work?", a: "Sheli is an AI-powered smart assistant on WhatsApp that understands natural language. Say \u0022milk\u0022 and it's on the list, say \u0022remind me...\u0022 and she'll remind you on time. Sheli works in private chat and in groups, alone or with everyone in your home. She learns your style over time: nicknames, regular products, routines." },
  { q: "An app for easy viewing of all your lists", a: "Your shopping list, tasks, reminders, budget and calendar sync in real time, from both WhatsApp and the app \u2014 it doesn't get easier than this!" },
  { q: "How much does it cost?", a: "40 actions per month for free, every month!\nNeed more? Unlimited Premium for just $2.70/month." },
  { q: "What about privacy?", a: "Sheli stores text messages and short voice messages you send her for 30 days. She doesn't store photos or videos. After 30 days, all data is deleted unless you ask Sheli otherwise. Your data is secure and only you can see it. Nobody else \u2014 including us." },
  { q: "How do I start? And stop?", a: "Send Sheli a message on WhatsApp, she starts helping right away. Want everyone at home to join? Add her to a WhatsApp group. Want to stop? Just stop writing. All data is deleted automatically, no strings attached." },
  { q: "Who is Sheli for?", a: "Everyone! Living alone? Sheli manages your shopping, reminders and daily tasks. Roommates? Add her to the apartment group and she'll coordinate who buys, who cleans, everything. Family? Sheli manages the whole household." },
],
```

**Step 3: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): refresh FAQ copy — Israeli dev context, app rename, privacy rewrite"
```

---

### Task 7: Update JSX — Avatar, remove QR, add bridge + family section

**Files:**
- Modify: `src/components/LandingPage.jsx:122-287` (JSX return block)

**Step 1: Replace avatar in hero mock header**

Replace (~line 148):
```jsx
<div className="wa-mock-avatar wa-mock-avatar-sheli">{c.mockAvatar}</div>
```

With:
```jsx
<img src="/icons/icon-192.png" alt="Sheli" className="wa-mock-avatar wa-mock-avatar-sheli" />
```

**Step 2: Remove QR block**

Delete the entire QR section (~lines 205-209):
```jsx
<a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-qr">
  <img src="/qr-whatsapp.svg" alt="QR code to message Sheli on WhatsApp" width="140" height="140" />
  <span className="landing-qr-label">{c.qrLabel}</span>
</a>
```

**Step 3: Add bridge one-liner**

After the free badge div (~line 203) and before the sign-in button, add:
```jsx
<p className="landing-bridge">{c.bridge}</p>
```

**Step 4: Add family section**

After the features `</section>` closing tag (~line 231) and before the "How It Works" section, add:
```jsx
{/* ─── Sheli for the Family ─── */}
<section className="landing-family">
  <h2 className="landing-section-title">{c.familyTitle}</h2>
  <div className="family-items">
    {c.familyItems.map((item, i) => (
      <div key={i} className="family-item">
        <div className="family-item-icon">
          <item.Icon size={22} />
        </div>
        <div className="family-item-text">
          <h3>{item.title}</h3>
          <p>{item.subtitle}</p>
        </div>
      </div>
    ))}
  </div>
</section>
```

**Step 5: Verify the page renders**

Run: `cd "C:/Users/yarond/Downloads/claude code/ours-app" && npx vite build --logLevel error 2>&1 | head -5`
Expected: clean build, no errors

**Step 6: Commit**

```bash
git add src/components/LandingPage.jsx
git commit -m "feat(landing): avatar PNG, remove QR, bridge one-liner, family section JSX"
```

---

### Task 8: Add CSS for bridge and family section

**Files:**
- Modify: `src/styles/landing.css:383-385` (after `.landing-signin:hover`, before Features section)

**Step 1: Add bridge one-liner styles**

Insert after the `.landing-signin:hover` rule (~line 384), before the `/* ─── Features ─── */` comment:

```css
.landing-bridge {
  margin-top: 16px;
  font-size: 14px;
  color: var(--warm);
  text-align: center;
  max-width: 340px;
  line-height: 1.5;
}
```

**Step 2: Add family section styles**

Insert after the Features section CSS (~line 450, after `.feature-card-text p`), before `/* ─── How It Works ─── */`:

```css
/* ─── Sheli for the Family ─── */

.landing-family {
  padding: 48px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--white);
}

.family-items {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 400px;
}

.family-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.family-item-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--primary-soft, rgba(42,182,115,0.10));
  display: flex;
  align-items: center;
  justify-content: center;
}

.family-item-text h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dark);
}

.family-item-text p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--warm);
  line-height: 1.5;
}
```

**Step 3: Remove QR CSS**

Delete these rules (~lines 353-372):
```css
.landing-qr { ... }
.landing-qr img { ... }
.landing-qr-label { ... }
```

**Step 4: Fix avatar CSS for img element**

The `.wa-mock-avatar-sheli` class currently styles a div with text. Now it's an `<img>`. Update:

Replace:
```css
.wa-mock-avatar-sheli {
  background: linear-gradient(135deg, #E8725C, #D4507A);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  font-family: 'Heebo', sans-serif;
}
```

With:
```css
.wa-mock-avatar-sheli {
  background: none;
  padding: 0;
  object-fit: cover;
}
```

**Step 5: Add desktop responsive for family section**

Inside the `@media (min-width: 768px)` block (~line 606+), add:
```css
.family-items {
  flex-direction: row;
  max-width: 720px;
  gap: 24px;
}

.family-item {
  flex: 1;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
```

**Step 6: Verify build**

Run: `cd "C:/Users/yarond/Downloads/claude code/ours-app" && npx vite build --logLevel error 2>&1 | head -5`
Expected: clean build

**Step 7: Commit**

```bash
git add src/styles/landing.css
git commit -m "feat(landing): CSS for bridge, family section, avatar img, remove QR styles"
```

---

### Task 9: Visual verification

**Step 1: Start dev server**

Run: `cd "C:/Users/yarond/Downloads/claude code/ours-app" && npm run dev`

**Step 2: Verify in browser (Hebrew)**

Check:
- [ ] Sheli PNG icon shows in mock header (not "ש" text)
- [ ] QR code is gone
- [ ] Bridge one-liner visible below free badge
- [ ] 6 feature cards (including expenses)
- [ ] "שלי לכל המשפחה" section visible between features and how-it-works
- [ ] FAQ shows updated copy (Israeli dev, app renamed, privacy rewritten)

**Step 3: Verify in browser (English)**

Toggle to EN and check same items. EN FAQ should NOT mention Israeli context.

**Step 4: Check mobile viewport (375px)**

Verify family section stacks vertically, no overflow.

**Step 5: Final commit if any tweaks needed**

```bash
git add -A
git commit -m "fix(landing): visual polish from review"
```
