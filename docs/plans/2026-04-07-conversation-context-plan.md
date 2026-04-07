# Conversation-Aware Classification & Dedup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the WhatsApp bot read recent conversation history before classifying each message, so it understands conversational context (not just the single message), and add dedup logic to prevent duplicate shopping items, tasks, and events.

**Architecture:** Add a `fetchRecentConversation()` function that queries recent messages, inject them into the Haiku classifier prompt as a RECENT CONVERSATION section, add a `needs_conversation_review` output field that triggers Sonnet escalation, and add dedup checks (with quantity-aware merge for shopping) inside `executeActions` before every INSERT.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), Anthropic Haiku + Sonnet API, Supabase Postgres

---

### Task 1: Add `fetchRecentConversation` Function

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts` (add function after line 207)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add function, must be inlined later)

**Step 1: Write the function in the modular file**

Add at end of `supabase/functions/_shared/haiku-classifier.ts`:

```typescript
/**
 * Fetch recent conversation for context injection.
 * Returns whichever is MORE: all messages within 15 min, OR last 10 regardless of age.
 * Capped at 30 messages, returned in chronological order.
 */
export async function fetchRecentConversation(
  supabase: any,
  groupId: string,
  excludeMessageId?: string
): Promise<Array<{ sender_name: string; message_text: string; created_at: string }>> {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Query 1: all messages within 15 minutes
  const { data: recentByTime } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .gte("created_at", fifteenMinAgo)
    .order("created_at", { ascending: true })
    .limit(30);

  // Query 2: last 10 messages regardless of age
  const { data: recentByCount } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(10);

  // Merge: use whichever set is LARGER, dedup by id
  const byTime = recentByTime || [];
  const byCount = (recentByCount || []).reverse(); // chronological
  const base = byTime.length >= byCount.length ? byTime : byCount;

  // Merge any messages from the other set not already included
  const ids = new Set(base.map((m: any) => m.id));
  const other = byTime.length >= byCount.length ? byCount : byTime;
  for (const m of other) {
    if (!ids.has(m.id)) {
      base.push(m);
      ids.add(m.id);
    }
  }

  // Sort chronologically, exclude current message, cap at 30
  return base
    .filter((m: any) => m.id !== excludeMessageId && m.message_text)
    .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at))
    .slice(-30)
    .map((m: any) => ({
      sender_name: m.sender_name || "?",
      message_text: m.message_text,
      created_at: m.created_at,
    }));
}
```

**Step 2: Verify it compiles**

No direct test runner for Deno Edge Functions — visual review that types are correct.

**Step 3: Commit**

```bash
git add supabase/functions/_shared/haiku-classifier.ts
git commit -m "feat: add fetchRecentConversation for conversation context"
```

---

### Task 2: Update Haiku Classifier Prompt with Conversation Context

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts` — `ClassifierContext` interface (line 31), `buildClassifierPrompt` (line 42), `classifyIntent` signature (line 138), `ClassificationOutput` interface (line 5)

**Step 1: Add `needs_conversation_review` to ClassificationOutput**

In `ClassificationOutput` interface (line 5), add after `confidence`:

```typescript
  addressed_to_bot?: boolean;
  needs_conversation_review?: boolean; // true when context makes intent ambiguous
```

Note: `addressed_to_bot` already exists in the inlined version but not in the modular file. Add both if missing.

**Step 2: Add `conversationHistory` to ClassifierContext**

In `ClassifierContext` interface (line 31), add:

```typescript
  conversationHistory?: string; // Formatted recent conversation for context
```

**Step 3: Update `buildClassifierPrompt` to include conversation context**

In `buildClassifierPrompt` (line 42), add a new section BEFORE the `EXAMPLES:` line (currently line 114). Insert right after the `FAMILY PATTERNS` / `HEBREW DAYS` line (line 112):

```typescript
${ctx.conversationHistory ? `
RECENT CONVERSATION (oldest first, for context):
${ctx.conversationHistory}

