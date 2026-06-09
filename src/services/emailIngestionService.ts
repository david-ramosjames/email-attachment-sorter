import { randomUUID } from 'crypto';
import {
  createFileSorterItemIfNew,
  getFileSorterItemByGmailAttachment,
  downloadTempAttachment,
  getCaseById,
  getCaseHintsForSender,
  getCaseHintsForCauseNumbers,
  getSortHintsForSender,
  getSenderFolderHistory,
  updateFileSorterItem,
  uploadTempAttachment,
} from '../db/supabase.js';
import { extractClientIdentity } from './clientIdentityAi.js';
import { classifyDocument } from './aiClassifier.js';
import { extractDocumentExcerpt } from './documentExtractor.js';
import { postEmailItemsToSlack, type QueuedInboundItem } from './emailBatchSlack.js';
import { auditService } from './auditService.js';
import { parseInboundEmail } from './emailIngestion/index.js';
import { syncDropboxStructureIfStale } from './dropboxSyncService.js';
import { CASE_REVIEW_THRESHOLD } from '../constants/classification.js';
import { extractCauseNumbersFromTexts } from '../utils/causeNumbers.js';
import { mergeMatchingHints } from '../utils/matchingHints.js';
import type {
  InboundAttachment,
  InboundEmailPayload,
  MatchContext,
} from '../types/index.js';
import { extractPatientNamesFromText } from '../utils/patientNameExtract.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { clientIdentityIsUnknown } from '../utils/emailClientSignals.js';
import {
  extractExternalFileLinks,
  externalLinkToAttachment,
  isExternalLinkAttachment,
} from '../utils/externalFileLinks.js';
import { extractForwardedEmailContext } from '../utils/forwardedEmailContext.js';
import { isIgnoredInboundRecipient, isIgnoredInboundSender } from '../constants/ignoredSenders.js';
import { logger } from '../utils/logger.js';

/** Shared state while processing all attachments in one inbound email. */
interface EmailBatchState {
  patientNames: string[];
  sharedCaseNumber: string | null;
  sharedConfidence: number;
}

