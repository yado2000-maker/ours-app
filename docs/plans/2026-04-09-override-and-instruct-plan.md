# Override Detection + instruct_bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix rotation override detection ("היום גילעד בתורות למקלחת") and add `instruct_bot` intent for explanatory messages with confirm-then-act flow.

**Architecture:** Override is a classifier prompt fix + entity routing. `instruct_bot` is a new intent with `pending_confirmations` table, pre-classifier confirmation check, Sonnet extraction of hidden action payload, and auto-confirm on timeout.

**Tech Stack:** Supabase (Postgres, RLS), Deno Edge Function (TypeScript), existing Haiku/Sonnet pipeline.

**Design doc:** `docs/plans/2026-04-09-override-and-instruct-design.md`

---

### Task 1: Create `pending_confirmations` table

**Files:**
- DB migration via Supabase MCP tool

**Step 1: Run migration**

```sql
CREATE TABLE pending_confirmations (
  id              text PRIMARY KEY,
  household_id    text NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  group_id        text NOT NULL,
  action_type     text NOT NULL,
  action_data     jsonb NOT NULL,
  confirmation_text text NOT NULL,
  created_by      text,
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_confirmations_select" ON pending_confirmations FOR SELECT USING (is_household_member(household_id));
CREATE POLICY "pending_confirmations_insert" ON pending_confirmations FOR INSERT WITH CHECK (is_household_member(household_id));
CREATE POLICY "pending_confirmations_update" ON pending_confirmations FOR UPDATE USING (is_household_member(household_id));
CREATE POLICY "pending_confirmations_delete" ON pending_confirmations FOR DELETE USING (is_household_member(household_id));

CREATE INDEX idx_pending_confirmations_group ON pending_confirmations(group_id) WHERE status = 'pending';
```

**Step 2: Verify**

Query `list_tables` to confirm table exists.

---

### Task 2: Add `override` entity + override detection to classifier

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~line 90 interface, ~line 505 patterns, ~line 552 examples, ~line 584 rules)
- Modify: `supabase/functions/_shared/haiku-classifier.ts` (same changes)

**Step 1: Add `override` to ClassificationOutput entities**

In `index.inlined.ts` at ~line 98 (after `rotation?` block), add:

```typescript
    override?: {
      title: string;
      person: string;
    };
```

Same in `_shared/haiku-classifier.ts`.

**Step 2: Add override patterns to HEBREW PATTERNS**

After the existing rotation detection block (~line 521 "מי בתור ל...?" line), add:

```
- ROTATION OVERRIDE: When an ACTIVE ROTATION exists and message assigns a specific person for today:
  "[person] בתורות/בתורנות/בתור ל[activity]", "היום [person] ב[activity]", "[person] [activity] היום",
  "[person] ראשון/ראשונה ב[activity] היום", "[person] תורן/תורנית [activity] היום"
  → add_task with override entity: {"override": {"title": "activity", "person": "name"}}
  All synonyms: תור, תורות, תורנות, תורן, תורנית — same meaning.
```

**Step 3: Add override examples**

After the existing rotation examples (~line 556), add:

```
[אמא]: "היום גילעד בתורות למקלחת" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"מקלחת","person":"גילעד"},"raw_text":"היום גילעד בתורות למקלחת"}}
[אבא]: "אביב תורן כלים היום" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"כלים","person":"אביב"},"raw_text":"אביב תורן כלים היום"}}
[אמא]: "גילעד ראשון במקלחת היום" → {"intent":"add_task","confidence":0.90,"entities":{"override":{"title":"מקלחת","person":"גילעד"},"raw_text":"גילעד ראשון במקלחת היום"}}
```

**Step 4: Add override JSON rule**

After the rotation JSON rule (~line 585), add:

```
- For add_task with OVERRIDE (changing who's next in an existing rotation): include "override" object with title and person. Only use when an ACTIVE ROTATION matches. Do NOT use rotation entity for overrides.
```

**Step 5: Update haikuEntitiesToActions**

In `haikuEntitiesToActions` `case "add_task":` (~line 3321), add override check BEFORE the rotation check:

