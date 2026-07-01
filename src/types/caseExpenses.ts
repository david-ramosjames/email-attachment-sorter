export type CaseExpenseDocumentType =
  | 'invoice'
  | 'receipt'
  | 'statement'
  | 'check_copy'
  | 'credit_card'
  | 'vendor_bill'
  | 'other';

export type CaseExpensePaymentStatus =
  | 'pending_review'
  | 'unpaid'
  | 'partially_paid'
  | 'paid'
  | 'waived'
  | 'closed'
  | 'unknown';

export type CaseExpenseReviewStatus =
  | 'needs_review'
  | 'reviewed'
  | 'pending'
  | 'in_review'
  | 'approved'
  | 'rejected';

export const CASE_EXPENSE_DOCUMENT_TYPES: CaseExpenseDocumentType[] = [
  'invoice',
  'receipt',
  'statement',
  'check_copy',
  'credit_card',
  'vendor_bill',
  'other',
];

export const CASE_EXPENSE_PAYMENT_STATUSES: CaseExpensePaymentStatus[] = [
  'pending_review',
  'unpaid',
  'partially_paid',
  'paid',
  'waived',
  'closed',
  'unknown',
];

export interface ExtractedCaseExpense {
  vendor_name: string;
  expense_type: string | null;
  description: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  service_date: string | null;
  amount: number | null;
  payment_status: CaseExpensePaymentStatus;
  paid_amount: number | null;
  check_number: string | null;
  payee_name: string | null;
  payee_address: string | null;
  reference_number: string | null;
  related_party: string | null;
  document_type: CaseExpenseDocumentType | null;
  line_confidence: number | null;
}

export interface CaseExpenseExtractionResult {
  document_summary: string;
  document_type: CaseExpenseDocumentType | null;
  document_confidence: number | null;
  expenses: ExtractedCaseExpense[];
}

export interface CaseExpenseInsert {
  case_number: string;
  case_id: string | null;
  vendor_name: string;
  expense_type: string | null;
  description: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  service_date: string | null;
  amount: number | null;
  payment_status: CaseExpensePaymentStatus;
  paid_amount: number | null;
  check_number: string | null;
  payee_name: string | null;
  payee_address: string | null;
  reference_number: string | null;
  related_party: string | null;
  dropbox_file_id: string;
  dropbox_file_path: string;
  dropbox_permalink?: string | null;
  document_type: CaseExpenseDocumentType | null;
  review_status: CaseExpenseReviewStatus;
  text_extraction_method: string | null;
  extraction_confidence: number | null;
  document_extraction_confidence: number | null;
}
