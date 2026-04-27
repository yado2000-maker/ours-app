-- notify_expired_nudge_series() — DM the requester when a series flips to
-- expired_tries / expired_deadline. Cron every 5 min. Idempotent via
-- metadata.expiry_notified breadcrumb. Sends through outbound_queue with
-- new message_type='nudge_expiry' so admin queries can separate them
-- from welcomes/recoveries.
--
-- Two CHECK constraints had to be updated together:
--   - outbound_queue_message_type_check (the simple enum)
--   - render_shape (the conditional shape constraint)
-- Both now allow 'nudge_expiry' with the same shape as 'recovery'
-- (phone_number + body). The original outbound_queue_render_shape (a
-- duplicate left from the welcome_queue → outbound_queue rename in
-- 2026-04-18) is dropped here so only the unified render_shape remains.
--
-- Body uses '/ה' slash-form on past-tense verbs because the series
-- requester is the parent and the target may be male or female (a
-- 3rd-person reference). This is one of the documented exceptions to
-- the SHARED_HEBREW_GRAMMAR ban on slash-forms (TODO in CLAUDE.md
-- tracks rewriting these as full-sentence variants by display_name
-- gender heuristic). Acceptable for v1.
--
-- The DM goes through the outbound_queue drain (rate-limited 10/hr)
-- so an expiry wave can't burst the bot's anti-spam ceiling. Bot
-- kill-switch (bot_settings.outbound_paused) gates it for free.
--
-- Plan: docs/plans/2026-04-26-nudge-reminders-plan.md (Phase 3 Task 3.4)

ALTER TABLE outbound_queue DROP CONSTRAINT IF EXISTS render_shape;
ALTER TABLE outbound_queue DROP CONSTRAINT IF EXISTS outbound_queue_render_shape;
ALTER TABLE outbound_queue ADD CONSTRAINT render_shape CHECK (
  (message_type = 'welcome'        AND template_variant IS NOT NULL AND phone_number IS NOT NULL) OR
  (message_type = 'recovery'       AND body IS NOT NULL             AND phone_number IS NOT NULL) OR
  (message_type = 'recovery_group' AND body IS NOT NULL             AND chat_id      IS NOT NULL) OR
  (message_type = 'nudge_expiry'   AND body IS NOT NULL             AND phone_number IS NOT NULL)
);

ALTER TABLE outbound_queue DROP CONSTRAINT IF EXISTS outbound_queue_message_type_check;
ALTER TABLE outbound_queue ADD CONSTRAINT outbound_queue_message_type_check CHECK (
  message_type = ANY (ARRAY['welcome'::text, 'recovery'::text, 'recovery_group'::text, 'nudge_expiry'::text])
);

CREATE OR REPLACE FUNCTION notify_expired_nudge_series()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_row RECORD;
  v_count INT := 0;
  v_target_name TEXT;
  v_completion TEXT;
  v_body TEXT;
BEGIN
  FOR v_row IN
    SELECT id, household_id, created_by_phone, nudge_config, series_status, metadata
    FROM reminder_queue
    WHERE series_status IN ('expired_tries', 'expired_deadline')
      AND nudge_config IS NOT NULL
      AND created_by_phone IS NOT NULL
      AND (metadata->>'expiry_notified') IS NULL
    LIMIT 50
  LOOP
    v_target_name := COALESCE(v_row.nudge_config->>'target_name', '');
    v_completion := COALESCE(v_row.nudge_config->>'prompt_completion', '');

    IF v_row.series_status = 'expired_tries' THEN
      v_body := format('%s לא אישר/ה את "%s" אחרי %s תזכורות. להזכיר שוב מחר?',
        v_target_name, v_completion, COALESCE(v_row.nudge_config->>'max_tries', '6'));
    ELSE  -- expired_deadline
      v_body := format('%s לא אישר/ה את "%s" עד הדדליין (%s). להזכיר שוב מחר?',
        v_target_name, v_completion, COALESCE(v_row.nudge_config->>'deadline_time_il', '?'));
    END IF;

    INSERT INTO outbound_queue (
      phone_number, household_id, body, message_type, scheduled_for, queued_at, metadata
    ) VALUES (
      v_row.created_by_phone, v_row.household_id, v_body, 'nudge_expiry',
      NOW(), NOW(),
      jsonb_build_object(
        'source', 'nudge_expiry',
        'series_id', v_row.id,
        'series_status', v_row.series_status,
        'target_name', v_target_name
      )
    );

    UPDATE reminder_queue
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'expiry_notified', NOW(),
          'expiry_notified_to', v_row.created_by_phone
        )
    WHERE id = v_row.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Cron: every 5 min. Cheap (one indexed scan via reminder_queue_active_series_idx
-- — well, actually scans for expired_tries / expired_deadline rows which aren't
-- in the partial index; could add a separate partial index later if the
-- terminal-state row count grows).
SELECT cron.schedule(
  'notify_expired_nudge_series',
  '*/5 * * * *',
  $$SELECT notify_expired_nudge_series()$$
);
