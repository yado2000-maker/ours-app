---
name: hebrew-grammar
description: Use when editing Sheli bot prompts (SHARED_HEBREW_GRAMMAR, ONBOARDING_1ON1_PROMPT, buildReplyPrompt, Haiku classifier in index.inlined.ts), reviewing Sheli's live WhatsApp replies for gender drift, plural-fallback misuse, Latin-letters-mid-Hebrew leakage, or missing-ה idiomatic openers, adding names to MALE_NAMES / FEMALE_NAMES / UNISEX_NAMES gender-detection sets, or writing Sheli-voice Hebrew copy (apology templates, onboarding messages, reminder phrasing). For general Hebrew marketing/SEO/UX copy not tied to Sheli, prefer hebrew-content-writer instead.
---

# Hebrew Grammar Reference (זכר / נקבה / כתיב תקין)

## Overview

Unpointed Israeli Hebrew has three gender forms that agents routinely confuse: **masculine singular** (זכר יחיד), **feminine singular** (נקבה יחידה), and **plural** (רבים, used as gender-neutral fallback). LLMs drift toward plural because it feels "safer" — but plural to one known person is **wrong and impersonal**. This skill is the reference for getting it right.

## When to Use

- Editing Sheli's prompts (`SHARED_HEBREW_GRAMMAR`, `ONBOARDING_1ON1_PROMPT`, `buildReplyPrompt`, Haiku classifier)
- Writing Hebrew UI strings, CTAs, landing copy, FAQ, WhatsApp onboarding messages
- Reviewing bot replies for gender drift, construct-state errors, or spelling mistakes
- Adding new names to the gender-detection lists
- Debugging user reports like "הבוט פנה אליי בזכר אבל אני אישה"

## Core Principles

1. **Known gender → lock singular. Never drift to plural mid-conversation.**
2. **Plural is fallback ONLY when gender is unknown** (or addressing multiple people).
3. **Sheli always speaks feminine first-person** (הוספתי, רשמתי, בדקתי) regardless of user gender.
4. **Never correct the user's own gender forms** — their verb form IS their gender.
5. **Unpointed Hebrew uses כתיב מלא** (full spelling with vav/yud), not כתיב חסר.

## Gender Quick Reference

### Addressing the user

| Form | Masculine | Feminine | Plural (fallback) |
|------|-----------|----------|---------------------|
| you (pronoun) | אתה | את | אתם / אתן |
| you want | רוצה (no ה) | רוצה | רוצים |
| you need | צריך | צריכה | צריכים |
| you know | יודע | יודעת | יודעים |
| you think | חושב | חושבת | חושבים |
| you go | הולך | הולכת | הולכים |
| try! (imperative) | תנסה | תנסי | תנסו |
| send! | שלח | שלחי | שלחו |
| write! | תכתוב | תכתבי | תכתבו |
| tell me | תגיד לי | תגידי לי | תגידו לי |
| come! | בוא | בואי | בואו |

### Gender-neutral in unpointed Hebrew (prefer for personal address when possible)

These look identical for masculine and feminine singular:
- **לך** (to you)
- **אותך** (you, direct object)
- **בשבילך** (for you)
- **איתך** (with you)
- **ממך** (from you)

Rule of thumb: if you can phrase the sentence with these, do — you get intimacy without gender commitment. Example: "מה הכי מעניין אותך?" works for male and female identically.

### Sheli's own verbs (always feminine) — PAST tense

| Verb | Form Sheli uses |
|------|-----------------|
| I added | הוספתי |
| I saved | שמרתי |
| I registered/wrote | רשמתי |
| I checked | בדקתי |
| I organized | סידרתי |
| I reminded | הזכרתי |
| I found | מצאתי |
| I marked | סימנתי |
| I understood | הבנתי |
| I knew | ידעתי |
| I thought | חשבתי |

Never "הוספנו" (we) or "הוסף" (masc. imperative) when Sheli is the subject.

### Sheli's own verbs — PRESENT tense (critical — frequent drift to masculine)

Sonnet reliably gets past-tense feminine right (הוספתי, בדקתי) but drifts masculine on **present tense** because the root form reads "default masculine" in training data. Lock these down explicitly:

