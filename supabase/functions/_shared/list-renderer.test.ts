// Unit tests for list-renderer.ts — run with: deno test supabase/functions/_shared/list-renderer.test.ts
//
// Same Deno-availability caveat as templates.test.ts: tests run in Supabase
// local dev / CI / PowerShell. Logic is deterministic + covered by the
// boundary cases below.

import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import {
  renderList,
  detectListQuery,
  ListItem,
} from "./list-renderer.ts";

function tasks(n: number): ListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `מטלה ${i + 1}`,
    dueDate: `2026-04-${String(20 + i).padStart(2, "0")}`,
  }));
}

// ───────────────── renderList: count boundaries (non-shopping) ─────────────────

Deno.test("renderList: empty list shows friendly short message with heart", () => {
  const out = renderList({ type: "task", items: [] });
  assertEquals(out.includes("אין"), true);
  assertEquals(out.includes("כרגע"), true);
  assertEquals(out.includes("🧡"), true);
  assertEquals(out.includes("sheli.ai"), false, "no link on empty state");
});

Deno.test("renderList: n=1 uses Hebrew singular (not '1 מטלות')", () => {
  const out = renderList({ type: "task", items: [{ title: "להתקשר לאמא" }] });
  assertEquals(out.includes("מטלה אחת"), true);
  assertEquals(out.includes("להתקשר לאמא"), true);
  assertEquals(out.includes("1 מטלות"), false, "ungrammatical singular avoided");
  assertEquals(out.includes("sheli.ai"), false, "no link for n=1 task");
});

Deno.test("renderList: n=3 tasks renders inline comma-separated", () => {
  const out = renderList({ type: "task", items: tasks(3) });
  assertEquals(out.includes("3 מטלות"), true);
  assertEquals(out.includes("מטלה 1, מטלה 2, מטלה 3"), true);
  assertEquals(out.includes("sheli.ai"), false);
  assertEquals(out.includes("•"), false, "no bullet chars anywhere (RTL flip)");
});

Deno.test("renderList: n=5 still inline (boundary)", () => {
  const out = renderList({ type: "task", items: tasks(5) });
  assertEquals(out.includes("5 מטלות"), true);
  assertEquals(out.includes("מטלה 5"), true);
  assertEquals(out.includes("•"), false);
});

Deno.test("renderList: n=6 flips to line-separated (no bullets)", () => {
  const out = renderList({ type: "task", items: tasks(6) });
  assertEquals(out.includes("6 ה"), true);
  assertEquals(out.includes("•"), false, "no bullet chars");
  // 6 items should appear each on its own line
  for (let i = 1; i <= 6; i++) {
    assertEquals(out.includes(`מטלה ${i}`), true, `מטלה ${i} missing`);
  }
  assertEquals(out.includes("sheli.ai"), false);
});

Deno.test("renderList: n=10 line-separated full (upper boundary before cap)", () => {
  const out = renderList({ type: "task", items: tasks(10) });
  assertEquals(out.includes("מטלה 10"), true);
  assertEquals(out.includes("•"), false);
  assertEquals(out.includes("sheli.ai"), false);
});

Deno.test("renderList: n=11 caps at 5 + link (cap boundary)", () => {
  const out = renderList({ type: "task", items: tasks(11) });
  assertEquals(out.includes("11 מטלות"), true);
  assertEquals(out.includes("הדחופות"), true);
  assertEquals(out.includes("sheli.ai/tasks"), true);
  for (let i = 1; i <= 5; i++) {
    assertEquals(out.includes(`מטלה ${i}`), true, `top-5 missing מטלה ${i}`);
  }
  assertEquals(out.includes("מטלה 6"), false, "nothing beyond top-5 inline");
  assertEquals(out.includes("•"), false);
});

// ───────────────── renderList: shopping category grouping ─────────────────

