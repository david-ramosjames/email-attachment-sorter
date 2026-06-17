import type { Case } from '../types/index.js';
import type { FileSorterItem } from '../types/index.js';
import {
  dropboxPathForCaseSubfolder,
  normalizeFolderLabel,
} from '../constants/rjlFolders.js';
import { getFoldersForCase } from '../db/supabase.js';
import { matchAttachmentForSkip } from './skipAttachment.js';

export interface PerFileFolderOverride {
  sourcePattern: string;
  folderLabel: string;
}

export interface ResolvedPerFileFolder extends PerFileFolderOverride {
  folderPath: string;
}

/** Parse `folder: scan.pdf | Medical` or `folder: scan.pdf to Pleadings`. */
export function parsePerFileFolderLine(line: string): PerFileFolderOverride | null {
  const trimmed = line.trim();
  const arrow = trimmed.match(/^folder:\s*(.+?)\s*(?:→|->|to)\s*(.+)$/i);
  if (arrow) {
    const sourcePattern = arrow[1]!.trim();
    const folderLabel = normalizeFolderLabel(arrow[2]!);
    if (!sourcePattern || !folderLabel) return null;
    return { sourcePattern, folderLabel };
  }

  const pipe = trimmed.match(/^folder:\s*(.+?)\s*\|\s*(.+)$/i);
  if (pipe) {
    const sourcePattern = pipe[1]!.trim();
    const folderLabel = normalizeFolderLabel(pipe[2]!);
    if (!sourcePattern || !folderLabel) return null;
    return { sourcePattern, folderLabel };
  }

  return null;
}

export function threadPerFileFolderHasValues(
  overrides: PerFileFolderOverride[] | undefined
): boolean {
  return (overrides?.length ?? 0) > 0;
}

export async function resolveFolderPathForCase(
  caseNumber: string,
  caseRow: Case,
  folderLabel: string
): Promise<string> {
  const normalized = normalizeFolderLabel(folderLabel);
  const folders = await getFoldersForCase(caseNumber);
  const folder = folders.find(
    (f) => f.folder_label.toLowerCase() === normalized.toLowerCase()
  );
  if (folder) return folder.dropbox_path;
  return dropboxPathForCaseSubfolder(caseRow.dropbox_root_path, normalized);
}

export async function resolvePerFileFoldersForCase(
  caseNumber: string,
  caseRow: Case,
  overrides: PerFileFolderOverride[]
): Promise<ResolvedPerFileFolder[]> {
  const resolved: ResolvedPerFileFolder[] = [];
  for (const entry of overrides) {
    const folderPath = await resolveFolderPathForCase(caseNumber, caseRow, entry.folderLabel);
    resolved.push({ ...entry, folderPath });
  }
  return resolved;
}

/** Latest matching per-file folder wins; then global thread folder; then AI suggestion. */
export function folderPathForBatchItem(
  item: FileSorterItem,
  batchItems: FileSorterItem[],
  perFileFolders: ResolvedPerFileFolder[],
  threadFolderPath: string | null
): string | null {
  const eligible = batchItems.filter((i) => !['saved', 'ignored'].includes(i.status));
  for (let i = perFileFolders.length - 1; i >= 0; i--) {
    const entry = perFileFolders[i]!;
    const match = matchAttachmentForSkip(eligible, entry.sourcePattern);
    if (match?.id === item.id) {
      return entry.folderPath;
    }
  }
  if (threadFolderPath) return threadFolderPath;
  return item.suggested_folder_path;
}

export function formatPerFileFolderConfirmationLines(
  batchItems: FileSorterItem[],
  perFileFolders: PerFileFolderOverride[]
): string[] {
  const lines: string[] = [];
  const eligible = batchItems.filter((i) => !['saved', 'ignored'].includes(i.status));
  const seen = new Set<string>();

  for (const entry of perFileFolders) {
    const match = matchAttachmentForSkip(eligible, entry.sourcePattern);
    if (!match || seen.has(match.id)) continue;
    seen.add(match.id);
    const suggested = match.suggested_folder_path
      ? match.suggested_folder_path.split('/').filter(Boolean).pop()
      : null;
    if (entry.folderLabel.toLowerCase() !== (suggested ?? '').toLowerCase()) {
      lines.push(`• _${match.attachment_filename}_ → folder *${entry.folderLabel}*`);
    }
  }

  return lines;
}
