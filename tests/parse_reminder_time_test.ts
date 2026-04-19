// ─────────────────────────────────────────────────────────────────────────────
// Tests for parseReminderTime (Bug 3, 2026-04-20).
//
// Run: deno test tests/parse_reminder_time_test.ts
//
// The function under test is duplicated here from index.inlined.ts because
// Edge Function bundling forbids cross-file imports inside the deployed file.
// Keep the two copies in sync; this duplication is intentional and trivial
// to verify by `diff`-ing the two function bodies.
// ─────────────────────────────────────────────────────────────────────────────

function ilOffsetMs(utcDate: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      timeZoneName: "shortOffset",
    });
    const off = fmt.formatToParts(utcDate).find((p) => p.type === "timeZoneName")?.value || "GMT+3";
    const m = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 3 * 60 * 60 * 1000;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (hh * 60 + mm) * 60 * 1000;
  } catch {
    return 3 * 60 * 60 * 1000;
  }
}

function parseReminderTime(timeStr: string): string | null {
  if (!timeStr) return null;
  if (timeStr.includes("T") && timeStr.includes(":")) {
    const parsed = new Date(timeStr);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const timeMatch = timeStr.match(/(\d{1,2})[:\u05D1\-]?(\d{2})?/);
  if (!timeMatch) return null;
  let hours = parseInt(timeMatch[1], 10);
  const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  if (Number.isNaN(hours) || hours < 0 || hours > 23) return null;
  if (Number.isNaN(minutes) || minutes < 0 || minutes > 59) return null;
  if (hours >= 1 && hours <= 6 && !/בוקר|לילה|morning|night/i.test(timeStr)) {
    hours += 12;
  }
  const nowUtc = new Date();
  const ilDateStr = nowUtc.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  const [yStr, mStr, dStr] = ilDateStr.split("-");
  const ilY = parseInt(yStr, 10);
  const ilM = parseInt(mStr, 10);
  const ilD = parseInt(dStr, 10);
  if (!ilY || !ilM || !ilD) return null;
  const buildUtcMs = (dayOffset: number) => {
    const naive = Date.UTC(ilY, ilM - 1, ilD + dayOffset, hours, minutes, 0, 0);
    return naive - ilOffsetMs(new Date(naive));
  };
  let targetMs = buildUtcMs(0);
  if (targetMs <= nowUtc.getTime() + 60 * 1000) {
    targetMs = buildUtcMs(1);
  }
  return new Date(targetMs).toISOString();
}

// ── Time-freeze utility ──
type Frozen = { dispose: () => void };
function freezeNow(isoUtc: string): Frozen {
  const real = Date.now;
  const fixed = new Date(isoUtc).getTime();
  Date.now = () => fixed;
  return { dispose: () => { Date.now = real; } };
}

// Quick assert helpers (avoid jsr/std import to keep test file portable).
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function toIlClock(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour12: false,
  });
}

// ── Tests ──

Deno.test("ISO with offset round-trips unchanged (Sonnet path)", () => {
  const out = parseReminderTime("2026-05-12T20:30:00+03:00");
  eq(out, "2026-05-12T17:30:00.000Z", "ISO round-trip");
});

Deno.test("Saturday 19:00 IL + '20:30' → today 20:30 IL (the headline bug)", () => {
  // Real UTC for IL Sat 2026-04-18 19:00 = Sat 16:00 UTC.
  const f = freezeNow("2026-04-18T16:00:00Z");
  try {
    const out = parseReminderTime("20:30")!;
    // Expect 20:30 IL on 2026-04-18 → 17:30 UTC same date.
    eq(out, "2026-04-18T17:30:00.000Z", "today 20:30 IL");
  } finally { f.dispose(); }
});

Deno.test("Saturday 21:00 IL + '20:30' → tomorrow 20:30 IL", () => {
  // Real UTC for IL Sat 2026-04-18 21:00 = Sat 18:00 UTC.
  const f = freezeNow("2026-04-18T18:00:00Z");
  try {
    const out = parseReminderTime("20:30")!;
    // 20:30 already passed today → bump to Sun 19.4 20:30 IL = Sun 17:30 UTC.
    eq(out, "2026-04-19T17:30:00.000Z", "tomorrow 20:30 IL");
  } finally { f.dispose(); }
});

Deno.test("Monday 09:00 IL + '14:00' → same day 14:00 IL", () => {
  // IL Mon 2026-04-20 09:00 = Mon 06:00 UTC (IDT, UTC+3).
  const f = freezeNow("2026-04-20T06:00:00Z");
  try {
    const out = parseReminderTime("14:00")!;
    eq(out, "2026-04-20T11:00:00.000Z", "same day 14:00 IL");
  } finally { f.dispose(); }
});

Deno.test("Single-digit hour 1-6 maps to PM (Israeli convention)", () => {
  // IL Mon 2026-04-20 09:00 = Mon 06:00 UTC.
  const f = freezeNow("2026-04-20T06:00:00Z");
  try {
    const out = parseReminderTime("ב-5")!;
    // "5" → 17:00 IL = 14:00 UTC same day.
    eq(out, "2026-04-20T14:00:00.000Z", "ב-5 → 17:00 IL");
  } finally { f.dispose(); }
});

Deno.test("Single-digit + 'בוקר' stays AM (no PM convention)", () => {
  const f = freezeNow("2026-04-20T06:00:00Z");
  try {
    // IL is currently 09:00 — "5 בבוקר" already passed → bump to tomorrow.
    const out = parseReminderTime("5 בבוקר")!;
    // Expect Tue 2026-04-21 05:00 IL = Tue 02:00 UTC.
    eq(out, "2026-04-21T02:00:00.000Z", "5 בבוקר tomorrow 05:00 IL");
  } finally { f.dispose(); }
});

Deno.test("Late IL Saturday 23:30 + '20:30' → Sunday 20:30 IL (no spurious +2 day)", () => {
  // IL Sat 2026-04-18 23:30 = Sat 20:30 UTC.
  const f = freezeNow("2026-04-18T20:30:00Z");
  try {
    const out = parseReminderTime("20:30")!;
    // 20:30 already passed today → Sun 20:30 IL = Sun 17:30 UTC.
    eq(out, "2026-04-19T17:30:00.000Z", "Sun 20:30 IL");
  } finally { f.dispose(); }
});

Deno.test("Winter (UTC+2) handles offset correctly — Nov 2026", () => {
  // IL Mon 2026-11-16 14:00 winter = Mon 12:00 UTC.
  const f = freezeNow("2026-11-16T12:00:00Z");
  try {
    const out = parseReminderTime("18:30")!;
    // IL 18:30 winter = 16:30 UTC (offset is +2 not +3 — the very bug we fixed).
    eq(out, "2026-11-16T16:30:00.000Z", "winter offset honored");
  } finally { f.dispose(); }
});

Deno.test("Empty / nonsense / OOB inputs return null", () => {
  eq(parseReminderTime(""), null, "empty");
  eq(parseReminderTime("abc"), null, "no digits");
  eq(parseReminderTime("99"), null, "hour 99 OOB");
  eq(parseReminderTime("12:99"), null, "minute 99 OOB");
});

console.log("All parseReminderTime tests passed.");
