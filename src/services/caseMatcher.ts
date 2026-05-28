import {
  getFoldersForCase,
  getSenderHistory,
  listAllCases,
  searchCases,
} from '../db/supabase.js';
import { MAX_AI_CANDIDATES } from '../constants/classification.js';
import type { Case, CaseCandidate, MatchContext } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { isPhoneLikeNumber, maskPhoneAndFaxNumbers } from '../utils/phoneMask.js';

const SEARCH_STOPWORDS = new Set([
  'from',
  'with',
  'that',
  'this',
  'your',
  'have',
  'been',
  'will',
  'page',
  'notice',
  'letter',
  'email',
  'fax',
  'hellofax',
  'dropbox',
  'ramos',
  'james',
  'legal',
  'assistant',
  'noreply',
  'mail',
  'incoming',
  'attachment',
  'document',
  'subject',
]);

const CASE_NUMBER_PATTERN =
  /\b(?:case|cause|docket|file\s*#?|file\s+no\.?)\s*#?\s*([A-Z0-9-]+)/i;
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

/**
 * Extract RJL case number references — never from phone/fax digit strings.
 * 3-digit case IDs (e.g. 512) only from folder-style "512. Client Name" or labeled refs.
 */
function extractNumericCaseRefs(
  text: string,
  knownCaseNumbers?: Set<string>
): string[] {
  const refs = new Set<string>();

  for (const m of text.matchAll(DROPBOX_FOLDER_LEAD_PATTERN)) {
    refs.add(m[1]);
  }

  const labeled = extractLabeledCaseNumber(text);
  if (labeled && /^\d{2,5}$/.test(labeled) && !isPhoneLikeNumber(labeled)) {
    refs.add(labeled);
  }

  const masked = maskPhoneAndFaxNumbers(text);

  // Bare 4–5 digit case numbers (e.g. 1321, 2760) after phones removed
  for (const m of masked.matchAll(/\b(\d{4,5})\b/g)) {
    refs.add(m[1]);
  }

  // 3-digit: only when already in Dropbox folder form (e.g. "512. NAME")
  if (knownCaseNumbers) {
    for (const caseNum of knownCaseNumbers) {
      if (caseNum.length !== 3 || refs.has(caseNum)) continue;
      const folderStyle = new RegExp(`\\b${caseNum}\\.\\s+[A-Za-z]`, 'i');
      if (folderStyle.test(text)) refs.add(caseNum);
    }
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
        .filter((w) => w.length > 2 && !isPhoneLikeNumber(w))
    ),
  ];
}

function combinedContext(ctx: MatchContext): string {
  const raw = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ].join(' ');
  return maskPhoneAndFaxNumbers(raw).toLowerCase();
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

  if (
    numericRefs.includes(caseRow.case_number) &&
    new RegExp(`\\b${caseNumberLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
      combined
    )
  ) {
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
    .slice(0, MAX_AI_CANDIDATES);
}

function extractAiSearchTerms(ctx: MatchContext): string[] {
  const raw = maskPhoneAndFaxNumbers(
    [
      ctx.subject,
      ctx.bodyExcerpt,
      ctx.attachmentFilename,
      ctx.documentExcerpt ?? '',
    ].join(' ')
  ).toLowerCase();

  return [
    ...new Set(
      raw
        .split(/[^a-z0-9]+/)
        .map((w) => w.trim())
        .filter(
          (w) =>
            w.length >= 4 &&
            !SEARCH_STOPWORDS.has(w) &&
            !isPhoneLikeNumber(w) &&
            !/^\d+$/.test(w)
        )
    ),
  ].slice(0, 10);
}

/** When rule matching is thin, search DB by document/name terms for OpenAI to evaluate. */
async function widenCandidatesForAi(
  ctx: MatchContext,
  existing: CaseCandidate[]
): Promise<CaseCandidate[]> {
  const terms = extractAiSearchTerms(ctx);
  if (!terms.length) return [];

  const seen = new Set(existing.map((c) => c.case.case_number));
  const widened: CaseCandidate[] = [];

  for (const term of terms) {
    const rows = await searchCases({ keywords: [term] });
    for (const caseRow of rows) {
      if (seen.has(caseRow.case_number)) continue;
      seen.add(caseRow.case_number);
      const folders = await getFoldersForCase(caseRow.case_number);
      widened.push({
        case: caseRow,
        folders,
        matchScore: 1,
        matchReasons: [`Widened search: "${term}" matched case index`],
      });
      if (existing.length + widened.length >= MAX_AI_CANDIDATES) break;
    }
    if (existing.length + widened.length >= MAX_AI_CANDIDATES) break;
  }

  if (widened.length) {
    logger.info('Widened AI candidate pool', {
      terms,
      added: widened.map((c) => c.case.case_number),
    });
  }

  return widened;
}

function mergeCandidates(
  primary: CaseCandidate[],
  extra: CaseCandidate[]
): CaseCandidate[] {
  const byCase = new Map<string, CaseCandidate>();
  for (const c of [...primary, ...extra]) {
    const prev = byCase.get(c.case.case_number);
    if (!prev || c.matchScore > prev.matchScore) {
      byCase.set(c.case.case_number, c);
    }
  }
  return [...byCase.values()]
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, MAX_AI_CANDIDATES);
}

async function keywordFallbackCandidates(
  ctx: MatchContext,
  knownCaseNumbers: Set<string>
): Promise<CaseCandidate[]> {
  const rawText = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ].join(' ');

  const keywords = [
    ...wordsFromFilename(ctx.attachmentFilename),
    ...extractNumericCaseRefs(rawText, knownCaseNumbers),
  ]
    .filter((k) => !isPhoneLikeNumber(k))
    .slice(0, 6);

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

  const numericRefs = extractNumericCaseRefs(rawText, knownCaseNumbers);
  const known = new Set(matched.map((c) => c.case_number));
  const senderCaseNumbers = await getSenderHistory(ctx.fromEmail);
  return buildCandidates(matched, ctx, senderCaseNumbers, numericRefs, known);
}

export async function findCaseCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const allCases = await listAllCases();
  const knownCaseNumbers = new Set(allCases.map((c) => c.case_number));
  const senderCaseNumbers = await getSenderHistory(ctx.fromEmail);
  const rawText = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ].join(' ');
  const numericRefs = extractNumericCaseRefs(rawText, knownCaseNumbers).filter((n) =>
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
    candidates = await keywordFallbackCandidates(ctx, knownCaseNumbers);
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

  // Give OpenAI more options when rules are uncertain (it filters bad matches)
  if (candidates.length < 5) {
    const widened = await widenCandidatesForAi(ctx, candidates);
    candidates = mergeCandidates(candidates, widened);
  }

  return candidates;
}
