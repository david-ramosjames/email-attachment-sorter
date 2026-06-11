import { getEnv } from '../config/env.js';
import { getConversationInfo } from './slackChannels.js';
import { parseUserMentionsFromSlackTopic } from '../utils/slackCaseParser.js';

const SLACK_USER_ID = /^U[A-Z0-9]+$/i;

/** Slack user IDs to @mention on new queue cards (env + queue channel topic). */
export async function resolveQueueMentionUserIds(): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];

  const fromEnv = getEnv().SLACK_QUEUE_MENTION_USER_IDS?.trim() ?? '';
  if (fromEnv) {
    for (const part of fromEnv.split(/[,\s]+/)) {
      const cleaned = part.trim().replace(/^<@|>$/g, '');
      if (SLACK_USER_ID.test(cleaned) && !seen.has(cleaned)) {
        seen.add(cleaned);
        ids.push(cleaned);
      }
    }
  }

  try {
    const channelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
    const convo = await getConversationInfo(channelId);
    if (convo?.topic) {
      for (const id of parseUserMentionsFromSlackTopic(convo.topic)) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  } catch {
    /* queue channel topic mentions are optional */
  }

  return ids;
}
