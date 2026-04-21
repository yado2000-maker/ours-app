# 1:1 Cost Controls — Pure-Ack Haiku Routing + Bedtime Circuit Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cut 1:1 social-chat spend by 60–80% without cooling off the "Sheli feels like a friend" experience. Route pure-ack turns (laughter, emoji, ≤12-char affirmations) to Haiku with a mirror-only prompt; apply a soft bedtime circuit after 2× "לילה טוב"; both guarded by per-feature flags in `bot_settings` for instant rollback.

**Architecture:**
Two pre-Sonnet gates inserted into `handleDirectMessage` in `supabase/functions/whatsapp-webhook/index.inlined.ts`, after gender detection and before the Sonnet API call. Gate 1 (`isPureAck`) detects message text that carries no informational content and routes to a dedicated Haiku prompt focused on emoji-mirroring with zero task-pitch. Gate 2 (`isBedtimeLoop`) detects a second "לילה טוב" within 5 minutes and responds with a cheap Haiku-generated 1-line goodnight. Both gates are wrapped in feature flags read from the existing `bot_settings` table and bypassable per-deploy. Telemetry routes to `whatsapp_messages.classification` using new labels `haiku_pure_ack` and `haiku_bedtime`.

**Tech Stack:** Deno/TypeScript (Edge Function), Supabase Postgres (feature flag storage), Anthropic Haiku 4.5 (reply model), Python `tests/test_webhook.py` for integration validation.

**Scope boundaries:**
- Applies to 1:1 (`@s.whatsapp.net`) only. Groups untouched.
- Does NOT activate for `msgCount <= 2` (new users always get Sonnet welcomes).
- Does NOT activate when Haiku-classifier already flagged the message as `actionable` (pure-ack is "no content"; actionable content should always reach Sonnet).
- Stores no new DB tables. Reuses `bot_settings` key-value pattern from the outbound kill-switch.

---

## Task 1: Migration — add two feature flags to `bot_settings`

**Files:**
- Create: `supabase/migrations/2026_04_20_1on1_cost_control_flags.sql`

**Step 1: Write the migration**

```sql
-- 1:1 cost control flags — default ENABLED so the cost saving kicks in on deploy.
-- Flip either to 'false' to revert that gate's behavior (all traffic falls through to Sonnet).
INSERT INTO bot_settings (key, value) VALUES
  ('pure_ack_haiku_enabled', 'true'),
  ('bedtime_circuit_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE bot_settings IS
  'Runtime feature flags. Known keys: outbound_paused (post-ban drain gate), nudges_paused, reminders_paused, pure_ack_haiku_enabled (1:1 pure-ack → Haiku mirror reply), bedtime_circuit_enabled (1:1 "לילה טוב" loop → cheap Haiku ack).';
```

**Step 2: Apply migration**

Use MCP tool `mcp__f5337598-...__apply_migration` with name `2026_04_20_1on1_cost_control_flags` and the SQL above.

**Step 3: Verify**

Run via MCP `execute_sql`:
```sql
SELECT key, value FROM bot_settings WHERE key IN ('pure_ack_haiku_enabled', 'bedtime_circuit_enabled');
```
Expected: 2 rows, both `value='true'`.

**Step 4: Commit**

```bash
git add supabase/migrations/2026_04_20_1on1_cost_control_flags.sql
git commit -m "feat(db): 1:1 cost control flags (pure_ack, bedtime_circuit)"
```

---

## Task 2: Pure-ack detector — `isPureAck()` helper

**Files:**
- Create: `supabase/functions/_shared/pure-ack.ts` (dev reference + unit-testable module)
- Test: `tests/pure_ack_test.ts` (Deno)

**Step 1: Write the failing test**

