-- Phase 1: Case Financials — Medical Expenses alignment
-- Run in the CLIENT / case-tracker Supabase project (after 001–003).

begin;

-- Expand review_status for human review workflow
alter table public.case_medical_records
  drop constraint if exists case_medical_records_review_status_check;

alter table public.case_medical_records
  alter column review_status set default 'needs_review';

update public.case_medical_records
set review_status = 'needs_review'
where review_status in ('pending', 'in_review');

alter table public.case_medical_records
  add constraint case_medical_records_review_status_check
  check (review_status in (
    'needs_review',
    'reviewed',
    'pending',
    'in_review',
    'approved',
    'rejected',
    'paid'
  ));

-- Expand document types
alter table public.case_medical_records
  drop constraint if exists case_medical_records_document_type_check;

alter table public.case_medical_records
  add constraint case_medical_records_document_type_check
  check (document_type in (
    'medical_bill',
    'balance_statement',
    'reduction_letter',
    'payment_invoice',
    'lop_statement',
    'medical_provider_statement'
  ));

-- Expand payment statuses
alter table public.case_medical_records
  drop constraint if exists case_medical_records_payment_status_check;

alter table public.case_medical_records
  add constraint case_medical_records_payment_status_check
  check (payment_status in (
    'pending_review',
    'unpaid',
    'partially_paid',
    'paid',
    'reduced',
    'waived',
    'closed',
    'pending_reduction',
    'unknown'
  ));

-- Dropbox permalink for opening source documents in UI
alter table public.case_medical_records
  add column if not exists dropbox_permalink text;

comment on column public.case_medical_records.dropbox_permalink is
  'Team-only Dropbox shared link to the source document.';

create index if not exists idx_case_medical_records_case_id
  on public.case_medical_records(case_id)
  where case_id is not null;

-- Alias view for Case Financials module (medical_expenses = case_medical_records)
create or replace view public.medical_expenses as
  select * from public.case_medical_records;

comment on view public.medical_expenses is
  'Case Financials — Medical Expenses (alias for case_medical_records).';

grant select, insert, update, delete on public.medical_expenses to authenticated;

commit;
