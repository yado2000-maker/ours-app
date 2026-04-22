-- Reconciliation v2 (2026-04-22) — cover recurring parents + cascade to children.
-- v1 filtered on sent=false which excluded recurring parents (sent=true is the sentinel
-- for parent rows). v2 removes that filter for the parent upgrade path AND cascades
-- to unsent children whose parent was just upgraded, so existing materialized rows
-- also flip from group-fallback to dm.
CREATE OR REPLACE FUNCTION public.upgrade_group_fallback_reminders(
  p_household_id TEXT, p_member_name TEXT, p_phone TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_upgraded INT := 0;
BEGIN
  -- 1. Upgrade matching parent/one-shot rows tagged with missing_phone_for.
  --    Covers both sent=false one-shots AND sent=true recurring parents.
  WITH upgraded AS (
    UPDATE public.reminder_queue
       SET delivery_mode    = 'dm',
           recipient_phones = ARRAY[p_phone],
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'auto_upgraded_from_group_fallback', true,
             'upgraded_at', NOW())
     WHERE household_id = p_household_id
       AND delivery_mode = 'group'
       AND metadata->>'missing_phone_for' ILIKE '%' || p_member_name || '%'
     RETURNING id
  )
  SELECT count(*) INTO v_upgraded FROM upgraded;

  -- 2. Cascade to unsent children whose parent we just upgraded.
  UPDATE public.reminder_queue c
     SET delivery_mode    = 'dm',
         recipient_phones = ARRAY[p_phone],
         metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
           'auto_upgraded_child_from_parent', true,
           'upgraded_at', NOW())
    FROM public.reminder_queue p
   WHERE c.recurrence_parent_id = p.id
     AND c.sent = false
     AND c.delivery_mode = 'group'
     AND p.household_id = p_household_id
     AND (p.metadata->>'auto_upgraded_from_group_fallback')::boolean = true;

  RETURN v_upgraded;
END;
$$;
