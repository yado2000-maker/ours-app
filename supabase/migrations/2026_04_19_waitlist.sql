-- Waitlist for recovery period: people we diverted from WhatsApp
-- (via landing page CTA swap + Business App Away Message) get captured
-- here instead of piling up in the bot's 1:1 inbox.

CREATE TABLE IF NOT EXISTS public.waitlist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    TEXT,
  phone         TEXT NOT NULL,
  interest      TEXT,           -- shopping / reminders / family_coordination / other
  source        TEXT,           -- landing_cta / wa_away / fb_ad / organic / other
  referrer_url  TEXT,
  user_agent    TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  invited_at    TIMESTAMPTZ,    -- when we sent them the "you're in" notification
  activated_at  TIMESTAMPTZ,    -- when they messaged Sheli after invite
  UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON public.waitlist (created_at);
CREATE INDEX IF NOT EXISTS waitlist_invited_at_idx ON public.waitlist (invited_at) WHERE invited_at IS NULL;

-- RLS: anon can INSERT (public signup form), only service_role can SELECT/UPDATE/DELETE
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS waitlist_anon_insert ON public.waitlist;
CREATE POLICY waitlist_anon_insert ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    -- Basic sanity: phone must be non-empty and look like digits
    phone IS NOT NULL
    AND length(phone) BETWEEN 7 AND 20
    AND phone ~ '^[0-9+\-\s]+$'
  );

-- No anon SELECT/UPDATE/DELETE — service_role bypasses RLS anyway for admin views.

COMMENT ON TABLE public.waitlist IS
  'Recovery-period waitlist. Populated by landing page /waitlist form. Drained manually when Cloud API migration completes.';