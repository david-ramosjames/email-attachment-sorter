/** Open a Slack message in the app or web client. */
export function slackQueueMessageUrl(
  channelId: string | null | undefined,
  messageTs: string | null | undefined
): string | null {
  const channel = channelId?.trim();
  const ts = messageTs?.trim();
  if (!channel || !ts) return null;
  const params = new URLSearchParams({ channel, message_ts: ts });
  return `https://slack.com/app_redirect?${params.toString()}`;
}
