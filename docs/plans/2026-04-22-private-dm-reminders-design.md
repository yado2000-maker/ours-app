# Private DM Reminders — Design

**Date:** 2026-04-22
**Author:** Sheli team
**Status:** Approved — ready for implementation plan
**Related CLAUDE.md TODO:** "Private DM reminders for rotations/assigned tasks"

## Motivation

Niv Kaye asked Sheli on 2026-04-21: `בבקשה להזכיר להם גם בפרטי` — remind each
kid privately, in addition to the group reminder, for the dishwashing rotation.
Sheli replied affirmatively (`תזכורות יגיעו גם בהודעה פרטית`) but the feature
doesn't exist. Today a single `reminder_queue` row (`62e8bb19`) covers
Jonathan's Wed 2026-04-22 07:00 UTC DM, inserted manually in SQL. Every future
request currently requires manual DB work. This is a trust-critical gap —
Sheli promised in chat.

## Goals

1. Let a user ask in natural Hebrew for a reminder delivered privately (DM),
   in addition to or instead of the group reminder.
2. Support rotation-aware fan-out: "remind each person on their day" resolves
   to N per-member recurring reminders automatically.
3. Graceful fallback when a rotation member has no known phone — degrade to a
   group reminder for that member's days rather than silently dropping them,
   and tell the user.
4. Zero regression for existing (non-private) reminders.
5. All outbound stays routed through `fire_due_reminders_inner()` — no new
   outbound path, inherits 4-layer kill switch and 24h customer-care-window
   gating for free.

## Non-goals

- Per-recipient delivery receipts ("Sheli showed you when everyone read it").
- Rotation creation / editing from inside a reminder command (out of scope —
  requires rotation UX rework).
- Cross-household reminders (can't DM a number that isn't mapped to some
  household yet).
- Re-introducing a quiet-hours early-return. User-scheduled reminders fire at
  their `send_at`, period. Anti-spam stays gated per-recipient via
  `il_window_open_for_chat`.

## Decisions (from brainstorming, 2026-04-22)

### Q1 — Delivery mode vocabulary

New field `delivery_mode: 'group' | 'dm' | 'both'`, default `'group'`
(backward compatible).

| Phrase | `delivery_mode` |
|---|---|
| `בפרטי` (bare) / `תזכירי לי בפרטי` / `תזכירי לו בפרטי` / `privately` | `dm` |
| `גם בפרטי` / `also privately` / `also in DM` | `both` |
| `בפרטי בלבד` / `רק בפרטי` / `privately only` | `dm` |
| `בקבוצה` / `בקבוצתי` / `במשפחתי` / `בווטסאפ המשותף` / `in the group` | `group` |
| _(no privacy marker)_ | `group` |

### Q2 — Rotation recipient resolution

**A (primitive) + B (resolver shortcut).** Store `recipient_phones TEXT[]` on
`reminder_queue` as the core primitive. Add a resolver at add-time that
compiles rotation phrases into N per-member recurring reminders, each with
its own `days` slice and single-element `recipient_phones`.

Rotation trigger phrases (classifier prompt + Sonnet prompt):
`לפי התור`, `בתורות`, `בתורנות` / `תורנות` / `תורנים`, `מתחלפים`,
`כל יום ילד אחר` / `כל יום מישהו אחר`, `לפי התורנות`, `מי שהתור שלו`.

### Q3 — Missing-phone fallback — Option D (hybrid)

| Shape of request | Behavior |
|---|---|
| Single-person request, phone unknown | Refuse; Sheli asks person to DM bot once. No DB row created. |
| Rotation with some members' phones missing | Partial-create: `dm` rows for resolved members, `group` rows for missing members tagged `metadata.missing_phone_for`. |
| All members missing (multi-person rotation, all unmapped) | Refuse; list all names. |

Future-proofing: when a new `whatsapp_member_mapping` row lands, a one-shot
`UPDATE` upgrades future unsent group-fallback reminders to `dm` for that
member. Nice-to-have, not v1 blocker.

### Q4 — Schema shape

Array column, no child table. Justification:
1. Existing row-level invariants (`attempts`, `sent`, `sent_at`, `metadata`)
   fit fan-out-as-a-unit perfectly.
2. Per-recipient window-check happens inside the row loop, not via schema.
3. Whapi is already fire-and-forget; per-recipient retry complexity buys
   nothing given `attempts < 3` cap.

No child table `reminder_recipients`. YAGNI.

## Data model

```sql
-- Migration: 2026_04_22_reminder_fanout.sql
ALTER TABLE public.reminder_queue
  ADD COLUMN IF NOT EXISTS recipient_phones TEXT[],
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT
    CHECK (delivery_mode IN ('group','dm','both')) DEFAULT 'group';
```

