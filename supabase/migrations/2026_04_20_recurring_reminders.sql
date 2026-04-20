-- Fix 4: Recurring reminders first-class support (2026-04-20).
-- Parent rows hold a recurrence JSONB rule ({days:[0..6], time:"HH:MM"}).
-- Parents are marked sent=true so drain ignores them. A daily materializer
-- reads each parent and inserts child reminder_queue rows for the next 7 days
-- (one-shot, sent=false, recurrence_parent_id -> parent). Drain fires the
-- children normally; window-check + quiet-hours gating inherits automatically.

ALTER TABLE public.reminder_queue
  ADD COLUMN IF NOT EXISTS recurrence JSONB,
  ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID REFERENCES public.reminder_queue(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS reminder_queue_recurrence_parent_idx
  ON public.reminder_queue (id)
  WHERE recurrence IS NOT NULL AND recurrence_parent_id IS NULL;

CREATE INDEX IF NOT EXISTS reminder_queue_recurrence_child_idx
  ON public.reminder_queue (recurrence_parent_id, send_at)
  WHERE recurrence_parent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.materialize_recurring_reminders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
BEGIN
  v_today_il := (NOW() AT TIME ZONE 'Asia/Jerusalem')::date;
  FOR v_parent IN
    SELECT id, message_text, group_id, reminder_type, recurrence, household_id
    FROM public.reminder_queue
    WHERE recurrence IS NOT NULL
      AND recurrence_parent_id IS NULL
      AND sent = true
  LOOP
    v_days := v_parent.recurrence->'days';
    v_time := COALESCE(v_parent.recurrence->>'time', '09:00');
    v_hour := split_part(v_time, ':', 1)::int;
    v_minute := split_part(v_time, ':', 2)::int;
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
            jsonb_build_object('materialized_from_recurring', true, 'parent_id', v_parent.id, 'materialized_at', NOW())
          );
          v_inserted := v_inserted + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.materialize_recurring_reminders() IS
  'Fix 4 recurring reminders: insert next 7 days of child rows for each parent with non-null recurrence. Idempotent per (parent_id, date). Skips past times. TZ: Asia/Jerusalem. Runs daily at 01:00 UTC via pg_cron.';

SELECT cron.schedule(
  'materialize_recurring_reminders_daily',
  '0 1 * * *',
  $cron$ SELECT public.materialize_recurring_reminders(); $cron$
);