`tests/pure_ack_test.ts`:
```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isPureAck } from "../supabase/functions/_shared/pure-ack.ts";

// Positive cases: should route to Haiku
Deno.test("isPureAck — pure laughter", () => {
  assertEquals(isPureAck("חח"), true);
  assertEquals(isPureAck("חחחח"), true);
  assertEquals(isPureAck("חחחחחחח"), true);
  assertEquals(isPureAck("lol"), true);
  assertEquals(isPureAck("😂"), true);
  assertEquals(isPureAck("😂😂😂"), true);
});

Deno.test("isPureAck — emoji-only", () => {
  assertEquals(isPureAck("💖💖"), true);
  assertEquals(isPureAck("🍿🍿🍿🍿"), true);
  assertEquals(isPureAck("❤️"), true);
  assertEquals(isPureAck("👸🏽"), true);
});

Deno.test("isPureAck — short affirmations", () => {
  assertEquals(isPureAck("סבבה"), true);
  assertEquals(isPureAck("אחלה"), true);
  assertEquals(isPureAck("יאללה"), true);
  assertEquals(isPureAck("יש"), true);
  assertEquals(isPureAck("ok"), true);
  assertEquals(isPureAck("אוקיי"), true);
  assertEquals(isPureAck("תודה"), true);
  assertEquals(isPureAck("כן"), true);
  assertEquals(isPureAck("לא"), true);
});

Deno.test("isPureAck — whitespace tolerant", () => {
  assertEquals(isPureAck("  חח  "), true);
  assertEquals(isPureAck("\nסבבה\n"), true);
});

// Negative cases: MUST fall through to Sonnet
Deno.test("isPureAck — has question mark", () => {
  assertEquals(isPureAck("חח?"), false);
  assertEquals(isPureAck("מה?"), false);
});

Deno.test("isPureAck — contains digits (price, time, qty)", () => {
  assertEquals(isPureAck("5 ש\"ח"), false);
  assertEquals(isPureAck("ב-8"), false);
});

Deno.test("isPureAck — contains action verb", () => {
  assertEquals(isPureAck("תזכירי"), false);
  assertEquals(isPureAck("תוסיפי חלב"), false);
  assertEquals(isPureAck("רשמי"), false);
  assertEquals(isPureAck("שמרי"), false);
  assertEquals(isPureAck("מחקי"), false);
});

Deno.test("isPureAck — sentence-length content", () => {
  assertEquals(isPureAck("אני עצובה היום"), false);
  assertEquals(isPureAck("משעמם לי"), false);
  assertEquals(isPureAck("את חברה שלי?"), false);
  assertEquals(isPureAck("תגידי לי בדיחה"), false);
});

Deno.test("isPureAck — empty / very short non-ack", () => {
  assertEquals(isPureAck(""), false);
  assertEquals(isPureAck("  "), false);
});

Deno.test("isPureAck — over 12 chars non-emoji", () => {
  assertEquals(isPureAck("סבבה גמור אחי"), false);
  assertEquals(isPureAck("תודה רבה לך"), false);
});
```

**Step 2: Run test — expect FAIL**

From PowerShell (Deno not in Git Bash on this machine per CLAUDE.md):
```powershell
deno test tests/pure_ack_test.ts --allow-read
```
Expected: FAIL with "module not found" / `isPureAck` undefined.

**Step 3: Write the helper**

