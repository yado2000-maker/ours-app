# Sheli-in-Groups Phases 2–6 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the Sheli-in-Groups product strategy from the approved brainstorm (`C:\Users\yarond\.claude\plans\brainstorming-about-shelley-in-parsed-cerf.md`). Phases 2–6 turn the strategy into code: bot-identity prompt rule, in-chat correction + cool-down, bidirectional household learning, thread-state-aware classifier, and dedicated-Sheli-group auto-detection.

**Architecture:** All behavior lives inside the Supabase Edge Function `supabase/functions/whatsapp-webhook/index.inlined.ts` (deployed via Dashboard paste, Verify JWT=OFF). Persistence piggybacks on existing tables (`whatsapp_config`, `household_patterns`, `whatsapp_messages`) to avoid new infrastructure. Haiku 4.5 stays as the classifier; prompt is extended with thread-state context and bidirectional per-household patterns. Correction flow reuses the existing quick-undo handler (`תמחקי` within 60s). No app-only value is introduced.

**Tech Stack:** TypeScript (Deno), Supabase Postgres, Anthropic Haiku 4.5 (`claude-haiku-4-5-20251001`), Sonnet 4 (`claude-sonnet-4-20250514`), esbuild for pre-deploy parse-check, Python tests (`tests/test_webhook.py`).

**Phase 1 status:** Already shipped (commit `22d300f` on `main`). `whatsapp_config.welcome_sent_at` + `claimWelcomeSend()` helper live on prod. This plan picks up from Phase 2.

---

## Prerequisites and conventions (read first)

**Never skip the esbuild parse-check before any Dashboard paste.** Silent parse errors in template literals (especially nested backticks) break deploys with cryptic messages. Run:

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

Must complete with a `Done in Xms` line. Any error = do not deploy.

**Deploy sequence per phase:**
1. Apply DB migration if any (via `mcp__f5337598__apply_migration`).
2. Parse-check.
3. Cursor-paste `index.inlined.ts` to Supabase Dashboard → Code tab → Deploy. Confirm Verify JWT=OFF.
4. Commit the code + migration on this branch. Push to main only when the user confirms (see commit-to-main rule in `CLAUDE.md`).
5. Live verify on a dev group before moving to the next task.

**Test approach:** primary regression tool is `tests/test_webhook.py` (47 integration tests against the real Edge Function). Each task adds 2–5 new cases. Never rely solely on offline classifier eval — it's out of sync.

**Anti-flake rule:** if a single test fails once with `LLM non-determinism`, re-run three times. Fail only if it's <2/3.

**Beta recovery posture is active.** `BOT_SILENT_MODE=false` (reactive ON), but `bot_settings.outbound_paused=true` and `nudges_paused=true`. None of these phases need proactive outbound. If a task in this plan ever tempts you to send unsolicited outbound, stop and flag it.

**"Commit IMMEDIATELY after Dashboard paste."** Dashboard paste is the canonical source of truth for the Edge Function. If `index.inlined.ts` is uncommitted, the next dev who pastes a different version wipes your fix. Every task that changes `index.inlined.ts` ends with a commit in the same turn.

---

## Phase 2 — Visit-not-residency + bot-identity prompt rule

