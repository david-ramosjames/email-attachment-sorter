import {
  deleteTempAttachment,
  listFileSorterItemsWithTempStorageOlderThan,
  updateFileSorterItem,
} from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { FileSorterItem } from '../types/index.js';

let cleanupInProgress = false;

/** Remove staged file from Supabase Storage and clear DB pointer. */
export async function clearTempStorageForItem(item: FileSorterItem): Promise<void> {
  if (!item.temp_storage_url) return;

  try {
    await deleteTempAttachment(item.id, item.attachment_filename);
  } catch (err) {
    logger.warn('Temp storage delete failed', {
      itemId: item.id,
      filename: item.attachment_filename,
      err: String(err),
    });
  }

  try {
    await updateFileSorterItem(item.id, { temp_storage_url: null });
  } catch (err) {
    logger.warn('Could not clear temp_storage_url on item', {
      itemId: item.id,
      err: String(err),
    });
  }
}

export async function clearTempStorageForItems(items: FileSorterItem[]): Promise<void> {
  for (const item of items) {
    await clearTempStorageForItem(item);
  }
}

/**
 * Delete temp attachments older than TEMP_STORAGE_TTL_HOURS (default 1h).
 * Frees Supabase Storage load for other apps on the same project.
 */
export async function cleanupExpiredTempStorage(): Promise<{
  scanned: number;
  deleted: number;
}> {
  if (cleanupInProgress) {
    logger.info('Temp storage cleanup already in progress');
    return { scanned: 0, deleted: 0 };
  }

  cleanupInProgress = true;
  try {
    const hours = getEnv().TEMP_STORAGE_TTL_HOURS;
    const items = await listFileSorterItemsWithTempStorageOlderThan(hours);
    let deleted = 0;

    for (const item of items) {
      await clearTempStorageForItem(item);
      deleted++;
    }

    if (deleted > 0) {
      logger.info('Temp storage cleanup finished', { deleted, ttlHours: hours });
    }

    return { scanned: items.length, deleted };
  } finally {
    cleanupInProgress = false;
  }
}

export function startTempStorageCleanupScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0) return;

  const run = () => {
    cleanupExpiredTempStorage().catch((err) => {
      logger.error('Scheduled temp storage cleanup failed', { err: String(err) });
    });
  };

  setTimeout(run, 60_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Temp storage cleanup scheduler started', {
    intervalMinutes,
    ttlHours: getEnv().TEMP_STORAGE_TTL_HOURS,
    firstRunDelaySec: 60,
  });
}
