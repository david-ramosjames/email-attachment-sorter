import {
  getFoldersForCase,
  getCaseHintsForCases,
  getCaseHintsForSender,
  listAllCases,
  searchCases,
} from '../db/supabase.js';
import { MAX_AI_CANDIDATES, MIN_EXTRACTED_TEXT_CHARS } from '../constants/classification.js';
import type { Case, CaseCandidate, MatchContext } from '../types/index.js';
import { clientTokensFromFilename } from '../utils/filenameCaseMatch.js';
import {
  allPatientNameTokens,
  extractPatientNamesFromText,
  tokensFromPersonName,
} from '../utils/patientNameExtract.js';
import {
  caseMatchesClientIdentity,
  compactAlpha,
  identityConflictsWithCase,
  scoreCaseForClientIdentity,
} from '../utils/caseNameMatch.js';
import { logger } from '../utils/logger.js';
import { mergeMatchingHints } from '../utils/matchingHints.js';
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
 * Explicit case number references only — labeled ("case 1448") or Dropbox folder style ("1448. Name").
 * Bare digits in addresses, zips, etc. are left for the AI classifier to interpret.
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
    ...(ctx.emailPatientNames ?? []),
  ].join(' ');
  return maskPhoneAndFaxNumbers(raw).toLowerCase();
}

function patientNamesForContext(ctx: MatchContext): string[] {
  const fromEmail = extractPatientNamesFromText(
    [ctx.subject, ctx.bodyExcerpt, ctx.documentExcerpt ?? ''].join('\n')
  );
  const merged = [...fromEmail, ...(ctx.emailPatientNames ?? [])];
  return [...new Set(merged)];
}

