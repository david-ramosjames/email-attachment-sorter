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
  formatSlackUserMentions,
  slackSectionWithLeadingMentions,
} from '../utils/slackText.js';
import {
  externalLinkUrlFromItem,
  isExternalLinkItem,
} from '../utils/externalFileLinks.js';
import {
  isIntakeNoCaseItem,
  queueCaseLabel,
  queueDocumentTypeLabel,
  queueFolderLabel,
} from '../utils/intakeDocumentSignals.js';
import { parseUserMentionsFromSlackTopic } from '../utils/slackCaseParser.js';
import { pickQueueMentionUserIdsForNewCard } from './queueMentionService.js';
import { getSlackUserDisplayName, getSlackUserDisplayNames } from './slackUserDirectory.js';
import {
  getSlackChannelIdByNameMap,
  clearSlackChannelNameCache,
  ensureBotCanUploadToChannel,
  ensureBotInQueueChannel,
  getConversationInfo,
  slackJoinHint,
  type BotChannelUploadAccess,
} from './slackChannels.js';

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

function extractSlackMessageText(message: Record<string, unknown>): string {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text) return text;

  const blocks = message.blocks;
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; elements?: unknown[] };
    if (b.type !== 'rich_text' || !Array.isArray(b.elements)) continue;
    for (const el of b.elements) {
      if (!el || typeof el !== 'object') continue;
      const section = el as { type?: string; elements?: unknown[] };
      if (section.type !== 'rich_text_section' || !Array.isArray(section.elements)) continue;
      for (const sub of section.elements) {
        if (!sub || typeof sub !== 'object') continue;
        const piece = sub as { type?: string; text?: string };
        if (piece.type === 'text' && piece.text) parts.push(piece.text);
      }
    }
  }
  return parts.join('').trim();
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

  const uploadStart = await slackApiForm<{
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

  await slackApiForm('files.completeUploadExternal', {
    files: JSON.stringify([{ id: uploadStart.file_id, title: opts.filename }]),
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
  channelName?: string;
  threadTs?: string;
}): Promise<void> {
  await slackUploadMultipleFilesToChannelWithFallback({
    channelId: opts.channelId,
    channelName: opts.channelName,
    threadTs: opts.threadTs,
    files: [
      {
        filename: opts.filename,
        buffer: opts.buffer,
        mimeType: opts.mimeType,
      },
    ],
  });
}

async function slackUploadMultipleFilesToChannel(opts: {
  channelId: string;
  files: Array<{ filename: string; buffer: Buffer; mimeType?: string | null }>;
  threadTs?: string;
}): Promise<void> {
  if (!opts.files.length) return;

  const completed: Array<{ id: string; title: string }> = [];
  for (const file of opts.files) {
    const mime = file.mimeType?.trim() || 'application/octet-stream';
    const uploadStart = await slackApiForm<{
      upload_url: string;
      file_id: string;
    }>('files.getUploadURLExternal', {
      filename: file.filename,
      length: file.buffer.length,
    });

    const byteUpload = await fetch(uploadStart.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: file.buffer,
    });
    if (!byteUpload.ok) {
      throw new Error(
        `Slack file byte upload failed for ${file.filename}: HTTP ${byteUpload.status}`
      );
    }

    completed.push({ id: uploadStart.file_id, title: file.filename });
  }

  await slackApiForm('files.completeUploadExternal', {
    files: JSON.stringify(completed),
    channel_id: opts.channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  });
}

