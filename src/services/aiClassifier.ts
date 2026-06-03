import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  CASE_ASSIGNMENT_THRESHOLD,
  CASE_REVIEW_THRESHOLD,
  computeOverallConfidence,
  MAX_DOCUMENT_TEXT_FOR_AI,
} from '../constants/classification.js';
import {
  DOCUMENT_TYPES,
  type ClassificationResult,
  type DocumentType,
  type MatchContext,
} from '../types/index.js';
import { RJL_STANDARD_SUBFOLDERS, dropboxPathForCaseSubfolder, normalizeFolderLabel } from '../constants/rjlFolders.js';
import { subfolderForDocumentType } from '../utils/folderInference.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { caseMatchingHintsPromptSection, documentSortHintsPromptSection } from '../utils/matchingHints.js';
import { getCaseById } from '../db/supabase.js';
import { clientIdentityIsUnknown, emailRequestsClientIdentification } from '../utils/emailClientSignals.js';
import { buildCaseIdentificationPrompt } from '../constants/caseIdentificationPrompt.js';
import { buildFolderClassificationPrompt, folderPromptCaseStageLine } from '../constants/folderClassificationPrompt.js';
import { clientNameExactlyMatchesCase } from '../utils/caseNameMatch.js';
import { isNewClientIntakeContext, INTAKE_NO_CASE_MARKER } from '../utils/intakeDocumentSignals.js';
import { extractForwardedEmailContext } from '../utils/forwardedEmailContext.js';
import { foldersForCaseNumber, loadCaseCatalogForAi } from './caseCatalogForAi.js';
import type { CaseCatalogForAi } from './caseCatalogForAi.js';
import type { CaseFolder } from '../types/index.js';
import { logger } from '../utils/logger.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

const caseIdentificationSchema = {
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
    case_confidence: {
      type: 'number' as const,
      minimum: 0,
      maximum: 1,
      description: 'Confidence that suggested_case_number is the correct case (0–1)',
    },
    names_compared: {
      type: 'string' as const,
      description:
        'Which index clients were compared; near-miss names rejected and why, or "none"',
    },
    reasoning: {
      type: 'string' as const,
      description: 'Case matching logic only — not folder or document type',
    },
    evidence: {
      type: 'string' as const,
      description: 'Specific facts from email/attachment supporting the case decision',
    },
  },
  required: [
    'summary',
    'client_name',
    'suggested_case_number',
    'case_confidence',
    'names_compared',
    'reasoning',
    'evidence',
  ],
  additionalProperties: false,
};

const folderClassificationSchema = {
  type: 'object' as const,
  properties: {
    folder: {
      type: ['string', 'null'] as const,
      description: `RJL subfolder — core: ${RJL_STANDARD_SUBFOLDERS.slice(0, 6).join(', ')}… or rare custom name`,
    },
    document_type: {
      type: 'string' as const,
      enum: [...DOCUMENT_TYPES, 'needs_attention'],
    },
    folder_confidence: {
      type: 'number' as const,
      minimum: 0,
      maximum: 1,
      description: 'Confidence in folder and document_type (case already decided)',
    },
    reasoning: {
      type: 'string' as const,
      description: 'Why this folder and document type',
    },
    evidence: {
      type: 'string' as const,
      description: 'Facts from the document/email supporting folder choice',
    },
  },
  required: ['folder', 'document_type', 'folder_confidence', 'reasoning', 'evidence'],
  additionalProperties: false,
};

interface CaseIdentificationResult {
  summary: string;
  client_name: string | null;
  suggested_case_number: string | null;
  case_confidence: number;
  names_compared: string;
  reasoning: string;
  evidence: string;
}

interface FolderClassificationResult {
  folder: string | null;
  document_type: string;
  folder_confidence: number;
  reasoning: string;
  evidence: string;
}

