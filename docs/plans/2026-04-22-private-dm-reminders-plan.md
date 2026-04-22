# Private DM Reminders — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users ask in natural Hebrew for reminders delivered privately (DM), in addition to or instead of the group reminder, including rotation-aware fan-out, with a graceful fallback when a member has no known phone.

**Architecture:** Additive schema change (`recipient_phones TEXT[]` + `delivery_mode` on `reminder_queue`); Haiku classifier learns new `delivery_mode` entity + privacy phrase vocabulary; Sonnet prompt gets `PHONE MAPPINGS` / `ROTATIONS` context blocks and emits extended REMINDER / RECURRING_REMINDER / new MISSING_PHONES blocks; `rescueRemindersAndStrip` resolver turns blocks into rows (with Option D missing-phone fallback); `fire_due_reminders_inner` v4 fans out per-recipient with existing per-target window check.

**Tech Stack:** Supabase (Postgres + Edge Functions + pg_cron), Deno/TypeScript, Whapi.Cloud (via `net.http_post`), Anthropic Claude Haiku 4.5 + Sonnet 4, Python + requests for integration tests.

**Reference design:** `docs/plans/2026-04-22-private-dm-reminders-design.md`

**Deployed file:** `supabase/functions/whatsapp-webhook/index.inlined.ts` (~2,200 lines, all modules inlined — the `_shared/` copies are dev reference only; edits must land in the inlined file for the Dashboard paste).

---

## Pre-flight

- Confirm you're on a feature branch under `.claude/worktrees/objective-fermat-b20fd5/` (already true).
- Confirm `bot_settings.reminders_paused='true'` in prod — drain is paused during recovery, so any new code is inert until operator flips the flag. Do NOT flip it as part of this PR.
- Read these CLAUDE.md sections before starting: "reminder_queue schema reality", "group_id format mismatch across tables", "Deploying: Cursor paste to Dashboard", "Pre-deploy esbuild parse-check".

---

## Task 1: Schema migration — additive columns

**Files:**
- Create: `supabase/migrations/2026_04_22_reminder_fanout.sql`

**Step 1: Write the migration**

```sql
ALTER TABLE public.reminder_queue
  ADD COLUMN IF NOT EXISTS recipient_phones TEXT[],
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT
    CHECK (delivery_mode IN ('group','dm','both')) DEFAULT 'group';

COMMENT ON COLUMN public.reminder_queue.recipient_phones IS
  'Bare phone numbers (no @-suffix) for dm/both delivery. NULL or [] = group-only.';
COMMENT ON COLUMN public.reminder_queue.delivery_mode IS
  'group (default, backward compat) | dm (recipients only) | both (group + recipients).';
```

**Step 2: Apply via Supabase MCP `apply_migration`**

- name: `2026_04_22_reminder_fanout`
- query: the SQL above

Expected: no error; two columns added.

**Step 3: Verify schema**

Run via MCP `execute_sql`:

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='reminder_queue'
  AND column_name IN ('recipient_phones','delivery_mode');
```

Expected: 2 rows — `recipient_phones` ARRAY, `delivery_mode` text default `'group'::text`.

**Step 4: Commit**

```
git add supabase/migrations/2026_04_22_reminder_fanout.sql
git commit -m "feat(reminders): add recipient_phones + delivery_mode columns"
```

---

## Task 2: Parser unit tests (offline, TDD shape contract)

**Files:**
- Create: `tests/test_recipient_fanout.py`

**Step 1: Write the tests**

```python
"""Parser shape contract for private DM reminders (2026-04-22).
Run: python -m unittest tests.test_recipient_fanout -v
Pure offline. Pins the block shapes the TS extractors must match.
"""
import json
import re
import unittest

REMINDER_RE = re.compile(r"<!--\s*REMINDER\s*:\s*(\{[^}]*\})")
RECURRING_RE = re.compile(r"<!--\s*RECURRING_REMINDER\s*:\s*(\{[^}]*\})\s*-*>")
MISSING_RE = re.compile(r"<!--\s*MISSING_PHONES\s*:\s*(\{[\s\S]*?\})\s*-*>")


def parse_reminders(reply):
    out = []
    for m in REMINDER_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            if p.get("send_at"):
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


def parse_recurring(reply):
    out = []
    for m in RECURRING_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            days = p.get("days")
            t = p.get("time", "")
            if (isinstance(p.get("reminder_text"), str)
                and isinstance(days, list)
                and all(isinstance(d, int) and 0 <= d <= 6 for d in days)
                and re.match(r"^\d{1,2}:\d{2}$", t)):
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


def parse_missing(reply):
    out = []
    for m in MISSING_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            if "known" in p and "unknown" in p:
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


class TestReminderBlocks(unittest.TestCase):
    def test_legacy_block(self):
        r = '<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00"}-->'
        got = parse_reminders(r)
        self.assertEqual(len(got), 1)
        self.assertNotIn("delivery_mode", got[0])

    def test_dm_with_recipients(self):
        r = ('<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00",'
             '"delivery_mode":"dm","recipient_phones":["972501234567"]}-->')
        got = parse_reminders(r)
        self.assertEqual(got[0]["delivery_mode"], "dm")
        self.assertEqual(got[0]["recipient_phones"], ["972501234567"])

    def test_both_multi_recipient(self):
        r = ('<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00",'
             '"delivery_mode":"both","recipient_phones":["972501111111","972502222222"]}-->')
        got = parse_reminders(r)
        self.assertEqual(got[0]["delivery_mode"], "both")
        self.assertEqual(len(got[0]["recipient_phones"]), 2)

    def test_malformed_rejected(self):
        r = '<!--REMINDER:{"reminder_text":"x","send_at":MALFORMED}-->'
        self.assertEqual(parse_reminders(r), [])


