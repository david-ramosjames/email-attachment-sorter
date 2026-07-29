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
import { preferredProviderName, providerNamesMatch } from '../utils/providerNameMatch.js';
import { providerFolderFromDropboxPath } from '../utils/providerNameQuality.js';
import {
  listExpenseVendorFolders,
  processExpenseFile,
  selectExpenseImportFiles,
} from './expensesFolderImportService.js';

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
  /** All files under LOP, Medical, and Expenses (any type). */
  scannedFiles: number;
  /** Supported files that the import will process. */
  includedFiles: number;
  /** Scanned files skipped (unsupported type). */
  excludedFiles: number;
  lopFiles: number;
  medicalFiles: number;
  expenseFiles: number;
  providerFolders: string[];
  vendorFolders: string[];
}

export type ImportFileSection = 'lop' | 'medical' | 'expenses';

export interface ImportExcludedFile {
  name: string;
  path: string;
  url: string | null;
  reason: string;
  section: ImportFileSection;
}

export interface MedicalImportJob {
  id: string;
  caseId: string;
  caseNumber: string;
  dropboxCasePath: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** Supported files processed by this job. */
  totalFiles: number;
  scannedFiles: number;
  excludedFiles: number;
  excludedFileList: ImportExcludedFile[];
  processedFiles: number;
  importedRecords: number;
  skippedFiles: number;
  /** Files skipped because records already existed (dedup). */
  alreadyImportedFiles: number;
  /** Files with no extractable / billable data (not an error). */
  noDataFiles: number;
  failedFiles: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type ImportFileSkipReason = 'already_imported' | 'no_data';

type ImportFileResult = {
  imported: number;
  skipReason?: ImportFileSkipReason;
};

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

function pathBelowExpenses(path: string, casePath: string): string | null {
  const prefix = `${casePath}/expenses`.toLowerCase();
  const lower = path.toLowerCase();
  if (lower !== prefix && !lower.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length).replace(/^\/+/, '');
}

function importSectionForPath(path: string, casePath: string): ImportFileSection | null {
  if (pathBelowSection(path, casePath, 'lop') != null) return 'lop';
  if (pathBelowSection(path, casePath, 'medical') != null) return 'medical';
  if (pathBelowExpenses(path, casePath) != null) return 'expenses';
  return null;
}

function classifyCaseDropboxFiles(tree: DropboxTreeEntry[], casePath: string) {
  const medicalIncluded = selectMedicalImportFiles(tree, casePath);
  const expenseIncluded = selectExpenseImportFiles(tree, casePath);
  const included = [...medicalIncluded, ...expenseIncluded];
  const includedPaths = new Set(included.map((entry) => entry.path));
  const excluded: Array<{ entry: DropboxTreeEntry; section: ImportFileSection; reason: string }> =
    [];

  for (const entry of tree) {
    if (entry.type !== 'file') continue;
    const section = importSectionForPath(entry.path, casePath);
    if (!section || includedPaths.has(entry.path)) continue;
    const ext = extension(entry.name);
    excluded.push({
      entry,
      section,
      reason: ext ? `Unsupported type (.${ext})` : 'Unsupported file type',
    });
  }

  return {
    included,
    excluded,
    scannedCount: included.length + excluded.length,
  };
}

async function buildExcludedFileList(
  excluded: Array<{ entry: DropboxTreeEntry; section: ImportFileSection; reason: string }>
): Promise<ImportExcludedFile[]> {
  const out: ImportExcludedFile[] = [];
  const chunkSize = 8;
  for (let i = 0; i < excluded.length; i += chunkSize) {
    const chunk = excluded.slice(i, i + chunkSize);
    const rows = await Promise.all(
      chunk.map(async ({ entry, section, reason }) => {
        let url: string | null = null;
        try {
          url = await generateDropboxPermalink(entry.path);
        } catch (err) {
          logger.warn('Silent import could not create excluded-file permalink', {
            path: entry.path,
            err: String(err),
          });
        }
        return {
          name: entry.name,
          path: entry.path,
          url,
          reason,
          section,
        };
      })
    );
    out.push(...rows);
  }
  return out.sort(
    (a, b) =>
      a.section.localeCompare(b.section) || a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

function selectMedicalImportFiles(tree: DropboxTreeEntry[], casePath: string): DropboxTreeEntry[] {
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
  const { included, excluded, scannedCount } = classifyCaseDropboxFiles(tree, path);
  const medicalIncluded = included.filter((f) => pathBelowSection(f.path, path, 'medical') != null);
  const lopIncluded = included.filter((f) => pathBelowSection(f.path, path, 'lop') != null);
  const expenseIncluded = included.filter((f) => pathBelowExpenses(f.path, path) != null);
  return {
    name,
    path,
    scannedFiles: scannedCount,
    includedFiles: included.length,
    excludedFiles: excluded.length,
    lopFiles: lopIncluded.length,
    medicalFiles: medicalIncluded.length,
    expenseFiles: expenseIncluded.length,
    providerFolders: providerFolders(tree, path),
    vendorFolders: listExpenseVendorFolders(tree, path),
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

type TrackerRow = {
  id: string;
  provider_name: string;
  has_lop: boolean | null;
  lop_files: TrackerLopFile[];
  treatment_finished_date: string | null;
  medical_requested_date: string | null;
  medical_received_date: string | null;
  billing_requested_date: string | null;
  billing_received_date: string | null;
};

type TrackerLopFile = {
  name: string;
  url: string;
  path: string;
  fileId: string | null;
};

function mergeTrackerLopFiles(...groups: TrackerLopFile[][]): TrackerLopFile[] {
  const files = new Map<string, TrackerLopFile>();
  for (const file of groups.flat()) {
    const key = file.fileId || file.path || file.url;
    if (key) files.set(key, file);
  }
  return [...files.values()];
}

function trackerFilledScore(row: TrackerRow): number {
  let score = 0;
  if (row.has_lop === true) score += 3;
  if (row.has_lop === false) score += 1;
  for (const key of [
    'treatment_finished_date',
    'medical_requested_date',
    'medical_received_date',
    'billing_requested_date',
    'billing_received_date',
  ] as const) {
    if (row[key]) score += 1;
  }
  score += Math.min(row.provider_name.trim().length, 40) / 40;
  return score;
}

/** Collapse near-duplicate tracker rows already on the case (e.g. LOP short name + full bill name). */
async function consolidateTrackerDuplicates(caseId: string): Promise<void> {
  const client = getClientSupabase();
  if (!client) return;

  const { data, error } = await client
    .from('case_medical_tracker')
    .select(
      'id, provider_name, has_lop, lop_files, treatment_finished_date, medical_requested_date, medical_received_date, billing_requested_date, billing_received_date'
    )
    .eq('case_id', caseId);
  if (error) throw new Error(`medical tracker list failed: ${error.message}`);

  const rows = (data ?? []) as TrackerRow[];
  const clusters: TrackerRow[][] = [];

  for (const row of rows) {
    const cluster = clusters.find((group) =>
      group.some((member) => providerNamesMatch(member.provider_name, row.provider_name))
    );
    if (cluster) cluster.push(row);
    else clusters.push([row]);
  }

  let removed = 0;

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    const mergedName = cluster.reduce(
      (best, row) => preferredProviderName(best, row.provider_name),
      cluster[0]!.provider_name
    );
    // Prefer the row that already owns the merged display name so rename can't collide.
    const exactName = cluster.find(
      (row) => row.provider_name.trim().toLowerCase() === mergedName.trim().toLowerCase()
    );
    const winner =
      exactName ??
      [...cluster].sort((a, b) => trackerFilledScore(b) - trackerFilledScore(a))[0]!;
    const loserIds = cluster.filter((row) => row.id !== winner.id).map((row) => row.id);
    const hasLop = cluster.some((row) => row.has_lop === true)
      ? true
      : cluster.some((row) => row.has_lop === false)
        ? false
        : null;

    // Save merged values before deleting anything. Rename separately after deleting
    // losers because one may still own mergedName under the unique constraint.
    const { error: updateError } = await client
      .from('case_medical_tracker')
      .update({
        has_lop: hasLop,
        lop_files: mergeTrackerLopFiles(...cluster.map((row) => row.lop_files ?? [])),
        treatment_finished_date:
          winner.treatment_finished_date ??
          cluster.find((r) => r.treatment_finished_date)?.treatment_finished_date ??
          null,
        medical_requested_date:
          winner.medical_requested_date ??
          cluster.find((r) => r.medical_requested_date)?.medical_requested_date ??
          null,
        medical_received_date:
          winner.medical_received_date ??
          cluster.find((r) => r.medical_received_date)?.medical_received_date ??
          null,
        billing_requested_date:
          winner.billing_requested_date ??
          cluster.find((r) => r.billing_requested_date)?.billing_requested_date ??
          null,
        billing_received_date:
          winner.billing_received_date ??
          cluster.find((r) => r.billing_received_date)?.billing_received_date ??
          null,
      })
      .eq('id', winner.id);
    if (updateError) {
      throw new Error(`medical tracker consolidate update failed: ${updateError.message}`);
    }

    if (loserIds.length) {
      const { error: deleteError } = await client
        .from('case_medical_tracker')
        .delete()
        .in('id', loserIds);
      if (deleteError) {
        throw new Error(`medical tracker consolidate delete failed: ${deleteError.message}`);
      }
      removed += loserIds.length;
    }

    if (winner.provider_name !== mergedName) {
      const { error: renameError } = await client
        .from('case_medical_tracker')
        .update({ provider_name: mergedName })
        .eq('id', winner.id);
      if (renameError) {
        throw new Error(`medical tracker consolidate rename failed: ${renameError.message}`);
      }
    }
  }

  if (removed) {
    logger.info('Consolidated medical tracker near-duplicates', {
      caseId,
      removed,
    });
  }
}

async function upsertTrackerProvider(opts: {
  caseId: string;
  caseNumber: string;
  providerName: string;
  hasLop?: boolean;
  lopFile?: TrackerLopFile | null;
}): Promise<void> {
  const client = getClientSupabase();
  if (!client || !opts.providerName.trim()) return;
  const providerName = opts.providerName.trim();

  // Exact + fuzzy match against all providers on the case (LOP short names vs full bill names).
  const { data: existingRows, error: lookupError } = await client
    .from('case_medical_tracker')
    .select('id, provider_name, has_lop, lop_files')
    .eq('case_id', opts.caseId);
  if (lookupError) throw new Error(`medical tracker lookup failed: ${lookupError.message}`);

  const matches = (existingRows ?? []).filter((row) =>
    providerNamesMatch(providerName, String(row.provider_name ?? ''))
  );

  if (matches.length > 0) {
    const preferred = matches.reduce(
      (best, row) => preferredProviderName(best, String(row.provider_name ?? '')),
      providerName
    );
    const exact = matches.find(
      (row) => String(row.provider_name ?? '').trim().toLowerCase() === preferred.trim().toLowerCase()
    );
    const winner = exact ?? matches[0]!;
    const loserIds = matches.filter((row) => row.id !== winner.id).map((row) => row.id as string);
    const lopFiles = mergeTrackerLopFiles(
      ...matches.map((row) => (Array.isArray(row.lop_files) ? row.lop_files : [])),
      opts.lopFile ? [opts.lopFile] : []
    );
    const mergedHasLop =
      opts.hasLop === true || matches.some((row) => row.has_lop === true)
        ? true
        : winner.has_lop;

    // Persist merged data before removing duplicates.
    const { error: mergeError } = await client
      .from('case_medical_tracker')
      .update({
        case_number: opts.caseNumber,
        has_lop: mergedHasLop,
        lop_files: lopFiles,
      })
      .eq('id', winner.id);
    if (mergeError) throw new Error(`medical tracker update failed: ${mergeError.message}`);

    if (loserIds.length) {
      const { error: deleteError } = await client
        .from('case_medical_tracker')
        .delete()
        .in('id', loserIds);
      if (deleteError) throw new Error(`medical tracker update failed: ${deleteError.message}`);
    }

    if (preferred !== winner.provider_name) {
      const { error } = await client
        .from('case_medical_tracker')
        .update({ provider_name: preferred })
        .eq('id', winner.id);
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
  if (opts.lopFile) payload.lop_files = [opts.lopFile];
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
}): Promise<ImportFileResult> {
  const isLopFolder = pathBelowSection(opts.entry.path, opts.casePath, 'lop') != null;
  const lopFromFilename = isLopFolder ? providerFromLopFilename(opts.entry.name) : null;
  let permalink: string | null = null;
  if (isLopFolder) {
    try {
      permalink = await generateDropboxPermalink(opts.entry.path);
    } catch (err) {
      logger.warn('Silent medical import could not create LOP permalink', {
        path: opts.entry.path,
        err: String(err),
      });
    }
  }
  const lopFile: TrackerLopFile | null =
    isLopFolder && permalink
      ? {
          name: opts.entry.name,
          url: permalink,
          path: opts.entry.path,
          fileId: opts.entry.id ?? null,
        }
      : null;
  // Seed tracker from LOP filenames even before download succeeds.
  if (lopFromFilename) {
    await upsertTrackerProvider({
      caseId: opts.caseId,
      caseNumber: opts.caseNumber,
      providerName: lopFromFilename,
      hasLop: true,
      lopFile,
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
      return { imported: 0 };
    }
    throw err;
  }
  const extracted = await extractDocumentExcerpt(buffer, mimeType(opts.entry.name), opts.entry.name);
  if (!extracted?.excerpt?.trim() || extracted.method === 'unsupported') {
    // LOP tracker may still have been seeded from the filename.
    return lopFromFilename ? { imported: 0 } : { imported: 0, skipReason: 'no_data' };
  }

  let imported = 0;
  let lopUpdated = Boolean(lopFromFilename);
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
        lopFile,
      });
      lopUpdated = true;
    }
  }

  const providerFolderHint = providerFolderFromDropboxPath(opts.entry.path);
  const billing = await extractMedicalBillingLines({
    documentText: extracted.excerpt,
    attachmentFilename: opts.entry.name,
    caseNumber: opts.caseNumber,
    providerFolderHint,
  });
  if (!billing.document_type || !billing.lines.length || !opts.entry.id) {
    // LOP-only files that updated the tracker are successes, not skips.
    if (lopUpdated || imported > 0) return { imported };
    return { imported: 0, skipReason: 'no_data' };
  }

  if (!permalink) {
    try {
      permalink = await generateDropboxPermalink(opts.entry.path);
    } catch (err) {
      logger.warn('Silent medical import could not create permalink', {
        path: opts.entry.path,
        err: String(err),
      });
    }
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

  if (result.inserted + result.updated === 0) {
    return { imported: 0, skipReason: 'already_imported' };
  }
  return { imported };
}

function jobFromRow(row: Record<string, unknown>): MedicalImportJob {
  const skippedFiles = Number(row.skipped_files ?? 0);
  const alreadyImportedFiles = Number(row.already_imported_files ?? 0);
  const noDataFiles = Number(row.no_data_files ?? 0);
  const totalFiles = Number(row.total_files ?? 0);
  const scannedFiles = Number(row.scanned_files ?? 0) || totalFiles;
  const excludedFiles =
    Number(row.excluded_files ?? 0) || Math.max(0, scannedFiles - totalFiles);
  const rawExcluded = row.excluded_file_list;
  const excludedFileList = Array.isArray(rawExcluded)
    ? (rawExcluded as ImportExcludedFile[])
    : [];
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    caseNumber: row.case_number as string,
    dropboxCasePath: row.dropbox_case_path as string,
    status: row.status as MedicalImportJob['status'],
    totalFiles,
    scannedFiles,
    excludedFiles,
    excludedFileList,
    processedFiles: Number(row.processed_files ?? 0),
    importedRecords: Number(row.imported_records ?? 0),
    skippedFiles,
    alreadyImportedFiles,
    noDataFiles,
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
  if (!error) return;
  // Migration 011 / 012 may not be applied yet — retry without newer columns.
  if (
    'already_imported_files' in patch ||
    'no_data_files' in patch ||
    'scanned_files' in patch ||
    'excluded_files' in patch ||
    'excluded_file_list' in patch
  ) {
    const {
      already_imported_files: _a,
      no_data_files: _n,
      scanned_files: _s,
      excluded_files: _e,
      excluded_file_list: _l,
      ...legacyPatch
    } = patch;
    const { error: legacyError } = await client
      .from('medical_import_jobs')
      .update(legacyPatch)
      .eq('id', jobId);
    if (legacyError) throw legacyError;
    return;
  }
  throw error;
}

async function runMedicalImport(jobId: string, preview: MedicalImportFolderPreview): Promise<void> {
  const job = await getMedicalImportJob(jobId);
  if (!job) return;
  const tree = await listDropboxTree(preview.path);
  const { included: files, excluded, scannedCount } = classifyCaseDropboxFiles(tree, preview.path);
  await updateJob(jobId, {
    status: 'running',
    total_files: files.length,
    scanned_files: scannedCount,
    excluded_files: excluded.length,
    started_at: new Date().toISOString(),
  });

  const medicalFiles = files.filter(
    (entry) =>
      pathBelowSection(entry.path, preview.path, 'lop') != null ||
      pathBelowSection(entry.path, preview.path, 'medical') != null
  );
  const expenseFiles = files.filter((entry) => pathBelowExpenses(entry.path, preview.path) != null);

  // Merge any existing near-duplicates before seeding more provider rows.
  await consolidateTrackerDuplicates(job.caseId);

  for (const providerName of providerFolders(tree, preview.path)) {
    await upsertTrackerProvider({
      caseId: job.caseId,
      caseNumber: job.caseNumber,
      providerName,
    });
  }

  let processed = 0;
  let imported = 0;
  let alreadyImported = 0;
  let noData = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  const applyResult = (result: ImportFileResult) => {
    imported += result.imported;
    if (result.skipReason === 'already_imported') alreadyImported++;
    if (result.skipReason === 'no_data') noData++;
  };

  const progressPatch = () => ({
    processed_files: processed,
    imported_records: imported,
    skipped_files: alreadyImported + noData,
    already_imported_files: alreadyImported,
    no_data_files: noData,
    failed_files: failed,
    ...(failureSamples.length ? { error_message: failureSamples.join(' | ') } : {}),
  });

  for (const entry of medicalFiles) {
    try {
      applyResult(
        await processMedicalFile({
          entry,
          casePath: preview.path,
          caseId: job.caseId,
          caseNumber: job.caseNumber,
        })
      );
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
    await updateJob(jobId, progressPatch());
  }

  for (const entry of expenseFiles) {
    try {
      applyResult(
        await processExpenseFile({
          entry,
          casePath: preview.path,
          caseId: job.caseId,
          caseNumber: job.caseNumber,
        })
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (failureSamples.length < 5) {
        failureSamples.push(`${entry.name}: ${message}`);
      }
      logger.warn(`Silent expenses import file failed: ${entry.path} — ${message}`);
    }
    processed++;
    await updateJob(jobId, progressPatch());
  }

  // Catch near-duplicates created mid-run (e.g. LOP short name then full bill name).
  await consolidateTrackerDuplicates(job.caseId);

  const excludedFileList = await buildExcludedFileList(excluded);

  await updateJob(jobId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    processed_files: processed,
    imported_records: imported,
    skipped_files: alreadyImported + noData,
    already_imported_files: alreadyImported,
    no_data_files: noData,
    failed_files: failed,
    scanned_files: scannedCount,
    excluded_files: excluded.length,
    excluded_file_list: excludedFileList,
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
      total_files: preview.includedFiles,
      scanned_files: preview.scannedFiles,
      excluded_files: preview.excludedFiles,
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
