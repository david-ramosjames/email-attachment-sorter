import { Dropbox } from 'dropbox';
import { getEnv } from '../config/env.js';
import {
  clearDropboxTokenCache,
  dropboxAuthMode,
  getDropboxAccessToken,
  isExpiredDropboxTokenError,
} from './dropboxAuth.js';
import { logger } from '../utils/logger.js';

/** Resolved after first successful discovery (may differ from env). */
let resolvedCasesRoot: string | null = null;
/** Dropbox Business namespace for API path root (team vs home). */
let resolvedNamespaceId: string | null = null;

function getNamespaceId(): string | null {
  return resolvedNamespaceId ?? getEnv().DROPBOX_NAMESPACE_ID ?? null;
}

async function getDropboxClient(namespaceId?: string | null): Promise<Dropbox> {
  const token = await getDropboxAccessToken();
  const ns = namespaceId ?? getNamespaceId();
  if (ns) {
    return new Dropbox({
      accessToken: token,
      pathRoot: JSON.stringify({ '.tag': 'namespace_id', namespace_id: ns }),
    });
  }
  return new Dropbox({ accessToken: token });
}

export function getCasesRootPath(): string {
  return resolvedCasesRoot ?? getEnv().DROPBOX_CASES_ROOT;
}

export function getResolvedNamespaceId(): string | null {
  return resolvedNamespaceId;
}

function normalizePath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p.replace(/\/+/g, '/');
}

import {
  parseCaseNumberFromDropboxFolder,
} from '../constants/rjlFolders.js';

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
  path: string,
  namespaceId?: string | null,
  isRetry = false
): Promise<{ entries: DropboxFolderEntry[]; error?: string }> {
  const normalized = path === '' ? '' : normalizePath(path);
  const entries: DropboxFolderEntry[] = [];
  const client = await getDropboxClient(namespaceId);

  try {
    let result = await client.filesListFolder({ path: normalized });
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
      result = await client.filesListFolderContinue({ cursor: result.result.cursor });
    }
    return { entries };
  } catch (err) {
    const message = extractDropboxError(err);
    if (!isRetry && isExpiredDropboxTokenError(message)) {
      clearDropboxTokenCache();
      logger.info('Dropbox token expired — refreshing and retrying', { path: normalized });
      return listFolderEntriesInternal(path, namespaceId, true);
    }
    logger.warn('listFolderEntries failed', { path: normalized, namespaceId, error: message });
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
  authMode?: 'refresh_token' | 'static_access_token';
  accountEmail?: string;
  accountName?: string;
  homePath?: string;
  rootNamespaceId?: string;
  homeNamespaceId?: string;
  error?: string;
}

/** Verifies Dropbox credentials (refresh token or static access token). */
export async function verifyDropboxConnection(): Promise<DropboxConnectionStatus> {
  try {
    const account = await (await getDropboxClient()).usersGetCurrentAccount();
    const root = account.result.root_info;
    const status: DropboxConnectionStatus = {
      ok: true,
      authMode: dropboxAuthMode(),
      accountEmail: account.result.email,
      accountName: account.result.name.display_name,
    };
    if (root['.tag'] === 'user') {
      const userRoot = root as { home_path?: string; root_namespace_id?: string; home_namespace_id?: string };
      status.homePath = userRoot.home_path;
      status.rootNamespaceId = userRoot.root_namespace_id;
      status.homeNamespaceId = userRoot.home_namespace_id;
    }
    return status;
  } catch (err) {
    return { ok: false, error: extractDropboxError(err) };
  }
}

