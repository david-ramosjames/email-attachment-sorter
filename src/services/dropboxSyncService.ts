import { getEnv } from '../config/env.js';
import {
  listCases,
  updateCaseDropboxFolderName,
  upsertCaseFolder,
} from '../db/supabase.js';
import {
  parseCaseNumberFromDropboxFolder,
  RJL_STANDARD_SUBFOLDERS,
} from '../constants/rjlFolders.js';
import { listCaseFolders } from './dropboxService.js';
import { logger } from '../utils/logger.js';

export interface DropboxSyncResult {
  caseFoldersFound: number;
  casesLinked: number;
  subfoldersIndexed: number;
  unmatchedDropboxFolders: string[];
  syncedAt: string;
}

let lastSyncAt: Date | null = null;
let syncInProgress = false;

export function getLastDropboxSyncAt(): string | null {
  return lastSyncAt?.toISOString() ?? null;
}

function caseRootPath(dropboxFolderName: string): string {
  const root = getEnv().DROPBOX_CASES_ROOT.replace(/\/+$/, '');
  return `${root}/${dropboxFolderName}`.replace(/\/+/g, '/');
}

/**
 * Scans DROPBOX_CASES_ROOT for case folders, links them to case_slack_channels
 * by leading case number, and indexes the standard RJL subfolders.
 */
export async function syncDropboxStructure(): Promise<DropboxSyncResult> {
  if (syncInProgress) {
    logger.info('Dropbox sync already in progress, skipping');
    return {
      caseFoldersFound: 0,
      casesLinked: 0,
      subfoldersIndexed: 0,
      unmatchedDropboxFolders: [],
      syncedAt: lastSyncAt?.toISOString() ?? new Date().toISOString(),
    };
  }

  syncInProgress = true;
  try {
    const root = getEnv().DROPBOX_CASES_ROOT;
    const dropboxCaseFolders = await listCaseFolders(root);
    const knownCases = await listCases();
    const knownByNumber = new Map(knownCases.map((c) => [c.case_number, c]));

    let casesLinked = 0;
    let subfoldersIndexed = 0;
    const unmatchedDropboxFolders: string[] = [];

    for (const entry of dropboxCaseFolders) {
      const caseNumber = parseCaseNumberFromDropboxFolder(entry.name);
      if (!caseNumber) {
        unmatchedDropboxFolders.push(entry.name);
        continue;
      }

      const known = knownByNumber.get(caseNumber);
      if (known) {
        await updateCaseDropboxFolderName(caseNumber, entry.name);
        casesLinked++;
      } else {
        unmatchedDropboxFolders.push(entry.name);
      }

      // Index standard subfolders for every parsed case folder (even if not in Slack yet)
      const rootPath = caseRootPath(entry.name);
      for (const label of RJL_STANDARD_SUBFOLDERS) {
        const dropboxPath = `${rootPath}/${label}`.replace(/\/+/g, '/');
        await upsertCaseFolder(caseNumber, label, dropboxPath);
        subfoldersIndexed++;
      }
    }

    lastSyncAt = new Date();
    const result: DropboxSyncResult = {
      caseFoldersFound: dropboxCaseFolders.length,
      casesLinked,
      subfoldersIndexed,
      unmatchedDropboxFolders,
      syncedAt: lastSyncAt.toISOString(),
    };

    logger.info('Dropbox structure sync complete', { ...result });
    return result;
  } finally {
    syncInProgress = false;
  }
}

/** Run sync if stale; used before case matching on inbound email. */
export async function syncDropboxStructureIfStale(maxAgeMinutes: number): Promise<void> {
  const stale =
    !lastSyncAt || Date.now() - lastSyncAt.getTime() > maxAgeMinutes * 60 * 1000;
  if (!stale) return;

  try {
    await syncDropboxStructure();
  } catch (err) {
    logger.warn('Background Dropbox sync failed', { err: String(err) });
  }
}

export function startDropboxSyncScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0) return;

  const run = () => {
    syncDropboxStructure().catch((err) => {
      logger.error('Scheduled Dropbox sync failed', { err: String(err) });
    });
  };

  // Initial sync shortly after boot (let server finish starting)
  setTimeout(run, 15_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Dropbox sync scheduler started', { intervalMinutes });
}
