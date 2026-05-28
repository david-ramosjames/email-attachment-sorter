import {
  getCaseById,
  getFoldersForCase,
  getSenderHistory,
  listAllCases,
} from '../db/supabase.js';
import type { Case, CaseCandidate, MatchContext } from '../types/index.js';

const CASE_NUMBER_PATTERN = /\b(?:case|cause|docket|file\s*#?)\s*#?\s*([A-Z0-9-]+)/i;

/** Meaningful tokens from slack_channel_name, e.g. "Maria Lopez - 2024-CV-123" → ["maria","lopez"] */
function nameTokensFromChannel(channelName: string): string[] {
  const withoutNumbers = channelName
    .replace(/\b\d{2,}[\w-]*\b/g, ' ')
    .replace(/[#()[\]]/g, ' ');
  return [...new Set(
    withoutNumbers
      .toLowerCase()
      .split(/[\s\-_|/\\,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2)
  )];
}

function extractCaseNumber(text: string): string | null {
  const match = text.match(CASE_NUMBER_PATTERN);
  return match?.[1] ?? null;
}

function scoreCase(
  caseRow: Case,
  ctx: MatchContext,
  senderCaseNumbers: string[]
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const combined = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const channelNameLower = caseRow.slack_channel_name.toLowerCase();
  const caseNumberLower = caseRow.case_number.toLowerCase();
  const nameTokens = nameTokensFromChannel(caseRow.slack_channel_name);

  // Best signal: full slack_channel_name line appears in email (name + number together)
  if (channelNameLower.length > 5 && combined.includes(channelNameLower)) {
    score += 70;
    reasons.push(`Slack channel line "${caseRow.slack_channel_name}" found in email`);
  }

  // Name tokens — primary match path for RJL (client name in channel title)
  const matchedTokens = nameTokens.filter((t) => combined.includes(t));
  if (matchedTokens.length >= 2) {
    score += 55;
    reasons.push(`Client name tokens matched: ${matchedTokens.join(', ')}`);
  } else if (matchedTokens.length === 1) {
    score += 40;
    reasons.push(`Name token matched: ${matchedTokens[0]}`);
  }

  const filenameLower = ctx.attachmentFilename.toLowerCase();
  const filenameTokenHits = nameTokens.filter((t) => filenameLower.includes(t));
  if (filenameTokenHits.length > 0) {
    score += 25;
    reasons.push(`Attachment filename matches name: ${filenameTokenHits.join(', ')}`);
  }

  // Case number — secondary signal (often embedded in slack_channel_name anyway)
  if (caseNumberLower.length > 2 && combined.includes(caseNumberLower)) {
    score += 25;
    reasons.push(`Case number ${caseRow.case_number} matched`);
  }

  if (senderCaseNumbers.includes(caseRow.case_number)) {
    score += 20;
    reasons.push('Sender has previously filed to this case');
  }

  return { score, reasons };
}

export async function findCaseCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const allCases = await listAllCases();
  const senderCaseNumbers = await getSenderHistory(ctx.fromEmail);

  // Boost cases whose case_number was extracted from email text
  const extractedNumber =
    extractCaseNumber(ctx.subject) ??
    extractCaseNumber(ctx.bodyExcerpt) ??
    extractCaseNumber(ctx.attachmentFilename) ??
    (ctx.documentExcerpt ? extractCaseNumber(ctx.documentExcerpt) : null);

  const scored = await Promise.all(
    allCases.map(async (caseRow) => {
      let { score, reasons } = scoreCase(caseRow, ctx, senderCaseNumbers);

      if (extractedNumber && caseRow.case_number.toLowerCase().includes(extractedNumber.toLowerCase())) {
        score += 15;
        reasons = [...reasons, `Extracted reference ${extractedNumber} matches case number`];
      }

      const folders = await getFoldersForCase(caseRow.case_number);
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
