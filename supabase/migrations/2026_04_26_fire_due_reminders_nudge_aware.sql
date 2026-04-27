-- Drain v6 — nudge-aware. After successfully firing a nudge attempt
-- (nudge_series_id IS NOT NULL + http_post landed), call
-- schedule_next_nudge(series_id) to either insert attempt N+1 or flip the
-- series to expired_tries / expired_deadline.
--
-- All other behavior preserved from v5:
--   - 24h staleness floor on send_at
--   - 10-at-a-time, FOR UPDATE SKIP LOCKED
--   - delivery_mode group/dm/both fan-out
--   - per-row attempts<3 + last_error breadcrumb on http failure
--   - empty recipient_phones on dm → mark sent + note='no_recipients' (no fanout)
--
-- The schedule_next_nudge call is wrapped in BEGIN/EXCEPTION so a poisoned
-- nudge config can never abort the loop and block real reminders. On error,
-- a metadata.schedule_next_error breadcrumb is left on the just-fired row.
--
-- Plan: docs/plans/2026-04-26-nudge-reminders-plan.md (Phase 1 Task 1.4)

CREATE OR REPLACE FUNCTION fire_due_reminders_inner()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  r                RECORD;
  v_count          INT := 0;
  v_request_id     BIGINT;
  v_msg_body       TEXT;
  v_target         TEXT;
  v_targets        TEXT[];
  v_sent_to        TEXT[];
  v_whapi_token    CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
  v_had_http_error BOOLEAN;
BEGIN
  FOR r IN
    SELECT id, group_id, message_text, send_at, attempts,
           delivery_mode, recipient_phones,
           nudge_series_id
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
    v_had_http_error := false;

    FOREACH v_target IN ARRAY v_targets LOOP
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
               'mode',    COALESCE(r.delivery_mode, 'group')
             )
           )
     WHERE id = r.id;

    IF array_length(v_sent_to, 1) IS NOT NULL THEN
      v_count := v_count + 1;

      -- NUDGE-AWARE EXTENSION (v6, 2026-04-26):
      -- On a successful nudge-attempt fire, schedule the next attempt
      -- (or transition the series to expired_tries / expired_deadline).
      -- Wrapped defensively: a poisoned config must never poison the drain.
      IF r.nudge_series_id IS NOT NULL THEN
        BEGIN
          PERFORM schedule_next_nudge(r.nudge_series_id);
        EXCEPTION WHEN OTHERS THEN
          UPDATE public.reminder_queue
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'schedule_next_error', SQLERRM,
                   'schedule_next_error_at', NOW())
           WHERE id = r.id;
        END;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;
