import { Router, type NextFunction, type Request, type Response } from 'express';
import { getClientSupabase } from '../db/clientSupabase.js';
import {
  DROPBOX_THUMBNAIL_SIZES,
  getDropboxThumbnailJpeg,
  type DropboxThumbnailSize,
} from '../services/dropboxService.js';
import { logger } from '../utils/logger.js';

const TOKEN_CACHE_MS = 5 * 60 * 1000;
const THUMB_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_DROPBOX = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const verifiedTokens = new Map<string, number>();
const thumbCache = new Map<string, Buffer>();
let thumbCacheBytes = 0;
let activeDropbox = 0;
const dropboxWaiters: Array<() => void> = [];

/**
 * Case Tracker staff auth. Accepts the Supabase access token as a Bearer header, or as
 * ?access_token= so a plain <img src> works (request logs record the path only).
 */
async function requireFirmUser(req: Request, res: Response, next: NextFunction) {
  const token =
    req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    (typeof req.query.access_token === 'string' ? req.query.access_token : undefined);
  const client = getClientSupabase();
  if (!token || !client) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const verifiedAt = verifiedTokens.get(token);
  if (verifiedAt && Date.now() - verifiedAt < TOKEN_CACHE_MS) {
    next();
    return;
  }

  const { data, error } = await client.auth.getUser(token);
  const email = data.user?.email?.toLowerCase() ?? '';
  if (error || !data.user || !email.endsWith('@ramosjames.com')) {
    res.status(403).json({ error: 'Firm authorization required' });
    return;
  }
  if (verifiedTokens.size > 1000) verifiedTokens.clear();
  verifiedTokens.set(token, Date.now());
  next();
}

async function withDropboxSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDropbox >= MAX_CONCURRENT_DROPBOX) {
    await new Promise<void>((resolve) => dropboxWaiters.push(resolve));
  }
  activeDropbox++;
  try {
    return await fn();
  } finally {
    activeDropbox--;
    dropboxWaiters.shift()?.();
  }
}

function cacheThumb(key: string, jpeg: Buffer): void {
  thumbCache.set(key, jpeg);
  thumbCacheBytes += jpeg.length;
  for (const [oldKey, oldBuf] of thumbCache) {
    if (thumbCacheBytes <= THUMB_CACHE_MAX_BYTES) break;
    thumbCache.delete(oldKey);
    thumbCacheBytes -= oldBuf.length;
  }
}

export const evidencePhotosRouter = Router();
evidencePhotosRouter.use('/evidence-photos', requireFirmUser);

/** Thumbnail streamed from Dropbox on demand; image bytes are never stored in Supabase. */
evidencePhotosRouter.get('/evidence-photos/:id/thumbnail', async (req, res) => {
  const id = req.params.id;
  const requested = String(req.query.size ?? 'w480h320');
  const size: DropboxThumbnailSize = DROPBOX_THUMBNAIL_SIZES.includes(
    requested as DropboxThumbnailSize
  )
    ? (requested as DropboxThumbnailSize)
    : 'w480h320';
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid photo id' });
    return;
  }

  try {
    const { data: row, error } = await getClientSupabase()!
      .from('evidence_photos')
      .select('dropbox_file_id, dropbox_rev')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    const etag = `"${row.dropbox_rev ?? row.dropbox_file_id}-${size}"`;
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const key = `${row.dropbox_file_id}:${row.dropbox_rev ?? ''}:${size}`;
    let jpeg = thumbCache.get(key);
    if (jpeg) {
      thumbCache.delete(key);
      thumbCache.set(key, jpeg);
    } else {
      jpeg = await withDropboxSlot(() => getDropboxThumbnailJpeg(row.dropbox_file_id, size));
      cacheThumb(key, jpeg);
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(jpeg);
  } catch (err) {
    logger.warn('Evidence photo thumbnail failed', {
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: 'Thumbnail unavailable' });
  }
});
