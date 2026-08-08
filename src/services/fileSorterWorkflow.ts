import {
  getCaseById,
  getCaseByName,
  getFileSorterItem,
  getQueueBatchItems,
  updateCaseDropboxFolderName,
  updateFileSorterItem,
  upsertCaseFolder,
  upsertSenderCaseHint,
  upsertSenderSortHint,
  addCaseOnlyHint,
  insertMatchingHintIfNew,
  upsertCauseNumberCaseHint,
} from '../db/supabase.js';
import {
  getCasesRootPath,
  downloadDropboxFile,
  fileExistsInDropbox,
  generateDropboxPermalink,
  getDropboxFileMetadata,
  isDropboxFileConflict,
  listCaseFolders,
  uploadFileToDropbox,
} from './dropboxService.js';
import {
  extractCauseNumbersFromTexts,
  formatCauseNumberCaseHint,
} from '../utils/causeNumbers.js';
import { folderLabelFromDropboxPath } from '../utils/dropboxFolderLabel.js';
import { loadAttachmentBytesForItem } from '../utils/attachmentBuffer.js';
import { isCaseQueueChannel } from '../utils/queueChannel.js';
import {
  autoLearnContextFromApproval,
  buildPatternSortHints,
  buildSenderCaseHintText,
  buildSenderFolderHintText,
  buildThreadOverrideCaseHint,
  buildThreadOverrideFolderHint,
} from '../utils/autoLearnHints.js';
import { captureMedicalRecordsAfterApprove } from './medicalRecordsCaptureService.js';
import { captureCaseExpensesAfterApprove } from './caseExpensesCaptureService.js';
import { extractDocumentExcerpt } from './documentExtractor.js';
import {
  clearTempStorageForItems,
  scheduleTempStorageDeletionAfterRouted,
} from './tempStorageCleanupService.js';
import {
  parseCaseNumberFromDropboxFolder,
  RJL_STANDARD_SUBFOLDERS,
  normalizeFolderLabel,
} from '../constants/rjlFolders.js';
import { slackService } from './slackService.js';
import { auditService } from './auditService.js';
import { isExternalLinkItem } from '../utils/externalFileLinks.js';
import { parseThreadReplies } from '../utils/threadParser.js';
import type { FilenameRename } from '../utils/filenameRename.js';
import { resolveDropboxFilenameForItem, sanitizeDropboxFilename } from '../utils/filenameRename.js';
import {
  folderPathForBatchItem,
  resolveFolderPathForCase,
  resolvePerFileFoldersForCase,
  type ResolvedPerFileFolder,
} from '../utils/perFileFolder.js';
import type { SlackThreadContext } from './slackService.js';
import { logger } from '../utils/logger.js';
import type { Case, FileSorterItem } from '../types/index.js';
import { confirmThreadOverrides } from './queueThreadOverrideService.js';

