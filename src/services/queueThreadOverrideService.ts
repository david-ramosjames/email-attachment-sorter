import { getEnv } from '../config/env.js';
import {
  getCaseById,
  getCaseByName,
  getPendingQueueItemsByThread,
  hasActiveQueueCardsInChannel,
} from '../db/supabase.js';
import { handleSkipAttachment } from './fileSorterWorkflow.js';
import { slackService, type SlackThreadContext } from './slackService.js';
import {
  parseThreadReplies,
  parseThreadReply,
  isThreadApproveCommand,
  threadOverrideHasValues,
  threadPerFileFolderHasValues,
  threadRenameHasValues,
  threadSkipHasValues,
  type ThreadOverride,
} from '../utils/threadParser.js';
import {
  formatApproveError,
  formatAlreadyProcessedThreadMessage,
  isAlreadyProcessedError,
} from '../utils/approveErrors.js';
import { formatRenameConfirmationLines } from '../utils/filenameRename.js';
import { formatPerFileFolderConfirmationLines } from '../utils/perFileFolder.js';
import { matchAttachmentForSkip } from '../utils/skipAttachment.js';
import { logger } from '../utils/logger.js';

export async function buildOverrideConfirmationText(
  override: ThreadOverride,
  suggestedCaseNumber: string | null,
  threadCtx: SlackThreadContext
): Promise<string> {
  const lines: string[] = ['*Got it — when you click Approve, I will:*'];

  if (override.caseName) {
    const matched = await getCaseByName(override.caseName);
    if (matched) {
      lines.push(`• Case: *${matched.slack_channel_name}* (${matched.case_number})`);
    } else {
      lines.push(
        `• Case: *${override.caseName}* _(could not match — check spelling or use case number)_`
      );
    }
  } else if (suggestedCaseNumber) {
    const caseRow = await getCaseById(suggestedCaseNumber);
    if (caseRow) {
      lines.push(
        `• Case: *${caseRow.slack_channel_name}* (${caseRow.case_number}) _(unchanged)_`
      );
    }
  }

  if (override.folderLabel) {
    lines.push(`• Folder (all attachments): *${override.folderLabel}*`);
  }

  const batchItems = await getPendingQueueItemsByThread(threadCtx.channelId, threadCtx.messageTs);

  const perFileFolderLines = formatPerFileFolderConfirmationLines(
    batchItems,
    override.perFileFolders ?? []
  );
  for (const line of perFileFolderLines) {
    lines.push(line);
  }

  const renameLines = formatRenameConfirmationLines(
    batchItems,
    override.filenameRenames ?? []
  );
  for (const line of renameLines) {
    lines.push(line);
  }

  for (const hint of override.caseHints ?? []) {
    lines.push(`• Teach Case noted: _${hint.slice(0, 120)}${hint.length > 120 ? '…' : ''}_`);
  }
  for (const hint of override.sortHints ?? []) {
    lines.push(`• Teach Folder noted: _${hint.slice(0, 120)}${hint.length > 120 ? '…' : ''}_`);
  }

  lines.push('\nClick *Approve* on the card above, or reply `approve` in this thread to file.');
  return lines.join('\n');
}

