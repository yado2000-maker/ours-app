ALTER TABLE public.reminder_queue
  ADD COLUMN IF NOT EXISTS recipient_phones TEXT[],
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT
    CHECK (delivery_mode IN ('group','dm','both')) DEFAULT 'group';

COMMENT ON COLUMN public.reminder_queue.recipient_phones IS
  'Bare phone numbers (no @-suffix) for dm/both delivery. NULL or [] = group-only.';
COMMENT ON COLUMN public.reminder_queue.delivery_mode IS
  'group (default, backward compat) | dm (recipients only) | both (group + recipients).';
