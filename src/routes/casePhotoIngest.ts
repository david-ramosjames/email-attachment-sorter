import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { getEnv } from '../config/env.js';
import { importCasePhotos, isImageMime } from '../services/casePhotoImportService.js';
import { logger } from '../utils/logger.js';

export const casePhotoIngestRouter = Router();

function secretMatches(provided: string | undefined): boolean {
  const expected = getEnv().CASE_PHOTO_INGEST_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface IngestMedia {
  url?: unknown;
  type?: unknown;
}

/**
 * Quo Router forwards media from client texts here. Responds immediately; download,
 * Dropbox upload, and the Slack confirmation happen in the background.
 */
casePhotoIngestRouter.post('/ingest/case-photos', (req, res) => {
  if (!secretMatches(req.header('X-Ingest-Secret'))) {
    res.status(401).json({ error: 'Invalid ingest secret' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const caseNumber = String(body.caseNumber ?? '').trim();
  const messageId = String(body.messageId ?? '').trim();
  const senderName = String(body.senderName ?? '').trim();
  const sentAt = new Date(String(body.sentAt ?? ''));
  const media = (Array.isArray(body.media) ? body.media : []) as IngestMedia[];
  const images = media
    .map((m) => ({ url: typeof m.url === 'string' ? m.url : '', type: String(m.type ?? '') }))
    .filter((m) => /^https:\/\//i.test(m.url) && isImageMime(m.type));

  if (!caseNumber || !messageId) {
    res.status(400).json({ error: 'caseNumber and messageId are required' });
    return;
  }
  res.status(202).json({ accepted: images.length });
  if (!images.length) return;

  void importCasePhotos({
    caseNumber,
    label: senderName ? `Text from ${senderName}` : 'Text message',
    sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
    photos: images.map((m, i) => ({
      sourceId: `${messageId}-${i + 1}`,
      mimeType: m.type,
      download: async () => {
        const r = await fetch(m.url);
        if (!r.ok) throw new Error(`Quo media download failed: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      },
    })),
  }).catch((err) => {
    logger.error('Quo photo import failed', { caseNumber, messageId, err: String(err) });
  });
});
