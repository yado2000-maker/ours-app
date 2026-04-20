-- Fix: user-created reminders fire at their send_at regardless of quiet hours.
-- If a user explicitly schedules a reminder for "שבת בבוקר" or "מחר ב-23:00",
-- we should honor their chosen time. The quiet-hours check was belt-and-
-- suspenders safety on top of il_window_open_for_chat (the real Meta 24h
-- customer-care window anti-spam gate). Suppressing user-scheduled times
-- was overreach.
--
-- Change: remove the top-level is_quiet_hours_il() early-return from
-- fire_due_reminders_inner. Anti-spam remains gated per-row via
-- il_window_open_for_chat. attempts cap still limits retries.

CREATE OR REPLACE FUNCTION public.fire_due_reminders_inner()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  r              RECORD;
  v_count        INT := 0;
  v_request_id   BIGINT;
  v_msg_body     TEXT;
  v_window_open  BOOLEAN;
  v_whapi_token  CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
BEGIN
  -- Quiet hours check REMOVED (2026-04-20). User-scheduled reminders fire at
  -- their send_at regardless of time of day. Anti-spam is still gated by
  -- il_window_open_for_chat (24h customer-care window) below.

  FOR r IN
    SELECT id, group_id, message_text, send_at, attempts
    FROM public.reminder_queue
    WHERE sent = false
      AND send_at <= NOW()
      AND send_at > NOW() - INTERVAL '24 hours'
      AND COALESCE(attempts, 0) < 3
    ORDER BY send_at ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  LOOP
    v_window_open := public.il_window_open_for_chat(r.group_id);

    IF NOT v_window_open THEN
      UPDATE public.reminder_queue
         SET sent     = true,
             sent_at  = NOW(),
             attempts = COALESCE(attempts, 0) + 1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'note',       'window_closed',
               'skipped_at', NOW()
             )
       WHERE id = r.id;
      CONTINUE;
    END IF;

    v_msg_body := '⏰ תזכורת ' || r.message_text;

    BEGIN
      SELECT net.http_post(
        url     := 'https://gate.whapi.cloud/messages/text',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_whapi_token,
          'Content-Type',  'application/json'
        ),
        body    := jsonb_build_object('to', r.group_id, 'body', v_msg_body)
      ) INTO v_request_id;

      UPDATE public.reminder_queue
         SET sent     = true,
             sent_at  = NOW(),
             attempts = COALESCE(attempts, 0) + 1
       WHERE id = r.id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.reminder_queue
         SET attempts = COALESCE(attempts, 0) + 1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'last_error',    SQLERRM,
               'last_error_at', NOW()
             )
       WHERE id = r.id;
    END;
  END LOOP;

  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.fire_due_reminders_inner() IS
  'v3 (2026-04-20): quiet-hours check removed — user-scheduled reminders fire at their send_at regardless of time of day. Anti-spam still gated by il_window_open_for_chat (24h customer-care window) per-row.';
