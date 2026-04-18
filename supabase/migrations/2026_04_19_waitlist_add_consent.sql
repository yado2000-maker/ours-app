-- Waitlist anti-spam compliance: consent capture for future outreach.
-- RLS now requires consent_given=true on insert, so the form cannot
-- bypass it by unchecking the box and submitting anyway.

ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consented_at  TIMESTAMPTZ;

DROP POLICY IF EXISTS waitlist_anon_insert ON public.waitlist;
CREATE POLICY waitlist_anon_insert ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    phone IS NOT NULL
    AND length(phone) BETWEEN 7 AND 20
    AND phone ~ '^[0-9+\-\s]+$'
    AND consent_given = TRUE
  );
