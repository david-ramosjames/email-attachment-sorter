import { Router, type NextFunction, type Request, type Response } from 'express';
import { getClientSupabase } from '../db/clientSupabase.js';
import {
  getMedicalImportJob,
  previewMedicalImportFolders,
  startMedicalImport,
} from '../services/medicalFolderImportService.js';
import { logger } from '../utils/logger.js';

type AuthenticatedRequest = Request & {
  firmUser?: { id: string; email: string };
};

async function requireFirmUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const client = getClientSupabase();
  if (!token || !client) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { data, error } = await client.auth.getUser(token);
  const email = data.user?.email?.toLowerCase() ?? '';
  if (error || !data.user || !email.endsWith('@ramosjames.com')) {
    res.status(403).json({ error: 'Firm authorization required' });
    return;
  }

  req.firmUser = { id: data.user.id, email };
  next();
}

export const medicalImportRouter = Router();
medicalImportRouter.use('/medical-import', requireFirmUser);

medicalImportRouter.get('/medical-import/folders', async (req: AuthenticatedRequest, res) => {
  try {
    const caseNumber = String(req.query.caseNumber ?? '').trim();
    if (!caseNumber) {
      res.status(400).json({ error: 'caseNumber is required' });
      return;
    }
    const folders = await previewMedicalImportFolders(caseNumber);
    res.json({ folders });
  } catch (err) {
    logger.error('Medical import folder preview failed', { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : 'Preview failed' });
  }
});

medicalImportRouter.post('/medical-import/jobs', async (req: AuthenticatedRequest, res) => {
  try {
    const caseId = String(req.body?.caseId ?? '').trim();
    const caseNumber = String(req.body?.caseNumber ?? '').trim();
    const folderPath = String(req.body?.folderPath ?? '').trim();
    if (!caseId || !caseNumber || !folderPath) {
      res.status(400).json({ error: 'caseId, caseNumber, and folderPath are required' });
      return;
    }

    const client = getClientSupabase();
    const { data: caseRow } = await client!
      .from('cases')
      .select('id,case_number')
      .eq('id', caseId)
      .maybeSingle();
    if (!caseRow || String(caseRow.case_number).trim() !== caseNumber) {
      res.status(400).json({ error: 'Case does not match case number' });
      return;
    }

    const job = await startMedicalImport({
      caseId,
      caseNumber,
      folderPath,
      startedBy: req.firmUser!.id,
    });
    res.status(202).json({ job });
  } catch (err) {
    logger.error('Medical import launch failed', { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

medicalImportRouter.get('/medical-import/jobs/:jobId', async (req: AuthenticatedRequest, res) => {
  try {
    const job = await getMedicalImportJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Import job not found' });
      return;
    }
    res.json({ job });
  } catch (err) {
    logger.error('Medical import status failed', { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : 'Status failed' });
  }
});
