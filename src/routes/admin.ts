import { Router } from 'express';
import { listCases, listFileSorterItems } from '../db/supabase.js';
import type { FileSorterItemStatus } from '../types/index.js';
import { reindexDropboxFoldersForCase } from '../services/fileSorterWorkflow.js';
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
    const caseId = req.body?.caseId as string | undefined;
    if (!caseId) {
      res.status(400).json({ error: 'caseId is required' });
      return;
    }
    const count = await reindexDropboxFoldersForCase(caseId);
    res.json({ caseId, foldersIndexed: count });
  } catch (err) {
    logger.error('Reindex failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Reindex failed',
    });
  }
});
