import { downloadTempAttachment } from '../db/supabase.js';
import { lookupClientCaseId, upsertCaseMedicalRecords } from '../db/clientMedicalRecords.js';
import { isClientSupabaseConfigured } from '../db/clientSupabase.js';
import { generateDropboxPermalink, downloadDropboxFile, getDropboxFileMetadata } from './dropboxService.js';
import { extractDocumentExcerpt, type DocumentExtractionResult } from './documentExtractor.js';
import { extractMedicalBillingLines } from './medicalRecordsExtractor.js';
import { auditService } from './auditService.js';
import type { FileSorterItem } from '../types/index.js';
import type { CaseMedicalRecordInsert } from '../types/medicalRecords.js';
import { folderLabelFromDropboxPath } from '../utils/dropboxFolderLabel.js';
import { providerFolderFromDropboxPath } from '../utils/providerNameQuality.js';
import { logger } from '../utils/logger.js';

const MEDICAL_DOC_TYPES = new Set(['Medical Records', 'Bills']);
const MEDICAL_FOLDER_LABELS = new Set(['Medical', 'LOP']);

function effectiveLineConfidence(
  lineConfidence: number | null,
  documentConfidence: number | null,
  textMethod: DocumentExtractionResult['method']
): number | null {
  let conf = lineConfidence ?? documentConfidence;
  if (conf == null) return null;
  if (documentConfidence != null) conf = Math.min(conf, documentConfidence);
  if (textMethod === 'pdf-vision' || textMethod === 'image-vision') {
    conf = conf * 0.9;
  }
  return Math.round(conf * 1000) / 1000;
}

export function isMedicalRecordsCaptureEnabled(): boolean {
  const env = process.env.MEDICAL_RECORDS_CAPTURE_ENABLED?.trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'off') return false;
  return isClientSupabaseConfigured();
}

export function shouldCaptureMedicalBilling(
  item: FileSorterItem,
  folderPath: string
): boolean {
  if (!isMedicalRecordsCaptureEnabled()) return false;

  const docType = item.suggested_document_type?.trim();
  if (docType && MEDICAL_DOC_TYPES.has(docType)) return true;

  const folderLabel = folderLabelFromDropboxPath(folderPath);
  if (folderLabel && MEDICAL_FOLDER_LABELS.has(folderLabel)) return true;

  const pathLower = folderPath.toLowerCase();
  return /\/(medical|lop)(\/|$)/.test(pathLower);
}

export async function captureMedicalRecordsAfterApprove(opts: {
  item: FileSorterItem;
  caseNumber: string;
  folderPath: string;
  dropboxPath: string;
  dropboxFileId?: string;
  fileBuffer?: Buffer;
  slackUserId?: string;
}): Promise<void> {
  if (!shouldCaptureMedicalBilling(opts.item, opts.folderPath)) return;

  const dropboxFileId =
    opts.dropboxFileId?.trim() ||
    (await getDropboxFileMetadata(opts.dropboxPath).catch(() => null))?.id ||
    null;

  if (!dropboxFileId) {
    logger.warn('Medical capture skipped — no Dropbox file id', {
      itemId: opts.item.id,
      dropboxPath: opts.dropboxPath,
    });
    return;
  }

  let dropboxPermalink: string | null = null;
  try {
    dropboxPermalink = await generateDropboxPermalink(opts.dropboxPath);
  } catch (err) {
    logger.warn('Medical capture — could not generate Dropbox permalink', {
      dropboxPath: opts.dropboxPath,
      err: String(err),
    });
  }

  let buffer = opts.fileBuffer;
  if (!buffer && opts.item.temp_storage_url) {
    try {
      buffer = await downloadTempAttachment(opts.item.id, opts.item.attachment_filename);
    } catch (err) {
      logger.warn('Medical capture — could not load temp attachment for extraction', {
        itemId: opts.item.id,
        err: String(err),
      });
    }
  }

  if (!buffer) {
    try {
      buffer = await downloadDropboxFile(opts.dropboxPath);
    } catch (err) {
      logger.warn('Medical capture — could not download file from Dropbox', {
        itemId: opts.item.id,
        dropboxPath: opts.dropboxPath,
        err: String(err),
      });
    }
  }

  if (!buffer) {
    logger.info('Medical capture skipped — no file bytes for extraction', {
      itemId: opts.item.id,
      filename: opts.item.attachment_filename,
    });
    return;
  }

  const extracted = await extractDocumentExcerpt(
    buffer,
    opts.item.attachment_mime_type ?? '',
    opts.item.attachment_filename
  );

  if (!extracted?.excerpt?.trim() || extracted.method === 'unsupported') {
    logger.info('Medical capture skipped — no extractable document text', {
      itemId: opts.item.id,
      method: extracted?.method ?? 'none',
    });
    return;
  }

  const billing = await extractMedicalBillingLines({
    documentText: extracted.excerpt,
    attachmentFilename: opts.item.attachment_filename,
    caseNumber: opts.caseNumber,
    providerFolderHint: providerFolderFromDropboxPath(opts.dropboxPath),
  });

  if (!billing.document_type || !billing.lines.length) {
    logger.info('Medical capture — no financial billing lines extracted', {
      itemId: opts.item.id,
      caseNumber: opts.caseNumber,
      summary: billing.document_summary,
    });
    await auditService.log(
      opts.item.id,
      'medical_records_capture_empty',
      { caseNumber: opts.caseNumber, summary: billing.document_summary },
      opts.slackUserId ?? undefined
    );
    return;
  }

  const caseId = await lookupClientCaseId(opts.caseNumber);

  const rows: CaseMedicalRecordInsert[] = billing.lines.map((line) => {
    const extraction_confidence = effectiveLineConfidence(
      line.line_confidence,
      billing.document_confidence,
      extracted.method
    );
    return {
      case_number: opts.caseNumber,
      case_id: caseId,
      tracker_entry_id: null,
      provider_id: null,
      provider_name: line.provider_name,
      account_number: line.account_number,
      date_of_service: line.date_of_service,
      original_charges: line.original_charges,
      current_balance: line.current_balance,
      final_pay_amount: line.final_pay_amount,
      reduced_from_amount: line.reduced_from_amount,
      payee_name: line.payee_name,
      payee_address: line.payee_address,
      document_type: billing.document_type!,
      payment_status: line.payment_status,
      dropbox_file_id: dropboxFileId,
      dropbox_file_path: opts.dropboxPath,
      dropbox_permalink: dropboxPermalink,
      review_status: 'needs_review',
      text_extraction_method: extracted.method,
      extraction_confidence,
      document_extraction_confidence: billing.document_confidence,
    };
  });

  const { inserted, updated, skipped } = await upsertCaseMedicalRecords(rows);

  logger.info('Medical records captured to client Supabase', {
    itemId: opts.item.id,
    caseNumber: opts.caseNumber,
    documentType: billing.document_type,
    inserted,
    updated,
    skipped,
    providers: billing.lines.map((l) => l.provider_name),
  });

  await auditService.log(
    opts.item.id,
    'medical_records_captured',
    {
      caseNumber: opts.caseNumber,
      documentType: billing.document_type,
      inserted,
      updated,
      skipped,
      dropboxFileId,
      dropboxPath: opts.dropboxPath,
      documentSummary: billing.document_summary,
      providers: billing.lines.map((l) => ({
        name: l.provider_name,
        paymentStatus: l.payment_status,
      })),
    },
    opts.slackUserId ?? undefined
  );
}
