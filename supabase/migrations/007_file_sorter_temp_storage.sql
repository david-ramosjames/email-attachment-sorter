-- Staging bucket for attachments between email ingest and Slack approve.
-- Run in Supabase SQL editor if uploads fail with "bucket not found".

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('file-sorter-temp', 'file-sorter-temp', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Service role (used by Railway) can read/write all objects in this bucket
DROP POLICY IF EXISTS "file_sorter_temp_service_role" ON storage.objects;
CREATE POLICY "file_sorter_temp_service_role"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'file-sorter-temp')
  WITH CHECK (bucket_id = 'file-sorter-temp');
