# Reminder Schedule — Generic Follow-up Policy Design (2026-04-21)

## Context

Sheli's reminder system today supports exactly two shapes:

1. **One-shot reminder** at a specific `send_at` timestamp.
2. **Daily recurrence** via `reminder_queue.recurrence = {days:[0..6], time:"HH:MM"}`, materialized 7 days ahead by a nightly pg_cron (`materialize_recurring_reminders_daily`).

Real user asks have proven richer. The motivating incident (Netzer family, 2026-04-20 and 2026-04-21): *"תזכירי לעופרי כל ערב ב-8 לקחת כדור, ואל תפסיקי להזכיר כל חצי שעה עד שהיא מאשרת שלקחה."* Sheli verbally committed (*"אזכיר יומית ב-20:00 ואמשיך כל 30 דק עד שתאשר"*) but the schema cannot express "every 30 min until ack", so only the 20:00 parent fired for two consecutive days. The family confronted Sheli both mornings — the worst failure mode: *verbal commitment without matching ACTIONS*.

Other real asks already in the backlog that the same gap blocks:

- "תזכירי לי יום לפני החשבון חשמל ושעה לפני" — stages *before* an anchor.
- "תזכירי לי כל יום לשלם חשבון עד ששילמתי" — daily ping until ack.
- "תזכירי לי על הפגישה 3 ימים לפני, יום לפני, ובבוקר עצמו" — multi-stage before.
- "תזכירי לי כל חצי שעה לאסוף את הכביסה מהחצר" — interval-until-ack at an ad-hoc moment.

This document designs a **single generic component** — a `followup_policy` jsonb attached to any reminder — that composes with existing daily recurrence to cover all of these, without a breaking migration.

## Goals

- Express all four real-world asks above in ONE data shape.
- Compose cleanly with today's daily `recurrence` (no breaking change).
- Let Sonnet emit the policy as an `ACTIONS` object without cryptic overload.
- Give the drain a simple, single-responsibility extension point.
- Safe by default: hard cap on follow-up count, quiet-hours respect, idempotent ack detection.

## Non-goals

- **Branch-to-person escalation** ("if ignored, ping mom instead") — deferred to Phase 3.
- **User-configurable quiet hours per session** — use household global for now.
- **Cross-household sessions** — out of scope.
- **Reply-based re-scheduling** ("שלי, תזכרי לי שוב בעוד 10 דק") — already covered by separate `add_reminder` flow.

## Concept — the composition

