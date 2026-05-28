import { getEnv } from '../config/env.js';
import { getSlackChannelForCase, updateCaseSlackChannelId } from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { slackFieldText, slackSectionText } from '../utils/slackText.js';

const SLACK_API = 'https://slack.com/api';

/** channel name (lowercase) → channel id; refreshed on first lookup per process */
let slackChannelIdByName: Map<string, string> | null = null;

/** action_id must be unique per message; value carries item UUID for the handler. */
const ACTION_PREFIX = {
  approve: 'fs_appr_',
  change: 'fs_chg_',
  needs_attention: 'fs_attn_',
  do_not_sort: 'fs_skip_',
} as const;

type SlackActionType = keyof typeof ACTION_PREFIX;

function actionIdFor(type: SlackActionType, itemId: string): string {
  return `${ACTION_PREFIX[type]}${itemId}`;
}

export function extractItemIdFromAction(
  actionId: string,
  value?: string
): string | null {
  if (value?.trim()) return value.trim();
  for (const prefix of Object.values(ACTION_PREFIX)) {
    if (actionId.startsWith(prefix)) {
      const id = actionId.slice(prefix.length);
      return id.length > 0 ? id : null;
    }
  }
  const legacy = actionId.match(/^file_sorter_(?:approve|change|needs_attention|do_not_sort)_(.+)$/);
  return legacy?.[1] ?? null;
}

export function slackActionType(actionId: string): SlackActionType | null {
  for (const [type, prefix] of Object.entries(ACTION_PREFIX) as [SlackActionType, string][]) {
    if (actionId.startsWith(prefix)) return type;
  }
  const legacy = actionId.match(
    /^file_sorter_(approve|change|needs_attention|do_not_sort)(?:_|$)/
  );
  if (legacy) return legacy[1] as SlackActionType;
  if (actionId === 'file_sorter_approve') return 'approve';
  if (actionId === 'file_sorter_change') return 'change';
  if (actionId === 'file_sorter_needs_attention') return 'needs_attention';
  if (actionId === 'file_sorter_do_not_sort') return 'do_not_sort';
  return null;
}

async function slackApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!(data as { ok: boolean }).ok) {
    throw new Error(`Slack API ${method} failed: ${(data as { error?: string }).error}`);
  }
  return data;
}

/** Form-encoded POST — required for some methods (e.g. conversations.replies). */
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

export interface SlackThreadContext {
  channelId: string;
  /** Parent message timestamp (thread root) */
  messageTs: string;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending_review: 'Pending review',
    approved: 'Approved',
    saved: 'Sorted to Dropbox',
    needs_attention: 'Needs attention',
    ignored: 'Do not sort',
    failed: 'Failed',
  };
  return map[status] ?? status;
}

function slackUserMention(userId: string): string {
  return `<@${userId.trim()}>`;
}

