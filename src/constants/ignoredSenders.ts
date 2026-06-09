/** Inbound senders that should not create File Sorter queue items. */
const IGNORED_SENDER_EMAILS = new Set([
  'listsender-ttlaadvocates@lyris.ttla.com',
]);

/** Personal inboxes — skip mail addressed To these (not the shared file-sorter mailbox). */
const IGNORED_TO_EMAILS = new Set([
  'laura@ramosjames.com',
  'jon@ramosjames.com',
  'david@ramosjames.com',
]);

export function normalizeSenderEmail(from: string): string {
  const trimmed = from.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  return (angle?.[1] ?? trimmed).toLowerCase();
}

export function isIgnoredInboundSender(fromEmail: string): boolean {
  return IGNORED_SENDER_EMAILS.has(normalizeSenderEmail(fromEmail));
}

/** Skip only when every To recipient is a personal inbox (mixed To e.g. intake@ + david@ still processes). */
export function isIgnoredInboundRecipient(toEmails: string[]): boolean {
  if (!toEmails.length) return false;
  return toEmails.every((email) => IGNORED_TO_EMAILS.has(normalizeSenderEmail(email)));
}
