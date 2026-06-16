-- Attorney / paralegal from Slack channel topic (e.g. Attorney @Ryan | Paralegal @Jorge (settled)).

ALTER TABLE public.case_slack_channels
  ADD COLUMN IF NOT EXISTS attorney_slack_user_id TEXT,
  ADD COLUMN IF NOT EXISTS attorney_name TEXT,
  ADD COLUMN IF NOT EXISTS paralegal_slack_user_id TEXT,
  ADD COLUMN IF NOT EXISTS paralegal_name TEXT;
