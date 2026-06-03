import type { MatchingHint, MatchingHintType } from '../types/index.js';

export function hintsOfType(
  hints: MatchingHint[] | undefined,
  hintType: MatchingHintType
): MatchingHint[] {
  return (hints ?? []).filter((h) => h.hintType === hintType);
}

export function formatCaseMatchingHintsForAi(hints: MatchingHint[] | undefined): string {
  const caseHints = hintsOfType(hints, 'case');
  if (!caseHints.length) return '';

  const lines = caseHints.map((h) => {
    const scope = h.senderEmail
      ? `sender ${h.senderEmail} → case ${h.caseNumber}`
      : `case ${h.caseNumber}`;
    return `- [${scope}] ${h.hintText}`;
  });

  return (
    'Staff Teach Case context (PI client identity, Cause numbers → case — use for suggested_case_number):\n' +
    lines.join('\n')
  );
}

export function formatDocumentSortHintsForAi(hints: MatchingHint[] | undefined): string {
  const sortHints = hintsOfType(hints, 'sort');
  if (!sortHints.length) return '';

  const lines = sortHints.map((h) => {
    const scope = h.caseNumber
      ? `sender ${h.senderEmail} (when case ${h.caseNumber} applies)`
      : `sender ${h.senderEmail}`;
    return `- [${scope}] ${h.hintText}`;
  });

  return (
    'Staff document-sorting context (how to file mail from this sender/provider — folder, document type, or Do Not Sort):\n' +
    lines.join('\n')
  );
}

export function mergeMatchingHints(
  ...groups: Array<MatchingHint[] | undefined>
): MatchingHint[] {
  const seen = new Set<string>();
  const merged: MatchingHint[] = [];
  for (const group of groups) {
    for (const hint of group ?? []) {
      const key = `${hint.hintType}|${hint.senderEmail ?? ''}|${hint.caseNumber ?? ''}|${hint.hintText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hint);
    }
  }
  return merged;
}

export function caseMatchingHintsPromptSection(hints: MatchingHint[] | undefined): string {
  const block = formatCaseMatchingHintsForAi(hints);
  return block ? `\n${block}` : '';
}

export function documentSortHintsPromptSection(hints: MatchingHint[] | undefined): string {
  const block = formatDocumentSortHintsForAi(hints);
  return block ? `\n${block}` : '';
}