| Wrong (masc) | Right (fem) | English |
|--------------|-------------|---------|
| אני מבין | **אני מבינה** (or past: הבנתי) | I understand |
| אני יודע | **אני יודעת** | I know |
| אני חושב | **אני חושבת** | I think |
| אני זוכר | **אני זוכרת** | I remember |
| אני מרגיש | **אני מרגישה** | I feel |
| אני שומע | **אני שומעת** | I hear |
| אני צריך | **אני צריכה** | I need |
| אני אוהב | **אני אוהבת** | I love / like |
| אני מחפש | **אני מחפשת** | I search for |
| אני בודק | **אני בודקת** | I'm checking |
| אני שולח | **אני שולחת** | I'm sending |
| אני לומד | **אני לומדת** | I learn |

**Gender-invariant present forms** (same for masc + fem — use freely, never wrong): רוצה, מנסה, מקווה, רואה.

This rule applies to **Sheli-as-subject** only. When Sheli addresses the user, she matches the user's gender (see GENDER LOCK section).

### WhatsApp Hebrew slang — recognition + register matching

Israelis text in slang. Sheli must **recognize** these forms, **match the register**, and **never "correct"** them.

| Slang | Meaning | How Sheli responds |
|-------|---------|---------------------|
| לול | LOL (laughter) | Match with חחח, לול, or 😂 |
| אומג / אומגד / אומייגד / אומייגאד | OMG (shock) | "וואו 😱" / "אומג" / "רגע מה?!" — never "מה זה אומג?" |
| כפרעליך / כפרעלייך | "sweetie/darling" (Moroccan-origin endearment, widely used) | Warm, never sarcastic: "חח כפרה, תודה 💛" |
| סבבה / אחלה / וואלה / יאללה / בכיף / וואו / ואו | casual connectors | Match register — use them back |
| חבל על הזמן | **"amazing / best"** (positive idiom) | NOT literal "waste of time" — if user loved something, match |
| סוף הדרך / סוף | amazing / ultimate | Positive superlative |
| חלאס / ח'לאס | enough / stop (Arabic loan) | Acceptable casual |
| בלגן / בלאגן | chaos | Accept either spelling; don't "fix" |
| בא לי / בא לך | I want / you want | Idiomatic — never literal |
| נו / נוו / נוווו | urging / impatience | "נו באמת" / "נוו תגידי כבר" |
| יש! / יש | yes! / score! | "יש! 🎉" |
| טמבל / טמבלה | fool (often AFFECTIONATE) | Read context — usually teasing |
| חמודי / חמודה | cutie | Warm address |

**Rules:**
- If user writes slangy/short-form → Sheli replies slangy/short-form. Formal Hebrew ("להבנתי" / "ברצוני") to a slang user = robotic bot.
- NEVER explain slang back ("אומג זה קיצור של OMG..."). NEVER add asterisks or spelling corrections.
- Just respond to what they MEANT, in their register.

## Plural as Fallback — When It's Correct

Plural (אתם / רוצים / תנסו) is the **right** choice in these cases:

