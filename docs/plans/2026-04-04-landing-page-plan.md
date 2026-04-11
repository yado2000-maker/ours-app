# Sheli Landing Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the WelcomeScreen with a full Hebrew landing page at sheli.ai with WhatsApp CTA as primary conversion.

**Architecture:** Single LandingPage component replaces WelcomeScreen in the existing screen-state model. No React Router. Hebrew-only, RTL-first.

**Tech Stack:** React 19, CSS (no libraries), existing design system variables from app.css.

**Design Doc:** `docs/plans/2026-04-04-landing-page-design.md`

---

## Task 1: Create landing page styles

**Files:**
- Create: `src/styles/landing.css`

**Step 1: Create the complete CSS file**

All styles for the landing page. Mobile-first with `@media (min-width: 768px)` breakpoint. Reuses CSS variables from app.css. WhatsApp mock has hardcoded dark colors (always dark regardless of theme). Page root is scrollable (`height: 100dvh; overflow-y: auto`) to work around `body { overflow: hidden }` in app.css.

Key sections: `.landing` (page root), `.landing-hero`, `.wa-mock` + `.wa-bubble`, `.landing-features` + `.feature-card`, `.landing-steps` + `.step-item`, `.landing-faq` + `.faq-item`, `.landing-bottom-cta`, `.landing-cta` (WhatsApp green button).

---

## Task 2: Create LandingPage component

**Files:**
- Create: `src/components/LandingPage.jsx`

**Step 1: Create the complete component**

Single file, self-contained. Props: `{ onGetStarted, onSignIn }` (same as WelcomeScreen).

Data arrays defined as constants outside the component:
- `MOCK_MESSAGES` — 6 WhatsApp messages (shopping + tasks)
- `FEATURES` — 3 feature cards with icons
- `STEPS` — 3 "How it works" steps
- `FAQ_ITEMS` — 4 Q&A pairs

Component state: `openFaq` (index or null) for accordion.

Sections in render order:
1. **Hero** — Wordmark + tagline + WhatsApp mock + CTA button + sign-in link
2. **Features** — Section title + 3-card grid
3. **How It Works** — Section title + 3 numbered steps
4. **FAQ** — Section title + 4 accordion items
5. **Bottom CTA** — Section title + WhatsApp button + "use the app" link

WhatsApp icon: small inline SVG defined locally (not in Icons.jsx).

Imports: `useState` from React, `../styles/landing.css`, icons from `./Icons.jsx` (ShoppingFeatureIcon, CalendarFeatureIcon, ChoresFeatureIcon, ChevronRightIcon).

### Hebrew Copy (final, approved):
- Tagline: "העוזרת החכמה של הבית — ישר בווטסאפ"
- Use "מטלות" not "משימות"
- Feminine Hebrew verbs for Sheli
- WA link: `https://wa.me/972555175553`
- Mock messages:
  - אמא: "חלב, ביצים ולחם"
  - שלי: "🛒 הוספתי חלב, ביצים ולחם לרשימה"
  - אבא: "מישהו יכול לאסוף את נועה מחוג ב-5?"
  - שלי: "📅 הוספתי: לאסוף נועה ב-17:00 — מי לוקח?"
  - אמא: "אני"
  - שלי: "✅ סימנתי לאמא"

---

## Task 3: Wire up in App.jsx

**Files:**
- Modify: `src/App.jsx`

**Step 1: Add import**

Add after the existing WelcomeScreen import:
```jsx
import LandingPage from "./components/LandingPage.jsx";
```

**Step 2: Swap the welcome screen render**

Change the `screen === "welcome"` block from `<WelcomeScreen>` to `<LandingPage>` with the same props.

Keep `WelcomeScreen.jsx` and its import (reference, not deleted).

---

## Gotchas

- **`body { overflow: hidden }`** in app.css — landing page root needs `height: 100dvh; overflow-y: auto`
- **No ChevronDownIcon** — rotate ChevronRightIcon 90deg via CSS
- **Font stacking** — landing page is outside `.app` wrapper, must set `font-family: 'Heebo'` explicitly
- **`@keyframes msgIn`** from app.css is globally available — reuse for bubble entrance
- **Dark mode** — CSS variables auto-adapt except WhatsApp mock (always dark)

---

## Verification

After deploying to Vercel:
- [ ] Landing page loads at sheli.ai for logged-out visitors
- [ ] Fully RTL, Heebo body font, Cormorant Garamond wordmark
- [ ] WhatsApp mock shows 6 messages (shopping + tasks) with staggered animation
- [ ] Green CTA opens wa.me/972555175553 in new tab
- [ ] "יש לי כבר חשבון" navigates to auth screen
- [ ] 3 feature cards with correct icons, "מטלות" not "משימות"
- [ ] 3 numbered "How it works" steps
- [ ] FAQ accordion opens/closes one at a time, chevron rotates
- [ ] Bottom CTA works, "או הורידו את האפליקציה" goes to auth
- [ ] Responsive: single column mobile, multi-column desktop
- [ ] Dark mode adapts (except WA mock stays dark)
- [ ] Logged-in users skip straight to app
- [ ] WelcomeScreen.jsx still exists
