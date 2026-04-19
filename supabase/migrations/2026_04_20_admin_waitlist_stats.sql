-- Admin RPC: waitlist signup analytics
-- Surfaces the recovery-period waitlist in the admin dashboard so we can
-- track landing-page conversion while outbound is paused.

CREATE OR REPLACE FUNCTION public.admin_waitlist_stats(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
  v_since timestamptz := now() - make_interval(days => p_days);
BEGIN
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH totals AS (
    SELECT
      COUNT(*)::int                                       AS total_signups,
      COUNT(*) FILTER (WHERE consent_given)::int          AS with_consent,
      COUNT(*) FILTER (WHERE email IS NOT NULL)::int      AS with_email,
      COUNT(*) FILTER (WHERE invited_at IS NOT NULL)::int AS invited,
      COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS activated,
      MIN(created_at)                                     AS first_signup,
      MAX(created_at)                                     AS latest_signup,
      COUNT(*) FILTER (WHERE created_at >= v_since)::int  AS signups_in_period
    FROM public.waitlist
  ),
  by_source AS (
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS cnt
    FROM public.waitlist
    GROUP BY COALESCE(source, 'unknown')
  ),
  by_interest AS (
    SELECT COALESCE(interest, 'unknown') AS interest, COUNT(*)::int AS cnt
    FROM public.waitlist
    GROUP BY COALESCE(interest, 'unknown')
  ),
  -- Dense daily series so the sparkline doesn't have gaps.
  days AS (
    SELECT generate_series(
      date_trunc('day', v_since),
      date_trunc('day', now()),
      interval '1 day'
    ) AS day
  ),
  daily AS (
    SELECT
      d.day,
      COALESCE(COUNT(w.id), 0)::int AS cnt
    FROM days d
    LEFT JOIN public.waitlist w
      ON date_trunc('day', w.created_at) = d.day
    GROUP BY d.day
    ORDER BY d.day
  )
  SELECT jsonb_build_object(
    'period_days', p_days,
    'totals', (SELECT to_jsonb(totals) FROM totals),
    'by_source', COALESCE(
      (SELECT jsonb_object_agg(source, cnt) FROM by_source),
      '{}'::jsonb
    ),
    'by_interest', COALESCE(
      (SELECT jsonb_object_agg(interest, cnt) FROM by_interest),
      '{}'::jsonb
    ),
    'signups_by_day', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('day', day, 'count', cnt) ORDER BY day) FROM daily),
      '[]'::jsonb
    ),
    'recent', COALESCE(
      (SELECT jsonb_agg(row ORDER BY created_at DESC) FROM (
        SELECT
          jsonb_build_object(
            'created_at', created_at,
            'first_name', first_name,
            'last_name',  last_name,
            'phone',      phone,
            'email',      email,
            'interest',   interest,
            'source',     source,
            'consent_given', consent_given,
            'invited_at', invited_at,
            'activated_at', activated_at
          ) AS row,
          created_at
        FROM public.waitlist
        ORDER BY created_at DESC
        LIMIT 20
      ) r),
      '[]'::jsonb
    )
  ) INTO result;

  RETURN result;
END;
$function$;
