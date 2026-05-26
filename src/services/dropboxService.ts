import { Dropbox } from 'dropbox';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let dbx: Dropbox | null = null;

function getDropbox(): Dropbox {
  if (!dbx) {
    dbx = new Dropbox({ accessToken: getEnv().DROPBOX_ACCESS_TOKEN });
  }
  return dbx;
}

export async function ensureFolderExists(folderPath: string): Promise<void> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  try {
    await getDropbox().filesCreateFolderV2({ path: normalized, autorename: false });
  } catch (err: unknown) {
    const e = err as { error?: { error_summary?: string } };
    const summary = e.error?.error_summary ?? '';
    if (summary.includes('path/conflict/folder')) return;
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
): Promise<{ path: string; id: string }> {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  await ensureFolderExists(normalized);
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

export interface DropboxFolderEntry {
  name: string;
  path: string;
}

export async function listCaseFolders(rootPath: string): Promise<DropboxFolderEntry[]> {
  const normalized = rootPath.startsWith('/') ? rootPath : `/${rootPath}`;
  try {
    const result = await getDropbox().filesListFolder({ path: normalized });
    return result.result.entries
      .filter((e) => e['.tag'] === 'folder')
      .map((e) => ({
        name: e.name,
        path: (e as { path_display: string }).path_display,
      }));
  } catch (err) {
    logger.warn('listCaseFolders failed', { rootPath, err: String(err) });
    return [];
  }
}
