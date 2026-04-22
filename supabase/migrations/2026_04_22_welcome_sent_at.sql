-- Phase 1 of Sheli-in-Groups strategy (plan: brainstorming-about-shelley-in-parsed-cerf.md).
-- Make group welcome delivery exactly-once, ever, per group.
--
-- The duplicate-welcome bug observed in WhatsApp screenshots (2026-04-22) came from
-- two races in index.inlined.ts:handleBotAddedToGroup:
--   1) Whapi group_joined event + first inbound message auto-setup (line ~6861)
--      both re-enter the handler; the second finds existingConfig and unconditionally
--      re-sends INTRO_MESSAGE at line ~5790.
--   2) Any bot_active flip via re-add re-sends intro regardless of prior delivery.
--
-- Fix: atomic claim. Code path uses
--   UPDATE whatsapp_config SET welcome_sent_at = NOW()
--   WHERE group_id = $1 AND welcome_sent_at IS NULL
--   RETURNING group_id
-- to claim the right to send exactly once. 0 rows returned -> already sent, skip.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ NULL;

-- Backfill: existing groups have already received (or missed) their welcome.
-- Mark them all as already-sent so the re-add path never retroactively fires
-- an intro for a group that's been around for weeks. Only rows inserted AFTER
-- this migration will have welcome_sent_at=NULL and be eligible for exactly one send.
UPDATE whatsapp_config
SET welcome_sent_at = NOW()
WHERE welcome_sent_at IS NULL;
