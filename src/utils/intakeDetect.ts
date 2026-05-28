export function isEmploymentRecordsAuthorization(ctx: {
  subject: string;
  bodyExcerpt: string;
  attachmentFilename: string;
  documentExcerpt?: string;
}): boolean {
  const text = [
    ctx.subject,
    ctx.bodyExcerpt,
    ctx.attachmentFilename,
    ctx.documentExcerpt ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return (
    /\b(employment\s+authorization|authorization\s+for\s+.*employment)\b/.test(text) ||
    /\bemployee\s+records\s+request\b/.test(text) ||
    /\bemployment\s+records\b/.test(text) ||
    /\brelease\s+of\s+(?:her|his|their)?\s*employment\b/.test(text) ||
    /\bexamined?\s+any\s+and\s+all\s+employment\s+records\b/.test(text) ||
    /\bemployment\s+authorization/i.test(ctx.attachmentFilename)
  );
}

/** Adobe Sign / engagement contract emails — not an existing case document. */
export function isLikelyNewClientContract(ctx: {
  fromEmail: string;
  subject: string;
  bodyExcerpt: string;
  attachmentFilename: string;
  documentExcerpt?: string;
}): boolean {
  if (
    isEmploymentRecordsAuthorization({
      subject: ctx.subject,
      bodyExcerpt: ctx.bodyExcerpt,
      attachmentFilename: ctx.attachmentFilename,
      documentExcerpt: ctx.documentExcerpt,
    })
  ) {
    return false;
  }

  const from = ctx.fromEmail.toLowerCase();
  const text = [ctx.subject, ctx.bodyExcerpt, ctx.attachmentFilename]
    .join(' ')
    .toLowerCase();

  const fromAdobe =
    from.includes('adobesign') || from.includes('echosign') || from.includes('docusign');

  const contractLanguage =
    /\b(contract|agreement|retainer|engagement letter)\b/.test(text) &&
    (/\b(signed and filed|is signed|has been signed|please sign)\b/.test(text) ||
      /\bexecuted\b/.test(text));

  const filenameContract =
    /\bcontract\b/i.test(ctx.attachmentFilename) &&
    /\b(sign|signed|english)\b/i.test(ctx.attachmentFilename);

  return (fromAdobe && contractLanguage) || filenameContract;
}
