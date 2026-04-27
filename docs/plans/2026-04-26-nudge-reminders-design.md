# Nudge Reminders — Design

**Date:** 2026-04-26
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Motivating incident:** Netzer family, 2026-04-26 16:39–16:43. Einat asked Sheli to "keep reminding every 30min until someone confirms ליאו (the dog) was walked." Sheli's workaround — stack 6 fixed-time recurring reminders — produced a truncated `<!--ACTIONS:-->` JSON block that leaked into the chat as visible code. The workaround also doesn't actually do what the user asked: it fires at fixed slots regardless of whether the task is done.

## Problem

Today's `reminder_queue` supports two primitives:

- **One-shot reminder** — fires once at `send_at`, done.
- **Recurring reminder** — `recurrence={days, time}` parent + daily-materialized children, each fires once per slot regardless of state.

Both are **calendar primitives**: time-based, stateless, fire-and-forget.

The Netzer ask is a **state-machine primitive**: fire repeatedly every N minutes until someone acknowledges the task is complete, or until a hard deadline / max-tries cap. Conflating it with calendar reminders (as Sheli tried today) produces brittle, noisy, ban-risky workarounds.

## Concept

A **nudge series** is a state machine with these states and transitions:

```
                  ┌─────────┐
       create ───▶│ active  │──ack───────▶ acked
                  │         │──attempt#=max ▶ expired_tries
                  │         │──now>deadline▶ expired_deadline
                  │         │──bot_removed─▶ superseded
                  └─────────┘
```

Each "fire" in the series is one attempt. Attempts are spaced by `interval_min`. The series ends when ANY of: explicit ack arrives, `max_tries` hit, deadline crossed, or bot removed from chat.

Nudge series can be:

- **One-shot** — single series, lives until terminal state, then gone.
- **Daily-recurring** — parent row with `recurrence={days, time}` spawns a fresh independent series each matching day. Yesterday's ack does NOT carry over to today.

## Decisions

| Decision | Value | Rationale |
|---|---|---|
| Stop signal | Explicit ack (✅ reaction OR Hebrew/English completion phrase) + Haiku auto-detect of natural completions in same chat during active window | Matches how families actually communicate ("הוצאתי", "בוצע") — typo-tolerant via Haiku |
| Who can ack | Any household member | "I took the dog because I couldn't stand the nudges to my sister" — that social pressure IS the feature |
| Failure bound | `max_tries` AND `deadline_time_il` — first-to-fire stops the series | Two failure modes (count vs wall-clock); user can express either or both |
| Min interval | 15 minutes (hard floor) | Anti-spam classifier risk; below 15 the cumulative load on the chat is dangerous |
| Max tries | 8 (hard ceiling) | Same reason; beyond 8 unacknowledged nudges the series should expire and escalate to requester |
| Max active series per household | 3 | Prevents a single household from saturating the bot's outbound budget |
| Sub-floor handling | Sheli explains the constraint warmly + offers nearest legal config | Hardcoded refusal text in `SHARED_NUDGE_RULES`, not Sonnet-improvised, to avoid drift |
| Channel | User picks per series: `group` / `dm` / `ask` (default = ask on creation) | High-stakes choice; one extra clarifying turn is worth it |
| Quiet hours | Skip + count + continue (do NOT pause-resume) | Nudges are time-sensitive — silent resume next morning is worse than expiring |
| Free-tier billing | Each fired attempt = 1 action against 40/mo quota | A 6-nudge × 7-day series = 42 actions otherwise |
| Daily-recurring composition | Each matching day spawns a fresh series anchor with own `nudge_series_id` | Yesterday's ack must not silence today |
| Days-of-week shape | Existing `recurrence.days:[0..6]` (0=Sunday); arbitrary subsets supported | "Sun/Tue/Thu" → `[0,2,4]`. Rotations modeled as TWO parent rows, one per assignee |

## Schema

Extends existing `reminder_queue`. No new tables.

```sql
ALTER TABLE reminder_queue
  ADD COLUMN nudge_config JSONB,
  ADD COLUMN nudge_series_id UUID,
  ADD COLUMN nudge_attempt INT,
  ADD COLUMN series_status TEXT;

CREATE INDEX reminder_queue_active_series_idx
  ON reminder_queue (household_id, series_status)
  WHERE series_status = 'active';

CREATE INDEX reminder_queue_series_member_idx
  ON reminder_queue (nudge_series_id, nudge_attempt)
  WHERE nudge_series_id IS NOT NULL;
```

