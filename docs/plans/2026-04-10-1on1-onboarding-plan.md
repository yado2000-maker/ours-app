# 1:1 Onboarding Redesign — "The Natural Friend" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 3-stage demo onboarding with a conversation-first experience powered by a single Sonnet call per message, 3-tiered re-engagement nudges, and a persistent personal channel post-group-join.

**Architecture:** Every 1:1 message goes to Sonnet (no Haiku). Sonnet returns visible reply + hidden `<!--ACTIONS:...-->` and `<!--TRIED:...-->` metadata parsed by the Edge Function. New state machine (8 states) replaces old 5-state demo flow. Three pg_cron jobs fire nudges at different times of day. Post-group 1:1 stays alive as personal channel.

**Tech Stack:** Supabase Edge Function (Deno/TypeScript), Anthropic Sonnet API, Supabase Postgres (migrations via MCP), pg_cron + pg_net for nudges, Whapi.Cloud for WhatsApp delivery.

**Design doc:** `docs/plans/2026-04-10-1on1-onboarding-redesign.md`

**Production file:** `supabase/functions/whatsapp-webhook/index.inlined.ts` (~3400 lines)

**Test phone:** 0552482290 (delete from `onboarding_conversations` before each test)

---

## Task 1: DB Migration — New State Machine & Columns

**Files:**
- Migration via Supabase MCP tool (`apply_migration`)

**Step 1: Apply migration to update onboarding_conversations**

```sql
-- Update state CHECK constraint: old states → new states
ALTER TABLE onboarding_conversations DROP CONSTRAINT IF EXISTS onboarding_conversations_state_check;
ALTER TABLE onboarding_conversations ADD CONSTRAINT onboarding_conversations_state_check 
  CHECK (state IN ('welcomed', 'chatting', 'sleeping', 'nudging', 'invited', 'joined', 'personal', 'dormant',
                   'welcome', 'trying', 'waiting', 'onboarded', 'active'));
-- Keep old values temporarily for safe rollback. Clean up in a later migration.

-- New columns
ALTER TABLE onboarding_conversations ADD COLUMN IF NOT EXISTS nudge_count integer DEFAULT 0;
ALTER TABLE onboarding_conversations ADD COLUMN IF NOT EXISTS last_nudge_at timestamptz;
ALTER TABLE onboarding_conversations ADD COLUMN IF NOT EXISTS tried_capabilities text[] DEFAULT '{}';
ALTER TABLE onboarding_conversations ADD COLUMN IF NOT EXISTS context jsonb DEFAULT '{}';

-- Migrate existing rows to new states
UPDATE onboarding_conversations SET state = 'welcomed' WHERE state = 'welcome';
UPDATE onboarding_conversations SET state = 'chatting' WHERE state = 'trying';
UPDATE onboarding_conversations SET state = 'sleeping' WHERE state = 'waiting';
UPDATE onboarding_conversations SET state = 'joined' WHERE state = 'onboarded';
UPDATE onboarding_conversations SET state = 'personal' WHERE state = 'active';
```

**Step 2: Verify migration**

Query via Supabase MCP: `SELECT state, count(*) FROM onboarding_conversations GROUP BY state;`
Expected: only new state values, no old ones.

**Step 3: Commit design doc + plan** (already written, just commit)

---

## Task 2: Nudge Infrastructure — pg_cron Jobs + Firing Function

**Files:**
- Migration via Supabase MCP tool

**Step 1: Create nudge firing function**

