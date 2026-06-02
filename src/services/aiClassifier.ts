import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  CONFIDENCE_THRESHOLD,
  MAX_DOCUMENT_TEXT_FOR_AI,
} from '../constants/classification.js';
import {
  DOCUMENT_TYPES,
  type ClassificationResult,
  type DocumentType,
  type MatchContext,
} from '../types/index.js';
import { RJL_STANDARD_SUBFOLDERS } from '../constants/rjlFolders.js';
import { subfolderForDocumentType } from '../utils/folderInference.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { caseMatchingHintsPromptSection, documentSortHintsPromptSection } from '../utils/matchingHints.js';
import { getCaseById } from '../db/supabase.js';
import { clientIdentityIsUnknown, emailRequestsClientIdentification } from '../utils/emailClientSignals.js';
import { buildClassifierSystemPrompt } from '../constants/classifierSystemPrompt.js';
import { extractForwardedEmailContext } from '../utils/forwardedEmailContext.js';
import { foldersForCaseNumber, loadCaseCatalogForAi } from './caseCatalogForAi.js';
import type { CaseFolder } from '../types/index.js';
import { logger } from '../utils/logger.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

const classificationSchema = {
  type: 'object' as const,
  properties: {
    summary: {
      type: 'string' as const,
      description: 'One sentence: who emailed whom and what this is about',
    },
    client_name: {
      type: ['string', 'null'] as const,
      description: 'PI client full name (injured party RJL represents), or null if unknown',
    },
    suggested_case_number: {
      type: ['string', 'null'] as const,
      description: 'Exact case_number from the case index, or null if no case fits',
    },
    folder: {
      type: ['string', 'null'] as const,
      description: `RJL Dropbox subfolder: ${RJL_STANDARD_SUBFOLDERS.join(', ')}`,
    },
    document_type: {
      type: 'string' as const,
      enum: [...DOCUMENT_TYPES, 'needs_attention'],
    },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    reasoning: {
      type: 'string' as const,
      description: 'Why this case, folder, and document type were chosen',
    },
    evidence: {
      type: 'string' as const,
      description: 'Specific facts from email/attachment supporting the decision; do not invent',
    },
  },
  required: [
    'summary',
    'client_name',
    'suggested_case_number',
    'folder',
    'document_type',
    'confidence',
    'reasoning',
    'evidence',
  ],
  additionalProperties: false,
};

/**
 * OpenAI reads email + attachment text and the full case index to decide case, folder, and type.
 * Rule-based pre-filtering is intentionally avoided — the model matches client names in the
 * document to slack_channel / dropbox_folder labels in the index.
 */
