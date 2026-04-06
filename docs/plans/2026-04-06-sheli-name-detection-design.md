# Design: שלי Name Detection + Reply Personality

**Date:** 2026-04-06
**Status:** Approved
**Problem:** Bot name "שלי" is identical to the Hebrew possessive "my/mine". Current regex `@?שלי` fires on every occurrence, causing false replies to "האוטו שלי", "ילדים שלי", etc.

## Architecture: 3-Layer Detection

```
Message arrives
  │
  ├─ Layer 1 (regex, 0 cost): high-confidence patterns only
  │   ├─ Definite NAME → directAddress = true, strip from text
  │   ├─ Definite NOT-NAME → directAddress = false (skip entirely)
  │   └─ Ambiguous → pass through to Layer 2
  │
  ├─ Layer 2 (Haiku classifier, ~$0.0003): Hebrew grammar understanding
  │   └─ Returns addressed_to_bot: boolean in classification output
  │
  └─ Layer 3 (Sonnet reply generator, ~$0.01): personality tuning
      ├─ 3a: Emoji energy matching
      └─ 3b: Varied out-of-scope deflections
```

## Layer 1: Pre-Classifier Regex

### High-confidence NAME patterns (force directAddress = true)

| # | Pattern | Example | Regex |
|---|---------|---------|-------|
| 1 | First word | "שלי מה צריך?" | `^\s*שלי[,\s!?]` |
| 2 | After greeting | "היי שלי" | `^(היי|הי|שלום|יו|בוקר טוב|ערב טוב)\s+שלי` |
| 3 | @mention | "@שלי" | `@שלי` |
| 4 | After thanks | "תודה שלי ❤️" | `תודה\s+שלי` |
| 5 | Standalone end | "מישהו? שלי?" | `[?!]\s+שלי[?!.\s]*$` |

### Definite NOT-NAME: "של מי" context (cross-message)

A standalone "שלי" or "שלי!" could mean "mine!" if replying to a recent "של מי" question.

**Detection:** Before classifying, check the last 3 messages in the group (from `whatsapp_messages` table, last 90 seconds). If any contains "של מי", then a standalone "שלי" message = "mine!", not the bot's name.

```
// Pseudocode
if (message.text.trim() matches /^שלי[!.\s]*$/) {
  const recent = last 3 messages from same group, last 90s
  if (any recent message contains "של מי") {
    // This is "mine!" not the bot's name → skip
    directAddress = false
    return
  }
}
```

### Everything else → pass to Haiku (Layer 2)

If "שלי" appears in the message but doesn't match any high-confidence pattern above, let Haiku decide based on grammar.

## Layer 2: Haiku Classifier Prompt Addition

### New output field

Add `addressed_to_bot: boolean` to the classifier's JSON output schema.

### Prompt addition (Hebrew grammar guidance)

```
CRITICAL — "שלי" DISAMBIGUATION:
"שלי" is BOTH the bot's name AND Hebrew for "my/mine".
Set addressed_to_bot: true ONLY when the user is talking TO Sheli.

POSSESSIVE "שלי" (= "my/mine") — addressed_to_bot: false:
- After any noun: "האוטו שלי", "הטלפון שלי", "הבית שלי", "החדר שלי"
- After endearments: "אהובים שלי", "יקרים שלי", "חיים שלי", "נשמה שלי"
- After family: "אמא שלי", "אבא שלי", "אחות שלי", "הילדים שלי"
- After body parts: "הראש שלי", "היד שלי", "הגב שלי"
- Claiming ownership: "זה שלי", "שלי!" (answering "של מי?")
- Possessive phrases: "הצד שלי", "התור שלי", "הבחירה שלי"

NAME "שלי" (= talking to the bot) — addressed_to_bot: true:
- Direct address at start: "שלי, מה צריך?"
- Direct address at end: "מה שלומך שלי?"
- After greeting: "היי שלי"
- After thanks/praise: "תודה שלי", "יופי שלי"
- With feminine imperative directed at bot: "תזכירי לי שלי", "אל תשכחי שלי"
- Calling the bot: "שלי?"

When in doubt between name and possessive, prefer possessive (false silence > false reply).
```

## Layer 3a: Emoji Energy Matching (Sonnet prompt, HE+EN)

Added to reply generator system prompt (bilingual — works for both Hebrew and English households):

```
EMOJI ENERGY: Mirror the sender's emotional temperature naturally.
- Hearts/love emoji (❤️💕😍) → respond with warmth, include a heart or love emoji
- Excitement (!!!🎉🔥) → match the energy, celebrate with them
- Dry/minimal → keep it clean, no forced emoji
- Frustrated → empathetic, calm, skip smiley faces
Read the room like a real person would.
```

## Layer 3b: Out-of-Scope Deflection (Sonnet prompt, HE+EN)

Added to reply generator system prompt with language-conditional examples:

**Hebrew:** Uses "מטלות" (not "משימות"), varied deflection vibes
**English:** Same structure, English-native phrasing

Both instruct Sonnet to NEVER repeat the same phrasing — create a unique response every time.

## Routing Logic (updated)

```
// After Layer 1 regex + Layer 2 Haiku classification:

const shouldReply = directAddress           // Layer 1 said yes
  || classification.addressed_to_bot        // Layer 2 (Haiku) said yes
  || classification.intent !== "ignore";    // Actionable intent

if (shouldReply) {
  // Generate reply via Sonnet (Layer 3)
  // Sonnet handles emoji matching + out-of-scope deflection via prompt
} else {
  // Silent — it's group chatter or possessive "שלי"
}
```

## Test Cases

| Message | Expected | Layer |
|---------|----------|-------|
| שלי מה צריך מהסופר? | NAME → reply | L1 (first word) |
| היי שלי מה קורה? | NAME → reply | L1 (greeting+name) |
| תודה שלי ❤️❤️❤️ | NAME → warm reply with heart | L1 + L3a |
| מישהו? שלי? | NAME → reply | L1 (end standalone) |
| אל תשכחי להזכיר לי שלי | NAME → reply | L2 (feminine verb) |
| מה שלומך שלי? | NAME → reply | L2 (directed at person) |
| שלי מה מזג האוויר? | NAME + out-of-scope → deflect | L1 + L3b |
| תזכירי לי לאסוף את האוטו שלי מהמוסך | POSSESSIVE → silent | L2 |
| ילדים שלי תאכלו | POSSESSIVE → silent | L2 |
| אמא שלי באה מחר | POSSESSIVE → silent | L2 |
| של מי הבקבוק? (msg 1) שלי! (msg 2) | POSSESSIVE → silent | L1 (של מי context) |
| אהובים שלי | POSSESSIVE → silent | L2 |
| הראש שלי כואב | POSSESSIVE → silent | L2 |
| שלי! | Ambiguous: check recent "של מי" → if yes: silent, if no: reply | L1 (context check) |

## Implementation Plan

1. **Update Layer 1 regex** in `index.inlined.ts` — replace current `@?שלי` with smart patterns + "של מי" cross-message check
2. **Update Haiku classifier prompt** — add `addressed_to_bot` field + disambiguation guidance
3. **Update `haikuEntitiesToActions` / routing** — use `addressed_to_bot` in reply decision
4. **Update Sonnet reply generator prompt** — add emoji energy + out-of-scope deflection sections
5. **Test** — run through test cases manually in WhatsApp group

## Cost Impact

- Layer 1: zero (regex)
- Layer 2: ~$0.00003 extra per message (200 tokens of disambiguation guidance)
- Layer 3: zero (prompt text only, Sonnet already runs for actionable messages)
- "של מי" context check: 1 lightweight DB query (~5ms)