function slackThreadForItem(item: FileSorterItem, slackThread?: SlackThreadContext): SlackThreadContext | null {
  if (slackThread?.channelId && slackThread.messageTs) {
    // Queue card ts on the item is the thread root — prefer it over interaction thread_ts.
    if (
      item.slack_queue_channel_id === slackThread.channelId &&
      item.slack_queue_message_ts
    ) {
      return {
        channelId: slackThread.channelId,
        messageTs: item.slack_queue_message_ts,
      };
    }
    return slackThread;
  }
  if (item.slack_queue_channel_id && item.slack_queue_message_ts) {
    return {
      channelId: item.slack_queue_channel_id,
      messageTs: item.slack_queue_message_ts,
    };
  }
  return null;
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
  threadCaseOverrideText: string | null;
  threadFolderOverrideText: string | null;
  filenameRenames: FilenameRename[];
  perFileFolders: ResolvedPerFileFolder[];
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
  let threadCaseOverrideText: string | null = null;
  let threadFolderOverrideText: string | null = null;
  let filenameRenames: FilenameRename[] = [];
  let perFileFolderOverrides: Array<{ sourcePattern: string; folderLabel: string }> = [];
  const threadCtx = slackThreadForItem(trigger, slackThread);

  if (threadCtx) {
    let replies: string[] = [];
    try {
      replies = await slackService.getThreadReplies(threadCtx);
    } catch (err) {
      logger.error('Could not load Slack thread overrides', {
        itemId,
        channelId: threadCtx.channelId,
        messageTs: threadCtx.messageTs,
        err: String(err),
        hint: 'Add channels:history and groups:history to the Slack app, then reinstall.',
      });
    }

    const override = parseThreadReplies(replies);
    logger.info('Thread overrides parsed for Approve', {
      itemId,
      replyCount: replies.length,
      folder: override.folderLabel ?? null,
      caseName: override.caseName ?? null,
      sortHints: override.sortHints?.length ?? 0,
      caseHints: override.caseHints?.length ?? 0,
      renames: override.filenameRenames?.length ?? 0,
      perFileFolders: override.perFileFolders?.length ?? 0,
    });
    if (override.caseHints?.length) {
      threadCaseHints = override.caseHints;
    }
    if (override.sortHints?.length) {
      threadSortHints = override.sortHints;
    }
    if (override.filenameRenames?.length) {
      filenameRenames = override.filenameRenames;
    }
    if (override.perFileFolders?.length) {
      perFileFolderOverrides = override.perFileFolders;
    }
    if (override.caseName) {
      threadCaseOverrideText = override.caseName.trim();
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
      threadFolderOverrideText = override.folderLabel.trim();
      threadFolderLabel = normalizeFolderLabel(override.folderLabel);
      threadFolderPath = await resolveFolderPathForCase(
        caseNumber,
        (await getCaseById(caseNumber))!,
        threadFolderLabel
      );
      await auditService.log(itemId, 'thread_override', {
        folderLabel: threadFolderLabel,
        dropboxPath: threadFolderPath,
        scope: 'all_attachments',
      });
    }
  }

  if (!caseNumber) {
    throw new Error('Case must be set before approval (use thread overrides or AI suggestion)');
  }

  const caseRow = await getCaseById(caseNumber);
  if (!caseRow) throw new Error('Case not found');

  const perFileFolders = perFileFolderOverrides.length
    ? await resolvePerFileFoldersForCase(caseNumber, caseRow, perFileFolderOverrides)
    : [];

  if (perFileFolders.length) {
    await auditService.log(itemId, 'thread_override', {
      perFileFolders: perFileFolders.map((f) => ({
        sourcePattern: f.sourcePattern,
        folderLabel: f.folderLabel,
        dropboxPath: f.folderPath,
      })),
    });
  }

  return {
    caseNumber,
    caseRow,
    threadFolderPath,
    threadCaseHints,
    threadSortHints,
    usedCaseOverride,
    usedFolderOverride,
    threadFolderLabel,
    threadCaseOverrideText,
    threadFolderOverrideText,
    filenameRenames,
    perFileFolders,
  };
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
  confirmedFolderLabel: string | null;
  savedAttachmentFilenames: string[];
  threadCaseOverrideText: string | null;
  threadFolderOverrideText: string | null;
  slackUserId: string;
  documentTextsForCauseLearning?: string[];
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
    confirmedFolderLabel,
    savedAttachmentFilenames,
    threadCaseOverrideText,
    threadFolderOverrideText,
    slackUserId,
    documentTextsForCauseLearning = [],
  } = opts;

  const aiMissedCase = batch.some(
    (i) => !i.suggested_case_number || i.suggested_case_number !== caseNumber
  );
  const aiMissedFolder = batch.some((i) => {
    const suggested = folderLabelFromDropboxPath(i.suggested_folder_path);
    return (
      confirmedFolderLabel &&
      suggested?.toLowerCase() !== confirmedFolderLabel.toLowerCase()
    );
  });

  const learnCtx = autoLearnContextFromApproval({
    trigger,
    batch,
    caseNumber,
    caseSlackChannelName: caseRow.slack_channel_name,
    confirmedFolderLabel,
    threadCaseOverrideText,
    threadFolderOverrideText,
  });
  learnCtx.attachmentFilenames = savedAttachmentFilenames;

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
        caseNumber,
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
    const caseHintText = buildSenderCaseHintText(learnCtx);
    try {
      await upsertSenderCaseHint({
        caseNumber,
        senderEmail: trigger.from_email,
        hintText: caseHintText,
        source: 'auto_learned',
        createdBy: slackUserId,
      });
      await auditService.log(
        trigger.id,
        'matching_hint_saved',
        {
          hintType: 'case',
          caseNumber,
          senderEmail: trigger.from_email,
          hintText: caseHintText.slice(0, 200),
          autoLearned: 'sender_case_corrected',
        },
        slackUserId
      );
    } catch (err) {
      logger.warn('Could not auto-learn sender case hint', { caseNumber, err: String(err) });
    }
  }

  if (!threadSortHints.length && confirmedFolderLabel) {
    const folderCorrected = usedFolderOverride || aiMissedFolder;
    if (folderCorrected) {
      const folderHintText = buildSenderFolderHintText(learnCtx);
      if (folderHintText) {
        try {
          await upsertSenderSortHint({
            senderEmail: trigger.from_email,
            hintText: folderHintText,
            caseNumber,
            source: 'auto_learned',
            createdBy: slackUserId,
          });
          await auditService.log(
            trigger.id,
            'matching_hint_saved',
            {
              hintType: 'sort',
              caseNumber,
              senderEmail: trigger.from_email,
              hintText: folderHintText.slice(0, 200),
              autoLearned: 'sender_folder_corrected',
            },
            slackUserId
          );
        } catch (err) {
          logger.warn('Could not auto-learn sender folder hint', { caseNumber, err: String(err) });
        }
      }
    }

    const patterns = buildPatternSortHints(learnCtx);
    for (const hintText of patterns) {
      try {
        const inserted = await insertMatchingHintIfNew({
          hintType: 'case',
          caseNumber,
          senderEmail: null,
          hintText,
          source: 'auto_learned',
          createdBy: slackUserId,
        });
        if (inserted) {
          await auditService.log(
            trigger.id,
            'matching_hint_saved',
            {
              hintType: 'case',
              caseNumber,
              hintText: hintText.slice(0, 200),
              autoLearned: 'pattern',
            },
            slackUserId
          );
        }
      } catch (err) {
        logger.warn('Could not auto-learn case filing pattern hint', { hintText, err: String(err) });
      }
    }
  }

  if (usedCaseOverride && !threadCaseHints.length) {
    const threadOverrideCaseHint = buildThreadOverrideCaseHint(learnCtx);
    if (threadOverrideCaseHint) {
      try {
        await insertMatchingHintIfNew({
          hintType: 'case',
          caseNumber,
          senderEmail: null,
          hintText: threadOverrideCaseHint,
          source: 'auto_learned',
          createdBy: slackUserId,
        });
      } catch (err) {
        logger.warn('Could not auto-learn thread Case override hint', { caseNumber, err: String(err) });
      }
    }
  }

  if (usedFolderOverride && !threadSortHints.length) {
    const threadOverrideFolderHint = buildThreadOverrideFolderHint(learnCtx);
    if (threadOverrideFolderHint) {
      try {
        await insertMatchingHintIfNew({
          hintType: 'case',
          caseNumber,
          senderEmail: null,
          hintText: threadOverrideFolderHint,
          source: 'auto_learned',
          createdBy: slackUserId,
        });
      } catch (err) {
        logger.warn('Could not auto-learn thread Folder override hint', { caseNumber, err: String(err) });
      }
    }
  }

  const causeNumbers = extractCauseNumbersFromTexts(
    trigger.subject,
    trigger.body_excerpt,
    ...batch.map((i) => i.ai_reason),
    ...documentTextsForCauseLearning
  );

  for (const causeNumber of causeNumbers) {
    try {
      const created = await upsertCauseNumberCaseHint({
        caseNumber,
        causeNumber,
        source: 'auto_learned',
        createdBy: slackUserId,
      });
      if (created) {
        const hintText = formatCauseNumberCaseHint(causeNumber, caseNumber);
        await auditService.log(
          trigger.id,
          'matching_hint_saved',
          {
            hintType: 'case',
            caseNumber,
            hintText: hintText.slice(0, 200),
            autoLearned: 'cause_number',
            causeNumber,
          },
          slackUserId
        );
        logger.info('Auto-learned Cause number case hint', { caseNumber, causeNumber });
      }
    } catch (err) {
      logger.warn('Could not auto-learn Cause number hint', {
        caseNumber,
        causeNumber,
        err: String(err),
      });
    }
  }
}