class TestRecurringBlocks(unittest.TestCase):
    def test_dm_single_day(self):
        r = ('<!--RECURRING_REMINDER:{"reminder_text":"t","days":[3],"time":"07:00",'
             '"delivery_mode":"dm","recipient_phones":["972501111111"]}-->')
        got = parse_recurring(r)
        self.assertEqual(got[0]["days"], [3])
        self.assertEqual(got[0]["delivery_mode"], "dm")

    def test_invalid_day_rejected(self):
        r = '<!--RECURRING_REMINDER:{"reminder_text":"x","days":[7],"time":"07:00"}-->'
        self.assertEqual(parse_recurring(r), [])


class TestMissingPhonesBlock(unittest.TestCase):
    def test_mixed(self):
        r = ('<!--MISSING_PHONES:{"known":[{"name":"a","phone":"972501"}],'
             '"unknown":["b"],"reminder_text":"x","delivery_mode":"dm",'
             '"send_at_or_recurrence":{"days":[3,4,5],"time":"07:00"}}-->')
        got = parse_missing(r)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["unknown"], ["b"])


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run tests**

```
python -m unittest tests.test_recipient_fanout -v
```

Expected: all 7 tests PASS. These pin the shape contract; TS extractor changes in Task 3 must honor it.

**Step 3: Commit**

```
git add tests/test_recipient_fanout.py
git commit -m "test(reminders): parser shape tests for DM fan-out blocks"
```

---

## Task 3: Extend TS extractors

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Update `extractRemindersFromReply` (around line 1756)**

Change return type + body to accept optional `delivery_mode` / `recipient_phones`:

```typescript
function extractRemindersFromReply(reply: string): Array<{
  reminder_text: string;
  send_at: string;
  delivery_mode?: "group" | "dm" | "both";
  recipient_phones?: string[];
}> {
  const jsonRegex = /<!--\s*REMINDER\s*:\s*(\{[^}]*\})/g;
  const reminders: Array<{
    reminder_text: string;
    send_at: string;
    delivery_mode?: "group" | "dm" | "both";
    recipient_phones?: string[];
  }> = [];
  let match;
  while ((match = jsonRegex.exec(reply)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.send_at) {
        if (parsed.delivery_mode && !["group","dm","both"].includes(parsed.delivery_mode)) {
          console.warn("[Reminder] Invalid delivery_mode, defaulting to group:", parsed.delivery_mode);
          delete parsed.delivery_mode;
        }
        if (parsed.recipient_phones && !Array.isArray(parsed.recipient_phones)) {
          console.warn("[Reminder] recipient_phones not an array, dropping:", parsed.recipient_phones);
          delete parsed.recipient_phones;
        }
        reminders.push(parsed);
      }
    } catch {
      console.warn("[Reminder] Failed to parse REMINDER block:", match[1]);
    }
  }
  return reminders;
}
```

**Step 2: Update `extractRecurringRemindersFromReply` (around line 1781)**

Same shape — accept + validate the two new fields, pass them through.

**Step 3: Add `extractMissingPhonesFromReply` (new, after `extractEventsFromReply` around line 1823)**

```typescript
function extractMissingPhonesFromReply(reply: string): Array<{
  known: Array<{ name: string; phone: string }>;
  unknown: string[];
  reminder_text: string;
  delivery_mode: "dm" | "both";
  send_at_or_recurrence: { send_at?: string } | { days: number[]; time: string };
}> {
  const out: Array<{
    known: Array<{ name: string; phone: string }>;
    unknown: string[];
    reminder_text: string;
    delivery_mode: "dm" | "both";
    send_at_or_recurrence: { send_at?: string } | { days: number[]; time: string };
  }> = [];
  for (const m of reply.matchAll(/<!--\s*MISSING_PHONES\s*:\s*(\{[\s\S]*?\})\s*-*>/g)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed.known) && Array.isArray(parsed.unknown)
          && typeof parsed.reminder_text === "string"
          && ["dm","both"].includes(parsed.delivery_mode)
          && parsed.send_at_or_recurrence) {
        out.push(parsed);
      } else {
        console.warn("[MissingPhones] Invalid MISSING_PHONES block shape:", m[1]);
      }
    } catch {
      console.warn("[MissingPhones] Failed to parse MISSING_PHONES block:", m[1]);
    }
  }
  return out;
}
```

**Step 4: Update `cleanReminderFromReply` (around line 1825)**

Add one `.replace(...)` line to strip MISSING_PHONES blocks:

```typescript
.replace(/<!--\s*MISSING_PHONES\s*:?\s*\{[\s\S]*?\}\s*-*>/g, "")
```

Insert right after the RECURRING_REMINDER strip.

**Step 5: esbuild parse-check**

```
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

Expected: no errors.

**Step 6: Commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): extend extractors for delivery_mode + recipient_phones + MISSING_PHONES"
```

---

## Task 4: Recipient resolver helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — insert above `rescueRemindersAndStrip` (~line 1870)

**Step 1: Add `resolveRecipientNamesToPhones`**

```typescript
async function resolveRecipientNamesToPhones(
  names: string[],
  householdId: string,
): Promise<{
  resolved: Array<{ name: string; phone: string }>;
  missing: string[];
}> {
  const resolved: Array<{ name: string; phone: string }> = [];
  const missing: string[] = [];

  const SHORTCUTS = ["הילדים","המשפחה","כולם","כל המשפחה","כל הילדים"];
  const expanded: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (SHORTCUTS.some(s => trimmed.includes(s))) {
      const { data: members } = await supabase
        .from("household_members")
        .select("display_name")
        .eq("household_id", householdId);
      for (const m of (members || []) as Array<{ display_name: string }>) {
        if (m.display_name) expanded.push(m.display_name);
      }
    } else {
      expanded.push(trimmed);
    }
  }
  const uniqueNames = Array.from(new Set(expanded));

  for (const name of uniqueNames) {
    const lookupName = name.replace(/s$/i, "");
    const { data } = await supabase
      .from("whatsapp_member_mapping")
      .select("phone_number, member_name")
      .eq("household_id", householdId)
      .ilike("member_name", `%${lookupName}%`)
      .limit(1)
      .maybeSingle();
    if (data?.phone_number) resolved.push({ name, phone: data.phone_number });
    else missing.push(name);
  }
  return { resolved, missing };
}
```

