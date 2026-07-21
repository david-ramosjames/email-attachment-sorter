export class SlackApiError extends Error {
  readonly code: string;
  readonly retryAfterSec: number | null;

  constructor(method: string, code: string, retryAfterSec?: number | null) {
    super(`Slack API ${method} failed: ${code}`);
    this.name = 'SlackApiError';
    this.code = code;
    this.retryAfterSec = retryAfterSec ?? null;
  }
}

export function slackApiErrorCode(err: unknown): string | null {
  if (err instanceof SlackApiError) return err.code;
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/Slack API \S+ failed: (\w+)/);
  return match?.[1] ?? null;
}

export function slackRetryAfterSec(err: unknown): number | null {
  if (err instanceof SlackApiError && err.retryAfterSec != null && err.retryAfterSec > 0) {
    return err.retryAfterSec;
  }
  return null;
}

export function isSlackMessageNotFoundError(err: unknown): boolean {
  return slackApiErrorCode(err) === 'message_not_found';
}

export function isSlackRateLimitedError(err: unknown): boolean {
  const code = slackApiErrorCode(err);
  return code === 'ratelimited' || code === 'rate_limited';
}

/** Stored queue-card pointer is no longer usable — clear DB refs instead of retrying forever. */
export function isStaleSlackQueueCardError(err: unknown): boolean {
  const code = slackApiErrorCode(err);
  return (
    code === 'message_not_found' ||
    code === 'channel_not_found' ||
    code === 'is_archived' ||
    code === 'cant_update_message'
  );
}
