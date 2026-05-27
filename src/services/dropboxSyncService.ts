import { getEnv } from '../config/env.js';
import {
  batchUpsertCaseFolders,
  listCases,
  updateCaseDropboxFolderName,
} from '../db/supabase.js';
import {
  parseCaseNumberFromDropboxFolder,
  RJL_STANDARD_SUBFOLDERS,
} from '../constants/rjlFolders.js';
import {
  discoverCasesRoot,
  listCaseFolders,
  resolveCasesRootFromEnv,
} from './dropboxService.js';
import { logger } from '../utils/logger.js';

export interface DropboxSyncResult {
  casesRootUsed: string;
  casesRootSource: string | null;
  namespaceId: string | null;
  caseFoldersFound: number;
  casesLinked: number;
  subfoldersIndexed: number;
  unmatchedDropboxFolders: string[];
  discoveryTried?: Array<{ path: string; source: string; folderCount: number }>;
  syncedAt: string;
  skipped?: boolean;
  error?: string;
}

let lastSyncAt: Date | null = null;
let syncInProgress = false;

export function getLastDropboxSyncAt(): string | null {
  return lastSyncAt?.toISOString() ?? null;
}

export function isSyncInProgress(): boolean {
  return syncInProgress;
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
    logger.info('Dropbox sync already in progress');
    return {
      casesRootUsed: '',
      casesRootSource: null,
      namespaceId: null,
      caseFoldersFound: 0,
      casesLinked: 0,
      subfoldersIndexed: 0,
      unmatchedDropboxFolders: [],
      syncedAt: new Date().toISOString(),
      skipped: true,
      error:
        'Sync already running (started by scheduler). Wait 2–5 minutes and try again, or check Railway logs.',
    };
  }

  syncInProgress = true;
  try {
    let casesRoot = '';
    let casesRootSource: string | null = null;
    let namespaceId: string | null = getEnv().DROPBOX_NAMESPACE_ID ?? null;
    let discoveryTried: DropboxSyncResult['discoveryTried'];

    // Fast path: env vars you already confirmed work
    const fromEnv = await resolveCasesRootFromEnv();
    if (fromEnv) {
      casesRoot = fromEnv.path;
      casesRootSource = 'env';
      namespaceId = fromEnv.namespaceId;
      logger.info('Using Dropbox root from env', fromEnv);
    } else {
      logger.info('Env fast path failed, running full discovery');
      const discovery = await discoverCasesRoot();
      discoveryTried = discovery.tried;

      if (!discovery.path) {
        const connErr = discovery.dropboxConnection.error;
        return {
          casesRootUsed: '',
          casesRootSource: null,
          namespaceId: discovery.namespaceId,
          caseFoldersFound: 0,
          casesLinked: 0,
          subfoldersIndexed: 0,
          unmatchedDropboxFolders: [],
          discoveryTried: discovery.tried,
          syncedAt: new Date().toISOString(),
          error: connErr ?? 'Could not find RAMOS JAMES LAW CASES in Dropbox. Set DROPBOX_NAMESPACE_ID=13922258995 in Railway.',
        };
      }

      casesRoot = discovery.path;
      casesRootSource = discovery.source;
      namespaceId = discovery.namespaceId;
    }

    const dropboxCaseFolders = await listCaseFolders(casesRoot, namespaceId);
    if (dropboxCaseFolders.length === 0) {
      return {
        casesRootUsed: casesRoot,
        casesRootSource,
        namespaceId,
        caseFoldersFound: 0,
        casesLinked: 0,
        subfoldersIndexed: 0,
        unmatchedDropboxFolders: [],
        discoveryTried,
        syncedAt: new Date().toISOString(),
        error: `Listed 0 folders at ${casesRoot}. Check DROPBOX_NAMESPACE_ID in Railway.`,
      };
    }

    const knownCases = await listCases();
    const knownByNumber = new Map(knownCases.map((c) => [c.case_number, c]));

    const folderRows: Array<{
      case_number: string;
      folder_label: string;
      dropbox_path: string;
    }> = [];
    const unmatchedDropboxFolders: string[] = [];
    let casesLinked = 0;

    for (const entry of dropboxCaseFolders) {
      const caseNumber = parseCaseNumberFromDropboxFolder(entry.name);
      if (!caseNumber) {
        unmatchedDropboxFolders.push(entry.name);
        continue;
      }

      if (knownByNumber.has(caseNumber)) {
        await updateCaseDropboxFolderName(caseNumber, entry.name);
        casesLinked++;
      } else {
        unmatchedDropboxFolders.push(entry.name);
      }

      const rootPath = caseRootPath(casesRoot, entry.name);
      for (const label of RJL_STANDARD_SUBFOLDERS) {
        folderRows.push({
          case_number: caseNumber,
          folder_label: label,
          dropbox_path: `${rootPath}/${label}`.replace(/\/+/g, '/'),
        });
      }
    }

    const subfoldersIndexed = await batchUpsertCaseFolders(folderRows);

    lastSyncAt = new Date();
    const result: DropboxSyncResult = {
      casesRootUsed: casesRoot,
      casesRootSource,
      namespaceId,
      caseFoldersFound: dropboxCaseFolders.length,
      casesLinked,
      subfoldersIndexed,
      unmatchedDropboxFolders: unmatchedDropboxFolders.slice(0, 20),
      discoveryTried,
      syncedAt: lastSyncAt.toISOString(),
    };

    logger.info('Dropbox structure sync complete', { ...result });
    return result;
  } catch (err) {
    logger.error('Dropbox sync error', { err: String(err) });
    return {
      casesRootUsed: '',
      casesRootSource: null,
      namespaceId: null,
      caseFoldersFound: 0,
      casesLinked: 0,
      subfoldersIndexed: 0,
      unmatchedDropboxFolders: [],
      syncedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
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
    if (syncInProgress) {
      logger.info('Skipping scheduled sync — previous sync still running');
      return;
    }
    syncDropboxStructure().catch((err) => {
      logger.error('Scheduled Dropbox sync failed', { err: String(err) });
    });
  };

  // Delay first sync so deploy + manual testing isn't blocked
  setTimeout(run, 120_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Dropbox sync scheduler started', { intervalMinutes, firstRunDelaySec: 120 });
}