**Step 2: esbuild parse-check + commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): add resolveRecipientNamesToPhones helper"
```

---

## Task 5: Populate new columns on insert (REMINDER + RECURRING_REMINDER)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — inside `rescueRemindersAndStrip` (lines ~1893-1910 and ~1960-1985)

**Step 1: Update REMINDER insert loop**

Replace the `.insert({...})` payload to include the two new fields + defensive guard:

```typescript
for (const reminderData of allReminders) {
  if (!reminderData.send_at) continue;

  const deliveryMode = reminderData.delivery_mode || "group";
  const recipientPhones: string[] | null = reminderData.recipient_phones || null;

  if ((deliveryMode === "dm" || deliveryMode === "both")
      && (!recipientPhones || recipientPhones.length === 0)) {
    console.warn(`[ReminderRescue] ${deliveryMode} mode but no recipient_phones — skipping: "${reminderData.reminder_text}"`);
    continue;
  }

  const { error } = await supabase.from("reminder_queue").insert({
    household_id: householdId,
    group_id: message.groupId,
    message_text: reminderData.reminder_text,
    send_at: reminderData.send_at,
    sent: false,
    reminder_type: "user",
    created_by_phone: message.senderPhone,
    created_by_name: message.senderName,
    delivery_mode: deliveryMode,
    recipient_phones: recipientPhones,
  });
  if (error) console.error("[ReminderRescue] Insert error:", error);
  else {
    console.log(`[ReminderRescue] Saved (${deliveryMode}): "${reminderData.reminder_text}" @ ${reminderData.send_at}`
      + (recipientPhones ? ` → ${recipientPhones.length} recipients` : ""));
    rescueSaveCount++;
  }
}
```

**Step 2: Update RECURRING_REMINDER insert loop (same pattern)**

Append `delivery_mode` + `recipient_phones` to the insert payload; add same guard against empty recipients for `dm`/`both`.

**Step 3: esbuild parse-check + commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): populate delivery_mode + recipient_phones on insert"
```

---

## Task 6: MISSING_PHONES handler (Option D fallback)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — new block inside `rescueRemindersAndStrip`, after RECURRING_REMINDER loop (~line 1985), before COMMITMENT-EMISSION guard (~line 1993)

**Step 1: Insert the handler**

```typescript
const missingBlocks = extractMissingPhonesFromReply(reply);
let missingPhoneFallbackReply: string | null = null;

for (const block of missingBlocks) {
  const { known, unknown, reminder_text, delivery_mode, send_at_or_recurrence } = block;

  // Case 1: single unknown, zero known → refuse
  if (unknown.length === 1 && known.length === 0) {
    missingPhoneFallbackReply = `לא מצאתי מספר של ${unknown[0]}. תבקשו ממנו/ה לשלוח לי הודעה פרטית פעם אחת ואז תוכלו לבקש שוב 🙏`;
    rescueSaveCount++;
    continue;
  }

  // Case 3: all missing, multi-person → refuse listing all
  if (known.length === 0 && unknown.length > 1) {
    missingPhoneFallbackReply = `אין לי מספרים של ${unknown.join(", ")}. תבקשו מהם לשלוח לי הודעה פרטית פעם אחת, ואז נסו שוב 🙏`;
    rescueSaveCount++;
    continue;
  }

  // Case 2: mixed — insert known as dm, unknown as group-fallback
  const isRecurring = "days" in send_at_or_recurrence && "time" in send_at_or_recurrence;

  for (const m of known) {
    const baseRow: Record<string, unknown> = {
      household_id: householdId,
      group_id: message.groupId,
      message_text: reminder_text,
      sent: isRecurring,
      reminder_type: "user",
      created_by_phone: message.senderPhone,
      created_by_name: message.senderName,
      delivery_mode: delivery_mode,
      recipient_phones: [m.phone],
      metadata: { source: "missing_phones_handler", for_member: m.name },
    };
    if (isRecurring) {
      baseRow.send_at = new Date().toISOString();
      baseRow.sent_at = new Date().toISOString();
      const rec = send_at_or_recurrence as { days: number[]; time: string };
      baseRow.recurrence = { days: rec.days, time: rec.time };
      (baseRow.metadata as Record<string, unknown>).recurring_parent = true;
    } else {
      baseRow.send_at = (send_at_or_recurrence as { send_at: string }).send_at;
    }
    const { error } = await supabase.from("reminder_queue").insert(baseRow);
    if (error) console.error(`[MissingPhonesHandler] dm insert error for ${m.name}:`, error);
    else rescueSaveCount++;
  }

  for (const u of unknown) {
    const baseRow: Record<string, unknown> = {
      household_id: householdId,
      group_id: message.groupId,
      message_text: `${u} — ${reminder_text}`,
      sent: isRecurring,
      reminder_type: "user",
      created_by_phone: message.senderPhone,
      created_by_name: message.senderName,
      delivery_mode: "group",
      recipient_phones: null,
      metadata: { source: "missing_phones_handler", missing_phone_for: u },
    };
    if (isRecurring) {
      baseRow.send_at = new Date().toISOString();
      baseRow.sent_at = new Date().toISOString();
      const rec = send_at_or_recurrence as { days: number[]; time: string };
      baseRow.recurrence = { days: rec.days, time: rec.time };
      (baseRow.metadata as Record<string, unknown>).recurring_parent = true;
    } else {
      baseRow.send_at = (send_at_or_recurrence as { send_at: string }).send_at;
    }
    const { error } = await supabase.from("reminder_queue").insert(baseRow);
    if (error) console.error(`[MissingPhonesHandler] group-fallback insert error for ${u}:`, error);
    else rescueSaveCount++;
  }

  if (isRecurring) {
    await supabase.rpc("materialize_recurring_reminders");
  }

  const knownNames = known.map(k => k.name).join(", ");
  const unknownNames = unknown.join(", ");
  missingPhoneFallbackReply = `רשמתי ל${knownNames} בפרטי. ל${unknownNames} אין לי מספר — אזכיר בקבוצה בימים שלו/ה. אם תשלח/י לי פעם אחת הודעה פרטית, אעביר גם אותו/ה לתזכורות פרטיות ✓`;
}

if (missingPhoneFallbackReply) {
  return missingPhoneFallbackReply;
}
```

