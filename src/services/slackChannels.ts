import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
  topic: string;
}

export interface SlackPublicJoinResult {
  publicChannels: number;
  alreadyMember: number;
  joined: number;
  failed: number;
  failedChannelNames: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackApiForm<T>(
  method: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      body.set(key, String(value));
    }
  }
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: body.toString(),
  });
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!(data as { ok: boolean }).ok) {
    throw new Error(`Slack API ${method} failed: ${(data as { error?: string }).error}`);
  }
  return data;
}

/** Paginated list of channels the bot can see (must be invited to private case channels). */
export async function listAllSlackChannels(): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await slackApiForm<{
      channels: Array<{
        id?: string;
        name?: string;
        is_private?: boolean;
        is_archived?: boolean;
        is_member?: boolean;
        topic?: { value?: string };
      }>;
      response_metadata?: { next_cursor?: string };
    }>('conversations.list', {
      types: 'public_channel,private_channel',
      limit: 500,
      exclude_archived: true,
      cursor,
    });

    for (const ch of page.channels ?? []) {
      if (!ch.id || !ch.name) continue;
      channels.push({
        id: ch.id,
        name: ch.name,
        isPrivate: Boolean(ch.is_private),
        isArchived: Boolean(ch.is_archived),
        isMember: Boolean(ch.is_member),
        topic: ch.topic?.value?.trim() ?? '',
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  logger.info('Slack channels listed', { count: channels.length });
  return channels;
}

/** Join a public channel so the bot can upload files. Private channels require /invite. */
export async function ensureBotInChannel(channelId: string): Promise<boolean> {
  try {
    await slackApiForm<{ channel?: { id?: string } }>('conversations.join', {
      channel: channelId,
    });
    return true;
  } catch (err) {
    const msg = String(err);
    if (msg.includes('already_in_channel')) return true;
    throw err;
  }
}

/**
 * Join every public channel the bot can see (requires channels:join).
 * Skips channels where is_member is already true. Rate-limited for Slack API tiers.
 */
export async function joinAllPublicSlackChannels(
  channels?: SlackChannelSummary[],
  opts?: { delayMs?: number }
): Promise<SlackPublicJoinResult> {
  const all = channels ?? (await listAllSlackChannels());
  const delayMs = opts?.delayMs ?? 120;
  const publicChannels = all.filter((ch) => !ch.isPrivate && !ch.isArchived);

  let alreadyMember = 0;
  let joined = 0;
  let failed = 0;
  const failedChannelNames: string[] = [];

  for (const ch of publicChannels) {
    if (ch.isMember) {
      alreadyMember++;
      continue;
    }

    try {
      await ensureBotInChannel(ch.id);
      joined++;
    } catch (err) {
      failed++;
      if (failedChannelNames.length < 25) {
        failedChannelNames.push(ch.name);
      }
      logger.warn('Failed to join public Slack channel', {
        channelId: ch.id,
        channelName: ch.name,
        err: String(err),
      });
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const result: SlackPublicJoinResult = {
    publicChannels: publicChannels.length,
    alreadyMember,
    joined,
    failed,
    failedChannelNames,
  };
  logger.info('Public Slack channel join pass complete', { ...result });
  return result;
}

export async function getConversationInfo(channelId: string): Promise<{
  id: string;
  name: string;
  topic: string;
} | null> {
  const data = await slackApiForm<{
    channel?: {
      id?: string;
      name?: string;
      topic?: { value?: string };
    };
  }>('conversations.info', { channel: channelId });

  const ch = data.channel;
  if (!ch?.id || !ch.name) return null;

  return {
    id: ch.id,
    name: ch.name,
    topic: ch.topic?.value?.trim() ?? '',
  };
}

let channelIdByName: Map<string, string> | null = null;

export function clearSlackChannelNameCache(): void {
  channelIdByName = null;
}

/** Lowercase channel name → channel id (loads from Slack on first use). */
export async function getSlackChannelIdByNameMap(): Promise<Map<string, string>> {
  if (channelIdByName) return channelIdByName;
  channelIdByName = new Map();
  for (const ch of await listAllSlackChannels()) {
    channelIdByName.set(ch.name.toLowerCase(), ch.id);
  }
  return channelIdByName;
}
