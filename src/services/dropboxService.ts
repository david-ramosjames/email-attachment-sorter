import { Dropbox } from 'dropbox';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let dbx: Dropbox | null = null;

/** Resolved after first successful discovery (may differ from env). */
let resolvedCasesRoot: string | null = null;

function getDropbox(): Dropbox {
  if (!dbx) {
    dbx = new Dropbox({ accessToken: getEnv().DROPBOX_ACCESS_TOKEN });
  }
  return dbx;
}

export function getCasesRootPath(): string {
  return resolvedCasesRoot ?? getEnv().DROPBOX_CASES_ROOT;
}

function normalizePath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p.replace(/\/+/g, '/');
}

function matchesCasesRootHint(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('ramos james law cases') ||
    lower.includes('ramos james law') ||
    (lower.includes('ramos') && lower.includes('cases'))
  );
}

export interface DropboxFolderEntry {
  name: string;
  path: string;
}

async function listFolderEntriesInternal(
  path: string
): Promise<{ entries: DropboxFolderEntry[]; error?: string }> {
  const normalized = path === '' ? '' : normalizePath(path);
  const entries: DropboxFolderEntry[] = [];
  let cursor: string | undefined;

  try {
    let result = await getDropbox().filesListFolder({ path: normalized });
    for (;;) {
      for (const e of result.result.entries) {
        if (e['.tag'] === 'folder') {
          entries.push({
            name: e.name,
            path: (e as { path_display: string }).path_display,
          });
        }
      }
      if (!result.result.has_more) break;
      cursor = result.result.cursor;
      result = await getDropbox().filesListFolderContinue({ cursor });
    }
    return { entries };
  } catch (err) {
    const message = extractDropboxError(err);
    logger.debug('listFolderEntries failed', { path: normalized, error: message });
    return { entries: [], error: message };
  }
}

function extractDropboxError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      error?: { error_summary?: string; error?: { '.tag'?: string } };
      message?: string;
    };
    if (e.error?.error_summary) return e.error.error_summary;
    if (e.message) return e.message;
  }
  return String(err);
}

export interface DropboxConnectionStatus {
  ok: boolean;
  accountEmail?: string;
  accountName?: string;
  error?: string;
}

/** Verifies DROPBOX_ACCESS_TOKEN works before folder discovery. */
export async function verifyDropboxConnection(): Promise<DropboxConnectionStatus> {
  try {
    const account = await getDropbox().usersGetCurrentAccount();
    return {
      ok: true,
      accountEmail: account.result.email,
      accountName: account.result.name.display_name,
    };
  } catch (err) {
    return { ok: false, error: extractDropboxError(err) };
  }
}

export interface DiscoverCasesRootResult {
  path: string | null;
  source: string | null;
  caseFolderCount: number;
  tried: Array<{ path: string; source: string; folderCount: number; error?: string }>;
  dropboxConnection: DropboxConnectionStatus;
}

/**
 * Finds the RAMOS JAMES LAW CASES root — including shared/mounted folders.
 */