`supabase/functions/_shared/pure-ack.ts`:
```ts
// Pure-ack detector: identifies messages that carry no informational content
// and can be handled by a cheap Haiku "emoji mirror" reply instead of Sonnet.
//
// Returns true ONLY when ALL of:
//   - Trimmed text is non-empty and ≤ 12 chars, OR is emoji-only (any length)
//   - No question mark (user wants a real answer)
//   - No Hebrew action verbs (actionable content should always reach Sonnet)
//   - No digits (prices/times/quantities are content)
//
// Kept pure + stateless so it unit-tests without DB or API.

const HEBREW_ACTION_VERBS = [
  "תזכירי", "תזכרי", "תוסיפי", "רשמי", "שמרי", "תכתבי", "מחקי",
  "תסמני", "תעדכני", "תעני", "תשלחי", "תשכחי", "תחזרי", "תבדקי",
  // Masculine variants (even though Sheli is fem, the user may write masculine when self-directing)
  "תזכיר", "תוסיף", "רשום", "שמור", "תכתוב", "מחק", "תסמן", "תעדכן",
  "להוסיף", "לרשום", "לשמור", "למחוק", "לתזכר",
];

const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const ONLY_EMOJI_WS_REGEX = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+$/u;

export function isPureAck(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Reject anything with a digit (price, time, quantity)
  if (/\d/.test(trimmed)) return false;

  // Reject anything with a question mark
  if (/[?؟]/.test(trimmed)) return false;

  // Reject if it contains a Hebrew action verb anywhere
  for (const verb of HEBREW_ACTION_VERBS) {
    if (trimmed.includes(verb)) return false;
  }

  // Emoji-only messages of any length = pure ack
  if (ONLY_EMOJI_WS_REGEX.test(trimmed)) return true;

  // Otherwise must be short (≤ 12 chars)
  if (trimmed.length > 12) return false;

  return true;
}
```

**Step 4: Run test — expect PASS**

```powershell
deno test tests/pure_ack_test.ts --allow-read
```
Expected: all 11 tests pass.

**Step 5: Commit**

```bash
git add supabase/functions/_shared/pure-ack.ts tests/pure_ack_test.ts
git commit -m "feat(bot): isPureAck detector + 11 unit tests"
```

---

## Task 3: Bedtime-loop detector — `isBedtimeLoop()` helper

**Files:**
- Create: `supabase/functions/_shared/bedtime-circuit.ts`
- Test: `tests/bedtime_circuit_test.ts`

**Step 1: Write the failing test**

`tests/bedtime_circuit_test.ts`:
```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isBedtimePhrase, isBedtimeLoop } from "../supabase/functions/_shared/bedtime-circuit.ts";

Deno.test("isBedtimePhrase — positive", () => {
  assertEquals(isBedtimePhrase("לילה טוב"), true);
  assertEquals(isBedtimePhrase("ליי לה טוב"), false); // noisy variant — keep strict
  assertEquals(isBedtimePhrase("לילה טובבב"), true);
  assertEquals(isBedtimePhrase("לילה טובב🍿"), true);
  assertEquals(isBedtimePhrase("ביוש"), true);
  assertEquals(isBedtimePhrase("לילה טוב פופי"), true);
  assertEquals(isBedtimePhrase("goodnight"), true);
  assertEquals(isBedtimePhrase("good night"), true);
  assertEquals(isBedtimePhrase("לילה טוב על אמת עכשיון"), true);
});

Deno.test("isBedtimePhrase — negative", () => {
  assertEquals(isBedtimePhrase("בוקר טוב"), false);
  assertEquals(isBedtimePhrase("לילה"), false); // bare "night" alone
  assertEquals(isBedtimePhrase("טוב"), false);
  assertEquals(isBedtimePhrase("אני עייפה"), false);
  assertEquals(isBedtimePhrase(""), false);
});

// prevMessages: chronological ascending; most recent last.
Deno.test("isBedtimeLoop — detects 2nd bedtime in 5 min", () => {
  const now = new Date("2026-04-20T21:30:00Z");
  const prev = [
    { text: "לילה טובב", created_at: "2026-04-20T21:27:30Z", sender_is_bot: false },
    { text: "לילה טוב! 🌙", created_at: "2026-04-20T21:27:45Z", sender_is_bot: true },
  ];
  assertEquals(isBedtimeLoop("לילה טוב על אמת", prev, now), true);
});

Deno.test("isBedtimeLoop — same user first bedtime = NOT a loop", () => {
  const now = new Date("2026-04-20T21:30:00Z");
  const prev = [
    { text: "חח", created_at: "2026-04-20T21:27:30Z", sender_is_bot: false },
  ];
  assertEquals(isBedtimeLoop("לילה טוב", prev, now), false);
});

Deno.test("isBedtimeLoop — bedtime > 5 min ago doesn't count", () => {
  const now = new Date("2026-04-20T21:40:00Z");
  const prev = [
    { text: "לילה טוב", created_at: "2026-04-20T21:30:00Z", sender_is_bot: false },
    { text: "לילה טוב! 🌙", created_at: "2026-04-20T21:30:15Z", sender_is_bot: true },
  ];
  assertEquals(isBedtimeLoop("לילה טוב שוב", prev, now), false);
});

Deno.test("isBedtimeLoop — current message must itself be bedtime", () => {
  const now = new Date("2026-04-20T21:30:00Z");
  const prev = [
    { text: "לילה טוב", created_at: "2026-04-20T21:27:30Z", sender_is_bot: false },
    { text: "לילה טוב!", created_at: "2026-04-20T21:27:45Z", sender_is_bot: true },
  ];
  assertEquals(isBedtimeLoop("מה נשמע", prev, now), false);
});
```

