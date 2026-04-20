-- Fix: CHECK constraint on onboarding_conversations.state did not include
-- 'waitlist_redirected' or 'welcome_queued', so every handleDirectMessage
-- waitlist_redirect path insert at line ~4213 was failing silently with a
-- constraint violation. The code does `.insert()` without checking the
-- error return, so the failure was invisible.
--
-- Consequence: new users hit the !convo branch, got the full waitlistBody
-- text, no row was persisted, and every subsequent message from them re-fired
-- the full waitlistBody (because convo stayed null forever). Reaching the
-- re-ping branch at line 4234 (shorter "שמרתי לך מקום..." text) was impossible.
--
-- Found 2026-04-20 when debugging "returning users see the automatic reply
-- on every message" — 4 of 5 recent dm_waitlist_new users had no
-- onboarding_conversations row despite a whatsapp_messages entry. Applied
-- as migration 2026_04_20_fix_onboarding_state_check. Also backfilled the 5
-- orphaned phones with reconstructed rows so they don't hit waitlistBody again.

ALTER TABLE public.onboarding_conversations
  DROP CONSTRAINT onboarding_conversations_state_check;

ALTER TABLE public.onboarding_conversations
  ADD CONSTRAINT onboarding_conversations_state_check
  CHECK (state = ANY (ARRAY[
    'welcomed','chatting','sleeping','nudging','invited','joined',
    'personal','dormant','welcome','trying','waiting','onboarded',
    'active','waitlist_redirected','welcome_queued'
  ]));
