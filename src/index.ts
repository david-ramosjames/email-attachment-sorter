import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { dropboxAuthMode, ensureDropboxAccessToken } from './services/dropboxAuth.js';
import { getDropboxConfigIssue } from './config/env.js';
import { startCaseSheetSyncScheduler } from './services/caseSheetSyncService.js';
import { startSlackCaseSyncScheduler } from './services/slackCaseSyncService.js';
import { ensureBotInQueueChannel } from './services/slackChannels.js';
import { startDropboxSyncScheduler } from './services/dropboxSyncService.js';
import { startQueueReminderScheduler, refreshPendingQueueCards } from './services/queueReminderService.js';
import { startEodStatusReportScheduler } from './services/eodStatusReportService.js';
import { startScoreboardEmailScheduler } from './services/scoreboardEmailService.js';
import { startTempStorageCleanupScheduler } from './services/tempStorageCleanupService.js';
import { isMedicalRecordsCaptureEnabled } from './services/medicalRecordsCaptureService.js';
import { logger } from './utils/logger.js';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    err: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});

const env = getEnv();
const app = createApp();

app.listen(env.PORT, () => {
  console.log(`RJL File Sorter listening on port ${env.PORT}`);
  logger.info('RJL File Sorter started', {
    port: env.PORT,
    dropboxAuth: dropboxAuthMode(),
    medicalRecordsCapture: isMedicalRecordsCaptureEnabled(),
  });
  const dropboxIssue = getDropboxConfigIssue();
  if (dropboxIssue) {
    logger.warn('Dropbox not configured — sync and Approve uploads disabled', {
      issue: dropboxIssue,
    });
  } else {
    startDropboxSyncScheduler(env.DROPBOX_SYNC_INTERVAL_MINUTES);
    ensureDropboxAccessToken().catch((err) => {
      logger.error('Dropbox token warmup failed', { err: String(err) });
    });
  }

  startTempStorageCleanupScheduler(env.TEMP_STORAGE_CLEANUP_INTERVAL_MINUTES);
  startCaseSheetSyncScheduler(env.CASE_SHEET_SYNC_INTERVAL_MINUTES);
  startSlackCaseSyncScheduler(env.SLACK_CASE_SYNC_INTERVAL_MINUTES);
  startQueueReminderScheduler(env.SLACK_QUEUE_REMINDER_CHECK_INTERVAL_MINUTES);
  startEodStatusReportScheduler(env.SLACK_EOD_REPORT_CHECK_INTERVAL_MINUTES);
  startScoreboardEmailScheduler(env.SCOREBOARD_EMAIL_CHECK_INTERVAL_MINUTES);

  void ensureBotInQueueChannel().catch((err) => {
    logger.error('Queue channel join on startup failed', { err: String(err) });
  });

  void refreshPendingQueueCards().catch((err) => {
    logger.error('Pending queue card refresh on startup failed', { err: String(err) });
  });
});
