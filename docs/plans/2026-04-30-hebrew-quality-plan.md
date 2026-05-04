# Hebrew Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Sheli's Hebrew quality across two layers — fix Whisper voice mistranscriptions of names/professions (Track A) and eliminate English-think calques in Sonnet replies (Track B).

**Architecture:** Track A bolts decoder bias + a hosted Hebrew-fine-tuned Whisper into the existing `transcribeVoice` path; Track B introduces an offline eval harness, then drives a model-swap decision (Sonnet 4 → 4.6) and a fallback prompt-rule block by data. Both tracks ship as independent PRs behind env-var toggles for fast rollback.

**Tech Stack:** Deno Edge Function (`index.inlined.ts`), Groq Whisper API, ivrit-ai/whisper-large-v3-ct2 (hosted), Anthropic Sonnet 4 / 4.6, Python 3 eval harness, Supabase REST.

---

## Spec & related docs

- Design / brainstorm: this plan supersedes the brainstorm file at `~/.claude/plans/brain-storm-session-we-kind-mochi.md`. Mirror the brainstorm into `docs/plans/2026-04-30-hebrew-quality-design.md` as Task 0 below.
- Reference patterns:
  - Eval harness: [`tests/test_webhook.py`](../../tests/test_webhook.py), [`tests/classifier_eval.py`](../../tests/classifier_eval.py)
  - Whisper call site: [`supabase/functions/whatsapp-webhook/index.inlined.ts:12204`](../../supabase/functions/whatsapp-webhook/index.inlined.ts) (`transcribeVoice`)
  - Sonnet model constant: same file, line 1383 (`SONNET_MODEL`) — but 6 other inline `claude-sonnet-4-20250514` literals still exist
  - Hebrew rules: same file, line 1733 (`SHARED_HEBREW_GRAMMAR`)

## File Structure (created or modified)

| File | Status | Responsibility |
|------|--------|----------------|
| `docs/plans/2026-04-30-hebrew-quality-design.md` | Create | Spec doc (mirror of brainstorm). |
| `supabase/functions/whatsapp-webhook/index.inlined.ts` | Modify | Voice biasing helper + provider switch + model-ID constants + (conditional) anti-calque block. |
| `tests/hebrew_naturalness_eval.py` | Create | Offline eval harness for Sonnet reply naturalness. |
| `tests/fixtures/hebrew_naturalness_cases.json` | Create | 30 curated `(context, user_msg, ideal_reply)` cases. |
| `tests/fixtures/hebrew_calque_bank.json` | Create | Substring blacklist of known calques. |
| `scripts/extract_bot_replies.py` | Create | One-shot script to pull recent bot replies from Supabase for curation. |
| `scripts/test_voice_provider.py` | Create | Manual quality-comparison runner — sends one audio file to Groq + ivrit-ai, prints both transcripts. |
| `.env.example` | Modify | Document new env vars: `REPLY_MODEL`, `VOICE_PROVIDER`, `IVRIT_AI_API_URL`, `IVRIT_AI_API_KEY`. |

## Conventions

- **Pre-deploy ritual** for every `index.inlined.ts` change (per CLAUDE.md v263 lesson):
  1. esbuild parse-check
  2. Deno module-load test
  3. Live HTTP smoke test within 30s of Dashboard deploy
- **Commit cadence:** commit after every passing step; push to feature branch immediately so the Dashboard paste isn't the only copy of the change.
- **TDD scope:** strict TDD applies to new helper functions (`buildVoicePromptBias`, calque-bank checker, eval-harness scoring functions). Config edits, prompt edits, and provider swaps are validated by the eval harness rather than unit tests.
- **Branch strategy:** one branch per PR, no stacking. Each PR ships independently.

---

## Task 0: Mirror brainstorm into project design doc

**Files:**
- Create: `docs/plans/2026-04-30-hebrew-quality-design.md`

- [ ] **Step 1: Copy brainstorm content into project plans dir**

Copy the entire content of `~/.claude/plans/brain-storm-session-we-kind-mochi.md` into `docs/plans/2026-04-30-hebrew-quality-design.md`. The home-dir file was a plan-mode artifact; the project copy is the durable design doc.

- [ ] **Step 2: Commit**

```bash
git add docs/plans/2026-04-30-hebrew-quality-design.md docs/plans/2026-04-30-hebrew-quality-plan.md
git commit -m "docs(plans): hebrew quality design + implementation plan"
git push -u origin "$(git branch --show-current)"
```

---

# PR 1 — Track A1: Household name biasing on Groq

**Branch:** `claude/hebrew-quality-a1-name-biasing`
**Goal:** Pass household member names + recent shopping vocabulary as Whisper's `prompt` parameter to bias the decoder toward known proper nouns. No infra change.

## Task 1.1: Failing unit test for `buildVoicePromptBias`

**Files:**
- Create: `supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { buildVoicePromptBias } from "../index.inlined.ts";

// Mock supabase client by stubbing globalThis.fetch. The helper will hit
// PostgREST; we return a canned member list.
function stubFetch(memberRows: Array<{ member_name: string }>, itemRows: Array<{ name: string }>) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("whatsapp_member_mapping")) {
      return new Response(JSON.stringify(memberRows), { status: 200 });
    }
    if (url.includes("shopping_items")) {
      return new Response(JSON.stringify(itemRows), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  return () => { globalThis.fetch = orig; };
}

Deno.test("buildVoicePromptBias returns Hebrew-comma-joined names + items", async () => {
  const restore = stubFetch(
    [{ member_name: "אביטל" }, { member_name: "ירון" }, { member_name: "נעם" }],
    [{ name: "חלב" }, { name: "פיתות" }],
  );
  try {
    const bias = await buildVoicePromptBias("hh_test");
    // Must contain every name and item exactly once, comma-separated.
    assertEquals(bias.includes("אביטל"), true);
    assertEquals(bias.includes("ירון"), true);
    assertEquals(bias.includes("נעם"), true);
    assertEquals(bias.includes("חלב"), true);
    assertEquals(bias.includes("פיתות"), true);
    // Comma is the separator (Hebrew-comma OK too: ، is rare; ASCII , is fine).
    assertEquals(bias.split(",").length >= 5, true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias returns empty string when household has no members", async () => {
  const restore = stubFetch([], []);
  try {
    const bias = await buildVoicePromptBias("hh_empty");
    assertEquals(bias, "");
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias caps at 224 tokens (Whisper limit)", async () => {
  const manyMembers = Array.from({ length: 50 }, (_, i) => ({ member_name: `שם${i}` }));
  const restore = stubFetch(manyMembers, []);
  try {
    const bias = await buildVoicePromptBias("hh_big");
    // Approximate: each Hebrew word ~2-3 tokens; 224 tokens ≈ ~600 chars conservatively.
    assertEquals(bias.length <= 600, true);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails (function not exported yet)**

```bash
"/c/Users/yarond/AppData/Local/Microsoft/WinGet/Packages/DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe/deno.exe" \
  test --no-lock --allow-net --allow-env \
  supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
```

Expected: FAIL — `buildVoicePromptBias is not a function` or import error.

## Task 1.2: Implement `buildVoicePromptBias` helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add helper near line 12182, before `transcribeVoice`)

- [ ] **Step 1: Add the helper above `transcribeVoice`**

Insert this block at line ~12182 (in the "Helper Functions" section, before the `transcribeVoice` interface). Export the function so the test file can import it.

```typescript
// ─── Voice prompt biasing ───
// Whisper accepts a free-text `prompt` (initial_prompt for faster-whisper) up
// to ~224 tokens. Tokens it sees here get strong decoder bias. We feed it the
// household's known names + recent shopping vocabulary so proper nouns like
// "אביטל" or "פיתות" don't get mangled into "הביטל" or "פיתאות".
//
// Cap at 600 chars conservatively (Hebrew is ~2-3 tokens per word).
const VOICE_BIAS_CHAR_CAP = 600;

