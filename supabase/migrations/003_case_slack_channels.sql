-- Maps case numbers to Slack channels (source of truth for case channel cross-posts).
-- If this table already exists in your project, skip this migration.

CREATE TABLE IF NOT EXISTS public.case_slack_channels (
  case_number TEXT NOT NULL,
  slack_channel_id TEXT NULL,
  slack_channel_name TEXT NOT NULL,
  topic_stage TEXT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT case_slack_channels_pkey PRIMARY KEY (case_number)
);

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_channel_id
  ON public.case_slack_channels USING btree (slack_channel_id);

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_channel_name
  ON public.case_slack_channels USING btree (lower(slack_channel_name));
