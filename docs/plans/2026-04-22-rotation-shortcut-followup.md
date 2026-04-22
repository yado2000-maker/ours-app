# Rotation Shortcut — Follow-up Report

**Date:** 2026-04-22
**Status:** Known limitation — shipped v1 without rotation shortcut, deferred to follow-up
**Related:**
- `docs/plans/2026-04-22-private-dm-reminders-design.md`
- `docs/plans/2026-04-22-private-dm-reminders-plan.md`
- Commits `e6b5dc1`, `ee39424`, `163465d`, `11af15f` on branch `claude/objective-fermat-b20fd5`

## What shipped (v1)

Private DM reminders work for these phrasings:

| Phrasing | Works? |
|---|---|
| "תזכירי לי בפרטי לשלם חשבון חמישי ב-10" (self) | ✓ |
| "תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7" (named, mapped) | ✓ |
| "תזכירי לנגה בפרטי מחר ב-9" (named, unmapped) → refuse | ✓ |
| "תזכירי ביום חמישי במשפחתי להביא שמיכות" (explicit group) | ✓ |
| "תזכירי לי מחר ב-10 להתקשר לסבתא" (legacy, no privacy) | ✓ |
| Auto-upgrade group-fallback to dm on new mapping | ✓ |
| **"תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7"** (rotation shortcut) | **✗** |

## The rotation-shortcut failure

### Repro

Group has rotation `"שטיפת כלים"` with members `[יונתן, איתן]`, both mapped to phones.
User sends: `תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7`
Expected: 2 RECURRING_REMINDER parent rows created, one per kid, each `delivery_mode='dm'` with their own `recipient_phones`.
Actual:
- Sonnet replies: `אזכיר לכל ילד ב-7:00 בתורו בפרטי ✓` (sounds like it worked)
- DB state: **zero reminder_queue rows created**

### Root cause

Sonnet is "bluffing" — the visible reply acknowledges the request but emits no
RECURRING_REMINDER blocks and no MISSING_PHONES block. The server-side
enrichment/refuse/split logic has nothing to work with.

**Why Sonnet can't generate per-member blocks:**
1. `buildReplyPrompt` (lines ~1552-1690) injects ACTIVE ROTATIONS context
   ONLY into `stateContext` when `classification.intent === "question"`
   (line 1524). For `add_reminder` intent, the Sonnet prompt sees NO
   rotation data.
2. Without rotation data, Sonnet cannot know:
   - Which rotation the user referenced ("בתורנות" — which one?)
   - Member list and their day-of-week assignments
3. The Sonnet RECURRING REMINDERS prompt section says "emit ONE
   RECURRING_REMINDER PER member ... days = just that member's days (from
   the rotation)" — but Sonnet has no rotation to read from.
4. Sonnet's training tendency is to acknowledge with a plausible reply
   rather than fail silently. So it says "אזכיר לכל ילד בתורו" and moves on.

### Server-side enrichment can't paper over this

My fan-out enrichment handles:
- `delivery_mode` merge from Haiku entities when Sonnet omits it
- `recipient_phones` resolution when Sonnet omits them
- Split-by-phone when resolution yields >1 phone (creates N parents)
- Refuse short-circuit when all named recipients unknown

None of this helps when Sonnet emits **zero RECURRING_REMINDER blocks** in
the first place. The Haiku-entities fallback in the actionable path (line
~8313) only synthesizes **one-shot** REMINDER blocks from `entities.time_iso`
— not recurring.

## Proposed fix (tomorrow)

Two complementary changes — either alone might work; doing both is safer.

### Fix 1 (preferred): Inject ACTIVE ROTATIONS into add_reminder Sonnet prompt

File: `supabase/functions/whatsapp-webhook/index.inlined.ts`, function
`buildReplyPrompt` (~line 1400).

Currently `stateContext` is only built for `intent === "question"`
(line 1524). Move the rotation-rendering piece OUT of `stateContext` and
into an always-rendered block, or add a parallel block that renders for
`intent === "add_reminder"` too.

