-- Bug #2 (Tomer Sagi 2026-04-27): web app sign-up fails for users who came in
-- via a non-phone auth provider (Google OAuth → auth.users.phone IS NULL).
--
-- Failure flow:
--   1. User signs in with Google → auth.users row created, phone=null.
--   2. detectHousehold() calls link_user_to_household(p_phone, p_email).
--      That RPC only links via PHONE → returns NULL for Google-only users.
--   3. User reaches JoinOrCreate, enters their household code → picker.
--   4. RLS on household_members hides existing rows because the user is not
--      yet a member. Picker fallback renders the "type your name" form.
--   5. The form INSERTs {user_id: auth.uid()} with role=founder. Even when
--      this succeeds it creates a DUPLICATE member row alongside the bot's
--      original (user_id=NULL) row. When it fails (subtle RLS edge cases on
--      stale sessions) the user sees "שמירת השם נכשלה" and is stuck.
--
-- This RPC unifies the linking path: if there is an unlinked member matching
-- the user's chosen display_name (case-insensitive), claim that row by
-- setting user_id = auth.uid(). Otherwise create a new member row. Either
-- way the auth user ends up linked to exactly ONE row, with no duplicates.
-- Also updates whatsapp_member_mapping so future inbound mapping lookups
-- carry the user_id.
--
-- SECURITY DEFINER: bypasses the household_members RLS that blocks
-- non-members from seeing siblings, while still requiring an authenticated
-- caller (auth.uid() must be set). The household_id is validated against
-- households_v2 to prevent claiming arbitrary IDs.

CREATE OR REPLACE FUNCTION public.claim_household_member(
  p_household_id TEXT,
  p_display_name TEXT
)
RETURNS TABLE(member_id UUID, claimed_existing BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID;
  v_existing_id UUID;
  v_new_id UUID;
  v_name TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  v_name := trim(coalesce(p_display_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'display_name required' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'display_name too long' USING ERRCODE = '22023';
  END IF;

  -- Validate the household exists. Without this guard a caller could claim
  -- ownership of a NEW (made-up) household_id.
  IF NOT EXISTS (SELECT 1 FROM households_v2 WHERE id = p_household_id) THEN
    RAISE EXCEPTION 'household not found' USING ERRCODE = '23503';
  END IF;

  -- Already linked in this household? Return that row idempotently.
  SELECT id INTO v_existing_id
  FROM household_members
  WHERE household_id = p_household_id AND user_id = v_uid
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, true;
    RETURN;
  END IF;

  -- Try to claim an unlinked member with matching name (case-insensitive).
  -- This is the common path for Google-OAuth users whose WhatsApp mapping
  -- already created a member row with user_id=NULL.
  UPDATE household_members
  SET user_id = v_uid
  WHERE id = (
    SELECT id FROM household_members
    WHERE household_id = p_household_id
      AND user_id IS NULL
      AND lower(display_name) = lower(v_name)
    ORDER BY id
    LIMIT 1
  )
  RETURNING id INTO v_existing_id;

  IF v_existing_id IS NOT NULL THEN
    -- Also link the WhatsApp mapping if one exists with the same display_name
    -- (case-insensitive). Best effort; safe if no row matches.
    UPDATE whatsapp_member_mapping
    SET user_id = v_uid
    WHERE household_id = p_household_id
      AND lower(member_name) = lower(v_name)
      AND user_id IS NULL;
    RETURN QUERY SELECT v_existing_id, true;
    RETURN;
  END IF;

  -- No matching unlinked row → create a fresh founder member.
  INSERT INTO household_members (household_id, display_name, role, user_id)
  VALUES (p_household_id, v_name, 'founder', v_uid)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_household_member(TEXT, TEXT) TO authenticated;

-- Also extend link_user_to_household so a Google-OAuth user (no phone) who
-- already has an unlinked member row can find it via name match against
-- whatsapp_member_mapping by member_name. Cheap pass — only runs when
-- p_phone is empty (otherwise the existing phone path already handles it).
-- Disabled for now: requires reliable name extraction from the auth user
-- which we don't have without explicit user input. The picker flow + the
-- claim_household_member RPC above cover the immediate need.
