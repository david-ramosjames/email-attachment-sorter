-- Same as 004b — copy into file-sorter client-supabase for discoverability
alter table public.case_medical_records
  add column if not exists dropbox_permalink text;

comment on column public.case_medical_records.dropbox_permalink is
  'Team-only Dropbox shared link to the source document.';
