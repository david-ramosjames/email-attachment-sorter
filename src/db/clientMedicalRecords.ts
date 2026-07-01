import { getClientSupabase } from './clientSupabase.js';
import type {
  CaseMedicalRecordInsert,
  MedicalDocumentType,
} from '../types/medicalRecords.js';
import { logger } from '../utils/logger.js';

const PROVIDER_MATCH_CONFIDENCE_THRESHOLD = 0.85;
const DUPLICATE_MATCH_CONFIDENCE_THRESHOLD = 0.75;

export function normalizeProviderKey(name: string, address?: string | null): {
  normalized_name: string;
  normalized_address: string;
} {
  const normalized_name = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const normalized_address = (address ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return { normalized_name, normalized_address };
}

interface ExistingMedicalRecord {
  id: string;
  provider_name: string;
  account_number: string | null;
  date_of_service: string | null;
  document_type: string | null;
}

/** Look up an existing provider without creating one. */
export async function lookupMedicalProvider(opts: {
  providerName: string;
  payeeAddress?: string | null;
}): Promise<string | null> {
  const client = getClientSupabase();
  if (!client) return null;

  const name = opts.providerName.trim();
  if (!name) return null;

  const { normalized_name, normalized_address } = normalizeProviderKey(name, opts.payeeAddress);

  const { data: exact, error: exactError } = await client
    .from('medical_providers')
    .select('id')
    .eq('normalized_name', normalized_name)
    .eq('normalized_address', normalized_address)
    .maybeSingle();

  if (exactError) {
    logger.warn('Medical provider lookup failed', { name, err: exactError.message });
    return null;
  }

  if (exact?.id) return exact.id as string;

  // Fuzzy fallback: name-only match when address is absent
  if (!normalized_address) {
    const { data: nameMatch } = await client
      .from('medical_providers')
      .select('id')
      .eq('normalized_name', normalized_name)
      .limit(1)
      .maybeSingle();
    return (nameMatch as { id?: string } | null)?.id ?? null;
  }

  return null;
}

/** Resolve provider_id when extraction confidence is high enough. */
export async function resolveProviderIdForLine(opts: {
  providerName: string;
  payeeAddress?: string | null;
  lineConfidence: number | null;
}): Promise<string | null> {
  const conf = opts.lineConfidence ?? 0;
  if (conf < PROVIDER_MATCH_CONFIDENCE_THRESHOLD) return null;
  return lookupMedicalProvider({
    providerName: opts.providerName,
    payeeAddress: opts.payeeAddress,
  });
}

/** Find or create a medical_providers row for reuse across cases. */
export async function resolveOrCreateMedicalProvider(opts: {
  providerName: string;
  payeeAddress?: string | null;
  payeeName?: string | null;
}): Promise<string | null> {
  const existing = await lookupMedicalProvider(opts);
  if (existing) return existing;

  const client = getClientSupabase();
  if (!client) return null;

  const name = opts.providerName.trim();
  if (!name) return null;

  const address = opts.payeeAddress?.trim() || null;
  const { normalized_name, normalized_address } = normalizeProviderKey(name, address);

  const { data: created, error: insertError } = await client
    .from('medical_providers')
    .insert({
      name,
      normalized_name,
      address,
      normalized_address,
      payee_name: opts.payeeName?.trim() || null,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return lookupMedicalProvider(opts);
    }
    logger.warn('Medical provider insert failed', { name, err: insertError.message });
    return null;
  }

  return (created as { id?: string })?.id ?? null;
}

export async function lookupClientCaseId(caseNumber: string): Promise<string | null> {
  const client = getClientSupabase();
  if (!client) return null;

  const { data, error } = await client
    .from('cases')
    .select('id')
    .eq('case_number', caseNumber.trim())
    .maybeSingle();

  if (error) {
    logger.warn('Client Supabase case lookup failed', { caseNumber, err: error.message });
    return null;
  }

  return (data as { id?: string } | null)?.id ?? null;
}

async function recordFromSameDocumentExists(row: CaseMedicalRecordInsert): Promise<boolean> {
  const client = getClientSupabase();
  if (!client) return false;

  let query = client
    .from('case_medical_records')
    .select('id')
    .eq('dropbox_file_id', row.dropbox_file_id)
    .eq('provider_name', row.provider_name);

  if (row.account_number) {
    query = query.eq('account_number', row.account_number);
  } else {
    query = query.is('account_number', null);
  }

  if (row.date_of_service) {
    query = query.eq('date_of_service', row.date_of_service);
  } else {
    query = query.is('date_of_service', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    logger.warn('Medical record same-document dedup check failed', { err: error.message });
    return false;
  }
  return Boolean(data);
}

/** Find an existing expense that this document likely updates. */
export async function findExistingMedicalExpense(opts: {
  caseId: string | null;
  caseNumber: string;
  providerName: string;
  accountNumber: string | null;
  dateOfService: string | null;
  documentType: MedicalDocumentType;
  lineConfidence: number | null;
}): Promise<ExistingMedicalRecord | null> {
  const client = getClientSupabase();
  if (!client) return null;

  const conf = opts.lineConfidence ?? 0;
  if (conf < DUPLICATE_MATCH_CONFIDENCE_THRESHOLD) return null;

  const { normalized_name } = normalizeProviderKey(opts.providerName);

  let query = client
    .from('case_medical_records')
    .select('id, provider_name, account_number, date_of_service, document_type')
    .eq('case_number', opts.caseNumber.trim())
    .order('updated_at', { ascending: false })
    .limit(20);

  if (opts.caseId) {
    query = query.eq('case_id', opts.caseId);
  }

  const { data, error } = await query;
  if (error || !data?.length) {
    if (error) logger.warn('Medical expense lookup failed', { err: error.message });
    return null;
  }

  const candidates = data as ExistingMedicalRecord[];

  const providerMatches = (record: ExistingMedicalRecord): boolean => {
    const recordNorm = normalizeProviderKey(record.provider_name).normalized_name;
    return recordNorm === normalized_name;
  };

  const accountMatches = (record: ExistingMedicalRecord): boolean => {
    if (opts.accountNumber && record.account_number) {
      return opts.accountNumber.trim() === record.account_number.trim();
    }
    return !opts.accountNumber && !record.account_number;
  };

  const dateMatches = (record: ExistingMedicalRecord): boolean => {
    if (opts.dateOfService && record.date_of_service) {
      return opts.dateOfService === record.date_of_service;
    }
    return !opts.dateOfService || !record.date_of_service;
  };

  // Strong match: case + provider + account + date
  const strong = candidates.find(
    (r) => providerMatches(r) && accountMatches(r) && dateMatches(r)
  );
  if (strong) return strong;

  // Update documents: match provider + account (date may differ on statements)
  if (
    opts.documentType === 'balance_statement' ||
    opts.documentType === 'reduction_letter' ||
    opts.documentType === 'payment_invoice'
  ) {
    const providerAccount = candidates.find((r) => providerMatches(r) && accountMatches(r));
    if (providerAccount) return providerAccount;

    // Reduction letters often lack account numbers — match provider only
    if (opts.documentType === 'reduction_letter') {
      const providerOnly = candidates.find((r) => providerMatches(r));
      if (providerOnly) return providerOnly;
    }
  }

  return null;
}

function buildUpdatePayload(
  existing: ExistingMedicalRecord,
  row: CaseMedicalRecordInsert
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dropbox_file_id: row.dropbox_file_id,
    dropbox_file_path: row.dropbox_file_path,
    dropbox_permalink: row.dropbox_permalink ?? null,
    document_type: row.document_type,
    extraction_confidence: row.extraction_confidence,
    document_extraction_confidence: row.document_extraction_confidence,
    text_extraction_method: row.text_extraction_method,
    review_status: 'needs_review',
  };

  if (row.provider_id) payload.provider_id = row.provider_id;

  switch (row.document_type) {
    case 'balance_statement':
      if (row.current_balance != null) payload.current_balance = row.current_balance;
      break;
    case 'reduction_letter':
      if (row.reduced_from_amount != null) payload.reduced_from_amount = row.reduced_from_amount;
      if (row.final_pay_amount != null) payload.final_pay_amount = row.final_pay_amount;
      payload.payment_status = 'reduced';
      break;
    case 'payment_invoice':
      if (row.final_pay_amount != null) payload.final_pay_amount = row.final_pay_amount;
      if (row.current_balance != null) payload.current_balance = row.current_balance;
      if (row.current_balance === 0) {
        payload.payment_status = 'paid';
      } else if (row.payment_status) {
        payload.payment_status = row.payment_status;
      }
      break;
    default:
      if (row.account_number != null) payload.account_number = row.account_number;
      if (row.date_of_service != null) payload.date_of_service = row.date_of_service;
      if (row.original_charges != null) payload.original_charges = row.original_charges;
      if (row.current_balance != null) payload.current_balance = row.current_balance;
      if (row.final_pay_amount != null) payload.final_pay_amount = row.final_pay_amount;
      if (row.reduced_from_amount != null) payload.reduced_from_amount = row.reduced_from_amount;
      if (row.payee_name != null) payload.payee_name = row.payee_name;
      if (row.payee_address != null) payload.payee_address = row.payee_address;
      if (row.payment_status) payload.payment_status = row.payment_status;
      break;
  }

  return payload;
}

function isMissingColumnError(err: { message?: string }, column: string): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes(column.toLowerCase()) && msg.includes('could not find');
}

