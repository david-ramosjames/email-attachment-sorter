import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

type SlackUserRecord = {
  id?: string;
  real_name?: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
};

let directoryCache: Map<string, string> | null = null;
let directoryExpiresAt = 0;
let directoryLoad: Promise<Map<string, string>> | null = null;

function displayNameFromUser(user: SlackUserRecord, fallbackId: string): string {
  const fromProfile =
    user.profile?.display_name?.trim() || user.profile?.real_name?.trim();
  return fromProfile || user.real_name?.trim() || user.name?.trim() || fallbackId;
}

async function slackApiForm<T>(
  method: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
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
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error ?? 'unknown'}`);
  }
  return data;
}

async function fetchUserInfoName(userId: string): Promise<string> {
  try {
    const data = await slackApiForm<{ user?: SlackUserRecord }>('users.info', {
      user: userId,
    });
    if (!data.user?.id) return userId;
    return displayNameFromUser(data.user, userId);
  } catch (err) {
    logger.warn('Slack users.info failed for display name', {
      userId,
      err: String(err),
    });
    return userId;
  }
}

async function loadDirectory(): Promise<Map<string, string>> {
  const now = Date.now();
  if (directoryCache && now < directoryExpiresAt) return directoryCache;

  if (directoryLoad) return directoryLoad;

  directoryLoad = (async () => {
    const map = new Map<string, string>();
    let cursor: string | undefined;

    try {
      do {
        const page = await slackApiForm<{
          members: SlackUserRecord[];
          response_metadata?: { next_cursor?: string };
        }>('users.list', {
          limit: 200,
          cursor,
        });

        for (const member of page.members ?? []) {
          if (!member.id || member.id === 'USLACKBOT') continue;
          if (member.deleted || member.is_bot) continue;
          map.set(member.id, displayNameFromUser(member, member.id));
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);

      directoryCache = map;
      directoryExpiresAt = Date.now() + CACHE_TTL_MS;
      logger.info('Slack user directory loaded', { count: map.size });
      return map;
    } catch (err) {
      logger.warn('Slack users.list failed — display names may show as IDs', {
        err: String(err),
        hint: 'Add users:read scope to the Slack app and reinstall',
      });
      return directoryCache ?? map;
    } finally {
      directoryLoad = null;
    }
  })();

  return directoryLoad;
}

export async function getSlackUserDisplayName(userId: string): Promise<string> {
  const id = userId.trim();
  if (!id) return userId;

  const dir = await loadDirectory();
  const cached = dir.get(id);
  if (cached && cached !== id) return cached;

  const fromInfo = await fetchUserInfoName(id);
  if (fromInfo !== id) {
    dir.set(id, fromInfo);
  }
  return fromInfo;
}

export async function getSlackUserDisplayNames(
  userIds: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  const dir = await loadDirectory();
  const out = new Map<string, string>();

  const missing: string[] = [];
  for (const id of unique) {
    const cached = dir.get(id);
    if (cached && cached !== id) {
      out.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  await Promise.all(
    missing.map(async (id) => {
      const name = await fetchUserInfoName(id);
      out.set(id, name);
      if (name !== id) dir.set(id, name);
    })
  );

  return out;
}
