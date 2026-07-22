import { randomUUID } from 'node:crypto';
import { insertCaseExpenses } from '../db/clientCaseExpenses.js';
import { getClientSupabase } from '../db/clientSupabase.js';
import type { CaseExpenseInsert } from '../types/caseExpenses.js';
import { parseCaseNumberFromDropboxFolder } from '../constants/rjlFolders.js';
import {
  downloadDropboxFileByPathOrId,
  generateDropboxPermalink,
  getCasesRootPath,
  listCaseFolders,
  listDropboxTree,
  type DropboxTreeEntry,
} from './dropboxService.js';
import { extractDocumentExcerpt } from './documentExtractor.js';
import { extractCaseExpenses } from './caseExpensesExtractor.js';
import { logger } from '../utils/logger.js';

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp']);

/** First-level Expenses subfolders that are organizational, not vendor names. */
const GENERIC_EXPENSE_FOLDERS = new Set([
  'receipts',
  'invoices',
  'bills',
  'checks',
  'check copies',
  'credit cards',
  'statements',
  'misc',
  'miscellaneous',
  'other',
  'archive',
  'archived',
]);

export interface ExpensesImportFolderPreview {
  name: string;
  path: string;
  expenseFiles: number;
  vendorFolders: string[];
  hasExpensesFolder: boolean;
}