```typescript
// Render rotations separately — include for add_reminder too so Sonnet
// can emit per-member RECURRING_REMINDER blocks for rotation shortcuts.
const rotations = ctx.currentRotations || [];
const rotationsStr = rotations.length === 0 ? "" : `
ACTIVE ROTATIONS (use to resolve rotation-shortcut reminders):
${rotations.map((r: any) => {
  const members = Array.isArray(r.members) ? r.members : JSON.parse(r.members);
  const freq = typeof r.frequency === "string" ? JSON.parse(r.frequency) : r.frequency;
  // Derive per-member days if frequency.days lists days-of-week
  return `- "${r.title}": members=${JSON.stringify(members)} frequency=${JSON.stringify(freq)}`;
}).join("\n")}`;
```

Then inject into the prompt near PHONE MAPPINGS.

Expected effect: Sonnet now has enough context to emit per-member
RECURRING_REMINDER blocks with each member's days slice. Existing
server-side split-by-phone logic is the safety net when Sonnet emits one
combined block.

### Fix 2 (belt-and-suspenders): Server-side rotation expansion from Haiku entities

If Sonnet still bluffs after Fix 1, add server-side fallback: when
`classification.intent === "add_reminder"` AND `entities.delivery_mode` ∈
{dm, both} AND the message contains rotation-shortcut keywords (בתורנות / לפי התור / מתחלפים /
כל יום ילד אחר) AND there's at least one active rotation AND Sonnet emitted
no RECURRING_REMINDER blocks → look up the active rotation, iterate its
members, emit N RECURRING parents server-side (one per member, days derived
from `frequency.days`).

Placement: in the actionable path, right after the RECURRING_REMINDER
extraction + enrichment pass. If `recurringBlocks.length === 0` and the
rotation-shortcut conditions are met, call a helper
`synthesizeRotationRecurringBlocks(household, rotation, entities)` that
queries `rotations` + `whatsapp_member_mapping` and builds the blocks.

Complexity: requires mapping Hebrew day names (`רביעי`/`חמישי`/`שישי`) ↔
DOW integers + parsing `frequency.days` (stored as `["wed","thu","fri"]`
strings) into those integers. Existing rotation materialization code
(`materializeDutyRotation`) already does this — extract + reuse.

## Test coverage after fix

Re-enable the two currently-failing assertions in `test_webhook.py`:
- `test_03_rotation_all_mapped`: expects ≥2 dm recurring rows, each with 1
  recipient_phone
- `test_04_rotation_missing_phone`: expects dm rows for mapped kids +
  group-fallback row tagged `missing_phone_for="נגה"` + reply mentioning
  נגה or בקבוצה

Both tests are ALREADY in the test file and will run automatically when
the fix lands.

## Impact assessment

### Who's actually affected

**Niv Kaye's original ask** (2026-04-21):
> בבקשה להזכיר להם גם בפרטי

This was a natural-language rotation-shortcut request. Niv is the one
user we know is actively requesting this feature. Without the fix, Niv
would need to either:
1. Rephrase per-child: `תזכירי ליונתן בפרטי כל רביעי לשטוף כלים` ×3 (works today)
2. Wait for the fix

### Risk of shipping v1 without the fix

- Niv gets "אזכיר לכל ילד בתורו בפרטי ✓" → no reminders fire → broken trust
  REPEATED from the original 2026-04-21 incident that motivated this feature.
- Other users trying rotation shortcuts have the same silent-fail UX.

**Mitigation until fix lands:**
Do NOT advertise the rotation shortcut in any onboarding/help text. The
per-child workaround works today and is the safer path to communicate.

### Manual workaround for Kaye family (today)

Same approach as the original manual row `62e8bb19` (being retired in Task
16): insert RECURRING_REMINDER parents directly via SQL for the rotation
members. The feature works; only the shortcut phrasing fails.

## Next-day steps

1. Apply Fix 1 (rotation context in Sonnet prompt). Deploy. Rerun tests.
2. If tests still fail, apply Fix 2 (server-side synthesis). Deploy. Rerun.
3. Once test_03 + test_04 pass, update this doc to "resolved" and remove
   the "rotation shortcut doesn't work" caveat from CLAUDE.md.
4. Reach out to Niv with the working flow.

## Related files

- `supabase/functions/whatsapp-webhook/index.inlined.ts` — `buildReplyPrompt` (line ~1400), actionable REMINDER/RECURRING_REMINDER handler (~line 8295)
- `tests/test_webhook.py` — `TestPrivateDmReminders.test_03_rotation_all_mapped` + `test_04_rotation_missing_phone`
- `supabase/migrations/2026_04_22_reminder_fanout.sql` — schema
- `supabase/migrations/2026_04_22_reminder_drain_v4.sql` — drain
