/** Slack mrkdwn in section fields is limited to 2000 characters per field. */
export const SLACK_FIELD_TEXT_MAX = 500;

/** Section block mrkdwn text limit */
export const SLACK_SECTION_TEXT_MAX = 2900;

/** Escape characters that break Slack mrkdwn or look like invalid links. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Prevent Slack from treating @ in emails as mention syntax when building button payloads. */
function neutralizeSlackMentions(text: string): string {
  return text.replace(/@/g, '@\u200b');
}

export function truncateSlackField(text: string, max = SLACK_FIELD_TEXT_MAX): string {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

export function slackFieldText(text: string, max = SLACK_FIELD_TEXT_MAX): string {
  return neutralizeSlackMentions(escapeSlackMrkdwn(truncateSlackField(text, max)));
}

export function slackSectionText(text: string): string {
  return neutralizeSlackMentions(
    escapeSlackMrkdwn(truncateSlackField(text, SLACK_SECTION_TEXT_MAX))
  );
}

/** Slack mrkdwn hyperlink — must not be passed through escapeSlackMrkdwn. */
export function slackMrkdwnLink(url: string, label: string): string {
  const safeUrl = url.trim().replace(/[<>]/g, '');
  const safeLabel = label.trim().replace(/[|<>]/g, '');
  return `<${safeUrl}|${safeLabel}>`;
}

/** Escaped body plus unescaped links/mentions appended (for section blocks). */
export function slackSectionWithExtras(
  body: string,
  extras: string[],
  max = SLACK_SECTION_TEXT_MAX
): string {
  const suffix = extras.filter(Boolean).join('\n');
  const room = max - suffix.length - (suffix ? 1 : 0);
  const head = slackSectionText(truncateSlackField(body, Math.max(room, 0)));
  return suffix ? `${head}\n${suffix}` : head;
}
