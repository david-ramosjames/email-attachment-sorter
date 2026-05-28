-- When the source email arrived in Gmail (from inbound webhook), not when we queued it.
ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS email_received_at TIMESTAMPTZ;
