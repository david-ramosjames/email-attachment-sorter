-- Add confidence + text extraction metadata (run if 001 already applied without these columns).

begin;

alter table public.case_medical_records
  add column if not exists text_extraction_method text,
  add column if not exists extraction_confidence numeric(5, 4),
  add column if not exists document_extraction_confidence numeric(5, 4);

comment on column public.case_medical_records.text_extraction_method is
  'How file-sorter obtained attachment text: pdf-text, pdf-vision, docx-text, etc.';
comment on column public.case_medical_records.extraction_confidence is
  'Effective AI confidence for this line (0–1), adjusted for document and OCR quality.';
comment on column public.case_medical_records.document_extraction_confidence is
  'AI confidence for the overall document extraction (0–1).';

commit;
