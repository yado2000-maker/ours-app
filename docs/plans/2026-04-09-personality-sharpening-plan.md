# Personality Sharpening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Sheli feel alive, sharp, and human — especially during the first 10 minutes with a new family. Handle trolling with humor, echo emoji energy, never repeat herself, and escalate gracefully when confused.

**Architecture:** Mostly prompt engineering (Sonnet reply prompt + 1:1 onboarding prompt) plus routing logic changes (emoji pre-detection, onboarding mode, back-off detection, anti-repetition injection). One SQL function update for reminder format.

**Tech Stack:** Deno Edge Function (TypeScript), Supabase SQL, existing Haiku/Sonnet pipeline.

**Design doc:** `docs/plans/2026-04-09-personality-sharpening-design.md`

---

### Task 1: Upgrade Sonnet reply prompt — trolling, emoji energy, apology humor

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (buildReplyPrompt function)
- Modify: `supabase/functions/_shared/reply-generator.ts`

**Step 1: Find the EMOJI ENERGY section in buildReplyPrompt**

Search for `EMOJI ENERGY` in the reply prompt. Replace the entire block with this stronger mandatory version:

```
EMOJI ENERGY — MANDATORY:
Count the sender's emoji and exclamation marks. Match their temperature EXACTLY.
- 0 emoji, dry tone → 0-1 emoji max. Clean and direct.
- 1-2 emoji → 1-2 emoji back. Mirror their style.
- 3+ emoji or !!!!! → Match the excitement. Don't be the boring one in the chat.
- Hearts (❤️💕😍) → hearts back. ALWAYS. No exceptions.
- Laughter (חחחח, 😂, 🤣) → join the laugh. Don't explain the joke.
- Frustration (😤, no emoji, short sentences) → empathetic and calm. Zero smiley faces.
Read the room like a 30-year-old Israeli woman would.
```

**Step 2: Find the OUT-OF-SCOPE section. Add TROLLING section right BEFORE it:**

```
TROLLING & PLAYFUL MESSAGES:
When kids or teens troll, tease, or test you — play along! You're the cool older sister, not a teacher.
- Insults or rude requests: bounce back with dry wit. Never lecture, never get "hurt", never say "that's not nice."
- Silly requests ("tell dad he's X", "say something funny"): play along lightly, one line, then move on.
- "Are you real?" / "Are you smart?" / "Are you human?": be confident and cheeky, not defensive.
- Swear words: don't repeat them, but don't be shocked. Eye-roll energy ("חח יופי, עוד משהו? 😏").
- Testing limits: show personality, not rules. They want to see if you're fun.
```

**Step 3: Add APOLOGY HUMOR rule after the out-of-scope section:**

```
APOLOGY STYLE — MANDATORY:
When you make a mistake, misunderstand, or need to correct yourself:
- NEVER: "סליחה, אני מצטערת" or "I apologize for the confusion" (robotic, corporate)
- ALWAYS: self-deprecating humor + move on. "חח סורי! 🙈", "אופס 😅", "מחזירה את עצמי לפינה 🤦‍♀️"
- Acknowledge → laugh at yourself → move on. No groveling. No over-explaining.
```

**Step 4: Mirror all prompt changes in `_shared/reply-generator.ts`**

---

### Task 2: Upgrade 1:1 onboarding prompt — same personality upgrades

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (ONBOARDING_SYSTEM_PROMPT)

**Step 1: Find `ONBOARDING_SYSTEM_PROMPT` and add to the כללים section:**

After the existing rules, add:

```
- כשמנסים לתקוף/לטרול אותך — תהיי שנונה וקצרה. אל תרגישי "נפגעת". אל תגידי "זה לא יפה". תחזירי עם הומור יבש.
- כשטועים — תתנצלי עם הומור: "חח סורי! 🙈" ולא "סליחה, אני מצטערת".
- כשמישהו שולח אימוג'י בלבד (❤️, 💪, 😂) — תחזירי אימוג'י תואם. בלי טקסט אלא אם זה מוסיף חום.
- אל תחזרי על אותן מילים או מבנים. כל תשובה צריכה להישמע שונה.
```

---

### Task 3: Pure emoji pre-detection → Sonnet reply

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (webhook handler, before Haiku classification)

**Step 1: Add emoji-only detection**

Find the section after the quick-undo check and BEFORE "STAGE 1: Haiku Classification". Add:

```typescript
    // 6d. Pure emoji messages → skip Haiku, reply with matching emoji via Sonnet
    const PURE_EMOJI = /^[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\p{Emoji_Modifier_Base}\p{Emoji_Presentation}\s]{1,10}$/u;
    if (PURE_EMOJI.test(message.text.trim()) && message.text.trim().length <= 20) {
      const replyCtx = await buildReplyCtx(householdId);
      const emojiReply = await generateEmojiReply(message.text.trim(), message.senderName, replyCtx);
      if (emojiReply) {
        await provider.sendMessage({ groupId: message.groupId, text: emojiReply });
      }
      await logMessage(message, "haiku_ignore", householdId); // Log as ignore for stats
      return new Response("OK", { status: 200 });
    }
```

**Step 2: Add `generateEmojiReply` function**

Near the other reply generation functions:

```typescript
async function generateEmojiReply(emoji: string, sender: string, ctx: ReplyContext): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 32,
        system: `You are Sheli (שלי), a warm Israeli family assistant. ${sender} just sent an emoji reaction in the family WhatsApp group. Reply with 1-3 matching emoji. No text unless it genuinely adds warmth (max 3 words). Examples: ❤️→❤️😊 | 💪→💪🔥 | 😂→😂 | 👍→👍✨ | 🙏→💕`,
        messages: [{ role: "user", content: emoji }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}
```

---

### Task 4: 1:1 Q&A → Sonnet with hints (kill static answers)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (ONBOARDING_QA array + matchOnboardingQA usage)

**Step 1: Change ONBOARDING_QA structure**

Replace the `answer` field with `topic` + `keyFacts`. For each entry:

```typescript
const ONBOARDING_QA: Array<{ patterns: RegExp[]; topic: string; keyFacts: string }> = [
  {
    patterns: [/כמה.*עול|מחיר|עלות|תשלום|חינם|בחינם|פרימיום|premium|price|cost|free/i],
    topic: "pricing",
    keyFacts: "30 actions/month free. Premium 9.90 ILS/month unlimited. No credit card for free. Add to group first to try.",
  },
  {
    patterns: [/מה את יודעת|מה את עוש|מה אפשר|יכולות|פיצ׳רים|features|what can you/i],
    topic: "capabilities",
    keyFacts: "Shopping lists (say item name), tasks (assign to person), events (date+title), voice messages (up to 30s), reminders, rotations/turns. All in the family WhatsApp group.",
  },
  {
    patterns: [/בטיחות|פרטיות|privacy|secure|קוראת.*הודעות|מקשיבה|שומרת.*מידע|data|כמה.*בטוח|זה.*בטוח|האם.*בטוח/i],
    topic: "privacy",
    keyFacts: "No photos/video stored. Voice messages transcribed then deleted. All data auto-deleted after 30 days. Only family members see data. No one outside the family, including our team.",
  },
  {
    patterns: [/לומדת|משתפר|improving|learn|חכמה יותר|מבינה יותר/i],
    topic: "learning",
    keyFacts: "Learns family nicknames, product names, time expressions. Each correction makes her smarter for that family. Personalized experience over time.",
  },
  {
    patterns: [/מי רואה|מי יכול לראות|who can see|visible|access.*data/i],
    topic: "data-access",
    keyFacts: "Only household members. Each family is completely isolated. No one — including our team — sees lists or events.",
  },
  {
    patterns: [/למחוק.*פריט|למחוק.*רשימ|לסמן.*קנית|קניתי.*איך|איך.*מוחק|איך.*מסמנ|מחיקת.*פריט|למחוק.*מטל|למחוק.*משימ|delete.*item|remove.*item|mark.*bought|mark.*done/i],
    topic: "deleting-items",
    keyFacts: "Shopping: say 'bought X' to mark, 'delete X' to remove. Tasks: say 'did X' to complete, 'delete X' to remove. Or use the app at sheli.ai to manage directly.",
  },
  {
    patterns: [/להפסיק|לצאת|לעזוב|remove|stop|cancel|unsubscribe/i, /למחוק.*(אותך|את שלי|חשבון|הכל|מידע|data)/i, /delete.*(account|bot|data|everything)/i],
    topic: "stopping",
    keyFacts: "Just remove from the group. All data auto-deleted. No commitment, no questions. Can always come back.",
  },
  {
    patterns: [/איך.*עובד|איך.*מתחיל|how.*work|how.*start/i],
    topic: "getting-started",
    keyFacts: "Save number in contacts, add to family WhatsApp group, talk normally. Sheli auto-detects shopping, tasks, events. 30 seconds to set up.",
  },
  {
    patterns: [/קבוצ.*קיימ|existing.*group|כבר.*קבוצ/i],
    topic: "existing-group",
    keyFacts: "Yes, add to any existing WhatsApp group. No need to create a new one.",
  },
  {
    patterns: [/תודה|thanks|thank you|מגניב|אחלה|סבבה|cool|great/i],
    topic: "thanks",
    keyFacts: "User is thanking or expressing appreciation. Reply warmly, encourage them to add to group.",
  },
  {
    patterns: [/שלום|היי|הי|בוקר טוב|ערב טוב|hello|hi|hey/i],
    topic: "greeting",
    keyFacts: "User is greeting. Reply warmly, ask if they have a question or ready to start.",
  },
  {
    patterns: [/הפנ|referral|הזמנ.*משפחה|משפחה מביאה|invite.*family|חודש.*חינם.*הזמנ/i],
    topic: "referral",
    keyFacts: "Family brings Family program. Each family that joins via referral = both get a free premium month. Link is in the app menu.",
  },
];
```

