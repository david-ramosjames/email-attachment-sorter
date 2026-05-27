-- Align file_sorter_items and case_folders with case_slack_channels (case_number as key).
-- Run in Supabase SQL editor if you already deployed the original schema.

-- file_sorter_items: use case_number instead of UUID case ids
ALTER TABLE file_sorter_items
  ADD COLUMN IF NOT EXISTS suggested_case_number TEXT,
  ADD COLUMN IF NOT EXISTS final_case_number TEXT;

-- case_folders: keyed by case_number
CREATE TABLE IF NOT EXISTS case_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT NOT NULL REFERENCES case_slack_channels (case_number) ON DELETE CASCADE,
  folder_label TEXT NOT NULL,
  dropbox_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_number, folder_label)
);

-- If case_folders existed with case_id UUID, add case_number column:
ALTER TABLE case_folders ADD COLUMN IF NOT EXISTS case_number TEXT;

CREATE INDEX IF NOT EXISTS idx_case_folders_case_number ON case_folders (case_number);

-- Minimal file_sorter_items if not yet created:
CREATE TABLE IF NOT EXISTS file_sorter_items (
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

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_sorter_item_id UUID NOT NULL REFERENCES file_sorter_items (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
