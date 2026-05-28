import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { MAX_DOCUMENT_TEXT_FOR_AI } from '../constants/classification.js';
import type { ClientIdentity, MatchContext } from '../types/index.js';
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
      description: 'Patient/client full name from the document, e.g. Lourdes Galeas Montoya',
    },
    name_tokens: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Distinct name parts for matching (lourdes, galeas, montoya)',
    },
    case_number_hint: {
      type: ['string', 'null'] as const,
      description: 'RJL case number if visible (often 3-5 digits, e.g. 940)',
    },
    slack_channel_hint: {
      type: ['string', 'null'] as const,
      description:
        'Likely Slack/case channel slug if inferable (e.g. lourdesgaleas-940), lowercase. Null for new clients.',
    },
    document_kind: {
      type: ['string', 'null'] as const,
      description:
        'client_contract | medical_records | court_filing | correspondence | other',
    },
    is_new_client_intake: {
      type: 'boolean' as const,
      description:
        'True for signed engagement/retainer contracts (Adobe Sign) when no existing case is referenced',
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
 * OpenAI reads ALL available text and extracts who the document is about.
 * Runs before case matching so rules/search can target lourdesgaleas-940-style channels.
 */
export async function extractClientIdentity(ctx: MatchContext): Promise<ClientIdentity> {
  const attachmentSection = ctx.documentExcerpt
    ? `\n\nAttachment text:\n${ctx.documentExcerpt.slice(0, MAX_DOCUMENT_TEXT_FOR_AI)}`
    : '\n\n(No attachment text extracted yet)';

  const siblings = ctx.siblingAttachmentFilenames?.length
    ? `\nAll attachments in this email: ${ctx.siblingAttachmentFilenames.join(', ')}`
    : '';

  const systemPrompt = `You extract the client/patient identity from legal inbound mail for Ramos James Law.

Read the email subject, body, attachment filename, and attachment text together.

Output:
- client_full_name: the person the records are about (not the sender company)
- name_tokens: 2+ lowercase tokens from that name (e.g. lourdes, galeas, montoya)
- case_number_hint: RJL case number digits if stated (e.g. 940, 1455) — NOT phone/fax numbers
- slack_channel_hint: if you can infer the firm's case channel slug, use format like "firstnamelastname-940" (no spaces, lowercase). Example: Lourdes Galeas Montoya on case 940 → "lourdesgaleas-940"

Medical records from records@procareinjury.com: the email body often says "Attached are [Name] records and billing" — that name is the client.
Affidavit filenames (RecordsAffidavit_*.pdf) usually do NOT contain the client name — rely on email body and PDF body (Patient: line).

Adobe Sign / DocuSign contracts (adobesign@): the email names the client party (e.g. "between Ramos James Law and Israel Mejia"). That person is the client.
- document_kind = client_contract for retainer/engagement contracts
- is_new_client_intake = true when this is a new engagement contract and NO existing RJL case number is in the document
- Do NOT guess slack_channel_hint from a similar surname (Mejia ≠ Mejias / javiermejias)

Return strict JSON only.`;

  const userPrompt = `From: ${ctx.fromEmail}
Subject: ${ctx.subject}
Email body:
${ctx.bodyExcerpt.slice(0, 4000)}
Attachment filename: ${ctx.attachmentFilename}${siblings}${attachmentSection}`;

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
      isNewClientIntake: parsed.is_new_client_intake,
      confidence: parsed.confidence,
      reason: parsed.reason,
    };

    logger.info('AI client identity extracted', {
      clientFullName: identity.clientFullName,
      nameTokens: identity.nameTokens,
      caseNumberHint: identity.caseNumberHint,
      slackChannelHint: identity.slackChannelHint,
      confidence: identity.confidence,
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
