import { getEnv } from '../config/env.js';

/** Slack archives path segment: p + ts without the decimal (e.g. 1704067200.123456 → p1704067200123456). */
export function slackMessagePathTs(messageTs: string): string {
  return `p${messageTs.trim().replace('.', '')}`;
}

function slackTeamHost(): string | null {
  const raw = getEnv().SLACK_TEAM_DOMAIN?.trim();
  if (!raw) return null;
  if (raw.includes('://')) {
    try {
      return new URL(raw).host;
    } catch {
      return null;
    }
  }
  const withoutProtocol = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (withoutProtocol.includes('.slack.com')) return withoutProtocol;
  return `${withoutProtocol}.slack.com`;
}

/** Open a specific Slack message (not just the channel). */
export function slackQueueMessageUrl(
  channelId: string | null | undefined,
  messageTs: string | null | undefined
): string | null {
  const channel = channelId?.trim();
  const ts = messageTs?.trim();
  if (!channel || !ts) return null;

  const pathTs = slackMessagePathTs(ts);
  const teamHost = slackTeamHost();
  if (teamHost) {
    return `https://${teamHost}/archives/${channel}/${pathTs}`;
  }
  return `https://slack.com/archives/${channel}/${pathTs}`;
}
