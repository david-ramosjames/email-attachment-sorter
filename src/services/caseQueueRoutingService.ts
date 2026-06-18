import { CASE_DIRECT_ROUTE_THRESHOLD } from '../constants/classification.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { parseUserMentionsFromSlackTopic } from '../utils/slackCaseParser.js';
import { queueChannelId } from '../utils/queueChannel.js';
import { logger } from '../utils/logger.js';
import { ensureBotCanUploadToChannel, ensureBotInQueueChannel, getConversationInfo } from './slackChannels.js';
import { resolveCaseSlackChannelId } from './slackService.js';
import { pickQueueMentionUserIdsForNewCard } from './queueMentionService.js';

export interface QueuePostTarget {
  channelId: string;
  mentionIds: string[];
  routedToCaseChannel: boolean;
}

function pickPrimaryByCaseConfidence(items: FileSorterItem[]): FileSorterItem {
  return items.reduce((best, cur) => {
    const curScore = cur.ai_case_confidence ?? cur.ai_confidence ?? 0;
    const bestScore = best.ai_case_confidence ?? best.ai_confidence ?? 0;
    return curScore > bestScore ? cur : best;
  });
}

/** True when the batch should post to the matched case channel instead of #file-sorter-queue. */
export function shouldRouteBatchToCaseChannel(
  items: FileSorterItem[],
  caseRow: Case | null
): boolean {
  if (!caseRow?.case_number) return false;

  const primary = pickPrimaryByCaseConfidence(items);
  const confidence = primary.ai_case_confidence;
  if (confidence == null || confidence < CASE_DIRECT_ROUTE_THRESHOLD) return false;
  if (primary.suggested_case_number !== caseRow.case_number) return false;

  return items.every(
    (i) => !i.suggested_case_number || i.suggested_case_number === caseRow.case_number
  );
}

/** @mention staff from the case channel topic (attorney/paralegal), with DB fallback. */
export async function pickCaseChannelMentionUserIds(
  caseRow: Case,
  channelId: string
): Promise<string[]> {
  try {
    const convo = await getConversationInfo(channelId);
    if (convo?.topic) {
      const fromTopic = parseUserMentionsFromSlackTopic(convo.topic);
      if (fromTopic.length) {
        logger.info('Case channel mention pool from topic', {
          caseNumber: caseRow.case_number,
          channelId,
          count: fromTopic.length,
          userIds: fromTopic,
        });
        return fromTopic;
      }
    }
  } catch (err) {
    logger.warn('Could not load case channel topic for staff mentions', {
      caseNumber: caseRow.case_number,
      channelId,
      err: String(err),
    });
  }

  const ids: string[] = [];
  if (caseRow.attorney_slack_user_id?.trim()) {
    ids.push(caseRow.attorney_slack_user_id.trim());
  }
  if (
    caseRow.paralegal_slack_user_id?.trim() &&
    caseRow.paralegal_slack_user_id !== caseRow.attorney_slack_user_id
  ) {
    ids.push(caseRow.paralegal_slack_user_id.trim());
  }

  if (ids.length) {
    logger.info('Case channel mention pool from stored staff', {
      caseNumber: caseRow.case_number,
      userIds: ids,
    });
  }

  return ids;
}

/** Where to post a new queue card (case channel when confidence is high, else shared queue). */
export async function resolveQueuePostTarget(
  items: FileSorterItem[],
  caseRow: Case | null
): Promise<QueuePostTarget> {
  const queueChannelIdValue = queueChannelId();

  if (caseRow && shouldRouteBatchToCaseChannel(items, caseRow)) {
    const caseChannelId = await resolveCaseSlackChannelId(caseRow);
    if (caseChannelId) {
      const access = await ensureBotCanUploadToChannel(caseChannelId);
      if (access.isMember) {
        const mentionIds = await pickCaseChannelMentionUserIds(caseRow, caseChannelId);
        logger.info('Routing queue card to case channel', {
          caseNumber: caseRow.case_number,
          channelId: caseChannelId,
          mentionCount: mentionIds.length,
          primaryCaseConfidence: pickPrimaryByCaseConfidence(items).ai_case_confidence,
        });
        return {
          channelId: caseChannelId,
          mentionIds,
          routedToCaseChannel: true,
        };
      }
      logger.warn('Cannot route to case channel — bot not a member', {
        caseNumber: caseRow.case_number,
        channelId: caseChannelId,
        slackError: access.slackError,
      });
    } else {
      logger.warn('Cannot route to case channel — channel not resolved', {
        caseNumber: caseRow.case_number,
        slackChannelName: caseRow.slack_channel_name,
      });
    }
  }

  await ensureBotInQueueChannel();
  const mentionIds = await pickQueueMentionUserIdsForNewCard();
  return {
    channelId: queueChannelIdValue,
    mentionIds,
    routedToCaseChannel: false,
  };
}