function folderLabelFromPath(path: string | null): string {
  if (!path) return '—';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function buildQueueBlocks(
  item: FileSorterItem,
  caseRow: Case | null,
  options?: {
    statusOverride?: string;
    reviewedByUserId?: string;
    dropboxLink?: string;
    disabled?: boolean;
  }
): Record<string, unknown>[] {
  const disabled = options?.disabled ?? false;
  const status = options?.statusOverride ?? item.status;
  const reviewedBy = options?.reviewedByUserId?.trim();
  const caseLabel = caseRow
    ? `${caseRow.slack_channel_name} (${caseRow.case_number})`
    : item.suggested_case_number ?? '—';
  const folderDisplay =
    item.suggested_folder_path != null
      ? folderLabelFromPath(item.suggested_folder_path)
      : '—';
  const toLine = [...item.to_emails, ...item.cc_emails].filter(Boolean).join(', ') || '—';

  const headerText =
    status === 'saved'
      ? 'File sorted'
      : status === 'ignored'
        ? 'Not sorted'
        : status === 'needs_attention'
          ? 'Needs attention'
          : 'New File Sorter Item';

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: false },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${slackFieldText(statusLabel(status))}` },
        { type: 'mrkdwn', text: `*From:*\n${slackFieldText(item.from_email)}` },
        { type: 'mrkdwn', text: `*To:*\n${slackFieldText(toLine)}` },
        { type: 'mrkdwn', text: `*Subject:*\n${slackFieldText(item.subject ?? '—')}` },
        {
          type: 'mrkdwn',
          text: `*Attachment:*\n${slackFieldText(item.attachment_filename)}`,
        },
        { type: 'mrkdwn', text: `*AI Suggested Case:*\n${slackFieldText(caseLabel)}` },
        {
          type: 'mrkdwn',
          text: `*AI Suggested Folder:*\n${slackFieldText(folderDisplay)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Document Type:*\n${slackFieldText(item.suggested_document_type ?? '—')}`,
        },
        {
          type: 'mrkdwn',
          text: `*Confidence:*\n${item.ai_confidence != null ? `${(item.ai_confidence * 100).toFixed(0)}%` : '—'}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason:*\n${slackFieldText(item.ai_reason ?? '—')}`,
      },
    },
  ];

  if (status === 'saved') {
    const sortedPath = item.final_dropbox_path ?? item.suggested_folder_path;
    const folderName = folderLabelFromPath(sortedPath);
    const byLine = reviewedBy ? ` by ${slackUserMention(reviewedBy)}` : '';
    const linkLine = options?.dropboxLink
      ? `\n<${options.dropboxLink}|Open in Dropbox>`
      : '';
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionText(
          `:white_check_mark: *Successfully sorted to Dropbox*${byLine}\n` +
            `Case: ${caseLabel} · Folder: ${folderName}${linkLine}`
        ),
      },
    });
  } else if (status === 'ignored') {
    const byLine = reviewedBy ? ` by ${slackUserMention(reviewedBy)}` : '';
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionText(
          `:no_entry_sign: *Do Not Sort pressed*${byLine}\n` +
            'This attachment was not filed to Dropbox.'
        ),
      },
    });
  } else if (status === 'needs_attention' && reviewedBy) {
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionText(
          `:warning: *Needs Attention* — flagged by ${slackUserMention(reviewedBy)}`
        ),
      },
    });
  } else if (status === 'needs_attention') {
    blocks.unshift({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':warning: *Needs attention*' }],
    });
  }

  if (!disabled) {
    const itemId = item.id;
    blocks.push({
      type: 'actions',
      block_id: `fs_actions_${itemId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: actionIdFor('approve', itemId),
          value: itemId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Change', emoji: true },
          action_id: actionIdFor('change', itemId),
          value: itemId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Needs Attention', emoji: true },
          action_id: actionIdFor('needs_attention', itemId),
          value: itemId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Do Not Sort', emoji: true },
          action_id: actionIdFor('do_not_sort', itemId),
          value: itemId,
        },
      ],
    });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            '_Optional — reply in thread before Approve (examples only; use your own values):_\n' +
            '• `case: 1277` (case number)\n' +
            '• `case: First Last` (client first and last name)\n' +
            '• `folder: Medical`',
        },
      ],
    });
  }

  return blocks;
}

