# Reminders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let families set reminders via WhatsApp ("תזכירי לי ב-4 לאסוף את הילדים") that fire as group messages at the specified time.

**Architecture:** Haiku classifies `add_reminder` intent → Sonnet extracts time + text → INSERT into `reminder_queue` → pg_cron fires every minute, checks for due reminders, sends via Whapi HTTP, marks sent.

**Tech Stack:** Supabase pg_cron + pg_net extensions, existing Haiku/Sonnet pipeline, Whapi API, reminder_queue table (already exists).

---

### Task 1: DB Setup — Enable Extensions + Add Column

**Files:**
- Modify: Supabase DB via SQL migration

**Step 1: Enable pg_cron and pg_net**

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
```

**Step 2: Add created_by columns to reminder_queue**

```sql
ALTER TABLE reminder_queue
ADD COLUMN IF NOT EXISTS created_by_phone TEXT,
ADD COLUMN IF NOT EXISTS created_by_name TEXT;
```

**Step 3: Create index for the cron query**

```sql
CREATE INDEX IF NOT EXISTS idx_reminder_queue_pending
ON reminder_queue (send_at)
WHERE sent = false;
```

---

### Task 2: Create pg_cron Job — Fire Due Reminders

**Files:**
- Modify: Supabase DB via SQL migration

**Step 1: Create the cron function that fires reminders**

This function runs every minute. It finds unsent reminders where `send_at <= now()`, sends each one via Whapi HTTP POST (using pg_net), and marks them sent.

```sql
CREATE OR REPLACE FUNCTION fire_due_reminders()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  whapi_token TEXT;
  request_id BIGINT;
BEGIN
  -- Get Whapi token from vault or hardcode for now
  whapi_token := current_setting('app.whapi_token', true);
  IF whapi_token IS NULL OR whapi_token = '' THEN
    RAISE NOTICE 'No whapi_token configured, skipping';
    RETURN;
  END IF;

  FOR r IN
    SELECT id, group_id, message_text, created_by_name, send_at
    FROM reminder_queue
    WHERE sent = false
      AND send_at <= now()
      AND send_at > now() - INTERVAL '24 hours'  -- skip stale reminders
    ORDER BY send_at ASC
    LIMIT 10  -- process max 10 per minute
  LOOP
    -- Send via Whapi using pg_net
    SELECT net.http_post(
      url := 'https://gate.whapi.cloud/messages/text',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || whapi_token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'to', r.group_id,
        'body', '⏰ תזכורת: ' || r.message_text ||
          CASE WHEN r.created_by_name IS NOT NULL
            THEN ' (נוצרה ע"י ' || r.created_by_name || ')'
            ELSE '' END
      )
    ) INTO request_id;

    -- Mark as sent
    UPDATE reminder_queue
    SET sent = true, sent_at = now()
    WHERE id = r.id;

    RAISE NOTICE 'Fired reminder % to group %', r.id, r.group_id;
  END LOOP;
END;
$$;
```

**Step 2: Schedule the cron job**

```sql
SELECT cron.schedule(
  'fire-reminders',
  '* * * * *',  -- every minute
  $$SELECT fire_due_reminders()$$
);
```

**Step 3: Set the Whapi token as a DB config**

```sql
ALTER DATABASE postgres SET app.whapi_token = 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
```

---

### Task 3: Add `add_reminder` Intent to Haiku Classifier

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add `add_reminder` to the ClassificationOutput interface (line ~74)**

Add `"add_reminder"` to the intent union type.

**Step 2: Add intent description to the classifier prompt (line ~456)**

After the `correct_bot` intent, add:
```
- add_reminder: Setting a reminder for a future time. "תזכירי לי ב-4", "תזכרו אותי מחר", "בעוד שעה תזכירי", "remind me at 5".
```

**Step 3: Add example to the EXAMPLES section (line ~532)**

```
[אמא]: "תזכירי לי ב-4 לאסוף את הילדים" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לאסוף את הילדים","time_raw":"ב-4","raw_text":"תזכירי לי ב-4 לאסוף את הילדים"}}
[אבא]: "בעוד שעה תזכירי לקחת את הכביסה" → {"intent":"add_reminder","confidence":0.95,"entities":{"reminder_text":"לקחת את הכביסה","time_raw":"בעוד שעה","raw_text":"בעוד שעה תזכירי לקחת את הכביסה"}}
```

**Step 4: Add Hebrew patterns hint**

In the HEBREW PATTERNS section, add:
```
- "תזכירי", "תזכיר", "תזכרו", "remind" = add_reminder (NOT add_task, NOT add_event)
```

---

### Task 4: Add Reminder Handling to Sonnet Reply Generator

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add reminder case to `buildReplyPrompt` (line ~645)**

In the switch on `classification.intent`, add a case for `add_reminder`:

```typescript
case "add_reminder":
  actionSummary = `${sender} wants a reminder: "${e.reminder_text || e.raw_text}". Time expression: "${e.time_raw || "not specified"}".`;
  break;
```

**Step 2: Add reminder extraction instructions to the Sonnet system prompt**

After the action summary in the reply prompt, add special instructions when intent is `add_reminder`:

```
When the intent is add_reminder, you MUST include a JSON block at the END of your reply in this exact format:
<!--REMINDER:{"reminder_text":"what to remind","send_at":"2026-04-08T16:00:00+03:00"}-->

