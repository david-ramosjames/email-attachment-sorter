import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import {
  buildCaseExpensesExtractionPrompt,
  isCaseExpenseDocumentType,
  isCaseExpensePaymentStatus,
} from '../constants/caseExpensesExtractionPrompt.js';
import type {
  CaseExpenseExtractionResult,
  CaseExpenseDocumentType,
  CaseExpensePaymentStatus,
  ExtractedCaseExpense,
} from '../types/caseExpenses.js';
import { logger } from '../utils/logger.js';

const MAX_TEXT_CHARS = 12_000;

const extractionSchema = {
  type: 'object' as const,
  properties: {
    document_summary: { type: 'string' as const },
    document_type: {
      type: ['string', 'null'] as const,
      enum: [
        'invoice',
        'receipt',
        'statement',
        'check_copy',
        'credit_card',
        'vendor_bill',
        'other',
        null,
      ],
    },
    document_confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    expenses: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          vendor_name: { type: 'string' as const },
          expense_type: { type: ['string', 'null'] as const },
          description: { type: ['string', 'null'] as const },
          invoice_number: { type: ['string', 'null'] as const },
          invoice_date: { type: ['string', 'null'] as const },
          service_date: { type: ['string', 'null'] as const },
          amount: { type: ['number', 'null'] as const },
          payment_status: {
            type: 'string' as const,
            enum: [
              'pending_review',
              'unpaid',
              'partially_paid',
              'paid',
              'waived',
              'closed',
              'unknown',
            ],
          },
          paid_amount: { type: ['number', 'null'] as const },
          check_number: { type: ['string', 'null'] as const },
          payee_name: { type: ['string', 'null'] as const },
          payee_address: { type: ['string', 'null'] as const },
          reference_number: { type: ['string', 'null'] as const },
          related_party: { type: ['string', 'null'] as const },
          document_type: {
            type: ['string', 'null'] as const,
            enum: [
              'invoice',
              'receipt',
              'statement',
              'check_copy',
              'credit_card',
              'vendor_bill',
              'other',
              null,
            ],
          },
          line_confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
        },
        required: [
          'vendor_name',
          'expense_type',
          'description',
          'invoice_number',
          'invoice_date',
          'service_date',
          'amount',
          'payment_status',
          'paid_amount',
          'check_number',
          'payee_name',
          'payee_address',
          'reference_number',
          'related_party',
          'document_type',
          'line_confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['document_summary', 'document_type', 'document_confidence', 'expenses'],
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
    return `${year}-${String(parseInt(us[1]!, 10)).padStart(2, '0')}-${String(parseInt(us[2]!, 10)).padStart(2, '0')}`;
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

function normalizePaymentStatus(raw: string | null | undefined): CaseExpensePaymentStatus {
  const value = raw?.trim();
  if (value && isCaseExpensePaymentStatus(value)) return value;
  return 'pending_review';
}

function normalizeDocumentType(raw: string | null | undefined): CaseExpenseDocumentType | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isCaseExpenseDocumentType(value)) return value;
  return null;
}

function normalizeExpense(
  raw: ExtractedCaseExpense,
  fallbackDocType: CaseExpenseDocumentType | null
): ExtractedCaseExpense | null {
  const vendor_name = raw.vendor_name?.trim();
  if (!vendor_name) return null;

  const amount = normalizeAmount(raw.amount);
  if (amount == null && !raw.invoice_number?.trim() && !raw.description?.trim()) {
    return null;
  }

  return {
    vendor_name,
    expense_type: raw.expense_type?.trim() || null,
    description: raw.description?.trim() || null,
    invoice_number: raw.invoice_number?.trim() || null,
    invoice_date: normalizeDate(raw.invoice_date),
    service_date: normalizeDate(raw.service_date),
    amount,
    payment_status: normalizePaymentStatus(raw.payment_status),
    paid_amount: normalizeAmount(raw.paid_amount),
    check_number: raw.check_number?.trim() || null,
    payee_name: raw.payee_name?.trim() || null,
    payee_address: raw.payee_address?.trim() || null,
    reference_number: raw.reference_number?.trim() || null,
    related_party: raw.related_party?.trim() || null,
    document_type: normalizeDocumentType(raw.document_type) ?? fallbackDocType,
    line_confidence: normalizeConfidence(raw.line_confidence),
  };
}

export async function extractCaseExpenses(opts: {
  documentText: string;
  attachmentFilename: string;
  caseNumber: string;
  /** First-level Expenses subfolder name, when the file sits under a vendor folder. */
  vendorFolderHint?: string;
}): Promise<CaseExpenseExtractionResult> {
  const text = opts.documentText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  if (text.length < 40) {
    return {
      document_summary: 'Insufficient text for expense extraction',
      document_type: null,
      document_confidence: null,
      expenses: [],
    };
  }

  const hintLine = opts.vendorFolderHint?.trim()
    ? `Expenses vendor folder hint: ${opts.vendorFolderHint.trim()}\n`
    : '';

  const response = await getOpenAI().chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'case_expense_extraction',
        strict: true,
        schema: extractionSchema,
      },
    },
    messages: [
      { role: 'system', content: buildCaseExpensesExtractionPrompt() },
      {
        role: 'user',
        content:
          `Case number: ${opts.caseNumber}\n` +
          `Filename: ${opts.attachmentFilename}\n` +
          hintLine +
          `\nDocument text:\n${text}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty case expense extraction response');

  const parsed = JSON.parse(content) as CaseExpenseExtractionResult;
  const document_type = normalizeDocumentType(parsed.document_type);

  if (!document_type && !(parsed.expenses ?? []).length) {
    return {
      document_summary: parsed.document_summary?.trim() || '',
      document_type: null,
      document_confidence: normalizeConfidence(parsed.document_confidence),
      expenses: [],
    };
  }

  const expenses = (parsed.expenses ?? [])
    .map((e) => normalizeExpense(e, document_type))
    .filter((e): e is ExtractedCaseExpense => e != null);

  logger.info('Case expense extraction finished', {
    caseNumber: opts.caseNumber,
    filename: opts.attachmentFilename,
    documentType: document_type,
    expenseCount: expenses.length,
  });

  return {
    document_summary: parsed.document_summary?.trim() || '',
    document_type,
    document_confidence: normalizeConfidence(parsed.document_confidence),
    expenses,
  };
}
