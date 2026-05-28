import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { getCasesRootPath } from '../services/dropboxService.js';
import type {
  AuditEvent,
  Case,
  CaseFolder,
  CaseSlackChannel,
  FileSorterItem,
  FileSorterItemStatus,
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

export async function downloadTempAttachment(
  itemId: string,
  filename: string
): Promise<Buffer> {
  const supabase = getSupabase();
  const path = `${itemId}/${filename}`;
  const { data, error } = await supabase.storage.from(TEMP_BUCKET).download(path);
  if (error || !data) throw new Error(`Temp download failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
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

export async function createFileSorterItem(
  row: Omit<FileSorterItem, 'created_at' | 'updated_at'> & {
    status?: FileSorterItemStatus;
  }
): Promise<FileSorterItem> {
  const { data, error } = await getSupabase()
    .from('file_sorter_items')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`Create item failed: ${error.message}`);
  return data as FileSorterItem;
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
