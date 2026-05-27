import { Router } from 'express';
import { listCases, listFileSorterItems } from '../db/supabase.js';
import type { FileSorterItemStatus } from '../types/index.js';
import { reindexDropboxFoldersForCase } from '../services/fileSorterWorkflow.js';
import {
  getLastDropboxSyncAt,
  syncDropboxStructure,
} from '../services/dropboxSyncService.js';
import { discoverCasesRoot, getCasesRootPath, verifyDropboxConnection } from '../services/dropboxService.js';
import { logger } from '../utils/logger.js';

export const adminRouter = Router();

adminRouter.get('/admin/file-sorter-items', async (req, res) => {
  try {
    const status = req.query.status as FileSorterItemStatus | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const items = await listFileSorterItems({ status, limit });
    res.json({ items, count: items.length });
  } catch (err) {
    logger.error('Admin list items failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to list items' });
  }
});

adminRouter.get('/admin/cases', async (_req, res) => {
  try {
    const cases = await listCases();
    res.json({ cases, count: cases.length });
  } catch (err) {
    logger.error('Admin list cases failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to list cases' });
  }
});

adminRouter.post('/admin/reindex-dropbox-folders', async (req, res) => {
  try {
    const caseNumber = req.body?.caseNumber as string | undefined;
    if (!caseNumber) {
      res.status(400).json({ error: 'caseNumber is required' });
      return;
    }
    const count = await reindexDropboxFoldersForCase(caseNumber);
    res.json({ caseNumber, foldersIndexed: count });
  } catch (err) {
    logger.error('Reindex failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Reindex failed',
    });
  }
});

/** Scan Dropbox for all case folders and index standard subfolders. */
adminRouter.post('/admin/sync-dropbox-structure', async (_req, res) => {
  try {
    const result = await syncDropboxStructure();
    res.json(result);
  } catch (err) {
    logger.error('Dropbox sync failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Dropbox sync failed',
    });
  }
});

adminRouter.get('/admin/dropbox-sync-status', (_req, res) => {
  res.json({
    lastSyncAt: getLastDropboxSyncAt(),
    casesRootPath: getCasesRootPath(),
  });
});

/** Discover RAMOS JAMES LAW CASES root without full index. */
adminRouter.post('/admin/discover-dropbox-root', async (_req, res) => {
  try {
    const result = await discoverCasesRoot();
    res.json(result);
  } catch (err) {
    logger.error('Dropbox discovery failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Discovery failed',
    });
  }
});

/** Check whether DROPBOX_ACCESS_TOKEN is valid. */
adminRouter.get('/admin/dropbox-connection', async (_req, res) => {
  try {
    const status = await verifyDropboxConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});