async function applyThreadSkips(
  items: Awaited<ReturnType<typeof getPendingQueueItemsByThread>>,
  skipPatterns: string[],
  slackUserId: string
): Promise<{ skipped: string[]; notFound: string[] }> {
  const skipped: string[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();

  for (const pattern of skipPatterns) {
    const match = matchAttachmentForSkip(items, pattern);
    if (!match || seen.has(match.id)) {
      notFound.push(pattern);
      continue;
    }
    if (['saved', 'ignored'].includes(match.status)) continue;

    seen.add(match.id);
    await handleSkipAttachment(match.id, slackUserId);
    skipped.push(match.attachment_filename);
  }

  return { skipped, notFound };
}

function buildSkipConfirmationText(result: {
  skipped: string[];
  notFound: string[];
}): string {
  const lines: string[] = [];
  if (result.skipped.length) {
    lines.push(
      `*Skipped (will not file):* ${result.skipped.map((name) => `_${name}_`).join(', ')}`
    );
    lines.push('Click *Approve* on the card, or reply `approve` in this thread to file the remaining attachments.');
  }
  if (result.notFound.length) {
    lines.push(
      `:warning: Could not match: ${result.notFound.map((name) => `_${name}_`).join(', ')} — use the exact filename or a unique partial name.`
    );
  }
  return lines.join('\n');
}

/** Post a thread confirmation when overrides are detected in queue replies. */
export async function confirmThreadOverrides(
  threadCtx: SlackThreadContext,
  suggestedCaseNumber: string | null,
  replies?: string[]
): Promise<boolean> {
  let texts = replies;
  if (!texts) {
    try {
      texts = await slackService.getThreadReplies(threadCtx);
    } catch (err) {
      logger.error('Could not read thread for override confirmation', {
        channelId: threadCtx.channelId,
        messageTs: threadCtx.messageTs,
        err: String(err),
        hint: 'Add channels:history and groups:history Slack scopes, then reinstall the app.',
      });
      return false;
    }
  }

  const override = parseThreadReplies(texts);
  if (
    !threadOverrideHasValues(override) &&
    !threadRenameHasValues(override) &&
    !threadPerFileFolderHasValues(override)
  ) {
    return false;
  }

  const text = await buildOverrideConfirmationText(override, suggestedCaseNumber, threadCtx);
  await slackService.postThreadReply(threadCtx.channelId, threadCtx.messageTs, text);
  logger.info('Thread override confirmation posted', {
    channelId: threadCtx.channelId,
    messageTs: threadCtx.messageTs,
    folder: override.folderLabel,
    caseName: override.caseName,
  });
  return true;
}

async function isFileSorterQueueChannel(channelId: string): Promise<boolean> {
  const configured = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
  if (channelId === configured) return true;
  return hasActiveQueueCardsInChannel(channelId);
}

async function handleThreadApproveCommand(
  channelId: string,
  threadTs: string,
  userId: string,
  items: Awaited<ReturnType<typeof getPendingQueueItemsByThread>>
): Promise<boolean> {
  const primary =
    items.find((i) => !['saved', 'ignored'].includes(i.status)) ?? items[0];
  if (!primary) return false;

  if (['saved', 'ignored'].includes(primary.status)) {
    await slackService.postThreadReply(
      channelId,
      threadTs,
      'This item is already processed — no action needed.'
    );
    return true;
  }

  try {
    const { handleApprove } = await import('./fileSorterWorkflow.js');
    await handleApprove(primary.id, userId, { channelId, messageTs: threadTs });
    logger.info('Queue thread approve command handled', {
      channelId,
      threadTs,
      itemId: primary.id,
      userId,
    });
    return true;
  } catch (err) {
    const threadText = isAlreadyProcessedError(err)
      ? formatAlreadyProcessedThreadMessage(err)
      : `:warning: *Could not approve from thread*\n${formatApproveError(err)}`;
    await slackService.postThreadReply(channelId, threadTs, threadText);
    logger.error('Queue thread approve command failed', {
      channelId,
      threadTs,
      itemId: primary.id,
      userId,
      err: String(err),
    });
    return true;
  }
}

/** Slack Events API: human replied in #file-sorter-queue with case/folder syntax. */
export async function handleQueueThreadOverrideEvent(
  event: Record<string, unknown>
): Promise<boolean> {
  if (String(event.type ?? '') !== 'message') return false;
  if (event.bot_id || event.subtype === 'bot_message') return false;
  if (event.subtype === 'message_changed' || event.subtype === 'message_deleted') return false;

  const channelId = typeof event.channel === 'string' ? event.channel : '';
  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : '';
  if (!channelId || !threadTs) return false;
  if (!(await isFileSorterQueueChannel(channelId))) return false;

  const text = typeof event.text === 'string' ? event.text : slackService.extractSlackMessageText(event);

  const items = await getPendingQueueItemsByThread(channelId, threadTs);
  if (!items.length) return false;

  const userId = typeof event.user === 'string' ? event.user : 'thread';

  if (isThreadApproveCommand(text)) {
    return handleThreadApproveCommand(channelId, threadTs, userId, items);
  }

  const parsed = parseThreadReply(text);
  if (
    !threadOverrideHasValues(parsed) &&
    !threadSkipHasValues(parsed) &&
    !threadRenameHasValues(parsed) &&
    !threadPerFileFolderHasValues(parsed)
  ) {
    return false;
  }

  logger.info('Queue thread override message received', {
    channelId,
    threadTs,
    preview: text.slice(0, 120),
    skipCount: parsed.skipFilenames?.length ?? 0,
  });

  if (threadSkipHasValues(parsed)) {
    const skipResult = await applyThreadSkips(items, parsed.skipFilenames ?? [], userId);
    const skipText = buildSkipConfirmationText(skipResult);
    if (skipText) {
      await slackService.postThreadReply(channelId, threadTs, skipText);
    }
    if (!threadOverrideHasValues(parsed)) return true;
  }

  const suggestedCase =
    items.find((i) => i.suggested_case_number)?.suggested_case_number ?? null;

  await confirmThreadOverrides({ channelId, messageTs: threadTs }, suggestedCase, [text]);
  return true;
}
