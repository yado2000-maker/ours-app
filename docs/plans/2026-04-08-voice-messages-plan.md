# Voice Message Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Sheli transcribe short (<=30s) WhatsApp voice messages via Groq Whisper and process them through the existing Haiku→Sonnet classification pipeline, identical to typed text.

**Architecture:** Voice messages are intercepted before the existing "skip non-text" guard. Audio is downloaded from Whapi's media URL, sent to Groq Whisper API for Hebrew transcription, and the resulting text is injected into `message.text` — from that point the entire existing pipeline runs unchanged.

**Tech Stack:** Groq Whisper API (`whisper-large-v3`), Deno `fetch` + `FormData`, Supabase Edge Functions

**Design doc:** `docs/plans/2026-04-07-voice-messages-design.md`

---

### Task 1: Extend IncomingMessage interface

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:35-44`
- Modify: `supabase/functions/_shared/whatsapp-provider.ts:4-13`

**Step 1: Add mediaUrl and mediaDuration to IncomingMessage in inlined file**

In `index.inlined.ts` at line 35, the interface is:
```typescript
interface IncomingMessage {
  messageId: string;
  groupId: string;
  senderPhone: string;
  senderName: string;
  text: string;
  type: "text" | "image" | "sticker" | "voice" | "video" | "document" | "reaction" | "other";
  timestamp: number;
  chatType: "group" | "direct";
}
```

Add two optional fields after `chatType`:
```typescript
interface IncomingMessage {
  messageId: string;
  groupId: string;
  senderPhone: string;
  senderName: string;
  text: string;
  type: "text" | "image" | "sticker" | "voice" | "video" | "document" | "reaction" | "other";
  timestamp: number;
  chatType: "group" | "direct";
  mediaUrl?: string;      // Audio file URL (for voice messages)
  mediaDuration?: number;  // Duration in seconds (for voice messages)
}
```

**Step 2: Mirror the same change in the modular dev reference file**

In `supabase/functions/_shared/whatsapp-provider.ts`, add the same two fields to the `IncomingMessage` export interface.

---

### Task 2: Extract mediaUrl and mediaDuration in parseIncoming

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:195-223`
- Modify: `supabase/functions/_shared/whatsapp-provider.ts` (mirror)

**Step 1: Extract audio link and duration from Whapi payload**

After line 200 (`const timestamp = ...`), add extraction of media fields from the Whapi message payload. Whapi sends voice messages with type `ptt` or `audio`, and the audio data is nested under that key:

```typescript
// Extract media info for voice messages (ptt = push-to-talk, audio = audio file)
const audioData = (msg.ptt || msg.audio) as Record<string, unknown> | undefined;
const mediaUrl = audioData?.link as string | undefined;
const mediaDuration = audioData?.duration as number | undefined;
```

**Step 2: Include in the returned object**

In the return statement (line 214-223), add the two new fields:

```typescript
return {
  messageId: id,
  groupId,
  senderPhone: from.replace("@s.whatsapp.net", ""),
  senderName: fromName,
  text: text,
  type: typeMap[type] || "other",
  timestamp,
  chatType,
  mediaUrl,
  mediaDuration,
};
```

**Step 3: Mirror in whatsapp-provider.ts**

Apply the same extraction logic in the modular `_shared/whatsapp-provider.ts` `parseIncoming` method.

---

### Task 3: Add transcribeVoice function

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (add function before the main handler, near other helper functions around line 2438)

**Step 1: Add the transcribeVoice function**

Insert after the `// ─── Helper Functions ───` comment (line 2438), before `logMessage`:

```typescript
async function transcribeVoice(mediaUrl: string): Promise<string | null> {
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
  if (!GROQ_API_KEY) {
    console.error("[Voice] GROQ_API_KEY not set");
    return null;
  }

  try {
    // 1. Download audio from Whapi media URL (must be immediate — URLs may expire)
    const audioResponse = await fetch(mediaUrl);
    if (!audioResponse.ok) {
      console.error("[Voice] Failed to download audio:", audioResponse.status);
      return null;
    }
    const audioBlob = await audioResponse.blob();

    // 2. Build multipart form data for Groq Whisper API
    // No language hint — Whisper auto-detects Hebrew, English, or mixed.
    // This supports English-speaking households and code-switching (common in Israel).
    const formData = new FormData();
    formData.append("file", audioBlob, "voice.ogg");
    formData.append("model", "whisper-large-v3");

    // 3. Call Groq Whisper API (OpenAI-compatible endpoint)
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      console.error("[Voice] Groq API error:", response.status, await response.text());
      return null;
    }

    const result = await response.json();
    return result.text?.trim() || null;
  } catch (err) {
    console.error("[Voice] Transcription error:", err);
    return null;
  }
}
```

