/** Texas-style litigation cause numbers (e.g. DC-24-12345, D-1-GN-24-001234). */
const CAUSE_LABELED_PATTERN =
  /\b(?:cause\s*(?:no\.?|number|#)?)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,})\b/gi;

/** Common unlabeled district-court style: DC-24-12345 */
const CAUSE_DC_PATTERN = /\b([A-Z]{1,3}-\d{2}-\d{3,6})\b/g;

/** Travis-style: D-1-GN-24-001234 */
const CAUSE_DASHED_PATTERN = /\b(D-\d+-[A-Z]{2,4}-\d{2}-\d{4,7})\b/gi;

function normalizeCauseNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

function isPlausibleCauseNumber(value: string): boolean {
  const v = normalizeCauseNumber(value);
  if (v.length < 6) return false;
  if (/^\d+$/.test(v)) return false;
  if (!/[A-Z]/.test(v)) return false;
  if (/^\d{2}-\d{4,6}$/.test(v)) return false;
  return true;
}

function collectMatches(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = normalizeCauseNumber(match[1]!);
    if (isPlausibleCauseNumber(value)) found.push(value);
  }
  return found;
}

/** Extract cause numbers from email body, attachment text, court filings, etc. */
export function extractCauseNumbers(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  const seen = new Set<string>();
  for (const value of [
    ...collectMatches(text, CAUSE_LABELED_PATTERN),
    ...collectMatches(text, CAUSE_DASHED_PATTERN),
    ...collectMatches(text, CAUSE_DC_PATTERN),
  ]) {
    seen.add(value);
  }
  return [...seen];
}

export function extractCauseNumbersFromTexts(
  ...texts: Array<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const value of extractCauseNumbers(text)) {
      seen.add(value);
    }
  }
  return [...seen];
}

export function formatCauseNumberCaseHint(causeNumber: string, caseNumber: string): string {
  return `Cause number ${normalizeCauseNumber(causeNumber)} belongs to case ${caseNumber}.`;
}

/** Slack channel topic stage indicates the case is in litigation (not pre-lit). */
export function caseTopicStageIsLitigation(topicStage: string | null | undefined): boolean {
  if (!topicStage?.trim()) return false;
  const s = topicStage.toLowerCase();
  if (/\bpre[-\s]?lit\b/.test(s)) return false;
  if (/\bintake\b/.test(s)) return false;
  return (
    /\blit\b/.test(s) ||
    /\bdiscovery\b/.test(s) ||
    /\btrial\b/.test(s) ||
    /\bmediation\b/.test(s) ||
    /\barbitration\b/.test(s) ||
    /\bappeal\b/.test(s)
  );
}

export function hintTextContainsCauseNumber(hintText: string, causeNumber: string): boolean {
  return hintText.toUpperCase().includes(normalizeCauseNumber(causeNumber));
}
