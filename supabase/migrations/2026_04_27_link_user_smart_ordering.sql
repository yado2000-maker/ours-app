-- Bug #3 (Tomer Sagi 2026-04-27 follow-up): link_user_to_household used
-- LIMIT 1 with no ORDER BY in three places (Already-linked check, phone
-- match, created_by match). When a user belongs to multiple households —
-- e.g. a real WhatsApp household + a phantom one created during the
-- broken sign-up flow — Postgres' physical scan order decides which one
-- wins. Tomer's web session was loading his phantom (empty) household
-- "מותק ותומק" instead of the real "עושים סדר" group with 21 shopping
-- items.
--
-- Fix: ORDER BY signals of "real-ness":
--   1. has a paired, active WhatsApp group (whatsapp_config.bot_active)
--   2. has any shopping/tasks/events data
--   3. has any household_members beyond the caller
-- Phantoms (no group, no data, no other members) sort last.
--
-- Behaviorally: a multi-household user lands on the household with the
-- most activity, every time. Single-household users are unchanged.
-- Tomer's phantom was already deleted in DB; this prevents the next
-- caught-by-the-bug user from hitting the same trap.

CREATE OR REPLACE FUNCTION public.link_user_to_household(
  p_phone TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID;
  v_hh_id TEXT;
  v_phone_normalized TEXT;
  v_member_name TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN NULL; END IF;

  -- Already linked? Return the BEST existing household (real-ness ordering
  -- below). Previously this used a bare LIMIT 1 with no ORDER BY, which
  -- returned an arbitrary row — phantoms could win over real households.
  SELECT hm.household_id INTO v_hh_id
  FROM household_members hm
  WHERE hm.user_id = v_uid
  ORDER BY
    EXISTS (
      SELECT 1 FROM whatsapp_config wc
      WHERE wc.household_id = hm.household_id AND wc.bot_active = true
    ) DESC,
    EXISTS (SELECT 1 FROM shopping_items s WHERE s.household_id = hm.household_id) DESC,
    EXISTS (SELECT 1 FROM tasks t WHERE t.household_id = hm.household_id) DESC,
    (SELECT COUNT(*) FROM household_members o WHERE o.household_id = hm.household_id) DESC,
    hm.id  -- deterministic tiebreaker
  LIMIT 1;
  IF v_hh_id IS NOT NULL THEN RETURN v_hh_id; END IF;

  -- Try phone match via whatsapp_member_mapping
  IF p_phone IS NOT NULL AND p_phone != '' THEN
    v_phone_normalized := regexp_replace(p_phone, '\D', '', 'g');
    IF v_phone_normalized LIKE '0%' THEN
      v_phone_normalized := '972' || substr(v_phone_normalized, 2);
    END IF;

    SELECT wmm.household_id, wmm.member_name
    INTO v_hh_id, v_member_name
    FROM whatsapp_member_mapping wmm
    WHERE wmm.phone_number = v_phone_normalized
      AND EXISTS (
        SELECT 1 FROM household_members hm
        WHERE hm.household_id = wmm.household_id
      )
    ORDER BY wmm.created_at DESC NULLS LAST
    LIMIT 1;

    IF v_hh_id IS NOT NULL THEN
      UPDATE household_members
      SET user_id = v_uid
      WHERE household_id = v_hh_id
        AND user_id IS NULL
        AND display_name = v_member_name;

      IF NOT FOUND THEN
        UPDATE household_members
        SET user_id = v_uid
        WHERE household_id = v_hh_id
          AND user_id IS NULL
          AND id = (
            SELECT id FROM household_members
            WHERE household_id = v_hh_id AND user_id IS NULL
            LIMIT 1
          );
      END IF;

      UPDATE whatsapp_member_mapping
      SET user_id = v_uid
      WHERE phone_number = v_phone_normalized AND household_id = v_hh_id;

      RETURN v_hh_id;
    END IF;
  END IF;

  -- Try created_by match — also prefer the real-est one if user created
  -- multiple (the same phantom-vs-real ordering applies here too).
  SELECT id INTO v_hh_id
  FROM households_v2 h
  WHERE h.created_by = v_uid
  ORDER BY
    EXISTS (
      SELECT 1 FROM whatsapp_config wc
      WHERE wc.household_id = h.id AND wc.bot_active = true
    ) DESC,
    EXISTS (SELECT 1 FROM shopping_items s WHERE s.household_id = h.id) DESC,
    EXISTS (SELECT 1 FROM tasks t WHERE t.household_id = h.id) DESC,
    h.created_at DESC NULLS LAST
  LIMIT 1;
  IF v_hh_id IS NOT NULL THEN RETURN v_hh_id; END IF;

  RETURN NULL;
END;
$$;
