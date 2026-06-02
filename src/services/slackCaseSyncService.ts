import { batchUpsertCaseSlackChannels } from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import {
  clearSlackChannelNameCache,
  joinAllPublicSlackChannels,
  listAllSlackChannels,
  type SlackPublicJoinResult,
} from './slackChannels.js';
import { parseCasesFromSlackChannels } from '../utils/slackCaseParser.js';
import { logger } from '../utils/logger.js';

export interface SlackCaseSyncResult {
  channelsListed: number;
  casesParsed: number;
  casesUpserted: number;
  skippedChannelCount: number;
  skippedChannels: string[];
  duplicateCaseNumbers: string[];
  publicJoin?: SlackPublicJoinResult;
  syncedAt: string;
  skipped?: boolean;
  error?: string;
}

let lastSyncAt: Date | null = null;
let syncInProgress = false;

export function getLastSlackCaseSyncAt(): Date | null {
  return lastSyncAt;
}

/** List Slack channels and upsert case rows (name + id; case # parsed from channel slug). */
export async function syncCasesFromSlack(): Promise<SlackCaseSyncResult> {
  if (syncInProgress) {
    return {
      channelsListed: 0,
      casesParsed: 0,
      casesUpserted: 0,
      skippedChannelCount: 0,
      skippedChannels: [],
      duplicateCaseNumbers: [],
      syncedAt: new Date().toISOString(),
      skipped: true,
      error: 'Slack case sync already running. Wait a minute and try again.',
    };
  }

  syncInProgress = true;
  try {
    const channels = await listAllSlackChannels();

    if (getEnv().SLACK_AUTO_JOIN_PUBLIC_CHANNELS) {
      void joinAllPublicSlackChannels(channels)
        .then((joinResult) => {
          logger.info('Background public Slack join finished', { ...joinResult });
        })
        .catch((err) => {
          logger.error('Background public Slack join failed', { err: String(err) });
        });
    }

    const { cases, skippedChannels, duplicateCaseNumbers } =
      parseCasesFromSlackChannels(channels);

    if (!cases.length) {
      return {
        channelsListed: channels.length,
        casesParsed: 0,
        casesUpserted: 0,
        skippedChannelCount: skippedChannels.length,
        skippedChannels,
        duplicateCaseNumbers,
        syncedAt: new Date().toISOString(),
        error:
          channels.length === 0
            ? 'No Slack channels returned. Check SLACK_BOT_TOKEN and channels:read scope.'
            : 'No case channels found. Channels must end with -{caseNumber} (e.g. javiermejias-etal-625). Invite the bot to private case channels.',
      };
    }

    const upserted = await batchUpsertCaseSlackChannels(cases, {
      preserveDropboxFolder: true,
    });
    clearSlackChannelNameCache();
    lastSyncAt = new Date();

    const result: SlackCaseSyncResult = {
      channelsListed: channels.length,
      casesParsed: cases.length,
      casesUpserted: upserted,
      skippedChannelCount: skippedChannels.length,
      skippedChannels,
      duplicateCaseNumbers,
      syncedAt: lastSyncAt.toISOString(),
    };
    if (getEnv().SLACK_AUTO_JOIN_PUBLIC_CHANNELS) {
      result.publicJoin = {
        publicChannels: channels.filter((c) => !c.isPrivate && !c.isArchived).length,
        alreadyMember: 0,
        joined: 0,
        failed: 0,
        failedChannelNames: [],
      };
    }
    logger.info('Slack case sync complete', { ...result, publicJoinStarted: Boolean(getEnv().SLACK_AUTO_JOIN_PUBLIC_CHANNELS) });
    return result;
  } catch (err) {
    logger.error('Slack case sync error', { err: String(err) });
    return {
      channelsListed: 0,
      casesParsed: 0,
      casesUpserted: 0,
      skippedChannelCount: 0,
      skippedChannels: [],
      duplicateCaseNumbers: [],
      syncedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    syncInProgress = false;
  }
}

export function startSlackCaseSyncScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0) return;

  const run = () => {
    if (syncInProgress) {
      logger.info('Skipping scheduled Slack case sync — previous sync still running');
      return;
    }
    syncCasesFromSlack().catch((err) => {
      logger.error('Scheduled Slack case sync failed', { err: String(err) });
    });
  };

  setTimeout(run, 60_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Slack case sync scheduler started', { intervalMinutes, firstRunDelaySec: 60 });
}
