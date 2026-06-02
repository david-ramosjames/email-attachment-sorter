import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  CONFIDENCE_THRESHOLD,
  MAX_DOCUMENT_TEXT_FOR_AI,
} from '../constants/classification.js';
import {
  DOCUMENT_TYPES,
  type CaseCandidate,
  type ClassificationResult,
  type DocumentType,
  type MatchContext,
} from '../types/index.js';
import { RJL_STANDARD_SUBFOLDERS } from '../constants/rjlFolders.js';
import { subfolderForDocumentType } from '../utils/folderInference.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { caseMatchingHintsPromptSection, documentSortHintsPromptSection } from '../utils/matchingHints.js';
import { getCaseById, getFoldersForCase } from '../db/supabase.js';
import { caseMatchesClientIdentity, identityConflictsWithCase } from '../utils/caseNameMatch.js';
import { clientIdentityIsUnknown, emailRequestsClientIdentification } from '../utils/emailClientSignals.js';
import { tokensFromPersonName } from '../utils/patientNameExtract.js';
import { buildClassifierSystemPrompt } from '../constants/classifierSystemPrompt.js';
import type { CaseFolder, ClientIdentity } from '../types/index.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

function effectiveClientIdentity(
  ctx: MatchContext,
  parsedClientName: string | null
): ClientIdentity | null {
  if (ctx.aiClientIdentity?.clientFullName?.trim()) {
    return ctx.aiClientIdentity;
  }
  if (!parsedClientName?.trim()) {
    return ctx.aiClientIdentity ?? null;
  }
  return {
    clientFullName: parsedClientName.trim(),
    nameTokens: tokensFromPersonName(parsedClientName),
    caseNumberHint: null,
    slackChannelHint: null,
    documentKind: null,
    isNewClientIntake: false,
    confidence: 0.7,
    reason: 'Classifier identified client name in document',
  };
}