function dropboxFilePath(folderPath: string, filename: string): string {
  const normalized = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;
  return `${normalized}/${filename}`.replace(/\/+/g, '/');
}

function scheduleMedicalRecordsCapture(opts: {
  item: FileSorterItem;
  caseNumber: string;
  folderPath: string;
  dropboxPath: string;
  dropboxFileId?: string;
  fileBuffer?: Buffer;
  slackUserId: string;
}): void {
  void captureMedicalRecordsAfterApprove(opts).catch((err) => {
    logger.warn('Medical records capture failed', {
      itemId: opts.item.id,
      caseNumber: opts.caseNumber,
      err: String(err),
    });
  });
}

function scheduleCaseExpensesCapture(opts: {
  item: FileSorterItem;
  caseNumber: string;
  folderPath: string;
  dropboxPath: string;
  dropboxFileId?: string;
  fileBuffer?: Buffer;
  slackUserId: string;
}): void {
  void captureCaseExpensesAfterApprove(opts).catch((err) => {
    logger.warn('Case expenses capture failed', {
      itemId: opts.item.id,
      caseNumber: opts.caseNumber,
      err: String(err),
    });
  });
}

async function completeAsAlreadyInDropbox(opts: {
  batchItem: FileSorterItem;
  folderPath: string;
  caseNumber: string;
  slackUserId: string;
  reviewedAt: string;
  source: 'pre_check' | 'upload_409';
  dropboxFilename: string;
}): Promise<{ saved: FileSorterItem; permalink: string }> {
  const fullPath = dropboxFilePath(opts.folderPath, opts.dropboxFilename);
  const meta = await getDropboxFileMetadata(fullPath);

  let permalink = fullPath;
  try {
    permalink = await generateDropboxPermalink(fullPath);
  } catch (err) {
    logger.warn('Could not generate permalink for existing Dropbox file', {
      itemId: opts.batchItem.id,
      path: fullPath,
      err: String(err),
    });
  }

  let fileBuffer: Buffer | undefined;
  if (opts.batchItem.temp_storage_url) {
    try {
      fileBuffer = await loadAttachmentBytesForItem(opts.batchItem, {
        dropboxPath: fullPath,
      });
    } catch (err) {
      logger.warn('Could not load attachment bytes for existing Dropbox file', {
        itemId: opts.batchItem.id,
        path: fullPath,
        err: String(err),
      });
    }
  } else {
    try {
      fileBuffer = await downloadDropboxFile(fullPath);
    } catch (err) {
      logger.warn('Could not download existing Dropbox file for extraction', {
        itemId: opts.batchItem.id,
        path: fullPath,
        err: String(err),
      });
    }
  }

  const saved = await updateFileSorterItem(opts.batchItem.id, {
    status: 'saved',
    final_case_number: opts.caseNumber,
    final_dropbox_path: fullPath,
    dropbox_permalink: permalink,
    reviewed_by_slack_user_id: opts.slackUserId,
    reviewed_at: opts.reviewedAt,
  });

  await auditService.log(
    opts.batchItem.id,
    'duplicate_detected',
    {
      folderPath: opts.folderPath,
      filename: opts.batchItem.attachment_filename,
      dropboxFilename: opts.dropboxFilename,
      source: opts.source,
    },
    opts.slackUserId
  );
  await auditService.log(
    opts.batchItem.id,
    'approved',
    { caseNumber: opts.caseNumber, folderPath: opts.folderPath, alreadyInDropbox: true, dropboxFilename: opts.dropboxFilename },
    opts.slackUserId
  );
  await auditService.log(
    opts.batchItem.id,
    'saved_to_dropbox',
    { path: fullPath, permalink, alreadyInDropbox: true },
    opts.slackUserId
  );

  const folderLabel = opts.folderPath.split('/').filter(Boolean).pop();
  if (folderLabel) {
    try {
      await upsertCaseFolder(opts.caseNumber, folderLabel, opts.folderPath);
    } catch (err) {
      logger.warn('Could not index folder for existing Dropbox file', {
        caseNumber: opts.caseNumber,
        folderLabel,
        err: String(err),
      });
    }
  }

  scheduleTempStorageDeletionAfterRouted(saved);
  scheduleMedicalRecordsCapture({
    item: saved,
    caseNumber: opts.caseNumber,
    folderPath: opts.folderPath,
    dropboxPath: fullPath,
    dropboxFileId: meta?.id,
    fileBuffer,
    slackUserId: opts.slackUserId,
  });
  scheduleCaseExpensesCapture({
    item: saved,
    caseNumber: opts.caseNumber,
    folderPath: opts.folderPath,
    dropboxPath: fullPath,
    dropboxFileId: meta?.id,
    fileBuffer,
    slackUserId: opts.slackUserId,
  });
  return { saved, permalink };
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
    const primary = batch[0] ?? trigger;
    const caseRow = primary.suggested_case_number
      ? await getCaseById(primary.suggested_case_number)
      : null;
    await slackService.updateQueueMessage(primary, caseRow, { disabled: true });
    if (primary.slack_queue_channel_id && primary.slack_queue_message_ts) {
      await slackService.postQueueCardThreadNotice(
        primary,
        ':warning: *File Sorter* — All attachments in this email are already processed.'
      );
    }
    logger.info('Approve skipped — batch already processed', {
      itemId,
      batchSize: batch.length,
    });
    return;
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
    threadCaseOverrideText,
    threadFolderOverrideText,
    filenameRenames,
    perFileFolders,
  } = await resolveBatchCase(itemId, slackThread);

  logger.info('Approve folder resolution', {
    itemId,
    caseNumber,
    usedFolderOverride,
    threadFolderLabel,
    threadFolderPath: threadFolderPath ?? null,
    perFileFolders: perFileFolders.length,
    aiSuggestedFolder: trigger.suggested_folder_path ?? null,
  });

  const savedFiles: Array<{ filename: string; dropboxLink: string }> = [];
  const savedAttachmentFilenames: string[] = [];
  const crossPostFiles: Array<{
    item: FileSorterItem;
    dropboxLink: string;
    fileBuffer: Buffer;
  }> = [];
  let confirmedFolderLabel: string | null = threadFolderLabel;
  const reviewedAt = new Date().toISOString();
  let externalLinkCount = 0;
  const documentTextsForCauseLearning: string[] = [];

  for (const batchItem of pending) {
    if (isExternalLinkItem(batchItem)) {
      externalLinkCount++;
      continue;
    }

    const folderPath = folderPathForBatchItem(
      batchItem,
      batch,
      perFileFolders,
      threadFolderPath
    );
    if (!folderPath) {
      throw new Error(
        `No folder for ${batchItem.attachment_filename} — use Change Case/Folder or a thread override`
      );
    }

    const dropboxFilename = resolveDropboxFilenameForItem(batchItem, batch, filenameRenames);

    const exists = await fileExistsInDropbox(folderPath, dropboxFilename);
    if (exists) {
      logger.info('Dropbox file already present — marking sorted', {
        itemId: batchItem.id,
        folderPath,
        filename: dropboxFilename,
        originalFilename: batchItem.attachment_filename,
      });
      const { permalink } = await completeAsAlreadyInDropbox({
        batchItem,
        folderPath,
        caseNumber,
        slackUserId,
        reviewedAt,
        source: 'pre_check',
        dropboxFilename,
      });
      savedFiles.push({ filename: dropboxFilename, dropboxLink: permalink });
      savedAttachmentFilenames.push(dropboxFilename);
      const folderLabel = folderPath.split('/').filter(Boolean).pop();
      if (folderLabel) {
        confirmedFolderLabel = folderLabelFromDropboxPath(folderPath) ?? folderLabel;
      }
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await loadAttachmentBytesForItem(batchItem, {
        dropboxPath: dropboxFilePath(folderPath, dropboxFilename),
      });
    } catch (err) {
      if (await fileExistsInDropbox(folderPath, dropboxFilename)) {
        logger.info('Attachment bytes unavailable — file already in Dropbox, marking sorted', {
          itemId: batchItem.id,
          filename: dropboxFilename,
        });
        const { permalink } = await completeAsAlreadyInDropbox({
          batchItem,
          folderPath,
          caseNumber,
          slackUserId,
          reviewedAt,
          source: 'pre_check',
          dropboxFilename,
        });
        savedFiles.push({ filename: dropboxFilename, dropboxLink: permalink });
        savedAttachmentFilenames.push(dropboxFilename);
        const folderLabel = folderPath.split('/').filter(Boolean).pop();
        if (folderLabel) {
          confirmedFolderLabel = folderLabelFromDropboxPath(folderPath) ?? folderLabel;
        }
        continue;
      }
      logger.error('Temp attachment download failed', {
        itemId: batchItem.id,
        filename: batchItem.attachment_filename,
        err: String(err),
      });
      throw err;
    }

    try {
      const extracted = await extractDocumentExcerpt(
        buffer,
        batchItem.attachment_mime_type ?? '',
        batchItem.attachment_filename
      );
      if (extracted?.excerpt) {
        documentTextsForCauseLearning.push(extracted.excerpt);
      }
    } catch {
      /* optional — email text still used for Cause extraction */
    }

    let upload: { path: string; id: string; folderCreated: boolean };
    try {
      upload = await uploadFileToDropbox(folderPath, dropboxFilename, buffer);
    } catch (err) {
      if (isDropboxFileConflict(err)) {
        logger.info('Dropbox upload conflict — file already present, marking sorted', {
          itemId: batchItem.id,
          folderPath,
          filename: dropboxFilename,
          originalFilename: batchItem.attachment_filename,
        });
        const { permalink } = await completeAsAlreadyInDropbox({
          batchItem,
          folderPath,
          caseNumber,
          slackUserId,
          reviewedAt,
          source: 'upload_409',
          dropboxFilename,
        });
        savedFiles.push({ filename: dropboxFilename, dropboxLink: permalink });
        savedAttachmentFilenames.push(dropboxFilename);
        const folderLabel = folderPath.split('/').filter(Boolean).pop();
        if (folderLabel) {
          confirmedFolderLabel = folderLabelFromDropboxPath(folderPath) ?? folderLabel;
        }
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

    await auditService.log(batchItem.id, 'approved', {
      caseNumber,
      folderPath,
      dropboxFilename,
      originalFilename: batchItem.attachment_filename,
    }, slackUserId);

    await auditService.log(
      batchItem.id,
      'saved_to_dropbox',
      { path: upload.path, permalink, dropboxFilename },
      slackUserId
    );

    savedFiles.push({ filename: dropboxFilename, dropboxLink: permalink });
    savedAttachmentFilenames.push(dropboxFilename);
    crossPostFiles.push({ item: saved, dropboxLink: permalink, fileBuffer: buffer });

    const folderLabel = folderPath.split('/').filter(Boolean).pop();
    if (folderLabel) {
      confirmedFolderLabel = folderLabelFromDropboxPath(folderPath) ?? folderLabel;
      try {
        await upsertCaseFolder(caseNumber, folderLabel, folderPath);
      } catch (err) {
        logger.warn('Could not index folder after upload', {
          caseNumber,
          folderLabel,
          err: String(err),
        });
      }
    }

    scheduleTempStorageDeletionAfterRouted(saved);
    scheduleMedicalRecordsCapture({
      item: saved,
      caseNumber,
      folderPath,
      dropboxPath: upload.path,
      dropboxFileId: upload.id,
      fileBuffer: buffer,
      slackUserId,
    });
    scheduleCaseExpensesCapture({
      item: saved,
      caseNumber,
      folderPath,
      dropboxPath: upload.path,
      dropboxFileId: upload.id,
      fileBuffer: buffer,
      slackUserId,
    });
  }

  if (crossPostFiles.length) {
    const approvedInCaseChannel = isCaseQueueChannel(trigger.slack_queue_channel_id);
    if (approvedInCaseChannel) {
      logger.info('Skipping case channel cross-post — queue card was approved in case channel', {
        itemId: trigger.id,
        caseNumber: caseRow.case_number,
        channelId: trigger.slack_queue_channel_id,
        savedCount: crossPostFiles.length,
      });
    } else {
      const crossPosted = await slackService.postCaseChannelConfirmation({
        caseRow,
        trigger,
        files: crossPostFiles,
        approvedByUserId: slackUserId,
      });

      if (!crossPosted) {
        for (const f of crossPostFiles) {
          await auditService.log(
            f.item.id,
            'case_channel_cross_post_failed',
            { caseNumber: caseRow.case_number, slackChannelName: caseRow.slack_channel_name },
            slackUserId
          );
        }
      }
    }
  }

  const primary = (await getQueueBatchItems(trigger))[0] ?? trigger;
  await slackService.updateQueueMessage(primary, caseRow, {
    reviewedByUserId: slackUserId,
    savedFiles,
    disabled: savedFiles.length > 0,
  });

  if (!savedFiles.length) {
    if (externalLinkCount > 0) {
      throw new Error(
        'External file links (Google Drive, etc.) cannot be auto-filed — open the links in the queue card, download, and file manually.'
      );
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
    confirmedFolderLabel,
    savedAttachmentFilenames,
    threadCaseOverrideText,
    threadFolderOverrideText,
    slackUserId,
    documentTextsForCauseLearning,
  });
}

export async function handleChange(
  itemId: string,
  slackUserId: string,
  slackThread?: SlackThreadContext
): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  await slackService.postChangeInstructions(item);
  await auditService.log(itemId, 'thread_override', { action: 'change_requested' }, slackUserId);

  const threadCtx = slackThreadForItem(item, slackThread);
  if (threadCtx) {
    await confirmThreadOverrides(threadCtx, item.suggested_case_number);
  }
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

export async function handleSkipAttachment(
  itemId: string,
  slackUserId: string
): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  if (['saved', 'ignored'].includes(item.status)) {
    throw new Error('This attachment is already processed');
  }

  const batch = await getQueueBatchItems(item);
  const reviewedAt = new Date().toISOString();

  await updateFileSorterItem(itemId, {
    status: 'ignored',
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: reviewedAt,
  });
  await auditService.log(itemId, 'ignored', { singleAttachment: true }, slackUserId);
  await clearTempStorageForItems([{ ...item, status: 'ignored' }]);

  const primary = batch[0] ?? item;
  const refreshedBatch = await getQueueBatchItems(primary);
  const caseRow = primary.suggested_case_number
    ? await getCaseById(primary.suggested_case_number)
    : null;
  const allDone = refreshedBatch.every((i) => ['saved', 'ignored'].includes(i.status));

  await slackService.updateQueueMessage(primary, caseRow, {
    reviewedByUserId: slackUserId,
    disabled: allDone,
  });
}

