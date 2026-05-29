import { RJL_STANDARD_SUBFOLDERS } from '../constants/rjlFolders.js';

/**
 * Parses reviewer thread replies for case/folder overrides and hints.
 * Expected format (case-insensitive keys):
 *   case: 1277
 *   case: First Last
 *   folder: Medical
 *   case hint: Client is Juan Garcia — sender is his daughter Maria
 *   sort hint: Law360 newsletters from this list — Do Not Sort
 */
export interface ThreadOverride {
  caseName?: string;
  folderLabel?: string;
  caseHints?: string[];
  sortHints?: string[];
}

/** "medical" → "Medical" when it matches a standard RJL subfolder */
export function normalizeFolderOverrideLabel(label: string): string {
  const trimmed = label.trim();
  const match = RJL_STANDARD_SUBFOLDERS.find(
    (f) => f.toLowerCase() === trimmed.toLowerCase()
  );
  return match ?? trimmed;
}

export function parseThreadReply(text: string): ThreadOverride {
  const result: ThreadOverride = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const caseMatch = trimmed.match(/^case:\s*(.+)$/i);
    if (caseMatch) {
      result.caseName = caseMatch[1].trim();
      continue;
    }
    const folderMatch = trimmed.match(/^folder:\s*(.+)$/i);
    if (folderMatch) {
      result.folderLabel = normalizeFolderOverrideLabel(folderMatch[1]);
      continue;
    }
    const caseHintMatch = trimmed.match(/^case\s+hint:\s*(.+)$/i);
    if (caseHintMatch) {
      result.caseHints = [...(result.caseHints ?? []), caseHintMatch[1].trim()];
      continue;
    }
    const sortHintMatch = trimmed.match(/^sort\s+hint:\s*(.+)$/i);
    if (sortHintMatch) {
      result.sortHints = [...(result.sortHints ?? []), sortHintMatch[1].trim()];
      continue;
    }
    const legacyHintMatch = trimmed.match(/^hint:\s*(.+)$/i);
    if (legacyHintMatch) {
      result.sortHints = [...(result.sortHints ?? []), legacyHintMatch[1].trim()];
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
  }
  return merged;
}