function buildCandidatePrompt(candidates: CaseCandidate[]): string {
  return candidates
    .map((c, i) => {
      const folders = c.folders.map((f) => f.folder_label).join(', ') || 'none indexed';
      const dropboxFolder = c.case.dropbox_folder_name ?? '(not linked yet)';
      return `[${i + 1}] case_number="${c.case.case_number}" slack_channel="${c.case.slack_channel_name}" dropbox_folder="${dropboxFolder}" folders=[${folders}]`;
    })
    .join('\n');
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
      description: 'Exact case_number from candidate list, or null if no case fits',
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
 * OpenAI reads full email + attachment context and decides case, folder, and type.
 * No hard-coded shortcuts (e.g. "signed" or adobesign) — only prompt guidance and safety checks.
 */
export async function classifyDocument(
  ctx: MatchContext,
  candidates: CaseCandidate[]
): Promise<ClassificationResult> {
  if (ctx.aiClientIdentity) {
    candidates = candidates.filter(
      (c) => !identityConflictsWithCase(c.case, ctx.aiClientIdentity!)
    );
  }

  if (candidates.length === 0 && ctx.batchSharedCaseNumber) {
    const sharedCase = await getCaseById(ctx.batchSharedCaseNumber);
    if (sharedCase) {
      const folders = await getFoldersForCase(sharedCase.case_number);
      candidates = [
        {
          case: sharedCase,
          folders,
          matchScore: 200,
          matchReasons: ['Same email — prior attachment matched this case'],
        },
      ];
    }
  }

  if (candidates.length === 0) {
    return {
      suggestedCaseNumber: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      confidence: 0,
      reason:
        'No case candidates in index for this client name — create or link the case, then re-file',
      needsAttention: true,
    };
  }

  const candidateNumbers = new Set(candidates.map((c) => c.case.case_number));
  const bodyForAi = buildSmartBodyExcerpt(ctx.bodyExcerpt, 8000);

  const identityHint = ctx.aiClientIdentity?.clientFullName
    ? `\nPre-analysis hint (verify, do not trust blindly): client may be "${ctx.aiClientIdentity.clientFullName}" — ${ctx.aiClientIdentity.reason}`
    : '';

  const systemPrompt = buildClassifierSystemPrompt();

  const documentSection = ctx.documentExcerpt
    ? `\n\nAttachment text:\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '\n\n(No attachment text extracted)';

  const senderSection = ctx.senderPriorCaseNumbers?.length
    ? `\nSender has previously filed to case(s): ${ctx.senderPriorCaseNumbers.join(', ')} (weak hint only)`
    : '';

  const siblingSection = ctx.siblingAttachmentFilenames?.length
    ? `\nAll attachments in this email (usually same case): ${ctx.siblingAttachmentFilenames.join(', ')}`
    : '';

  const batchSection = ctx.batchSharedCaseNumber
    ? `\nEarlier attachment in this email was filed to case_number="${ctx.batchSharedCaseNumber}" — use same case unless this document is clearly for a different client.`
    : '';

  const userPrompt = `From (sender): ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ') || '(not provided)'}
Cc: ${ctx.ccEmails.join(', ') || '(none)'}
Subject: ${ctx.subject}

Email body:
${bodyForAi}

Attachment filename: ${ctx.attachmentFilename}${identityHint}${caseMatchingHintsPromptSection(ctx.caseMatchingHints)}${documentSortHintsPromptSection(ctx.documentSortHints)}${siblingSection}${batchSection}${senderSection}${documentSection}

Candidate cases (choose ONLY from this list, exact case_number):
${buildCandidatePrompt(candidates)}`;

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
  let caseClearedForIdentity = false;

  const clientIdentity = effectiveClientIdentity(ctx, parsed.client_name);

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

  if (suggestedCaseNumber && !candidateNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case number not in candidate list — rejected';
  }

  if (!clientUnknown && clientIdentity && suggestedCaseNumber) {
    const picked = candidates.find((c) => c.case.case_number === suggestedCaseNumber);
    if (
      picked &&
      (identityConflictsWithCase(picked.case, clientIdentity) ||
        !caseMatchesClientIdentity(picked.case, clientIdentity))
    ) {
      const better = candidates.find((c) => caseMatchesClientIdentity(c.case, clientIdentity));
      if (better) {
        suggestedCaseNumber = better.case.case_number;
        reason += ` (matched case ${better.case.slack_channel_name})`;
      } else {
        suggestedCaseNumber = null;
        documentType = 'needs_attention';
        confidence = Math.min(confidence, 0.4);
        caseClearedForIdentity = true;
        reason += ` (no case in list matches client ${clientIdentity.clientFullName ?? 'unknown'})`;
      }
    }
  }

  if (ctx.batchSharedCaseNumber && !caseClearedForIdentity && !clientUnknown) {
    const batchCase = candidates.find(
      (c) => c.case.case_number === ctx.batchSharedCaseNumber
    );
    const identityBlocks =
      batchCase &&
      clientIdentity &&
      identityConflictsWithCase(batchCase.case, clientIdentity);
    const clientKnown = Boolean(clientIdentity?.clientFullName?.trim());
    if (batchCase && !identityBlocks && clientKnown) {
      const identityMatchesBatch =
        clientIdentity && caseMatchesClientIdentity(batchCase.case, clientIdentity);
      const shouldUseBatch =
        suggestedCaseNumber === ctx.batchSharedCaseNumber ||
        (identityMatchesBatch &&
          (!suggestedCaseNumber || confidence < CONFIDENCE_THRESHOLD));
      if (shouldUseBatch && suggestedCaseNumber !== ctx.batchSharedCaseNumber) {
        suggestedCaseNumber = ctx.batchSharedCaseNumber;
        confidence = Math.max(confidence, 0.72);
        reason += ` (same email batch → ${ctx.batchSharedCaseNumber})`;
      }
    }
  }

  let suggestedFolderPath: string | null = null;
  if (suggestedCaseNumber && documentType !== 'needs_attention') {
    const resolved = resolveFolderForCase(
      suggestedCaseNumber,
      candidates,
      parsed.folder,
      documentType
    );
    suggestedFolderPath = resolved.path;
    if (resolved.reasonSuffix) reason += resolved.reasonSuffix;
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
  caseNumber: string,
  candidates: CaseCandidate[],
  aiFolderLabel: string | null,
  documentType: string
): { path: string | null; reasonSuffix: string } {
  const match = candidates.find((c) => c.case.case_number === caseNumber);
  if (!match?.folders.length) {
    return { path: null, reasonSuffix: ' (no indexed folders for case)' };
  }

  const fromAi = findFolderByLabel(match.folders, aiFolderLabel);
  if (fromAi) {
    return { path: fromAi.dropbox_path, reasonSuffix: '' };
  }

  const subfolder = subfolderForDocumentType(documentType);
  if (subfolder) {
    const folder = findFolderByLabel(match.folders, subfolder);
    if (folder) {
      return {
        path: folder.dropbox_path,
        reasonSuffix: ` (mapped ${documentType} → ${subfolder})`,
      };
    }
    const root = match.case.dropbox_root_path.replace(/\/+$/, '');
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