Key design decisions:
- Downloads audio immediately (Whapi URLs may expire)
- Uses `whisper-large-v3` with NO language hint — auto-detects Hebrew, English, or mixed speech. Whisper's language detection is highly accurate, and this supports English-speaking households + Israeli code-switching (Hebrew/English mid-sentence)
- Returns `null` on any failure — caller decides how to handle gracefully
- File extension `.ogg` matches WhatsApp's native OGG/Opus format (no conversion needed)

---

### Task 4: Replace skip filter with voice-aware routing

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:1981-1986`

**Step 1: Replace the blanket non-text skip**

Current code (lines 1981-1986):
```typescript
// 3. Skip non-text messages (photos, stickers, voice notes)
if (message.type !== "text") {
  console.log(`[Webhook] Skipping ${message.type} message from ${message.senderName}`);
  await logMessage(message, "skipped_non_text");
  return new Response("OK", { status: 200 });
}
```

Replace with:
```typescript
// 3. Handle voice messages: transcribe short ones, skip long ones
if (message.type === "voice") {
  const duration = message.mediaDuration || 0;
  if (duration > 30) {
    console.log(`[Webhook] Skipping long voice (${duration}s) from ${message.senderName}`);
    await logMessage(message, "skipped_long_voice");
    return new Response("OK", { status: 200 });
  }

  if (!message.mediaUrl) {
    console.log(`[Webhook] Voice message without media URL from ${message.senderName}`);
    await logMessage(message, "voice_transcription_failed");
    return new Response("OK", { status: 200 });
  }

  console.log(`[Webhook] Transcribing ${duration}s voice from ${message.senderName}`);
  const transcribed = await transcribeVoice(message.mediaUrl);
  if (!transcribed) {
    console.log(`[Webhook] Transcription failed for ${message.senderName}`);
    await logMessage(message, "voice_transcription_failed");
    return new Response("OK", { status: 200 });
  }

  // Inject transcribed text — from here the pipeline treats it as a typed message
  message.text = transcribed;
  console.log(`[Webhook] Transcribed voice: "${transcribed.slice(0, 80)}..."`);
}

