# update_event + update_reminder in group path — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship structured UPDATE/REMOVE capability for events + reminders in the group path, replacing `handleCorrection`'s delete+reinsert with a Sonnet-driven structured-output flow.

**Architecture:** Option B (gated Sonnet-ACTIONS). On `correct_bot` in group mode, a dedicated `buildCorrectionPrompt` + Sonnet call returns `{action:"update"|"remove"|"clarify", ...}` JSON. Dispatch goes through a new `executeCrudAction` helper extracted from the 1:1 CRUD block at `index.inlined.ts:5066-5122` and reused by both paths. Old `handleCorrection` body is deleted.

**Tech Stack:** Deno / TypeScript, Supabase Edge Function (single-file `index.inlined.ts`), Claude Sonnet 4 (`claude-sonnet-4-20250514`), Python integration tests (`tests/test_webhook.py`) against the live deployed Edge Function.

**Design doc:** [docs/plans/2026-04-23-update-event-reminder-design.md](2026-04-23-update-event-reminder-design.md)

---

## Pre-flight

Before any task: read `CLAUDE.md` at repo root end-to-end. The project has dozens of non-obvious production gotchas (paste-corruption, bundler sensitivity to nested backticks, `reminder_queue` schema quirks, bot phone = `972555175553`, test phone = `972552482290`). Violating any of them lands a cryptic bug.

**Key references:**
- Design doc linked above.
- `handleCorrection` at `supabase/functions/whatsapp-webhook/index.inlined.ts:11289` (call site: `:8522`).
- Existing 1:1 CRUD block at `supabase/functions/whatsapp-webhook/index.inlined.ts:5066-5122`.
- Integration test pattern: `tests/test_webhook.py`, class `TestPrivateDmReminders` (~L2100).
- `buildReplyPrompt` (for Sonnet-call infrastructure reuse): `index.inlined.ts:1505`.
- `toIsraelTimeStr` + `ilOffsetMs` (DST-safe time helpers): search `index.inlined.ts`.
- `sendAndLog`, `logMessage`: standard send+audit wrappers, use unchanged.

**Parse-check command (run after EVERY edit to `index.inlined.ts`):**

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app/.claude/worktrees/ecstatic-goldstine-8b263d"
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

Expected: silent success (warnings about unresolved `jsr:*` / `npm:*` are fine; any `ERROR` with line+col is a real bug).

---

