import { requireClientSupabase } from '../db/clientSupabase.js';
import { extractDropboxError, generateDropboxPermalink } from './dropboxService.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 40;
const FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;

let inProgress = false;
/** Rows whose link creation failed, so one bad file doesn't block the queue every minute. */
const failedAt = new Map<string, number>();

/**
 * Fill evidence_photos.dropbox_permalink with team-only shared links. "/home/..." web URLs
 * depend on where each person's Dropbox mounts the cases folder, so the Case Tracker links
 * through these instead. Shared links follow the file across moves and renames.
 */
export async function backfillEvidencePermalinks(): Promise<number> {
  if (inProgress) return 0;
  inProgress = true;
  let created = 0;
  try {
    const { data, error } = await requireClientSupabase()
      .from('evidence_photos')
      .select('id, dropbox_path')
      .is('dropbox_permalink', null)
      .is('deleted_at', null)
      .order('created_at')
      .limit(BATCH_SIZE + failedAt.size);
    if (error) throw new Error(`Load evidence photos missing links failed: ${error.message}`);

    const now = Date.now();
    const rows = (data ?? [])
      .filter((r) => now - (failedAt.get(r.id) ?? 0) > FAILURE_RETRY_MS)
      .slice(0, BATCH_SIZE);

    for (const row of rows) {
      try {
        const url = await generateDropboxPermalink(row.dropbox_path);
        const { error: updateError } = await requireClientSupabase()
          .from('evidence_photos')
          .update({ dropbox_permalink: url })
          .eq('id', row.id);
        if (updateError) throw new Error(updateError.message);
        failedAt.delete(row.id);
        created++;
      } catch (err) {
        failedAt.set(row.id, now);
        logger.warn('Evidence photo: shared link failed', {
          id: row.id,
          path: row.dropbox_path,
          err: extractDropboxError(err),
        });
      }
    }
    if (created) logger.info('Evidence photos: shared links created', { created });
    return created;
  } finally {
    inProgress = false;
  }
}