`nudge_config` shape:

```json
{
  "interval_min": 30,
  "max_tries": 6,
  "deadline_time_il": "16:30",
  "channel": "group" | "dm" | "ask",
  "target_phone": "972XXXXXXXXX",
  "target_name": "עופרי",
  "prompt_completion": "להוציא את ליאו"
}
```

Two row patterns:

| Pattern | Parent | Children |
|---|---|---|
| **One-shot series** | One row, `recurrence=NULL`, `nudge_config` set, `sent=true` (sentinel like recurring parents). `series_status` lives here. | Materializer creates child rows with `nudge_attempt=1..N`, `nudge_series_id=parent_id`. Each child is a normal `reminder_queue` row that the existing drain fires. |
| **Daily-recurring series** | One row, `recurrence={days, time}`, `nudge_config` set, `sent=true`. | New cron `materialize_nudge_series_daily` (01:00 IL) creates a *new series anchor* per active day with its own `nudge_series_id`. That anchor materializes its own attempt children. |

`series_status`: `active` | `acked` | `expired_tries` | `expired_deadline` | `superseded`.

## Lifecycle

### Series start

For one-shot: immediately on `add_nudge_reminder` action.
For daily-recurring: at 01:00 IL by `materialize_nudge_series_daily`, only on days matching `recurrence.days`.

1. Create series anchor (UUID = `nudge_series_id`, `series_status='active'`).
2. Insert attempt #1 with `send_at = max(NOW(), today_at(parent.recurrence.time))`.
3. If `channel='dm'`: post a one-time bookend in the group ("הגדרתי תזכורת חוזרת ל...") via `outbound_queue` — group-aware, doesn't count toward `max_tries`.

### Per attempt fire

In `fire_due_reminders_inner` (existing drain), after sending an attempt:

```
schedule_next_nudge(series_id):
  SELECT ... FOR UPDATE  -- race-safe
  if series_status != 'active': return  -- ack arrived, no-op
  next_send = NOW() + interval_min
  if next_send > today_at(deadline_time_il):
    UPDATE series_status = 'expired_deadline'
    notify_requester_of_expiry(series_id)
    return
  if nudge_attempt = max_tries:
    UPDATE series_status = 'expired_tries'
    notify_requester_of_expiry(series_id)
    return
  INSERT next attempt with send_at = next_send, nudge_attempt = N+1
```

Quiet hours: attempt that fires during quiet hours is marked `sent=true + metadata.note='quiet_hours_skipped'` and `schedule_next_nudge` is still called — counts toward `max_tries`.

### Ack path

Three entry points, all funnel into `ack_nudge_series(series_id, ack_phone)`:

1. **Reaction** — existing `pending_confirmations` table extended to record nudge attempts; ✅/💪/👍 on any nudge in the series triggers ack.
2. **Haiku auto-detect** — when an active series exists in the chat, the Haiku classifier output gets one extra boolean `completes_pending_nudge`. If true, the bot routes to `ack_nudge_series` instead of normal flow. Cheap (one extra prompt line) and only evaluated when there's an open series in scope.
3. **Explicit text match** — Hebrew/English regex fast-path on the same active-series window: `בוצע`, `עשיתי`, `הוצאתי`, `נלקח`, `לקחתי`, `done`, `did it`. Fires before Haiku for zero-cost ack on common patterns.

`ack_nudge_series`:

```sql
UPDATE reminder_queue
  SET series_status='acked'
  WHERE nudge_series_id=$1 AND series_status='active';
DELETE FROM reminder_queue
  WHERE nudge_series_id=$1 AND sent=false;
```

Then post confirmation:
- `channel='group'` → "מעולה! סימנתי ש{target} {completion} ✓" in group
- `channel='dm'` → "תודה, סימנתי ✓" in DM + closing bookend in group ("{target} {completion} ✓")

### Expiry path

`expired_tries` or `expired_deadline` → DM the **requester** (the phone that created the series, stored in series anchor metadata): "{target} לא אישר/ה — להזכיר שוב מחר?" No public failure-shaming in the group.

### Bot removed mid-series

`handleBotRemoved` extended: mark all active series in the household `series_status='superseded'`, `metadata.note='bot_removed'`. Drain ignores superseded.

## Classifier & Sonnet Surface

### New Haiku intent: `add_nudge_reminder`

Distinct from `add_reminder` and `add_recurring_reminder`. Trigger phrases:

- `כל X דקות עד ש...` / `כל חצי שעה עד...`
- `נדנדי` / `נדנדי לו` / `נדנדי לה`
- `תמשיכי להזכיר עד...`
- `תזכורת חוזרת עד...` (only when `עד` clause is a completion event, not a fixed time)

Haiku output shape:

```json
{
  "intent": "add_nudge_reminder",
  "confidence": 0.85,
  "addressed_to_bot": true,
  "entities": {
    "target_name": "עופרי",
    "completion_text": "להוציא את ליאו",
    "interval_min": 30,
    "deadline_time_il": "16:30",
    "max_tries": null,
    "days": [0,2,4,6],
    "channel_hint": null
  }
}
```

`null` for `max_tries`/`deadline_time_il`/`days`/`channel_hint` means "use default" or "ask user". Defaults: `max_tries=6`, `deadline_time_il=null` (cap by max_tries only), `days=null` (one-shot), `channel_hint=null` (ask).

### Sonnet behavior (in both `ONBOARDING_1ON1_PROMPT` and `buildReplyPrompt`)

1. If `channel_hint` is null AND nudge would fire in a group context, ask one clarifying turn: "בקבוצה או בפרטי לעופרי?" (exception to the no-clarifying-questions rule — high-stakes for noise/ban).
2. Emit `<!--ACTIONS:[{"type":"nudge_series", ...}]-->` with resolved fields.
3. Confirm to user with concrete numbers: *"הגדרתי: כל 30 דק מ-14:00 עד 16:30, ימי א/ג/ה/ש, לעופרי בקבוצה. כש-✅ או 'בוצע' אעצור."* No vague "I'll figure it out".
4. Sub-floor refusals are HARDCODED templates in `SHARED_NUDGE_RULES`, not Sonnet-paraphrased.

### `SHARED_NUDGE_RULES` (new shared constant)

Injected into both Sonnet prompt builders. Contents:

- ABSOLUTE RULE — never emit `nudge_series` from conversational context. Only when current user message has explicit `נדנדי` / `כל X דקות עד` / `תמשיכי להזכיר` / `keep reminding until` patterns.
- ABSOLUTE RULE — confirmation reply MUST list resolved `interval_min`, deadline (or "עד שמאשרים"), days (or "היום"), channel, target. No vagueness.
- Days field uses 0=Sunday convention. "every day" → `[0,1,2,3,4,5,6]`. Empty array is invalid.
- Sub-floor refusal templates:
  - `interval_min < 15`: *"המינימום הוא 15 דקות בין תזכורות — וואטסאפ מגביל אותי כדי לא להיתקע. לעשות כל 15?"*
  - `max_tries > 8`: *"מקסימום 8 תזכורות בסדרה. אחרי זה אם אף אחד לא הגיב, אני שולחת לך הודעה פרטית."*
  - 4th simultaneous active series: *"כבר יש 3 סדרות פעילות. תרצי לבטל אחת קודם?"*

## Anti-Ban Guardrails

Enforced at INSERT time via SQL `RAISE EXCEPTION` (Sonnet catches the error and surfaces the friendly message):

- `interval_min < 15` → reject
- `max_tries > 8` → reject
- 4th active series in household → reject
- `deadline_time_il` more than 12 hours past `series_start` → reject (sanity bound)

## Edge Cases

| Case | Behavior |
|---|---|
| Ack arrives between attempt fire and `schedule_next_nudge` | `FOR UPDATE` on series row makes the re-read race-safe; ack wins, no further attempts scheduled. |
| Two acks arrive simultaneously | First UPDATE wins; second is no-op. Confirmation reply deduped via `pending_confirmations`. |
| User cancels mid-series ("תעצרי את התזכורות לליאו") | New `cancel_nudge` action via `handleCorrection` flow (already Sonnet-structured since 2026-04-23). Soft-cancels parent + deletes unsent children. |
| Duplicate series attempt (same target+task while active) | INSERT-time check; refuse with "כבר יש סדרה פעילה — לבטל ולהתחיל חדשה?" |
| Bot kicked from group mid-series | All active series in that household → `superseded` via `handleBotRemoved`. |
| Recurring parent edited (interval_min changed) | Future days use new value; today's already-spawned anchor unchanged. |
| `target_phone` unknown | Falls into existing MISSING_PHONES Option D path from private DM reminders v1. For `channel='group'` moot; for `channel='dm'` blocks until resolved. |
| DST transition | `parseReminderTime` is DST-aware (fixed 2026-04-20). `deadline_time_il` is wall-clock — re-resolved per-day. |
| Quiet hours mid-series | Per-attempt skip + count toward max. User warned at creation if range crosses 22:00–07:00. |