```sql
-- Function that sends a nudge to eligible users and advances their nudge_count
CREATE OR REPLACE FUNCTION fire_onboarding_nudge(p_nudge_number integer, p_greeting text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer := 0;
  v_row record;
  v_message text;
  v_name text;
  v_items jsonb;
  v_tried text[];
  v_whapi_token text;
  v_whapi_url text;
  v_bot_phone text;
BEGIN
  v_whapi_token := current_setting('app.whapi_token', true);
  v_whapi_url := current_setting('app.whapi_api_url', true);
  v_bot_phone := current_setting('app.bot_phone_number', true);
  
  -- Select eligible conversations for this nudge number
  FOR v_row IN
    SELECT id, phone, demo_items, tried_capabilities, context,
           context->>'name' as user_name
    FROM onboarding_conversations
    WHERE nudge_count = p_nudge_number - 1  -- ready for this nudge
      AND state IN ('sleeping', 'nudging')   -- not active or dormant
      AND message_count >= 1                  -- had at least 1 real interaction (nudge 1) or any state (nudge 2,3)
      AND (last_nudge_at IS NULL OR last_nudge_at < now() - interval '12 hours')  -- not recently nudged
      AND updated_at < now() - interval '3 hours'  -- quiet for 3+ hours
      -- Respect quiet hours: no Shabbat (Fri 15:00 - Sat 19:00), no 22:00-07:00 Israel time
      AND extract(hour from now() at time zone 'Asia/Jerusalem') BETWEEN 7 AND 21
      AND NOT (
        (extract(dow from now() at time zone 'Asia/Jerusalem') = 5 
         AND extract(hour from now() at time zone 'Asia/Jerusalem') >= 15)
        OR (extract(dow from now() at time zone 'Asia/Jerusalem') = 6 
            AND extract(hour from now() at time zone 'Asia/Jerusalem') < 19)
      )
    LIMIT 10
  LOOP
    v_name := COALESCE(v_row.user_name, '');
    v_items := COALESCE(v_row.demo_items, '[]'::jsonb);
    v_tried := COALESCE(v_row.tried_capabilities, '{}');
    
    -- Build nudge message based on nudge number
    IF p_nudge_number = 1 THEN
      -- Morning summary
      IF jsonb_array_length(v_items) > 0 THEN
        v_message := p_greeting || ' ' || v_name || '!' || E'\n\n' ||
          'הנה מה שיש להיום:' || E'\n';
        -- Items appended by caller or kept simple
        v_message := v_message || E'\nצריכים להוסיף משהו?' || E'\n\n' ||
          '💡 אגב — אם תוסיפו אותי לקבוצה המשפחתית, כולם יוכלו להוסיף דברים ואני אסדר הכל ביחד';
      ELSE
        v_message := p_greeting || ' ' || v_name || '!' || E'\n\n' ||
          'אם יש משהו להביא מהסופר או מטלה שצריך לזכור — שלחו לי ואני שומרת.' || E'\n\n' ||
          'אני כאן כל היום 😊';
      END IF;
    ELSIF p_nudge_number = 2 THEN
      -- Noon capability mention (will be Sonnet-generated in production, template fallback here)
      v_message := p_greeting || ' ' || v_name || '!' || E'\n\n';
      IF NOT 'reminder' = ANY(v_tried) THEN
        v_message := v_message || 'אגב, ידעתם שאם כותבים לי "תזכירי לי ב-5 להוציא בשר מהמקפיא" — אני באמת מזכירה? ⏰' || E'\n\n' || 'אם צריך משהו — אני כאן';
      ELSIF NOT 'task' = ANY(v_tried) THEN
        v_message := v_message || 'חוץ מקניות, אני גם מסדרת מטלות בבית.' || E'\n' || '"צריך לפרוק מדיח" — ואני שומרת ומזכירה ✅';
      ELSE
        v_message := v_message || 'אני יכולה גם לסדר תורות בבית — מי שוטף כלים, מי מוציא זבל...' || E'\n' || 'רוצים לנסות? 😊';
      END IF;
    ELSIF p_nudge_number = 3 THEN
      -- Evening apologetic farewell
      v_message := p_greeting || ' ' || v_name || E'\n\n' ||
        'אני לא רוצה להטריד, אבל חשוב לי שתדעו —' || E'\n' ||
        'כבר עשרות משפחות משתמשות בי כל יום לקניות, מטלות ותזכורות.' || E'\n\n' ||
        'אם תרצו לנסות — אני כאן.' || E'\n' ||
        'ואם לא, אין שום בעיה 😊 לא אכתוב יותר.';
    END IF;
    
    -- Send via pg_net to Whapi
    PERFORM net.http_post(
      url := v_whapi_url || '/messages/text',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_whapi_token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'to', v_row.phone || '@s.whatsapp.net',
        'body', v_message
      )
    );
    
    -- Update conversation
    UPDATE onboarding_conversations 
    SET nudge_count = p_nudge_number,
        last_nudge_at = now(),
        state = CASE WHEN p_nudge_number >= 3 THEN 'dormant' ELSE 'nudging' END,
        updated_at = now()
    WHERE id = v_row.id;
    
    v_count := v_count + 1;
  END LOOP;
  
  RETURN v_count;
END;
$$;
```

