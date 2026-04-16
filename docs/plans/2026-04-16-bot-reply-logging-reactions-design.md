# Bot Reply Logging + Reaction Confirmations — Design

**Date:** 2026-04-16  
**Status:** Approved  
**Scope:** WhatsApp bot (`index.inlined.ts`), DB migration, no frontend changes

## Problem

Two related gaps in the WhatsApp bot:

1. **Bot replies are never logged to DB.** `whatsapp_messages.ai_responded` is never set to `true`. The reply text Sheli sent is not stored anywhere. `sendMessage()` returns `boolean`, discarding Whapi's response message ID. Debugging "Sheli went silent" bugs requires inference from classification data alone — we can't see what she actually said.

2. **👍 emoji reactions are silently dropped.** WhatsApp reaction events (`type: "reaction"`) are killed at the `type !== "text"` gate (line 4650). When Sheli asks a clarifying question and the user reacts 👍, nothing happens. More broadly, reactions to ANY Sheli message are valuable user feedback (positive or negative) that we're throwing away.

Both fixes share the same foundation: `sendMessage` must return message IDs, and bot replies must be stored in DB so reactions can be matched to them.

## Approach

**Wrapper function (Approach A):** Replace all 46 `provider.sendMessage()` call sites with a `sendAndLog()` wrapper that sends + logs in one step. Complete audit trail, zero maintenance burden when adding new reply paths.

## Design

### 1. `sendMessage` return type

```ts
// Before
async sendMessage(msg: OutgoingMessage): Promise<boolean>

// After
interface SendResult { ok: boolean; messageId?: string }
async sendMessage(msg: OutgoingMessage): Promise<SendResult>
```

Both `WhapiProvider` and `MetaCloudProvider` parse the response body to extract the sent message ID:
- Whapi: `data.message.id` from `POST /messages/text` response
- Meta: `data.messages[0].id` from Graph API response

### 2. `sendAndLog` wrapper

```ts
async function sendAndLog(
  provider: WhatsAppProvider,
  msg: OutgoingMessage,
  context: {
    householdId?: string;
    groupId: string;
    inReplyTo?: string;      // whatsapp_message_id of the triggering user message
    replyType?: string;       // "action_reply", "confirmation_accept", "nudge", "error", etc.
  }
): Promise<SendResult>
```

- Calls `provider.sendMessage()`, gets `{ ok, messageId }`.
- **Fire-and-forget** DB insert into `whatsapp_messages` with `sender_phone = BOT_PHONE`, `sender_name = "שלי"`, `ai_responded = true`, the reply text, the Whapi message ID, and `in_reply_to` linking to the user message.
- Fire-and-forget pattern (`.then()`, not `await`) — doesn't add latency to the reply path.
- Returns `SendResult` so callers that need the message ID (pending confirmations) can destructure it.

All 46 `provider.sendMessage()` / `prov.sendMessage()` call sites change to `sendAndLog()`. This is mechanical find-and-replace — the `context` parameter varies per call site but follows clear patterns:
- Action replies: `replyType: "action_reply"`
- Pending confirmation ask: `replyType: "confirmation_ask"`
- Confirmation accept/reject: `replyType: "confirmation_accept"` / `"confirmation_reject"`
- Nudges/dashboard links: `replyType: "nudge"`
- Error fallbacks: `replyType: "error_fallback"`
- Emoji reactions: `replyType: "emoji_reaction"`
- 1:1 replies: `replyType: "direct_reply"`
- Group management (intro, welcome): `replyType: "group_mgmt"`

### 3. DB migration

**`whatsapp_messages` — add column:**
```sql
ALTER TABLE whatsapp_messages ADD COLUMN in_reply_to TEXT;
```
Links bot reply → user message that triggered it. Enables conversation threading queries.

**`pending_confirmations` — add column:**
```sql
ALTER TABLE pending_confirmations ADD COLUMN bot_message_id TEXT;
```
Stores the Whapi message ID of the bot's clarification question. Join key for reaction matching.

Both nullable, backward compatible. No RLS changes (service_role-only tables).

### 4. Reaction routing

New block before the `type !== "text"` gate (line 4650), after household resolution.

**Three emoji categories:**

| Category | Emoji | On pending confirmation | On any other Sheli message |
|----------|-------|------------------------|---------------------------|
| Confirm | 👍💪✅👌❤️🔥 | Execute the action | Log `reaction_positive` |
| Wrong | 😂😤👎❌🤦🤦‍♀️🤦‍♂️😡 | Reject the action | Log `reaction_negative` + flag for learning |
| Noise | everything else | Skip | Skip |