async function resolveCaseSlackChannelId(caseRow: Case): Promise<string | null> {
  const mapping = await getSlackChannelForCase(caseRow.case_number);
  const storedId = mapping?.slack_channel_id ?? caseRow.slack_channel_id;
  if (storedId?.trim()) return storedId.trim();

  const channelName = caseRow.slack_channel_name.trim().toLowerCase();
  if (!channelName) return null;

  if (!slackChannelIdByName) {
    slackChannelIdByName = new Map();
    let cursor: string | undefined;
    do {
      const page = await slackApiForm<{
        channels: Array<{ id?: string; name?: string }>;
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', {
        types: 'public_channel,private_channel',
        limit: 200,
        exclude_archived: true,
        cursor,
      });
      for (const ch of page.channels ?? []) {
        if (ch.id && ch.name) {
          slackChannelIdByName.set(ch.name.toLowerCase(), ch.id);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    logger.info('Slack channel list loaded for case cross-post', {
      count: slackChannelIdByName.size,
    });
  }

  const resolved = slackChannelIdByName.get(channelName) ?? null;
  if (resolved) {
    try {
      await updateCaseSlackChannelId(caseRow.case_number, resolved);
    } catch (err) {
      logger.warn('Could not persist slack_channel_id', {
        caseNumber: caseRow.case_number,
        err: String(err),
      });
    }
  }
  return resolved;
}

export const slackService = {
  async postQueueItem(item: FileSorterItem, caseRow: Case | null): Promise<{
    channel: string;
    ts: string;
  }> {
    const channel = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID;
    const blocks = buildQueueBlocks(item, caseRow);
    const result = await slackApi<{ channel: string; ts: string }>('chat.postMessage', {
      channel,
      text: `New File Sorter Item: ${item.attachment_filename}`,
      blocks,
    });
    return { channel: result.channel, ts: result.ts };
  },

  async updateQueueMessage(
    item: FileSorterItem,
    caseRow: Case | null,
    options?: {
      reviewedByUserId?: string;
      dropboxLink?: string;
      disabled?: boolean;
    }
  ): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    const reviewedByUserId =
      options?.reviewedByUserId ?? item.reviewed_by_slack_user_id ?? undefined;
    const blocks = buildQueueBlocks(item, caseRow, {
      statusOverride: item.status,
      reviewedByUserId,
      dropboxLink: options?.dropboxLink,
      disabled: options?.disabled ?? ['saved', 'ignored', 'failed'].includes(item.status),
    });
    const fallbackText =
      item.status === 'saved'
        ? `Sorted to Dropbox: ${item.attachment_filename}`
        : item.status === 'ignored'
          ? `Do not sort: ${item.attachment_filename}`
          : `File Sorter Item: ${item.attachment_filename} — ${statusLabel(item.status)}`;
    await slackApi('chat.update', {
      channel: item.slack_queue_channel_id,
      ts: item.slack_queue_message_ts,
      text: fallbackText,
      blocks,
    });
  },

  async postChangeInstructions(item: FileSorterItem): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    await slackApi('chat.postMessage', {
      channel: item.slack_queue_channel_id,
      thread_ts: item.slack_queue_message_ts,
      text:
        'Reply in this thread with overrides, then click Approve.\n' +
        'Examples (use your own values):\n' +
        '```case: 1277\ncase: First Last\nfolder: Medical```',
    });
  },

  async getThreadReplies(ctx: SlackThreadContext): Promise<string[]> {
    const channelId = ctx.channelId.trim();
    const ts = ctx.messageTs.trim();
    if (!channelId || !ts) {
      throw new Error('Missing Slack channel or message timestamp');
    }

    const result = await slackApiForm<{
      messages: Array<{ text?: string; user?: string; bot_id?: string; subtype?: string }>;
    }>('conversations.replies', {
      channel: channelId,
      ts,
      limit: 50,
    });

    return (result.messages ?? [])
      .filter((m) => !m.bot_id && m.subtype !== 'bot_message')
      .map((m) => m.text ?? '')
      .filter(Boolean);
  },

  async getUserDisplayName(userId: string): Promise<string> {
    try {
      const result = await slackApi<{
        user: {
          real_name?: string;
          name?: string;
          profile?: { display_name?: string; real_name?: string };
        };
      }>('users.info', { user: userId });
      const u = result.user;
      const fromProfile = u.profile?.display_name?.trim() || u.profile?.real_name?.trim();
      return fromProfile || u.real_name?.trim() || u.name?.trim() || userId;
    } catch {
      return userId;
    }
  },

  async postEphemeral(channel: string, userId: string, text: string): Promise<void> {
    await slackApi('chat.postEphemeral', { channel, user: userId, text });
  },

  async postCaseChannelConfirmation(opts: {
    caseRow: Case;
    item: FileSorterItem;
    dropboxLink: string;
    approvedByUserId: string;
  }): Promise<boolean> {
    const channelId = await resolveCaseSlackChannelId(opts.caseRow);

    if (!channelId) {
      logger.warn('No Slack channel for case cross-post', {
        caseNumber: opts.caseRow.case_number,
        slackChannelName: opts.caseRow.slack_channel_name,
      });
      return false;
    }

    const folderName = folderLabelFromPath(
      opts.item.final_dropbox_path ?? opts.item.suggested_folder_path
    );

    try {
      await slackApi('chat.postMessage', {
        channel: channelId,
        text: `Document sorted to Dropbox: ${opts.item.attachment_filename}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: slackSectionText(
                `:white_check_mark: *Document sorted to Dropbox*\n` +
                  `*${opts.item.attachment_filename}*\n` +
                  `Case: #${opts.caseRow.slack_channel_name} · Folder: ${folderName}\n` +
                  `From: ${opts.item.from_email}\n` +
                  `Subject: ${opts.item.subject ?? '—'}\n` +
                  `Sorted by: ${slackUserMention(opts.approvedByUserId)}\n` +
                  `<${opts.dropboxLink}|Open in Dropbox>`
              ),
            },
          },
        ],
      });
      logger.info('Cross-posted sorted document to case Slack channel', {
        caseNumber: opts.caseRow.case_number,
        channelId,
        filename: opts.item.attachment_filename,
      });
      return true;
    } catch (err) {
      logger.error('Failed to cross-post to case Slack channel', {
        caseNumber: opts.caseRow.case_number,
        channelId,
        slackChannelName: opts.caseRow.slack_channel_name,
        err: String(err),
      });
      return false;
    }
  },
};
