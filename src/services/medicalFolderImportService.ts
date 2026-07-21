import { randomUUID } from 'node:crypto';
import { getClientSupabase } from '../db/clientSupabase.js';
import { upsertCaseMedicalRecords } from '../db/clientMedicalRecords.js';
import type { CaseMedicalRecordInsert } from '../types/medicalRecords.js';
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
import { extractLopProvider } from './lopProviderExtractor.js';
import { extractMedicalBillingLines } from './medicalRecordsExtractor.js';
import { logger } from '../utils/logger.js';

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp']);
const GENERIC_MEDICAL_FOLDERS = new Set([
  'records request',
  'record requests',
  'medical records',
  'records',
  'billing',
  'bills',
  'pd',
]);

export interface MedicalImportFolderPreview {
  name: string;
  path: string;
  lopFiles: number;
  medicalFiles: number;
  providerFolders: string[];
}

export interface MedicalImportJob {
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

function pathBelowSection(path: string, casePath: string, section: 'lop' | 'medical'): string | null {
  const prefix = `${casePath}/${section}`.toLowerCase();
  const lower = path.toLowerCase();
  if (lower !== prefix && !lower.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length).replace(/^\/+/, '');
}

function selectImportFiles(tree: DropboxTreeEntry[], casePath: string): DropboxTreeEntry[] {
  return tree.filter(
    (entry) =>
      isSupportedFile(entry) &&
      (pathBelowSection(entry.path, casePath, 'lop') != null ||
        pathBelowSection(entry.path, casePath, 'medical') != null)
  );
}

function providerFolders(tree: DropboxTreeEntry[], casePath: string): string[] {
  const names = new Map<string, string>();
  for (const entry of tree) {
    if (entry.type !== 'folder') continue;
    const relative = pathBelowSection(entry.path, casePath, 'medical');
    if (!relative) continue;
    const first = relative.split('/')[0]?.trim().replace(/\s+\([A-Z]\)$/i, '');
    if (!first || GENERIC_MEDICAL_FOLDERS.has(first.toLowerCase())) continue;
    names.set(first.toLowerCase(), first);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function providerFromLopFilename(filename: string): string | null {
  const withoutExtension = filename.replace(/\.[^.]+$/, '').trim();
  const match = withoutExtension.match(/^lop\s*[-_–—]\s*(.+)$/i);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/\s+(?:round\s+draft|draft|signed|executed)$/i, '')
    .trim() || null;
}

async function previewFolder(name: string, path: string): Promise<MedicalImportFolderPreview> {
  const tree = await listDropboxTree(path);
  const files = selectImportFiles(tree, path);
  return {
    name,
    path,
    lopFiles: files.filter((f) => pathBelowSection(f.path, path, 'lop') != null).length,
    medicalFiles: files.filter((f) => pathBelowSection(f.path, path, 'medical') != null).length,
    providerFolders: providerFolders(tree, path),
  };
}

export async function previewMedicalImportFolders(
  caseNumber: string
): Promise<MedicalImportFolderPreview[]> {
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

async function upsertTrackerProvider(opts: {
  caseId: string;
  caseNumber: string;
  providerName: string;
  hasLop?: boolean;
}): Promise<void> {
  const client = getClientSupabase();
  if (!client || !opts.providerName.trim()) return;
  const providerName = opts.providerName.trim();
  const normalized = providerName.toLowerCase();

  // Avoid onConflict against a generated column (PostgREST is unreliable there).
  const { data: existing, error: lookupError } = await client
    .from('case_medical_tracker')
    .select('id, has_lop')
    .eq('case_id', opts.caseId)
    .eq('normalized_provider_name', normalized)
    .maybeSingle();
  if (lookupError) throw new Error(`medical tracker lookup failed: ${lookupError.message}`);

  if (existing?.id) {
    if (opts.hasLop === true && existing.has_lop !== true) {
      const { error } = await client
        .from('case_medical_tracker')
        .update({ has_lop: true, case_number: opts.caseNumber })
        .eq('id', existing.id);
      if (error) throw new Error(`medical tracker update failed: ${error.message}`);
    }
    return;
  }

  const payload: Record<string, unknown> = {
    case_id: opts.caseId,
    case_number: opts.caseNumber,
    provider_name: providerName,
  };
  if (opts.hasLop === true) payload.has_lop = true;
  const { error } = await client.from('case_medical_tracker').insert(payload);
  if (error) {
    // Race: another worker inserted the same provider
    if (error.code === '23505') return;
    throw new Error(`medical tracker insert failed: ${error.message}`);
  }
}

async function processMedicalFile(opts: {
  entry: DropboxTreeEntry;
  casePath: string;
  caseId: string;
  caseNumber: string;
}): Promise<{ imported: number; skipped: boolean }> {
  const isLopFolder = pathBelowSection(opts.entry.path, opts.casePath, 'lop') != null;
  const lopFromFilename = isLopFolder ? providerFromLopFilename(opts.entry.name) : null;
  // Seed tracker from LOP filenames even before download succeeds.
  if (lopFromFilename) {
    await upsertTrackerProvider({
      caseId: opts.caseId,
      caseNumber: opts.caseNumber,
      providerName: lopFromFilename,
      hasLop: true,
    });
  }

  let buffer: Buffer;
  try {
    buffer = await downloadDropboxFileByPathOrId({
      path: opts.entry.path,
      id: opts.entry.id,
    });
  } catch (err) {
    // Filename-based LOP seeding already applied — don't hard-fail the whole file.
    if (lopFromFilename) {
      logger.warn(
        `Silent medical import LOP seeded from filename but download failed: ${opts.entry.path} — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { imported: 0, skipped: true };
    }
    throw err;
  }
  const extracted = await extractDocumentExcerpt(buffer, mimeType(opts.entry.name), opts.entry.name);
  if (!extracted?.excerpt?.trim() || extracted.method === 'unsupported') {
    return { imported: 0, skipped: true };
  }

  let imported = 0;
  if (isLopFolder) {
    // Filename pattern is enough for most LOPs; only call AI when needed.
    let providerName = providerFromLopFilename(opts.entry.name);
    if (!providerName) {
      const lop = await extractLopProvider({
        filename: opts.entry.name,
        documentText: extracted.excerpt,
      });
      if (lop.isLop && lop.providerName && lop.confidence >= 0.6) {
        providerName = lop.providerName;
      }
    }
    if (providerName) {
      await upsertTrackerProvider({
        caseId: opts.caseId,
        caseNumber: opts.caseNumber,
        providerName,
        hasLop: true,
      });
    }
  }

  const billing = await extractMedicalBillingLines({
    documentText: extracted.excerpt,
    attachmentFilename: opts.entry.name,
    caseNumber: opts.caseNumber,
  });
  if (!billing.document_type || !billing.lines.length || !opts.entry.id) {
    return { imported, skipped: imported === 0 };
  }

  let permalink: string | null = null;
  try {
    permalink = await generateDropboxPermalink(opts.entry.path);
  } catch (err) {
    logger.warn('Silent medical import could not create permalink', {
      path: opts.entry.path,
      err: String(err),
    });
  }

  const rows: CaseMedicalRecordInsert[] = billing.lines.map((line) => ({
    case_number: opts.caseNumber,
    case_id: opts.caseId,
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
    dropbox_file_id: opts.entry.id!,
    dropbox_file_path: opts.entry.path,
    dropbox_permalink: permalink,
    review_status: 'needs_review',
    text_extraction_method: extracted.method,
    extraction_confidence: line.line_confidence ?? billing.document_confidence,
    document_extraction_confidence: billing.document_confidence,
  }));
  const result = await upsertCaseMedicalRecords(rows);
  imported += result.inserted + result.updated;

  for (const line of billing.lines) {
    await upsertTrackerProvider({
      caseId: opts.caseId,
      caseNumber: opts.caseNumber,
      providerName: line.provider_name,
    });
  }

  return { imported, skipped: result.inserted + result.updated === 0 };
}

function jobFromRow(row: Record<string, unknown>): MedicalImportJob {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    caseNumber: row.case_number as string,
    dropboxCasePath: row.dropbox_case_path as string,
    status: row.status as MedicalImportJob['status'],
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

export async function getMedicalImportJob(jobId: string): Promise<MedicalImportJob | null> {
  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const { data, error } = await client
    .from('medical_import_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? jobFromRow(data as Record<string, unknown>) : null;
}

async function updateJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const { error } = await client.from('medical_import_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function runMedicalImport(jobId: string, preview: MedicalImportFolderPreview): Promise<void> {
  const job = await getMedicalImportJob(jobId);
  if (!job) return;
  const tree = await listDropboxTree(preview.path);
  const files = selectImportFiles(tree, preview.path);
  await updateJob(jobId, {
    status: 'running',
    total_files: files.length,
    started_at: new Date().toISOString(),
  });

  for (const providerName of providerFolders(tree, preview.path)) {
    await upsertTrackerProvider({
      caseId: job.caseId,
      caseNumber: job.caseNumber,
      providerName,
    });
  }

  let processed = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  for (const entry of files) {
    try {
      const result = await processMedicalFile({
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
      // Log as a single string so Railway's truncated UI still shows the reason.
      logger.warn(`Silent medical import file failed: ${entry.path} — ${message}`);
    }
    processed++;
    await updateJob(jobId, {
      processed_files: processed,
      imported_records: imported,
      skipped_files: skipped,
      failed_files: failed,
      ...(failureSamples.length
        ? { error_message: failureSamples.join(' | ') }
        : {}),
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

export async function startMedicalImport(opts: {
  caseId: string;
  caseNumber: string;
  folderPath: string;
  startedBy: string;
}): Promise<MedicalImportJob> {
  const candidates = await previewMedicalImportFolders(opts.caseNumber);
  const preview = candidates.find((candidate) => candidate.path === opts.folderPath);
  if (!preview) throw new Error('Dropbox folder does not match this case');

  const client = getClientSupabase();
  if (!client) throw new Error('Client Supabase is not configured');
  const id = randomUUID();
  const { data, error } = await client
    .from('medical_import_jobs')
    .insert({
      id,
      case_id: opts.caseId,
      case_number: opts.caseNumber,
      dropbox_case_path: opts.folderPath,
      status: 'queued',
      total_files: preview.lopFiles + preview.medicalFiles,
      started_by: opts.startedBy,
    })
    .select('*')
    .single();
  if (error) throw error;

  void runMedicalImport(id, preview).catch(async (err) => {
    logger.error('Silent medical import failed', { jobId: id, err: String(err) });
    await updateJob(id, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    }).catch(() => undefined);
  });

  return jobFromRow(data as Record<string, unknown>);
}
