-- Extend waitlist capture with last_name + email for richer outreach
-- when the Cloud API migration completes.

ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS email     TEXT;

CREATE INDEX IF NOT EXISTS waitlist_email_idx ON public.waitlist (email) WHERE email IS NOT NULL;