**Step 2: Run test — expect FAIL**

```powershell
deno test tests/bedtime_circuit_test.ts --allow-read
```
Expected: all tests fail (module not found).

**Step 3: Write the helper**

`supabase/functions/_shared/bedtime-circuit.ts`:
```ts
export interface PrevMessage {
  text: string;
  created_at: string;
  sender_is_bot: boolean;
}

// Bedtime phrase detection — Hebrew + English, tolerant of emoji/punctuation/name
// after the core phrase. Deliberately strict on the OPENING token so "בוקר טוב"
// doesn't match and "לילה" alone (no טוב) doesn't match.
export function isBedtimePhrase(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Hebrew: "לילה טוב" (+ tails like ב, בב, !, emoji)
  if (/לילה\s*טוב/.test(lower)) return true;
  // Slang: "ביוש" (goodnight kiddie slang, observed in real convo)
  if (/\bביוש\b/.test(lower) || lower.trim() === "ביוש" || lower.startsWith("ביוש")) return true;
  // English
  if (/\bgood\s*night\b/.test(lower) || /\bgoodnight\b/.test(lower)) return true;
  return false;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

// Returns true iff:
//   1. current message is a bedtime phrase, AND
//   2. the same user said a bedtime phrase within the past 5 minutes.
// Reads prevMessages oldest → newest. Bot messages don't count as "user bedtime".
export function isBedtimeLoop(
  currentText: string,
  prevMessages: PrevMessage[],
  now: Date,
): boolean {
  if (!isBedtimePhrase(currentText)) return false;
  const cutoff = now.getTime() - FIVE_MIN_MS;
  for (const m of prevMessages) {
    if (m.sender_is_bot) continue;
    const ts = new Date(m.created_at).getTime();
    if (ts < cutoff) continue;
    if (isBedtimePhrase(m.text)) return true;
  }
  return false;
}
```

**Step 4: Run test — expect PASS**

```powershell
deno test tests/bedtime_circuit_test.ts --allow-read
```
Expected: all tests pass.

**Step 5: Commit**

```bash
git add supabase/functions/_shared/bedtime-circuit.ts tests/bedtime_circuit_test.ts
git commit -m "feat(bot): isBedtimeLoop detector + unit tests"
```

---

## Task 4: Feature flag lookup helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add helper near the other `supabase.from("bot_settings")` reads)

**Step 1: Search for existing flag-read pattern**

```bash
grep -n "bot_settings" supabase/functions/whatsapp-webhook/index.inlined.ts | head -10
```

Identify: is there an existing `readBotSetting(key)` helper? If yes, reuse. If no, add one.

**Step 2: Add helper (if none exists)**

Near the top of the file, after the Supabase client init:

```ts
// In-memory TTL cache for bot_settings flags (10s TTL) — avoids a DB round-trip per message.
// Cache is best-effort; missing a flip for 10s is acceptable (manual SQL flip is already
// a "give it a minute" operation).
const BOT_FLAG_CACHE = new Map<string, { value: string; expires: number }>();
const FLAG_TTL_MS = 10_000;

async function readBotFlag(key: string, defaultValue: string): Promise<string> {
  const hit = BOT_FLAG_CACHE.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const { data } = await supabase.from("bot_settings").select("value").eq("key", key).maybeSingle();
    const value = data?.value ?? defaultValue;
    BOT_FLAG_CACHE.set(key, { value, expires: Date.now() + FLAG_TTL_MS });
    return value;
  } catch (e) {
    console.warn(`[bot_flag] read failed for ${key}, using default:`, e);
    return defaultValue;
  }
}
```

**Step 3: Run esbuild parse check**

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app" && npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```
Expected: parse succeeds, no errors.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): readBotFlag helper with 10s TTL cache"
```

---

## Task 5: Haiku mirror-reply generator

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add `generateHaikuMirrorReply` near existing Haiku-call code around line 7066)

**Step 1: Add the function**

```ts
// Haiku reply generator for pure-ack turns — emoji-match, warmth, NO task pitch.
// Returns null on any API failure (caller falls through to Sonnet).
async function generateHaikuMirrorReply(
  userText: string,
  userName: string,
  gender: string | null,
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const genderLine = gender === "female"
    ? "User is FEMALE. Use feminine singular (את, רוצה, תנסי, צריכה). NEVER plural."
    : gender === "male"
    ? "User is MALE. Use masculine singular (אתה, רוצה, תנסה, צריך). NEVER plural."
    : "Gender unknown. Use gender-neutral forms (לך, אותך) or plural fallback if needed.";

  const system = `You are שלי (Sheli). The user just sent a PURE ACKNOWLEDGEMENT — laughter, emoji, or a ≤12-char affirmation. They are NOT asking anything, NOT requesting a task, NOT emotional. They are maintaining warmth.

YOUR JOB: match their energy with a TINY reply. Nothing more.

STRICT RULES:
- 1 line max. Under 40 characters if possible.
- If they sent emoji, send back the SAME emoji (or a close sibling). Examples:
  - "💖💖" → "💖" or "💖✨"
  - "🍿🍿🍿" → "🍿🍿"
  - "😂" → "😂"
  - "חח" → "חח 😊" or "😂"
- If they sent a short affirmation (סבבה / אחלה / תודה / כן / ok), reply with one-word warmth: "סבבה 💛" / "אחלה" / "בכיף 😊".
- NEVER ask "רוצה עזרה?" / "צריך משהו?" / "מה לעשות?" — this is a social moment, not a support call.
- NEVER suggest tasks, shopping, reminders, events. DO NOT mention capabilities.
- NEVER re-introduce yourself.
- Hebrew feminine first-person if you refer to yourself (but usually you don't need to).
- ${genderLine}

If you're tempted to write a second line or add a task pitch, DELETE it. One line. Match the vibe. Stop.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 80,
        system,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!response.ok) {
      console.warn(`[haiku_mirror] ${response.status}`);
      return null;
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    return text || null;
  } catch (e) {
    console.warn(`[haiku_mirror] error:`, e);
    return null;
  }
}
```

**Step 2: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```
Expected: parse succeeds.

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): generateHaikuMirrorReply for pure-ack turns"
```

---

## Task 6: Haiku bedtime-ack generator

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add right below `generateHaikuMirrorReply`)

**Step 1: Add the function**

```ts
async function generateHaikuBedtimeAck(
  userName: string,
  gender: string | null,
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const genderLine = gender === "female"
    ? "User is FEMALE. Use feminine if needed (לך is fine — gender-neutral)."
    : gender === "male"
    ? "User is MALE. Use masculine if needed (לך is fine — gender-neutral)."
    : "";

  const system = `You are שלי (Sheli). The user is saying goodnight for the SECOND time in 5 minutes. They want to wrap the conversation. Respect that.

YOUR JOB: send ONE short goodnight. Done.