**Step 2: esbuild parse-check + commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): MISSING_PHONES handler with Option D fallback"
```

---

## Task 7: Haiku classifier — entity fields + detection rules + examples

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts` + inlined classifier copy in `index.inlined.ts`

**Step 1: Extend `entities` type**

Add optional fields:

```typescript
delivery_mode?: "group" | "dm" | "both";
recipient_names?: string[];
```

**Step 2: Add detection rules to the `add_reminder` bullet of the classifier prompt** (near line 689 for inlined, mirror in `_shared/`)

Append:

```
- PRIVACY MODIFIER: Detect and set entities.delivery_mode:
    "בפרטי" / "תזכירי לי בפרטי" / "תזכירי לו בפרטי" / "privately" → delivery_mode="dm"
    "גם בפרטי" / "also privately" / "also in DM" → delivery_mode="both"
    "בפרטי בלבד" / "רק בפרטי" / "privately only" → delivery_mode="dm"
    "בקבוצה" / "בקבוצתי" / "במשפחתי" / "בווטסאפ המשותף" / "in the group" → delivery_mode="group"
    (no privacy phrase) → omit delivery_mode (Sonnet defaults to group)
- ROTATION SHORTCUT (set needs_conversation_review=true): "לפי התור" / "בתורות" / "בתורנות" / "תורנות" / "תורנים" / "מתחלפים" / "כל יום ילד אחר" / "כל יום מישהו אחר" / "לפי התורנות" / "מי שהתור שלו" — Sonnet expands to per-member recurring blocks.
- RECIPIENT NAMES: Extract named people into entities.recipient_names (array).
```

**Step 3: Add 4 new examples near the existing add_reminder examples (around line 900-905)**

```
[ניב]: "תזכירי לי בפרטי לשלם חשבון חשמל בחמישי" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לשלם חשבון חשמל","time_raw":"חמישי","delivery_mode":"dm","recipient_names":["ניב"],"raw_text":"תזכירי לי בפרטי לשלם חשבון חשמל בחמישי"}}
[ניב]: "תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7 בבוקר" → {"intent":"add_reminder","confidence":0.92,"entities":{"reminder_text":"יונתן — לשטוף כלים","time_raw":"רביעי 7:00","delivery_mode":"both","recipient_names":["יונתן"],"raw_text":"תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7 בבוקר"}}
[ניב]: "תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7" → {"intent":"add_reminder","confidence":0.85,"needs_conversation_review":true,"entities":{"reminder_text":"לשטוף כלים","time_raw":"כל יום 7:00","delivery_mode":"dm","recipient_names":["הילדים"],"raw_text":"תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7"}}
[ניב]: "תזכירי ביום חמישי במשפחתי להביא שמיכות" → {"intent":"add_reminder","confidence":0.88,"entities":{"reminder_text":"להביא שמיכות","time_raw":"חמישי","delivery_mode":"group","raw_text":"תזכירי ביום חמישי במשפחתי להביא שמיכות"}}
```

**Step 4: esbuild parse-check**

Watch for the CLAUDE.md gotcha: no backticks inside template literals.

**Step 5: Commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts supabase/functions/_shared/haiku-classifier.ts
git commit -m "feat(reminders): Haiku classifier learns delivery_mode + recipient_names + rotation shortcuts"
```

---

## Task 8: Inject PHONE MAPPINGS into Sonnet context

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `buildGroupContext` (or wherever `rotationsStr` is assembled, around line 655-660)

**Step 1: Fetch mappings, add to `ctx`**

```typescript
const { data: mappings } = await supabase
  .from("whatsapp_member_mapping")
  .select("member_name, phone_number")
  .eq("household_id", householdId);
const phoneMappingsStr = (mappings || [])
  .map((m: { member_name: string; phone_number: string }) => `${m.member_name} → ${m.phone_number}`)
  .join("\n") || "(no mappings)";
ctx.phoneMappings = phoneMappingsStr;
```

**Step 2: Inject into `buildReplyPrompt` template (near where ACTIVE ROTATIONS is rendered)**

```
PHONE MAPPINGS (use to fill recipient_phones in private reminders):
${ctx.phoneMappings}
```

**Step 3: Same injection into `ONBOARDING_1ON1_PROMPT` for symmetry**

**Step 4: esbuild parse-check + commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): inject PHONE MAPPINGS context into Sonnet prompts"
```

---

## Task 9: Extend Sonnet REMINDERS rules

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — REMINDERS section (~line 1617) and RECURRING REMINDERS section (~line 1642)

**Step 1: Append to REMINDERS section**

```
PRIVATE DELIVERY (2026-04-22):
If the classifier sets entities.delivery_mode, honor it. Otherwise infer from message:
  "גם בפרטי" / "also privately" → delivery_mode="both"
  bare "בפרטי" / "בפרטי בלבד" / "רק בפרטי" → delivery_mode="dm"
  "בקבוצה" / "במשפחתי" / "בווטסאפ המשותף" → delivery_mode="group"

Phone resolution:
- Use PHONE MAPPINGS block above. Look up each named recipient.
- If ALL named recipients resolve, emit extended REMINDER:
    <!--REMINDER:{"reminder_text":"...","send_at":"...","delivery_mode":"dm|both","recipient_phones":["972...","972..."]}-->
- If one or more recipients are NOT in PHONE MAPPINGS, emit MISSING_PHONES instead:
    <!--MISSING_PHONES:{"known":[{"name":"יונתן","phone":"972..."}],"unknown":["נגה"],"reminder_text":"...","delivery_mode":"dm","send_at_or_recurrence":{"send_at":"2026-04-22T07:00:00+03:00"}}-->
  The handler decides the fallback (refuse vs partial + group).

Examples:
  "תזכירי לי בפרטי לשלם חשמל חמישי ב-10" (sender=972500000000) → reply "אזכיר חמישי ב-10:00 בפרטי ✓" + REMINDER block with delivery_mode=dm, recipient_phones=[972500000000].
  "תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7" (yonatan in mappings) → reply "אזכיר ליונתן רביעי 7:00 גם בפרטי ✓" + REMINDER block with delivery_mode=both, recipient_phones=[jonatan_phone].
  "תזכירי לנגה בפרטי מחר ב-9" (נגה NOT mapped) → reply nothing visible + MISSING_PHONES block. Handler writes the refuse reply.
```