Goal: Sheli holds the bot-identity line during visits (she's warm-but-external, not family). Welcome message teaches correction phrases inline so families learn them before they ever need them.

### Task 2.1: Add `VISIT_NOT_RESIDENCY` to `SHARED_GROUNDING_RULES`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (the `SHARED_GROUNDING_RULES` constant — grep to locate)

**Step 1: Write the failing test.** Add to `tests/test_webhook.py`:

```python
# In Scope category:
{
    "name": "visit_not_residency_holds_identity",
    "text": "שלי תראי איזה ציור עידו צייר בגן!",
    "expected_intent": "ignore",  # living-layer invitation; Sonnet replies via direct_address path
    "expected_reply_pattern": r"(כל הכבוד|יופי|חמוד|מדהים)",
    "negative_reply_pattern": r"(אני.*חלק.*מהמשפחה|אני.*מתרגשת.*ביחד איתכם|אנחנו משפחה)",
    "category": "Scope",
},
```

Run: `python tests/test_webhook.py --category Scope`. Expected: FAIL (the negative pattern is not yet enforced).

**Step 2: Locate `SHARED_GROUNDING_RULES` in `index.inlined.ts`.**

```bash
grep -n 'SHARED_GROUNDING_RULES\s*=' supabase/functions/whatsapp-webhook/index.inlined.ts
```

**Step 3: Add this block inside the constant (as a trailing section, separated by a blank line from the prior rule):**

```
VISIT NOT RESIDENCY (bot identity during living-moment visits):
- When a family member addresses you inside a celebration / photo-share / emotional moment, reply ONCE briefly, then STOP.
- You are a helpful assistant. You are not a family member. Never write "אני חלק מהמשפחה" / "אני מתרגשת ביחד איתכם" / "אנחנו" as if you share their experience.
- DO say: "כל הכבוד לעידו, איזה יופי!" / "חמוד מאוד" / "יופי של ציור 💚" — warm, external, short.
- DO NOT extend the moment. The next message in the thread is not yours unless they invite you again by name.
- The line: you cheered for them. You are not one of them.
```

**Step 4: Run parse-check.**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

Expected: `Done in <N>ms` with no parse errors. Watch for nested-backtick errors in the string you added.

**Step 5: Deploy to Dashboard.** Ctrl+A in Cursor → paste → Deploy → confirm success.

**Step 6: Run test.** `python tests/test_webhook.py --category Scope`. Expected: the new case PASSES. If LLM non-determinism, re-run up to 3 times.

**Step 7: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "prompt: VISIT_NOT_RESIDENCY — Sheli stays warm-but-external during invited visits"
```

---

### Task 2.2: Welcome message teaches correction phrases inline

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (the `INTRO_MESSAGE` constant — grep to locate)

**Step 1: Locate `INTRO_MESSAGE` and the 1:1 welcome text.**

```bash
grep -n 'INTRO_MESSAGE\s*=\|getOnboardingWelcome\|generateUniqueWelcome' supabase/functions/whatsapp-webhook/index.inlined.ts
```

**Step 2: Add a one-line correction hint near the end of `INTRO_MESSAGE`** (before the CTA / closing):

```
אם אני מפריעה באיזשהו רגע, פשוט תגידו "שלי שקט" ואני אלמד 🤫
```

**Step 3: Parse-check** (same command as Task 2.1 Step 4).

**Step 4: Deploy to Dashboard.**

**Step 5: Manual verify** — remove + re-add Sheli from a dev group you haven't welcomed yet (or create a fresh dev group). Confirm the welcome text includes the new correction-phrase line. No code-level test; this is a copy change.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "welcome: teach 'שלי שקט' correction phrase in group intro"
```

---

## Phase 3 — Correction + cool-down mechanism

Goal: families can correct Sheli in one word. Undo-if-recent + log-as-living-pattern + 10-min cool-down that raises the ambient threshold. Reuses the existing `תמחקי` quick-undo path.

### Task 3.1: Add `quiet_until` column to `whatsapp_config`

**Files:**
- Create: `supabase/migrations/2026_04_22_whatsapp_config_quiet_until.sql`

**Step 1: Write the migration.**

```sql
-- Phase 3 of Sheli-in-Groups: per-group cool-down after correction.
-- No new table — piggyback on whatsapp_config (one row per group anyway).
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS quiet_until TIMESTAMPTZ NULL;

-- Index only rows that are currently quiet (tiny, fast).
CREATE INDEX IF NOT EXISTS whatsapp_config_quiet_until_idx
  ON whatsapp_config (quiet_until)
  WHERE quiet_until IS NOT NULL;
```

**Step 2: Apply via MCP.**

```
mcp__f5337598__apply_migration(
  project_id="wzwwtghtnkapdwlgnrxr",
  name="whatsapp_config_quiet_until",
  query=<contents of the .sql file>
)
```

Expected response: `{"success": true}`.

**Step 3: Commit.**

```bash
git add supabase/migrations/2026_04_22_whatsapp_config_quiet_until.sql
git commit -m "db: whatsapp_config.quiet_until for per-group cool-down after correction"
```

---

### Task 3.2: Regex matcher + `isCorrectionPhrase` helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Write failing test.** Add to `tests/test_webhook.py`:

```python
{
    "name": "correction_shakat",
    "text": "שלי שקט",
    "expected_classification": "correction_applied",  # reuse existing label for quick-undo
    "expected_reply_pattern": r"(הבנתי|אוקי|שקט)",
    "category": "Correction",
},
{
    "name": "correction_lo_achshav",
    "text": "שלי לא עכשיו",
    "expected_classification": "correction_applied",
    "category": "Correction",
},
{
    "name": "correction_tirageyi",
    "text": "שלי תירגעי",
    "expected_classification": "correction_applied",
    "category": "Correction",
},
{
    "name": "correction_lo_elayich",
    "text": "שלי לא אלייך",
    "expected_classification": "correction_applied",
    "category": "Correction",
},
```

Run: `python tests/test_webhook.py --category Correction`. Expected: all FAIL.

**Step 2: Find the existing quick-undo handler in `index.inlined.ts`.**

```bash
grep -n 'תמחקי\|quick.*undo\|isQuickUndoPhrase' supabase/functions/whatsapp-webhook/index.inlined.ts
```

Note the exact line where the quick-undo detection happens — we'll add a sibling helper right next to it.

**Step 3: Add the helper.** Paste this above the existing quick-undo detection:

```ts
// Correction phrases — one-word "back off" from the family. Triggers:
//   1) undo the most recent Sheli-authored item in this group within last 5 min
//   2) log the triggering message as a living_layer_trigger household_pattern (Phase 4 wires this)
//   3) set whatsapp_config.quiet_until = NOW() + 10 min for this group
// These re-use the existing quick-undo handler's side-effects; we only widen the matcher.
const CORRECTION_PHRASES: RegExp[] = [
  /^\s*שלי[,\s]+שקט[!.]?\s*$/,
  /^\s*שלי[,\s]+לא\s+עכשיו[!.]?\s*$/,
  /^\s*שלי[,\s]+תירגעי[!.]?\s*$/,
  /^\s*שלי[,\s]+לא\s+אלייך[!.]?\s*$/,
];

function isCorrectionPhrase(text: string): boolean {
  const normalized = text.trim();
  return CORRECTION_PHRASES.some((re) => re.test(normalized));
}
```

**Step 4: Parse-check.** Same esbuild command.

**Step 5: Commit (no deploy yet — wiring happens in 3.3).**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "correction: CORRECTION_PHRASES regex + isCorrectionPhrase helper"
```

---

### Task 3.3: Wire correction phrases to the existing undo handler + cool-down

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the existing quick-undo call site in the group message handler.

**Step 1: Locate the quick-undo invocation.** It's inside the group message handler, above the classifier call. Look for the pattern that checks for `תמחקי` within 60s.

**Step 2: Extend the check to include correction phrases.** Change the branch condition from `isQuickUndoPhrase(text)` (or equivalent) to `(isQuickUndoPhrase(text) || isCorrectionPhrase(text))`. Inside the branch, after the undo executes, add:

```ts
// Correction-specific side-effects (skipped for plain תמחקי to avoid over-triggering)
if (isCorrectionPhrase(text)) {
  const quietUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase
    .from("whatsapp_config")
    .update({ quiet_until: quietUntil })
    .eq("group_id", message.groupId);
  console.log(`[Correction] ${message.groupId} quiet until ${quietUntil}`);
  // Phase 4 will add: log the PRIOR message as a living_layer_trigger household_pattern.
  // For now, leave a marker log line so Phase 4 can grep for it.
  console.log(`[Correction:TODO-Phase4] log living_layer_trigger for prior message`);
}
```

**Step 3: Acknowledgment reply.** Reply is one short line, no self-recrimination. Find the existing undo acknowledgment (e.g. `"מחקתי 👌"`) — for correction phrases, swap to `"הבנתי 🤫"`. Pattern:

```ts
const ackText = isCorrectionPhrase(text) ? "הבנתי 🤫" : "מחקתי 👌";
```

**Step 4: Parse-check.**

**Step 5: Deploy to Dashboard.**

**Step 6: Run tests.** `python tests/test_webhook.py --category Correction`. Expected: 4 new cases PASS. Run 3× to flake-filter.

**Step 7: DB verify.** Manually in psql or `mcp__f5337598__execute_sql`:

```sql
SELECT group_id, quiet_until FROM whatsapp_config WHERE quiet_until IS NOT NULL ORDER BY quiet_until DESC LIMIT 5;
```

Expected: your dev group's quiet_until is ~10 min in the future.

**Step 8: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "correction: undo + 10-min cool-down on שלי שקט / שלי לא עכשיו / שלי תירגעי / שלי לא אלייך"
```

---

### Task 3.4: Honor `quiet_until` in the group message handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the classifier-threshold path.

**Step 1: Write failing test.**

```python
{
    "name": "ambient_silent_during_cooldown",
    "setup_sql": "UPDATE whatsapp_config SET quiet_until = NOW() + INTERVAL '5 minutes' WHERE group_id = :group_id",
    "text": "צריך לקנות חלב",  # operating-ambient; would normally fire
    "expected_ai_responded": False,
    "expected_classification": "suppressed_cooldown",
    "teardown_sql": "UPDATE whatsapp_config SET quiet_until = NULL WHERE group_id = :group_id",
    "category": "Correction",
},
{
    "name": "explicit_addressing_still_works_during_cooldown",
    "setup_sql": "UPDATE whatsapp_config SET quiet_until = NOW() + INTERVAL '5 minutes' WHERE group_id = :group_id",
    "text": "שלי תוסיפי חלב לרשימה",  # explicit + operating; must fire
    "expected_ai_responded": True,
    "teardown_sql": "UPDATE whatsapp_config SET quiet_until = NULL WHERE group_id = :group_id",
    "category": "Correction",
},
```

Run: expected 2 FAIL.

**Step 2: Add the check.** Right after the group's `whatsapp_config` is fetched (there's already a fetch for `bot_active`, `language`, `group_message_count` — extend it to also select `quiet_until`), add:

```ts
const isCoolingDown = config.quiet_until && new Date(config.quiet_until) > new Date();
const hasExplicitAddress = containsShelinameAddress(message.text);  // reuse existing @שלי detector
if (isCoolingDown && !hasExplicitAddress) {
  console.log(`[Correction] Suppressed ambient in ${message.groupId} — cool-down active`);
  await logMessage(message, "suppressed_cooldown");
  return new Response("OK", { status: 200 });
}
```

Replace `containsShelinameAddress` with the actual helper name used in the file (search: `addressed_to_bot`, `containsShelimention`, or the LID/name-match logic).

**Step 3: Parse-check.**

**Step 4: Deploy.**

**Step 5: Run tests.** Expected: 2 new cases PASS + all existing tests unchanged.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "correction: suppress ambient classification during 10-min cool-down; explicit still works"
```

---

## Phase 4 — Bidirectional per-household learning

Goal: `household_patterns` now captures *both* corrections (→ quieter) and accepted invitations (→ warmer). Same message, different Sheli per family over time.

### Task 4.1: Extend `household_patterns.pattern_type` CHECK

**Files:**
- Create: `supabase/migrations/2026_04_22_household_patterns_bidirectional.sql`

**Step 1: Check the existing CHECK constraint first.**

```sql
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'household_patterns'::regclass
  AND contype = 'c'
  AND conname LIKE '%pattern_type%';
