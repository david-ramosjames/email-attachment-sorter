import { normalizeFolderLabel } from '../constants/rjlFolders.js';
import { parseFilenameRenameLine, threadRenameHasValues as renameListHasValues, type FilenameRename } from './filenameRename.js';
import {
  parsePerFileFolderLine,
  threadPerFileFolderHasValues as perFileFolderListHasValues,
  type PerFileFolderOverride,
} from './perFileFolder.js';

export type { FilenameRename, PerFileFolderOverride };

/**
 * Parses reviewer thread replies for case/folder overrides and hints.
 * Expected format (case-insensitive keys):
 *   case: 1277
 *   case: First Last
 *   folder: Medical
 *   folder: scan.pdf | Medical
 *   folder: photo.jpg to Photos
 *   Teach Case: Maria Garcia is Juan Garcia's daughter
 *   Teach Folder: Law360 newsletters should not be sorted
 * Legacy: case hint:, sort hint:, hint:
 */
export interface ThreadOverride {
  caseName?: string;
  folderLabel?: string;
  caseHints?: string[];
  sortHints?: string[];
  /** Filenames (or partial unique names) to exclude from Approve. */
  skipFilenames?: string[];
  /** Rename attachments when filing to Dropbox. */
  filenameRenames?: FilenameRename[];
  /** Folder overrides for specific attachments in a multi-file email. */
  perFileFolders?: PerFileFolderOverride[];
}

/** Strip Slack code formatting (backticks) from a single line. */
export function cleanThreadLine(line: string): string {
  return line
    .trim()
    .replace(/^[`'*_\s]+|[`'*_\s]+$/g, '')
    .trim();
}

/** Normalize folder override — known folders match canonical spelling; custom names allowed. */
export function normalizeFolderOverrideLabel(label: string): string {
  return normalizeFolderLabel(label);
}

export function threadOverrideHasValues(override: ThreadOverride): boolean {
  return Boolean(
    override.caseName ||
      override.folderLabel ||
      override.caseHints?.length ||
      override.sortHints?.length
  );
}

export function threadSkipHasValues(override: ThreadOverride): boolean {
  return (override.skipFilenames?.length ?? 0) > 0;
}

export function threadRenameHasValues(override: ThreadOverride): boolean {
  return renameListHasValues(override.filenameRenames);
}

export function threadPerFileFolderHasValues(override: ThreadOverride): boolean {
  return perFileFolderListHasValues(override.perFileFolders);
}

export function parseThreadReply(text: string): ThreadOverride {
  const result: ThreadOverride = {};
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const trimmed = cleanThreadLine(rawLine);
    if (!trimmed) continue;

    const caseMatch = trimmed.match(/^case:\s*(.+)$/i);
    if (caseMatch) {
      result.caseName = cleanThreadLine(caseMatch[1]!);
      continue;
    }
    const perFileFolder = parsePerFileFolderLine(trimmed);
    if (perFileFolder) {
      result.perFileFolders = [...(result.perFileFolders ?? []), perFileFolder];
      continue;
    }
    const folderMatch = trimmed.match(/^folder:\s*(.+)$/i);
    if (folderMatch) {
      result.folderLabel = normalizeFolderOverrideLabel(folderMatch[1]!);
      continue;
    }
    const caseHintMatch = trimmed.match(/^case\s+hint:\s*(.+)$/i);
    if (caseHintMatch) {
      result.caseHints = [...(result.caseHints ?? []), cleanThreadLine(caseHintMatch[1]!)];
      continue;
    }
    const teachCaseMatch = trimmed.match(/^teach\s+case:\s*(.+)$/i);
    if (teachCaseMatch) {
      result.caseHints = [...(result.caseHints ?? []), cleanThreadLine(teachCaseMatch[1]!)];
      continue;
    }
    const sortHintMatch = trimmed.match(/^sort\s+hint:\s*(.+)$/i);
    if (sortHintMatch) {
      result.sortHints = [...(result.sortHints ?? []), cleanThreadLine(sortHintMatch[1]!)];
      continue;
    }
    const teachFolderMatch = trimmed.match(/^teach\s+folder:\s*(.+)$/i);
    if (teachFolderMatch) {
      result.sortHints = [...(result.sortHints ?? []), cleanThreadLine(teachFolderMatch[1]!)];
      continue;
    }
    const legacyHintMatch = trimmed.match(/^hint:\s*(.+)$/i);
    if (legacyHintMatch) {
      result.sortHints = [...(result.sortHints ?? []), cleanThreadLine(legacyHintMatch[1]!)];
      continue;
    }
    const skipMatch = trimmed.match(/^(?:skip|do not sort):\s*(.+)$/i);
    if (skipMatch) {
      const names = cleanThreadLine(skipMatch[1]!)
        .split(/[,;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      result.skipFilenames = [...(result.skipFilenames ?? []), ...names];
      continue;
    }
    const rename = parseFilenameRenameLine(trimmed);
    if (rename) {
      result.filenameRenames = [...(result.filenameRenames ?? []), rename];
    }
  }

  return result;
}

/** Merge overrides from all thread replies (latest folder/case wins). */
export function parseThreadReplies(replies: string[]): ThreadOverride {
  const merged: ThreadOverride = {};
  for (const text of replies) {
    const parsed = parseThreadReply(text);
    if (parsed.caseName) merged.caseName = parsed.caseName;
    if (parsed.folderLabel) merged.folderLabel = parsed.folderLabel;
    if (parsed.caseHints?.length) {
      merged.caseHints = [...(merged.caseHints ?? []), ...parsed.caseHints];
    }
    if (parsed.sortHints?.length) {
      merged.sortHints = [...(merged.sortHints ?? []), ...parsed.sortHints];
    }
    if (parsed.skipFilenames?.length) {
      merged.skipFilenames = [...(merged.skipFilenames ?? []), ...parsed.skipFilenames];
    }
    if (parsed.filenameRenames?.length) {
      merged.filenameRenames = mergeFilenameRenames(
        merged.filenameRenames ?? [],
        parsed.filenameRenames
      );
    }
    if (parsed.perFileFolders?.length) {
      merged.perFileFolders = mergePerFileFolders(
        merged.perFileFolders ?? [],
        parsed.perFileFolders
      );
    }
  }
  return merged;
}

function mergePerFileFolders(
  existing: PerFileFolderOverride[],
  incoming: PerFileFolderOverride[]
): PerFileFolderOverride[] {
  const bySource = new Map<string, PerFileFolderOverride>();
  for (const entry of [...existing, ...incoming]) {
    bySource.set(entry.sourcePattern.toLowerCase(), entry);
  }
  return [...bySource.values()];
}

function mergeFilenameRenames(
  existing: FilenameRename[],
  incoming: FilenameRename[]
): FilenameRename[] {
  const bySource = new Map<string, FilenameRename>();
  for (const rename of [...existing, ...incoming]) {
    bySource.set(rename.sourcePattern.toLowerCase(), rename);
  }
  return [...bySource.values()];
}
