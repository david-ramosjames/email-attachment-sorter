-- Persistent status for silent Dropbox Expenses folder backfill jobs.
-- Run in the CLIENT Supabase project after migration 008.

begin;

create table if not exists public.case_expense_import_jobs (
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
  constraint case_expense_import_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'failed'))
);

create index if not exists idx_case_expense_import_jobs_case_created
  on public.case_expense_import_jobs(case_id, created_at desc);

drop trigger if exists trg_case_expense_import_jobs_updated_at on public.case_expense_import_jobs;
create trigger trg_case_expense_import_jobs_updated_at
before update on public.case_expense_import_jobs
for each row execute function public.set_updated_at();

alter table public.case_expense_import_jobs enable row level security;

drop policy if exists "case expense import jobs readable by authenticated users" on public.case_expense_import_jobs;
create policy "case expense import jobs readable by authenticated users"
on public.case_expense_import_jobs for select to authenticated using (true);

grant select on public.case_expense_import_jobs to authenticated;

commit;