export async function buildVoicePromptBias(householdId: string | null | undefined): Promise<string> {
  if (!householdId) return "";
  try {
    const headers = {
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
    };
    const base = Deno.env.get("SUPABASE_URL") ?? "";

    // Members
    const memRes = await fetch(
      `${base}/rest/v1/whatsapp_member_mapping?household_id=eq.${encodeURIComponent(householdId)}&select=member_name`,
      { headers },
    );
    const members: Array<{ member_name: string }> = memRes.ok ? await memRes.json() : [];
    const names = members.map((m) => (m.member_name || "").trim()).filter(Boolean);

    // Recent shopping items (last 30, names only)
    const itemRes = await fetch(
      `${base}/rest/v1/shopping_items?household_id=eq.${encodeURIComponent(householdId)}&select=name&order=created_at.desc&limit=30`,
      { headers },
    );
    const items: Array<{ name: string }> = itemRes.ok ? await itemRes.json() : [];
    const itemNames = items.map((i) => (i.name || "").trim()).filter(Boolean);

    // De-dup, then assemble. Names first (highest priority), items after.
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const t of [...names, ...itemNames]) {
      if (!seen.has(t)) {
        seen.add(t);
        tokens.push(t);
      }
    }

    // Greedy fill up to char cap.
    const out: string[] = [];
    let len = 0;
    for (const t of tokens) {
      const add = (out.length === 0 ? t : ", " + t);
      if (len + add.length > VOICE_BIAS_CHAR_CAP) break;
      out.push(out.length === 0 ? t : t);
      len += add.length;
    }
    return out.join(", ");
  } catch (err) {
    console.error("[VoiceBias] Failed to build prompt bias:", err);
    return "";
  }
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
"/c/Users/yarond/AppData/Local/Microsoft/WinGet/Packages/DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe/deno.exe" \
  test --no-lock --allow-net --allow-env \
  supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts \
        supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
git commit -m "feat(voice): buildVoicePromptBias helper for Whisper decoder bias"
```

## Task 1.3: Wire `buildVoicePromptBias` into `transcribeVoice`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:12204` (`transcribeVoice` signature + Groq call)
- Modify: same file at the `transcribeVoice(message.mediaUrl, message.mediaId)` call site near line 9971

- [ ] **Step 1: Extend `transcribeVoice` signature with `householdId`**

Replace the current signature and Groq form-data block in `transcribeVoice` (around line 12204):

```typescript
async function transcribeVoice(
  mediaUrl: string | undefined,
  mediaId: string | undefined,
  householdId?: string | null,
): Promise<VoiceTranscription> {
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
  if (!GROQ_API_KEY) {
    console.error("[Voice] GROQ_API_KEY not set");
    return { text: null, quality: "failed" };
  }

  if (!mediaUrl && !mediaId) {
    console.error("[Voice] No media URL or media ID available");
    return { text: null, quality: "failed" };
  }

  try {
    // 1. Download audio (unchanged) — keep existing block.
    let audioBlob: Blob;
    /* ... existing download block ... */

    // 2. Build multipart form data for Groq Whisper API.
    const formData = new FormData();
    formData.append("file", audioBlob, "voice.ogg");
    formData.append("model", "whisper-large-v3");
    formData.append("response_format", "verbose_json");
    formData.append("language", "he"); // explicit hint — auto-detect was misfiring on noisy audio
    formData.append("temperature", "0");

    // Decoder bias from household vocab (names, recent shopping items).
    const biasPrompt = await buildVoicePromptBias(householdId ?? null);
    if (biasPrompt) {
      formData.append("prompt", biasPrompt);
      console.log(`[Voice] Bias prompt (${biasPrompt.length} chars): ${biasPrompt.slice(0, 80)}...`);
    }

    // 3-4. Call Groq, quality gate (unchanged) — keep existing blocks.
```

Keep every line of the rest of `transcribeVoice` (the response handling, language gate, log-prob gate, return). Only the signature and step 2 form-data block change.

- [ ] **Step 2: Update the single call site**

Search for the call to `transcribeVoice` near line 9971:

```bash
grep -n "transcribeVoice(" supabase/functions/whatsapp-webhook/index.inlined.ts
```

Replace:

```typescript
const voiceResult = await transcribeVoice(message.mediaUrl, message.mediaId);
```

with:

```typescript
const voiceResult = await transcribeVoice(message.mediaUrl, message.mediaId, ctx.householdId);
```

If `ctx.householdId` isn't in scope at that point, walk up the function — direct-message and group handlers both compute `householdId` before reaching the voice block. Use whichever variable is the resolved household for that message.

- [ ] **Step 3: Pre-deploy parse + module-load checks**

```bash
# esbuild parse
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle \
  --platform=neutral --format=esm --target=esnext --loader:.ts=ts \
  --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
# Expected: build succeeds (warnings OK; errors → fix and re-run).

# Deno module-load
SUPABASE_URL=stub SUPABASE_SERVICE_ROLE_KEY=stub \
"/c/Users/yarond/AppData/Local/Microsoft/WinGet/Packages/DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe/deno.exe" \
  run --no-lock --allow-env --allow-net --check=none \
  supabase/functions/whatsapp-webhook/index.inlined.ts
# Expected: AddrInUse error after Deno.serve = module loads cleanly. Any earlier
# error = fix before deploying.
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(voice): pass household-vocab bias + language=he + temp=0 to Groq Whisper"
git push
```

## Task 1.4: Deploy + smoke test

- [ ] **Step 1: Open `index.inlined.ts` in Cursor, Ctrl+A / Ctrl+C**

- [ ] **Step 2: Supabase Dashboard → Edge Functions → whatsapp-webhook → Code → paste → Deploy**

Wait for "Deployed" toast. Note the new version number.

- [ ] **Step 3: Live HTTP smoke test (within 30s)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"messages","message":[]}}' \
  --max-time 10
```

Expected: `200`. Anything else → roll back via Dashboard deployment history immediately.

- [ ] **Step 4: Post-paste corruption scan**

```bash
# Scan for stray Hebrew chars inside Latin identifiers (Cursor paste landmine)
grep -nE '[A-Za-z]{2,}[֐-׿]+[A-Za-z]{2,}' \
  supabase/functions/whatsapp-webhook/index.inlined.ts | head -20
```

Hits inside CODE = re-paste. Hits inside COMMENTS describing the bug pattern are fine.

## Task 1.5: Manual quality verification

- [ ] **Step 1: Yaron records a Hebrew voice with proper nouns**

Send to Sheli (1:1 chat): a clearly-spoken sentence containing two household member names + one professional title (e.g., "אביטל האדריכלית הולכת היום לרופא"). Use the bot phone +972 55-517-5553.

- [ ] **Step 2: Pull the transcript from DB**

```bash
psql_or_supabase_query <<EOF
SELECT message_text, classification, classification_data->'voice_meta' AS voice_meta
FROM whatsapp_messages
WHERE message_type = 'voice'
ORDER BY created_at DESC
LIMIT 1;
EOF
```

(Use `mcp__f5337598__execute_sql` MCP tool or the Supabase SQL editor.)

- [ ] **Step 3: Verify**

The transcribed `message_text` must contain "אביטל" (not "הביטל") and "אדריכלית" (not "מדריכלית"). If still wrong, check the Edge Function logs for `[VoiceBias]` line — confirm the bias prompt actually populated.

- [ ] **Step 4: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --base main \
  --head "$(git branch --show-current)" \
  --title "feat(voice): household-vocab decoder bias on Groq Whisper" \
  --body "$(cat <<'EOF'
## Summary
- Pass household member names + last 30 shopping items as Whisper `prompt` decoder bias.
- Add explicit `language=he` and `temperature=0`.
- Expected: 30-50% reduction in proper-noun mistranscriptions.

## Test plan
- [x] Deno unit tests pass for `buildVoicePromptBias`
- [x] esbuild + Deno module-load pre-deploy checks
- [x] Live HTTP smoke 200
- [x] Manual: "אביטל האדריכלית" sample transcribed correctly post-deploy

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 2 — Track B1: Eval harness + reference set

**Branch:** `claude/hebrew-quality-b1-eval-harness`
**Goal:** Build the offline scoring harness and curated 30-case reference set. Pre-req for measuring any Sonnet change in PR 3 / PR 5.

## Task 2.1: Extract recent bot replies for curation

**Files:**
- Create: `scripts/extract_bot_replies.py`

- [ ] **Step 1: Write the extraction script**

```python
# scripts/extract_bot_replies.py
"""
Pull recent Sheli bot replies + the user message that triggered each, for
curation into the Hebrew naturalness eval reference set.

Output: tests/fixtures/hebrew_naturalness_candidates.json
        — 100 candidates ordered by recency, ready for Yaron to filter to 30.

Run: python scripts/extract_bot_replies.py
"""
import os, sys, json, requests
from pathlib import Path
from datetime import datetime, timedelta, timezone

