# Nudge Reminders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a state-machine reminder primitive that fires every N minutes until acknowledged (or until max_tries / deadline), distinct from existing calendar reminders.

**Architecture:** Extends `reminder_queue` with 4 columns (`nudge_config`, `nudge_series_id`, `nudge_attempt`, `series_status`). Two row patterns share schema: one-shot series (parent + on-demand attempt children) and daily-recurring series (parent's `recurrence` triggers daily anchor → attempt children). New SQL function `schedule_next_nudge` runs after each attempt fires. Ack arrives via reaction, regex fast-path, or new Haiku boolean `completes_pending_nudge`. Three-tier ban guardrails enforced at INSERT.

**Tech Stack:** Supabase (Postgres + Edge Functions, Deno/TypeScript), pg_cron, Haiku 4.5 + Sonnet 4 (Anthropic), Whapi.Cloud, `tests/test_webhook.py` (Python integration tests against live Edge Function).

**Reference:** Design doc at `docs/plans/2026-04-26-nudge-reminders-design.md`. Read it before starting.

**Branch:** Already in worktree `trusting-mendel-d7e78f` on branch `claude/trusting-mendel-d7e78f`.

---

## Phase 1 — Schema + drain logic

### Task 1.1: Migration — add nudge columns + indexes

**Files:**
- Create migration via `mcp__f5337598-...__apply_migration` tool, name: `2026_04_26_nudge_reminders_schema`

**Step 1: Verify current state**

Run via MCP `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='reminder_queue'
  AND column_name IN ('nudge_config','nudge_series_id','nudge_attempt','series_status');
```
Expected: 0 rows (none exist yet).

**Step 2: Apply migration**

Apply this migration body:
```sql
ALTER TABLE reminder_queue
  ADD COLUMN IF NOT EXISTS nudge_config JSONB,
  ADD COLUMN IF NOT EXISTS nudge_series_id UUID,
  ADD COLUMN IF NOT EXISTS nudge_attempt INT,
  ADD COLUMN IF NOT EXISTS series_status TEXT
    CHECK (series_status IN ('active','acked','expired_tries','expired_deadline','superseded'));

CREATE INDEX IF NOT EXISTS reminder_queue_active_series_idx
  ON reminder_queue (household_id, series_status)
  WHERE series_status = 'active';

CREATE INDEX IF NOT EXISTS reminder_queue_series_member_idx
  ON reminder_queue (nudge_series_id, nudge_attempt)
  WHERE nudge_series_id IS NOT NULL;

COMMENT ON COLUMN reminder_queue.nudge_config IS
  'Nudge series config: {interval_min, max_tries, deadline_time_il, channel, target_phone, target_name, prompt_completion}. NULL for non-nudge rows.';
COMMENT ON COLUMN reminder_queue.series_status IS
  'Lifecycle of nudge series: active|acked|expired_tries|expired_deadline|superseded. NULL for non-nudge rows.';
```

**Step 3: Verify**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='reminder_queue'
  AND column_name IN ('nudge_config','nudge_series_id','nudge_attempt','series_status')
ORDER BY column_name;
```
Expected: 4 rows. `nudge_config` jsonb, `nudge_series_id` uuid, `nudge_attempt` integer, `series_status` text.

**Step 4: Commit**

The migration tool auto-records to `supabase/migrations/`. Stage + commit any new migration file:
```bash
git add supabase/migrations/
git commit -m "feat(db): add nudge series columns to reminder_queue"
```

---

### Task 1.2: SQL function — `schedule_next_nudge(series_id UUID)`

**Files:**
- Migration name: `2026_04_26_schedule_next_nudge`

**Step 1: Write the function with embedded test cases first**

Apply migration body:
```sql
CREATE OR REPLACE FUNCTION schedule_next_nudge(p_series_id UUID)
RETURNS TEXT  -- returns the new state: 'scheduled'|'expired_tries'|'expired_deadline'|'noop_acked'
LANGUAGE plpgsql AS $$
DECLARE
  v_anchor RECORD;
  v_last_attempt INT;
  v_max_tries INT;
  v_interval_min INT;
  v_deadline_time_il TEXT;
  v_today_il DATE;
  v_now_il TIMESTAMP;
  v_next_send_il TIMESTAMP;
  v_deadline_il TIMESTAMP;
  v_next_send_utc TIMESTAMPTZ;
BEGIN
  -- Lock the anchor row for this series (race-safe)
  SELECT id, household_id, group_id, message_text, reminder_type,
         created_by_phone, created_by_name, delivery_mode, recipient_phones,
         nudge_config, series_status
  INTO v_anchor
  FROM reminder_queue
  WHERE id = p_series_id
  FOR UPDATE;

  IF NOT FOUND OR v_anchor.series_status != 'active' THEN
    RETURN 'noop_acked';
  END IF;

  v_max_tries := COALESCE((v_anchor.nudge_config->>'max_tries')::int, 6);
  v_interval_min := COALESCE((v_anchor.nudge_config->>'interval_min')::int, 30);
  v_deadline_time_il := v_anchor.nudge_config->>'deadline_time_il';

  -- Find the highest attempt# for this series so far
  SELECT COALESCE(MAX(nudge_attempt), 0) INTO v_last_attempt
  FROM reminder_queue
  WHERE nudge_series_id = p_series_id;

  IF v_last_attempt >= v_max_tries THEN
    UPDATE reminder_queue SET series_status='expired_tries' WHERE id=p_series_id;
    RETURN 'expired_tries';
  END IF;

  v_now_il := (NOW() AT TIME ZONE 'Asia/Jerusalem')::timestamp;
  v_today_il := v_now_il::date;
  v_next_send_il := v_now_il + (v_interval_min || ' minutes')::interval;

  IF v_deadline_time_il IS NOT NULL THEN
    v_deadline_il := v_today_il + v_deadline_time_il::time;
    IF v_next_send_il > v_deadline_il THEN
      UPDATE reminder_queue SET series_status='expired_deadline' WHERE id=p_series_id;
      RETURN 'expired_deadline';
    END IF;
  END IF;

  v_next_send_utc := v_next_send_il AT TIME ZONE 'Asia/Jerusalem';

  INSERT INTO reminder_queue (
    household_id, group_id, message_text, send_at, sent, reminder_type,
    created_by_phone, created_by_name, delivery_mode, recipient_phones,
    nudge_series_id, nudge_attempt, series_status, metadata
  ) VALUES (
    v_anchor.household_id, v_anchor.group_id, v_anchor.message_text,
    v_next_send_utc, false, v_anchor.reminder_type,
    v_anchor.created_by_phone, v_anchor.created_by_name,
    v_anchor.delivery_mode, v_anchor.recipient_phones,
    p_series_id, v_last_attempt + 1, NULL,
    jsonb_build_object('nudge_attempt_of_series', p_series_id, 'attempt_num', v_last_attempt + 1)
  );

  RETURN 'scheduled';
END;
$$;
```

**Step 2: Smoke-test the function**

```sql
-- Insert a fake anchor with nudge_config
INSERT INTO reminder_queue (
  household_id, group_id, message_text, send_at, sent, reminder_type,
  created_by_phone, created_by_name, nudge_config, series_status, delivery_mode
) VALUES (
  'hh_u4lp6lsh', '120363407839946451@g.us', 'TEST nudge anchor',
  NOW(), true, 'user',
  '972526210880', 'TEST',
  jsonb_build_object('interval_min', 15, 'max_tries', 3, 'deadline_time_il', '23:59',
                     'channel','group','target_phone','972526210880','target_name','TEST',
                     'prompt_completion','test'),
  'active', 'group'
) RETURNING id;
-- Note the returned id as $TEST_ID

-- First call schedules attempt #1
SELECT schedule_next_nudge('$TEST_ID');  -- expect 'scheduled'
-- Verify a child row appeared
SELECT nudge_attempt, send_at FROM reminder_queue WHERE nudge_series_id='$TEST_ID';

-- Three more calls; the 4th should expire_tries
SELECT schedule_next_nudge('$TEST_ID');  -- 'scheduled' (attempt 2)
SELECT schedule_next_nudge('$TEST_ID');  -- 'scheduled' (attempt 3)
SELECT schedule_next_nudge('$TEST_ID');  -- 'expired_tries'
SELECT series_status FROM reminder_queue WHERE id='$TEST_ID';  -- 'expired_tries'

-- Cleanup
DELETE FROM reminder_queue WHERE id='$TEST_ID' OR nudge_series_id='$TEST_ID';
```

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): schedule_next_nudge SQL function"
```

---

### Task 1.3: SQL function — `materialize_nudge_series_daily()` + cron

**Files:**
- Migration name: `2026_04_26_materialize_nudge_series_daily`

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION materialize_nudge_series_daily()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_inserted INT := 0;
  v_parent RECORD;
  v_today_il DATE;
  v_today_dow INT;
  v_anchor_id UUID;
  v_anchor_send_at_il TIMESTAMP;
  v_anchor_send_at_utc TIMESTAMPTZ;
  v_time TEXT;
  v_hour INT;
  v_minute INT;
BEGIN
  v_today_il := (NOW() AT TIME ZONE 'Asia/Jerusalem')::date;
  v_today_dow := EXTRACT(DOW FROM v_today_il)::int;

  -- For each daily-recurring NUDGE parent (recurrence + nudge_config + sent=true sentinel)
  FOR v_parent IN
    SELECT id, household_id, group_id, message_text, reminder_type,
           created_by_phone, created_by_name, delivery_mode, recipient_phones,
           recurrence, nudge_config
    FROM reminder_queue
    WHERE recurrence IS NOT NULL
      AND nudge_config IS NOT NULL
      AND recurrence_parent_id IS NULL
      AND sent = true
      AND series_status IS NULL  -- parent itself isn't a series instance
  LOOP
    -- Skip if today not in days[]
    IF NOT (v_parent.recurrence->'days' @> to_jsonb(v_today_dow)) THEN
      CONTINUE;
    END IF;

    -- Skip if a series anchor for this parent + today already exists
    IF EXISTS (
      SELECT 1 FROM reminder_queue
      WHERE metadata->>'nudge_parent_id' = v_parent.id::text
        AND (metadata->>'series_date_il')::date = v_today_il
    ) THEN
      CONTINUE;
    END IF;

    v_time := COALESCE(v_parent.recurrence->>'time', '09:00');
    v_hour := split_part(v_time, ':', 1)::int;
    v_minute := split_part(v_time, ':', 2)::int;
    v_anchor_send_at_il := v_today_il + make_time(v_hour, v_minute, 0);
    v_anchor_send_at_utc := v_anchor_send_at_il AT TIME ZONE 'Asia/Jerusalem';

    -- Skip if start time already past + interval window has fully expired
    -- (lazy: just skip if anchor time is more than 6 hours in the past)
    IF v_anchor_send_at_utc < NOW() - INTERVAL '6 hours' THEN
      CONTINUE;
    END IF;

    -- Create the series anchor
    INSERT INTO reminder_queue (
      household_id, group_id, message_text, send_at, sent, reminder_type,
      created_by_phone, created_by_name, delivery_mode, recipient_phones,
      nudge_config, series_status, metadata
    ) VALUES (
      v_parent.household_id, v_parent.group_id, v_parent.message_text,
      GREATEST(v_anchor_send_at_utc, NOW()),  -- if start time past, fire ASAP
      true,  -- anchor sentinel like recurring parents
      v_parent.reminder_type,
      v_parent.created_by_phone, v_parent.created_by_name,
      v_parent.delivery_mode, v_parent.recipient_phones,
      v_parent.nudge_config,
      'active',
      jsonb_build_object(
        'nudge_parent_id', v_parent.id,
        'series_date_il', v_today_il,
        'spawned_at', NOW()
      )
    ) RETURNING id INTO v_anchor_id;

    -- Insert attempt #1 immediately (drain will fire it)
    INSERT INTO reminder_queue (
      household_id, group_id, message_text, send_at, sent, reminder_type,
      created_by_phone, created_by_name, delivery_mode, recipient_phones,
      nudge_series_id, nudge_attempt, metadata
    ) VALUES (
      v_parent.household_id, v_parent.group_id, v_parent.message_text,
      GREATEST(v_anchor_send_at_utc, NOW()),
      false, v_parent.reminder_type,
      v_parent.created_by_phone, v_parent.created_by_name,
      v_parent.delivery_mode, v_parent.recipient_phones,
      v_anchor_id, 1,
      jsonb_build_object('nudge_attempt_of_series', v_anchor_id, 'attempt_num', 1)
    );

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

-- Schedule daily at 01:00 IL (23:00 UTC summer / 22:00 UTC winter — use 23:00 UTC consistently;
-- if first nudge is at 14:00 IL, 01:00 IL spawn is plenty of lead time)
SELECT cron.schedule(
  'materialize_nudge_series_daily',
  '0 22 * * *',  -- 22:00 UTC = 01:00 IL (in IDT) / midnight (in IST). Acceptable drift.
  $$SELECT materialize_nudge_series_daily()$$
);
```

**Step 2: Verify cron registered**

```sql
SELECT jobname, schedule, command FROM cron.job WHERE jobname='materialize_nudge_series_daily';
```
Expected: 1 row with schedule `0 22 * * *`.

**Step 3: Test by manual call**

```sql
SELECT materialize_nudge_series_daily();
```
Expected: returns 0 (no nudge_config parents exist yet — this is fine for now).

**Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): materialize_nudge_series_daily + 01:00 IL cron"
```

---

### Task 1.4: Extend `fire_due_reminders_inner` to call `schedule_next_nudge`

**Files:**
- Migration name: `2026_04_26_fire_due_reminders_nudge_aware`

**Step 1: Read current function**

```sql
SELECT prosrc FROM pg_proc WHERE proname='fire_due_reminders_inner' LIMIT 1;
```
Read the source. Identify the loop that processes due reminders + the point where each row is marked `sent=true`. The change: AFTER successfully firing a row whose `nudge_series_id IS NOT NULL`, call `schedule_next_nudge(nudge_series_id)`.

**Step 2: Apply migration replacing the function**

The migration body should be `CREATE OR REPLACE FUNCTION fire_due_reminders_inner ...` with the original function body PLUS this addition right after the row is marked sent (or the http_post is queued):

```sql
-- After firing each row, if it's a nudge attempt, schedule next
IF v_row.nudge_series_id IS NOT NULL THEN
  PERFORM schedule_next_nudge(v_row.nudge_series_id);
END IF;
```

Where `v_row` is the loop variable that yields the due reminder. Read the existing function source and adapt the variable name. **Do not** change other behavior — quiet hours rule, kill switch, fan-out logic must all stay identical.

**Step 3: Smoke test**

Insert a fake series anchor + attempt that's already due:
```sql
WITH anchor AS (
  INSERT INTO reminder_queue (
    household_id, group_id, message_text, send_at, sent, reminder_type,
    created_by_phone, created_by_name, nudge_config, series_status, delivery_mode
  ) VALUES (
    'hh_u4lp6lsh', '120363407839946451@g.us', 'TEST chain',
    NOW(), true, 'user', '972526210880', 'TEST',
    jsonb_build_object('interval_min',15,'max_tries',3,'deadline_time_il','23:59',
                       'channel','group','target_phone','972526210880',
                       'target_name','TEST','prompt_completion','test'),
    'active', 'group'
  ) RETURNING id
)
INSERT INTO reminder_queue (
  household_id, group_id, message_text, send_at, sent, reminder_type,
  created_by_phone, nudge_series_id, nudge_attempt, delivery_mode
)
SELECT 'hh_u4lp6lsh', '120363407839946451@g.us', 'TEST chain attempt 1',
       NOW() - INTERVAL '1 minute', false, 'user',
       '972526210880', id, 1, 'group'
FROM anchor RETURNING nudge_series_id AS series_id;
-- Save series_id from output
```

DO NOT call `fire_due_reminders` — that would actually send to family group. Instead, simulate just the post-fire handler by calling `schedule_next_nudge` directly:
```sql
SELECT schedule_next_nudge('<series_id>');  -- expect 'scheduled'
SELECT count(*) FROM reminder_queue WHERE nudge_series_id='<series_id>';  -- expect 2 (attempt 1 + 2)
```

Cleanup:
```sql
DELETE FROM reminder_queue WHERE nudge_series_id='<series_id>' OR id='<series_id>';
```

**Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): fire_due_reminders_inner schedules next nudge after fire"
```

---

### Task 1.5: SQL guardrail trigger for nudge_config validity

**Files:**
- Migration name: `2026_04_26_nudge_config_guardrails`

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION validate_nudge_config()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_interval INT;
  v_max INT;
  v_active_count INT;
BEGIN
  IF NEW.nudge_config IS NULL THEN
    RETURN NEW;
  END IF;

  v_interval := (NEW.nudge_config->>'interval_min')::int;
  v_max := (NEW.nudge_config->>'max_tries')::int;

  IF v_interval IS NULL OR v_interval < 15 THEN
    RAISE EXCEPTION 'nudge_interval_below_floor: interval_min=% must be >= 15', v_interval
      USING HINT = 'sub_floor_15min';
  END IF;

  IF v_max IS NULL OR v_max < 1 OR v_max > 8 THEN
    RAISE EXCEPTION 'nudge_max_tries_out_of_range: max_tries=% must be 1..8', v_max
      USING HINT = 'sub_floor_max_tries';
  END IF;

  -- Only check active-series cap on parents and one-shot anchors (not attempt children)
  IF NEW.series_status = 'active'
     OR (NEW.recurrence IS NOT NULL AND NEW.recurrence_parent_id IS NULL) THEN
    SELECT count(*) INTO v_active_count
    FROM reminder_queue
    WHERE household_id = NEW.household_id
      AND series_status = 'active'
      AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    IF v_active_count >= 3 THEN
      RAISE EXCEPTION 'too_many_active_series: household_id=% already has % active series',
        NEW.household_id, v_active_count
        USING HINT = 'too_many_active_series';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_nudge_config_trigger ON reminder_queue;
CREATE TRIGGER validate_nudge_config_trigger
  BEFORE INSERT OR UPDATE OF nudge_config ON reminder_queue
  FOR EACH ROW
  WHEN (NEW.nudge_config IS NOT NULL)
  EXECUTE FUNCTION validate_nudge_config();
```

