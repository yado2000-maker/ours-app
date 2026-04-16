# Bot Reply Logging + Reaction Confirmations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Log all bot replies to DB with message IDs, and route WhatsApp emoji reactions as confirmations/feedback with conversation context for Haiku+Sonnet.

**Architecture:** Wrapper function `sendAndLog` replaces 46 direct `sendMessage` calls. Reaction events intercepted before the `type !== "text"` gate and matched against bot message IDs in `whatsapp_messages`. Reactions appear in conversation history for Haiku/Sonnet context.

**Tech Stack:** Supabase Edge Function (Deno/TypeScript), Supabase Postgres, Whapi.Cloud API

**Design doc:** `docs/plans/2026-04-16-bot-reply-logging-reactions-design.md`

---

### Task 1: DB Migration — Add columns

**Files:**
- Migration via Supabase MCP tool

**Step 1: Add `in_reply_to` to `whatsapp_messages`**

```sql
ALTER TABLE whatsapp_messages ADD COLUMN in_reply_to TEXT;
COMMENT ON COLUMN whatsapp_messages.in_reply_to IS 'whatsapp_message_id of the user message this bot reply responds to';
```

**Step 2: Add `bot_message_id` to `pending_confirmations`**

```sql
ALTER TABLE pending_confirmations ADD COLUMN bot_message_id TEXT;
COMMENT ON COLUMN pending_confirmations.bot_message_id IS 'Whapi message ID of bot clarification question, used for reaction matching';
```

