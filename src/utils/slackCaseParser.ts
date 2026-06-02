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

/** Status text inside parentheses in the channel topic, e.g. "(Pre-Lit)". */
export function parseStatusFromTopic(topicText: string): string {
  const source = String(topicText || '').trim();
  const match = source.match(/\(([^)]+)\)/);
  return match?.[1]?.trim() ?? '';
}

export function parseChannelAndTopic(data: {
  channelId: string;
  channelName: string;
  topic?: string;
}): ParsedSlackCase | null {
  const caseInfo = parseCaseFromChannelName(data.channelName);
  if (!caseInfo.caseNumber) return null;

  const status = parseStatusFromTopic(data.topic ?? '');

  return {
    case_number: caseInfo.caseNumber,
    slack_channel_name: data.channelName,
    slack_channel_id: data.channelId,
    case_name: caseInfo.caseName,
    topic_stage: status || null,
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