function isCheckConstraintError(err: { code?: string; message?: string }): boolean {
  return err.code === '23514' || (err.message ?? '').toLowerCase().includes('check constraint');
}

function insertPayload(row: CaseMedicalRecordInsert): Record<string, unknown> {
  return {
    case_number: row.case_number,
    case_id: row.case_id,
    tracker_entry_id: row.tracker_entry_id,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    account_number: row.account_number,
    date_of_service: row.date_of_service,
    original_charges: row.original_charges,
    current_balance: row.current_balance,
    final_pay_amount: row.final_pay_amount,
    reduced_from_amount: row.reduced_from_amount,
    payee_name: row.payee_name,
    payee_address: row.payee_address,
    document_type: row.document_type,
    payment_status: row.payment_status,
    dropbox_file_id: row.dropbox_file_id,
    dropbox_file_path: row.dropbox_file_path,
    dropbox_permalink: row.dropbox_permalink ?? null,
    review_status: row.review_status,
    text_extraction_method: row.text_extraction_method,
    extraction_confidence: row.extraction_confidence,
    document_extraction_confidence: row.document_extraction_confidence,
  };
}

/** Insert with fallbacks when Phase-1 migrations (004) are not fully applied yet. */
async function insertMedicalRecordRow(
  client: NonNullable<ReturnType<typeof getClientSupabase>>,
  row: CaseMedicalRecordInsert
): Promise<{ error: { message: string; code?: string } | null }> {
  let payload = insertPayload(row);
  let result = await client.from('case_medical_records').insert(payload);

  if (result.error && isMissingColumnError(result.error, 'dropbox_permalink')) {
    const { dropbox_permalink: _removed, ...withoutPermalink } = payload;
    payload = withoutPermalink;
    logger.warn('case_medical_records.dropbox_permalink column missing — run migrations/004', {
      caseNumber: row.case_number,
    });
    result = await client.from('case_medical_records').insert(payload);
  }

  if (result.error && isCheckConstraintError(result.error)) {
    const msg = (result.error.message ?? '').toLowerCase();
    if (msg.includes('review_status') && payload.review_status === 'needs_review') {
      payload = { ...payload, review_status: 'pending' };
      result = await client.from('case_medical_records').insert(payload);
    } else if (msg.includes('payment_status') && payload.payment_status === 'pending_review') {
      payload = { ...payload, payment_status: 'unknown' };
      result = await client.from('case_medical_records').insert(payload);
    }
  }

  return { error: result.error };
}