**Step 3: Verify columns exist**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name IN ('whatsapp_messages', 'pending_confirmations')
AND column_name IN ('in_reply_to', 'bot_message_id');
```

Expected: 2 rows, both TEXT, nullable.

**Step 4: Commit**

```bash
git commit --allow-empty -m "chore: DB migration — add in_reply_to and bot_message_id columns"
```

---

### Task 2: `SendResult` interface + `sendMessage` return type

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:64-71` (WhatsAppProvider interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:344-362` (WhapiProvider.sendMessage)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:435-458` (MetaCloudProvider.sendMessage)

**Step 1: Add `SendResult` interface (after line 62)**

Find the `WhatsAppProvider` interface block and add `SendResult` above it:

```ts
interface SendResult {
  ok: boolean;
  messageId?: string;
}
```

**Step 2: Update `WhatsAppProvider` interface (line 69)**

Change:
```ts
sendMessage(msg: OutgoingMessage): Promise<boolean>;
```
To:
```ts
sendMessage(msg: OutgoingMessage): Promise<SendResult>;
```

**Step 3: Update `WhapiProvider.sendMessage` (lines 344-362)**

Replace the method body:
```ts
async sendMessage(msg: OutgoingMessage): Promise<SendResult> {
  try {
    const res = await fetch(`${this.apiUrl}/messages/text`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: msg.groupId,
        body: msg.text,
      }),
    });
    if (!res.ok) return { ok: false };
    try {
      const data = await res.json();
      return { ok: true, messageId: data?.message?.id || data?.sent?.id };
    } catch {
      return { ok: true }; // Sent but couldn't parse response
    }
  } catch (err) {
    console.error("[WhapiProvider] Send error:", err);
    return { ok: false };
  }
}
```

Note: Whapi response format isn't fully documented. We parse `data.message.id` (most likely) with `data.sent.id` fallback. If neither works, the first deploy's console logs will show the actual shape — adjust the path then. The wrapper still works (messageId is just undefined).

**Step 4: Update `MetaCloudProvider.sendMessage` (lines 435-458)**

Replace the method body:
```ts
async sendMessage(msg: OutgoingMessage): Promise<SendResult> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: msg.groupId,
          type: "text",
          text: { body: msg.text },
        }),
      }
    );
    if (!res.ok) return { ok: false };
    try {
      const data = await res.json();
      return { ok: true, messageId: data?.messages?.[0]?.id };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    console.error("[MetaCloudProvider] Send error:", err);
    return { ok: false };
  }
}
```

**Step 5: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

Expected: No errors.

**Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "refactor: sendMessage returns SendResult with messageId"
```

---

### Task 3: `sendAndLog` wrapper function

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — add function after `logMessage` (~line 5882)

**Step 1: Add `sendAndLog` function**

Insert after the `logMessage` function (after line 5882):

```ts
// ─── Bot Reply Logger (wraps sendMessage) ───

async function sendAndLog(
  prov: WhatsAppProvider,
  msg: OutgoingMessage,
  ctx: {
    householdId?: string;
    groupId: string;
    inReplyTo?: string;
    replyType?: string;
  }
): Promise<SendResult> {
  const result = await prov.sendMessage(msg);

  // Fire-and-forget — don't block the reply path
  const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
  supabase.from("whatsapp_messages").insert({
    household_id: ctx.householdId || "unknown",
    group_id: ctx.groupId,
    sender_phone: botPhone,
    sender_name: "שלי",
    message_text: msg.text,
    message_type: "text",
    whatsapp_message_id: result.messageId || null,
    classification: ctx.replyType || "bot_reply",
    ai_responded: true,
    in_reply_to: ctx.inReplyTo || null,
  }).then(({ error }) => {
    if (error) console.error("[sendAndLog] DB error:", error.message);
  });

  return result;
}
```

**Step 2: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: add sendAndLog wrapper for bot reply logging"
```

---

### Task 4: Replace all `sendMessage` call sites with `sendAndLog`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — all 46 call sites

This is a mechanical replacement. Each call site follows one of these patterns:

**Pattern A — Group handler with `message` in scope (most common, ~30 sites):**
```ts
// Before:
await provider.sendMessage({ groupId: message.groupId, text: reply });

// After:
await sendAndLog(provider, { groupId: message.groupId, text: reply }, {
  householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "ACTION_TYPE"
});
```

**Pattern B — 1:1 handler with `prov` variable (~8 sites):**
```ts
// Before:
await prov.sendMessage({ groupId: message.groupId, text: reply });

// After:
await sendAndLog(prov, { groupId: message.groupId, text: reply }, {
  householdId: convo?.household_id, groupId: message.groupId, inReplyTo: message.messageId, replyType: "direct_reply"
});
```

**Pattern C — Group management / no `message` object (~6 sites, e.g. INTRO_MESSAGE):**
```ts
// Before:
await provider.sendMessage({ groupId, text: INTRO_MESSAGE });

// After:
await sendAndLog(provider, { groupId, text: INTRO_MESSAGE }, {
  householdId: householdId || "unknown", groupId, replyType: "group_mgmt"
});
```

**Pattern D — Pending confirmation insert (line ~5401) — capture messageId:**
```ts
// Before:
if (cleanReply) {
  await provider.sendMessage({ groupId: message.groupId, text: cleanReply });
}

// After:
let confBotMsgId: string | undefined;
if (cleanReply) {
  const sendResult = await sendAndLog(provider, { groupId: message.groupId, text: cleanReply }, {
    householdId, groupId: message.groupId, inReplyTo: message.messageId, replyType: "confirmation_ask"
  });
  confBotMsgId = sendResult.messageId;
}
```

Then update the `pending_confirmations` insert (line ~5389) to include:
```ts
bot_message_id: confBotMsgId || null,
```

**Step 1: Replace all call sites**

Use the following `replyType` labels per context:

| Context | replyType |
|---------|-----------|
| Action execution reply (add_task, add_shopping, etc.) | `"action_reply"` |
| Sonnet escalation reply | `"sonnet_escalated_reply"` |
| Direct address reply | `"direct_address_reply"` |
| instruct_bot confirmation ask | `"confirmation_ask"` |
| Confirmation accepted | `"confirmation_accept"` |
| Confirmation rejected | `"confirmation_reject"` |
| Quick undo ("בוטל") | `"quick_undo_reply"` |
| Back-off ("חח סורי!") | `"back_off_reply"` |
| Pure emoji reaction reply | `"emoji_reaction"` |
| 1:1 direct message reply | `"direct_reply"` |
| 1:1 onboarding (welcome, state replies) | `"onboarding_reply"` |
| Group management (INTRO_MESSAGE, post-group msg) | `"group_mgmt"` |
| Dashboard link / referral / soft warning | `"nudge"` |
| Error fallback ("אופס") | `"error_fallback"` |
| Shopping batch reply | `"batch_reply"` |
| Long voice message text reply | `"long_voice_reply"` |
| Dedup reply ("👍 כבר ברשימה") | `"dedup_reply"` |
| Clarification ("מה רצית?") | `"clarification"` |

**Step 2: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 3: Verify no remaining raw sendMessage calls (except the 2 provider implementations)**

```bash
grep -n "sendMessage(" supabase/functions/whatsapp-webhook/index.inlined.ts | grep -v "sendAndLog" | grep -v "async sendMessage" | grep -v "interface"
```

Expected: Only the 2 method definitions in WhapiProvider and MetaCloudProvider, plus the 1 call inside `sendAndLog` itself. No direct calls from handler code.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: replace 46 sendMessage calls with sendAndLog wrapper"
```

---

### Task 5: Parse reaction data in `parseMessage()`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:35-48` (IncomingMessage interface)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:265-297` (parseMessage body)

**Step 1: Add reaction fields to `IncomingMessage` (after line 47)**

```ts
reactionEmoji?: string;      // emoji used in reaction ("👍", "❤️", etc.)
reactionTargetId?: string;   // whatsapp_message_id of the message being reacted to
```

**Step 2: Extract reaction data in parseMessage (after line 269, media extraction)**

```ts
// Extract reaction info (for reaction-type messages)
const reactionData = msg.reaction as Record<string, unknown> | undefined;
const reactionEmoji = (reactionData?.emoji as string | undefined) || undefined;
// Whapi reaction target: try msg_id, then message_id, then id — format is underdocumented
const reactionTargetId = (reactionData?.msg_id as string | undefined)
  || (reactionData?.message_id as string | undefined)
  || undefined;

// DEBUG: Log raw reaction payload on first encounters to confirm field names
if (type === "reaction") {
  console.log(`[WhapiProvider] Reaction payload:`, JSON.stringify(msg.reaction || msg));
}
```

**Step 3: Add to the return object (line ~284-297)**

Add after `quotedText`:
```ts
reactionEmoji: reactionEmoji || undefined,
reactionTargetId: reactionTargetId || undefined,
```

**Step 4: Run esbuild parse check**

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: parse reaction emoji + target message ID from Whapi payload"
```

---

### Task 6: Reaction routing — intercept before type gate

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:4649-4654` — add reaction handler block BEFORE the `type !== "text"` gate

**Step 1: Add reaction handler block**

Insert BEFORE line 4649 (`// 3b. Skip all non-text/non-voice messages`). This must be AFTER household resolution (so `householdId` is available) but BEFORE the type gate.

```ts
    // 3a-reaction. Handle emoji reactions to Sheli's messages
    if (message.type === "reaction" && message.reactionEmoji && message.reactionTargetId) {
      const CONFIRM_EMOJI = /^(👍|💪|✅|👌|❤️|🔥)$/;
      const WRONG_EMOJI = /^(😂|😤|👎|❌|🤦|🤦‍♀️|🤦‍♂️|😡)$/;

      // Step 1: Is this a reaction to a Sheli message?
      const botPhone = Deno.env.get("BOT_PHONE_NUMBER") || "972555175553";
      const { data: botMsg } = await supabase
        .from("whatsapp_messages")
        .select("id, whatsapp_message_id, classification, message_text, household_id")
        .eq("whatsapp_message_id", message.reactionTargetId)
        .eq("sender_phone", botPhone)
        .maybeSingle();

      if (!botMsg) {
        // Reaction to someone else's message — social noise, skip silently
        return new Response("OK", { status: 200 });
      }

      const hhId = botMsg.household_id || householdId || "unknown";
      const isConfirm = CONFIRM_EMOJI.test(message.reactionEmoji);
      const isWrong = WRONG_EMOJI.test(message.reactionEmoji);

      if (!isConfirm && !isWrong) {
        // Unrecognized emoji on Sheli's message — skip
        return new Response("OK", { status: 200 });
      }

      // Step 2: Check for pending confirmation targeting this bot message
      const { data: pending } = await supabase
        .from("pending_confirmations")
        .select("id, action_type, action_data")
        .eq("bot_message_id", message.reactionTargetId)
        .eq("status", "pending")
        .maybeSingle();

      if (pending) {
        if (isConfirm) {
          const actions = [{ type: pending.action_type, data: pending.action_data }];
          const { summary } = await executeActions(hhId, actions, message.senderName);
          console.log(`[Reaction] Confirmed via ${message.reactionEmoji}:`, summary);
          await supabase.from("pending_confirmations")
            .update({ status: "confirmed" }).eq("id", pending.id);
          await sendAndLog(provider,
            { groupId: message.groupId, text: "מעולה, סידרתי! ✓" },
            { householdId: hhId, groupId: message.groupId, replyType: "confirmation_accept_reaction" });
          await logMessage(message, "reaction_confirmed", hhId);
        } else {
          await supabase.from("pending_confirmations")
            .update({ status: "rejected" }).eq("id", pending.id);
          await sendAndLog(provider,
            { groupId: message.groupId, text: "אוקי, ביטלתי 🤷‍♀️" },
            { householdId: hhId, groupId: message.groupId, replyType: "confirmation_reject_reaction" });
          await logMessage(message, "reaction_rejected", hhId);
        }
        return new Response("OK", { status: 200 });
      }

      // Step 3: No pending confirmation — log as feedback on Sheli's message
      if (isConfirm) {
        console.log(`[Reaction] Positive ${message.reactionEmoji} from ${message.senderName} on: "${botMsg.message_text?.slice(0, 60)}"`);
        await logMessage(message, "reaction_positive", hhId);
      } else {
        console.log(`[Reaction] Negative ${message.reactionEmoji} from ${message.senderName} on: "${botMsg.message_text?.slice(0, 60)}"`);
        await logMessage(message, "reaction_negative", hhId);
        // Store as correction signal for Stream B learning
        supabase.from("classification_corrections").insert({
          household_id: hhId,
          correction_type: "reaction_negative",
          original_data: {
            bot_message_text: botMsg.message_text,
            bot_classification: botMsg.classification,
            reaction_emoji: message.reactionEmoji,
            reactor_name: message.senderName,
          },
        }).then(({ error }) => {
          if (error) console.error("[Reaction] correction log error:", error.message);
        });
      }
      return new Response("OK", { status: 200 });
    }
```

**Important positioning note:** This block must go AFTER:
- Bot's own message skip (line ~4568: `if (senderPhone === botPhone)`)
- Household resolution (line ~4760: `const householdId = ...`)
- Direct address detection (line ~4800)

But BEFORE:
- The `type !== "text"` gate (line 4650)

The exact insertion point is right before line 4649's comment `// 3b. Skip all non-text/non-voice messages`.

**Step 2: Update the existing `type !== "text"` gate to exclude reactions (they're now handled above)**

The existing gate at line 4650 stays as-is — reactions never reach it because the block above returns early.

**Step 3: Run esbuild parse check**

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: route emoji reactions as confirmations/feedback on Sheli messages"
```

---

### Task 7: Reactions in conversation context

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:1921-1963` (fetchRecentConversation)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:5007-5018` (conversation history formatter)

**Step 1: Add `classification` and `in_reply_to` to fetchRecentConversation select**

At lines 1929 and 1937, change:
```ts
.select("id, sender_name, message_text, created_at")
```
To:
```ts
.select("id, sender_name, message_text, created_at, classification, in_reply_to")
```

Both queries (byTime and byCount) need this change.

**Step 2: Update return type**

At line 1924, change:
```ts
): Promise<Array<{ sender_name: string; message_text: string; created_at: string }>> {
```
To:
```ts
): Promise<Array<{ sender_name: string; message_text: string; created_at: string; classification?: string; in_reply_to?: string }>> {
```

At line 1959-1963, add classification and in_reply_to to the return map:
```ts
.map((m: any) => ({
  sender_name: m.sender_name || "?",
  message_text: m.message_text,
  created_at: m.created_at,
  classification: m.classification || undefined,
  in_reply_to: m.in_reply_to || undefined,
}));
```

**Step 3: Format reactions differently in the conversation history builder (lines 5007-5018)**

Replace the `.map()` formatter:
```ts
const conversationHistory = conversationMsgs.length > 0
  ? conversationMsgs.map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jerusalem",
      });
      const safeName = (m.sender_name || "?").replace(/[\x00-\x1f\x7f\[\]{}]/g, "").slice(0, 50);
      const safeText = (m.message_text || "").slice(0, 500);

      // Format reactions to Sheli's messages distinctly
      if (m.classification === "reaction_positive" || m.classification === "reaction_negative") {
        // message_text is the emoji, find the bot message it reacted to
        const emoji = safeText;
        // Look up the bot message text from the same conversation window
        const targetMsg = conversationMsgs.find(
          (t) => t.classification?.startsWith("bot_") || t.classification?.endsWith("_reply")
        );
        const botText = targetMsg?.message_text?.slice(0, 60) || "(הודעה קודמת)";
        const sentiment = m.classification === "reaction_positive" ? "👍" : "👎";
        return `[${time} ${safeName} reacted ${emoji} to שלי: "${botText}"]`;
      }

      return `[${time} ${safeName}]: ${safeText}`;
    }).join("\n")
  : undefined;