function buildSharedUserPrompt(ctx: MatchContext, catalog: CaseCatalogForAi): string {
  const bodyForAi = buildSmartBodyExcerpt(ctx.bodyExcerpt, 8000);

  const identityHint = ctx.aiClientIdentity?.clientFullName
    ? `\nOptional hint (verify against attachment text): client may be "${ctx.aiClientIdentity.clientFullName}" — ${ctx.aiClientIdentity.reason}`
    : '';

  const documentSection = ctx.documentExcerpt
    ? `\n\nAttachment text (PRIMARY evidence for case matching — read carefully):\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '\n\n(No attachment text extracted — case matching is harder; prefer null over guessing)';

  const senderSection = ctx.senderPriorCaseNumbers?.length
    ? `\nSender has previously filed to case(s): ${ctx.senderPriorCaseNumbers.join(', ')} (weak hint only — never override attachment name evidence)`
    : '';

  const siblingSection = ctx.siblingAttachmentFilenames?.length
    ? `\nAll attachments in this email (usually same case): ${ctx.siblingAttachmentFilenames.join(', ')}`
    : '';

  const batchSection = ctx.batchSharedCaseNumber
    ? `\nEarlier attachment in this email matched case_number="${ctx.batchSharedCaseNumber}" — use same case only if this document is for the same PI client.`
    : '';

  const forwardedText =
    ctx.forwardedEmailContext?.trim() || extractForwardedEmailContext(ctx.bodyExcerpt);
  const forwardedBlock = forwardedText
    ? `\nForwarded / original request context:\n${forwardedText}`
    : '';

  const externalLinkSection = ctx.externalFileUrl
    ? `\nExternal file link (not attached — staff must download manually): ${ctx.externalFileUrl}`
    : '';

  return `From (sender): ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ') || '(not provided)'}
Cc: ${ctx.ccEmails.join(', ') || '(none)'}
Subject: ${ctx.subject}

Email body:
${bodyForAi}

Attachment filename: ${ctx.attachmentFilename}${identityHint}${caseMatchingHintsPromptSection(ctx.caseMatchingHints)}${documentSortHintsPromptSection(ctx.documentSortHints)}${siblingSection}${batchSection}${forwardedBlock}${externalLinkSection}${senderSection}${documentSection}

Case index (${catalog.caseNumbers.size} cases — suggested_case_number MUST be an exact case_number from this list, or null):
${catalog.catalogPrompt}`;
}

async function identifyCase(
  ctx: MatchContext,
  catalog: CaseCatalogForAi
): Promise<CaseIdentificationResult> {
  const response = await getOpenAI().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'case_identification',
        strict: true,
        schema: caseIdentificationSchema,
      },
    },
    messages: [
      { role: 'system', content: buildCaseIdentificationPrompt() },
      { role: 'user', content: buildSharedUserPrompt(ctx, catalog) },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty AI case identification response');
  }

  return JSON.parse(content) as CaseIdentificationResult;
}

async function classifyFolder(
  ctx: MatchContext,
  catalog: CaseCatalogForAi,
  caseResult: CaseIdentificationResult,
  suggestedCaseNumber: string | null
): Promise<FolderClassificationResult> {
  const caseRow = suggestedCaseNumber ? await getCaseById(suggestedCaseNumber) : null;
  const stageLine = folderPromptCaseStageLine(caseRow?.topic_stage ?? null);

  const caseContext = suggestedCaseNumber
    ? `Assigned case (DO NOT CHANGE): case_number="${suggestedCaseNumber}", client="${caseResult.client_name ?? 'unknown'}", case_confidence=${caseResult.case_confidence}\n${stageLine}`
    : 'Assigned case: none (suggested_case_number is null — folder may be Intake or null)';

  const response = await getOpenAI().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0.1,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'folder_classification',
        strict: true,
        schema: folderClassificationSchema,
      },
    },
    messages: [
      { role: 'system', content: buildFolderClassificationPrompt() },
      {
        role: 'user',
        content: `${caseContext}\n\n${buildSharedUserPrompt(ctx, catalog)}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty AI folder classification response');
  }

  return JSON.parse(content) as FolderClassificationResult;
}

/**
 * Two-pass classification: dedicated case identification, then folder/type.
 * Case correctness is prioritized — review flags and overall score weight case heavily.
 */