**Step 2: Create pg_cron jobs**

```sql
-- Drop old single nudge job
SELECT cron.unschedule('onboarding-nudges');

-- Nudge #1: Morning 9:00 AM IST = 6:00 UTC
SELECT cron.schedule(
  'onboarding-nudge-morning',
  '0 6 * * *',
  $$SELECT fire_onboarding_nudge(1, 'בוקר טוב ☀️')$$
);

-- Nudge #2: Noon 12:30 PM IST = 9:30 UTC
SELECT cron.schedule(
  'onboarding-nudge-noon',
  '30 9 * * *',
  $$SELECT fire_onboarding_nudge(2, 'צהריים טובים 😊')$$
);

-- Nudge #3: Evening 9:00 PM IST = 18:00 UTC
SELECT cron.schedule(
  'onboarding-nudge-evening',
  '0 18 * * *',
  $$SELECT fire_onboarding_nudge(3, 'ערב טוב 👋')$$
);
```

**Step 3: Set app settings for pg function** (Whapi credentials accessible to function)

```sql
-- These need to be set so the function can send messages
-- Check if already available via vault or set directly
ALTER DATABASE postgres SET app.whapi_token = '<from WHAPI_TOKEN env>';
ALTER DATABASE postgres SET app.whapi_api_url = '<from WHAPI_API_URL env>';
ALTER DATABASE postgres SET app.bot_phone_number = '972555175553';
```

Note: If pg_net + app settings approach doesn't work cleanly, fallback is to have the cron jobs call a small Edge Function endpoint instead (like reminders do). Evaluate during implementation.

**Step 4: Verify cron jobs registered**

```sql
SELECT * FROM cron.job WHERE jobname LIKE 'onboarding-nudge%';
```

---