```

**Step 4: Add prompt guidance for Haiku**

In the `buildHaikuClassifierPrompt` function (around line 525, in the rules section near line 623), add after the "Greetings, emojis, reactions" line:

```
- When conversation history shows a NEGATIVE REACTION (😂/🤦/👎) to Sheli's previous message, the NEXT user message is likely a correction or clarification. Lean toward correct_bot or re-classify with higher attention.
```

**Step 5: Add prompt guidance for Sonnet**

In the `buildReplyPrompt` function (in the Sonnet prompt text, near the GROUNDING rules section around line 1720), add:

```
- If recent conversation history shows someone reacted negatively (😂/🤦/👎) to your last message, acknowledge gracefully ("אופס" / "סליחה, פספסתי") and ask for clarification. Don't repeat the same action.
```

**Step 6: Run esbuild parse check**

**Step 7: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat: include reactions in conversation context for Haiku+Sonnet"
```

---

### Task 8: Integration test + esbuild verify + deploy

**Files:**
- Modify: `tests/test_webhook.py` — add 2-3 reaction test cases
- Deploy: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add reaction test cases to test_webhook.py**

Add to the test cases array:

```python
# Reaction tests (these test the logging, not the full reaction flow,
# since we can't simulate Whapi reaction payloads through the test harness)
{
    "name": "bot_reply_logged",
    "description": "Verify bot replies appear in whatsapp_messages after an action",
    "message": "תוסיפי חלב",
    "sender": "TestUser",
    "expected_intent": "add_shopping",
    "db_check": lambda: check_bot_reply_exists("חלב"),
},
```

