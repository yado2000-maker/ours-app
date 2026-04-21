-- Option 1 Cloud API migration — Task 14 (DDL portion only).
-- Plan: docs/plans/2026-04-18-option-1-cloud-api-migration-plan.md
--
-- Adds migration_cohort to households_v2 so we can phase the Whapi → Cloud API
-- cutover per-household without a big-bang switchover.
--
-- Additive only. DEFAULT 'whapi' means every existing row and every new row
-- keeps the current transport until an operator explicitly flips them via:
--   UPDATE households_v2 SET migration_cohort = 'cloud_api' WHERE id = '<hh_id>';
--
-- The code-side `selectProvider()` that reads this column is INTENTIONALLY
-- deferred to Task 9 (CloudApiProvider). Shipping the reader before the
-- provider exists would be churn: the only branch it could take is 'whapi',
-- which is what's already hardcoded today. The column stands by itself here
-- as a zero-cost unlock for the Cloud API work.

ALTER TABLE households_v2
  ADD COLUMN IF NOT EXISTS migration_cohort TEXT DEFAULT 'whapi'
    CHECK (migration_cohort IN ('whapi', 'cloud_api'));

CREATE INDEX IF NOT EXISTS households_migration_cohort_idx
  ON households_v2 (migration_cohort);