## Test Plan

New test class `TestNudgeReminders` in `tests/test_webhook.py`. Minimum 8 cases:

1. **Create one-shot nudge** — "תזכירי לעופרי כל 30 דק עד 16:30 להוציא את ליאו" → series anchor + first attempt scheduled, correct config.
2. **Sub-floor refusal** — "כל 5 דקות" → Sheli refuses with hardcoded template + offers 15.
3. **Auto-ack via Hebrew completion** — series active, group msg "הוצאתי את הכלב" → series → `acked`, unsent attempts deleted.
4. **Reaction ack** — ✅ reaction on any Sheli nudge → series → `acked`.
5. **Max tries expiry** — fast-forward attempts, verify `expired_tries` + DM-to-requester fallback.
6. **Deadline expiry** — series with deadline 5 min from now, no ack → `expired_deadline`.
7. **Daily-recurring rotation** — two parent rows (עופרי `[0,2,4,6]`, אריק `[1,3,5]`), verify only one fires per weekday.
8. **Race: ack mid-fire** — INSERT ack while attempt fires, verify next attempt NOT scheduled.

## Rollout (4 phases, sequential)

Each phase is a deployable unit; later phases depend on earlier. Each ends with verification before the next begins.

### Phase 1 — Schema + drain logic

- Migration: `nudge_config`, `nudge_series_id`, `nudge_attempt`, `series_status` columns + indexes.
- New SQL function `schedule_next_nudge(series_id)`.
- New cron `materialize_nudge_series_daily` at 01:00 IL.
- Extend `fire_due_reminders_inner` to call `schedule_next_nudge` after firing nudge attempts.
- Anti-ban guardrails as INSERT-time checks (RAISE EXCEPTION).
- **No classifier change yet.**
- **Backfill Netzer:** delete the 6 wrong-days every-day parents from 2026-04-26 16:41, replace with proper one-shot nudge series (or stay-as-recurring if Yaron prefers — see open questions below).

### Phase 2 — Classifier + Sonnet prompts

- New Haiku intent `add_nudge_reminder` + entities.
- New `nudge_series` action type in executor.
- `SHARED_NUDGE_RULES` constant injected into both prompt builders.
- Sonnet clarifying-channel turn for `channel_hint=null`.
- Eval suite passes.

### Phase 3 — Acknowledgment paths

- Haiku `completes_pending_nudge` field, only populated when active series in scope.
- Hebrew/English regex fast-path for common ack phrases.
- `pending_confirmations` extended to record nudge attempts.
- Reaction routing → `ack_nudge_series`.
- Bookend posts (start + end of `channel='dm'` series).
- Expiry → DM requester.

### Phase 4 — General release

- Beta announcement to families.
- Feature flag `bot_settings.nudge_reminders_enabled` defaults `'false'` globally; per-household override via `households_v2.metadata.nudge_reminders_enabled`. Netzer (`hh_u4lp6lsh`) flipped on first.

## Out of Scope (deferred)