Every reminder parent row may carry an optional `followup_policy` jsonb. The policy describes what fires *around* the anchor (the parent's `send_at`). Three composable primitives:

| Primitive | Meaning | Example |
|---|---|---|
| `stages_before` | Fire N children at offsets *before* anchor | "יום לפני, שעה לפני" |
| `interval_until_ack` | After anchor, fire every N min until an ack phrase appears in chat | "כל חצי שעה עד שלקחה" |
| `stages_after` | Fire N children at fixed offsets *after* anchor | "בעוד שעה, בעוד 3 שעות" (no ack loop) |

A policy picks ONE `kind`. Combinations use `kind: "combined"` with `before[]` and `after` fields. Four real asks map cleanly:

| User ask | `kind` | Shape |
|---|---|---|
| Netzer pill (every 30 min until ack) | `interval_until_ack` | `{interval_minutes:30, max_count:6, stop_at_il:"23:30", ack_phrases:["לקחתי","לקחה","אישרתי"]}` |
| "1 day + 1 hour before bill" | `stages_before` | `{offsets:[{days:-1},{hours:-1}]}` |
| "1 hour after, then 3 hours after" | `stages_after` | `{offsets:[{hours:1},{hours:3}]}` |
| "3 days + 1 day before + every day until paid" | `combined` | `{before:[{days:-3},{days:-1}], after:{kind:"interval_until_ack",interval_minutes:1440,max_count:5,ack_phrases:["שילמתי"]}}` |

Orthogonality with existing daily recurrence:

- `recurrence = {days:[1,2,3,4,5], time:"20:00"}` creates a daily parent each morning for today.
- Each materialized child *inherits* the parent's `followup_policy`.
- The child fires at 20:00, then its own followups fire at 20:30, 21:00, ... per the policy.
- Fresh ack session per day (session_id encodes the date) — yesterday's ack doesn't silence today's loop.

## Data model

### Schema migration

```sql
-- Migration: 2026_04_XX_reminder_followup_policy.sql
ALTER TABLE reminder_queue
  ADD COLUMN followup_policy jsonb,
  ADD COLUMN followup_session_id text,
  ADD COLUMN followup_parent_id uuid REFERENCES reminder_queue(id) ON DELETE CASCADE;

CREATE INDEX idx_reminder_queue_followup_session
  ON reminder_queue(household_id, followup_session_id)
  WHERE followup_session_id IS NOT NULL;

CREATE INDEX idx_reminder_queue_followup_parent
  ON reminder_queue(followup_parent_id)
  WHERE followup_parent_id IS NOT NULL;

-- Per-session ack ledger
CREATE TABLE followup_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id text NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  acked_at timestamptz NOT NULL DEFAULT NOW(),
  acked_by_phone text,
  ack_text text,
  CONSTRAINT uq_followup_acks_session UNIQUE (household_id, session_id)
);

ALTER TABLE followup_acks ENABLE ROW LEVEL SECURITY;
-- Service-role-only table; no policies needed.
```

### `followup_policy` shape (jsonb)

```jsonc
// Kind 1: interval-until-ack
{
  "kind": "interval_until_ack",
  "interval_minutes": 30,      // required, >= 5
  "max_count": 6,              // required, 1..10 (hard cap)
  "stop_at_il": "23:30",       // optional, HH:MM IL — stops at this wall time
  "stop_after_hours": 6,       // optional, max hours from first fire
  "ack_phrases": ["לקחתי","לקחה","אישרתי","בוצע","done","took it"],
  "override_quiet_hours": false,  // default false
  "message_template": "עופרי — תזכורת שוב, הכדור 💊 ({n}/{max})"  // optional; {n},{max} substituted
}

// Kind 2: stages-before
{
  "kind": "stages_before",
  "offsets": [
    {"days": -1, "label": "יום לפני"},
    {"hours": -1, "label": "שעה לפני"}
  ]
}

// Kind 3: stages-after (no ack)
{
  "kind": "stages_after",
  "offsets": [
    {"hours": 1},
    {"hours": 3}
  ]
}

// Kind 4: combined
{
  "kind": "combined",
  "before": [{"days": -3}, {"days": -1}],
  "after":  {
    "kind": "interval_until_ack",
    "interval_minutes": 1440,
    "max_count": 5,
    "ack_phrases": ["שילמתי"]
  }
}
```

### `followup_session_id` convention

`{topic}_{YYYY-MM-DD}` — e.g. `pill_2026-04-21`, `electricity_bill_2026-05-10`, `laundry_2026-04-21`. Date suffix ensures fresh session per recurrence instance; `topic` disambiguates when multiple sessions run in parallel in the same household (pill + trash + laundry all active).

## Code flow

### (A) Intake — Sonnet emits the ACTION

New `reminder_with_followups` action type. ACTIONS schema extension in both `buildReplyPrompt` (group) and `ONBOARDING_1ON1_PROMPT` (1:1):

```
- reminder_with_followups: {
    "type": "reminder_with_followups",
    "text": "עופרי — לקחת כדור",
    "send_at": "2026-04-21T20:00:00+03:00",
    "session_id": "pill_2026-04-21",
    "followup_policy": { ... see shapes above ... },
    "recurrence": {"days":[0,1,2,3,4,5,6], "time":"20:00"}  // optional — daily anchor
  }
```

If `recurrence` is present too, the parent is a daily-recurring parent (existing mechanic) — each materialized child for each day inherits the `followup_policy`. `session_id` is re-computed per-day by the materializer (suffixing that day's date).

### (B) Execution — `execute*Actions` handler

One DB insert (parent row) with the policy jsonb. No children materialized upfront — saves DB bloat when the follow-up loop may never run (if ack arrives before the first follow-up).

```ts
// pseudocode
await supabase.from("reminder_queue").insert({
  household_id, group_id,
  message_text: action.text,
  send_at: action.send_at,
  sent: false,
  reminder_type: "user",
  recurrence: action.recurrence ?? null,
  followup_policy: action.followup_policy ?? null,
  followup_session_id: action.session_id ?? null,
});
```

### (C) Fire — `fire_due_reminders_inner` v4

Extend the existing drain (migration `2026_04_20_reminder_drain_v2.sql`):

```sql
-- Pseudocode additions inside the for-loop:
--   After the existing window/quiet-hours checks but BEFORE net.http_post:
IF v_row.followup_session_id IS NOT NULL THEN
  SELECT 1 INTO v_acked FROM followup_acks
    WHERE household_id = v_row.household_id
      AND session_id = v_row.followup_session_id;
  IF FOUND THEN
    UPDATE reminder_queue SET sent = true,
      metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{note}', '"acked_pre_fire"')
      WHERE id = v_row.id;
    CONTINUE;  -- skip send
  END IF;
END IF;

-- ...existing net.http_post call...

-- AFTER successful fire, if followup_policy present, schedule next children:
IF v_row.followup_policy IS NOT NULL THEN
  PERFORM schedule_followups(v_row.id);
END IF;
```

### (D) `schedule_followups(p_parent_id)` — new PG function

Reads the parent's policy + session_id. For:

- **`stages_before`** — nothing to do at fire time (children scheduled upfront at insert — see Intake note below for stages_before exception).
- **`interval_until_ack`** — inserts ONE next-child row at `parent.send_at + interval_minutes`, up to `max_count`. Each new child is inserted when ITS predecessor fires (daisy-chained) — not all upfront. Keeps the queue small + lets an ack mid-chain cancel the rest.
- **`stages_after`** — insert all N rows upfront with `send_at` at each offset.
- **`combined`** — behavior per sub-kind.

**Intake exception for stages_before**: because `stages_before` children fire *before* the anchor, they must be inserted at intake time (otherwise the anchor fire triggers them retroactively). Intake handler detects `stages_before` / `combined` and inserts the before-children immediately alongside the parent.

### (E) Ack detection — webhook handler

New module: `followup-ack-detector.ts` called from `Deno.serve` for group + 1:1 messages *after* `logMessage` and *before* Haiku classification:

```ts
// Pseudocode
const activeSessions = await supabase
  .from("reminder_queue")
  .select("followup_session_id, followup_policy")
  .eq("household_id", ctx.householdId)
  .not("followup_session_id", "is", null)
  .eq("sent", false)
  .gt("send_at", new Date().toISOString());  // only sessions with still-pending children

for (const session of dedupBySessionId(activeSessions)) {
  const phrases = session.followup_policy?.ack_phrases ?? DEFAULT_ACK_PHRASES;
  if (textContainsAnyPhrase(message.text, phrases)) {
    // strict match — insert ack + cancel remaining
    await insertAck(ctx.householdId, session.followup_session_id, message);
    await cancelPendingFollowups(session.followup_session_id);
    // Optional: bot posts brief confirmation
    return { matched: true, session_id: session.followup_session_id };
  }
}
// Phase 2: ambiguous message + active session → Haiku yes/no classification
```

Strict phrase match is the MVP. Haiku-based fuzzy ack (phase 2) handles "עופרי כבר לקחה" or "סיימתי" without listing every variant.

### (F) Cancel pending followups

```sql
-- Triggered on ack OR manual admin SQL
DELETE FROM reminder_queue
WHERE household_id = $1
  AND followup_session_id = $2
  AND sent = false;
```

ON DELETE CASCADE on `followup_parent_id` means if the parent daily row is deleted, all its children (and their grandchildren daisy-chained) cascade clean.

## Prompt / intent changes

### Haiku classifier

No new intent needed for MVP — the existing `add_reminder` intent routes to Sonnet. Add a single rule in the Haiku prompt:

> When the user's reminder request includes a repeat pattern (*"כל X דקות/שעות"*, *"עד שX"*, *"every N"*, *"until"*) OR multiple stages (*"יום לפני וגם שעה לפני"*), classify as `add_reminder` with `confidence >= 0.8`. Route to Sonnet — do NOT truncate the pattern into a single fire time.

### Sonnet — ACTIONS schema

Add `reminder_with_followups` under the REMINDERS section, with 3 canonical examples (pill, bill, laundry). Add a "when to pick this vs `reminder` / `recurring_reminder`" decision rule:

> Use `reminder_with_followups` when the user asks for ANY of: (a) repeat-until-ack behavior, (b) multi-stage before/after an event, (c) escalation. Use plain `reminder` for one-shot. Use `recurring_reminder` for pure daily/weekly-at-same-time with no follow-up loop.

Reinforce the **COMMITMENT-EMISSION INVARIANT** (rule 20): if the visible reply promises a repeat ("אמשיך להזכיר כל 30 דק"), the ACTIONS entry MUST be `reminder_with_followups` with matching policy — never fall back to a plain one-shot.

## Edge cases

1. **Quiet hours** — followup children default to respecting `is_quiet_hours_il()` (rescheduled to next non-quiet window). Override with `policy.override_quiet_hours: true` (pill case likely opts in; most asks stay off). Matches CLAUDE.md 2026-04-20 rule *"quiet hours no longer block user-scheduled reminders"* — user explicitly picked the cadence.

2. **Max cap** — `interval_until_ack.max_count` is hard-capped at 10 per session (validated in `schedule_followups`). Protects against Sonnet emitting `max_count: 100`.

3. **Duplicate session collision** — `session_id = {topic}_{date}`. Two pill sessions on the same day would collide; `UNIQUE (household_id, session_id)` on `followup_acks` prevents duplicates there, but parent inserts would conflict. Resolution: Sonnet must include hour in session_id when second-of-the-day is actually intended, else the system de-dupes the request with a polite "כבר יש תזכורת כזאת פעילה".

4. **Ack without session_id** — user types "לקחתי" with multiple active sessions (pill + trash + laundry). Phase 1: match the first session whose ack_phrases contain the exact substring. Phase 2: Haiku disambiguates using session topics injected into the prompt.

5. **Edits / rescheduling** — if user changes the anchor time, update parent.send_at, DELETE all pending children with `followup_parent_id = parent.id`, reschedule on next fire. Helper: `reset_followup_chain(p_parent_id)`.

6. **Ofri is sick / on vacation, pause for a day** — new "skip-today" intent OR manual `INSERT INTO followup_acks` with today's session_id. CLI shortcut: `python scripts/pause_followup.py --household X --session pill_2026-04-21`.

7. **BOT_SILENT_MODE interaction** — drain uses direct `net.http_post` (bypasses BOT_SILENT_MODE, per CLAUDE.md layered kill switch). Followups fire during silent mode. If operator wants full silence, set `bot_settings.reminders_paused = 'true'` (layer 4).

8. **Daily-recurring-with-followups on Saturday** — daily parent materializes fresh child for Saturday with fresh session_id `pill_2026-04-25`. If the family respects Shabbat silence for this specific reminder, `followup_policy.override_quiet_hours` should be `false` AND `recurrence.days` should exclude day 6. Not automatic.

9. **User retroactively removes the daily anchor** — DELETE the parent row cascades to all materialized children and their followup chains. Clean.

10. **Escalation to a different person** — NOT in scope for MVP. Phase 3 shape will be `followup_policy.escalate_to: "972541234567"` with a handoff after X unanswered fires.

## Critical files to modify

- `supabase/functions/whatsapp-webhook/index.inlined.ts` — new ACTION type in both group + 1:1 prompts, new `execute*Actions` branch, new ack-detector call in `Deno.serve`.
- `supabase/functions/_shared/action-executor.ts` — modular reference for the inlined version.
- `supabase/functions/_shared/haiku-classifier.ts` — prompt rule for repeat-pattern detection.
- **New file**: `supabase/functions/whatsapp-webhook/followup-ack-detector.ts` — ack matcher.
- **New migration**: `supabase/migrations/2026_04_XX_reminder_followup_policy.sql` — schema + `schedule_followups` PG function.
- **New migration**: update `fire_due_reminders_inner` to v4 with the pre/post-fire hooks above.

## Phased rollout

### Phase 1 — MVP (~1 week)

- Schema migration (3 columns + 1 table).
- `interval_until_ack` kind only.
- Strict substring `ack_phrases` matching (no Haiku ack).
- Daisy-chained scheduling (one next-child per fire).
- `reminder_with_followups` ACTION in Sonnet prompts.
- Covers: Netzer pill case, trash-until-done, daily "until paid" bill nag.

Exit criteria:
- Netzer family confirms the pill reminder fires 20:00 + every 30 min until "לקחתי" / 23:30, for 3 consecutive days.
- Acks within 5 seconds of the message.
- No duplicate fires (cross-check against daily recurrence).
- Zero silent-commitment incidents in a week of traffic.

### Phase 2 — stages + Haiku ack (~2 weeks after Phase 1)

- `stages_before`, `stages_after`, `combined` kinds.
- Haiku-assisted ack detection for ambiguous messages.
- Multi-session disambiguation.
- Admin CLI: pause/skip/cancel sessions.

### Phase 3 — escalation (quarterly)

- `escalate_to` another phone.
- Per-session quiet hours.
- Cross-member handoff.

## Verification plan

1. **Unit tests** (`tests/test_followup_policy.py`):
   - `interval_until_ack` schedules daisy-chain correctly.
   - Ack cancels remaining.
   - Max count enforced.
   - Quiet hours respected when `override_quiet_hours=false`.

2. **Integration tests** (`tests/test_webhook.py` additions):
   - End-to-end: user asks "תזכירי כל חצי שעה עד שאאשר" → Sonnet emits `reminder_with_followups` → DB has parent + followup_policy → simulated fire schedules child → ack in chat cancels children.
   - Multi-session ack: 2 active sessions, ack for one leaves the other alone.
   - Daily-recurring with followups: tomorrow's session_id differs from today's, yesterday's ack doesn't silence today.

3. **Netzer pilot** (3 consecutive nights after Phase 1 deploy):
   - 20:00 fire → 20:30 → 21:00 → ack → stop.
   - Confirm via DB query + family confirmation in chat.

## Open questions for product

- Should the ack itself trigger a "thank you, stopping" bot reply, or silent cancel? (Proposed: silent cancel + optional "סבבה, עצרתי 🧡" ONE-liner only if `followup_policy.confirm_ack_reply: true`.)
- Should the default `ack_phrases` list be shared across policies (topic-agnostic) or emitted fresh per session by Sonnet? (Proposed: fresh per session, with a curated fallback list.)
- Should we expose session management in the web app (`sheli.ai`)? (Proposed: Phase 2 — a "active reminders" view with pause/cancel buttons.)

---

## Retroactive fixes for current state (today)

Independent of this design, THREE manual fixes applied during the 2026-04-21 session:

1. Three follow-up rows inserted for tonight (22:00, 22:30, 23:00) for `hh_u4lp6lsh` with `metadata.pill_session='2026-04-21'`.
2. Apology text drafted for operator to paste manually: *"עינת, סליחה 🙈 פספסתי את הלופ..."*.
3. When Ofri confirms tonight: `DELETE FROM reminder_queue WHERE household_id='hh_u4lp6lsh' AND metadata->>'pill_session'='2026-04-21' AND sent=false;`.

These are NOT the design — they're the bridge until Phase 1 ships.