/** Match cases when client name is in email/PDF but slack channel is unrelated (e.g. heidievans + folder "1455. LOURDES GALEAS"). */
async function findCandidatesByPatientNames(
  ctx: MatchContext,
  allCases: Case[],
  senderCaseNumbers: string[],
  numericRefs: string[],
  knownCaseNumbers: Set<string>
): Promise<CaseCandidate[]> {
  const patientNames = patientNamesForContext(ctx);
  if (!patientNames.length) return [];

  const tokens = allPatientNameTokens(patientNames);
  if (tokens.length < 2) return [];

  const matched = allCases.filter((caseRow) => {
    if (identityConflictsWithCase(caseRow, {
      clientFullName: patientNames[0] ?? null,
      nameTokens: tokens,
      caseNumberHint: null,
      slackChannelHint: null,
      documentKind: null,
      isNewClientIntake: false,
      confidence: 1,
      reason: '',
    })) {
      return false;
    }
    return caseMatchesClientIdentity(caseRow, {
      clientFullName: patientNames[0] ?? null,
      nameTokens: tokens,
      caseNumberHint: null,
      slackChannelHint: null,
      documentKind: null,
      isNewClientIntake: false,
      confidence: 1,
      reason: '',
    });
  });

  if (!matched.length) {
    const seen = new Set<string>();
    const fromSearch: Case[] = [];
    for (const token of tokens) {
      const rows = await searchCases({ keywords: [token] });
      for (const row of rows) {
        if (!seen.has(row.case_number)) {
          seen.add(row.case_number);
          fromSearch.push(row);
        }
      }
    }
    if (!fromSearch.length) return [];
    return buildCandidates(
      fromSearch,
      ctx,
      senderCaseNumbers,
      numericRefs,
      knownCaseNumbers
    );
  }

  logger.info('Matched cases by patient name from email/document', {
    patientNames,
    tokens,
    cases: matched.map((c) => c.case_number),
  });

  const candidates = await buildCandidates(
    matched,
    ctx,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );
  return candidates.map((c) => ({
    ...c,
    matchScore: c.matchScore + 120,
    matchReasons: [...c.matchReasons, 'Boosted: patient name from email/document'],
  }));
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

  for (const patientName of patientNamesForContext(ctx)) {
    const patientTokens = tokensFromPersonName(patientName);
    if (patientTokens.length < 2) continue;
    const first = patientTokens[0];
    const last = patientTokens[patientTokens.length - 1];
    const firstInChannel =
      channelNameLower.includes(first) ||
      folderLower.includes(first) ||
      compactAlpha(channelNameLower).includes(compactAlpha(first));
    const lastInChannel =
      channelNameLower.includes(last) ||
      folderLower.includes(last) ||
      compactAlpha(channelNameLower).includes(compactAlpha(last));
    if (!firstInChannel) continue;
    if (firstInChannel && lastInChannel) {
      score += 95;
      reasons.push(`Patient "${patientName}" matches case (first + last name in channel/folder)`);
    }
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

  const clientFilenameTokens = clientTokensFromFilename(ctx.attachmentFilename);
  const filenameHits = clientFilenameTokens.filter(
    (t) =>
      channelNameLower.includes(t) ||
      folderLower.includes(t) ||
      filenameLower.includes(t)
  );
  if (clientFilenameTokens.length >= 2 && filenameHits.length >= 2) {
    score += 90;
    reasons.push(`Filename client name matched: ${filenameHits.join(', ')}`);
  } else if (clientFilenameTokens.length >= 1 && filenameHits.length >= 1) {
    score += 70;
    reasons.push(`Filename token matched: ${filenameHits.join(', ')}`);
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
      ...(ctx.emailPatientNames ?? []),
    ].join(' ')
  ).toLowerCase();

  const fromWords = raw
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter(
      (w) =>
        w.length >= 4 &&
        !SEARCH_STOPWORDS.has(w) &&
        !isPhoneLikeNumber(w) &&
        !/^\d+$/.test(w)
    );

  const fromPatient = allPatientNameTokens(patientNamesForContext(ctx)).filter(
    (t) => t.length >= 4
  );

  return [...new Set([...fromPatient, ...fromWords])].slice(0, 12);
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

/** Last-resort case search from vision/OCR attachment text before document-only AI classification. */
export async function widenCandidatesFromDocument(
  ctx: MatchContext
): Promise<CaseCandidate[]> {
  if ((ctx.documentExcerpt?.trim().length ?? 0) < MIN_EXTRACTED_TEXT_CHARS) {
    return [];
  }

  let widened = await widenCandidatesForAi(ctx, []);
  if (widened.length) return widened;

  const docText = ctx.documentExcerpt ?? '';
  const tokens = [
    ...new Set(
      docText
        .toLowerCase()
        .split(/[^a-z]+/)
        .map((w) => w.trim())
        .filter(
          (w) =>
            w.length >= 3 &&
            w.length <= 24 &&
            !SEARCH_STOPWORDS.has(w) &&
            !isPhoneLikeNumber(w) &&
            !/^\d+$/.test(w)
        )
    ),
  ].slice(0, 15);

  const seen = new Set<string>();
  for (const term of tokens) {
    const rows = await searchCases({ keywords: [term] });
    for (const caseRow of rows) {
      if (seen.has(caseRow.case_number)) continue;
      seen.add(caseRow.case_number);
      const folders = await getFoldersForCase(caseRow.case_number);
      widened.push({
        case: caseRow,
        folders,
        matchScore: 1,
        matchReasons: [`Document text search: "${term}" matched case index`],
      });
      if (widened.length >= MAX_AI_CANDIDATES) break;
    }
    if (widened.length >= MAX_AI_CANDIDATES) break;
  }

  if (widened.length) {
    logger.info('Document-driven case candidate widen', {
      attachmentFilename: ctx.attachmentFilename,
      terms: tokens.slice(0, 8),
      cases: widened.map((c) => c.case.slack_channel_name),
    });
  }

  if (ctx.aiClientIdentity && widened.length) {
    const before = widened.length;
    widened = widened.filter(
      (c) => !identityConflictsWithCase(c.case, ctx.aiClientIdentity!)
    );
    if (widened.length < before) {
      logger.info('Document widen removed conflicting cases', {
        client: ctx.aiClientIdentity.clientFullName,
        removed: before - widened.length,
      });
    }
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
  return buildCandidates(matched, ctx, [], numericRefs, known);
}

async function findCandidatesByClientIdentity(
  ctx: MatchContext,
  allCases: Case[],
  senderCaseNumbers: string[],
  numericRefs: string[],
  knownCaseNumbers: Set<string>
): Promise<CaseCandidate[]> {
  const identity = ctx.aiClientIdentity;
  if (!identity?.nameTokens.length && !identity?.slackChannelHint && !identity?.caseNumberHint) {
    return [];
  }

  const scored = allCases
    .map((caseRow) => ({
      caseRow,
      score: scoreCaseForClientIdentity(caseRow, identity),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  let matched = scored.map((s) => s.caseRow);

  if (identity.slackChannelHint) {
    const hint = identity.slackChannelHint.toLowerCase();
    const byChannel = allCases.filter((c) =>
      c.slack_channel_name.toLowerCase().includes(hint)
    );
    matched = [...new Map([...matched, ...byChannel].map((c) => [c.case_number, c])).values()];
  }

  for (const token of identity.nameTokens) {
    const rows = await searchCases({ keywords: [token] });
    for (const row of rows) {
      if (!matched.some((m) => m.case_number === row.case_number)) {
        matched.push(row);
      }
    }
  }

  if (!matched.length) return [];

  logger.info('Candidates from AI client identity', {
    clientFullName: identity.clientFullName,
    slackChannelHint: identity.slackChannelHint,
    caseNumberHint: identity.caseNumberHint,
    nameTokens: identity.nameTokens,
    cases: matched.slice(0, 5).map((c) => c.slack_channel_name),
  });

  const candidates = await buildCandidates(
    matched.slice(0, MAX_AI_CANDIDATES),
    ctx,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  return candidates.map((c) => ({
    ...c,
    matchScore: c.matchScore + 180,
    matchReasons: [
      ...c.matchReasons,
      `AI identity: ${identity.clientFullName ?? identity.slackChannelHint ?? 'client'} (${identity.reason.slice(0, 80)})`,
    ],
  }));
}

async function findCasesFromFilename(ctx: MatchContext): Promise<Case[]> {
  const tokens = clientTokensFromFilename(ctx.attachmentFilename);
  const seen = new Set<string>();
  const matched: Case[] = [];

  for (const token of tokens) {
    const rows = await searchCases({ keywords: [token] });
    for (const row of rows) {
      if (!seen.has(row.case_number)) {
        seen.add(row.case_number);
        matched.push(row);
      }
    }
  }

  if (matched.length) {
    logger.info('Cases found from attachment filename', {
      filename: ctx.attachmentFilename,
      tokens,
      cases: matched.map((c) => c.case_number),
    });
  }

  return matched;
}

async function findCandidatesFromMatchingHints(
  ctx: MatchContext,
  allCases: Case[],
  senderCaseNumbers: string[],
  numericRefs: string[],
  knownCaseNumbers: Set<string>
): Promise<CaseCandidate[]> {
  const hints = ctx.caseMatchingHints ?? [];
  if (!hints.length) return [];

  const caseNumbers = [...new Set(hints.map((h) => h.caseNumber))];
  const matched = allCases.filter((c) => caseNumbers.includes(c.case_number));
  if (!matched.length) return [];

  logger.info('Candidates from staff matching hints', {
    fromEmail: ctx.fromEmail,
    cases: matched.map((c) => c.slack_channel_name),
    hints: hints.map((h) => h.hintText.slice(0, 80)),
  });

  const candidates = await buildCandidates(
    matched,
    ctx,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  return candidates.map((c) => {
    const hintTexts = hints
      .filter((h) => h.caseNumber === c.case.case_number)
      .map((h) => h.hintText);
    return {
      ...c,
      matchScore: c.matchScore + 250,
      matchReasons: [
        ...c.matchReasons,
        `Staff matching hint: ${hintTexts.join('; ').slice(0, 160)}`,
      ],
    };
  });
}

export async function findCaseCandidates(ctx: MatchContext): Promise<CaseCandidate[]> {
  const senderHints = await getCaseHintsForSender(ctx.fromEmail);
  ctx.caseMatchingHints = mergeMatchingHints(senderHints, ctx.caseMatchingHints);

  const allCases = await listAllCases();
  const knownCaseNumbers = new Set(allCases.map((c) => c.case_number));
  const senderCaseNumbers: string[] = [];
  const rawText = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ].join(' ');
  const numericRefs = extractNumericCaseRefs(rawText, knownCaseNumbers).filter((n) =>
    knownCaseNumbers.has(n)
  );

  const identityCandidates = await findCandidatesByClientIdentity(
    ctx,
    allCases,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  const patientCandidates = await findCandidatesByPatientNames(
    ctx,
    allCases,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  const filenameCases = await findCasesFromFilename(ctx);
  let candidates = await buildCandidates(
    allCases,
    ctx,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );

  if (identityCandidates.length) {
    candidates = mergeCandidates(identityCandidates, candidates);
  }

  const hintCandidates = await findCandidatesFromMatchingHints(
    ctx,
    allCases,
    senderCaseNumbers,
    numericRefs,
    knownCaseNumbers
  );
  if (hintCandidates.length) {
    candidates = mergeCandidates(hintCandidates, candidates);
  }

  if (patientCandidates.length) {
    candidates = mergeCandidates(patientCandidates, candidates);
  }

  if (ctx.batchSharedCaseNumber) {
    const shared = allCases.find((c) => c.case_number === ctx.batchSharedCaseNumber);
    if (shared) {
      const sharedCandidates = await buildCandidates(
        [shared],
        ctx,
        senderCaseNumbers,
        numericRefs,
        knownCaseNumbers
      );
      const boosted = sharedCandidates.map((c) => ({
        ...c,
        matchScore: c.matchScore + 150,
        matchReasons: [...c.matchReasons, 'Boosted: same email batch as prior attachment'],
      }));
      candidates = mergeCandidates(boosted, candidates);
    }
  }

  if (filenameCases.length) {
    const filenameCandidates = await buildCandidates(
      filenameCases,
      ctx,
      senderCaseNumbers,
      numericRefs,
      knownCaseNumbers
    );
    for (const fc of filenameCandidates) {
      const boosted = {
        ...fc,
        matchScore: fc.matchScore + 100,
        matchReasons: [...fc.matchReasons, 'Boosted: filename client-name search'],
      };
      const existing = candidates.find((c) => c.case.case_number === fc.case.case_number);
      if (existing) {
        existing.matchScore = Math.max(existing.matchScore, boosted.matchScore);
        existing.matchReasons = [...new Set([...existing.matchReasons, ...boosted.matchReasons])];
      } else {
        candidates.push(boosted);
      }
    }
    candidates = candidates
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, MAX_AI_CANDIDATES);
  }

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

  if (!candidates.length) {
    const retry = await findCandidatesByPatientNames(
      ctx,
      allCases,
      senderCaseNumbers,
      numericRefs,
      knownCaseNumbers
    );
    candidates = retry;
  }

  if (!candidates.length && ctx.aiClientIdentity) {
    const identity = ctx.aiClientIdentity;
    const fallbackCases = allCases
      .filter((c) => caseMatchesClientIdentity(c, identity))
      .slice(0, MAX_AI_CANDIDATES);
    if (fallbackCases.length) {
      candidates = await buildCandidates(
        fallbackCases,
        ctx,
        senderCaseNumbers,
        numericRefs,
        knownCaseNumbers
      );
      logger.info('Identity fallback matched cases', {
        cases: fallbackCases.map((c) => c.slack_channel_name),
      });
    }
  }

  if (ctx.aiClientIdentity && candidates.length) {
    const before = candidates.length;
    candidates = candidates.filter(
      (c) => !identityConflictsWithCase(c.case, ctx.aiClientIdentity!)
    );
    if (candidates.length < before) {
      logger.info('Removed conflicting case candidates', {
        client: ctx.aiClientIdentity.clientFullName,
        removed: before - candidates.length,
      });
    }
  }

  if (candidates.length) {
    const caseHints = await getCaseHintsForCases(
      candidates.map((c) => c.case.case_number)
    );
    ctx.caseMatchingHints = mergeMatchingHints(ctx.caseMatchingHints, caseHints);
  }

  return candidates;
}