async function slackUploadMultipleFilesLegacy(opts: {
  channelId: string;
  files: Array<{ filename: string; buffer: Buffer; mimeType?: string | null }>;
  threadTs?: string;
}): Promise<void> {
  for (const file of opts.files) {
    const form = new FormData();
    form.append('channels', opts.channelId);
    form.append('filename', file.filename);
    if (opts.threadTs) form.append('thread_ts', opts.threadTs);
    const mime = file.mimeType?.trim() || 'application/octet-stream';
    form.append('file', new Blob([file.buffer], { type: mime }), file.filename);

    const res = await fetch(`${SLACK_API}/files.upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}` },
      body: form,
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API files.upload failed for ${file.filename}: ${data.error ?? 'unknown'}`);
    }
  }
}

async function slackUploadMultipleFilesToChannelWithFallback(opts: {
  channelId: string;
  files: Array<{ filename: string; buffer: Buffer; mimeType?: string | null }>;
  threadTs?: string;
  channelName?: string;
}): Promise<void> {
  if (!opts.files.length) return;

  const uploadAccess = await ensureBotCanUploadToChannel(opts.channelId);
  if (!uploadAccess.isMember) {
    throw new Error(
      `Slack API files.upload failed: not_in_channel (${uploadAccess.slackError ?? 'not joined'})`
    );
  }

  const attempt = async () => {
    try {
      await slackUploadMultipleFilesToChannel(opts);
    } catch (err) {
      logger.warn('Slack external multi-file upload failed, trying legacy files.upload', {
        fileCount: opts.files.length,
        err: String(err),
      });
      await slackUploadMultipleFilesLegacy(opts);
    }
  };

  try {
    await attempt();
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('not_in_channel')) throw err;
    const retryAccess = await ensureBotCanUploadToChannel(opts.channelId);
    if (!retryAccess.isMember) {
      throw new Error(
        `Slack API files.upload failed: not_in_channel (${retryAccess.slackError ?? 'not joined'})`
      );
    }
    await attempt();
  }
}

function slackFileUploadHint(
  err: string,
  channelName: string,
  uploadAccess?: { isPrivate: boolean; slackError: string | null }
): string {
  if (err.includes('not_in_channel') || uploadAccess?.slackError) {
    if (uploadAccess?.isPrivate) {
      return (
        `This is a *private* case channel — invite the bot with \`/invite @RJL File Sorter\` in #${channelName}. ` +
        'File attachments require channel membership (text-only posts work without it).'
      );
    }
    if (uploadAccess?.slackError === 'missing_scope') {
      return 'Add channels:join to the Slack app, reinstall, then Approve again (or run POST /admin/join-public-slack-channels).';
    }
    if (uploadAccess?.slackError) {
      return `${slackJoinHint(uploadAccess.slackError)} Then Approve again or use POST /admin/join-public-slack-channels.`;
    }
    return (
      `Bot is not in #${channelName} — public channels auto-join on Approve; if this persists, ` +
      'add channels:join scope and reinstall the Slack app.'
    );
  }
  if (err.includes('missing_scope')) {
    return 'Add files:write scope to the Slack app and reinstall to the workspace.';
  }
  if (err.includes('invalid_arguments')) {
    return 'Slack file upload misconfigured — check Railway logs; the app should retry with legacy upload.';
  }
  return 'Check Slack app scopes (files:write, channels:join) and that the bot is in the case channel.';
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

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;

function parseTaggedUserIdsFromItem(item: FileSorterItem): string[] {
  if (!item.queue_tagged_slack_user_id?.trim()) return [];
  return item.queue_tagged_slack_user_id
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((id) => SLACK_USER_ID.test(id));
}

function taggedMentionIdsFromBatchItems(items: FileSorterItem[]): string[] {
  for (const item of items) {
    const ids = parseTaggedUserIdsFromItem(item);
    if (ids.length) return ids;
  }
  return [];
}

function insertQueueMentionBlock(
  blocks: Record<string, unknown>[],
  mentionIds: string[]
): { blocks: Record<string, unknown>[]; mentionLine: string } {
  const mentionLine = formatSlackUserMentions(mentionIds);
  if (!mentionLine) return { blocks, mentionLine: '' };

  const headerIdx = blocks.findIndex((b) => (b as { type?: string }).type === 'header');
  const insertAt = headerIdx >= 0 ? headerIdx + 1 : 0;
  const next = [...blocks];
  next.splice(insertAt, 0, {
    type: 'section',
    text: { type: 'mrkdwn', text: mentionLine },
  });
  return { blocks: next, mentionLine };
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
  return (
    'If correct, click *Approve*.\n\n' +
    'If wrong, reply before approving:\n\n' +
    'Case: 1277\n' +
    'Folder: Medical\n\n' +
    'Optional — teach the AI for next time:\n\n' +
    "Teach Case: Maria Garcia is Juan Garcia's daughter.\n" +
    'Teach Case: Cause number DC-24-12345 belongs to case 1277.\n\n' +
    'Teach Folder: MoveDocs records belong in Medical.\n' +
    'Teach Folder: Law360 newsletters should not be sorted.\n' +
    'Teach Folder: Photos from this sender belong in Photos.\n\n' +
    'Then click *Approve*.'
  );
}

