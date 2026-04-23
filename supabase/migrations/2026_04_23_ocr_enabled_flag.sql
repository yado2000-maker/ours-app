-- OCR feature kill switch + per-household daily cap.
--
-- Matches the existing bot_settings feature-flag pattern
-- (outbound_paused, nudges_paused, reminders_paused, forward_enabled).
--
-- ocr_enabled:
--   Default: enabled. Disable without a deploy via:
--     UPDATE public.bot_settings
--        SET value='false',
--            updated_at=NOW(),
--            updated_by='<ticket or name>'
--      WHERE key='ocr_enabled';
--   The Edge Function reads this flag in isOcrEnabled() inside the top-level
--   image handler; when 'false', inbound images fall back to skipped_non_text
--   behaviour exactly like before the feature shipped.
--
-- ocr_daily_cap_per_household:
--   Hard cap on successful OCRs per household per rolling 24h window. Guards
--   against pathological image-spam driving Anthropic vision cost up. Default
--   50 (≈ $0.20–0.40/day/household worst case). Adjust via the same pattern.

INSERT INTO public.bot_settings (key, value, updated_by)
VALUES ('ocr_enabled', 'true', 'migration:2026_04_23_ocr_enabled_flag')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.bot_settings (key, value, updated_by)
VALUES ('ocr_daily_cap_per_household', '50', 'migration:2026_04_23_ocr_enabled_flag')
ON CONFLICT (key) DO NOTHING;
