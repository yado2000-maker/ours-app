# Sheli Landing Page — Design Doc

**Date:** 2026-04-04
**Status:** Approved
**Author:** Yaron + Claude

## Goal

Replace the current WelcomeScreen with a full Hebrew landing page at sheli.ai. Primary CTA: add Sheli to a WhatsApp group (`wa.me/972555175553`). No React Router — reuse the existing screen-state model.

## Audience

Israeli families. Hebrew-first, RTL layout. Heebo font for body, Cormorant Garamond for wordmark.

## Architecture

- Replace `WelcomeScreen` component (currently 312 lines) with a new `LandingPage` component
- Same screen-state integration: `screen === "welcome"` renders LandingPage
- Logged-in users skip directly to app (existing auth check unchanged)
- Logged-out visitors see the landing page
- "Sign in" link in hero navigates to auth screen via `onSignIn()`
- Reuse existing design system (CSS variables, Icons, fonts)

## Sections

### 1. Hero (full viewport)

- **Wordmark:** "Sheli" — Cormorant Garamond, ~48px, letterSpacing 0.22em
- **Tagline:** "העוזרת החכמה של הבית בווטסאפ שלכם"
- **WhatsApp mock** (expanded, 6 messages showing shopping + tasks):
  - אמא: "חלב, ביצים ולחם"
  - שלי: "🛒 הוספתי חלב, ביצים ולחם לרשימה"
  - אבא: "מישהו יכול לאסוף את נועה מחוג ב-5?"
  - שלי: "📅 הוספתי: לאסוף נועה ב-17:00 — מי לוקח?"
  - אמא: "אני"
  - שלי: "✅ סימנתי לאמא"
- **Primary CTA:** Green WhatsApp button — "הוסיפו את שלי לקבוצה" → `https://wa.me/972555175553`
- **Secondary:** Text link — "יש לי כבר חשבון → כניסה" → `onSignIn()`

### 2. Features (3 cards)

Reuse existing card layout with warm accent styling.

| Icon | Title | Subtitle |
|------|-------|----------|
| ShoppingFeatureIcon | רשימת קניות | אמרו "חלב" בקבוצה — וזה ברשימה. בלי אפליקציה, בלי הקלדה |
| CalendarFeatureIcon | חוגים, הסעות ואירועים | שלי מזהה תאריכים ומארגנת את היומן המשפחתי |
| ChoresFeatureIcon | מטלות בית | מי עושה מה ומתי — שלי זוכרת ומעדכנת |

### 3. How It Works (3 numbered steps)

Horizontal layout (vertical on mobile). Numbered circles (1, 2, 3) with warm accent color.

1. **הוסיפו את שלי לקבוצת הווטסאפ** — "לחצו על הכפתור ושלי מצטרפת לקבוצה שלכם"
2. **דברו כרגיל** — "שלי מבינה עברית טבעית — קניות, מטלות, אירועים"
3. **הכל מסתדר** — "הרשימה, היומן והמטלות מתעדכנים אוטומטית"

### 4. FAQ (4 collapsible items)

Accordion-style, click to expand. Chevron icon rotates on open.

- **"האם שלי קוראת את כל ההודעות?"** → "שלי מזהה רק הודעות שקשורות למטלות, קניות ואירועים. שיחות חברתיות, תמונות ומדיה — שלי מתעלמת לחלוטין."
- **"כמה זה עולה?"** → "30 פעולות בחודש חינם. Premium ב-9.90 ₪ לחודש — ללא הגבלה."
- **"האם זה עובד בקבוצות קיימות?"** → "כן! פשוט הוסיפו את שלי לכל קבוצת ווטסאפ."
- **"מה שלי יודעת לעשות?"** → "רשימות קניות, מטלות בית, אירועים ביומן, תזכורות, ומענה לשאלות על מה שצריך לעשות."

### 5. Bottom CTA

- Same green WhatsApp button: "הוסיפו את שלי לקבוצה"
- Small secondary link: "או הורידו את האפליקציה" → `onGetStarted()` (goes to auth/signup)

## Visual Style

- **Background:** `--cream` (#FAF8F5)
- **Text:** `--dark` (#2D2A26) for headings, `--warm` (#4A453E) for body
- **CTA button:** WhatsApp green (#25D366) with white text
- **Feature cards:** White background, `--sh` shadow, `--border` border, rounded corners
- **WhatsApp mock:** Dark WA background (#0b141a), green outgoing bubbles (#103529), dark incoming (#1f2c34), bot accent border (#25D366)
- **FAQ:** Expandable, warm border, smooth height transition
- **Responsive:** Single column on mobile (< 768px), wider layout on desktop
- **Dark mode:** Inherits from existing CSS variable dark mode

## Copy Guidelines

- **מטלות** (not משימות) for tasks
- **העוזרת החכמה של הבית** (not של המשפחה)
- Warm, direct, no corporate speak
- Feminine Hebrew verbs for Sheli (הוספתי, סימנתי, זוכרת)

## Files to Modify

| File | Change |
|------|--------|
| `src/components/LandingPage.jsx` | NEW — full landing page component |
| `src/styles/landing.css` | NEW — landing page styles |
| `src/App.jsx` | Replace `<WelcomeScreen>` with `<LandingPage>` in welcome screen branch |
| `src/components/WelcomeScreen.jsx` | Keep as reference, eventually remove |

## What NOT to Build

- No React Router
- No pricing section (yet)
- No testimonials (no real users yet)
- No English version (yet)
- No animation library (CSS transitions only)
- No analytics/tracking (yet)
