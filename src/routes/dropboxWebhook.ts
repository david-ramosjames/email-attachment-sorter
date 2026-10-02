import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { getEnv } from '../config/env.js';
import { triggerEvidenceChanges } from '../services/evidencePhotoSyncService.js';
import { logger } from '../utils/logger.js';

export const dropboxWebhookRouter = Router();

/** Dropbox signs the raw body with HMAC-SHA256 using the app secret (hex digest). */
function isValidDropboxSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = getEnv().DROPBOX_APP_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.trim(), 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Endpoint verification: echo the challenge back as plain text.
dropboxWebhookRouter.get('/webhooks/dropbox', (req, res) => {
  const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : '';
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(challenge);
});

dropboxWebhookRouter.post('/webhooks/dropbox', (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = req.header('X-Dropbox-Signature');
  if (!isValidDropboxSignature(rawBody, signature)) {
    logger.warn('Dropbox webhook rejected — bad or missing signature');
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);

  setImmediate(() => triggerEvidenceChanges('webhook'));
});
