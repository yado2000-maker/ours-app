-- household_rules — P2 #9 from 2026-05-03 post-mortem.
--
-- Persistence layer for user-described rules like:
--   - "things tagged מבחן → remind me a week before"
--   - "everything else → remind me an hour before"
--   - "always remind me 30 min before doctor appointments"
--
-- Before this table, those rules had nowhere to live. Sheli would say
-- "מעולה, סידרתי!" and store nothing — the silent trust killer #4 from
-- the 2026-05-03 churn. With this table the bot can either insert via a
-- new PENDING_ACTION shape (set_reminder_rule, P2 #10) or read at
-- add_event time to auto-create a reminder (P2 #11).

CREATE TABLE IF NOT EXISTS public.household_rules (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES public.households_v2(id) ON DELETE CASCADE,
  -- 'reminder_default' = applies to all events without a more specific rule.
  -- 'tag_reminder'     = applies to events whose title contains tag_pattern.
  rule_type       TEXT NOT NULL CHECK (rule_type IN ('reminder_default', 'tag_reminder')),
  -- For tag_reminder: substring matched against event title (case-insensitive).
  -- Empty for reminder_default rows.
  tag_pattern     TEXT,
  -- Minutes BEFORE the event's scheduled_for to fire the reminder.
  -- 60 = "1 hour before", 10080 = "1 week before", etc.
  lead_time_minutes INTEGER NOT NULL CHECK (lead_time_minutes >= 0 AND lead_time_minutes <= 525600),
  -- Optional default time-of-day (e.g. "09:00") for events the user adds
  -- without a time. Reserved for future use; the time-honesty fix (P2 #13)
  -- currently asks the user instead.
  default_time    TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT household_rules_tag_pattern_when_tag_rule
    CHECK ((rule_type = 'tag_reminder' AND tag_pattern IS NOT NULL AND tag_pattern <> '')
           OR rule_type = 'reminder_default')
);

CREATE INDEX IF NOT EXISTS household_rules_household_active_idx
  ON public.household_rules(household_id, active)
  WHERE active = TRUE;

-- RLS by default (CLAUDE.md memory: service-role-only tables MUST still
-- ENABLE RLS to satisfy Security Advisor; no policies = service role only).
ALTER TABLE public.household_rules ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.household_rules IS
  'User-described automation rules per household. Read at add_event time to schedule auto-reminders. Inserted via instruct_bot → set_reminder_rule PENDING_ACTION → 👍. P2 #9 from 2026-05-03 post-mortem.';