**Step 2: Smoke test**

```sql
-- Sub-floor interval should fail
INSERT INTO reminder_queue (household_id, group_id, message_text, send_at, reminder_type,
  created_by_phone, nudge_config, series_status, delivery_mode)
VALUES ('hh_u4lp6lsh', '120363407839946451@g.us', 't', NOW(), 'user', '972526210880',
  jsonb_build_object('interval_min',5,'max_tries',3,'deadline_time_il','23:00',
                     'channel','group','target_phone','972526210880',
                     'target_name','t','prompt_completion','t'),
  'active','group');
-- Expect: ERROR: nudge_interval_below_floor

-- Max-tries over ceiling fails
INSERT INTO reminder_queue (household_id, group_id, message_text, send_at, reminder_type,
  created_by_phone, nudge_config, series_status, delivery_mode)
VALUES ('hh_u4lp6lsh', '120363407839946451@g.us', 't', NOW(), 'user', '972526210880',
  jsonb_build_object('interval_min',30,'max_tries',12,'deadline_time_il','23:00',
                     'channel','group','target_phone','972526210880',
                     'target_name','t','prompt_completion','t'),
  'active','group');
-- Expect: ERROR: nudge_max_tries_out_of_range
```

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): nudge_config guardrails (15min/8 tries/3 active)"
```

---

### Task 1.6: Backfill Netzer interim rows to proper nudge_series

**Files:**
- One-shot SQL — no migration. Run via `execute_sql`.

**Step 1: Read interim parents**

```sql
SELECT id, message_text, recurrence, metadata->>'intended_nudge_config' AS intended
FROM reminder_queue
WHERE household_id = 'hh_u4lp6lsh'
  AND metadata->>'will_migrate_to_nudge_series' = 'true'
  AND recurrence_parent_id IS NULL
