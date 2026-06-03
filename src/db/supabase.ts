import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { getCasesRootPath } from '../services/dropboxService.js';
import {
  formatCauseNumberCaseHint,
  hintTextContainsCauseNumber,
} from '../utils/causeNumbers.js';
import type {
  AuditEvent,
  Case,
  CaseFolder,
  CaseSlackChannel,
  FileSorterItem,
  FileSorterItemStatus,
  MatchingHint,
} from '../types/index.js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const env = getEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

function dropboxRootForCase(row: CaseSlackChannel): string {
  const root = getCasesRootPath().replace(/\/+$/, '');
  const folderName = row.dropbox_folder_name ?? row.case_number;
  return `${root}/${folderName}`.replace(/\/+/g, '/');
}

export function mapSlackChannelToCase(row: CaseSlackChannel): Case {
  return {
    id: row.case_number,
    case_number: row.case_number,
    slack_channel_name: row.slack_channel_name,
    slack_channel_id: row.slack_channel_id,
    topic_stage: row.topic_stage,
    dropbox_root_path: dropboxRootForCase(row),
    dropbox_folder_name: row.dropbox_folder_name,
  };
}

const TEMP_BUCKET = 'file-sorter-temp';

export async function uploadTempAttachment(
  itemId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const supabase = getSupabase();
  const path = `${itemId}/${filename}`;
  const { error } = await supabase.storage
    .from(TEMP_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) {
    throw new Error(
      `Temp upload failed (bucket "${TEMP_BUCKET}"): ${error.message}. Create the bucket in Supabase Storage.`
    );
  }

  const { data } = supabase.storage.from(TEMP_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEMP_DOWNLOAD_TIMEOUT_MS = 120_000;

async function downloadTempViaSignedUrl(
  supabase: SupabaseClient,
  path: string
): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from(TEMP_BUCKET)
    .createSignedUrl(path, 300);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'Could not create signed download URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEMP_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(data.signedUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Signed download HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Temp download timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadTempAttachment(
  itemId: string,
  filename: string,
  options?: { maxAttempts?: number }
): Promise<Buffer> {
  const supabase = getSupabase();
  const path = `${itemId}/${filename}`;
  const maxAttempts = options?.maxAttempts ?? 3;
  let lastMessage = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadTempViaSignedUrl(supabase, path);
    } catch (signedErr) {
      lastMessage =
        signedErr instanceof Error ? signedErr.message : String(signedErr);

      try {
        const { data, error } = await supabase.storage.from(TEMP_BUCKET).download(path);
        if (!error && data) {
          return Buffer.from(await data.arrayBuffer());
        }
        lastMessage = error?.message ?? lastMessage;
      } catch (directErr) {
        lastMessage =
          directErr instanceof Error ? directErr.message : String(directErr);
      }
    }

    const retryable = /timeout|timed out|aborted|ECONNRESET|fetch failed|502|503|504/i.test(
      lastMessage
    );
    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `Temp download failed: ${lastMessage} (bucket "${TEMP_BUCKET}", path "${path}")`
      );
    }
    await sleep(1000 * attempt);
  }

  throw new Error(`Temp download failed: ${lastMessage}`);
}

export async function deleteTempAttachment(itemId: string, filename: string): Promise<void> {
  const supabase = getSupabase();
  const path = `${itemId}/${filename}`;
  const { error } = await supabase.storage.from(TEMP_BUCKET).remove([path]);
  if (error) {
    throw new Error(`Temp delete failed: ${error.message} (path "${path}")`);
  }
}

export async function searchCases(query: {
  caseNumber?: string;
  keywords?: string[];
}): Promise<Case[]> {
  const supabase = getSupabase();
  let q = supabase.from('case_slack_channels').select('*');

  if (query.caseNumber) {
    q = q.ilike('case_number', `%${query.caseNumber}%`);
  } else if (query.keywords?.length) {
    const term = query.keywords[0];
    q = q.or(
      `case_number.ilike.%${term}%,slack_channel_name.ilike.%${term}%,dropbox_folder_name.ilike.%${term}%`
    );
  } else {
    const { data, error } = await supabase
      .from('case_slack_channels')
      .select('*')
      .limit(50);
    if (error) throw new Error(`Case search failed: ${error.message}`);
    return (data ?? []).map((row) => mapSlackChannelToCase(row as CaseSlackChannel));
  }

  const { data, error } = await q.limit(20);
  if (error) throw new Error(`Case search failed: ${error.message}`);
  return (data ?? []).map((row) => mapSlackChannelToCase(row as CaseSlackChannel));
}

