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
import {
  discoverCasesRoot,
  getCasesRootPath,
  listCaseFolders,
} from './dropboxService.js';
import { logger } from '../utils/logger.js';

export interface DropboxSyncResult {
  casesRootUsed: string;
  casesRootSource: string | null;
  caseFoldersFound: number;
  casesLinked: number;
  subfoldersIndexed: number;
  unmatchedDropboxFolders: string[];
  discoveryTried?: Array<{ path: string; source: string; folderCount: number }>;
  syncedAt: string;
}

let lastSyncAt: Date | null = null;
let syncInProgress = false;

export function getLastDropboxSyncAt(): string | null {
  return lastSyncAt?.toISOString() ?? null;
}

function caseRootPath(casesRoot: string, dropboxFolderName: string): string {
  const root = casesRoot.replace(/\/+$/, '');
  return `${root}/${dropboxFolderName}`.replace(/\/+/g, '/');
}

/**
 * Scans Dropbox cases root for case folders, links to case_slack_channels,
 * and indexes standard RJL subfolders.
 */
export async function syncDropboxStructure(): Promise<DropboxSyncResult> {
  if (syncInProgress) {
    logger.info('Dropbox sync already in progress, skipping');
    return {
      casesRootUsed: getCasesRootPath(),
      casesRootSource: null,
      caseFoldersFound: 0,
      casesLinked: 0,
      subfoldersIndexed: 0,
      unmatchedDropboxFolders: [],
      syncedAt: lastSyncAt?.toISOString() ?? new Date().toISOString(),
    };
  }

  syncInProgress = true;
  try {
    let casesRoot = getCasesRootPath();
    let casesRootSource: string | null = 'cached_or_env';
    let discoveryTried: DropboxSyncResult['discoveryTried'];

    let dropboxCaseFolders = await listCaseFolders(casesRoot);

    if (dropboxCaseFolders.length === 0) {
      logger.info('No folders at configured root, running Dropbox discovery');
      const discovery = await discoverCasesRoot();
      discoveryTried = discovery.tried;
      if (discovery.path) {
        casesRoot = discovery.path;
        casesRootSource = discovery.source;
        dropboxCaseFolders = await listCaseFolders(casesRoot);
      } else {
        logger.error('Dropbox cases root not found', { tried: discovery.tried });
      }
    }

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

      const rootPath = caseRootPath(casesRoot, entry.name);
      for (const label of RJL_STANDARD_SUBFOLDERS) {
        const dropboxPath = `${rootPath}/${label}`.replace(/\/+/g, '/');
        await upsertCaseFolder(caseNumber, label, dropboxPath);
        subfoldersIndexed++;
      }
    }

    lastSyncAt = new Date();
    const result: DropboxSyncResult = {
      casesRootUsed: casesRoot,
      casesRootSource,
      caseFoldersFound: dropboxCaseFolders.length,
      casesLinked,
      subfoldersIndexed,
      unmatchedDropboxFolders: unmatchedDropboxFolders.slice(0, 20),
      discoveryTried,
      syncedAt: lastSyncAt.toISOString(),
    };

    logger.info('Dropbox structure sync complete', { ...result });
    return result;
  } finally {
    syncInProgress = false;
  }
}

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

  setTimeout(run, 15_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Dropbox sync scheduler started', { intervalMinutes });
}
