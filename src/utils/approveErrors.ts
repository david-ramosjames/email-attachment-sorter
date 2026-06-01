import { isDropboxFileConflict } from '../services/dropboxService.js';

/** User-facing Slack ephemeral text from Approve failures. */
export function formatApproveError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (isDropboxFileConflict(err) || /409/.test(raw)) {
    return (
      'This file already exists in that Dropbox folder. ' +
      'Move or rename the existing file, choose another folder in thread, then Approve again.'
    );
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
    return raw + ' Review duplicates or folder overrides in the thread.';
  }

  if (/case must be set/i.test(raw)) {
    return raw + ' Reply in thread with case: <number or name>, then Approve.';
  }

  return raw;
}

export function isRecoverableApproveError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    isDropboxFileConflict(err) ||
    /409/.test(raw) ||
    /temp download failed/i.test(raw) ||
    /no files were saved/i.test(raw) ||
    /duplicate/i.test(raw)
  );
}
