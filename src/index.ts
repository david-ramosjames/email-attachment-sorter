import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { startDropboxSyncScheduler } from './services/dropboxSyncService.js';
import { logger } from './utils/logger.js';

const env = getEnv();
const app = createApp();

app.listen(env.PORT, () => {
  logger.info('RJL File Sorter started', { port: env.PORT });
  startDropboxSyncScheduler(env.DROPBOX_SYNC_INTERVAL_MINUTES);
});
