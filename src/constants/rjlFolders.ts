/** Standard subfolders inside every RJL case folder on Dropbox. */
export const RJL_STANDARD_SUBFOLDERS = [
  'Correspondence',
  'Expenses',
  'Intake',
  'Investigation',
  'LOP',
  'Lost Wages',
  'Medical',
  'PD',
  'Photos',
  'Pleadings',
  'Settlement',
  'Subrogation',
] as const;

export type RjlSubfolder = (typeof RJL_STANDARD_SUBFOLDERS)[number];

/** Maps AI document types to RJL Dropbox subfolder names. */
export const DOCUMENT_TYPE_TO_SUBFOLDER: Record<string, RjlSubfolder> = {
  'Medical Records': 'Medical',
  Bills: 'Expenses',
  Pleadings: 'Pleadings',
  Discovery: 'Investigation',
  'Court Notices': 'Correspondence',
  Correspondence: 'Correspondence',
  Photos: 'Photos',
  Settlement: 'Settlement',
  Insurance: 'Subrogation',
  Intake: 'Intake',
  Misc: 'Correspondence',
};

/** Parse "276. REGINA PEEK ETAL 3 (DOL 04-22-20)" → "276" */
export function parseCaseNumberFromDropboxFolder(folderName: string): string | null {
  const match = folderName.match(/^(\d+)\./);
  return match?.[1] ?? null;
}
