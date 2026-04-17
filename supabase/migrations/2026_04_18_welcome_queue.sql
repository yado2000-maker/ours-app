-- 2026-04-18: Welcome-throttle queue to prevent WhatsApp spam-ban.
--
-- Yesterday a viral FB post drove 500+ new 1:1 users in <24h; each triggered
-- an immediate auto-welcome and WhatsApp's anti-spam classifier restricted
-- the bot phone (+972 55 517 5553) for 24h.
--
-- Fix:
--   • New 1:1 users whose first message is actionable get a bundled reply
--     (action + one-line intro) — handled in index.inlined.ts, no queue row.
--   • New 1:1 users whose first message is a greeting/ignore get queued here
--     with 30–90s jitter and a random template (1–3).
--   • A pg_cron job drains the queue every minute, capped at 6 sends per
--     rolling hour, firing Whapi via net.http_post (same pattern as
--     fire_onboarding_nudge).

-- ============================================================================
-- Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.welcome_queue (
  phone_number     TEXT PRIMARY KEY,
  display_name     TEXT,                        -- pre-hebrewized name (nullable)
  queued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for    TIMESTAMPTZ NOT NULL,        -- earliest time to fire
  template_variant SMALLINT NOT NULL CHECK (template_variant BETWEEN 1 AND 3),
  sent_at          TIMESTAMPTZ,                 -- NULL = not yet sent
  attempts         INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS welcome_queue_due_idx
  ON public.welcome_queue (scheduled_for)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS welcome_queue_sent_at_idx
  ON public.welcome_queue (sent_at)
  WHERE sent_at IS NOT NULL;

-- RLS enabled, no policies → service_role only (matches classification_corrections pattern).
ALTER TABLE public.welcome_queue ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Template renderer — 3 variants, each ≤6 lines, on-brand Sheli voice.
-- Uses stored display_name (already hebrewized at enqueue time).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.render_welcome_template(
  p_variant SMALLINT,
  p_display_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_greet TEXT;
BEGIN
  v_greet := CASE WHEN p_display_name IS NOT NULL AND p_display_name <> ''
                  THEN 'היי ' || p_display_name
                  ELSE 'היי' END;

  IF p_variant = 1 THEN
    RETURN v_greet || '! 😊 אני שלי, נעים מאוד.' || E'\n' ||
           'אני יודעת לנהל רשימת קניות, מטלות, הוצאות ותזכורות.' || E'\n\n' ||
           'רוצים לנסות? כתבו לי:' || E'\n' ||
           '"תזכירי לי בעוד שעה לכבות את הדוד" ⏰' || E'\n\n' ||
           'אפשר גם לצרף אותי לקבוצת המשפחה 🏠';
  ELSIF p_variant = 2 THEN
    RETURN v_greet || ' 💚' || E'\n' ||
           'אני שלי — העוזרת החכמה שלך בווטסאפ.' || E'\n\n' ||
           'בואו נתחיל מתזכורת:' || E'\n' ||
           '"תזכירי לי מחר ב-8 להתקשר לסבתא" ⏰' || E'\n\n' ||
           'גם קניות, מטלות והוצאות — הכל כאן 🛒';
  ELSE -- variant 3
    RETURN v_greet || '! שלי כאן 😊' || E'\n' ||
           'אני עוזרת למשפחות לעשות סדר: קניות, מטלות, הוצאות, תזכורות.' || E'\n\n' ||
           'שלחו לי משהו לנסות:' || E'\n' ||
           '"חלב, ביצים, לחם" 🛒' || E'\n' ||
           'או "תזכירי לי בבוקר להוציא בשר" ⏰';
  END IF;
END;
$$;

-- ============================================================================
-- Drain function — invoked by pg_cron every minute.
-- Rate-limit: ≤6 sends per rolling hour across all rows.
-- Picks the oldest due rows first, fires Whapi via net.http_post,
-- sets sent_at optimistically (pg_net is async — failures not auto-retried v1).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.drain_welcome_queue()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row           RECORD;
  v_sent_last_hr  INT;
  v_slots_left    INT;
  v_budget        CONSTANT INT := 6;   -- global cap per rolling hour
  v_msg           TEXT;
  v_count         INT := 0;
  v_req_id        BIGINT;
  v_whapi_token   CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
BEGIN
  SELECT COUNT(*) INTO v_sent_last_hr
  FROM public.welcome_queue
  WHERE sent_at IS NOT NULL
    AND sent_at > NOW() - INTERVAL '1 hour';

  v_slots_left := v_budget - v_sent_last_hr;
  IF v_slots_left <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT phone_number, display_name, template_variant, attempts
    FROM public.welcome_queue
    WHERE sent_at IS NULL
      AND scheduled_for <= NOW()
      AND attempts < 3
    ORDER BY scheduled_for ASC
    LIMIT v_slots_left
    FOR UPDATE SKIP LOCKED
  LOOP
    v_msg := public.render_welcome_template(v_row.template_variant, v_row.display_name);

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

      UPDATE public.welcome_queue
         SET sent_at  = NOW(),
             attempts = attempts + 1
       WHERE phone_number = v_row.phone_number;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Mark attempt even on net.http_post enqueue failure.
      UPDATE public.welcome_queue
         SET attempts = attempts + 1
       WHERE phone_number = v_row.phone_number;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================================
-- Schedule — every minute. Safe to re-run migration (drops + recreates).
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('drain_welcome_queue_every_minute')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain_welcome_queue_every_minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'drain_welcome_queue_every_minute',
  '* * * * *',
  $cron$ SELECT public.drain_welcome_queue(); $cron$
);
