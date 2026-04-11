# Family Memory System + Fabrication Guardrail

**Date:** 2026-04-11
**Status:** Approved
**Trigger:** La Familia — Sheli invented a "forgetting milk on Shabbat" jab that confused the family. AMOR declared herself "queen princess" and Sheli should remember it weeks later.

## Part 1: Fabrication Guardrail (deploy immediately)

### Problem

Sonnet reply generator has zero family context — `household_patterns` are only injected into Haiku classifier, not Sonnet. When Sonnet tries to be witty (trolling responses, playful banter), it invents events, habits, and failures that never happened. The La Familia incident: Sheli referenced "forgetting milk on Shabbat" — nobody mentioned milk.

### Fix

One rule added to Sonnet reply generator system prompt, after the trolling/playful section:

> "NEVER reference events, habits, mistakes, or scenarios that aren't explicitly in this conversation, the action results, or the family memories provided. When roasting or joking back, use ONLY what the sender actually said or did. If you have nothing specific to reference, keep it generic and short."

**Where:** `reply-generator.ts` system prompt + mirror in `index.inlined.ts`.

### Why this works

The boundary between "riff on real context" and "invent context" was never explicit. Sonnet optimizes for sounding human — without real material, it fabricates. This rule makes the constraint clear. Once family memories exist (Part 2), Sonnet will have real material to work with, and the guardrail becomes a safety net.

---

## Part 2: Family Memory System

### Vision

Sheli remembers family history — inside jokes, personalities, past moments — and uses them with humor at the RIGHT time, not robotically. Like a real older sister who just happened to remember.

**Example:** AMOR says "call me the queen princess of the house." Three days later, AMOR finishes a hard chore → Sheli: "מלכת הבית סיימה! 👑"

### Decision Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| How are memories created? | Hybrid — auto-detect + explicit save/recall | Auto-capture is the magic ("how did she remember?!"), explicit gives control |
| How are memories used? | Proactive with 2-3 day freshness gate | Old enough to feel like a callback, fresh enough for timely jokes |
| Memory capacity? | A: 10/member + 10 household-wide (evolve to B: 25/member) | Lean for beta, schema supports growth |
| Privacy model? | Member-scoped with group spillover | Group memories available everywhere, 1:1 memories stay private |

---

### Data Model

**New table: `family_memories`**

```sql
CREATE TABLE public.family_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id TEXT NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  member_phone TEXT,              -- who the memory is about (NULL = household-wide)
  memory_type TEXT NOT NULL,      -- moment | personality | preference | nickname | quote
  content TEXT NOT NULL,          -- the memory (~50-150 chars, natural language)
  context TEXT,                   -- what triggered it (~100 chars, conversation snippet)
  source TEXT NOT NULL DEFAULT 'auto_detected',  -- auto_detected | explicit_save | correction
  scope TEXT NOT NULL DEFAULT 'group',           -- group | direct
  importance REAL NOT NULL DEFAULT 0.5,          -- 0.0-1.0
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,      -- updated when Sonnet references it
  use_count INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_family_memories_household ON family_memories(household_id) WHERE active = true;
CREATE INDEX idx_family_memories_member ON family_memories(household_id, member_phone) WHERE active = true;

ALTER TABLE family_memories ENABLE ROW LEVEL SECURITY;
-- RLS: service_role only (bot writes, bot reads for prompt injection)
```

**Memory types:**

| Type | Example | Auto-detect? |
|------|---------|-------------|
| `moment` | "AMOR declared herself queen princess of the house" | Yes |
| `personality` | "Yuval always volunteers for dishes" | Yes |
| `preference` | "Mom hates when people leave lights on" | Yes (rare) |
| `nickname` | "AMOR = queen princess" | Yes |
| `quote` | "Dad: 'I don't burn dinner, I caramelize it'" | Yes |
| `about_sheli` | "Dad called Sheli 'an Iranian bot' as a joke" | Yes |

**IMPORTANT — Memories about Sheli herself:** When family members say things about Sheli — jokes ("Iranian bot"), compliments ("you're the best"), challenges ("you're not real"), opinions ("she's actually human pretending") — these MUST be captured as `about_sheli` type with `member_phone` set to whoever said it. Sheli should remember who said what about her and use it with self-aware humor later. Example: Dad called her "an Iranian bot" → weeks later, Dad asks her something → "רגע, אני צריכה לתרגם מפרסית 😏"

**Capacity rules:**
- 10 memories per member + 10 household-wide = max ~50 for a 4-person family
- When a member hits 10: evict lowest `importance × recency_factor` → `active=false`
- `recency_factor`: 1.0 for <7 days, decays 0.05/day after, floor 0.2
- Memories with `use_count > 0` get +0.2 importance boost (Sonnet actually used them)
- Explicit saves (`importance=0.8`) survive ~3x longer than auto-detected (`importance=0.5`)

**Scope rules:**
- `scope=group` → injected in group chat AND all 1:1 chats
- `scope=direct` → injected ONLY in that member's 1:1 channel

**Relationship to `household_patterns`:** Separate systems, no migration. Patterns = flat operational shortcuts (nicknames→names, time expressions, compound products). Memories = narrative context for personality and humor.

---

### Memory Capture — Three Paths

#### Path 1: Auto-detection (by Sonnet, post-reply)

After generating a reply, Sonnet can output a hidden metadata block:

```
<!--MEMORY:{"about":"+972501234567","type":"moment","content":"הכריזה על עצמה כמלכת הבית","importance":0.6}-->
```

Same pattern as existing `<!--REMINDER:{}-->` and `<!--ACTIONS:...-->` blocks.