Where `check_bot_reply_exists` queries:
```python
def check_bot_reply_exists(keyword):
    """Check that a bot reply containing keyword was logged"""
    result = supabase.table("whatsapp_messages") \
        .select("message_text, ai_responded, classification") \
        .eq("sender_phone", "972555175553") \
        .eq("ai_responded", True) \
        .ilike("message_text", f"%{keyword}%") \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()
    return len(result.data) > 0
```

**Step 2: Run full esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 3: Run existing test suite to verify no regressions**

```bash
python tests/test_webhook.py
```

Expected: 44-47 of 47+ tests pass (existing flaky tests from LLM non-determinism are acceptable).

**Step 4: Deploy**

Deploy via Supabase Dashboard:
1. Open `index.inlined.ts` in Cursor/VS Code
2. Ctrl+A, Ctrl+C
3. Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab → paste → Deploy
4. Verify JWT = OFF

**Step 5: Smoke test — send a message to the bot and verify bot reply is logged**

```sql
SELECT sender_phone, sender_name, message_text, classification, ai_responded, whatsapp_message_id, in_reply_to
FROM whatsapp_messages
WHERE sender_phone = '972555175553'
ORDER BY created_at DESC
LIMIT 5;
```

Expected: Bot replies appear with `ai_responded = true`, `classification` matching the `replyType`, and `whatsapp_message_id` populated (or null if Whapi response parsing needs adjustment).

