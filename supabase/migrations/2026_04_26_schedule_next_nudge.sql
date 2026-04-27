-- schedule_next_nudge(p_series_id UUID) — race-safe per-series next-attempt scheduler.
--
-- Called by the reminder drain right after a nudge attempt fires. Returns
-- one of:
--   'noop_acked'        — series already terminal (acked / expired / superseded)
--   'expired_tries'     — max_tries reached
--   'expired_deadline'  — next_send would cross deadline_time_il (today)
--   'scheduled'         — new attempt row inserted with send_at = NOW()+interval_min
--
-- Uses SELECT ... FOR UPDATE on the anchor row so two concurrent fire ticks
-- can't both schedule the next attempt.
--
-- See docs/plans/2026-04-26-nudge-reminders-design.md "Per attempt fire".

CREATE OR REPLACE FUNCTION schedule_next_nudge(p_series_id UUID)
RETURNS TEXT
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
