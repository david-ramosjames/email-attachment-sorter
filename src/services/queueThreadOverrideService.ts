import { getEnv } from '../config/env.js';
import { getCaseById, getCaseByName, getPendingQueueItemsByThread } from '../db/supabase.js';
import { slackService, type SlackThreadContext } from './slackService.js';
import {
  parseThreadReplies,
  parseThreadReply,
  threadOverrideHasValues,
  type ThreadOverride,
} from '../utils/threadParser.js';
import { logger } from '../utils/logger.js';

export async function buildOverrideConfirmationText(
  override: ThreadOverride,
  suggestedCaseNumber: string | null
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
    lines.push(`• Folder: *${override.folderLabel}*`);
  }

  for (const hint of override.caseHints ?? []) {
    lines.push(`• Case hint noted: _${hint.slice(0, 120)}${hint.length > 120 ? '…' : ''}_`);
  }
  for (const hint of override.sortHints ?? []) {
    lines.push(`• Sort hint noted: _${hint.slice(0, 120)}${hint.length > 120 ? '…' : ''}_`);
  }

  lines.push('\nClick *Approve* on the card above to file with these settings.');
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
  if (!threadOverrideHasValues(override)) return false;

  const text = await buildOverrideConfirmationText(override, suggestedCaseNumber);
  await slackService.postThreadReply(threadCtx.channelId, threadCtx.messageTs, text);
  logger.info('Thread override confirmation posted', {
    channelId: threadCtx.channelId,
    messageTs: threadCtx.messageTs,
    folder: override.folderLabel,
    caseName: override.caseName,
  });
  return true;
}

/** Slack Events API: human replied in #file-sorter-queue with case/folder syntax. */
export async function handleQueueThreadOverrideEvent(
  event: Record<string, unknown>
): Promise<boolean> {
  if (String(event.type ?? '') !== 'message') return false;
  if (event.bot_id || event.subtype === 'bot_message') return false;

  const channelId = typeof event.channel === 'string' ? event.channel : '';
  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : '';
  if (!channelId || !threadTs) return false;
  if (channelId !== getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID) return false;

  const text = slackService.extractSlackMessageText(event);
  const parsed = parseThreadReply(text);
  if (!threadOverrideHasValues(parsed)) return false;

  const items = await getPendingQueueItemsByThread(channelId, threadTs);
  if (!items.length) return false;

  const suggestedCase =
    items.find((i) => i.suggested_case_number)?.suggested_case_number ?? null;

  await confirmThreadOverrides({ channelId, messageTs: threadTs }, suggestedCase, [text]);
  return true;
}
