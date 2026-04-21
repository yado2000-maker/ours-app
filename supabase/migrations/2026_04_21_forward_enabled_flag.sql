-- Option 1 Task 11: forward-to-task kill switch.
--
-- Matches the existing bot_settings feature-flag pattern
-- (outbound_paused, nudges_paused, reminders_paused).
--
-- Default: enabled. If we see extraction-accuracy problems or the feature
-- gets abused, disable without a deploy via:
--
--   UPDATE public.bot_settings
--      SET value='false',
--          updated_at=NOW(),
--          updated_by='<ticket or name>'
--    WHERE key='forward_enabled';
--
-- The Edge Function reads this flag in isForwardEnabled() inside the 1:1
-- handler; when 'false', forwarded messages fall through to the normal
-- Sonnet path (acting as if the forward flag was never set).

INSERT INTO public.bot_settings (key, value, updated_by)
VALUES ('forward_enabled', 'true', 'migration:2026_04_21_forward_enabled_flag')
ON CONFLICT (key) DO NOTHING;
