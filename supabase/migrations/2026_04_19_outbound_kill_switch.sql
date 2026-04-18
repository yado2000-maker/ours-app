-- Database-level kill switch for outbound messaging, added 2026-04-19
-- after the 2026-04-18 double-ban.
--
-- Context: `drain_outbound_queue()` sends to Whapi via `net.http_post` from
-- Postgres, bypassing the Edge Function's BOT_SILENT_MODE guard. Before this
-- migration, the only thing keeping the drain quiet during ban recovery was
-- an out-of-band `cron.unschedule()` — trivially undone by re-applying a
-- migration, by a Supabase maintenance event, or by a future engineer who
-- assumes the cron "should" be scheduled.
--
-- This migration adds a `bot_settings` runtime-flags table with a single
-- `outbound_paused` key, defaulting to 'true'. The drain function checks the
-- flag first and returns 0 if paused. Even if the cron is re-scheduled,
-- nothing fires until a human explicitly runs:
--
--   UPDATE public.bot_settings
--      SET value='false',
--          updated_at=NOW(),
--          updated_by='<your name or ticket>'
--    WHERE key='outbound_paused';
--
-- Recovery runbook:
--   1. Verify 24h restriction lifted (Whapi /health returns AUTH after re-pair).
--   2. Audit pending queue: SELECT id, phone_number, message_type, queued_at,
--      left(body, 60) FROM outbound_queue WHERE sent_at IS NULL AND attempts < 3;
--   3. Supersede anything older than 23h30m or stale:
--      UPDATE outbound_queue SET attempts=99,
--             metadata=COALESCE(metadata,'{}'::jsonb)||'{"superseded_reason":"pre_resume_manual_sweep"}'::jsonb
--       WHERE sent_at IS NULL AND (NOW() - queued_at) > INTERVAL '23 hours 30 minutes';
--   4. Flip BOT_SILENT_MODE=false in Edge Function secrets.
--   5. Flip the flag above.
--   6. Re-schedule the cron:
--      SELECT cron.schedule('drain_outbound_queue_every_minute', '* * * * *',
--                           $$ SELECT public.drain_outbound_queue(); $$);
--   7. Monitor the first 10 sends for 30 minutes before walking away.

-- ============================================================================
-- 1. bot_settings table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bot_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  TEXT
);

COMMENT ON TABLE public.bot_settings IS
  'Runtime feature flags for the WhatsApp bot. Keys so far: outbound_paused.';

-- Default: paused. Explicit human act required to resume.
INSERT INTO public.bot_settings (key, value, updated_by)
VALUES ('outbound_paused', 'true', 'migration:2026_04_19_outbound_kill_switch')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. Rename existing drain function and wrap it with a guard
-- ============================================================================
-- The existing function (from 2026_04_18_drain_outbound_queue_v3.sql) is
-- renamed to _inner. A new public.drain_outbound_queue() is created that
-- reads the pause flag and delegates. The cron schedule string calls
-- drain_outbound_queue() by name, so this is transparent to the cron.

DO $$
BEGIN
  -- Rename only if the _inner version does not already exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'drain_outbound_queue_inner'
       AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE 'ALTER FUNCTION public.drain_outbound_queue() RENAME TO drain_outbound_queue_inner';
  END IF;
END $$;

-- Guarded wrapper. This is what the cron now calls.
CREATE OR REPLACE FUNCTION public.drain_outbound_queue()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_paused TEXT;
BEGIN
  SELECT value INTO v_paused FROM public.bot_settings WHERE key = 'outbound_paused';

  -- COALESCE to 'true' so a missing row also means paused (fail safe).
  IF COALESCE(v_paused, 'true') = 'true' THEN
    RETURN 0;
  END IF;

  RETURN public.drain_outbound_queue_inner();
END;
$function$;

-- ============================================================================
-- 3. Belt-and-suspenders: unschedule known outbound crons at migration time.
-- ============================================================================
-- These should already be unscheduled per the 2026-04-18 live ops actions,
-- but re-applying the migration idempotently shouldn't re-schedule them.

DO $$
BEGIN
  PERFORM cron.unschedule('drain_outbound_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_outbound_queue_every_minute');
  PERFORM cron.unschedule('drain_welcome_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_welcome_queue_every_minute');
  PERFORM cron.unschedule('fire_reminders_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fire_reminders_every_minute');
  PERFORM cron.unschedule('fire-reminders')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fire-reminders');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
