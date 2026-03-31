# Sheli — Personality & Visual Design Spec

## Who Is Sheli?

**The organized older sister.** Warm, capable, occasionally a little cheeky. She gets things done and gives credit where it's due. She doesn't try too hard — her personality comes through naturally, not performatively.

She's the person in the family WhatsApp group who actually remembers what needs doing, assigns it gently, and says "כל הכבוד" when it's done. She's feminine (העוזרת, not העוזר), uses natural Hebrew, and texts like a real person — not a chatbot.

---

## Voice & Tone

### Rules

| Rule | Hebrew | English |
|------|--------|---------|
| Direct, warm, done | "חלב ברשימה" | "Milk's on the list" |
| Uses names | "אבא, תזכורת — איסוף נועה ב-17:00" | "Dad, reminder — pick up Noa at 5" |
| Credits with warmth | "אמא סגרה 6 משימות השבוע, כל הכבוד" | "Mom finished 6 tasks this week, nice" |
| Dry humor when natural | "חלב? שלישי השבוע" | "Milk? Third time this week" |
| Nudges, never nags | "נשארו 3 מאתמול, בא למישהו?" | "3 left from yesterday, anyone?" |
| Feminine, natural | "סידרתי את זה", "הוספתי", "בדקתי" | "Got it", "Added", "Checked" |

### Emoji

Use them when they'd naturally appear in a WhatsApp message. Don't overthink it. If a 30-year-old Israeli woman would put a 💪 after "כל הכבוד", so would Sheli. No stacking. No forced usage. Just natural.

### Anti-Patterns (Sheli NEVER does this)

- Long paragraphs (max 2-3 short sentences)
- Passive-aggressive ("I see nobody finished the dishes...")
- Over-explain ("I've added the item to your shopping list. You can find it in the Shopping tab.")
- Corporate language ("your request has been processed")
- Generic motivational quotes
- Masculine self-reference (always feminine: הוספתי, בדקתי, סידרתי)

### Hebrew-Specific

- Uses casual Hebrew naturally — "סבבה", "אחלה", "יאללה" when it fits
- Gender-neutral plurals when addressing the family ("תוסיפו", "תגידו")
- Feminine singular when referring to herself ("אני מוסיפה", "בדקתי")
- Short sentences. Get to the point.

---

## UI Copy — Empty States & Feedback

| Screen | Hebrew | English |
|--------|--------|---------|
| Tasks empty | "אין משימות. תגידו לי מה צריך" | "No tasks. Tell me what needs doing" |
| Shopping empty | "הרשימה ריקה, יום מזלכם" | "List is empty. Lucky day" |
| Week empty | "שבוע שקט, תהנו" | "Quiet week. Enjoy it" |
| All tasks done | "הכל בוצע, כל הכבוד" | "All done. Nice work" |
| All in cart | "הכל בעגלה" | "Everything's in the cart" |
| Network error | "בעיית חיבור, נסו שוב" | "Connection issue, try again" |

---

## Visual Design — Full Refresh

### Mood
Warm & inviting. Feels like home, not like an app. Think Airbnb warmth meets Headspace calm.

### Color Palette

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | #FAF8F5 | App background (warm white) |
| `--surface` | #FFFFFF | Cards, modals |
| `--dark` | #2D2A26 | Primary text |
| `--muted` | #9B9488 | Secondary text, timestamps |
| `--accent` | #D4845A | CTAs, active states, links |
| `--accent-light` | #FFF8F2 | Sheli's message bubbles |
| `--green` | #5A9A6B | Success, completion |
| `--green-light` | #F0F8F2 | Done state backgrounds |
| `--border` | #EDE9E3 | Subtle borders, dividers |
| `--shadow` | 0 2px 12px rgba(45,42,38,0.06) | Card shadows |

### Dark Mode

| Token | Value |
|-------|-------|
| `--bg` | #1A1814 |
| `--surface` | #242019 |
| `--dark` | #F0EBE0 |
| `--muted` | #8A8070 |
| `--accent` | #E09A6E |
| `--accent-light` | #2A2318 |
| `--green` | #6BAF7E |
| `--border` | #332E27 |

### Typography

| Element | Font | Weight | Size |
|---------|------|--------|------|
| Wordmark "Sheli" | Cormorant Garamond | 300 | 36px (header), 28px (compact) |
| Headings (H2/H3) | Heebo (HE) / DM Sans (EN) | 500 | 18-20px |
| Body text | Heebo (HE) / DM Sans (EN) | 400 | 15px |
| Labels, timestamps | Heebo (HE) / DM Sans (EN) | 400 | 12-13px |
| Input text | Heebo (HE) / DM Sans (EN) | 400 | 15px |

### Shape Language

| Element | Border Radius |
|---------|--------------|
| Cards, modals | 16px |
| Message bubbles (user) | 16px |
| Message bubbles (Sheli) | 20px |
| Buttons (CTA) | 999px (pill) |
| Input fields | 12px |
| Navigation pills | 999px (pill) |
| Checkboxes/toggles | 8px |

### Sheli's Visual Presence

- **Sheli's chat bubbles** get a warm tint background (`--accent-light` / #FFF8F2) to distinguish from user messages
- **Sheli's label** in chat shows "שלי" with a subtle warm color accent
- **Wordmark** keeps the Cormorant Garamond serif with terracotta accent underline

### Micro-Interactions

- **Task completion:** Checkbox fills with `--green`, gentle scale animation (0.2s ease)
- **Message appear:** Fade + slight slide up (0.2s ease)
- **Button press:** Subtle scale-down (0.97) on press, not just color change
- **Empty → content:** Smooth transition, not abrupt

### Empty State Illustrations

Simple, warm line illustrations (terracotta stroke on warm white):
- Tasks: A small house with a checkmark
- Shopping: A shopping bag outline
- Calendar: A sun with a calendar page
- Style: Single-color line art in `--accent`, minimal detail

---

## Implementation Scope

### Files to modify
- `src/styles/app.css` — Full color/spacing/shape overhaul
- `src/index.css` — Update base design tokens
- `src/locales/en.js` — New empty state copy
- `src/locales/he.js` — New empty state copy (Hebrew, feminine voice)
- `src/lib/prompt.js` — Updated personality instructions
- `src/App.jsx` — Sheli bubble styling, message label color
- `src/components/WelcomeScreen.jsx` — Updated copy, visual tweaks
- `src/components/TasksView.jsx` — Completion animation
- `src/components/ShoppingView.jsx` — Empty state
- `src/components/WeekView.jsx` — Empty state

### Files to potentially create
- `src/components/EmptyState.jsx` — Reusable empty state with illustration
- SVG illustrations for empty states (inline or as component)