**Step 2: Append to RECURRING REMINDERS section**

```
PRIVATE DELIVERY + ROTATION SHORTCUT (2026-04-22):
- Honor delivery_mode like one-shot reminders.
- ROTATION SHORTCUT — When message has "לפי התור" / "בתורות" / "בתורנות" / "מתחלפים" / "כל יום ילד אחר" AND ACTIVE ROTATIONS matches, emit ONE RECURRING_REMINDER PER member. Each block:
    days = just that member's days
    recipient_phones = [their phone from PHONE MAPPINGS]
    delivery_mode = from message (typically "dm")
- If any rotation member's phone is missing, emit a single MISSING_PHONES block (NOT multiple RECURRING_REMINDER blocks). Set send_at_or_recurrence to the FULL rotation days/time; handler slices per member.

Example — rotation kids Wed=יונתן, Thu=איתן, Fri=נגה, all mapped:
  "תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7"
  reply "אזכיר לכל ילד ב-7:00 בתורו בפרטי ✓"
  3 RECURRING_REMINDER blocks, one per child with their single day.

Same rotation with נגה missing phone:
  reply (empty — handler writes fallback)
  MISSING_PHONES block with known=[יונתן,איתן], unknown=[נגה], days=[3,4,5], time=07:00.
```

**Step 3: esbuild parse-check** — no backticks inside literals. Verify.

**Step 4: Commit**

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): Sonnet prompt for private delivery + rotation shortcut + MISSING_PHONES"
```

---

## Task 10: SQL drain v4 — fan-out migration

**Files:**
- Create: `supabase/migrations/2026_04_22_reminder_drain_v4.sql`

**Step 1: Write the migration**

```sql
-- fire_due_reminders_inner v4 (2026-04-22) — private DM reminder fan-out.
-- Extends v3 with per-recipient fan-out. No quiet-hours early return.
-- Per-target il_window_open_for_chat gate. Partial HTTP error keeps row
-- sent=false (retries ≤3).

CREATE OR REPLACE FUNCTION public.fire_due_reminders_inner()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  r                RECORD;
  v_count          INT := 0;
  v_request_id     BIGINT;
  v_msg_body       TEXT;
  v_target         TEXT;
  v_targets        TEXT[];
  v_sent_to        TEXT[];
  v_skipped        TEXT[];
  v_whapi_token    CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
  v_had_http_error BOOLEAN;
BEGIN
  FOR r IN
    SELECT id, group_id, message_text, send_at, attempts,
           delivery_mode, recipient_phones
    FROM public.reminder_queue
    WHERE sent = false
      AND send_at <= NOW()
      AND send_at >  NOW() - INTERVAL '24 hours'
      AND COALESCE(attempts, 0) < 3
    ORDER BY send_at ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  LOOP
    v_targets := ARRAY[]::TEXT[];
    IF COALESCE(r.delivery_mode, 'group') = 'group' THEN
      v_targets := ARRAY[r.group_id];
    ELSIF r.delivery_mode = 'dm' THEN
      IF r.recipient_phones IS NULL OR array_length(r.recipient_phones, 1) IS NULL THEN
        UPDATE public.reminder_queue
           SET sent = true, sent_at = NOW(),
               attempts = COALESCE(attempts, 0) + 1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'note', 'no_recipients', 'skipped_at', NOW())
         WHERE id = r.id;
        CONTINUE;
      END IF;
      SELECT array_agg(p || '@s.whatsapp.net') INTO v_targets
        FROM unnest(r.recipient_phones) AS p;
    ELSIF r.delivery_mode = 'both' THEN
      v_targets := ARRAY[r.group_id];
      IF r.recipient_phones IS NOT NULL AND array_length(r.recipient_phones, 1) IS NOT NULL THEN
        v_targets := v_targets || (
          SELECT array_agg(p || '@s.whatsapp.net') FROM unnest(r.recipient_phones) AS p
        );
      END IF;
    END IF;

    v_msg_body := '⏰ תזכורת ' || r.message_text;
    v_sent_to := ARRAY[]::TEXT[];
    v_skipped := ARRAY[]::TEXT[];
    v_had_http_error := false;

    FOREACH v_target IN ARRAY v_targets LOOP
      IF NOT public.il_window_open_for_chat(v_target) THEN
        v_skipped := v_skipped || v_target;
        CONTINUE;
      END IF;
      BEGIN
        SELECT net.http_post(
          url     := 'https://gate.whapi.cloud/messages/text',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || v_whapi_token,
            'Content-Type',  'application/json'
          ),
          body    := jsonb_build_object('to', v_target, 'body', v_msg_body)
        ) INTO v_request_id;
        v_sent_to := v_sent_to || v_target;
      EXCEPTION WHEN OTHERS THEN
        v_had_http_error := true;
        UPDATE public.reminder_queue
           SET attempts = COALESCE(attempts, 0) + 1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'last_error',        SQLERRM,
                 'last_error_at',     NOW(),
                 'last_error_target', v_target)
         WHERE id = r.id;
        EXIT;
      END;
    END LOOP;

    IF v_had_http_error THEN
      CONTINUE;
    END IF;

    UPDATE public.reminder_queue
       SET sent = true, sent_at = NOW(),
           attempts = COALESCE(attempts, 0) + 1,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'fanout', jsonb_build_object(
               'sent_to', to_jsonb(v_sent_to),
               'skipped', to_jsonb(v_skipped),
               'mode',    COALESCE(r.delivery_mode, 'group')
             )
           )
     WHERE id = r.id;

    IF array_length(v_sent_to, 1) IS NOT NULL THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.fire_due_reminders_inner() IS
  'v4 (2026-04-22): per-recipient fan-out. delivery_mode=group|dm|both with recipient_phones array. Per-target il_window_open_for_chat gate. No quiet-hours early return.';