ORDER BY recurrence->>'time';
```
Expect: 18 rows (12 dog + 6 pill).

**Step 2: Update each row to attach nudge_config**

For dog rows (interval=30, max=6, deadline depends on current time slot):

```sql
-- Dog rows: each time slot becomes the START of a series ending at 16:30
-- Only the 14:00 slot needs nudge_config; the rest become superseded
-- Why: nudges are 14:00, 14:30, 15:00, 15:30, 16:00, 16:30 = 6 attempts FROM ONE start, not 6 starts.
-- Delete the 5 redundant slots per assignee, keep only 14:00 with nudge_config.

DELETE FROM reminder_queue
WHERE household_id = 'hh_u4lp6lsh'
  AND metadata->>'source' = 'netzer_dog_rotation_cleanup_2026_04_26'
  AND recurrence->>'time' != '14:00';
-- This deletes 10 dog parents (5 per target × 2 targets) + their materialized children

-- Update remaining 14:00 dog rows with nudge_config
UPDATE reminder_queue
SET nudge_config = jsonb_build_object(
      'interval_min', 30,
      'max_tries', 6,
      'deadline_time_il', '16:30',
      'channel', 'group',
      'target_phone', CASE WHEN message_text LIKE '%עופרי%' THEN '972526210880' ELSE '972526255413' END,
      'target_name', CASE WHEN message_text LIKE '%עופרי%' THEN 'עופרי' ELSE 'אריק' END,
      'prompt_completion', 'להוציא את ליאו'
    )
