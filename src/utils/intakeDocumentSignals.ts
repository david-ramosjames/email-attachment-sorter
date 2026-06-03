import type { MatchContext, FileSorterItem } from '../types/index.js';

export const INTAKE_NO_CASE_MARKER = '[Intake — no case folder yet]';

export const INTAKE_RAMOSJAMES_EMAIL = 'intake@ramosjames.com';

export function isIntakeRamosJamesAddress(email: string): boolean {
  return email.trim().toLowerCase() === INTAKE_RAMOSJAMES_EMAIL;
}

/** True when the message is from intake@ or forwards an intake@ request. */
export function isEmailFromIntake(ctx: {
  fromEmail: string;
  bodyExcerpt?: string | null;
  forwardedEmailContext?: string | null;
}): boolean {
  if (isIntakeRamosJamesAddress(ctx.fromEmail)) return true;

  const body = ctx.bodyExcerpt ?? '';
  if (/\bfrom:\s*[^\n]*intake@ramosjames\.com/i.test(body)) return true;

  const forwarded = ctx.forwardedEmailContext ?? '';
  if (/intake@ramosjames\.com/i.test(forwarded)) return true;

  return false;
}

/** New-client intake queue handling — only intake@ramosjames.com (not Adobe Sign / e-sign). */
export function isNewClientIntakeContext(ctx: MatchContext): boolean {
  return isEmailFromIntake(ctx);
}

export function isIntakeNoCaseItem(item: FileSorterItem): boolean {
  if (item.suggested_case_number) return false;
  if (item.ai_reason?.includes(INTAKE_NO_CASE_MARKER)) return true;
  return isEmailFromIntake({
    fromEmail: item.from_email,
    bodyExcerpt: item.body_excerpt,
  });
}

export function queueCaseLabel(item: FileSorterItem, caseRow: { slack_channel_name: string; case_number: string } | null): string {
  if (caseRow) {
    return `${caseRow.slack_channel_name} (${caseRow.case_number})`;
  }
  if (item.suggested_case_number) {
    return item.suggested_case_number;
  }
  if (isIntakeNoCaseItem(item)) {
    return 'Intake — no case folder yet';
  }
  return '—';
}

export function queueFolderLabel(item: FileSorterItem, folderFromPath: string): string {
  if (folderFromPath !== '—') return folderFromPath;
  if (isIntakeNoCaseItem(item)) return 'Intake';
  return '—';
}

export function queueDocumentTypeLabel(item: FileSorterItem, docTypes: string[]): string {
  if (docTypes.length) {
    return docTypes.length === 1 ? docTypes[0]! : docTypes.join(', ');
  }
  if (isIntakeNoCaseItem(item)) return 'Intake';
  return '—';
}
