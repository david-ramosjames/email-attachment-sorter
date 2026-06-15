-- Human-readable name for the Slack user tagged on the queue card.
ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS queue_tagged_slack_user_name TEXT;

COMMENT ON COLUMN public.file_sorter_items.queue_tagged_slack_user_name IS
  'Display name of the Slack user tagged when the queue card was posted.';
