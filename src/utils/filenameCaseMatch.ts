import type { Case, CaseCandidate } from '../types/index.js';

const FILENAME_STOPWORDS = new Set([
  'standard',
  'release',
  'bundle',
  'letter',
  'notice',
  'page',
  'from',
  'final',
  'signed',
  'copy',
  'scan',
  'file',
  'document',
  'incoming',
  'fax',
]);

/** Client-name tokens from attachment filename (e.g. Galeas Montoya Lourdes 89195.pdf). */
export function clientTokensFromFilename(filename: string): string[] {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  return [
    ...new Set(
      base
        .toLowerCase()
        .split(/[^a-z]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !FILENAME_STOPWORDS.has(t) && !/^\d+$/.test(t))
    ),
  ];
}

export function filenameMatchesCase(filename: string, caseRow: Case): boolean {
  const tokens = clientTokensFromFilename(filename);
  if (!tokens.length) return false;

  const channel = caseRow.slack_channel_name.toLowerCase();
  const folder = (caseRow.dropbox_folder_name ?? '').toLowerCase();
  const hits = tokens.filter((t) => channel.includes(t) || folder.includes(t));

  if (tokens.length >= 2) return hits.length >= 2;
  return hits.length >= 1;
}

export function topCandidateMatchesFilename(
  candidates: CaseCandidate[],
  filename: string
): boolean {
  const top = candidates[0];
  if (!top) return false;
  return filenameMatchesCase(filename, top.case);
}

export function isGenericFilingSender(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase();
  const domain = lower.split('@')[1] ?? '';
  return (
    domain.includes('noreply') ||
    domain.includes('no-reply') ||
    domain.includes('adobesign') ||
    domain.includes('hellofax') ||
    domain.includes('procareinjury') ||
    domain.includes('docusign') ||
    domain.includes('mail.adobe')
  );
}
