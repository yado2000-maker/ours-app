-- Tier 2.0 of the list-display recovery + free-form tags plan.
-- Additive only. Backfill of [עבודה]/[בית] prefix titles is intentionally
-- deferred to a follow-up one-shot SQL once Tier 2 has been live a few days.
-- See docs/plans/2026-04-25-list-display-and-free-form-tags-plan.md.

ALTER TABLE tasks          ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE events         ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS tasks_tags_idx          ON tasks          USING GIN (tags);
CREATE INDEX IF NOT EXISTS shopping_items_tags_idx ON shopping_items USING GIN (tags);
CREATE INDEX IF NOT EXISTS events_tags_idx         ON events         USING GIN (tags);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;
CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks (household_id, due_date)
  WHERE due_date IS NOT NULL;