-- Update materializer to copy new fields from parent to child
CREATE OR REPLACE FUNCTION public.materialize_recurring_reminders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inserted INT := 0;
  v_parent RECORD;
  v_day_offset INT;
  v_target_date DATE;
  v_target_dow INT;
  v_time TEXT;
  v_hour INT;
  v_minute INT;
  v_send_at_il TIMESTAMP;
  v_send_at_utc TIMESTAMPTZ;
  v_days JSONB;
  v_today_il DATE;
BEGIN
  v_today_il := (NOW() AT TIME ZONE 'Asia/Jerusalem')::date;
  FOR v_parent IN
    SELECT id, message_text, group_id, reminder_type, recurrence, household_id,
           delivery_mode, recipient_phones
    FROM public.reminder_queue
    WHERE recurrence IS NOT NULL AND recurrence_parent_id IS NULL AND sent = true
  LOOP
    v_days := v_parent.recurrence->'days';
    v_time := COALESCE(v_parent.recurrence->>'time', '09:00');
    v_hour := split_part(v_time, ':', 1)::int;
    v_minute := split_part(v_time, ':', 2)::int;
    FOR v_day_offset IN 0..6 LOOP
      v_target_date := v_today_il + v_day_offset;
      v_target_dow := EXTRACT(DOW FROM v_target_date)::int;
      IF v_days @> to_jsonb(v_target_dow) THEN
        v_send_at_il := v_target_date + make_time(v_hour, v_minute, 0);
        v_send_at_utc := v_send_at_il AT TIME ZONE 'Asia/Jerusalem';
        IF v_send_at_utc < NOW() THEN CONTINUE; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.reminder_queue
          WHERE recurrence_parent_id = v_parent.id
            AND (send_at AT TIME ZONE 'Asia/Jerusalem')::date = v_target_date
        ) THEN
          INSERT INTO public.reminder_queue (
            household_id, message_text, send_at, sent, group_id, reminder_type,
            recurrence_parent_id, delivery_mode, recipient_phones, metadata
          ) VALUES (
            v_parent.household_id, v_parent.message_text, v_send_at_utc,
            false, v_parent.group_id, v_parent.reminder_type, v_parent.id,
            COALESCE(v_parent.delivery_mode, 'group'), v_parent.recipient_phones,
            jsonb_build_object('materialized_from_recurring', true,
                               'parent_id', v_parent.id,
                               'materialized_at', NOW())
          );
          v_inserted := v_inserted + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_inserted;
END;
$$;
```

**Step 2: Apply via Supabase MCP `apply_migration`**

- name: `2026_04_22_reminder_drain_v4`
- query: file contents

Expected: no errors.

**Step 3: Verify**

```sql
SELECT obj_description('public.fire_due_reminders_inner'::regprocedure, 'pg_proc');
```

Expected: contains `'v4 (2026-04-22)'`.

**Step 4: Commit**

```
git add supabase/migrations/2026_04_22_reminder_drain_v4.sql
git commit -m "feat(reminders): drain v4 — per-recipient fan-out with window check"
```

---

## Task 11: SQL smoke test (sandbox household)

**Step 1: Insert a throwaway test row against a sandbox household**

SAFETY: use fake phone + fake group_id. Do NOT touch production households.

```sql
INSERT INTO reminder_queue (
  household_id, group_id, message_text, send_at, sent,
  reminder_type, delivery_mode, recipient_phones
) VALUES (
  'hh_sandbox_test',
  '972000000000@s.whatsapp.net',
  'TEST — fan-out smoke test',
  NOW() - INTERVAL '1 second',
  false,
  'user',
  'dm',
  ARRAY['972000000000']
);

SELECT public.fire_due_reminders_inner();

