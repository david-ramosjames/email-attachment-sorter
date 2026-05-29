-- Staff-provided context for case matching and document sorting

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
