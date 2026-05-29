import { RJL_STANDARD_SUBFOLDERS, type RjlSubfolder } from '../constants/rjlFolders.js';
import { getEnv } from '../config/env.js';
import {
  getQueueBatchItems,
  getSlackChannelForCase,
  updateCaseSlackChannelId,
} from '../db/supabase.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  slackFieldText,
  slackMrkdwnLink,
  slackSectionText,
  slackSectionWithExtras,
} from '../utils/slackText.js';

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

/**
 * Upload a file into a channel so it appears as a normal Slack file attachment.
 * Uses files.getUploadURLExternal + files.completeUploadExternal (files.upload is deprecated).
 * Requires files:write scope.
 */
async function slackUploadFileToChannel(opts: {
  channelId: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string | null;
  initialComment?: string;
}): Promise<void> {
  const mime = opts.mimeType?.trim() || 'application/octet-stream';

  const uploadStart = await slackApi<{
    upload_url: string;
    file_id: string;
  }>('files.getUploadURLExternal', {
    filename: opts.filename,
    length: opts.buffer.length,
  });

  const byteUpload = await fetch(uploadStart.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: opts.buffer,
  });
  if (!byteUpload.ok) {
    throw new Error(`Slack file byte upload failed: HTTP ${byteUpload.status}`);
  }

  await slackApi('files.completeUploadExternal', {
    files: [{ id: uploadStart.file_id, title: opts.filename }],
    channel_id: opts.channelId,
    initial_comment: opts.initialComment,
  });
}

/** Legacy fallback if external upload is unavailable on the workspace. */
async function slackUploadFileLegacy(opts: {
  channelId: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string | null;
  initialComment?: string;
}): Promise<void> {
  const form = new FormData();
  form.append('channels', opts.channelId);
  form.append('filename', opts.filename);
  if (opts.initialComment) form.append('initial_comment', opts.initialComment);
  const mime = opts.mimeType?.trim() || 'application/octet-stream';
  form.append('file', new Blob([opts.buffer], { type: mime }), opts.filename);

  const res = await fetch(`${SLACK_API}/files.upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}` },
    body: form,
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API files.upload failed: ${data.error ?? 'unknown'}`);
  }
}

async function slackUploadFileToChannelWithFallback(opts: {
  channelId: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string | null;
  initialComment?: string;
}): Promise<void> {
  try {
    await slackUploadFileToChannel(opts);
  } catch (err) {
    logger.warn('Slack external file upload failed, trying legacy files.upload', {
      filename: opts.filename,
      err: String(err),
    });
    await slackUploadFileLegacy(opts);
  }
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
  if (!parts.length) return '—';

  const known = new Set<string>(RJL_STANDARD_SUBFOLDERS);
  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i]!;
    if (known.has(segment as RjlSubfolder)) return segment;
  }

  const last = parts[parts.length - 1]!;
  if (/\.[a-z0-9]{2,5}$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2]!;
  }
  return last;
}

/** Slack renders this in each viewer's local timezone. */
function slackReceivedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const unix = Math.floor(ms / 1000);
  const fallback = new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `<!date^${unix}^{date_short_pretty} at {time}|${fallback}>`;
}

function threadOverrideHelpText(): string {
  const folderList = RJL_STANDARD_SUBFOLDERS.join(', ');
  return (
    '_Optional — reply in thread before Approve (use your own values):_\n' +
    '• `case: 1277` (case number) or `case: First Last` (client name)\n' +
    `• \`folder: <name>\` — ${folderList} (applies to all files in this email)\n` +
    '• `case hint: Client is Juan Garcia — sender is his daughter Maria` (who the client is)\n' +
    '• `sort hint: Law360 newsletters from this sender — Do Not Sort` (how to file by provider/sender)'
  );
}

function pickPrimaryQueueItem(items: FileSorterItem[]): FileSorterItem {
  const sorted = [...items].sort((a, b) => (b.ai_confidence ?? 0) - (a.ai_confidence ?? 0));
  return sorted.find((i) => i.suggested_case_number) ?? sorted[0]!;
}

