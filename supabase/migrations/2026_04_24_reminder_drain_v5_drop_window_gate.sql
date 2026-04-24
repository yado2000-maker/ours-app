-- fire_due_reminders_inner v5 (2026-04-24) — drop 24h customer-care window gate.
--
-- Rationale: v4 silently marked reminders as sent with fanout.skipped=[target]
-- when il_window_open_for_chat(target) returned false (recipient hadn't
-- messaged bot in 24h). Last 14 days: 12 legacy window_closed + 6 fanouts
-- with zero recipients → ~18 silent reminder deaths. A silent drop churns
-- a user; a fired reminder can re-engage.
--
-- Volume is low enough (2 pending DMs, 99 group) that the anti-ban value
-- of the gate doesn't justify the churn cost. Kept: attempts<3,
-- send_at <= NOW(), 24h staleness, SKIP LOCKED, 10/tick, reminders_paused
-- kill switch (wrapper), per-target HTTP try/catch.

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
    v_had_http_error := false;

    FOREACH v_target IN ARRAY v_targets LOOP
      -- v5: il_window_open_for_chat gate REMOVED. Every due reminder fires
      -- regardless of whether the recipient messaged the bot in the last 24h.
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
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.fire_due_reminders_inner() IS
  'v5 (2026-04-24): 24h customer-care window gate REMOVED. Every due reminder fires regardless of last-inbound. Reasoning: silent drops churn users; volume too low (2 DM, 99 group) to justify anti-ban cost. reminders_paused kill switch remains at wrapper layer.';
