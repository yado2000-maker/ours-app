-- Calendar materializer must skip parents that carry nudge_config — those
-- are the new state-machine primitive owned by materialize_nudge_series_daily
-- (cron at 22:00 UTC). Without this filter, both materializers would run
-- against the same parents and produce duplicate firings every matching day.
--
-- Single change vs prior version: add `AND nudge_config IS NULL` to the
-- FOR loop SELECT. Everything else preserved verbatim.
--
-- Plan: docs/plans/2026-04-26-nudge-reminders-plan.md (Phase 1 Task 1.6a)

CREATE OR REPLACE FUNCTION materialize_recurring_reminders()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_inserted INT := 0;
  v_parent RECORD;
  v_day_offset INT;
  v_target_date DATE;
  v_target_dow INT;
  v_time TEXT;
  v_hour INT;
  v_minute INT;
  v_send_at_il TIMESTAMP;
  v_send_at_utc TIMESTAMPTZ;
  v_days JSONB;
  v_today_il DATE;
  v_type TEXT;
  v_day_of_month INT;
BEGIN
  v_today_il := (NOW() AT TIME ZONE 'Asia/Jerusalem')::date;
  FOR v_parent IN
    SELECT id, message_text, group_id, reminder_type, recurrence, household_id
    FROM public.reminder_queue
    WHERE recurrence IS NOT NULL
      AND recurrence_parent_id IS NULL
      AND sent = true
      AND nudge_config IS NULL
  LOOP
    v_type := COALESCE(v_parent.recurrence->>'type', 'weekly');
    v_time := COALESCE(v_parent.recurrence->>'time', '09:00');
    v_hour := split_part(v_time, ':', 1)::int;
    v_minute := split_part(v_time, ':', 2)::int;

    IF v_type = 'monthly' THEN
      v_day_of_month := NULLIF(v_parent.recurrence->>'day_of_month', '')::int;
      IF v_day_of_month IS NULL OR v_day_of_month < 1 OR v_day_of_month > 31 THEN
        RAISE WARNING 'materialize_recurring_reminders: parent % has invalid monthly day_of_month=%', v_parent.id, v_parent.recurrence->>'day_of_month';
        CONTINUE;
      END IF;
      FOR v_day_offset IN 0..42 LOOP
        v_target_date := v_today_il + v_day_offset;
        IF EXTRACT(DAY FROM v_target_date)::int = v_day_of_month THEN
          v_send_at_il := v_target_date + make_time(v_hour, v_minute, 0);
          v_send_at_utc := v_send_at_il AT TIME ZONE 'Asia/Jerusalem';
          IF v_send_at_utc < NOW() THEN CONTINUE; END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.reminder_queue
            WHERE recurrence_parent_id = v_parent.id
              AND (send_at AT TIME ZONE 'Asia/Jerusalem')::date = v_target_date
          ) THEN
            INSERT INTO public.reminder_queue (
              household_id, message_text, send_at, sent, group_id, reminder_type,
              recurrence_parent_id, metadata
            ) VALUES (
              v_parent.household_id, v_parent.message_text, v_send_at_utc,
              false, v_parent.group_id, v_parent.reminder_type, v_parent.id,
              jsonb_build_object(
                'materialized_from_recurring', true,
                'parent_id', v_parent.id,
                'cadence', 'monthly',
                'materialized_at', NOW()
              )
            );
            v_inserted := v_inserted + 1;
          END IF;
          EXIT;
        END IF;
      END LOOP;
    ELSE
      v_days := v_parent.recurrence->'days';
      IF v_days IS NULL THEN CONTINUE; END IF;
      FOR v_day_offset IN 0..6 LOOP
        v_target_date := v_today_il + v_day_offset;
        v_target_dow := EXTRACT(DOW FROM v_target_date)::int;
        IF v_days @> to_jsonb(v_target_dow) THEN
          v_send_at_il := v_target_date + make_time(v_hour, v_minute, 0);
          v_send_at_utc := v_send_at_il AT TIME ZONE 'Asia/Jerusalem';
          IF v_send_at_utc < NOW() THEN CONTINUE; END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.reminder_queue
            WHERE recurrence_parent_id = v_parent.id
              AND (send_at AT TIME ZONE 'Asia/Jerusalem')::date = v_target_date
          ) THEN
            INSERT INTO public.reminder_queue (
              household_id, message_text, send_at, sent, group_id, reminder_type,
              recurrence_parent_id, metadata
            ) VALUES (
              v_parent.household_id, v_parent.message_text, v_send_at_utc,
              false, v_parent.group_id, v_parent.reminder_type, v_parent.id,
              jsonb_build_object(
                'materialized_from_recurring', true,
                'parent_id', v_parent.id,
                'cadence', 'weekly',
                'materialized_at', NOW()
              )
            );
            v_inserted := v_inserted + 1;
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_inserted;
END;
$$;