function aggregateBatchStatus(items: FileSorterItem[]): string {
  if (items.every((i) => i.status === 'saved')) return 'saved';
  if (items.every((i) => i.status === 'ignored')) return 'ignored';
  if (items.some((i) => i.status === 'needs_attention')) return 'needs_attention';
  if (items.some((i) => i.status === 'failed')) return 'failed';
  return items[0]!.status;
}

function formatAttachmentList(items: FileSorterItem[]): string {
  return items
    .map((i) => {
      const folder = i.suggested_folder_path
        ? folderLabelFromPath(i.suggested_folder_path)
        : null;
      const folderNote = folder && folder !== '—' ? ` → ${folder}` : '';
      return `• \`${i.attachment_filename}\`${folderNote}`;
    })
    .join('\n');
}

function formatConfidenceRange(items: FileSorterItem[]): string {
  const values = items
    .map((i) => i.ai_confidence)
    .filter((c): c is number => c != null);
  if (!values.length) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return `${(min * 100).toFixed(0)}%`;
  return `${(min * 100).toFixed(0)}%–${(max * 100).toFixed(0)}%`;
}

function queueCardEmoji(status: string): string {
  switch (status) {
    case 'saved':
      return '✅';
    case 'ignored':
      return '🚫';
    case 'needs_attention':
      return '⚠️';
    case 'failed':
      return '❌';
    case 'pending_review':
      return '📥';
    default:
      return '📎';
  }
}

function buildQueueHeaderText(status: string, batch: boolean, batchCount: number): string {
  const emoji = queueCardEmoji(status);
  const batchSuffix = batch
    ? status === 'needs_attention' || status === 'saved' || status === 'failed'
      ? ` (${batchCount} files)`
      : ` (${batchCount} attachments)`
    : '';

  if (status === 'saved') {
    return `${emoji} ${batch ? `${batchCount} files sorted` : 'File sorted'}`;
  }
  if (status === 'ignored') {
    return `${emoji} Not sorted`;
  }
  if (status === 'needs_attention') {
    return `${emoji} New File Sorter Item — Needs Human Review${batchSuffix}`;
  }
  if (status === 'failed') {
    return `${emoji} File Sorter failed${batchSuffix}`;
  }
  return `${emoji} New File Sorter Item${batchSuffix}`;
}

