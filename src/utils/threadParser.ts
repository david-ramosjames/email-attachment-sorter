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
      result.folderLabel = folderMatch[1].trim();
    }
  }

  return result;
}
