-- Auto-upgrade group-fallback reminders to dm when a new member phone lands
-- (2026-04-22). Matches rows tagged by the MISSING_PHONES handler with
-- metadata.missing_phone_for=<name> and unsent. Returns count for telemetry.
CREATE OR REPLACE FUNCTION public.upgrade_group_fallback_reminders(
  p_household_id TEXT, p_member_name TEXT, p_phone TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_upgraded INT := 0;
BEGIN
  WITH upgraded AS (
    UPDATE public.reminder_queue
       SET delivery_mode    = 'dm',
           recipient_phones = ARRAY[p_phone],
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'auto_upgraded_from_group_fallback', true,
             'upgraded_at', NOW())
     WHERE household_id = p_household_id
       AND sent = false
       AND delivery_mode = 'group'
       AND metadata->>'missing_phone_for' ILIKE '%' || p_member_name || '%'
     RETURNING 1
  )
  SELECT count(*) INTO v_upgraded FROM upgraded;
  RETURN v_upgraded;
END;
$$;
