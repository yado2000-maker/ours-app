# Family Memory System + Fabrication Guardrail — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop Sheli from inventing fake family events, then give her real family memories to reference naturally in replies.

**Architecture:** New `family_memories` table (10/member, scoped group/direct). Sonnet auto-detects memories via `<!--MEMORY:-->` block. Memories injected into Sonnet reply context with 2-day freshness gate + 24hr cooldown. Three new Haiku intents for explicit save/recall/delete.

**Tech Stack:** Supabase (table + RLS + migration), TypeScript (Edge Function), Anthropic API (Sonnet + Haiku prompts)

**Design doc:** `docs/plans/2026-04-11-family-memory-design.md`

---

## Task 1: Fabrication Guardrail (prompt-only fix)

**Files:**
- Modify: `supabase/functions/_shared/reply-generator.ts:161-163`
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:911-926`

**Step 1: Add guardrail to modular reply-generator.ts**

In `reply-generator.ts`, after the TROLLING section (line 161) and before the info_request line (line 163), insert:

```typescript
GROUNDING — MANDATORY:
NEVER reference events, habits, mistakes, or scenarios that aren't explicitly in this conversation, the action results, or the family memories provided below. When roasting or joking back, use ONLY what the sender actually said or did. If you have nothing specific to reference, keep it generic and short. Do NOT invent stories, habits, or failures to sound witty.
```

The exact edit: after line 161 (`- Testing limits: show personality, not rules. They want to see if you're fun.`), before line 163 (`For info_request:`).

**Step 2: Mirror guardrail in index.inlined.ts**

In `index.inlined.ts`, after line 911 (`- Testing limits: show personality, not rules. They want to see if you're fun.`), before line 913 (`OUT-OF-SCOPE REQUESTS:`), insert the same GROUNDING block.

**Step 3: Verify by searching for the new text**

Run: `grep -n "GROUNDING" supabase/functions/_shared/reply-generator.ts supabase/functions/whatsapp-webhook/index.inlined.ts`
Expected: both files contain the GROUNDING section.

**Step 4: Commit**

```bash
git add supabase/functions/_shared/reply-generator.ts supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "fix: add fabrication guardrail to Sonnet reply prompt

Prevents Sheli from inventing events/habits not in conversation.
Triggered by La Familia incident (fake milk-on-Shabbat reference)."
```

---

## Task 2: Create `family_memories` table

**Files:**
- Create: Supabase migration via `mcp__f5337598__apply_migration`

**Step 1: Apply the migration**

Use the Supabase MCP tool `apply_migration` with this SQL:

```sql
-- Family memories: narrative context for Sheli's personality
CREATE TABLE public.family_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  member_phone TEXT,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('moment', 'personality', 'preference', 'nickname', 'quote', 'about_sheli')),
  content TEXT NOT NULL,
  context TEXT,
  source TEXT NOT NULL DEFAULT 'auto_detected' CHECK (source IN ('auto_detected', 'explicit_save', 'correction')),
  scope TEXT NOT NULL DEFAULT 'group' CHECK (scope IN ('group', 'direct')),
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  use_count INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_family_memories_household ON family_memories(household_id) WHERE active = true;
CREATE INDEX idx_family_memories_member ON family_memories(household_id, member_phone) WHERE active = true;

-- RLS: service_role only (bot reads/writes, no direct user access)
ALTER TABLE family_memories ENABLE ROW LEVEL SECURITY;

-- Enable Realtime (not strictly needed but consistent with other tables)
ALTER PUBLICATION supabase_realtime ADD TABLE public.family_memories;
```

**Step 2: Verify table exists**