```

Use `mcp__f5337598__execute_sql`. Note the current allowed values — typically includes `nickname`, `time_expression`, `category_preference`, `compound_name`, etc.

**Step 2: Write the migration — drop + re-add the CHECK with the two new values.** Exact SQL depends on what Step 1 returned; template:

```sql
-- Phase 4 of Sheli-in-Groups: bidirectional learning.
-- Extend pattern_type CHECK to cover living-layer corrections and accepted invitations.
ALTER TABLE household_patterns
  DROP CONSTRAINT IF EXISTS household_patterns_pattern_type_check;

ALTER TABLE household_patterns
  ADD CONSTRAINT household_patterns_pattern_type_check
  CHECK (pattern_type IN (
    -- ... existing values from Step 1 ...
    'nickname',
    'time_expression',
    'category_preference',
    'compound_name',
    -- NEW:
    'living_layer_trigger',
    'invitation_accepted'
  ));
```

**Step 3: Apply via MCP `apply_migration`.**

**Step 4: Verify.**

```sql
-- Should succeed:
INSERT INTO household_patterns (household_id, pattern_type, pattern_value, count)
VALUES ('hh_test', 'living_layer_trigger', 'תאסוף את שושי עכשיו', 1)
ON CONFLICT DO NOTHING;

DELETE FROM household_patterns WHERE household_id = 'hh_test';
```

**Step 5: Commit.**

```bash
git add supabase/migrations/2026_04_22_household_patterns_bidirectional.sql
git commit -m "db: household_patterns allows living_layer_trigger + invitation_accepted pattern_types"
```

---

### Task 4.2: `logLivingLayerTrigger` helper, wired from correction handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Locate the existing `household_patterns` helpers.**

```bash
grep -n 'household_patterns\|logPattern\|logHouseholdPattern' supabase/functions/whatsapp-webhook/index.inlined.ts
```

**Step 2: Add helper next to the existing ones:**

```ts
// Log the message that Sheli misfired on (the PRIOR user message in this group)
// as a living_layer_trigger pattern for the household. Used after a correction phrase.
async function logLivingLayerTrigger(
  householdId: string,
  groupId: string,
  correctionMsgId: string
): Promise<void> {
  // Find the most recent user message BEFORE the correction (window: 5 min)
  const { data: prior } = await supabase
    .from("whatsapp_messages")
    .select("message_text, sender_phone, created_at")
    .eq("group_id", groupId.split("@")[0])
    .neq("message_id", correctionMsgId)
    .lt("created_at", new Date().toISOString())
    .gt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .neq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!prior?.message_text) return;

  await supabase.rpc("upsert_household_pattern", {
    p_household_id: householdId,
    p_pattern_type: "living_layer_trigger",
    p_pattern_value: prior.message_text.substring(0, 140),
  });
  console.log(`[Patterns] living_layer_trigger logged for ${householdId}: "${prior.message_text.substring(0, 60)}..."`);
}
```

If `upsert_household_pattern` RPC doesn't exist, replace with direct INSERT using `ON CONFLICT` on `(household_id, pattern_type, pattern_value)` incrementing `count`. Check with `grep upsert_household_pattern` first.

**Step 3: Replace the `TODO-Phase4` marker from Task 3.3 with the call:**

```ts
await logLivingLayerTrigger(config.household_id, message.groupId, message.messageId);
```

**Step 4: Parse-check. Deploy.**

**Step 5: Live verify.** In a dev group: send a deliberately ambient-living-layer message (e.g. `תאסוף את שושי עכשיו!`); if Sheli misfires, respond `שלי שקט`. Then query:

```sql
SELECT pattern_type, pattern_value, count FROM household_patterns
WHERE household_id = 'your_dev_household'
AND pattern_type = 'living_layer_trigger';
```

Expected: one row with the offending prior message text.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "patterns: log living_layer_trigger from correction handler"
```