STRICT RULES:
- 1 line max. Under 30 characters.
- ONE emoji, maybe two.
- Examples: "לילה טוב 🌙", "לילה 💛", "שינה מתוקה ✨", "חלומות טובים 🌙".
- Optionally include user's name if short: "לילה טוב ${userName} 🌙"
- DO NOT ask questions. DO NOT offer help. DO NOT extend the goodbye.
- ${genderLine}

Send goodnight. Stop talking.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 40,
        system,
        messages: [{ role: "user", content: "[user said goodnight again]" }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    return text || null;
  } catch (e) {
    console.warn(`[haiku_bedtime] error:`, e);
    return null;
  }
}
```

**Step 2: Run esbuild parse check**

Same command as Task 5 Step 2. Expected: parse succeeds.

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): generateHaikuBedtimeAck for goodnight-loop"
```

---

## Task 7: Inline the pure-ack + bedtime modules into `index.inlined.ts`

Because Edge Functions don't support cross-function shared imports (per CLAUDE.md), copy the logic from `_shared/pure-ack.ts` and `_shared/bedtime-circuit.ts` directly into `index.inlined.ts` as sibling functions.

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (paste the two modules' contents near the other helpers, just above `generateHaikuMirrorReply`)

**Step 1: Copy pure-ack module into inlined file**

Paste the FULL body of `_shared/pure-ack.ts` (drop the `export` keyword on `isPureAck`). Place between the classifier helpers and the reply generators (approx line 3070).

**Step 2: Copy bedtime module into inlined file**

Paste the FULL body of `_shared/bedtime-circuit.ts` (drop `export`). Place directly below the pure-ack block. Also need a small helper to fetch the last 10 1:1 messages for the sliding window:

```ts
async function fetchRecent1on1ForBedtime(phone: string, limitMinutes: number = 5): Promise<PrevMessage[]> {
  const cutoff = new Date(Date.now() - limitMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("message_text, created_at, sender_phone")
    .eq("group_id", phone)  // 1:1 stores bare phone (not JID) in group_id per CLAUDE.md
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error || !data) return [];
  const BOT_PHONE = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  return data.map((r: any) => ({
    text: r.message_text || "",
    created_at: r.created_at,
    sender_is_bot: r.sender_phone === BOT_PHONE,
  }));
}
```

**Step 3: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```
Expected: parse succeeds.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): inline pure-ack + bedtime-circuit modules"
```

---

## Task 8: Wire gates into `handleDirectMessage`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` in `handleDirectMessage`, inserted after gender resolution (~line 4471) and BEFORE `const contextBlock = ...` (~line 4481).

**Step 1: Find insertion point**

```bash
grep -n "if (userGender && userGender !== convo.context" supabase/functions/whatsapp-webhook/index.inlined.ts
```
Identify the line number immediately after gender-storage block.

**Step 2: Insert gate logic**

```ts
  // ─── COST CONTROL GATES (pre-Sonnet) ─────────────────────────────────────
  // Skip gates for msg #1 and #2 (new users always get Sonnet welcome)
  // and for actionable Haiku classifications.
  const costGatesEligible = msgCount >= 3;

  if (costGatesEligible) {
    // Gate 2: bedtime circuit (runs first because it's a sliding-window check)
    const bedtimeEnabled = await readBotFlag("bedtime_circuit_enabled", "true");
    if (bedtimeEnabled === "true" && isBedtimePhrase(text)) {
      const recent = await fetchRecent1on1ForBedtime(phone, 5);
      if (isBedtimeLoop(text, recent, new Date())) {
        const ack = await generateHaikuBedtimeAck(userName, userGender);
        if (ack) {
          await logMessage(message, "received_1on1", convo.household_id || "unknown");
          await sendAndLog(prov, { groupId: message.groupId, text: ack }, {
            householdId: convo.household_id || "unknown",
            groupId: message.groupId,
            inReplyTo: message.messageId,
            replyType: "haiku_bedtime",
          });
          console.log(`[1:1][haiku_bedtime] ${phone} → "${ack}"`);
          return;
        }
        // Haiku failed → fall through to Sonnet
      }
    }

    // Gate 1: pure-ack
    const pureAckEnabled = await readBotFlag("pure_ack_haiku_enabled", "true");
    if (pureAckEnabled === "true" && isPureAck(text)) {
      const reply = await generateHaikuMirrorReply(text, userName, userGender);
      if (reply) {
        await logMessage(message, "received_1on1", convo.household_id || "unknown");
        await sendAndLog(prov, { groupId: message.groupId, text: reply }, {
          householdId: convo.household_id || "unknown",
          groupId: message.groupId,
          inReplyTo: message.messageId,
          replyType: "haiku_pure_ack",
        });
        console.log(`[1:1][haiku_pure_ack] ${phone} "${text}" → "${reply}"`);
        return;
      }
      // Haiku failed → fall through to Sonnet
    }
  }
  // ─── END COST CONTROL GATES ──────────────────────────────────────────────

  // Build context for Sonnet
  const contextBlock = `...` // (existing code continues)
```

**Step 3: Run esbuild parse check**

Same command. Expected: parse succeeds.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): wire pure-ack + bedtime gates into handleDirectMessage"
```

---

## Task 9: Classification labels — document new telemetry

**Files:**
- Modify: `CLAUDE.md` — update the "Classification values" section

**Step 1: Find section**

Search for `### Classification values in \`whatsapp_messages.classification\``.

