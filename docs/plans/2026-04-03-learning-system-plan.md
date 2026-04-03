# Sheli Learning System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Sheli learn from corrections — both per-family (prompt enrichment) and globally (weekly review).

**Architecture:** Three-phase incremental build. Phase 1 stores classification data + adds @שלי direct address. Phase 2 adds `correct_bot` intent with undo/redo. Phase 3 adds implicit feedback + `household_patterns` table + prompt injection.

**Tech Stack:** Supabase (Postgres + Edge Functions), Deno, Anthropic Haiku/Sonnet APIs. All changes in `index.inlined.ts` (production) + `_shared/` files (dev reference). Deploy via Supabase Dashboard paste.

**Design Doc:** `docs/plans/2026-04-03-learning-system-design.md`

---

## Phase 1: Foundation (Store Data + @שלי Detection)

### Task 1: DB Migration — classification_data + corrections table

**Files:**
- SQL migration via Supabase MCP `apply_migration`

**Step 1: Apply migration**

```sql
-- Store full Haiku output on every message
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS classification_data JSONB;

-- Corrections from all 3 feedback signals
CREATE TABLE IF NOT EXISTS public.classification_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  message_id UUID,
  correction_type TEXT NOT NULL,
  original_data JSONB,
  corrected_data JSONB,
  applied_to_global BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Family-specific learned patterns
CREATE TABLE IF NOT EXISTS public.household_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT REFERENCES households_v2(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  pattern_value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  hit_count INT DEFAULT 1,
  last_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE(household_id, pattern_type, pattern_key)
);

-- Global prompt improvement proposals
CREATE TABLE IF NOT EXISTS public.global_prompt_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  proposal_type TEXT NOT NULL,
  proposal_text TEXT NOT NULL,
  evidence_count INT NOT NULL,
  household_count INT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for weekly aggregation queries
CREATE INDEX IF NOT EXISTS idx_corrections_created
  ON public.classification_corrections (created_at);
CREATE INDEX IF NOT EXISTS idx_patterns_household
  ON public.household_patterns (household_id, pattern_type);
```

**Step 2: Verify migration**

Run SQL: `SELECT column_name FROM information_schema.columns WHERE table_name = 'whatsapp_messages' AND column_name = 'classification_data';`
Expected: 1 row returned.

Run SQL: `SELECT table_name FROM information_schema.tables WHERE table_name IN ('classification_corrections', 'household_patterns', 'global_prompt_proposals');`
Expected: 3 rows returned.

---

### Task 2: Store classification_data on every Haiku call

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `logMessage()` function (~line 1578)
- Modify: All `logMessage()` call sites in the main handler

**Step 1: Update `logMessage` signature to accept classification_data**

Change the `logMessage` function to accept an optional `classificationData` parameter:

```typescript
async function logMessage(
  message: { messageId: string; groupId: string; senderPhone: string; senderName: string; text: string; type: string },
  classification: string,
  householdId?: string,
  classificationData?: ClassificationOutput | null
) {
  try {
    await supabase.from("whatsapp_messages").insert({
      household_id: householdId || "unknown",
      group_id: message.groupId,
      sender_phone: message.senderPhone,
      sender_name: message.senderName,
      message_text: message.text,
      message_type: message.type,
      whatsapp_message_id: message.messageId,
      classification,
      classification_data: classificationData ? JSON.parse(JSON.stringify(classificationData)) : null,
    });
  } catch (err) {
    console.error("[logMessage] Error:", err);
  }
}
```

**Step 2: Pass classification data at all call sites**

Find every `await logMessage(message, "haiku_actionable", householdId)` and similar calls. Add `classification` as the 4th argument where available:

- `logMessage(message, "haiku_ignore", householdId, classification)` — after Haiku ignore branch
- `logMessage(message, "haiku_low_confidence", householdId, classification)` — after low confidence
- `logMessage(message, "haiku_reply_only", householdId, classification)` — after question/info_request
- `logMessage(message, "haiku_actionable", householdId, classification)` — after action execution
- `logMessage(message, "sonnet_escalated", householdId)` — no Haiku data here (Sonnet took over)
- Other call sites: pass `null` if no classification available

**Step 3: Verify by sending a test message and checking DB**

Run SQL: `SELECT classification_data FROM whatsapp_messages ORDER BY created_at DESC LIMIT 1;`
Expected: JSONB with `{"intent": "...", "confidence": ..., "entities": {...}}`

