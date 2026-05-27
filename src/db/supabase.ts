import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
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

function dropboxRootForCase(caseNumber: string): string {
  const root = getEnv().DROPBOX_CASES_ROOT.replace(/\/+$/, '');
  return `${root}/${caseNumber}`.replace(/\/+/g, '/');
}

export function mapSlackChannelToCase(row: CaseSlackChannel): Case {
  return {
    id: row.case_number,
    case_number: row.case_number,
    slack_channel_name: row.slack_channel_name,
    slack_channel_id: row.slack_channel_id,
    topic_stage: row.topic_stage,
    dropbox_root_path: dropboxRootForCase(row.case_number),
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
  if (error) throw new Error(`Temp upload failed: ${error.message}`);

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
      `case_number.ilike.%${term}%,slack_channel_name.ilike.%${term}%`
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
  const { data, error } = await getSupabase()
    .from('case_slack_channels')
    .select('*')
    .or(`slack_channel_name.ilike.%${name}%,case_number.ilike.%${name}%`)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapSlackChannelToCase(data as CaseSlackChannel);
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
