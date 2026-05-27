-- Safe: adds optional Dropbox folder name to existing case_slack_channels rows.
-- Example folder: "276. REGINA PEEK ETAL 3 (DOL 04-22-20)"

ALTER TABLE public.case_slack_channels
  ADD COLUMN IF NOT EXISTS dropbox_folder_name TEXT;

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_dropbox_folder
  ON public.case_slack_channels (dropbox_folder_name)
  WHERE dropbox_folder_name IS NOT NULL;
