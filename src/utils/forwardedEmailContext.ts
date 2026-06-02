/**
 * Pull original sender / request context from forwarded Gmail threads
 * (e.g. intake@ramosjames.com requesting documents).
 */
export function extractForwardedEmailContext(body: string): string | null {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;

  const parts: string[] = [];

  const intakeLine = normalized.match(/[^\n]*intake@ramosjames\.com[^\n]*/i)?.[0]?.trim();
  if (intakeLine) parts.push(intakeLine);

  const forwardBlocks = normalized.split(
    /(?:\n-{3,}\s*Forwarded message\s*-{3,}|\nBegin forwarded message:)/i
  );
  const forwardTail = forwardBlocks.length > 1 ? forwardBlocks[forwardBlocks.length - 1]! : normalized;

  const fromMatch = forwardTail.match(/^From:\s*(.+)$/im);
  if (fromMatch?.[1]?.trim()) {
    parts.push(`Original sender: ${fromMatch[1].trim()}`);
  }

  const subjectMatch = forwardTail.match(/^Subject:\s*(.+)$/im);
  if (subjectMatch?.[1]?.trim()) {
    parts.push(`Original subject: ${subjectMatch[1].trim()}`);
  }

  const requestMatch = forwardTail.match(
    /(?:requesting|please provide|please send|send (?:us )?the following|need (?:the )?following documents?)[^\n]{0,240}/i
  );
  if (requestMatch?.[0]?.trim()) {
    parts.push(requestMatch[0].replace(/\s+/g, ' ').trim());
  }

  const unique = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  return unique.length ? unique.join(' · ') : null;
}

export function forwardedContextPromptSection(body: string): string {
  const context = extractForwardedEmailContext(body);
  return context ? `\nForwarded / original request context (use for case and folder):\n${context}` : '';
}
