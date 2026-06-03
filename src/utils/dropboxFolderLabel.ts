import { RJL_STANDARD_SUBFOLDERS, type RjlSubfolder } from '../constants/rjlFolders.js';

/** Last known RJL subfolder segment in a Dropbox path (skips filename). */
export function folderLabelFromDropboxPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return null;

  const known = new Set<string>(RJL_STANDARD_SUBFOLDERS);
  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i]!;
    if (known.has(segment as RjlSubfolder)) return segment;
  }

  const last = parts[parts.length - 1]!;
  if (/\.[a-z0-9]{2,5}$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2]!;
  }
  return last;
}
