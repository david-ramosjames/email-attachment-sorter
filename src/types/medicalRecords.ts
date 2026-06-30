export type MedicalRecordReviewStatus =
  | 'needs_review'
  | 'reviewed'
  | 'pending'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'paid';

export type MedicalDocumentType =
  | 'medical_bill'
  | 'balance_statement'
  | 'reduction_letter'
  | 'payment_invoice'
  | 'lop_statement'
  | 'medical_provider_statement';

export type MedicalPaymentStatus =
  | 'pending_review'
  | 'unpaid'
  | 'partially_paid'
  | 'paid'
  | 'reduced'
  | 'waived'
  | 'closed'
  | 'pending_reduction'
  | 'unknown';

export const MEDICAL_DOCUMENT_TYPES: MedicalDocumentType[] = [
  'medical_bill',
  'balance_statement',
  'reduction_letter',
  'payment_invoice',
  'lop_statement',
  'medical_provider_statement',
];

export const FINANCIAL_MEDICAL_DOCUMENT_TYPES: MedicalDocumentType[] = [
  ...MEDICAL_DOCUMENT_TYPES,
];

export const MEDICAL_PAYMENT_STATUSES: MedicalPaymentStatus[] = [
  'pending_review',
  'unpaid',
  'partially_paid',
  'paid',
  'reduced',
  'waived',
  'closed',
  'pending_reduction',
  'unknown',
];

export interface ExtractedMedicalBillingLine {
  provider_name: string;
  account_number: string | null;
  date_of_service: string | null;
  original_charges: number | null;
  current_balance: number | null;
  final_pay_amount: number | null;
  reduced_from_amount: number | null;
  payee_name: string | null;
  payee_address: string | null;
  payment_status: MedicalPaymentStatus;
  line_confidence: number | null;
}

export interface MedicalBillingExtractionResult {
  document_summary: string;
  document_type: MedicalDocumentType | null;
  document_confidence: number | null;
  lines: ExtractedMedicalBillingLine[];
}

export interface CaseMedicalRecordInsert {
  case_number: string;
  case_id: string | null;
  tracker_entry_id: string | null;
  provider_id: string | null;
  provider_name: string;
  account_number: string | null;
  date_of_service: string | null;
  original_charges: number | null;
  current_balance: number | null;
  final_pay_amount: number | null;
  reduced_from_amount: number | null;
  payee_name: string | null;
  payee_address: string | null;
  document_type: MedicalDocumentType;
  payment_status: MedicalPaymentStatus;
  dropbox_file_id: string;
  dropbox_file_path: string;
  dropbox_permalink?: string | null;
  review_status: MedicalRecordReviewStatus;
  text_extraction_method: string | null;
  extraction_confidence: number | null;
  document_extraction_confidence: number | null;
}
