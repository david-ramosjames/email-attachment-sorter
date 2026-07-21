-- Provider-level medical tracker for each case.
-- Run in the CLIENT Supabase project after migrations 001–005.

begin;

create table if not exists public.case_medical_tracker (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  case_number text not null,
  provider_id uuid references public.medical_providers(id) on delete set null,
  provider_name text not null,
  normalized_provider_name text generated always as (lower(btrim(provider_name))) stored,
  has_lop boolean,
  treatment_finished_date date,
  medical_requested_date date,
  medical_received_date date,
  billing_requested_date date,
  billing_received_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_medical_tracker_case_provider_unique
    unique (case_id, normalized_provider_name)
);

create index if not exists idx_case_medical_tracker_case_id
  on public.case_medical_tracker(case_id);

comment on table public.case_medical_tracker is
  'Provider-level LOP, treatment completion, and medical/billing document request tracking.';

drop trigger if exists trg_case_medical_tracker_updated_at on public.case_medical_tracker;
create trigger trg_case_medical_tracker_updated_at
before update on public.case_medical_tracker
for each row execute function public.set_updated_at();

alter table public.case_medical_tracker enable row level security;

drop policy if exists "medical tracker readable by authenticated users" on public.case_medical_tracker;
create policy "medical tracker readable by authenticated users"
on public.case_medical_tracker for select to authenticated using (true);

drop policy if exists "medical tracker editable by authenticated users" on public.case_medical_tracker;
create policy "medical tracker editable by authenticated users"
on public.case_medical_tracker for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.case_medical_tracker to authenticated;

commit;
