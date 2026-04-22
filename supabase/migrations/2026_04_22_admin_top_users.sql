-- Admin RPC: top-performing users by action count
-- Surfaces the most active individuals (not households) in the admin dashboard
-- so we can spot power-users, early evangelists, and people worth interviewing.
--
-- "Action" = a user message whose classifier intent is actionable
-- (add_* / complete_* / claim_task / add_expense / correct_bot / save_memory).
-- `ignore`, `question`, `info_request`, `recall_memory` do not count —
-- they're chat, not DB mutations.
--
-- Sender phones matching the bot or the human operator are excluded so the
-- list only shows real end-users.

CREATE OR REPLACE FUNCTION public.admin_top_users(
  p_days  integer DEFAULT 7,
  p_limit integer DEFAULT 20
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
  v_since timestamptz := now() - make_interval(days => p_days);
  v_bot_phones text[] := ARRAY['972555175553', '972525937316'];
  v_action_intents text[] := ARRAY[
    'add_task','add_shopping','add_event','add_reminder',
    'complete_task','complete_shopping','claim_task',
    'add_expense','save_memory','delete_memory','correct_bot'
  ];
BEGIN
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH user_msgs AS (
    SELECT
      wm.sender_phone,
      wm.household_id,
      wm.classification,
      wm.classification_data,
      wm.created_at
    FROM whatsapp_messages wm
    WHERE wm.created_at >= v_since
      AND wm.sender_phone IS NOT NULL
      AND wm.sender_phone <> ALL (v_bot_phones)
      AND wm.household_id IS NOT NULL
      AND wm.household_id <> 'unknown'
  ),
  aggregated AS (
    SELECT
      sender_phone,
      household_id,
      COUNT(*) FILTER (
        WHERE classification_data->>'intent' = ANY (v_action_intents)
      )::int AS actions,
      COUNT(*)::int AS total_messages,
      MAX(created_at) AS last_active
    FROM user_msgs
    GROUP BY sender_phone, household_id
  ),
  -- One row per (phone, household) collapsed to one row per phone:
  -- sum across households for a user who appears in multiple groups.
  per_phone AS (
    SELECT
      sender_phone,
      SUM(actions)::int           AS actions,
      SUM(total_messages)::int    AS total_messages,
      MAX(last_active)             AS last_active,
      (array_agg(household_id ORDER BY actions DESC))[1] AS top_household_id
    FROM aggregated
    GROUP BY sender_phone
    HAVING SUM(actions) > 0
  ),
  ranked AS (
    SELECT
      p.sender_phone,
      p.actions,
      p.total_messages,
      p.last_active,
      p.top_household_id,
      COALESCE(
        (SELECT wmm.member_name
           FROM whatsapp_member_mapping wmm
          WHERE wmm.phone_number = p.sender_phone
            AND wmm.member_name IS NOT NULL
          ORDER BY CASE WHEN wmm.household_id = p.top_household_id THEN 0 ELSE 1 END
          LIMIT 1),
        '—'
      ) AS member_name,
      (SELECT h.name FROM households_v2 h WHERE h.id = p.top_household_id) AS household_name
    FROM per_phone p
    ORDER BY p.actions DESC, p.last_active DESC
    LIMIT GREATEST(p_limit, 1)
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'phone',          LEFT(sender_phone, 6) || '****',
        'member_name',    member_name,
        'household_name', household_name,
        'household_id',   top_household_id,
        'actions',        actions,
        'total_messages', total_messages,
        'last_active',    last_active
      )
      ORDER BY actions DESC, last_active DESC
    ),
    '[]'::jsonb
  ) INTO result
  FROM ranked;

  RETURN jsonb_build_object(
    'users', result,
    'period_days', p_days,
    'limit', p_limit
  );
END;
$function$;
