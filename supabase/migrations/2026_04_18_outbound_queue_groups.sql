-- 2026-04-18 (evening): extend outbound_queue to support GROUP recovery
-- messages, in addition to the existing 1:1 welcome + recovery rows.
--
-- Context: Yaron is recovering backlog for both 1:1 chats AND group chats
-- missed during the 24h ban window (2026-04-17 05:42 UTC → 2026-04-18 ~05:42
-- UTC). A 1:1 recovery message goes to one phone; a group recovery message
-- goes to a shared WhatsApp chat_id and addresses multiple members in one
-- unified message (so we don't spray N pings into a group — that was the
-- original spam pattern that got the bot banned).
--
-- Schema changes below are additive + backward compatible with the existing
-- welcome (1:1) and recovery (1:1) row shapes. Primary key migrates from
-- `phone_number` to a surrogate UUID `id`, with a partial UNIQUE index on
-- `phone_number` WHERE `message_type='welcome'` to preserve the existing
-- `ON CONFLICT (phone_number)` upsert used by the 1:1 welcome-queue path.

-- ============================================================================
-- Schema evolution: surrogate id, chat_id, nullable phone, recovery_group
-- ============================================================================

-- 1) Add surrogate id (gen_random_uuid requires pgcrypto or pg 13+).
ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Backfill any rows still missing an id (safe — DEFAULT only applies to NEW rows).
UPDATE public.outbound_queue SET id = gen_random_uuid() WHERE id IS NULL;

-- 2) Swap primary key from phone_number → id.
ALTER TABLE public.outbound_queue
  DROP CONSTRAINT IF EXISTS welcome_queue_pkey;
ALTER TABLE public.outbound_queue
  DROP CONSTRAINT IF EXISTS outbound_queue_pkey;

ALTER TABLE public.outbound_queue
  ALTER COLUMN id SET NOT NULL,
  ADD CONSTRAINT outbound_queue_pkey PRIMARY KEY (id);

-- 3) Allow phone_number to be NULL (groups route by chat_id, no phone).
ALTER TABLE public.outbound_queue
  ALTER COLUMN phone_number DROP NOT NULL;

-- 4) New columns.
ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS chat_id TEXT;

ALTER TABLE public.outbound_queue
  ADD COLUMN IF NOT EXISTS household_id TEXT;

-- 5) Re-introduce the "one welcome per phone" guard as a partial unique index
--    so the existing 1:1 welcome upsert path (ON CONFLICT phone_number)
--    keeps working. Recovery + recovery_group rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_queue_welcome_phone_uniq
  ON public.outbound_queue (phone_number)
  WHERE message_type = 'welcome' AND phone_number IS NOT NULL;

-- 6) Expand message_type CHECK to include recovery_group.
ALTER TABLE public.outbound_queue
  DROP CONSTRAINT IF EXISTS outbound_queue_message_type_check;
-- Column-level CHECK constraints get auto-named; also drop any implicit one.
DO $$
DECLARE con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.outbound_queue'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%message_type%IN%'
  LOOP
    EXECUTE format('ALTER TABLE public.outbound_queue DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE public.outbound_queue
  ADD CONSTRAINT outbound_queue_message_type_check
  CHECK (message_type IN ('welcome', 'recovery', 'recovery_group'));

-- 7) Update the render_shape CHECK: welcome needs template+phone, recovery
--    needs body+phone, recovery_group needs body+chat_id (phone optional).
ALTER TABLE public.outbound_queue
  DROP CONSTRAINT IF EXISTS outbound_queue_render_shape;
ALTER TABLE public.outbound_queue
  ADD CONSTRAINT outbound_queue_render_shape CHECK (
    (message_type = 'welcome'        AND template_variant IS NOT NULL AND phone_number IS NOT NULL) OR
    (message_type = 'recovery'       AND body IS NOT NULL             AND phone_number IS NOT NULL) OR
    (message_type = 'recovery_group' AND body IS NOT NULL             AND chat_id IS NOT NULL)
  );

-- 8) Index for diagnostic queries by household.
CREATE INDEX IF NOT EXISTS outbound_queue_household_idx
  ON public.outbound_queue (household_id)
  WHERE household_id IS NOT NULL;

-- ============================================================================
-- Replace drain function: route by COALESCE(chat_id, phone@s.whatsapp.net)
-- Locate rows by surrogate id (phone is nullable, so the old WHERE-by-phone
-- would misbehave for group rows and wouldn't be unique post-migration).
-- Still 6-per-rolling-hour global cap across ALL message types (welcomes,
-- 1:1 recoveries, group recoveries share one bucket — that's correct:
-- WhatsApp's anti-spam limit is per-sender, not per-recipient type).
-- ============================================================================

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
  v_to            TEXT;
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
    SELECT id, phone_number, chat_id, display_name, template_variant,
           body, message_type, attempts
    FROM public.outbound_queue
    WHERE sent_at IS NULL
      AND scheduled_for <= NOW()
      AND attempts < 3
    ORDER BY
      CASE message_type
        WHEN 'recovery_group' THEN 0  -- groups first: one send unblocks many users
        WHEN 'recovery'       THEN 1
        ELSE                       2  -- welcomes last within a given tick
      END,
      scheduled_for ASC
    LIMIT v_slots_left
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Render body (template for welcome, free-form for recovery*).
    IF v_row.message_type = 'welcome' THEN
      v_msg := public.render_welcome_template(v_row.template_variant, v_row.display_name);
    ELSE
      v_msg := v_row.body;
    END IF;

    -- Resolve destination: chat_id wins (groups), else phone@s.whatsapp.net.
    v_to := COALESCE(v_row.chat_id, v_row.phone_number || '@s.whatsapp.net');

    IF v_msg IS NULL OR length(trim(v_msg)) = 0 OR v_to IS NULL THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE id = v_row.id;
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
          'to',   v_to,
          'body', v_msg
        )
      ) INTO v_req_id;

      UPDATE public.outbound_queue
         SET sent_at  = NOW(),
             attempts = attempts + 1
       WHERE id = v_row.id;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE id = v_row.id;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================================
-- Re-schedule cron (idempotent): point at the refreshed drain function.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('drain_outbound_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_outbound_queue_every_minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'drain_outbound_queue_every_minute',
  '* * * * *',
  $cron$ SELECT public.drain_outbound_queue(); $cron$
);