**Step 2: Add new labels**

Append to the list:
- `haiku_pure_ack` — Haiku-generated mirror reply for low-content 1:1 turns (≤12 chars, no ?, no digits, no action verbs)
- `haiku_bedtime` — Haiku-generated goodnight ack after 2× bedtime phrase in 5 min

**Step 3: Also update the bot `replyType` list**

Append `haiku_pure_ack`, `haiku_bedtime` to the "Bot reply `replyType` labels" list.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document haiku_pure_ack + haiku_bedtime classifications"
```

---

## Task 10: Integration smoke tests

**Files:**
- Modify: `tests/test_webhook.py` (add 4 new cases)

**Step 1: Identify the test harness pattern**

```bash
grep -n "def test_\|add_case\|TEST_CASES" tests/test_webhook.py | head -20
```
Match the existing pattern (likely a list of dicts with `input`, `expected_classification`, `db_check`).

**Step 2: Add 4 cases**

```python
# --- Pure-ack gate ---
{
    "category": "CostControls",
    "name": "pure_ack_laughter",
    "phone": "972500000001",  # synthetic test phone
    "input": "חח",
    "warmup": ["היי", "מה קורה", "תודה שאת פה"],  # 3 prior msgs → msgCount >= 3
    "expected_classification": "haiku_pure_ack",
    "reply_pattern": r"^.{1,60}$",  # short reply
},
{
    "category": "CostControls",
    "name": "pure_ack_emoji_only",
    "phone": "972500000002",
    "input": "💖💖",
    "warmup": ["היי", "סבבה", "מעולה"],
    "expected_classification": "haiku_pure_ack",
    "reply_pattern": r".*[💖💕❤️✨🌸]",  # should echo heart energy
},

# --- Bedtime circuit ---
{
    "category": "CostControls",
    "name": "bedtime_first_time_not_circuit",
    "phone": "972500000003",
    "input": "לילה טוב",
    "warmup": ["היי", "מה קורה", "יום ארוך היום"],
    "expected_classification": "direct_reply",  # first bedtime = Sonnet normal
},
{
    "category": "CostControls",
    "name": "bedtime_loop_triggers_circuit",
    "phone": "972500000004",
    "input": "לילה טוב שוב",
    "warmup": ["היי", "מה קורה", "לילה טוב"],  # bedtime in last 5 min
    "expected_classification": "haiku_bedtime",
    "reply_pattern": r"^.{1,50}$",  # terse
},
```

Note: the `warmup` pattern requires the test harness to send N priming messages before the asserted one. If the harness doesn't support that, add a `warmup_messages` field and extend the runner to POST them sequentially, waiting for DB insert confirmation between sends.

**Step 3: Run integration tests against deployed Edge Function**

```bash
python tests/test_webhook.py --category CostControls
```
Expected: 4 pass after deploy (run AFTER Task 11, not before).

**Step 4: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(bot): integration cases for haiku_pure_ack + haiku_bedtime"
```