Time parsing rules (Israel timezone, UTC+3):
- "ב-4" or "ב-16" → today at 16:00 (if in future, else tomorrow at 16:00)
- "מחר ב-8" → tomorrow at 08:00
- "בעוד שעה" → current time + 1 hour
- "בעוד 20 דקות" → current time + 20 minutes
- "ביום חמישי ב-10" → next Thursday at 10:00
- "בערב" → 19:00, "בצהריים" → 12:00, "בבוקר" → 08:00
- If no time specified, reply asking "מתי לתזכיר?" and do NOT include the REMINDER block.

Your visible reply should confirm: "אזכיר [what] [when] ✓"
```

---

### Task 5: Add Reminder Action Execution

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Parse the REMINDER block from Sonnet's reply**

Add a function after `generateReply`:

```typescript
function extractReminderFromReply(reply: string): { reminder_text: string; send_at: string } | null {
  const match = reply.match(/<!--REMINDER:(.*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function cleanReminderFromReply(reply: string): string {
  return reply.replace(/<!--REMINDER:.*?-->/, "").trim();
}
```

**Step 2: Handle reminder insertion in the main message flow**

In the `haiku_actionable` routing branch (around line 2070-2090), after `executeActions` and before sending the reply, add:

```typescript
// Handle reminder insertion
if (classification.intent === "add_reminder") {
  const reminderData = extractReminderFromReply(replyResult.reply);
  if (reminderData && reminderData.send_at) {
    await supabase.from("reminder_queue").insert({
      household_id: householdId,
      group_id: message.groupId,
      message_text: reminderData.reminder_text,
      send_at: reminderData.send_at,
      sent: false,
      reminder_type: "user",
      created_by_phone: message.senderPhone,
      created_by_name: message.senderName,
    });
    console.log(`[Reminder] Created for ${reminderData.send_at}: ${reminderData.reminder_text}`);
  }
  // Clean the hidden JSON from the reply before sending
  replyResult.reply = cleanReminderFromReply(replyResult.reply);
}
```

**Step 3: Add `add_reminder` to the `haikuEntitiesToActions` function**

The classifier output goes through `haikuEntitiesToActions` to create actions. For reminders, we don't need a DB action (it's handled separately via the REMINDER block), but we need to avoid the "no actions" path:

```typescript
case "add_reminder":
  // Reminders are handled via Sonnet's REMINDER block, not via executeActions
  // But we need an action entry so the flow doesn't treat it as "no action"
  actions.push({ type: "add_reminder", data: { reminder_text: e.reminder_text || e.raw_text, time_raw: e.time_raw } });
  break;
```

Also add `"add_reminder"` to the `ClassifiedAction` type's `type` union.

---

### Task 6: Handle 1:1 Reminder Requests

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add reminder detection in `handleDirectMessage`**

In the Q&A matching section (before the Haiku fallback), add a reminder pattern:

```typescript
// Check for reminder request in 1:1
const reminderPattern = /תזכיר[יו]|תזכרו|remind/i;
if (reminderPattern.test(message.text)) {
  // Look up user's household
  const { data: mapping } = await supabase
    .from("whatsapp_member_mapping")
    .select("household_id")
    .eq("phone_number", phone)
    .limit(1)
    .single();

  if (mapping) {
    // Find the group for this household
    const { data: config } = await supabase
      .from("whatsapp_config")
      .select("group_id")
      .eq("household_id", mapping.household_id)
      .eq("bot_active", true)
      .limit(1)
      .single();

    if (config) {
      // Use Sonnet to parse the reminder
      // ... (call generateReply with add_reminder context, extract time, insert into reminder_queue with config.group_id)
      // Reply in 1:1: "אזכיר! התזכורת תישלח בקבוצה המשפחתית ✓"
    }
  } else {
    await prov.sendMessage({
      groupId: message.groupId,
      text: "כדי שאוכל לתזכיר, קודם הוסיפו אותי לקבוצה המשפחתית 😊",
    });
  }
  return;
}
```

---

### Task 7: Add Cancel/List Reminders

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Handle "מה התזכורות שלי?" in the `question` intent**

When Sonnet detects a question about reminders, query pending reminders:

```typescript
// In the question handling, add reminder listing
const pendingReminders = await supabase
  .from("reminder_queue")
  .select("message_text, send_at, created_by_name")
  .eq("household_id", householdId)
  .eq("sent", false)
  .order("send_at", { ascending: true })
  .limit(10);
```

**Step 2: Handle "תבטלי את התזכורת" in quick-undo**

Add to the quick undo patterns (pre-classifier):
```typescript
const cancelReminderPattern = /תבטל[יו].*תזכורת|בטל[יו].*תזכורת|cancel.*remind/i;
```

Mark the most recent unsent reminder as sent (effectively cancelling it).

---

### Task 8: Test End-to-End + Deploy

**Step 1: Deploy the code changes**
Open `index.inlined.ts` in Cursor → Ctrl+A → Ctrl+C → Supabase Dashboard → paste → Deploy.

**Step 2: Run the SQL migrations**
Execute Tasks 1 and 2 SQL via Supabase SQL Editor or MCP tool.

**Step 3: Test in WhatsApp**
- "תזכירי לי בעוד 2 דקות לבדוק משהו" → should confirm, then fire 2 min later
- "מה התזכורות שלי?" → should list pending
- "תבטלי את התזכורת" → should cancel

**Step 4: Monitor pg_cron logs**
```sql
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```