async function resolveAttachmentBuffer(
  itemId: string,
  attachment: InboundAttachment
): Promise<Buffer> {
  if (attachment.contentBase64) {
    return Buffer.from(attachment.contentBase64, 'base64');
  }
  if (attachment.downloadUrl) {
    const res = await fetch(attachment.downloadUrl);
    if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Attachment must include contentBase64 or downloadUrl');
}

export async function processInboundEmail(
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): Promise<{ processed: number; skipped: number }> {
  await syncDropboxStructureIfStale(30);

  const payload = parseInboundEmail(headers, body);

  if (isIgnoredInboundSender(payload.fromEmail)) {
    logger.info('Skipping email from ignored sender', {
      gmailMessageId: payload.gmailMessageId,
      fromEmail: payload.fromEmail,
    });
    return { processed: 0, skipped: 1 };
  }

  if (isIgnoredInboundRecipient(payload.toEmails)) {
    logger.info('Skipping email to ignored recipient inbox', {
      gmailMessageId: payload.gmailMessageId,
      toEmails: payload.toEmails,
    });
    return { processed: 0, skipped: 1 };
  }

  const rawBody = payload.bodyExcerpt;
  const externalLinks = extractExternalFileLinks(rawBody);
  const linkAttachments = externalLinks.map(externalLinkToAttachment);
  const bodyExcerpt = buildSmartBodyExcerpt(rawBody);
  const enrichedPayload = { ...payload, bodyExcerpt };
  const forwardedEmailContext = extractForwardedEmailContext(rawBody);

  const allAttachments = [...payload.attachments, ...linkAttachments];

  if (externalLinks.length) {
    logger.info('External file links found in email', {
      gmailMessageId: payload.gmailMessageId,
      fileAttachmentCount: payload.attachments.length,
      externalLinkCount: externalLinks.length,
      urls: externalLinks.map((l) => l.url),
    });
  }

  if (!allAttachments.length) {
    logger.info('Skipping email with no attachments or external file links', {
      gmailMessageId: payload.gmailMessageId,
    });
    return { processed: 0, skipped: 1 };
  }

  const payloadWithLinks = { ...enrichedPayload, attachments: allAttachments };

  const patientNames = extractPatientNamesFromText(
    [enrichedPayload.subject, bodyExcerpt].join('\n')
  );
  const batch: EmailBatchState = {
    patientNames,
    sharedCaseNumber: null,
    sharedConfidence: 0,
  };

  await preflightEmailBatchNames(payloadWithLinks, batch);

  const attachments = [...payloadWithLinks.attachments].sort(attachmentSortRank);

  const queued: QueuedInboundItem[] = [];
  let skipped = 0;
  for (const attachment of attachments) {
    const outcome = await processSingleAttachment(
      payloadWithLinks,
      attachment,
      batch,
      forwardedEmailContext
    );
    if (outcome === 'skipped') {
      skipped++;
    } else {
      queued.push(outcome);
    }
  }

  if (queued.length > 0) {
    await postEmailItemsToSlack(payloadWithLinks, queued, batch.sharedCaseNumber);
  }

  return { processed: queued.length, skipped };
}

async function processSingleAttachment(
  payload: InboundEmailPayload,
  attachment: InboundAttachment,
  batch: EmailBatchState,
  forwardedEmailContext: string | null
): Promise<QueuedInboundItem | 'skipped'> {
  const existing = await getFileSorterItemByGmailAttachment(
    payload.gmailMessageId,
    attachment.filename
  );
  if (existing) {
    logger.info('Skipping duplicate inbound attachment', {
      gmailMessageId: payload.gmailMessageId,
      attachmentFilename: attachment.filename,
      existingItemId: existing.id,
      status: existing.status,
    });
    return 'skipped';
  }

  const itemId = randomUUID();
  const isExternalLink = isExternalLinkAttachment(attachment);

  let tempStorageUrl: string | null = null;
  let fileBuffer: Buffer | null = null;

  if (isExternalLink) {
    tempStorageUrl = attachment.downloadUrl?.trim() ?? null;
  } else {
    fileBuffer = await resolveAttachmentBuffer(itemId, attachment);
    try {
      tempStorageUrl = await uploadTempAttachment(
        itemId,
        attachment.filename,
        fileBuffer,
        attachment.mimeType
      );
    } catch (err) {
      logger.warn('Temp storage upload failed; Approve will fail until bucket exists', {
        itemId,
        filename: attachment.filename,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const senderPriorFolderLabels = await getSenderFolderHistory(payload.fromEmail);
  const senderCaseHints = await getCaseHintsForSender(payload.fromEmail);
  const senderSortHints = await getSortHintsForSender(payload.fromEmail);
  const causeNumbers = extractCauseNumbersFromTexts(payload.subject, payload.bodyExcerpt);
  const causeHints = causeNumbers.length
    ? await getCaseHintsForCauseNumbers(causeNumbers)
    : [];

  const matchContext: MatchContext = {
    fromEmail: payload.fromEmail,
    toEmails: payload.toEmails,
    ccEmails: payload.ccEmails,
    subject: payload.subject,
    bodyExcerpt: payload.bodyExcerpt,
    attachmentFilename: attachment.filename,
    senderPriorFolderLabels,
    caseMatchingHints: mergeMatchingHints(senderCaseHints, causeHints),
    documentSortHints: senderSortHints,
    emailPatientNames: batch.patientNames,
    siblingAttachmentFilenames: payload.attachments.map((a) => a.filename),
    batchSharedCaseNumber: batch.sharedCaseNumber ?? undefined,
    externalFileUrl: isExternalLink ? attachment.downloadUrl : undefined,
    forwardedEmailContext: forwardedEmailContext ?? undefined,
  };

  let documentExtraction: { method: string; excerptLength: number } | null = null;

  if (!isExternalLink && fileBuffer) {
    const isFilingDocument =
      /\.(pdf|docx?)$/i.test(attachment.filename) ||
      attachment.mimeType.includes('pdf') ||
      attachment.mimeType.includes('word') ||
      attachment.mimeType.includes('msword') ||
      attachment.mimeType.startsWith('image/');

    if (isFilingDocument) {
      const extracted = await extractDocumentExcerpt(
        fileBuffer,
        attachment.mimeType,
        attachment.filename
      );
      if (extracted?.excerpt) {
        matchContext.documentExcerpt = extracted.excerpt;
        const fromDoc = extractPatientNamesFromText(extracted.excerpt);
        if (fromDoc.length) {
          matchContext.emailPatientNames = [
            ...new Set([...(matchContext.emailPatientNames ?? []), ...fromDoc]),
          ];
          batch.patientNames = [...new Set([...batch.patientNames, ...fromDoc])];
        }
        documentExtraction = {
          method: extracted.method,
          excerptLength: extracted.excerpt.length,
        };
        const fromDocCauseHints = await getCaseHintsForCauseNumbers(
          extractCauseNumbersFromTexts(extracted.excerpt)
        );
        if (fromDocCauseHints.length) {
          matchContext.caseMatchingHints = mergeMatchingHints(
            matchContext.caseMatchingHints,
            fromDocCauseHints
          );
        }
      }
    }
  }

  matchContext.aiClientIdentity = await extractClientIdentity(matchContext);
  if (matchContext.aiClientIdentity.clientFullName) {
    matchContext.emailPatientNames = [
      ...new Set([
        matchContext.aiClientIdentity.clientFullName,
        ...(matchContext.emailPatientNames ?? []),
      ]),
    ];
    batch.patientNames = [...new Set([...batch.patientNames, matchContext.aiClientIdentity.clientFullName])];
  }

  let classification = await classifyDocument(matchContext);

  logger.info('Classification complete', {
    itemId,
    documentExcerptChars: matchContext.documentExcerpt?.length ?? 0,
    client: classification.reason.slice(0, 120),
    caseConfidence: classification.caseConfidence,
    folderConfidence: classification.folderConfidence,
    overallConfidence: classification.confidence,
    suggestedCase: classification.suggestedCaseNumber,
  });

  if (isExternalLink) {
    classification = {
      ...classification,
      needsAttention: true,
      reason: `${classification.reason} (Google Drive / external link — download manually; cannot auto-file to Dropbox)`,
    };
  } else if (forwardedEmailContext && !classification.reason.includes(forwardedEmailContext.slice(0, 40))) {
    classification = {
      ...classification,
      reason: `Original request: ${forwardedEmailContext}. ${classification.reason}`,
    };
  }

  if (
    classification.suggestedCaseNumber &&
    classification.caseConfidence >= CASE_REVIEW_THRESHOLD &&
    !clientIdentityIsUnknown({
      subject: payload.subject,
      bodyExcerpt: payload.bodyExcerpt,
      aiClientIdentity: matchContext.aiClientIdentity,
    })
  ) {
    batch.sharedCaseNumber = classification.suggestedCaseNumber;
    batch.sharedConfidence = classification.caseConfidence;
  }

  const status =
    classification.needsAttention || isExternalLink ? 'needs_attention' : 'pending_review';

  const { item, created } = await createFileSorterItemIfNew({
    id: itemId,
    gmail_message_id: payload.gmailMessageId,
    from_email: payload.fromEmail,
    to_emails: payload.toEmails,
    cc_emails: payload.ccEmails,
    subject: payload.subject,
    body_excerpt: payload.bodyExcerpt,
    attachment_filename: attachment.filename,
    attachment_mime_type: attachment.mimeType,
    attachment_size: attachment.size,
    temp_storage_url: tempStorageUrl,
    suggested_case_number: classification.suggestedCaseNumber,
    suggested_folder_path: classification.suggestedFolderPath,
    suggested_document_type: classification.intakeNoCase
      ? 'Intake'
      : classification.documentType === 'needs_attention'
        ? null
        : classification.documentType,
    ai_case_confidence: classification.caseConfidence,
    ai_folder_confidence: classification.folderConfidence,
    ai_confidence: classification.confidence,
    ai_reason: classification.reason,
    status,
    final_case_number: null,
    final_dropbox_path: null,
    dropbox_permalink: null,
    slack_queue_message_ts: null,
    slack_queue_channel_id: null,
    reviewed_by_slack_user_id: null,
    reviewed_at: null,
    email_received_at: payload.receivedAt,
  });

  if (!created) {
    logger.info('Duplicate attachment insert raced; skipping Slack queue', {
      gmailMessageId: payload.gmailMessageId,
      attachmentFilename: attachment.filename,
      itemId: item.id,
    });
    return 'skipped';
  }

  await auditService.log(item.id, 'email_received', {
    gmailMessageId: payload.gmailMessageId,
    from: payload.fromEmail,
    attachment: attachment.filename,
  });

  await auditService.log(item.id, 'classification_complete', {
    suggestedCaseNumber: classification.suggestedCaseNumber,
    caseConfidence: classification.caseConfidence,
    folderConfidence: classification.folderConfidence,
    overallConfidence: classification.confidence,
    reason: classification.reason,
    documentExtraction,
    aiClientIdentity: matchContext.aiClientIdentity,
  });

  const caseRow = classification.suggestedCaseNumber
    ? await getCaseById(classification.suggestedCaseNumber)
    : batch.sharedCaseNumber
      ? await getCaseById(batch.sharedCaseNumber)
      : null;

  return { item, caseRow };
}

/** Process documents with extractable text before generic email signature images; links last. */
function attachmentSortRank(a: InboundAttachment): number {
  if (isExternalLinkAttachment(a)) return 3;
  if (/\.(docx?|pdf)$/i.test(a.filename)) return 0;
  if (/\.(jpe?g|png|gif|webp|tiff?)$/i.test(a.filename)) return 2;
  return 1;
}

/** Seed batch patient names from subject/body before attachments are classified. */
function preflightEmailBatchNames(
  payload: InboundEmailPayload,
  batch: EmailBatchState
): void {
  const fromSubjectBody = extractPatientNamesFromText(
    [payload.subject, payload.bodyExcerpt].join('\n')
  );
  if (fromSubjectBody.length) {
    batch.patientNames = [...new Set([...batch.patientNames, ...fromSubjectBody])];
  }
}

export { downloadTempAttachment };
