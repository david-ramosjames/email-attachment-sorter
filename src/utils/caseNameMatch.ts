import type { Case, ClientIdentity } from '../types/index.js';
import { tokensFromPersonName } from './patientNameExtract.js';

/** "lourdes galeas" → "lourdesgaleas" for matching slack channel slugs */
export function compactAlpha(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function caseHaystack(caseRow: Case): { text: string; compact: string } {
  const text = [caseRow.slack_channel_name, caseRow.dropbox_folder_name ?? '']
    .join(' ')
    .toLowerCase();
  return { text, compact: compactAlpha(text) };
}

function surnameTokensSimilar(token: string, haystackCompact: string): boolean {
  if (token.length < 5) return false;
  const t = compactAlpha(token);
  if (haystackCompact.includes(t)) return true;
  const prefix = t.slice(0, 4);
  if (prefix.length < 4) return false;
  if (!haystackCompact.includes(prefix)) return false;
  // e.g. pardon vs padron in mindypadron
  if (Math.abs(t.length - prefix.length) > 4) return false;
  for (let i = 0; i <= haystackCompact.length - t.length; i++) {
    const slice = haystackCompact.slice(i, i + t.length);
    if (slice.length !== t.length) continue;
    let diff = 0;
    for (let j = 0; j < t.length; j++) {
      if (slice[j] !== t[j]) diff++;
    }
    if (diff <= 2) return true;
  }
  return false;
}

function tokenAppearsInHaystack(token: string, haystack: { text: string; compact: string }): boolean {
  if (token.length < 3) return false;
  const t = token.toLowerCase();
  return (
    haystack.text.includes(t) ||
    haystack.compact.includes(compactAlpha(t)) ||
    (t.length >= 5 && haystack.compact.includes(compactAlpha(t).slice(0, 5))) ||
    surnameTokensSimilar(t, haystack.compact)
  );
}

/** First segment of slack slug (e.g. javiermejias from javiermejias-etal-625). */
function channelNameSegment(caseRow: Case): string {
  return (caseRow.slack_channel_name.split('-')[0] ?? '').toLowerCase();
}

/**
 * Client's first name is absent but the channel slug clearly names someone else
 * (Israel Mejia vs javiermejias-etal-625 → "javier" at start, not "israel").
 */
function channelNamesDifferentFirstPerson(
  caseRow: Case,
  clientFirstName: string,
  haystack: { text: string; compact: string }
): boolean {
  if (tokenAppearsInHaystack(clientFirstName, haystack)) {
    return false;
  }

  const segment = compactAlpha(channelNameSegment(caseRow));
  const clientFirst = compactAlpha(clientFirstName);
  if (segment.length < 5 || clientFirst.length < 3) return false;

  // Slug is one glued token (javiermejias) — client's first name must appear inside it
  if (segment.includes(clientFirst)) return false;

  // Channel segment starts with a different given name (≥4 chars) than the client's
  const prefix = segment.slice(0, Math.min(segment.length, 12));
  if (prefix.length >= 4 && !clientFirst.startsWith(prefix.slice(0, 4)) && !prefix.startsWith(clientFirst.slice(0, 4))) {
    return true;
  }

  return false;
}

function tokenAppearsExactlyInHaystack(
  token: string,
  haystack: { text: string; compact: string }
): boolean {
  if (token.length < 3) return false;
  const t = token.toLowerCase();
  const compact = compactAlpha(t);
  return haystack.text.includes(t) || haystack.compact.includes(compact);
}

/**
 * Strict gate for AI case assignment: BOTH first and last name must appear in the
 * case Slack slug or Dropbox folder label — no fuzzy surname matching, no first-name-only.
 */
export function clientNameExactlyMatchesCase(caseRow: Case, clientFullName: string): boolean {
  const tokens = tokensFromPersonName(clientFullName);
  if (tokens.length < 2) return false;

  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const haystack = caseHaystack(caseRow);

  if (!tokenAppearsExactlyInHaystack(first, haystack)) return false;
  if (!tokenAppearsExactlyInHaystack(last, haystack)) return false;

  // Channel slug often glues first+last (albertomontes) — last name must still appear
  if (channelNamesDifferentFirstPerson(caseRow, first, haystack)) return false;

  return true;
}

/** How many name tokens appear in channel, folder, or case number fields */
export function countTokenHitsInCase(caseRow: Case, tokens: string[]): number {
  const haystack = caseHaystack(caseRow);
  return tokens.filter((t) => tokenAppearsInHaystack(t, haystack)).length;
}

/**
 * True when the case belongs to a different person than the document client.
 * Requires the client's FIRST name to appear in the case — a shared last name alone is not enough.
 */
export function identityConflictsWithCase(caseRow: Case, identity: ClientIdentity): boolean {
  const tokens = identity.nameTokens.filter((t) => t.length >= 3);
  if (tokens.length < 2 || !identity.clientFullName) return false;

  const haystack = caseHaystack(caseRow);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  const firstInCase = tokenAppearsInHaystack(first, haystack);
  const lastInCase = tokenAppearsInHaystack(last, haystack);

  // Different first names: Israel Mejia ≠ Javier Mejias — never match on surname only
  if (!firstInCase) {
    return true;
  }

  if (channelNamesDifferentFirstPerson(caseRow, first, haystack)) {
    return true;
  }

  if (!lastInCase && !firstInCase) {
    return true;
  }

  const nameCompact = compactAlpha(identity.clientFullName);
  if (nameCompact.length >= 8 && !haystack.compact.includes(nameCompact.slice(0, 8))) {
    const hits = countTokenHitsInCase(caseRow, tokens);
    if (hits < 2) return true;
  }

  return false;
}

export function caseMatchesClientIdentity(caseRow: Case, identity: ClientIdentity): boolean {
  if (identityConflictsWithCase(caseRow, identity)) return false;
  if (!identity.nameTokens.length && !identity.slackChannelHint) return false;

  const haystack = caseHaystack(caseRow);
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
    if (nameCompact.length >= 8 && haystack.compact.includes(nameCompact.slice(0, 10))) {
      return true;
    }
    if (haystack.compact.includes(nameCompact)) return true;
  }

  const tokens = identity.nameTokens.filter((t) => t.length >= 3);
  if (tokens.length >= 2) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    const firstOk = tokenAppearsInHaystack(first, haystack);
    const lastOk = tokenAppearsInHaystack(last, haystack);
    // Both first and last (or full compact name) must align — not last name only
    return firstOk && lastOk;
  }

  const hits = countTokenHitsInCase(caseRow, identity.nameTokens);
  return identity.nameTokens.length >= 1 && hits >= 1;
}

export function scoreCaseForClientIdentity(caseRow: Case, identity: ClientIdentity): number {
  if (identityConflictsWithCase(caseRow, identity)) return 0;

  let score = 0;
  const haystack = caseHaystack(caseRow);
  const channel = caseRow.slack_channel_name.toLowerCase();

  if (identity.slackChannelHint && channel.includes(identity.slackChannelHint)) {
    score += 200;
  }

  if (identity.caseNumberHint && caseRow.case_number === identity.caseNumberHint) {
    score += 150;
  }

  const tokens = identity.nameTokens.filter((t) => t.length >= 3);
  if (tokens.length >= 2) {
    const firstOk = tokenAppearsInHaystack(tokens[0], haystack);
    const lastOk = tokenAppearsInHaystack(tokens[tokens.length - 1], haystack);
    if (firstOk) score += 80;
    if (lastOk) score += 50;
    if (firstOk && lastOk) score += 60;
  } else {
    score += countTokenHitsInCase(caseRow, identity.nameTokens) * 40;
  }

  if (identity.clientFullName) {
    const nameCompact = compactAlpha(identity.clientFullName);
    if (haystack.compact.includes(nameCompact)) {
      score += 100;
    }
  }

  return score;
}
