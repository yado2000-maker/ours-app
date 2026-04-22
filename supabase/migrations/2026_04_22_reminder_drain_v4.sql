-- fire_due_reminders_inner v4 (2026-04-22) — private DM reminder fan-out.
-- Extends v3 with per-recipient fan-out. No quiet-hours early return.
-- Per-target il_window_open_for_chat gate. Partial HTTP error keeps row
-- sent=false (retries <= 3).

CREATE OR REPLACE FUNCTION public.fire_due_reminders_inner()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  r                RECORD;
  v_count          INT := 0;
  v_request_id     BIGINT;
  v_msg_body       TEXT;
  v_target         TEXT;
  v_targets        TEXT[];
  v_sent_to        TEXT[];
  v_skipped        TEXT[];
  v_whapi_token    CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
  v_had_http_error BOOLEAN;
BEGIN
  FOR r IN
    SELECT id, group_id, message_text, send_at, attempts,
           delivery_mode, recipient_phones
    FROM public.reminder_queue
    WHERE sent = false
      AND send_at <= NOW()
      AND send_at >  NOW() - INTERVAL '24 hours'
      AND COALESCE(attempts, 0) < 3
    ORDER BY send_at ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  LOOP
    v_targets := ARRAY[]::TEXT[];
    IF COALESCE(r.delivery_mode, 'group') = 'group' THEN
      v_targets := ARRAY[r.group_id];
    ELSIF r.delivery_mode = 'dm' THEN
      IF r.recipient_phones IS NULL OR array_length(r.recipient_phones, 1) IS NULL THEN
        UPDATE public.reminder_queue
           SET sent = true, sent_at = NOW(),
               attempts = COALESCE(attempts, 0) + 1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'note', 'no_recipients', 'skipped_at', NOW())
         WHERE id = r.id;
        CONTINUE;
      END IF;
      SELECT array_agg(p || '@s.whatsapp.net') INTO v_targets
        FROM unnest(r.recipient_phones) AS p;
    ELSIF r.delivery_mode = 'both' THEN
      v_targets := ARRAY[r.group_id];
      IF r.recipient_phones IS NOT NULL AND array_length(r.recipient_phones, 1) IS NOT NULL THEN
        v_targets := v_targets || (
          SELECT array_agg(p || '@s.whatsapp.net') FROM unnest(r.recipient_phones) AS p
        );
      END IF;
    END IF;

    v_msg_body := '⏰ תזכורת ' || r.message_text;
    v_sent_to := ARRAY[]::TEXT[];
    v_skipped := ARRAY[]::TEXT[];
    v_had_http_error := false;

    FOREACH v_target IN ARRAY v_targets LOOP
      IF NOT public.il_window_open_for_chat(v_target) THEN
        v_skipped := v_skipped || v_target;
        CONTINUE;
      END IF;
      BEGIN
        SELECT net.http_post(
          url     := 'https://gate.whapi.cloud/messages/text',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || v_whapi_token,
            'Content-Type',  'application/json'
          ),
          body    := jsonb_build_object('to', v_target, 'body', v_msg_body)
        ) INTO v_request_id;
        v_sent_to := v_sent_to || v_target;
      EXCEPTION WHEN OTHERS THEN
        v_had_http_error := true;
        UPDATE public.reminder_queue
           SET attempts = COALESCE(attempts, 0) + 1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'last_error',        SQLERRM,
                 'last_error_at',     NOW(),
                 'last_error_target', v_target)
         WHERE id = r.id;
        EXIT;
      END;
    END LOOP;

    IF v_had_http_error THEN
      CONTINUE;
    END IF;

    UPDATE public.reminder_queue
       SET sent = true, sent_at = NOW(),
           attempts = COALESCE(attempts, 0) + 1,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'fanout', jsonb_build_object(
               'sent_to', to_jsonb(v_sent_to),
               'skipped', to_jsonb(v_skipped),
               'mode',    COALESCE(r.delivery_mode, 'group')
             )
           )
     WHERE id = r.id;

    IF array_length(v_sent_to, 1) IS NOT NULL THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.fire_due_reminders_inner() IS
  'v4 (2026-04-22): per-recipient fan-out. delivery_mode=group|dm|both with recipient_phones array. Per-target il_window_open_for_chat gate. No quiet-hours early return.';

-- Update materializer to copy new fields from parent to child
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
    SELECT id, message_text, group_id, reminder_type, recurrence, household_id,
           delivery_mode, recipient_phones
    FROM public.reminder_queue
    WHERE recurrence IS NOT NULL AND recurrence_parent_id IS NULL AND sent = true
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
            recurrence_parent_id, delivery_mode, recipient_phones, metadata
          ) VALUES (
            v_parent.household_id, v_parent.message_text, v_send_at_utc,
            false, v_parent.group_id, v_parent.reminder_type, v_parent.id,
            COALESCE(v_parent.delivery_mode, 'group'), v_parent.recipient_phones,
            jsonb_build_object('materialized_from_recurring', true,
                               'parent_id', v_parent.id,
                               'materialized_at', NOW())
          );
          v_inserted := v_inserted + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_inserted;
END;
$$;
