import {
  getFoldersForCase,
  getSenderHistory,
  listAllCases,
  searchCases,
} from '../db/supabase.js';
import type { Case, CaseCandidate, MatchContext } from '../types/index.js';
import { logger } from '../utils/logger.js';

const CASE_NUMBER_PATTERN = /\b(?:case|cause|docket|file\s*#?)\s*#?\s*([A-Z0-9-]+)/i;
const RJL_NUMERIC_CASE_PATTERN = /\b(\d{3,5})\b/g;
const DROPBOX_FOLDER_LEAD_PATTERN = /\b(\d{3,5})\.\s+[A-Za-z]/g;

/** Meaningful tokens from slack_channel_name or Dropbox folder name */
function nameTokensFromLabel(label: string): string[] {
  const withoutNumbers = label
    .replace(/\b\d{2,}[\w-]*\b/g, ' ')
    .replace(/[#()[\].]/g, ' ')
    .replace(/_/g, ' ');
  return [
    ...new Set(
      withoutNumbers
        .toLowerCase()
        .split(/[\s\-_|/\\,]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 2)
    ),
  ];
}

/** Split hyphenated slack names: mindystocker-etal-1321 → extra parts */
function expandedNameTokens(label: string): string[] {
  const base = nameTokensFromLabel(label);
  const fromHyphens = label
    .toLowerCase()
    .split(/[-_]+/)
    .map((t) => t.replace(/\d+/g, '').trim())
    .filter((t) => t.length > 2);
  return [...new Set([...base, ...fromHyphens])];
}

function extractLabeledCaseNumber(text: string): string | null {
  const match = text.match(CASE_NUMBER_PATTERN);
  return match?.[1] ?? null;
}

/** RJL case numbers are typically 3–5 digits (e.g. 1321, 276). */
function extractNumericCaseRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(RJL_NUMERIC_CASE_PATTERN)) {
    refs.add(m[1]);
  }
  for (const m of text.matchAll(DROPBOX_FOLDER_LEAD_PATTERN)) {
    refs.add(m[1]);
  }
  return [...refs];
}

function wordsFromFilename(filename: string): string[] {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  return [
    ...new Set(
      base
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 2)
    ),
  ];
}

function combinedContext(ctx: MatchContext): string {
  return [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function scoreCase(
  caseRow: Case,
  ctx: MatchContext,
  senderCaseNumbers: string[],
  numericRefs: string[],
  knownCaseNumbers: Set<string>
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const combined = combinedContext(ctx);
  const channelNameLower = caseRow.slack_channel_name.toLowerCase();
  const caseNumberLower = caseRow.case_number.toLowerCase();
  const folderLabel = caseRow.dropbox_folder_name ?? '';
  const nameTokens = [
    ...expandedNameTokens(caseRow.slack_channel_name),
    ...expandedNameTokens(folderLabel),
  ];

  if (knownCaseNumbers.has(caseRow.case_number) && numericRefs.includes(caseRow.case_number)) {
    score += 80;
    reasons.push(`Case number ${caseRow.case_number} found in document/email text`);
  }

  if (channelNameLower.length > 5 && combined.includes(channelNameLower)) {
    score += 70;
    reasons.push(`Slack channel line "${caseRow.slack_channel_name}" found in text`);
  }

  const folderLower = folderLabel.toLowerCase();
  if (folderLower.length > 8 && combined.includes(folderLower)) {
    score += 75;
    reasons.push(`Dropbox folder name "${folderLabel}" found in text`);
  }

  const matchedTokens = nameTokens.filter((t) => combined.includes(t));
  if (matchedTokens.length >= 2) {
    score += 55;
    reasons.push(`Client name tokens matched: ${matchedTokens.join(', ')}`);
  } else if (matchedTokens.length === 1) {
    score += 40;
    reasons.push(`Name token matched: ${matchedTokens[0]}`);
  }

  const filenameLower = ctx.attachmentFilename.toLowerCase();
  const filenameWords = wordsFromFilename(ctx.attachmentFilename);
  const filenameTokenHits = nameTokens.filter((t) => filenameLower.includes(t));
  if (filenameTokenHits.length > 0) {
    score += 25;
    reasons.push(`Attachment filename matches name: ${filenameTokenHits.join(', ')}`);
  }

  for (const word of filenameWords) {
    if (caseNumberLower === word || channelNameLower.includes(word)) {
      score += 30;
      reasons.push(`Filename keyword "${word}" matches case`);
      break;
    }
    if (folderLower.includes(word)) {
      score += 35;
      reasons.push(`Filename keyword "${word}" matches Dropbox folder`);
      break;
    }
  }

  if (caseNumberLower.length > 0 && combined.includes(caseNumberLower)) {
    score += 25;
    reasons.push(`Case number ${caseRow.case_number} matched in text`);
  }

  if (senderCaseNumbers.includes(caseRow.case_number)) {
    score += 20;
    reasons.push('Sender has previously filed to this case');
  }

  const labeled = extractLabeledCaseNumber(combined);
  if (labeled && caseRow.case_number.toLowerCase().includes(labeled.toLowerCase())) {
    score += 15;
    reasons.push(`Labeled reference ${labeled} matches case number`);
  }

  return { score, reasons };
}

async function buildCandidates(
  cases: Case[],
  ctx: MatchContext,
  senderCaseNumbers: string[],
  numericRefs: string[],
  knownCaseNumbers: Set<string>
): Promise<CaseCandidate[]> {
  const scored = await Promise.all(
    cases.map(async (caseRow) => {
      const { score, reasons } = scoreCase(
        caseRow,
        ctx,
        senderCaseNumbers,
        numericRefs,
        knownCaseNumbers
      );
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
    .slice(0, 8);
}

async function keywordFallbackCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const keywords = [
    ...wordsFromFilename(ctx.attachmentFilename),
    ...extractNumericCaseRefs(combinedContext(ctx)),
  ].slice(0, 6);

  const seen = new Set<string>();
  const matched: Case[] = [];

  for (const keyword of keywords) {
    const rows = await searchCases({ keywords: [keyword] });
    for (const row of rows) {
      if (!seen.has(row.case_number)) {
        seen.add(row.case_number);
        matched.push(row);
      }
    }
  }

  if (!matched.length) return [];

  logger.info('Case keyword fallback matched', {
    keywords,
    cases: matched.map((c) => c.case_number),
  });

  const numericRefs = extractNumericCaseRefs(combinedContext(ctx));
  const known = new Set(matched.map((c) => c.case_number));
  const senderCaseNumbers = await getSenderHistory(ctx.fromEmail);
  return buildCandidates(matched, ctx, senderCaseNumbers, numericRefs, known);
}

export async function findCaseCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const allCases = await listAllCases();
  const knownCaseNumbers = new Set(allCases.map((c) => c.case_number));
  const senderCaseNumbers = await getSenderHistory(ctx.fromEmail);
  const combined = combinedContext(ctx);
  const numericRefs = extractNumericCaseRefs(combined).filter((n) =>
    knownCaseNumbers.has(n)
  );

  let candidates = await buildCandidates(
    allCases,
    ctx,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  if (!candidates.length) {
    candidates = await keywordFallbackCandidates(ctx);
  }

  if (!candidates.length && numericRefs.length) {
    const byNumber = allCases.filter((c) => numericRefs.includes(c.case_number));
    if (byNumber.length) {
      candidates = await buildCandidates(
        byNumber,
        ctx,
        senderCaseNumbers,
        numericRefs,
        knownCaseNumbers
      );
    }
  }

  return candidates;
}
