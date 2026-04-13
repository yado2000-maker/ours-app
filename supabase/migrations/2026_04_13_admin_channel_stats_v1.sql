CREATE OR REPLACE FUNCTION public.admin_channel_stats(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
  -- Retention always uses a fixed 7-day window (not p_days) so the % is comparable across periods.
  v_active_cutoff timestamptz := now() - interval '7 days';
BEGIN
  -- Admin gate: identical pattern to existing admin_* RPCs
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH
  -- Classify each household into exactly one of three channels.
  classified AS (
    SELECT
      h.id AS household_id,
      EXISTS(
        SELECT 1 FROM whatsapp_config wc
        WHERE wc.household_id = h.id AND wc.group_id LIKE '%@g.us'
      ) AS has_group,
      EXISTS(
        SELECT 1 FROM onboarding_conversations oc
        WHERE oc.household_id = h.id
      ) AS has_personal
    FROM households_v2 h
  ),
  channel AS (
    SELECT
      household_id,
      CASE
        WHEN has_group AND has_personal THEN 'both'
        WHEN has_group AND NOT has_personal THEN 'group_only'
        WHEN has_personal AND NOT has_group THEN 'personal_only'
        ELSE 'unclassified'
      END AS channel
    FROM classified
  ),
  active_hh AS (
    SELECT DISTINCT household_id FROM (
      SELECT household_id FROM whatsapp_messages WHERE created_at >= v_active_cutoff
      UNION ALL
      SELECT household_id FROM web_sessions WHERE created_at >= v_active_cutoff AND household_id IS NOT NULL
    ) u
  ),
  channel_agg AS (
    SELECT
      channel,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE household_id IN (SELECT household_id FROM active_hh)) AS active_7d
    FROM channel
    WHERE channel <> 'unclassified'
    GROUP BY channel
  ),
  funnel AS (
    SELECT state, COUNT(*) AS cnt
    FROM onboarding_conversations
    GROUP BY state
  ),
  nudge AS (
    SELECT
      COUNT(*) FILTER (WHERE oc.context ? 'group_nudge_sent_at') AS nudged,
      COUNT(*) FILTER (
        WHERE oc.context ? 'group_nudge_sent_at'
          AND EXISTS (
            SELECT 1 FROM whatsapp_config wc
            WHERE wc.household_id = oc.household_id AND wc.group_id LIKE '%@g.us'
          )
      ) AS added_group
    FROM onboarding_conversations oc
  )
  SELECT jsonb_build_object(
    'period_days', p_days,
    'channels', jsonb_build_object(
      'personal_only', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='personal_only'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='personal_only'), 0)
      ),
      'group_only', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='group_only'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='group_only'), 0)
      ),
      'both', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='both'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='both'), 0)
      )
    ),
    'funnel_counts', COALESCE(
      (SELECT jsonb_object_agg(state, jsonb_build_object('count', cnt)) FROM funnel),
      '{}'::jsonb
    ),
    'group_nudge', (
      SELECT jsonb_build_object(
        'nudged', nudged,
        'added_group', added_group,
        'conversion_pct',
          CASE WHEN nudged = 0 THEN 0
               ELSE ROUND((added_group::numeric / nudged) * 100, 1)
          END
      ) FROM nudge
    ),
    'retention_by_channel', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'channel', channel,
        'total', total,
        'active_7d', active_7d,
        'pct', CASE WHEN total = 0 THEN 0
                    ELSE ROUND((active_7d::numeric / total) * 100, 1)
               END
      ) ORDER BY channel) FROM channel_agg),
      '[]'::jsonb
    )
  ) INTO result;

  RETURN result;
END;
$function$;

-- Supporting index: classified/nudge CTEs do EXISTS lookups keyed on household_id.
-- Invisible at 22 rows, prevents seq scans as the table grows.
CREATE INDEX IF NOT EXISTS idx_onboarding_household ON onboarding_conversations(household_id);