**Prompt instruction added to reply generator:**

> "If something memorable happens — a funny moment, a self-given nickname, a strong personality reveal, a quotable line — add a `<!--MEMORY:{}-->` block. Only capture genuinely distinctive moments, NOT routine task completions or shopping. Max 1 memory per message. NEVER save memories about fights, punishments, embarrassing failures, or anything a member might not want remembered."

**Auto-detection triggers (guidance, not hard rules):**
- Self-declarations ("call me...", "I'm the...")
- Running jokes or callbacks the family makes
- Strong emotional moments (celebrations, funny fails owned by the person)
- Repeated personality patterns (always volunteers, always late)
- **Things said about Sheli** — jokes ("Iranian bot"), compliments ("you're the best"), challenges ("you're not real"), opinions ("she's human pretending"). These are `about_sheli` type. Sheli should remember who said what about her and use it with self-aware humor later.

**NOT captured:** routine actions, task completions, shopping lists, scheduling, fights, punishments.

**Rate limit:** Max 3 auto-detected memories per household per day. Prevents noise from chatty families.

#### Path 2: Explicit save

New Haiku intent: `save_memory`

**Triggers:**
- "שלי תזכרי ש..."
- "שלי תרשמי לך ש..."
- "שלי אל תשכחי ש..."

Routes to Sonnet → extracts memory → saves with `source=explicit_save`, `importance=0.8`.

#### Path 3: Recall

New Haiku intent: `recall_memory`

**Triggers:**
- "שלי מה את זוכרת על...?"
- "שלי מה ידוע לך על...?"

Sonnet receives that member's memories and composes a warm, natural summary — like telling a story, not dumping a database.

#### Path 4: Delete

New Haiku intent: `delete_memory`

**Triggers:**
- "שלי תשכחי את זה"
- "שלי תמחקי את הזיכרון"

Soft-deletes most recent memory (or by context match). `active=false`.

---

### Memory Injection — How Sonnet Uses Memories

**Current flow (no family context to Sonnet):**
```
Haiku classifies → Sonnet generates reply (blind to family)
```

**New flow:**
```
Haiku classifies (with household_patterns)
  → if reply needed: query family_memories
  → filter: active=true, created_at <= now()-2days, scope matches chat type
  → exclude: last_used_at within 24 hours (cooldown)
  → format as context block
  → inject into Sonnet reply generator
  → Sonnet replies (+ optional <!--MEMORY:--> capture)
```

**Context block format:**

```
FAMILY MEMORIES (use naturally, not robotically — only when genuinely relevant):
- AMOR (אמור): declared herself "queen princess of the house" (3 days ago)
- AMOR: always dramatic when asked to help with dishes
- Yuval (יובל): volunteers for everything, family calls him "the hero"
- Household: Dad's "caramelizing" excuse for burnt food is a running joke
```

**Prompt rules:**

> "You have family memories below. Use them ONLY when the current conversation naturally connects — a relevant callback, a witty reference, a warm moment. NEVER force a memory into a reply. NEVER reference a memory in every message. If no memory fits, don't use any. When you DO use one, it should feel like an older sister who just happened to remember — brief, casual, not announcing it."

**Freshness gate:**
- Memories < 2 days old: NOT injected (too fresh = parroting)
- Memories ≥ 2 days old: eligible
- `last_used_at` within 24 hours: skipped (prevents repetition)

**Token budget:** ~200-300 tokens. At 10/member for 4-person household, max 50 memories, but ~5-8 pass filters per message.

**After Sonnet replies:** Parse `<!--MEMORY:-->` block if present. Check daily rate limit (3/household). Upsert to `family_memories`. If member at capacity, run eviction.

**When Sonnet uses a memory:** Parse which memory was referenced (by content match or explicit `<!--USED_MEMORY:id-->` tag). Update `last_used_at=now()`, `use_count += 1`.

---

### Edge Cases

| Case | Handling |
|------|----------|
| Conflicting memories (queen one week, boss next) | Both stored, Sonnet picks. Old one evicts naturally. |
| Sensitive content (fights, punishments) | Prompt excludes. Auto-detect only captures positive/funny/neutral. |
| 1:1 privacy (Dad planning surprise party) | `scope=direct`, only in Dad's 1:1 context. Never group. |
| Empty memories (new household) | No memories block injected. Sonnet behaves as today + guardrail. |
| Memory about non-member | `member_phone=NULL`, stored as household-wide. |
| Family asks "what do you remember?" in group | `recall_memory` intent → Sonnet composes group-safe summary (skips direct-scoped). |

---

### Cost Impact

| Component | Cost per message |
|-----------|-----------------|
| Memory query (Supabase) | ~0ms (indexed, <50 rows) |
| Sonnet prompt tokens (+200-300) | ~$0.001 |
| Memory parse + upsert (3/day max) | Negligible |
| **Total delta** | **~$0.001/message** (~10% increase over current $0.01) |

---

### Success Metrics

- **Fabrication incidents → 0** after guardrail deploy (Part 1)
- **Memory capture rate:** 1-3 auto-detected per active household per day
- **Memory usage rate:** Sonnet references a memory in ~5-10% of replies (not more)
- **User delight:** Families react positively to callbacks (measure via reply sentiment)
- **No complaints about privacy leaks** between group/1:1

---

### Non-Goals (YAGNI)

- No semantic/embedding search (overkill for 10-50 memories)
- No cross-household memory sharing
- No memory editing UI in web app (future)
- No Stream A global learning from memories (future)
- No memory export/download
