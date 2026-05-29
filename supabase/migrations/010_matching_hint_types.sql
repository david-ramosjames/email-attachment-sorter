-- Split matching hints into case matching vs document sorting

ALTER TABLE public.matching_hints
  ADD COLUMN IF NOT EXISTS hint_type TEXT NOT NULL DEFAULT 'case';

ALTER TABLE public.matching_hints
  ALTER COLUMN case_number DROP NOT NULL;

UPDATE public.matching_hints SET hint_type = 'case' WHERE hint_type IS NULL;

ALTER TABLE public.matching_hints
  DROP CONSTRAINT IF EXISTS matching_hints_type_check;

ALTER TABLE public.matching_hints
  ADD CONSTRAINT matching_hints_type_check CHECK (hint_type IN ('case', 'sort'));

ALTER TABLE public.matching_hints
  DROP CONSTRAINT IF EXISTS matching_hints_case_requires_case_number;

ALTER TABLE public.matching_hints
  ADD CONSTRAINT matching_hints_case_requires_case_number
  CHECK (hint_type != 'case' OR case_number IS NOT NULL);

ALTER TABLE public.matching_hints
  DROP CONSTRAINT IF EXISTS matching_hints_sort_requires_sender;

ALTER TABLE public.matching_hints
  ADD CONSTRAINT matching_hints_sort_requires_sender
  CHECK (hint_type != 'sort' OR sender_email IS NOT NULL);

DROP INDEX IF EXISTS public.idx_matching_hints_sender_case_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_hints_sender_case_unique
  ON public.matching_hints (lower(trim(sender_email)), case_number)
  WHERE sender_email IS NOT NULL AND hint_type = 'case' AND case_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_hints_sender_sort_unique
  ON public.matching_hints (lower(trim(sender_email)), coalesce(case_number, ''))
  WHERE sender_email IS NOT NULL AND hint_type = 'sort';

CREATE INDEX IF NOT EXISTS idx_matching_hints_type
  ON public.matching_hints (hint_type);