**Step 6: Verify reaction payload shape (first reaction from any user)**

After deploy, have someone react 👍 to a Sheli message in any group. Check Edge Function logs for:
```
[WhapiProvider] Reaction payload: {...}
```

If the field names differ from `msg.reaction.emoji` / `msg.reaction.msg_id`, update Task 5's extraction code accordingly.

**Step 7: Commit test changes**

```bash
git add tests/test_webhook.py
git commit -m "test: add bot reply logging verification to integration tests"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (ours-app)

**Step 1: Add to WhatsApp Bot Gotchas section:**

```
- **Bot replies logged to DB** — All `sendMessage` calls go through `sendAndLog()` wrapper. Bot messages stored in `whatsapp_messages` with `sender_phone = BOT_PHONE`, `ai_responded = true`, and `in_reply_to` linking to the triggering user message. `replyType` labels: action_reply, confirmation_ask/accept/reject, direct_reply, nudge, error_fallback, etc.
- **Emoji reactions routed** — 👍💪✅👌❤️🔥 = confirm (execute pending action or log positive feedback). 😂😤👎❌🤦😡 = wrong (reject pending action or log negative feedback to classification_corrections). All other emoji on Sheli messages = skip. Reactions on non-Sheli messages = skip (social noise).
- **`sendMessage` returns `SendResult`** — `{ ok: boolean, messageId?: string }`. Whapi message ID parsed from response. Used for `pending_confirmations.bot_message_id` (reaction matching).
```

**Step 2: Remove from TODO section:**

Remove the `Handle 👍 emoji reactions as confirmations` TODO item.

**Step 3: Add to classification values:**

Add to the "Classification values in `whatsapp_messages.classification`" list:
```
`bot_reply`, `reaction_positive`, `reaction_negative`, `reaction_confirmed`, `reaction_rejected`, `skipped_reaction`, `confirmation_accept_reaction`, `confirmation_reject_reaction`
```

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with bot reply logging + reaction routing"
```