WHERE household_id = 'hh_u4lp6lsh'
  AND metadata->>'source' = 'netzer_dog_rotation_cleanup_2026_04_26'
  AND recurrence->>'time' = '14:00';
-- Now 2 dog parents (עופרי + אריק) carry the nudge config.

-- Same for pill: keep only 20:00 + nudge_config, delete others
DELETE FROM reminder_queue
WHERE household_id = 'hh_u4lp6lsh'
  AND metadata->>'source' = 'netzer_pill_nudge_cleanup_2026_04_26'
  AND recurrence->>'time' != '20:00';

UPDATE reminder_queue
SET nudge_config = jsonb_build_object(
      'interval_min', 30,
      'max_tries', 6,
      'deadline_time_il', '22:30',
      'channel', 'group',
      'target_phone', '972526210880',
      'target_name', 'עופרי',
      'prompt_completion', 'לקחת את הכדור'
    )
WHERE household_id = 'hh_u4lp6lsh'
  AND metadata->>'source' = 'netzer_pill_nudge_cleanup_2026_04_26'
  AND recurrence->>'time' = '20:00';
```

**Step 3: Trigger materialize so today + future days spawn fresh nudge series anchors**

```sql
SELECT materialize_nudge_series_daily();
```
Expect: count of new anchors (only days from today onward where parent's days[] matches).

**Step 4: Verify**

```sql
SELECT id, message_text, recurrence->>'time' AS slot,
       recurrence->'days' AS days,
       nudge_config->>'deadline_time_il' AS deadline,
       series_status
FROM reminder_queue
WHERE household_id='hh_u4lp6lsh'
  AND nudge_config IS NOT NULL
