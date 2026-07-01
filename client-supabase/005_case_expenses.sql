-- Same as case-financials/migrations/005_case_expenses.sql
begin;

create table if not exists public.case_expenses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.cases(id) on delete set null,
  case_number text not null,
  vendor_name text not null,
  expense_type text,
  description text,
  invoice_number text,
  invoice_date date,
  service_date date,
  amount numeric(14, 2),
  payment_status text not null default 'pending_review',
  paid_amount numeric(14, 2),
  check_number text,
  payee_name text,
  payee_address text,
  reference_number text,
  related_party text,
  dropbox_file_id text,
  dropbox_file_path text,
  dropbox_permalink text,
  document_type text,
  review_status text not null default 'needs_review',
  text_extraction_method text,
  extraction_confidence numeric(5, 4),
  document_extraction_confidence numeric(5, 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_expenses_payment_status_check
    check (payment_status in (
      'pending_review', 'unpaid', 'partially_paid', 'paid', 'waived', 'closed', 'unknown'
    )),
  constraint case_expenses_review_status_check
    check (review_status in (
      'needs_review', 'reviewed', 'pending', 'in_review', 'approved', 'rejected'
    )),
  constraint case_expenses_document_type_check
    check (document_type is null or document_type in (
      'invoice', 'receipt', 'statement', 'check_copy', 'credit_card', 'vendor_bill', 'other'
    ))
);

create index if not exists idx_case_expenses_case_number on public.case_expenses(case_number);
create index if not exists idx_case_expenses_case_id on public.case_expenses(case_id) where case_id is not null;
create index if not exists idx_case_expenses_review_status on public.case_expenses(review_status);
create index if not exists idx_case_expenses_created_at on public.case_expenses(created_at desc);
create index if not exists idx_case_expenses_dropbox_file_id on public.case_expenses(dropbox_file_id) where dropbox_file_id is not null;

drop trigger if exists trg_case_expenses_updated_at on public.case_expenses;
create trigger trg_case_expenses_updated_at
before update on public.case_expenses
for each row execute function public.set_updated_at();

alter table public.case_expenses enable row level security;

drop policy if exists "case expenses readable by authenticated users" on public.case_expenses;
create policy "case expenses readable by authenticated users"
on public.case_expenses for select to authenticated using (true);

drop policy if exists "case expenses editable by firm roles" on public.case_expenses;
create policy "case expenses editable by firm roles"
on public.case_expenses for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.case_expenses to authenticated;

commit;