export async function handleSaveQueueFilenameRename(
  itemId: string,
  dropboxFilename: string,
  slackUserId: string
): Promise<void> {
  const item = await getFileSorterItem(itemId);
  if (!item) throw new Error('Item not found');
  if (['saved', 'ignored'].includes(item.status)) {
    throw new Error('This attachment is already processed');
  }

  const safeName = sanitizeDropboxFilename(dropboxFilename);
  if (!safeName) throw new Error('Enter a valid filename');

  await updateFileSorterItem(itemId, {
    queue_save_as_filename: safeName,
    reviewed_by_slack_user_id: slackUserId,
    reviewed_at: new Date().toISOString(),
  });
  await auditService.log(
    itemId,
    'thread_override',
    {
      rename: true,
      originalFilename: item.attachment_filename,
      dropboxFilename: safeName,
    },
    slackUserId
  );

  const batch = await getQueueBatchItems(item);
  const primary = batch[0] ?? item;
  const caseRow = primary.suggested_case_number
    ? await getCaseById(primary.suggested_case_number)
    : null;
  await slackService.updateQueueMessage(primary, caseRow, {
    reviewedByUserId: slackUserId,
  });

  if (item.slack_queue_channel_id && item.slack_queue_message_ts) {
    const label =
      safeName === item.attachment_filename
        ? `*${safeName}*`
        : `_${item.attachment_filename}_ → *${safeName}*`;
    await slackService.postQueueCardThreadNotice(
      item,
      `:pencil2: *Rename saved* — will file as ${label} when you Approve.`
    );
  }
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

  try {
    await slackService.postDoNotSortThreadDetails(primary, batch, caseRow);
  } catch (err) {
    logger.warn('Could not post Do Not Sort details to thread', {
      itemId: primary.id,
      err: String(err),
    });
  }
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
