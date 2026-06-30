-- Run this in the CLIENT / case-tracker Supabase project (not the file-sorter project).

begin;

create table if not exists public.medical_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  address text,
  normalized_address text not null default '',
  payee_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_providers_name_address_unique unique (normalized_name, normalized_address)
);

create index if not exists idx_medical_providers_normalized_name
  on public.medical_providers(normalized_name);

comment on table public.medical_providers is
  'Reusable medical provider / billing entity directory (deduped by normalized name + address).';

create table if not exists public.case_medical_records (
  id uuid primary key default gen_random_uuid(),
  tracker_entry_id uuid references public.case_tracker_entries(id) on delete cascade,
  case_id uuid references public.cases(id) on delete set null,
  case_number text not null,
  provider_name text not null,
  account_number text,
  date_of_service date,
  original_charges numeric(14, 2),
  current_balance numeric(14, 2),
  final_pay_amount numeric(14, 2),
  reduced_from_amount numeric(14, 2),
  payee_name text,
  payee_address text,
  dropbox_file_id text,
  dropbox_file_path text,
  document_type text not null default 'medical_bill',
  payment_status text not null default 'unknown',
  provider_id uuid references public.medical_providers(id) on delete set null,
  text_extraction_method text,
  extraction_confidence numeric(5, 4),
  document_extraction_confidence numeric(5, 4),
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_medical_records_review_status_check
    check (review_status in ('pending', 'in_review', 'approved', 'rejected', 'paid')),
  constraint case_medical_records_document_type_check
    check (document_type in (
      'medical_bill',
      'balance_statement',
      'reduction_letter',
      'payment_invoice'
    )),
  constraint case_medical_records_payment_status_check
    check (payment_status in (
      'unpaid',
      'paid',
      'reduced',
      'waived',
      'pending_reduction',
      'unknown'
    ))
);

create index if not exists idx_case_medical_records_case_number
  on public.case_medical_records(case_number);

create index if not exists idx_case_medical_records_tracker_entry_id
  on public.case_medical_records(tracker_entry_id);

create index if not exists idx_case_medical_records_review_status
  on public.case_medical_records(review_status);

create index if not exists idx_case_medical_records_dropbox_file_id
  on public.case_medical_records(dropbox_file_id)
  where dropbox_file_id is not null;

create index if not exists idx_case_medical_records_provider_id
  on public.case_medical_records(provider_id)
  where provider_id is not null;

create index if not exists idx_case_medical_records_document_type
  on public.case_medical_records(document_type);

comment on table public.case_medical_records is
  'Medical provider billing lines keyed by case number (one case may have many providers / line items).';
comment on column public.case_medical_records.document_type is
  'Kind of billing document: medical_bill, balance_statement, reduction_letter, payment_invoice.';
comment on column public.case_medical_records.payment_status is
  'Payment state: unpaid, paid, reduced, waived, pending_reduction, unknown.';
comment on column public.case_medical_records.provider_id is
  'FK to medical_providers — reusable provider directory entry.';

drop trigger if exists trg_medical_providers_updated_at on public.medical_providers;
create trigger trg_medical_providers_updated_at
before update on public.medical_providers
for each row execute function public.set_updated_at();

alter table public.medical_providers enable row level security;

drop policy if exists "medical providers readable by authenticated users" on public.medical_providers;
create policy "medical providers readable by authenticated users"
on public.medical_providers for select to authenticated using (true);

drop policy if exists "medical providers editable by firm roles" on public.medical_providers;
create policy "medical providers editable by firm roles"
on public.medical_providers for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.medical_providers to authenticated;

drop trigger if exists trg_case_medical_records_updated_at on public.case_medical_records;
create trigger trg_case_medical_records_updated_at
before update on public.case_medical_records
for each row execute function public.set_updated_at();

alter table public.case_medical_records enable row level security;

drop policy if exists "medical records readable by authenticated users" on public.case_medical_records;
create policy "medical records readable by authenticated users"
on public.case_medical_records
for select to authenticated using (true);

drop policy if exists "medical records editable by firm roles" on public.case_medical_records;
create policy "medical records editable by firm roles"
on public.case_medical_records
for all to authenticated
using (true)
with check (true);

grant select, insert, update, delete on public.case_medical_records to authenticated;

commit;