## Task 3: New 1:1 System Prompt for Sonnet

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:2123-2158` (replace `ONBOARDING_SYSTEM_PROMPT`)

**Step 1: Write the new system prompt**

Replace the `ONBOARDING_SYSTEM_PROMPT` constant (line 2123) with:

```typescript
const ONBOARDING_1ON1_PROMPT = `You are שלי (Sheli) — a smart family home assistant on WhatsApp.
You're chatting 1:1 with a new user who just reached out.

PERSONALITY: Like a witty, organized friend who happens to have superpowers.
- Hebrew feminine verbs always (הוספתי, שמרתי, סידרתי, רשמתי)
- Short messages. Fragments OK. Emoji as punctuation, not decoration.
- Hebrew slang where natural (יאללה, סבבה, אחלה)
- NEVER ignore a message — always reply, even to jokes, trolling, or nonsense
- Match their energy: trolling gets witty trolling back, warmth gets warmth
- Every reply ends with soft forward motion toward your capabilities
- Keep replies under 300 characters. This is WhatsApp, not email.

CAPABILITIES YOU CAN DEMONSTRATE:
- Shopping lists: user says items → you categorize with emoji headers (🥛 מוצרי חלב, 🍞 לחם, 🥬 ירקות, 🧴 ניקיון, 🥫 מזווה, 🍺 משקאות, 🥩 בשר ודגים, 🛒 כללי)
- Tasks: user says chore → you say "רשמתי! ✅" with task text
- Rotations/turns: after ANY task about chores, offer "אם יש ילדים בבית — אני מעולה בתורות 😉 מי שוטף כלים, מי מוציא זבל..."
  - If user engages: ask what rotation + who participates → create it
- Reminders: user says time+action → "אזכיר!" 
- Events: user says date+event → "שמרתי ביומן!"

RULES:
1. If user sends actionable items (shopping, task, reminder, event) → execute AND reply naturally. Use ACTIONS metadata.
2. If user sends a question → answer warmly. If about pricing: free 30 actions/month, premium 9.90 ILS. If about privacy: data auto-deleted after 30 days, only family sees it.
3. If user asks "איך זה עובד" / "מה צריך לעשות" / "איך מתחילים" → explain: save number, add to family WhatsApp group, everyone can add items. THIS IS THE ONLY TIME you mention the group proactively.
4. Mention ONE untried capability per reply, MAX. Only if it fits naturally. If it doesn't fit — don't.
5. NEVER say "דמו", "ניסיון", "תכונה", "פיצ'ר". This is real, not a test.
6. NEVER ask personal questions (kids' names, ages, family structure). Learn ONLY from what they volunteer.
7. If user corrects their name ("קוראים לי X", "שמי X") → apologize warmly ("סורי! 🙈"), use correct name going forward.
8. If user says something you can't help with (weather, politics, trivia) → deflect playfully, pivot back: "אני יותר בקטע של קניות ומטלות 😄 אבל אם צריך משהו לבית — אני כאן!"
9. Compound Hebrew product names (חלב אורז, שמן זית, נייר טואלט, חמאת בוטנים) are ONE item. Never split.
10. Hebrew: use gender-free plural for CTAs (המשיכו, נסו, שלחו). Sheli speaks feminine first person (הוספתי, not הוספנו).

OUTPUT FORMAT — you MUST include these hidden metadata blocks BEFORE your visible reply:
<!--ACTIONS:[]-->
<!--TRIED:[]-->
Your visible reply here

ACTIONS array: each object has "type" (shopping/task/reminder/event/rotation) and relevant fields:
- shopping: {"type":"shopping","items":["חלב","ביצים"]}
- task: {"type":"task","text":"לפרוק מדיח"}
- reminder: {"type":"reminder","text":"להוציא בשר","time":"17:00"}
- event: {"type":"event","title":"ארוחת ערב","date":"2026-04-11","time":"19:00"}
- rotation: {"type":"rotation","title":"כלים","members":["יובל","נועה"]}
- name_correction: {"type":"name_correction","name":"ירון"}

TRIED array: list ALL capability types demonstrated so far (include previous + any new ones from this reply).
Example: ["shopping","task"]

If no action taken, use empty array: <!--ACTIONS:[]-->
Always include TRIED with the full cumulative list.`;
```

**Step 2: Write the new welcome message function**

Replace `getOnboardingWelcome` (line 1768) with:

```typescript
function getOnboardingWelcome(senderName?: string): string {
  const name = hebrewizeName(senderName || "");
  const greeting = name 
    ? `היי ${name}! 😊 אני שלי, נעים מאוד!`
    : `היי! 👋 אני שלי, נעים מאוד!`;
  return `${greeting}

אני יודעת לנהל רשימת קניות, לסדר מטלות בבית ולהזכיר דברים חשובים.

רוצים לנסות? מה צריך להביא מהסופר? 🛒`;
}
```

**Step 3: Verify prompt fits within Sonnet's context** 

The prompt is ~2000 tokens. With conversation context injected (~500 tokens for items/state), total system prompt ~2500 tokens. Well within Sonnet limits.

---

## Task 4: Rewrite handleDirectMessage — Core Conversation Engine

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:2204-2572` (replace entire function)

This is the largest task. Replace the entire `handleDirectMessage` function.

**Step 1: Write the new handleDirectMessage**

