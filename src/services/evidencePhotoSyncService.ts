import { getEnv } from '../config/env.js';
import { getAppSetting, upsertAppSetting } from '../db/supabase.js';
import { requireClientSupabase } from '../db/clientSupabase.js';
import {
  extractDropboxError,
  getCasesRootPath,
  getLatestDropboxCursor,
  isDropboxCursorReset,
  isDropboxPathNotFound,
  listDropboxChanges,
  listDropboxFilesRecursive,
  type DropboxFileChange,
  type DropboxListChange,
} from './dropboxService.js';
import { logger } from '../utils/logger.js';

const CURSOR_KEY = 'evidence_photos_dropbox_cursor';
const RECONCILE_KEY = 'evidence_photos_last_reconcile';
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;
const RECONCILE_CONCURRENCY = 4;
const NIGHTLY_WINDOW_MINUTES = 180;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
};

interface CaseRoot {
  caseNumber: string;
  caseId: string | null;
  rootLower: string;
}

interface EvidencePhotoRow {
  id: string;
  dropbox_file_id: string;
  dropbox_path: string;
  dropbox_rev: string | null;
  analyzed_rev: string | null;
  original_filename: string;
  mime_type: string | null;
  file_size: number | null;
  dropbox_client_modified: string | null;
  case_number: string;
  case_id: string | null;
  human_edited: boolean;
  deleted_at: string | null;
}

const ROW_COLUMNS =
  'id, dropbox_file_id, dropbox_path, dropbox_rev, analyzed_rev, original_filename, mime_type, ' +
  'file_size, dropbox_client_modified, case_number, case_id, human_edited, deleted_at';

export interface EvidenceApplyCounts {
  inserted: number;
  updated: number;
  requeued: number;
  softDeleted: number;
  unchanged: number;
}

export interface EvidenceReconcileResult extends EvidenceApplyCounts {
  caseFolders: number;
  failedCases: string[];
  photosSeen: number;
  startedAt: string;
  finishedAt: string;
  skipped?: string;
}

let reconcileInProgress = false;
let changesInProgress = false;
let changesRerunRequested = false;
let lastReconcile: EvidenceReconcileResult | null = null;
let lastChangesAt: string | null = null;
let lastChangesError: string | null = null;
let onPendingQueued: (() => void) | null = null;

/** Called after sync queues photos for analysis (wired to the worker in index.ts). */
export function setEvidencePendingListener(listener: () => void): void {
  onPendingQueued = listener;
}

function emptyCounts(): EvidenceApplyCounts {
  return { inserted: 0, updated: 0, requeued: 0, softDeleted: 0, unchanged: 0 };
}

function addCounts(into: EvidenceApplyCounts, from: EvidenceApplyCounts): void {
  into.inserted += from.inserted;
  into.updated += from.updated;
  into.requeued += from.requeued;
  into.softDeleted += from.softDeleted;
  into.unchanged += from.unchanged;
}