- "Pause for 10 min" semantics (negative ack with auto-reschedule).
- Per-attempt different copy (e.g. attempt #5 escalates wording).
- Cross-household nudge series (one phone in two households).
- Analytics on ack-rate / attempt-distribution (worth adding to admin dashboard later).

## Open Questions

- **13:00 dog reminder day-set drift:** the pre-existing lunch-walk reminder at 13:00 from 2026-04-20 uses עופרי `[0,2,4]` (no Saturday), but the corrected 14:00–16:30 series uses `[0,2,4,6]`. Decide whether to align the 13:00 row.

## Interim Cleanup Log (2026-04-26)

Ahead of Phase 1, the Netzer family DB was repaired to fire correctly tomorrow morning. This cleanup uses the **existing** `recurring_reminder` primitive (no auto-ack); rows are tagged `metadata.will_migrate_to_nudge_series=true` for Phase 1 migration.

**Snapshot:** 55 affected rows preserved at `bot_settings.netzer_2026_04_26_dog_pill_pre_cleanup_snapshot` for rollback.

**Removed:** 7 wrong parents (6 every-day dog reminders with `group_id=Einat's 1:1 phone` from the 16:41 ACTIONS-leak session + 1 daily-only pill parent) plus their 48 unsent children. The 3 historical fired pill children (2026-04-21..04-25) are preserved for audit trail.

**Inserted:**

- 12 dog rotation parents — 6 time slots × 2 targets:
  - עופרי `days:[0,2,4,6]` at 14:00 / 14:30 / 15:00 / 15:30 / 16:00 / 16:30
  - אריק `days:[1,3,5]` at the same 6 slots
  - All in family group `120363407839946451@g.us`
  - Tagged `source: netzer_dog_rotation_cleanup_2026_04_26`
- 6 pill nudge-stub parents — every 30 min from 20:00 to 22:30, all 7 days, family group
  - Tagged `source: netzer_pill_nudge_cleanup_2026_04_26`
  - Each carries `metadata.intended_nudge_config` with the target Phase 1 shape (`interval_min:30, max_tries:6, deadline_time_il:'22:30', channel:'group', target:'עופרי', prompt_completion:'לקחת את הכדור'`) so the Phase 1 backfill script can read intent directly.

**Materialized:** 78 children for the next 7 days via `materialize_recurring_reminders()`. Tonight's 6 pill nudges (20:00–22:30) and tomorrow's 6 אריק dog nudges (14:00–16:30) are queued in family group.

## Phase 1 Backfill Log (2026-04-27, 20:10 IL)

Phase 1 schema + helpers shipped (Tasks 1.1–1.5). Task 1.6 collapsed Netzer's 18 calendar-style interim parents into the 3 logical nudge_series the design specifies. Live state at backfill time was 18 parents (12 dog `netzer_dog_rotation_cleanup_2026_04_26` + 6 pill `netzer_pill_nudge_cleanup_2026_04_26`) with 90 children (13 already fired, 77 unsent — 5 tonight, 72 tomorrow+).

**Materializer fix (Task 1.6a):** `materialize_recurring_reminders` was patched to add `AND nudge_config IS NULL` to its parent SELECT. Without this, both the calendar materializer and the new nudge materializer would walk the same parents and double-fire every matching day.

**Cleanup (Task 1.6b, single transaction):**

1. **Detached** 5 tonight pill children (20:30 / 21:00 / 21:30 / 22:00 / 22:30 IL) by setting `recurrence_parent_id=NULL` + `metadata.detached_during_nudge_migration=true` + `metadata.former_parent_id`. They keep firing tonight as plain reminders. Yaron will tell Sheli when עופרי acks the pill so we can soft-cancel the unsent ones.
2. **Deleted** 70 unsent tomorrow-plus children of all 18 interim parents (30 dog + 40 pill).
3. **Deleted** 15 redundant parents — 10 dog (all non-14:00 slots × 2 targets) + 5 pill (all non-20:00 slots).
4. **Updated** the 3 kept parents with proper `nudge_config`:
    - עופרי dog `1fa96db7` — `days:[0,2,4,6]`, `time:14:00`, deadline `16:30`, interval 30, max 6, target עופרי `972526210880`, completion `להוציא את ליאו`
    - אריק dog `2953ec9f` — `days:[1,3,5]`, `time:14:00`, deadline `16:30`, interval 30, max 6, target אריק `972526255413`, completion `להוציא את ליאו`
    - עופרי pill `e761a0c4` — `days:[0..6]`, `time:20:00`, deadline `22:30`, interval 30, max 6, target עופרי `972526210880`, completion `לקחת את הכדור`

**Materialize NOT called today.** It's already 20:07 IL. Today's אריק dog 14:00 series start would have fired in-the-past at 19:45 IL with the deadline already crossed. Today's 20:00 pill series start would have raced the existing 20:00 pill child (which already fired). Cleaner to wait for tonight's 22:00 UTC nudge cron to spawn tomorrow's series anchors fresh. Today's nudge sequence completes via the 5 detached pill children → manual ack → soft cancel.

**Preserved for audit:** 13 already-sent children of the 18 parents are kept (no DELETE on `sent=true`).

**Out of scope, still firing:** 6 lunch-walk children (13:00 IL, separate `manual_backfill_einat_2026_04_20` parents `28984da4` + `23c96c80`) keep firing as plain calendar reminders for the next 6 matching days. The day-set drift question (עופרי `[0,2,4,6]` 13:00 vs. עופרי `[0,2,4,6]` 14:00) noted in Open Questions remains open — both align after the 2026-04-26 fix.