// 3b. Skip all other non-text messages (photos, stickers, video, etc.)
if (message.type !== "text" && message.type !== "voice") {
  console.log(`[Webhook] Skipping ${message.type} message from ${message.senderName}`);
  await logMessage(message, "skipped_non_text");
  return new Response("OK", { status: 200 });
}
```

**Important:** The voice block runs first. If transcription succeeds, `message.text` is set to the transcribed text and execution falls through to the rest of the pipeline (length cap, empty check, @שלי detection, Haiku classifier, etc.) — no changes needed downstream.

---

### Task 5: Log voice_transcribed classification

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Find where classification is set after successful processing**

After the voice message is transcribed and classified through the pipeline, the existing `logMessage` call at the end of the pipeline already logs the classification (e.g., `haiku_actionable`, `haiku_ignore`, etc.). The transcribed text is already in `message.text`.

We need ONE additional log line: when transcription succeeds, we want the `message_text` column in `whatsapp_messages` to contain the transcribed text (not empty). This happens automatically because we set `message.text = transcribed` before `logMessage` is called.

**Step 2: Add a console.log marker for analytics**

After the `message.text = transcribed` line in the voice block (Task 4), the existing pipeline handles classification + logging. The `message_type` column already stores `"voice"` (from `message.type`), and `message_text` stores the transcribed text — so `voice_transcribed` messages are queryable as: `WHERE message_type = 'voice' AND classification NOT IN ('skipped_long_voice', 'voice_transcription_failed')`.

No separate `voice_transcribed` classification value is needed — the existing pipeline classifications (`haiku_actionable`, `haiku_ignore`, etc.) apply to transcribed voice messages just like text messages, which is more useful for analytics.

---

### Task 6: Update privacy FAQ on landing page

**Files:**
- Modify: `src/components/LandingPage.jsx:44` (Hebrew FAQ)
- Modify: `src/components/LandingPage.jsx:85` (English FAQ)

**Step 1: Update Hebrew privacy FAQ**

Replace line 44's answer text:
```
Old: "שלי לא שומרת תמונות, הודעות קוליות או מדיה — רק טקסט שקשור למטלות, קניות ואירועים. כל המידע נמחק אחרי 30 יום. שיחות אישיות? שלי לא רואה אותן בכלל. רק בני הבית שלכם רואים את המידע — אף אחד אחר, כולל אנחנו."
```
```
New: "שלי לא שומרת תמונות או וידאו. היא יכולה לשמוע הודעות קוליות קצרות - תוכלו להקליט לה את המצרכים לקניות או את מטלות הבית בדיוק כמו בהודעת טקסט - היא לא שומרת את ההקלטה אלא רק את התוכן שלה, בדיוק כמו הודעה רגילה. כל המידע נמחק אחרי 30 יום. שיחות אישיות? שלי לא רואה אותן בכלל. רק בני הבית שלכם רואים את המידע — אף אחד אחר, כולל אנחנו."
```

**Step 2: Update English privacy FAQ**

Replace line 85's answer text:
```
Old: "Sheli doesn't store photos, voice messages or media — only text about tasks, shopping and events. All data is deleted after 30 days. Personal conversations? Sheli doesn't see them at all. Only your household members can see your data — nobody else, including us."
```
```
New: "Sheli doesn't store photos or videos. She can listen to short voice messages — you can record your shopping list or household tasks just like a text message. She doesn't save the recording, only its content, just like a regular message. All data is deleted after 30 days. Personal conversations? Sheli doesn't see them at all. Only your household members can see your data — nobody else, including us."
```

---

### Task 7: Update Sheli's self-knowledge in reply generator prompt

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:740-743` (Hebrew self-knowledge)
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts:743-746` (English self-knowledge)

**Step 1: Update Hebrew privacy self-knowledge**

Replace:
```
- פרטיות: "אני לא שומרת תמונות, הודעות קוליות או מדיה. רק טקסט שקשור למטלות, קניות ואירועים. הכל נמחק אוטומטית אחרי 30 יום."
```
With:
```
- פרטיות: "אני לא שומרת תמונות או וידאו. אני כן שומעת הודעות קוליות קצרות — תקליטו לי רשימת קניות או מטלות בדיוק כמו הודעה רגילה. אני לא שומרת את ההקלטה, רק את התוכן. הכל נמחק אוטומטית אחרי 30 יום."
```

**Step 2: Update English privacy self-knowledge**

Replace:
```
- Privacy: "I don't store photos, voice messages, or media. Only text related to tasks, shopping, and events. Everything is auto-deleted after 30 days."
```
With:
```
- Privacy: "I don't store photos or videos. I can listen to short voice messages — record your shopping list or tasks just like a text. I don't save the recording, only its content. Everything is auto-deleted after 30 days."
```

---

### Task 8: Set GROQ_API_KEY env var in Supabase

**Manual step (not code):**

1. Get a Groq API key from `console.groq.com` → API Keys → Create
2. In Supabase Dashboard → Edge Functions → whatsapp-webhook → Settings → Environment Variables
3. Add: `GROQ_API_KEY` = `gsk_...`

---

### Task 9: Deploy and test

**Step 1: Deploy inlined file**

Open `supabase/functions/whatsapp-webhook/index.inlined.ts` in Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → whatsapp-webhook → Code → paste → Deploy. Verify JWT = OFF.

**Step 2: Test voice message flow**

Manual test checklist:
- [ ] Send a short Hebrew voice message (5-10s) to the bot in a WhatsApp group: "תוסיפי חלב וביצים לרשימה"
- [ ] Verify bot responds with shopping list confirmation
- [ ] Check `whatsapp_messages` table: `message_type = 'voice'`, `message_text` = transcribed text, `classification` = `haiku_actionable`
- [ ] Send a voice message > 30 seconds — verify bot ignores it, `classification = 'skipped_long_voice'`
- [ ] Send a photo — verify still skipped as `skipped_non_text`
- [ ] Send a voice message in 1:1 direct chat — verify transcription works there too
- [ ] Check Groq console for usage stats

**Step 3: Verify edge cases**

- [ ] Send voice message with background noise only — should get empty transcription → skipped gracefully
- [ ] Check Supabase Edge Function logs for `[Voice]` log lines

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (project root, the ours-app CLAUDE.md)

**Step 1: Add voice message documentation**

Add to the "WhatsApp Bot Gotchas" section:
```
- **Voice message support:** <=30s voice messages transcribed via Groq Whisper (`whisper-large-v3`, `language: "he"`). Text injected into existing pipeline. >30s skipped. Env var: `GROQ_API_KEY`. Free tier: 28,800 sec/day.
- **Whapi voice payload:** `msg.ptt.link` / `msg.audio.link` for media URL, `msg.ptt.duration` / `msg.audio.duration` for seconds.
```

Add to the "Classification values" list:
```
`skipped_long_voice`, `voice_transcription_failed`
```

---

## File Change Summary

| File | Change |
|------|--------|
| `supabase/functions/whatsapp-webhook/index.inlined.ts` | Add `mediaUrl`/`mediaDuration` to interface, extract in parser, add `transcribeVoice()`, replace skip filter, update self-knowledge |
| `supabase/functions/_shared/whatsapp-provider.ts` | Mirror interface + parser changes (dev reference) |
| `src/components/LandingPage.jsx` | Update privacy FAQ (HE + EN) |
| `CLAUDE.md` | Document voice support, new env var, classification values |
