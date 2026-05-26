import { getEnv } from '../config/env.js';
import { getSlackChannelForCase } from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';

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

function actionId(suffix: string, itemId: string): string {
  return `file_sorter_${suffix}_${itemId}`;
}

function parseActionItemId(actionId: string): string | null {
  const match = actionId.match(/^file_sorter_\w+_(.+)$/);
  return match?.[1] ?? null;
}

export function extractItemIdFromAction(actionIdValue: string): string | null {
  return parseActionItemId(actionIdValue);
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending_review: 'PENDING REVIEW',
    approved: 'APPROVED',
    saved: 'SAVED',
    needs_attention: 'NEEDS ATTENTION',
    ignored: 'IGNORED',
    failed: 'FAILED',
  };
  return map[status] ?? status.toUpperCase();
}

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
    ? `${caseRow.case_name} (${caseRow.client_name})`
    : item.suggested_case_id ?? '—';

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'New File Sorter Item', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${statusLabel(status)}` },
        { type: 'mrkdwn', text: `*From:*\n${item.from_email}` },
        { type: 'mrkdwn', text: `*To:*\n${item.to_emails.join(', ') || '—'}` },
        { type: 'mrkdwn', text: `*Subject:*\n${item.subject ?? '—'}` },
        { type: 'mrkdwn', text: `*Attachment:*\n${item.attachment_filename}` },
        { type: 'mrkdwn', text: `*AI Suggested Case:*\n${caseLabel}` },
        {
          type: 'mrkdwn',
          text: `*AI Suggested Folder:*\n${item.suggested_folder_path ?? '—'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Document Type:*\n${item.suggested_document_type ?? '—'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Confidence:*\n${item.ai_confidence != null ? `${(item.ai_confidence * 100).toFixed(0)}%` : '—'}`,
        },
        { type: 'mrkdwn', text: `*Reason:*\n${item.ai_reason ?? '—'}` },
      ],
    },
  ];

  if (options?.approvedBy) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Approved by:* ${options.approvedBy}`,
      },
    });
  }
  if (options?.dropboxLink) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Saved to:*\n<${options.dropboxLink}|Open in Dropbox>`,
      },
    });
  }

  if (status === 'needs_attention') {
    blocks.unshift({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':warning: *NEEDS ATTENTION*',
        },
      ],
    });
  }

  if (!disabled) {
    blocks.push({
      type: 'actions',
      block_id: `actions_${item.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: actionId('approve', item.id),
          value: item.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Change' },
          action_id: actionId('change', item.id),
          value: item.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Needs Attention' },
          action_id: actionId('needs_attention', item.id),
          value: item.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Do Not Sort' },
          style: 'danger',
          action_id: actionId('do_not_sort', item.id),
          value: item.id,
        },
      ],
    });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_To change case/folder, reply in thread: `case: Name` and `folder: Label`_',
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
      text: `New File Sorter Item: ${item.attachment_filename}`,
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
      text: `File Sorter Item: ${item.attachment_filename} — ${statusLabel(item.status)}`,
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

  async getThreadReplies(channel: string, threadTs: string): Promise<string[]> {
    const result = await slackApi<{
      messages: Array<{ text?: string; user?: string; bot_id?: string }>;
    }>('conversations.replies', { channel, ts: threadTs, limit: 50 });
    return (result.messages ?? [])
      .filter((m) => !m.bot_id)
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
      text: `New document saved to Dropbox: ${opts.item.attachment_filename}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'New document saved to Dropbox', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Document:*\n${opts.item.attachment_filename}` },
            {
              type: 'mrkdwn',
              text: `*Dropbox folder:*\n${opts.item.final_dropbox_path ?? '—'}`,
            },
            {
              type: 'mrkdwn',
              text: `*Document type:*\n${opts.item.suggested_document_type ?? '—'}`,
            },
            { type: 'mrkdwn', text: `*Original sender:*\n${opts.item.from_email}` },
            { type: 'mrkdwn', text: `*Original subject:*\n${opts.item.subject ?? '—'}` },
            { type: 'mrkdwn', text: `*Approved by:*\n${opts.approvedBy}` },
            {
              type: 'mrkdwn',
              text: `*Dropbox:*\n<${opts.dropboxLink}|Open file>`,
            },
          ],
        },
      ],
    });
  },
};
