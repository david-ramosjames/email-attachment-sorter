import type { Case, ClientIdentity } from '../types/index.js';

/** "lourdes galeas" → "lourdesgaleas" for matching slack channel slugs */
export function compactAlpha(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** How many name tokens appear in channel, folder, or case number fields */
export function countTokenHitsInCase(caseRow: Case, tokens: string[]): number {
  const channel = caseRow.slack_channel_name.toLowerCase();
  const folder = (caseRow.dropbox_folder_name ?? '').toLowerCase();
  const caseNum = caseRow.case_number.toLowerCase();
  const channelCompact = compactAlpha(channel);
  const folderCompact = compactAlpha(folder);

  return tokens.filter((t) => {
    if (t.length < 3) return false;
    return (
      channel.includes(t) ||
      folder.includes(t) ||
      caseNum.includes(t) ||
      channelCompact.includes(t) ||
      folderCompact.includes(t)
    );
  }).length;
}

/**
 * True when the case channel clearly belongs to a different person
 * (e.g. Israel Mejia vs javiermejias-etal-625 — only partial "mejia" in "mejias").
 */
export function identityConflictsWithCase(caseRow: Case, identity: ClientIdentity): boolean {
  const tokens = identity.nameTokens.filter((t) => t.length >= 3);
  if (tokens.length < 2 || !identity.clientFullName) return false;

  const haystack = [
    caseRow.slack_channel_name,
    caseRow.dropbox_folder_name ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const haystackCompact = compactAlpha(haystack);

  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  const firstHit =
    haystack.includes(first) ||
    haystackCompact.includes(first) ||
    (first.length >= 5 && haystackCompact.includes(compactAlpha(first).slice(0, 5)));
  const lastHit = haystack.includes(last) || haystackCompact.includes(last);

  if (lastHit && !firstHit && first.length >= 4) {
    return true;
  }

  if (!lastHit && !firstHit) {
    return true;
  }

  const nameCompact = compactAlpha(identity.clientFullName);
  if (nameCompact.length >= 8 && !haystackCompact.includes(nameCompact.slice(0, 8))) {
    const hits = countTokenHitsInCase(caseRow, tokens);
    if (hits < 2) return true;
  }

  return false;
}

export function caseMatchesClientIdentity(caseRow: Case, identity: ClientIdentity): boolean {
  if (identityConflictsWithCase(caseRow, identity)) return false;
  if (!identity.nameTokens.length && !identity.slackChannelHint) return false;

  const channel = caseRow.slack_channel_name.toLowerCase();

  if (identity.slackChannelHint) {
    const hint = identity.slackChannelHint.toLowerCase();
    if (channel.includes(hint) || hint.includes(channel.replace(/[^a-z0-9-]/g, ''))) {
      return true;
    }
  }

  if (identity.caseNumberHint && caseRow.case_number === identity.caseNumberHint) {
    const hits = countTokenHitsInCase(caseRow, identity.nameTokens);
    if (hits >= 2 || identity.nameTokens.length === 0) return true;
  }

  if (identity.clientFullName) {
    const nameCompact = compactAlpha(identity.clientFullName);
    const channelCompact = compactAlpha(channel);
    if (nameCompact.length >= 8 && channelCompact.includes(nameCompact.slice(0, 10))) {
      return true;
    }
    if (channelCompact.includes(nameCompact)) return true;
  }

  const hits = countTokenHitsInCase(caseRow, identity.nameTokens);
  if (identity.nameTokens.length >= 2 && hits >= 2) return true;

  return false;
}

export function scoreCaseForClientIdentity(caseRow: Case, identity: ClientIdentity): number {
  if (identityConflictsWithCase(caseRow, identity)) return 0;

  let score = 0;
  const channel = caseRow.slack_channel_name.toLowerCase();
  const channelCompact = compactAlpha(channel);
  const folder = (caseRow.dropbox_folder_name ?? '').toLowerCase();

  if (identity.slackChannelHint && channel.includes(identity.slackChannelHint)) {
    score += 200;
  }

  if (identity.caseNumberHint && caseRow.case_number === identity.caseNumberHint) {
    score += 150;
  }

  const hits = countTokenHitsInCase(caseRow, identity.nameTokens);
  score += hits * 40;

  if (identity.clientFullName) {
    const nameCompact = compactAlpha(identity.clientFullName);
    if (channelCompact.includes(nameCompact) || folder.includes(nameCompact.slice(0, 12))) {
      score += 100;
    }
  }

  return score;
}
