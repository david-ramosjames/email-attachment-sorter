import { getEnv } from '../config/env.js';
import { getConversationInfo, lookupSlackUserByEmail } from './slackChannels.js';
import { pickNextQueueMentionUserId } from '../db/supabase.js';
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

async function resolveEnvMentionUserIds(): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];
  const fromEnv = getEnv().SLACK_QUEUE_MENTION_USER_IDS?.trim() ?? '';
  if (!fromEnv) return ids;

  for (const part of fromEnv.split(/[,\s]+/)) {
    await resolveEnvToken(part, seen, ids);
  }
  return ids;
}

/**
 * Mention pool for new queue cards.
 * Queue channel topic @mentions win; SLACK_QUEUE_MENTION_USER_IDS is the fallback.
 */
export async function getQueueMentionPool(): Promise<string[]> {
  try {
    const channelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
    const convo = await getConversationInfo(channelId);
    if (convo?.topic) {
      const fromTopic = parseUserMentionsFromSlackTopic(convo.topic);
      if (fromTopic.length) {
        logger.info('Queue mention pool from channel topic', {
          channelId,
          count: fromTopic.length,
          userIds: fromTopic,
        });
        return fromTopic;
      }
      logger.info('Queue channel topic has no parseable <@U…> mentions', {
        channelId,
        topicPreview: convo.topic.slice(0, 120),
      });
    }
  } catch (err) {
    logger.warn('Could not load queue channel topic for staff mentions', {
      err: String(err),
    });
  }

  const fromEnv = await resolveEnvMentionUserIds();
  if (fromEnv.length) {
    logger.info('Queue mention pool from env fallback', {
      count: fromEnv.length,
      userIds: fromEnv,
    });
  }
  return fromEnv;
}

/** User IDs to @mention on the next new queue card (rotates when enabled). */
export async function pickQueueMentionUserIdsForNewCard(): Promise<string[]> {
  const pool = await getQueueMentionPool();
  if (!pool.length) return [];

  const rotate = getEnv().SLACK_QUEUE_MENTION_ROTATE;
  if (!rotate || pool.length === 1) {
    return pool;
  }

  try {
    const nextId = await pickNextQueueMentionUserId(pool);
    if (!nextId) return [];
    logger.info('Queue mention rotation picked user', {
      userId: nextId,
      poolSize: pool.length,
      poolUserIds: pool,
    });
    return [nextId];
  } catch (err) {
    logger.warn('Queue mention rotation failed — tagging first user in pool', {
      err: String(err),
      poolUserIds: pool,
    });
    return [pool[0]!];
  }
}

/** @deprecated Use pickQueueMentionUserIdsForNewCard — tags entire pool with no rotation. */
export async function resolveQueueMentionUserIds(): Promise<string[]> {
  return getQueueMentionPool();
}
