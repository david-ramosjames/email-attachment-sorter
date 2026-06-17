import type { FileSorterItem } from '../types/index.js';
import { matchAttachmentForSkip } from './skipAttachment.js';

export interface FilenameRename {
  sourcePattern: string;
  targetFilename: string;
}

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** Safe filename for Dropbox upload (not a path). */
export function sanitizeDropboxFilename(name: string): string | null {
  const cleaned = name
    .trim()
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 240);
}

/** Parse `rename: old.pdf to new.pdf` or `name: old.pdf | new.pdf`. */
export function parseFilenameRenameLine(line: string): FilenameRename | null {
  const trimmed = line.trim();
  const arrow = trimmed.match(/^(?:rename|name|filename):\s*(.+?)\s*(?:→|->|to)\s*(.+)$/i);
  if (arrow) {
    const sourcePattern = arrow[1]!.trim();
    const targetFilename = sanitizeDropboxFilename(arrow[2]!);
    if (!sourcePattern || !targetFilename) return null;
    return { sourcePattern, targetFilename };
  }

  const pipe = trimmed.match(/^(?:rename|name|filename):\s*(.+?)\s*\|\s*(.+)$/i);
  if (pipe) {
    const sourcePattern = pipe[1]!.trim();
    const targetFilename = sanitizeDropboxFilename(pipe[2]!);
    if (!sourcePattern || !targetFilename) return null;
    return { sourcePattern, targetFilename };
  }

  return null;
}

export function threadRenameHasValues(renames: FilenameRename[] | undefined): boolean {
  return (renames?.length ?? 0) > 0;
}

/** Latest matching rename wins. Modal save-as on the item takes priority over thread. */
export function resolveDropboxFilenameForItem(
  item: FileSorterItem,
  batchItems: FileSorterItem[],
  renames: FilenameRename[]
): string {
  const savedAs = item.queue_save_as_filename?.trim();
  if (savedAs) return savedAs;

  if (!renames.length) return item.attachment_filename;

  const eligible = batchItems.filter((i) => !['saved', 'ignored'].includes(i.status));
  for (let i = renames.length - 1; i >= 0; i--) {
    const rename = renames[i]!;
    const match = matchAttachmentForSkip(eligible, rename.sourcePattern);
    if (match?.id === item.id) {
      return rename.targetFilename;
    }
  }

  return item.attachment_filename;
}

export function formatQueueFilenameDisplay(item: FileSorterItem): string {
  const saveAs = item.queue_save_as_filename?.trim();
  if (saveAs && saveAs !== item.attachment_filename) {
    return `${item.attachment_filename} → ${saveAs}`;
  }
  return saveAs || item.attachment_filename;
}

export function formatRenameConfirmationLines(
  batchItems: FileSorterItem[],
  renames: FilenameRename[]
): string[] {
  const lines: string[] = [];
  const eligible = batchItems.filter((i) => !['saved', 'ignored'].includes(i.status));
  const seen = new Set<string>();

  for (const rename of renames) {
    const match = matchAttachmentForSkip(eligible, rename.sourcePattern);
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    const target = resolveDropboxFilenameForItem(match, batchItems, renames);
    if (target !== match.attachment_filename) {
      lines.push(`• _${match.attachment_filename}_ → _${target}_`);
    }
  }

  return lines;
}
