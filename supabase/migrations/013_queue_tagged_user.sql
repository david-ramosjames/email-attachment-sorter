-- Slack user @mentioned on the queue card when the item was posted (rotation assignment).
ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS queue_tagged_slack_user_id TEXT;

COMMENT ON COLUMN public.file_sorter_items.queue_tagged_slack_user_id IS
  'Slack user ID tagged on the queue card (comma-separated when multiple).';

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_queue_tagged_user
  ON public.file_sorter_items (queue_tagged_slack_user_id)
  WHERE queue_tagged_slack_user_id IS NOT NULL;