1. **Addressing a group in a family WhatsApp group** — "יאללה חבר'ה, תזכרו לקנות חלב"
2. **Addressing multiple specific people** — "תעדכנו אותי כשסיימתם"
3. **Truly unknown user gender** (new 1:1 user whose name isn't in the detection list)

Plural is **wrong** in these cases:
- 1:1 chat with a user whose gender is known (male or female)
- Speaking to one person even if you feel polite/safer using plural
- Hebrew plural-for-respect doesn't exist like French "vous" — it just sounds distant

## Gender Detection Cascade (bot)

Implemented in [index.inlined.ts](supabase/functions/whatsapp-webhook/index.inlined.ts):

1. **Text signals** (`detectGenderFromText`) — user wrote "אני צריכה" or "בעלי" → female; "אני צריך" or "אשתי" → male. This is **authoritative** — overrides stored values.
2. **Stored** (`convo.context.gender`) — set on previous turns, persists across the conversation.
3. **Name** (`detectGender`) — matches against `MALE_NAMES` / `FEMALE_NAMES` / `UNISEX_NAMES` sets. Heuristic: Hebrew names ending in ית are female. Do NOT guess from ה ending — too many exceptions (משה, אריה, שרה).

When adding new names, remember:
- Unisex names (אורי, טל, גל, עמית, יובל, נועם, דניאל, עדן, חן, רוני, שחר) belong in `UNISEX_NAMES` — not male/female — so Sheli waits for text signal before committing.
- Strip English possessive 's before lookup (WhatsApp senderName sometimes shows "Gilads" instead of "Gilad").

## Construct State (סמיכות)

Only the **second** noun takes the definite article ה-, never the first.

| Wrong | Right |
|-------|-------|
| הרשימת הקניות | רשימת הקניות |
| המספר הטלפון | מספר הטלפון |
| השם המשתמש | שם המשתמש |
| הסוף השבוע | סוף השבוע |
| הבית הספר | בית הספר |

When Sheli refers to the shopping list, her calendar, etc., she uses construct state: "רשימת הקניות", "יומן המשפחה", "שעון המעורר".

## Proper Spelling (כתיב מלא, no niqqud)

Modern unpointed Hebrew doubles vowels with vav/yud. Common mistakes:

### Two words, not one
| Wrong | Right | Meaning |
|-------|-------|---------|
| איאפשר | אי אפשר | impossible |
| כלכך | כל כך | so (much) |
| עלידי | על ידי | by (agent) |
| בכלאופן | בכל אופן | anyway |
| לאמעט | לא מעט | quite a few |

### One word, not two
| Wrong | Right | Meaning |
|-------|-------|---------|
| ב סדר | בסדר | okay |
| ה כל | הכל | everything |
| ל פעמים | לפעמים | sometimes |

### Common misspellings
| Wrong | Right | Meaning |
|-------|-------|---------|
| מאוד (overused) | — | Prefer specific adverbs (ממש, לגמרי, סופר) |
| קלוז / קלוס | close | Use the Hebrew — קרוב/סגור |
| הייתי צריך | הייתי צריך (ok) | but NOT "הייתי צריכתי" |
| אוכלה | אוכל (m) / אוכלת (f) | — |
| כאילו (overused) | — | Fine once, annoying 3× in one reply |

### Borrowed words (gershayim / apostrophe)
| Form | Example |
|------|---------|
| Use `'` (apostrophe) for single foreign sound | צ'יפס, ג'ינס, ג'ירפה |
| Use `"` (gershayim) for abbreviations | צה"ל, ארה"ב, תל"מ |
| Never regular double-quotes around Hebrew text | Use «quotes» or just no quotes |

### Verb forms Sheli gets wrong often
- **"תפסת אותי"** (you caught me) — NOT "נתפסת אותי" (which means "I got caught," passive reflexive)
- **"התכוונתי"** — NOT "כיוונתי" when meaning "I meant"
- **"אכפת לי"** — NOT "איכפת לי" (no yud before כ)
- **"אני מצטערת"** (Sheli feminine) — NOT "אני מצטער"

### Idiomatic sentence openers — use the definite article ה-

English abstract nouns drop "the"; Hebrew usually keeps it when the noun opens a thought.

| Wrong (bare) | Right (with ה-) | English |
|--------------|------------------|---------|
| אמת? | **האמת?** | honestly? / to be honest? |
| אמת, אני לא יודעת | **האמת שאני לא יודעת** | honestly, I don't know |
| עניין הוא ש... | **העניין הוא ש...** | the thing is... |
| בעיה היא... | **הבעיה היא...** | the problem is... |
| דבר הכי חשוב | **הדבר הכי חשוב** | the most important thing |

Rule of thumb: if English would use "the" or if the noun opens a thought/confession/explanation, Hebrew takes ה-.

### Never mix Latin letters into a Hebrew reply

Hebrew output stays Hebrew. The only Latin allowed mid-sentence:
- **Native-Latin proper nouns** — WhatsApp, Google, API, Claude, iCount, Supabase, URLs.
- **Everything else** → Hebrew.

**Anti-pattern** (observed live 2026-04-21):
> "על כל הטכנולוגיה giaI הזאת"

Sheli tried to transliterate "טכנולוגיה" → "Technologia" → got confused → output the garbage fragment "giaI". Never do this. Write "טכנולוגיה" in Hebrew, or fall back to a simpler Hebrew noun (מערכת / כלים / תוכנה).

If an LLM reply contains Latin letters that aren't on the whitelist above, flag it for regeneration — this is a model output bug, not a valid style choice.

## CTAs and Imperatives — Use Plural (gender-free)

For UI buttons, landing page CTAs, and marketing copy addressing an unknown visitor, **always use masculine plural** — it reads as gender-neutral in modern Hebrew UX:

| Wrong (gendered) | Right (plural = neutral) |
|------------------|---------------------------|
| המשך / המשיכי | המשיכו |
| הירשם / הירשמי | הירשמו |
| התחבר / התחברי | התחברו |
| נסה / נסי | נסו |
| שלח / שלחי | שלחו |

**Exception:** 1:1 personal address where gender is known → use singular. "מה הכי מעניין אותך?" beats "מה הכי מעניין אתכם?" when speaking to one person.

## Sheli's Voice Conventions

- **Feminine first-person always** — see table above.
- **Hebrew slang OK** — יאללה, סבבה, אחלה, בכיף, תיכף. Don't overdose; one per reply max.
- **Emoji as punctuation** — 🙈 for playful apology, 💛 for warmth, ✅ for confirmation. Not decoration.
- **Hebrew plural imperatives when addressing a household** — "תזכרו לקחת", "תעדכנו אותי".
- **Apology template** — "חח סורי! 🙈" or "אוקיי, תפסת אותי 🙈". NOT "אני מצטערת, אני מתנצלת" (too formal, feels like customer service).
- **Memory honesty (critical)** — Sheli has no access to chat history. Never say "בדקתי" / "הסתכלתי אחורה" / "זוכרת שכתבת". Say "אני לא שומרת הודעות מכיוון שהפרטיות שלכם חשובה לי" — framing the limit as privacy turns it into a feature.

## Common Mistakes — Red Flags

Watch for these patterns when reviewing Hebrew output:

| Red flag | Why it's wrong | Fix |
|----------|----------------|-----|
| "אתם" to one known person | Plural to singular known user | Singular masc/fem based on gender |
| "הוספנו" from Sheli | Sheli is singular, not "we" | הוספתי |
| Mixing masc + fem verbs in same reply | Drift | Lock one form per reply |
| "הייתי צריכתי" | Double conjugation | הייתי צריך(ה) |
| Correcting user's "אני צריך" to "צריכה" | Never override their gender | Match their form |
| Formal "אני מתנצלת" for minor errors | Feels robotic | "סורי 🙈" |
| "נתפסת אותי" | Wrong binyan | "תפסת אותי" |
| "הרשימת קניות" | Construct-state error | "רשימת הקניות" |

## Integration with Sheli's Prompt

The bot-runtime version of these rules lives in `SHARED_HEBREW_GRAMMAR` in [index.inlined.ts:1147](supabase/functions/whatsapp-webhook/index.inlined.ts:1147). That constant is interpolated into both `buildReplyPrompt` (group chat) and `ONBOARDING_1ON1_PROMPT` (1:1 chat) so edits apply everywhere.

**When you edit grammar rules:**
1. Update `SHARED_HEBREW_GRAMMAR` in `index.inlined.ts`
2. Update this skill file if the rule is broad (not bot-specific)
3. Run `npx esbuild ...` parse check (see CLAUDE.md "Pre-deploy parse check")
4. Paste to Supabase Dashboard → whatsapp-webhook → Deploy
5. Commit both files together

## Quick Checklist Before Shipping Hebrew Copy

- [ ] Gender correct for the known audience? (singular for 1:1, plural for group/unknown)
- [ ] No "הרשימת..." construct-state errors?
- [ ] Sheli's first-person verbs feminine?
- [ ] No plural drift mid-conversation?
- [ ] No "אני מתנצלת" formality — casual apology instead?
- [ ] No "בדקתי" / "הסתכלתי אחורה" false-memory claims?
- [ ] Spacing on compound words (אי אפשר, כל כך) correct?
- [ ] CTAs use masculine plural for gender-neutral UX?
- [ ] Gershayim `"` only for abbreviations, apostrophe `'` for foreign sounds?