export async function classifyDocument(ctx: MatchContext): Promise<ClassificationResult> {
  const catalog = await loadCaseCatalogForAi();

  if (!catalog.caseNumbers.size) {
    return {
      suggestedCaseNumber: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      caseConfidence: 0,
      folderConfidence: 0,
      confidence: 0,
      suggestedFolderLabel: null,
      intakeNoCase: false,
      reason: 'Case index is empty — sync cases from Slack, then re-file',
      needsAttention: true,
    };
  }

  logger.info('AI case identification request', {
    attachmentFilename: ctx.attachmentFilename,
    caseIndexSize: catalog.caseNumbers.size,
    documentExcerptChars: ctx.documentExcerpt?.length ?? 0,
  });

  const caseParsed = await identifyCase(ctx, catalog);

  let suggestedCaseNumber = caseParsed.suggested_case_number;
  let caseConfidence = caseParsed.case_confidence;
  let reason = formatCaseReason(caseParsed);

  if (caseConfidence < CASE_ASSIGNMENT_THRESHOLD && suggestedCaseNumber) {
    suggestedCaseNumber = null;
    caseConfidence = Math.min(caseConfidence, CASE_ASSIGNMENT_THRESHOLD - 0.01);
    reason += ` (case confidence below ${CASE_ASSIGNMENT_THRESHOLD} — case not assigned)`;
  }

  const clientUnknown = clientIdentityIsUnknown(ctx);
  if (clientUnknown) {
    suggestedCaseNumber = null;
    caseConfidence = Math.min(caseConfidence, 0.35);
    reason = emailRequestsClientIdentification(
      [ctx.subject, ctx.bodyExcerpt].filter(Boolean).join('\n')
    )
      ? `Sender is asking RJL to identify the client — case cannot be assigned yet. ${reason}`
      : `No PI client named in this email (open records / property investigation). ${reason}`;
  } else if (caseParsed.client_name) {
    reason = `Client: ${caseParsed.client_name}. ${reason}`;
  }

  if (suggestedCaseNumber && !catalog.caseNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    caseConfidence = 0;
    reason = 'AI returned case number not in case index — rejected';
  }

  if (isNewClientIntakeContext(ctx)) {
    if (suggestedCaseNumber) {
      suggestedCaseNumber = null;
      reason +=
        ' (intake/retainer document — case not auto-assigned; open a case channel/folder first or use thread Case: before Approve)';
    }
    caseConfidence = Math.min(caseConfidence, 0.35);
  } else if (suggestedCaseNumber && caseParsed.client_name) {
    const caseRow = await getCaseById(suggestedCaseNumber);
    if (caseRow && !clientNameExactlyMatchesCase(caseRow, caseParsed.client_name)) {
      suggestedCaseNumber = null;
      caseConfidence = Math.min(caseConfidence, 0.35);
      reason += ` (exact name match required — "${caseParsed.client_name}" does not match ${caseRow.slack_channel_name})`;
    }
  } else if (suggestedCaseNumber && !caseParsed.client_name) {
    suggestedCaseNumber = null;
    caseConfidence = Math.min(caseConfidence, 0.35);
    reason += ' (case not assigned without a identified PI client name)';
  }

  logger.info('AI folder classification request', {
    attachmentFilename: ctx.attachmentFilename,
    suggestedCase: suggestedCaseNumber,
    caseConfidence,
  });

  const folderParsed = await classifyFolder(ctx, catalog, {
    ...caseParsed,
    suggested_case_number: suggestedCaseNumber,
    case_confidence: caseConfidence,
  }, suggestedCaseNumber);

  let documentType = folderParsed.document_type as DocumentType | 'needs_attention';
  let folderConfidence = folderParsed.folder_confidence;
  reason += ` Folder: ${folderParsed.reasoning.trim()}`;
  if (folderParsed.evidence?.trim()) {
    reason += ` Folder evidence: ${folderParsed.evidence.trim()}`;
  }

  if (!suggestedCaseNumber) {
    folderConfidence = Math.min(folderConfidence, caseConfidence);
  }

  let suggestedFolderPath: string | null = null;
  if (suggestedCaseNumber && documentType !== 'needs_attention') {
    const caseRow = await getCaseById(suggestedCaseNumber);
    const folders = await foldersForCaseNumber(suggestedCaseNumber);
    const resolved = resolveFolderForCase(caseRow, folders, folderParsed.folder, documentType);
    suggestedFolderPath = resolved.path;
    if (resolved.reasonSuffix) reason += resolved.reasonSuffix;
  }

  const intakeNoCase = isNewClientIntakeContext(ctx) && !suggestedCaseNumber;

  const overallConfidence = computeOverallConfidence(
    caseConfidence,
    folderConfidence,
    Boolean(suggestedCaseNumber)
  );

  const needsAttention =
    !suggestedCaseNumber ||
    caseConfidence < CASE_REVIEW_THRESHOLD ||
    documentType === 'needs_attention';

  let suggestedFolderLabel =
    folderParsed.folder?.trim() ? normalizeFolderLabel(folderParsed.folder) : intakeNoCase ? 'Intake' : null;

  let filingDocumentType: DocumentType | 'needs_attention' = needsAttention
    ? 'needs_attention'
    : (documentType as DocumentType);

  if (intakeNoCase) {
    filingDocumentType = 'Intake';
    if (!suggestedFolderLabel) suggestedFolderLabel = 'Intake';
    reason = `${INTAKE_NO_CASE_MARKER} ${reason}`;
  }

  return {
    suggestedCaseNumber,
    suggestedFolderPath,
    suggestedFolderLabel,
    documentType: filingDocumentType,
    caseConfidence,
    folderConfidence,
    confidence: overallConfidence,
    reason,
    needsAttention,
    intakeNoCase,
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

  const fromAi = findFolderByLabel(folders, aiFolderLabel);
  if (fromAi) {
    return { path: fromAi.dropbox_path, reasonSuffix: '' };
  }

  if (aiFolderLabel?.trim()) {
    const label = normalizeFolderLabel(aiFolderLabel);
    return {
      path: dropboxPathForCaseSubfolder(caseRow.dropbox_root_path, label),
      reasonSuffix: '',
    };
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
    return {
      path: dropboxPathForCaseSubfolder(caseRow.dropbox_root_path, subfolder),
      reasonSuffix: ` (mapped ${documentType} → ${subfolder})`,
    };
  }

  return { path: null, reasonSuffix: '' };
}

function formatCaseReason(parsed: CaseIdentificationResult): string {
  const parts = [parsed.summary.trim(), parsed.reasoning.trim()];
  if (parsed.names_compared?.trim() && parsed.names_compared.toLowerCase() !== 'none') {
    parts.push(`Compared: ${parsed.names_compared.trim()}`);
  }
  if (parsed.evidence?.trim()) {
    parts.push(`Evidence: ${parsed.evidence.trim()}`);
  }
  return parts.filter(Boolean).join(' ');
}