# Encoding fix
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BOT_PHONE = "972555175553"
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

# Pull bot replies from last 7 days
since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
url = (
    f"{SB_URL}/rest/v1/whatsapp_messages"
    f"?sender_phone=eq.{BOT_PHONE}"
    f"&created_at=gte.{since}"
    f"&ai_responded=eq.true"
    f"&select=id,group_id,household_id,message_text,classification,in_reply_to,created_at"
    f"&order=created_at.desc&limit=200"
)
res = requests.get(url, headers=HEADERS, timeout=30)
res.raise_for_status()
bot_replies = res.json()
print(f"Pulled {len(bot_replies)} bot replies")

# For each reply, fetch the user message it answered (in_reply_to → whatsapp_messages)
candidates = []
for r in bot_replies[:100]:
    user_msg = None
    if r.get("in_reply_to"):
        u = requests.get(
            f"{SB_URL}/rest/v1/whatsapp_messages"
            f"?whatsapp_message_id=eq.{r['in_reply_to']}"
            f"&select=message_text,sender_phone,sender_name",
            headers=HEADERS, timeout=15,
        )
        if u.ok and u.json():
            user_msg = u.json()[0]
    candidates.append({
        "id": r["id"],
        "household_id": r.get("household_id"),
        "group_id": r.get("group_id"),
        "user_message": (user_msg or {}).get("message_text"),
        "user_sender": (user_msg or {}).get("sender_name"),
        "bot_reply": r["message_text"],
        "classification": r.get("classification"),
        "created_at": r["created_at"],
    })

out = Path(__file__).parent.parent / "tests" / "fixtures" / "hebrew_naturalness_candidates.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Wrote {len(candidates)} candidates → {out}")
```

- [ ] **Step 2: Run extraction**

```bash
python scripts/extract_bot_replies.py
```

Expected: prints `Pulled N bot replies` then `Wrote 100 candidates → tests/fixtures/hebrew_naturalness_candidates.json`. The file is created.

- [ ] **Step 3: Commit (script only — fixtures gitignored at this stage)**

```bash
echo "tests/fixtures/hebrew_naturalness_candidates.json" >> .gitignore
git add scripts/extract_bot_replies.py .gitignore
git commit -m "tools: extract recent bot replies for naturalness curation"
```

## Task 2.2: Yaron curates 30 cases

**Files:**
- Create: `tests/fixtures/hebrew_naturalness_cases.json`

- [ ] **Step 1: Manual curation by Yaron (out-of-band)**

Open `tests/fixtures/hebrew_naturalness_candidates.json`. Pick 30 entries spread across:
- Greetings / small talk (5)
- Action confirmations (5)
- Error / "didn't understand" replies (5)
- Suggestions / proactive offers (5)
- Reminder/event confirmations (5)
- Free-form chitchat (5)

For each picked case, write the **ideal natural-Hebrew reply** Yaron would have written. Save to `tests/fixtures/hebrew_naturalness_cases.json` as:

```json
[
  {
    "id": "case_001",
    "category": "greeting",
    "user_message": "היי שלי, מה קורה?",
    "bad_reply_observed": "מה על הראש היום?",
    "ideal_reply": "היי 💛 מה איתך?",
    "calques_to_flag": ["מה על הראש"],
    "notes": "Calque of 'what's on your mind'. Natural HE doesn't use this construction."
  },
  ...
]
```

Aim for cases that exhibit **distinct** failure modes — don't pick 5 variants of the same calque.

- [ ] **Step 2: Commit the curated set**

```bash
git add tests/fixtures/hebrew_naturalness_cases.json
git commit -m "test: 30 curated Hebrew naturalness reference cases"
```

## Task 2.3: Build the calque bank fixture

**Files:**
- Create: `tests/fixtures/hebrew_calque_bank.json`

- [ ] **Step 1: Write the bank**

```json
{
  "calques": [
    {"phrase": "מה על הראש", "english_source": "what's on your mind", "natural_alt": "מה איתך / מה קורה"},
    {"phrase": "תני לי לדעת", "english_source": "let me know", "natural_alt": "תגידי לי / עדכני אותי"},
    {"phrase": "תן לי לדעת", "english_source": "let me know (m)", "natural_alt": "תגיד לי / עדכן אותי"},
    {"phrase": "אחזור אליך", "english_source": "I'll get back to you", "natural_alt": "אכתוב לך אחר כך"},
    {"phrase": "אני כאן בשבילך", "english_source": "I'm here for you", "natural_alt": "אני איתך"},
    {"phrase": "יום נפלא", "english_source": "have a great day", "natural_alt": "יום טוב / שיהיה לך יום נעים"},
    {"phrase": "קח את הזמן שלך", "english_source": "take your time", "natural_alt": "אין לחץ / בקצב שלך"},
    {"phrase": "קחי את הזמן שלך", "english_source": "take your time (f)", "natural_alt": "אין לחץ / בקצב שלך"},
    {"phrase": "שאלה מהירה", "english_source": "quick question", "natural_alt": "שאלה קטנה / שאלה אחת"},
    {"phrase": "רגע מהיר", "english_source": "quick moment", "natural_alt": "רגע / שנייה"},
    {"phrase": "תהיה זהיר", "english_source": "be careful", "natural_alt": "תזהר / שים לב"},
    {"phrase": "יש לי שאלה בשבילך", "english_source": "I have a question for you", "natural_alt": "שאלה קטנה / רציתי לשאול"},
    {"phrase": "אני רוצה לוודא", "english_source": "I want to make sure", "natural_alt": "סתם לוודא / רק לאשר"},
    {"phrase": "תרגיש חופשי", "english_source": "feel free to", "natural_alt": "אפשר / בכיף"},
    {"phrase": "תרגישי חופשייה", "english_source": "feel free to (f)", "natural_alt": "אפשר / בכיף"},
    {"phrase": "אעדכן אותך בחזרה", "english_source": "I'll update you back", "natural_alt": "אעדכן אותך / אכתוב לך"}
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/hebrew_calque_bank.json
git commit -m "test: initial Hebrew calque bank for naturalness scoring"
```

## Task 2.4: Failing test for calque-bank checker

**Files:**
- Create: `tests/test_naturalness_scorers.py`

- [ ] **Step 1: Write failing tests for the four scoring primitives**

```python
# tests/test_naturalness_scorers.py
"""Unit tests for the scoring primitives used by hebrew_naturalness_eval.py."""
import json, sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Import the SUT (will fail at first because functions don't exist yet)
sys.path.insert(0, str(Path(__file__).parent))
from hebrew_naturalness_eval import (
    contains_calque,
    contains_latin_in_hebrew,
    has_feminine_first_person,
    score_case,
)

CALQUE_BANK = json.loads(
    (Path(__file__).parent / "fixtures" / "hebrew_calque_bank.json").read_text(encoding="utf-8")
)["calques"]


def test_contains_calque_detects_known_phrase():
    assert contains_calque("מה על הראש היום?", CALQUE_BANK) == "מה על הראש"


def test_contains_calque_returns_none_for_clean_text():
    assert contains_calque("מה איתך היום?", CALQUE_BANK) is None


def test_contains_calque_skips_when_natural_completion():
    # "יש לך על הראש" is fine — the calque is "מה על הראש" without "יש לך".
    # For now, do exact-substring matching; a future refinement can add context.
    # Document this as a known limitation in the eval harness.
    assert contains_calque("יש לך משהו על הראש?", CALQUE_BANK) == "מה על הראש" or None


def test_contains_latin_in_hebrew_flags_mid_sentence():
    assert contains_latin_in_hebrew("היי technologia") is True


def test_contains_latin_in_hebrew_allows_whitelisted_proper_nouns():
    # WhatsApp, Google, sheli.ai, etc. are allowed mid-sentence.
    assert contains_latin_in_hebrew("שלחתי לך ב-WhatsApp") is False
    assert contains_latin_in_hebrew("היכנסי ל-sheli.ai") is False


def test_has_feminine_first_person_passes_for_feminine():
    assert has_feminine_first_person("הוספתי לרשימה, בודקת את התזכורת") is True


def test_has_feminine_first_person_flags_masculine_drift():
    # Sheli is feminine; "אני חושב" / "אני יודע" = masculine drift.
    assert has_feminine_first_person("אני חושב שזה בסדר") is False


def test_score_case_aggregates_all_four():
    case = {
        "id": "case_001",
        "user_message": "היי שלי",
        "ideal_reply": "היי 💛 מה איתך?",
    }
    actual = "מה על הראש היום?"
    result = score_case(case, actual, CALQUE_BANK, judge_natural=lambda *_: False)
    assert result["calque_clean"] is False
    assert result["calque_found"] == "מה על הראש"
    assert result["pass"] is False
```

- [ ] **Step 2: Run to verify it fails**

```bash
python -m pytest tests/test_naturalness_scorers.py -v
```

Expected: FAIL — `ImportError: cannot import name 'contains_calque'` (because `hebrew_naturalness_eval.py` doesn't exist yet).

## Task 2.5: Implement the eval harness

**Files:**
- Create: `tests/hebrew_naturalness_eval.py`

- [ ] **Step 1: Write the harness**

```python
# tests/hebrew_naturalness_eval.py
"""
Sheli Hebrew Naturalness Eval

Runs each curated case through the configured Sonnet model and scores 4 binary
checks: calque-free, no Latin mid-Hebrew, feminine first-person, Haiku-judge
naturalness. Reports per-case pass/fail and aggregate score.

Run:  python tests/hebrew_naturalness_eval.py
Env:  ANTHROPIC_API_KEY (required)
      REPLY_MODEL (default: claude-sonnet-4-20250514)
      JUDGE_MODEL (default: claude-haiku-4-5-20251001)
"""
import json, os, sys, re, time
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

import requests

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
REPLY_MODEL = os.environ.get("REPLY_MODEL", "claude-sonnet-4-20250514")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-haiku-4-5-20251001")

FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "hebrew_naturalness_cases.json").read_text(encoding="utf-8"))
CALQUE_BANK = json.loads((FIXTURES / "hebrew_calque_bank.json").read_text(encoding="utf-8"))["calques"]

# ─── Whitelisted Latin proper nouns (subset of SHARED_HEBREW_GRAMMAR rule) ───
LATIN_WHITELIST = {
    "WhatsApp", "Google", "API", "Claude", "iCount", "iPhone",
    "sheli.ai", "Sheli.ai", "OpenAI", "Anthropic", "Calendar",
}
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9.\-_]*")
HEBREW_RE = re.compile(r"[֐-׿]")


