import { randomUUID } from 'crypto';
import {
  createFileSorterItem,
  downloadTempAttachment,
  getCaseById,
  updateFileSorterItem,
  uploadTempAttachment,
} from '../db/supabase.js';
import { findCaseCandidates } from './caseMatcher.js';
import { classifyDocument } from './aiClassifier.js';
import { slackService } from './slackService.js';
import { auditService } from './auditService.js';
import { parseInboundEmail } from './emailIngestion/index.js';
import type { InboundAttachment, InboundEmailPayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

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
  const payload = parseInboundEmail(headers, body);

  if (!payload.attachments.length) {
    logger.info('Skipping email with no attachments', {
      gmailMessageId: payload.gmailMessageId,
    });
    return { processed: 0, skipped: 1 };
  }

  let processed = 0;
  for (const attachment of payload.attachments) {
    await processSingleAttachment(payload, attachment);
    processed++;
  }
  return { processed, skipped: 0 };
}

async function processSingleAttachment(
  payload: InboundEmailPayload,
  attachment: InboundAttachment
): Promise<void> {
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
    logger.warn('Temp storage upload failed; continuing without URL', {
      err: String(err),
    });
  }

  const matchContext = {
    fromEmail: payload.fromEmail,
    toEmails: payload.toEmails,
    ccEmails: payload.ccEmails,
    subject: payload.subject,
    bodyExcerpt: payload.bodyExcerpt,
    attachmentFilename: attachment.filename,
  };

  const candidates = await findCaseCandidates(matchContext);
  const classification = await classifyDocument(matchContext, candidates);

  const status = classification.needsAttention ? 'needs_attention' : 'pending_review';

  const item = await createFileSorterItem({
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
    suggested_case_id: classification.suggestedCaseId,
    suggested_folder_path: classification.suggestedFolderPath,
    suggested_document_type:
      classification.documentType === 'needs_attention'
        ? null
        : classification.documentType,
    ai_confidence: classification.confidence,
    ai_reason: classification.reason,
    status,
    final_case_id: null,
    final_dropbox_path: null,
    dropbox_permalink: null,
    slack_queue_message_ts: null,
    slack_queue_channel_id: null,
    reviewed_by_slack_user_id: null,
    reviewed_at: null,
  });

  await auditService.log(item.id, 'email_received', {
    gmailMessageId: payload.gmailMessageId,
    from: payload.fromEmail,
    attachment: attachment.filename,
  });

  await auditService.log(item.id, 'classification_complete', {
    suggestedCaseId: classification.suggestedCaseId,
    confidence: classification.confidence,
    reason: classification.reason,
    candidateCount: candidates.length,
  });

  const caseRow = classification.suggestedCaseId
    ? await getCaseById(classification.suggestedCaseId)
    : null;

  const slackMsg = await slackService.postQueueItem(item, caseRow);
  const updated = await updateFileSorterItem(item.id, {
    slack_queue_channel_id: slackMsg.channel,
    slack_queue_message_ts: slackMsg.ts,
  });

  await auditService.log(item.id, 'slack_queued', {
    channel: slackMsg.channel,
    ts: slackMsg.ts,
  });

  await slackService.updateQueueMessage(updated, caseRow);
}

export { downloadTempAttachment };