/** Update with fallbacks when dropbox_permalink column is missing. */
async function updateMedicalRecordRow(
  client: NonNullable<ReturnType<typeof getClientSupabase>>,
  id: string,
  payload: Record<string, unknown>
): Promise<{ error: { message: string; code?: string } | null }> {
  let result = await client.from('case_medical_records').update(payload).eq('id', id);

  if (result.error && isMissingColumnError(result.error, 'dropbox_permalink')) {
    const { dropbox_permalink: _removed, ...withoutPermalink } = payload;
    logger.warn('case_medical_records.dropbox_permalink column missing — run migrations/004', { id });
    result = await client.from('case_medical_records').update(withoutPermalink).eq('id', id);
  }

  if (result.error && isCheckConstraintError(result.error) && payload.review_status === 'needs_review') {
    result = await client
      .from('case_medical_records')
      .update({ ...payload, review_status: 'pending' })
      .eq('id', id);
  }

  return { error: result.error };
}

export async function upsertCaseMedicalRecords(
  rows: CaseMedicalRecordInsert[]
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const client = getClientSupabase();
  if (!client) return { inserted: 0, updated: 0, skipped: rows.length };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (await recordFromSameDocumentExists(row)) {
      skipped++;
      continue;
    }

    let providerId = row.provider_id;
    if (!providerId) {
      providerId = await resolveProviderIdForLine({
        providerName: row.provider_name,
        payeeAddress: row.payee_address,
        lineConfidence: row.extraction_confidence,
      });
    }

    const rowWithProvider = { ...row, provider_id: providerId };

    const existing = await findExistingMedicalExpense({
      caseId: row.case_id,
      caseNumber: row.case_number,
      providerName: row.provider_name,
      accountNumber: row.account_number,
      dateOfService: row.date_of_service,
      documentType: row.document_type,
      lineConfidence: row.extraction_confidence,
    });

    if (existing && row.document_type !== 'medical_bill') {
      const updatePayload = buildUpdatePayload(existing, rowWithProvider);
      const { error } = await updateMedicalRecordRow(client, existing.id, updatePayload);

      if (error) {
        logger.error('Failed to update case_medical_records row', {
          id: existing.id,
          err: error.message,
        });
        throw new Error(`case_medical_records update failed: ${error.message}`);
      }
      updated++;
      continue;
    }

    const { error } = await insertMedicalRecordRow(client, rowWithProvider);

    if (error) {
      logger.error('Failed to insert case_medical_records row', {
        caseNumber: row.case_number,
        provider: row.provider_name,
        err: error.message,
      });
      throw new Error(`case_medical_records insert failed: ${error.message}`);
    }
    inserted++;
  }

  return { inserted, updated, skipped };
}

/** @deprecated Use upsertCaseMedicalRecords */
export async function insertCaseMedicalRecords(
  rows: CaseMedicalRecordInsert[]
): Promise<{ inserted: number; skipped: number }> {
  const result = await upsertCaseMedicalRecords(rows);
  return { inserted: result.inserted, skipped: result.skipped + result.updated };
}
