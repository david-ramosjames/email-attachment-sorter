import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { MAX_DOCUMENT_TEXT_FOR_AI } from '../constants/classification.js';
import type { ClientIdentity, MatchContext } from '../types/index.js';
import { buildSmartBodyExcerpt } from '../utils/emailBodyExcerpt.js';
import { isEmailFromIntake } from '../utils/intakeDocumentSignals.js';
import { caseMatchingHintsPromptSection } from '../utils/matchingHints.js';
import { logger } from '../utils/logger.js';

export type { ClientIdentity };

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

const identitySchema = {
  type: 'object' as const,
  properties: {
    client_full_name: {
      type: ['string', 'null'] as const,
      description: 'PI client full name (injured party RJL represents)',
    },
    name_tokens: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Lowercase name parts for search (e.g. kisha, williams)',
    },
    case_number_hint: {
      type: ['string', 'null'] as const,
      description: 'RJL case number digits if clearly stated',
    },
    slack_channel_hint: {
      type: ['string', 'null'] as const,
      description: 'Likely case channel slug if inferable, else null',
    },
    document_kind: {
      type: ['string', 'null'] as const,
      description: 'Brief label: e.g. medical_records, employment_authorization, retainer_contract',
    },
    is_new_client_intake: {
      type: 'boolean' as const,
      description:
        'True only if this appears to be a brand-new engagement with no existing case folder yet',
    },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    reason: { type: 'string' as const },
  },
  required: [
    'client_full_name',
    'name_tokens',
    'case_number_hint',
    'slack_channel_hint',
    'document_kind',
    'is_new_client_intake',
    'confidence',
    'reason',
  ],
  additionalProperties: false,
};

/**
 * Optional pre-pass: extract who the PI client is to widen the case candidate search.
 * Final filing decisions are made by classifyDocument() — not hard rules here.
 */
export async function extractClientIdentity(ctx: MatchContext): Promise<ClientIdentity> {
  const attachmentSection = ctx.documentExcerpt
    ? `\n\nAttachment text:\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '';

  const siblings = ctx.siblingAttachmentFilenames?.length
    ? `\nAll attachments in this email: ${ctx.siblingAttachmentFilenames.join(', ')}`
    : '';

  const systemPrompt = `You analyze inbound email for Ramos James Law (personal injury firm).

From: sender, To/Cc, subject, body (including forwards), attachment filename, and attachment text — determine:

1. Who is the PI CLIENT (person RJL represents)? This is usually NOT the email sender (often a vendor, HR dept, Adobe Sign, medical records company, or RJL staff).
2. What kind of document this is (brief document_kind label).
3. Whether this looks like a brand-new client engagement with no case folder yet (is_new_client_intake) — **only true when the email is from intake@ramosjames.com or forwards intake@**; Adobe Sign and other vendors are NOT intake.

If the sender asks RJL to identify the client ("please let me know the name of your client"), set client_full_name to null — the client is unknown.

Return strict JSON only.`;

  const bodyForAi = buildSmartBodyExcerpt(ctx.bodyExcerpt, 8000);

  const userPrompt = `From: ${ctx.fromEmail}
To: ${ctx.toEmails.join(', ') || '(not provided)'}
Cc: ${ctx.ccEmails.join(', ') || '(none)'}
Subject: ${ctx.subject}

Email body:
${bodyForAi}

Attachment filename: ${ctx.attachmentFilename}${siblings}${attachmentSection}${caseMatchingHintsPromptSection(ctx.caseMatchingHints)}${ctx.forwardedEmailContext ? `\n\nForwarded / original request:\n${ctx.forwardedEmailContext}` : ''}${ctx.externalFileUrl ? `\n\nExternal file link:\n${ctx.externalFileUrl}` : ''}`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: getEnv().OPENAI_MODEL,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'client_identity',
          strict: true,
          schema: identitySchema,
        },
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return emptyIdentity('Empty AI identity response');
    }

    const parsed = JSON.parse(content) as {
      client_full_name: string | null;
      name_tokens: string[];
      case_number_hint: string | null;
      slack_channel_hint: string | null;
      document_kind: string | null;
      is_new_client_intake: boolean;
      confidence: number;
      reason: string;
    };

    const tokens = [
      ...new Set(
        (parsed.name_tokens ?? [])
          .map((t) => t.toLowerCase().trim())
          .filter((t) => t.length >= 3)
      ),
    ];

    if (parsed.client_full_name) {
      for (const t of parsed.client_full_name
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 3)) {
        if (!tokens.includes(t)) tokens.push(t);
      }
    }

    const identity: ClientIdentity = {
      clientFullName: parsed.client_full_name,
      nameTokens: tokens,
      caseNumberHint: parsed.case_number_hint?.replace(/\D/g, '') || null,
      slackChannelHint: parsed.slack_channel_hint?.toLowerCase().trim() || null,
      documentKind: parsed.document_kind,
      isNewClientIntake: isEmailFromIntake(ctx),
      confidence: parsed.confidence,
      reason: parsed.reason,
    };

    logger.info('AI client identity (candidate search hint)', {
      clientFullName: identity.clientFullName,
      documentKind: identity.documentKind,
      isNewClientIntake: identity.isNewClientIntake,
    });

    return identity;
  } catch (err) {
    logger.warn('AI client identity extraction failed', { err: String(err) });
    return emptyIdentity(`Identity extraction failed: ${String(err)}`);
  }
}

function emptyIdentity(reason: string): ClientIdentity {
  return {
    clientFullName: null,
    nameTokens: [],
    caseNumberHint: null,
    slackChannelHint: null,
    documentKind: null,
    isNewClientIntake: false,
    confidence: 0,
    reason,
  };
}
