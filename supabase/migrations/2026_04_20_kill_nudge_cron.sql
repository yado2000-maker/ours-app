-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-04-20 — Kill the onboarding nudge cron (4th outbound path).
--
-- Incident: at 21:00 IST on 2026-04-19, cron job `onboarding-nudge-evening`
-- fired `fire_onboarding_nudge(3, 'ערב טוב 👋')` and sent a proactive message
-- to 4 beta users — DESPITE the existing 3-layer kill switch being fully
-- engaged. The function bypasses the kill switch because:
--   (a) It calls `net.http_post` directly from PG, just like the old
--       fire_due_reminders did.
--   (b) It runs on its OWN pg_cron job — unscheduling drain_outbound_queue
--       doesn't touch it.
--   (c) It never consulted bot_settings.outbound_paused.
--
-- This is the same class of bug as fire_due_reminders before today's
-- reminder drain v2 migration. Same fix pattern:
--   1. Unschedule the 4 nudge cron jobs (idempotent here; live DB already
--      done via cron.unschedule at incident response).
--   2. Rewrite fire_onboarding_nudge() to short-circuit when
--      bot_settings.outbound_paused='true' OR
--      bot_settings.nudges_paused  ='true'.
--   3. Seed bot_settings.nudges_paused='true' so the function stays inert
--      even if outbound_paused is ever flipped to 'false' for Cloud API
--      cutover.
--
-- Defense in depth: the nudge function is now gated by TWO independent
-- flags. Flipping either back to 'true' stops it. Resuming nudges (if we
-- ever want to) requires both flags + a re-scheduled cron — matching the
-- outbound_queue + reminder_queue runbook discipline.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Idempotent unschedule (cron.unschedule errors when the job doesn't exist,
--    so guard with a DO block that swallows undefined_object).
DO $$
DECLARE
  v_job TEXT;
BEGIN
  FOREACH v_job IN ARRAY ARRAY[
    'onboarding-nudge-morning',
    'onboarding-nudge-noon',
    'onboarding-nudge-evening',
    'onboarding-nudge-motzash'
  ]
  LOOP
    BEGIN
      PERFORM cron.unschedule(v_job);
    EXCEPTION WHEN OTHERS THEN
      -- already gone; fine.
      NULL;
    END;
  END LOOP;
END
$$;

-- 2. Kill-switch flag (separate from outbound_paused so nudges can be
--    controlled independently during/after Cloud API migration).
INSERT INTO public.bot_settings(key, value)
VALUES ('nudges_paused', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true';

-- 3. Gate the function itself. If the cron is ever re-scheduled by mistake,
--    the function still refuses to send.
CREATE OR REPLACE FUNCTION public.fire_onboarding_nudge(
  p_nudge_number integer,
  p_greeting     text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_outbound_paused TEXT;
  v_nudges_paused   TEXT;
BEGIN
  SELECT value INTO v_outbound_paused FROM public.bot_settings WHERE key = 'outbound_paused';
  SELECT value INTO v_nudges_paused   FROM public.bot_settings WHERE key = 'nudges_paused';

  -- Defense in depth: either flag set to 'true' blocks the function.
  -- Default to 'true' when a flag is missing — fail closed, never silently fire.
  IF COALESCE(v_outbound_paused, 'true') = 'true' THEN
    RAISE NOTICE 'fire_onboarding_nudge blocked by bot_settings.outbound_paused';
    RETURN 0;
  END IF;
  IF COALESCE(v_nudges_paused, 'true') = 'true' THEN
    RAISE NOTICE 'fire_onboarding_nudge blocked by bot_settings.nudges_paused';
    RETURN 0;
  END IF;

  -- Body of the real implementation was removed as part of the 2026-04-20
  -- kill-switch hardening. If nudges are ever resumed, restore from
  -- git history commit <see this file's commit message> and re-apply
  -- BEHIND the two flags above — do not strip the gates.
  RETURN 0;
END;
$fn$;