---

### Task 4.3: Log `invitation_accepted` for successful visits

Strategy: when Sheli visits a living-layer moment (explicit address + `living_vs_operating=living` in Phase 5, OR existing `addressed_to_bot=true` + a heuristic living-layer check for now), log it optimistically as `invitation_accepted` with a `pending_until` timestamp in a side column. If a correction phrase fires within 10 min, the correction handler deletes the pending pattern. Otherwise it stands.

Because `household_patterns` doesn't have `pending_until`, use a small separate column or encode in `pattern_value` with a TTL marker. Simplest: add a nullable `pending_until TIMESTAMPTZ` column.

**Files:**
- Create: `supabase/migrations/2026_04_22_household_patterns_pending_until.sql`
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Migration.**

```sql
ALTER TABLE household_patterns
  ADD COLUMN IF NOT EXISTS pending_until TIMESTAMPTZ NULL;

-- Optional sweep to permanently retain rows whose pending_until has passed:
-- (runs naturally — no cron needed; we just check NOW() > pending_until on read.)
```

Apply.

**Step 2: Add helper `logInvitationPending`:**

```ts
async function logInvitationPending(
  householdId: string,
  messageText: string
): Promise<string | null> {
  const pendingUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("household_patterns")
    .insert({
      household_id: householdId,
      pattern_type: "invitation_accepted",
      pattern_value: messageText.substring(0, 140),
      count: 1,
      pending_until: pendingUntil,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[Patterns] logInvitationPending failed:", error);
    return null;
  }
  return data?.id ?? null;
}
```

**Step 3: Correction handler deletes matching pending patterns.** In Task 3.3's correction branch, add:

```ts
// If the family just corrected a prior visit, retract it — not accepted after all.
await supabase
  .from("household_patterns")
  .delete()
  .eq("household_id", config.household_id)
  .eq("pattern_type", "invitation_accepted")
  .gt("pending_until", new Date().toISOString());
```

**Step 4: Call `logInvitationPending` at the visit-reply site.** For now, trigger on any explicit-address living-layer reply (Phase 5 will give a proper `living` classification). Until then, proxy: when Sheli replies with an `addressed_to_bot=true` but the message has a celebration-y word (photo attachment, 🎉/👶/❤️ emoji in recent messages, or a chag greeting in the last 5 messages).

Accept that this heuristic is temporary — Phase 5 replaces it. Leave a comment:

```ts
// TEMP heuristic until Phase 5 ships living_vs_operating.
// Replace this with: classification.living_vs_operating === "living".
```

**Step 5: Parse-check. Deploy.**

**Step 6: Live verify.** Invite Sheli into a celebration (`שלי תראי!` + an emoji). Query `household_patterns` — should show a `pending_until` row. After 10 min without correction, the row becomes a permanent accepted pattern (detect with `pending_until < NOW()`).

**Step 7: Commit.**

```bash
git add supabase/migrations/2026_04_22_household_patterns_pending_until.sql supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "patterns: log invitation_accepted (pending, auto-retracted on correction within 10 min)"
```

---

### Task 4.4: Inject both pattern types into Haiku classifier prompt

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the Haiku prompt builder.

**Step 1: Locate existing FAMILY PATTERNS injection.**

```bash
grep -n 'FAMILY PATTERNS\|pattern_type\|household_patterns' supabase/functions/whatsapp-webhook/index.inlined.ts
```

**Step 2: Extend the fetch to include both new pattern types:**

```ts
const { data: patterns } = await supabase
  .from("household_patterns")
  .select("pattern_type, pattern_value, count, pending_until")
  .eq("household_id", householdId)
  .in("pattern_type", [
    "nickname", "time_expression", "category_preference", "compound_name",
    "living_layer_trigger",
    "invitation_accepted",
  ])
  .order("count", { ascending: false })
  .limit(30);
```

Filter out still-pending `invitation_accepted` rows (only permanent ones inform the classifier):

```ts
const nowIso = new Date().toISOString();
const activePatterns = (patterns || []).filter(
  (p) => p.pattern_type !== "invitation_accepted" || !p.pending_until || p.pending_until < nowIso
);
```

**Step 3: Render into the prompt.** Two new FAMILY PATTERNS subsections:

```
LIVING-LAYER PHRASES THIS FAMILY USES (do NOT classify these as operating):
- "<pattern_value>"
- "<pattern_value>"

INVITATIONS THIS FAMILY HAS ACCEPTED (ok to visit warmly next time you see something similar):
- "<pattern_value>"
```

If either list is empty, omit the subsection header.

**Step 4: Parse-check. Deploy.**

**Step 5: Write a classifier test.** Seed a dev household with a `living_layer_trigger` of `תאסוף את שושי עכשיו` via SQL. Send the same message ambient; confirm classification is `ignore` (not `add_task`).

```python
{
    "name": "household_pattern_suppresses_misclassification",
    "setup_sql": "INSERT INTO household_patterns (household_id, pattern_type, pattern_value, count) VALUES (:hh, 'living_layer_trigger', 'תאסוף את שושי עכשיו', 3) ON CONFLICT DO NOTHING",
    "text": "תאסוף את שושי עכשיו",
    "expected_intent": "ignore",
    "teardown_sql": "DELETE FROM household_patterns WHERE household_id = :hh AND pattern_type = 'living_layer_trigger'",
    "category": "Patterns",
},
```

Run: expected PASS after deploy.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "classifier: inject living_layer_trigger + invitation_accepted into FAMILY PATTERNS"
```

---

## Phase 5 — Thread-state context in classifier

**Biggest blast radius.** Ship Phases 2–4 first so the safety net catches misfires.

Goal: Haiku sees the last ~5 group messages + time-gap + living-density signal. Outputs a new `living_vs_operating` field. Group handler routes by 3×2 matrix cell instead of raw intent alone.

### Task 5.1: Add `living_vs_operating` field to Haiku output schema

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts` (schema — though this file is dev reference, keep in sync).
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the Haiku prompt + JSON schema definition (inlined copy is authoritative).

**Step 1: Locate the Haiku JSON schema in `index.inlined.ts`.**

```bash
grep -n '"intent":\s*{\|json_schema\|response_format' supabase/functions/whatsapp-webhook/index.inlined.ts
```

**Step 2: Add `living_vs_operating` to the schema:**

```ts
living_vs_operating: {
  type: "string",
  enum: ["operating", "ambiguous", "living"],
  description: "Which layer this message belongs to. operating = planning/tracking/remembering/deciding (shopping, tasks, reminders, events, expenses). living = doing/reacting/urging/sharing/emoting right now. ambiguous = could be either without more context.",
},
```

And add it to the `required` array.

**Step 3: Add layer-discrimination guidance + 10 paired few-shots to the Haiku prompt.** At the end of the prompt (before the user message), inject:

```
LAYER DISCRIMINATION (living vs operating):
- operating: structured planning language. explicit time/date, named assignee, shopping items, reminders, events, expenses. "לאסוף את שושי בארבע", "להוסיף חלב", "תזכירי לי מחר ב-8", "שילמתי 200 על פיצה".
- living: urgency-now, deictic commands, exclamations, photos-and-reactions, chag greetings, indirect pleas to unnamed family. "תזדרזו!", "מישהו יכול?", "תאסוף את שושי עכשיו!", "חג שמח", "וואו".
- ambiguous: genuinely unclear without context. "תאסוף את שושי" (no time, no urgency) alone could be either. In ambient mode, silent is safer.

Paired few-shots:
- "לקנות חלב" → operating
- "לקנות חלב?!" → living  (exclamation + question = live moment)
- "נצטרך לאסוף את שושי בארבע" → operating
- "תאסוף את שושי עכשיו" → living  (now-marker)
- "צריך תור לרופא שיניים לעידו" → operating
- "תזדרזו כבר!" → living
- "שלי תראי את הציור של עידו" → living  (explicit + celebration)
- "שלי תזכירי לי מחר ב-9" → operating  (explicit + planning)
- "מישהו יביא יין בדרך?" → living  (indirect plea, no time)
- "תקראי לאמא שתבוא לארוחה בשבת" → operating  (planning with time)
```

**Step 4: Parse-check. Deploy.**

