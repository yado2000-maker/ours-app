-- Phase 4 of Sheli-in-Groups: bidirectional learning.
-- Formalize the set of allowed pattern_type values as a CHECK constraint,
-- adding the two new types required by Phase 4:
--   living_layer_trigger  — phrases the family corrected Sheli on (be quieter next time)
--   invitation_accepted   — visits Sheli was invited to that went well (ok to visit again)
--
-- Existing types inferred from code + live data as of 2026-04-22:
--   nickname, compound_name, back_off, category_pref
-- No DROP needed: the column was previously unconstrained.
ALTER TABLE household_patterns
  ADD CONSTRAINT household_patterns_pattern_type_check
  CHECK (pattern_type IN (
    'nickname',
    'compound_name',
    'back_off',
    'category_pref',
    'living_layer_trigger',
    'invitation_accepted'
  ));
