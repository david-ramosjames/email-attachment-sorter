import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { ensureDropboxAccessToken, dropboxAuthMode } from './services/dropboxAuth.js';
import { startDropboxSyncScheduler } from './services/dropboxSyncService.js';
import { logger } from './utils/logger.js';

const env = getEnv();
const app = createApp();

app.listen(env.PORT, () => {
  logger.info('RJL File Sorter started', {
    port: env.PORT,
    dropboxAuth: dropboxAuthMode(),
  });
  startDropboxSyncScheduler(env.DROPBOX_SYNC_INTERVAL_MINUTES);
  ensureDropboxAccessToken().catch((err) => {
    logger.error('Dropbox token warmup failed', { err: String(err) });
  });
});