export interface DiscoverCasesRootResult {
  path: string | null;
  source: string | null;
  namespaceId: string | null;
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
      namespaceId: null,
      caseFolderCount: 0,
      tried,
      dropboxConnection,
    };
  }

  const finish = (
    path: string,
    source: string,
    caseFolderCount: number
  ): DiscoverCasesRootResult => ({
    path,
    source,
    namespaceId: resolvedNamespaceId,
    caseFolderCount,
    tried,
    dropboxConnection,
  });

  const envRoot = normalizePath(getEnv().DROPBOX_CASES_ROOT);

  const tryPath = async (
    path: string,
    source: string,
    namespaceId?: string | null
  ): Promise<string | null> => {
    const { entries, error } = await listFolderEntriesInternal(path, namespaceId);
    const label = namespaceId ? `${source} (ns:${namespaceId.slice(0, 8)}…)` : source;
    tried.push({ path, source: label, folderCount: entries.length, error });

    const caseFolders = entries.filter((e) => parseCaseNumberFromDropboxFolder(e.name));

    if (caseFolders.length > 0) {
      resolvedCasesRoot = normalizePath(path === '' && entries.length === 1 && matchesCasesRootHint(entries[0].name)
        ? `/${entries[0].name}`
        : path);
      if (namespaceId) resolvedNamespaceId = namespaceId;
      logger.info('Discovered Dropbox cases root', {
        path: resolvedCasesRoot,
        source: label,
        caseFolderCount: caseFolders.length,
        namespaceId,
      });
      return resolvedCasesRoot;
    }

    // Direct hit: listing the cases root itself (subfolders are case folders)
    if (entries.length > 0 && (path.includes('RAMOS') || matchesCasesRootHint(path))) {
      resolvedCasesRoot = normalizePath(path);
      if (namespaceId) resolvedNamespaceId = namespaceId;
      return resolvedCasesRoot;
    }

    return null;
  };

  // Dropbox Business: try team root namespace first (shared "RAMOS JAMES LAW CASES" lives here)
  if (dropboxConnection.rootNamespaceId) {
    const ns = dropboxConnection.rootNamespaceId;
    const teamCandidates = [
      { path: '/RAMOS JAMES LAW CASES', source: 'team_root_namespace' },
      { path: envRoot, source: 'team_root_env' },
      { path: '', source: 'team_root_list' },
    ];
    for (const c of teamCandidates) {
      const found = await tryPath(c.path, c.source, ns);
      if (found) {
        return finish(found, c.source, tried[tried.length - 1].folderCount);
      }
    }
  }

  // User home namespace (/David Eagan/...)
  if (dropboxConnection.homeNamespaceId) {
    const ns = dropboxConnection.homeNamespaceId;
    const homeCandidates = [
      { path: '/RAMOS JAMES LAW CASES', source: 'home_namespace' },
      { path: envRoot, source: 'home_namespace_env' },
      { path: '', source: 'home_namespace_list' },
    ];
    for (const c of homeCandidates) {
      const found = await tryPath(c.path, c.source, ns);
      if (found) {
        return finish(found, c.source, tried[tried.length - 1].folderCount);
      }
    }
  }

  const candidates: Array<{ path: string; source: string }> = [
    { path: envRoot, source: 'env_DROPBOX_CASES_ROOT' },
    { path: '/RAMOS JAMES LAW CASES', source: 'shared_name_default' },
    { path: '/David Eagan/RAMOS JAMES LAW CASES', source: 'nested_default' },
  ];

  for (const c of candidates) {
    const found = await tryPath(c.path, c.source);
    if (found) {
      return finish(found, c.source, tried[tried.length - 1].folderCount);
    }
  }

  // Scan default namespace home
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
        return finish(found, 'account_root_match', tried[tried.length - 1].folderCount);
      }
    }
  }

  // Shared folders available to mount (and often already visible in /)
  try {
    const mountable = await (await getDropboxClient()).sharingListMountableFolders({});
    for (const folder of mountable.result.entries) {
      if (!matchesCasesRootHint(folder.name)) continue;
      const folderPath = folder.path_lower
        ? normalizePath(folder.path_lower)
        : normalizePath(`/${folder.name}`);
      const found = await tryPath(folderPath, 'sharing_list_mountable');
      if (found) {
        return finish(found, 'sharing_list_mountable', tried[tried.length - 1].folderCount);
      }
    }
  } catch (err) {
    logger.warn('sharingListMountableFolders failed', { err: extractDropboxError(err) });
  }

  // Team / shared folders the user is a member of
  try {
    const shared = await (await getDropboxClient()).sharingListFolders({});
    for (const folder of shared.result.entries) {
      if (!matchesCasesRootHint(folder.name)) continue;
      const folderPath = folder.path_lower
        ? normalizePath(folder.path_lower)
        : normalizePath(`/${folder.name}`);
      const found = await tryPath(folderPath, 'sharing_list_folders');
      if (found) {
        return finish(found, 'sharing_list_folders', tried[tried.length - 1].folderCount);
      }
    }
  } catch (err) {
    logger.warn('sharingListFolders failed', { err: extractDropboxError(err) });
  }

  return {
    path: null,
    source: null,
    namespaceId: null,
    caseFolderCount: 0,
    tried,
    dropboxConnection,
  };
}

export async function listCaseFolders(
  rootPath: string,
  namespaceId?: string | null
): Promise<DropboxFolderEntry[]> {
  const { entries } = await listFolderEntriesInternal(rootPath, namespaceId ?? getNamespaceId());
  return entries;
}

/**
 * Fast path: use DROPBOX_CASES_ROOT + DROPBOX_NAMESPACE_ID from env (no full discovery scan).
 */
export async function resolveCasesRootFromEnv(): Promise<{
  path: string;
  namespaceId: string;
  folderCount: number;
} | null> {
  const root = normalizePath(getEnv().DROPBOX_CASES_ROOT);
  const ns = getEnv().DROPBOX_NAMESPACE_ID;
  if (!ns) return null;

  resolvedNamespaceId = ns;
  const { entries, error } = await listFolderEntriesInternal(root, ns);
  if (error) {
    logger.warn('resolveCasesRootFromEnv failed', {
      root,
      namespaceId: ns,
      error,
      hint: 'Usually expired token, wrong DROPBOX_NAMESPACE_ID, or path not visible in that namespace',
    });
    return null;
  }
  if (entries.length === 0) return null;

  resolvedCasesRoot = root;
  return { path: root, namespaceId: ns, folderCount: entries.length };
}

export async function ensureFolderExists(folderPath: string): Promise<boolean> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  try {
    await (await getDropboxClient()).filesCreateFolderV2({ path: normalized, autorename: false });
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
    await (await getDropboxClient()).filesGetMetadata({ path: fullPath });
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

  const response = await (await getDropboxClient()).filesUpload({
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
  const shared = await (await getDropboxClient()).sharingCreateSharedLinkWithSettings({
    path: normalized,
    settings: { requested_visibility: { '.tag': 'team_only' } },
  });
  return shared.result.url;
}
