/** Adobe Sign / engagement contract emails — not an existing case document. */
export function isLikelyNewClientContract(ctx: {
  fromEmail: string;
  subject: string;
  bodyExcerpt: string;
  attachmentFilename: string;
}): boolean {
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