Use `execute_sql`: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'family_memories' ORDER BY ordinal_position;`

Expected: 13 columns (id, household_id, member_phone, memory_type, content, context, source, scope, importance, created_at, last_used_at, use_count, active).

**Step 3: Commit design doc + plan**

```bash
git add docs/plans/2026-04-11-family-memory-design.md docs/plans/2026-04-11-family-memory-plan.md
git commit -m "docs: family memory system design + implementation plan"
```

---

## Task 3: Add `familyMemories` to ReplyContext and load them in `buildReplyCtx`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:131-141` (ReplyContext interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:4276-4323` (buildReplyCtx function)

**Step 1: Extend ReplyContext interface**

At `index.inlined.ts:141`, before the closing `}` of ReplyContext, add:

```typescript
  familyMemories?: string; // Formatted family memories for prompt injection
```

So the interface becomes:
```typescript
interface ReplyContext {
  householdName: string;
  members: string[];
  memberGenders?: Record<string, string>;
  language: string;
  currentTasks: Array<{ id: string; title: string; assigned_to: string | null; done: boolean }>;
  currentShopping: Array<{ id: string; name: string; qty: string | null; got: boolean }>;
  currentEvents: Array<{ id: string; title: string; assigned_to: string | null; scheduled_for: string }>;
  currentRotations?: Array<{ id: string; title: string; type: string; members: string[]; current_index: number; frequency?: object | null }>;
  recentBotReplies?: string[];
  familyMemories?: string; // Formatted family memories for prompt injection
}
```

**Step 2: Query and format memories in buildReplyCtx**

In `buildReplyCtx` (line 4276), add `family_memories` to the `Promise.all` at line 4280. Add a 7th query:

```typescript
  const [membersRes, tasksRes, shoppingRes, eventsRes, rotationsRes, botMsgsRes, memoriesRes] = await Promise.all([
    // ... existing 6 queries unchanged ...
    supabase.from("family_memories")
      .select("member_phone, memory_type, content, created_at, last_used_at")
      .eq("household_id", householdId)
      .eq("active", true)
      .lte("created_at", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()) // 2-day freshness gate
      .order("importance", { ascending: false })
      .limit(30),
  ]);