ORDER BY message_text, slot;
```
Expect: 3 parents (עופרי dog, אריק dog, עופרי pill) + however many active anchors materialize spawned today.

**Step 5: Commit log**

No code change to commit. Append a note to the design doc's interim cleanup log:
```bash
# (manually edit docs/plans/2026-04-26-nudge-reminders-design.md to note Phase 1 backfill done)
git add docs/plans/2026-04-26-nudge-reminders-design.md
git commit -m "docs(plans): nudge reminders — Phase 1 Netzer backfill complete"
```

---

## Phase 2 — Classifier + Sonnet prompts

### Task 2.1: Add `add_nudge_reminder` intent to Haiku classifier

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — Haiku classifier prompt section. Search for the existing intent list (look for `add_recurring_reminder` to find it).

**Step 1: Find current intent list**

```bash
grep -n "add_recurring_reminder" supabase/functions/whatsapp-webhook/index.inlined.ts | head -20
```
Identify the prompt-string region listing all intents (15 items per CLAUDE.md). Note line numbers.

**Step 2: Add intent definition**

In the intent enumeration in the Haiku prompt, after `add_recurring_reminder`, add:

```
- "add_nudge_reminder": A reminder that fires repeatedly every N minutes until someone says it's done. Distinct from add_reminder (one-shot) and add_recurring_reminder (calendar). Trigger phrases: "כל X דקות עד ש...", "נדנדי", "תמשיכי להזכיר עד...", "keep reminding until...".
```

In the entities-shape section, add the entity fields for `add_nudge_reminder`:

```
For add_nudge_reminder:
  target_name: string (who needs reminding)
  completion_text: string (what they need to do, e.g. "להוציא את ליאו")
  interval_min: int (default 30 if user didn't specify; min 15)
  deadline_time_il: string "HH:MM" or null (when to stop trying)
  max_tries: int or null (use 6 default if unset; max 8)
  days: array of int (0=Sunday) for daily-recurring; null for one-shot
  channel_hint: "group" | "dm" | null (null means ask user)
```

In the EXAMPLES section of the Haiku prompt, add 4 examples:
- "תזכירי לעופרי כל חצי שעה עד שתוציא את ליאו" → `{intent:"add_nudge_reminder",entities:{target_name:"עופרי",completion_text:"להוציא את ליאו",interval_min:30,deadline_time_il:null,max_tries:null,days:null,channel_hint:null}}`
- "נדנדי לאריק להוציא את הזבל" → same intent, target=אריק
- "תזכירי לי כל 15 דק לקחת תרופה עד 21:00" → `{interval_min:15, deadline_time_il:"21:00", target_name:"לי" or sender_name}`
- "כל יום ראשון/שלישי/חמישי כל חצי שעה מ-14:00 עד 16:30 לעופרי על הכלב" → with `days:[0,2,4]`

**Step 3: Run pre-deploy esbuild check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```
Expected: exit 0, no errors.

**Step 4: Deploy via Supabase Dashboard paste**

Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → Edge Functions → whatsapp-webhook → Code tab → paste → Deploy. Verify version bump in Dashboard. Run paste-corruption scan per CLAUDE.md (search deployed source for `[A-Za-z]{2,}[֐-׿]+[A-Za-z]{2,}` regex hits in code — re-paste if any).

**Step 5: Commit (after successful deploy)**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): add_nudge_reminder Haiku intent"
```

---

### Task 2.2: Integration test — Haiku classifies nudge phrases correctly

**Files:**
- Modify: `tests/test_webhook.py` — add a new test class `TestNudgeReminders` near the existing intent test classes.

**Step 1: Write the test**

```python
class TestNudgeReminders(WebhookTestBase):
    def test_classifies_simple_nudge(self):
        msg = "שלי תזכירי לעופרי כל חצי שעה עד שתוציא את ליאו"
        result = self.send_message(msg, group_id="120363407839946451@g.us",
                                    sender_phone="972526210880", sender_name="עינת")
        self.assertEqual(result.classification_data.get("intent"), "add_nudge_reminder")
        self.assertEqual(result.classification_data["entities"]["interval_min"], 30)
        self.assertEqual(result.classification_data["entities"]["target_name"], "עופרי")

    def test_classifies_short_interval_nudge(self):
        msg = "שלי כל 15 דק תזכירי לי לבדוק את התנור"
        result = self.send_message(msg, group_id=...)
        self.assertEqual(result.classification_data["intent"], "add_nudge_reminder")
        self.assertEqual(result.classification_data["entities"]["interval_min"], 15)

    def test_classifies_with_deadline(self):
        msg = "שלי נדנדי לי כל חצי שעה עד 22:00 לקחת כדור"
        result = self.send_message(msg, group_id=...)
        self.assertEqual(result.classification_data["intent"], "add_nudge_reminder")
        self.assertEqual(result.classification_data["entities"]["deadline_time_il"], "22:00")
```

**Step 2: Run only this class**

```bash
python tests/test_webhook.py --category NudgeReminders
```
Expected: 3/3 pass (LLM-non-determinism may cause occasional flakes; re-run on flake).

**Step 3: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(bot): integration tests for add_nudge_reminder classification"
```

---

### Task 2.3: Add `nudge_series` action type to executor

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — find `executeActions` (group path) and `execute1on1Actions` (1:1 path). Look for the `add_recurring_reminder` case as the closest parallel.

**Step 1: Implement the action handler**

Inside `executeActions` add a new case `nudge_series`:

```typescript
case "nudge_series": {
  // Validate config
  const cfg = action;  // {type, target_name, target_phone?, completion_text, interval_min, deadline_time_il, max_tries, days?, channel}
  const interval = cfg.interval_min ?? 30;
  const maxTries = cfg.max_tries ?? 6;
  if (interval < 15 || maxTries > 8) {
    actionResults.push({ ok:false, error:"sub_floor", action:cfg });
    break;
  }

  // Resolve target_phone if missing (use existing resolveRecipientNamesToPhones)
  let targetPhone = cfg.target_phone;
  if (!targetPhone && cfg.target_name) {
    const resolved = await resolveRecipientNamesToPhones(supabase, householdId, [cfg.target_name]);
    targetPhone = resolved[0] ?? null;
  }

  const nudge_config = {
    interval_min: interval,
    max_tries: maxTries,
    deadline_time_il: cfg.deadline_time_il ?? null,
    channel: cfg.channel ?? "group",
    target_phone: targetPhone,
    target_name: cfg.target_name,
    prompt_completion: cfg.completion_text,
  };

  const message_text = `${cfg.target_name} — ${cfg.completion_text}`;

  if (cfg.days && Array.isArray(cfg.days) && cfg.days.length > 0) {
    // Daily-recurring nudge parent
    const insertParent = await supabase.from("reminder_queue").insert({
      household_id: householdId,
      group_id: groupId,
      message_text,
      send_at: new Date().toISOString(),
      sent: true,  // sentinel
      reminder_type: "user",
      created_by_phone: senderPhone,
      created_by_name: senderName,
      delivery_mode: "group",
      recurrence: { days: cfg.days, time: cfg.start_time_il ?? "09:00" },
      nudge_config,
      metadata: { source: "nudge_series_action", recurring_parent: true }
    });
    if (insertParent.error) {
      // Probably guardrail violation — surface
      actionResults.push({ ok:false, error: insertParent.error.message, action:cfg });
      break;
    }
    // Trigger today's series spawn immediately
    await supabase.rpc("materialize_nudge_series_daily");
  } else {
    // One-shot series — anchor + first attempt
    const anchorRes = await supabase.from("reminder_queue").insert({
      household_id: householdId,
      group_id: groupId,
      message_text,
      send_at: new Date().toISOString(),
      sent: true,  // sentinel
      reminder_type: "user",
      created_by_phone: senderPhone,
      created_by_name: senderName,
      delivery_mode: "group",
      nudge_config,
      series_status: "active",
      metadata: { source: "nudge_series_action", one_shot: true }
    }).select("id").single();
    if (anchorRes.error) {
      actionResults.push({ ok:false, error: anchorRes.error.message, action:cfg });
      break;
    }
    // Insert attempt #1 firing now
    await supabase.from("reminder_queue").insert({
      household_id: householdId,
      group_id: groupId,
      message_text,
      send_at: new Date().toISOString(),
      sent: false,
      reminder_type: "user",
      created_by_phone: senderPhone,
      delivery_mode: "group",
      nudge_series_id: anchorRes.data.id,
      nudge_attempt: 1,
      metadata: { nudge_attempt_of_series: anchorRes.data.id, attempt_num: 1 }
    });
  }
  actionResults.push({ ok:true, action:"nudge_series_created" });
  break;
}
```

