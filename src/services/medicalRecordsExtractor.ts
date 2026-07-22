import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  buildMedicalRecordsExtractionPrompt,
  isMedicalDocumentType,
  isMedicalPaymentStatus,
} from '../constants/medicalRecordsExtractionPrompt.js';
import type {
  ExtractedMedicalBillingLine,
  MedicalBillingExtractionResult,
  MedicalDocumentType,
  MedicalPaymentStatus,
} from '../types/medicalRecords.js';
import { logger } from '../utils/logger.js';
import { resolveProviderName } from '../utils/providerNameQuality.js';

const MAX_TEXT_CHARS = 12_000;

const extractionSchema = {
  type: 'object' as const,
  properties: {
    document_summary: {
      type: 'string' as const,
      description: 'One sentence describing the billing document',
    },
    document_type: {
      type: ['string', 'null'] as const,
      enum: [
        'medical_bill',
        'balance_statement',
        'reduction_letter',
        'payment_invoice',
        'lop_statement',
        'medical_provider_statement',
        null,
      ],
    },
    document_confidence: {
      type: 'number' as const,
      minimum: 0,
      maximum: 1,
      description: 'Overall confidence in this extraction (0–1)',
    },
    lines: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          provider_name: { type: 'string' as const },
          account_number: { type: ['string', 'null'] as const },
          date_of_service: { type: ['string', 'null'] as const },
          original_charges: { type: ['number', 'null'] as const },
          current_balance: { type: ['number', 'null'] as const },
          final_pay_amount: { type: ['number', 'null'] as const },
          reduced_from_amount: { type: ['number', 'null'] as const },
          payee_name: { type: ['string', 'null'] as const },
          payee_address: { type: ['string', 'null'] as const },
          payment_status: {
            type: 'string' as const,
            enum: [
              'pending_review',
              'unpaid',
              'partially_paid',
              'paid',
              'reduced',
              'waived',
              'closed',
              'pending_reduction',
              'unknown',
            ],
          },
          line_confidence: {
            type: 'number' as const,
            minimum: 0,
            maximum: 1,
            description: 'Confidence in this line (0–1)',
          },
        },
        required: [
          'provider_name',
          'account_number',
          'date_of_service',
          'original_charges',
          'current_balance',
          'final_pay_amount',
          'reduced_from_amount',
          'payee_name',
          'payee_address',
          'payment_status',
          'line_confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['document_summary', 'document_type', 'document_confidence', 'lines'],
  additionalProperties: false,
};

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
}

function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    let year = parseInt(us[3]!, 10);
    if (year < 100) year += 2000;
    const month = String(parseInt(us[1]!, 10)).padStart(2, '0');
    const day = String(parseInt(us[2]!, 10)).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

function normalizeAmount(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

function normalizeConfidence(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

function normalizeDocumentType(raw: string | null | undefined): MedicalDocumentType | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isMedicalDocumentType(value)) return value;
  return null;
}

function normalizePaymentStatus(raw: string | null | undefined): MedicalPaymentStatus {
  const value = raw?.trim();
  if (value && isMedicalPaymentStatus(value)) return value;
  return 'pending_review';
}

function applyDocumentTypeRules(
  documentType: MedicalDocumentType,
  line: ExtractedMedicalBillingLine
): ExtractedMedicalBillingLine {
  const result = { ...line };

  switch (documentType) {
    case 'reduction_letter':
      result.payment_status = 'reduced';
      break;
    case 'payment_invoice':
      if (result.current_balance === 0) {
        result.payment_status = 'paid';
      }
      break;
    case 'balance_statement':
      // Only balance is meaningful; other amounts stay as extracted or null
      break;
    default:
      break;
  }

  return result;
}

function normalizeLine(raw: ExtractedMedicalBillingLine): ExtractedMedicalBillingLine | null {
  const provider_name = raw.provider_name?.trim();
  if (!provider_name) return null;

  return {
    provider_name,
    account_number: raw.account_number?.trim() || null,
    date_of_service: normalizeDate(raw.date_of_service),
    original_charges: normalizeAmount(raw.original_charges),
    current_balance: normalizeAmount(raw.current_balance),
    final_pay_amount: normalizeAmount(raw.final_pay_amount),
    reduced_from_amount: normalizeAmount(raw.reduced_from_amount),
    payee_name: raw.payee_name?.trim() || null,
    payee_address: raw.payee_address?.trim() || null,
    payment_status: normalizePaymentStatus(raw.payment_status),
    line_confidence: normalizeConfidence(raw.line_confidence),
  };
}