CONVERSATION CONTEXT RULES:
- Read the RECENT CONVERSATION to understand the CURRENT MESSAGE in context.
- A message that REFERS to a previously mentioned product/task/event is NOT a new request.
  Example: "אין ספרייט" after someone asked for Sprite = status update → ignore.
- A message correcting/updating a previous request is NOT a new add.
  Example: "לא 2, צריך 3" = quantity update, not new item.
- A message between family members ABOUT an item is social chatter → ignore.
  Example: "גור יש רק 7אפ" = telling Gur something, not requesting the bot.
- Only classify as actionable when the sender is clearly REQUESTING the bot to act.
- These rules apply to ALL entity types: shopping, tasks, and events.
- If you are uncertain whether a message is a request or just conversation, set confidence: 0.55 and needs_conversation_review: true.
` : ""}
```

**Step 4: Update `classifyIntent` to accept and format conversation**

Change the `classifyIntent` function signature (line 138) to accept conversation messages:

```typescript
export async function classifyIntent(
  message: string,
  sender: string,
  context: ClassifierContext,
  apiKey?: string
): Promise<ClassificationOutput> {
```

No signature change needed — the conversation is already embedded in `context.conversationHistory`. But update the response parser (line 179) to include the new field:

```typescript
      return {
        intent: parsed.intent || "ignore",
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        addressed_to_bot: parsed.addressed_to_bot || false,
        needs_conversation_review: parsed.needs_conversation_review || false,
        entities: {
          ...parsed.entities,
          raw_text: message,
        },
      };
```

**Step 5: Update the RULES section of the prompt**

In the RULES section (line 128), add:

```
- If conversation context makes your classification uncertain, include "needs_conversation_review": true in your response.
```

**Step 6: Commit**

```bash
git add supabase/functions/_shared/haiku-classifier.ts
git commit -m "feat: add conversation context to Haiku classifier prompt"
```

---

### Task 3: Add Normalization and Dedup Functions

**Files:**
- Modify: `supabase/functions/_shared/action-executor.ts` (add helper functions at top)

**Step 1: Write normalization functions**

Add before the `executeActions` function in `action-executor.ts`:

```typescript
// ─── Normalization & Dedup Helpers ───

const CONTAINER_PREFIXES = /^(בקבוק|בקבוקי|חבילת|חבילות|שקית|שקיות|קופסת|קופסאות|פחית|פחיות|ארגז|שלישיית)\s+/;
const QTY_PREFIX = /^(\d+\.?\d*)\s+/;
const DESCRIPTOR_SUFFIX = /\s+(ליטר|מ"ל|מל|גרם|ג'|קילו|ק"ג|יחידות|זוגות)(\s+.+)?$/;
const REPEATED_LETTERS = /(.)\1{2,}/g; // 3+ repeats → 2

interface ParsedProduct {
  name: string;       // Core product name (for comparison)
  qty: string | null;  // Extracted quantity
  fullName: string;    // Original text (for display)
}

function extractProduct(text: string): ParsedProduct {
  let remaining = text.trim();
  const fullName = remaining;

  // Extract leading quantity
  let qty: string | null = null;
  const qtyMatch = remaining.match(QTY_PREFIX);
  if (qtyMatch) {
    qty = qtyMatch[1];
    remaining = remaining.slice(qtyMatch[0].length);
  }

  // Strip container prefixes
  remaining = remaining.replace(CONTAINER_PREFIXES, "");

  // Strip trailing descriptors (ליטר וחצי, 500 מל, etc.)
  remaining = remaining.replace(DESCRIPTOR_SUFFIX, "");

  // Collapse repeated letters (ספרייייט → ספריט)
  remaining = remaining.replace(REPEATED_LETTERS, "$1$1");

  return {
    name: remaining.trim(),
    qty,
    fullName,
  };
}

function isSameProduct(a: string, b: string): boolean {
  const na = a.replace(REPEATED_LETTERS, "$1$1").trim();
  const nb = b.replace(REPEATED_LETTERS, "$1$1").trim();
  if (na === nb) return true;
  if (na.length >= 2 && nb.length >= 2) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

const TASK_FILLER = /^(את\s+|ה|ל|ב)/;

function normalizeTaskTitle(text: string): string {
  return text
    .trim()
    .replace(TASK_FILLER, "")
    .replace(REPEATED_LETTERS, "$1$1")
    .trim();
}

function isSameTask(a: string, b: string): boolean {
  const na = normalizeTaskTitle(a);
  const nb = normalizeTaskTitle(b);
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

function isSameEvent(
  existingTitle: string,
  newTitle: string,
  existingDate: string,
  newDate: string
): boolean {
  // Must be on the same date
  const eDate = existingDate.slice(0, 10); // "YYYY-MM-DD"
  const nDate = newDate.slice(0, 10);
  if (eDate !== nDate) return false;
  return isSameTask(existingTitle, newTitle);
}
```