---

### Task 3: @שלי direct address detection

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — main handler, before Haiku classification (~line 1447)

**Step 1: Add direct address detection after member mapping, before classification**

Insert after line `await upsertMemberMapping(...)` and before `const usageOk = ...`:

```typescript
    // 6b. Detect @שלי direct address — forces a response regardless of intent
    const sheliMentionPattern = /^@?שלי[\s,:]?|,\s*@?שלי[\s,:]?/;
    const directAddress = sheliMentionPattern.test(message.text);
    const cleanedText = directAddress
      ? message.text.replace(/@?שלי[\s,:]*/, "").trim()
      : message.text;

    if (directAddress) {
      console.log(`[Webhook] Direct address detected from ${message.senderName}`);
    }
```

**Step 2: Use cleanedText for classification instead of message.text**

Change the Haiku classification call from:
```typescript
    const classification = await classifyIntent(
      message.text,
      message.senderName,
      haikuCtx
    );
```
To:
```typescript
    const classification = await classifyIntent(
      cleanedText || message.text,
      message.senderName,
      haikuCtx
    );
```

**Step 3: Add forced-reply for direct address + ignore**

After the ignore branch (`if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH)`), add a direct-address override:

```typescript
    // If ignore with high confidence → stop (no Sonnet call)
    // UNLESS directly addressed — then always reply
    if (classification.intent === "ignore" && classification.confidence >= CONFIDENCE_HIGH) {
      if (directAddress) {
        // Direct address overrides ignore — generate a personality reply
        const replyCtx = await buildReplyCtx(householdId);
        const { reply } = await generateReply(classification, message.senderName, replyCtx);
        if (reply) {
          await provider.sendMessage({ groupId: message.groupId, text: reply });
        }
        await logMessage(message, "direct_address_reply", householdId, classification);
        return new Response("OK", { status: 200 });
      }
      await logMessage(message, "haiku_ignore", householdId, classification);
      return new Response("OK", { status: 200 });
    }
```

**Step 4: Test by sending "@שלי כל הכבוד" in WhatsApp group**

Expected: Bot responds with a warm personality reply instead of ignoring.
Check logs: `[Webhook] Direct address detected from Yaron`

---

## Phase 2: Corrections (correct_bot intent + undo/redo)

### Task 4: Add `correct_bot` intent to classifier

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `ClassificationOutput` interface (~line 70) + `buildClassifierPrompt` (~line 386)

**Step 1: Add `correct_bot` to the intent union type**

```typescript
interface ClassificationOutput {
  intent:
    | "add_task"
    | "add_shopping"
    | "add_event"
    | "complete_task"
    | "complete_shopping"
    | "ignore"
    | "question"
    | "claim_task"
    | "info_request"
    | "correct_bot";   // <-- ADD THIS
```

**Step 2: Add correction patterns + examples to the classifier prompt**

In `buildClassifierPrompt`, add to INTENTS section:
```
- correct_bot: Correcting something Sheli just did wrong. "התכוונתי ל...", "לא X, כן Y", "תתקני", "טעית", "זה פריט אחד".
```

Add to EXAMPLES section:
```
[אמא]: "התכוונתי לשמן זית, לא לשמן וזית" → {"intent":"correct_bot","confidence":0.95,"entities":{"correction_text":"שמן זית","raw_text":"התכוונתי לשמן זית, לא לשמן וזית"}}
[אבא]: "שלי טעית, זה דבר אחד" → {"intent":"correct_bot","confidence":0.90,"entities":{"correction_text":"","raw_text":"שלי טעית, זה דבר אחד"}}
```

Add to RULES section:
```
- For correct_bot: extract what the user MEANT in correction_text. This is about fixing Sheli's last action.
```

**Step 3: Add `correction_text` to entities interface**

```typescript
  entities: {
    person?: string;
    items?: Array<{ name: string; qty?: string; category?: string }>;
    title?: string;
    time_raw?: string;
    time_iso?: string;
    task_id?: string;
    item_id?: string;
    correction_text?: string;  // <-- ADD THIS
    raw_text: string;
  };
```

---

### Task 5: Build undo/redo logic for correct_bot

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — new function `handleCorrection()` + routing in main handler

**Step 1: Add `getLastBotAction` helper**

Insert near the helper functions section:

```typescript
async function getLastBotAction(groupId: string, householdId: string): Promise<{
  messageId: string;
  classification_data: ClassificationOutput;
  created_at: string;
} | null> {
  // Find the most recent actionable message from the bot in this group (within 5 min)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("id, classification_data, created_at")
    .eq("group_id", groupId)
    .eq("household_id", householdId)
    .in("classification", ["haiku_actionable", "sonnet_escalated", "batch_actionable"])
    .gte("created_at", fiveMinAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!data || !data.classification_data) return null;
  return {
    messageId: data.id,
    classification_data: data.classification_data as ClassificationOutput,
    created_at: data.created_at,
  };
}
```

**Step 2: Add `undoLastAction` helper**

```typescript
async function undoLastAction(householdId: string, lastAction: ClassificationOutput): Promise<string[]> {
  const undone: string[] = [];

  // Undo based on the original intent
  switch (lastAction.intent) {
    case "add_shopping": {
      const items = lastAction.entities.items || [];
      for (const item of items) {
        const { data } = await supabase
          .from("shopping_items")
          .delete()
          .eq("household_id", householdId)
          .eq("name", item.name)
          .eq("got", false)
          .order("created_at", { ascending: false })
          .limit(1)
          .select("id, name");
        if (data?.[0]) undone.push(`Shopping: "${data[0].name}"`);
      }
      break;
    }
    case "add_task": {
      const title = lastAction.entities.title || lastAction.entities.raw_text;
      const { data } = await supabase
        .from("tasks")
        .delete()
        .eq("household_id", householdId)
        .eq("title", title)
        .eq("done", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .select("id, title");
      if (data?.[0]) undone.push(`Task: "${data[0].title}"`);
      break;
    }
    case "add_event": {
      const title = lastAction.entities.title || lastAction.entities.raw_text;
      const { data } = await supabase
        .from("events")
        .delete()
        .eq("household_id", householdId)
        .eq("title", title)
        .order("created_at", { ascending: false })
        .limit(1)
        .select("id, title");
      if (data?.[0]) undone.push(`Event: "${data[0].title}"`);
      break;
    }
  }
  return undone;
}
```

**Step 3: Add `handleCorrection` function**

```typescript
async function handleCorrection(
  message: IncomingMessage,
  classification: ClassificationOutput,
  householdId: string,
  provider: WhatsAppProvider,
): Promise<void> {
  // 1. Find the last bot action
  const lastAction = await getLastBotAction(message.groupId, householdId);

  if (!lastAction) {
    await provider.sendMessage({
      groupId: message.groupId,
      text: "לא מצאתי פעולה אחרונה לתקן 🤔",
    });
    return;
  }

  // 2. Undo the last action
  const undone = await undoLastAction(householdId, lastAction.classification_data);
  console.log(`[Correction] Undone:`, undone);

  // 3. If correction_text provided, redo with the corrected version
  const correctionText = classification.entities.correction_text;
  let redone: string[] = [];
  if (correctionText) {
    // Re-classify the correction text to get proper entities
    const ctx = await buildClassifierCtx(householdId);
    const reclassified = await classifyIntent(correctionText, message.senderName, ctx);

    if (reclassified.intent !== "ignore" && reclassified.intent !== "correct_bot") {
      const actions = haikuEntitiesToActions(reclassified);
      const result = await executeActions(householdId, actions);
      redone = result.summary;
    }
  }

  // 4. Log the correction for learning
  await supabase.from("classification_corrections").insert({
    household_id: householdId,
    message_id: lastAction.messageId,
    correction_type: "mention_correction",
    original_data: lastAction.classification_data,
    corrected_data: classification,
  });

  // 5. Reply with confirmation
  const replyParts: string[] = [];
  if (undone.length > 0) replyParts.push(`ביטלתי: ${undone.join(", ")}`);
  if (redone.length > 0) replyParts.push(`הוספתי: ${redone.join(", ")}`);
  const reply = replyParts.length > 0
    ? `סורי! 😅 ${replyParts.join(". ")}`
    : "סורי! תיקנתי 😅";

  await provider.sendMessage({ groupId: message.groupId, text: reply });
  await logMessage(message, "correction_applied", householdId, classification);
}
```

**Step 4: Route `correct_bot` in the main handler**

After the shopping batch branch and before the ignore branch, add:

```typescript
    // 8b. Correction: user is fixing something Sheli did wrong
    if (classification.intent === "correct_bot" && classification.confidence >= CONFIDENCE_HIGH) {
      await handleCorrection(message, classification, householdId, provider);
      return new Response("OK", { status: 200 });
    }
```