/** @param caseNumber case_slack_channels.case_number */
export async function getCaseById(caseNumber: string): Promise<Case | null> {
  const { data, error } = await getSupabase()
    .from('case_slack_channels')
    .select('*')
    .eq('case_number', caseNumber)
    .maybeSingle();
  if (error || !data) return null;
  return mapSlackChannelToCase(data as CaseSlackChannel);
}

export async function getSlackChannelForCase(
  caseNumber: string | null | undefined
): Promise<CaseSlackChannel | null> {
  if (!caseNumber) return null;
  const { data, error } = await getSupabase()
    .from('case_slack_channels')
    .select('*')
    .eq('case_number', caseNumber)
    .maybeSingle();
  if (error) return null;
  return data as CaseSlackChannel | null;
}

export async function getCaseByName(name: string): Promise<Case | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const exact = await getCaseById(trimmed);
  if (exact) return exact;

  const { data, error } = await getSupabase()
    .from('case_slack_channels')
    .select('*')
    .or(`slack_channel_name.ilike.%${trimmed}%,case_number.ilike.%${trimmed}%`)
    .limit(1)
    .maybeSingle();
  if (!error && data) return mapSlackChannelToCase(data as CaseSlackChannel);

  const tokens = trimmed
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 1);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]!;
    const candidates = await searchCases({ keywords: [last] });
    const hits = candidates.filter((c) => {
      const hay = [c.slack_channel_name, c.dropbox_folder_name ?? '', c.case_number]
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      const channelMatch = hits.find((c) =>
        tokens.every((t) => c.slack_channel_name.toLowerCase().includes(t))
      );
      return channelMatch ?? hits[0]!;
    }
  }

  return null;
}

export async function updateCaseSlackChannelId(
  caseNumber: string,
  slackChannelId: string
): Promise<void> {
  const { error } = await getSupabase()
    .from('case_slack_channels')
    .update({ slack_channel_id: slackChannelId, updated_at: new Date().toISOString() })
    .eq('case_number', caseNumber);
  if (error) throw new Error(`Update slack channel id failed: ${error.message}`);
}

export async function updateCaseDropboxFolderName(
  caseNumber: string,
  dropboxFolderName: string
): Promise<void> {
  const { error } = await getSupabase()
    .from('case_slack_channels')
    .update({ dropbox_folder_name: dropboxFolderName, updated_at: new Date().toISOString() })
    .eq('case_number', caseNumber);
  if (error) throw new Error(`Update dropbox folder failed: ${error.message}`);
}

export async function getFoldersForCase(caseNumber: string): Promise<CaseFolder[]> {
  const { data, error } = await getSupabase()
    .from('case_folders')
    .select('*')
    .eq('case_number', caseNumber);
  if (error) {
    // case_folders is optional until Dropbox reindex is run
    return [];
  }
  return (data ?? []) as CaseFolder[];
}

export async function listAllCases(): Promise<Case[]> {
  return listCases();
}

export async function getSenderHistory(fromEmail: string): Promise<string[]> {
  const { data } = await getSupabase()
    .from('file_sorter_items')
    .select('final_case_number')
    .eq('from_email', fromEmail)
    .eq('status', 'saved')
    .not('final_case_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);
  const ids = (data ?? [])
    .map((r) => r.final_case_number as string)
    .filter(Boolean);
  return [...new Set(ids)];
}

function isMissingMatchingHintsTable(error: { message?: string }): boolean {
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('matching_hints') && (msg.includes('does not exist') || msg.includes('schema cache'));
}

function normalizeSenderEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapMatchingHintRow(row: {
  id: string;
  hint_type?: string;
  case_number: string | null;
  sender_email: string | null;
  hint_text: string;
  source?: string;
}): MatchingHint {
  return {
    id: row.id,
    hintType: row.hint_type === 'sort' ? 'sort' : 'case',
    caseNumber: row.case_number,
    senderEmail: row.sender_email,
    hintText: row.hint_text,
    source: row.source,
  };
}

const MATCHING_HINT_COLUMNS = 'id, hint_type, case_number, sender_email, hint_text, source';

/** Case-matching hints for this sender (who the client is). */
export async function getCaseHintsForSender(fromEmail: string): Promise<MatchingHint[]> {
  const sender = normalizeSenderEmail(fromEmail);
  const { data, error } = await getSupabase()
    .from('matching_hints')
    .select(MATCHING_HINT_COLUMNS)
    .eq('sender_email', sender)
    .eq('hint_type', 'case')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingMatchingHintsTable(error)) return [];
    throw new Error(`Case hints lookup failed: ${error.message}`);
  }
  return (data ?? []).map(mapMatchingHintRow);
}