**Step 2: Commit**

```bash
git add supabase/functions/_shared/action-executor.ts
git commit -m "feat: add normalization and dedup helper functions"
```

---

### Task 4: Add Dedup Logic to `executeActions` — Shopping Items

**Files:**
- Modify: `supabase/functions/_shared/action-executor.ts` — `add_shopping` case
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — same section (lines 1019-1036)

**Step 1: Update `add_shopping` case with dedup**

Replace the `add_shopping` case in `executeActions`:

```typescript
case "add_shopping": {
  const { items } = action.data as {
    items: Array<{ name: string; qty?: string; category?: string }>;
  };

  // Fetch existing open shopping items for dedup
  const { data: existingItems } = await supabase
    .from("shopping_items")
    .select("id, name, qty, category")
    .eq("household_id", householdId)
    .eq("got", false);

  for (const item of items || []) {
    const parsed = extractProduct(item.name);

    // Check for existing similar product
    const match = (existingItems || []).find((existing: any) => {
      const existingParsed = extractProduct(existing.name);
      return isSameProduct(parsed.name, existingParsed.name);
    });

    if (match) {
      // Duplicate found — decide: update or skip
      const incomingQty = item.qty || parsed.qty;
      const existingQty = match.qty;

      if (incomingQty && incomingQty !== existingQty) {
        // New quantity provided — UPDATE existing item
        const updates: Record<string, any> = { qty: incomingQty };
        // If incoming name is more specific (longer), update name too
        if (item.name.length > match.name.length) {
          updates.name = item.name;
        }
        await supabase.from("shopping_items")
          .update(updates)
          .eq("id", match.id);
        summary.push(`Shopping-updated: "${match.name}" → qty ${incomingQty}`);
      } else {
        // No new info — skip
        summary.push(`Shopping-exists: "${match.name}"`);
      }
    } else {
      // No duplicate — INSERT as usual
      const { error } = await supabase.from("shopping_items").insert({
        id: uid4(),
        household_id: householdId,
        name: item.name,
        qty: item.qty || parsed.qty || null,
        category: item.category || "אחר",
        got: false,
      });
      if (error) throw error;
      summary.push(`Shopping: "${item.name}"${item.qty ? ` ×${item.qty}` : ""}`);
    }
  }
  break;
}
```

**Step 2: Commit**

```bash
git add supabase/functions/_shared/action-executor.ts
git commit -m "feat: add shopping dedup with quantity-aware merge"
```

---

### Task 5: Add Dedup Logic to `executeActions` — Tasks and Events

**Files:**
- Modify: `supabase/functions/_shared/action-executor.ts` — `add_task` and `add_event` cases

**Step 1: Update `add_task` case with dedup**

Replace the `add_task` case:

```typescript
case "add_task": {
  const { title, assigned_to } = action.data as { title: string; assigned_to?: string };

  // Check for existing similar open task
  const { data: existingTasks } = await supabase
    .from("tasks")
    .select("id, title, assigned_to")
    .eq("household_id", householdId)
    .eq("done", false);

  const match = (existingTasks || []).find((existing: any) =>
    isSameTask(existing.title, title)
  );

  if (match) {
    summary.push(`Task-exists: "${match.title}"`);
  } else {
    const { error } = await supabase.from("tasks").insert({
      id: uid4(),
      household_id: householdId,
      title,
      assigned_to: assigned_to || null,
      done: false,
    });
    if (error) throw error;
    summary.push(`Task: "${title}"${assigned_to ? ` → ${assigned_to}` : ""}`);
  }
  break;
}
```

**Step 2: Update `add_event` case with dedup**

Replace the `add_event` case:

```typescript
case "add_event": {
  const { title, assigned_to, scheduled_for } = action.data as {
    title: string;
    assigned_to?: string;
    scheduled_for: string;
  };

  // Check for existing similar event on same date
  const datePrefix = scheduled_for.slice(0, 10); // "YYYY-MM-DD"
  const { data: existingEvents } = await supabase
    .from("events")
    .select("id, title, scheduled_for")
    .eq("household_id", householdId)
    .gte("scheduled_for", `${datePrefix}T00:00:00`)
    .lte("scheduled_for", `${datePrefix}T23:59:59`);

  const match = (existingEvents || []).find((existing: any) =>
    isSameEvent(existing.title, title, existing.scheduled_for, scheduled_for)
  );

  if (match) {
    summary.push(`Event-exists: "${match.title}"`);
  } else {
    const { error } = await supabase.from("events").insert({
      id: uid4(),
      household_id: householdId,
      title,
      assigned_to: assigned_to || null,
      scheduled_for: scheduled_for,
    });
    if (error) throw error;
    summary.push(`Event: "${title}" @ ${scheduled_for}`);
  }
  break;
}
```

**Step 3: Commit**

```bash
git add supabase/functions/_shared/action-executor.ts
git commit -m "feat: add task and event dedup in executeActions"
```

---

### Task 6: Wire Conversation Context into Message Handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — main handler (around lines 1850-1870)

**Step 1: Fetch conversation before classification**

In the main message handler, BEFORE the `classifyIntent` call (line 1863), add:

```typescript
// Fetch recent conversation for context
const conversationMsgs = await fetchRecentConversation(
  supabase,
  message.groupId || message.senderId,
  message.id  // exclude current message
);

// Format for classifier prompt
const conversationHistory = conversationMsgs.length > 0
  ? conversationMsgs.map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jerusalem",
      });
      return `[${time} ${m.sender_name}]: ${m.message_text}`;
    }).join("\n")
  : undefined;

// Add conversation to classifier context
haikuCtx.conversationHistory = conversationHistory;
```

The existing `classifyIntent` call stays the same — the conversation is now embedded in `haikuCtx`.