SELECT id, sent, attempts, metadata->'fanout' AS fanout
FROM reminder_queue
WHERE household_id = 'hh_sandbox_test'
ORDER BY send_at DESC LIMIT 1;
```

Expected: row has `metadata.fanout` populated (either `sent_to` or `skipped`). Proves fan-out executed.

**Step 2: Clean up**

```sql
DELETE FROM reminder_queue WHERE household_id = 'hh_sandbox_test';
```

**Step 3: No commit** — verification only.

---

## Task 12: Integration tests — 8 end-to-end cases

**Files:**
- Modify: `tests/test_webhook.py` — new `TestPrivateDmReminders` class at end

**Step 1: Add test class and helpers**

Before writing new helpers, grep existing `test_webhook.py` for `def _` helpers — reuse anything that matches. Most likely already present: `_send_webhook`, `_fetch_reminders`, `_reset_household`.

```python
class TestPrivateDmReminders(unittest.TestCase):
    """Integration tests — private DM reminders (2026-04-22).
    Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, deployed Edge Function.
    """
    TEST_HOUSEHOLD_ID = "hh_dm_reminders_test"
    TEST_GROUP_ID = "972000000100@g.us"
    TEST_SENDER_PHONE = "972500000100"

    @classmethod
    def setUpClass(cls):
        _reset_household(cls.TEST_HOUSEHOLD_ID)
        _create_household(cls.TEST_HOUSEHOLD_ID, "Test DM Household")
        _create_member(cls.TEST_HOUSEHOLD_ID, "ניב", cls.TEST_SENDER_PHONE)
        _create_member(cls.TEST_HOUSEHOLD_ID, "יונתן", "972500000111")
        _create_member(cls.TEST_HOUSEHOLD_ID, "איתן", "972500000112")
        # נגה intentionally without phone
        _create_member(cls.TEST_HOUSEHOLD_ID, "נגה", None)

    @classmethod
    def tearDownClass(cls):
        _reset_household(cls.TEST_HOUSEHOLD_ID)

    def test_01_self_dm_reminder(self):
        _send_webhook(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                      "תזכירי לי בפרטי לשלם חשבון חמישי ב-10")
        rows = _fetch_reminders(self.TEST_HOUSEHOLD_ID)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["delivery_mode"], "dm")
        self.assertEqual(rows[0]["recipient_phones"], [self.TEST_SENDER_PHONE])

    def test_02_third_person_both(self):
        _send_webhook(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                      "תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7 בבוקר")
        rows = _fetch_reminders(self.TEST_HOUSEHOLD_ID)
        row = next(r for r in rows if "יונתן" in r["message_text"])
        self.assertEqual(row["delivery_mode"], "both")
        self.assertEqual(row["recipient_phones"], ["972500000111"])

    def test_03_rotation_all_mapped(self):
        _create_rotation(self.TEST_HOUSEHOLD_ID, "שטיפת כלים",
                         [{"name":"יונתן","day":3},{"name":"איתן","day":4}])
        _send_webhook(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                      "תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7")
        parents = _fetch_reminders(self.TEST_HOUSEHOLD_ID, recurring_only=True)
        self.assertGreaterEqual(len(parents), 2)
        for p in parents:
            self.assertEqual(p["delivery_mode"], "dm")
            self.assertIsNotNone(p["recipient_phones"])
            self.assertEqual(len(p["recipient_phones"]), 1)

    def test_04_rotation_missing_phone(self):
        _create_rotation(self.TEST_HOUSEHOLD_ID, "שטיפת כלים",
                         [{"name":"יונתן","day":3},{"name":"איתן","day":4},
                          {"name":"נגה","day":5}])
        reply = _send_webhook_return_reply(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                                           "תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7")
        self.assertIn("נגה", reply)
        self.assertIn("בקבוצה", reply)
        parents = _fetch_reminders(self.TEST_HOUSEHOLD_ID, recurring_only=True)
        dm_rows = [p for p in parents if p["delivery_mode"] == "dm"]
        group_rows = [p for p in parents
                      if p["delivery_mode"] == "group"
                      and (p.get("metadata") or {}).get("missing_phone_for") == "נגה"]
        self.assertGreaterEqual(len(dm_rows), 2)
        self.assertGreaterEqual(len(group_rows), 1)

    def test_05_single_unknown_refuses(self):
        reply = _send_webhook_return_reply(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                                           "תזכירי לנגה בפרטי מחר ב-9")
        self.assertIn("לא מצאתי מספר של נגה", reply)
        rows = _fetch_reminders(self.TEST_HOUSEHOLD_ID,
                                since=datetime.utcnow() - timedelta(seconds=10))
        for r in rows:
            self.assertNotIn("972500000113", str(r.get("recipient_phones") or []))

    def test_06_explicit_group_override(self):
        _send_webhook(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                      "תזכירי ביום חמישי במשפחתי להביא שמיכות")
        rows = _fetch_reminders(self.TEST_HOUSEHOLD_ID)
        row = next(r for r in rows if "שמיכות" in r["message_text"])
        self.assertEqual(row["delivery_mode"], "group")
        self.assertIsNone(row["recipient_phones"])

    def test_07_legacy_no_privacy_word(self):
        _send_webhook(self.TEST_GROUP_ID, self.TEST_SENDER_PHONE,
                      "תזכירי לי מחר ב-10 להתקשר לסבתא")
        rows = _fetch_reminders(self.TEST_HOUSEHOLD_ID)
        row = next(r for r in rows if "סבתא" in r["message_text"])
        self.assertEqual(row["delivery_mode"], "group")

    def test_08_reconciliation_on_mapping_add(self):
        # Seed a group-fallback row for נגה
        _insert_group_fallback_reminder(self.TEST_HOUSEHOLD_ID, "נגה",
                                        "לשטוף כלים", days=[5], time="07:00")
        _create_member(self.TEST_HOUSEHOLD_ID, "נגה", "972500000113", upsert=True)
        _run_reconciliation(self.TEST_HOUSEHOLD_ID, "נגה", "972500000113")
        parents = _fetch_reminders(self.TEST_HOUSEHOLD_ID, recurring_only=True,
                                   since=datetime.utcnow() - timedelta(minutes=1))
        upgraded = [p for p in parents
                    if p["delivery_mode"] == "dm"
                    and p.get("recipient_phones") == ["972500000113"]]
        self.assertGreaterEqual(len(upgraded), 1)
```

**Step 2: Run tests**

```
python tests/test_webhook.py -v TestPrivateDmReminders
```

Expected: all 8 pass. Allow ONE retry for LLM non-determinism (per CLAUDE.md, ~6% flake rate is known).

**Step 3: Commit**

```
git add tests/test_webhook.py
git commit -m "test(reminders): 8 integration tests for private DM fan-out"
```

---

## Task 13 (OPTIONAL, nice-to-have): Reconciliation on mapping insert

If skipping in v1: mark Task 12 `test_08` with `@unittest.skip("reconciliation not yet shipped")` and come back later.

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — after successful `whatsapp_member_mapping` inserts
- Create: `supabase/migrations/2026_04_22_reminder_reconciliation.sql`

**Step 1: Migration**

```sql
CREATE OR REPLACE FUNCTION public.upgrade_group_fallback_reminders(
  p_household_id TEXT, p_member_name TEXT, p_phone TEXT
)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_upgraded INT := 0;
BEGIN
  WITH upgraded AS (
    UPDATE public.reminder_queue
       SET delivery_mode    = 'dm',
           recipient_phones = ARRAY[p_phone],
           metadata = metadata || jsonb_build_object(
             'auto_upgraded_from_group_fallback', true,
             'upgraded_at', NOW())
     WHERE household_id = p_household_id
       AND sent = false
       AND delivery_mode = 'group'
       AND metadata->>'missing_phone_for' ILIKE '%' || p_member_name || '%'
     RETURNING 1
  )
  SELECT count(*) INTO v_upgraded FROM upgraded;
  RETURN v_upgraded;
