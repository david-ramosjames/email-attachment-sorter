import { DOCUMENT_TYPE_TO_SUBFOLDER, type RjlSubfolder } from '../constants/rjlFolders.js';
import type { DocumentType } from '../types/index.js';

function combinedText(parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join('\n').toLowerCase();
}

/**
 * Rule-based subfolder from filename, email, and attachment text (runs before/after AI).
 */
export function inferFolderLabelFromContent(parts: {
  attachmentFilename: string;
  subject?: string;
  bodyExcerpt?: string;
  documentExcerpt?: string;
}): RjlSubfolder | null {
  const text = combinedText([
    parts.attachmentFilename,
    parts.subject,
    parts.bodyExcerpt,
    parts.documentExcerpt,
  ]);

  if (
    /\b(complaint|petition|motion|pleading|summons|subpoena|notice of hearing|original petition)\b/.test(
      text
    )
  ) {
    return 'Pleadings';
  }
  if (/\b(discovery|interrogator|request for production|deposition)\b/.test(text)) {
    return 'Investigation';
  }
  if (/\b(settlement|release|demand letter|offer of settlement)\b/.test(text)) {
    return 'Settlement';
  }
  if (/\b(subrogation|lien notice|insurance lien)\b/.test(text)) {
    return 'Subrogation';
  }
  if (/\b(lost wages|wage statement|pay stub|employer verification)\b/.test(text)) {
    return 'Lost Wages';
  }
  if (
    /\b(employment\s+authorization|employee\s+records|employment\s+records|personnel\s+file|payroll)\b/.test(
      text
    )
  ) {
    return 'Lost Wages';
  }
  if (/\b(photo|photograph|image of (scene|injury|vehicle))\b/.test(text)) {
    return 'Photos';
  }
  if (/\b(court notice|order|scheduling order|docket)\b/.test(text)) {
    return 'Correspondence';
  }

  if (
    /\b(contract|retainer|engagement letter|fee agreement)\b/.test(text) &&
    (/\b(adobesign|docusign|signed and filed|is signed)\b/.test(text) ||
      /\bramos james law\b/.test(text))
  ) {
    return 'Intake';
  }

  // Medical records / provider billing (affidavits from records@, procare, etc.)
  if (
    /\b(affidavit|hipaa|medical records?|records affidavit|billing affidavit|billings? affidavit)\b/.test(
      text
    ) ||
    /\b(procare|hospital|clinic|radiology|imaging|emergency|physician|chiropractic)\b/.test(
      text
    ) ||
    (/\brecords?\b/.test(text) && /\bbilling|billings?\b/.test(text)) ||
    /@.*injury\.com\b/.test(text) ||
    /records@/.test(text)
  ) {
    return 'Medical';
  }

  // Expense receipts / costs (not provider medical bills)
  if (/\b(receipt|expense report|mileage|filing fee)\b/.test(text)) {
    return 'Expenses';
  }

  return null;
}

/** Adjust document type when filename/body clearly indicate medical records. */
export function inferDocumentTypeFromContent(parts: {
  attachmentFilename: string;
  subject?: string;
  bodyExcerpt?: string;
  documentExcerpt?: string;
}): DocumentType | null {
  const text = combinedText([
    parts.attachmentFilename,
    parts.subject,
    parts.bodyExcerpt,
    parts.documentExcerpt,
  ]);

  if (
    /\b(affidavit|hipaa|medical records?|records affidavit|billing affidavit|billings? affidavit)\b/.test(
      text
    ) ||
    (/\brecords?\b/.test(text) && /\bbilling|billings?\b/.test(text)) ||
    /records@/.test(text)
  ) {
    return 'Medical Records';
  }

  if (/\b(complaint|petition|motion|pleading|summons)\b/.test(text)) {
    return 'Pleadings';
  }

  if (
    /\b(employment\s+authorization|employee\s+records|employment\s+records)\b/.test(text)
  ) {
    return 'Misc';
  }

  if (
    /\b(contract|retainer|engagement)\b/.test(text) &&
    /\b(signed|adobesign|docusign)\b/.test(text) &&
    !/\bemployment\b/.test(text)
  ) {
    return 'Intake';
  }

  return null;
}

export function subfolderForDocumentType(documentType: string): RjlSubfolder | undefined {
  return DOCUMENT_TYPE_TO_SUBFOLDER[documentType];
}
