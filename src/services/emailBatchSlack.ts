import { getCaseById, getFileSorterItem, updateFileSorterItem } from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { auditService } from './auditService.js';
import { slackService } from './slackService.js';
import type { InboundEmailPayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface QueuedInboundItem {
  item: FileSorterItem;
  caseRow: Case | null;
}

export async function postEmailItemsToSlack(
  payload: InboundEmailPayload,
  queued: QueuedInboundItem[],
  sharedCaseNumber: string | null
): Promise<void> {
  if (!queued.length) return;

  let caseRow: Case | null = null;
  if (sharedCaseNumber) {
    caseRow = await getCaseById(sharedCaseNumber);
  }
  if (!caseRow) {
    caseRow = queued.find((q) => q.caseRow)?.caseRow ?? null;
  }
  if (!caseRow && queued[0]?.item.suggested_case_number) {
    caseRow = await getCaseById(queued[0].item.suggested_case_number);
  }

  const items = queued.map((q) => q.item);
  const slackMsg = await slackService.postQueueBatch(items, caseRow, {
    emailReceivedAt: payload.receivedAt,
  });

  for (const { item } of queued) {
    await updateFileSorterItem(item.id, {
      slack_queue_channel_id: slackMsg.channel,
      slack_queue_message_ts: slackMsg.ts,
    });
    await auditService.log(item.id, 'slack_queued', {
      channel: slackMsg.channel,
      ts: slackMsg.ts,
      batchSize: items.length,
    });
  }

  const primaryId = items.reduce((best, cur) =>
    (cur.ai_confidence ?? 0) > (best.ai_confidence ?? 0) ? cur : best
  ).id;
  const updatedPrimary = (await getFileSorterItem(primaryId)) ?? items[0]!;
  await slackService.updateQueueMessage(updatedPrimary, caseRow);

  logger.info('Slack queue batch posted', {
    gmailMessageId: payload.gmailMessageId,
    attachmentCount: items.length,
    filenames: items.map((i) => i.attachment_filename),
  });
}
