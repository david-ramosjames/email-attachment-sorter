-- =============================================================================
-- RJL File Sorter — ONE script for a NEW Supabase project
-- Run this entire file once in SQL Editor, then skip migrations 001–010.
-- =============================================================================

-- Case index (Slack channel ↔ case number ↔ Dropbox folder)
CREATE TABLE IF NOT EXISTS public.case_slack_channels (
  case_number TEXT NOT NULL,
  slack_channel_id TEXT NULL,
  slack_channel_name TEXT NOT NULL,
  topic_stage TEXT NULL,
  dropbox_folder_name TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT case_slack_channels_pkey PRIMARY KEY (case_number)
);

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_channel_id
  ON public.case_slack_channels USING btree (slack_channel_id);

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_channel_name
  ON public.case_slack_channels USING btree (lower(slack_channel_name));

CREATE INDEX IF NOT EXISTS idx_case_slack_channels_dropbox_folder
  ON public.case_slack_channels (dropbox_folder_name)
  WHERE dropbox_folder_name IS NOT NULL;

-- Queue items awaiting Slack review
CREATE TABLE IF NOT EXISTS public.file_sorter_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_emails TEXT[] NOT NULL DEFAULT '{}',
  cc_emails TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  body_excerpt TEXT,
  attachment_filename TEXT NOT NULL,
  attachment_mime_type TEXT,
  attachment_size BIGINT,
  temp_storage_url TEXT,
  suggested_case_number TEXT,
  suggested_folder_path TEXT,
  suggested_document_type TEXT,
  ai_confidence NUMERIC(4, 3),
  ai_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  final_case_number TEXT,
  final_dropbox_path TEXT,
  dropbox_permalink TEXT,
  slack_queue_message_ts TEXT,
  slack_queue_channel_id TEXT,
  reviewed_by_slack_user_id TEXT,
  reviewed_at TIMESTAMPTZ,
  email_received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gmail_message_id, attachment_filename)
);

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_status
  ON public.file_sorter_items (status);

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_created_at
  ON public.file_sorter_items (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_gmail_message_id
  ON public.file_sorter_items (gmail_message_id);

-- Audit trail
CREATE TABLE IF NOT EXISTS public.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_sorter_item_id UUID NOT NULL REFERENCES public.file_sorter_items (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_item_id
  ON public.audit_events (file_sorter_item_id);

-- Dropbox subfolder index per case
CREATE TABLE IF NOT EXISTS public.case_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT NOT NULL,
  folder_label TEXT NOT NULL,
  dropbox_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_number, folder_label)
);

CREATE INDEX IF NOT EXISTS idx_case_folders_case_number
  ON public.case_folders (case_number);

-- Case / sort hints (staff teaching)
CREATE TABLE IF NOT EXISTS public.matching_hints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hint_type TEXT NOT NULL DEFAULT 'case' CHECK (hint_type IN ('case', 'sort')),
  case_number TEXT REFERENCES public.case_slack_channels (case_number) ON DELETE CASCADE,
  sender_email TEXT,
  hint_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matching_hints_case_requires_case_number
    CHECK (hint_type != 'case' OR case_number IS NOT NULL),
  CONSTRAINT matching_hints_sort_requires_sender
    CHECK (hint_type != 'sort' OR sender_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_matching_hints_sender
  ON public.matching_hints (lower(trim(sender_email)))
  WHERE sender_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matching_hints_case
  ON public.matching_hints (case_number)
  WHERE case_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matching_hints_type
  ON public.matching_hints (hint_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_hints_sender_case_unique
  ON public.matching_hints (lower(trim(sender_email)), case_number)
  WHERE sender_email IS NOT NULL AND hint_type = 'case' AND case_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_hints_sender_sort_unique
  ON public.matching_hints (lower(trim(sender_email)), coalesce(case_number, ''))
  WHERE sender_email IS NOT NULL AND hint_type = 'sort';

-- Temp attachment bucket (private; Railway uses service role)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('file-sorter-temp', 'file-sorter-temp', false, 52428800)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "file_sorter_temp_service_role" ON storage.objects;
CREATE POLICY "file_sorter_temp_service_role"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'file-sorter-temp')
  WITH CHECK (bucket_id = 'file-sorter-temp');
