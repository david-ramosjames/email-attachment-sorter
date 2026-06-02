import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
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
      }>;
      response_metadata?: { next_cursor?: string };
    }>('conversations.list', {
      types: 'public_channel,private_channel',
      limit: 200,
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
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  logger.info('Slack channels listed', { count: channels.length });
  return channels;
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
