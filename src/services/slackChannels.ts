import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';

/** Fatal Slack errors — remaining joins will fail the same way. */
const FATAL_JOIN_ERRORS = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'access_denied',
]);

const CASE_CHANNEL_NAME = /^(.*)-(\d+)$/;

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
  /** Public channels skipped (non-case names when case-only mode is on). */
  skippedNonCase: number;
  alreadyMember: number;
  joined: number;
  failed: number;
  failedChannelNames: string[];
  failedByError: Record<string, number>;
  abortedEarly: boolean;
  abortReason: string | null;
}

import { SlackApiError } from '../utils/slackErrors.js';
export { SlackApiError };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSlackError(
  method: string,
  data: { error?: string; retry_after?: number },
  retryAfterHeader?: string | null
): SlackApiError {
  const code = data.error ?? 'unknown';
  const fromBody =
    typeof data.retry_after === 'number' && data.retry_after > 0 ? data.retry_after : null;
  const fromHeader = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  const retryAfter =
    fromBody ?? (Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : null);
  return new SlackApiError(method, code, retryAfter);
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
  const data = (await res.json()) as T & {
    ok: boolean;
    error?: string;
    retry_after?: number;
  };
  if (!(data as { ok: boolean }).ok) {
    throw parseSlackError(method, data, res.headers.get('Retry-After'));
  }
  return data;
}

export function isLikelyCaseSlackChannel(name: string): boolean {
  return CASE_CHANNEL_NAME.test(String(name || '').trim().toLowerCase());
}

function joinDelayMs(): number {
  const fromEnv = process.env.SLACK_JOIN_DELAY_MS;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1500;
}

let joinInProgress = false;

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

export function slackJoinHint(code: string): string {
  switch (code) {
    case 'missing_scope':
      return 'Add channels:join to the Slack app, reinstall to the workspace, then retry.';
    case 'ratelimited':
      return 'Slack rate limit — increase SLACK_JOIN_DELAY_MS (default 1500) and retry later.';
    case 'restricted_action':
      return 'Workspace policy may block bots from joining channels — ask a Slack admin.';
    case 'method_not_supported_for_channel_type':
      return 'Channel is not a joinable public channel (may be private or special type).';
    default:
      return 'Check Slack app scopes and workspace channel restrictions.';
  }
}

/** Join a public channel so the bot can upload files. Private channels require /invite. */
export async function ensureBotInChannel(channelId: string): Promise<boolean> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await slackApiForm<{ channel?: { id?: string } }>('conversations.join', {
        channel: channelId,
      });
      return true;
    } catch (err) {
      const slackErr = err instanceof SlackApiError ? err : null;
      const code = slackErr?.code ?? 'unknown';

      if (code === 'already_in_channel') return true;

      if (code === 'ratelimited' && attempt < maxAttempts) {
        const waitSec = slackErr?.retryAfterSec ?? 30;
        logger.warn('Slack join rate limited — waiting before retry', {
          channelId,
          waitSec,
          attempt,
        });
        await sleep(waitSec * 1000);
        continue;
      }

      throw err;
    }
  }
  return false;
}

function caseChannelsOnly(): boolean {
  return getEnv().SLACK_AUTO_JOIN_CASE_CHANNELS_ONLY;
}

/**
 * Join public case channels the bot can see (requires channels:join).
 * Skips channels where is_member is already true. Rate-limited for Slack API tiers.
 */
export async function joinAllPublicSlackChannels(
  channels?: SlackChannelSummary[],
  opts?: { delayMs?: number; caseChannelsOnly?: boolean }
): Promise<SlackPublicJoinResult> {
  if (joinInProgress) {
    logger.info('Skipping public Slack join — previous pass still running');
    return {
      publicChannels: 0,
      skippedNonCase: 0,
      alreadyMember: 0,
      joined: 0,
      failed: 0,
      failedChannelNames: [],
      failedByError: {},
      abortedEarly: true,
      abortReason: 'join_already_in_progress',
    };
  }

  joinInProgress = true;
  try {
    await ensureBotInQueueChannel();

    const all = channels ?? (await listAllSlackChannels());
    const delayMs = opts?.delayMs ?? joinDelayMs();
    const onlyCaseChannels = opts?.caseChannelsOnly ?? caseChannelsOnly();
    const queueChannelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();

    let publicChannels = all.filter((ch) => !ch.isPrivate && !ch.isArchived);
    let skippedNonCase = 0;

    if (onlyCaseChannels) {
      const before = publicChannels.length;
      publicChannels = publicChannels.filter(
        (ch) => ch.id === queueChannelId || isLikelyCaseSlackChannel(ch.name)
      );
      skippedNonCase = before - publicChannels.length;
    }

    let alreadyMember = 0;
    let joined = 0;
    let failed = 0;
    const failedChannelNames: string[] = [];
    const failedByError: Record<string, number> = {};
    let abortedEarly = false;
    let abortReason: string | null = null;

    logger.info('Starting public Slack channel join pass', {
      publicChannels: publicChannels.length,
      skippedNonCase,
      delayMs,
      caseChannelsOnly: onlyCaseChannels,
    });

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
        const code = err instanceof SlackApiError ? err.code : 'unknown';
        failedByError[code] = (failedByError[code] ?? 0) + 1;

        if (failedChannelNames.length < 25) {
          failedChannelNames.push(ch.name);
        }

        if (failed === 1) {
          logger.error('First public Slack join failure', {
            channelId: ch.id,
            channelName: ch.name,
            slackError: code,
            hint: slackJoinHint(code),
            err: String(err),
          });
        } else if (failed <= 5) {
          logger.warn('Failed to join public Slack channel', {
            channelId: ch.id,
            channelName: ch.name,
            slackError: code,
            err: String(err),
          });
        }

        if (FATAL_JOIN_ERRORS.has(code)) {
          abortedEarly = true;
          abortReason = code;
          logger.error('Aborting public Slack join pass — fatal Slack error', {
            slackError: code,
            hint: slackJoinHint(code),
            joined,
            failed,
            remaining: publicChannels.length - alreadyMember - joined - failed,
          });
          break;
        }
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const result: SlackPublicJoinResult = {
      publicChannels: publicChannels.length,
      skippedNonCase,
      alreadyMember,
      joined,
      failed,
      failedChannelNames,
      failedByError,
      abortedEarly,
      abortReason,
    };
    logger.info('Public Slack channel join pass complete', {
      ...result,
      summary: `caseChannels=${publicChannels.length} joined=${joined} alreadyMember=${alreadyMember} failed=${failed}`,
    });
    return result;
  } finally {
    joinInProgress = false;
  }
}

