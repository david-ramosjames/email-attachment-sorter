import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { dropboxAuthMode, ensureDropboxAccessToken } from './services/dropboxAuth.js';
import { getDropboxConfigIssue } from './config/env.js';
import { startDropboxSyncScheduler } from './services/dropboxSyncService.js';
import { logger } from './utils/logger.js';

const env = getEnv();
const app = createApp();

app.listen(env.PORT, () => {
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
});
