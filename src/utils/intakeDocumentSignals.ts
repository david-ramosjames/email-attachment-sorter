import type { MatchContext } from '../types/index.js';

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
