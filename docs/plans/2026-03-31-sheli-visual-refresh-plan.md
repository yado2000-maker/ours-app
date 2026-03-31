# Sheli Visual Refresh — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refresh Sheli's visual design and UI copy to match the "warm & inviting organized older sister" personality.

**Architecture:** CSS custom property overhaul + locale string updates + prompt.js personality refinement + Sheli bubble differentiation. No structural changes — same components, new skin.

**Tech Stack:** CSS custom properties, React inline styles (where needed), SVG illustrations (inline)

---

## Task 1: Color Palette & Design Tokens

**Files:**
- Modify: `src/styles/app.css:4-10` (light mode tokens)
- Modify: `src/styles/app.css:34-38` (dark mode tokens)
- Modify: `src/styles/app.css:39-45` (auto dark mode tokens)

**Step 1: Update light mode CSS custom properties**

Replace `:root` color block (lines 4-10) with:
```css
:root{
  --cream:#FAF8F5;--dark:#2D2A26;--warm:#4A453E;
  --accent:#D4845A;--accent-soft:rgba(212,132,90,0.1);--accent-light:#FFF8F2;
  --green:#5A9A6B;--green-light:#F0F8F2;--muted:#9B9488;--white:#fff;
  --border:#EDE9E3;
  --sh:0 2px 12px rgba(45,42,38,0.06);--shm:0 4px 20px rgba(45,42,38,0.09);
}
```

**Step 2: Update dark mode tokens**

Replace both dark mode blocks with:
```css
[data-theme="dark"]{
  --cream:#1A1814;--dark:#F0EBE0;--warm:#C8BFB0;
  --accent:#E09A6E;--accent-soft:rgba(224,154,110,0.12);--accent-light:#2A2318;
  --green:#6BAF7E;--green-light:#1A2A1E;--muted:#8A8070;--white:#242019;
  --border:#332E27;
  --sh:0 2px 12px rgba(0,0,0,0.25);--shm:0 4px 20px rgba(0,0,0,0.35);
}
```
(Same for the `@media(prefers-color-scheme:dark)` auto block)

**Step 3: Update typography scale**

Replace lines 13-22 with:
```css
:root {
  --text-xs: 11px;
  --text-sm: 12.5px;
  --text-base: 15px;
  --text-md: 16px;
  --text-lg: 18px;
  --text-xl: 20px;
  --text-2xl: 24px;
  --text-3xl: 32px;
}
```

**Step 4: Commit**
```
git commit -m "design: update color palette and typography tokens for Sheli brand refresh"
```

---

## Task 2: Shape Language & Component Styles

**Files:**
- Modify: `src/styles/app.css` — bubble styles, buttons, cards

**Step 1: Update message bubbles**

Replace `.bubble` rule (line 91):
```css
.bubble{padding:11px 15px;border-radius:16px;font-size:15px;line-height:1.65;white-space:pre-wrap;}
```

Update Sheli bubble (`.msg-wrap.assistant .bubble`, line 93):
```css
.msg-wrap.assistant .bubble{background:var(--accent-light);color:var(--dark);border-bottom-left-radius:4px;box-shadow:var(--sh);}
```

Update RTL Sheli bubble (line 95):
```css
[dir="rtl"] .msg-wrap.assistant .bubble{border-bottom-left-radius:20px;border-bottom-right-radius:4px;}
```

Also add Sheli label accent color:
```css
.msg-wrap.assistant .msg-label{color:var(--accent);}
```

**Step 2: Update button shapes to pill**

Find all CTA buttons and update border-radius to `999px`. Key selectors:
- `.pill` (line 62) — already `100px`, good
- `.nav-badge` (line 77) — already `100px`, good
- Any `.button` or CTA selectors — change to `border-radius:999px`

**Step 3: Update card shadows**

The empty state, header, and nav already use `--sh`. The new values from Task 1 will cascade.

**Step 4: Commit**
```
git commit -m "design: warm Sheli bubbles, rounded shapes, updated shadows"
```

---

## Task 3: Sheli's Message Label Accent

**Files:**
- Modify: `src/App.jsx` — Sheli's label in chat

**Step 1: Update Sheli's chat label styling**

In `App.jsx`, find where `t.sheliLabel` is rendered (the msg-label divs). The CSS from Task 2 already handles `.msg-wrap.assistant .msg-label{color:var(--accent);}` so this should cascade automatically.

Verify it works — no code change needed if CSS targets are correct.

**Step 2: Commit** (combine with Task 2 if no changes needed)

---

## Task 4: UI Copy — Empty States & Locale Strings