function lineHasBillingData(line: ExtractedMedicalBillingLine): boolean {
  return (
    line.original_charges != null ||
    line.current_balance != null ||
    line.final_pay_amount != null ||
    line.reduced_from_amount != null ||
    Boolean(line.account_number)
  );
}

function pickPaymentStatus(
  a: ExtractedMedicalBillingLine['payment_status'],
  b: ExtractedMedicalBillingLine['payment_status']
): ExtractedMedicalBillingLine['payment_status'] {
  if (a === b) return a;
  if (a === 'pending_review') return b;
  if (b === 'pending_review') return a;
  return a;
}

/** Merge itemized lines into provider/account totals (one row per bill). */
export function collapseBillingLinesToTotals(
  lines: ExtractedMedicalBillingLine[]
): ExtractedMedicalBillingLine[] {
  if (lines.length <= 1) return lines;

  const byKey = new Map<string, ExtractedMedicalBillingLine>();
  for (const line of lines) {
    const key = `${line.provider_name.trim().toLowerCase()}|${(line.account_number ?? '').trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...line });
      continue;
    }

    const sum = (x: number | null, y: number | null) => {
      if (x == null && y == null) return null;
      return (x ?? 0) + (y ?? 0);
    };
    const max = (x: number | null, y: number | null) => {
      if (x == null) return y;
      if (y == null) return x;
      return Math.max(x, y);
    };

    byKey.set(key, {
      ...existing,
      original_charges: sum(existing.original_charges, line.original_charges),
      current_balance: max(existing.current_balance, line.current_balance),
      final_pay_amount: max(existing.final_pay_amount, line.final_pay_amount),
      reduced_from_amount: max(existing.reduced_from_amount, line.reduced_from_amount),
      date_of_service: existing.date_of_service ?? line.date_of_service,
      payee_name: existing.payee_name ?? line.payee_name,
      payee_address: existing.payee_address ?? line.payee_address,
      payment_status: pickPaymentStatus(existing.payment_status, line.payment_status),
      line_confidence: max(existing.line_confidence, line.line_confidence),
    });
  }

  return [...byKey.values()];
}

export async function extractMedicalBillingLines(opts: {
  documentText: string;
  attachmentFilename: string;
  caseNumber: string;
  /** Dropbox Medical/ provider folder — used when the model returns city/placeholder junk. */
  providerFolderHint?: string | null;
}): Promise<MedicalBillingExtractionResult> {
  const text = opts.documentText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  if (text.length < 40) {
    return {
      document_summary: 'Insufficient text for billing extraction',
      document_type: null,
      document_confidence: null,
      lines: [],
    };
  }

  const hint = opts.providerFolderHint?.trim() || '';
  const response = await getOpenAI().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'medical_billing_extraction',
        strict: true,
        schema: extractionSchema,
      },
    },
    messages: [
      { role: 'system', content: buildMedicalRecordsExtractionPrompt() },
      {
        role: 'user',
        content:
          `Case number: ${opts.caseNumber}\n` +
          `Filename: ${opts.attachmentFilename}\n` +
          (hint ? `Dropbox provider folder hint: ${hint}\n` : '') +
          `\nDocument text:\n${text}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty medical billing extraction response');
  }

  const parsed = JSON.parse(content) as MedicalBillingExtractionResult;
  const document_type = normalizeDocumentType(parsed.document_type);

  if (!document_type) {
    logger.info('Medical billing extraction skipped — not a financial document', {
      caseNumber: opts.caseNumber,
      filename: opts.attachmentFilename,
      summary: parsed.document_summary,
    });
    return {
      document_summary: parsed.document_summary?.trim() || '',
      document_type: null,
      document_confidence: normalizeConfidence(parsed.document_confidence),
      lines: [],
    };
  }

  const lines = collapseBillingLinesToTotals(
    (parsed.lines ?? [])
      .map((line) => normalizeLine(line))
      .filter((line): line is ExtractedMedicalBillingLine => line != null && lineHasBillingData(line))
      .map((line) => {
        const resolved = resolveProviderName(line.provider_name, hint);
        return applyDocumentTypeRules(document_type, {
          ...line,
          provider_name: resolved ?? line.provider_name,
        });
      })
  );

  logger.info('Medical billing extraction finished', {
    caseNumber: opts.caseNumber,
    filename: opts.attachmentFilename,
    documentType: document_type,
    lineCount: lines.length,
    providerHint: hint || null,
    providers: lines.map((l) => l.provider_name),
  });

  return {
    document_summary: parsed.document_summary?.trim() || '',
    document_type,
    document_confidence: normalizeConfidence(parsed.document_confidence),
    lines,
  };
}
