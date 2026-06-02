import {
  downloadTempAttachment,
  getCaseById,
  getCaseByName,
  getFileSorterItem,
  getFoldersForCase,
  getQueueBatchItems,
  updateCaseDropboxFolderName,
  updateFileSorterItem,
  upsertCaseFolder,
  upsertSenderCaseHint,
  upsertSenderSortHint,
  addCaseOnlyHint,
} from '../db/supabase.js';
import {
  getCasesRootPath,
  fileExistsInDropbox,
  generateDropboxPermalink,
  isDropboxFileConflict,
  listCaseFolders,
  uploadFileToDropbox,
} from './dropboxService.js';
import { FILE_ALREADY_IN_DROPBOX } from '../utils/approveErrors.js';
import { clearTempStorageForItem, clearTempStorageForItems } from './tempStorageCleanupService.js';
import {
  parseCaseNumberFromDropboxFolder,
  RJL_STANDARD_SUBFOLDERS,
} from '../constants/rjlFolders.js';
import { slackService } from './slackService.js';
import { auditService } from './auditService.js';
import { parseThreadReplies } from '../utils/threadParser.js';
import type { SlackThreadContext } from './slackService.js';
import { logger } from '../utils/logger.js';
import type { Case, FileSorterItem } from '../types/index.js';

function slackThreadForItem(item: FileSorterItem, slackThread?: SlackThreadContext): SlackThreadContext | null {
  return (
    slackThread ??
    (item.slack_queue_channel_id && item.slack_queue_message_ts
      ? {
          channelId: item.slack_queue_channel_id,
          messageTs: item.slack_queue_message_ts,
        }
      : null)
  );
}

async function resolveBatchCase(
  itemId: string,
  slackThread?: SlackThreadContext
): Promise<{
  caseNumber: string;
  caseRow: Case;
  threadFolderPath: string | null;
  threadCaseHints: string[];
  threadSortHints: string[];
  usedCaseOverride: boolean;
  usedFolderOverride: boolean;
  threadFolderLabel: string | null;
}> {
  const trigger = await getFileSorterItem(itemId);
  if (!trigger) throw new Error('Item not found');

  const batch = await getQueueBatchItems(trigger);
  let caseNumber =
    trigger.final_case_number ??
    trigger.suggested_case_number ??
    batch.find((i) => i.suggested_case_number)?.suggested_case_number ??
    null;

  let threadFolderPath: string | null = null;
  let threadCaseHints: string[] = [];
  let threadSortHints: string[] = [];
  let usedCaseOverride = false;
  let usedFolderOverride = false;
  let threadFolderLabel: string | null = null;
  const threadCtx = slackThreadForItem(trigger, slackThread);

  if (threadCtx) {
    let replies: string[] = [];
    try {
      replies = await slackService.getThreadReplies(threadCtx);
    } catch (err) {
      logger.warn('Could not load Slack thread overrides', {
        itemId,
        err: String(err),
      });
    }

    const override = parseThreadReplies(replies);
    if (override.caseHints?.length) {
      threadCaseHints = override.caseHints;
    }
    if (override.sortHints?.length) {
      threadSortHints = override.sortHints;
    }
    if (override.caseName) {
      const matched = await getCaseByName(override.caseName);
      if (matched) {
        caseNumber = matched.case_number;
        usedCaseOverride = true;
        await auditService.log(itemId, 'thread_override', {
          caseName: override.caseName,
          caseNumber: matched.case_number,
        });
      }
    }
    if (override.folderLabel && caseNumber) {
      usedFolderOverride = true;
      threadFolderLabel = override.folderLabel;
      const folders = await getFoldersForCase(caseNumber);
      const folder = folders.find(
        (f) => f.folder_label.toLowerCase() === override.folderLabel!.toLowerCase()
      );
      if (folder) {
        threadFolderPath = folder.dropbox_path;
        await auditService.log(itemId, 'thread_override', {
          folderLabel: override.folderLabel,
          dropboxPath: folder.dropbox_path,
        });
      } else {
        const caseRow = await getCaseById(caseNumber);
        if (caseRow) {
          threadFolderPath = `${caseRow.dropbox_root_path}/${override.folderLabel}`;
          await auditService.log(itemId, 'thread_override', {
            folderLabel: override.folderLabel,
            dropboxPath: threadFolderPath,
            note: 'constructed from case root',
          });
        }
      }
    }
  }

  if (!caseNumber) {
    throw new Error('Case must be set before approval (use thread overrides or AI suggestion)');
  }

  const caseRow = await getCaseById(caseNumber);
  if (!caseRow) throw new Error('Case not found');

  return {
    caseNumber,
    caseRow,
    threadFolderPath,
    threadCaseHints,
    threadSortHints,
    usedCaseOverride,
    usedFolderOverride,
    threadFolderLabel,
  };
}

function folderPathForBatchItem(
  item: FileSorterItem,
  caseRow: Case,
  threadFolderPath: string | null
): string | null {
  if (threadFolderPath) return threadFolderPath;
  return item.suggested_folder_path;
}

