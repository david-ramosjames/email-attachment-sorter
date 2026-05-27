-- SAFE migration for existing Supabase projects.
-- Does NOT touch case_slack_channels or any existing tables.
-- Run this only — skip 001, 002, 003, and 004 unless you know you need them.

-- Queued email items awaiting Slack review
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gmail_message_id, attachment_filename)
);

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_status
  ON public.file_sorter_items (status);

CREATE INDEX IF NOT EXISTS idx_file_sorter_items_created_at
  ON public.file_sorter_items (created_at DESC);

-- Audit trail for each filing action
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

-- Optional: Dropbox subfolder index per case (for AI folder suggestions)
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

-- If file_sorter_items already existed from an older attempt, add missing columns only:
ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS suggested_case_number TEXT,
  ADD COLUMN IF NOT EXISTS final_case_number TEXT;
