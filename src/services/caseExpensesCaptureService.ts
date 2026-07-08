import { insertCaseExpenses, lookupClientCaseId } from '../db/clientCaseExpenses.js';
import { isClientSupabaseConfigured } from '../db/clientSupabase.js';
import { generateDropboxPermalink, getDropboxFileMetadata } from './dropboxService.js';
import { extractDocumentExcerpt, type DocumentExtractionResult } from './documentExtractor.js';
import { extractCaseExpenses } from './caseExpensesExtractor.js';
import { auditService } from './auditService.js';
import type { FileSorterItem } from '../types/index.js';
import type { CaseExpenseInsert } from '../types/caseExpenses.js';
import { loadAttachmentBytesForItem } from '../utils/attachmentBuffer.js';
import { folderLabelFromDropboxPath } from '../utils/dropboxFolderLabel.js';
import { logger } from '../utils/logger.js';

const MEDICAL_DOC_TYPES = new Set(['Medical Records', 'Bills']);

function effectiveConfidence(
  lineConfidence: number | null,
  documentConfidence: number | null,
  textMethod: DocumentExtractionResult['method']
): number | null {
  let conf = lineConfidence ?? documentConfidence;
  if (conf == null) return null;
  if (documentConfidence != null) conf = Math.min(conf, documentConfidence);
  if (textMethod === 'pdf-vision' || textMethod === 'image-vision') conf *= 0.9;
  return Math.round(conf * 1000) / 1000;
}

export function isCaseExpensesCaptureEnabled(): boolean {
  const env = process.env.CASE_EXPENSES_CAPTURE_ENABLED?.trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'off') return false;
  return isClientSupabaseConfigured();
}

/** Capture case costs filed to the Expenses folder (not medical provider bills). */
export function shouldCaptureCaseExpenses(item: FileSorterItem, folderPath: string): boolean {
  if (!isCaseExpensesCaptureEnabled()) return false;

  const docType = item.suggested_document_type?.trim();
  if (docType && MEDICAL_DOC_TYPES.has(docType)) return false;

  const folderLabel = folderLabelFromDropboxPath(folderPath);
  if (folderLabel === 'Expenses') return true;

  return /\/expenses(\/|$)/i.test(folderPath);
}

export async function captureCaseExpensesAfterApprove(opts: {
  item: FileSorterItem;
  caseNumber: string;
  folderPath: string;
  dropboxPath: string;
  dropboxFileId?: string;
  fileBuffer?: Buffer;
  slackUserId?: string;
}): Promise<void> {
  if (!shouldCaptureCaseExpenses(opts.item, opts.folderPath)) return;

  const dropboxFileId =
    opts.dropboxFileId?.trim() ||
    (await getDropboxFileMetadata(opts.dropboxPath).catch(() => null))?.id ||
    null;

  if (!dropboxFileId) {
    logger.warn('Case expense capture skipped — no Dropbox file id', {
      itemId: opts.item.id,
      dropboxPath: opts.dropboxPath,
    });
    return;
  }

  let dropboxPermalink: string | null = null;
  try {
    dropboxPermalink = await generateDropboxPermalink(opts.dropboxPath);
  } catch (err) {
    logger.warn('Case expense capture — could not generate Dropbox permalink', {
      dropboxPath: opts.dropboxPath,
      err: String(err),
    });
  }

  let buffer = opts.fileBuffer;
  if (!buffer) {
    try {
      buffer = await loadAttachmentBytesForItem(opts.item, { dropboxPath: opts.dropboxPath });
    } catch (err) {
      logger.warn('Case expense capture — could not load attachment bytes', {
        itemId: opts.item.id,
        err: String(err),
      });
    }
  }

  if (!buffer) {
    logger.info('Case expense capture skipped — no file bytes', { itemId: opts.item.id });
    return;
  }

  const extracted = await extractDocumentExcerpt(
    buffer,
    opts.item.attachment_mime_type ?? '',
    opts.item.attachment_filename
  );

  if (!extracted?.excerpt?.trim() || extracted.method === 'unsupported') {
    logger.info('Case expense capture skipped — no extractable text', { itemId: opts.item.id });
    return;
  }

  const result = await extractCaseExpenses({
    documentText: extracted.excerpt,
    attachmentFilename: opts.item.attachment_filename,
    caseNumber: opts.caseNumber,
  });

  if (!result.expenses.length) {
    logger.info('Case expense capture — no expense lines extracted', {
      itemId: opts.item.id,
      caseNumber: opts.caseNumber,
      summary: result.document_summary,
    });
    await auditService.log(
      opts.item.id,
      'case_expenses_capture_empty',
      { caseNumber: opts.caseNumber, summary: result.document_summary },
      opts.slackUserId ?? undefined
    );
    return;
  }

  const caseId = await lookupClientCaseId(opts.caseNumber);

  const rows: CaseExpenseInsert[] = result.expenses.map((exp) => ({
    case_number: opts.caseNumber,
    case_id: caseId,
    vendor_name: exp.vendor_name,
    expense_type: exp.expense_type,
    description: exp.description,
    invoice_number: exp.invoice_number,
    invoice_date: exp.invoice_date,
    service_date: exp.service_date,
    amount: exp.amount,
    payment_status: exp.payment_status,
    paid_amount: exp.paid_amount,
    check_number: exp.check_number,
    payee_name: exp.payee_name,
    payee_address: exp.payee_address,
    reference_number: exp.reference_number,
    related_party: exp.related_party,
    dropbox_file_id: dropboxFileId,
    dropbox_file_path: opts.dropboxPath,
    dropbox_permalink: dropboxPermalink,
    document_type: exp.document_type ?? result.document_type,
    review_status: 'needs_review',
    text_extraction_method: extracted.method,
    extraction_confidence: effectiveConfidence(
      exp.line_confidence,
      result.document_confidence,
      extracted.method
    ),
    document_extraction_confidence: result.document_confidence,
  }));

  const { inserted, skipped } = await insertCaseExpenses(rows);

  logger.info('Case expenses captured to client Supabase', {
    itemId: opts.item.id,
    caseNumber: opts.caseNumber,
    inserted,
    skipped,
    vendors: result.expenses.map((e) => e.vendor_name),
  });

  await auditService.log(
    opts.item.id,
    'case_expenses_captured',
    {
      caseNumber: opts.caseNumber,
      inserted,
      skipped,
      dropboxFileId,
      dropboxPath: opts.dropboxPath,
      vendors: result.expenses.map((e) => e.vendor_name),
    },
    opts.slackUserId ?? undefined
  );
}