async function persistMatchingHintsFromApproval(opts: {
  trigger: FileSorterItem;
  batch: FileSorterItem[];
  caseNumber: string;
  caseRow: Case;
  threadCaseHints: string[];
  threadSortHints: string[];
  usedCaseOverride: boolean;
  usedFolderOverride: boolean;
  threadFolderLabel: string | null;
  slackUserId: string;
}): Promise<void> {
  const {
    trigger,
    batch,
    caseNumber,
    caseRow,
    threadCaseHints,
    threadSortHints,
    usedCaseOverride,
    usedFolderOverride,
    threadFolderLabel,
    slackUserId,
  } = opts;

  const aiMissedCase = batch.some(
    (i) => !i.suggested_case_number || i.suggested_case_number !== caseNumber
  );

  for (const hintText of threadCaseHints) {
    try {
      await upsertSenderCaseHint({
        caseNumber,
        senderEmail: trigger.from_email,
        hintText,
        source: 'slack_thread',
        createdBy: slackUserId,
      });
      await addCaseOnlyHint({
        caseNumber,
        hintText,
        source: 'slack_thread',
        createdBy: slackUserId,
      });
      await auditService.log(
        trigger.id,
        'matching_hint_saved',
        { hintType: 'case', caseNumber, senderEmail: trigger.from_email, hintText: hintText.slice(0, 200) },
        slackUserId
      );
    } catch (err) {
      logger.warn('Could not save case hint', { caseNumber, err: String(err) });
    }
  }

  for (const hintText of threadSortHints) {
    try {
      await upsertSenderSortHint({
        senderEmail: trigger.from_email,
        hintText,
        caseNumber: null,
        source: 'slack_thread',
        createdBy: slackUserId,
      });
      await auditService.log(
        trigger.id,
        'matching_hint_saved',
        { hintType: 'sort', senderEmail: trigger.from_email, hintText: hintText.slice(0, 200) },
        slackUserId
      );
    } catch (err) {
      logger.warn('Could not save sort hint', { err: String(err) });
    }
  }

  if ((usedCaseOverride || aiMissedCase) && !threadCaseHints.length) {
    const hintText = `Emails from ${trigger.from_email} belong to case ${caseRow.slack_channel_name} (${caseNumber}).`;
    try {
      await upsertSenderCaseHint({
        caseNumber,
        senderEmail: trigger.from_email,
        hintText,
        source: 'auto_learned',
        createdBy: slackUserId,
      });
    } catch (err) {
      logger.warn('Could not auto-learn case hint', { caseNumber, err: String(err) });
    }
  }

  if (usedFolderOverride && threadFolderLabel && !threadSortHints.length) {
    const hintText = `Emails from ${trigger.from_email} → folder ${threadFolderLabel}.`;
    try {
      await upsertSenderSortHint({
        senderEmail: trigger.from_email,
        hintText,
        caseNumber: null,
        source: 'auto_learned',
        createdBy: slackUserId,
      });
    } catch (err) {
      logger.warn('Could not auto-learn sort hint', { err: String(err) });
    }
  }
}

