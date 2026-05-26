import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  CONFIDENCE_THRESHOLD,
  DOCUMENT_TYPES,
  type CaseCandidate,
  type ClassificationResult,
  type DocumentType,
  type MatchContext,
} from '../types/index.js';

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
      return `[${i + 1}] id=${c.case.id} case_name="${c.case.case_name}" client="${c.case.client_name}" cause="${c.case.cause_number ?? 'n/a'}" folders=[${folders}] match_score=${c.matchScore} reasons=${c.matchReasons.join('; ')}`;
    })
    .join('\n');
}

const classificationSchema = {
  type: 'object' as const,
  properties: {
    suggested_case_id: {
      type: ['string', 'null'] as const,
      description: 'UUID from candidate list, or null if needs_attention',
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
    'suggested_case_id',
    'suggested_folder_path',
    'document_type',
    'confidence',
    'reason',
  ],
  additionalProperties: false,
};

export async function classifyDocument(
  ctx: MatchContext,
  candidates: CaseCandidate[]
): Promise<ClassificationResult> {
  if (candidates.length === 0) {
    return {
      suggestedCaseId: null,
      suggestedFolderPath: null,
      documentType: 'needs_attention',
      confidence: 0,
      reason: 'No matching cases found in index',
      needsAttention: true,
    };
  }

  const candidateIds = new Set(candidates.map((c) => c.case.id));
  const validFolders = new Map<string, Set<string>>();
  for (const c of candidates) {
    validFolders.set(
      c.case.id,
      new Set(c.folders.map((f) => f.dropbox_path))
    );
  }

  const systemPrompt = `You are a legal document filing assistant for Ramos James Law.
You MUST choose ONLY from the provided case candidates by using their exact id UUID.
You MUST NOT invent case names, client names, or case IDs not in the list.
If no candidate is a confident match, set suggested_case_id to null and document_type to "needs_attention".
Folder paths must come from the candidate's indexed folders only.
Document types: ${DOCUMENT_TYPES.join(', ')}.
Return strict JSON only.`;

  const userPrompt = `Email context:
From: ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ')}
Subject: ${ctx.subject}
Body excerpt: ${ctx.bodyExcerpt.slice(0, 1500)}
Attachment: ${ctx.attachmentFilename}

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
    suggested_case_id: string | null;
    suggested_folder_path: string | null;
    document_type: string;
    confidence: number;
    reason: string;
  };

  let suggestedCaseId = parsed.suggested_case_id;
  let suggestedFolderPath = parsed.suggested_folder_path;
  let documentType = parsed.document_type as DocumentType | 'needs_attention';
  let confidence = parsed.confidence;
  let reason = parsed.reason;

  if (suggestedCaseId && !candidateIds.has(suggestedCaseId)) {
    suggestedCaseId = null;
    suggestedFolderPath = null;
    documentType = 'needs_attention';
    confidence = 0;
    reason = 'AI returned case ID not in candidate list — rejected';
  }

  if (suggestedCaseId && suggestedFolderPath) {
    const allowed = validFolders.get(suggestedCaseId);
    if (allowed && allowed.size > 0 && !allowed.has(suggestedFolderPath)) {
      const match = candidates.find((c) => c.case.id === suggestedCaseId);
      suggestedFolderPath = match?.folders[0]?.dropbox_path ?? null;
      reason += ' (folder adjusted to indexed path)';
    }
  }

  const needsAttention =
    documentType === 'needs_attention' ||
    !suggestedCaseId ||
    confidence < CONFIDENCE_THRESHOLD;

  return {
    suggestedCaseId,
    suggestedFolderPath,
    documentType: needsAttention ? 'needs_attention' : (documentType as DocumentType),
    confidence,
    reason,
    needsAttention,
  };
}