Mirror the same case into `execute1on1Actions` (uses different vars — adapt; in 1:1 path the `groupId` for `delivery_mode='group'` is the family group of the requester, not the 1:1 phone — read the existing `add_event` 1:1 case for the household-group lookup pattern).

**Step 2: Pre-deploy esbuild check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```
Expected: 0 errors.

**Step 3: Deploy + paste-corruption scan**

Per CLAUDE.md routine. Verify version bump.

**Step 4: Smoke test**

Send test message in family group: "שלי תזכירי לי כל 15 דק לבדוק תנור עד 21:00". Verify in DB:
```sql
SELECT id, message_text, nudge_config, series_status
FROM reminder_queue
WHERE created_at > NOW() - INTERVAL '5 minutes'
  AND nudge_config IS NOT NULL;
```
Expect 1 anchor + 1 child.

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): nudge_series action executor (group + 1:1)"
```

---

### Task 2.4: Add `SHARED_NUDGE_RULES` constant + inject into both Sonnet prompts

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — find existing `SHARED_GROUNDING_RULES`, `SHARED_HEBREW_GRAMMAR` etc. constants (per CLAUDE.md, 7 SHARED_* constants exist).

**Step 1: Define the constant**

Near the other SHARED constants:

```typescript
const SHARED_NUDGE_RULES = `
ABSOLUTE NUDGE RULES (apply only when current user message is creating or modifying a nudge series):

1. NEVER emit {"type":"nudge_series",...} from conversational context. Only when the CURRENT message contains explicit phrases: "כל X דקות עד", "נדנדי", "תמשיכי להזכיר עד", "keep reminding until", or equivalent. Past mentions in the conversation do NOT count.

2. Confirmation reply MUST list ALL resolved fields concretely: interval_min, deadline_time_il (or "עד שמאשרים"), days (or "היום"), channel, target_name. Never say "אגדיר" or "אטפל" without numbers.

3. Days field uses 0=Sunday convention. "כל יום" → [0,1,2,3,4,5,6]. Empty array is invalid.

4. Sub-floor refusals — use these EXACT templates, do NOT paraphrase:
   - interval_min < 15 → "המינימום הוא 15 דקות בין תזכורות — וואטסאפ מגביל אותי כדי לא להיתקע. לעשות כל 15?"
   - max_tries > 8 → "מקסימום 8 תזכורות בסדרה. אחרי זה אם אף אחד לא הגיב, אני שולחת לך הודעה פרטית."
   - 4th active series error from DB → "כבר יש 3 סדרות פעילות בבית. תרצי לבטל אחת קודם?"

5. If channel is unspecified (channel_hint=null) AND the nudge would fire in a group, ASK ONE clarifying question: "בקבוצה (כולם רואים) או בפרטי ל{target_name}?". Do not guess.
`;
```

**Step 2: Inject into both prompt builders**

Find `buildReplyPrompt` (group) and `ONBOARDING_1ON1_PROMPT` (1:1) — both already interpolate other SHARED constants. Add `${SHARED_NUDGE_RULES}` to both, near the other rule blocks.

**Step 3: Pre-deploy esbuild + deploy + scan**

Same routine.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): SHARED_NUDGE_RULES injected into group + 1:1 prompts"
```

---

### Task 2.5: Integration test — end-to-end nudge creation + sub-floor refusal

**Files:**
- Modify: `tests/test_webhook.py` `TestNudgeReminders` class.

**Step 1: Add tests**

```python
def test_creates_one_shot_nudge_in_db(self):
    # Send create message, verify DB has anchor + first attempt
    msg = "שלי תזכירי לי כל 15 דק לבדוק תנור עד 21:00"
    self.send_message(msg, group_id=..., sender_phone="972XXX")
    rows = self.db_query("""
      SELECT id, nudge_config, series_status FROM reminder_queue
      WHERE created_at > NOW() - INTERVAL '30 seconds'
        AND nudge_config IS NOT NULL
    """)
    self.assertEqual(len(rows), 1)
    self.assertEqual(rows[0]["series_status"], "active")
    self.assertEqual(rows[0]["nudge_config"]["interval_min"], 15)

def test_sub_floor_refused_with_template(self):
    msg = "שלי תזכירי לי כל 5 דקות לבדוק תנור"
    result = self.send_message(msg, group_id=...)
    self.assertIn("המינימום הוא 15 דקות", result.bot_reply_text)
    rows = self.db_query("""SELECT id FROM reminder_queue WHERE created_at > NOW() - INTERVAL '30 seconds' AND nudge_config IS NOT NULL""")
    self.assertEqual(len(rows), 0)  # nothing created