**Flow:**
```
Reaction arrives →
  1. Is target a Sheli message? (lookup whatsapp_messages by whatsapp_message_id + sender_phone = BOT)
     NO → skip (social noise)
     YES ↓
  2. Pending confirmation matching bot_message_id?
     YES + confirm → execute action, reply "מעולה, סידרתי! ✓"
     YES + wrong   → reject action, reply "אוקי, ביטלתי 🤷‍♀️"
     NO ↓
  3. Log feedback:
     confirm → logMessage "reaction_positive"
     wrong   → logMessage "reaction_negative" + insert classification_corrections
              (correction_type: "reaction_negative", original_data: bot message text + classification + emoji + reactor name)
```

**Parse reaction data in `parseMessage()`:**

New fields on `IncomingMessage`:
```ts
reactionEmoji?: string;      // "👍", "❤️", etc.
reactionTargetId?: string;   // whatsapp_message_id of the message being reacted to
```

Extracted from Whapi payload: `msg.reaction.emoji`, `msg.reaction.msg_id`.

**Why 😂 = wrong:** When Sheli adds "תחתונים" to the shopping list and someone reacts 😂, that's laughing AT Sheli — she misunderstood. Same correction energy as 🤦. Logged to `classification_corrections` for Stream B learning.

**Zero AI cost:** Pure DB lookup, no Haiku/Sonnet calls for reaction handling.

### 5. Reactions in conversation context

Reactions logged to `whatsapp_messages` appear in the conversation history window that Haiku and Sonnet see.

**Formatting in history:**
```
[Shira reacted 👍 to שלי: "הוספתי חלב וביצים לרשימה"]
[Daniel reacted 😂 to שלי: "הזכרתי לכם — תור רופא מחר ב-10"]
```

The `in_reply_to` field links reaction → bot message. The history formatter branches on `classification === "reaction_positive" || "reaction_negative"` and fetches the bot message text (joined from the query or stored inline).

**Prompt additions:**

Haiku classifier prompt (rules section):
```
- When conversation history shows a negative reaction (😂/🤦/👎) to Sheli's previous message,
  the NEXT user message is likely a correction or clarification. Lean toward correct_bot or
  re-classify with higher attention.
```

Sonnet reply prompt:
```
- If recent history shows someone reacted negatively to your last message, acknowledge gracefully
  ("אופס" / "סליחה") and ask for clarification. Don't repeat the same action.
```

**No extra query:** Reactions are in the same `whatsapp_messages` table that conversation history already queries. They appear in the result set naturally within the existing LIMIT.

## Classification values (new)

Added to `whatsapp_messages.classification`:
- `bot_reply` — default for all bot outgoing messages
- `reaction_positive` — confirm-category emoji on a Sheli message
- `reaction_negative` — wrong-category emoji on a Sheli message
- `reaction_confirmed` — confirm emoji on a pending confirmation → action executed
- `reaction_rejected` — wrong emoji on a pending confirmation → action rejected
- `skipped_reaction` — reaction to a non-Sheli message (social noise)
- `confirmation_accept_reaction` — (replyType on bot's "מעולה, סידרתי!" reply)
- `confirmation_reject_reaction` — (replyType on bot's "אוקי, ביטלתי" reply)

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Whapi reaction payload shape unknown (no docs found) | First deploy: log raw `msg.reaction` JSON to console. Adjust field names if needed. Add `--dry-run` test path. |
| 46 call site changes = large diff | Mechanical find-and-replace. Each change is identical pattern. Code review can verify with regex. |
| Fire-and-forget DB insert could silently fail | `.then()` logs errors to console. Not blocking — reply still reaches user. Admin notification on repeated failures. |
| 😂 on a genuinely funny Sheli reply = false negative signal | Low risk — Sheli rarely makes jokes. If it becomes noisy, add a time window (only flag 😂 within 60s of a bot action, not on social replies). |
| DB write volume doubles (bot replies now logged) | ~50 bot replies/day across all households. Negligible vs. 1,297 existing rows. |

## Non-goals

- **Threaded reply UI in web app** — bot replies in DB enable this later, but not in this scope.
- **Reaction analytics dashboard** — `classification_corrections` with `reaction_negative` is queryable for Stream B learning, but no admin UI now.
- **Reaction to non-bot messages as signal** — only reactions to Sheli's messages are captured. Reactions between family members remain invisible (social noise).
