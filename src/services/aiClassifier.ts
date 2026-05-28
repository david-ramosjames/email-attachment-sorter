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
import {
  inferDocumentTypeFromContent,
  inferFolderLabelFromContent,
  subfolderForDocumentType,
} from '../utils/folderInference.js';
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
      return `[${i + 1}] case_number="${c.case.case_number}" slack_channel="${c.case.slack_channel_name}" dropbox_folder="${dropboxFolder}" folders=[${folders}] rule_match_score=${c.matchScore} rule_signals="${c.matchReasons.join('; ') || 'widened pool — verify against document'}"`;
    })
    .join('\n');
}

const classificationSchema = {
  type: 'object' as const,
  properties: {
    suggested_case_number: {
      type: ['string', 'null'] as const,
      description: 'case_number from candidate list, or null if needs_attention',
    },
    suggested_folder_label: {
      type: ['string', 'null'] as const,
      description:
        'RJL subfolder label from candidate folders list (e.g. Medical, Pleadings), or null to infer from document_type',
    },
    document_type: {
      type: 'string' as const,
      enum: [...DOCUMENT_TYPES, 'needs_attention'],
    },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    reason: { type: 'string' as const },
  },
  required: [
    'suggested_case_number',
    'suggested_folder_label',
    'document_type',
    'confidence',
    'reason',
  ],
  additionalProperties: false,
};

export async function classifyDocument(
  ctx: MatchContext,
  candidates: CaseCandidate[],
  options?: { usedDocumentContent?: boolean }
): Promise<ClassificationResult> {
  if (candidates.length === 0) {
    const hint = ctx.documentExcerpt
      ? 'No case candidates matched — check case_slack_channels for names/numbers in the document'
      : 'No matching cases found — attachment text may not have been extracted';
    return {
      suggestedCaseNumber: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      confidence: 0,
      reason: hint,
      needsAttention: true,
    };
  }

  const candidateNumbers = new Set(candidates.map((c) => c.case.case_number));

  const systemPrompt = `You are a legal document filing assistant for Ramos James Law.

Your job: pick the best matching case and document type from the candidate list, using ALL context (email + attachment text + Dropbox folder names).

Rules:
- Choose ONLY from the candidate list using the exact case_number string.
- rule_match_score and rule_signals are automated hints — they can be WRONG (e.g. phone area codes mistaken for case numbers). Always verify against document content.
- NEVER match a case based only on a short number inside a phone number, fax header, date, or page number.
- Fax/scan emails (HelloFax, "Incoming fax", filenames with 10+ digit ids) usually need client/name matching from the document body, not fax metadata.
- The attachment FILENAME often contains the client name (e.g. "Galeas Montoya Lourdes 89195.pdf") — treat filename tokens as primary evidence, stronger than vendor senders like settlement@ or adobesign@.
- Prefer client name tokens, Dropbox folder names (e.g. "1321. CLIENT NAME"), and labeled "Case/Cause/File No." over bare 3-digit numbers.
- Do NOT match a case when the filename names a different client than the candidate's slack_channel / dropbox_folder.
- If no candidate fits well, set suggested_case_number to null, document_type to "needs_attention", and confidence below 0.5.
- Pick suggested_folder_label from the candidate's indexed folder labels only (standard RJL labels: ${RJL_STANDARD_SUBFOLDERS.join(', ')}).
- Folder must match document content — do NOT default to Correspondence.
- Medical provider records/affidavits (e.g. RecordsAffidavit, BillingsAffidavit, records@…injury.com, procare) → document_type "Medical Records", folder_label "Medical".
- Attorney pleadings/motions/complaints → "Pleadings". Generic letters → "Correspondence".
- If unsure of folder, set suggested_folder_label to null (system maps from document_type).
- Calibrate confidence honestly: 0.9+ only when name/case evidence is clear; 0.5–0.75 when plausible but ambiguous.

Document types: ${DOCUMENT_TYPES.join(', ')}.
Return strict JSON only.`;

  const documentSection = ctx.documentExcerpt
    ? `\n\nAttachment text (primary evidence for fax/scanned docs):\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '';

  const senderSection =
    ctx.senderPriorCaseNumbers?.length
      ? `\nSender previously filed to case(s): ${ctx.senderPriorCaseNumbers.join(', ')}`
      : '';

  const userPrompt = `Email metadata:
From: ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ')}
Subject: ${ctx.subject}
Body excerpt: ${ctx.bodyExcerpt.slice(0, 2000)}
Attachment filename (PRIMARY for client identity): ${ctx.attachmentFilename}
Filename name tokens to match: ${ctx.attachmentFilename.replace(/\.[a-z0-9]+$/i, '').split(/[^a-zA-Z]+/).filter((t) => t.length >= 4).join(', ') || '(none)'}${senderSection}${documentSection}

Candidate cases (${candidates.length} — choose ONLY from this list):
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
    suggested_case_number: string | null;
    suggested_folder_label: string | null;
    document_type: string;
    confidence: number;
    reason: string;
  };

  let suggestedCaseNumber = parsed.suggested_case_number;
  let documentType = parsed.document_type as DocumentType | 'needs_attention';
  let confidence = parsed.confidence;
  let reason = parsed.reason;

  const contentParts = {
    attachmentFilename: ctx.attachmentFilename,
    subject: ctx.subject,
    bodyExcerpt: ctx.bodyExcerpt,
    documentExcerpt: ctx.documentExcerpt,
  };

  const inferredType = inferDocumentTypeFromContent(contentParts);
  if (
    inferredType &&
    documentType !== 'needs_attention' &&
    (documentType === 'Bills' || documentType === 'Misc' || documentType === 'Correspondence')
  ) {
    documentType = inferredType;
    reason += ` (document type adjusted to ${inferredType} from filename/content)`;
  }

  if (suggestedCaseNumber && !candidateNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case number not in candidate list — rejected';
  }

  let suggestedFolderPath: string | null = null;
  if (suggestedCaseNumber && documentType !== 'needs_attention') {
    const resolved = resolveFolderForCase(
      suggestedCaseNumber,
      candidates,
      parsed.suggested_folder_label,
      documentType,
      contentParts
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

/** Resolve Dropbox path: content rules → AI label → document_type map (never folders[0]). */
function resolveFolderForCase(
  caseNumber: string,
  candidates: CaseCandidate[],
  aiFolderLabel: string | null,
  documentType: string,
  contentParts: {
    attachmentFilename: string;
    subject: string;
    bodyExcerpt: string;
    documentExcerpt?: string;
  }
): { path: string | null; reasonSuffix: string } {
  const match = candidates.find((c) => c.case.case_number === caseNumber);
  if (!match?.folders.length) {
    return { path: null, reasonSuffix: ' (no indexed folders for case)' };
  }

  const fromContent = inferFolderLabelFromContent(contentParts);
  if (fromContent) {
    const folder = findFolderByLabel(match.folders, fromContent);
    if (folder) {
      return {
        path: folder.dropbox_path,
        reasonSuffix: ` (folder ${fromContent} from filename/email/document)`,
      };
    }
  }

  const fromAi = findFolderByLabel(match.folders, aiFolderLabel);
  if (fromAi) {
    return { path: fromAi.dropbox_path, reasonSuffix: '' };
  }
  if (aiFolderLabel) {
    // AI picked a label not in index — fall through to type mapping, not Correspondence
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
  }

  return { path: null, reasonSuffix: ' (could not resolve folder — use thread override)' };
}