```

**Step 2: Run + commit**

```bash
python tests/test_webhook.py --category NudgeReminders
git add tests/test_webhook.py
git commit -m "test(bot): nudge series creation + sub-floor refusal"
```

---

## Phase 3 — Acknowledgment paths

### Task 3.1: Hebrew/English regex fast-path for ack

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — early in `Deno.serve` request handler, before Haiku classification, after the dedup window check.

**Step 1: Implement**

```typescript
// Active-series ack fast-path: if any active series in this chat,
// check current message text against completion patterns.
const ACK_PATTERNS = /\b(בוצע|בוצעה|עשיתי|הוצאתי|נלקח|לקחתי|טיפלתי|done|did it|finished|took it)\b/i;
if (ACK_PATTERNS.test(message.text || "")) {
  // Find active series in this chat
  const chatGroupId = isGroup ? groupId : `${senderPhone}@s.whatsapp.net`;
  const { data: activeSeries } = await supabase
    .from("reminder_queue")
    .select("id, message_text, nudge_config")
    .eq("household_id", householdId)
    .eq("series_status", "active")
    .eq("group_id", chatGroupId);
  if (activeSeries && activeSeries.length > 0) {
    // Heuristic: ack the OLDEST active series (most likely the one user is responding to)
    const target = activeSeries.sort((a,b) => a.id.localeCompare(b.id))[0];
    await ackNudgeSeries(supabase, target.id, senderPhone);
    await sendAndLog(/* confirmation msg */);
    await logMessage(message, "nudge_acked_regex");
    return new Response("ok");
  }
}
```

Add helper `ackNudgeSeries`:

```typescript
async function ackNudgeSeries(supabase, seriesId: string, ackPhone: string) {
  await supabase.from("reminder_queue")
    .update({ series_status: "acked", metadata: { acked_by: ackPhone, acked_at: new Date().toISOString() } })
    .eq("id", seriesId)
    .eq("series_status", "active");  // race-safe: only update if still active
  await supabase.from("reminder_queue")
    .delete()
    .eq("nudge_series_id", seriesId)
    .eq("sent", false);
}
```

**Step 2: esbuild + deploy + scan**

**Step 3: Smoke test**

Manually create test series via `nudge_series` action, send "בוצע" in same chat, verify series → acked + child rows deleted.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): regex fast-path ack for active nudge series"
```

---

### Task 3.2: Reaction-based ack (✅ on a Sheli nudge)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — find the existing reaction handler (search `action.type === "reaction"` or `reaction_positive` per CLAUDE.md routing).

**Step 1: Extend reaction handler**

When a `reaction_positive` (👍✅💪) lands on a Sheli message, look up if that bot message was a nudge attempt:

```typescript
// In the reaction-routing branch, after determining the reacted-to message is from bot
const reactedTo = await supabase
  .from("whatsapp_messages")
  .select("metadata, classification")
  .eq("whatsapp_message_id", reactedMessageId)
  .single();

const seriesId = reactedTo?.data?.metadata?.nudge_series_id;
if (seriesId && reactionType === "positive") {
  await ackNudgeSeries(supabase, seriesId, senderPhone);
  await sendAndLog({ replyType: "nudge_acked_reaction", ... });
  return new Response("ok");
}
```

This requires nudge attempts (when sent) to log `nudge_series_id` into `whatsapp_messages.metadata` — modify the `sendAndLog` call sites that fire nudge attempts to include `metadata: { nudge_series_id, nudge_attempt }`.

**Step 2: Update drain to pass metadata**

The drain calls `net.http_post` to Whapi directly from SQL — no `sendAndLog` involvement. So bot messages from drain won't appear in `whatsapp_messages` until they bounce back as Whapi echo. The echo handler logs them but doesn't have nudge metadata.

Workaround: at drain time, INSERT a row into `whatsapp_messages` ourselves marking the Whapi outbound message ID. Modify `fire_due_reminders_inner` for nudge_series_id rows: after successful net.http_post, parse the response (Whapi returns a message ID), insert a stub `whatsapp_messages` row with `metadata.nudge_series_id`. **Note:** this is non-trivial because pg_net is fire-and-forget. Alternative: log a post-fire row from a follow-up Edge Function call.

**Simplification for v1:** match reactions by inspecting recent Sheli messages in the chat that contain the series's `prompt_completion` text. Skip metadata threading for now. Document as v1 limitation in the design doc.

**Step 3: Implement simplified version**

```typescript
// On reaction to a Sheli message:
const sheliMsg = await fetchMessageByWhapiId(reactedMessageId);
if (!sheliMsg) return;  // not in our DB
// Find any active series in this chat
const { data: activeSeries } = await supabase.from("reminder_queue")
  .select("id, nudge_config")
  .eq("household_id", householdId)
  .eq("series_status", "active")
  .eq("group_id", chatGroupId);
// Match reacted-to text against series prompt_completion
const match = activeSeries?.find(s => sheliMsg.message_text.includes(s.nudge_config.prompt_completion));
if (match) await ackNudgeSeries(supabase, match.id, senderPhone);
```

**Step 4: esbuild + deploy + scan**

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): ✅ reaction ack on nudge attempts (text-match v1)"
```

---

### Task 3.3: Haiku classifier — `completes_pending_nudge` boolean for fuzzy ack

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — Haiku prompt + classifier output schema.

**Step 1: Inject context flag when active series exists**

Before calling Haiku, check for active series in chat. If one exists, append a context line to the prompt:

```
ACTIVE NUDGE SERIES IN THIS CHAT:
- target: {target_name}, task: {prompt_completion}
If the current message indicates this task is now done (even indirectly, even with typos), set completes_pending_nudge=true in the output. Examples that count: "הוצאתי" (took out), "פיניתי" (cleared), "לקחתי" (took), "ok done", "טיפלתי בזה". Examples that don't: "מתי?" (when?), "אני בדרך" (on my way), "בעוד דקה" (in a minute).
```

**Step 2: Add field to expected output schema**

In the Haiku output validator, accept `completes_pending_nudge: boolean` (default false).

**Step 3: Wire to ack handler**

After classification, if `completes_pending_nudge=true`, ack the matching active series same way as the regex path.

**Step 4: esbuild + deploy + scan**

**Step 5: Add test**

```python
def test_haiku_acks_via_natural_completion(self):
    # First create a series
    self.send_message("שלי תזכירי לי כל 15 דק לבדוק תנור עד 21:00", group_id=...)
    # Then ack with non-regex phrase (Haiku-only)
    self.send_message("יש, התנור כבוי", group_id=...)
    rows = self.db_query("""SELECT series_status FROM reminder_queue WHERE created_at > NOW() - INTERVAL '2 minutes' AND nudge_config IS NOT NULL""")
    self.assertEqual(rows[0]["series_status"], "acked")
