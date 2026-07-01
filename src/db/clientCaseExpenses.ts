import { getClientSupabase } from './clientSupabase.js';
import { lookupClientCaseId } from './clientMedicalRecords.js';
import type { CaseExpenseInsert } from '../types/caseExpenses.js';
import { logger } from '../utils/logger.js';

function isMissingColumnError(err: { message?: string }, column: string): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes(column.toLowerCase()) && msg.includes('could not find');
}

function isCheckConstraintError(err: { code?: string }): boolean {
  return err.code === '23514';
}

function insertPayload(row: CaseExpenseInsert): Record<string, unknown> {
  return {
    case_number: row.case_number,
    case_id: row.case_id,
    vendor_name: row.vendor_name,
    expense_type: row.expense_type,
    description: row.description,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    service_date: row.service_date,
    amount: row.amount,
    payment_status: row.payment_status,
    paid_amount: row.paid_amount,
    check_number: row.check_number,
    payee_name: row.payee_name,
    payee_address: row.payee_address,
    reference_number: row.reference_number,
    related_party: row.related_party,
    dropbox_file_id: row.dropbox_file_id,
    dropbox_file_path: row.dropbox_file_path,
    dropbox_permalink: row.dropbox_permalink ?? null,
    document_type: row.document_type,
    review_status: row.review_status,
    text_extraction_method: row.text_extraction_method,
    extraction_confidence: row.extraction_confidence,
    document_extraction_confidence: row.document_extraction_confidence,
  };
}

async function insertCaseExpenseRow(
  client: NonNullable<ReturnType<typeof getClientSupabase>>,
  row: CaseExpenseInsert
): Promise<{ error: { message: string; code?: string } | null }> {
  let payload = insertPayload(row);
  let result = await client.from('case_expenses').insert(payload);

  if (result.error && isMissingColumnError(result.error, 'dropbox_permalink')) {
    const { dropbox_permalink: _removed, ...withoutPermalink } = payload;
    payload = withoutPermalink;
    logger.warn('case_expenses.dropbox_permalink column missing — run migration 005', {
      caseNumber: row.case_number,
    });
    result = await client.from('case_expenses').insert(payload);
  }

  if (result.error && isCheckConstraintError(result.error)) {
    const msg = (result.error.message ?? '').toLowerCase();
    if (msg.includes('review_status') && payload.review_status === 'needs_review') {
      payload = { ...payload, review_status: 'pending' };
      result = await client.from('case_expenses').insert(payload);
    } else if (msg.includes('payment_status') && payload.payment_status === 'pending_review') {
      payload = { ...payload, payment_status: 'unknown' };
      result = await client.from('case_expenses').insert(payload);
    }
  }

  return { error: result.error };
}

async function recordFromSameDocumentExists(row: CaseExpenseInsert): Promise<boolean> {
  const client = getClientSupabase();
  if (!client) return false;

  let query = client
    .from('case_expenses')
    .select('id')
    .eq('dropbox_file_id', row.dropbox_file_id)
    .eq('vendor_name', row.vendor_name);

  if (row.invoice_number) {
    query = query.eq('invoice_number', row.invoice_number);
  } else {
    query = query.is('invoice_number', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    logger.warn('Case expense dedup check failed', { err: error.message });
    return false;
  }
  return Boolean(data);
}

export async function insertCaseExpenses(
  rows: CaseExpenseInsert[]
): Promise<{ inserted: number; skipped: number }> {
  const client = getClientSupabase();
  if (!client) return { inserted: 0, skipped: rows.length };

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (await recordFromSameDocumentExists(row)) {
      skipped++;
      continue;
    }

    const { error } = await insertCaseExpenseRow(client, row);
    if (error) {
      if (error.message?.includes('case_expenses') && error.message?.includes('does not exist')) {
        logger.error('case_expenses table missing — run migration 005', { err: error.message });
      }
      logger.error('Failed to insert case_expenses row', {
        caseNumber: row.case_number,
        vendor: row.vendor_name,
        err: error.message,
      });
      throw new Error(`case_expenses insert failed: ${error.message}`);
    }
    inserted++;
  }

  return { inserted, skipped };
}

export { lookupClientCaseId };
