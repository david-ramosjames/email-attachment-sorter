-- Document type, payment status, and provider directory (run after 001/002).

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

alter table public.case_medical_records
  add column if not exists document_type text,
  add column if not exists payment_status text,
  add column if not exists provider_id uuid references public.medical_providers(id) on delete set null;

update public.case_medical_records
set document_type = coalesce(document_type, 'medical_bill'),
    payment_status = coalesce(payment_status, 'unknown')
where document_type is null or payment_status is null;

alter table public.case_medical_records
  alter column document_type set default 'medical_bill',
  alter column payment_status set default 'unknown';

alter table public.case_medical_records
  drop constraint if exists case_medical_records_document_type_check;

alter table public.case_medical_records
  add constraint case_medical_records_document_type_check
  check (document_type in (
    'medical_bill',
    'balance_statement',
    'reduction_letter',
    'payment_invoice'
  ));

alter table public.case_medical_records
  drop constraint if exists case_medical_records_payment_status_check;

alter table public.case_medical_records
  add constraint case_medical_records_payment_status_check
  check (payment_status in (
    'unpaid',
    'paid',
    'reduced',
    'waived',
    'pending_reduction',
    'unknown'
  ));

create index if not exists idx_case_medical_records_provider_id
  on public.case_medical_records(provider_id)
  where provider_id is not null;

create index if not exists idx_case_medical_records_document_type
  on public.case_medical_records(document_type);

comment on column public.case_medical_records.document_type is
  'Kind of billing document: medical_bill, balance_statement, reduction_letter, payment_invoice.';
comment on column public.case_medical_records.payment_status is
  'Payment state for this line: unpaid, paid, reduced, waived, pending_reduction, unknown.';
comment on column public.case_medical_records.provider_id is
  'FK to medical_providers — reusable provider directory entry.';

commit;
