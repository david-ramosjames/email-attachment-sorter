import { getEnv } from '../config/env.js';

export interface SlackChannelForCaseParse {
  id: string;
  name: string;
  isArchived: boolean;
  topic?: string;
}

export interface ParsedSlackCase {
  case_number: string;
  slack_channel_name: string;
  slack_channel_id: string;
  /** Client display name parsed from channel slug (e.g. "Regina Peek Etal 3") */
  case_name: string;
  topic_stage: string | null;
  attorney_slack_user_id: string | null;
  attorney_name: string | null;
  paralegal_slack_user_id: string | null;
  paralegal_name: string | null;
  dropbox_folder_name: string | null;
}

/** Same rule as the Google Apps Script: `clientname-etal-625` → case 625 */
const CASE_CHANNEL_NAME = /^(.*)-(\d+)$/;

export function parseCaseFromChannelName(channelName: string): {
  caseNumber: string;
  caseName: string;
} {
  const normalized = String(channelName || '').trim().toLowerCase();
  const match = normalized.match(CASE_CHANNEL_NAME);

  if (!match) {
    return { caseNumber: '', caseName: '' };
  }

  const rawName = match[1]!;
  const caseNumber = match[2]!;

  const caseName = toTitleCase(
    rawName
      .replace(/_+/g, ' ')
      .replace(/-+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  return { caseNumber, caseName };
}

/** Status text inside parentheses in the channel topic, e.g. "(Pre-Lit)" or "(settled)". */
export function parseStatusFromTopic(topicText: string): string {
  const source = String(topicText || '').trim();
  const match = source.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() ?? source.match(/\(([^)]+)\)/)?.[1]?.trim() ?? '';
}

export interface ParsedTopicStaff {
  attorney_slack_user_id: string | null;
  attorney_name: string | null;
  paralegal_slack_user_id: string | null;
  paralegal_name: string | null;
}

function parseLabeledStaffFromTopic(
  topicText: string,
  label: 'attorney' | 'paralegal'
): { slackUserId: string | null; name: string | null } {
  const source = String(topicText || '').trim();
  if (!source) return { slackUserId: null, name: null };

  const mrkdwn = new RegExp(
    `${label}\\s*[:\\-]?\\s*<@([UW][A-Z0-9]+)(?:\\|([^>]+))?>`,
    'i'
  );
  const mrkdwnMatch = source.match(mrkdwn);
  if (mrkdwnMatch) {
    return {
      slackUserId: mrkdwnMatch[1]!.trim(),
      name: mrkdwnMatch[2]?.trim() || null,
    };
  }

  const plain = new RegExp(
    `${label}\\s*[:\\-]?\\s*@([A-Za-z][A-Za-z0-9._-]*)`,
    'i'
  );
  const plainMatch = source.match(plain);
  if (plainMatch) {
    return { slackUserId: null, name: plainMatch[1]!.trim() };
  }

  return { slackUserId: null, name: null };
}

/** Attorney / paralegal from channel topic, e.g. "Attorney @Ryan | Paralegal @Jorge (settled)". */
export function parseStaffFromTopic(topicText: string): ParsedTopicStaff {
  const attorney = parseLabeledStaffFromTopic(topicText, 'attorney');
  const paralegal = parseLabeledStaffFromTopic(topicText, 'paralegal');
  return {
    attorney_slack_user_id: attorney.slackUserId,
    attorney_name: attorney.name,
    paralegal_slack_user_id: paralegal.slackUserId,
    paralegal_name: paralegal.name,
  };
}

/** User IDs from Slack topic mrkdwn, e.g. `<@U123>` or `<@U123|Jesus>`. */
export function parseUserMentionsFromSlackTopic(topicText: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const re = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(topicText)) !== null) {
    const id = match[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function parseChannelAndTopic(data: {
  channelId: string;
  channelName: string;
  topic?: string;
}): ParsedSlackCase | null {
  const caseInfo = parseCaseFromChannelName(data.channelName);
  if (!caseInfo.caseNumber) return null;

  const status = parseStatusFromTopic(data.topic ?? '');
  const staff = parseStaffFromTopic(data.topic ?? '');

  return {
    case_number: caseInfo.caseNumber,
    slack_channel_name: data.channelName,
    slack_channel_id: data.channelId,
    case_name: caseInfo.caseName,
    topic_stage: status || null,
    attorney_slack_user_id: staff.attorney_slack_user_id,
    attorney_name: staff.attorney_name,
    paralegal_slack_user_id: staff.paralegal_slack_user_id,
    paralegal_name: staff.paralegal_name,
    dropbox_folder_name: null,
  };
}

function toTitleCase(str: string): string {
  return String(str || '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function excludedChannelNames(): Set<string> {
  const fromEnv = getEnv().SLACK_CASE_CHANNEL_EXCLUDE_NAMES;
  const defaults = ['general', 'random'];
  const names = [...defaults, ...fromEnv.split(',')]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return new Set(names);
}

export function parseCasesFromSlackChannels(channels: SlackChannelForCaseParse[]): {
  cases: ParsedSlackCase[];
  skippedChannels: string[];
  duplicateCaseNumbers: string[];
} {
  const queueChannelId = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
  const excludeNames = excludedChannelNames();
  const skippedChannels: string[] = [];
  const byCaseNumber = new Map<string, ParsedSlackCase>();
  const duplicateCaseNumbers: string[] = [];

  for (const ch of channels) {
    if (ch.isArchived) {
      skippedChannels.push(ch.name);
      continue;
    }
    if (ch.id === queueChannelId) {
      skippedChannels.push(ch.name);
      continue;
    }
    if (excludeNames.has(ch.name.toLowerCase())) {
      skippedChannels.push(ch.name);
      continue;
    }

    const parsed = parseChannelAndTopic({
      channelId: ch.id,
      channelName: ch.name,
      topic: ch.topic,
    });

    if (!parsed) {
      skippedChannels.push(ch.name);
      continue;
    }

    const existing = byCaseNumber.get(parsed.case_number);
    if (existing) {
      duplicateCaseNumbers.push(parsed.case_number);
      if (ch.name.length > existing.slack_channel_name.length) {
        byCaseNumber.set(parsed.case_number, parsed);
      }
    } else {
      byCaseNumber.set(parsed.case_number, parsed);
    }
  }

  return {
    cases: [...byCaseNumber.values()],
    skippedChannels: skippedChannels.slice(0, 50),
    duplicateCaseNumbers: [...new Set(duplicateCaseNumbers)],
  };
}