function buildQueueBlocks(
  items: FileSorterItem[],
  caseRow: Case | null,
  options?: {
    statusOverride?: string;
    reviewedByUserId?: string;
    dropboxLink?: string;
    savedFiles?: Array<{ filename: string; dropboxLink: string }>;
    disabled?: boolean;
    emailReceivedAt?: string | null;
  }
): Record<string, unknown>[] {
  const batch = items.length > 1;
  const item = pickPrimaryQueueItem(items);
  const disabled = options?.disabled ?? false;
  const status = options?.statusOverride ?? (batch ? aggregateBatchStatus(items) : item.status);
  const reviewedBy = options?.reviewedByUserId?.trim();
  const caseLabel = caseRow
    ? `${caseRow.slack_channel_name} (${caseRow.case_number})`
    : item.suggested_case_number ?? '—';

  const folderLabels = [
    ...new Set(
      items
        .map((i) => folderLabelFromPath(i.suggested_folder_path))
        .filter((f) => f !== '—')
    ),
  ];
  const folderDisplay =
    folderLabels.length === 0
      ? '—'
      : folderLabels.length === 1
        ? folderLabels[0]!
        : `Multiple (${folderLabels.join(', ')})`;

  const docTypes = [
    ...new Set(items.map((i) => i.suggested_document_type).filter(Boolean)),
  ] as string[];
  const documentTypeDisplay =
    docTypes.length === 0 ? '—' : docTypes.length === 1 ? docTypes[0]! : docTypes.join(', ');

  const toLine = [...item.to_emails, ...item.cc_emails].filter(Boolean).join(', ') || '—';
  const attachmentDisplay = batch
    ? formatAttachmentList(items)
    : item.attachment_filename;

  const headerText = buildQueueHeaderText(status, batch, items.length);

  const blocks: Record<string, unknown>[] = [
    { type: 'divider' },
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${slackFieldText(statusLabel(status))}` },
        { type: 'mrkdwn', text: `*From:*\n${slackFieldText(item.from_email)}` },
        { type: 'mrkdwn', text: `*To:*\n${slackFieldText(toLine)}` },
        {
          type: 'mrkdwn',
          text: `*Received:*\n${slackReceivedAt(
            options?.emailReceivedAt ?? item.email_received_at ?? item.created_at
          )}`,
        },
        { type: 'mrkdwn', text: `*Subject:*\n${slackFieldText(item.subject ?? '—')}` },
        {
          type: 'mrkdwn',
          text: `*Attachment${batch ? 's' : ''}:*\n${slackFieldText(attachmentDisplay, batch ? 900 : 200)}`,
        },
        { type: 'mrkdwn', text: `*AI Suggested Case:*\n${slackFieldText(caseLabel)}` },
        {
          type: 'mrkdwn',
          text: `*AI Suggested Folder:*\n${slackFieldText(folderDisplay)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Document Type:*\n${slackFieldText(documentTypeDisplay)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Confidence:*\n${batch ? formatConfidenceRange(items) : item.ai_confidence != null ? `${(item.ai_confidence * 100).toFixed(0)}%` : '—'}`,
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
    const successExtras = [
      reviewedBy ? `Sorted by: ${slackUserMention(reviewedBy)}` : '',
    ];
    if (options?.savedFiles?.length) {
      for (const f of options.savedFiles) {
        successExtras.push(`${f.filename}: ${slackMrkdwnLink(f.dropboxLink, 'Open in Dropbox')}`);
      }
    } else if (options?.dropboxLink) {
      successExtras.push(slackMrkdwnLink(options.dropboxLink, 'Open in Dropbox'));
    }
    const sortedPath = item.final_dropbox_path ?? item.suggested_folder_path;
    const folderName = folderLabelFromPath(sortedPath);
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionWithExtras(
          `:white_check_mark: *Successfully sorted to Dropbox*\n` +
            `Case: ${caseLabel}` +
            (batch ? `\n${formatAttachmentList(items)}` : ` · Folder: ${folderName}`),
          successExtras.filter(Boolean)
        ),
      },
    });
  } else if (status === 'ignored') {
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionWithExtras(
          ':no_entry_sign: *Do Not Sort pressed*\nThis attachment was not filed to Dropbox.',
          reviewedBy ? [`Pressed by: ${slackUserMention(reviewedBy)}`] : []
        ),
      },
    });
  } else if (status === 'needs_attention' && reviewedBy) {
    blocks.unshift({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackSectionWithExtras(
          ':warning: *Needs Attention* — use Change Case/Folder, then Approve to file.',
          [`Flagged by: ${slackUserMention(reviewedBy)}`]
        ),
      },
    });
  }

  if (!disabled) {
    const itemId = item.id;
    const actionElements: Record<string, unknown>[] = [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve', emoji: true },
        style: 'primary',
        action_id: actionIdFor('approve', itemId),
        value: itemId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Change Case/Folder', emoji: true },
        action_id: actionIdFor('change', itemId),
        value: itemId,
      },
    ];
    if (status !== 'needs_attention') {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Needs Attention', emoji: true },
        action_id: actionIdFor('needs_attention', itemId),
        value: itemId,
      });
    }
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Do Not Sort', emoji: true },
      action_id: actionIdFor('do_not_sort', itemId),
      value: itemId,
    });
    blocks.push({
      type: 'actions',
      block_id: `fs_actions_${itemId}`,
      elements: actionElements,
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${queueCardEmoji(status)} *RJL File Sorter* · ${slackFieldText(
          batch ? `${items.length} attachments` : item.attachment_filename,
          120
        )}`,
      },
    ],
  });

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
  async postQueueBatch(
    items: FileSorterItem[],
    caseRow: Case | null,
    options?: { emailReceivedAt?: string | null }
  ): Promise<{ channel: string; ts: string }> {
    const channel = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID;
    const blocks = buildQueueBlocks(items, caseRow, options);
    const label =
      items.length === 1
        ? items[0]!.attachment_filename
        : `${items.length} attachments: ${items.map((i) => i.attachment_filename).join(', ')}`;
    const status = aggregateBatchStatus(items);
    const result = await slackApi<{ channel: string; ts: string }>('chat.postMessage', {
      channel,
      text: `${buildQueueHeaderText(status, items.length > 1, items.length)} — ${label}`,
      blocks,
    });
    return { channel: result.channel, ts: result.ts };
  },

  async postQueueItem(
    item: FileSorterItem,
    caseRow: Case | null,
    options?: { emailReceivedAt?: string | null }
  ): Promise<{ channel: string; ts: string }> {
    return slackService.postQueueBatch([item], caseRow, options);
  },

  async updateQueueMessage(
    item: FileSorterItem,
    caseRow: Case | null,
    options?: {
      reviewedByUserId?: string;
      dropboxLink?: string;
      savedFiles?: Array<{ filename: string; dropboxLink: string }>;
      disabled?: boolean;
    }
  ): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    const batchItems = await getQueueBatchItems(item);
    const reviewedByUserId =
      options?.reviewedByUserId ?? item.reviewed_by_slack_user_id ?? undefined;
    const status = aggregateBatchStatus(batchItems);
    const blocks = buildQueueBlocks(batchItems, caseRow, {
      statusOverride: status,
      reviewedByUserId,
      dropboxLink: options?.dropboxLink,
      savedFiles: options?.savedFiles,
      disabled:
        options?.disabled ?? ['saved', 'ignored', 'failed'].includes(status),
    });
    const label =
      batchItems.length === 1
        ? batchItems[0]!.attachment_filename
        : `${batchItems.length} attachments`;
    const fallbackText = `${buildQueueHeaderText(status, batchItems.length > 1, batchItems.length)} — ${label}`;
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
        '*How to change case or folder before Approve:*\n' +
        threadOverrideHelpText() +
        '\n\nReply in this thread with your values, then click Approve.',
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
    fileBuffer: Buffer;
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

    const dropboxLink = slackMrkdwnLink(opts.dropboxLink, 'Open in Dropbox');
    const sectionText = slackSectionWithExtras(
      `:white_check_mark: *Document sorted to Dropbox*\n` +
        `*${slackFieldText(opts.item.attachment_filename, 200)}*\n` +
        `Case: #${opts.caseRow.slack_channel_name} · Folder: ${slackFieldText(folderName, 80)}\n` +
        `From: ${slackFieldText(opts.item.from_email, 120)}\n` +
        `Subject: ${slackFieldText(opts.item.subject ?? '—', 200)}`,
      [`Sorted by: ${slackUserMention(opts.approvedByUserId)}`, dropboxLink]
    );

    try {
      await slackApi('chat.postMessage', {
        channel: channelId,
        text: `Document sorted to Dropbox: ${opts.item.attachment_filename}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: sectionText },
          },
        ],
      });

      try {
        await slackUploadFileToChannelWithFallback({
          channelId,
          filename: opts.item.attachment_filename,
          buffer: opts.fileBuffer,
          mimeType: opts.item.attachment_mime_type,
        });
      } catch (uploadErr) {
        logger.error('Case channel file attachment failed', {
          caseNumber: opts.caseRow.case_number,
          channelId,
          filename: opts.item.attachment_filename,
          err: String(uploadErr),
          hint: 'Ensure the bot has files:write scope and is in this channel.',
        });
      }

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
