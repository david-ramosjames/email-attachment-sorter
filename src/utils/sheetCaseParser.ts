import { parseCaseNumberFromDropboxFolder } from '../constants/rjlFolders.js';

export interface ParsedSheetCase {
  case_number: string;
  slack_channel_name: string;
  slack_channel_id: string | null;
  topic_stage: string | null;
  dropbox_folder_name: string | null;
}

type CaseField = keyof ParsedSheetCase;

const COLUMN_ALIASES: Record<CaseField, string[]> = {
  case_number: [
    'case_number',
    'case number',
    'case#',
    'case #',
    'case_no',
    'case no',
    'case_num',
    'caseno',
    'number',
    'case',
    'matter_number',
    'matter number',
  ],
  slack_channel_name: [
    'slack_channel_name',
    'slack channel name',
    'slack channel',
    'channel_name',
    'channel name',
    'channel',
    'client',
    'client_name',
    'client name',
    'case_name',
    'case name',
    'matter',
    'matter_name',
    'pi_client',
    'name',
  ],
  slack_channel_id: [
    'slack_channel_id',
    'slack channel id',
    'channel_id',
    'channel id',
    'slack_id',
    'slack id',
  ],
  topic_stage: ['topic_stage', 'topic stage', 'stage', 'topic', 'status', 'case_stage'],
  dropbox_folder_name: [
    'dropbox_folder_name',
    'dropbox folder',
    'dropbox',
    'dropbox_folder',
    'folder',
    'dropbox_path',
  ],
};

function normalizeHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[#]/g, '');
}

function headerToField(header: string): CaseField | null {
  const norm = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [CaseField, string[]][]) {
    if (aliases.some((a) => norm === normalizeHeader(a))) return field;
  }
  return null;
}

function cellValue(row: string[], index: number): string | null {
  const v = row[index]?.trim();
  return v ? v : null;
}

/** Extract a case number from free text (e.g. "276. REGINA PEEK" or "276-regina-peek"). */
export function inferCaseNumber(
  explicit: string | null,
  channelName: string | null,
  dropboxFolder: string | null
): string | null {
  for (const raw of [explicit, dropboxFolder, channelName]) {
    if (!raw?.trim()) continue;
    const t = raw.trim();
    const fromDropbox = parseCaseNumberFromDropboxFolder(t);
    if (fromDropbox) return fromDropbox;
    const leading = t.match(/^(\d{1,6})\b/);
    if (leading) return leading[1]!;
  }
  if (explicit?.trim()) return explicit.trim();
  return null;
}

/**
 * Map a header row + data rows from Google Sheets into case records.
 * Skips rows without case_number and slack_channel_name.
 */
export function parseCaseRowsFromSheet(values: string[][]): {
  cases: ParsedSheetCase[];
  skippedRows: number;
  headerFields: Partial<Record<CaseField, number>>;
} {
  if (!values.length) {
    return { cases: [], skippedRows: 0, headerFields: {} };
  }

  const headerRow = values[0] ?? [];
  const headerFields: Partial<Record<CaseField, number>> = {};
  headerRow.forEach((cell, i) => {
    const field = headerToField(cell);
    if (field !== null && headerFields[field] === undefined) {
      headerFields[field] = i;
    }
  });

  const hasHeader = Object.keys(headerFields).length > 0;
  const dataRows = hasHeader ? values.slice(1) : values;

  const cases: ParsedSheetCase[] = [];
  let skippedRows = 0;

  for (const row of dataRows) {
    if (!row.some((c) => c?.trim())) {
      skippedRows++;
      continue;
    }

    const get = (field: CaseField): string | null => {
      const idx = headerFields[field];
      if (idx === undefined) return null;
      return cellValue(row, idx);
    };

    let caseNumber: string | null;
    let channelName: string | null;
    let channelId: string | null;
    let topicStage: string | null;
    let dropboxFolder: string | null;

    if (hasHeader) {
      caseNumber = get('case_number');
      channelName = get('slack_channel_name');
      channelId = get('slack_channel_id');
      topicStage = get('topic_stage');
      dropboxFolder = get('dropbox_folder_name');
    } else {
      caseNumber = cellValue(row, 0);
      channelName = cellValue(row, 1);
      channelId = cellValue(row, 2);
      topicStage = cellValue(row, 3);
      dropboxFolder = cellValue(row, 4);
    }

    caseNumber = inferCaseNumber(caseNumber, channelName, dropboxFolder);
    if (!channelName?.trim() && caseNumber) {
      channelName = caseNumber;
    }

    if (!caseNumber || !channelName?.trim()) {
      skippedRows++;
      continue;
    }

    cases.push({
      case_number: caseNumber,
      slack_channel_name: channelName.trim(),
      slack_channel_id: channelId,
      topic_stage: topicStage,
      dropbox_folder_name: dropboxFolder,
    });
  }

  return { cases, skippedRows, headerFields };
}
