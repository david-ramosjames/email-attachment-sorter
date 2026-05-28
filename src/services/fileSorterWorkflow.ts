import {
  downloadTempAttachment,
  getCaseById,
  getCaseByName,
  getFileSorterItem,
  getFoldersForCase,
  updateCaseDropboxFolderName,
  updateFileSorterItem,
  upsertCaseFolder,
} from '../db/supabase.js';
import {
  getCasesRootPath,
  fileExistsInDropbox,
  generateDropboxPermalink,
  listCaseFolders,
  uploadFileToDropbox,
} from './dropboxService.js';
import {
  parseCaseNumberFromDropboxFolder,
  RJL_STANDARD_SUBFOLDERS,
} from '../constants/rjlFolders.js';
import { slackService } from './slackService.js';
import { auditService } from './auditService.js';
import { parseThreadReplies } from '../utils/threadParser.js';
import type { SlackThreadContext } from './slackService.js';
import { logger } from '../utils/logger.js';

async function resolveFinalPaths(
  itemId: string,
  slackThread?: SlackThreadContext
): Promise<{
  caseNumber: string;
  folderPath: string;
  caseRow: NonNullable<Awaited<ReturnType<typeof getCaseById>>>;
}> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');

  let caseNumber = item.final_case_number ?? item.suggested_case_number;
  let folderPath = item.final_dropbox_path ?? item.suggested_folder_path;

  const threadCtx: SlackThreadContext | null =
    slackThread ??
    (item.slack_queue_channel_id && item.slack_queue_message_ts
      ? {
          channelId: item.slack_queue_channel_id,
          messageTs: item.slack_queue_message_ts,
        }
      : null);

  if (threadCtx) {
    let replies: string[] = [];
    try {
      replies = await slackService.getThreadReplies(threadCtx);
    } catch (err) {
      logger.warn('Could not load Slack thread overrides', {
        itemId,
        channelId: threadCtx.channelId,
        messageTs: threadCtx.messageTs,
        err: String(err),
      });
    }

    const override = parseThreadReplies(replies);
    if (override.caseName) {
      const matched = await getCaseByName(override.caseName);
      if (matched) {
        caseNumber = matched.case_number;
        await auditService.log(itemId, 'thread_override', {
          caseName: override.caseName,
          caseNumber: matched.case_number,
        });
      }
    }
    if (override.folderLabel && caseNumber) {
      const folders = await getFoldersForCase(caseNumber);
      const folder = folders.find(
        (f) => f.folder_label.toLowerCase() === override.folderLabel!.toLowerCase()
      );
      if (folder) {
        folderPath = folder.dropbox_path;
        await auditService.log(itemId, 'thread_override', {
          folderLabel: override.folderLabel,
          dropboxPath: folder.dropbox_path,
        });
      } else if (caseNumber) {
        const caseRow = await getCaseById(caseNumber);
        if (caseRow) {
          folderPath = `${caseRow.dropbox_root_path}/${override.folderLabel}`;
          await auditService.log(itemId, 'thread_override', {
            folderLabel: override.folderLabel,
            dropboxPath: folderPath,
            note: 'constructed from case root',
          });
        }
      }
    }
  }

  if (!caseNumber || !folderPath) {
    throw new Error('Case and folder must be set before approval (use thread overrides or AI suggestion)');
  }

  const caseRow = await getCaseById(caseNumber);
  if (!caseRow) throw new Error('Case not found');

  return { caseNumber, folderPath, caseRow };
}

