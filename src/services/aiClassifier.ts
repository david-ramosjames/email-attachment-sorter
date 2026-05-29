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
import type { CaseFolder } from '../types/index.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
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
    pi_client_full_name: {
      type: ['string', 'null'] as const,
      description:
        'The Ramos James Law PI client this document belongs to (not the email sender unless they are the client)',
    },
    email_summary: {
      type: 'string' as const,
      description: 'One sentence: who emailed whom, and what this is about',
    },
    suggested_case_number: {
      type: ['string', 'null'] as const,
      description: 'case_number from candidate list, or null if no case fits',
    },
    suggested_folder_label: {
      type: ['string', 'null'] as const,
      description: `RJL subfolder from candidate list: ${RJL_STANDARD_SUBFOLDERS.join(', ')}`,
    },
    document_type: {
      type: 'string' as const,
      enum: [...DOCUMENT_TYPES, 'needs_attention'],
    },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    reason: { type: 'string' as const },
  },
  required: [
    'pi_client_full_name',
    'email_summary',
    'suggested_case_number',
    'suggested_folder_label',
    'document_type',
    'confidence',
    'reason',
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

  const systemPrompt = `You are the filing assistant for Ramos James Law (RJL), a personal injury law firm.

Read the entire situation — who sent the email, who received it, the subject, body (including forwards), attachment filename, and attachment text — then decide how to file this document.

Your job:
1. Identify the PI CLIENT (injured party RJL represents) — usually NOT the person who sent the email.
   - Senders are often vendors: medical records companies, Adobe Sign, HR departments, opposing counsel, fax services.
   - In forwards, the client is usually in the original RJL request (e.g. Jorge @ramosjames.com asking for records on behalf of a named client).
2. Summarize what this email is about in one sentence.
3. Pick the best case_number from the candidate list ONLY if that case clearly belongs to this client (first AND last name should match slack_channel / dropbox_folder).
4. Pick folder and document_type from the document's actual purpose (medical records → Medical; employment authorization → Lost Wages; court filing → Pleadings; new engagement contract with no case yet → needs_attention with null case).
5. Calibrate confidence honestly — never use 0.9+ unless the client name clearly matches the chosen case channel.

Important:
- Words like "signed", "authorization", or "contract" in a filename do NOT by themselves mean anything — read the content.
- A signed employment authorization for an existing client is NOT a new retainer and NOT Pleadings.
- A new Adobe Sign retainer for a brand-new client with no matching case in the list → suggested_case_number null, document_type needs_attention, low confidence.
- Partial surname matches are wrong (Israel Mejia ≠ javiermejias / Javier Mejias).
- rule_match_score in older systems was unreliable — you decide from meaning.

Document types: ${DOCUMENT_TYPES.join(', ')}.
Return strict JSON only.`;

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
    pi_client_full_name: string | null;
    email_summary: string;
    suggested_case_number: string | null;
    suggested_folder_label: string | null;
    document_type: string;
    confidence: number;
    reason: string;
  };

  let suggestedCaseNumber = parsed.suggested_case_number;
  let documentType = parsed.document_type as DocumentType | 'needs_attention';
  let confidence = parsed.confidence;
  let reason = `${parsed.email_summary} ${parsed.reason}`;
  if (parsed.pi_client_full_name) {
    reason = `Client: ${parsed.pi_client_full_name}. ${reason}`;
  }

  if (suggestedCaseNumber && !candidateNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case number not in candidate list — rejected';
  }

  if (ctx.aiClientIdentity && suggestedCaseNumber) {
    const picked = candidates.find((c) => c.case.case_number === suggestedCaseNumber);
    if (
      picked &&
      (identityConflictsWithCase(picked.case, ctx.aiClientIdentity) ||
        !caseMatchesClientIdentity(picked.case, ctx.aiClientIdentity))
    ) {
      const better = candidates.find((c) =>
        caseMatchesClientIdentity(c.case, ctx.aiClientIdentity!)
      );
      if (better) {
        suggestedCaseNumber = better.case.case_number;
        reason += ` (matched case ${better.case.slack_channel_name})`;
      } else {
        suggestedCaseNumber = null;
        documentType = 'needs_attention';
        confidence = Math.min(confidence, 0.4);
        reason += ` (no case in list matches client ${ctx.aiClientIdentity.clientFullName})`;
      }
    }
  }

  if (ctx.batchSharedCaseNumber) {
    const batchCase = candidates.find(
      (c) => c.case.case_number === ctx.batchSharedCaseNumber
    );
    const identityBlocks =
      batchCase &&
      ctx.aiClientIdentity &&
      identityConflictsWithCase(batchCase.case, ctx.aiClientIdentity);
    if (batchCase && !identityBlocks) {
      const shouldUseBatch =
        !suggestedCaseNumber ||
        confidence < CONFIDENCE_THRESHOLD ||
        (ctx.aiClientIdentity &&
          caseMatchesClientIdentity(batchCase.case, ctx.aiClientIdentity));
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
      parsed.suggested_folder_label,
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
