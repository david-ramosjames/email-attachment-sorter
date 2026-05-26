import {
  getCaseById,
  getFoldersForCase,
  getSenderHistory,
  searchCases,
} from '../db/supabase.js';
import type { Case, CaseCandidate, MatchContext } from '../types/index.js';

const CAUSE_NUMBER_PATTERN = /\b(?:cause|docket|case)\s*#?\s*([A-Z0-9-]+)/i;

function extractCauseNumber(text: string): string | null {
  const match = text.match(CAUSE_NUMBER_PATTERN);
  return match?.[1] ?? null;
}

function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);
}

function scoreCase(
  caseRow: Case,
  ctx: MatchContext,
  senderCaseIds: string[]
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const combined = `${ctx.subject} ${ctx.bodyExcerpt} ${ctx.attachmentFilename}`.toLowerCase();
  const clientLower = caseRow.client_name.toLowerCase();
  const caseNameLower = caseRow.case_name.toLowerCase();

  if (combined.includes(clientLower)) {
    score += 40;
    reasons.push(`Client name "${caseRow.client_name}" found in email content`);
  }
  if (combined.includes(caseNameLower)) {
    score += 30;
    reasons.push(`Case name "${caseRow.case_name}" found in email content`);
  }
  if (caseRow.cause_number && combined.includes(caseRow.cause_number.toLowerCase())) {
    score += 50;
    reasons.push(`Cause number ${caseRow.cause_number} matched`);
  }
  if (caseRow.case_number && combined.includes(caseRow.case_number.toLowerCase())) {
    score += 35;
    reasons.push(`Case number ${caseRow.case_number} matched`);
  }
  if (senderCaseIds.includes(caseRow.id)) {
    score += 25;
    reasons.push('Sender has previously filed to this case');
  }
  const filenameLower = ctx.attachmentFilename.toLowerCase();
  if (filenameLower.includes(clientLower.split(' ')[0] ?? '')) {
    score += 15;
    reasons.push('Attachment filename suggests client match');
  }

  return { score, reasons };
}

export async function findCaseCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const causeNumber =
    extractCauseNumber(ctx.subject) ??
    extractCauseNumber(ctx.bodyExcerpt) ??
    extractCauseNumber(ctx.attachmentFilename);

  const keywords = tokenizeForSearch(
    `${ctx.subject} ${ctx.attachmentFilename} ${ctx.bodyExcerpt}`
  );

  const searches: Promise<Case[]>[] = [];
  if (causeNumber) {
    searches.push(searchCases({ causeNumber }));
  }
  searches.push(searchCases({ keywords }));

  const senderCaseIds = await getSenderHistory(ctx.fromEmail);
  if (senderCaseIds.length > 0) {
    for (const id of senderCaseIds.slice(0, 3)) {
      const c = await getCaseById(id);
      if (c) searches.push(Promise.resolve([c]));
    }
  }

  const results = await Promise.all(searches);
  const seen = new Set<string>();
  const allCases: Case[] = [];
  for (const batch of results) {
    for (const c of batch) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        allCases.push(c);
      }
    }
  }

  const scored = await Promise.all(
    allCases.map(async (caseRow) => {
      const { score, reasons } = scoreCase(caseRow, ctx, senderCaseIds);
      const folders = await getFoldersForCase(caseRow.id);
      return {
        case: caseRow,
        folders,
        matchScore: score,
        matchReasons: reasons,
      } satisfies CaseCandidate;
    })
  );

  return scored
    .filter((c) => c.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}