```

**Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts tests/test_webhook.py
git commit -m "feat(bot): Haiku completes_pending_nudge boolean for fuzzy ack"
```

---

### Task 3.4: Expiry handler — DM the requester on `expired_*`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — but the expiry transition happens in SQL (`schedule_next_nudge`). The notification has to be triggered somewhere reachable.

**Approach:** new SQL function `notify_expired_nudge_series()` that finds series flipped to `expired_*` since last run and queues outbound rows.

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION notify_expired_nudge_series()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_row RECORD;
  v_count INT := 0;
BEGIN
  FOR v_row IN
    SELECT id, household_id, created_by_phone, nudge_config, series_status
    FROM reminder_queue
    WHERE series_status IN ('expired_tries','expired_deadline')
      AND nudge_config IS NOT NULL
      AND (metadata->>'expiry_notified') IS NULL
  LOOP
    -- Queue outbound DM to requester
    INSERT INTO outbound_queue (
      phone_number, household_id, body, message_type, queued_at, metadata
    ) VALUES (
      v_row.created_by_phone, v_row.household_id,
      format('%s לא אישר/ה — להזכיר שוב מחר?', v_row.nudge_config->>'target_name'),
      'recovery',  -- reuse existing path; or new type 'expiry_notice' if outbound_queue allows
      NOW(),
      jsonb_build_object('source','nudge_expiry','series_id',v_row.id)
    );
    UPDATE reminder_queue
      SET metadata = metadata || jsonb_build_object('expiry_notified', NOW())
      WHERE id = v_row.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Cron: every 5 minutes
SELECT cron.schedule('notify_expired_nudge_series', '*/5 * * * *',
  $$SELECT notify_expired_nudge_series()$$);
```

**Step 2: Verify cron + test**

```sql
SELECT jobname FROM cron.job WHERE jobname='notify_expired_nudge_series';
```
Manually transition a test series to `expired_tries`, run `SELECT notify_expired_nudge_series();`, verify a row appears in `outbound_queue`.

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): notify_expired_nudge_series cron + outbound DM"
```

---

### Task 3.5: End-to-end integration tests

**Files:**
- Modify: `tests/test_webhook.py` `TestNudgeReminders`.

**Step 1: Add 4 more tests covering acks + expiries**

```python
def test_max_tries_expiry(self):
    # Create series with max_tries=2 and short interval, fast-forward via direct SQL
    # Verify series_status='expired_tries' and outbound_queue row appears
    ...

def test_deadline_expiry(self):
    # Create series with deadline 2 min from now, no ack
    # Wait, verify expired_deadline
    ...

def test_reaction_ack(self):
    # Create series, simulate ✅ reaction on Sheli message
    # Verify acked
    ...

def test_daily_recurring_independence(self):
    # Create daily-recurring nudge with days [DOW_TODAY], ack today
    # Manually advance materialize to next day, verify new active series spawns
    ...
```

**Step 2: Run all**

```bash
python tests/test_webhook.py --category NudgeReminders
```
Expected: 8/8 pass (or 7/8 with one LLM-flake on ambiguous case).

**Step 3: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(bot): nudge series ack + expiry end-to-end"
```

---

## Phase 4 — Feature flag + rollout

### Task 4.1: Feature flag `nudge_reminders_enabled`

**Files:**
- Migration name: `2026_04_26_nudge_reminders_feature_flag`
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` — gate `add_nudge_reminder` action execution.

**Step 1: Add bot_settings + per-household override**

```sql
INSERT INTO bot_settings (key, value, updated_by)
VALUES ('nudge_reminders_enabled', 'false', 'phase4_default')
ON CONFLICT (key) DO NOTHING;

-- Enable for Netzer first
UPDATE households_v2
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('nudge_reminders_enabled', true)
WHERE id = 'hh_u4lp6lsh';
```

**Step 2: Gate executor**

In `executeActions` and `execute1on1Actions` `nudge_series` case, BEFORE creating the row:

```typescript
// Check household override first, then global flag
const { data: hh } = await supabase.from("households_v2").select("metadata").eq("id", householdId).single();
const hhEnabled = hh?.metadata?.nudge_reminders_enabled;
let enabled: boolean;
if (typeof hhEnabled === "boolean") {
  enabled = hhEnabled;
} else {
  const { data: setting } = await supabase.from("bot_settings").select("value").eq("key","nudge_reminders_enabled").single();
  enabled = setting?.value === "true";
}
if (!enabled) {
  // Soft refuse — explain feature is in beta
  actionResults.push({ ok:false, error:"feature_disabled", action:cfg });
  break;
}
```

**Step 3: Commit + deploy**

```bash
git add supabase/migrations/ supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): nudge_reminders_enabled feature flag (Netzer first)"
```

---

### Task 4.2: Rollout verification — Netzer

**Step 1:** Verify Netzer's 3 active recurring nudge parents work end-to-end:
- Tomorrow morning: Watch the family group; verify אריק dog nudges fire 14:00 → 16:30.
- Tomorrow night: Watch pill nudges fire 20:00 → 22:30 (or stop early on ack).
- Verify ack works: have someone send "בוצע" mid-series, check series flips to `acked` and remaining attempts deleted.

**Step 2:** If issues, debug via:
```sql
SELECT id, nudge_attempt, send_at AT TIME ZONE 'Asia/Jerusalem' AS send_at_il, sent, sent_at, metadata
FROM reminder_queue
WHERE household_id='hh_u4lp6lsh' AND nudge_series_id IS NOT NULL
ORDER BY send_at DESC LIMIT 30;
```

**Step 3:** Once verified, document in CLAUDE.md a brief mention of nudge reminders + the gotchas list.

---

## Reference

- **Design doc:** `docs/plans/2026-04-26-nudge-reminders-design.md`
- **CLAUDE.md sections to read:** "WhatsApp Bot Gotchas", "Reminder drain v5", "Recurring reminders", "Edge Function deploy verify ritual"
- **Skills to invoke during execution:** `superpowers:test-driven-development` for each TDD task; `superpowers:verification-before-completion` before claiming done; `superpowers:requesting-code-review` after Phase 2 and Phase 3.
