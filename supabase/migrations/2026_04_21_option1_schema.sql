-- Option 1 Cloud API migration — Task 5 (schema primitives).
-- Plan: docs/plans/2026-04-18-option-1-cloud-api-migration-plan.md
--
-- Additive only. No code reads these columns yet; they unblock later tasks:
--   - outbound_queue.template_id/template_variables  → Task 13 (reminder firing via template)
--   - outbound_queue.transport                       → Task 9/10 (CloudApiProvider + selectProvider)
--   - tasks.source / source_message_id               → Task 11 (forward-to-task)
--
-- Speculative index on (transport, ...) is deliberately NOT created here —
-- no reader queries by transport yet, and the recovery-period drain
-- (2026_04_18_drain_outbound_queue_v3) uses `sent_at IS NULL AND attempts<3`
-- semantics (no `status` column). A partial index matching the real drain
-- pattern will land alongside Task 9.

-- outbound_queue: template routing for Cloud API cohort
ALTER TABLE outbound_queue
  ADD COLUMN IF NOT EXISTS template_id TEXT,
  ADD COLUMN IF NOT EXISTS template_variables JSONB,
  ADD COLUMN IF NOT EXISTS transport TEXT DEFAULT 'whapi'
    CHECK (transport IN ('whapi', 'cloud_api'));

-- tasks: source tracking for forward-to-task (Task 11)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chat'
    CHECK (source IN ('chat', 'forward', 'web', 'voice')),
  ADD COLUMN IF NOT EXISTS source_message_id TEXT;
