import {
  getCaseById,
  getQueueableItemsByGmailMessage,
  getQueueBatchItems,
  updateFileSorterItem,
} from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { auditService } from './auditService.js';
import {
  pickCaseChannelMentionUserIds,
  resolveQueuePostTarget,
} from './caseQueueRoutingService.js';
import { resolveMentionDisplayNames } from '../utils/mentionDisplay.js';
import { isCaseQueueChannel } from '../utils/queueChannel.js';
import { pickQueueMentionUserIdsForNewCard } from './queueMentionService.js';
import { slackService } from './slackService.js';
import type { InboundEmailPayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface QueuedInboundItem {
  item: FileSorterItem;
  caseRow: Case | null;
}

/** Serialize Slack posting per Gmail message (retries / slow AI can overlap). */
const slackPostLocks = new Map<string, Promise<void>>();

export async function postEmailItemsToSlack(
  payload: InboundEmailPayload,
  queued: QueuedInboundItem[],
  sharedCaseNumber: string | null
): Promise<void> {
  if (!queued.length) return;

  const gmailMessageId = payload.gmailMessageId;
  const prev = slackPostLocks.get(gmailMessageId) ?? Promise.resolve();
  const work = prev
    .catch(() => undefined)
    .then(() => postEmailItemsToSlackInner(payload, queued, sharedCaseNumber))
    .finally(() => {
      if (slackPostLocks.get(gmailMessageId) === work) {
        slackPostLocks.delete(gmailMessageId);
      }
    });
  slackPostLocks.set(gmailMessageId, work);
  await work;
}

async function resolveBatchCaseRow(
  items: FileSorterItem[],
  queued: QueuedInboundItem[],
  sharedCaseNumber: string | null
): Promise<Case | null> {
  if (sharedCaseNumber) {
    const row = await getCaseById(sharedCaseNumber);
    if (row) return row;
  }
  const fromQueued = queued.find((q) => q.caseRow)?.caseRow;
  if (fromQueued) return fromQueued;
  for (const item of items) {
    if (item.suggested_case_number) {
      const row = await getCaseById(item.suggested_case_number);
      if (row) return row;
    }
  }
  return null;
}

function pickPrimaryItem(items: FileSorterItem[]): FileSorterItem {
  return items.reduce((best, cur) => {
    const curScore = cur.ai_case_confidence ?? cur.ai_confidence ?? 0;
    const bestScore = best.ai_case_confidence ?? best.ai_confidence ?? 0;
    return curScore > bestScore ? cur : best;
  });
}

function parseTaggedUserIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function taggedUserIdsToStored(ids: string[]): string | null {
  if (!ids.length) return null;
  return ids.join(',');
}

function taggedUserNamesToStored(names: string[]): string | null {
  if (!names.length) return null;
  return names.join(', ');
}

async function postEmailItemsToSlackInner(
  payload: InboundEmailPayload,
  queued: QueuedInboundItem[],
  sharedCaseNumber: string | null
): Promise<void> {
  const gmailMessageId = payload.gmailMessageId;
  const allItems = await getQueueableItemsByGmailMessage(gmailMessageId);
  if (!allItems.length) return;

  const caseRow = await resolveBatchCaseRow(allItems, queued, sharedCaseNumber);
  const withSlack = allItems.filter(
    (i) => i.slack_queue_channel_id && i.slack_queue_message_ts
  );
  const withoutSlack = allItems.filter(
    (i) => !i.slack_queue_channel_id || !i.slack_queue_message_ts
  );

  if (withSlack.length > 0) {
    const anchor = withSlack[0]!;
    for (const item of withoutSlack) {
      await updateFileSorterItem(item.id, {
        slack_queue_channel_id: anchor.slack_queue_channel_id,
        slack_queue_message_ts: anchor.slack_queue_message_ts,
        queue_tagged_slack_user_id: anchor.queue_tagged_slack_user_id,
        queue_tagged_slack_user_name: anchor.queue_tagged_slack_user_name,
      });
      await auditService.log(item.id, 'slack_queued', {
        channel: anchor.slack_queue_channel_id,
        ts: anchor.slack_queue_message_ts,
        batchSize: allItems.length,
        mergedIntoExisting: true,
        taggedUserIds: parseTaggedUserIds(anchor.queue_tagged_slack_user_id),
      });
    }

    const batchItems = await getQueueBatchItems(anchor);
    const primary = pickPrimaryItem(batchItems);

    if (!parseTaggedUserIds(anchor.queue_tagged_slack_user_id).length) {
      const mentionIds = isCaseQueueChannel(anchor.slack_queue_channel_id) && caseRow
        ? await pickCaseChannelMentionUserIds(caseRow, anchor.slack_queue_channel_id!)
        : await pickQueueMentionUserIdsForNewCard();
      if (mentionIds.length) {
        const nameMap = await resolveMentionDisplayNames(mentionIds, caseRow);
        const taggedStored = taggedUserIdsToStored(mentionIds);
        const taggedNamesStored = taggedUserNamesToStored(
          mentionIds.map((id) => nameMap.get(id) ?? id)
        );
        for (const batchItem of batchItems) {
          await updateFileSorterItem(batchItem.id, {
            queue_tagged_slack_user_id: taggedStored,
            queue_tagged_slack_user_name: taggedNamesStored,
          });
        }
        primary.queue_tagged_slack_user_id = taggedStored;
        primary.queue_tagged_slack_user_name = taggedNamesStored;
        logger.info('Assigned queue mention on batch merge', {
          gmailMessageId,
          taggedUserIds: mentionIds,
          attachmentCount: batchItems.length,
        });
      }
    }

    await slackService.updateQueueMessage(primary, caseRow);

    if (withoutSlack.length > 0 && anchor.slack_queue_channel_id && anchor.slack_queue_message_ts) {
      await slackService.attachFilesToQueueCard(
        anchor.slack_queue_channel_id,
        anchor.slack_queue_message_ts,
        withoutSlack
      );
    }

    logger.info('Slack queue batch merged into existing card', {
      gmailMessageId,
      attachmentCount: batchItems.length,
      filenames: batchItems.map((i) => i.attachment_filename),
      slackTs: anchor.slack_queue_message_ts,
    });
    return;
  }

  const postTarget = await resolveQueuePostTarget(allItems, caseRow);
  const slackMsg = await slackService.postQueueBatch(allItems, caseRow, {
    emailReceivedAt: payload.receivedAt,
    channelId: postTarget.channelId,
    mentionUserIds: postTarget.mentionIds,
    postedToCaseChannel: postTarget.routedToCaseChannel,
  });
  const taggedStored = taggedUserIdsToStored(slackMsg.taggedUserIds);
  const taggedNamesStored = taggedUserNamesToStored(slackMsg.taggedUserNames);

  for (const item of allItems) {
    await updateFileSorterItem(item.id, {
      slack_queue_channel_id: slackMsg.channel,
      slack_queue_message_ts: slackMsg.ts,
      queue_tagged_slack_user_id: taggedStored,
      queue_tagged_slack_user_name: taggedNamesStored,
    });
    await auditService.log(item.id, 'slack_queued', {
      channel: slackMsg.channel,
      ts: slackMsg.ts,
      batchSize: allItems.length,
      taggedUserIds: slackMsg.taggedUserIds,
      taggedUserNames: slackMsg.taggedUserNames,
      routedToCaseChannel: postTarget.routedToCaseChannel,
    });
  }

  logger.info('Slack queue batch posted', {
    gmailMessageId,
    attachmentCount: allItems.length,
    filenames: allItems.map((i) => i.attachment_filename),
    routedToCaseChannel: postTarget.routedToCaseChannel,
    channelId: slackMsg.channel,
  });
}