## Task 1: Extract `executeCrudAction` helper (pure refactor, no behavior change)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:5066-5122`
- (New helper lives inline, near the top of the file's "action executor" section — search for `case "update_shopping"` to locate current code.)

**Goal:** Extract the existing 1:1 CRUD block into a standalone `async function executeCrudAction(...)`. No semantic change yet. This is a refactor that unblocks Task 2 + future reuse from the group correction path.

**Step 1: Write the failing test**

Add a file-level sanity test in `tests/test_webhook.py` near `TestPrivateDmReminders`:

```python
class TestCrudHelper:
    """Task 1 regression — 1:1 CRUD path still works end-to-end after extraction."""

    def test_01_update_shopping_still_works_1on1(self):
        """Baseline: the 1:1 update_shopping path (which drives the extraction) must not regress."""
        phone = TEST_PHONE_1  # 972552482290
        # Step 1: add item
        send_direct_message(phone, "תוסיפי פסטה לרשימה")
        time.sleep(3)
        # Step 2: correct name
        send_direct_message(phone, "תתקני לפסטה פנה")
        time.sleep(3)
        # Assert one row with updated name
        rows = fetch_shopping(phone)
        pasta = [r for r in rows if "פסטה" in r["name"]]
        assert len(pasta) == 1, f"Expected exactly 1 pasta row, got {len(pasta)}: {pasta}"
        assert pasta[0]["name"] == "פסטה פנה", f"Expected renamed row, got {pasta[0]['name']}"
```

**Step 2: Run test to verify it passes on current code (baseline)**

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app/.claude/worktrees/ecstatic-goldstine-8b263d"
python -m pytest tests/test_webhook.py::TestCrudHelper -v
```

Expected: PASS (this is a regression net — current behavior must be preserved by the refactor).

**Step 3: Extract the helper**

Add this function near `function haikuEntitiesToActions` or above the existing case block (keep close for readability):

```typescript
type CrudAction = {
  type: "update_event" | "update_reminder" | "update_task" | "update_shopping"
       | "remove_event" | "remove_reminder" | "remove_task" | "remove_shopping";
  // Identification (either a fuzzy search string OR a direct id)
  target_id?: string;
  old_name?: string; old_text?: string; old_title?: string;
  name?: string; text?: string; title?: string;
  // Update payload
  new_name?: string; new_text?: string; new_title?: string;
  new_send_at?: string; new_date?: string; new_time?: string;
  new_scheduled_for?: string;
};

async function executeCrudAction(
  householdId: string,
  action: CrudAction,
  logPrefix: string,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const CRUD_MAP: Record<string, { table: string; matchCol: string; activeFilter?: Record<string, any> }> = {
    update_shopping:  { table: "shopping_items",  matchCol: "name",         activeFilter: { got: false } },
    update_task:      { table: "tasks",           matchCol: "title",        activeFilter: { done: false } },
    update_reminder:  { table: "reminder_queue",  matchCol: "message_text", activeFilter: { sent: false } },
    update_event:     { table: "events",          matchCol: "title" },
    remove_shopping:  { table: "shopping_items",  matchCol: "name",         activeFilter: { got: false } },
    remove_task:      { table: "tasks",           matchCol: "title",        activeFilter: { done: false } },
    remove_reminder:  { table: "reminder_queue",  matchCol: "message_text", activeFilter: { sent: false } },
    remove_event:     { table: "events",          matchCol: "title" },
  };
  const cfg = CRUD_MAP[action.type];
  if (!cfg) return { ok: false, summary: "", error: "unknown_action_type" };
  const isRemove = action.type.startsWith("remove_");

  // Resolve target row. Prefer direct id (authoritative — Task 2 path).
  let match: { id: string; scheduled_for?: string | null } | null = null;
  if (action.target_id) {
    let q = supabase.from(cfg.table).select("id, scheduled_for").eq("household_id", householdId).eq("id", action.target_id);
    if (cfg.activeFilter) for (const [k, v] of Object.entries(cfg.activeFilter)) q = q.eq(k, v);
    const { data, error } = await q.limit(1).single();
    if (!error && data) match = data as any;
  }
  // Fall back to fuzzy match (1:1 path legacy — Sonnet emits old_text/old_title).
  if (!match) {
    const searchText = isRemove
      ? (action.name || action.text || action.title)
      : (action.old_name || action.old_text || action.old_title);
    if (!searchText) return { ok: false, summary: "", error: "no_target" };
    let exactQ = supabase.from(cfg.table).select("id, scheduled_for").eq("household_id", householdId).eq(cfg.matchCol, searchText);
    if (cfg.activeFilter) for (const [k, v] of Object.entries(cfg.activeFilter)) exactQ = exactQ.eq(k, v);
    let { data: exact } = await exactQ.order("created_at", { ascending: false }).limit(1).single();
    if (!exact) {
      let fuzzyQ = supabase.from(cfg.table).select("id, scheduled_for").eq("household_id", householdId).ilike(cfg.matchCol, `%${searchText}%`);
      if (cfg.activeFilter) for (const [k, v] of Object.entries(cfg.activeFilter)) fuzzyQ = fuzzyQ.eq(k, v);
      const { data: fuzzy } = await fuzzyQ.order("created_at", { ascending: false }).limit(1).single();
      exact = fuzzy;
    }
    match = (exact as any) || null;
  }
  if (!match) return { ok: false, summary: "", error: "not_found" };

  if (isRemove) {
    if (cfg.table === "reminder_queue") {
      // Soft-cancel: preserve audit trail.
      const { error: updErr } = await supabase
        .from(cfg.table)
        .update({ sent: true, metadata: { cancelled_by_user: true, cancelled_at: new Date().toISOString() } })
        .eq("id", match.id)
        .eq("household_id", householdId);
      if (updErr) { console.error(`${logPrefix} ${action.type} soft-cancel error:`, updErr); return { ok: false, summary: "", error: "db_error" }; }
    } else {
      const { error: delErr } = await supabase.from(cfg.table).delete().eq("id", match.id).eq("household_id", householdId);
      if (delErr) { console.error(`${logPrefix} ${action.type} delete error:`, delErr); return { ok: false, summary: "", error: "db_error" }; }
    }
    console.log(`${logPrefix} Removed ${cfg.table}: ${match.id}`);
    return { ok: true, summary: `בוטלה ${cfg.table === "events" ? "אירוע" : cfg.table === "reminder_queue" ? "תזכורת" : "שורה"}` };
  }

  // UPDATE
  const updates: Record<string, any> = {};
  if (action.new_name) updates.name = action.new_name;
  if (action.new_text) updates[cfg.matchCol] = action.new_text;
  if (action.new_title) updates.title = action.new_title;
  if (action.new_send_at) updates.send_at = new Date(action.new_send_at).toISOString();
  if (action.new_scheduled_for) updates.scheduled_for = new Date(action.new_scheduled_for).toISOString();
  if (action.new_date) {
    updates.scheduled_for = `${action.new_date}${action.new_time ? "T" + action.new_time + ":00+03:00" : "T18:00:00+03:00"}`;
  } else if (action.new_time && match.scheduled_for) {
    const d = new Date(match.scheduled_for);
    const israelDate = d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    updates.scheduled_for = `${israelDate}T${action.new_time}:00+03:00`;
  }
  if (Object.keys(updates).length === 0) return { ok: false, summary: "", error: "no_changes" };

  const { error: updErr } = await supabase
    .from(cfg.table)
    .update(updates)
    .eq("id", match.id)
    .eq("household_id", householdId);
  if (updErr) { console.error(`${logPrefix} ${action.type} error:`, updErr); return { ok: false, summary: "", error: "db_error" }; }
  console.log(`${logPrefix} Updated ${cfg.table}: ${match.id}`);
  return { ok: true, summary: `עדכנתי ${cfg.table === "events" ? "אירוע" : cfg.table === "reminder_queue" ? "תזכורת" : "שורה"}` };
}
```

**Step 4: Replace the original inline block at L5066-5122 with a helper call**

```typescript
// --- UPDATE / REMOVE actions (table-driven) ---
case "update_shopping": case "update_task": case "update_reminder": case "update_event":
case "remove_shopping": case "remove_task": case "remove_reminder": case "remove_event": {
  await executeCrudAction(householdId, action as CrudAction, logPrefix);
  break;
}
```

**Step 5: Parse check**

Run the esbuild command from Pre-flight. Expected: no ERRORs.

**Step 6: Run the regression test**

Note: this test hits the live deployed Edge Function. We need to deploy first. Two options:
- (a) Skip this test for now with `@pytest.mark.skip(reason="Task 1 not deployed yet — runs in Task 8 smoke test")` and rely on Task 2+3 tests to cover behavior.
- (b) Deploy after Task 1 (higher risk, uncommon pattern).

**Pick (a) for Task 1.** Uncomment in Task 8.

**Step 7: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "refactor: extract executeCrudAction helper from 1:1 path

Pure refactor, no behavior change. Prepares for group-path correction
handler in Task 2. Adds target_id support, explicit household_id in WHERE,
soft-cancel for reminder removes, and {ok,summary,error} return shape."
```

---

## Task 2: Add `buildCorrectionPrompt` Sonnet-call infrastructure

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — add new function near `buildReplyPrompt` (~L1505).

**Goal:** Produce the prompt + Sonnet call that returns `{action, ...}` JSON. No dispatch yet — that's Task 3.

**Step 1: Write the failing test**

Add to `TestCorrectBotV2` class (new class) in `tests/test_webhook.py`:

```python
class TestCorrectBotV2:
    """Group-path correction with Sonnet-ACTIONS (update/remove/clarify)."""

    def test_08_malformed_sonnet_falls_back_to_clarify(self):
        """Mocked Sonnet JSON parse failure → clarify reply, no DB change.
        This test is last-numbered but first-written: it validates the plumbing exists."""
        # Pre-condition: seed an event so there's a candidate row.
        group_id = TEST_GROUP_1
        send_group_message(group_id, TEST_PHONE_1, "יש אירוע מחר בשמונה בערב — תה עם סבתא")
        time.sleep(4)
        # Send a correction that the Sonnet harness will mock as malformed.
        # (Requires test hook: env var CORRECTION_SONNET_MOCK=malformed on the Edge Function.)
        send_group_message(group_id, TEST_PHONE_1, "תתקני את זה")
        time.sleep(4)
        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any("תוכלי" in r["message_text"] or "שוב" in r["message_text"] for r in replies), \
            f"Expected clarification ask, got: {[r['message_text'] for r in replies]}"
        # Assert DB unchanged: still one event row.
        events = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events) == 1, f"Expected no new event inserts on clarify, got {len(events)}"
```

**Step 2: Run test to confirm it fails**

```bash
python -m pytest tests/test_webhook.py::TestCorrectBotV2::test_08_malformed_sonnet_falls_back_to_clarify -v
```

Expected: FAIL ("function not defined" or "no clarification in replies"). Test will actually skip until deploy — mark with `@pytest.mark.skip` until Task 7.

**Step 3: Implement `buildCorrectionPrompt`**

Add near `buildReplyPrompt` (L1505):

```typescript
type CandidateRow = {
  id: string;
  kind: "event" | "reminder";
  title: string;
  whenLocal: string; // pre-formatted Israel-time string
};

type SheliActionSummary = {
  whenLocal: string; // "לפני 3 דק'"
  text: string;
};

function buildCorrectionPrompt(
  correctionText: string,
  recentContext: Array<{ sender: string; text: string; whenLocal: string }>,
  candidates: CandidateRow[],
  recentSheliActions: SheliActionSummary[],
): string {
  const contextBlock = recentContext.length
    ? recentContext.map((m) => `[${m.whenLocal}] ${m.sender}: ${m.text}`).join("\n")
    : "(אין הקשר אחרון)";
  const sheliBlock = recentSheliActions.length
    ? recentSheliActions.map((s) => `[${s.whenLocal}] ${s.text}`).join("\n")
    : "(אין פעולות אחרונות)";
  const candidateBlock = candidates.length
    ? candidates.map((c) => `[${c.id}] ${c.kind === "event" ? "אירוע" : "תזכורת"}: "${c.title}" — ${c.whenLocal}`).join("\n")
    : "(אין שורות מועמדות)";

  return `את שלי. המשפחה תיקנה אותך. המטרה שלך: להבין מה הם רוצים לשנות ולהחזיר JSON אחד.

הקשר אחרון (15 דקות):
${contextBlock}

פעולות אחרונות שלך:
${sheliBlock}

שורות מועמדות לעדכון (מקסימום 10):
${candidateBlock}

ההודעה המתקנת: "${correctionText}"

כללים:
- target_id חייב להיות מתוך הרשימה. אם לא מזהה — החזירי clarify.
- new_scheduled_for / new_send_at ב-ISO 8601 עם offset מפורש (+03:00 בקיץ, +02:00 בחורף).
- כללי רק שדות שבאמת משתנים. null או השמטה = לא לשנות.
- clarify.ask הוא הטקסט בעברית שיישלח לקבוצה כשאלת הבהרה.

החזירי JSON אחד בלבד, בלי טקסט נוסף. אחד משלושה:
{"action":"update","target_id":"<id>","target_type":"event"|"reminder","new_scheduled_for":"<iso?>","new_send_at":"<iso?>","new_title":"<str?>","new_text":"<str?>"}
{"action":"remove","target_id":"<id>","target_type":"event"|"reminder"}
{"action":"clarify","reason":"<string>","ask":"<Hebrew question>"}`;
}
```

**Step 4: Implement `callCorrectionSonnet`**

```typescript
type CorrectionSonnetResult =
  | { action: "update"; target_id: string; target_type: "event" | "reminder"; new_scheduled_for?: string; new_send_at?: string; new_title?: string; new_text?: string }
  | { action: "remove"; target_id: string; target_type: "event" | "reminder" }
  | { action: "clarify"; reason?: string; ask: string };

async function callCorrectionSonnet(prompt: string): Promise<CorrectionSonnetResult> {
  // Test hook for Task 2 integration test.
  const mock = Deno.env.get("CORRECTION_SONNET_MOCK");
  if (mock === "malformed") return { action: "clarify", reason: "mocked_malformed", ask: "לא הצלחתי להבין, תוכלי להגיד שוב?" };

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { action: "clarify", reason: "no_api_key", ask: "לא הצלחתי להבין, תוכלי להגיד שוב?" };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error("[correctionSonnet] HTTP", res.status, await res.text());
      return { action: "clarify", reason: "http_error", ask: "לא הצלחתי להבין, תוכלי להגיד שוב?" };
    }
    const body = await res.json();
    const raw = body?.content?.[0]?.text?.trim() || "";
    // Strip optional fences.
    const jsonStr = raw.replace(/^\`\`\`json\s*|\s*\`\`\`$/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed.action === "update" || parsed.action === "remove" || parsed.action === "clarify") {
      return parsed as CorrectionSonnetResult;
    }
    return { action: "clarify", reason: "unknown_action", ask: "לא הצלחתי להבין, תוכלי להגיד שוב?" };
  } catch (err) {
    console.error("[correctionSonnet] Parse/fetch error:", err);
    return { action: "clarify", reason: "parse_error", ask: "לא הצלחתי להבין, תוכלי להגיד שוב?" };
  }
}
```

**Step 5: Parse check**

Run esbuild. If it fails with "Identifier cannot follow number" near the prompt, you've hit the nested-backtick trap (see CLAUDE.md). Escape the inner ``` fences with `\`\`\`` and retry.

**Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "feat: add buildCorrectionPrompt + callCorrectionSonnet

New Sonnet call for group-path corrections. Returns structured
update/remove/clarify JSON. CORRECTION_SONNET_MOCK env var for tests.
Wiring into handleCorrection in Task 3."
```

---

## Task 3: Rewrite `handleCorrection` as `handleCorrection_v2`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:11289-11444` — replace body of `handleCorrection`.

**Goal:** `correct_bot`-classified group messages now flow through gather-candidates → `buildCorrectionPrompt` → `callCorrectionSonnet` → dispatch via `executeCrudAction` (update/remove) or `sendAndLog` (clarify). The old delete+reinsert body is deleted.

**Step 1: Write failing tests (3 of the 8)**

Add tests 1, 3, 5 to `TestCorrectBotV2`:

```python
    def test_01_time_only_event_update_preserves_id(self):
        group_id = TEST_GROUP_2
        send_group_message(group_id, TEST_PHONE_1, "בדיקת שיניים ביום רביעי ב-14:00")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1
        original_id = events_before[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "תתקני ל-15:00")
        time.sleep(5)

        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 1, f"Expected no dup, got {len(events_after)}"
        assert events_after[0]["id"] == original_id, "id must be preserved"
        assert "15:00" in israel_time_hhmm(events_after[0]["scheduled_for"])

    def test_03_reminder_time_shift_preserves_id_and_sent_false(self):
        group_id = TEST_GROUP_3
        send_group_message(group_id, TEST_PHONE_1, "תזכירי לי מחר ב-8 לקחת ויטמין")
        time.sleep(4)
        reminders = fetch_reminders_for_group(group_id, since_minutes=2)
        assert len(reminders) == 1
        original_id = reminders[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "תעבירי ל-9")
        time.sleep(5)

        reminders_after = fetch_reminders_for_group(group_id, since_minutes=2)
        assert len(reminders_after) == 1
        assert reminders_after[0]["id"] == original_id
        assert reminders_after[0]["sent"] == False
        assert "09:00" in israel_time_hhmm(reminders_after[0]["send_at"])

    def test_05_ambiguous_multi_match_clarifies(self):
        group_id = TEST_GROUP_4
        send_group_message(group_id, TEST_PHONE_1, "בדיקת דירה ביום שישי ב-08:00")
        time.sleep(3)
        send_group_message(group_id, TEST_PHONE_1, "בדיקת דירה ביום שבת ב-10:00")
        time.sleep(3)

        send_group_message(group_id, TEST_PHONE_1, "תתקני את בדיקת הדירה ל-11:00")
        time.sleep(5)

        # No DB change.
        events = fetch_events_for_group(group_id, since_minutes=3)
        assert len(events) == 2
        # Clarification asked.
        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any("איזה" in r["message_text"] or "איזו" in r["message_text"] for r in replies)
```

(Mark `@pytest.mark.skip` until Task 7.)

**Step 2: Implement candidate gathering**

Above the rewritten `handleCorrection`, add a helper:

```typescript
async function gatherCorrectionCandidates(householdId: string): Promise<CandidateRow[]> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [evRes, remRes] = await Promise.all([
    supabase.from("events").select("id, title, scheduled_for")
      .eq("household_id", householdId).gte("created_at", dayAgo)
      .order("created_at", { ascending: false }).limit(5),
    supabase.from("reminder_queue").select("id, message_text, send_at")
      .eq("household_id", householdId).eq("sent", false).gte("created_at", dayAgo)
      .order("created_at", { ascending: false }).limit(5),
  ]);
  const events: CandidateRow[] = (evRes.data || []).map((e: any) => ({
    id: e.id, kind: "event", title: e.title, whenLocal: toIsraelTimeStr(e.scheduled_for),
  }));
  const reminders: CandidateRow[] = (remRes.data || []).map((r: any) => ({
    id: r.id, kind: "reminder", title: r.message_text, whenLocal: toIsraelTimeStr(r.send_at),
  }));
  return [...events, ...reminders].slice(0, 10);
}

async function gatherRecentGroupContext(groupId: string, minutes = 15): Promise<Array<{ sender: string; text: string; whenLocal: string }>> {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabase.from("whatsapp_messages")
    .select("sender_phone, message_text, created_at, sender_name")
    .eq("group_id", groupId.split("@")[0])
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(30);
  return (data || []).map((m: any) => ({
    sender: m.sender_name || m.sender_phone || "unknown",
    text: m.message_text || "",
    whenLocal: toIsraelTimeStr(m.created_at),
  }));
}

async function gatherRecentSheliActions(groupId: string, limit = 5): Promise<SheliActionSummary[]> {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await supabase.from("whatsapp_messages")
    .select("message_text, created_at")
    .eq("group_id", groupId.split("@")[0])
    .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse().map((m: any) => ({
    whenLocal: toIsraelTimeStr(m.created_at),
    text: (m.message_text || "").slice(0, 120),
  }));
}
```

**Step 3: Rewrite `handleCorrection`**

Replace the entire body of `handleCorrection` (L11289-L11384) with:

```typescript
async function handleCorrection(
  message: IncomingMessage,
  classification: ClassificationOutput,
  householdId: string,
  provider: WhatsAppProvider,
): Promise<void> {
  const logPrefix = `[handleCorrection:${householdId}]`;
  const groupId = message.groupId;
  if (!groupId) {
    console.warn(`${logPrefix} No groupId, skipping`);
    return;
  }

  // 1. Gather candidates + context.
  const [candidates, ctx, sheliActs] = await Promise.all([
    gatherCorrectionCandidates(householdId),
    gatherRecentGroupContext(groupId),
    gatherRecentSheliActions(groupId),
  ]);

  if (candidates.length === 0) {
    await sendAndLog(provider, { groupId, text: "סליחה, לא מצאתי שורה קרובה לתקן. תוכלי להגיד שוב?" }, {
      householdId, groupId, inReplyTo: message.messageId, replyType: "clarification",
    });
    await logMessage(message, "correction_error", householdId, classification);
    return;
  }

  // 2. Call Sonnet.
  const prompt = buildCorrectionPrompt(message.text || "", ctx, candidates, sheliActs);
  const result = await callCorrectionSonnet(prompt);

  // 3. Validate target_id is in candidate list (for update/remove).
  if (result.action === "update" || result.action === "remove") {
    const inList = candidates.some((c) => c.id === result.target_id);
    if (!inList) {
      console.warn(`${logPrefix} Sonnet emitted unknown target_id ${result.target_id}, falling back to clarify`);
      await sendAndLog(provider, { groupId, text: "לא הצלחתי לזהות בדיוק מה לעדכן. תוכלי להגיד שוב?" }, {
        householdId, groupId, inReplyTo: message.messageId, replyType: "clarification",
      });
      await logMessage(message, "correction_error", householdId, classification);
      return;
    }
  }

  // 4. Dispatch.
  if (result.action === "clarify") {
    await sendAndLog(provider, { groupId, text: result.ask }, {
      householdId, groupId, inReplyTo: message.messageId, replyType: "clarification",
    });
    await logMessage(message, "correction_clarify", householdId, classification);
    return;
  }

  const actionType = result.action === "update"
    ? (result.target_type === "reminder" ? "update_reminder" : "update_event")
    : (result.target_type === "reminder" ? "remove_reminder" : "remove_event");

  const crudAction: CrudAction = {
    type: actionType as CrudAction["type"],
    target_id: result.target_id,
    ...(result.action === "update" ? {
      new_scheduled_for: (result as any).new_scheduled_for,
      new_send_at: (result as any).new_send_at,
      new_title: (result as any).new_title,
      new_text: (result as any).new_text,
    } : {}),
  };

  const out = await executeCrudAction(householdId, crudAction, logPrefix);

  if (!out.ok) {
    const errMsg = out.error === "already_sent"
      ? "התזכורת כבר נשלחה, לא יכולה לשנות 🙈"
      : out.error === "not_found"
      ? "לא מצאתי את השורה הזאת, אולי כבר נמחקה?"
      : "משהו השתבש, תוכלי לנסות שוב?";
    await sendAndLog(provider, { groupId, text: errMsg }, {
      householdId, groupId, inReplyTo: message.messageId, replyType: "error_fallback",
    });
    await logMessage(message, "correction_error", householdId, classification);
    return;
  }

  const opener = "סליחה, תיקנתי! ";
  await sendAndLog(provider, { groupId, text: opener + out.summary + " ✨" }, {
    householdId, groupId, inReplyTo: message.messageId, replyType: "action_reply",
  });
  await logMessage(message, "correction_applied", householdId, classification);
}
```

**Step 4: Also add `already_sent` detection to `executeCrudAction`**

Go back to Task 1's `executeCrudAction`. Before the UPDATE branch for reminders, add:

```typescript
// For reminder updates, verify the row is still unsent (activeFilter already checks this,
// but an explicit second fetch catches the race where a reminder fired between gather + update).
if (cfg.table === "reminder_queue" && !isRemove) {
  const { data: freshRow } = await supabase.from(cfg.table).select("sent").eq("id", match.id).eq("household_id", householdId).single();
  if (freshRow?.sent === true) return { ok: false, summary: "", error: "already_sent" };
}
```

**Step 5: Parse check**

Run esbuild. Fix any errors.

**Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "feat: handleCorrection_v2 with structured Sonnet output

correct_bot in group mode now goes through buildCorrectionPrompt +
callCorrectionSonnet, dispatches update/remove via executeCrudAction or
sends clarify message. Old delete+reinsert body replaced. Logs
correction_applied / correction_clarify / correction_error for
observability."
```

---

## Task 4: Add remaining tests (2, 4, 6, 7)

**Files:**
- Modify: `tests/test_webhook.py` — add 4 more cases to `TestCorrectBotV2`.

**Step 1: Write the tests**

```python
    def test_02_date_only_update_preserves_id(self):
        group_id = TEST_GROUP_5
        send_group_message(group_id, TEST_PHONE_1, "ארוחה עם סבתא בחמישי ב-19:00")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        original_id = events_before[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "לא חמישי, שבת")
        time.sleep(5)
        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 1
        assert events_after[0]["id"] == original_id
        # scheduled_for day-of-week should now be Saturday.
        import datetime
        sf = datetime.datetime.fromisoformat(events_after[0]["scheduled_for"].replace("Z", "+00:00"))
        # Convert to Israel tz roughly via +3h (ignore DST for test tolerance).
        assert sf.weekday() in (5, 6), f"Expected Sat, got weekday {sf.weekday()}"

    def test_04_remove_event_hard_delete(self):
        group_id = TEST_GROUP_6
        send_group_message(group_id, TEST_PHONE_1, "ארוחת ערב ב-19:00 מחר")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1

        send_group_message(group_id, TEST_PHONE_1, "תבטלי את זה")
        time.sleep(5)
        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 0, f"Expected deletion, got {events_after}"

        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any("בוטלה" in r["message_text"] or "תיקנתי" in r["message_text"] for r in replies)

    def test_06_no_event_exists_debug_token_leak(self):
        group_id = TEST_GROUP_7
        send_group_message(group_id, TEST_PHONE_1, "תור לרופא מחר ב-10:00")
        time.sleep(4)
        send_group_message(group_id, TEST_PHONE_1, "תתקני ל-11:00")
        time.sleep(5)

        replies = fetch_bot_replies(group_id, since_seconds=10)
        for r in replies:
            assert "Event-exists:" not in r["message_text"], f"Debug token leaked: {r['message_text']}"
            assert "Reminder-exists:" not in r["message_text"]
            assert "old_title" not in r["message_text"]

    def test_07_fired_reminder_noop(self):
        """Reminder already fired cannot be updated."""
        # Seed reminder via direct DB insert with sent=true.
        group_id = TEST_GROUP_8
        hhid = fetch_household_for_group(group_id)
        reminder_id = insert_reminder_direct(hhid, group_id, text="לקחת תרופה",
                                              send_at_iso=minutes_ago_iso(5),
                                              sent=True, sent_at_iso=minutes_ago_iso(5))
        # Give Sonnet a reason to consider this row — seed a second unsent one too
        # so the candidate list isn't empty (fired row won't be in unsent list).
        # Actually: gatherCorrectionCandidates filters sent=false, so fired row is INVISIBLE.
        # Expect: Sonnet gets zero candidates → "לא מצאתי שורה קרובה" path.
        send_group_message(group_id, TEST_PHONE_1, "תעבירי את תזכורת התרופה ל-9")
        time.sleep(5)
        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any("לא מצאתי" in r["message_text"] or "כבר נשלחה" in r["message_text"] for r in replies)
        # Verify fired reminder untouched.
        fresh = fetch_reminder_by_id(reminder_id)
        assert fresh["sent"] == True
```

**Step 2: Run tests to confirm they fail (or skip if not deployed)**

```bash
python -m pytest tests/test_webhook.py::TestCorrectBotV2 -v
```

Expected: all skipped (marker) or all fail with connection/setup errors. Don't implement fixes yet — they'll run green in Task 7.

**Step 3: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test: add remaining TestCorrectBotV2 cases (2,4,6,7)

Covers date-only update, hard remove, debug-token regression, fired
reminder no-op. All marked skip until deploy in Task 7."
```

---

## Task 5: Add test fixtures + helpers

**Files:**
- Modify: `tests/test_webhook.py` — add missing helper functions used by TestCorrectBotV2.

**Goal:** The tests reference `send_group_message`, `fetch_events_for_group`, `fetch_reminders_for_group`, `fetch_bot_replies`, `israel_time_hhmm`, `insert_reminder_direct`, `fetch_reminder_by_id`, `fetch_household_for_group`, `minutes_ago_iso`, and `TEST_GROUP_1..8`. Some exist; some need to be added.

**Step 1: Audit existing helpers**

```bash
grep -n "def send_group_message\|def fetch_events\|def fetch_reminders\|def fetch_bot_replies\|TEST_GROUP" tests/test_webhook.py
```

Add whatever is missing. For `TEST_GROUP_1..8` — pick real groups from the existing beta households OR create dedicated test-only groups where only the bot + test phone are members. Document which groups are used.

**Step 2: Implement missing helpers**

Example stubs (adapt to existing patterns in the file):

```python
def fetch_events_for_group(group_id, since_minutes=5):
    hhid = fetch_household_for_group(group_id)
    since = (datetime.utcnow() - timedelta(minutes=since_minutes)).isoformat() + "Z"
    r = supabase.table("events").select("*").eq("household_id", hhid).gte("created_at", since).execute()
    return r.data or []

def fetch_bot_replies(group_id, since_seconds=10):
    since = (datetime.utcnow() - timedelta(seconds=since_seconds)).isoformat() + "Z"
    r = supabase.table("whatsapp_messages").select("*") \
        .eq("group_id", group_id.split("@")[0]) \
        .eq("sender_phone", BOT_PHONE) \
        .gte("created_at", since).execute()
    return r.data or []

def israel_time_hhmm(iso_str):
    d = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    # Rough IST/IDT handling — good enough for HH:MM assertions.
    il = d + timedelta(hours=3)
    return il.strftime("%H:%M")
```

**Step 3: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test: add TestCorrectBotV2 fixtures and helpers"
```

---

## Task 6: Pre-deploy parse check + paste-corruption dry-run

**Files:** none (validation only).

**Step 1: Final parse check**

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app/.claude/worktrees/ecstatic-goldstine-8b263d"
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

Expected: no ERROR lines.

**Step 2: Review diff against main**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Confirm only `index.inlined.ts` + `tests/test_webhook.py` + the two `docs/plans/` files are touched.

**Step 3: Hand-scan the deployed-file lines you rewrote**

Spot-check `handleCorrection` (~L11289), `executeCrudAction`, `buildCorrectionPrompt`. Look for any mixed Hebrew+ASCII tokens that could be paste-corruption vectors. Nothing to commit — just a visual review.

---

## Task 7: Deploy + smoke test

**Files:** none.

**Step 1: Paste-deploy**

Open `supabase/functions/whatsapp-webhook/index.inlined.ts` in Cursor/VS Code. `Ctrl+A`, `Ctrl+C`. Supabase Dashboard → Edge Functions → `whatsapp-webhook` → Code tab → select all → paste → Deploy. Ensure Settings → Verify JWT = OFF.

**Step 2: Paste-corruption scan**

```python
# Via mcp__f5337598__get_edge_function + regex from CLAUDE.md:
# re.compile(r"[A-Za-z]{2,}[\u0590-\u05FF]+[A-Za-z]{2,}")
# Hits in code = re-paste. Hits in comments = fine.
```

Pull deployed source via MCP tool `mcp__f5337598__get_edge_function`, run the regex, inspect hits. If any hit is inside an identifier (not a string/comment), re-paste.

**Step 3: Un-skip the tests and run smoke**

Remove `@pytest.mark.skip` from `TestCorrectBotV2` (all 8 tests). Run:

```bash
python -m pytest tests/test_webhook.py::TestCorrectBotV2 -v
```

Expected: all 8 pass. If test_08 fails due to env var, confirm `CORRECTION_SONNET_MOCK` is NOT set in Edge Function secrets (we want Sonnet to actually run for tests 1-7) — but temporarily set it for test_08 or use a stub group. Practical approach: run test_08 last, manually set+unset the env var around it.

**Step 4: Live smoke (one manual message per path)**

In a test group with just `972552482290`:
1. Send: "ארוחת צהריים מחר ב-13:00" → verify event created.
2. Send: "תתקני ל-14:00" → verify event's scheduled_for is 14:00, same id.
3. Send: "תבטלי את זה" → verify event deleted.

Check `whatsapp_messages` for `correction_applied` rows on both corrections.

**Step 5: Commit smoke results + un-skipped tests**

```bash
git add tests/test_webhook.py
git commit -m "test: un-skip TestCorrectBotV2 after deploy + smoke pass"
```

---

## Task 8: Observe + merge

**Files:** none (observation + PR).

**Step 1: Watch production for 1 hour**

Query:

```sql
SELECT classification, count(*)
FROM whatsapp_messages
WHERE created_at > now() - interval '1 hour'
  AND classification LIKE 'correction_%'
GROUP BY classification
ORDER BY 2 DESC;
```

Expected ratios (loose): `correction_applied` > `correction_clarify` > `correction_error`. If `correction_error` dominates, inspect the rows and fix.

**Step 2: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --title "feat: update_event + update_reminder in group path" \
  --base main --head "$(git branch --show-current)" \
  --body "$(cat <<'EOF'
Replaces handleCorrection's delete+reinsert with Sonnet-driven structured
output (update/remove/clarify). Closes the Roi-household double-insert
bug + the Event-exists: debug token leak.

- Option B chosen (Sonnet-ACTIONS gated on correct_bot).
- Extracted executeCrudAction shared helper from 1:1 path.
- buildCorrectionPrompt emits target candidates with ids, Sonnet picks by id.
- Three terminal states: correction_applied / correction_clarify / correction_error.
- 8 integration tests in TestCorrectBotV2 (all green post-deploy).

Design: docs/plans/2026-04-23-update-event-reminder-design.md
Plan: docs/plans/2026-04-23-update-event-reminder-plan.md
EOF
)"
```

**Step 3: If PR accepted → done. If any test flakes → debug, don't merge.**

---

## Rollback

If production goes sideways:
1. `git revert <merge commit>` on main.
2. Paste the reverted `index.inlined.ts` into Supabase Dashboard.
3. Old `handleCorrection` is in git history — restore via revert, no manual surgery.