**Step 5: Test by sending "@שלי התכוונתי לשמן זית, לא לשמן וזית"**

Expected: Bot undoes the wrong items + adds the correct one + replies "סורי! 😅 ..."
Check DB: `classification_corrections` has a row with `correction_type = 'mention_correction'`

---

### Task 6: Explicit "תמחקי" undo command

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — add check in main handler after bot reply

**Step 1: Track last bot action per group**

Add a module-level Map (persists within single request lifecycle only — stateless across requests):

```typescript
// Near the top of the file, after supabase client creation
const UNDO_PATTERNS = /^(תמחקי|בטלי|לא נכון|לא|ביטול|תבטלי)$/;
```

**Step 2: Add undo detection in main handler**

Before Haiku classification, add a quick check for undo commands:

```typescript
    // 6c. Quick undo: if message matches rejection pattern, undo last bot action
    if (UNDO_PATTERNS.test(message.text.trim())) {
      const lastAction = await getLastBotAction(message.groupId, householdId);
      if (lastAction) {
        // Only undo if the last action was within 60 seconds
        const sixtySecsAgo = Date.now() - 60000;
        if (new Date(lastAction.created_at).getTime() > sixtySecsAgo) {
          const undone = await undoLastAction(householdId, lastAction.classification_data);
          if (undone.length > 0) {
            await provider.sendMessage({
              groupId: message.groupId,
              text: `בוטל ✓`,
            });
            await supabase.from("classification_corrections").insert({
              household_id: householdId,
              message_id: lastAction.messageId,
              correction_type: "explicit_reject",
              original_data: lastAction.classification_data,
            });
            await logMessage(message, "explicit_undo", householdId);
            return new Response("OK", { status: 200 });
          }
        }
      }
      // If no recent action to undo, fall through to normal classification
    }
```

**Step 3: Test by adding a shopping item then immediately sending "תמחקי"**

Expected: Item removed, bot replies "בוטל ✓"
Check DB: `classification_corrections` has a row with `correction_type = 'explicit_reject'`

---

## Phase 3: Family Patterns + Prompt Injection

### Task 7: Load and inject household_patterns into Haiku prompt

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — `buildClassifierCtx` + `buildClassifierPrompt`

**Step 1: Extend ClassifierContext with family patterns**

```typescript
interface ClassifierContext {
  members: string[];
  openTasks: Array<{ id: string; title: string; assigned_to: string | null }>;
  openShopping: Array<{ id: string; name: string; qty: string | null }>;
  today: string;
  dayOfWeek: string;
  familyPatterns?: string;  // <-- ADD THIS
}
```

**Step 2: Load patterns in buildClassifierCtx**

Add to `buildClassifierCtx` after the existing parallel queries:

```typescript
  // Load family-specific learned patterns
  const { data: patterns } = await supabase
    .from("household_patterns")
    .select("pattern_type, pattern_key, pattern_value")
    .eq("household_id", householdId)
    .gte("confidence", 0.3)
    .order("hit_count", { ascending: false })
    .limit(20);

  let familyPatterns = "";
  if (patterns && patterns.length > 0) {
    const byType: Record<string, string[]> = {};
    for (const p of patterns) {
      if (!byType[p.pattern_type]) byType[p.pattern_type] = [];
      byType[p.pattern_type].push(`"${p.pattern_key}" = ${p.pattern_value}`);
    }
    const sections: string[] = [];
    if (byType.nickname) sections.push(`Nicknames: ${byType.nickname.join(", ")}`);
    if (byType.time_expr) sections.push(`Times: ${byType.time_expr.join(", ")}`);
    if (byType.category_pref) sections.push(`Categories: ${byType.category_pref.join(", ")}`);
    if (byType.compound_name) sections.push(`Compound names (ONE item): ${byType.compound_name.join(", ")}`);
    if (byType.recurring_item) sections.push(`Recurring: ${byType.recurring_item.join(", ")}`);
    familyPatterns = sections.join("\n");
  }
```

Add `familyPatterns` to the return object.

**Step 3: Inject into the Haiku prompt**

In `buildClassifierPrompt`, add after the SHOPPING CATEGORIES section:

```typescript
  const familySection = ctx.familyPatterns
    ? `\nFAMILY PATTERNS (learned for this household):\n${ctx.familyPatterns}\n`
    : "";
```

