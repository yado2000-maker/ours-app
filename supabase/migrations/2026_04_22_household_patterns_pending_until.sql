-- Phase 4 of Sheli-in-Groups: support optimistic "invitation_accepted" logging.
-- A pattern row is written with pending_until = NOW() + 10 min when Sheli visits
-- a living-layer moment (Phase 5 will add the real call site). If the family
-- corrects Sheli within 10 min, the correction handler DELETEs the row — not
-- accepted after all. Otherwise the row stands and becomes a permanent signal
-- to the classifier ("this family is OK with you visiting similar moments").
ALTER TABLE household_patterns
  ADD COLUMN IF NOT EXISTS pending_until TIMESTAMPTZ NULL;
