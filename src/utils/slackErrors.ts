export function slackApiErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/Slack API \S+ failed: (\w+)/);
  return match?.[1] ?? null;
}

export function isSlackMessageNotFoundError(err: unknown): boolean {
  return slackApiErrorCode(err) === 'message_not_found';
}