export async function classifyDocument(ctx: MatchContext): Promise<ClassificationResult> {
  const catalog = await loadCaseCatalogForAi();

  if (!catalog.caseNumbers.size) {
    return {
      suggestedCaseNumber: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      confidence: 0,
      reason: 'Case index is empty — sync cases from Slack, then re-file',
      needsAttention: true,
    };
  }

  const bodyForAi = buildSmartBodyExcerpt(ctx.bodyExcerpt, 8000);

  const identityHint = ctx.aiClientIdentity?.clientFullName
    ? `\nOptional hint (verify against attachment text): client may be "${ctx.aiClientIdentity.clientFullName}" — ${ctx.aiClientIdentity.reason}`
    : '';

  const systemPrompt = buildClassifierSystemPrompt();

  const documentSection = ctx.documentExcerpt
    ? `\n\nAttachment text (primary evidence — match PI client name here to case index):\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '\n\n(No attachment text extracted — use email body and filename)';

  const senderSection = ctx.senderPriorCaseNumbers?.length
    ? `\nSender has previously filed to case(s): ${ctx.senderPriorCaseNumbers.join(', ')} (weak hint only)`
    : '';

  const siblingSection = ctx.siblingAttachmentFilenames?.length
    ? `\nAll attachments in this email (usually same case): ${ctx.siblingAttachmentFilenames.join(', ')}`
    : '';

  const batchSection = ctx.batchSharedCaseNumber
    ? `\nEarlier attachment in this email was filed to case_number="${ctx.batchSharedCaseNumber}" — use same case unless this document is clearly for a different client.`
    : '';

  const forwardedText =
    ctx.forwardedEmailContext?.trim() || extractForwardedEmailContext(ctx.bodyExcerpt);
  const forwardedBlock = forwardedText
    ? `\nForwarded / original request context:\n${forwardedText}`
    : '';

  const externalLinkSection = ctx.externalFileUrl
    ? `\nExternal file link (not attached — staff must download manually): ${ctx.externalFileUrl}`
    : '';

  const userPrompt = `From (sender): ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ') || '(not provided)'}
Cc: ${ctx.ccEmails.join(', ') || '(none)'}
Subject: ${ctx.subject}

Email body:
${bodyForAi}

Attachment filename: ${ctx.attachmentFilename}${identityHint}${caseMatchingHintsPromptSection(ctx.caseMatchingHints)}${documentSortHintsPromptSection(ctx.documentSortHints)}${siblingSection}${batchSection}${forwardedBlock}${externalLinkSection}${senderSection}${documentSection}

Case index (${catalog.caseNumbers.size} cases — choose ONLY suggested_case_number from this list):
${catalog.catalogPrompt}`;

  logger.info('AI classification request', {
    attachmentFilename: ctx.attachmentFilename,
    caseIndexSize: catalog.caseNumbers.size,
    documentExcerptChars: ctx.documentExcerpt?.length ?? 0,
  });

  const response = await getOpenAI().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0.1,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'document_classification',
        strict: true,
        schema: classificationSchema,
      },
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty AI classification response');
  }

  const parsed = JSON.parse(content) as {
    summary: string;
    client_name: string | null;
    suggested_case_number: string | null;
    folder: string | null;
    document_type: string;
    confidence: number;
    reasoning: string;
    evidence: string;
  };

  let suggestedCaseNumber = parsed.suggested_case_number;
  let documentType = parsed.document_type as DocumentType | 'needs_attention';
  let confidence = parsed.confidence;
  let reason = formatClassificationReason(parsed);

  if (confidence < 0.6 && suggestedCaseNumber) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = Math.min(confidence, 0.59);
    reason += ' (confidence below 0.60 — case not assigned per filing rules)';
  }

  const clientUnknown = clientIdentityIsUnknown(ctx);
  if (clientUnknown) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = Math.min(confidence, 0.35);
    reason = emailRequestsClientIdentification(
      [ctx.subject, ctx.bodyExcerpt].filter(Boolean).join('\n')
    )
      ? `Sender is asking RJL to identify the client — case cannot be assigned yet. ${reason}`
      : `No PI client named in this email (open records / property investigation). ${reason}`;
  } else if (parsed.client_name) {
    reason = `Client: ${parsed.client_name}. ${reason}`;
  }

  if (suggestedCaseNumber && !catalog.caseNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case number not in case index — rejected';
  }

  let suggestedFolderPath: string | null = null;
  if (suggestedCaseNumber && documentType !== 'needs_attention') {
    const caseRow = await getCaseById(suggestedCaseNumber);
    const folders = await foldersForCaseNumber(suggestedCaseNumber);
    const resolved = resolveFolderForCase(caseRow, folders, parsed.folder, documentType);
    suggestedFolderPath = resolved.path;
    if (resolved.reasonSuffix) reason += resolved.reasonSuffix;
  } else if (parsed.folder?.trim()) {
    suggestedFolderPath = parsed.folder.trim();
  }

  const needsAttention =
    documentType === 'needs_attention' ||
    !suggestedCaseNumber ||
    confidence < CONFIDENCE_THRESHOLD;

  return {
    suggestedCaseNumber,
    suggestedFolderPath,
    documentType: needsAttention ? 'needs_attention' : (documentType as DocumentType),
    confidence,
    reason,
    needsAttention,
  };
}

function findFolderByLabel(
  folders: CaseFolder[],
  label: string | null | undefined
): CaseFolder | undefined {
  if (!label?.trim()) return undefined;
  const norm = label.trim().toLowerCase();
  return folders.find((f) => f.folder_label.toLowerCase() === norm);
}

function resolveFolderForCase(
  caseRow: Awaited<ReturnType<typeof getCaseById>>,
  folders: CaseFolder[],
  aiFolderLabel: string | null,
  documentType: string
): { path: string | null; reasonSuffix: string } {
  if (!caseRow) {
    return { path: null, reasonSuffix: ' (case not found for folder resolution)' };
  }

  if (!folders.length) {
    return { path: null, reasonSuffix: ' (no indexed folders for case)' };
  }

  const fromAi = findFolderByLabel(folders, aiFolderLabel);
  if (fromAi) {
    return { path: fromAi.dropbox_path, reasonSuffix: '' };
  }

  const subfolder = subfolderForDocumentType(documentType);
  if (subfolder) {
    const folder = findFolderByLabel(folders, subfolder);
    if (folder) {
      return {
        path: folder.dropbox_path,
        reasonSuffix: ` (mapped ${documentType} → ${subfolder})`,
      };
    }
    const root = caseRow.dropbox_root_path.replace(/\/+$/, '');
    return {
      path: `${root}/${subfolder}`.replace(/\/+/g, '/'),
      reasonSuffix: ` (constructed ${subfolder} under case root)`,
    };
  }

  return { path: null, reasonSuffix: '' };
}

function formatClassificationReason(parsed: {
  summary: string;
  reasoning: string;
  evidence: string;
}): string {
  const parts = [parsed.summary.trim(), parsed.reasoning.trim()];
  if (parsed.evidence?.trim()) {
    parts.push(`Evidence: ${parsed.evidence.trim()}`);
  }
  return parts.filter(Boolean).join(' ');
}
