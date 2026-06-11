import { getEnv } from '../config/env.js';
import { getConversationInfo, lookupSlackUserByEmail } from './slackChannels.js';
import { parseUserMentionsFromSlackTopic } from '../utils/slackCaseParser.js';
import { logger } from '../utils/logger.js';

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function addUserId(seen: Set<string>, ids: string[], id: string): void {
  const cleaned = id.trim();
  if (!SLACK_USER_ID.test(cleaned) || seen.has(cleaned)) return;
  seen.add(cleaned);
  ids.push(cleaned);
}

function addMentionsFromText(seen: Set<string>, ids: string[], text: string): void {
  for (const id of parseUserMentionsFromSlackTopic(text)) {
    addUserId(seen, ids, id);
  }
}

async function resolveEnvToken(
  token: string,
  seen: Set<string>,
  ids: string[]
): Promise<void> {
  const raw = token.trim();
  if (!raw) return;

  const fromMention = raw.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i)?.[1];
  if (fromMention) {
    addUserId(seen, ids, fromMention);
    return;
  }

  const bare = raw.replace(/^<@|>$/g, '').trim();
  if (SLACK_USER_ID.test(bare)) {
    addUserId(seen, ids, bare);
    return;
  }

  if (EMAIL.test(bare)) {
    const id = await lookupSlackUserByEmail(bare);
    if (id) addUserId(seen, ids, id);
    else {
      logger.warn('Queue mention email did not resolve to a Slack user', { email: bare });
    }
  }
}

/** Slack user IDs to @mention on new queue cards (env + queue channel topic/description). */
export async function resolveQueueMentionUserIds(): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];

  const fromEnv = getEnv().SLACK_QUEUE_MENTION_USER_IDS?.trim() ?? '';
  if (fromEnv) {
    for (const part of fromEnv.split(/[,\s]+/)) {
      await resolveEnvToken(part, seen, ids);
    }
  }

  try {
    const channelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
    const convo = await getConversationInfo(channelId);
    if (convo) {
      if (convo.topic) addMentionsFromText(seen, ids, convo.topic);
      if (convo.purpose) addMentionsFromText(seen, ids, convo.purpose);
      if (!ids.length && (convo.topic || convo.purpose)) {
        logger.info('Queue channel has topic/description but no <@U…> mentions parsed', {
          channelId,
          hasTopic: Boolean(convo.topic),
          hasPurpose: Boolean(convo.purpose),
        });
      }
    }
  } catch (err) {
    logger.warn('Could not load queue channel for staff mentions', {
      err: String(err),
    });
  }

  if (ids.length > 0) {
    logger.info('Queue mention users resolved', { count: ids.length, userIds: ids });
  } else if (fromEnv) {
    logger.warn('SLACK_QUEUE_MENTION_USER_IDS is set but no user IDs resolved', {
      configured: fromEnv,
    });
  }

  return ids;
}