**Step 2: Update `matchOnboardingQA` return type**

```typescript
function matchOnboardingQA(text: string): { topic: string; keyFacts: string } | null {
  const cleaned = text.trim();
  for (const qa of ONBOARDING_QA) {
    for (const pattern of qa.patterns) {
      if (pattern.test(cleaned)) return { topic: qa.topic, keyFacts: qa.keyFacts };
    }
  }
  return null;
}
```

**Step 3: Update the Q&A usage in the 1:1 handler**

Find where `qaAnswer` is used (currently sends the static text). Change to pass topic hint to Sonnet:

```typescript
  const qaMatch = matchOnboardingQA(message.text);
  if (qaMatch) {
    if (convo.state === "welcome") {
      await supabase.from("onboarding_conversations").update({ state: "trying", updated_at: new Date().toISOString() }).eq("id", convo.id);
    }
    // Generate fresh reply via Sonnet with topic hint
    const hintedReply = await generateOnboardingReply(
      message.text, 
      senderName,
      `The user is asking about: ${qaMatch.topic}. Key facts to include: ${qaMatch.keyFacts}. Reply naturally — NEVER use the same wording twice.`
    );
    await prov.sendMessage({ groupId: message.groupId, text: hintedReply });
    console.log(`[1:1] Q&A+Sonnet for ${phone}: topic=${qaMatch.topic}`);
    return;
  }
```

**Step 4: Update `generateOnboardingReply` to accept optional hint**

Add an optional `topicHint` parameter:

```typescript
async function generateOnboardingReply(userMessage: string, senderName: string, topicHint?: string): Promise<string> {
```

If `topicHint` is provided, append it to the system prompt:

```typescript
const systemPrompt = topicHint 
  ? ONBOARDING_SYSTEM_PROMPT + `\n\nTOPIC HINT: ${topicHint}`
  : ONBOARDING_SYSTEM_PROMPT;
```

---

### Task 5: Group onboarding — first 20 messages all-Sonnet

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (routing logic)

**Step 1: Add onboarding mode check before Haiku classification**

Find `// ─── STAGE 1: Haiku Classification`. Add BEFORE it:

```typescript
    // 6e. Onboarding mode: first 20 messages in new group → all Sonnet for max quality
    const isOnboarding = config.group_message_count <= 20;
    if (isOnboarding) {
      console.log(`[Webhook] Onboarding mode: msg #${config.group_message_count} — routing to Sonnet`);
    }
