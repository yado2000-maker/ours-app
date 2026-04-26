// ─────────────────────────────────────────────────────────────────────────────
// Tests for stripUnterminatedMetaBlocks (2026-04-26 Netzer leak guardrail).
//
// Run: deno test tests/strip_unterminated_meta_test.ts
//
// The function under test is duplicated here from index.inlined.ts because
// Edge Function bundling forbids cross-file imports. Keep the two copies in
// sync; the body is trivially short.
//
// Repro: Sonnet emitted <!--ACTIONS:[{...},{...},...]--> with 6 recurring_reminder
// objects. max_tokens cut off mid-fourth object at "[0,2," with no closing -->.
// The terminator-required strip-regexes all missed it, so the raw JSON leaked
// to the user as visible WhatsApp text. This helper runs AFTER all
// terminator-required strippers — at that point any remaining "<!--XXX:" opener
// is by definition unterminated and gets nuked to end-of-string.
// ─────────────────────────────────────────────────────────────────────────────

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

function stripUnterminatedMetaBlocks(s: string): string {
  return s.replace(/<!--\s*[A-Z][A-Z_]*\s*:[\s\S]*$/, "").trimEnd();
}

Deno.test("strips unterminated <!--ACTIONS: block (truncation repro)", () => {
  const leaked = `<!--ACTIONS:[{"type":"recurring_reminder","text":"עופרי","days":[0,2,4,6],"time":"14:00"},{"type":"recurring_reminder","text":"...","days":[0,2,`;
  assertEquals(stripUnterminatedMetaBlocks(leaked), "");
});

Deno.test("strips unterminated block but keeps preceding visible text", () => {
  const input = `אזכיר ✓ <!--ACTIONS:[{"type":"reminder","text":"x"`;
  assertEquals(stripUnterminatedMetaBlocks(input), "אזכיר ✓");
});

Deno.test("strips unterminated <!--REMINDER: block", () => {
  const input = `רשמתי\n<!--REMINDER:{"reminder_text":"להביא חלב","send_at":"2026-04-`;
  assertEquals(stripUnterminatedMetaBlocks(input), "רשמתי");
});

Deno.test("strips unterminated <!--RECURRING_REMINDER: block", () => {
  const input = `אזכיר כל שני <!--RECURRING_REMINDER:{"reminder_text":"x","days":[1`;
  assertEquals(stripUnterminatedMetaBlocks(input), "אזכיר כל שני");
});

Deno.test("idempotent on already-clean text", () => {
  const input = "רשמתי ✓";
  assertEquals(stripUnterminatedMetaBlocks(input), "רשמתי ✓");
});

Deno.test("idempotent on empty string", () => {
  assertEquals(stripUnterminatedMetaBlocks(""), "");
});

Deno.test("does not touch lowercase/HTML-like comments (defensive scope)", () => {
  // Pattern requires uppercase/underscore name. Lowercase or mixed never matches.
  const input = "see <!--note: this is fine-->";
  assertEquals(stripUnterminatedMetaBlocks(input), "see <!--note: this is fine-->");
});

Deno.test("does not touch chat text containing '<!--' alone", () => {
  const input = "what is <!-- this thing?";
  assertEquals(stripUnterminatedMetaBlocks(input), "what is <!-- this thing?");
});

Deno.test("real-world Netzer 2026-04-26 leak shape", () => {
  const leaked = `<!--ACTIONS:[{"type":"recurring_reminder","text":"עופרי — להוציא את ליאו לטיול 🐕","days":[0,2,4,6],"time":"14:00"},{"type":"recurring_reminder","text":"...","days":[0,2,`;
  assertEquals(stripUnterminatedMetaBlocks(leaked), "");
});

Deno.test("preserves text before block and trims trailing whitespace", () => {
  const input = "אזכיר ✓   \n  <!--ACTIONS:[{";
  assertEquals(stripUnterminatedMetaBlocks(input), "אזכיר ✓");
});