export async function handleApprove(
  itemId: string,
  slackUserId: string,
  slackThread?: SlackThreadContext
): Promise<void> {
  const trigger = await getFileSorterItem(itemId);
  if (!trigger) throw new Error('Item not found');

  const batch = await getQueueBatchItems(trigger);
  const pending = batch.filter((i) => !['saved', 'ignored'].includes(i.status));
  if (!pending.length) {
    throw new Error('All attachments in this email are already processed');
  }

  logger.info('Approve started', {
    itemId,
    slackUserId,
    pendingCount: pending.length,
    filenames: pending.map((i) => i.attachment_filename),
  });

  const {
    caseNumber,
    caseRow,
    threadFolderPath,
    threadCaseHints,
    threadSortHints,
    usedCaseOverride,
    usedFolderOverride,
    threadFolderLabel,
  } = await resolveBatchCase(itemId, slackThread);

  const savedFiles: Array<{ filename: string; dropboxLink: string }> = [];
  const reviewedAt = new Date().toISOString();
  let duplicateCount = 0;

  for (const batchItem of pending) {
    const folderPath = folderPathForBatchItem(batchItem, caseRow, threadFolderPath);
    if (!folderPath) {
      throw new Error(
        `No folder for ${batchItem.attachment_filename} — use Change Case/Folder or a thread override`
      );
    }

    const exists = await fileExistsInDropbox(folderPath, batchItem.attachment_filename);
    if (exists) {
      logger.warn('Dropbox duplicate skipped at pre-check', {
        itemId: batchItem.id,
        folderPath,
        filename: batchItem.attachment_filename,
      });
      await updateFileSorterItem(batchItem.id, { status: 'needs_attention' });
      await auditService.log(
        batchItem.id,
        'duplicate_detected',
        { folderPath, filename: batchItem.attachment_filename },
        slackUserId
      );
      duplicateCount++;
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await downloadTempAttachment(batchItem.id, batchItem.attachment_filename);
    } catch (err) {
      logger.error('Temp attachment download failed', {
        itemId: batchItem.id,
        filename: batchItem.attachment_filename,
        err: String(err),
      });
      throw err;
    }

    let upload: { path: string; id: string; folderCreated: boolean };
    try {
      upload = await uploadFileToDropbox(folderPath, batchItem.attachment_filename, buffer);
    } catch (err) {
      if (isDropboxFileConflict(err)) {
        logger.warn('Dropbox upload conflict (409)', {
          itemId: batchItem.id,
          folderPath,
          filename: batchItem.attachment_filename,
        });
        await updateFileSorterItem(batchItem.id, { status: 'needs_attention' });
        await auditService.log(
          batchItem.id,
          'duplicate_detected',
          { folderPath, filename: batchItem.attachment_filename, source: 'upload_409' },
          slackUserId
        );
        duplicateCount++;
        continue;
      }
      logger.error('Dropbox upload failed', {
        itemId: batchItem.id,
        folderPath,
        err: String(err),
      });
      throw err;
    }

    const permalink = await generateDropboxPermalink(upload.path);

    const saved = await updateFileSorterItem(batchItem.id, {
      status: 'saved',
      final_case_number: caseNumber,
      final_dropbox_path: upload.path,
      dropbox_permalink: permalink,
      reviewed_by_slack_user_id: slackUserId,
      reviewed_at: reviewedAt,
    });

    await auditService.log(batchItem.id, 'approved', { caseNumber, folderPath }, slackUserId);

    await auditService.log(
      batchItem.id,
      'saved_to_dropbox',
      { path: upload.path, permalink },
      slackUserId
    );

    savedFiles.push({ filename: batchItem.attachment_filename, dropboxLink: permalink });

    await clearTempStorageForItem(saved);

    const crossPosted = await slackService.postCaseChannelConfirmation({
      caseRow,
      item: saved,
      dropboxLink: permalink,
      approvedByUserId: slackUserId,
      fileBuffer: buffer,
    });

    if (!crossPosted) {
      await auditService.log(
        batchItem.id,
        'case_channel_cross_post_failed',
        { caseNumber: caseRow.case_number, slackChannelName: caseRow.slack_channel_name },
        slackUserId
      );
    }
  }

  const primary = (await getQueueBatchItems(trigger))[0] ?? trigger;
  await slackService.updateQueueMessage(primary, caseRow, {
    reviewedByUserId: slackUserId,
    savedFiles,
    disabled: savedFiles.length > 0,
  });

  if (!savedFiles.length) {
    if (duplicateCount > 0) {
      throw new Error(FILE_ALREADY_IN_DROPBOX);
    }
    throw new Error('No files were saved — check folder overrides in thread.');
  }

  logger.info('Approve completed', {
    itemId,
    savedCount: savedFiles.length,
    caseNumber,
  });

  await persistMatchingHintsFromApproval({
    trigger,
    batch,
    caseNumber,
    caseRow,
    threadCaseHints,
    threadSortHints,
    usedCaseOverride,
    usedFolderOverride,
    threadFolderLabel,
    slackUserId,
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
  const trigger = await getFileSorterItem(itemId);
  if (!trigger) throw new Error('Item not found');

  const batch = await getQueueBatchItems(trigger);
  const reviewedAt = new Date().toISOString();

  for (const batchItem of batch) {
    if (['saved', 'ignored'].includes(batchItem.status)) continue;
    await updateFileSorterItem(batchItem.id, {
      status: 'needs_attention',
      reviewed_by_slack_user_id: slackUserId,
      reviewed_at: reviewedAt,
    });
    await auditService.log(batchItem.id, 'needs_attention', { batch: true }, slackUserId);
  }

  const primary = batch[0] ?? trigger;
  const caseRow = primary.suggested_case_number
    ? await getCaseById(primary.suggested_case_number)
    : null;
  await slackService.updateQueueMessage(primary, caseRow, {
    reviewedByUserId: slackUserId,
  });
}

export async function handleDoNotSort(itemId: string, slackUserId: string): Promise<void> {
  const trigger = await getFileSorterItem(itemId);
  if (!trigger) throw new Error('Item not found');

  const batch = await getQueueBatchItems(trigger);
  const reviewedAt = new Date().toISOString();

  const toClear: FileSorterItem[] = [];

  for (const batchItem of batch) {
    if (['saved', 'ignored'].includes(batchItem.status)) continue;
    await updateFileSorterItem(batchItem.id, {
      status: 'ignored',
      reviewed_by_slack_user_id: slackUserId,
      reviewed_at: reviewedAt,
    });
    await auditService.log(batchItem.id, 'ignored', { batch: true }, slackUserId);
    toClear.push({ ...batchItem, status: 'ignored' });
  }

  await clearTempStorageForItems(toClear);

  const primary = batch[0] ?? trigger;
  const caseRow = primary.suggested_case_number
    ? await getCaseById(primary.suggested_case_number)
    : null;
  await slackService.updateQueueMessage(primary, caseRow, {
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