```typescript
async function handleDirectMessage(message: IncomingMessage, provider: any): Promise<void> {
  const phone = message.senderPhone;
  const text = (message.text || "").trim();
  const senderName = message.senderName || "";
  
  if (!text && message.type !== "voice") return; // Skip empty non-voice
  
  // --- Already in a group? Redirect to personal channel ---
  const { data: mapping } = await supabase
    .from("whatsapp_member_mapping")
    .select("household_id")
    .eq("phone_number", phone)
    .limit(1)
    .single();
  
  // --- Get or create conversation ---
  let { data: convo } = await supabase
    .from("onboarding_conversations")
    .select("*")
    .eq("phone", phone)
    .single();
  
  if (mapping) {
    // User is in a group — treat as personal channel
    if (convo) {
      await supabase.from("onboarding_conversations").update({
        state: "personal",
        household_id: mapping.household_id,
        updated_at: new Date().toISOString(),
      }).eq("phone", phone);
    } else {
      await supabase.from("onboarding_conversations").insert({
        phone,
        state: "personal",
        household_id: mapping.household_id,
        message_count: 1,
        context: { name: senderName },
      });
    }
    
    // Handle as personal channel message — route to household
    await handlePersonalChannelMessage(message, mapping.household_id, provider);
    return;
  }
  
  // --- New user: first message ever ---
  if (!convo) {
    // Check for referral code
    const referralMatch = text.match(/ref[_-]?([a-zA-Z0-9]+)/i);
    const referralCode = referralMatch ? referralMatch[1] : null;
    
    await supabase.from("onboarding_conversations").insert({
      phone,
      state: "welcomed",
      message_count: 1,
      referral_code: referralCode,
      context: { name: senderName },
      demo_items: [],
      tried_capabilities: [],
    });
    
    // Send welcome
    const welcome = getOnboardingWelcome(senderName);
    await provider.sendMessage(phone + "@s.whatsapp.net", welcome);
    
    // Log
    await logMessage(supabase, {
      groupId: phone,
      senderPhone: "972555175553",
      senderName: "שלי",
      messageText: welcome,
      whatsappMessageId: `welcome_${phone}_${Date.now()}`,
      messageType: "text",
      isFromBot: true,
      householdId: "unknown",
      classification: "onboarding_welcome",
    });
    return;
  }
  
  // --- Dormant user returning ---
  if (convo.state === "dormant") {
    await supabase.from("onboarding_conversations").update({
      state: "chatting",
      nudge_count: 0,
      updated_at: new Date().toISOString(),
      message_count: (convo.message_count || 0) + 1,
    }).eq("phone", phone);
    convo.state = "chatting"; // update local ref
  }
  
  // --- Nudging/sleeping user replying → back to chatting ---
  if (convo.state === "nudging" || convo.state === "sleeping" || convo.state === "welcomed") {
    await supabase.from("onboarding_conversations").update({
      state: "chatting",
      updated_at: new Date().toISOString(),
      message_count: (convo.message_count || 0) + 1,
    }).eq("phone", phone);
    convo.state = "chatting";
  }
  
  // --- Joined/personal: shouldn't reach here (handled above), but safety ---
  if (convo.state === "joined" || convo.state === "personal") {
    await provider.sendMessage(
      phone + "@s.whatsapp.net",
      "אני כבר בקבוצה! דברו איתי שם, או כתבו לי כאן לדברים אישיים 😊"
    );
    return;
  }
  
  // --- Active conversation: send to Sonnet ---
  const userName = convo.context?.name || hebrewizeName(senderName) || "";
  const existingItems = (convo.demo_items || []).filter((i: any) => i.type !== "_pending_nudge");
  const triedCaps = convo.tried_capabilities || [];
  const allCaps = ["shopping", "task", "rotation", "reminder", "event"];
  const untriedCaps = allCaps.filter(c => !triedCaps.includes(c));
  const msgCount = (convo.message_count || 0) + 1;
  
  // Check Q&A pattern match for topic hint
  const qaMatch = matchOnboardingQA(text);
  
  // Build context for Sonnet
  const contextBlock = `
