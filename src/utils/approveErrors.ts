import { isDropboxFileConflict } from '../services/dropboxService.js';

export const FILE_ALREADY_IN_DROPBOX = 'File already in Dropbox.';

/** User-facing Slack ephemeral text from Approve failures. */
export function formatApproveError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (
    isDropboxFileConflict(err) ||
    /409/.test(raw) ||
    raw === FILE_ALREADY_IN_DROPBOX ||
    /file already in dropbox/i.test(raw)
  ) {
    return FILE_ALREADY_IN_DROPBOX;
  }

  if (/temp download failed/i.test(raw)) {
    if (/timeout|timed out/i.test(raw)) {
      return (
        'Could not load the attachment from temp storage (connection timed out). ' +
        'Wait a minute and press Approve again. If it keeps failing, check Supabase is awake and the file-sorter-temp bucket.'
      );
    }
    return (
      'Attachment missing from temp storage — it may never have uploaded when the email arrived. ' +
      'Re-forward the email or check the file-sorter-temp bucket in Supabase.'
    );
  }

  if (/no files were saved/i.test(raw)) {
    return 'No files were saved — check folder overrides in thread.';
  }

  if (/case must be set/i.test(raw)) {
    return raw + ' Reply in thread with case: <number or name>, then Approve.';
  }

  return raw;
}

/** Thread reply when Approve / queue actions fail. */
export function formatSortFailureThreadMessage(err: unknown): string {
  const reason = formatApproveError(err);
  return [
    ':x: *Sort failed*',
    reason,
    '',
    '_Press *Approve* on the card to retry after fixing, or use *Change Case/Folder* / thread overrides (`case:`, `folder:`, `rename:`)._',
  ].join('\n');
}

export function isRecoverableApproveError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    isDropboxFileConflict(err) ||
    /409/.test(raw) ||
    /file already in dropbox/i.test(raw) ||
    raw === FILE_ALREADY_IN_DROPBOX ||
    /temp download failed/i.test(raw) ||
    /no files were saved/i.test(raw) ||
    /duplicate/i.test(raw)
  );
}