**Step 5: Write tests for the new field.** Add 10 tests covering the few-shots above, checking `classification_data.living_vs_operating`.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts supabase/functions/_shared/haiku-classifier.ts tests/test_webhook.py
git commit -m "classifier: living_vs_operating field + layer-discrimination prompt with paired few-shots"
```

---

### Task 5.2: Thread-state header construction

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — just before the Haiku call in the group handler.

**Step 1: Add helper `buildThreadStateHeader`:**

```ts
async function buildThreadStateHeader(groupId: string, currentMessageTs: string): Promise<string> {
  const { data: recent } = await supabase
    .from("whatsapp_messages")
    .select("message_text, sender_phone, created_at")
    .eq("group_id", groupId.split("@")[0])
    .lt("created_at", currentMessageTs)
    .order("created_at", { ascending: false })
    .limit(5);
  if (!recent || recent.length === 0) return "";

  const msgs = recent.reverse();  // chronological
  const gapSec = Math.floor((new Date(currentMessageTs).getTime() - new Date(msgs[msgs.length - 1].created_at).getTime()) / 1000);
  const lines = msgs.map((m) => {
    const t = m.created_at.slice(11, 16);  // HH:MM
    const who = m.sender_phone || "?";
    const txt = (m.message_text || "").slice(0, 120);
    return `[${t} ${who}] ${txt}`;
  }).join("\n");

  // Living-density heuristic: count emoji-only or <20-char reactive messages
  const reactiveCount = msgs.filter((m) => {
    const t = (m.message_text || "").trim();
    return t.length < 20 || /^[\p{Emoji}\s]+$/u.test(t);
  }).length;
  const density = reactiveCount >= 3 ? "high (rapid reactive thread)" : reactiveCount >= 1 ? "medium" : "low";

  return `THREAD STATE:
Last 5 messages in this group (chronological):
${lines}
Time gap to current message: ${gapSec}s
Living-layer density: ${density}

`;
}
```

**Step 2: Inject the header into the Haiku user message.** Where the current Haiku user message is built (just `message.text` today), prepend the header:

```ts
const threadState = await buildThreadStateHeader(message.groupId, message.timestamp);
const userPromptForHaiku = threadState + `CURRENT MESSAGE:\n${message.text}`;
```

**Step 3: Parse-check. Deploy.**

**Step 4: Cost sanity check.** Run 100 real messages through the classifier in a log-only mode; sum input tokens before vs. after. Acceptable threshold: +30% input tokens, absolute cost still < $0.001/message.

Use `mcp__f5337598__execute_sql`:

```sql
SELECT
  AVG((classification_data->>'input_tokens')::int) AS avg_input,
  AVG((classification_data->>'output_tokens')::int) AS avg_output
FROM whatsapp_messages
WHERE created_at > NOW() - INTERVAL '1 hour'
  AND classification LIKE 'haiku_%';
```

If avg_input is >+40% over baseline, tune the header (shorter message previews, drop time gap, etc.).

**Step 5: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "classifier: thread-state header (last 5 msgs + time-gap + living-density)"
```

---

### Task 5.3: Route by 3×2 matrix cell

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the routing block after Haiku returns.

**Step 1: Add matrix router.** Replace the existing confidence-gate branching with:

```ts
type MatrixCell =
  | "explicit_operating" | "explicit_ambiguous" | "explicit_living"
  | "ambient_operating" | "ambient_ambiguous" | "ambient_living";

function resolveMatrixCell(classification: { addressed_to_bot: boolean; living_vs_operating: string }): MatrixCell {
  const addr = classification.addressed_to_bot ? "explicit" : "ambient";
  const layer = (classification.living_vs_operating || "ambiguous") as "operating" | "ambiguous" | "living";
  return `${addr}_${layer}` as MatrixCell;
}

// Actions per cell:
// explicit_operating -> Chatty: full reply + action (current path)
// explicit_ambiguous -> Chatty: clarify or act on best reading
// explicit_living    -> Visit: one mirrored reply, return
// ambient_operating  -> Act: compact one-line confirm
// ambient_ambiguous  -> Silent (no reply, no action)
// ambient_living     -> Silent
```

**Step 2: Wire each cell.** Most cells map to existing paths; `ambient_ambiguous` and `ambient_living` become explicit silent-returns. `explicit_living` triggers visit logic (Sonnet reply with VISIT_NOT_RESIDENCY + `logInvitationPending`).

**Step 3: Write 15 matrix cell tests.** One per cell with 2–3 variants. Use the few-shots from Task 5.1 expanded with explicit/ambient variations.

**Step 4: Parse-check. Deploy.**

**Step 5: Run full test suite** — not just the new cases, the full 47 + new ones. Target: ≥93% pass. Re-run any flake 3×.

**Step 6: Commit.**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "group-handler: route by 3x2 matrix (address × layer) — silent on ambient ambiguous/living"
```

---

## Phase 6 — Dedicated-Sheli-group auto-detection

Goal: auto-detect groups that are dedicated-Sheli (name contains `שלי` AND high addressed-ratio). Relax thresholds in the matrix for these groups. Any uncertainty falls back to family-chat mode. No user-facing setting.

### Task 6.1: Add `group_mode` to `whatsapp_config`

**Files:**
- Create: `supabase/migrations/2026_04_22_whatsapp_config_group_mode.sql`

**Step 1: Migration.**

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS group_mode TEXT NOT NULL DEFAULT 'family_chat'
  CHECK (group_mode IN ('family_chat', 'dedicated_sheli'));
```

Apply.

**Step 2: Commit migration.**

---

### Task 6.2: Detection heuristic (name + address-ratio, both required)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — add detection helper, call after every Nth message.