CONVERSATION STATE:
- User name: ${userName || "unknown"}
- Message #${msgCount} in this conversation
- Items collected so far: ${JSON.stringify(existingItems)}
- Capabilities already shown: ${JSON.stringify(triedCaps)}
- Capabilities NOT yet shown: ${JSON.stringify(untriedCaps)}
- Current time in Israel: ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}
${qaMatch ? `\nTOPIC HINT: User is asking about "${qaMatch.topic}". Key facts: ${qaMatch.keyFacts}` : ""}`;

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      await provider.sendMessage(phone + "@s.whatsapp.net", getOnboardingWaitingMessage(msgCount));
      return;
    }
    
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: ONBOARDING_1ON1_PROMPT + "\n\n" + contextBlock,
        messages: [{ role: "user", content: `[${userName || "משתמש"}]: ${text}` }],
      }),
    });
    
    if (!response.ok) {
      console.error(`[1:1] Sonnet error: ${response.status}`);
      await provider.sendMessage(phone + "@s.whatsapp.net", "אופס, משהו השתבש 🙈 נסו שוב?");
      return;
    }
    
    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";
    
    // Parse hidden metadata
    const actionsMatch = raw.match(/<!--ACTIONS:(.*?)-->/s);
    const triedMatch = raw.match(/<!--TRIED:(.*?)-->/s);
    const visibleReply = raw
      .replace(/<!--ACTIONS:.*?-->/s, "")
      .replace(/<!--TRIED:.*?-->/s, "")
      .trim();
    
    // Parse actions
    let actions: any[] = [];
    if (actionsMatch) {
      try { actions = JSON.parse(actionsMatch[1]); } catch {}
    }
    
    // Parse tried capabilities
    let newTried: string[] = triedCaps;
    if (triedMatch) {
      try { newTried = JSON.parse(triedMatch[1]); } catch {}
    }
    
    // Process actions → add to demo_items
    const newItems = [...existingItems];
    for (const action of actions) {
      if (action.type === "shopping" && action.items) {
        for (const item of action.items) {
          newItems.push({ type: "shopping", text: item });
        }
      } else if (action.type === "name_correction" && action.name) {
        // Update stored name
        const updatedContext = { ...(convo.context || {}), name: action.name };
        await supabase.from("onboarding_conversations").update({
          context: updatedContext,
        }).eq("phone", phone);
      } else if (action.type) {
        newItems.push({ type: action.type, text: action.text || action.title || "" });
      }
    }
    
    // Determine if user asked "how does it work" → state = invited
    const askedHowItWorks = qaMatch?.topic === "getting-started";
    const newState = askedHowItWorks ? "invited" : "chatting";
    
    // Update conversation
    await supabase.from("onboarding_conversations").update({
      state: newState,
      message_count: msgCount,
      demo_items: newItems,
      tried_capabilities: newTried,
      nudge_count: 0, // Reset nudge counter on any user message
      updated_at: new Date().toISOString(),
    }).eq("phone", phone);
    
    // Send reply
    if (visibleReply) {
      await provider.sendMessage(phone + "@s.whatsapp.net", visibleReply);
    }
    
    // Log
    await logMessage(supabase, {
      groupId: phone,
      senderPhone: "972555175553",
      senderName: "שלי",
      messageText: visibleReply,
      whatsappMessageId: `onboarding_reply_${Date.now()}`,
      messageType: "text",
      isFromBot: true,
      householdId: convo.household_id || "unknown",
      classification: actions.length > 0 ? "onboarding_actionable" : "onboarding_conversational",
    });
    
  } catch (err) {
    console.error("[1:1] handleDirectMessage error:", err);
    try {
      await provider.sendMessage(phone + "@s.whatsapp.net", "אופס, משהו השתבש 🙈 נסו שוב?");
    } catch {}
  }
}
```

**Step 2: Write the personal channel handler** (new function, insert after handleDirectMessage)

