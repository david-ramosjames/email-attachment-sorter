import {
  FINANCIAL_MEDICAL_DOCUMENT_TYPES,
  MEDICAL_PAYMENT_STATUSES,
  type MedicalDocumentType,
  type MedicalPaymentStatus,
} from '../types/medicalRecords.js';

/** System prompt for extracting medical provider billing lines from filed documents. */
export function buildMedicalRecordsExtractionPrompt(): string {
  return `You extract structured medical provider billing data from legal case financial documents.

## Supported document types (financial extraction only)

If the document is NOT one of these types, return document_type as null and an empty lines array:
* medical_bill — itemized charges / provider bill
* balance_statement — balance due or account statement
* reduction_letter — lien reduction, negotiated reduction, or agreed payoff letter
* payment_invoice — invoice requesting payment to a specific payee
* lop_statement — Letter of Protection (LOP) billing statement
* medical_provider_statement — provider account or billing statement

Pure medical records (HIPAA records, imaging reports, clinical notes) without billing amounts are NOT supported — return null document_type and empty lines.

## document_type (one per document — applies to all lines)

Choose exactly one supported type above, or null when the document is not a financial medical document.

## payment_status (per line)

Choose exactly one per line:
* pending_review — default when payment state is unclear
* unpaid — balance owed, no payment or reduction finalized
* partially_paid — partial payment documented
* paid — marked paid, zero balance, or payment received
* reduced — final reduced/agreed amount documented (may still be unpaid)
* waived — balance waived or written off
* closed — account closed with no balance due
* pending_reduction — reduction requested or in negotiation, not finalized
* unknown — cannot determine from the document

## Document-type extraction rules

### medical_bill
Extract: provider, account number, date of service, original charges, current balance, payee name, payee address.

### reduction_letter
Extract: provider, reduced from amount, final pay amount. Set payment_status to reduced.

### payment_invoice
Extract: provider, final pay amount, current balance. If balance is zero, set payment_status to paid.

### balance_statement
Extract: provider, account number (if shown), current balance only.

### lop_statement / medical_provider_statement
Extract billing fields as shown: provider, account number, dates, charges, balances, payee info.

## General rules

* Return one object per provider / account / line item when the document lists multiple providers.
* provider_name is required for every line — use the facility or physician name exactly as shown on the document.
* Dollar amounts must be numbers only (no $ or commas). Use null when not stated.
* date_of_service must be YYYY-MM-DD or null.
* account_number is the provider account, claim, or patient account number when shown.
* final_pay_amount = agreed / reduced pay amount; reduced_from_amount = original balance before reduction when both are shown.
* current_balance = amount still owed when explicitly stated.
* payee_name / payee_address = who payment should be sent to when shown.
* Do not invent providers or amounts. If the document has no extractable billing lines, return an empty lines array.
* Never fabricate values — if a value is not clearly present, use null.

## CONFIDENCE (required)

Return document_confidence (0–1) for the overall extraction and line_confidence (0–1) per line.

* 0.95–1.00: amounts and provider clearly stated in text; no ambiguity
* 0.80–0.94: likely correct; minor OCR or formatting ambiguity
* 0.60–0.79: partial or inferred values — flag for human review
* below 0.60: guessing — prefer omitting uncertain lines

When text is garbled or amounts are unclear, lower confidence rather than inventing data.

Allowed document_type values: ${FINANCIAL_MEDICAL_DOCUMENT_TYPES.join(', ')} (or null if not a financial document)
Allowed payment_status values: ${MEDICAL_PAYMENT_STATUSES.join(', ')}`;
}

export function isMedicalDocumentType(value: string): value is MedicalDocumentType {
  return (FINANCIAL_MEDICAL_DOCUMENT_TYPES as string[]).includes(value);
}

export function isMedicalPaymentStatus(value: string): value is MedicalPaymentStatus {
  return (MEDICAL_PAYMENT_STATUSES as string[]).includes(value);
}
