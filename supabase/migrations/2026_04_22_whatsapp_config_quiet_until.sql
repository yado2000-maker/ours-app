-- Phase 3 of Sheli-in-Groups: per-group cool-down after correction.
-- No new table — piggyback on whatsapp_config (one row per group anyway).
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS quiet_until TIMESTAMPTZ NULL;

-- Index only rows that are currently quiet (tiny, fast).
CREATE INDEX IF NOT EXISTS whatsapp_config_quiet_until_idx
  ON whatsapp_config (quiet_until)
  WHERE quiet_until IS NOT NULL;