Both columns NULLABLE / defaulted. Existing rows unchanged.

## Routing at fire-time

| `delivery_mode` | `recipient_phones` | Targets Whapi sends to |
|---|---|---|
| `group` (default) | ignored | `row.group_id` (1 msg) |
| `dm` | `[p1, p2]` | `p1@s.whatsapp.net`, `p2@s.whatsapp.net` |
| `both` | `[p1, p2]` | `row.group_id` + both DMs (3 msgs) |

Empty `recipient_phones` when `delivery_mode='dm'` → row marked `sent=true`
with `metadata.note='no_recipients'`. Never blocks drain.

## Block shapes (Sonnet-emitted)

### REMINDER (one-shot) — extended

```json
<!--REMINDER:{
  "reminder_text": "לשטוף כלים",
  "send_at": "2026-04-22T07:00:00+03:00",
  "delivery_mode": "dm",
  "recipient_phones": ["972501234567"]
}-->
```

### RECURRING_REMINDER — extended

```json
<!--RECURRING_REMINDER:{
  "reminder_text": "יונתן — לשטוף כלים",
  "days": [3],
  "time": "07:00",
  "delivery_mode": "dm",
  "recipient_phones": ["972501234567"]
}-->
```

### MISSING_PHONES (new — blocks insertion, drives fallback UX)

```json
<!--MISSING_PHONES:{
  "known":   [{"name":"יונתן","phone":"972501111111"},
              {"name":"איתן","phone":"972502222222"}],
  "unknown": ["נגה"],
  "reminder_text": "לשטוף כלים",
  "delivery_mode": "dm",
  "send_at_or_recurrence": { "days":[3,4,5], "time":"07:00" }
}-->
```

## Classifier changes (`_shared/haiku-classifier.ts` + inlined copy)

Extend `add_reminder` intent entities:
- `delivery_mode?: "group" | "dm" | "both"` (parsed from privacy phrases)
- `recipient_names?: string[]` (names only; phone resolution deferred)

Add 4+ new examples covering bare `בפרטי`, `גם בפרטי`, rotation shortcut
with `בתורנות`, and `במשפחתי` override.

## Sonnet prompt changes

Two new context blocks injected per-turn:

- **PHONE MAPPINGS** — household's `whatsapp_member_mapping` as `name → phone`
  pairs. Used to fill `recipient_phones`.
- **ROTATIONS** — active rotations (name, members in order, weekly days).
  Only included if `rotations` rows exist.

New rules added to `SHARED_REMINDERS_RULES` (shared between `buildReplyPrompt`
and `ONBOARDING_1ON1_PROMPT`):

- PRIVATE DELIVERY: emit `delivery_mode` + `recipient_phones` when appropriate.
- MISSING PHONE: emit `MISSING_PHONES` block instead of REMINDER when one or
  more named recipients has no phone in PHONE MAPPINGS.
- ROTATION SHORTCUT: compile to N per-member RECURRING_REMINDER blocks with
  filtered `days`.

## Add-time resolver (in `index.inlined.ts`)

Two new helpers:

1. `resolveRecipientNamesToPhones(names, householdId) → { resolved, missing }`
   — `ilike` lookup in `whatsapp_member_mapping`, handles `הילדים` / `המשפחה`
   / `כולם` shortcuts via `household_members`.
2. `expandRotationShortcut(rotation, householdId) → RECURRING_REMINDER[]`
   — reads `rotations` table, emits one block per member with their days.

Extended `rescueRemindersAndStrip`:
- REMINDER / RECURRING_REMINDER blocks: trust Sonnet-emitted
  `recipient_phones`; fall back to local resolution if only `recipient_names`
  present.
- MISSING_PHONES blocks: drive Option D fallback UX (see Missing-phone flow).
- Insert rows with new columns populated.

## Missing-phone flow (Option D)

Implemented inside `rescueRemindersAndStrip`, triggered by MISSING_PHONES block:

```
Case 1: unknown.length === 1 && known.length === 0
  → Insert nothing.
  → Reply: "לא מצאתי מספר של {name}. תבקשו ממנה לשלוח לי הודעה פרטית פעם אחת
            ואז תוכלו לבקש שוב. 🙏"

Case 2: known.length > 0 && unknown.length > 0
  → Insert N rows (dm) for known members.
  → Insert M rows (group, metadata.missing_phone_for=name) for unknown members.
  → Reply naming both groups.

Case 3: known.length === 0 && unknown.length > 1
  → Insert nothing. Reply listing all unknown names.
```

Existing `COMMITMENT_PHRASE_REGEX` safety net counts MISSING_PHONES blocks as
emissions — no false-positive `[CommitmentWithoutEmission]` WARNs.

