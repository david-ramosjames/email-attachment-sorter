-- Persistent status for silent Dropbox medical backfill jobs.
-- Run in the CLIENT Supabase project after migration 006.

begin;

create table if not exists public.medical_import_jobs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  case_number text not null,
  dropbox_case_path text not null,
  status text not null default 'queued',
  total_files integer not null default 0,
  processed_files integer not null default 0,
  imported_records integer not null default 0,
  skipped_files integer not null default 0,
  failed_files integer not null default 0,
  error_message text,
  started_by uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_import_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'failed'))
);

create index if not exists idx_medical_import_jobs_case_created
  on public.medical_import_jobs(case_id, created_at desc);

drop trigger if exists trg_medical_import_jobs_updated_at on public.medical_import_jobs;
create trigger trg_medical_import_jobs_updated_at
before update on public.medical_import_jobs
for each row execute function public.set_updated_at();

alter table public.medical_import_jobs enable row level security;

drop policy if exists "medical import jobs readable by authenticated users" on public.medical_import_jobs;
create policy "medical import jobs readable by authenticated users"
on public.medical_import_jobs for select to authenticated using (true);

grant select on public.medical_import_jobs to authenticated;

commit;