---

## Task 11: Deploy + live monitoring

**Files:**
- None (operational step)

**Step 1: Final esbuild parse check on `index.inlined.ts`**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```
Expected: parse succeeds, bundle size ~455–460 KB.

**Step 2: Deploy via Supabase Dashboard**

1. Open `supabase/functions/whatsapp-webhook/index.inlined.ts` in Cursor.
2. Ctrl+A, Ctrl+C.
3. Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab.
4. Paste. Ensure Settings → Verify JWT is OFF.
5. Click Deploy.

**Step 3: Verify flags are enabled**

Via MCP `execute_sql`:
```sql
SELECT key, value FROM bot_settings WHERE key IN ('pure_ack_haiku_enabled', 'bedtime_circuit_enabled');
```
Both should be `'true'`.

**Step 4: 30-minute live watch**

Query every few minutes:
```sql
SELECT classification, COUNT(*)
FROM whatsapp_messages
WHERE created_at >= NOW() - INTERVAL '30 minutes'
  AND classification IN ('haiku_pure_ack', 'haiku_bedtime', 'direct_reply', 'received_1on1')
GROUP BY classification
ORDER BY COUNT(*) DESC;
```
Expected: `haiku_pure_ack` appears organically (not zero) and `direct_reply` count drops compared to baseline. No error spikes in Edge Function logs.

**Step 5: Cost sanity check after 24h**

```sql
-- Approximate: count 1:1 bot replies by classification over the last 24h
SELECT
  CASE
    WHEN classification IN ('haiku_pure_ack','haiku_bedtime') THEN 'haiku_gated'
    WHEN classification = 'direct_reply' THEN 'sonnet_1on1'
    ELSE 'other'
  END AS bucket,
  COUNT(*) AS replies
FROM whatsapp_messages
WHERE sender_phone = '972555175553'
  AND created_at >= NOW() - INTERVAL '24 hours'
GROUP BY bucket;
```
Target: `haiku_gated` ≥ 20% of 1:1 bot replies within a week (heavy kid-chatter households will push higher).

**Step 6: Rollback procedure (document, don't execute)**

If the Haiku voice reads as too cold in the wild:
```sql
UPDATE bot_settings SET value='false' WHERE key='pure_ack_haiku_enabled';
UPDATE bot_settings SET value='false' WHERE key='bedtime_circuit_enabled';
```
Cache TTL is 10s → within seconds all 1:1 traffic falls back to Sonnet.

**Step 7: Commit any docs changes from monitoring**

If the monitoring queries produce insights worth keeping, add them to `CLAUDE.md` or a follow-up memory note.

---

## Open Questions / Future Iterations

**Not in this plan — revisit after a week of live data:**

1. **Daily Sonnet budget.** Currently skipped. If a subset of users routes 30+ Sonnet calls/day after pure-ack gate kicks in (i.e. they send mostly question-bearing chatter, not acks), add a `social_budget_per_day` flag.
2. **Kid/teen detection.** Out of scope; no reliable signal without asking age. Could be added later via explicit household metadata (parents tag kid phones).
3. **"Lonely user" detection.** If analytics shows a single user sending 50+ messages/day with 0 tasks for 2+ weeks, Sheli could proactively soft-redirect ("אני לא תרפיסטית מקצועית, אבל אם בא לך משהו קל — תגידי לי"). Sensitive — park for product discussion.
4. **Haiku prompt tuning.** After live data, iterate on emoji-mirror examples in `generateHaikuMirrorReply` prompt based on real "too cold" cases. No code change, just prompt text.

---

**Plan complete and saved to `docs/plans/2026-04-20-1on1-cost-controls-plan.md`.**
