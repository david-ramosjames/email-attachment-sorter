import { batchUpsertCaseSlackChannels } from '../db/supabase.js';
import {
  clearSlackChannelNameCache,
  getConversationInfo,
} from './slackChannels.js';
import {
  parseChannelAndTopic,
  type ParsedSlackCase,
} from '../utils/slackCaseParser.js';
import { logger } from '../utils/logger.js';

const EVENT_TTL_MS = 6 * 60 * 60 * 1000;
const processedEventIds = new Map<string, number>();

function pruneProcessedEvents(): void {
  const cutoff = Date.now() - EVENT_TTL_MS;
  for (const [id, ts] of processedEventIds) {
    if (ts < cutoff) processedEventIds.delete(id);
  }
}

function alreadyProcessedEvent(eventId: string | undefined): boolean {
  if (!eventId) return false;
  pruneProcessedEvents();
  return processedEventIds.has(eventId);
}

function markProcessedEvent(eventId: string | undefined): void {
  if (!eventId) return;
  processedEventIds.set(eventId, Date.now());
}

const ALLOWED_DIRECT_EVENTS = new Set([
  'channel_created',
  'channel_rename',
  'member_joined_channel',
]);

const ALLOWED_MESSAGE_SUBTYPES = new Set([
  'channel_topic',
  'group_topic',
  'channel_name',
  'group_name',
]);

export function extractChannelIdFromSlackEvent(event: Record<string, unknown>): string | null {
  const channel = event.channel;
  if (channel && typeof channel === 'object' && channel !== null && 'id' in channel) {
    const id = (channel as { id?: string }).id;
    if (id) return id;
  }
  if (typeof channel === 'string' && channel) return channel;
  const item = event.item;
  if (item && typeof item === 'object' && item !== null && 'channel' in item) {
    const id = (item as { channel?: string }).channel;
    if (id) return id;
  }
  return null;
}

function isCaseIndexEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.type ?? '');
  const subtype = String(event.subtype ?? '');

  if (ALLOWED_DIRECT_EVENTS.has(eventType)) return true;
  return eventType === 'message' && ALLOWED_MESSAGE_SUBTYPES.has(subtype);
}

export async function upsertParsedSlackCase(
  parsed: ParsedSlackCase
): Promise<'inserted' | 'updated' | 'unchanged'> {
  await batchUpsertCaseSlackChannels([parsed], { preserveDropboxFolder: true });
  clearSlackChannelNameCache();
  return 'updated';
}

export async function syncCaseChannelById(
  channelId: string
): Promise<'ok' | 'not_case_channel' | 'lookup_failed'> {
  const convo = await getConversationInfo(channelId);
  if (!convo) return 'lookup_failed';

  const parsed = parseChannelAndTopic({
    channelId: convo.id,
    channelName: convo.name,
    topic: convo.topic,
  });

  if (!parsed) return 'not_case_channel';

  await upsertParsedSlackCase(parsed);
  logger.info('Case channel synced from Slack event', {
    caseNumber: parsed.case_number,
    channelName: parsed.slack_channel_name,
    topicStage: parsed.topic_stage,
  });
  return 'ok';
}

export interface SlackEventsWebhookResult {
  status: number;
  body: string | Record<string, unknown>;
}

/** Handles Slack Events API payloads (URL verification + case index updates). */
export async function handleSlackEventsWebhook(
  body: Record<string, unknown>
): Promise<SlackEventsWebhookResult> {
  if (body.type === 'url_verification') {
    return {
      status: 200,
      body: { challenge: body.challenge },
    };
  }

  if (body.type !== 'event_callback' || !body.event || typeof body.event !== 'object') {
    return { status: 200, body: 'ignored' };
  }

  const eventId = typeof body.event_id === 'string' ? body.event_id : undefined;
  if (alreadyProcessedEvent(eventId)) {
    return { status: 200, body: 'duplicate' };
  }

  const event = body.event as Record<string, unknown>;

  if (event.type === 'app_mention') {
    markProcessedEvent(eventId);
    return { status: 200, body: 'mention_ignored' };
  }

  if (!isCaseIndexEvent(event)) {
    markProcessedEvent(eventId);
    return { status: 200, body: 'ignored_event' };
  }

  const channelId = extractChannelIdFromSlackEvent(event);
  if (!channelId) {
    markProcessedEvent(eventId);
    return { status: 200, body: 'no_channel_id' };
  }

  try {
    const result = await syncCaseChannelById(channelId);
    markProcessedEvent(eventId);
    return { status: 200, body: result };
  } catch (err) {
    logger.error('Slack case event sync failed', {
      channelId,
      err: String(err),
    });
    markProcessedEvent(eventId);
    return { status: 200, body: 'error' };
  }
}