export async function getConversationInfo(channelId: string): Promise<{
  id: string;
  name: string;
  topic: string;
  purpose: string;
  isMember: boolean;
  isPrivate: boolean;
} | null> {
  const data = await slackApiForm<{
    channel?: {
      id?: string;
      name?: string;
      is_member?: boolean;
      is_private?: boolean;
      topic?: { value?: string };
      purpose?: { value?: string };
    };
  }>('conversations.info', { channel: channelId });

  const ch = data.channel;
  if (!ch?.id || !ch.name) return null;

  return {
    id: ch.id,
    name: ch.name,
    topic: ch.topic?.value?.trim() ?? '',
    purpose: ch.purpose?.value?.trim() ?? '',
    isMember: Boolean(ch.is_member),
    isPrivate: Boolean(ch.is_private),
  };
}

/** Resolve a workspace member ID from their email (needs users:read.email). */
export async function lookupSlackUserByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  try {
    const data = await slackApiForm<{ user?: { id?: string; deleted?: boolean } }>(
      'users.lookupByEmail',
      { email: normalized }
    );
    const id = data.user?.id?.trim();
    if (!id || data.user?.deleted) return null;
    return id;
  } catch (err) {
    logger.warn('Slack users.lookupByEmail failed', {
      email: normalized,
      err: String(err),
    });
    return null;
  }
}

export interface BotChannelUploadAccess {
  channelId: string;
  channelName: string;
  isMember: boolean;
  isPrivate: boolean;
  joinedNow: boolean;
  slackError: string | null;
}

/** Join a public case channel when needed so files.upload can attach PDFs. */
export async function ensureBotCanUploadToChannel(
  channelId: string
): Promise<BotChannelUploadAccess> {
  let channelName = channelId;
  let isPrivate = false;
  let isMember = false;

  try {
    const info = await getConversationInfo(channelId);
    if (info) {
      channelName = info.name;
      isPrivate = info.isPrivate;
      isMember = info.isMember;
    }
  } catch (err) {
    logger.warn('Could not load Slack channel info before join', {
      channelId,
      err: String(err),
    });
  }

  if (isMember) {
    return {
      channelId,
      channelName,
      isMember: true,
      isPrivate,
      joinedNow: false,
      slackError: null,
    };
  }

  try {
    await ensureBotInChannel(channelId);
    const after = await getConversationInfo(channelId);
    if (after?.isMember) {
      logger.info('Joined Slack case channel for file upload', {
        channelId,
        channelName: after.name,
      });
      return {
        channelId,
        channelName: after.name,
        isMember: true,
        isPrivate: after.isPrivate,
        joinedNow: true,
        slackError: null,
      };
    }
    logger.warn('Slack join returned ok but bot is still not a channel member', {
      channelId,
      channelName,
    });
    return {
      channelId,
      channelName,
      isMember: false,
      isPrivate,
      joinedNow: false,
      slackError: 'not_in_channel',
    };
  } catch (err) {
    const slackError = err instanceof SlackApiError ? err.code : 'unknown';
    logger.warn('Could not join Slack case channel for file upload', {
      channelId,
      channelName,
      isPrivate,
      slackError,
      hint: slackJoinHint(slackError),
      err: String(err),
    });
    return {
      channelId,
      channelName,
      isMember: false,
      isPrivate: isPrivate || slackError === 'method_not_supported_for_channel_type',
      joinedNow: false,
      slackError,
    };
  }
}

/** Always join the configured #file-sorter-queue channel (required for thread reads). */
export async function ensureBotInQueueChannel(): Promise<BotChannelUploadAccess> {
  const channelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
  const access = await ensureBotCanUploadToChannel(channelId);
  if (!access.isMember) {
    logger.warn('File Sorter bot is not a member of the queue channel', {
      channelId,
      channelName: access.channelName,
      isPrivate: access.isPrivate,
      slackError: access.slackError,
      hint: access.isPrivate
        ? 'Private channel — run /invite @RJL File Sorter in the queue channel.'
        : 'Ensure channels:join scope is installed and SLACK_FILE_SORTER_QUEUE_CHANNEL_ID is correct.',
    });
  } else if (access.joinedNow) {
    logger.info('Joined File Sorter queue channel', {
      channelId,
      channelName: access.channelName,
    });
  }
  return access;
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