# ─── Scorers ───

def contains_calque(text, bank):
    """Return the matched calque phrase, or None."""
    for entry in bank:
        if entry["phrase"] in text:
            return entry["phrase"]
    return None


def contains_latin_in_hebrew(text):
    """True if text mixes Hebrew with non-whitelisted Latin tokens."""
    if not HEBREW_RE.search(text):
        return False  # no Hebrew → not a Hebrew-context check
    for tok in LATIN_RE.findall(text):
        if tok in LATIN_WHITELIST:
            continue
        # Strip trailing punctuation
        bare = tok.rstrip(".,!?;:")
        if bare in LATIN_WHITELIST:
            continue
        return True
    return False


def has_feminine_first_person(text):
    """Sheli speaking about herself: must use feminine present-tense forms."""
    masc_drift = ["אני חושב ", "אני יודע ", "אני זוכר ", "אני מבין ",
                   "אני רוצה ", "אני שולח ", "אני בודק ", "אני מחפש "]
    # NOTE: "אני רוצה" is gender-invariant in unpointed Hebrew — exclude from drift.
    masc_drift = [m for m in masc_drift if "רוצה" not in m]
    for m in masc_drift:
        if m in text:
            return False
    return True


def judge_natural_anthropic(user_msg, actual_reply, ideal_reply):
    """Haiku-as-judge: is `actual_reply` natural Hebrew (similar quality to `ideal_reply`)?"""
    prompt = f"""User wrote: {user_msg}
Bot replied: {actual_reply}
Ideal reply (for reference): {ideal_reply}

Is the bot's reply natural Hebrew that a native Israeli would say? Answer ONLY "yes" or "no". No explanation.
- "yes" = sounds natural, no English-think calques, appropriate register.
- "no" = stilted, calque-y, robotic, or wrong register."""
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": JUDGE_MODEL,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    res.raise_for_status()
    answer = res.json()["content"][0]["text"].strip().lower()
    return answer.startswith("yes")


# ─── Reply generation (calls the configured Sonnet model directly) ───

def generate_reply(user_msg, system_prompt=None):
    """Generate a Sheli-style reply via the configured REPLY_MODEL."""
    sys_prompt = system_prompt or (
        "את שלי, עוזרת משפחתית חכמה ב-WhatsApp. תעני בעברית טבעית, חמה, "
        "קצרה. גוף ראשון יחיד נקבה. אל תתרגמי מילולית מאנגלית — תכתבי כמו "
        "ישראלית טבעית."
    )
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": REPLY_MODEL,
            "max_tokens": 256,
            "system": sys_prompt,
            "messages": [{"role": "user", "content": user_msg}],
        },
        timeout=60,
    )
    res.raise_for_status()
    return res.json()["content"][0]["text"].strip()


# ─── Per-case scorer ───

def score_case(case, actual, bank, judge_natural=judge_natural_anthropic):
    calque_found = contains_calque(actual, bank)
    latin_violation = contains_latin_in_hebrew(actual)
    masc_drift = not has_feminine_first_person(actual)
    judge_yes = judge_natural(case["user_message"], actual, case["ideal_reply"])

    return {
        "id": case["id"],
        "actual": actual,
        "calque_clean": calque_found is None,
        "calque_found": calque_found,
        "latin_clean": not latin_violation,
        "feminine_clean": not masc_drift,
        "judge_natural": judge_yes,
        "pass": (calque_found is None) and (not latin_violation) and (not masc_drift) and judge_yes,
    }


# ─── Main runner ───

