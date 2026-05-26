import {
  downloadTempAttachment,
  getCaseById,
  getCaseByName,
  getFileSorterItem,
  getFoldersForCase,
  updateFileSorterItem,
  upsertCaseFolder,
} from '../db/supabase.js';
import {
  fileExistsInDropbox,
  generateDropboxPermalink,
  listCaseFolders,
  uploadFileToDropbox,
} from './dropboxService.js';
import { slackService } from './slackService.js';
import { auditService } from './auditService.js';
import { parseThreadReply } from '../utils/threadParser.js';
import { logger } from '../utils/logger.js';

async function resolveFinalPaths(itemId: string): Promise<{
  caseId: string;
  folderPath: string;
  caseRow: NonNullable<Awaited<ReturnType<typeof getCaseById>>>;
}> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');

  let caseId = item.final_case_id ?? item.suggested_case_id;
  let folderPath = item.final_dropbox_path ?? item.suggested_folder_path;

  if (item.slack_queue_channel_id && item.slack_queue_message_ts) {
    const replies = await slackService.getThreadReplies(
      item.slack_queue_channel_id,
      item.slack_queue_message_ts
    );
    const latest = replies[replies.length - 1];
    if (latest) {
      const override = parseThreadReply(latest);
      if (override.caseName) {
        const matched = await getCaseByName(override.caseName);
        if (matched) {
          caseId = matched.id;
          await auditService.log(itemId, 'thread_override', {
            caseName: override.caseName,
            caseId: matched.id,
          });
        }
      }
      if (override.folderLabel && caseId) {
        const folders = await getFoldersForCase(caseId);
        const folder = folders.find(
          (f) => f.folder_label.toLowerCase() === override.folderLabel!.toLowerCase()
        );
        if (folder) {
          folderPath = folder.dropbox_path;
          await auditService.log(itemId, 'thread_override', {
            folderLabel: override.folderLabel,
            dropboxPath: folder.dropbox_path,
          });
        } else if (caseId) {
          const caseRow = await getCaseById(caseId);
          if (caseRow) {
            folderPath = `${caseRow.dropbox_root_path}/${override.folderLabel}`;
          }
        }
      }
    }
  }

  if (!caseId || !folderPath) {
    throw new Error('Case and folder must be set before approval (use thread overrides or AI suggestion)');
  }

  const caseRow = await getCaseById(caseId);
  if (!caseRow) throw new Error('Case not found');

  return { caseId, folderPath, caseRow };
}

export async function handleApprove(itemId: string, slackUserId: string): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  if (['saved', 'ignored'].includes(item.status)) {
    throw new Error(`Item already ${item.status}`);
  }

  const { caseId, folderPath, caseRow } = await resolveFinalPaths(itemId);

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
    final_case_id: caseId,
    final_dropbox_path: folderPath,
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: new Date().toISOString(),
  });

  await auditService.log(itemId, 'approved', { caseId, folderPath }, slackUserId);

  const buffer = await downloadTempAttachment(itemId, item.attachment_filename);
  const upload = await uploadFileToDropbox(folderPath, item.attachment_filename, buffer);
  const permalink = await generateDropboxPermalink(upload.path);

  const approverName = await slackService.getUserDisplayName(slackUserId);

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
    approvedBy: approverName,
    dropboxLink: permalink,
    disabled: true,
  });

  await slackService.postCaseChannelConfirmation({
    caseRow,
    item: saved,
    dropboxLink: permalink,
    approvedBy: approverName,
  });
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

  const caseRow = updated.suggested_case_id
    ? await getCaseById(updated.suggested_case_id)
    : null;
  await slackService.updateQueueMessage(updated, caseRow);
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

  const caseRow = updated.suggested_case_id
    ? await getCaseById(updated.suggested_case_id)
    : null;
  await slackService.updateQueueMessage(updated, caseRow, { disabled: true });
}

export async function reindexDropboxFoldersForCase(caseId: string): Promise<number> {
  const caseRow = await getCaseById(caseId);
  if (!caseRow) throw new Error('Case not found');

  const folders = await listCaseFolders(caseRow.dropbox_root_path);
  for (const f of folders) {
    await upsertCaseFolder(caseId, f.name, f.path);
  }
  logger.info('Reindexed case folders', { caseId, count: folders.length });
  return folders.length;
}