```typescript
    case "add_task":
      if (e.override) {
        actions.push({
          type: "override_rotation",
          data: { title: e.override.title, person: e.override.person },
        });
      } else if (e.rotation) {
        // ... existing rotation code ...
```

**Step 6: Update reply generator for override**

In `buildReplyPrompt` `case "add_task":` (~line 694), add override branch before rotation branch:

```typescript
    case "add_task":
      if (e.override) {
        actionSummary = `Rotation override: "${e.override.title}" switched to ${e.override.person} for today. Confirm the change.`;
      } else if (e.rotation) {
        // ... existing rotation code ...
```

---

### Task 3: Add `instruct_bot` intent to classifier

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~line 74 interface, ~line 460 intents, ~line 505 patterns, ~line 552 examples)
- Modify: `supabase/functions/_shared/haiku-classifier.ts` (same)

**Step 1: Add `instruct_bot` to intent union**

In `ClassificationOutput` interface (~line 75), add after `"add_reminder"`:

```typescript
    | "instruct_bot";
```

Same in `_shared/haiku-classifier.ts`.

**Step 2: Add intent description**

In the INTENTS section of `buildClassifierPrompt` (~line 490), add:

```
- instruct_bot: Parent EXPLAINING a rule or management preference to Sheli. Teaching tone — "ככה...", "אמרתי ש...", "את אמורה ל...", "צריך לנהל את זה ככה ש...". NOT a direct command — it's an explanation of how things should work. Frustration or repetition signals ("אבל את אמורה", "שוב...") also indicate instruct_bot.
```

**Step 3: Add to HEBREW PATTERNS**

After the override patterns, add:

```
- INSTRUCTION vs COMMAND: explanatory messages teaching Sheli a rule = instruct_bot
  Signals: "ככה" (like this), "אמרתי ש" (I said that), "את אמורה ל" (you're supposed to), "צריך לנהל ככה ש" (should manage like), past tense explanations, frustrated repetitions
  Examples: "ככה יום אביב יום גילעד" = instruct_bot. "תורות מקלחת: אביב, גילעד" = add_task (direct command).
```

**Step 4: Add examples**

```
[אמא]: "ככה יום אביב יום גילעד" → {"intent":"instruct_bot","confidence":0.85,"entities":{"raw_text":"ככה יום אביב יום גילעד"}}
[אמא]: "אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד" → {"intent":"instruct_bot","confidence":0.90,"entities":{"raw_text":"אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד"}}
[אבא]: "צריך לנהל את הכלים ככה שכל יום ילד אחר" → {"intent":"instruct_bot","confidence":0.88,"entities":{"raw_text":"צריך לנהל את הכלים ככה שכל יום ילד אחר"}}
```

**Step 5: Update isActionable check**

In the routing logic (~line 2691), `instruct_bot` should NOT be in the `isActionable` set (it follows its own flow). It's like `question` — generates a reply but doesn't go through the standard action executor. Add it to the non-actionable check:

```typescript
    const isActionable = classification.intent !== "ignore" 
      && classification.intent !== "info_request" 
      && classification.intent !== "correct_bot"
      && classification.intent !== "instruct_bot";
```

---

### Task 4: Implement pending confirmation pre-check in webhook handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~line 2595, before quick undo check)

**Step 1: Add confirmation keyword patterns**

After the UNDO_KEYWORDS regex definition, add:

```typescript
const CONFIRM_AFFIRMATIVE = /^(כן|נכון|בדיוק|יאללה|אוקי|ok|כמובן|מדויק|yes|בטח|sure|👍|💪)[\s.!]*$/i;
const CONFIRM_NEGATIVE = /^(לא|לא נכון|טעות|הפוך|שגוי|no|ממש לא)[\s.!]*$/i;
```

**Step 2: Add pending confirmation check**

BEFORE the quick undo check (~line 2595), add:

```typescript
    // 6b. Check for pending confirmation response
    const { data: pendingConfirm } = await supabase
      .from("pending_confirmations")
      .select("id, action_type, action_data, status, expires_at")
      .eq("group_id", message.groupId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingConfirm) {
      const msgTrimmed = message.text.trim();

      if (CONFIRM_AFFIRMATIVE.test(msgTrimmed)) {
        // Execute the pending action
        const actions = [{ type: pendingConfirm.action_type, data: pendingConfirm.action_data }];
        const { summary } = await executeActions(householdId, actions);
        console.log(`[Webhook] Pending confirmation confirmed:`, summary);

        await supabase.from("pending_confirmations")
          .update({ status: "confirmed" })
          .eq("id", pendingConfirm.id);

        await provider.sendMessage({ groupId: message.groupId, text: "מעולה, סידרתי! ✓" });
        await logMessage(message, "confirmation_accepted", householdId);
        return new Response("OK", { status: 200 });
      }

      if (CONFIRM_NEGATIVE.test(msgTrimmed)) {
        await supabase.from("pending_confirmations")
          .update({ status: "rejected" })
          .eq("id", pendingConfirm.id);

        await provider.sendMessage({
          groupId: message.groupId,
          text: "אוקי, ביטלתי 🤷‍♀️ אפשר להסביר שוב ואני אנסה להבין",
        });
        await logMessage(message, "confirmation_rejected", householdId);
        return new Response("OK", { status: 200 });
      }

      // Check for auto-expire: if past expires_at, execute silently
      if (new Date(pendingConfirm.expires_at) < new Date()) {
        const actions = [{ type: pendingConfirm.action_type, data: pendingConfirm.action_data }];
        const { summary } = await executeActions(householdId, actions);
        console.log(`[Webhook] Pending confirmation auto-expired, executing:`, summary);

        await supabase.from("pending_confirmations")
          .update({ status: "expired" })
          .eq("id", pendingConfirm.id);
        // Don't reply — just execute silently and continue with current message
      }

      // If neither confirm nor reject, fall through to normal classification
    }
```

---

### Task 5: Implement `instruct_bot` routing + Sonnet extraction

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~line 2840, non-actionable routing)

**Step 1: Add instruct_bot handler in routing**

In the non-actionable intent routing block (~line 2840), add a dedicated branch for `instruct_bot`:

```typescript
    // instruct_bot: parent explaining a rule → Sonnet parses + confirm-then-act
    if (classification.intent === "instruct_bot") {
      const replyCtx = await buildReplyCtx(householdId);
      const { reply } = await generateReply(classification, message.senderName, replyCtx);

      // Extract hidden PENDING_ACTION block from Sonnet reply
      const pendingAction = extractPendingAction(reply);
      const cleanReply = cleanPendingAction(reply);

      if (pendingAction && pendingAction.action_type) {
        // Store pending confirmation
        const confId = Math.random().toString(36).slice(2, 10);
        const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3 hours
        const { error } = await supabase.from("pending_confirmations").insert({
          id: confId,
          household_id: householdId,
          group_id: message.groupId,
          action_type: pendingAction.action_type,
          action_data: pendingAction.action_data,
          confirmation_text: cleanReply,
          created_by: message.senderName,
          expires_at: expiresAt,
          status: "pending",
        });
        if (error) console.error("[Webhook] Failed to store pending confirmation:", error);
      }

      if (cleanReply) {
        await provider.sendMessage({ groupId: message.groupId, text: cleanReply });
      }
      await logMessage(message, "instruct_bot", householdId, classification);
      return new Response("OK", { status: 200 });
    }
```

**Step 2: Add extractPendingAction + cleanPendingAction helpers**

Near the existing `extractReminderFromReply` (~line 894), add:

```typescript
function extractPendingAction(reply: string): { action_type: string; action_data: Record<string, unknown> } | null {
  const match = reply.match(/<!--PENDING_ACTION:(.*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    console.warn("[PendingAction] Failed to parse PENDING_ACTION block:", match[1]);
    return null;
  }
}

function cleanPendingAction(reply: string): string {
  return reply.replace(/<!--PENDING_ACTION:.*?-->/, "").trim();
}
```

---

