-- 2026-04-18 (later same day): extend welcome_queue into a general
-- outbound_queue so the same rate-limited drain can carry BOTH auto-welcomes
-- AND personalised "recovery" messages to users who were stuck on the
-- WhatsApp "Away Message" during the 24h ban window.
--
-- Prior migration (2026_04_18_welcome_queue.sql) created welcome_queue +
-- render_welcome_template + drain_welcome_queue + pg_cron job. That schema
-- is template-only (variant 1-3 rendered in SQL). Recovery messages are
-- Sonnet-generated per-user so we need a free-form body column and a
-- message_type discriminator.
--
-- Both migrations are still "uncommitted-to-prod" (user deploys manually
-- after ban lifts), so this is just the logical next step of the same
-- feature.

-- ============================================================================
-- Schema evolution
-- ============================================================================

ALTER TABLE public.welcome_queue RENAME TO outbound_queue;

ALTER INDEX IF EXISTS public.welcome_queue_due_idx       RENAME TO outbound_queue_due_idx;
ALTER INDEX IF EXISTS public.welcome_queue_sent_at_idx   RENAME TO outbound_queue_sent_at_idx;

ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'welcome'
    CHECK (message_type IN ('welcome', 'recovery'));

ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS body TEXT;

ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Make template_variant nullable (recovery rows have no variant).
ALTER TABLE public.outbound_queue
  ALTER COLUMN template_variant DROP NOT NULL;

-- Guarantee the row has enough info to be rendered at drain time.
ALTER TABLE public.outbound_queue
  DROP CONSTRAINT IF EXISTS outbound_queue_render_shape;
ALTER TABLE public.outbound_queue
  ADD CONSTRAINT outbound_queue_render_shape CHECK (
    (message_type = 'welcome'  AND template_variant IS NOT NULL) OR
    (message_type = 'recovery' AND body IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS outbound_queue_type_sent_idx
  ON public.outbound_queue (message_type, sent_at);

-- ============================================================================
-- Replace drain function: handle both welcome (template render) and recovery
-- (free-form body). Still 6-per-rolling-hour global cap across all types.
-- ============================================================================

-- Old function is now stale; keep it but make it a thin forwarder so any
-- already-scheduled cron jobs keep working while the user redeploys.
CREATE OR REPLACE FUNCTION public.drain_welcome_queue()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN public.drain_outbound_queue();
END;
$$;

CREATE OR REPLACE FUNCTION public.drain_outbound_queue()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row           RECORD;
  v_sent_last_hr  INT;
  v_slots_left    INT;
  v_budget        CONSTANT INT := 6;
  v_msg           TEXT;
  v_count         INT := 0;
  v_req_id        BIGINT;
  v_whapi_token   CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
BEGIN
  SELECT COUNT(*) INTO v_sent_last_hr
  FROM public.outbound_queue
  WHERE sent_at IS NOT NULL
    AND sent_at > NOW() - INTERVAL '1 hour';

  v_slots_left := v_budget - v_sent_last_hr;
  IF v_slots_left <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT phone_number, display_name, template_variant, body,
           message_type, attempts
    FROM public.outbound_queue
    WHERE sent_at IS NULL
      AND scheduled_for <= NOW()
      AND attempts < 3
    ORDER BY scheduled_for ASC
    LIMIT v_slots_left
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_row.message_type = 'recovery' THEN
      v_msg := v_row.body;
    ELSE
      v_msg := public.render_welcome_template(v_row.template_variant, v_row.display_name);
    END IF;

    IF v_msg IS NULL OR length(trim(v_msg)) = 0 THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE phone_number = v_row.phone_number;
      CONTINUE;
    END IF;

    BEGIN
      SELECT net.http_post(
        url     := 'https://gate.whapi.cloud/messages/text',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_whapi_token,
          'Content-Type',  'application/json'
        ),
        body    := jsonb_build_object(
          'to',   v_row.phone_number || '@s.whatsapp.net',
          'body', v_msg
        )
      ) INTO v_req_id;

      UPDATE public.outbound_queue
         SET sent_at  = NOW(),
             attempts = attempts + 1
       WHERE phone_number = v_row.phone_number;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE phone_number = v_row.phone_number;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================================
-- Re-schedule cron: point the existing minute-tick at the new drain.
-- Safe to re-run.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('drain_welcome_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_welcome_queue_every_minute');
  PERFORM cron.unschedule('drain_outbound_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_outbound_queue_every_minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'drain_outbound_queue_every_minute',
  '* * * * *',
  $cron$ SELECT public.drain_outbound_queue(); $cron$
);
