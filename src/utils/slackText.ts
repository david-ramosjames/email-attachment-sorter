/** Slack mrkdwn in section fields is limited to 2000 characters per field. */
export const SLACK_FIELD_TEXT_MAX = 1900;

/** Escape characters that break Slack mrkdwn or look like invalid links. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncateSlackField(text: string, max = SLACK_FIELD_TEXT_MAX): string {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

export function slackFieldText(text: string): string {
  return escapeSlackMrkdwn(truncateSlackField(text));
}
