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
}): RjlSubfolder | string | null {
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
  if (/\b(discovery|interrogator|request for production)\b/.test(text)) {
    return 'Discovery';
  }
  if (/\b(deposition|depo transcript)\b/.test(text)) {
    return 'Deposition';
  }
  if (/\b(mediation|mediator)\b/.test(text)) {
    return 'Mediation';
  }
  if (/\b(expert report|expert witness|expert disclosure)\b/.test(text)) {
    return 'Experts';
  }
  if (/\b(trial exhibit|trial brief|voir dire)\b/.test(text)) {
    return 'Trial';
  }
  if (/\b(settlement release|signed release|offer of settlement)\b/.test(text)) {
    return 'Settlement';
  }
  if (/\b(settlement demand|demand letter|demand package)\b/.test(text)) {
    return 'Demand';
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
  if (/\b(court notice|scheduling order|litigation correspondence)\b/.test(text)) {
    return 'Correspondence Litigation';
  }
  if (/\b(court notice|order|docket)\b/.test(text)) {
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

export function subfolderForDocumentType(documentType: string): RjlSubfolder | string | undefined {
  return DOCUMENT_TYPE_TO_SUBFOLDER[documentType];
}
