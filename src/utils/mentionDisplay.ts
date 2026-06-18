import type { Case } from '../types/index.js';
import { getSlackUserDisplayNames } from '../services/slackUserDirectory.js';

/** Slack member IDs start with U (or legacy W). */
export function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{8,}$/i.test(value.trim());
}

/** Display names from `<@U123|Name>` in channel topics. */
export function slackTopicMentionNames(topicText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(topicText)) !== null) {
    const name = match[2]?.trim();
    if (name) out.set(match[1]!, name);
  }
  return out;
}

export function caseStaffDisplayName(
  caseRow: Case | null | undefined,
  userId: string
): string | null {
  if (!caseRow) return null;
  if (caseRow.attorney_slack_user_id === userId && caseRow.attorney_name?.trim()) {
    return caseRow.attorney_name.trim();
  }
  if (caseRow.paralegal_slack_user_id === userId && caseRow.paralegal_name?.trim()) {
    return caseRow.paralegal_name.trim();
  }
  return null;
}

export async function resolveMentionDisplayNames(
  userIds: string[],
  caseRow?: Case | null,
  topicText?: string | null
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  const fromApi = await getSlackUserDisplayNames(unique);
  const fromTopic = topicText?.trim() ? slackTopicMentionNames(topicText) : new Map<string, string>();
  const out = new Map<string, string>();

  for (const id of unique) {
    const topicName = fromTopic.get(id);
    if (topicName) {
      out.set(id, topicName);
      continue;
    }

    const apiName = fromApi.get(id) ?? id;
    if (!isSlackUserId(apiName)) {
      out.set(id, apiName);
      continue;
    }
    out.set(id, caseStaffDisplayName(caseRow, id) ?? apiName);
  }

  return out;
}

export function splitStoredTaggedNames(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Pair stored name parts with user IDs when both lists align and names are real. */
export function storedTaggedNameMap(
  userIds: string[],
  storedNames: string | null | undefined
): Map<string, string> | null {
  const names = splitStoredTaggedNames(storedNames);
  if (!names.length || names.length !== userIds.length) return null;
  if (names.some((name) => isSlackUserId(name))) return null;

  const map = new Map<string, string>();
  userIds.forEach((id, index) => map.set(id, names[index]!));
  return map;
}