function pickPrimaryQueueItem(items: FileSorterItem[]): FileSorterItem {
  const sorted = [...items].sort(
    (a, b) => (b.ai_case_confidence ?? b.ai_confidence ?? 0) - (a.ai_case_confidence ?? a.ai_confidence ?? 0)
  );
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
      const external = isExternalLinkItem(i) ? ' _(external link)_' : '';
      return `• ${i.attachment_filename}${external}${folderNote}`;
    })
    .join('\n');
}

function formatExternalLinksSection(items: FileSorterItem[]): string | null {
  const links = items
    .map((i) => {
      const url = externalLinkUrlFromItem(i);
      return url ? slackMrkdwnLink(url, i.attachment_filename) : null;
    })
    .filter(Boolean);
  if (!links.length) return null;
  return (
    `:link: *External files (not attached — download manually):*\n` + links.map((l) => `• ${l}`).join('\n')
  );
}

function formatPct(confidence: number | null | undefined): string {
  if (confidence == null) return '—';
  return `${(confidence * 100).toFixed(0)}%`;
}

function formatConfidenceScores(item: FileSorterItem): string {
  if (isIntakeNoCaseItem(item)) {
    return [
      'Case: N/A (new client intake)',
      `Folder: ${formatPct(item.ai_folder_confidence)}`,
      `Overall: ${formatPct(item.ai_confidence)}`,
    ].join('\n');
  }
  return [
    `Case: ${formatPct(item.ai_case_confidence)}`,
    `Folder: ${formatPct(item.ai_folder_confidence)}`,
    `Overall: ${formatPct(item.ai_confidence)}`,
  ].join('\n');
}

function formatConfidenceRange(values: Array<number | null | undefined>): string {
  const nums = values.filter((c): c is number => c != null);
  if (!nums.length) return '—';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return formatPct(min);
  return `${formatPct(min)}–${formatPct(max)}`;
}

