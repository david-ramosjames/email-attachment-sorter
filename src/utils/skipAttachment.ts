import type { FileSorterItem } from '../types/index.js';

/** Match a skip pattern to one pending attachment in a batch (exact or unique partial name). */
export function matchAttachmentForSkip(
  items: FileSorterItem[],
  pattern: string
): FileSorterItem | null {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return null;

  const eligible = items.filter((i) => !['saved', 'ignored'].includes(i.status));
  const exact = eligible.filter((i) => i.attachment_filename.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;

  const partial = eligible.filter((i) => i.attachment_filename.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;

  return null;
}
