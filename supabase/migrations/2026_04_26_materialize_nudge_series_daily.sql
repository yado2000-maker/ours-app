-- materialize_nudge_series_daily() — one daily-recurring nudge parent spawns
-- one fresh series anchor per matching weekday, with attempt #1 queued at the
-- parent's recurrence.time. Runs nightly at 22:00 UTC (~01:00 IL) via pg_cron.
--
-- Walks every recurrence-bearing parent (recurrence IS NOT NULL +
-- nudge_config IS NOT NULL + recurrence_parent_id IS NULL + sent=true sentinel
-- + series_status IS NULL on the parent itself).
--
-- Skip rules:
--   - today's DOW not in recurrence.days
--   - a series anchor for this parent + today already exists
--     (idempotent re-runs / hand-triggered runs from a deploy)
--   - parent's start time is more than 6 hours past (window expired)
--
-- Each spawn creates two rows:
--   - anchor: sent=true sentinel, nudge_config copied, series_status='active',
--     metadata.nudge_parent_id + series_date_il for dedup
--   - attempt #1: sent=false, send_at = max(parent.start_time_utc, NOW()),
--     nudge_series_id = anchor_id, nudge_attempt = 1
--
-- Returns INT count of series spawned this call.
--
-- See docs/plans/2026-04-26-nudge-reminders-design.md "Daily-recurring series".

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

  FOR v_parent IN
    SELECT id, household_id, group_id, message_text, reminder_type,
           created_by_phone, created_by_name, delivery_mode, recipient_phones,
           recurrence, nudge_config
    FROM reminder_queue
    WHERE recurrence IS NOT NULL
      AND nudge_config IS NOT NULL
      AND recurrence_parent_id IS NULL
      AND sent = true
      AND series_status IS NULL
  LOOP
    IF NOT (v_parent.recurrence->'days' @> to_jsonb(v_today_dow)) THEN
      CONTINUE;
    END IF;

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

    IF v_anchor_send_at_utc < NOW() - INTERVAL '6 hours' THEN
      CONTINUE;
    END IF;

    INSERT INTO reminder_queue (
      household_id, group_id, message_text, send_at, sent, reminder_type,
      created_by_phone, created_by_name, delivery_mode, recipient_phones,
      nudge_config, series_status, metadata
    ) VALUES (
      v_parent.household_id, v_parent.group_id, v_parent.message_text,
      GREATEST(v_anchor_send_at_utc, NOW()),
      true,
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

-- Schedule: 22:00 UTC daily = 01:00 IL (IDT) / 00:00 IL (IST). Acceptable drift —
-- earliest known nudge starts at 14:00 IL, so even worst-case spawn at midnight
-- gives 14h lead time.
SELECT cron.schedule(
  'materialize_nudge_series_daily',
  '0 22 * * *',
  $$SELECT materialize_nudge_series_daily()$$
);