function formatConfidenceScoresBatch(items: FileSorterItem[]): string {
  return [
    `Case: ${formatConfidenceRange(items.map((i) => i.ai_case_confidence))}`,
    `Folder: ${formatConfidenceRange(items.map((i) => i.ai_folder_confidence))}`,
    `Overall: ${formatConfidenceRange(items.map((i) => i.ai_confidence))}`,
  ].join('\n');
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

function buildQueueHeaderText(status: string, batch: boolean, batchCount: number, items?: FileSorterItem[]): string {
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
    const intakeBatch = items?.some(isIntakeNoCaseItem);
    if (intakeBatch && !batch) {
      return `${emoji} New intake — no case folder yet`;
    }
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
  const caseLabel = queueCaseLabel(item, caseRow);

  const folderLabels = [
    ...new Set(
      items
        .map((i) => folderLabelFromPath(i.suggested_folder_path))
        .filter((f) => f !== '—')
    ),
  ];
  const folderDisplay = batch
    ? folderLabels.length === 0
      ? items.some(isIntakeNoCaseItem)
        ? 'Intake'
        : '—'
      : folderLabels.length === 1
        ? folderLabels[0]!
        : `Multiple (${folderLabels.join(', ')})`
    : queueFolderLabel(item, folderLabelFromPath(item.suggested_folder_path));

  const docTypes = [
    ...new Set(items.map((i) => i.suggested_document_type).filter(Boolean)),
  ] as string[];
  const documentTypeDisplay = batch
    ? queueDocumentTypeLabel(item, docTypes)
    : queueDocumentTypeLabel(item, item.suggested_document_type ? [item.suggested_document_type] : docTypes);

  const toLine = [...item.to_emails, ...item.cc_emails].filter(Boolean).join(', ') || '—';
  const attachmentDisplay = batch
    ? formatAttachmentList(items)
    : isExternalLinkItem(item)
      ? `${item.attachment_filename} (external link)`
      : item.attachment_filename;

  const externalLinksBlock = formatExternalLinksSection(items);

  const headerText = buildQueueHeaderText(status, batch, items.length, items);

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
          text: `*Confidence:*\n${batch ? formatConfidenceScoresBatch(items) : formatConfidenceScores(item)}`,
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

  if (externalLinksBlock) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: externalLinksBlock },
    });
  }

  if (items.some(isExternalLinkItem)) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_External links cannot be auto-filed — open the link, download, and file to the suggested folder._',
        },
      ],
    });
  }

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
  const expectedName = caseRow.slack_channel_name.trim().toLowerCase();

  if (storedId?.trim()) {
    try {
      const info = await getConversationInfo(storedId.trim());
      if (info && (!expectedName || info.name.toLowerCase() === expectedName)) {
        return info.id;
      }
      logger.warn('Stored slack_channel_id does not match case channel name — re-resolving', {
        caseNumber: caseRow.case_number,
        storedId: storedId.trim(),
        slackName: info?.name,
        expectedName,
      });
    } catch (err) {
      logger.warn('Stored slack_channel_id could not be loaded — re-resolving by name', {
        caseNumber: caseRow.case_number,
        storedId: storedId.trim(),
        err: String(err),
      });
    }
  }

  const channelName = expectedName;
  if (!channelName) return null;

  clearSlackChannelNameCache();
  const slackChannelIdByName = await getSlackChannelIdByNameMap();
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
  ): Promise<{ channel: string; ts: string; taggedUserIds: string[]; taggedUserNames: string[] }> {
    const channel = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID;
    await ensureBotInQueueChannel();
    const mentionIds = await pickQueueMentionUserIdsForNewCard();
    const nameMap = await getSlackUserDisplayNames(mentionIds);
    const taggedUserNames = mentionIds.map((id) => nameMap.get(id) ?? id);
    const blocks = buildQueueBlocks(items, caseRow, options);
    const { blocks: blocksWithMention, mentionLine } = insertQueueMentionBlock(blocks, mentionIds);
    if (!mentionLine) {
      logger.info('Queue card posted without @mentions — set SLACK_QUEUE_MENTION_USER_IDS or add <@U…> to queue channel topic');
    }
    const label =
      items.length === 1
        ? items[0]!.attachment_filename
        : `${items.length} attachments: ${items.map((i) => i.attachment_filename).join(', ')}`;
    const status = aggregateBatchStatus(items);
    const headerText = buildQueueHeaderText(status, items.length > 1, items.length, items);
    const fallbackText = mentionLine
      ? `${mentionLine} ${headerText} — ${label}`
      : `${headerText} — ${label}`;
    const result = await slackApi<{ channel: string; ts: string }>('chat.postMessage', {
      channel,
      text: fallbackText,
      blocks: blocksWithMention,
    });
    return { channel: result.channel, ts: result.ts, taggedUserIds: mentionIds, taggedUserNames };
  },

  async postQueueItem(
    item: FileSorterItem,
    caseRow: Case | null,
    options?: { emailReceivedAt?: string | null }
  ): Promise<{ channel: string; ts: string; taggedUserIds: string[]; taggedUserNames: string[] }> {
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
    let blocks = buildQueueBlocks(batchItems, caseRow, {
      statusOverride: status,
      reviewedByUserId,
      dropboxLink: options?.dropboxLink,
      savedFiles: options?.savedFiles,
      disabled:
        options?.disabled ?? ['saved', 'ignored', 'failed'].includes(status),
    });
    const mentionIds = taggedMentionIdsFromBatchItems(batchItems);
    const { blocks: blocksWithMention, mentionLine } = insertQueueMentionBlock(blocks, mentionIds);
    blocks = blocksWithMention;
    const label =
      batchItems.length === 1
        ? batchItems[0]!.attachment_filename
        : `${batchItems.length} attachments`;
    const headerText = buildQueueHeaderText(status, batchItems.length > 1, batchItems.length, batchItems);
    const fallbackText = mentionLine
      ? `${mentionLine} ${headerText} — ${label}`
      : `${headerText} — ${label}`;
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
      text: threadOverrideHelpText(),
    });
  },

  extractSlackMessageText,

  async postThreadReply(channelId: string, threadTs: string, text: string): Promise<void> {
    await slackApi('chat.postMessage', {
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  },

  async postQueueCardThreadNotice(item: FileSorterItem, text: string): Promise<void> {
    if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) return;
    await slackService.postThreadReply(
      item.slack_queue_channel_id,
      item.slack_queue_message_ts,
      text
    );
  },

  async getThreadReplies(ctx: SlackThreadContext): Promise<string[]> {
    const channelId = ctx.channelId.trim();
    const ts = ctx.messageTs.trim();
    if (!channelId || !ts) {
      throw new Error('Missing Slack channel or message timestamp');
    }

    const access = await ensureBotCanUploadToChannel(channelId);
    if (!access.isMember) {
      throw new Error(
        `Slack API conversations.replies failed: not_in_channel (${access.slackError ?? 'bot not in channel'})`
      );
    }

    let result: { messages: Array<Record<string, unknown>> };
    try {
      result = await slackApiForm<{
        messages: Array<Record<string, unknown>>;
      }>('conversations.replies', {
        channel: channelId,
        ts,
        limit: 50,
      });
    } catch (err) {
      const msg = String(err);
      const historyHint = access.isPrivate
        ? 'Private queue channel — ensure groups:history scope is installed and the bot is invited.'
        : 'Ensure channels:history scope is installed and the bot is in the queue channel.';
      throw new Error(`${msg} (${historyHint})`);
    }

    const texts = (result.messages ?? [])
      .filter((m) => !m.bot_id && m.subtype !== 'bot_message')
      .map((m) => extractSlackMessageText(m))
      .filter(Boolean);

    logger.info('Slack thread replies loaded', {
      channelId,
      messageTs: ts,
      replyCount: texts.length,
    });

    return texts;
  },

  async getUserDisplayName(userId: string): Promise<string> {
    return getSlackUserDisplayName(userId);
  },

  async postEphemeral(channel: string, userId: string, text: string): Promise<void> {
    await slackApi('chat.postEphemeral', { channel, user: userId, text });
  },

  async postCaseChannelConfirmation(opts: {
    caseRow: Case;
    trigger: FileSorterItem;
    files: Array<{
      item: FileSorterItem;
      dropboxLink: string;
      fileBuffer: Buffer;
    }>;
    approvedByUserId: string;
  }): Promise<boolean> {
    if (!opts.files.length) return false;

    const channelId = await resolveCaseSlackChannelId(opts.caseRow);

    if (!channelId) {
      logger.warn('No Slack channel for case cross-post', {
        caseNumber: opts.caseRow.case_number,
        slackChannelName: opts.caseRow.slack_channel_name,
      });
      return false;
    }

    const batch = opts.files.length > 1;
    const trigger = opts.trigger;

    let topicMentionIds: string[] = [];
    let uploadAccess: BotChannelUploadAccess | null = null;
    try {
      uploadAccess = await ensureBotCanUploadToChannel(channelId);
    } catch (err) {
      logger.warn('Could not join case channel before cross-post', {
        channelId,
        caseNumber: opts.caseRow.case_number,
        err: String(err),
      });
    }

    try {
      const convo = await getConversationInfo(channelId);
      if (convo?.topic) {
        topicMentionIds = parseUserMentionsFromSlackTopic(convo.topic);
      }
    } catch (err) {
      logger.warn('Could not load channel topic for staff mentions', {
        channelId,
        caseNumber: opts.caseRow.case_number,
        err: String(err),
      });
    }

    const batchFileLines = batch
      ? opts.files
          .map((f) => {
            const folderName = folderLabelFromPath(
              f.item.final_dropbox_path ?? f.item.suggested_folder_path
            );
            const link = slackMrkdwnLink(f.dropboxLink, f.item.attachment_filename);
            return `• ${link} · Folder: ${slackFieldText(folderName, 80)}`;
          })
          .join('\n')
      : '';

    const sectionBody = batch
      ? `:white_check_mark: *Documents sorted to Dropbox* (${opts.files.length} files)`
      : `:white_check_mark: *Document sorted to Dropbox*\n*${slackFieldText(opts.files[0]!.item.attachment_filename, 200)}*\n` +
        `Case: #${opts.caseRow.slack_channel_name} · Folder: ${slackFieldText(
          folderLabelFromPath(
            opts.files[0]!.item.final_dropbox_path ?? opts.files[0]!.item.suggested_folder_path
          ),
          80
        )}\n` +
        `From: ${slackFieldText(trigger.from_email, 120)}\n` +
        `Subject: ${slackFieldText(trigger.subject ?? '—', 200)}`;

    const sectionExtras = batch
      ? [
          batchFileLines,
          `Case: #${opts.caseRow.slack_channel_name}`,
          `From: ${slackFieldText(trigger.from_email, 120)}`,
          `Subject: ${slackFieldText(trigger.subject ?? '—', 200)}`,
          `Sorted by: ${slackUserMention(opts.approvedByUserId)}`,
        ]
      : [
          `Sorted by: ${slackUserMention(opts.approvedByUserId)}`,
          slackMrkdwnLink(opts.files[0]!.dropboxLink, 'Open in Dropbox'),
        ];

    const sectionText = slackSectionWithLeadingMentions(
      topicMentionIds,
      sectionBody,
      sectionExtras
    );

    const mentionPrefix = formatSlackUserMentions(topicMentionIds);
    const fallbackLabel = batch
      ? `${opts.files.length} documents sorted to Dropbox`
      : opts.files[0]!.item.attachment_filename;
    const fallbackText = mentionPrefix
      ? `${mentionPrefix} Document sorted to Dropbox: ${fallbackLabel}`
      : `Document sorted to Dropbox: ${fallbackLabel}`;

    try {
      const postResult = await slackApi<{ ts: string }>('chat.postMessage', {
        channel: channelId,
        text: fallbackText,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: sectionText },
          },
        ],
      });

      let fileAttached = false;
      try {
        await slackUploadMultipleFilesToChannelWithFallback({
          channelId,
          channelName: opts.caseRow.slack_channel_name,
          threadTs: postResult.ts,
          files: opts.files.map((f) => ({
            filename: f.item.attachment_filename,
            buffer: f.fileBuffer,
            mimeType: f.item.attachment_mime_type,
          })),
        });
        fileAttached = true;
      } catch (uploadErr) {
        const errMsg = String(uploadErr);
        const hint = slackFileUploadHint(
          errMsg,
          opts.caseRow.slack_channel_name,
          uploadAccess ?? undefined
        );
        logger.error('Case channel file attachment failed', {
          caseNumber: opts.caseRow.case_number,
          channelId,
          slackChannelName: opts.caseRow.slack_channel_name,
          fileCount: opts.files.length,
          filenames: opts.files.map((f) => f.item.attachment_filename),
          err: errMsg,
          hint,
          uploadAccess,
        });
        try {
          await slackApi('chat.postMessage', {
            channel: channelId,
            thread_ts: postResult.ts,
            text:
              `:warning: *File${batch ? 's' : ''} not attached in Slack* — ${batch ? 'they are' : 'file is'} in Dropbox (link${batch ? 's' : ''} above).\n` +
              `${hint}`,
          });
        } catch {
          /* ignore follow-up failure */
        }
      }

      logger.info('Cross-posted sorted document to case Slack channel', {
        caseNumber: opts.caseRow.case_number,
        channelId,
        fileCount: opts.files.length,
        filenames: opts.files.map((f) => f.item.attachment_filename),
        fileAttached,
        topicMentions: topicMentionIds,
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