**Files:**
- Modify: `src/locales/en.js`
- Modify: `src/locales/he.js`

**Step 1: Update English empty states**

```javascript
tasksEmpty: "No tasks. Tell me what needs doing",
shopEmpty: "List is empty. Lucky day",
allDone: "All done. Nice work",
allInCart: "Everything's in the cart",
```

Also update:
```javascript
chatSub: "Tasks, shopping, calendar, rides — all in one place.",
```

**Step 2: Update Hebrew empty states**

```javascript
tasksEmpty: "אין משימות. תגידו לי מה צריך",
shopEmpty: "הרשימה ריקה, יום מזלכם",
allDone: "הכל בוצע, כל הכבוד",
allInCart: "הכל בעגלה",
```

Also update `chatSub`:
```javascript
chatSub: "מטלות, קניות, לו\"ז, הסעות ואירועים — הכל במקום אחד.",
```

**Step 3: Update WeekView empty states**

In `src/locales/en.js`:
```javascript
weekEmpty: "Quiet week. Enjoy it",
```

In `src/locales/he.js`:
```javascript
weekEmpty: "שבוע שקט, תהנו",
```

**Step 4: Commit**
```
git commit -m "copy: update empty states and UI strings to match Sheli personality"
```

---

## Task 5: AI System Prompt — Personality Upgrade

**Files:**
- Modify: `src/lib/prompt.js`

**Step 1: Update Hebrew tone section (lines 3-12)**

Replace the Hebrew langNote with:
```javascript
? `The household language is Hebrew. ALWAYS respond in Hebrew.

Tone in Hebrew — you are Sheli, the organized older sister:
- Warm and capable. Like a real person texting in a family WhatsApp group.
- Direct, short sentences. Get to the point. Max 2-3 sentences per response.
- Natural casual Hebrew — "סבבה", "אחלה", "יאללה" when it fits, but don't force it.
- Use gender-neutral plural forms when addressing the family: "תוסיפו", "תגידו", "בדקו".
- When referring to YOURSELF, ALWAYS use FEMININE forms: "הוספתי", "אני בודקת", "סידרתי", "בדקתי". You are feminine (היא, העוזרת).
- Use names naturally. Give credit when tasks are done: "אבא סגר 3 משימות, כל הכבוד".
- Occasional dry humor when natural: "חלב? שלישי השבוע".
- Emoji when natural — like a 30-year-old Israeli woman would. Not forced, not avoided.
- Never nag. Nudge gently: "נשארו 3 מאתמול, בא למישהו?"
- Never over-explain. Never use corporate language. Never sound like a chatbot.`
```

**Step 2: Update personality line (line 35)**

Replace:
```
Personality: warm, direct. No filler phrases. Short responses unless detail is needed. Never nag. Use names naturally.
```
With:
```
Personality: You are Sheli — the organized older sister. Warm, capable, occasionally a little cheeky. Direct and short — max 2-3 sentences. Use names naturally. Give credit when tasks are completed. Never nag, never over-explain, never sound like a chatbot.
```

**Step 3: Commit**
```
git commit -m "personality: upgrade AI prompt to match Sheli's organized-older-sister voice"
```

---

## Task 6: Welcome Screen Copy Polish

**Files:**
- Modify: `src/components/WelcomeScreen.jsx`

**Step 1: Verify the WhatsApp subtitle is feminine**

Line 158 should already be: "העוזרת המשפחתית החכמה שגרה בקבוצת הוואטסאפ שלכם" (fixed in earlier commit). Verify.

**Step 2: Verify feature descriptions use feminine verbs**

Line 30 should say "מוסיפה" (fixed earlier). Verify.

**Step 3: Commit** (only if changes needed)

---

## Task 7: Final Push & Verify

**Step 1: Run a final grep for remaining issues**
```bash
grep -rn "Ours\|ours-\|העוזר " src/
```

**Step 2: Push to GitHub**
```bash
git push origin main
```

**Step 3: Wait for Vercel deploy, then verify at sheli.ai**
- Check welcome screen colors
- Check chat bubble differentiation (Sheli vs user)
- Check empty states text
- Check dark mode

---

## Verification Checklist

- [ ] Light mode: warm white background (#FAF8F5), not old cream (#F5F0E8)
- [ ] Sheli's chat bubbles have warm tint (#FFF8F2), distinct from user bubbles
- [ ] Sheli's chat label shows in accent color (#D4845A)
- [ ] Empty states show Sheli's personality copy
- [ ] Dark mode: accent color shifts to #E09A6E
- [ ] AI responses use feminine Hebrew self-reference
- [ ] No remaining "Ours" references anywhere