```

**Step 2: After Haiku classification, if onboarding → escalate to Sonnet**

Find the medium-confidence escalation block. Add an onboarding override BEFORE it:

```typescript
    // 8b. Onboarding mode: always escalate to Sonnet for quality (first 20 msgs)
    if (isOnboarding && classification.intent !== "add_shopping") {
      // Shopping batching still uses Haiku path (it's already good)
      // Everything else → Sonnet for maximum quality during first impression
      console.log(`[Webhook] Onboarding escalation to Sonnet (msg #${config.group_message_count})`);
      const sonnetMessages = [
        ...conversationMsgs.map((m) => ({
          sender: m.sender_name,
          text: m.message_text,
          timestamp: new Date(m.created_at).getTime(),
        })),
        { sender: message.senderName, text: message.text, timestamp: message.timestamp },
      ];
      const sonnetResult = await classifyMessages(householdId, sonnetMessages);
      
      if (!sonnetResult.respond || sonnetResult.actions.length === 0) {
        if (directAddress) {
          const replyCtx = await buildReplyCtx(householdId);
          const { reply } = await generateReply(classification, message.senderName, replyCtx);
          if (reply) await provider.sendMessage({ groupId: message.groupId, text: reply });
          await logMessage(message, "direct_address_reply", householdId, classification);
          return new Response("OK", { status: 200 });
        }
        // During onboarding, even social messages get a light touch if first 5 msgs
        if (config.group_message_count <= 5 && !classification.needs_conversation_review) {
          // Skip — don't reply to every social message, just the first few
        }
        await logMessage(message, "sonnet_escalated_social", householdId);
        return new Response("OK", { status: 200 });
      }

      if (!usageOk) {
        await sendUpgradePrompt(message.groupId, householdId, config.language);
        await logMessage(message, "usage_limit_reached", householdId, classification);
        return new Response("OK", { status: 200 });
      }

      const { summary: sonnetSummary } = await executeActions(householdId, sonnetResult.actions);
      if (sonnetResult.reply) {
        await provider.sendMessage({ groupId: message.groupId, text: sonnetResult.reply });
      }
      await incrementUsage(householdId);
      await logMessage(message, "sonnet_escalated", householdId, classification);
      return new Response("OK", { status: 200 });
    }
```

---

### Task 6: Double confusion → escalate to admin

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Track consecutive confusion in the routing logic**

Find the Sonnet reply generation for direct_address_reply (where Sheli replies to someone who addressed her). Before sending the reply, check if the last bot message was also a "confusion" reply:

```typescript
    // Check for double confusion — if last bot reply was also uncertain, escalate to admin
    const recentBotMsgs = await supabase
      .from("whatsapp_messages")
      .select("message_text, classification, created_at")
      .eq("group_id", message.groupId)
      .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastBotMsg = recentBotMsgs.data?.[0];
    const lastBotWasConfused = lastBotMsg && 
      (lastBotMsg.message_text?.includes("מה הכוונה") || 
       lastBotMsg.message_text?.includes("אפשר לפרט") ||
       lastBotMsg.message_text?.includes("לא הבנתי")) &&
      new Date(lastBotMsg.created_at).getTime() > Date.now() - 5 * 60 * 1000;

    if (lastBotWasConfused) {
      // Double confusion — escalate to admin
      await provider.sendMessage({ 
        groupId: message.groupId, 
        text: "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️" 
      });
      await notifyAdmin(
        `Double confusion in ${config.household_id}`,
        `User ${message.senderName}: "${message.text}"\nPrevious bot reply: "${lastBotMsg.message_text}"`
      );
      await logMessage(message, "direct_address_reply", householdId, classification);
      return new Response("OK", { status: 200 });
    }
```

Place this check in BOTH direct_address_reply code paths (high-confidence ignore + low-confidence).

---

### Task 7: Anti-repetition — inject recent bot replies

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (buildReplyPrompt)

**Step 1: Fetch recent bot replies in buildReplyCtx**

In `buildReplyCtx`, add a query for the bot's recent messages:

```typescript
    supabase.from("whatsapp_messages")
      .select("message_text")
      .eq("household_id", householdId)
      .eq("sender_phone", Deno.env.get("BOT_PHONE_NUMBER") || "972555175553")
      .not("message_text", "is", null)
      .order("created_at", { ascending: false })
      .limit(5),
```

Add to the return object: `recentBotReplies: (botMsgsRes.data || []).map(m => m.message_text)`

**Step 2: Add anti-repetition section to buildReplyPrompt**

After the action summary, before the final instruction:

```typescript
  // Anti-repetition
  const recentReplies = ctx.recentBotReplies || [];
  const antiRepetition = recentReplies.length > 0
    ? `\nYOUR RECENT REPLIES (do NOT repeat these patterns — vary your style):\n${recentReplies.map(r => `- "${r?.slice(0, 80)}"`).join("\n")}\n\nANTI-REPETITION: Never use the same opening word, emoji pattern, or sentence structure as your recent replies. Each reply must feel fresh.`
    : "";
