import { downloadTempAttachment } from '../db/supabase.js';
import { downloadDropboxFile } from '../services/dropboxService.js';
import type { FileSorterItem } from '../types/index.js';
import { logger } from './logger.js';

export interface LoadAttachmentBytesOptions {
  /** Dropbox path to try when temp storage is missing (e.g. target folder + filename). */
  dropboxPath?: string;
}

/**
 * Load attachment bytes for Approve / extraction — temp storage first, then Dropbox.
 */
export async function loadAttachmentBytesForItem(
  item: FileSorterItem,
  options?: LoadAttachmentBytesOptions
): Promise<Buffer> {
  const dropboxPaths = [
    options?.dropboxPath?.trim(),
    item.final_dropbox_path?.trim(),
  ].filter((p): p is string => Boolean(p));

  if (item.temp_storage_url) {
    try {
      return await downloadTempAttachment(item.id, item.attachment_filename);
    } catch (err) {
      logger.warn('Temp attachment unavailable — trying Dropbox fallback', {
        itemId: item.id,
        filename: item.attachment_filename,
        err: String(err),
      });
    }
  }

  for (const path of dropboxPaths) {
    try {
      return await downloadDropboxFile(path);
    } catch (err) {
      logger.warn('Dropbox attachment fallback download failed', {
        itemId: item.id,
        path,
        err: String(err),
      });
    }
  }

  throw new Error(
    `Temp download failed: attachment not in temp storage and Dropbox fallback failed ` +
      `(item ${item.id}, file ${item.attachment_filename})`
  );
}
