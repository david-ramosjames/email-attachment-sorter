import type { FileSorterItem } from '../types/index.js';

export interface AutoLearnApprovalContext {
  fromEmail: string;
  subject: string;
  attachmentFilenames: string[];
  caseNumber: string;
  caseSlackChannelName: string;
  folderLabel: string | null;
  documentType: string | null;
  threadCaseOverrideText: string | null;
  threadFolderOverrideText: string | null;
}

export function buildSenderCaseHintText(
  ctx: AutoLearnApprovalContext,
  opts: { corrected: boolean }
): string {
  if (opts.corrected) {
    return `Emails from ${ctx.fromEmail} belong to case ${ctx.caseSlackChannelName} (${ctx.caseNumber}).`;
  }
  return (
    `Staff confirmed: emails from ${ctx.fromEmail} usually belong to case ` +
    `${ctx.caseSlackChannelName} (${ctx.caseNumber}).`
  );
}

export function buildSenderFolderHintText(
  ctx: AutoLearnApprovalContext,
  opts: { corrected: boolean }
): string | null {
  if (!ctx.folderLabel) return null;
  if (opts.corrected) {
    return (
      `Emails from ${ctx.fromEmail} (case ${ctx.caseNumber}) → folder ${ctx.folderLabel}.`
    );
  }
  return (
    `Staff confirmed: emails from ${ctx.fromEmail} (case ${ctx.caseNumber}) ` +
    `usually → folder ${ctx.folderLabel}.`
  );
}

/** Distinct subject/sender/filename patterns worth remembering (deduped). */
export function buildPatternSortHints(ctx: AutoLearnApprovalContext): string[] {
  const folder = ctx.folderLabel;
  if (!folder) return [];

  const hints: string[] = [];
  const subjectLower = ctx.subject.trim().toLowerCase();
  const fromLower = ctx.fromEmail.toLowerCase();
  const domain = fromLower.split('@')[1];

  if (
    /\bhas been sent out for signature\b/.test(subjectLower) ||
    /\bsent out for signature\b/.test(subjectLower)
  ) {
    hints.push(`Subject "sent out for signature" from ${ctx.fromEmail} → folder ${folder}.`);
  }

  if (/adobesign|docusign/.test(fromLower)) {
    hints.push(`E-signature notifications from ${ctx.fromEmail} → folder ${folder}.`);
  }

  if (domain && !domain.endsWith('ramosjames.com')) {
    hints.push(`Emails from @${domain} (case ${ctx.caseNumber}) → folder ${folder}.`);
  }

  for (const filename of ctx.attachmentFilenames) {
    const fn = filename.toLowerCase();
    if (/\blop\b/.test(fn)) {
      hints.push(`Filenames containing "LOP" from ${ctx.fromEmail} → folder ${folder}.`);
      break;
    }
    if (/\b(medical|records|billing|hospital|clinic|radiology)\b/.test(fn)) {
      hints.push(`Medical-record style filenames from ${ctx.fromEmail} → folder ${folder}.`);
      break;
    }
    if (/\b(demand|settlement|offer|mediation)\b/.test(fn)) {
      hints.push(`Demand/settlement style filenames from ${ctx.fromEmail} → folder ${folder}.`);
      break;
    }
    if (/\b(deposition|discovery|pleading|subpoena)\b/.test(fn)) {
      hints.push(`Litigation document filenames from ${ctx.fromEmail} → folder ${folder}.`);
      break;
    }
  }

  if (ctx.documentType && ctx.documentType !== 'needs_attention') {
    hints.push(
      `Document type ${ctx.documentType} from ${ctx.fromEmail} (case ${ctx.caseNumber}) → folder ${folder}.`
    );
  }

  return [...new Set(hints)];
}

export function buildThreadOverrideCaseHint(ctx: AutoLearnApprovalContext): string | null {
  if (!ctx.threadCaseOverrideText?.trim()) return null;
  return (
    `Thread Case: ${ctx.threadCaseOverrideText.trim()} → case ${ctx.caseSlackChannelName} (${ctx.caseNumber}).`
  );
}

export function buildThreadOverrideFolderHint(ctx: AutoLearnApprovalContext): string | null {
  if (!ctx.threadFolderOverrideText?.trim() || !ctx.folderLabel) return null;
  return (
    `Thread Folder: ${ctx.threadFolderOverrideText.trim()} → folder ${ctx.folderLabel} ` +
    `(case ${ctx.caseNumber}).`
  );
}

export function autoLearnContextFromApproval(opts: {
  trigger: FileSorterItem;
  batch: FileSorterItem[];
  caseNumber: string;
  caseSlackChannelName: string;
  confirmedFolderLabel: string | null;
  threadCaseOverrideText: string | null;
  threadFolderOverrideText: string | null;
}): AutoLearnApprovalContext {
  const savedInBatch = opts.batch.filter((i) => i.status === 'saved' || i.final_dropbox_path);
  const filenames =
    savedInBatch.length > 0
      ? savedInBatch.map((i) => i.attachment_filename)
      : opts.batch.map((i) => i.attachment_filename);

  const docType =
    opts.trigger.suggested_document_type ??
    opts.batch.find((i) => i.suggested_document_type)?.suggested_document_type ??
    null;

  return {
    fromEmail: opts.trigger.from_email,
    subject: opts.trigger.subject ?? '',
    attachmentFilenames: filenames,
    caseNumber: opts.caseNumber,
    caseSlackChannelName: opts.caseSlackChannelName,
    folderLabel: opts.confirmedFolderLabel,
    documentType: docType,
    threadCaseOverrideText: opts.threadCaseOverrideText,
    threadFolderOverrideText: opts.threadFolderOverrideText,
  };
}
