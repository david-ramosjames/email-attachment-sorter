import type { MatchContext, FileSorterItem } from '../types/index.js';

export const INTAKE_NO_CASE_MARKER = '[Intake — no case folder yet]';

/** Retainer/contract intake — often no Slack case channel yet; do not assign an existing case lightly. */
export function isNewClientIntakeContext(ctx: MatchContext): boolean {
  if (ctx.aiClientIdentity?.isNewClientIntake) return true;

  const blob = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.fromEmail,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  if (/\bhas been sent out for signature\b/.test(blob)) return true;
  if (/\bsent out for signature to\b/.test(blob)) return true;
  if (/\bawaiting (your )?signature\b/.test(blob)) return true;

  if (/adobesign|docusign/.test(ctx.fromEmail.toLowerCase())) {
    if (/\b(contract|retainer|engagement|fee agreement)\b/.test(blob)) return true;
  }

  if (/\bcontract\b.*\bramos james law\b/.test(blob)) return true;
  if (/\bramos james law\b.*\bcontract\b/.test(blob)) return true;

  return false;
}

export function isIntakeNoCaseItem(item: FileSorterItem): boolean {
  if (item.suggested_case_number) return false;
  if (item.ai_reason?.includes(INTAKE_NO_CASE_MARKER)) return true;
  return isNewClientIntakeContext({
    fromEmail: item.from_email,
    toEmails: item.to_emails,
    ccEmails: item.cc_emails,
    subject: item.subject ?? '',
    bodyExcerpt: item.body_excerpt ?? '',
    attachmentFilename: item.attachment_filename,
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