Deno.test("shopping: n=1 flat singular, no category header", () => {
  const out = renderList({
    type: "shopping",
    items: [{ title: "חלב", category: "מוצרי חלב" }],
  });
  assertEquals(out.includes("פריט אחד"), true);
  assertEquals(out.includes("חלב"), true);
  assertEquals(out.includes("🥛"), false, "single item doesn't need category emoji");
  assertEquals(out.includes("•"), false);
});

Deno.test("shopping: n=3 same category flattens (no header noise)", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "חלב", category: "מוצרי חלב" },
      { title: "קוטג'", category: "מוצרי חלב" },
      { title: "ביצים", category: "מוצרי חלב" },
    ],
  });
  assertEquals(out.includes("3 פריטים"), true);
  assertEquals(out.includes("חלב, קוטג', ביצים"), true);
  assertEquals(out.includes("🥛 מוצרי חלב"), false, "single category → no grouped header");
});

Deno.test("shopping: n=5 multi-category grouped with emoji headers, no bullets", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "חלב", category: "מוצרי חלב" },
      { title: "קוטג'", category: "מוצרי חלב" },
      { title: "עגבניות", category: "פירות וירקות" },
      { title: "מלפפון", category: "פירות וירקות" },
      { title: "נייר טואלט", category: "אחר" },
    ],
  });
  assertEquals(out.includes("5 פריטים"), true);
  assertEquals(out.includes("🥦 פירות וירקות (2)"), true);
  assertEquals(out.includes("🥛 מוצרי חלב (2)"), true);
  assertEquals(out.includes("🛒 אחר (1)"), true);
  assertEquals(out.includes("חלב"), true);
  assertEquals(out.includes("עגבניות"), true);
  assertEquals(out.includes("•"), false, "no bullet chars anywhere");
});

Deno.test("shopping: category order follows canonical (produce before dairy before other)", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "נייר טואלט", category: "אחר" },
      { title: "חלב", category: "מוצרי חלב" },
      { title: "עגבניות", category: "פירות וירקות" },
    ],
  });
  const produceIdx = out.indexOf("🥦 פירות וירקות");
  const dairyIdx = out.indexOf("🥛 מוצרי חלב");
  const otherIdx = out.indexOf("🛒 אחר");
  assertEquals(produceIdx < dairyIdx, true, "produce before dairy");
  assertEquals(dairyIdx < otherIdx, true, "dairy before other");
});

Deno.test("shopping: legacy 'חלב וביצים' category aliases to 'מוצרי חלב'", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "חלב", category: "חלב וביצים" },  // legacy name
      { title: "קוטג'", category: "מוצרי חלב" },   // new name
      { title: "עגבניות", category: "פירות וירקות" },
    ],
  });
  // Both items bucket under the new canonical name
  assertEquals(out.includes("🥛 מוצרי חלב (2)"), true);
  assertEquals(out.includes("חלב וביצים"), false, "legacy name not shown");
});

Deno.test("shopping: unknown category gets 📦 fallback, appears after canonical cats", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "חלב", category: "מוצרי חלב" },
      { title: "גבינת עיזים", category: "טיפוח" },  // bot-hallucinated, not canonical
    ],
  });
  assertEquals(out.includes("🥛 מוצרי חלב"), true);
  assertEquals(out.includes("📦 טיפוח"), true, "unknown cat uses 📦 fallback");
  const dairyIdx = out.indexOf("🥛 מוצרי חלב");
  const unknownIdx = out.indexOf("📦 טיפוח");
  assertEquals(dairyIdx < unknownIdx, true, "canonical before unknown in output");
});