export async function discoverCasesRoot(): Promise<DiscoverCasesRootResult> {
  const tried: DiscoverCasesRootResult['tried'] = [];
  const dropboxConnection = await verifyDropboxConnection();

  if (!dropboxConnection.ok) {
    return {
      path: null,
      source: null,
      caseFolderCount: 0,
      tried,
      dropboxConnection,
    };
  }

  const envRoot = normalizePath(getEnv().DROPBOX_CASES_ROOT);

  const candidates: Array<{ path: string; source: string }> = [
    { path: envRoot, source: 'env_DROPBOX_CASES_ROOT' },
    { path: '/RAMOS JAMES LAW CASES', source: 'shared_name_default' },
    { path: '/David Eagan/RAMOS JAMES LAW CASES', source: 'nested_default' },
  ];

  const tryPath = async (path: string, source: string): Promise<string | null> => {
    const { entries, error } = await listFolderEntriesInternal(path);
    tried.push({ path, source, folderCount: entries.length, error });
    if (entries.length > 0) {
      resolvedCasesRoot = normalizePath(path);
      logger.info('Discovered Dropbox cases root', {
        path: resolvedCasesRoot,
        source,
        caseFolderCount: entries.length,
      });
      return resolvedCasesRoot;
    }
    return null;
  };

  for (const c of candidates) {
    const found = await tryPath(c.path, c.source);
    if (found) {
      return {
        path: found,
        source: c.source,
        caseFolderCount: tried[tried.length - 1].folderCount,
        tried,
        dropboxConnection,
      };
    }
  }

  // Scan account home root for a matching folder name
  const homeResult = await listFolderEntriesInternal('');
  tried.push({
    path: '(account root)',
    source: 'account_root_scan',
    folderCount: homeResult.entries.length,
    error: homeResult.error,
  });

  for (const folder of homeResult.entries) {
    if (matchesCasesRootHint(folder.name)) {
      const found = await tryPath(folder.path, 'account_root_match');
      if (found) {
        return {
          path: found,
          source: 'account_root_match',
          caseFolderCount: tried[tried.length - 1].folderCount,
          tried,
          dropboxConnection,
        };
      }
    }
  }

  // Shared folders available to mount (and often already visible in /)
  try {
    const mountable = await getDropbox().sharingListMountableFolders({});
    for (const folder of mountable.result.entries) {
      if (!matchesCasesRootHint(folder.name)) continue;
      const folderPath = folder.path_lower
        ? normalizePath(folder.path_lower)
        : normalizePath(`/${folder.name}`);
      const found = await tryPath(folderPath, 'sharing_list_mountable');
      if (found) {
        return {
          path: found,
          source: 'sharing_list_mountable',
          caseFolderCount: tried[tried.length - 1].folderCount,
          tried,
          dropboxConnection,
        };
      }
    }
  } catch (err) {
    logger.warn('sharingListMountableFolders failed', { err: extractDropboxError(err) });
  }

  // Team / shared folders the user is a member of
  try {
    const shared = await getDropbox().sharingListFolders({});
    for (const folder of shared.result.entries) {
      if (!matchesCasesRootHint(folder.name)) continue;
      const folderPath = folder.path_lower
        ? normalizePath(folder.path_lower)
        : normalizePath(`/${folder.name}`);
      const found = await tryPath(folderPath, 'sharing_list_folders');
      if (found) {
        return {
          path: found,
          source: 'sharing_list_folders',
          caseFolderCount: tried[tried.length - 1].folderCount,
          tried,
          dropboxConnection,
        };
      }
    }
  } catch (err) {
    logger.warn('sharingListFolders failed', { err: extractDropboxError(err) });
  }

  return { path: null, source: null, caseFolderCount: 0, tried, dropboxConnection };
}

export async function listCaseFolders(rootPath: string): Promise<DropboxFolderEntry[]> {
  const { entries } = await listFolderEntriesInternal(rootPath);
  return entries;
}

export async function ensureFolderExists(folderPath: string): Promise<boolean> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  try {
    await getDropbox().filesCreateFolderV2({ path: normalized, autorename: false });
    return true;
  } catch (err: unknown) {
    const e = err as { error?: { error_summary?: string } };
    const summary = e.error?.error_summary ?? '';
    if (summary.includes('path/conflict/folder')) return false;
    throw err;
  }
}

export async function fileExistsInDropbox(
  folderPath: string,
  filename: string
): Promise<boolean> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  const fullPath = `${normalized}/${filename}`.replace(/\/+/g, '/');
  try {
    await getDropbox().filesGetMetadata({ path: fullPath });
    return true;
  } catch {
    return false;
  }
}

export async function uploadFileToDropbox(
  folderPath: string,
  filename: string,
  contents: Buffer
): Promise<{ path: string; id: string; folderCreated: boolean }> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  const folderCreated = await ensureFolderExists(normalized);
  const fullPath = `${normalized}/${filename}`.replace(/\/+/g, '/');

  const response = await getDropbox().filesUpload({
    path: fullPath,
    contents,
    mode: { '.tag': 'add' },
    autorename: false,
    mute: true,
  });

  return {
    path: response.result.path_display ?? fullPath,
    id: response.result.id,
    folderCreated,
  };
}

export async function generateDropboxPermalink(filePath: string): Promise<string> {
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const shared = await getDropbox().sharingCreateSharedLinkWithSettings({
    path: normalized,
    settings: { requested_visibility: { '.tag': 'team_only' } },
  });
  return shared.result.url;
}
