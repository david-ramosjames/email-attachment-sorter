import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { dropboxAuthMode, ensureDropboxAccessToken } from './services/dropboxAuth.js';
import { getDropboxConfigIssue } from './config/env.js';
import { startDropboxSyncScheduler } from './services/dropboxSyncService.js';
import { startTempStorageCleanupScheduler } from './services/tempStorageCleanupService.js';
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
});