END;
$$;
```

**Step 2: Invoke RPC after mapping insert**

```typescript
await supabase.rpc("upgrade_group_fallback_reminders", {
  p_household_id: householdId,
  p_member_name: displayName,
  p_phone: senderPhone,
});
```

**Step 3: Commit**

```
git add supabase/migrations/2026_04_22_reminder_reconciliation.sql supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(reminders): auto-upgrade group-fallback reminders on new phone mapping"
```

---

## Task 14: Deploy Edge Function

**Step 1: Final esbuild parse-check**

```
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

**Step 2: Deploy via Dashboard paste**

Per CLAUDE.md: open `index.inlined.ts` in Cursor → Ctrl+A, Ctrl+C → Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab → paste → Deploy. Confirm JWT = OFF.

**Step 3: Commit deployed state to branch IMMEDIATELY after Dashboard paste**

(Per CLAUDE.md "Edge Function hot-fix" rule.)

```
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "chore(reminders): deploy private DM fan-out to Edge Function"
```

---

## Task 15: Staging smoke test

**Step 1: Flip `reminders_paused` only on a dev branch DB or run inner function directly**

```sql
-- On dev branch only:
UPDATE bot_settings SET value='false' WHERE key='reminders_paused';
```

**Step 2: Send live test message from a mapped test number**

`תזכירי לי בפרטי בעוד 2 דקות להריץ טסט`

**Step 3: Wait 2 minutes. Verify:**

- Edge Function logs: `[ReminderRescue] Saved (dm): "להריץ טסט" ... → 1 recipients`.
- DB row: `sent=true`, `metadata.fanout.mode='dm'`, `sent_to=['<phone>@s.whatsapp.net']`, `skipped=[]`.
- DM arrives on the sender's personal WhatsApp.

**Step 4: Revert pause flag**

```sql
UPDATE bot_settings SET value='true' WHERE key='reminders_paused';
```

**Step 5: No commit**.

---

## Task 16: Retire Kaye family manual row

**Step 1: Verify row still pending**

```sql
SELECT id, household_id, send_at, sent, delivery_mode
FROM reminder_queue WHERE id = '62e8bb19'::uuid;
```

**Step 2: Retire + replace with proper recurring parent**

```sql
-- Mark the ad-hoc row retired
UPDATE reminder_queue
   SET sent = true, sent_at = NOW(),
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'retired', true,
         'retired_reason', 'replaced_by_recurring_parent_2026_04_22')
 WHERE id = '62e8bb19'::uuid;

-- Create recurring parent for Jonathan
INSERT INTO reminder_queue (
  household_id, group_id, message_text, send_at, sent, sent_at,
  reminder_type, delivery_mode, recipient_phones, recurrence, metadata
) VALUES (
  '<kaye_household_id>',
  '<kaye_group_jid>',
  'יונתן — לשטוף כלים',
  NOW(), true, NOW(),
  'user', 'dm',
  ARRAY['<jonathan_phone>'],
  '{"days":[3],"time":"07:00"}'::jsonb,
  jsonb_build_object('recurring_parent', true,
                     'source', 'manual_kaye_2026_04_22',
                     'replaces_row_id', '62e8bb19')
);

-- Materialize next 7 days
SELECT public.materialize_recurring_reminders();
```

**Step 3: Verify child created**

```sql
SELECT id, send_at, delivery_mode, recipient_phones
FROM reminder_queue
WHERE recurrence_parent_id = (
  SELECT id FROM reminder_queue
  WHERE metadata->>'replaces_row_id' = '62e8bb19' LIMIT 1
)
ORDER BY send_at;
```

Expected: one row for next Wednesday 07:00 IST, `delivery_mode='dm'`.

**Step 4: No commit** — DB-only.

---

## Task 17: Update CLAUDE.md + memory

**Files:**
- Modify: `CLAUDE.md` — mark TODO done
- Optional: add `memory/project_private_dm_reminders.md` index entry

**Step 1: Edit CLAUDE.md TODO entry**

Replace the existing "Private DM reminders for rotations/assigned tasks — NOT IMPLEMENTED" bullet with:

```
- **Private DM reminders for rotations — DONE 2026-04-22.**
  Design: `docs/plans/2026-04-22-private-dm-reminders-design.md`. Plan:
  `docs/plans/2026-04-22-private-dm-reminders-plan.md`.
  Schema: `recipient_phones TEXT[]` + `delivery_mode` on `reminder_queue`.
  Drain v4 fans out per-recipient with per-target `il_window_open_for_chat`
  gate. Rotation shortcut compiles to N recurring parents. Missing-phone
  fallback (Option D): single-unknown refuses; rotation-with-missing
  degrades to group with `metadata.missing_phone_for` tag.
  Auto-reconciliation on mapping insert. Kaye row `62e8bb19` retired.
```

**Step 2: Extend the "reminder_queue schema reality" gotcha with the two new columns + fan-out semantics.**

**Step 3: Commit**

```
git add CLAUDE.md
git commit -m "docs: mark private DM reminders TODO done; update schema notes"
```

---

## Rollout checklist

- [ ] All 7 offline unit tests pass (`python -m unittest tests.test_recipient_fanout -v`)
- [ ] All 8 integration tests pass (`python tests/test_webhook.py -v TestPrivateDmReminders`) — 1 retry allowed for LLM flakes
- [ ] esbuild parse-check passes on `index.inlined.ts`
- [ ] Staging smoke test succeeds (Task 15)
- [ ] Kaye manual row retired (Task 16)
- [ ] CLAUDE.md updated (Task 17)
- [ ] `bot_settings.reminders_paused='true'` in production (do NOT flip in this PR)

---

## Risks & mitigations

- **Whapi double-delivery on partial HTTP error** — Whapi dedupes by content+to; `attempts<3` caps. Acceptable.
- **Name-resolution ambiguity** — `ilike '%name%'` may match multiple; `limit(1)` takes first. Log WARN; fix case-by-case.
- **Sonnet hallucinates recipient_phones** — to mitigate if seen in production, add a re-validate step in Task 5 (not included now, YAGNI): look up each `recipient_phones` value in `whatsapp_member_mapping` before insert; reject unknown phones with WARN.
