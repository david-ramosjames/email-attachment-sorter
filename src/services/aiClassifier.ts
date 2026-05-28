import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { CONFIDENCE_THRESHOLD } from '../constants/classification.js';
import {
  DOCUMENT_TYPES,
  type CaseCandidate,
  type ClassificationResult,
  type DocumentType,
  type MatchContext,
} from '../types/index.js';
import { DOCUMENT_TYPE_TO_SUBFOLDER } from '../constants/rjlFolders.js';

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
      return `[${i + 1}] case_number="${c.case.case_number}" slack_channel="${c.case.slack_channel_name}" folders=[${folders}] match_score=${c.matchScore} reasons=${c.matchReasons.join('; ')}`;
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
    suggested_folder_path: {
      type: ['string', 'null'] as const,
      description: 'Dropbox folder path from candidate folders, or null',
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
    'suggested_folder_path',
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
    return {
      suggestedCaseNumber: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      confidence: 0,
      reason: 'No matching cases found in index',
      needsAttention: true,
    };
  }

  const candidateNumbers = new Set(candidates.map((c) => c.case.case_number));
  const validFolders = new Map<string, Set<string>>();
  for (const c of candidates) {
    validFolders.set(
      c.case.case_number,
      new Set(c.folders.map((f) => f.dropbox_path))
    );
  }

  const systemPrompt = `You are a legal document filing assistant for Ramos James Law.
You MUST choose ONLY from the provided case candidates by using their exact case_number.
Each candidate's slack_channel field is the primary human-readable case label (often "Client Name - case ref").
Prefer matching by client/name signals in the email over bare case numbers.
You MUST NOT invent case numbers or Slack channel names not in the list.
If no candidate is a confident match, set suggested_case_number to null and document_type to "needs_attention".
Folder paths must come from the candidate's indexed folders only.
Document types: ${DOCUMENT_TYPES.join(', ')}.
Return strict JSON only.`;

  const documentSection = ctx.documentExcerpt
    ? `\nDocument content (from attachment${options?.usedDocumentContent ? ', email match was low confidence' : ''}):\n${ctx.documentExcerpt.slice(0, 4000)}`
    : '';

  const userPrompt = `Email context:
From: ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ')}
Subject: ${ctx.subject}
Body excerpt: ${ctx.bodyExcerpt.slice(0, 1500)}
Attachment filename: ${ctx.attachmentFilename}${documentSection}

Candidate cases (choose ONLY from these):
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
    suggested_folder_path: string | null;
    document_type: string;
    confidence: number;
    reason: string;
  };

  let suggestedCaseNumber = parsed.suggested_case_number;
  let suggestedFolderPath = parsed.suggested_folder_path;
  let documentType = parsed.document_type as DocumentType | 'needs_attention';
  let confidence = parsed.confidence;
  let reason = parsed.reason;

  if (suggestedCaseNumber && !candidateNumbers.has(suggestedCaseNumber)) {
    suggestedCaseNumber = null;
    suggestedFolderPath = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case number not in candidate list — rejected';
  }

  if (suggestedCaseNumber && suggestedFolderPath) {
    const allowed = validFolders.get(suggestedCaseNumber);
    if (allowed && allowed.size > 0 && !allowed.has(suggestedFolderPath)) {
      const match = candidates.find((c) => c.case.case_number === suggestedCaseNumber);
      suggestedFolderPath = match?.folders[0]?.dropbox_path ?? null;
      reason += ' (folder adjusted to indexed path)';
    }
  }

  // Map document type → RJL subfolder when AI picked case but not path
  if (suggestedCaseNumber && !suggestedFolderPath && documentType !== 'needs_attention') {
    const subfolder = DOCUMENT_TYPE_TO_SUBFOLDER[documentType];
    const match = candidates.find((c) => c.case.case_number === suggestedCaseNumber);
    const folder = match?.folders.find((f) => f.folder_label === subfolder);
    if (folder) {
      suggestedFolderPath = folder.dropbox_path;
      reason += ` (mapped ${documentType} → ${subfolder})`;
    }
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
