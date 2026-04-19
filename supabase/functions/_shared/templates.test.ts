// Unit tests for templates.ts — run with: deno test supabase/functions/_shared/templates.test.ts
//
// Note: this machine's bash has no Deno; tests are intended to run in a
// Deno-capable environment (Supabase local dev, CI, Yaron's PowerShell
// with deno installed). Logic is intentionally simple so a static read
// confirms correctness; unit tests exist for regression safety once a
// runner is available.

import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";
import {
  TEMPLATES,
  TemplateId,
  renderTemplate,
  orderedVariables,
} from "./templates.ts";

Deno.test("renderTemplate: reminder_fire substitutes reminderText", () => {
  const out = renderTemplate("reminder_fire", { reminderText: "לקנות חלב" });
  assertEquals(out, "⏰ היי, תזכורת: לקנות חלב");
});

Deno.test("renderTemplate: event_fire substitutes delta and title", () => {
  const out = renderTemplate("event_fire", { delta: "שעה", title: "פגישה עם רינה" });
  assertEquals(out, "📅 בעוד שעה: פגישה עם רינה");
});

Deno.test("renderTemplate: welcome_direct includes firstName, examples, tips, CTA", () => {
  const out = renderTemplate("welcome_direct", { firstName: "דנה" });
  // Personal greeting with name
  assertEquals(out.startsWith("היי דנה!"), true);
  // Utility enumeration (avoid the hallucination-prone "AI assistant" framing)
  assertEquals(out.includes("רשימות קניות, תזכורות, מטלות ויומן"), true);
  // Four concrete examples are present
  assertEquals(out.includes("תזכירי לי מחר ב-18:00 להתקשר לאמא"), true);
  assertEquals(out.includes("תוסיפי לקניות חלב, לחם וביצים"), true);
  assertEquals(out.includes("פגישה ביום שלישי ב-10:00 אצל הרופא"), true);
  assertEquals(out.includes("שילמתי 250"), true);
  // Forward-to-task tip (flagship feature per design §5; quoted "העבר" verb per 2026-04-19 copy review)
  assertEquals(out.includes("💡 אפשר לעשות אליי \"העבר\""), true);
  // Voice-message tip (per 2026-04-19 copy review)
  assertEquals(out.includes("🎤"), true);
  assertEquals(out.includes("להקליט לי הודעה קולית"), true);
  // Family-group CTA — new version mentions creating a new group + sparkle
  assertEquals(out.includes("תיאום בין בני הבית"), true);
  assertEquals(out.includes("צרו קבוצה חדשה"), true);
  assertEquals(out.includes("✨"), true);
});

Deno.test("renderTemplate: welcome_direct respects Meta 1024-char body limit", () => {
  const out = renderTemplate("welcome_direct", { firstName: "אבי" });
  // Meta utility template body limit is ~1024. Give ourselves headroom.
  assertEquals(out.length < 1024, true, `welcome_direct rendered to ${out.length} chars`);
});

Deno.test("TEMPLATES: no bullet characters in any body (RTL flip invariant, 2026-04-19)", () => {
  // Bullet chars like "•" flip to the visual end in WhatsApp RTL rendering
  // and feel broken to Hebrew readers. Anti-drift invariant enforced at the
  // code level so a future copy edit can't silently regress.
  const bulletChars = ["•", "●", "○", "▪", "▫", "◦"];
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    for (const bullet of bulletChars) {
      assertEquals(
        tpl.body.includes(bullet),
        false,
        `Template ${id} contains bullet char "${bullet}" — use plain newlines instead`,
      );
    }
  }
});

Deno.test("renderTemplate: welcome_group has no variables and includes examples + tips", () => {
  const out = renderTemplate("welcome_group", {});
  assertEquals(out.startsWith("שלום לכולם!"), true);
  assertEquals(out.includes("תזכירי לנו"), true);
  assertEquals(out.includes("sheli.ai"), true);
  // Forward + voice tips (2026-04-19 copy review, mirrored from welcome_direct)
  assertEquals(out.includes("💡 אפשר לעשות אליי \"העבר\""), true);
  assertEquals(out.includes("🎤"), true);
  assertEquals(out.includes("להקליט לי הודעה קולית"), true);
});

Deno.test("renderTemplate: morning_briefing substitutes summary", () => {
  const out = renderTemplate("morning_briefing", { summary: "3 מטלות ופגישה אחת" });
  assertEquals(out, "בוקר טוב! מה להיום: 3 מטלות ופגישה אחת.");
});

Deno.test("renderTemplate: number_change_notice substitutes newNumber", () => {
  const out = renderTemplate("number_change_notice", { newNumber: "+972-55-123-4567" });
  assertEquals(out.includes("+972-55-123-4567"), true);
  assertEquals(out.includes("עברתי למספר חדש"), true);
});

Deno.test("renderTemplate: rejects unknown template id", () => {
  assertThrows(() => renderTemplate("nonexistent" as TemplateId, {}));
});

Deno.test("renderTemplate: rejects missing required variable", () => {
  assertThrows(
    () => renderTemplate("reminder_fire", {}),
    Error,
    "missing variable: reminderText",
  );
});

Deno.test("TEMPLATES: every entry has body, variables array, UTILITY category, he language", () => {
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    assertEquals(typeof tpl.body, "string", `${id} body is not string`);
    assertEquals(tpl.body.length > 0, true, `${id} body is empty`);
    assertEquals(Array.isArray(tpl.variables), true, `${id} variables not array`);
    assertEquals(tpl.category, "UTILITY", `${id} category not UTILITY`);
    assertEquals(tpl.language, "he", `${id} language not he`);
    assertEquals(tpl.metaName, id, `${id} metaName doesn't match key`);
  }
});

Deno.test("TEMPLATES: no banned AI-framing terms in any body", () => {
  // Design §4 positioning: drop AI / בינה / chatbot / LLM framing.
  // Word-boundary matches only — otherwise "sheli.ai" trips the "AI" match.
  // Hebrew phrases checked as raw substrings (no word-boundary concept in
  // unpointed Hebrew).
  const bannedExact = [/\bAI\b/i, /\bLLM\b/i, /\bGPT\b/i, /\bchatbot\b/i, /\bChatGPT\b/i, /\bClaude\b/i];
  const bannedHebrew = ["בינה מלאכותית"];

  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    // Strip the sheli.ai domain before regex scan — it's not AI framing,
    // it's the product URL. (Leaves other matches intact.)
    const scanBody = tpl.body.replaceAll(/sheli\.ai/gi, "[URL]");

    for (const pattern of bannedExact) {
      assertEquals(
        pattern.test(scanBody),
        false,
        `Template ${id} contains banned term matching ${pattern}`,
      );
    }
    for (const term of bannedHebrew) {
      assertEquals(
        tpl.body.includes(term),
        false,
        `Template ${id} contains banned Hebrew term "${term}"`,
      );
    }
  }
});

Deno.test("orderedVariables: returns positional array matching template's variables declaration", () => {
  const ordered = orderedVariables("event_fire", { title: "אסיפה", delta: "30 דק'" });
  // Declaration order in TEMPLATES.event_fire: ["delta", "title"]
  assertEquals(ordered, ["30 דק'", "אסיפה"]);
});

Deno.test("orderedVariables: fills missing variables with empty string", () => {
  const ordered = orderedVariables("event_fire", { delta: "שעה" });
  assertEquals(ordered, ["שעה", ""]);
});

Deno.test("orderedVariables: welcome_group has empty array", () => {
  const ordered = orderedVariables("welcome_group", {});
  assertEquals(ordered, []);
});