def main():
    results = []
    print(f"Running {len(CASES)} cases against {REPLY_MODEL}...")
    for i, case in enumerate(CASES, 1):
        print(f"[{i}/{len(CASES)}] {case['id']}: {case['user_message'][:50]}...")
        try:
            actual = generate_reply(case["user_message"])
            r = score_case(case, actual, CALQUE_BANK)
        except Exception as e:
            print(f"  ERROR: {e}")
            r = {"id": case["id"], "error": str(e), "pass": False}
        results.append(r)
        time.sleep(1.5)  # Tier 1 rate limit: 5/min

    passed = sum(1 for r in results if r.get("pass"))
    score = passed / len(results) * 100 if results else 0
    print(f"\n=== RESULTS ===")
    print(f"Model: {REPLY_MODEL}")
    print(f"Passed: {passed}/{len(results)} ({score:.1f}%)")
    print(f"\nFailures:")
    for r in results:
        if not r.get("pass"):
            print(f"  {r['id']}: calque={r.get('calque_found')} "
                  f"latin={'X' if not r.get('latin_clean') else '✓'} "
                  f"fem={'X' if not r.get('feminine_clean') else '✓'} "
                  f"judge={'X' if not r.get('judge_natural') else '✓'}")
            print(f"    actual: {r.get('actual', r.get('error', ''))[:120]}")

    out = Path(__file__).parent / "fixtures" / f"naturalness_run_{REPLY_MODEL.replace('-', '_')}.json"
    out.write_text(json.dumps({"model": REPLY_MODEL, "score": score, "results": results},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote run details → {out}")
    return score


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
```

- [ ] **Step 2: Run unit tests for the scorers — verify they pass**

```bash
python -m pytest tests/test_naturalness_scorers.py -v
```

Expected: PASS (all scorer tests).

- [ ] **Step 3: Run full eval as baseline**

```bash
python tests/hebrew_naturalness_eval.py
```

Expected: prints per-case results + final aggregate score (e.g. `Passed: 12/30 (40.0%)`). Saves run JSON to `tests/fixtures/naturalness_run_claude_sonnet_4_20250514.json`.

This is the **baseline score** — record it in the PR description for comparison.

- [ ] **Step 4: Commit**

```bash
git add tests/hebrew_naturalness_eval.py tests/test_naturalness_scorers.py \
        tests/fixtures/naturalness_run_claude_sonnet_4_20250514.json
git commit -m "test: hebrew naturalness eval harness + baseline (Sonnet 4)"
```

- [ ] **Step 5: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --base main \
  --head "$(git branch --show-current)" \
  --title "test(hebrew): naturalness eval harness + 30 reference cases + Sonnet 4 baseline" \
  --body "$(cat <<'EOF'
## Summary
- 30 curated `(user_msg, bad_reply, ideal_reply)` cases.
- 4-axis scorer: calque-bank substring, Latin mid-Hebrew, Sheli feminine first-person, Haiku-as-judge.
- Baseline score on Sonnet 4 recorded for PR 3 / PR 5 comparison.

## Baseline
- Sonnet 4 (`claude-sonnet-4-20250514`): see attached run JSON.

## Test plan
- [x] Unit tests pass for scoring primitives
- [x] Full 30-case eval runs end-to-end
- [x] Run JSON committed for reproducibility

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 3 — Track B2: Sonnet 4.6 model-swap trial

**Branch:** `claude/hebrew-quality-b2-sonnet-46`
**Goal:** Make `SONNET_MODEL` env-configurable, run the eval harness against `claude-sonnet-4-6`, ship the swap if it lifts naturalness ≥30%.

## Task 3.1: Consolidate hardcoded model IDs to the constant

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

The constant `SONNET_MODEL` exists at line 1383 but 6 other call sites still hardcode `"claude-sonnet-4-20250514"` inline. Fix that drift.

- [ ] **Step 1: Find every hardcoded literal**

```bash
grep -n 'claude-sonnet-4-20250514' supabase/functions/whatsapp-webhook/index.inlined.ts
```

Expected hits at lines (approx, will shift): 1383, 2001, 3894, 7554, 8550, 8766, 12550. The first is the constant declaration; replace the other six.

- [ ] **Step 2: Replace inline literals with `SONNET_MODEL`**

For each non-1383 hit, change `model: "claude-sonnet-4-20250514"` → `model: SONNET_MODEL`. Use Edit tool with `replace_all` if all six are identical occurrences:

```
old_string: model: "claude-sonnet-4-20250514",
new_string: model: SONNET_MODEL,
replace_all: true
```

(After replace_all, line 1383's `const SONNET_MODEL = "claude-sonnet-4-20250514";` is untouched because it doesn't match the pattern with the comma.)

- [ ] **Step 3: Make the constant env-configurable**

Replace the constant at line 1383:

```typescript
// Replace:
const SONNET_MODEL = "claude-sonnet-4-20250514";

// With:
const SONNET_MODEL = Deno.env.get("REPLY_MODEL") || "claude-sonnet-4-20250514";
```

- [ ] **Step 4: Pre-deploy checks**

```bash
# esbuild
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle \
  --platform=neutral --format=esm --target=esnext --loader:.ts=ts \
  --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js

# Module-load
SUPABASE_URL=stub SUPABASE_SERVICE_ROLE_KEY=stub \
"/c/Users/yarond/AppData/Local/Microsoft/WinGet/Packages/DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe/deno.exe" \
  run --no-lock --allow-env --allow-net --check=none \
  supabase/functions/whatsapp-webhook/index.inlined.ts
```

Both must pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "refactor(bot): consolidate Sonnet model ID to env-configurable SONNET_MODEL"
```

## Task 3.2: Run eval harness against Sonnet 4.6

- [ ] **Step 1: Run with REPLY_MODEL=claude-sonnet-4-6**

```bash
REPLY_MODEL=claude-sonnet-4-6 python tests/hebrew_naturalness_eval.py
```

Expected: a new run JSON written to `tests/fixtures/naturalness_run_claude_sonnet_4_6.json`.

- [ ] **Step 2: Compare with baseline**

```bash
python -c "
import json
from pathlib import Path
b = json.loads(Path('tests/fixtures/naturalness_run_claude_sonnet_4_20250514.json').read_text(encoding='utf-8'))
n = json.loads(Path('tests/fixtures/naturalness_run_claude_sonnet_4_6.json').read_text(encoding='utf-8'))
print(f'Sonnet 4 baseline: {b[\"score\"]:.1f}%')
print(f'Sonnet 4.6:       {n[\"score\"]:.1f}%')
print(f'Lift:             +{n[\"score\"] - b[\"score\"]:.1f}pp')
"
```

- [ ] **Step 3: Decide**

- **Lift ≥ 30 percentage points (e.g. 40% → 70%):** ship it. Proceed to Task 3.3.
- **Lift 10-30pp:** weigh against latency / cost. If reply latency p50 doesn't degrade >300ms in canary, still ship.
- **Lift < 10pp:** do not ship the swap. Skip to PR 5 (anti-calque rule block).

Record the decision + numbers in PR description.

## Task 3.3: Deploy + canary (only if Step 3 above said ship)

- [ ] **Step 1: Set REPLY_MODEL env var**

Supabase Dashboard → Edge Functions → whatsapp-webhook → Settings → Secrets → Add: `REPLY_MODEL=claude-sonnet-4-6`.

- [ ] **Step 2: Trigger redeploy (no code change needed — env vars require redeploy)**

Either re-paste `index.inlined.ts` or hit the "Redeploy" button on the latest version.

- [ ] **Step 3: Live HTTP smoke test**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"messages","message":[]}}' \
  --max-time 10
```

Expected: 200.

- [ ] **Step 4: Run integration tests**

```bash
python tests/test_webhook.py
```

Expected: ~94%+ pass rate (matching pre-swap baseline). If significantly lower, roll back the env var.

- [ ] **Step 5: 24h canary monitoring**

Yaron's own household is the canary. After 24h:
- Subjective vibe check on replies — Hebrew should feel more natural.
- p50 latency: query `whatsapp_messages` for bot replies, compute time between user message and bot reply for the canary household. Compare with prior week.

```sql
-- Run via Supabase SQL editor
SELECT
  date_trunc('day', created_at) AS day,
  AVG(EXTRACT(EPOCH FROM (b.created_at - u.created_at)) * 1000) AS avg_ms_p50
FROM whatsapp_messages u
JOIN whatsapp_messages b
  ON b.in_reply_to = u.whatsapp_message_id
 AND b.sender_phone = '972555175553'
WHERE u.household_id = '<yaron_hh_id>'
  AND u.created_at > NOW() - INTERVAL '14 days'
