-- ─────────────────────────────────────────────────────────────────────────────
-- Bug 4 (2026-04-20) — Window-checked reminder drain (v2).
--
-- Replaces fire_due_reminders() with a drain that:
--   1. Honours a 4th kill-switch layer: bot_settings.reminders_paused
--      (defaults to 'true' so this migration alone does NOT resume firing).
--   2. Defers entirely during IL quiet hours (22:00–07:00 daily, Fri 15:00 –
--      Sat 19:00 for Shabbat).
--   3. Skips reminders for recipients whose 24h customer-care window has
--      closed — sending those would risk the anti-spam classifier (the very
--      class of behaviour that triggered the 2026-04-17 ban). Skipped reminders
--      are stamped sent=true with metadata.note='window_closed' so the cron
--      doesn't keep retrying and so a future "missed reminders" digest can
--      surface them on the user's next inbound.
--   4. Uses FOR UPDATE SKIP LOCKED so two concurrent cron runs can't double-fire.
--   5. Tracks attempts so transient HTTP errors don't fire repeatedly.
--
-- Cron is intentionally NOT (re)scheduled here. Resume requires an explicit
-- two-step opt-in by the operator:
--   (a) UPDATE bot_settings SET value='false' WHERE key='reminders_paused';
--   (b) SELECT cron.schedule('drain_reminder_queue_every_minute', '* * * * *',
--                            $$ SELECT public.fire_due_reminders(); $$);
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Schema additions (additive — safe to re-run).
ALTER TABLE public.reminder_queue
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attempts INT  DEFAULT 0;

-- 2. Kill-switch flag, layered on top of BOT_SILENT_MODE + outbound_paused.
INSERT INTO public.bot_settings(key, value)
VALUES ('reminders_paused', 'true')
ON CONFLICT (key) DO NOTHING;

-- 3. Helper: is the 24h customer-care window open for a given chat?
--    For 1:1 (group_id ends with @s.whatsapp.net) AND group chats (@g.us),
--    we check whether ANY non-bot phone has messaged that chat in the last 24h.
CREATE OR REPLACE FUNCTION public.il_window_open_for_chat(p_group_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.whatsapp_messages wm
    WHERE wm.group_id     = p_group_id
      AND wm.sender_phone IS NOT NULL
      AND wm.sender_phone <> '972555175553'              -- bot phone
      AND wm.created_at   > NOW() - INTERVAL '24 hours'
  );
$$;

-- 4. Helper: are we currently inside IL quiet hours?
--    Daily 22:00-06:59 + Friday 15:00 onward + Saturday until 18:59.
--    (Postgres EXTRACT(DOW): 0=Sun .. 5=Fri, 6=Sat.)
CREATE OR REPLACE FUNCTION public.is_quiet_hours_il()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  ts        timestamp;
  hr        int;
  dow       int;
BEGIN
  ts  := (NOW() AT TIME ZONE 'Asia/Jerusalem');
  hr  := EXTRACT(HOUR FROM ts)::int;
  dow := EXTRACT(DOW  FROM ts)::int;
  RETURN (hr >= 22 OR hr < 7)
      OR (dow = 5 AND hr >= 15)
      OR (dow = 6 AND hr < 19);
END;
$$;

-- 5. Inner drain — does the actual work. Always callable for ad-hoc / tests.
CREATE OR REPLACE FUNCTION public.fire_due_reminders_inner()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r              RECORD;
  v_count        INT := 0;
  v_request_id   BIGINT;
  v_msg_body     TEXT;
  v_window_open  BOOLEAN;
  v_whapi_token  CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
BEGIN
  -- Quiet hours: defer entirely without consuming attempts. Cron will retry
  -- next minute; eventually quiet hours end and reminders fire normally.
  IF public.is_quiet_hours_il() THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id, group_id, message_text, send_at, attempts
    FROM public.reminder_queue
    WHERE sent = false
      AND send_at  <= NOW()
      AND send_at  >  NOW() - INTERVAL '24 hours'
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
$$;

-- 6. Wrapper — what cron actually calls. Adds the bot_settings kill-switch.
DROP FUNCTION IF EXISTS public.fire_due_reminders();
CREATE OR REPLACE FUNCTION public.fire_due_reminders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_paused TEXT;
BEGIN
  SELECT value INTO v_paused FROM public.bot_settings WHERE key = 'reminders_paused';
  IF COALESCE(v_paused, 'true') = 'true' THEN
    RETURN 0;
  END IF;
  RETURN public.fire_due_reminders_inner();
END;
$$;
