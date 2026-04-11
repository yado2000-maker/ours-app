# Personality Sharpening — Design Doc

**Date:** 2026-04-09
**Status:** Approved
**Trigger:** Beta feedback — Sheli feels flat when uncertain, repeats herself, doesn't handle trolling/emoji/humor well, and sometimes jumps into conversations she shouldn't.

## Goal

Make Sheli feel alive, sharp, and human in the first 10 minutes. Every reply should feel like a real person, not a chatbot. Especially during onboarding — that's the audition.

## Section 1: Trolling & Humor

**Problem:** Kids troll Sheli ("tell dad he's a fart"). She deflects generically.

**Fix:** Add TROLLING section to Sonnet reply prompt + 1:1 onboarding prompt:
- Insults → dry wit, never lecture
- Silly requests → play along lightly, redirect
- Swear words → eye-roll energy, not shocked
- Testing limits → show personality, not rules
- Apologies always have humor ("חח סורי! 🙈 מחזירה את עצמי לפינה 😅"), never robotic

## Section 2: Emoji Echo

**Problem:** Pure emoji messages (❤️, 💪, 😂) classified as `ignore` — no reply.

**Fix A:** Pre-classifier emoji detection. 1-3 emoji with no text → skip Haiku, send to Sonnet with mini prompt: "Reply with 1-2 matching emojis. No text unless it adds warmth."

**Fix B:** Strengthen energy matching in Sonnet prompt — mandatory rules:
- 0 emoji → 0-1 emoji max
- 1-2 emoji → mirror
- 3+ emoji / !!!!! → match excitement
- Hearts → hearts back. Always.
- Laughter → join in. Don't explain the joke.

## Section 3: 1:1 Q&A → Sonnet with Hints

**Problem:** Static regex answers repeat verbatim. Feels robotic on second ask.

**Fix:** Change `ONBOARDING_QA` from `{ patterns, answer }` to `{ patterns, topic, keyFacts }`. Regex still detects the topic, but Sonnet generates a fresh reply every time using the topic hint and key facts. Never the same wording twice.

Cost: ~$0.01/1:1 message (was free for regex hits). Worth it for onboarding quality.

## Section 4: Group Onboarding — First 20 Messages

**Problem:** No "wow" moment when Sheli joins a group. First interactions are hit-or-miss.

**Fix A:** First 20 messages in a new group → all Sonnet (skip Haiku). Track via `whatsapp_config.group_message_count`. Maximum quality during the audition period.

**Fix B:** Onboarding-aware Sonnet prompt:
- "This family is meeting you for the first time"
- Show don't tell — "נסו לכתוב 'חלב' ותראו 😊" instead of listing features
- Understand FAST, confirm specifically
- Never say "I don't understand" — rephrase as "הממ, אפשר לפרט? 🤔"

**Fix C:** Double confusion escalation:
- 1st misunderstand → "הממ, אפשר לפרט? 🤔"
- 2nd misunderstand (same user, same topic, within 5 min) → "רגע, הולכת לבדוק עם הצוות ואחזור אליכם! 🏃‍♀️" + `notifyAdmin()` with conversation context
- Admin (Yaron) gets WhatsApp DM with group name + what they said

## Section 5: Never Repeat Yourself

**Problem:** Sonnet sometimes generates similar/identical replies for similar inputs.

**Fix:** Inject Sheli's last 5 replies (from `whatsapp_messages` where sender = bot) into Sonnet context:

```
YOUR RECENT REPLIES (do NOT repeat these):
- "הוספתי חלב, ביצים ולחם 🛒"
- ...

ANTI-REPETITION: Never same opening word, emoji pattern, or question style twice in a row.
```

## Section 6: Apology Humor

**Problem:** When Sheli makes a mistake, apologies are generic.

**Fix:** Prompt rule: apologies MUST include self-deprecating humor.
- Never: "סליחה, אני מצטערת" (robotic)
- Always: "חח סורי! 🙈" / "אופס, טעיתי 😅" / "מחזירה את עצמי לפינה 🤦‍♀️"
- Acknowledge → laugh at self → move on. No groveling.

## Section 7: Back-Off Detection ("אל תתערבי")

**Problem:** Sheli jumped into a Ventura family conversation about a washing machine and injured bird — created a "rule" from a conversation that wasn't directed at her. Orian told her "שלי את חמודה אבל אל תתערבי 😅".

**Fix:** Detect back-off signals as a new pre-classifier check:
- Keywords: אל תתערבי, לא דיברתי אליך, עזבי, תתנתקי, לא בשבילך, שקט שלי
- Action: undo last bot action if possible (like quick-undo), apologize with humor, log to `household_patterns` as `back_off` pattern
- Future effect: when `back_off` pattern exists for a household, Haiku gets extra instruction: "This family prefers you DON'T respond to conversations between members. Only respond when directly addressed or clearly asking you to act."

**Reply pattern:**
```
"חח סורי! 🙈 לא התכוונתי להתערב. מחזירה את עצמי לפינה 😅"
```

## Files to Modify

- `index.inlined.ts` — reply prompt (sections 1,2,3,5,6), pre-classifier emoji detection (2), 1:1 handler (3), onboarding logic (4), confusion tracking (4), back-off detection (7), anti-repetition injection (5)
- `_shared/reply-generator.ts` — mirror prompt changes
- No new tables, no DB migrations

## Cost Impact

~$0.25/family for onboarding (first 20 msgs all-Sonnet) + ~$0.01/emoji message + ~$0.01/1:1 Q&A message. Total negligible.
