-- Split AI confidence into case, folder, and overall scores.
ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS ai_case_confidence NUMERIC(4, 3),
  ADD COLUMN IF NOT EXISTS ai_folder_confidence NUMERIC(4, 3);

COMMENT ON COLUMN public.file_sorter_items.ai_case_confidence IS
  'AI confidence (0–1) that suggested_case_number is correct';
COMMENT ON COLUMN public.file_sorter_items.ai_folder_confidence IS
  'AI confidence (0–1) that suggested folder/document type is correct';
COMMENT ON COLUMN public.file_sorter_items.ai_confidence IS
  'AI overall filing confidence (0–1) — case, folder, and document type combined';
