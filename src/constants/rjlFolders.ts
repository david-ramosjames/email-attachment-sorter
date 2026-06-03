/** Core subfolders — most filings (pre-lit and general). */
export const RJL_CORE_SUBFOLDERS = [
  'Correspondence',
  'Expenses',
  'Intake',
  'Investigation',
  'LOP',
  'Lost Wages',
  'Medical',
  'PD',
  'Photos',
  'Settlement',
  'Subrogation',
] as const;

/** Litigation subfolders — use once a case enters litigation. */
export const RJL_LITIGATION_SUBFOLDERS = [
  'Correspondence Litigation',
  'Demand',
  'Deposition',
  'Discovery',
  'Experts',
  'Mediation',
  'Pleadings',
  'Trial',
] as const;

/** All standard RJL subfolders (indexed paths; folder may not exist in Dropbox yet). */
export const RJL_STANDARD_SUBFOLDERS = [
  ...RJL_CORE_SUBFOLDERS,
  ...RJL_LITIGATION_SUBFOLDERS,
] as const;

export type RjlCoreSubfolder = (typeof RJL_CORE_SUBFOLDERS)[number];
export type RjlLitigationSubfolder = (typeof RJL_LITIGATION_SUBFOLDERS)[number];
export type RjlSubfolder = (typeof RJL_STANDARD_SUBFOLDERS)[number];

const LITIGATION_FOLDER_SET = new Set<string>(
  RJL_LITIGATION_SUBFOLDERS.map((f) => f.toLowerCase())
);

/** Maps AI document types to preferred RJL Dropbox subfolder names. */
export const DOCUMENT_TYPE_TO_SUBFOLDER: Record<string, RjlSubfolder | string> = {
  'Medical Records': 'Medical',
  Bills: 'Expenses',
  Pleadings: 'Pleadings',
  Discovery: 'Discovery',
  'Court Notices': 'Correspondence Litigation',
  Correspondence: 'Correspondence',
  Photos: 'Photos',
  Settlement: 'Settlement',
  Insurance: 'Subrogation',
  Intake: 'Intake',
  Misc: 'Correspondence',
};

/** Slack channel topic stage indicates litigation (not pre-lit). */
export function caseStageIsLitigation(topicStage: string | null | undefined): boolean {
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

export function isLitigationSubfolder(label: string): boolean {
  return LITIGATION_FOLDER_SET.has(label.trim().toLowerCase());
}

/** Match a label to a known folder (case-insensitive) or title-case a custom folder name. */
export function normalizeFolderLabel(label: string): string {
  const trimmed = label.trim().replace(/^[`'*_\s]+|[`'*_\s]+$/g, '').trim();
  if (!trimmed) return trimmed;

  const known = RJL_STANDARD_SUBFOLDERS.find((f) => f.toLowerCase() === trimmed.toLowerCase());
  if (known) return known;

  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function dropboxPathForCaseSubfolder(caseRootPath: string, folderLabel: string): string {
  const root = caseRootPath.replace(/\/+$/, '');
  const label = normalizeFolderLabel(folderLabel);
  return `${root}/${label}`.replace(/\/+/g, '/');
}

/** Parse "276. REGINA PEEK ETAL 3 (DOL 04-22-20)" → "276" */
export function parseCaseNumberFromDropboxFolder(folderName: string): string | null {
  const match = folderName.match(/^(\d+)\./);
  return match?.[1] ?? null;
}
