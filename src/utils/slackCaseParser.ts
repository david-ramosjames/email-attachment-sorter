import { getEnv } from '../config/env.js';

export interface SlackChannelForCaseParse {
  id: string;
  name: string;
  isArchived: boolean;
}

export interface ParsedSlackCase {
  case_number: string;
  slack_channel_name: string;
  slack_channel_id: string;
  topic_stage: string | null;
  dropbox_folder_name: string | null;
}

const TRAILING_CASE_NUMBER = /-(\d{1,6})$/;
const LEADING_CASE_NUMBER = /^(\d{1,6})-/;

/**
 * Case Slack channels are usually named like `javiermejias-etal-625` or `276-regina-peek`.
 */
export function inferCaseNumberFromSlackChannel(channelName: string): string | null {
  const name = channelName.trim().toLowerCase();
  if (!name) return null;

  const trailing = name.match(TRAILING_CASE_NUMBER);
  if (trailing) return trailing[1]!;

  const leading = name.match(LEADING_CASE_NUMBER);
  if (leading) return leading[1]!;

  return null;
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

    const caseNumber = inferCaseNumberFromSlackChannel(ch.name);
    if (!caseNumber) {
      skippedChannels.push(ch.name);
      continue;
    }

    const row: ParsedSlackCase = {
      case_number: caseNumber,
      slack_channel_name: ch.name,
      slack_channel_id: ch.id,
      topic_stage: null,
      dropbox_folder_name: null,
    };

    const existing = byCaseNumber.get(caseNumber);
    if (existing) {
      duplicateCaseNumbers.push(caseNumber);
      // Prefer the longer / more descriptive channel name
      if (ch.name.length > existing.slack_channel_name.length) {
        byCaseNumber.set(caseNumber, row);
      }
    } else {
      byCaseNumber.set(caseNumber, row);
    }
  }

  return {
    cases: [...byCaseNumber.values()],
    skippedChannels: skippedChannels.slice(0, 50),
    duplicateCaseNumbers: [...new Set(duplicateCaseNumbers)],
  };
}
