-- Adds nudge-series columns to reminder_queue.
-- See docs/plans/2026-04-26-nudge-reminders-design.md.
-- Applied via MCP apply_migration on 2026-04-27.

ALTER TABLE reminder_queue
  ADD COLUMN IF NOT EXISTS nudge_config JSONB,
  ADD COLUMN IF NOT EXISTS nudge_series_id UUID,
  ADD COLUMN IF NOT EXISTS nudge_attempt INT,
  ADD COLUMN IF NOT EXISTS series_status TEXT
    CHECK (series_status IN ('active','acked','expired_tries','expired_deadline','superseded'));

CREATE INDEX IF NOT EXISTS reminder_queue_active_series_idx
  ON reminder_queue (household_id, series_status)
  WHERE series_status = 'active';

CREATE INDEX IF NOT EXISTS reminder_queue_series_member_idx
  ON reminder_queue (nudge_series_id, nudge_attempt)
  WHERE nudge_series_id IS NOT NULL;

COMMENT ON COLUMN reminder_queue.nudge_config IS
  'Nudge series config: {interval_min, max_tries, deadline_time_il, channel, target_phone, target_name, prompt_completion}. NULL for non-nudge rows.';
COMMENT ON COLUMN reminder_queue.series_status IS
  'Lifecycle of nudge series: active|acked|expired_tries|expired_deadline|superseded. NULL for non-nudge rows.';