And include `${familySection}` in the prompt template before the RULES section.

**Step 4: Test by inserting a test pattern and sending a message**

```sql
INSERT INTO household_patterns (household_id, pattern_type, pattern_key, pattern_value, confidence, hit_count)
VALUES ('mz6gz5xa', 'nickname', 'אבוש', 'דויד', 0.9, 5);
```

Send "@שלי מי אבוש?" — Sheli should know "אבוש" = דויד.

---

### Task 8: Auto-derive patterns from corrections

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — new function `derivePatternFromCorrection`

**Step 1: Add pattern derivation function**

```typescript
async function derivePatternFromCorrection(
  householdId: string,
  correctionType: string,
  originalData: ClassificationOutput | null,
  correctedData: ClassificationOutput | null,
) {
  if (!originalData) return;

  // Category fix: user changed a category
  if (correctionType === "category_fix" && correctedData?.entities?.items?.[0]) {
    const item = correctedData.entities.items[0];
    if (item.category && item.category !== "אחר") {
      await supabase.from("household_patterns").upsert({
        household_id: householdId,
        pattern_type: "category_pref",
        pattern_key: item.name,
        pattern_value: item.category,
        confidence: 0.7,
        hit_count: 1,
        last_seen: new Date().toISOString(),
      }, { onConflict: "household_id,pattern_type,pattern_key" });
    }
  }

  // Compound name fix: user corrected a split (e.g., "שמן" + "זית" → "שמן זית")
  if (correctionType === "mention_correction" && correctedData?.entities?.correction_text) {
    const correctedText = correctedData.entities.correction_text;
    if (correctedText.includes(" ")) {
      await supabase.from("household_patterns").upsert({
        household_id: householdId,
        pattern_type: "compound_name",
        pattern_key: correctedText,
        pattern_value: correctedText,
        confidence: 0.8,
        hit_count: 1,
        last_seen: new Date().toISOString(),
      }, { onConflict: "household_id,pattern_type,pattern_key" });
    }
  }
}
```

**Step 2: Call it from handleCorrection and the explicit undo**

In `handleCorrection`, after inserting into `classification_corrections`, add:

```typescript
  await derivePatternFromCorrection(householdId, "mention_correction", lastAction.classification_data, classification);
```

**Step 3: Verify by correcting a compound name and checking patterns**

Send "שמן זית" → bot splits it → send "@שלי התכוונתי לשמן זית"
Check DB: `SELECT * FROM household_patterns WHERE household_id = 'mz6gz5xa' AND pattern_type = 'compound_name';`
Expected: Row with `pattern_key = 'שמן זית'`

---

### Task 9: Mirror changes to dev reference files

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.ts`
- Modify: `supabase/functions/_shared/haiku-classifier.ts`
- Modify: `supabase/functions/_shared/action-executor.ts`

Mirror all changes from Tasks 2-8 to the dev reference files. Keep the modular structure — types go in their respective `_shared/` files, handler logic goes in `index.ts`.

---

### Task 10: Deploy + end-to-end testing

**Step 1: Deploy via Dashboard**

1. Open `index.inlined.ts` in text editor
2. Go to Supabase Dashboard → Edge Functions → whatsapp-webhook → Code
3. Select all → delete → paste → Deploy updates

**Step 2: Test the full learning loop**

| Test | Send | Expected |
|------|------|----------|
| Classification data stored | "אבוקדו" | `classification_data` JSONB in `whatsapp_messages` |
| @שלי praise reply | "@שלי כל הכבוד" | Warm reply (not ignored) |
| @שלי question | "@שלי מה צריך מהסופר?" | Shopping list response |
| correct_bot undo+redo | "@שלי התכוונתי לשמן זית" | Undo wrong + add correct + "סורי!" |
| תמחקי undo | Add item → "תמחקי" within 60s | "בוטל ✓" |
| Pattern derived | After correction, send "שמן זית" again | Should be one item (learned) |
| Family patterns loaded | Insert nickname pattern → ask "@שלי מי אבוש?" | Knows the nickname |

---

## Future Tasks (Not in This Plan)

- **Implicit feedback from app** (delete-within-5min detection) — needs Realtime watcher or DB trigger
- **Weekly global review batch job** — Claude analyzes corrections, proposes prompt improvements
- **Recurring item detection** — track shopping frequency per household
- **Pattern confidence decay** — reduce confidence for unseen patterns over 90 days