Deno.test("shopping: n=15 multi-category shows counts summary + link (no items)", () => {
  const items: ListItem[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ title: `פרי ${i}`, category: "פירות וירקות" })),
    ...Array.from({ length: 3 }, (_, i) => ({ title: `מוצר חלב ${i}`, category: "מוצרי חלב" })),
    ...Array.from({ length: 2 }, (_, i) => ({ title: `בשר ${i}`, category: "בשר ודגים" })),
    ...Array.from({ length: 5 }, (_, i) => ({ title: `כללי ${i}`, category: "אחר" })),
  ];
  const out = renderList({ type: "shopping", items });
  assertEquals(out.includes("15 פריטים"), true);
  assertEquals(out.includes("🥦 פירות וירקות (5)"), true);
  assertEquals(out.includes("🥛 מוצרי חלב (3)"), true);
  assertEquals(out.includes("🥩 בשר ודגים (2)"), true);
  assertEquals(out.includes("🛒 אחר (5)"), true);
  assertEquals(out.includes("sheli.ai/shopping"), true);
  // Individual item titles should NOT be in the summary
  assertEquals(out.includes("פרי 0"), false, "large list → counts only, no items");
});

Deno.test("shopping: missing category defaults to 'אחר'", () => {
  const out = renderList({
    type: "shopping",
    items: [
      { title: "חלב", category: "מוצרי חלב" },
      { title: "משהו", /* no category */ },
    ],
  });
  assertEquals(out.includes("🛒 אחר (1)"), true);
  assertEquals(out.includes("משהו"), true);
});

// ───────────────── renderList: per-type behavior ─────────────────

Deno.test("renderList: expense always routes to web link regardless of count", () => {
  const one = renderList({ type: "expense", items: [{ title: "חשמל", amount: 250 }] });
  assertEquals(one.includes("sheli.ai/expenses"), true, "n=1 expense → link");

  const three = renderList({
    type: "expense",
    items: [{ title: "חשמל" }, { title: "מים" }, { title: "ארנונה" }],
  });
  assertEquals(three.includes("sheli.ai/expenses"), true, "n=3 expense → link (no inline)");
  assertEquals(three.includes("חשמל, מים"), false, "expense NOT listed inline");
});

Deno.test("renderList: event uses 'אירועים' phrasing", () => {
  const out = renderList({
    type: "event",
    items: [{ title: "פגישה עם רינה" }, { title: "יום הולדת" }],
  });
  assertEquals(out.includes("2 אירועים"), true);
});

Deno.test("renderList: reminder uses 'תזכורות' phrasing and links to /reminders on long list", () => {
  const out = renderList({ type: "reminder", items: tasks(12) });
  assertEquals(out.includes("תזכורות"), true);
  assertEquals(out.includes("sheli.ai/reminders"), true);
  assertEquals(out.includes("•"), false);
});

// ───────────────── detectListQuery: Hebrew + English ─────────────────

Deno.test("detectListQuery: Hebrew list queries", () => {
  assertEquals(detectListQuery("תן לי את כל המטלות"), "task");
  assertEquals(detectListQuery("מה יש ברשימת הקניות?"), "shopping");
  assertEquals(detectListQuery("מה בקניות"), "shopping");
  assertEquals(detectListQuery("אילו אירועים יש השבוע"), "event");
  assertEquals(detectListQuery("כמה הוצאנו על חשמל"), "expense");
  assertEquals(detectListQuery("מה בהוצאות"), "expense");
  assertEquals(detectListQuery("אילו תזכורות פתוחות"), "reminder");
});

Deno.test("detectListQuery: English list queries", () => {
  assertEquals(detectListQuery("give me my todo"), "task");
  assertEquals(detectListQuery("what's on the shopping list?"), "shopping");
  assertEquals(detectListQuery("upcoming events"), "event");
  assertEquals(detectListQuery("expenses this month"), "expense");
  assertEquals(detectListQuery("my reminders"), "reminder");
});

Deno.test("detectListQuery: non-list questions return null", () => {
  assertEquals(detectListQuery("איך את היום?"), null);
  assertEquals(detectListQuery("מה השעה"), null);
  assertEquals(detectListQuery("תודה שלי"), null);
  assertEquals(detectListQuery("how does this work"), null);
});

Deno.test("detectListQuery: bare 'רשימה' returns null (ambiguous); 'רשימת הקניות' resolves shopping", () => {
  assertEquals(detectListQuery("תן לי את הרשימה"), null);
  assertEquals(detectListQuery("רשימת הקניות שלי"), "shopping");
});
