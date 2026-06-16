import type { Case, MatchContext } from '../types/index.js';

function staffNames(caseRow: Case): Array<{ role: string; name: string }> {
  const out: Array<{ role: string; name: string }> = [];
  if (caseRow.attorney_name?.trim()) {
    out.push({ role: 'Attorney', name: caseRow.attorney_name.trim() });
  }
  if (caseRow.paralegal_name?.trim()) {
    out.push({ role: 'Paralegal', name: caseRow.paralegal_name.trim() });
  }
  return out;
}

function nameAppearsInText(name: string, haystack: string): boolean {
  const lower = haystack.toLowerCase();
  const nameLower = name.toLowerCase();
  if (lower.includes(nameLower)) return true;
  const first = nameLower.split(/\s+/)[0];
  if (first && first.length >= 3) {
    if (lower.includes(`@${first}`)) return true;
    if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)) {
      return true;
    }
  }
  return false;
}

/** Rule-based boost when email sender or body aligns with case topic staff. */
export function scoreCaseStaffMatch(
  caseRow: Case,
  ctx: Pick<MatchContext, 'fromEmail' | 'subject' | 'bodyExcerpt' | 'documentExcerpt'>
): { score: number; reasons: string[]; confidenceBoost: number } {
  let score = 0;
  let confidenceBoost = 0;
  const reasons: string[] = [];
  const fromLower = ctx.fromEmail.toLowerCase();
  const combined = [ctx.subject, ctx.bodyExcerpt, ctx.documentExcerpt ?? ''].join('\n');

  for (const { role, name } of staffNames(caseRow)) {
    const nameLower = name.toLowerCase();
    const localPart = fromLower.split('@')[0] ?? '';

    if (
      fromLower.includes(nameLower) ||
      (localPart.length >= 3 && nameLower.includes(localPart))
    ) {
      score += 45;
      confidenceBoost = Math.max(confidenceBoost, 0.1);
      reasons.push(`${role} ${name} matches sender`);
      continue;
    }

    if (nameAppearsInText(name, combined)) {
      score += 28;
      confidenceBoost = Math.max(confidenceBoost, 0.06);
      reasons.push(`${role} ${name} mentioned in email/document`);
    }
  }

  return { score, reasons, confidenceBoost };
}

export function caseStaffCatalogAttributes(caseRow: Case): string {
  const parts: string[] = [];
  if (caseRow.attorney_name?.trim()) {
    parts.push(`attorney="${caseRow.attorney_name.trim()}"`);
  }
  if (caseRow.paralegal_name?.trim()) {
    parts.push(`paralegal="${caseRow.paralegal_name.trim()}"`);
  }
  return parts.join(' ');
}
