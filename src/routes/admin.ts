import { Router } from 'express';
import {
  listCases,
  listFileSorterItems,
  listMatchingHints,
  upsertSenderCaseHint,
  upsertSenderSortHint,
  addCaseOnlyHint,
} from '../db/supabase.js';
import type { FileSorterItemStatus, MatchingHintType } from '../types/index.js';
import { reindexDropboxFoldersForCase } from '../services/fileSorterWorkflow.js';
import { cleanupExpiredTempStorage } from '../services/tempStorageCleanupService.js';
import {
  getLastDropboxSyncAt,
  syncDropboxStructure,
} from '../services/dropboxSyncService.js';
import { getDropboxAuthStatus } from '../services/dropboxAuth.js';
import { discoverCasesRoot, getCasesRootPath, verifyDropboxConnection } from '../services/dropboxService.js';
import { logger } from '../utils/logger.js';

export const adminRouter = Router();

adminRouter.get('/admin/matching-hints', async (req, res) => {
  try {
    const caseNumber = req.query.caseNumber as string | undefined;
    const senderEmail = req.query.senderEmail as string | undefined;
    const hintType = req.query.hintType as MatchingHintType | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    const hints = await listMatchingHints({ hintType, caseNumber, senderEmail, limit });
    res.json({ hints, count: hints.length });
  } catch (err) {
    logger.error('Admin list matching hints failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to list matching hints' });
  }
});

adminRouter.post('/admin/matching-hints', async (req, res) => {
  try {
    const caseNumber = req.body?.caseNumber as string | undefined;
    const hintType = (req.body?.hintType as MatchingHintType | undefined) ?? 'case';
    const hintText = req.body?.hintText as string | undefined;
    const senderEmail = req.body?.senderEmail as string | undefined;
    if (!hintText?.trim()) {
      res.status(400).json({ error: 'hintText is required' });
      return;
    }
    if (hintType === 'sort') {
      if (!senderEmail?.trim()) {
        res.status(400).json({ error: 'senderEmail is required for sort hints' });
        return;
      }
      await upsertSenderSortHint({
        senderEmail: senderEmail.trim(),
        hintText: hintText.trim(),
        caseNumber: caseNumber?.trim() ?? null,
        source: 'admin',
      });
    } else {
      if (!caseNumber?.trim()) {
        res.status(400).json({ error: 'caseNumber is required for case hints' });
        return;
      }
      if (senderEmail?.trim()) {
        await upsertSenderCaseHint({
          caseNumber: caseNumber.trim(),
          senderEmail: senderEmail.trim(),
          hintText: hintText.trim(),
          source: 'admin',
        });
      } else {
        await addCaseOnlyHint({
          caseNumber: caseNumber.trim(),
          hintText: hintText.trim(),
          source: 'admin',
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('Admin create matching hint failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to create matching hint',
    });
  }
});

adminRouter.post('/admin/cleanup-temp-storage', async (_req, res) => {
  try {
    const result = await cleanupExpiredTempStorage();
    res.json(result);
  } catch (err) {
    logger.error('Temp storage cleanup failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Cleanup failed',
    });
  }
});

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
    if (result.skipped) {
      res.status(409).json(result);
      return;
    }
    if (result.error && result.caseFoldersFound === 0) {
      res.status(500).json(result);
      return;
    }
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

/** Check whether Dropbox credentials (refresh token or access token) work. */
adminRouter.get('/admin/dropbox-connection', async (_req, res) => {
  try {
    const auth = getDropboxAuthStatus();
    const status = await verifyDropboxConnection();
    res.json({ ...status, auth });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), auth: getDropboxAuthStatus() });
  }
});
