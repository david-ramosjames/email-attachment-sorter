-- RJL File Sorter — initial schema

CREATE TYPE file_sorter_item_status AS ENUM (
  'pending_review',
  'approved',
  'saved',
  'needs_attention',
  'ignored',
  'failed'
);

CREATE TYPE case_status AS ENUM (
  'active',
  'closed',
  'archived'
);

CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_name TEXT NOT NULL,
  case_number TEXT,
  client_name TEXT NOT NULL,
  cause_number TEXT,
  dropbox_root_path TEXT NOT NULL,
  slack_channel_id TEXT,
  status case_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_client_name ON cases (client_name);
CREATE INDEX idx_cases_cause_number ON cases (cause_number) WHERE cause_number IS NOT NULL;
CREATE INDEX idx_cases_case_number ON cases (case_number) WHERE case_number IS NOT NULL;
CREATE INDEX idx_cases_status ON cases (status);

CREATE TABLE case_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  folder_label TEXT NOT NULL,
  dropbox_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, folder_label)
);

CREATE INDEX idx_case_folders_case_id ON case_folders (case_id);

CREATE TABLE file_sorter_items (
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
  suggested_case_id UUID REFERENCES cases (id),
  suggested_folder_path TEXT,
  suggested_document_type TEXT,
  ai_confidence NUMERIC(4, 3),
  ai_reason TEXT,
  status file_sorter_item_status NOT NULL DEFAULT 'pending_review',
  final_case_id UUID REFERENCES cases (id),
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

CREATE INDEX idx_file_sorter_items_status ON file_sorter_items (status);
CREATE INDEX idx_file_sorter_items_gmail_message_id ON file_sorter_items (gmail_message_id);
CREATE INDEX idx_file_sorter_items_created_at ON file_sorter_items (created_at DESC);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_sorter_item_id UUID NOT NULL REFERENCES file_sorter_items (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_item_id ON audit_events (file_sorter_item_id);
CREATE INDEX idx_audit_events_created_at ON audit_events (created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cases_updated_at
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER file_sorter_items_updated_at
  BEFORE UPDATE ON file_sorter_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Supabase Storage bucket for temp attachments (create via dashboard or API)
-- Bucket name: file-sorter-temp
