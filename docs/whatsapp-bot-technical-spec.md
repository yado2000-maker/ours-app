# Ours WhatsApp Bot -- Technical Specification

**Version:** 1.0
**Date:** March 29, 2026
**Status:** Draft -- Implementation-Ready
**Author:** Product & Engineering

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Message Flow](#2-message-flow)
3. [AI Classification Prompt](#3-ai-classification-prompt)
4. [Proactive Features](#4-proactive-features)
5. [Database Schema Additions](#5-database-schema-additions)
6. [API Integration Layer](#6-api-integration-layer)
7. [Rate Limiting & Cost Control](#7-rate-limiting--cost-control)
8. [Privacy & Security](#8-privacy--security)
9. [Onboarding Flow](#9-onboarding-flow)
10. [Migration Path](#10-migration-path)
11. [Error Handling](#11-error-handling)
12. [Cost Model](#12-cost-model)

---

## 1. System Architecture

### High-Level Architecture

```
+---------------------------+         +---------------------------+
|     WhatsApp Users        |         |      Web App (PWA)        |
|  (family group members)   |         |   React 19 + Vite on      |
|                           |         |   Vercel                  |
+----------+----------------+         +----------+----------------+
           |                                      |
           | Messages                             | REST / Realtime
           v                                      v
+----------+----------------+         +----------+----------------+
|  WhatsApp Cloud API       |         |                           |
|  (Meta or Whapi.Cloud)    |         |                           |
+----------+----------------+         |                           |
           |                          |      Supabase             |
           | Webhook POST             |      PostgreSQL           |
           v                          |      + Edge Functions     |
+----------+----------------+         |      + Realtime           |
|  Supabase Edge Function   |         |      + pg_cron            |
|  /whatsapp-webhook        +-------->+                           |
|                           |         |  Tables:                  |
|  1. Validate signature    |         |  - households_v2          |
|  2. Parse message         |         |  - tasks                  |
|  3. Batch & classify (AI) |         |  - events                 |
|  4. Execute actions       |         |  - shopping_items         |
|  5. Send response         |         |  - messages               |
|  6. Log & meter           |         |  - whatsapp_config  [NEW] |
+----------+----------------+         |  - whatsapp_messages[NEW] |
           |                          |  - reminder_queue   [NEW] |
           | Send reply               |  - ai_usage               |
           v                          |  - subscriptions          |
+----------+----------------+         +---------------------------+
|  WhatsApp Cloud API       |                    ^
|  (outbound message)       |                    |
+----------+----------------+         +----------+----------------+
           |                          |  Supabase pg_cron         |
           v                          |  (scheduled jobs)         |
+----------+----------------+         |                           |
|  Family WhatsApp Group    |         |  - Morning briefing       |
|                           |         |  - Event reminders        |
+---------------------------+         |  - End-of-day summary     |
                                      |  - Weekly report          |
                                      |  - Stale task nudges      |
                                      +---------------------------+
```

### Data Flow Diagram

```
WhatsApp Group ──webhook──> Edge Function: /whatsapp-webhook
                                 |
                                 +-- validate signature (HMAC-SHA256)
                                 +-- extract sender phone, message text, group_id
                                 +-- lookup household by group_id
                                 |
                                 +-- Message Batcher (30s window)
                                 |       collect messages from same group
                                 |       flush when window expires or 5 msgs
                                 |
                                 +-- AI Classifier (Claude Sonnet 4)
                                 |       input: batched messages + household context
                                 |       output: { respond: bool, actions: [...], reply: "..." }
                                 |
                                 +-- Action Executor
                                 |       INSERT into tasks / events / shopping_items
                                 |       UPDATE existing records
                                 |       DELETE completed items
                                 |
                                 +-- Response Sender
                                 |       POST /messages via WhatsApp API
                                 |       (only if respond=true)
                                 |
                                 +-- Logging & Metering
                                         INSERT into whatsapp_messages (raw log)
                                         UPDATE ai_usage (increment counter)

Web App (PWA) ──Realtime subscription──> Supabase
                                 |
                                 +-- tasks / events / shopping_items changes
                                 +-- renders dashboard in real-time
                                 +-- user edits sync back to same tables
                                 +-- WhatsApp bot sees changes on next AI call
```

### Component Ownership

| Component | Technology | Hosting | Purpose |
|-----------|-----------|---------|---------|
| Webhook Handler | Supabase Edge Function (Deno) | Supabase | Receive & validate WhatsApp webhooks |
| AI Classifier | Claude Sonnet 4 (Anthropic API) | Called from Edge Function | Classify messages, generate replies |
| Action Executor | Supabase Edge Function (Deno) | Supabase | Write to DB tables |
| Response Sender | Supabase Edge Function (Deno) | Supabase | Send WhatsApp replies via provider |
| Scheduled Jobs | Supabase pg_cron + Edge Functions | Supabase | Proactive messages (briefings, reminders) |
| Web Dashboard | React 19 + Vite | Vercel | Settings, history, premium management |
| Message Batcher | Supabase Edge Function (in-memory + DB) | Supabase | Group nearby messages before AI call |

---

## 2. Message Flow

### Step-by-Step: Incoming Message

**Step 1: Webhook Delivery**

WhatsApp (Meta or Whapi.Cloud) sends an HTTP POST to our registered webhook URL.

```
POST https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook
Content-Type: application/json
X-Hub-Signature-256: sha256=<hmac_signature>    # Meta Cloud API
# OR
Authorization: Bearer <webhook_token>            # Whapi.Cloud
```

**Step 2: Edge Function Validation**

```typescript
// supabase/functions/whatsapp-webhook/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

serve(async (req: Request) => {
  // 1. Verify webhook signature
  const provider = Deno.env.get("WHATSAPP_PROVIDER"); // "meta" | "whapi"
  const isValid = await verifySignature(req, provider);
  if (!isValid) return new Response("Unauthorized", { status: 401 });

  // 2. Normalize payload (abstracts Meta vs Whapi format)
  const message = normalizeIncoming(await req.json(), provider);
  if (!message || message.type === "status_update") {
    return new Response("OK", { status: 200 }); // Acknowledge non-message events
  }

  // 3. Skip non-text messages early (photos, stickers, voice notes)
  if (!["text", "interactive"].includes(message.type)) {
    await logMessage(message, "skipped_non_text");
    return new Response("OK", { status: 200 });
  }

  // 4. Look up household by WhatsApp group ID
  const config = await getWhatsAppConfig(message.groupId);
  if (!config || !config.bot_active) {
    return new Response("OK", { status: 200 }); // Bot not active for this group
  }

  // 5. Enqueue for batching
  await enqueueBatchMessage(config.household_id, message);

  return new Response("OK", { status: 200 });
});
```

**Step 3: Message Batching**

To avoid responding to every individual message in a rapid conversation, messages are batched.

```
Message arrives → INSERT into whatsapp_message_buffer
                  → Set/reset 30-second timer for that group

Timer fires → Collect all buffered messages for group
            → Delete from buffer
            → Send batch to AI Classifier
```

Implementation options (in order of preference):
- **Option A: Database-based batching** -- Insert into `whatsapp_message_buffer` table. A pg_cron job runs every 10 seconds, finds groups with messages older than 30s, and processes them.
- **Option B: Edge Function with Deno.setTimeout** -- Hold the connection and wait (not recommended; Edge Functions have a 150s timeout and this wastes compute).

Recommended: **Option A** with a 10-second cron sweep.

```sql
-- pg_cron job: every 10 seconds
SELECT cron.schedule('process-message-buffer', '10 seconds',
  $$SELECT net.http_post(
    url := 'https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/process-message-batch',
    headers := '{"Authorization": "Bearer <service_role_key>"}'::jsonb
  )$$
);
```

**Step 4: AI Classification**

The batch processor calls Claude Sonnet 4 with the collected messages plus household context.

```typescript
// Build context: household members, recent tasks, upcoming events, shopping list
const context = await buildHouseholdContext(householdId);
const prompt = buildWhatsAppClassifierPrompt(context, batchedMessages);

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": Deno.env.get("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  }),
});
```

AI returns structured JSON:

```json
{
  "respond": true,
  "reply": "סבבה, הוספתי 'חלב' ו'ביצים' לרשימה והזכרתי ליונתן על ההסעה",
  "actions": [
    {
      "type": "add_shopping",
      "items": [
        { "name": "חלב", "qty": "1", "category": "חלב וביצים" },
        { "name": "ביצים", "qty": "1", "category": "חלב וביצים" }
      ]
    },
    {
      "type": "add_event",
      "title": "הסעה ליונתן",
      "assigned_to": "יונתן",
      "scheduled_for": "2026-03-30T07:30:00+03:00"
    }
  ]
}
```

**Step 5: Action Execution**

Each action in the array maps to a Supabase operation:

| Action Type | DB Operation |
|-------------|-------------|
| `add_task` | INSERT into `tasks` |
| `complete_task` | UPDATE `tasks` SET done=true, completed_by, completed_at |
| `add_shopping` | INSERT into `shopping_items` (one per item) |
| `mark_shopping_done` | UPDATE `shopping_items` SET got=true |
| `add_event` | INSERT into `events` |
| `update_event` | UPDATE `events` SET scheduled_for, assigned_to |
| `no_action` | Skip (social/noise message) |

**Step 6: Send Response to WhatsApp**

Only if `respond: true`. The reply text is sent back to the same group.

```typescript
await whatsappProvider.sendGroupMessage(groupId, reply);
```

**Step 7: Web App Sees Updates**

The web app has active Supabase Realtime subscriptions on `tasks`, `events`, and `shopping_items`. Changes appear within milliseconds. No polling required.

```javascript
// Already in the web app
supabase
  .channel("household-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "tasks",
    filter: `household_id=eq.${householdId}` }, handleTaskChange)
  .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items",
    filter: `household_id=eq.${householdId}` }, handleShoppingChange)
  .on("postgres_changes", { event: "*", schema: "public", table: "events",
    filter: `household_id=eq.${householdId}` }, handleEventChange)
  .subscribe();
```

---

## 3. AI Classification Prompt

### System Prompt for WhatsApp Classifier

This prompt differs fundamentally from the web app chat prompt (`src/lib/prompt.js`). The web app prompt receives a user conversation and always responds. The WhatsApp prompt receives individual messages from a group and must decide whether to respond at all.

```typescript
const buildWhatsAppClassifierPrompt = (
  household: HouseholdContext,
  messages: BatchedMessage[]
) => {
  const isHe = household.lang === "he";

  const today = new Date();
  const israelTZ = "Asia/Jerusalem";
  const localTime = today.toLocaleString("he-IL", { timeZone: israelTZ });

  // Build day mapping (same as existing prompt.js)
  const hebrewDayNames = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const name = hebrewDayNames[d.getDay()];
    return `${name} = ${iso}${i === 0 ? " (היום)" : ""}`;
  }).join(", ");

  const system = `You are Ours — an AI family assistant that lives inside the ${household.name} WhatsApp group.
You passively read all group messages and ONLY respond when there is something actionable.

${isHe ? `LANGUAGE: Always respond in Hebrew.
TONE: Warm, brief, helpful. Like a reliable family member who keeps things organized.
- Use natural Hebrew — not formal, not robotic.
- Occasional slang is fine when it fits ("סבבה", "אחלה") but keep it natural.
- Use gender-neutral plural ("תוסיפו", "בדקו").
- Short sentences. No filler. No emojis unless the family uses them.
- Never sound like a customer service bot. Sound like a person.` : `LANGUAGE: English.
TONE: Warm, brief, helpful. Like a reliable family member.`}

MEMBERS: ${household.members.map(m => `${m.display_name} (phone: ${m.phone || "unknown"})`).join(", ")}
TODAY: ${today.toISOString().slice(0, 10)} (${hebrewDayNames[today.getDay()]})
LOCAL TIME: ${localTime}
UPCOMING DAYS: ${upcomingDays}

HEBREW DAY MAPPING (memorize exactly):
יום ראשון = Sunday, יום שני = Monday, יום שלישי = Tuesday,
יום רביעי = Wednesday, יום חמישי = Thursday, יום שישי = Friday, שבת = Saturday

CURRENT TASKS:
${household.tasks.length === 0 ? "(none)" :
  household.tasks.map(t =>
    `- [${t.done ? "done" : "open"}] ${t.title}${t.assigned_to ? ` -> ${t.assigned_to}` : ""}`
  ).join("\n")}

UPCOMING EVENTS (next 7 days):
${household.events.length === 0 ? "(none)" :
  household.events.map(e =>
    `- ${e.title}${e.assigned_to ? ` -> ${e.assigned_to}` : ""} @ ${e.scheduled_for}`
  ).join("\n")}

SHOPPING LIST:
${household.shopping.length === 0 ? "(empty)" :
  household.shopping.map(s =>
    `- [${s.got ? "got" : "need"}] ${s.name}${s.qty ? ` x${s.qty}` : ""} [${s.category}]`
  ).join("\n")}

DECISION RULES — when to respond:
1. ACTIONABLE messages: someone mentions a task, chore, shopping item, event, appointment,
   deadline, reminder, or asks about the household schedule. -> RESPOND with action.
2. DIRECT QUESTIONS about household state: "What do we need from the store?",
   "When is the dentist?" -> RESPOND with info.
3. SOCIAL / NOISE messages: greetings, memes, jokes, photos, "LOL", family gossip,
   forwarded messages, stickers, voice notes. -> DO NOT RESPOND. Set respond=false.
4. AMBIGUOUS: if unsure, DO NOT RESPOND. False silence is better than false action.

CRITICAL RULES:
- You see multiple messages at once (batched). Read ALL of them before deciding.
- If the same person corrects themselves ("wait, not milk, I meant cheese"),
  use the corrected version.
- If two people conflict ("buy milk" / "we already have milk"), note the conflict
  in your reply and ask for clarification.
- Never respond to forwarded messages or media-only messages.
- Never create duplicate tasks/items. Check existing lists first.
- Never remove items unless someone explicitly says to.
- Resolve relative dates using today's date.
- Use ISO 8601 with Israel timezone offset (+02:00 or +03:00 for DST).

${isHe ? `SHOPPING CATEGORIES (use exact names):
פירות וירקות, חלב וביצים, בשר ודגים, מאפים, מזווה, מוצרים קפואים, משקאות, ניקוי ובית, מוצרים מחנות הטבע, אחר` :
`SHOPPING CATEGORIES: Produce, Dairy, Meat, Bakery, Pantry, Frozen, Drinks, Household, Health Store, Other`}

RESPOND ONLY as this exact JSON — no markdown, no extra text:
{
  "respond": true/false,
  "reply": "Hebrew text to send to the group (empty string if respond=false)",
  "actions": [
    // Zero or more action objects. Types:
    // { "type": "add_task", "title": "...", "assigned_to": "name or null" }
    // { "type": "complete_task", "title_match": "partial title to match" }
    // { "type": "add_shopping", "items": [{"name":"...","qty":"...","category":"..."}] }
    // { "type": "mark_shopping_done", "name_match": "partial name to match" }
    // { "type": "add_event", "title": "...", "assigned_to": "name or null", "scheduled_for": "ISO 8601" }
    // { "type": "update_event", "title_match": "...", "scheduled_for": "new ISO 8601" }
  ]
}`;

  const userContent = messages
    .map(m => `[${m.timestamp}] ${m.senderName}: ${m.text}`)
    .join("\n");

  return { system, user: userContent };
};
```

### Key Differences from Web App Prompt

| Aspect | Web App (prompt.js) | WhatsApp Bot |
|--------|-------------------|--------------|
| Input | Single user message in a conversation | Batch of group messages from multiple senders |
| Response decision | Always responds | Decides whether to respond (most messages are noise) |
| Output format | `{message, tasks, shopping, events}` | `{respond, reply, actions}` with action types |
| ID generation | 4-char alphanumeric in prompt | Server generates IDs after AI decides |
| Context window | Full conversation history | Only current batch + household state |
| Personality | Conversational chat assistant | Brief group participant (much shorter replies) |

---

## 4. Proactive Features

### 4.1 Morning Briefing

**Trigger:** pg_cron job at configurable time per household (default: 07:30 IST)

**Content:**
```
[Hebrew example]
בוקר טוב משפחת כהן!

📋 היום:
- חוג פסנתר של נועה ב-16:00
- תורן לשטוף כלים: אבא

🛒 רשימת קניות (4 פריטים):
חלב, ביצים, לחם, גבינה צהובה

✅ משימות פתוחות:
- לקבוע תור לרופא שיניים (ממתין מאז יום שני)

יום טוב!
```

**Database query:**
```sql
-- Find households needing morning briefing NOW
SELECT wc.household_id, wc.whatsapp_group_id, wc.briefing_time, h.name, h.lang
FROM whatsapp_config wc
JOIN households_v2 h ON h.id = wc.household_id
WHERE wc.bot_active = true
  AND wc.morning_briefing_enabled = true
  AND wc.briefing_time = date_trunc('minute', NOW() AT TIME ZONE 'Asia/Jerusalem')::time
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_messages wm
    WHERE wm.household_id = wc.household_id
      AND wm.message_type = 'morning_briefing'
      AND wm.created_at::date = CURRENT_DATE
  );
```

**pg_cron schedule:** Run every minute between 06:00-10:00 IST to catch all configured briefing times.

### 4.2 Smart Reminders

**Trigger:** 15 minutes before any event with a `scheduled_for` in the next 24 hours.

**Logic:**
```sql
-- Find events needing reminders
SELECT e.*, wc.whatsapp_group_id
FROM events e
JOIN whatsapp_config wc ON wc.household_id = e.household_id
LEFT JOIN reminder_queue rq ON rq.source_type = 'event' AND rq.source_id = e.id
WHERE e.scheduled_for BETWEEN NOW() + interval '14 minutes'
                       AND NOW() + interval '16 minutes'
  AND rq.id IS NULL  -- not already reminded
  AND wc.bot_active = true;
```

**Message format:**
```
תזכורת: חוג פסנתר של נועה בעוד 15 דקות (16:00)
```

**pg_cron schedule:** Every minute, all day.

### 4.3 End-of-Day Summary

**Trigger:** Configurable time (default: 21:00 IST), only sent if there was activity that day.

**Content:**
```
סיכום יומי - יום שלישי:

✅ הושלמו היום:
- לשטוף כלים (אבא)
- לקנות חלב (אמא)

⏳ עדיין פתוח:
- לקבוע תור רופא שיניים

🛒 נקנו 3 מתוך 5 פריטים ברשימה

מחר: חוג כדורגל של יונתן ב-17:00
```

**Condition:** Only send if at least one task was completed, shopping item was bought, or event occurred today. Do not send empty summaries.

### 4.4 Shopping Completion Detection

**Trigger:** When a family member marks 80%+ of shopping items as `got=true` within a 30-minute window.

**Message:**
```
נראה שסיימתם את הקניות! נשאר ברשימה:
- אבקת כביסה
- סבון כלים

לנקות את הרשימה?
```

**Implementation:** A Supabase database trigger on `shopping_items` updates. When `got` changes to `true`, check if threshold is met.

### 4.5 Unassigned Task Nudges

**Trigger:** Once daily at 12:00 IST, if there are tasks older than 48 hours without an `assigned_to`.

**Message:**
```
יש 2 משימות שעדיין לא שויכו לאף אחד:
- לקבוע תור רופא שיניים (נוצר לפני 3 ימים)
- להחליף נורה במטבח (נוצר אתמול)

מי לוקח?
```

**Rate limit:** Maximum one nudge per household per day. Do not nudge for tasks created in the last 24 hours.

### 4.6 Weekly Household Report (Premium)

**Trigger:** Every Friday at 14:00 IST (before Shabbat for Israeli families).

**Content:**
```
📊 סיכום שבועי - משפחת כהן

משימות: 12 הושלמו, 3 פתוחות
אירועים: 8 התקיימו השבוע
קניות: 23 פריטים נקנו

🏆 הכי פעילים השבוע:
1. אמא - 7 משימות
2. אבא - 3 משימות
3. נועה - 2 משימות

שבוע הבא: 4 אירועים מתוכננים

שבת שלום!
```

**Gate:** `subscriptions.plan IN ('premium', 'family_plus')`.

---

## 5. Database Schema Additions

### 5.1 New Table: `whatsapp_config`

Stores WhatsApp integration settings per household.

```sql
CREATE TABLE public.whatsapp_config (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  household_id TEXT NOT NULL REFERENCES public.households_v2(id) ON DELETE CASCADE,
  whatsapp_group_id TEXT NOT NULL,          -- WhatsApp group JID (e.g., "120363012345@g.us")
  bot_phone_number TEXT NOT NULL,           -- Ours bot phone number (e.g., "+972501234567")
  provider TEXT NOT NULL DEFAULT 'whapi'    -- 'whapi' | 'meta'
    CHECK (provider IN ('whapi', 'meta')),
  bot_active BOOLEAN NOT NULL DEFAULT true,

  -- Proactive feature toggles
  morning_briefing_enabled BOOLEAN NOT NULL DEFAULT true,
  briefing_time TIME NOT NULL DEFAULT '07:30',  -- Local Israel time
  evening_summary_enabled BOOLEAN NOT NULL DEFAULT true,
  summary_time TIME NOT NULL DEFAULT '21:00',
  smart_reminders_enabled BOOLEAN NOT NULL DEFAULT true,
  reminder_minutes_before INT NOT NULL DEFAULT 15,
  task_nudges_enabled BOOLEAN NOT NULL DEFAULT true,
  weekly_report_enabled BOOLEAN NOT NULL DEFAULT false,  -- Premium only

  -- Onboarding state
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ,                    -- When bot was added to group

  -- Provider-specific
  webhook_secret TEXT,                      -- For verifying incoming webhooks

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_household_whatsapp UNIQUE (household_id),
  CONSTRAINT unique_group_id UNIQUE (whatsapp_group_id)
);

-- Index for webhook lookup (hot path)
CREATE INDEX idx_whatsapp_config_group_id ON whatsapp_config(whatsapp_group_id);

-- Index for scheduled job queries
CREATE INDEX idx_whatsapp_config_briefing ON whatsapp_config(briefing_time)
  WHERE bot_active = true AND morning_briefing_enabled = true;

-- RLS
ALTER TABLE whatsapp_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own household config"
  ON whatsapp_config FOR SELECT
  USING (household_id IN (
    SELECT household_id FROM household_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "Founders can update config"
  ON whatsapp_config FOR UPDATE
  USING (household_id IN (
    SELECT household_id FROM household_members
    WHERE user_id = auth.uid() AND role = 'founder'
  ));
```

### 5.2 New Table: `whatsapp_messages`

Raw message log for context and debugging. Messages older than 30 days are automatically purged.

```sql
CREATE TABLE public.whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  household_id TEXT NOT NULL REFERENCES public.households_v2(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT,                 -- Provider's message ID
  group_id TEXT NOT NULL,                   -- WhatsApp group JID
  sender_phone TEXT NOT NULL,               -- Sender's phone number
  sender_name TEXT,                         -- Sender's WhatsApp display name
  message_type TEXT NOT NULL DEFAULT 'incoming'
    CHECK (message_type IN (
      'incoming',           -- User message received
      'outgoing',           -- Bot reply sent
      'morning_briefing',   -- Proactive: morning briefing
      'evening_summary',    -- Proactive: evening summary
      'reminder',           -- Proactive: event reminder
      'nudge',              -- Proactive: task nudge
      'weekly_report',      -- Proactive: weekly report
      'onboarding',         -- Onboarding messages
      'error'               -- Error notifications
    )),
  content_type TEXT NOT NULL DEFAULT 'text'
    CHECK (content_type IN ('text', 'image', 'video', 'audio', 'document',
                            'sticker', 'location', 'contact', 'interactive')),
  body TEXT,                                -- Message text content (NULL for media)
  media_url TEXT,                           -- URL for media messages (not stored long-term)

  -- AI processing metadata
  ai_classified BOOLEAN NOT NULL DEFAULT false,
  ai_classification JSONB,                  -- { respond: bool, actions: [...] }
  ai_latency_ms INT,                        -- Time taken for AI classification
  ai_tokens_used INT,                       -- Token count for cost tracking

  -- Batching
  batch_id UUID,                            -- Links messages processed together

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for household message history (used by AI for context)
CREATE INDEX idx_whatsapp_messages_household
  ON whatsapp_messages(household_id, created_at DESC);

-- Index for batch processing
CREATE INDEX idx_whatsapp_messages_batch
  ON whatsapp_messages(batch_id) WHERE batch_id IS NOT NULL;

-- Auto-purge messages older than 30 days (privacy)
SELECT cron.schedule('purge-old-whatsapp-messages', '0 3 * * *',
  $$DELETE FROM whatsapp_messages WHERE created_at < NOW() - interval '30 days'$$
);

-- RLS
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own household messages"
  ON whatsapp_messages FOR SELECT
  USING (household_id IN (
    SELECT household_id FROM household_members WHERE user_id = auth.uid()
  ));
```

### 5.3 New Table: `whatsapp_message_buffer`

Temporary buffer for message batching. Messages sit here for up to 30 seconds before being processed.

```sql
CREATE TABLE public.whatsapp_message_buffer (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  household_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  sender_name TEXT,
  body TEXT NOT NULL,
  whatsapp_message_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for batch sweep
CREATE INDEX idx_buffer_group_received
  ON whatsapp_message_buffer(group_id, received_at);

-- No RLS needed -- only accessed by service role from Edge Functions
```

### 5.4 New Table: `reminder_queue`

Tracks which reminders have been sent to prevent duplicates.

```sql
CREATE TABLE public.reminder_queue (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  household_id TEXT NOT NULL REFERENCES public.households_v2(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('event', 'task', 'shopping')),
  source_id TEXT NOT NULL,                  -- ID of the event/task/shopping_item
  reminder_type TEXT NOT NULL CHECK (reminder_type IN (
    'pre_event',       -- 15 min before event
    'morning',         -- Morning briefing inclusion
    'nudge',           -- Unassigned task nudge
    'shopping_done'    -- Shopping completion
  )),
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,                      -- NULL = not yet sent
  whatsapp_message_id TEXT,                 -- Provider message ID after sending
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reminder_queue_pending
  ON reminder_queue(scheduled_for) WHERE sent_at IS NULL;

CREATE UNIQUE INDEX idx_reminder_unique
  ON reminder_queue(source_type, source_id, reminder_type, scheduled_for::date);
```

### 5.5 New Table: `whatsapp_member_mapping`

Maps WhatsApp phone numbers to household members for sender identification.

```sql
CREATE TABLE public.whatsapp_member_mapping (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  household_id TEXT NOT NULL REFERENCES public.households_v2(id) ON DELETE CASCADE,
  household_member_id UUID NOT NULL REFERENCES public.household_members(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,               -- E.164 format: "+972501234567"
  whatsapp_display_name TEXT,               -- Last known WhatsApp name
  verified BOOLEAN NOT NULL DEFAULT false,  -- Confirmed by household founder
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_phone_household UNIQUE (household_id, phone_number)
);
```

### 5.6 Column Addition to Existing Table: `household_members`

```sql
ALTER TABLE public.household_members
  ADD COLUMN phone TEXT;  -- E.164 format, used for WhatsApp identity matching
```

### 5.7 Column Addition to Existing Table: `ai_usage`

```sql
ALTER TABLE public.ai_usage
  ADD COLUMN whatsapp_messages_in INT NOT NULL DEFAULT 0,   -- Incoming messages received
  ADD COLUMN whatsapp_messages_out INT NOT NULL DEFAULT 0,  -- Outgoing messages sent
  ADD COLUMN whatsapp_ai_calls INT NOT NULL DEFAULT 0,      -- Claude API calls
  ADD COLUMN whatsapp_tokens_used INT NOT NULL DEFAULT 0;   -- Total tokens consumed
```

---

## 6. API Integration Layer

### 6.1 Provider Abstraction

A common interface that both Whapi.Cloud and Meta Cloud API implement. This is the key to making the migration seamless.

```typescript
// supabase/functions/_shared/whatsapp-provider.ts

export interface WhatsAppMessage {
  messageId: string;
  groupId: string;          // Group JID
  senderPhone: string;      // E.164 format
  senderName: string;       // Display name
  timestamp: string;        // ISO 8601
  type: "text" | "image" | "video" | "audio" | "document" | "sticker"
        | "location" | "contact" | "interactive";
  text?: string;            // For text messages
  mediaUrl?: string;        // For media messages
  isForwarded: boolean;
  isFromMe: boolean;        // Sent by the bot itself
}

export interface WhatsAppProvider {
  name: "whapi" | "meta";

  // Inbound: normalize webhook payload to common format
  parseWebhook(body: unknown): WhatsAppMessage | null;

  // Inbound: verify webhook signature
  verifySignature(request: Request): Promise<boolean>;

  // Outbound: send text message to group
  sendGroupMessage(groupId: string, text: string): Promise<string>;  // returns messageId

  // Outbound: send message with quick reply buttons
  sendInteractiveMessage(
    groupId: string,
    text: string,
    buttons: { id: string; title: string }[]
  ): Promise<string>;

  // Management: get group info (members, name)
  getGroupInfo(groupId: string): Promise<GroupInfo>;
}

export interface GroupInfo {
  id: string;
  name: string;
  participants: { phone: string; name: string; isAdmin: boolean }[];
}
```

### 6.2 Whapi.Cloud Implementation

```typescript
// supabase/functions/_shared/providers/whapi.ts

const WHAPI_BASE = "https://gate.whapi.cloud";

export class WhapiProvider implements WhatsAppProvider {
  name = "whapi" as const;
  private token: string;
  private webhookSecret: string;

  constructor() {
    this.token = Deno.env.get("WHAPI_API_TOKEN")!;
    this.webhookSecret = Deno.env.get("WHAPI_WEBHOOK_SECRET")!;
  }

  parseWebhook(body: any): WhatsAppMessage | null {
    // Whapi.Cloud webhook format
    // See: https://whapi.readme.io/reference/webhooks
    const msg = body?.messages?.[0];
    if (!msg) return null;

    return {
      messageId: msg.id,
      groupId: msg.chat_id,                        // "120363012345@g.us"
      senderPhone: msg.from.split("@")[0],          // "972501234567"
      senderName: msg.from_name || "Unknown",
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      type: msg.type,                               // "text", "image", etc.
      text: msg.text?.body || msg.body,
      mediaUrl: msg.image?.link || msg.video?.link || msg.document?.link,
      isForwarded: !!msg.forwarded,
      isFromMe: msg.from_me || false,
    };
  }

  async verifySignature(request: Request): Promise<boolean> {
    // Whapi uses a simple bearer token for webhook auth
    const authHeader = request.headers.get("authorization");
    return authHeader === `Bearer ${this.webhookSecret}`;
  }

  async sendGroupMessage(groupId: string, text: string): Promise<string> {
    const res = await fetch(`${WHAPI_BASE}/messages/text`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: groupId,                    // "120363012345@g.us"
        body: text,
      }),
    });
    const data = await res.json();
    return data.sent?.id || data.message_id || "";
  }

  async sendInteractiveMessage(
    groupId: string,
    text: string,
    buttons: { id: string; title: string }[]
  ): Promise<string> {
    // Whapi supports interactive buttons via the buttons endpoint
    const res = await fetch(`${WHAPI_BASE}/messages/interactive`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: groupId,
        type: "button",
        body: { text },
        action: {
          buttons: buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      }),
    });
    const data = await res.json();
    return data.sent?.id || "";
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo> {
    const res = await fetch(`${WHAPI_BASE}/groups/${groupId}`, {
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    const data = await res.json();
    return {
      id: data.id,
      name: data.subject || data.name || "Unknown Group",
      participants: (data.participants || []).map((p: any) => ({
        phone: p.id.split("@")[0],
        name: p.name || "",
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      })),
    };
  }
}
```

### 6.3 Meta Cloud API Implementation

```typescript
// supabase/functions/_shared/providers/meta.ts

const META_GRAPH_URL = "https://graph.facebook.com/v21.0";

export class MetaProvider implements WhatsAppProvider {
  name = "meta" as const;
  private accessToken: string;
  private phoneNumberId: string;
  private appSecret: string;

  constructor() {
    this.accessToken = Deno.env.get("META_WHATSAPP_TOKEN")!;
    this.phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID")!;
    this.appSecret = Deno.env.get("META_APP_SECRET")!;
  }

  parseWebhook(body: any): WhatsAppMessage | null {
    // Meta Cloud API webhook format
    // See: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return null;

    const contact = value?.contacts?.[0];

    return {
      messageId: msg.id,
      groupId: msg.group_id || msg.from,     // Group JID for group messages
      senderPhone: msg.from,                  // "972501234567"
      senderName: contact?.profile?.name || "Unknown",
      timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
      type: msg.type,
      text: msg.text?.body,
      mediaUrl: msg.image?.id || msg.video?.id || msg.document?.id,  // Media IDs, need separate fetch
      isForwarded: msg.context?.forwarded || false,
      isFromMe: false,  // Meta doesn't send our own messages back
    };
  }

  async verifySignature(request: Request): Promise<boolean> {
    // Meta uses HMAC-SHA256 signature
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) return false;

    const body = await request.clone().text();
    const key = new TextEncoder().encode(this.appSecret);
    const data = new TextEncoder().encode(body);

    const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const computed = "sha256=" + Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, "0")).join("");

    return signature === computed;
  }

  async sendGroupMessage(groupId: string, text: string): Promise<string> {
    const res = await fetch(
      `${META_GRAPH_URL}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "group",
          to: groupId,
          type: "text",
          text: { body: text },
        }),
      }
    );
    const data = await res.json();
    return data.messages?.[0]?.id || "";
  }

  async sendInteractiveMessage(
    groupId: string,
    text: string,
    buttons: { id: string; title: string }[]
  ): Promise<string> {
    const res = await fetch(
      `${META_GRAPH_URL}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "group",
          to: groupId,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text },
            action: {
              buttons: buttons.map(b => ({
                type: "reply",
                reply: { id: b.id, title: b.title },
              })),
            },
          },
        }),
      }
    );
    const data = await res.json();
    return data.messages?.[0]?.id || "";
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo> {
    // Meta Cloud API group info endpoint
    const res = await fetch(
      `${META_GRAPH_URL}/${this.phoneNumberId}/groups/${groupId}`,
      {
        headers: { "Authorization": `Bearer ${this.accessToken}` },
      }
    );
    const data = await res.json();
    return {
      id: groupId,
      name: data.subject || "Unknown Group",
      participants: (data.participants || []).map((p: any) => ({
        phone: p.phone_number,
        name: p.display_name || "",
        isAdmin: p.admin || false,
      })),
    };
  }
}
```

### 6.4 Provider Factory

```typescript
// supabase/functions/_shared/whatsapp-factory.ts

import { WhapiProvider } from "./providers/whapi.ts";
import { MetaProvider } from "./providers/meta.ts";
import type { WhatsAppProvider } from "./whatsapp-provider.ts";

export function getProvider(providerName?: string): WhatsAppProvider {
  const name = providerName || Deno.env.get("WHATSAPP_PROVIDER") || "whapi";

  switch (name) {
    case "whapi":
      return new WhapiProvider();
    case "meta":
      return new MetaProvider();
    default:
      throw new Error(`Unknown WhatsApp provider: ${name}`);
  }
}
```

### 6.5 Migration Compatibility

When migrating from Whapi to Meta, the only changes needed:

1. Update `whatsapp_config.provider` from `'whapi'` to `'meta'` per household.
2. Set new environment variables (`META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`).
3. Register the same webhook URL with Meta instead of Whapi.
4. Group JID format may differ -- test and add a normalization layer if needed.

The `WhatsAppProvider` interface ensures all business logic, AI classification, and database operations remain identical.

---

## 7. Rate Limiting & Cost Control

### 7.1 Claude API Rate Limiting

```typescript
// Per-household rate limiting

const RATE_LIMITS = {
  free: {
    max_ai_calls_per_day: 20,        // ~20 actionable message batches
    max_ai_calls_per_minute: 3,      // Burst protection
    max_tokens_per_day: 50_000,      // ~50 medium responses
  },
  premium: {
    max_ai_calls_per_day: 100,
    max_ai_calls_per_minute: 10,
    max_tokens_per_day: 200_000,
  },
  family_plus: {
    max_ai_calls_per_day: 300,
    max_ai_calls_per_minute: 20,
    max_tokens_per_day: 500_000,
  },
};
```

**Implementation:** Before each AI call, check and increment counters in `ai_usage`:

```typescript
async function checkRateLimit(householdId: string, plan: string): Promise<boolean> {
  const limits = RATE_LIMITS[plan] || RATE_LIMITS.free;

  // Daily limit check
  const { data: usage } = await supabase
    .from("ai_usage")
    .select("whatsapp_ai_calls, whatsapp_tokens_used")
    .eq("household_id", householdId)
    .eq("usage_date", new Date().toISOString().slice(0, 10))
    .single();

  if (usage && usage.whatsapp_ai_calls >= limits.max_ai_calls_per_day) {
    return false; // Rate limited
  }

  return true;
}
```

When rate limited, the bot silently stops responding (no error message to the group -- that would be spammy).

### 7.2 Message Batching Strategy

```
Timeline:
  t=0s   Message A arrives → buffer, start 30s timer
  t=5s   Message B arrives → buffer, timer continues
  t=12s  Message C arrives → buffer, timer continues
  t=30s  Timer fires → process batch [A, B, C] as one AI call

  OR (burst mode):
  t=0s   Message A arrives → buffer, start 30s timer
  t=1s   Message B arrives → buffer
  t=2s   Message C arrives → buffer
  t=3s   Message D arrives → buffer
  t=4s   Message E arrives → 5 messages reached, process immediately
```

**Rules:**
- Minimum batch window: 30 seconds (configurable down to 10s for premium).
- Maximum batch size: 5 messages (triggers immediate processing).
- Maximum batch window: 120 seconds (safety valve).

### 7.3 Social Message Filtering

Messages are filtered BEFORE AI classification to save API costs:

```typescript
function shouldSkipMessage(message: WhatsAppMessage): boolean {
  // Skip non-text entirely
  if (!["text", "interactive"].includes(message.type)) return true;

  // Skip forwarded messages
  if (message.isForwarded) return true;

  // Skip messages from the bot itself
  if (message.isFromMe) return true;

  // Skip very short social messages (< 3 chars)
  if (message.text && message.text.trim().length < 3) return true;

  // Skip common social-only patterns
  const socialPatterns = [
    /^(lol|haha|😂|👍|❤️|🙏|ok|אוקי|הה+|לול|😊|🤣|👌)+$/i,
    /^https?:\/\/(www\.)?(youtube|tiktok|instagram|facebook)\./i,  // Social media links
  ];
  if (message.text && socialPatterns.some(p => p.test(message.text!.trim()))) return true;

  return false;
}
```

**Estimated savings:** 60-70% of group messages are social/noise. Filtering saves ~$0.01-0.03 per skipped AI call.

### 7.4 Monthly Usage Tracking

```sql
-- Monthly usage view for billing/dashboard
CREATE OR REPLACE VIEW whatsapp_monthly_usage AS
SELECT
  household_id,
  date_trunc('month', usage_date) AS month,
  SUM(whatsapp_messages_in) AS total_messages_in,
  SUM(whatsapp_messages_out) AS total_messages_out,
  SUM(whatsapp_ai_calls) AS total_ai_calls,
  SUM(whatsapp_tokens_used) AS total_tokens,
  ROUND(SUM(whatsapp_tokens_used) * 0.000003, 4) AS estimated_ai_cost_usd  -- Sonnet 4 pricing
FROM ai_usage
GROUP BY household_id, date_trunc('month', usage_date);
```

---

## 8. Privacy & Security

### 8.1 Data Classification

| Data | Stored | Retention | Encryption |
|------|--------|-----------|------------|
| Message text (actionable) | Yes, in `whatsapp_messages` | 30 days | At rest (Supabase default AES-256) |
| Message text (social/skipped) | No | Discarded immediately | N/A |
| Media (photos, videos, voice) | Not stored | Never downloaded | N/A |
| Phone numbers | Yes, in `whatsapp_member_mapping` | Until household deletion | At rest |
| AI classifications | Yes, in `whatsapp_messages.ai_classification` | 30 days | At rest |
| Tasks/events/shopping | Yes, in core tables | Until user deletes | At rest |
| Sender names | Yes, in message log | 30 days | At rest |

### 8.2 Encryption

- **At rest:** Supabase PostgreSQL uses AES-256 encryption for data at rest (enabled by default on all Supabase projects).
- **In transit:** All connections use TLS 1.2+. Edge Functions communicate with the database over encrypted internal connections.
- **API keys:** Stored as Supabase Edge Function secrets (Deno.env), never committed to code.
- **Phone numbers:** Stored in E.164 format. Not exposed to the web app frontend -- the frontend shows display names only, never phone numbers.

### 8.3 GDPR & Israeli Privacy Law (PPPA) Compliance

**Israeli Protection of Privacy Law (1981) and GDPR requirements:**

1. **Lawful basis:** Legitimate interest (providing requested family management service) + explicit consent at onboarding.
2. **Data minimization:** Only actionable message text is stored. Social messages, media, forwarded content are discarded immediately.
3. **Right to access:** Users can view all stored data via the web app dashboard.
4. **Right to deletion:** Household founder can trigger full data deletion (see section 8.5).
5. **Data retention:** 30-day automatic purge on message logs. Core data (tasks/events/shopping) retained until user deletes.
6. **Notification:** Privacy policy link sent during onboarding flow.
7. **Database registration:** If >10,000 users, register with the Israeli Privacy Protection Authority (PPA) database registry.

### 8.4 Consent Flow

When the bot joins a WhatsApp group, the first message it sends is a consent/introduction message:

```
שלום! אני Ours, העוזר המשפחתי שלכם.

אני אקרא את ההודעות בקבוצה ואזהה אוטומטית משימות, קניות ואירועים.

מה חשוב לדעת:
- אני לא שומר תמונות, סרטונים או הודעות מועברות
- הודעות טקסט נשמרות 30 יום ואז נמחקות
- אפשר לכבות אותי בכל רגע דרך האפליקציה

על ידי השארתי בקבוצה, אתם מסכימים לתנאי השימוש ומדיניות הפרטיות:
https://ours.co.il/privacy

כדי להתחיל, מי המבוגרים בקבוצה? (תגידו לי שמות ואני אלמד להכיר)
```

**Opt-out:** Any household member can say "כבה את הבוט" / "turn off bot" in the group. The bot confirms and deactivates. Reactivation requires the household founder to toggle in the web app.

### 8.5 Data Deletion

When a household resets or deletes their account:

```sql
-- Cascade delete all WhatsApp data
-- (ON DELETE CASCADE handles most tables)

-- Explicitly purge message buffer and logs
DELETE FROM whatsapp_message_buffer WHERE household_id = $1;
DELETE FROM whatsapp_messages WHERE household_id = $1;
DELETE FROM reminder_queue WHERE household_id = $1;
DELETE FROM whatsapp_member_mapping WHERE household_id = $1;
DELETE FROM whatsapp_config WHERE household_id = $1;

-- Core tables cascade from households_v2 FK
DELETE FROM households_v2 WHERE id = $1;
```

### 8.6 Security Measures

- **Webhook signature verification** on every incoming request (HMAC-SHA256 for Meta, bearer token for Whapi).
- **Supabase RLS** on all tables -- users can only access their own household data.
- **Service role key** used only in Edge Functions, never exposed to the client.
- **No PII in logs** -- Edge Function logs do not contain message content, only household IDs and processing metadata.
- **Rate limiting** prevents abuse (see section 7).
- **Input sanitization** -- all message text is sanitized before database insertion to prevent SQL injection (parameterized queries via Supabase client).

---

## 9. Onboarding Flow

### Step-by-Step

```
STEP 1: Web App Signup
  User creates account on ours.co.il
  → Creates auth.users row
  → Creates profiles row
  → Creates households_v2 row
  → Creates household_members row (role: founder)

STEP 2: "Add Ours to WhatsApp" button on dashboard
  User clicks → web app shows instruction screen:
  "Add this number to your family WhatsApp group:"
  [+972-50-XXX-XXXX]  (the Ours bot number)
  [Copy Number]

  Instructions:
  1. Open your family WhatsApp group
  2. Tap group name → Add participants
  3. Paste the Ours number
  4. Come back here and tap "I added Ours"

STEP 3: User adds bot to WhatsApp group
  User manually adds the Ours phone number to their group.
  (WhatsApp requires adding as a contact first)

STEP 4: User confirms in web app
  User taps "I added Ours to the group"
  → Web app calls Edge Function: POST /functions/v1/whatsapp-verify-group
  → Edge Function calls provider.getGroupInfo() for all groups the bot is in
  → Finds the new group (not yet in whatsapp_config)
  → Returns group name and member list to web app

STEP 5: Web app shows confirmation
  "Found your group: 'משפחת כהן'
   Members: אבא, אמא, נועה, יונתן

   Is this the right group?"
  [Yes, activate!] [No, different group]

STEP 6: Activation
  User confirms → web app calls Edge Function: POST /functions/v1/whatsapp-activate
  → Creates whatsapp_config row
  → Creates whatsapp_member_mapping rows (best-effort from WhatsApp names)
  → Bot sends introduction message to the group (see section 8.4)
  → Sets onboarding_complete = true

STEP 7: Bot introduction in group
  Bot sends the consent/introduction message.
  Bot asks who the family members are.
  Family responds naturally in the group.
  Bot uses AI to match WhatsApp participants to household members.

STEP 8: Preferences (optional, in group or web app)
  Family can set:
  - Briefing time (default 07:30)
  - Summary time (default 21:00)
  - Toggle features on/off
  Via web app settings page OR by telling the bot in WhatsApp:
  "שנה תזכורת בוקר ל-8:00" → bot updates briefing_time
```

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Bot is added to multiple groups by same household | Only the first activated group is used. Web app shows warning. |
| Bot is added to a group by someone without an Ours account | Bot sends a message: "I need to be activated first. Visit ours.co.il to set up your household." |
| Group has >8 members (Meta limit) | Works fine with Whapi. For Meta, handled by Meta's own limits. |
| Bot is removed from the group | Webhook stops arriving. Daily health check detects and marks `bot_active = false`. Web app shows "Bot disconnected" banner. |
| Family wants to switch groups | Deactivate current group in web app settings, add bot to new group, re-activate. |

---

## 10. Migration Path

### Phase A: Sandbox Prototype (Week 1-2)

**Provider:** Whapi.Cloud free sandbox
**Cost:** $0
**Scope:** Internal testing only (developer family)

| What | Details |
|------|---------|
| WhatsApp number | Sandbox number from Whapi.Cloud |
| Group limit | 1 group |
| Features | Incoming message parsing, AI classification, basic replies |
| Database | Full schema deployed to Supabase dev branch |
| AI | Claude Sonnet 4, real API calls |
| Web app | Local development, not deployed |

**Deliverables:**
- Working webhook handler
- AI classifier prompt tuned on real Hebrew family messages
- Provider abstraction layer built
- Message batching logic validated

**What stays the same after this phase:** Database schema, AI prompt, provider interface, all Edge Function business logic.

### Phase B: Paid Beta (Month 1-3)

**Provider:** Whapi.Cloud paid plan ($29/mo annual or $35/mo monthly)
**Cost:** $29-35/mo fixed (no per-message fees)
**Scope:** First 50-100 families (beta cohort)

| What | Details |
|------|---------|
| WhatsApp number | Dedicated Israel number registered with Whapi |
| Group limit | Unlimited (Whapi has no group cap on paid plans) |
| Features | Full feature set: batching, proactive messages, reminders |
| Database | Production Supabase |
| AI | Claude Sonnet 4 with rate limiting |
| Web app | Deployed on Vercel, settings page for WhatsApp preferences |

**New compared to Phase A:**
- Proactive features (morning briefing, reminders, summaries)
- WhatsApp settings page in web app
- Usage tracking and rate limiting
- Privacy consent flow
- Error handling and retry logic

**Scaling concern:** Whapi.Cloud uses unofficial WhatsApp Web API. Risk of number ban if message volume is too high or if WhatsApp detects automation. Mitigation: keep message frequency reasonable (~5-10 outgoing messages per group per day).

### Phase C: Official Meta Cloud API (Month 3-6)

**Provider:** Meta Cloud API (Official Business Account)
**Cost:** ~$0-2/mo per active family (service messages are free within 24h window)
**Scope:** General availability

**Requirements to reach Phase C:**
1. Register a Meta Business Account
2. Apply for Official Business Account (OBA) -- green checkmark
3. Pass Meta's business verification
4. Apply for WhatsApp Groups API access (available since Oct 2025)
5. Acquire a dedicated phone number for WhatsApp Business API
6. Set up Meta webhooks pointing to the same Supabase Edge Function

**What changes:**
| Component | Phase B (Whapi) | Phase C (Meta) |
|-----------|----------------|----------------|
| Webhook signature | Bearer token | HMAC-SHA256 |
| Webhook payload | Whapi format | Meta Graph API format |
| Outbound API | `gate.whapi.cloud/messages/text` | `graph.facebook.com/v21.0/{phone_id}/messages` |
| Group JID format | Same | Potentially different -- normalize |
| Interactive messages | Whapi format | Meta interactive format |
| Provider env var | `WHAPI_API_TOKEN` | `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET` |

**What stays the same:**
- All database schema
- AI classifier prompt and logic
- Message batching strategy
- Proactive features (pg_cron jobs)
- Web app frontend
- Provider interface contract
- Rate limiting logic
- Privacy and security measures

**Migration procedure:**
1. Deploy `MetaProvider` implementation (already written, see section 6.3).
2. Set Meta environment variables on Supabase Edge Functions.
3. Register webhook URL with Meta.
4. For each household, update `whatsapp_config.provider = 'meta'` (can be done in batches).
5. Monitor for 48 hours per batch before proceeding.
6. Decommission Whapi.Cloud subscription once all households are migrated.

---

## 11. Error Handling

### 11.1 Claude API Down

**Detection:** HTTP 5xx or timeout (>30s) from `api.anthropic.com`.

**Handling:**
```typescript
async function classifyWithRetry(prompt, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        { /* ... */ },
        30_000 // 30s timeout
      );
      if (response.ok) return await response.json();

      if (response.status === 529) {
        // API overloaded -- back off
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (response.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      // 4xx errors: don't retry (bad request, auth, etc.)
      throw new Error(`Claude API error: ${response.status}`);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}
```

**Fallback:** If all retries fail:
1. Log the failure to `whatsapp_messages` with `ai_classification: { error: "api_unavailable" }`.
2. Store messages in buffer for retry on next batch cycle (up to 5 minutes).
3. If still failing after 5 minutes, silently drop. Do NOT send error messages to the WhatsApp group.
4. Alert the operations team via a separate monitoring channel (Telegram or Slack webhook).

### 11.2 WhatsApp API Down

**Detection:** HTTP 5xx or timeout from Whapi.Cloud / Meta Graph API on outbound sends.

**Handling:**
```typescript
async function sendWithRetry(groupId, text, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messageId = await provider.sendGroupMessage(groupId, text);
      return messageId;
    } catch (err) {
      if (attempt === maxRetries) {
        // Store in dead letter queue
        await supabase.from("reminder_queue").insert({
          household_id: householdId,
          source_type: "message_retry",
          source_id: crypto.randomUUID(),
          reminder_type: "pre_event",  // reuse type
          scheduled_for: new Date(Date.now() + 300_000).toISOString(), // retry in 5 min
        });
        return null;
      }
      await sleep(3000 * (attempt + 1));
    }
  }
}
```

**Impact:** Database actions (creating tasks, events, shopping items) still succeed even if the WhatsApp reply fails. The web app will show the updates. Only the WhatsApp confirmation is delayed.

### 11.3 Message Parse Failure

**Detection:** AI returns invalid JSON or missing required fields.

**Handling:**
```typescript
function parseAIResponse(raw: string): ClassificationResult {
  try {
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (typeof parsed.respond !== "boolean") throw new Error("Missing 'respond'");
    if (parsed.respond && typeof parsed.reply !== "string") throw new Error("Missing 'reply'");
    if (!Array.isArray(parsed.actions)) throw new Error("Missing 'actions'");

    // Validate each action
    for (const action of parsed.actions) {
      if (!VALID_ACTION_TYPES.includes(action.type)) {
        throw new Error(`Invalid action type: ${action.type}`);
      }
    }

    return parsed;
  } catch (err) {
    // Log the parse failure
    console.error("AI response parse failed:", err.message, "Raw:", raw.slice(0, 500));

    // Return safe default: don't respond, no actions
    return { respond: false, reply: "", actions: [] };
  }
}
```

**Key principle:** Parse failures are silent. The family never sees an error message.

### 11.4 Dead Letter Queue

Failed outbound messages and retryable operations are stored in `reminder_queue` with a future `scheduled_for` time. The pg_cron job that processes reminders also picks up these retries.

```sql
-- Retry sweep: every 5 minutes
SELECT cron.schedule('retry-failed-sends', '*/5 * * * *',
  $$SELECT net.http_post(
    url := 'https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/process-retry-queue',
    headers := '{"Authorization": "Bearer <service_role_key>"}'::jsonb
  )$$
);
```

### 11.5 Monitoring & Alerting

```typescript
// Health check endpoint
// GET /functions/v1/whatsapp-health

serve(async (req) => {
  const checks = {
    database: await checkDatabaseConnection(),
    ai_api: await checkAnthropicHealth(),
    whatsapp_api: await checkWhatsAppHealth(),
    buffer_size: await getBufferSize(),      // Alert if > 100 messages stuck
    failed_sends_24h: await getFailedSendCount(),
  };

  const healthy = Object.values(checks).every(c => c.status === "ok");

  return new Response(JSON.stringify(checks), {
    status: healthy ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
});
```

---

## 12. Cost Model

### 12.1 Per-Household Cost Assumptions

| Metric | Estimate |
|--------|----------|
| Messages per group per day | ~50-100 |
| Actionable messages (after filtering) | ~10-20 (20% of total) |
| Batches per day (after 30s batching) | ~5-10 |
| AI calls per day | ~5-10 |
| Avg tokens per AI call | ~800 input + 200 output |
| Proactive messages per day | ~3-5 (briefing + reminders + summary) |
| AI calls for proactive features | ~3-5 per day |
| Total AI calls per household per day | ~8-15 |

### 12.2 Unit Costs

| Service | Unit | Cost |
|---------|------|------|
| Claude Sonnet 4 - input tokens | 1M tokens | $3.00 |
| Claude Sonnet 4 - output tokens | 1M tokens | $15.00 |
| Whapi.Cloud | Per month (flat) | $29.00 |
| Meta Cloud API - service messages | Per message (within 24h window) | $0.00 |
| Meta Cloud API - utility template | Per message (outside window) | $0.004-0.02 |
| Supabase Free tier | Per month | $0.00 |
| Supabase Pro | Per month | $25.00 |
| Vercel Hobby | Per month | $0.00 |
| Vercel Pro | Per month | $20.00 |

**Claude cost per household per day:**
- Input: 10 calls x 800 tokens = 8,000 tokens = $0.024
- Output: 10 calls x 200 tokens = 2,000 tokens = $0.030
- Total: ~$0.054/day = ~$1.62/month per household

### 12.3 Cost at Scale

| Households | WhatsApp API/mo | Claude AI/mo | Supabase/mo | Vercel/mo | Total/mo | Cost/household |
|------------|----------------|-------------|-------------|-----------|----------|----------------|
| **10** | $29 (Whapi) | $16 | $0 (free) | $0 (free) | **$45** | $4.50 |
| **100** | $29 (Whapi) | $162 | $25 (Pro) | $0 (free) | **$216** | $2.16 |
| **500** | $29 (Whapi) | $810 | $25 (Pro) | $20 (Pro) | **$884** | $1.77 |
| **1,000** | $0 (Meta) | $1,620 | $25 (Pro) | $20 (Pro) | **$1,665** | $1.67 |
| **5,000** | $0 (Meta) | $8,100 | $75 (Pro+) | $20 (Pro) | **$8,195** | $1.64 |
| **10,000** | $50 (Meta templates) | $16,200 | $150 (custom) | $20 (Pro) | **$16,420** | $1.64 |

Notes:
- Whapi.Cloud flat fee covers up to ~500 households easily (one WhatsApp number handles thousands of groups).
- Meta Cloud API is effectively free for active groups (24h service window stays open with regular group activity).
- Meta template messages ($0.004-0.02 each) only needed for proactive messages when the 24h window has closed (rare in active family groups).
- Supabase free tier supports ~500 concurrent connections and 500MB database. Pro needed at ~50-100 households.

### 12.4 Revenue Model

| Plan | Price/mo | Included |
|------|----------|----------|
| Free | $0 | 20 AI interactions/day, basic briefing, 1 group |
| Premium | 14.90 ILS (~$4/mo) | 100 AI interactions/day, all proactive features, priority AI |
| Family Plus | 29.90 ILS (~$8/mo) | 300 AI interactions/day, weekly reports, multiple groups, API access |

### 12.5 Break-Even Analysis

| Scale | Monthly Cost | Monthly Revenue (30% premium conversion) | Profit/Loss |
|-------|-------------|----------------------------------------|-------------|
| 10 households | $45 | $12 (3 premium x $4) | **-$33** |
| 50 households | $132 | $60 (15 premium x $4) | **-$72** |
| 100 households | $216 | $120 (30 premium x $4) | **-$96** |
| 250 households | $475 | $300 (75 premium x $4) | **-$175** |
| 500 households | $884 | $600 (150 premium x $4) | **-$284** |
| 1,000 households | $1,665 | $1,200 (300 premium x $4) | **-$465** |
| 2,500 households | $4,135 | $3,000 (750 premium x $4) | **-$1,135** |
| 5,000 households | $8,195 | $6,000 (1,500 premium x $4) | **-$2,195** |

**At 30% premium conversion and $4/mo price, the product does not break even.**

**Path to profitability (options):**
1. **Increase premium conversion to 50%** -- break-even at ~5,000 households.
2. **Raise price to 24.90 ILS (~$7/mo)** -- break-even at ~2,000 households with 30% conversion.
3. **Reduce Claude cost** -- use prompt caching (50% discount on cached tokens), implement local classification for simple messages, switch to Claude Haiku 3.5 for simple classifications (~10x cheaper) and Sonnet only for complex multi-action batches.
4. **Combined:** Haiku for 70% of calls + Sonnet for 30% = ~$0.50/household/mo. Break-even at ~800 households with 30% conversion at $4/mo.

**Recommended cost optimization strategy:**
```
Message arrives
  → Pre-filter (free): skip media, stickers, very short messages
  → Simple classifier (Haiku 3.5, ~$0.10/day/household):
      "Is this actionable? Yes/No"
  → If actionable → Full classifier (Sonnet 4, ~$0.054/call):
      Extract tasks, events, shopping, generate reply
```

This two-tier approach reduces the Sonnet call volume by ~70%, bringing per-household AI cost to ~$0.50/month and break-even to ~800 households.

---

## Appendix A: Environment Variables

```bash
# WhatsApp Provider (Phase B: Whapi)
WHATSAPP_PROVIDER=whapi
WHAPI_API_TOKEN=<from Whapi.Cloud dashboard>
WHAPI_WEBHOOK_SECRET=<set during webhook registration>

# WhatsApp Provider (Phase C: Meta)
# WHATSAPP_PROVIDER=meta
# META_WHATSAPP_TOKEN=<from Meta Business Suite>
# META_PHONE_NUMBER_ID=<from Meta WhatsApp Business settings>
# META_APP_SECRET=<from Meta App Dashboard>
# META_VERIFY_TOKEN=<set during webhook registration>

# AI
ANTHROPIC_API_KEY=<from Anthropic Console>

# Supabase (Edge Function has these by default)
SUPABASE_URL=https://wzwwtghtnkapdwlgnrxr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard>

# Monitoring (optional)
ALERT_WEBHOOK_URL=<Telegram bot or Slack webhook for ops alerts>
```

## Appendix B: pg_cron Job Summary

| Job | Schedule | Function Called |
|-----|----------|----------------|
| `process-message-buffer` | Every 10 seconds | `/functions/v1/process-message-batch` |
| `morning-briefing` | Every minute, 06:00-10:00 IST | `/functions/v1/proactive-briefing` |
| `event-reminders` | Every minute | `/functions/v1/proactive-reminders` |
| `evening-summary` | Every minute, 20:00-23:00 IST | `/functions/v1/proactive-summary` |
| `task-nudges` | Daily at 12:00 IST | `/functions/v1/proactive-nudges` |
| `weekly-report` | Fridays at 14:00 IST | `/functions/v1/proactive-weekly-report` |
| `retry-failed-sends` | Every 5 minutes | `/functions/v1/process-retry-queue` |
| `purge-old-messages` | Daily at 03:00 IST | SQL: DELETE old whatsapp_messages |

## Appendix C: Edge Function Inventory

| Function | Trigger | Purpose |
|----------|---------|---------|
| `whatsapp-webhook` | HTTP POST (WhatsApp webhook) | Receive, validate, buffer incoming messages |
| `process-message-batch` | pg_cron (10s) | Flush buffer, classify with AI, execute actions, send replies |
| `whatsapp-verify-group` | HTTP POST (web app) | During onboarding: find which group the bot was added to |
| `whatsapp-activate` | HTTP POST (web app) | Activate bot for a household's group |
| `proactive-briefing` | pg_cron (1m) | Send morning briefings |
| `proactive-reminders` | pg_cron (1m) | Send event reminders |
| `proactive-summary` | pg_cron (1m) | Send end-of-day summaries |
| `proactive-nudges` | pg_cron (daily) | Send unassigned task nudges |
| `proactive-weekly-report` | pg_cron (weekly) | Send premium weekly reports |
| `process-retry-queue` | pg_cron (5m) | Retry failed outbound messages |
| `whatsapp-health` | HTTP GET (monitoring) | Health check endpoint |
