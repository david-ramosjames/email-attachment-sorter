import { Router } from 'express';
import path from 'path';
import {
  getScoreboardEmailSettings,
  saveScoreboardEmailSettings,
  getScoreboardEmailConfigIssue,
  runScoreboardEmail,
} from '../services/scoreboardEmailService.js';
import {
  getEvidencePhotoSettings,
  parseScanFolders,
  resolveEvidenceModel,
  saveEvidencePhotoSettings,
  type EvidencePhotoSettings,
} from '../services/evidencePhotoSettings.js';
import {
  clearEvidenceAnalysisPause,
  getEvidenceAnalysisStatus,
  getEvidencePhotoCounts,
  triggerEvidenceAnalysis,
} from '../services/evidencePhotoAnalysisService.js';
import {
  getEvidenceSyncStatus,
  runEvidenceReconciliation,
} from '../services/evidencePhotoSyncService.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const faqRouter = Router();

const faqPath = path.join(process.cwd(), 'public', 'faq.html');

faqRouter.get('/faq', (_req, res) => {
  res.sendFile(faqPath, (err) => {
    if (err) {
      res.status(404).send('FAQ page not found');
    }
  });
});

faqRouter.get('/api/faq/scoreboard-email-settings', async (_req, res) => {
  try {
    const settings = await getScoreboardEmailSettings();
    const configIssue = getScoreboardEmailConfigIssue(settings);
    res.json({
      settings,
      configIssue,
      recipientsText: settings.recipients.join(', '),
    });
  } catch (err) {
    logger.error('Load scoreboard email settings failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

faqRouter.put('/api/faq/scoreboard-email-settings', async (req, res) => {
  try {
    const body = req.body ?? {};
    const settings = await saveScoreboardEmailSettings({
      enabled: body.enabled,
      recipientsText:
        typeof body.recipientsText === 'string'
          ? body.recipientsText
          : typeof body.recipients === 'string'
            ? body.recipients
            : undefined,
      recipients: Array.isArray(body.recipients) ? body.recipients : undefined,
      sendAs: body.sendAs,
      sendTime: body.sendTime,
      days: Array.isArray(body.days) ? body.days : undefined,
      daysText: typeof body.daysText === 'string' ? body.daysText : undefined,
      hours: body.hours,
      subject: body.subject,
    });
    const configIssue = getScoreboardEmailConfigIssue(settings);
    res.json({
      ok: true,
      settings,
      configIssue,
      recipientsText: settings.recipients.join(', '),
    });
  } catch (err) {
    logger.error('Save scoreboard email settings failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to save settings',
    });
  }
});

async function evidencePayload(settings: EvidencePhotoSettings) {
  const env = getEnv();
  let counts: Record<string, number> | null = null;
  let countsError: string | null = null;
  try {
    counts = await getEvidencePhotoCounts();
  } catch (err) {
    countsError = err instanceof Error ? err.message : String(err);
  }
  const sync = getEvidenceSyncStatus();
  return {
    settings,
    effectiveModel: resolveEvidenceModel(settings),
    defaultModel: env.OPENAI_VISION_MODEL || env.OPENAI_MODEL,
    counts,
    countsError,
    analysis: getEvidenceAnalysisStatus(),
    sync: {
      reconcileInProgress: sync.reconcileInProgress,
      lastReconcileAt: sync.lastReconcile?.finishedAt ?? null,
      lastChangesError: sync.lastChangesError,
    },
  };
}

faqRouter.get('/api/faq/evidence-photos-settings', async (_req, res) => {
  try {
    res.json(await evidencePayload(await getEvidencePhotoSettings()));
  } catch (err) {
    logger.error('Load evidence photo settings failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

faqRouter.put('/api/faq/evidence-photos-settings', async (req, res) => {
  try {
    const body = req.body ?? {};
    const before = await getEvidencePhotoSettings();
    const settings = await saveEvidencePhotoSettings({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      captioningEnabled:
        typeof body.captioningEnabled === 'boolean' ? body.captioningEnabled : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      imageDetail: body.imageDetail,
      maxPerMinute: body.maxPerMinute,
      pollIntervalMinutes: body.pollIntervalMinutes,
      reconcileTime: body.reconcileTime,
      scanFolders:
        body.scanFolders !== undefined ? parseScanFolders(body.scanFolders) : undefined,
    });
    clearEvidenceAnalysisPause();
    triggerEvidenceAnalysis('settings');
    const foldersChanged =
      before.scanFolders.map((f) => f.toLowerCase()).sort().join('|') !==
      settings.scanFolders.map((f) => f.toLowerCase()).sort().join('|');
    if (settings.enabled && foldersChanged) {
      void runEvidenceReconciliation().catch((err) => {
        logger.error('Evidence photos re-scan after folder change failed', { err: String(err) });
      });
    }
    res.json({ ok: true, ...(await evidencePayload(settings)) });
  } catch (err) {
    logger.error('Save evidence photo settings failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to save settings',
    });
  }
});

faqRouter.post('/api/faq/scoreboard-email-test', async (_req, res) => {
  try {
    const result = await runScoreboardEmail({ force: true });
    if (!result.sent) {
      res.status(400).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('Test scoreboard email failed', { err: String(err) });
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to send test email',
    });
  }
});