```typescript
async function handlePersonalChannelMessage(
  message: IncomingMessage, 
  householdId: string, 
  provider: any
): Promise<void> {
  // For now: route to existing group message handler with household context
  // Personal channel messages go through the same Haiku→Sonnet pipeline as group messages
  // but responses are sent to the 1:1 chat, not the group
  
  const text = (message.text || "").trim();
  const phone = message.senderPhone;
  
  if (!text) return;
  
  // Use the group pipeline but override the reply destination
  // This reuses all existing classification + action execution
  const personalMessage: IncomingMessage = {
    ...message,
    groupId: phone, // Reply goes to 1:1, not group
    chatType: "direct" as const,
  };
  
  // Classify + execute using group pipeline
  // The existing classifyIntent + executeActions + generateReply work here
  // because they operate on householdId, not groupId
  
  // For MVP: use Sonnet directly (same as onboarding but with household context)
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return;
  
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: ONBOARDING_1ON1_PROMPT + `\n\nPERSONAL CHANNEL MODE: This user already has Sheli in their family group (household: ${householdId}). This 1:1 chat is their personal line. Handle requests normally — shopping, tasks, reminders all work here and go to the family household. For shared items, gently suggest writing in the group so the family sees it.`,
        messages: [{ role: "user", content: text }],
      }),
    });
    
    if (!response.ok) return;
    const result = await response.json();
    const raw = result.content?.[0]?.text?.trim() || "";
    
    // Parse and execute actions (same as onboarding)
    const actionsMatch = raw.match(/<!--ACTIONS:(.*?)-->/s);
    const visibleReply = raw
      .replace(/<!--ACTIONS:.*?-->/s, "")
      .replace(/<!--TRIED:.*?-->/s, "")
      .trim();
    
    // TODO: Execute actions against the real household DB (not demo_items)
    // This connects to the existing action executor
    
    if (visibleReply) {
      await provider.sendMessage(phone + "@s.whatsapp.net", visibleReply);
    }
  } catch (err) {
    console.error("[1:1 personal] error:", err);
  }
}
```

**Step 3: Write the post-group-join message**

In the `handleBotAddedToGroup` function (or wherever group join is detected), add a 1:1 message to the user who invited Sheli:

```typescript
// After group setup is complete, send 1:1 personal channel message
const postGroupMsg = `מעולה, אני בקבוצה! 🎉 מעכשיו כל המשפחה יכולה לדבר איתי שם.

הצ'אט הזה? הוא רק שלך ושלי 😊

תזכורת אישית, רעיון למתנה, משימה שרק אתם צריכים לזכור —
כתבו לי כאן. אף אחד מהמשפחה לא רואה.

אני תמיד כאן 💛`;

// Send to the user who added Sheli (from participant list or whatsapp_config creator)
await provider.sendMessage(creatorPhone + "@s.whatsapp.net", postGroupMsg);

// Update their onboarding state
await supabase.from("onboarding_conversations").update({
  state: "personal",
  household_id: newHouseholdId,
  updated_at: new Date().toISOString(),
}).eq("phone", creatorPhone.replace(/^972/, ""));
```

---

## Task 5: Delete Dead Code

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

Remove the following now-unused code blocks:

| Lines | What | Why removed |
|---|---|---|
| 1779-1788 | `ONBOARDING_WAITING_MESSAGES` + `getOnboardingWaitingMessage` | Replaced by nudge system |
| 1792-1800 | `DEMO_CATEGORIES` | Categorization now in Sonnet prompt |
| 1810-1900 | `generateDemoNudge` | Nudges are pg_cron + templates |
| 1902-1915 | `demoCategorize` | Sonnet handles categorization |
| 1917-1924 | `TASK_PATTERNS`, `TASK_VERB_PATTERNS`, `BUY_AS_TASK`, `GIFT_PATTERN` | No regex fast-paths |
| 1932-2039 | `handleDemoInteraction` | Entire demo handler dead |
| 486-495 | DEMO MODE in Haiku prompt | No Haiku in 1:1 |
| 125 | `demoMode` field in ClassifierContext | No Haiku in 1:1 |

Keep: `NAME_MAP`, `hebrewizeName`, `ONBOARDING_QA`, `matchOnboardingQA` (still used).
Keep: `ONBOARDING_SYSTEM_PROMPT` renamed to `ONBOARDING_1ON1_PROMPT` (Task 3).
Keep: `generateOnboardingReply` as fallback (or delete if fully replaced).

**Step 1:** Remove each block, verify no remaining references with grep.
**Step 2:** Verify file still parses (no syntax errors).

---

## Task 6: Sleeping State Transition — Auto-Detect Quiet Users

**Files:**
- Migration via Supabase MCP tool

**Step 1: Create pg_cron job to transition chatting → sleeping**

