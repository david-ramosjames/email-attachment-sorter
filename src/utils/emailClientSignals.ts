/** Vendor/investigator is asking RJL to identify which client a document belongs to. */
export function emailRequestsClientIdentification(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(name of (?:your )?client|your client for this|who is (?:the )?client|which client|what client|identify (?:the )?client)\b/i.test(
      t
    ) ||
    /\bplease (?:let me know|advise|confirm|provide).{0,40}\bclient\b/i.test(t) ||
    /\bclient (?:name|for this one)\b/i.test(t)
  );
}

/** Open-records / property investigation with no named PI client in the thread. */
export function emailIsOpenRecordsPropertyRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\borr\b/.test(t) ||
    /\bopen records\b/i.test(t) ||
    /\bcrime history search\b/i.test(t) ||
    /\b(?:cad|ap[d]) call sheet\b/i.test(t) ||
    /\bapartments in austin\b/i.test(t)
  );
}

export function clientIdentityIsUnknown(ctx: {
  bodyExcerpt?: string;
  subject?: string;
  aiClientIdentity?: { clientFullName?: string | null } | null;
}): boolean {
  const blob = [ctx.subject, ctx.bodyExcerpt].filter(Boolean).join('\n');
  if (emailRequestsClientIdentification(blob)) return true;
  if (!ctx.aiClientIdentity?.clientFullName?.trim()) {
    if (emailIsOpenRecordsPropertyRequest(blob)) return true;
  }
  return false;
}
