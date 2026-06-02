import { randomUUID } from 'crypto';
import {
  createFileSorterItemIfNew,
  getFileSorterItemByGmailAttachment,
  downloadTempAttachment,
  getCaseById,
  getCaseHintsForSender,
  getSortHintsForSender,
  getSenderHistory,
  updateFileSorterItem,
  uploadTempAttachment,
} from '../db/supabase.js';
import { extractClientIdentity } from './clientIdentityAi.js';
import { findCaseCandidates } from './caseMatcher.js';
import { classifyDocument } from './aiClassifier.js';
import { extractDocumentExcerpt } from './documentExtractor.js';
import { postEmailItemsToSlack, type QueuedInboundItem } from './emailBatchSlack.js';
import { auditService } from './auditService.js';
import { parseInboundEmail } from './emailIngestion/index.js';
import { syncDropboxStructureIfStale } from './dropboxSyncService.js';
import type {
  InboundAttachment,
  InboundEmailPayload,
  MatchContext,
} from '../types/index.js';
import { extractPatientNamesFromText } from '../utils/patientNameExtract.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { clientIdentityIsUnknown } from '../utils/emailClientSignals.js';
import { isIgnoredInboundSender } from '../constants/ignoredSenders.js';
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

  if (!payload.attachments.length) {
    logger.info('Skipping email with no attachments', {
      gmailMessageId: payload.gmailMessageId,
    });
    return { processed: 0, skipped: 1 };
  }

  const bodyExcerpt = buildSmartBodyExcerpt(payload.bodyExcerpt);
  const enrichedPayload = { ...payload, bodyExcerpt };

  const patientNames = extractPatientNamesFromText(
    [enrichedPayload.subject, bodyExcerpt].join('\n')
  );
  const batch: EmailBatchState = {
    patientNames,
    sharedCaseNumber: null,
    sharedConfidence: 0,
  };

  await preflightEmailBatchCase(enrichedPayload, batch);

  const attachments = [...enrichedPayload.attachments].sort(attachmentSortRank);

  const queued: QueuedInboundItem[] = [];
  let skipped = 0;
  for (const attachment of attachments) {
    const outcome = await processSingleAttachment(enrichedPayload, attachment, batch);
    if (outcome === 'skipped') {
      skipped++;
    } else {
      queued.push(outcome);
    }
  }

  if (queued.length > 0) {
    await postEmailItemsToSlack(enrichedPayload, queued, batch.sharedCaseNumber);
  }

  return { processed: queued.length, skipped };
}

async function processSingleAttachment(
  payload: InboundEmailPayload,
  attachment: InboundAttachment,
  batch: EmailBatchState
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
  const buffer = await resolveAttachmentBuffer(itemId, attachment);

  let tempStorageUrl: string | null = null;
  try {
    tempStorageUrl = await uploadTempAttachment(
      itemId,
      attachment.filename,
      buffer,
      attachment.mimeType
    );
  } catch (err) {
    logger.warn('Temp storage upload failed; Approve will fail until bucket exists', {
      itemId,
      filename: attachment.filename,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const senderPriorCaseNumbers = await getSenderHistory(payload.fromEmail);
  const senderCaseHints = await getCaseHintsForSender(payload.fromEmail);
  const senderSortHints = await getSortHintsForSender(payload.fromEmail);

  const matchContext: MatchContext = {
    fromEmail: payload.fromEmail,
    toEmails: payload.toEmails,
    ccEmails: payload.ccEmails,
    subject: payload.subject,
    bodyExcerpt: payload.bodyExcerpt,
    attachmentFilename: attachment.filename,
    senderPriorCaseNumbers,
    caseMatchingHints: senderCaseHints,
    documentSortHints: senderSortHints,
    emailPatientNames: batch.patientNames,
    siblingAttachmentFilenames: payload.attachments.map((a) => a.filename),
    batchSharedCaseNumber: batch.sharedCaseNumber ?? undefined,
  };

  let documentExtraction: { method: string; excerptLength: number } | null = null;

  const isFilingDocument =
    /\.(pdf|docx?)$/i.test(attachment.filename) ||
    attachment.mimeType.includes('pdf') ||
    attachment.mimeType.includes('word') ||
    attachment.mimeType.includes('msword') ||
    attachment.mimeType.startsWith('image/');

  if (isFilingDocument) {
    const extracted = await extractDocumentExcerpt(
      buffer,
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

  const candidates = await findCaseCandidates(matchContext);
  const classification = await classifyDocument(matchContext, candidates);

  logger.info('Classification complete', {
    itemId,
    candidateCount: candidates.length,
    candidateCases: candidates.map((c) => c.case.slack_channel_name),
    client: classification.reason.slice(0, 120),
    confidence: classification.confidence,
    suggestedCase: classification.suggestedCaseNumber,
  });

  if (
    classification.suggestedCaseNumber &&
    classification.confidence >= 0.5 &&
    (!classification.needsAttention || classification.confidence >= 0.65) &&
    !clientIdentityIsUnknown({ subject: payload.subject, bodyExcerpt: payload.bodyExcerpt, aiClientIdentity: matchContext.aiClientIdentity })
  ) {
    batch.sharedCaseNumber = classification.suggestedCaseNumber;
    batch.sharedConfidence = classification.confidence;
  }

  const status = classification.needsAttention ? 'needs_attention' : 'pending_review';

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
    suggested_document_type:
      classification.documentType === 'needs_attention'
        ? null
        : classification.documentType,
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
    confidence: classification.confidence,
    reason: classification.reason,
    candidateCount: candidates.length,
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

/** Process documents with extractable text before generic email signature images. */
function attachmentSortRank(a: InboundAttachment): number {
  if (/\.(docx?|pdf)$/i.test(a.filename)) return 0;
  if (/\.(jpe?g|png|gif|webp|tiff?)$/i.test(a.filename)) return 2;
  return 1;
}

/** Resolve likely case from subject/body before any attachment is classified. */
async function preflightEmailBatchCase(
  payload: InboundEmailPayload,
  batch: EmailBatchState
): Promise<void> {
  const primaryFilename =
    payload.attachments.find((a) => /\.(docx?|pdf)$/i.test(a.filename))?.filename ??
    payload.attachments[0]?.filename ??
    '';

  const matchContext: MatchContext = {
    fromEmail: payload.fromEmail,
    toEmails: payload.toEmails,
    ccEmails: payload.ccEmails,
    subject: payload.subject,
    bodyExcerpt: payload.bodyExcerpt,
    attachmentFilename: primaryFilename,
    emailPatientNames: batch.patientNames,
    siblingAttachmentFilenames: payload.attachments.map((a) => a.filename),
  };

  matchContext.aiClientIdentity = await extractClientIdentity(matchContext);
  if (matchContext.aiClientIdentity.clientFullName) {
    batch.patientNames = [
      ...new Set([...batch.patientNames, matchContext.aiClientIdentity.clientFullName]),
    ];
    matchContext.emailPatientNames = batch.patientNames;
  }

  const candidates = await findCaseCandidates(matchContext);
  const top = candidates[0];
  if (
    top &&
    top.matchScore >= 40 &&
    !clientIdentityIsUnknown({ ...matchContext, aiClientIdentity: matchContext.aiClientIdentity })
  ) {
    batch.sharedCaseNumber = top.case.case_number;
    batch.sharedConfidence = 0.7;
    logger.info('Email preflight matched case for batch', {
      caseNumber: top.case.case_number,
      slackChannel: top.case.slack_channel_name,
      score: top.matchScore,
    });
  }
}

export { downloadTempAttachment };
