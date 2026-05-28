import { Router } from 'express';
import { getDropboxAuthStatus } from '../services/dropboxAuth.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  const dropbox = getDropboxAuthStatus();
  res.json({
    status: 'ok',
    service: 'rjl-file-sorter',
    timestamp: new Date().toISOString(),
    dropbox: {
      configured: dropbox.configured,
      mode: dropbox.mode,
      ...(dropbox.configIssue ? { configIssue: dropbox.configIssue } : {}),
    },
  });
});
