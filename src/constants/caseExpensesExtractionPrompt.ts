import {
  CASE_EXPENSE_DOCUMENT_TYPES,
  CASE_EXPENSE_PAYMENT_STATUSES,
  type CaseExpenseDocumentType,
  type CaseExpensePaymentStatus,
} from '../types/caseExpenses.js';

export function buildCaseExpensesExtractionPrompt(): string {
  return `You extract structured case expense data from legal case financial documents.

These are NON-MEDICAL case costs filed in the firm's Expenses folder, such as:
* Investigation / surveillance invoices
* Medical records retrieval (copy service) invoices
* Court filing fees, process server, subpoena costs
* Expert witness invoices (non-medical)
* Travel, lodging, photocopy, shipping receipts
* Vendor bills and general case operating expenses

Do NOT extract medical provider bills, hospital itemized bills, or lien reduction letters — return null document_type and empty expenses for those.

## document_type (per expense line when clear)

invoice, receipt, statement, check_copy, credit_card, vendor_bill, other — or null if not a case expense document.

## expense_type (short category label)

Examples: investigation, records_retrieval, court_fees, filing_fees, process_server, expert, travel, deposition, shipping, other

## payment_status

pending_review, unpaid, partially_paid, paid, waived, closed, unknown

## Rules

* vendor_name is required — the company or payee on the invoice/receipt exactly as shown.
* amount = total due or charge (numbers only, no $). Use null when not stated.
* paid_amount when a partial or full payment amount is documented separately from amount due.
* Dates as YYYY-MM-DD or null.
* related_party = client, opposing party, witness, or other party the expense relates to when stated.
* reference_number = PO, matter ref, claim #, or similar when shown.
* Do not invent values. Return empty expenses array when nothing extractable.
* One expense object per invoice/receipt; multiple only if the document clearly lists separate vendors.

## CONFIDENCE

document_confidence (0–1) overall; line_confidence (0–1) per expense.

Allowed document_type: ${CASE_EXPENSE_DOCUMENT_TYPES.join(', ')}
Allowed payment_status: ${CASE_EXPENSE_PAYMENT_STATUSES.join(', ')}`;
}

export function isCaseExpenseDocumentType(value: string): value is CaseExpenseDocumentType {
  return (CASE_EXPENSE_DOCUMENT_TYPES as string[]).includes(value);
}

export function isCaseExpensePaymentStatus(value: string): value is CaseExpensePaymentStatus {
  return (CASE_EXPENSE_PAYMENT_STATUSES as string[]).includes(value);
}