/** Document-sorting hints for this sender (folder, type, ignore). */
export async function getSortHintsForSender(fromEmail: string): Promise<MatchingHint[]> {
  const sender = normalizeSenderEmail(fromEmail);
  const { data, error } = await getSupabase()
    .from('matching_hints')
    .select(MATCHING_HINT_COLUMNS)
    .eq('sender_email', sender)
    .eq('hint_type', 'sort')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingMatchingHintsTable(error)) return [];
    throw new Error(`Sort hints lookup failed: ${error.message}`);
  }
  return (data ?? []).map(mapMatchingHintRow);
}

/** General case identity notes (no sender). */
export async function getCaseHintsForCases(caseNumbers: string[]): Promise<MatchingHint[]> {
  const unique = [...new Set(caseNumbers.filter(Boolean))];
  if (!unique.length) return [];

  const { data, error } = await getSupabase()
    .from('matching_hints')
    .select(MATCHING_HINT_COLUMNS)
    .in('case_number', unique)
    .eq('hint_type', 'case')
    .is('sender_email', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingMatchingHintsTable(error)) return [];
    throw new Error(`Case notes lookup failed: ${error.message}`);
  }
  return (data ?? []).map(mapMatchingHintRow);
}

export async function upsertSenderCaseHint(params: {
  caseNumber: string;
  senderEmail: string;
  hintText: string;
  source: string;
  createdBy?: string;
}): Promise<void> {
  await upsertMatchingHint({
    hintType: 'case',
    caseNumber: params.caseNumber,
    senderEmail: params.senderEmail,
    hintText: params.hintText,
    source: params.source,
    createdBy: params.createdBy,
  });
}

export async function upsertSenderSortHint(params: {
  senderEmail: string;
  hintText: string;
  source: string;
  caseNumber?: string | null;
  createdBy?: string;
}): Promise<void> {
  await upsertMatchingHint({
    hintType: 'sort',
    caseNumber: params.caseNumber ?? null,
    senderEmail: params.senderEmail,
    hintText: params.hintText,
    source: params.source,
    createdBy: params.createdBy,
  });
}

export async function addCaseOnlyHint(params: {
  caseNumber: string;
  hintText: string;
  source: string;
  createdBy?: string;
}): Promise<void> {
  const hintText = params.hintText.trim();
  if (!hintText) return;

  const { error } = await getSupabase().from('matching_hints').insert({
    hint_type: 'case',
    case_number: params.caseNumber,
    sender_email: null,
    hint_text: hintText,
    source: params.source,
    created_by: params.createdBy ?? null,
  });
  if (error) throw new Error(`Insert case-only hint failed: ${error.message}`);
}