export async function handleApprove(
  itemId: string,
  slackUserId: string,
  slackThread?: SlackThreadContext
): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  if (['saved', 'ignored'].includes(item.status)) {
    throw new Error(`Item already ${item.status}`);
  }

  const { caseNumber, folderPath, caseRow } = await resolveFinalPaths(itemId, slackThread);

  const exists = await fileExistsInDropbox(folderPath, item.attachment_filename);
  if (exists) {
    await updateFileSorterItem(itemId, { status: 'needs_attention' });
    await auditService.log(itemId, 'duplicate_detected', { folderPath, filename: item.attachment_filename }, slackUserId);
    const updated = await getFileSorterItem(itemId);
    if (updated) {
      await slackService.updateQueueMessage(updated, caseRow);
    }
    throw new Error('Duplicate file exists in Dropbox folder — marked needs_attention');
  }

  await updateFileSorterItem(itemId, {
    status: 'approved',
    final_case_number: caseNumber,
    final_dropbox_path: folderPath,
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: new Date().toISOString(),
  });

  await auditService.log(itemId, 'approved', { caseNumber, folderPath }, slackUserId);

  const buffer = await downloadTempAttachment(itemId, item.attachment_filename);
  const upload = await uploadFileToDropbox(folderPath, item.attachment_filename, buffer);
  const permalink = await generateDropboxPermalink(upload.path);

  const saved = await updateFileSorterItem(itemId, {
    status: 'saved',
    final_dropbox_path: upload.path,
    dropbox_permalink: permalink,
  });

  await auditService.log(
    itemId,
    'saved_to_dropbox',
    { path: upload.path, permalink },
    slackUserId
  );

  await slackService.updateQueueMessage(saved, caseRow, {
    reviewedByUserId: slackUserId,
    dropboxLink: permalink,
    disabled: true,
  });

  const crossPosted = await slackService.postCaseChannelConfirmation({
    caseRow,
    item: saved,
    dropboxLink: permalink,
    approvedByUserId: slackUserId,
  });

  if (!crossPosted) {
    await auditService.log(
      itemId,
      'case_channel_cross_post_failed',
      {
        caseNumber: caseRow.case_number,
        slackChannelName: caseRow.slack_channel_name,
        note: 'Invite the File Sorter bot to this case channel, or ensure channels:read scope is enabled.',
      },
      slackUserId
    );
  }
}

export async function handleChange(itemId: string, slackUserId: string): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  await slackService.postChangeInstructions(item);
  await auditService.log(itemId, 'thread_override', { action: 'change_requested' }, slackUserId);
}

export async function handleNeedsAttention(
  itemId: string,
  slackUserId: string
): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');

  const updated = await updateFileSorterItem(itemId, {
    status: 'needs_attention',
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: new Date().toISOString(),
  });

  await auditService.log(itemId, 'needs_attention', {}, slackUserId);

  const caseRow = updated.suggested_case_number
    ? await getCaseById(updated.suggested_case_number)
    : null;
  await slackService.updateQueueMessage(updated, caseRow, {
    reviewedByUserId: slackUserId,
    disabled: true,
  });
}

export async function handleDoNotSort(itemId: string, slackUserId: string): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');

  const updated = await updateFileSorterItem(itemId, {
    status: 'ignored',
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: new Date().toISOString(),
  });

  await auditService.log(itemId, 'ignored', {}, slackUserId);

  const caseRow = updated.suggested_case_number
    ? await getCaseById(updated.suggested_case_number)
    : null;
  await slackService.updateQueueMessage(updated, caseRow, {
    reviewedByUserId: slackUserId,
    disabled: true,
  });
}

export async function reindexDropboxFoldersForCase(caseNumber: string): Promise<number> {
  const caseRow = await getCaseById(caseNumber);
  if (!caseRow) throw new Error('Case not found');

  const root = getCasesRootPath().replace(/\/+$/, '');
  const dropboxCaseFolders = await listCaseFolders(root);
  const match = dropboxCaseFolders.find(
    (f) => parseCaseNumberFromDropboxFolder(f.name) === caseNumber
  );

  const folderName = match?.name ?? caseRow.dropbox_root_path.split('/').pop() ?? caseNumber;
  const caseRoot = `${root}/${folderName}`.replace(/\/+/g, '/');

  if (match) {
    await updateCaseDropboxFolderName(caseNumber, match.name);
  }

  for (const label of RJL_STANDARD_SUBFOLDERS) {
    await upsertCaseFolder(
      caseNumber,
      label,
      `${caseRoot}/${label}`.replace(/\/+/g, '/')
    );
  }

  logger.info('Reindexed case folders', { caseNumber, folderName });
  return RJL_STANDARD_SUBFOLDERS.length;
}
