// Deterministic list renderer — plan Task 7, brought forward per Phase 0 P0.6.
//
// Replaces Sonnet prose generation for "תן לי את כל המטלות / הקניות /
// האירועים" style queries. For long lists (>10), shows a category-count
// summary + web link to prevent hallucination or item-drop regressions.
//
// Transport-agnostic — works identically on Whapi and Cloud API cohorts.
// No template dependency. No Meta approval dependency. Ship any time.
//
// Priority order per item type (owner of sort key):
//   - task:    due date ascending (oldest overdue first)
//   - shopping: category-grouped (per canonical order), items most-recent first
//   - event:   chronological upcoming (ascending scheduled_for)
//   - expense: never dump in chat (money audit trail + multi-currency) →
//              always short "N items, see web" regardless of count
//   - reminder: ascending send_at (closest upcoming first)
// Sort within groups is caller's responsibility.
//
// RTL NOTE (2026-04-19): no bullet characters anywhere in output. "• " at
// line-start flips to the visual end in WhatsApp's RTL rendering — feels
// broken to Hebrew readers. We use plain line breaks; emojis on category
// headers give enough visual structure.

export type ListType = "task" | "shopping" | "event" | "expense" | "reminder";

export interface ListItem {
  title: string;
  category?: string;   // shopping only — renderer groups by category when n>=2
  dueDate?: string;
  amount?: number;
}

// Canonical shopping category order + emoji. MUST stay in sync with
// src/locales/he.js cats array (that's the source of truth the web app
// uses for grouping). Ordering matters for render output: canonical cats
// appear in this order; unknown (drift) cats appear at the end.
const SHOPPING_CATEGORIES: Array<[string, string]> = [
  ["פירות וירקות",              "🥦"],
  ["מוצרי חלב",                  "🥛"],
  ["בשר ודגים",                  "🥩"],
  ["מאפים",                      "🍞"],
  ["מזווה",                      "🥫"],
  ["מוצרים קפואים",              "🧊"],
  ["משקאות",                     "🥤"],
  ["ניקוי ובית",                 "🧽"],
  ["מוצרים מחנות הטבע",          "🌱"],
  ["אחר",                        "🛒"],
];
const SHOPPING_EMOJI: Record<string, string> = Object.fromEntries(SHOPPING_CATEGORIES);
const SHOPPING_CATEGORY_ORDER: string[] = SHOPPING_CATEGORIES.map(([name]) => name);
const UNKNOWN_CATEGORY_EMOJI = "📦";

// Legacy-name aliases. Items stored with the old display name still group
// with the new canonical bucket at render time. Remove entries once a DB
// migration rewrites categories (Yaron can run UPDATE shopping_items SET
// category='מוצרי חלב' WHERE category='חלב וביצים' at his convenience).
const CATEGORY_ALIASES: Record<string, string> = {
  "חלב וביצים": "מוצרי חלב",
};

function normalizeCategory(raw: string | undefined): string {
  const c = (raw || "").trim() || "אחר";
  return CATEGORY_ALIASES[c] || c;
}

export interface RenderArgs {
  type: ListType;
  items: ListItem[];
}

interface Label {
  singular: string;
  plural: string;
  webPath: string;
}

const LABELS: Record<ListType, Label> = {
  task:     { singular: "מטלה אחת",               plural: "מטלות",                    webPath: "/tasks" },
  shopping: { singular: "פריט אחד ברשימת קניות",   plural: "פריטים ברשימת קניות",      webPath: "/shopping" },
  event:    { singular: "אירוע אחד",               plural: "אירועים",                  webPath: "/events" },
  expense:  { singular: "הוצאה אחת",               plural: "הוצאות",                   webPath: "/expenses" },
  reminder: { singular: "תזכורת אחת",              plural: "תזכורות",                  webPath: "/reminders" },
};

const EMPTY_PLURAL: Record<ListType, string> = {
  task:     "מטלות פתוחות",
  shopping: "דברים ברשימת הקניות",
  event:    "אירועים מתוכננים",
  expense:  "הוצאות רשומות",
  reminder: "תזכורות פתוחות",
};

/**
 * Render a list deterministically. Always shows the count N so the user
 * knows the list size. No bullet characters (RTL flip issue).
 *
 * Boundary rules (non-shopping):
 *   n == 0   → "אין [plural] כרגע 🧡"
 *   n == 1   → "יש לכם [singular]: [title]."
 *   n == 2-5 → inline: "יש לכם N [plural]: t1, t2, ..."
 *   n == 6-10 → line-separated full list (no markers, no bullets)
 *   n >  10  → top 5 + "הרשימה המלאה: sheli.ai{webPath}"
 *
 * Shopping-specific:
 *   n == 0    → same empty state
 *   n == 1    → same singular inline
 *   n >= 2, single category       → same flat rules as above
 *   n 2-10, multiple categories   → grouped with emoji headers
 *   n > 10                         → category-count summary + web link
 *
 * Expenses always route to the web link regardless of count (money
 * audit trail + multi-currency confusion risk).
 */