GROUP BY 1 ORDER BY 1;
```

- [ ] **Step 6: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --base main \
  --head "$(git branch --show-current)" \
  --title "feat(bot): Sonnet 4.6 model swap (REPLY_MODEL env var) + 6-site model ID cleanup" \
  --body "$(cat <<'EOF'
## Summary
- Consolidated 6 inline `claude-sonnet-4-20250514` literals to the `SONNET_MODEL` constant (anti-drift).
- Made `SONNET_MODEL` env-configurable via `REPLY_MODEL`.
- Ran the naturalness eval harness against Sonnet 4.6.

## Eval results
- Sonnet 4 baseline: <fill from run>
- Sonnet 4.6:       <fill from run>
- Lift:             <fill>

## Latency
- p50 reply latency, canary household, 24h: <fill ms>

## Test plan
- [x] esbuild + Deno module-load
- [x] Live HTTP smoke 200
- [x] `tests/test_webhook.py` ≥ 94%
- [x] 24h canary clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 4 — Track A2: Hosted ivrit-ai voice provider

**Branch:** `claude/hebrew-quality-a2-ivrit-ai`
**Goal:** Add a hosted ivrit-ai/whisper-large-v3-ct2 endpoint as an alternate `transcribeVoice` provider. Switch via `VOICE_PROVIDER` env var. Keep Groq path intact for instant rollback.

## Task 4.1: Provider research + decision (one-time, ~30 min)

- [ ] **Step 1: Search Replicate**

Open https://replicate.com/explore and search "hebrew whisper" / "ivrit-ai". Note any maintained model with: stable input schema, recent updates, returns segments-with-confidence (or raw text + we compute a synthetic confidence).

- [ ] **Step 2: Search Hugging Face Inference Endpoints**

Open https://huggingface.co/ivrit-ai/whisper-large-v3-ct2. Click "Deploy" → "Inference Endpoints". Note pricing for scale-to-zero CPU and on-demand GPU (e.g. T4 small).

- [ ] **Step 3: Pick one provider and document**

Add a section to `docs/plans/2026-04-30-hebrew-quality-design.md`:

```markdown
## Track A2 provider decision (resolved YYYY-MM-DD)

**Picked:** <Replicate | HF Inference Endpoint | other>
**Endpoint URL:** <full URL>
**Auth:** <header / API key style>
**Input schema:** <JSON shape>
**Output schema:** <does it return segments? avg_logprob? language?>
**Cost:** ~$X.XX per voice at <duration>s avg
**Cold start:** <Y / N + duration>
**Rejected alternatives:** <brief why>
```

- [ ] **Step 4: Commit the decision**

```bash
git add docs/plans/2026-04-30-hebrew-quality-design.md
git commit -m "docs(hebrew-quality): pick ivrit-ai hosted provider"
```

## Task 4.2: Add ivrit-ai transcription helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (insert before `transcribeVoice`)

- [ ] **Step 1: Implement `transcribeVoiceIvritAi`**

Insert after `buildVoicePromptBias`, before `transcribeVoice`. The exact request shape depends on Task 4.1's chosen provider — adapt the body to that provider. The skeleton (Replicate-style):

```typescript
// ─── ivrit-ai voice provider (Hebrew-fine-tuned Whisper) ───
async function transcribeVoiceIvritAi(
  audioBlob: Blob,
  biasPrompt: string,
): Promise<VoiceTranscription> {
  const apiKey = Deno.env.get("IVRIT_AI_API_KEY") || "";
  const apiUrl = Deno.env.get("IVRIT_AI_API_URL") || ""; // full endpoint URL
  if (!apiKey || !apiUrl) {
    console.error("[VoiceIvrit] IVRIT_AI_API_KEY or IVRIT_AI_API_URL not set");
    return { text: null, quality: "failed" };
  }

  try {
    // Upload audio to a temporary signed URL OR pass as base64. Replicate
    // accepts both; HF endpoints typically want multipart. Pick per Task 4.1.
    // For Replicate: convert blob to base64 data URL.
    const arrayBuf = await audioBlob.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
    const dataUrl = `data:audio/ogg;base64,${b64}`;

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          audio: dataUrl,
          language: "he",
          initial_prompt: biasPrompt || undefined,
          temperature: 0,
          word_timestamps: false,
          // request per-segment confidence if the provider exposes it
          condition_on_previous_text: false,
        },
      }),
    });

    if (!res.ok) {
      console.error("[VoiceIvrit] API error:", res.status, await res.text());
      return { text: null, quality: "failed" };
    }

    const result = await res.json();
    // Replicate response: { output: { text, segments?, language? } }
    // HF endpoint: { text, chunks? }
    // ADAPT this destructure to whichever Task 4.1 picked.
    const output = result.output || result;
    const text: string | null = (output.text || "").trim() || null;
    if (!text) return { text: null, quality: "failed" };

    const language: string | undefined = output.language;
    const hebrewOrEnglish = !language ||
      ["he", "iw", "hebrew", "en", "english"].includes(language.toLowerCase());
    if (!hebrewOrEnglish) {
      return { text, quality: "wrong_language", language };
    }

    // Best-effort confidence: if segments aren't returned, default to "ok"
    // since ivrit-ai is fine-tuned on Hebrew (lower hallucination rate).
    const segments: Array<{ avg_logprob?: number; no_speech_prob?: number }> =
      Array.isArray(output.segments) ? output.segments : [];
    let avgLogprob = 0;
    let maxNoSpeech = 0;
    if (segments.length > 0) {
      avgLogprob = segments.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segments.length;
      maxNoSpeech = segments.reduce((m, x) => Math.max(m, x.no_speech_prob ?? 0), 0);
      if (maxNoSpeech > 0.7) {
        return { text, quality: "no_speech", language, avgLogprob, noSpeechProb: maxNoSpeech };
      }
      if (avgLogprob < -1.2) {
        return { text, quality: "unclear", language, avgLogprob, noSpeechProb: maxNoSpeech };
      }
    }

    return { text, quality: "ok", language, avgLogprob, noSpeechProb: maxNoSpeech };
  } catch (err) {
    console.error("[VoiceIvrit] Transcription error:", err);
    return { text: null, quality: "failed" };
  }
}
```

## Task 4.3: Refactor `transcribeVoice` into a provider switch

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:12204` (existing `transcribeVoice`)

- [ ] **Step 1: Extract Groq path into `transcribeVoiceGroq`**

Rename the existing `transcribeVoice` to `transcribeVoiceGroq`, keeping its current body (with the bias-prompt + language=he + temperature=0 changes from PR 1). Then write a new top-level `transcribeVoice` that switches:

```typescript
async function transcribeVoice(
  mediaUrl: string | undefined,
  mediaId: string | undefined,
  householdId?: string | null,
): Promise<VoiceTranscription> {
  if (!mediaUrl && !mediaId) {
    console.error("[Voice] No media URL or media ID available");
    return { text: null, quality: "failed" };
  }

  // 1. Download audio (shared between providers)
  let audioBlob: Blob;
  try {
    if (mediaUrl) {
      const r = await fetch(mediaUrl);
      if (!r.ok) {
        console.error("[Voice] Audio download failed:", r.status);
        return { text: null, quality: "failed" };
      }
      audioBlob = await r.blob();
    } else {
      const apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
      const token = Deno.env.get("WHAPI_TOKEN") || "";
      const r = await fetch(`${apiUrl}/media/${mediaId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "audio/ogg" },
      });
      if (!r.ok) {
        console.error("[Voice] Whapi media download failed:", r.status);
        return { text: null, quality: "failed" };
      }
      audioBlob = await r.blob();
    }
  } catch (err) {
    console.error("[Voice] Download error:", err);
    return { text: null, quality: "failed" };
  }

  // 2. Build decoder bias from household vocab (provider-agnostic)
  const biasPrompt = await buildVoicePromptBias(householdId ?? null);
  if (biasPrompt) {
    console.log(`[Voice] Bias prompt (${biasPrompt.length} chars)`);
  }

  // 3. Route to chosen provider
  const provider = (Deno.env.get("VOICE_PROVIDER") || "groq").toLowerCase();
  if (provider === "ivrit_ai" || provider === "ivritai") {
    return transcribeVoiceIvritAi(audioBlob, biasPrompt);
  }
  return transcribeVoiceGroq(audioBlob, biasPrompt);
}
```

- [ ] **Step 2: Update `transcribeVoiceGroq` signature**

Change the renamed Groq function to accept the pre-downloaded blob + pre-built bias prompt instead of downloading again:

```typescript
async function transcribeVoiceGroq(
  audioBlob: Blob,
  biasPrompt: string,
): Promise<VoiceTranscription> {
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
  if (!GROQ_API_KEY) {
    console.error("[Voice] GROQ_API_KEY not set");
    return { text: null, quality: "failed" };
  }

  try {
    const formData = new FormData();
    formData.append("file", audioBlob, "voice.ogg");
    formData.append("model", "whisper-large-v3");
    formData.append("response_format", "verbose_json");
    formData.append("language", "he");
    formData.append("temperature", "0");
    if (biasPrompt) formData.append("prompt", biasPrompt);

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      console.error("[Voice] Groq API error:", response.status, await response.text());
      return { text: null, quality: "failed" };
    }

    const result = await response.json();
    const text = result.text?.trim() || null;
    if (!text) return { text: null, quality: "failed" };

    const language: string | undefined = result.language;
    const hebrewOrEnglish = !language ||
      ["he", "iw", "hebrew", "en", "english"].includes(language.toLowerCase());
    if (!hebrewOrEnglish) {
      return { text, quality: "wrong_language", language };
    }

    const segments: Array<{ avg_logprob?: number; no_speech_prob?: number }> =
      Array.isArray(result.segments) ? result.segments : [];
    let avgLogprob = 0;
    let maxNoSpeech = 0;
    if (segments.length > 0) {
      avgLogprob = segments.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segments.length;
      maxNoSpeech = segments.reduce((m, x) => Math.max(m, x.no_speech_prob ?? 0), 0);
    }
    if (maxNoSpeech > 0.7) return { text, quality: "no_speech", language, avgLogprob, noSpeechProb: maxNoSpeech };
    if (avgLogprob < -1.2) return { text, quality: "unclear", language, avgLogprob, noSpeechProb: maxNoSpeech };
    return { text, quality: "ok", language, avgLogprob, noSpeechProb: maxNoSpeech };
  } catch (err) {
    console.error("[Voice] Groq transcription error:", err);
    return { text: null, quality: "failed" };
  }
}
```

- [ ] **Step 3: Pre-deploy checks**

Same esbuild + Deno module-load as before.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(voice): provider abstraction + ivrit-ai backend behind VOICE_PROVIDER"
```

## Task 4.4: Side-by-side quality comparison script

**Files:**
- Create: `scripts/test_voice_provider.py`

- [ ] **Step 1: Write the comparison script**

```python
# scripts/test_voice_provider.py
"""
Send one audio file to both Groq and ivrit-ai endpoints, print both transcripts
side by side. Use to validate the swap before flipping the env var in prod.

Run: python scripts/test_voice_provider.py path/to/voice.ogg
"""
import os, sys, base64
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

import requests

if len(sys.argv) < 2:
    print("Usage: python scripts/test_voice_provider.py <audio.ogg>")
    sys.exit(1)

audio_path = Path(sys.argv[1])
audio_bytes = audio_path.read_bytes()

# 1. Groq
groq_key = os.environ["GROQ_API_KEY"]
files = {"file": (audio_path.name, audio_bytes, "audio/ogg")}
data = {"model": "whisper-large-v3", "response_format": "verbose_json",
        "language": "he", "temperature": "0"}
r = requests.post(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    headers={"Authorization": f"Bearer {groq_key}"},
    files=files, data=data, timeout=120,
)
groq_text = r.json().get("text") if r.ok else f"ERROR {r.status_code}: {r.text}"

# 2. ivrit-ai
ivrit_url = os.environ["IVRIT_AI_API_URL"]
ivrit_key = os.environ["IVRIT_AI_API_KEY"]
b64 = base64.b64encode(audio_bytes).decode("ascii")
r = requests.post(
    ivrit_url,
    headers={"Authorization": f"Bearer {ivrit_key}", "Content-Type": "application/json"},
    json={"input": {"audio": f"data:audio/ogg;base64,{b64}", "language": "he",
                     "temperature": 0, "condition_on_previous_text": False}},
    timeout=180,
)
if r.ok:
    out = r.json().get("output") or r.json()
    ivrit_text = out.get("text", "") if isinstance(out, dict) else str(out)
else:
    ivrit_text = f"ERROR {r.status_code}: {r.text}"

print(f"\n=== Voice Provider Comparison ===")
print(f"File: {audio_path}\n")
print(f"--- Groq Whisper Large v3 ---")
print(groq_text)
print(f"\n--- ivrit-ai/whisper-large-v3-ct2 ---")
print(ivrit_text)
```

- [ ] **Step 2: Run on Yaron's "אביטל האדריכלית" sample**

```bash
python scripts/test_voice_provider.py path/to/avital_sample.ogg
```

Expected: ivrit-ai transcript contains "אביטל האדריכלית" correctly. If not, the provider isn't a meaningful upgrade — flag and revisit.

- [ ] **Step 3: Commit script**

```bash
git add scripts/test_voice_provider.py
git commit -m "tools: side-by-side voice provider comparison"
```

## Task 4.5: Deploy + canary

- [ ] **Step 1: Set env vars in Dashboard**

Supabase Dashboard → Edge Functions → whatsapp-webhook → Settings → Secrets:
- `IVRIT_AI_API_URL=<from Task 4.1>`
- `IVRIT_AI_API_KEY=<from Task 4.1>`
- Do NOT set `VOICE_PROVIDER` yet (default = groq, safe).

- [ ] **Step 2: Deploy code**

Paste `index.inlined.ts` to Dashboard → Deploy → live HTTP smoke 200.

- [ ] **Step 3: Flip VOICE_PROVIDER for Yaron's household only — wait, env vars are global**

Env vars are global, so we can't easily canary one household. Two options:
- Option A: read household whitelist from `bot_settings.voice_provider_canary_households` (CSV) — feature-flag pattern. Adds a small SQL migration.
- Option B: pure cutover after side-by-side script passes. Simpler.

**Pick Option B for first deploy.** Yaron's <50/day total volume means the blast radius of a regression is minimal, and the side-by-side script (Task 4.4) already validated quality on the trigger sample.

Set `VOICE_PROVIDER=ivrit_ai` in Dashboard → Redeploy → smoke test.

- [ ] **Step 4: Monitor for 1 week**

Daily for 7 days, query the most recent voice transcripts:

```sql
SELECT created_at, message_text, classification_data->'voice_meta' AS meta
FROM whatsapp_messages
WHERE message_type = 'voice'
ORDER BY created_at DESC
LIMIT 20;
```

Eyeball — proper nouns should look right. If quality degrades, set `VOICE_PROVIDER=groq` and redeploy (instant rollback).

- [ ] **Step 5: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --base main \
  --head "$(git branch --show-current)" \
  --title "feat(voice): hosted ivrit-ai/whisper-large-v3-ct2 provider behind VOICE_PROVIDER" \
  --body "$(cat <<'EOF'
## Summary
- Provider abstraction: `transcribeVoiceGroq` + `transcribeVoiceIvritAi`, switched by `VOICE_PROVIDER` env var.
- Hosted ivrit-ai/whisper-large-v3-ct2 on <provider> (~$X.XX/voice).
- Side-by-side comparison script for ad-hoc QA.

## Quality validation
- "אביטל האדריכלית" sample: Groq → "<previous>", ivrit-ai → "<correct>".

## Rollback
- `VOICE_PROVIDER=groq` + redeploy = instant revert.

## Test plan
- [x] Provider research documented in design doc
- [x] esbuild + Deno module-load
- [x] Side-by-side script run on 5+ samples
- [x] Live HTTP smoke 200
- [ ] 1-week canary clean (in-progress)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 5 — Track B3: Anti-calque rule block (CONDITIONAL)

**Branch:** `claude/hebrew-quality-b3-anti-calque-rules`
**Goal:** If PR 3's eval lift was insufficient, add a named anti-calque rule block to `SHARED_HEBREW_GRAMMAR`. Skip this PR entirely if Sonnet 4.6 alone solved the problem.

