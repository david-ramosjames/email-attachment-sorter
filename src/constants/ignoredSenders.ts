/** Inbound senders that should not create File Sorter queue items. */
const IGNORED_SENDER_EMAILS = new Set([
  'listsender-ttlaadvocates@lyris.ttla.com',
]);

export function normalizeSenderEmail(from: string): string {
  const trimmed = from.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  return (angle?.[1] ?? trimmed).toLowerCase();
}

export function isIgnoredInboundSender(fromEmail: string): boolean {
  return IGNORED_SENDER_EMAILS.has(normalizeSenderEmail(fromEmail));
}