**Step 1: Add helper:**

```ts
const DEDICATED_NAME_RE = /(^|\s)שלי(\s|$|[^א-ת])/;

async function maybePromoteGroupMode(
  groupId: string,
  groupName: string | null,
  householdId: string
): Promise<void> {
  // Require BOTH: name mentions שלי AND address-ratio >= 40% over first 50 messages.
  // Hebrew gotcha: שלי also means "mine" — so המשפחה שלי (my family) is a family chat.
  // Only promote when the second signal confirms.
  if (!groupName || !DEDICATED_NAME_RE.test(groupName)) return;

  const { count: total } = await supabase
    .from("whatsapp_messages")
    .select("message_id", { count: "exact", head: true })
    .eq("household_id", householdId);
  if (!total || total < 20) return;  // not enough signal yet

  const { count: addressed } = await supabase
    .from("whatsapp_messages")
    .select("message_id", { count: "exact", head: true })
    .eq("household_id", householdId)
    .eq("classification_data->>addressed_to_bot", "true");

  const ratio = (addressed || 0) / total;
  const isDedicated = ratio >= 0.40;

  await supabase
    .from("whatsapp_config")
    .update({ group_mode: isDedicated ? "dedicated_sheli" : "family_chat" })
    .eq("group_id", groupId);
  console.log(`[GroupMode] ${groupId} (${groupName}): ratio ${ratio.toFixed(2)} → ${isDedicated ? "dedicated_sheli" : "family_chat"}`);
}
```

**Step 2: Call after every 10th message** (cheap sweep). In the group message handler, after classification:

```ts
if ((config.group_message_count || 0) % 10 === 0) {
  const groupInfo = await fetchGroupInfo(message.groupId).catch(() => null);
  await maybePromoteGroupMode(message.groupId, groupInfo?.name || null, config.household_id);
}
```

**Step 3: Parse-check. Deploy.**

**Step 4: Commit.**

---

### Task 6.3: Matrix override for `dedicated_sheli` mode

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — the router from Task 5.3.

**Step 1: Adjust `ambient_ambiguous` routing for dedicated groups.**

```ts
if (cell === "ambient_ambiguous" && config.group_mode === "dedicated_sheli") {
  // In dedicated groups, ambient ambiguous is Visit-worthy (not silent).
  // Reply with a short clarification or best-reading action.
  return await handleVisit(...);
}
```

Keep `ambient_living` silent even in dedicated groups — emoji-reactions and chag greetings don't want replies regardless of mode.

**Step 2: Write tests** with setup_sql that flips `group_mode = 'dedicated_sheli'` for the test household.

**Step 3: Parse-check. Deploy.**

**Step 4: Commit.**

---

## Final verification (post-all-phases)

**End-to-end checklist** (copy from approved brainstorm plan `verification` section):

1. `python tests/test_webhook.py` — full suite. Target ≥93% on new cases, no regression on existing 47.
2. Haiku cost delta: measure avg input tokens before (from git-log of last week's metrics) vs. after. Must be < $0.001/classification.
3. Manual correction + cool-down: dev group, force misfire, send `שלי שקט`, verify undo + pattern logged + 10-min suppression + explicit tag still works.
4. Manual bidirectional learning: seed `living_layer_trigger` in household A, `invitation_accepted` in household B, send identical borderline message to both, verify divergent Haiku outputs.
5. Manual dedicated-group detection: test three group names (`המשפחה שלי`, `שלי של בית כהן`, `משפחת Y`) × varying addressed-ratios, confirm name-AND-ratio gate.
6. Welcome dedup (Phase 1, already verified) — trigger group_joined twice, one intro.
7. Visit-not-residency: `שלי תראי!` in a celebration, one warm reply, silence next 5 ambient messages until re-invited.

**Metrics to monitor for 2 weeks post-ship:**
- Intrusion rate (corrections ÷ Sheli-initiated messages) — should trend to zero per household.
- Missed-ask proxy (@שלי tags that re-state prior ambient content within 10 min) — should stay flat or decrease.
- Welcome dedup = exactly 1.0.
- Haiku cost delta stays under $0.001/classification.

**Rollback plan per phase:**
- Phase 2 (prompt-only): Dashboard revert to previous version, no DB touch.
- Phase 3 (cool-down): `UPDATE whatsapp_config SET quiet_until = NULL` then Dashboard revert.
- Phase 4 (patterns): `DELETE FROM household_patterns WHERE pattern_type IN ('living_layer_trigger','invitation_accepted')` + Dashboard revert. CHECK can stay (harmless).
- Phase 5 (classifier): Dashboard revert — this is the biggest risk. Field `living_vs_operating` can remain in schema unused.
- Phase 6 (group_mode): `UPDATE whatsapp_config SET group_mode = 'family_chat'` + Dashboard revert.
