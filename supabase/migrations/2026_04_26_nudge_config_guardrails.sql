-- INSERT-time guardrails on reminder_queue.nudge_config to enforce the
-- anti-spam ceiling Sonnet must explain to the user via SHARED_NUDGE_RULES.
--
-- Three rejections (RAISE EXCEPTION ... USING HINT = '...'):
--   - interval_min < 15      → HINT 'sub_floor_15min'
--   - max_tries  not 1..8    → HINT 'sub_floor_max_tries'
--   - 4th active series in same household → HINT 'too_many_active_series'
--
-- Only fires when nudge_config IS NOT NULL (`WHEN` clause on trigger), so
-- pure-calendar reminder INSERTs are unaffected.
--
-- Active-series cap excludes the row being inserted (id != NEW.id), so
-- inserting the 3rd row in a household with 2 existing actives passes.
--
-- Design: docs/plans/2026-04-26-nudge-reminders-design.md "Anti-Ban Guardrails"
-- Plan: docs/plans/2026-04-26-nudge-reminders-plan.md (Phase 1 Task 1.5)

CREATE OR REPLACE FUNCTION validate_nudge_config()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_interval INT;
  v_max INT;
  v_active_count INT;
BEGIN
  IF NEW.nudge_config IS NULL THEN
    RETURN NEW;
  END IF;

  v_interval := (NEW.nudge_config->>'interval_min')::int;
  v_max := (NEW.nudge_config->>'max_tries')::int;

  IF v_interval IS NULL OR v_interval < 15 THEN
    RAISE EXCEPTION 'nudge_interval_below_floor: interval_min=% must be >= 15', v_interval
      USING HINT = 'sub_floor_15min';
  END IF;

  IF v_max IS NULL OR v_max < 1 OR v_max > 8 THEN
    RAISE EXCEPTION 'nudge_max_tries_out_of_range: max_tries=% must be 1..8', v_max
      USING HINT = 'sub_floor_max_tries';
  END IF;

  -- Cap-check fires on parents (recurrence non-null + no parent ref) and
  -- one-shot anchors (series_status='active'). Attempt children inherit
  -- nothing from this trigger because their nudge_config is NULL — the
  -- WHEN clause on the trigger short-circuits them.
  IF NEW.series_status = 'active'
     OR (NEW.recurrence IS NOT NULL AND NEW.recurrence_parent_id IS NULL) THEN
    SELECT count(*) INTO v_active_count
    FROM reminder_queue
    WHERE household_id = NEW.household_id
      AND series_status = 'active'
      AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    IF v_active_count >= 3 THEN
      RAISE EXCEPTION 'too_many_active_series: household_id=% already has % active series',
        NEW.household_id, v_active_count
        USING HINT = 'too_many_active_series';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_nudge_config_trigger ON reminder_queue;
CREATE TRIGGER validate_nudge_config_trigger
  BEFORE INSERT OR UPDATE OF nudge_config ON reminder_queue
  FOR EACH ROW
  WHEN (NEW.nudge_config IS NOT NULL)
  EXECUTE FUNCTION validate_nudge_config();