**Step 2: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: wire conversation context into message handler"
```

---

### Task 7: Update Sonnet Escalation to Pass Conversation

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — escalation block (around lines 1953-1990)

**Step 1: Add `needs_conversation_review` to escalation condition**

Change the escalation condition (line 1953) from:

```typescript
if (classification.confidence < CONFIDENCE_HIGH && isActionable) {
```

to:

```typescript
if (
  (classification.confidence < CONFIDENCE_HIGH && isActionable) ||
  classification.needs_conversation_review
) {
```

**Step 2: Pass conversation window to Sonnet**

Change the `classifyMessages` call (line 1955) from:

```typescript
const sonnetResult = await classifyMessages(householdId, [
  { sender: message.senderName, text: message.text, timestamp: message.timestamp },
]);
```

to:

```typescript
// Build conversation context for Sonnet escalation
const sonnetMessages = [
  ...conversationMsgs.map((m) => ({
    sender: m.sender_name,
    text: m.message_text,
    timestamp: new Date(m.created_at).getTime(),
  })),
  { sender: message.senderName, text: message.text, timestamp: message.timestamp },
];

const sonnetResult = await classifyMessages(householdId, sonnetMessages);
```

This passes the full conversation window + current message to Sonnet. The existing `classifyMessages` already joins multiple messages with newlines — it just never received more than one until now.

**Step 3: Update classification logging**

After the escalation block, add logging for the new field:

```typescript
if (classification.needs_conversation_review) {
  console.log(`[Webhook] Context-uncertain, escalating to Sonnet`);
}
```

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: escalate to Sonnet with conversation when context uncertain"
```

---

### Task 8: Update Reply Generator for Dedup Outcomes

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — reply generation after `executeActions` (around lines 2003-2045)

**Step 1: Handle dedup summaries in reply**

After `executeActions` returns, check the summary for dedup outcomes. In the section where the reply is generated after high-confidence actionable classification (around line 2010), update the reply logic:

```typescript
const { success, summary } = await executeActions(householdId, actions);

// Check if dedup caught everything (all items were duplicates)
const allDeduped = summary.every(
  (s) => s.includes("-exists:") || s.includes("-updated:")
);
const someDeduped = summary.some(
  (s) => s.includes("-exists:") || s.includes("-updated:")
);

if (allDeduped && summary.length > 0) {
  // Everything was a duplicate — send dedup reply instead of normal reply
  const dedupMessages: string[] = [];
  for (const s of summary) {
    if (s.includes("Shopping-exists:")) {
      const name = s.match(/"(.+?)"/)?.[1] || "";
      dedupMessages.push(`${name} כבר ברשימה`);
    } else if (s.includes("Shopping-updated:")) {
      const match = s.match(/"(.+?)" → qty (.+)/);
      if (match) dedupMessages.push(`עדכנתי ${match[1]} ל-${match[2]}`);
    } else if (s.includes("Task-exists:")) {
      const name = s.match(/"(.+?)"/)?.[1] || "";
      dedupMessages.push(`"${name}" כבר במטלות`);
    } else if (s.includes("Event-exists:")) {
      const name = s.match(/"(.+?)"/)?.[1] || "";
      dedupMessages.push(`"${name}" כבר ביומן`);
    }
  }
  const dedupReply = "👍 " + dedupMessages.join("\n");
  await provider.sendMessage({ groupId: message.groupId || message.senderId, text: dedupReply });
} else if (someDeduped) {
  // Mixed: some new, some deduped — generate normal reply (for new items) + dedup note
  // Let Sonnet generate the reply for the new items; the summary already excludes deduped
  const replyCtx = await buildReplyCtx(householdId);
  const { reply } = await generateReply(classification, message.senderName, replyCtx);
  await provider.sendMessage({ groupId: message.groupId || message.senderId, text: reply });
} else {
  // Normal path — no dedup, generate reply as usual
  const replyCtx = await buildReplyCtx(householdId);
  const { reply } = await generateReply(classification, message.senderName, replyCtx);
  await provider.sendMessage({ groupId: message.groupId || message.senderId, text: reply });
}
```

**Step 2: Apply same logic to batch processing**

In `claimAndProcessBatch` (around line 1605), after `executeActions` returns, add the same dedup summary check. Replace the batch reply section:

```typescript
const { success, summary } = await executeActions(householdId, actions);

// Build reply that accounts for dedup
const newItems = summary.filter((s) => s.startsWith("Shopping:"));
const updatedItems = summary.filter((s) => s.includes("Shopping-updated:"));
const existsItems = summary.filter((s) => s.includes("Shopping-exists:"));

const replyParts: string[] = [];
if (newItems.length > 0) {
  const names = newItems.map((s) => s.match(/"(.+?)"/)?.[1]).filter(Boolean);
  replyParts.push(`🛒 הוספתי ${names.join(", ")} לרשימה`);
}
if (updatedItems.length > 0) {
  for (const s of updatedItems) {
    const match = s.match(/"(.+?)" → qty (.+)/);
    if (match) replyParts.push(`עדכנתי ${match[1]} ל-${match[2]}`);
  }
}
if (existsItems.length > 0) {
  const names = existsItems.map((s) => s.match(/"(.+?)"/)?.[1]).filter(Boolean);
  replyParts.push(`${names.join(", ")} כבר ברשימה 👍`);
}

const batchReply = replyParts.join("\n") || "🛒 עדכנתי את הרשימה";
await provider.sendMessage({ groupId, text: batchReply });
```

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: dedup-aware reply generation for shopping, tasks, events"
```

---

### Task 9: Inline Everything into Production File

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — inline all changes from modular files

**Step 1: Inline `fetchRecentConversation`**

Copy the function from `haiku-classifier.ts` into `index.inlined.ts`. Place it near the existing `buildClassifierCtx` function (around line 2259).

**Step 2: Inline normalization functions**

Copy `extractProduct`, `isSameProduct`, `normalizeTaskTitle`, `isSameTask`, `isSameEvent` from `action-executor.ts` into `index.inlined.ts`. Place them right before `executeActions` (around line 990).

**Step 3: Inline classifier prompt changes**

Update the inlined copy of `buildClassifierPrompt` (around lines 437-533) with the same CONVERSATION CONTEXT RULES section added in Task 2.

**Step 4: Update inlined `ClassificationOutput` interface**

Add `needs_conversation_review?: boolean` to the inlined interface (around line 71).

**Step 5: Update inlined `ClassifierContext` interface**

Add `conversationHistory?: string` to the inlined interface.

**Step 6: Update inlined `classifyIntent` response parser**

Add `needs_conversation_review: parsed.needs_conversation_review || false` to the return object.

**Step 7: Verify the inlined file is self-consistent**

Read through to confirm all functions reference each other correctly and no imports are broken.

**Step 8: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: inline all conversation context and dedup changes"
```

---

### Task 10: Deploy and Test

**Files:**
- Deploy: `supabase/functions/whatsapp-webhook/index.inlined.ts` via Supabase Dashboard

**Step 1: Deploy to Supabase**

Open `index.inlined.ts` in Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab → paste → Deploy. Verify JWT = OFF.

**Step 2: Test conversation context — shopping chatter scenario**

In the family WhatsApp group, simulate:
1. Person A: "צריך ספרייט" → Bot should add Sprite
2. Person B: "אין ספרייט בסופר" → Bot should IGNORE (status update, not request)
3. Person A: "אז 7אפ" → Bot should add 7Up (new request)

Verify in Supabase Dashboard → whatsapp_messages table that message #2 was classified as `ignore`.

**Step 3: Test dedup — duplicate shopping item**

1. Person A: "חלב" → Bot adds milk
2. Person B: "3 חלב" → Bot should UPDATE qty to 3 (not add new milk)
3. Person A: "חלב" again → Bot should reply "חלב כבר ברשימה 👍"

Check `shopping_items` table: should have exactly ONE milk row with qty=3.

**Step 4: Test dedup — duplicate task**

1. "לנקות מטבח" → Bot adds task
2. "לנקות את המטבח" → Bot should reply "המטלה כבר קיימת 👍"

Check `tasks` table: should have exactly ONE clean-kitchen task.

**Step 5: Test dedup — duplicate event**

1. "ארוחת ערב ביום שלישי" → Bot adds event
2. "ארוחת ערב יום שלישי" → Bot should reply "האירוע כבר ביומן 👍"

Check `events` table: should have exactly ONE dinner event.

**Step 6: Test Sonnet escalation on ambiguous context**

1. Person A: "שלי תוסיפי ביצים" → Haiku should classify clearly (add_shopping, high conf)
2. Person A: "ביצים זה הכל?" Person B: "ביצים וחלב" → The second message is ambiguous (shopping request? or answering the question?)

Check logs: message should show `needs_conversation_review: true` and Sonnet escalation.

**Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: post-deploy testing adjustments"
```