## Drain changes (`fire_due_reminders_inner` v4)

Migration: `2026_04_22_reminder_fanout_drain.sql` (supersedes v3).

Inside the existing row loop (quiet-hours gate stays removed from 2026-04-20):

```
Build v_targets based on delivery_mode:
  'group' → [row.group_id]
  'dm'    → [phone || '@s.whatsapp.net' for phone in recipient_phones]
  'both'  → [row.group_id] ++ dm_targets

For each target:
  If NOT il_window_open_for_chat(target):
    push to v_skipped_closed_window; continue
  net.http_post(Whapi, to=target, body=v_msg_body)
  push to v_sent_targets

Mark row sent=true + sent_at=NOW(), attempts += 1.
metadata.fanout = { sent_to, skipped, mode }.
```

Rate characteristics:
- Worst case: 10 rows/min × 3 recipients = 30 Whapi calls/min.
- Still far below the ban threshold (40+/hr of anti-spam-classified sends).
- Per-recipient window check preserves the real anti-spam gate.

## Materializer change

`materialize_recurring_reminders()` — copy `recipient_phones` and
`delivery_mode` from parent to each materialized child row. One-line INSERT
change.

## Missing-phone reconciliation (nice-to-have)

When `whatsapp_member_mapping` insert completes for a new member:

```sql
UPDATE reminder_queue
   SET delivery_mode    = 'dm',
       recipient_phones = ARRAY[NEW.phone_number],
       metadata = metadata || '{"auto_upgraded_from_group_fallback": true}'
 WHERE household_id = NEW.household_id
   AND sent = false
   AND delivery_mode = 'group'
   AND metadata->>'missing_phone_for' ILIKE '%' || NEW.member_name || '%';
```

Can ship in a follow-up PR.

## Verification

### Unit tests (new: `tests/test_recipient_fanout.py`)

Pure Python parser + resolver tests, 8+ cases covering block shapes and
resolution edge cases.

### Integration tests (add to `tests/test_webhook.py`)

8 new end-to-end cases, hits real Edge Function + Supabase:

1. `תזכירי לי בפרטי לשלם חשבון חמישי ב-10` → dm, self
2. `תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7` → both, jonathan
3. `תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7` → N dm rows
4. Same as #3 with Noga unmapped → J+E dm, Noga group-fallback
5. `תזכירי לנגה בפרטי מחר ב-9` (single unknown) → refuse, 0 rows
6. `תזכירי ביום חמישי במשפחתי להביא שמיכות` → group (explicit override)
7. Legacy `תזכירי לי מחר ב-10` → group (backward compat)
8. Reconciliation: after Noga DMs bot, new reminder resolves dm

### Pre-deploy

Pre-deploy esbuild parse-check on `index.inlined.ts`:

```
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

### Runtime validation SQL

```sql
SELECT id, delivery_mode, recipient_phones, group_id,
       metadata->'fanout' AS fanout_status,
       sent, sent_at
  FROM reminder_queue
 WHERE household_id = '<hhid>'
   AND created_at > NOW() - INTERVAL '1 hour'
 ORDER BY send_at DESC;
```

## Rollout

1. Migration applies additively (all new columns default / nullable).
2. Deploy Edge Function.
3. Backfill: none — existing rows default to `delivery_mode='group'`.
4. Recovery posture respected: feature is live but inert until
   `bot_settings.reminders_paused='false'` is flipped. That flip is a
   separate operator action tied to ban-recovery, NOT this PR.
5. Retire the manual `62e8bb19` row by flipping it to a RECURRING_REMINDER
   parent for Jonathan (one-liner UPDATE). Kaye family will receive
   Jonathan's Wednesday DM via this path going forward, once the feature
   ships and reminders resume.

## Risks

- **Whapi double-delivery on partial HTTP error** — If target 1 succeeds and
  target 2 throws, the EXCEPTION path increments `attempts` without marking
  `sent=true`. Target 1 gets the reminder twice on retry. Whapi's own
  dedup window mitigates; `attempts < 3` caps blast radius. Acceptable.
- **Name resolution ambiguity** — `ilike '%name%'` may match multiple
  members. Resolver takes `limit 1`; if this turns out to be wrong for a
  real household, fix case-by-case rather than building a disambiguation UX
  prematurely. Logged with WARN so triage is possible.
- **Sonnet hallucinates `recipient_phones`** — Phone numbers it didn't see in
  PHONE MAPPINGS. Mitigation: add-time resolver re-validates every phone
  against `whatsapp_member_mapping` before insert; unknown phones are
  rejected with WARN + refuse-reply. Unit-tested.
