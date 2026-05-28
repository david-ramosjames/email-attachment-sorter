import { RJL_STANDARD_SUBFOLDERS } from '../constants/rjlFolders.js';

/**
 * Parses reviewer thread replies for case/folder overrides.
 * Expected format (case-insensitive keys):
 *   case: Maria Lopez
 *   folder: Pleadings
 */
export interface ThreadOverride {
  caseName?: string;
  folderLabel?: string;
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
  }
  return merged;
}