export function evidenceMimeType(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return MIME_BY_EXTENSION[filename.slice(dot).toLowerCase()] ?? null;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** One root per case: the parent folder of its indexed RJL subfolders. */
async function loadCaseRoots(): Promise<CaseRoot[]> {
  const supabase = requireClientSupabase();
  const [folders, cases] = await Promise.all([
    selectAllPages<{ case_number: string; dropbox_path: string }>((from, to) =>
      supabase
        .from('case_folders')
        .select('case_number, dropbox_path')
        .order('id')
        .range(from, to)
    ),
    selectAllPages<{ id: string; case_number: string | null }>((from, to) =>
      supabase
        .from('cases')
        .select('id, case_number')
        .not('case_number', 'is', null)
        .order('id')
        .range(from, to)
    ),
  ]);

  const caseIdByNumber = new Map<string, string>();
  for (const c of cases) {
    if (c.case_number) caseIdByNumber.set(c.case_number.trim(), c.id);
  }

  const roots = new Map<string, CaseRoot>();
  for (const folder of folders) {
    const root = parentPath(folder.dropbox_path);
    const rootLower = root.toLowerCase();
    if (roots.has(rootLower)) continue;
    roots.set(rootLower, {
      caseNumber: folder.case_number,
      caseId: caseIdByNumber.get(folder.case_number.trim()) ?? null,
      rootLower,
    });
  }

  // Longest first so nested roots win.
  return [...roots.values()].sort((a, b) => b.rootLower.length - a.rootLower.length);
}

function caseForPath(roots: CaseRoot[], path: string): CaseRoot | null {
  const lower = path.toLowerCase();
  for (const root of roots) {
    if (lower.startsWith(`${root.rootLower}/`)) return root;
  }
  return null;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return Date.parse(a) === Date.parse(b);
}

async function loadRowsByFileIds(ids: string[]): Promise<Map<string, EvidencePhotoRow>> {
  const byId = new Map<string, EvidencePhotoRow>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await requireClientSupabase()
      .from('evidence_photos')
      .select(ROW_COLUMNS)
      .in('dropbox_file_id', chunk);
    if (error) throw new Error(`Load evidence photos failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as EvidencePhotoRow[]) {
      byId.set(row.dropbox_file_id, row);
    }
  }
  return byId;
}

async function softDeleteByFileIds(ids: string[]): Promise<number> {
  let total = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await requireClientSupabase()
      .from('evidence_photos')
      .update({ deleted_at: now })
      .in('dropbox_file_id', ids.slice(i, i + ID_CHUNK))
      .is('deleted_at', null)
      .select('id');
    if (error) throw new Error(`Soft delete evidence photos failed: ${error.message}`);
    total += data?.length ?? 0;
  }
  return total;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Dropbox reports deletions by path only — covers a deleted file or a deleted folder. */
async function softDeleteByPaths(paths: string[]): Promise<number> {
  let total = 0;
  const now = new Date().toISOString();
  for (const path of paths) {
    const escaped = escapeLike(path);
    for (const pattern of [escaped, `${escaped}/%`]) {
      const { data, error } = await requireClientSupabase()
        .from('evidence_photos')
        .update({ deleted_at: now })
        .ilike('dropbox_path', pattern)
        .is('deleted_at', null)
        .select('id');
      if (error) throw new Error(`Soft delete evidence photos by path failed: ${error.message}`);
      total += data?.length ?? 0;
    }
  }
  return total;
}

/**
 * Upsert Dropbox file metadata into evidence_photos.
 * Moves update location only; a new rev re-queues analysis unless staff edited the row.
 */
async function applyFiles(files: DropboxFileChange[], roots: CaseRoot[]): Promise<EvidenceApplyCounts> {
  const counts = emptyCounts();
  const photos = files.filter((f) => evidenceMimeType(f.name));
  if (!photos.length) return counts;

  const existing = await loadRowsByFileIds([...new Set(photos.map((f) => f.id))]);
  const inserts: Record<string, unknown>[] = [];
  const outsideIds: string[] = [];

  for (const file of photos) {
    const target = caseForPath(roots, file.path);
    const row = existing.get(file.id);

    if (!target) {
      if (row && !row.deleted_at) outsideIds.push(file.id);
      continue;
    }

    const location = {
      dropbox_path: file.path,
      original_filename: file.name,
      mime_type: evidenceMimeType(file.name),
      file_size: file.size,
      dropbox_client_modified: file.clientModified,
      case_number: target.caseNumber,
      case_id: target.caseId,
    };

    if (!row) {
      inserts.push({
        ...location,
        dropbox_file_id: file.id,
        dropbox_rev: file.rev,
        analysis_status: 'pending',
      });
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (row.dropbox_path !== location.dropbox_path) patch.dropbox_path = location.dropbox_path;
    if (row.original_filename !== location.original_filename) {
      patch.original_filename = location.original_filename;
    }
    if (row.mime_type !== location.mime_type) patch.mime_type = location.mime_type;
    if (row.file_size !== location.file_size) patch.file_size = location.file_size;
    if (!sameInstant(row.dropbox_client_modified, location.dropbox_client_modified)) {
      patch.dropbox_client_modified = location.dropbox_client_modified;
    }
    if (row.case_number !== location.case_number) patch.case_number = location.case_number;
    if (row.case_id !== location.case_id) patch.case_id = location.case_id;
    if (row.deleted_at) patch.deleted_at = null;

    let requeue = false;
    if (row.dropbox_rev !== file.rev) {
      patch.dropbox_rev = file.rev;
      if (!row.human_edited && row.analyzed_rev !== file.rev) {
        Object.assign(patch, {
          analysis_status: 'pending',
          analysis_error: null,
          analysis_attempts: 0,
          processing_started_at: null,
        });
        requeue = true;
      }
    }

    if (!Object.keys(patch).length) {
      counts.unchanged++;
      continue;
    }

    const { error } = await requireClientSupabase().from('evidence_photos').update(patch).eq('id', row.id);
    if (error) throw new Error(`Update evidence photo failed: ${error.message}`);
    counts.updated++;
    if (requeue) counts.requeued++;
  }

  for (let i = 0; i < inserts.length; i += ID_CHUNK) {
    const chunk = inserts.slice(i, i + ID_CHUNK);
    const { data, error } = await requireClientSupabase()
      .from('evidence_photos')
      .upsert(chunk, { onConflict: 'dropbox_file_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`Insert evidence photos failed: ${error.message}`);
    counts.inserted += data?.length ?? 0;
  }

  if (outsideIds.length) counts.softDeleted += await softDeleteByFileIds(outsideIds);
  return counts;
}

/** Apply changes in Dropbox order so delete-then-re-add (and moves) resolve correctly. */
async function applyChanges(changes: DropboxListChange[], roots: CaseRoot[]): Promise<EvidenceApplyCounts> {
  const counts = emptyCounts();
  let i = 0;
  while (i < changes.length) {
    const type = changes[i].type;
    let j = i;
    while (j < changes.length && changes[j].type === type) j++;
    const run = changes.slice(i, j);
    if (type === 'file') {
      addCounts(counts, await applyFiles(run as DropboxFileChange[], roots));
    } else {
      counts.softDeleted += await softDeleteByPaths(run.map((c) => c.path));
    }
    i = j;
  }
  return counts;
}

async function loadCursor(): Promise<string | null> {
  const stored = await getAppSetting<{ cursor?: string }>(CURSOR_KEY);
  return typeof stored?.cursor === 'string' && stored.cursor ? stored.cursor : null;
}

async function saveCursor(cursor: string | null): Promise<void> {
  await upsertAppSetting(CURSOR_KEY, {
    cursor,
    root: getCasesRootPath(),
    savedAt: new Date().toISOString(),
  });
}

/**
 * Full scan of every case folder: inserts missing photos, fixes stale paths/revs,
 * and soft-deletes rows whose files are gone. Also serves as the initial import.
 */
export async function runEvidenceReconciliation(): Promise<EvidenceReconcileResult> {
  const startedAt = new Date().toISOString();
  if (reconcileInProgress) {
    return {
      ...emptyCounts(),
      caseFolders: 0,
      failedCases: [],
      photosSeen: 0,
      startedAt,
      finishedAt: startedAt,
      skipped: 'already_running',
    };
  }

  reconcileInProgress = true;
  try {
    // Take the change cursor first so edits made during the scan are replayed afterwards.
    if (!(await loadCursor())) {
      await saveCursor(await getLatestDropboxCursor(getCasesRootPath()));
      logger.info('Evidence photos: saved initial Dropbox change cursor', {
        root: getCasesRootPath(),
      });
    }

    const roots = await loadCaseRoots();
    const counts = emptyCounts();
    const seen = new Set<string>();
    const failedCases = new Set<string>();
    let photosSeen = 0;

    let next = 0;
    const worker = async () => {
      while (next < roots.length) {
        const root = roots[next++];
        let files: DropboxFileChange[] = [];
        try {
          files = await listDropboxFilesRecursive(root.rootLower);
        } catch (err) {
          if (!isDropboxPathNotFound(err)) {
            failedCases.add(root.caseNumber);
            logger.warn('Evidence photos: case folder listing failed', {
              caseNumber: root.caseNumber,
              root: root.rootLower,
              err: extractDropboxError(err),
            });
            continue;
          }
        }
        // Files under a nested root belong to that root's pass.
        const own = files.filter((f) => caseForPath(roots, f.path) === root);
        for (const f of own) {
          if (evidenceMimeType(f.name)) {
            seen.add(f.id);
            photosSeen++;
          }
        }
        try {
          addCounts(counts, await applyFiles(own, roots));
        } catch (err) {
          failedCases.add(root.caseNumber);
          logger.error('Evidence photos: applying case folder failed', {
            caseNumber: root.caseNumber,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: RECONCILE_CONCURRENCY }, worker));

    if (roots.length) {
      const stale = await selectAllPages<{ dropbox_file_id: string; case_number: string; updated_at: string }>(
        (from, to) =>
          requireClientSupabase()
            .from('evidence_photos')
            .select('dropbox_file_id, case_number, updated_at')
            .is('deleted_at', null)
            .order('id')
            .range(from, to)
      );
      // Rows touched after the scan started were written by live change processing.
      const missing = stale
        .filter(
          (r) =>
            !seen.has(r.dropbox_file_id) &&
            !failedCases.has(r.case_number) &&
            Date.parse(r.updated_at) < Date.parse(startedAt)
        )
        .map((r) => r.dropbox_file_id);
      if (missing.length) counts.softDeleted += await softDeleteByFileIds(missing);
    }

    const result: EvidenceReconcileResult = {
      ...counts,
      caseFolders: roots.length,
      failedCases: [...failedCases],
      photosSeen,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    lastReconcile = result;
    logger.info('Evidence photos reconciliation complete', { ...result });
    if (counts.inserted || counts.requeued) onPendingQueued?.();
    return result;
  } finally {
    reconcileInProgress = false;
  }
}

/** Replay Dropbox changes since the saved cursor. Single-flight; coalesces webhook bursts. */
export async function processEvidenceChanges(): Promise<void> {
  if (changesInProgress) {
    changesRerunRequested = true;
    return;
  }
  changesInProgress = true;
  try {
    do {
      changesRerunRequested = false;
      await processEvidenceChangesOnce();
    } while (changesRerunRequested);
  } finally {
    changesInProgress = false;
  }
}

async function processEvidenceChangesOnce(): Promise<void> {
  let cursor = await loadCursor();
  if (!cursor) {
    void runEvidenceReconciliation().catch((err) => {
      logger.error('Evidence photos initial import failed', { err: String(err) });
    });
    return;
  }

  const roots = await loadCaseRoots();
  const counts = emptyCounts();
  let pages = 0;
  try {
    for (;;) {
      const page = await listDropboxChanges(cursor);
      if (page.changes.length) addCounts(counts, await applyChanges(page.changes, roots));
      cursor = page.cursor;
      await saveCursor(cursor);
      pages++;
      if (!page.hasMore) break;
    }
    lastChangesAt = new Date().toISOString();
    lastChangesError = null;
  } catch (err) {
    if (isDropboxCursorReset(err)) {
      logger.warn('Evidence photos: Dropbox cursor reset — running full reconciliation');
      await saveCursor(null);
      void runEvidenceReconciliation().catch((e) => {
        logger.error('Evidence photos reconciliation after reset failed', { err: String(e) });
      });
      return;
    }
    lastChangesError = extractDropboxError(err);
    throw err;
  }

  if (counts.inserted || counts.updated || counts.softDeleted) {
    logger.info('Evidence photos: applied Dropbox changes', { ...counts, pages });
  }
  if (counts.inserted || counts.requeued) onPendingQueued?.();
}

/** Fire-and-forget entry point for the webhook and poll timer. */
export function triggerEvidenceChanges(source: string): void {
  void processEvidenceChanges().catch((err) => {
    logger.error('Evidence photos change processing failed', {
      source,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

function localClock(tz: string, at: Date): { dateKey: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm: `${get('hour')}:${get('minute')}`,
  };
}

async function runNightlyIfDue(): Promise<void> {
  const env = getEnv();
  const tz = env.SLACK_REMINDER_TIMEZONE.trim() || 'America/Chicago';
  const { dateKey, hhmm } = localClock(tz, new Date());
  const target = /^\d{2}:\d{2}$/.test(env.EVIDENCE_PHOTOS_RECONCILE_TIME)
    ? env.EVIDENCE_PHOTOS_RECONCILE_TIME
    : '02:00';
  const minutes = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const sinceTarget = minutes(hhmm) - minutes(target);
  if (sinceTarget < 0 || sinceTarget > NIGHTLY_WINDOW_MINUTES) return;

  const last = await getAppSetting<{ dateKey?: string }>(RECONCILE_KEY);
  if (last?.dateKey === dateKey) return;

  await upsertAppSetting(RECONCILE_KEY, { dateKey, startedAt: new Date().toISOString() });
  await runEvidenceReconciliation();
}

export function getEvidenceSyncStatus() {
  return {
    reconcileInProgress,
    changesInProgress,
    lastReconcile,
    lastChangesAt,
    lastChangesError,
  };
}

export function startEvidencePhotoSyncScheduler(): void {
  const env = getEnv();
  if (!env.EVIDENCE_PHOTOS_ENABLED) {
    logger.info('Evidence photos disabled (EVIDENCE_PHOTOS_ENABLED=false)');
    return;
  }

  // Startup: replay changes (or run the initial import when no cursor exists yet).
  setTimeout(() => triggerEvidenceChanges('startup'), 90_000);

  if (env.EVIDENCE_PHOTOS_POLL_INTERVAL_MINUTES > 0) {
    setInterval(
      () => triggerEvidenceChanges('poll'),
      env.EVIDENCE_PHOTOS_POLL_INTERVAL_MINUTES * 60 * 1000
    );
  }

  setInterval(() => {
    if (reconcileInProgress) return;
    runNightlyIfDue().catch((err) => {
      logger.error('Evidence photos nightly reconciliation failed', { err: String(err) });
    });
  }, 15 * 60 * 1000);

  logger.info('Evidence photo sync scheduler started', {
    pollIntervalMinutes: env.EVIDENCE_PHOTOS_POLL_INTERVAL_MINUTES,
    reconcileTime: env.EVIDENCE_PHOTOS_RECONCILE_TIME,
  });
}
