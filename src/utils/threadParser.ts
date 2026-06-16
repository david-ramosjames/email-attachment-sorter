import { normalizeFolderLabel } from '../constants/rjlFolders.js';

/**
 * Parses reviewer thread replies for case/folder overrides and hints.
 * Expected format (case-insensitive keys):
 *   case: 1277
 *   case: First Last
 *   folder: Medical
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
  }
  return merged;
}