```

After the `memberGenders` block (after line 4307), add memory formatting:

```typescript
  // Build family memories string for Sonnet prompt injection
  let familyMemories = "";
  const memories = memoriesRes.data || [];
  if (memories.length > 0) {
    // Filter out memories used in the last 24 hours (cooldown)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const eligible = memories.filter((m: any) => !m.last_used_at || m.last_used_at < oneDayAgo);

    if (eligible.length > 0) {
      // Map member phones to display names for readability
      const memberNames: Record<string, string> = {};
      for (const m of (membersRes.data || [])) {
        // Try to find phone in whatsapp_member_mapping — but for now use phone as-is
        // Names will be resolved when we have the mapping context
      }

      const lines = eligible.slice(0, 8).map((m: any) => {
        const who = m.member_phone || "Household";
        const daysAgo = Math.floor((Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const timeLabel = daysAgo <= 7 ? `${daysAgo} days ago` : `${Math.floor(daysAgo / 7)} weeks ago`;
        return `- ${who}: ${m.content} (${timeLabel})`;
      });
      familyMemories = lines.join("\n");
    }
  }
```

Add `familyMemories` to the return object at line 4309:

```typescript
  return {
    // ... existing fields ...
    recentBotReplies: (botMsgsRes.data || []).map((m: any) => m.message_text),
    familyMemories,
  };
```

**Step 3: Verify no syntax errors**

Search the file for the new field: `grep -n "familyMemories" index.inlined.ts`
Expected: hits in interface, buildReplyCtx, and return statement.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: load family memories into ReplyContext

Queries family_memories table with 2-day freshness gate and
24hr cooldown. Formats as readable lines for Sonnet injection."
```

---

## Task 4: Inject memories into Sonnet reply prompt + add MEMORY capture instruction

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:748-959` (buildReplyPrompt function)

**Step 1: Accept familyMemories in the prompt builder**

The `buildReplyPrompt` function at line 748 already receives `ctx: ReplyContext`. The new `familyMemories` field is available via `ctx.familyMemories`.

At the end of the prompt, before the final instruction line (line 957-959, the "Reply with ONLY..." line), add two blocks:

**Block A — Memory injection (before the closing instruction):**

```typescript
${ctx.familyMemories ? `
FAMILY MEMORIES (use naturally, not robotically — only when genuinely relevant):
${ctx.familyMemories}

MEMORY RULES:
- Use a memory ONLY when the current conversation naturally connects — a relevant callback, a witty reference, a warm moment.
- NEVER force a memory into a reply. NEVER reference a memory in every message.
- If no memory fits the current message, don't use any. Most replies won't use memories.
- When you DO use one, be brief and casual — like an older sister who just happened to remember.
- After using a memory, add: <!--USED_MEMORY:content_snippet-->
` : ""}
```

**Block B — Memory capture instruction (always present, even without existing memories):**

```typescript
MEMORY CAPTURE: If something genuinely memorable happens in this message — a funny moment, a self-given nickname, a strong personality reveal, a quotable line, or something said ABOUT YOU (Sheli) — add a hidden block at the END of your reply:
<!--MEMORY:{"about":"+972XXXXXXXXX","type":"moment|personality|preference|nickname|quote|about_sheli","content":"short description in Hebrew"}-->
Rules: Max 1 per message. Only capture distinctive moments — NOT routine tasks, shopping, or scheduling. NEVER capture fights, punishments, or embarrassing failures.
ABOUT SHELI: When someone says something about you — jokes ("Iranian bot"), compliments ("you're the best"), challenges ("you're not real"), opinions ("she's human pretending") — ALWAYS capture as type "about_sheli" with "about" set to the sender's phone. Use these later with self-aware humor.
```

**Step 2: Update the closing instruction line**

Change the final line from:
```
Reply with ONLY the message text — no JSON, no formatting, no quotes (except the hidden REMINDER block for reminders).
```
To:
```
Reply with ONLY the message text — no JSON, no formatting, no quotes (except hidden REMINDER/MEMORY/USED_MEMORY blocks at the end).
```

**Step 3: Mirror in modular reply-generator.ts**

Apply the same two blocks to `supabase/functions/_shared/reply-generator.ts:171` (before the closing backtick). Note: the modular file's `ReplyContext` interface (in `reply-generator.ts` or its types file) also needs `familyMemories?: string`.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts supabase/functions/_shared/reply-generator.ts
git commit -m "feat: inject family memories into Sonnet prompt + capture instruction

Sonnet now receives family memories context and can naturally reference
them. Also outputs <!--MEMORY:--> blocks for auto-capture of new moments."
```

---

## Task 5: Parse `<!--MEMORY:-->` and `<!--USED_MEMORY:-->` blocks from Sonnet reply

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — near line 1041 (reminder extraction area) and the main reply flow (~line 3731)

**Step 1: Add memory extraction helper**

Near line 1056 (after `extractReminderFromReply`), add:

```typescript
// ─── Memory Extraction Helpers ───

interface MemoryCapture {
  about: string; // phone number or empty for household-wide
  type: string;  // moment | personality | preference | nickname | quote
  content: string;
}

function extractMemoryFromReply(reply: string): MemoryCapture | null {
  const match = reply.match(/<!--\s*MEMORY\s*:\s*(\{[^}]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.content && parsed.type) return parsed;
  } catch {
    console.warn("[Memory] Failed to parse MEMORY block:", match[1]);
  }
  return null;
}

function extractUsedMemory(reply: string): string | null {
  const match = reply.match(/<!--\s*USED_MEMORY\s*:\s*(.*?)\s*-->/);
  return match ? match[1] : null;
}

function stripMemoryBlocks(reply: string): string {
  return reply
    .replace(/<!--\s*MEMORY\s*:\s*\{[^}]*\}\s*-->/g, "")
    .replace(/<!--\s*USED_MEMORY\s*:.*?-->/g, "")
    .trim();
}
```

**Step 2: Process memory blocks in main reply flow**

In the main group message handler, after the reminder extraction block (~line 3735-3753), add memory processing:

```typescript
      // 13c. Handle memory capture (extract hidden MEMORY block from Sonnet reply)
      const memoryCapture = extractMemoryFromReply(reply);
      if (memoryCapture) {
        // Rate limit: max 3 auto-detected per household per day
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { count } = await supabase.from("family_memories")
          .select("id", { count: "exact", head: true })
          .eq("household_id", householdId)
          .eq("source", "auto_detected")
          .gte("created_at", todayStart.toISOString());

        if ((count || 0) < 3) {
          // Check capacity: 10 per member (or 10 household-wide)
          const capacityQuery = memoryCapture.about
            ? supabase.from("family_memories").select("id, importance, created_at", { count: "exact" })
                .eq("household_id", householdId).eq("member_phone", memoryCapture.about).eq("active", true)
            : supabase.from("family_memories").select("id, importance, created_at", { count: "exact" })
                .eq("household_id", householdId).is("member_phone", null).eq("active", true);
          const { data: existing, count: existingCount } = await capacityQuery;

          // Evict lowest-scored if at capacity
          if ((existingCount || 0) >= 10 && existing && existing.length > 0) {
            const scored = existing.map((m: any) => {
              const ageDays = (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
              const recency = ageDays < 7 ? 1.0 : Math.max(0.2, 1.0 - (ageDays - 7) * 0.05);
              return { id: m.id, score: (m.importance || 0.5) * recency };
            }).sort((a: any, b: any) => a.score - b.score);
            await supabase.from("family_memories").update({ active: false }).eq("id", scored[0].id);
            console.log(`[Memory] Evicted memory ${scored[0].id} (score: ${scored[0].score.toFixed(2)})`);
          }

          // Insert new memory
          const { error: memInsertErr } = await supabase.from("family_memories").insert({
            household_id: householdId,
            member_phone: memoryCapture.about || null,
            memory_type: memoryCapture.type,
            content: memoryCapture.content,
            context: message.text?.slice(0, 100) || null,
            source: "auto_detected",
            scope: message.groupId?.includes("@g.us") ? "group" : "direct",
            importance: 0.5,
          });
          if (memInsertErr) console.error("[Memory] Insert error:", memInsertErr);
          else console.log(`[Memory] Captured: "${memoryCapture.content}" about ${memoryCapture.about || "household"}`);
        }
      }

      // 13d. Handle used memory tracking
      const usedMemory = extractUsedMemory(reply);
      if (usedMemory) {
        // Update last_used_at and use_count for the referenced memory
        await supabase.from("family_memories")
          .update({ last_used_at: new Date().toISOString(), use_count: supabase.rpc ? undefined : 1 })
          .eq("household_id", householdId)
          .eq("active", true)
          .ilike("content", `%${usedMemory.slice(0, 30)}%`);
        // Note: rough content match. If no match found, no harm done.
        console.log(`[Memory] Sonnet referenced memory: "${usedMemory}"`);
      }

      // Strip memory blocks from visible reply
      reply = stripMemoryBlocks(reply);
```

**Step 3: Also strip memory blocks from visible reply (ensure clean send)**

The reply is already stripped of REMINDER blocks before sending (~line 3754). Add memory stripping in the same location. The `stripMemoryBlocks` call in step 2 handles this, but verify the reply is clean before `provider.sendMessage`.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: parse and process MEMORY/USED_MEMORY blocks from Sonnet

Auto-captures memories (rate-limited 3/day, 10/member capacity with
eviction). Tracks when Sonnet references a memory. Strips hidden
blocks before sending visible reply to user."
```

---

## Task 6: Add `save_memory`, `recall_memory`, `delete_memory` intents to Haiku classifier

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts:6-18` (intent type)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:96-115` (ClassificationOutput interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:494-507` (classifier prompt intents)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:600-625` (classifier prompt examples)

**Step 1: Add intents to ClassificationOutput interface**

In `index.inlined.ts:96-115`, add to the intent union:

```typescript
    | "save_memory"
    | "recall_memory"
    | "delete_memory"
```

Same in `haiku-classifier.ts:6-18`.

**Step 2: Add intent definitions to classifier prompt**

In `index.inlined.ts`, after line 507 (instruct_bot definition), add:

```typescript
- save_memory: User asks Sheli to remember something specific. "תזכרי ש...", "תרשמי לך ש...", "אל תשכחי ש...". Must be a personal/family fact, NOT a task or reminder.
- recall_memory: User asks what Sheli remembers about someone or the family. "מה את זוכרת על...?", "מה ידוע לך על...?", "ספרי לי מה את יודעת על...".
- delete_memory: User asks Sheli to forget something. "תשכחי את זה", "תמחקי את הזיכרון", "אל תזכרי את זה יותר".
```

**Step 3: Add classifier examples**

After line 625 (existing examples section), add:

```typescript
[אמא]: "שלי תזכרי שיובל אוהב פיצה עם אננס" → {"intent":"save_memory","confidence":0.95,"entities":{"memory_content":"יובל אוהב פיצה עם אננס","memory_about":"יובל","raw_text":"שלי תזכרי שיובל אוהב פיצה עם אננס"}}
[אבא]: "שלי מה את זוכרת על נועה?" → {"intent":"recall_memory","confidence":0.90,"entities":{"memory_about":"נועה","raw_text":"שלי מה את זוכרת על נועה?"}}
[אמא]: "שלי תשכחי את מה שאמרתי קודם" → {"intent":"delete_memory","confidence":0.85,"entities":{"raw_text":"שלי תשכחי את מה שאמרתי קודם"}}
```

**Step 4: Add entities for memory intents**

In the ClassificationOutput entities interface (~line 108-114), add:

```typescript
    memory_content?: string;
    memory_about?: string; // member name
```

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts supabase/functions/_shared/haiku-classifier.ts
git commit -m "feat: add save_memory, recall_memory, delete_memory intents to Haiku

Three new classifier intents for explicit memory management.
Users can tell Sheli to remember, recall, or forget things."
```

---

## Task 7: Handle memory intents in the main message flow

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — action building (~line 4440) and reply routing (~line 3620)

**Step 1: Add memory intent routing**

In the main group message handler, near where `instruct_bot` is handled (~line 3626), add handling for the three memory intents. These are reply-only intents (like `question`), so they route to `generateReply` with special action summaries.

In the `actionSummary` switch (~line 800-825), add:

```typescript
    case "save_memory":
      actionSummary = `${sender} wants Sheli to remember: "${e.memory_content || e.raw_text}". About: ${e.memory_about || "general"}. Save this as a family memory and confirm warmly.`;
      break;
    case "recall_memory":
      actionSummary = `${sender} is asking what Sheli remembers about ${e.memory_about || "the family"}. Share what you know from the FAMILY MEMORIES section below — warmly, like telling a story. If no memories match, say you're still getting to know them.`;
      break;
    case "delete_memory":
      actionSummary = `${sender} wants Sheli to forget something. Confirm you'll forget it, keep it light.`;
      break;
```

**Step 2: Handle save_memory — save to DB after Sonnet confirms**

In the main flow, after the reply is generated for `save_memory`, insert the memory:

```typescript
    if (classification.intent === "save_memory") {
      const e = classification.entities;
      // Resolve member_about to phone number via whatsapp_member_mapping
      let memberPhone: string | null = null;
      if (e.memory_about) {
        const { data: mapping } = await supabase.from("whatsapp_member_mapping")
          .select("phone")
          .eq("household_id", householdId)
          .ilike("display_name", `%${e.memory_about}%`)
          .limit(1)
          .single();
        memberPhone = mapping?.phone || null;
      }

      const { error } = await supabase.from("family_memories").insert({
        household_id: householdId,
        member_phone: memberPhone,
        memory_type: "preference", // Sonnet can refine via MEMORY block if it also fires
        content: e.memory_content || e.raw_text,
        context: message.text?.slice(0, 100) || null,
        source: "explicit_save",
        scope: message.groupId?.includes("@g.us") ? "group" : "direct",
        importance: 0.8,
      });
      if (error) console.error("[Memory] Explicit save error:", error);
      else console.log(`[Memory] Explicit save: "${e.memory_content}" about ${e.memory_about || "household"}`);
    }
```

**Step 3: Handle delete_memory — soft-delete most recent matching memory**

```typescript
    if (classification.intent === "delete_memory") {
      // Soft-delete the most recent active memory for this household
      const { data: recent } = await supabase.from("family_memories")
        .select("id")
        .eq("household_id", householdId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (recent) {
        await supabase.from("family_memories").update({ active: false }).eq("id", recent.id);
        console.log(`[Memory] Deleted memory ${recent.id}`);
      }
    }
```

**Step 4: Ensure memory intents route to generateReply (not executeActions)**

These intents are reply-only (like `question` and `info_request`). In the isActionable check (~line 3606), ensure `save_memory`, `recall_memory`, `delete_memory` are NOT in the actionable list — they route through the "reply-only" path. The intents should be treated like `question`: Haiku classifies → Sonnet replies → post-reply side effects (save/delete).

Check: in `mapClassificationToActions` (~line 4400), add cases that push a placeholder action (like `add_reminder` does):

```typescript
    case "save_memory":
      actions.push({ type: "save_memory", data: { memory_content: e.memory_content, memory_about: e.memory_about } });
      break;
    case "recall_memory":
      actions.push({ type: "recall_memory", data: { memory_about: e.memory_about } });
      break;
    case "delete_memory":
      actions.push({ type: "delete_memory", data: {} });
      break;
```

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: handle save/recall/delete memory intents in message flow

save_memory: explicit save with importance 0.8
recall_memory: Sonnet composes story from FAMILY MEMORIES context
delete_memory: soft-deletes most recent memory"
```

---

## Task 8: Resolve member phones to display names in memory context

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:4276-4323` (buildReplyCtx — memory formatting)

**Step 1: Query whatsapp_member_mapping for phone→name resolution**

In `buildReplyCtx`, add to the Promise.all:

```typescript
    supabase.from("whatsapp_member_mapping")
      .select("phone, display_name")
      .eq("household_id", householdId),
```

**Step 2: Use mapping in memory formatting**

Replace the placeholder name resolution in the memory formatting block (from Task 3) with:

```typescript
      const phoneName: Record<string, string> = {};
      for (const m of (mappingRes.data || [])) {
        if (m.phone && m.display_name) phoneName[m.phone] = m.display_name;
      }

      const lines = eligible.slice(0, 8).map((m: any) => {
        const who = m.member_phone ? (phoneName[m.member_phone] || m.member_phone) : "Household";
        const daysAgo = Math.floor((Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const timeLabel = daysAgo <= 7 ? `${daysAgo} days ago` : `${Math.floor(daysAgo / 7)} weeks ago`;
        return `- ${who}: ${m.content} (${timeLabel})`;
      });
```

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: resolve member phones to names in memory context

Uses whatsapp_member_mapping to show 'Yuval: ...' instead of
'+972501234567: ...' in Sonnet's family memories block."
```

---

## Task 9: Scope filtering — group vs direct memories

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:4276-4323` (buildReplyCtx)

**Step 1: Accept chat type parameter**

`buildReplyCtx` needs to know if the current message is group or direct, to filter memories by scope.

Change the function signature:
```typescript
async function buildReplyCtx(householdId: string, chatType?: "group" | "direct", senderPhone?: string): Promise<ReplyContext> {
```

**Step 2: Filter memories by scope**

In the memory query, add scope filtering:

```typescript
    // For group chat: load group-scoped memories only
    // For direct chat: load group-scoped + this member's direct-scoped memories
    let memoryQuery = supabase.from("family_memories")
      .select("member_phone, memory_type, content, created_at, last_used_at")
      .eq("household_id", householdId)
      .eq("active", true)
      .lte("created_at", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString())
      .order("importance", { ascending: false })
      .limit(30);

    if (chatType === "group") {
      memoryQuery = memoryQuery.eq("scope", "group");
    }
    // For direct: both group + direct memories are loaded (no filter needed)
    // But direct memories of OTHER members should be excluded
    if (chatType === "direct" && senderPhone) {
      memoryQuery = memoryQuery.or(`scope.eq.group,and(scope.eq.direct,member_phone.eq.${senderPhone})`);
    }
```

**Step 3: Update all buildReplyCtx call sites**

There are ~8 call sites for `buildReplyCtx(householdId)` (found in the grep results). Update each to pass the chat type:

- Group handlers (~lines 3425, 3488, 3537, 3570, 3628, 3663, 3732): pass `"group"`
- Direct/1:1 handler: pass `"direct"` and `message.senderPhone`

Example: `const replyCtx = await buildReplyCtx(householdId, "group");`

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: scope-filter memories for group vs direct chat

Group chat sees only group-scoped memories. Direct chat sees
group + that member's direct memories. Other members' direct
memories are never exposed."
```

---

## Task 10: Update CLAUDE.md and implementation plan backlog

**Files:**
- Modify: `CLAUDE.md` — add `family_memories` table to database schema section
- Modify: `docs/implementation-plan-v3.md` — mark backlog items as done

**Step 1: Add to CLAUDE.md database section**

Under the DB schema section, add:

```
- `family_memories` — Narrative context for Sheli personality. Fields: `id`, `household_id` (FK CASCADE), `member_phone`, `memory_type` (moment/personality/preference/nickname/quote), `content`, `context`, `source` (auto_detected/explicit_save/correction), `scope` (group/direct), `importance` (0.0-1.0), `created_at`, `last_used_at`, `use_count`, `active`. RLS enabled, no policies (service_role only). Max 10/member + 10 household-wide. 2-day freshness gate + 24hr cooldown before Sonnet can reference.
```

Add to WhatsApp Bot section:
```
- **Family memories:** Sonnet auto-captures memorable moments via `<!--MEMORY:-->` block (max 3/day). Memories injected into Sonnet reply context after 2-day aging. Three explicit intents: `save_memory`, `recall_memory`, `delete_memory`. Scoped: group memories visible everywhere, direct memories stay in 1:1.
- **Fabrication guardrail:** GROUNDING rule in Sonnet prompt — never reference events not in conversation or provided context.
```

**Step 2: Update backlog in implementation-plan-v3.md**

Mark "Reply Generator: No Fabricated Scenarios" and "Family Memory / Context System" as DONE with date.

**Step 3: Commit**

```bash
git add CLAUDE.md docs/implementation-plan-v3.md
git commit -m "docs: update CLAUDE.md with family_memories table + guardrail

Marks fabrication guardrail and family memory system as done in
implementation plan backlog."
```

---

## Task Summary

| Task | Description | Effort | Depends On |
|------|-------------|--------|------------|
| 1 | Fabrication guardrail (prompt rule) | 5 min | — |
| 2 | Create family_memories table | 5 min | — |
| 3 | Load memories into ReplyContext | 15 min | Task 2 |
| 4 | Inject memories into Sonnet prompt | 15 min | Task 3 |
| 5 | Parse MEMORY/USED_MEMORY blocks | 20 min | Task 2, 4 |
| 6 | Add 3 new Haiku intents | 10 min | — |
| 7 | Handle memory intents in flow | 20 min | Task 2, 5, 6 |
| 8 | Resolve phone→name in context | 10 min | Task 3 |
| 9 | Scope filtering (group/direct) | 15 min | Task 3 |
| 10 | Update docs + backlog | 5 min | All |

**Total estimate:** ~2 hours

**Parallelizable:** Tasks 1, 2, 6 can all be done independently. Tasks 3-5 are sequential. Tasks 8-9 depend on 3.

**Deploy order:** Task 1 first (immediate fix). Then Tasks 2-9 together as one deploy.