export function renderList({ type, items }: RenderArgs): string {
  const label = LABELS[type];
  const n = items.length;

  if (n === 0) {
    return `אין ${EMPTY_PLURAL[type]} כרגע 🧡`;
  }

  if (type === "expense") {
    const countLabel = n === 1 ? label.singular : `${n} ${label.plural}`;
    return `יש לכם ${countLabel}. לצפייה מלאה: sheli.ai${label.webPath}`;
  }

  if (n === 1) {
    return `יש לכם ${label.singular}: ${items[0].title}.`;
  }

  if (type === "shopping") {
    return renderShopping(items, label);
  }

  return renderFlat(items, n, label);
}

// Flat rendering used for tasks/events/reminders at any count, and for
// shopping when all items are in a single category.
function renderFlat(items: ListItem[], n: number, label: Label): string {
  if (n <= 5) {
    const list = items.map((i) => i.title).join(", ");
    return `יש לכם ${n} ${label.plural}: ${list}.`;
  }

  if (n <= 10) {
    const lines = items.map((i) => i.title).join("\n");
    return `הנה ${n} ה${label.plural} שלכם:\n${lines}`;
  }

  const top5 = items.slice(0, 5).map((i) => i.title).join("\n");
  return (
    `יש לכם ${n} ${label.plural}. הנה 5 הדחופות:\n${top5}\n\n` +
    `הרשימה המלאה: sheli.ai${label.webPath}`
  );
}

function renderShopping(items: ListItem[], label: Label): string {
  const n = items.length;

  // Group by normalized category (aliases legacy "חלב וביצים" → "מוצרי חלב")
  const groups = new Map<string, ListItem[]>();
  for (const item of items) {
    const cat = normalizeCategory(item.category);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(item);
  }

  // Single-category: fall back to flat (no header noise for a homogeneous list)
  if (groups.size === 1) {
    return renderFlat(items, n, label);
  }

  // Order categories: canonical first in defined order, then any drift cats
  // in insertion order at the end.
  const orderedCats: string[] = [];
  for (const cat of SHOPPING_CATEGORY_ORDER) {
    if (groups.has(cat)) orderedCats.push(cat);
  }
  for (const cat of groups.keys()) {
    if (!orderedCats.includes(cat)) orderedCats.push(cat);
  }

  // Always dump items, grouped by category, at any count. Previous n>10 cap
  // (category counts only + web link) hid the exact symptom users need to see
  // to clean stale items: Kaye family 2026-04-21 — Niv asked for the list,
  // got "25 items" + category counts + link. He had no in-chat signal of WHICH
  // items were already bought, so the list kept accumulating. Data is fetched
  // deterministically from Postgres (no LLM → zero hallucination risk), so
  // dumping all items is both safe and useful. ~100 items × ~20 chars ≈ 2KB,
  // well under WhatsApp's 4096 char cap. Web link still appended when long.
  //
  // Per-category counts dropped 2026-04-21 — total count is already on the
  // opener line, and the user can see the items below each category header.
  // Redundant noise otherwise.
  const sections = orderedCats.map((cat) => {
    const emoji = SHOPPING_EMOJI[cat] || UNKNOWN_CATEGORY_EMOJI;
    const catItems = groups.get(cat)!;
    const itemLines = catItems.map((i) => i.title).join("\n");
    return `${emoji} ${cat}:\n${itemLines}`;
  });
  let out = `יש לכם ${n} ${label.plural}:\n\n${sections.join("\n\n")}`;
  if (n > 10) {
    // Two additions for long lists: (1) gentle cleanup nudge so users can
    // clear stale entries by saying "קניתי X" — addresses the core Kaye
    // complaint; (2) web link for users who prefer the checkbox UI.
    out += `\n\nאם כבר קניתם משהו, כתבו לי ואני אמחק 🧡\nהרשימה המלאה: sheli.ai${label.webPath}`;
  }
  return out;
}

/**
 * Detect whether a user text is asking for a list of a given item type.
 * Returns null if no list query is detected. Uses regex only — no LLM
 * call, keeps the intent="question" hot path deterministic.
 *
 * Caller should fall through to Sonnet for non-list questions.
 */
export function detectListQuery(text: string): ListType | null {
  // IMPORTANT: no \b around Hebrew — JS regex \b is ASCII-only by default,
  // so \bמטלות\b matches nothing. Bare Hebrew substring is correct because
  // Hebrew uses inseparable prefixes (ה/ב/ל/מ/כ/ש + noun) which fuse onto
  // the noun ("בקניות", "הקניות", "לקניות" all should match). \b kept for
  // English alternates only.

  if (/מטלות|דברים\s+לעשות|\bto.?do\b/i.test(text)) return "task";
  if (/קני(?:ות|יה)|רשימת?\s+קניות|\bshopping\b/i.test(text)) return "shopping";
  if (/אירועים|פגישות|ביומן|\bevents?\b|\bcalendar\b/i.test(text)) return "event";
  if (/הוצאות|כמה\s+(?:הוצאנו|שילמנו)|\bexpenses?\b/i.test(text)) return "expense";
  if (/תזכורות|\breminders?\b/i.test(text)) return "reminder";
  return null;
}
