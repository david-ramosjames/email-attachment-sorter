import {
  deleteTempAttachment,
  listRoutedTempStorageReadyForDeletion,
  listUnroutedTempStorageExpired,
  updateFileSorterItem,
} from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { FileSorterItem } from '../types/index.js';

let cleanupInProgress = false;
const scheduledDeletes = new Map<string, NodeJS.Timeout>();

/** Remove staged file from Supabase Storage and clear DB pointer. */
export async function clearTempStorageForItem(item: FileSorterItem): Promise<void> {
  if (!item.temp_storage_url) return;

  const pending = scheduledDeletes.get(item.id);
  if (pending) {
    clearTimeout(pending);
    scheduledDeletes.delete(item.id);
  }

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

/** Delete temp file shortly after successful routing (Dropbox + queue update). */
export function scheduleTempStorageDeletionAfterRouted(item: FileSorterItem): void {
  if (!item.temp_storage_url) return;

  const delayMs = getEnv().TEMP_STORAGE_ROUTED_DELETE_AFTER_MINUTES * 60 * 1000;
  if (delayMs <= 0) {
    void clearTempStorageForItem(item);
    return;
  }

  const existing = scheduledDeletes.get(item.id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    scheduledDeletes.delete(item.id);
    clearTempStorageForItem(item).catch((err) => {
      logger.warn('Scheduled routed temp delete failed', {
        itemId: item.id,
        err: String(err),
      });
    });
  }, delayMs);

  scheduledDeletes.set(item.id, timer);
}

/**
 * Purge temp storage:
 * - Routed (saved): after TEMP_STORAGE_ROUTED_DELETE_AFTER_MINUTES from reviewed_at
 * - Unrouted: after TEMP_STORAGE_UNROUTED_TTL_HOURS from created_at
 */
export async function cleanupExpiredTempStorage(): Promise<{
  scanned: number;
  deleted: number;
  routedDeleted: number;
  unroutedDeleted: number;
}> {
  if (cleanupInProgress) {
    logger.info('Temp storage cleanup already in progress');
    return { scanned: 0, deleted: 0, routedDeleted: 0, unroutedDeleted: 0 };
  }

  cleanupInProgress = true;
  try {
    const env = getEnv();
    const [routed, unrouted] = await Promise.all([
      listRoutedTempStorageReadyForDeletion(env.TEMP_STORAGE_ROUTED_DELETE_AFTER_MINUTES),
      listUnroutedTempStorageExpired(env.TEMP_STORAGE_UNROUTED_TTL_HOURS),
    ]);

    const seen = new Set<string>();
    let routedDeleted = 0;
    let unroutedDeleted = 0;

    for (const item of routed) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      await clearTempStorageForItem(item);
      routedDeleted++;
    }

    for (const item of unrouted) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      await clearTempStorageForItem(item);
      unroutedDeleted++;
    }

    const deleted = routedDeleted + unroutedDeleted;
    if (deleted > 0) {
      logger.info('Temp storage cleanup finished', {
        deleted,
        routedDeleted,
        unroutedDeleted,
        routedGraceMinutes: env.TEMP_STORAGE_ROUTED_DELETE_AFTER_MINUTES,
        unroutedTtlHours: env.TEMP_STORAGE_UNROUTED_TTL_HOURS,
      });
    }

    return {
      scanned: routed.length + unrouted.length,
      deleted,
      routedDeleted,
      unroutedDeleted,
    };
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
    routedDeleteAfterMinutes: getEnv().TEMP_STORAGE_ROUTED_DELETE_AFTER_MINUTES,
    unroutedTtlHours: getEnv().TEMP_STORAGE_UNROUTED_TTL_HOURS,
    firstRunDelaySec: 60,
  });
}