### Task 6: Update reply generator for `instruct_bot`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (~line 694, buildReplyPrompt)
- Modify: `supabase/functions/_shared/reply-generator.ts`

**Step 1: Add `instruct_bot` case in buildReplyPrompt**

In the `switch (classification.intent)` block, add before the `default:` case:

```typescript
    case "instruct_bot":
      actionSummary = `The user is explaining a household rule or management preference: "${e.raw_text}".
Parse what they want into a structured action. Common patterns:
- Rotation setup: extract title, type (order/duty), members, frequency → action_type "create_rotation"
- Rotation override: extract title, person → action_type "override_rotation"
- Pattern/preference: extract what they want

Reply in Hebrew with a SPECIFIC confirmation question showing exactly what you understood.
Example: "הבנתי! תורות מקלחת: גילעד ← אביב, מתחלפים כל יום. היום תור של גילעד. נכון?"

IMPORTANT: Include a hidden block at the END of your reply:
<!--PENDING_ACTION:{"action_type":"create_rotation","action_data":{"title":"מקלחת","rotation_type":"order","members":["גילעד","אביב"]}}-->

If you cannot parse a clear action, just acknowledge warmly and ask for clarification. Do NOT include PENDING_ACTION if unclear.`;
      break;
```

**Step 2: Mirror in `_shared/reply-generator.ts`**

Same case added.

---

### Task 7: Add test cases

**Files:**
- Modify: `tests/classifier-test-cases.ts`

**Step 1: Add override + instruct_bot test cases**

After the existing rotation test cases at the end of `ADD_TASK_CASES`, add:

```typescript
  // ─── Override patterns ───
  {
    input: "היום גילעד בתורות למקלחת",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "מקלחת", person: "גילעד" } },
    notes: "Override rotation — specific person for today (when rotation exists)",
  },
  {
    input: "אביב תורן כלים היום",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "כלים", person: "אביב" } },
    notes: "Override using תורן synonym",
  },
  {
    input: "גילעד ראשון במקלחת היום",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "מקלחת", person: "גילעד" } },
    notes: "Override — first in shower today",
  },
```

Add a new section for `instruct_bot`:

```typescript
// ─── INSTRUCT_BOT (teaching Sheli rules) ───
export const INSTRUCT_BOT_CASES: TestCase[] = [
  {
    input: "ככה יום אביב יום גילעד",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Explaining alternating daily pattern",
  },
  {
    input: "אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Frustrated re-explanation of rotation rule",
  },
  {
    input: "צריך לנהל את הכלים ככה שכל יום ילד אחר",
    sender: "אבא",
    expectedIntent: "instruct_bot",
    notes: "Teaching daily chore rotation pattern",
  },
  {
    input: "את אמורה לזכור מי בתור ולהחליף כל יום",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Explaining expected bot behavior",
  },
];
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add to classifier intents table**

Add `instruct_bot` to the 11 Intent Types table (now 12):
```
| `instruct_bot` | Parse instruction → confirm → execute | INSERT pending_confirmations |
```

**Step 2: Add to classification values**

Add `instruct_bot`, `confirmation_accepted`, `confirmation_rejected` to the classification values list.

**Step 3: Document pending_confirmations table**

Add after the `rotations` documentation:
```
- `pending_confirmations` — Confirm-then-act for instruct_bot. Stores parsed action + confirmation text. Status: pending→confirmed/expired/rejected. Auto-executes after 3 hours if no response.
```

**Step 4: Document override synonyms**

Add to gotchas: "תור, תורות, תורנות, תורן, תורנית — all synonymous turn/rotation keywords."

---

## Execution Dependencies

```
Task 1 (DB migration)    ─── must be first
Task 2 (override)        ─── independent (classifier only)
Task 3 (instruct_bot)    ─── independent (classifier only)
Task 4 (pre-check)       ─── after Task 1
Task 5 (routing)         ─── after Task 1 + Task 3
Task 6 (reply generator) ─── after Task 3
Task 7 (tests)           ─── after Task 2 + Task 3
Task 8 (docs)            ─── last

Parallelizable: Tasks 2+3 together, Tasks 4+6 together, Task 7 alone
```