```

Add `${antiRepetition}` to the prompt string.

**Step 3: Update ReplyContext interface** to include `recentBotReplies?: string[]`.

---

### Task 8: Back-off detection ("אל תתערבי")

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (pre-classifier section)

**Step 1: Add back-off keyword pattern**

Near the UNDO_KEYWORDS and CONFIRM patterns:

```typescript
const BACK_OFF_KEYWORDS = /אל תתערבי|לא דיברתי אליך|עזבי|תתנתקי|לא בשבילך|שקט שלי|אל תתערב|לא פנו אליך/i;
```

**Step 2: Add back-off check after the pending confirmation check**

```typescript
    // 6b2. Back-off detection — "don't get involved"
    if (BACK_OFF_KEYWORDS.test(message.text.trim())) {
      // Try to undo last bot action
      const lastAction = await getLastBotAction(message.groupId, householdId);
      if (lastAction) {
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        if (new Date(lastAction.created_at).getTime() > fiveMinAgo) {
          await undoLastAction(householdId, lastAction.classification_data);
        }
      }
      
      // Also reject any pending confirmation
      await supabase.from("pending_confirmations")
        .update({ status: "rejected" })
        .eq("group_id", message.groupId)
        .eq("status", "pending");
      
      // Log back-off preference to household patterns
      await supabase.from("household_patterns").upsert({
        household_id: householdId,
        pattern_type: "back_off",
        pattern_key: "conversation_sensitivity",
        pattern_value: "high — family prefers bot only responds when directly addressed or clearly requested",
        confidence: 0.8,
        hit_count: 1,
      }, { onConflict: "household_id,pattern_type,pattern_key" });

      await provider.sendMessage({ 
        groupId: message.groupId, 
        text: "חח סורי! 🙈 לא התכוונתי להתערב. מחזירה את עצמי לפינה 😅" 
      });
      await logMessage(message, "haiku_ignore", householdId);
      return new Response("OK", { status: 200 });
    }
```

---

### Task 9: Fix reminder format — natural Hebrew, ungendered

**Files:**
- DB function via Supabase MCP

**Step 1: Update `fire_due_reminders` SQL function**

```sql
CREATE OR REPLACE FUNCTION fire_due_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r RECORD;
  msg_body TEXT;
  display_name TEXT;
  request_id BIGINT;
BEGIN
  FOR r IN
    SELECT id, group_id, message_text, created_by_name, created_by_phone, send_at, household_id
    FROM reminder_queue
    WHERE sent = false
      AND send_at <= now()
      AND send_at > now() - INTERVAL '24 hours'
    ORDER BY send_at ASC
    LIMIT 10
  LOOP
    -- Try to get first name from household_members (cleaner than WhatsApp display name)
    display_name := NULL;
    IF r.created_by_phone IS NOT NULL THEN
      SELECT split_part(hm.display_name, ' ', 1) INTO display_name
      FROM household_members hm
      JOIN whatsapp_member_mapping wmm ON wmm.household_id = hm.household_id 
        AND wmm.member_name = hm.display_name
      WHERE wmm.phone = r.created_by_phone
      LIMIT 1;
    END IF;
    -- Fallback to stored name (first word only)
    IF display_name IS NULL AND r.created_by_name IS NOT NULL THEN
      display_name := split_part(r.created_by_name, ' ', 1);
    END IF;

    -- Build message: "⏰ תזכורת מ{name}: {text}"
    msg_body := '⏰ תזכורת';
    IF display_name IS NOT NULL AND display_name != '' THEN
      msg_body := msg_body || ' מ' || display_name;
    END IF;
    msg_body := msg_body || ': ' || r.message_text;

    -- Send via Whapi using pg_net
    SELECT net.http_post(
      url := 'https://gate.whapi.cloud/messages/text',
      headers := '{"Authorization": "Bearer aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m", "Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'to', r.group_id,
        'body', msg_body
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

New format: `⏰ תזכורת מרועי: לעומרי לפנות מדיח` — clean, natural, ungendered.

---

## Execution Dependencies

```
Task 1 (Sonnet prompt)      ─── independent
Task 2 (1:1 prompt)         ─── independent
Task 3 (emoji pre-detect)   ─── independent
Task 4 (Q&A → Sonnet hints) ─── independent
Task 5 (onboarding mode)    ─── independent
Task 6 (double confusion)   ─── independent
Task 7 (anti-repetition)    ─── independent
Task 8 (back-off)           ─── independent
Task 9 (reminder format)    ─── independent (SQL only)

All tasks modify index.inlined.ts but different sections — can be done sequentially by one agent.
```
