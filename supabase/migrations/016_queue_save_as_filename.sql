-- Optional Dropbox filename set via queue card Rename modal (or thread rename:).

ALTER TABLE public.file_sorter_items
  ADD COLUMN IF NOT EXISTS queue_save_as_filename TEXT;