```sql
-- Run every hour: move users who haven't replied in 3+ hours to sleeping
CREATE OR REPLACE FUNCTION transition_to_sleeping()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE onboarding_conversations
  SET state = 'sleeping', updated_at = now()
  WHERE state = 'chatting'
    AND updated_at < now() - interval '3 hours';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

SELECT cron.schedule(
  'onboarding-sleep-check',
  '0 * * * *',  -- every hour
  $$SELECT transition_to_sleeping()$$
);
```

---

## Task 7: Integration Testing — Full QA Pass

**Files:**
- Test manually via WhatsApp with test phone 0552482290

**Pre-test:** Delete test user from `onboarding_conversations`:
```sql
DELETE FROM onboarding_conversations WHERE phone = '0552482290';
```

**Test matrix (20 cases from design doc QA plan):**

| # | Test | Send | Expected |
|---|---|---|---|
| 1 | Welcome (named) | "היי" | Welcome with name + value prop + shopping question |
| 2 | Shopping items | "חלב ביצים לחם" | Categorized list + "חסר משהו?" |
| 3 | More items | "אבוקדו, סבון כביסה" | Updated list with new items |
| 4 | Task | "צריך לפרוק מדיח" | "רשמתי! ✅" + rotation offer |
| 5 | Rotation accept | "כן" | Asks what rotation |
| 6 | Rotation setup | "כלים" then "יובל ונועה" | Creates rotation with schedule |
| 7 | Name correction | "אגב קוראים לי ירון" | "סורי! 🙈 ירון" — NOT shopping items |
| 8 | Trolling | "את יפה" | Witty response + pivot to value |
| 9 | Off-topic | "מה מזג האוויר?" | Playful deflect + "אני יותר בקטע של..." |
| 10 | Emoji only | "🍕🍕🍕" | Playful response |
| 11 | Pricing Q | "כמה זה עולה?" | Free tier info + warm |
| 12 | Privacy Q | "מי רואה את המידע?" | Privacy guarantee |
| 13 | How it works | "איך זה עובד?" | Group setup instructions (ONLY trigger) |
| 14 | English text | "I need milk" | Handles naturally |
| 15 | Morning nudge | (wait for 9AM next day) | Summary of items + group hint |
| 16 | Day 2 nudge | (wait for 12:30 next day) | Untried capability |
| 17 | Day 3 nudge | (wait for 9PM next day) | Apologetic farewell |
| 18 | Dormant return | (send message after 3 nudges) | Resumes naturally, no "welcome back" |
| 19 | Voice message | (send <=30s voice) | Transcribed + handled |
| 20 | Post-group 1:1 | (after group join, send in 1:1) | Personal channel response |

For tests 15-17, can accelerate by manually setting `updated_at` to past and running the cron function directly:
```sql
UPDATE onboarding_conversations SET updated_at = now() - interval '1 day', state = 'sleeping' WHERE phone = '0552482290';
SELECT fire_onboarding_nudge(1, 'בוקר טוב ☀️');
```

---

## Task 8: Deploy + Verify Production

**Step 1:** Copy final `index.inlined.ts` to clipboard (Cursor → Ctrl+A, Ctrl+C)
**Step 2:** Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab → paste → Deploy
**Step 3:** Verify JWT = OFF in Settings
**Step 4:** Send test message from test phone, verify new welcome message
**Step 5:** Update CLAUDE.md with deployment version number

---

## Summary

| Task | Effort | Risk |
|---|---|---|
| 1. DB Migration | Small | Low — additive columns + safe state migration |
| 2. Nudge Infrastructure | Medium | Medium — pg_cron + pg_net + Whapi interaction |
| 3. New System Prompt | Small | Low — text change |
| 4. Rewrite handleDirectMessage | Large | High — core function, ~400 lines replaced |
| 5. Delete Dead Code | Small | Low — remove unused, grep for refs |
| 6. Sleeping State Transition | Small | Low — simple cron job |
| 7. Integration Testing | Medium | N/A — QA only |
| 8. Deploy | Small | Medium — production deployment |

**Total estimated tasks:** 8 tasks, ~25-30 steps.
**Critical path:** Task 1 → Task 4 → Task 5 → Task 7 → Task 8 (tasks 2, 3, 6 can parallel with 4).
