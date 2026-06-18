import { getEnv } from '../config/env.js';

export function queueChannelId(): string {
  return getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID.trim();
}

export function isCaseQueueChannel(channelId: string | null | undefined): boolean {
  const id = channelId?.trim();
  if (!id) return false;
  return id !== queueChannelId();
}