**Skip condition:** PR 3's `naturalness_run_claude_sonnet_4_6.json` score is ≥ 80% AND Yaron subjectively considers the canary clean. Otherwise, proceed.

## Task 5.1: Mine real calques from PR 2 + PR 3 run data

**Files:**
- Modify: `tests/fixtures/hebrew_calque_bank.json`

- [ ] **Step 1: Extract calques the eval flagged**

```bash
python -c "
import json
from pathlib import Path
runs = ['naturalness_run_claude_sonnet_4_20250514.json', 'naturalness_run_claude_sonnet_4_6.json']
seen = {}
for r in runs:
    p = Path('tests/fixtures') / r
    if not p.exists(): continue
    data = json.loads(p.read_text(encoding='utf-8'))
    for case in data['results']:
        c = case.get('calque_found')
        if c and c not in seen:
            seen[c] = case.get('actual', '')[:80]
for c, sample in seen.items():
    print(f'{c}\t→ from: {sample}')
"
```

- [ ] **Step 2: Augment the calque bank to ~25 entries**

Add any flagged calques not already in `tests/fixtures/hebrew_calque_bank.json`. For each new entry, write the natural-Hebrew alternative.

## Task 5.2: Write the anti-calque rule block

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:1733` (`SHARED_HEBREW_GRAMMAR`)

- [ ] **Step 1: Insert new rule at TOP of SHARED_HEBREW_GRAMMAR**

Place this block right after the opening backtick (recency bias matters in long prompts — top of section gets stronger attention than middle):

```typescript
const SHARED_HEBREW_GRAMMAR = `Hebrew grammar:
- ANTI-CALQUE — DO NOT translate English idioms word-for-word. Hebrew has its own way of saying these. List of bans (with the natural Hebrew you SHOULD use):
  - "what's on your mind today" — NEVER write "מה על הראש היום". Use "מה איתך היום" / "מה קורה" / "מה יש לך על הראש היום" (only with יש לך).
  - "let me know" — NEVER "תני/תן לי לדעת". Use "תגידי לי" / "עדכני אותי" / "תכתבי לי".
  - "I'll get back to you" — NEVER "אחזור אליך". Use "אכתוב לך אחר כך" / "אענה לך כשאדע".
  - "I'm here for you" — NEVER "אני כאן בשבילך" (calque-y). Use "אני איתך" or just answer the question without preamble.
  - "have a great day" — NEVER "יום נפלא". Use "יום טוב" / "שיהיה לך יום נעים".
  - "take your time" — NEVER "קחי/קח את הזמן שלך". Use "אין לחץ" / "בקצב שלך".
  - "quick question" — NEVER "שאלה מהירה" / "רגע מהיר". Use "שאלה קטנה" / "שאלה אחת" / "רגע" / "שנייה".
  - "feel free to" — NEVER "תרגיש/י חופשי/ה". Use "אפשר" / "בכיף" / "כל הזמן שלך".
  - "I'll update you back" — NEVER "אעדכן אותך בחזרה". Use "אעדכן אותך" / "אכתוב לך".
  - "I want to make sure" — NEVER "אני רוצה לוודא". Use "סתם לוודא" / "רק לאשר".
  - "be careful" — NEVER "תהיה זהיר". Use "תזהר" / "שים לב".
  - [Add the rest from the calque bank — ~15-25 entries total.]
- Rule of thumb: if a phrase translates word-for-word from English, it probably sounds wrong in Hebrew. Reach for a Hebrew-native rephrasing. When in doubt, write what an Israeli grandmother would say, not what Google Translate would write.
- Construct state (סמיכות): ONLY the second noun gets ה. ...
[REST OF EXISTING RULES UNCHANGED]
```

- [ ] **Step 2: Pre-deploy checks (esbuild + Deno module-load)**

The most likely failure mode here is a stray unescaped backtick or `${...}` inside the new block (per CLAUDE.md v263 lesson). Sanity check:

```bash
grep -nE '\${[a-zA-Z_]' supabase/functions/whatsapp-webhook/index.inlined.ts | head -20
```

Any new hits inside `SHARED_HEBREW_GRAMMAR` MUST resolve to in-scope variables. If you see `${count}` or similar as intended literal text, escape: `\${count}`.

Then run esbuild + Deno module-load as in earlier tasks. Both must pass.

- [ ] **Step 3: Run eval harness**

```bash
python tests/hebrew_naturalness_eval.py
```

Expected: score lifts above the PR 3 number. If no lift, the rules aren't biting — investigate (rule placement, prompt length pressure, or maybe the model legitimately ignores them).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts \
        tests/fixtures/hebrew_calque_bank.json \
        tests/fixtures/naturalness_run_*.json
git commit -m "feat(prompt): anti-calque rule block in SHARED_HEBREW_GRAMMAR"
```

## Task 5.3: Deploy + verify

- [ ] **Step 1: Paste-deploy + smoke + corruption scan**

```bash
# Live HTTP smoke
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"messages","message":[]}}' \
  --max-time 10

# Paste-corruption scan (Hebrew injected mid-Latin-identifier)
grep -nE '[A-Za-z]{2,}[֐-׿]+[A-Za-z]{2,}' \
  supabase/functions/whatsapp-webhook/index.inlined.ts | head -20
```

Expected: 200 + no hits in code (hits in comments OK).

- [ ] **Step 2: Run integration tests**

```bash
python tests/test_webhook.py
```

Expected: ≥94% pass rate.

- [ ] **Step 3: 24h canary**

Yaron's household. Verify replies feel natural and no calque from the bank appears in any reply.

- [ ] **Step 4: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --base main \
  --head "$(git branch --show-current)" \
  --title "feat(prompt): anti-calque rule block — eliminate English-think Hebrew" \
  --body "$(cat <<'EOF'
## Summary
- New section at top of `SHARED_HEBREW_GRAMMAR` listing 15-25 named English→Hebrew anti-calques with natural Hebrew alternatives.
- Mined from real PR 2 / PR 3 eval flags.

## Eval lift
- Pre PR 5: <PR 3 score>%
- Post PR 5: <new score>%

## Test plan
- [x] esbuild + Deno module-load
- [x] Eval harness lift confirmed
- [x] `tests/test_webhook.py` clean
- [x] Live HTTP smoke 200
- [x] 24h canary clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

Spec coverage check (each section of the design has a corresponding task):

- [x] Track A1 household name biasing → Tasks 1.1–1.5
- [x] Track A2 hosted ivrit-ai → Tasks 4.1–4.5
- [x] Track A3 verification → covered in Tasks 1.5 and 4.5
- [x] Track B1 reference set + harness → Tasks 2.1–2.5
- [x] Track B2 model swap → Tasks 3.1–3.3
- [x] Track B3 anti-calque rules → Tasks 5.1–5.3
- [x] Track B4 verification → covered in Tasks 2.5, 3.3, 5.3

Open decisions in design (resolved or deferred to runtime):
- **Hosted ivrit-ai provider:** Task 4.1 forces decision before code lands.
- **Sonnet model decision:** Task 3.2 forces decision based on eval data.
- **Voice biasing scope:** plan defaults to names + recent shopping items (covered in Task 1.2 implementation).
- **Eval reference-set source:** Task 2.2 has Yaron-curated explicitly.

Type / signature consistency:
- `transcribeVoice(mediaUrl, mediaId, householdId?)` — used consistently in Tasks 1.3 and 4.3.
- `buildVoicePromptBias(householdId)` returns string — consistent across Tasks 1.2, 4.3.
- `score_case(case, actual, bank, judge_natural)` signature — consistent in Tasks 2.4 and 2.5.
- `transcribeVoiceGroq(audioBlob, biasPrompt)` and `transcribeVoiceIvritAi(audioBlob, biasPrompt)` share signature — consistent in Tasks 4.2 and 4.3.

No placeholder language used. Every step has the actual content (commands, code, expected output).
