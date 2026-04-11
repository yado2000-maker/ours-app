# Voice Message Support - Design

**Date:** 2026-04-07
**Status:** Approved
**Goal:** Sheli listens to short voice messages (<=30s) in WhatsApp, transcribes them to text via Groq Whisper, and processes them through the existing classification pipeline.

## Why

Israelis use voice messages heavily. Shopping lists, task assignments, schedule updates - all spoken naturally in Hebrew. Without voice support, Sheli misses a large portion of actionable messages.

## 1. Flow

```
Voice message arrives (type: "ptt" or "audio")
    |
    +-- Duration > 30 seconds? --> SKIP (log as "skipped_long_voice")
    |
    +-- Download OGG/Opus from Whapi media URL
    |
    +-- Send to Groq Whisper API (language: "he")
    |   --> Returns transcribed Hebrew text
    |
    +-- Inject transcribed text into existing pipeline
    |   (same as if user typed it)
    |
    +-- Classify with Haiku --> Execute --> Reply
        (conversation context, dedup - all existing logic applies)
```

Voice messages become text messages. The entire existing pipeline (Haiku classifier, conversation context, dedup, Sonnet escalation, reply generation) works unchanged.

## 2. Provider: Groq Whisper

- **API:** `POST https://api.groq.com/openai/v1/audio/transcriptions` (OpenAI-compatible)
- **Model:** `whisper-large-v3`
- **Audio format:** OGG/Opus (WhatsApp native, no conversion needed)
- **Language hint:** None (auto-detect). Supports Hebrew, English, and mixed speech. Whisper-large-v3 auto-detection is highly accurate.
- **Free tier:** 28,800 seconds/day (8 hours) - covers up to ~500 families
- **Paid:** $0.003/min after free tier
- **Env var:** `GROQ_API_KEY=gsk_...`

## 3. Duration Filter

- **<=30 seconds:** Transcribe and process
- **>30 seconds:** Skip, log as `skipped_long_voice`
- **Why 30s:** Actionable messages ("add milk", "pick up the kids at 5") are under 10 seconds. Long voice notes are stories, gossip, rants - never actionable. 30s is generous.

## 4. Code Changes

### 4a. Extend IncomingMessage (whatsapp-provider.ts / inlined)

Add fields to the interface:
```typescript
mediaUrl?: string;     // Audio file URL from Whapi
mediaDuration?: number; // Duration in seconds
```

Parse from Whapi webhook payload:
- `message.audio.link` or `message.ptt.link` --> `mediaUrl`
- `message.audio.duration` or `message.ptt.duration` --> `mediaDuration`

### 4b. Replace skip filter (index.inlined.ts)

```
Current:
  if (type !== "text") --> skip all non-text

New:
  if (type === "voice" && duration <= 30) --> transcribe --> continue pipeline
  if (type === "voice" && duration > 30) --> skip (log "skipped_long_voice")
  if (type !== "text" && type !== "voice") --> skip (existing behavior)
```

### 4c. New function: transcribeVoice(mediaUrl)

```typescript
async function transcribeVoice(mediaUrl: string): Promise<string | null> {
  // 1. Fetch audio from Whapi media URL
  const audioResponse = await fetch(mediaUrl);
  const audioBlob = await audioResponse.blob();

  // 2. Build form data for Groq API
  const formData = new FormData();
  formData.append("file", audioBlob, "voice.ogg");
  formData.append("model", "whisper-large-v3");
  // No language hint — auto-detect Hebrew/English/mixed

  // 3. Call Groq Whisper API
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  if (!response.ok) {
    console.error("[Voice] Groq API error:", response.status);
    return null;
  }

  const result = await response.json();
  return result.text?.trim() || null;
}
```

On failure: log error, skip message gracefully (don't crash pipeline).

## 5. Logging

| Classification | Meaning |
|---------------|---------|
| `voice_transcribed` | Successfully transcribed + classified |
| `skipped_long_voice` | Voice > 30s, ignored |
| `voice_transcription_failed` | Groq API error, skipped |

Store in `whatsapp_messages`:
- `message_type: "voice"` (already captured)
- `message_text: <transcribed text>` (new - fill after transcription)

## 6. Cost at Scale

| Families | Voice msgs/day | Seconds/day | Monthly cost |
|----------|---------------|-------------|-------------|
| 10 | 25 | 250 | **$0 (free tier)** |
| 50 | 125 | 1,250 | **$0 (free tier)** |
| 100 | 500 | 5,000 | **$0 (free tier)** |
| 500 | 2,500 | 25,000 | **$0 (free tier)** |
| 1,000 | 5,000 | 50,000 | ~$3/day = **$90/month** |

Assumptions: ~5 voice msgs/family/day, ~10 sec average (after 30s filter).

## 7. Privacy Update

**Hebrew FAQ answer (replaces current privacy Q):**
"שלי לא שומרת תמונות או וידאו. היא יכולה לשמוע הודעות קוליות קצרות - תוכלו להקליט לה את המצרכים לקניות או את מטלות הבית בדיוק כמו בהודעת טקסט - היא לא שומרת את ההקלטה אלא רק את התוכן שלה, בדיוק כמו הודעה רגילה"

**English FAQ answer:**
"Sheli doesn't store photos or videos. She can listen to short voice messages - you can record your shopping list or household tasks just like a text message. She doesn't save the recording, only its content, just like a regular message."

**Bot self-knowledge (reply-generator prompt):**
Add to Sheli's self-knowledge: "I can understand short voice messages in Hebrew. I transcribe them and process them like text. I don't save the audio recording."

## 8. Edge Cases

- **Empty transcription:** Groq returns empty string (background noise, music) - treat as ignore, don't classify
- **Non-Hebrew voice:** Whisper auto-detects language — English voice messages transcribed accurately. Mixed Hebrew/English (common in Israel) also handled well.
- **Whapi media URL expiry:** Whapi media URLs may expire. Download immediately on webhook receipt, before any async processing.
- **Edge Function timeout (150s):** Download (~1s) + Groq API (~2-5s) + Haiku (~1s) = well within limit.
- **Rate limiting:** Groq free tier is per-day, not per-minute. No burst concerns.

## 9. What This Enables

Israeli families can now:
- Record a shopping list while driving: "חלב, ביצים, לחם ועגבניות"
- Assign tasks by voice: "שלי תוסיפי לגור לנקות את המטבח"
- Schedule events: "יש לנועה חוג ביום שלישי בחמש"
- All processed identically to text messages
