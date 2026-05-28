import { getEnv } from '../config/env.js';
import { getSlackChannelForCase } from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { slackFieldText, slackSectionText } from '../utils/slackText.js';

const SLACK_API = 'https://slack.com/api';

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
    saved: 'Saved',
    needs_attention: 'Needs attention',
    ignored: 'Ignored',
    failed: 'Failed',
  };
  return map[status] ?? status;
}

function folderLabelFromPath(path: string | null): string {
  if (!path) return '—';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Compact review card — details live in Supabase; buttons only send item id in `value`.
 */
function buildQueueBlocks(
  item: FileSorterItem,
  caseRow: Case | null,
  options?: {
    statusOverride?: string;
    approvedBy?: string;
    dropboxLink?: string;
    disabled?: boolean;
  }
): Record<string, unknown>[] {
  const disabled = options?.disabled ?? false;
  const status = options?.statusOverride ?? item.status;
  const caseLabel = caseRow
    ? `${caseRow.slack_channel_name} (${caseRow.case_number})`
    : item.suggested_case_number ?? '—';
  const folderLabel = folderLabelFromPath(item.suggested_folder_path);

  const lines = [
    `*${slackFieldText(item.attachment_filename, 200)}*`,
    `Status: ${statusLabel(status)}`,
    `Case: ${slackFieldText(caseLabel, 200)}`,
    `Folder: ${slackFieldText(folderLabel, 120)}`,
    item.suggested_document_type
      ? `Type: ${slackFieldText(item.suggested_document_type, 80)}`
      : null,
    item.ai_confidence != null
      ? `Confidence: ${(item.ai_confidence * 100).toFixed(0)}%`
      : null,
    `From: ${slackFieldText(item.from_email, 120)}`,
  ].filter(Boolean);

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: lines.join('\n'),
      },
    },
  ];

  if (options?.approvedBy) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Approved by ${slackFieldText(options.approvedBy, 80)}` }],
    });
  }
  if (options?.dropboxLink) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${options.dropboxLink}|Open in Dropbox>`,
        },
      ],
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
          text: 'To override before Approve, reply in thread: `case: Client Name` · `folder: Medical`',
        },
      ],
    });
  }

  return blocks;
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
      text: `File Sorter: ${item.attachment_filename} → ${caseRow?.case_number ?? item.suggested_case_number ?? '?'}`,
      blocks,
    });
    return { channel: result.channel, ts: result.ts };
  },

  async updateQueueMessage(
    item: FileSorterItem,
    caseRow: Case | null,
    options?: { approvedBy?: string; dropboxLink?: string; disabled?: boolean }
  ): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    const blocks = buildQueueBlocks(item, caseRow, {
      statusOverride: item.status,
      approvedBy: options?.approvedBy,
      dropboxLink: options?.dropboxLink,
      disabled: options?.disabled ?? ['saved', 'ignored', 'failed'].includes(item.status),
    });
    await slackApi('chat.update', {
      channel: item.slack_queue_channel_id,
      ts: item.slack_queue_message_ts,
      text: `File Sorter: ${item.attachment_filename} — ${statusLabel(item.status)}`,
      blocks,
    });
  },

  async postChangeInstructions(item: FileSorterItem): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    await slackApi('chat.postMessage', {
      channel: item.slack_queue_channel_id,
      thread_ts: item.slack_queue_message_ts,
      text: 'Reply in this thread with overrides, then click Approve:\n```case: Client or Case Name\nfolder: Pleadings```',
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
      const result = await slackApi<{ user: { real_name?: string; name?: string } }>(
        'users.info',
        { user: userId }
      );
      return result.user.real_name ?? result.user.name ?? userId;
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
    approvedBy: string;
  }): Promise<void> {
    const channelMapping = await getSlackChannelForCase(opts.caseRow.case_number);
    const channelId =
      channelMapping?.slack_channel_id ?? opts.caseRow.slack_channel_id ?? null;

    if (!channelId) {
      logger.warn('No Slack channel for case', {
        caseId: opts.caseRow.id,
        caseNumber: opts.caseRow.case_number,
      });
      return;
    }
    await slackApi('chat.postMessage', {
      channel: channelId,
      text: `Saved to Dropbox: ${opts.item.attachment_filename}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: slackSectionText(
              `*${opts.item.attachment_filename}*\n` +
                `Folder: ${opts.item.final_dropbox_path ?? '—'}\n` +
                `Approved by: ${opts.approvedBy}\n` +
                `<${opts.dropboxLink}|Open in Dropbox>`
            ),
          },
        },
      ],
    });
  },
};