/** Case hints that mention extracted Cause numbers (litigation matching). */
export async function getCaseHintsForCauseNumbers(causeNumbers: string[]): Promise<MatchingHint[]> {
  const unique = [...new Set(causeNumbers.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!unique.length) return [];

  const merged: MatchingHint[] = [];
  const seen = new Set<string>();

  for (const causeNumber of unique) {
    const { data, error } = await getSupabase()
      .from('matching_hints')
      .select(MATCHING_HINT_COLUMNS)
      .eq('hint_type', 'case')
      .ilike('hint_text', `%${causeNumber}%`);

    if (error) {
      if (isMissingMatchingHintsTable(error)) return [];
      throw new Error(`Cause hint lookup failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      const hint = mapMatchingHintRow(row);
      const key = `${hint.caseNumber ?? ''}|${hint.hintText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hint);
    }
  }

  return merged;
}

/** Save a Teach Case hint linking a Cause number to a case (idempotent). Returns true if inserted. */
export async function upsertCauseNumberCaseHint(params: {
  caseNumber: string;
  causeNumber: string;
  source: string;
  createdBy?: string;
}): Promise<boolean> {
  const hintText = formatCauseNumberCaseHint(params.causeNumber, params.caseNumber);
  const { data: existing, error: listError } = await getSupabase()
    .from('matching_hints')
    .select('id, hint_text')
    .eq('hint_type', 'case')
    .eq('case_number', params.caseNumber)
    .is('sender_email', null);

  if (listError) {
    if (isMissingMatchingHintsTable(listError)) return false;
    throw new Error(`Cause hint lookup failed: ${listError.message}`);
  }

  const duplicate = (existing ?? []).some((row) =>
    hintTextContainsCauseNumber(String(row.hint_text ?? ''), params.causeNumber)
  );
  if (duplicate) return false;

  await addCaseOnlyHint({
    caseNumber: params.caseNumber,
    hintText,
    source: params.source,
    createdBy: params.createdBy,
  });
  return true;
}

async function upsertMatchingHint(params: {
  hintType: MatchingHint['hintType'];
  caseNumber: string | null;
  senderEmail: string;
  hintText: string;
  source: string;
  createdBy?: string;
}): Promise<void> {
  const sender = normalizeSenderEmail(params.senderEmail);
  const hintText = params.hintText.trim();
  if (!hintText) return;

  let query = getSupabase()
    .from('matching_hints')
    .select('id')
    .eq('sender_email', sender)
    .eq('hint_type', params.hintType);

  if (params.hintType === 'case') {
    query = query.eq('case_number', params.caseNumber!);
  } else {
    query = params.caseNumber
      ? query.eq('case_number', params.caseNumber)
      : query.is('case_number', null);
  }

  const { data: existing } = await query.maybeSingle();

  if (existing?.id) {
    const { error } = await getSupabase()
      .from('matching_hints')
      .update({
        hint_text: hintText,
        source: params.source,
        created_by: params.createdBy ?? null,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`Update matching hint failed: ${error.message}`);
    return;
  }

  const { error } = await getSupabase().from('matching_hints').insert({
    hint_type: params.hintType,
    case_number: params.caseNumber,
    sender_email: sender,
    hint_text: hintText,
    source: params.source,
    created_by: params.createdBy ?? null,
  });
  if (error) throw new Error(`Insert matching hint failed: ${error.message}`);
}

export async function listMatchingHints(opts?: {
  hintType?: MatchingHint['hintType'];
  caseNumber?: string;
  senderEmail?: string;
  limit?: number;
}): Promise<MatchingHint[]> {
  let q = getSupabase()
    .from('matching_hints')
    .select(MATCHING_HINT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 100);

  if (opts?.hintType) q = q.eq('hint_type', opts.hintType);
  if (opts?.caseNumber) q = q.eq('case_number', opts.caseNumber);
  if (opts?.senderEmail) q = q.eq('sender_email', normalizeSenderEmail(opts.senderEmail));

  const { data, error } = await q;
  if (error) {
    if (isMissingMatchingHintsTable(error)) return [];
    throw new Error(`List matching hints failed: ${error.message}`);
  }
  return (data ?? []).map(mapMatchingHintRow);
}

/** @deprecated use getCaseHintsForSender or getSortHintsForSender */
export async function getMatchingHintsForSender(fromEmail: string): Promise<MatchingHint[]> {
  return getCaseHintsForSender(fromEmail);
}

/** @deprecated use getCaseHintsForCases */
export async function getMatchingHintsForCases(caseNumbers: string[]): Promise<MatchingHint[]> {
  return getCaseHintsForCases(caseNumbers);
}

/** @deprecated use upsertSenderCaseHint */
export async function upsertSenderMatchingHint(params: {
  caseNumber: string;
  senderEmail: string;
  hintText: string;
  source: string;
  createdBy?: string;
}): Promise<void> {
  return upsertSenderCaseHint(params);
}

/** @deprecated use addCaseOnlyHint */
export async function addCaseMatchingHint(params: {
  caseNumber: string;
  hintText: string;
  source: string;
  createdBy?: string;
}): Promise<void> {
  return addCaseOnlyHint(params);
}

export async function getFileSorterItemByGmailAttachment(
  gmailMessageId: string,
  attachmentFilename: string
): Promise<FileSorterItem | null> {
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .eq('gmail_message_id', gmailMessageId)
    .eq('attachment_filename', attachmentFilename)
    .maybeSingle();
  if (error) return null;
  return data as FileSorterItem | null;
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '23505' ||
    (error.message?.includes('duplicate key') ?? false) ||
    (error.message?.includes('file_sorter_items_gmail_message_id_attachment_filename_key') ??
      false)
  );
}

function isMissingColumnError(error: { message?: string }, column: string): boolean {
  const msg = (error.message ?? '').toLowerCase();
  const col = column.toLowerCase();
  return (
    msg.includes(col) &&
    (msg.includes('column') || msg.includes('schema cache') || msg.includes('does not exist'))
  );
}

/** Insert a row, or return the existing row if this Gmail attachment was already queued. */
export async function createFileSorterItemIfNew(
  row: Omit<FileSorterItem, 'created_at' | 'updated_at'> & {
    status?: FileSorterItemStatus;
  }
): Promise<{ item: FileSorterItem; created: boolean }> {
  const attemptInsert = async (
    insertRow: Omit<FileSorterItem, 'created_at' | 'updated_at'> & {
      status?: FileSorterItemStatus;
    }
  ) =>
    getSupabase().from('file_sorter_items').insert(insertRow).select().single();

  let insertRow = row;
  let { data, error } = await attemptInsert(insertRow);

  if (
    error &&
    (isMissingColumnError(error, 'ai_case_confidence') ||
      isMissingColumnError(error, 'ai_folder_confidence'))
  ) {
    const { ai_case_confidence: _c, ai_folder_confidence: _f, ...withoutSplitConfidence } =
      insertRow;
    insertRow = withoutSplitConfidence as typeof insertRow;
    ({ data, error } = await attemptInsert(insertRow));
  }

  if (
    error &&
    insertRow.email_received_at != null &&
    isMissingColumnError(error, 'email_received_at')
  ) {
    const { email_received_at: _dropped, ...withoutReceivedAt } = insertRow;
    insertRow = withoutReceivedAt as typeof insertRow;
    ({ data, error } = await attemptInsert(insertRow));
  }

  if (!error) {
    return { item: data as FileSorterItem, created: true };
  }

  if (isUniqueViolation(error)) {
    const existing = await getFileSorterItemByGmailAttachment(
      row.gmail_message_id,
      row.attachment_filename
    );
    if (existing) return { item: existing, created: false };
  }

  throw new Error(`Create item failed: ${error.message}`);
}

export async function createFileSorterItem(
  row: Omit<FileSorterItem, 'created_at' | 'updated_at'> & {
    status?: FileSorterItemStatus;
  }
): Promise<FileSorterItem> {
  const { item } = await createFileSorterItemIfNew(row);
  return item;
}

export async function updateFileSorterItem(
  id: string,
  patch: Partial<FileSorterItem>
): Promise<FileSorterItem> {
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`Update item failed: ${error.message}`);
  return data as FileSorterItem;
}

export async function getFileSorterItem(id: string): Promise<FileSorterItem | null> {
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as FileSorterItem;
}

/** All items sharing the same Slack queue message (one email batch card). */
export async function getQueueBatchItems(item: FileSorterItem): Promise<FileSorterItem[]> {
  if (!item.slack_queue_channel_id || !item.slack_queue_message_ts) {
    return [item];
  }
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .eq('slack_queue_channel_id', item.slack_queue_channel_id)
    .eq('slack_queue_message_ts', item.slack_queue_message_ts)
    .order('created_at', { ascending: true });
  if (error || !data?.length) return [item];
  return data as FileSorterItem[];
}

/** Pending queue items for a Slack thread (batch card root message). */
export async function getPendingQueueItemsByThread(
  channelId: string,
  threadTs: string
): Promise<FileSorterItem[]> {
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .eq('slack_queue_channel_id', channelId)
    .eq('slack_queue_message_ts', threadTs)
    .in('status', ['pending_review', 'approved', 'needs_attention', 'failed'])
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Queue thread lookup failed: ${error.message}`);
  return (data ?? []) as FileSorterItem[];
}

const UNROUTED_TEMP_STATUSES: FileSorterItemStatus[] = [
  'pending_review',
  'approved',
  'needs_attention',
  'failed',
];

/** Routed items ready to drop from temp (reviewed_at past grace window). */
export async function listRoutedTempStorageReadyForDeletion(
  minutesAfterRouted: number
): Promise<FileSorterItem[]> {
  const cutoff = new Date(Date.now() - minutesAfterRouted * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .eq('status', 'saved')
    .not('temp_storage_url', 'is', null)
    .not('reviewed_at', 'is', null)
    .lt('reviewed_at', cutoff)
    .order('reviewed_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(`List routed temp items failed: ${error.message}`);
  return (data ?? []) as FileSorterItem[];
}

/** Unrouted queue items past retention (e.g. weekend backlog). */
export async function listUnroutedTempStorageExpired(hours: number): Promise<FileSorterItem[]> {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .select('*')
    .in('status', UNROUTED_TEMP_STATUSES)
    .not('temp_storage_url', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(`List unrouted temp items failed: ${error.message}`);
  return (data ?? []) as FileSorterItem[];
}

export async function listFileSorterItems(opts?: {
  status?: FileSorterItemStatus;
  limit?: number;
}): Promise<FileSorterItem[]> {
  let q = getSupabase()
    .from('file_sorter_items')
    .select('*')
    .order('created_at', { ascending: false });
  if (opts?.status) q = q.eq('status', opts.status);
  if (opts?.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`List items failed: ${error.message}`);
  return (data ?? []) as FileSorterItem[];
}

export async function listCases(): Promise<Case[]> {
  const { data, error } = await getSupabase()
    .from('case_slack_channels')
    .select('*')
    .order('case_number');
  if (error) throw new Error(`List cases failed: ${error.message}`);
  return (data ?? []).map((row) => mapSlackChannelToCase(row as CaseSlackChannel));
}

export async function batchUpsertCaseSlackChannels(
  rows: Array<{
    case_number: string;
    slack_channel_name: string;
    slack_channel_id?: string | null;
    topic_stage?: string | null;
    dropbox_folder_name?: string | null;
  }>,
  options?: { preserveDropboxFolder?: boolean }
): Promise<number> {
  if (!rows.length) return 0;
  const now = new Date().toISOString();

  let dropboxByCase = new Map<string, string | null>();
  if (options?.preserveDropboxFolder) {
    const caseNumbers = [...new Set(rows.map((r) => r.case_number))];
    for (let i = 0; i < caseNumbers.length; i += 200) {
      const chunk = caseNumbers.slice(i, i + 200);
      const { data, error } = await getSupabase()
        .from('case_slack_channels')
        .select('case_number, dropbox_folder_name')
        .in('case_number', chunk);
      if (error) throw new Error(`Case lookup failed: ${error.message}`);
      for (const row of data ?? []) {
        dropboxByCase.set(row.case_number, row.dropbox_folder_name ?? null);
      }
    }
  }

  const payload = rows.map((r) => ({
    case_number: r.case_number,
    slack_channel_name: r.slack_channel_name,
    slack_channel_id: r.slack_channel_id ?? null,
    topic_stage: r.topic_stage ?? null,
    dropbox_folder_name: options?.preserveDropboxFolder
      ? (r.dropbox_folder_name ?? dropboxByCase.get(r.case_number) ?? null)
      : (r.dropbox_folder_name ?? null),
    synced_at: now,
    updated_at: now,
  }));

  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await getSupabase()
      .from('case_slack_channels')
      .upsert(chunk, { onConflict: 'case_number' });
    if (error) throw new Error(`Batch upsert cases failed: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

export async function batchUpsertCaseFolders(
  rows: Array<{ case_number: string; folder_label: string; dropbox_path: string }>
): Promise<number> {
  if (!rows.length) return 0;
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await getSupabase()
      .from('case_folders')
      .upsert(chunk, { onConflict: 'case_number,folder_label' });
    if (error) throw new Error(`Batch upsert folders failed: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

export async function upsertCaseFolder(
  caseNumber: string,
  folderLabel: string,
  dropboxPath: string
): Promise<CaseFolder> {
  const { data, error } = await getSupabase()
    .from('case_folders')
    .upsert(
      { case_number: caseNumber, folder_label: folderLabel, dropbox_path: dropboxPath },
      { onConflict: 'case_number,folder_label' }
    )
    .select()
    .single();
  if (error) throw new Error(`Upsert folder failed: ${error.message}`);
  return data as CaseFolder;
}

export async function createAuditEvent(
  fileSorterItemId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdBy?: string
): Promise<AuditEvent> {
  const { data, error } = await getSupabase()
    .from('audit_events')
    .insert({
      file_sorter_item_id: fileSorterItemId,
      event_type: eventType,
      payload,
      created_by: createdBy ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Audit event failed: ${error.message}`);
  return data as AuditEvent;
}

export async function listAuditEvents(itemId: string): Promise<AuditEvent[]> {
  const { data, error } = await getSupabase()
    .from('audit_events')
    .select('*')
    .eq('file_sorter_item_id', itemId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`List audit failed: ${error.message}`);
  return (data ?? []) as AuditEvent[];
}
