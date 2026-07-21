import {
  hasQueueReminderBeenSent,
  listPendingQueueItemsWithSlackCard,
  getCaseById,
  clearSlackQueueCardRefsForBatch,
} from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import { auditService } from './auditService.js';
import { slackService } from './slackService.js';
import type { FileSorterItem } from '../types/index.js';
import {
  isSlackRateLimitedError,
  isStaleSlackQueueCardError,
  slackApiErrorCode,
  slackRetryAfterSec,
} from '../utils/slackErrors.js';
import { logger } from '../utils/logger.js';

let reminderPassInProgress = false;

/** Space out chat.update calls so startup refresh does not trip Slack rate limits. */
const QUEUE_CARD_REFRESH_GAP_MS = 400;
const QUEUE_CARD_REFRESH_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reminderTimezone(): string {
  return getEnv().SLACK_REMINDER_TIMEZONE.trim() || 'America/Chicago';
}

export function isWorkdayInTimezone(tz: string, at: Date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(at);
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function itemQueuedAtMs(item: FileSorterItem): number {
  const raw = item.email_received_at ?? item.created_at;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? Date.parse(item.created_at) : ms;
}

function batchKey(item: FileSorterItem): string | null {
  if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return null;
  return `${item.slack_queue_channel_id}:${item.slack_queue_message_ts}`;
}

async function updateQueueCardWithRetry(item: FileSorterItem): Promise<void> {
  const caseRow = item.suggested_case_number
    ? await getCaseById(item.suggested_case_number)
    : null;

  for (let attempt = 1; attempt <= QUEUE_CARD_REFRESH_MAX_ATTEMPTS; attempt++) {
    try {
      await slackService.updateQueueMessage(item, caseRow);
      return;
    } catch (err) {
      if (isSlackRateLimitedError(err) && attempt < QUEUE_CARD_REFRESH_MAX_ATTEMPTS) {
        const waitSec = slackRetryAfterSec(err) ?? Math.min(60, 5 * attempt);
        logger.warn('Queue card refresh rate limited — waiting before retry', {
          itemId: item.id,
          attempt,
          waitSec,
        });
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
}

/** Re-render Slack queue cards (e.g. after deploy adds new buttons). One update per card. */
export async function refreshPendingQueueCards(): Promise<{
  refreshed: number;
  failed: number;
  staleCleared: number;
}> {
  const items = await listPendingQueueItemsWithSlackCard();
  const seen = new Set<string>();
  let refreshed = 0;
  let failed = 0;
  let staleCleared = 0;

  for (const item of items) {
    const key = batchKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    try {
      await updateQueueCardWithRetry(item);
      refreshed++;
    } catch (err) {
      if (isStaleSlackQueueCardError(err)) {
        await clearSlackQueueCardRefsForBatch(item);
        staleCleared++;
        logger.info('Cleared stale Slack queue card reference', {
          key,
          itemId: item.id,
          code: slackApiErrorCode(err),
        });
      } else {
        failed++;
        logger.warn('Failed to refresh queue card', {
          key,
          itemId: item.id,
          code: slackApiErrorCode(err),
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await sleep(QUEUE_CARD_REFRESH_GAP_MS);
  }

  if (refreshed > 0 || failed > 0 || staleCleared > 0) {
    logger.info('Pending queue card refresh complete', { refreshed, failed, staleCleared });
  }

  return { refreshed, failed, staleCleared };
}

/** One reminder per Slack queue card (batch). */
export async function runQueueReminderPass(): Promise<{
  checked: number;
  reminded: number;
  skipped: number;
}> {
  if (reminderPassInProgress) {
    logger.info('Skipping queue reminder pass — already running');
    return { checked: 0, reminded: 0, skipped: 0 };
  }

  const hours = getEnv().SLACK_QUEUE_REMINDER_HOURS;
  if (hours <= 0) {
    return { checked: 0, reminded: 0, skipped: 0 };
  }

  const tz = reminderTimezone();
  if (!isWorkdayInTimezone(tz)) {
    logger.info('Skipping queue reminder pass — not a workday', { timezone: tz });
    return { checked: 0, reminded: 0, skipped: 0 };
  }

  reminderPassInProgress = true;
  try {
    const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
    const items = await listPendingQueueItemsWithSlackCard();

    const batches = new Map<string, FileSorterItem[]>();
    for (const item of items) {
      const key = batchKey(item);
      if (!key) continue;
      const list = batches.get(key) ?? [];
      list.push(item);
      batches.set(key, list);
    }

    let reminded = 0;
    let skipped = 0;

    for (const batchItems of batches.values()) {
      const oldest = batchItems.reduce((a, b) =>
        itemQueuedAtMs(a) <= itemQueuedAtMs(b) ? a : b
      );
      if (itemQueuedAtMs(oldest) > cutoffMs) {
        skipped++;
        continue;
      }

      if (await hasQueueReminderBeenSent(oldest.id)) {
        skipped++;
        continue;
      }

      const filenames = batchItems.map((i) => i.attachment_filename).join(', ');
      const hoursWaiting = Math.floor((Date.now() - itemQueuedAtMs(oldest)) / (60 * 60 * 1000));
      const text =
        `:hourglass_flowing_sand: *Reminder* — this file sorter item has been waiting ` +
        `${hoursWaiting}+ hours. Please review the card above and click *Approve* or *Do Not Sort*.` +
        (batchItems.length > 1 ? `\n_Attachments: ${filenames}_` : `\n_${filenames}_`);

      await slackService.postQueueCardThreadNotice(oldest, text);

      for (const item of batchItems) {
        await auditService.log(item.id, 'queue_reminder_sent', {
          batchSize: batchItems.length,
          hoursWaiting,
          slackTs: oldest.slack_queue_message_ts,
        });
      }

      reminded++;
      logger.info('Queue reminder posted', {
        itemId: oldest.id,
        batchSize: batchItems.length,
        hoursWaiting,
      });
    }

    return { checked: batches.size, reminded, skipped };
  } finally {
    reminderPassInProgress = false;
  }
}

export function startQueueReminderScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0 || getEnv().SLACK_QUEUE_REMINDER_HOURS <= 0) return;

  const run = () => {
    runQueueReminderPass()
      .then((result) => {
        if (result.reminded > 0) {
          logger.info('Queue reminder pass complete', result);
        }
      })
      .catch((err) => {
        logger.error('Queue reminder pass failed', { err: String(err) });
      });
  };

  setTimeout(run, 120_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Queue reminder scheduler started', {
    intervalMinutes,
    reminderHours: getEnv().SLACK_QUEUE_REMINDER_HOURS,
    timezone: reminderTimezone(),
    firstRunDelaySec: 120,
  });
}
