// ─────────────────────────────────────────────────────────────────────────────
// Tests for normalizeTags + mergeTagsDiff (Tier 2 retag, 2026-04-26).
//
// Run: deno test tests/merge_tags_test.ts
//
// Both functions are pure — no DB, no clock. Duplicated here from
// index.inlined.ts because Edge Function bundling forbids cross-file imports
// in the deployed file. Keep the two copies in sync.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 50);
}

function mergeTagsDiff(current: unknown, addTags?: string[], removeTags?: string[]): string[] {
  const next = new Set(normalizeTags(current));
  for (const t of normalizeTags(addTags)) next.add(t);
  for (const t of normalizeTags(removeTags)) next.delete(t);
  return Array.from(next).sort();
}

// ── Quick assert helper ──
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// ── Tests ──

Deno.test("empty current + add → result is the added tags sorted", () => {
  eq(mergeTagsDiff([], ["work"]), ["work"], "add to empty");
  eq(mergeTagsDiff([], ["amazon", "בית מרקחת"]), ["amazon", "בית מרקחת"], "two adds, hebrew sorts after latin");
});

Deno.test("remove existing tag drops it; remove non-existent is a no-op", () => {
  eq(mergeTagsDiff(["work", "home"], undefined, ["home"]), ["work"], "drop existing");
  eq(mergeTagsDiff(["work"], undefined, ["home"]), ["work"], "remove non-existent leaves array intact");
});

Deno.test("add duplicate dedupes (idempotent)", () => {
  eq(mergeTagsDiff(["work"], ["work"]), ["work"], "add already-present");
  eq(mergeTagsDiff(["work"], ["WORK"]), ["work"], "case-insensitive dedup");
  eq(mergeTagsDiff(["work"], ["  work  "]), ["work"], "whitespace-trim dedup");
});

Deno.test("normalization: lowercase + trim + drop empty + drop length>50", () => {
  eq(mergeTagsDiff([], ["  Amazon  "]), ["amazon"], "trim + lowercase");
  eq(mergeTagsDiff([], ["", "  ", "valid"]), ["valid"], "empty/whitespace-only dropped");
  const long51 = "x".repeat(51);
  eq(mergeTagsDiff([], [long51, "ok"]), ["ok"], "length>50 dropped");
});

Deno.test("add and remove with overlap: remove wins (applied last)", () => {
  // Contract: remove_tags is applied AFTER add_tags. If a tag is in both
  // arrays, the remove deletes it. This is the only sensible order — the
  // alternative ("add wins") would silently no-op every remove that was
  // also in add, which is a footgun.
  eq(mergeTagsDiff(["home"], ["work"], ["work"]), ["home"], "add+remove same tag → remove wins");
  eq(mergeTagsDiff([], ["work", "home"], ["home"]), ["work"], "add two, remove one");
});

Deno.test("non-array input returns empty (defensive)", () => {
  eq(mergeTagsDiff(null), [], "null current");
  eq(mergeTagsDiff(undefined), [], "undefined current");
  eq(mergeTagsDiff("not-an-array" as unknown), [], "string current");
  eq(mergeTagsDiff([], "not-an-array" as unknown as string[]), [], "string add_tags");
});

Deno.test("hebrew-only and mixed scripts sort deterministically", () => {
  eq(
    mergeTagsDiff([], ["עבודה", "בית", "amazon", "פרויקט הסלון"]),
    ["amazon", "בית", "עבודה", "פרויקט הסלון"],
    "Latin sorts before Hebrew, Hebrew sorts by codepoint",
  );
});