export interface ExpensesImportJob {
  id: string;
  caseId: string;
  caseNumber: string;
  dropboxCasePath: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  totalFiles: number;
  processedFiles: number;
  importedRecords: number;
  skippedFiles: number;
  failedFiles: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function isSupportedFile(entry: DropboxTreeEntry): boolean {
  return entry.type === 'file' && SUPPORTED_EXTENSIONS.has(extension(entry.name));
}

function mimeType(filename: string): string {
  switch (extension(filename)) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function pathBelowExpenses(path: string, casePath: string): string | null {
  const prefix = `${casePath}/expenses`.toLowerCase();
  const lower = path.toLowerCase();
  if (lower !== prefix && !lower.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length).replace(/^\/+/, '');
}

function selectImportFiles(tree: DropboxTreeEntry[], casePath: string): DropboxTreeEntry[] {
  return tree.filter((entry) => isSupportedFile(entry) && pathBelowExpenses(entry.path, casePath) != null);
}

export function selectExpenseImportFiles(
  tree: DropboxTreeEntry[],
  casePath: string
): DropboxTreeEntry[] {
  return selectImportFiles(tree, casePath);
}

function vendorFolders(tree: DropboxTreeEntry[], casePath: string): string[] {
  const names = new Map<string, string>();
  for (const entry of tree) {
    if (entry.type !== 'folder') continue;
    const relative = pathBelowExpenses(entry.path, casePath);
    if (!relative) continue;
    const first = relative.split('/')[0]?.trim();
    if (!first || GENERIC_EXPENSE_FOLDERS.has(first.toLowerCase())) continue;
    names.set(first.toLowerCase(), first);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export function listExpenseVendorFolders(
  tree: DropboxTreeEntry[],
  casePath: string
): string[] {
  return vendorFolders(tree, casePath);
}

function vendorFolderFromPath(filePath: string, casePath: string): string | null {
  const relative = pathBelowExpenses(filePath, casePath);
  if (!relative) return null;
  const first = relative.split('/')[0]?.trim();
  if (!first || GENERIC_EXPENSE_FOLDERS.has(first.toLowerCase())) return null;
  // File sitting directly under Expenses/ (no vendor subfolder)
  if (!relative.includes('/')) return null;
  return first;
}

function hasExpensesFolder(tree: DropboxTreeEntry[], casePath: string): boolean {
  const prefix = `${casePath}/expenses`.toLowerCase();
  return tree.some((entry) => {
    const lower = entry.path.toLowerCase();
    return lower === prefix || lower.startsWith(`${prefix}/`);
  });
}

function effectiveConfidence(
  lineConfidence: number | null,
  documentConfidence: number | null,
  textMethod: string
): number | null {
  let conf = lineConfidence ?? documentConfidence;
  if (conf == null) return null;
  if (documentConfidence != null) conf = Math.min(conf, documentConfidence);
  if (textMethod === 'pdf-vision' || textMethod === 'image-vision') conf *= 0.9;
  return Math.round(conf * 1000) / 1000;
}

async function previewFolder(name: string, path: string): Promise<ExpensesImportFolderPreview> {
  const tree = await listDropboxTree(path);
  const files = selectImportFiles(tree, path);
  return {
    name,
    path,
    expenseFiles: files.length,
    vendorFolders: vendorFolders(tree, path),
    hasExpensesFolder: hasExpensesFolder(tree, path),
  };
}

export async function previewExpensesImportFolders(
  caseNumber: string
): Promise<ExpensesImportFolderPreview[]> {
  const normalized = caseNumber.trim().toLowerCase();
  if (!normalized) return [];
  const folders = await listCaseFolders(getCasesRootPath());
  const matches = folders.filter((folder) => {
    const parsed = parseCaseNumberFromDropboxFolder(folder.name)?.toLowerCase();
    if (parsed) return parsed === normalized;
    return new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.|\\s|$)`).test(
      folder.name.toLowerCase()
    );
  });
  return Promise.all(matches.slice(0, 5).map((folder) => previewFolder(folder.name, folder.path)));
}

export async function processExpenseFile(opts: {
  entry: DropboxTreeEntry;
  casePath: string;
  caseId: string;
  caseNumber: string;
}): Promise<{ imported: number; skipped: boolean }> {
  if (!opts.entry.id) {
    return { imported: 0, skipped: true };
  }

  const buffer = await downloadDropboxFileByPathOrId({
    path: opts.entry.path,
    id: opts.entry.id,
  });
  const extracted = await extractDocumentExcerpt(buffer, mimeType(opts.entry.name), opts.entry.name);
  if (!extracted?.excerpt?.trim() || extracted.method === 'unsupported') {
    return { imported: 0, skipped: true };
  }

  const vendorFolderHint = vendorFolderFromPath(opts.entry.path, opts.casePath);
  const result = await extractCaseExpenses({
    documentText: extracted.excerpt,
    attachmentFilename: opts.entry.name,
    caseNumber: opts.caseNumber,
    vendorFolderHint: vendorFolderHint ?? undefined,
  });

  if (!result.expenses.length) {
    return { imported: 0, skipped: true };
  }

  let permalink: string | null = null;
  try {
    permalink = await generateDropboxPermalink(opts.entry.path);
  } catch (err) {
    logger.warn('Silent expenses import could not create permalink', {
      path: opts.entry.path,
      err: String(err),
    });
  }

  const rows: CaseExpenseInsert[] = result.expenses.map((exp) => {
    let vendorName = exp.vendor_name;
    // Prefer folder name when extraction returns a weak/generic vendor.
    if (
      vendorFolderHint &&
      (!vendorName ||
        /^(unknown|n\/?a|vendor|various|misc|miscellaneous)$/i.test(vendorName.trim()))
    ) {
      vendorName = vendorFolderHint;
    }
    return {
      case_number: opts.caseNumber,
      case_id: opts.caseId,
      vendor_name: vendorName,
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
      dropbox_file_id: opts.entry.id!,
      dropbox_file_path: opts.entry.path,
      dropbox_permalink: permalink,
      document_type: exp.document_type ?? result.document_type,
      review_status: 'needs_review',
      text_extraction_method: extracted.method,
      extraction_confidence: effectiveConfidence(
        exp.line_confidence,
        result.document_confidence,
        extracted.method
      ),
      document_extraction_confidence: result.document_confidence,
    };
  });

  const { inserted, skipped } = await insertCaseExpenses(rows);
  return { imported: inserted, skipped: inserted === 0 && skipped > 0 };
}

function jobFromRow(row: Record<string, unknown>): ExpensesImportJob {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    caseNumber: row.case_number as string,
    dropboxCasePath: row.dropbox_case_path as string,
    status: row.status as ExpensesImportJob['status'],
    totalFiles: Number(row.total_files ?? 0),
    processedFiles: Number(row.processed_files ?? 0),
    importedRecords: Number(row.imported_records ?? 0),
    skippedFiles: Number(row.skipped_files ?? 0),
    failedFiles: Number(row.failed_files ?? 0),
    errorMessage: (row.error_message as string) ?? null,
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
  };
}

export async function getExpensesImportJob(jobId: string): Promise<ExpensesImportJob | null> {
  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const { data, error } = await client
    .from('case_expense_import_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? jobFromRow(data as Record<string, unknown>) : null;
}

async function updateJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const { error } = await client.from('case_expense_import_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function runExpensesImport(jobId: string, preview: ExpensesImportFolderPreview): Promise<void> {
  const job = await getExpensesImportJob(jobId);
  if (!job) return;
  const tree = await listDropboxTree(preview.path);
  const files = selectImportFiles(tree, preview.path);
  await updateJob(jobId, {
    status: 'running',
    total_files: files.length,
    started_at: new Date().toISOString(),
  });

  let processed = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  for (const entry of files) {
    try {
      const result = await processExpenseFile({
        entry,
        casePath: preview.path,
        caseId: job.caseId,
        caseNumber: job.caseNumber,
      });
      imported += result.imported;
      if (result.skipped) skipped++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (failureSamples.length < 5) {
        failureSamples.push(`${entry.name}: ${message}`);
      }
      logger.warn(`Silent expenses import file failed: ${entry.path} — ${message}`);
    }
    processed++;
    await updateJob(jobId, {
      processed_files: processed,
      imported_records: imported,
      skipped_files: skipped,
      failed_files: failed,
      ...(failureSamples.length ? { error_message: failureSamples.join(' | ') } : {}),
    });
  }

  await updateJob(jobId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    processed_files: processed,
    imported_records: imported,
    skipped_files: skipped,
    failed_files: failed,
    error_message: failureSamples.length ? failureSamples.join(' | ') : null,
  });
}

export async function startExpensesImport(opts: {
  caseId: string;
  caseNumber: string;
  folderPath: string;
  startedBy: string;
}): Promise<ExpensesImportJob> {
  const candidates = await previewExpensesImportFolders(opts.caseNumber);
  const preview = candidates.find((candidate) => candidate.path === opts.folderPath);
  if (!preview) throw new Error('Dropbox folder does not match this case');
  if (!preview.hasExpensesFolder) {
    throw new Error('No Expenses folder found under this Dropbox case folder');
  }

  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const id = randomUUID();
  const { data, error } = await client
    .from('case_expense_import_jobs')
    .insert({
      id,
      case_id: opts.caseId,
      case_number: opts.caseNumber,
      dropbox_case_path: opts.folderPath,
      status: 'queued',
      total_files: preview.expenseFiles,
      started_by: opts.startedBy,
    })
    .select('*')
    .single();
  if (error) throw error;

  void runExpensesImport(id, preview).catch(async (err) => {
    logger.error('Silent expenses import failed', { jobId: id, err: String(err) });
    await updateJob(id, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    }).catch(() => undefined);
  });

  return jobFromRow(data as Record<string, unknown>);
}
