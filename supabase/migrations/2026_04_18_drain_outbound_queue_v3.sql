-- Drain function hardened 2026-04-18 after a day of live-incident iteration.
-- Supersedes the initial drain defined in 2026_04_18_welcome_queue.sql.
--
-- Evolution today (applied via Supabase apply_migration, consolidated here):
--   1. drain_outbound_queue_dedup_guard_2026_04_18     — skip if bot replied in target chat in 24h
--   2. drain_outbound_queue_welcome_priority_2026_04_18 — cap 6→10, welcomes first, 24h window skip, body preference
--   3. drain_outbound_queue_cross_channel_dedup_2026_04_18 — dedup across user's 1:1 AND household groups
--   4. drain_outbound_queue_operator_phones_2026_04_18  — match operator phones (bot + Yaron personal) not just bot
--
-- Why v3 matters in production:
-- - Welcomes now drain priority 0 (ahead of recovery) so real-time new-user greetings
--   aren't stranded behind recovery backlog for 33+ hours (original ordering was inverted).
-- - 10/hr cap replaces 6/hr. Safely spread: 1 message every ~6 min looks conversational;
--   still well below the ~50-in-minutes burst that triggered the 2026-04-17 ban.
-- - Cross-channel operator dedup: when an operator replies to the user in a household
--   group (not the 1:1 the recovery targets), the row is now correctly marked superseded.
--   Prevents the "Sheli sends recovery DM about a topic already resolved in the group"
--   pattern observed 2026-04-18 with user נעמי.
-- - 24h customer-care-window-expiry skip: welcomes queued >23h30m ago are marked superseded
--   rather than sending a stale reply that would count as proactive outreach.
-- - Body preference: prefers outbound_queue.body (populated with unique Sonnet-generated
--   welcome at queue time by handleDirectMessage) over the 3-variant SQL template. Reduces
--   text-similarity signal — every welcome has distinct wording.
--
-- Open follow-ups (for future migrations):
-- - v_whapi_token and v_operator_phones are hardcoded. Move to a settings table or
--   Supabase Vault secret. Token rotation is a separate security item.
-- - Plan-time dedup in scripts/plan_recovery_messages.py (don't queue rows for users
--   you've already reached in a group). Belt to the drain-time suspenders here.

CREATE OR REPLACE FUNCTION public.drain_outbound_queue()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_row             RECORD;
  v_sent_last_hr    INT;
  v_slots_left      INT;
  v_budget          CONSTANT INT      := 10;
  v_window_edge     CONSTANT INTERVAL := INTERVAL '23 hours 30 minutes';
  v_msg             TEXT;
  v_to              TEXT;
  v_count           INT := 0;
  v_req_id          BIGINT;
  v_recent_ops      INT;
  v_bot_phone       CONSTANT TEXT := '972555175553';
  v_operator_phones CONSTANT TEXT[] := ARRAY[
    '972555175553',  -- bot phone (sendAndLog + WhatsApp Web manual replies)
    '972525937316'   -- Yaron's personal phone (replies from his own WhatsApp in household groups)
  ];
  v_meta_household  TEXT;
  v_whapi_token     CONSTANT TEXT := 'aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m';
BEGIN
  SELECT COUNT(*) INTO v_sent_last_hr
  FROM public.outbound_queue
  WHERE sent_at IS NOT NULL
    AND sent_at > NOW() - INTERVAL '1 hour';

  v_slots_left := v_budget - v_sent_last_hr;
  IF v_slots_left <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT id, phone_number, chat_id, display_name, template_variant,
           body, message_type, attempts, queued_at, metadata
    FROM public.outbound_queue
    WHERE sent_at IS NULL
      AND scheduled_for <= NOW()
      AND attempts < 3
    ORDER BY
      CASE message_type
        WHEN 'welcome'        THEN 0  -- real-time new users first (24h-window sensitive)
        WHEN 'recovery'       THEN 1  -- 1:1 ban-recovery
        WHEN 'recovery_group' THEN 2  -- group ban-recovery
        ELSE                       3
      END,
      queued_at ASC                   -- within type, oldest first (closest to window expiry)
    LIMIT v_slots_left
    FOR UPDATE SKIP LOCKED
  LOOP
    v_to := COALESCE(v_row.chat_id, v_row.phone_number || '@s.whatsapp.net');
    v_meta_household := v_row.metadata->>'household_id';

    -- 24hr customer-care-window expiry: don't turn a reply into a proactive outreach
    IF v_row.message_type = 'welcome'
       AND (NOW() - v_row.queued_at) > v_window_edge THEN
      UPDATE public.outbound_queue
         SET attempts = 99,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'superseded_at', NOW(),
               'superseded_reason', '24h_customer_care_window_expired'
             )
       WHERE id = v_row.id;
      CONTINUE;
    END IF;

    -- Cross-channel operator dedup:
    -- Skip if any operator (bot or Yaron) replied in ANY chat the target participates in
    -- within the last 24h — 1:1 OR the household group derived from recovery metadata
    -- OR groups of any household the target is mapped to via whatsapp_member_mapping.
    SELECT COUNT(*) INTO v_recent_ops
    FROM public.whatsapp_messages wm
    WHERE wm.sender_phone = ANY(v_operator_phones)
      AND wm.created_at > NOW() - INTERVAL '24 hours'
      AND wm.group_id IN (
        -- 1:1 chat with target
        SELECT v_row.phone_number || '@s.whatsapp.net'
        UNION
        -- Household group from recovery metadata (primary path — planner sets this)
        SELECT wc.group_id
        FROM public.whatsapp_config wc
        WHERE v_meta_household IS NOT NULL
          AND wc.household_id = v_meta_household
          AND wc.group_id IS NOT NULL
        UNION
        -- Groups of households the target is mapped to (belt-and-suspenders)
        SELECT wc.group_id
        FROM public.whatsapp_member_mapping wmm
        JOIN public.whatsapp_config wc ON wc.household_id = wmm.household_id
        WHERE wmm.phone_number = v_row.phone_number
          AND wc.group_id IS NOT NULL
      );

    IF v_recent_ops > 0 THEN
      UPDATE public.outbound_queue
         SET attempts = 99,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'superseded_at', NOW(),
               'superseded_reason', 'operator already engaged this user (cross-channel) within 24h'
             )
       WHERE id = v_row.id;
      CONTINUE;
    END IF;

    -- Body preference: custom (Sonnet-generated) > SQL template fallback
    IF v_row.body IS NOT NULL AND length(trim(v_row.body)) > 0 THEN
      v_msg := v_row.body;
    ELSIF v_row.message_type = 'welcome' THEN
      v_msg := public.render_welcome_template(v_row.template_variant, v_row.display_name);
    ELSE
      v_msg := v_row.body;
    END IF;

    IF v_msg IS NULL OR length(trim(v_msg)) = 0 OR v_to IS NULL THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE id = v_row.id;
      CONTINUE;
    END IF;

    BEGIN
      SELECT net.http_post(
        url     := 'https://gate.whapi.cloud/messages/text',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_whapi_token,
          'Content-Type',  'application/json'
        ),
        body    := jsonb_build_object(
          'to',   v_to,
          'body', v_msg
        )
      ) INTO v_req_id;

      UPDATE public.outbound_queue
         SET sent_at  = NOW(),
             attempts = attempts + 1
       WHERE id = v_row.id;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.outbound_queue
         SET attempts = attempts + 1
       WHERE id = v_row.id;
    END;
  END LOOP;

  RETURN v_count;
END;
$function$;
