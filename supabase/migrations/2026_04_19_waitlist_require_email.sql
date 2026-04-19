-- Email becomes required on waitlist signups. Rationale: during ban
-- recovery + Cloud API migration, WhatsApp proactive outbound is not an
-- option. SMS is largely ignored. Email is the only reliable re-engagement
-- channel. Enforced at RLS level (defense-in-depth with the form).

DROP POLICY IF EXISTS waitlist_anon_insert ON public.waitlist;
CREATE POLICY waitlist_anon_insert ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    phone IS NOT NULL
    AND length(phone) BETWEEN 7 AND 20
    AND phone ~ '^[0-9+\-\s]+$'
    AND consent_given = TRUE
    AND email IS NOT NULL
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );
