import { getEnv } from '../config/env.js';
import { getCaseById, getCaseBySlackChannelId } from '../db/supabase.js';
import {
  extractDropboxError,
  generateDropboxPermalink,
  isDropboxFileConflict,
  uploadFileToDropbox,
} from './dropboxService.js';
import { resolveCaseSlackChannelId, slackService } from './slackService.js';
import { resolveFolderPathForCase } from '../utils/perFileFolder.js';
import { sanitizeDropboxFilename } from '../utils/filenameRename.js';
import { logger } from '../utils/logger.js';
import type { Case } from '../types/index.js';

const PHOTOS_FOLDER = 'Photos';
const MAX_BYTES = 50 * 1024 * 1024;
const RETRY_DELAYS_MS = [0, 30_000, 120_000];

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface CasePhotoSource {
  /** Stable id embedded in the filename so retries and duplicate events never double-save. */
  sourceId: string;
  mimeType: string;
  originalName?: string | null;
  download: () => Promise<Buffer>;
}

export interface CasePhotoBatch {
  caseNumber: string;
  /** e.g. "Text from Mayra Nevarez" or "Slack - Dina Flores". */
  label: string;
  sentAt: Date;
  photos: CasePhotoSource[];
  /** Where to post the confirmation; defaults to the case channel. */
  notify?: { channelId: string; threadTs?: string };
}

export function isImageMime(mime: string | null | undefined): boolean {
  return Boolean(mime && mime.toLowerCase().startsWith('image/'));
}

function extensionFor(photo: CasePhotoSource): string {
  const fromName = photo.originalName?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return fromName ?? EXTENSION_BY_MIME[photo.mimeType.toLowerCase()] ?? 'jpg';
}

function localStamp(at: Date): string {
  const tz = getEnv().SLACK_REMINDER_TIMEZONE.trim() || 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}.${get('minute')}`;
}

function photoFilename(batch: CasePhotoBatch, photo: CasePhotoSource): string {
  const shortId = photo.sourceId.replace(/[^A-Za-z0-9-]/g, '').slice(-14);
  const ext = extensionFor(photo);
  return (
    sanitizeDropboxFilename(`${localStamp(batch.sentAt)} ${batch.label} (${shortId}).${ext}`) ??
    `${localStamp(batch.sentAt)} (${shortId}).${ext}`
  );
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function notifySaved(
  caseRow: Case,
  batch: CasePhotoBatch,
  folderPath: string,
  saved: number
): Promise<void> {
  try {
    const channelId = batch.notify?.channelId ?? (await resolveCaseSlackChannelId(caseRow));
    if (!channelId) return;
    let folderLink: string | null = null;
    try {
      folderLink = await generateDropboxPermalink(folderPath);
    } catch {
      folderLink = null;
    }
    const noun = saved === 1 ? 'photo' : 'photos';
    const target = folderLink ? `<${folderLink}|Photos>` : PHOTOS_FOLDER;
    const text = `📁 Saved ${saved} ${noun} to Dropbox › ${target}`;
    if (batch.notify?.threadTs) {
      await slackService.postThreadReply(channelId, batch.notify.threadTs, text);
    } else {
      await slackService.postChannelMessage(channelId, text);
    }
  } catch (err) {
    logger.warn('Case photo import: Slack confirmation failed', {
      caseNumber: caseRow.case_number,
      err: String(err),
    });
  }
}

/** Save images into the case's Photos folder. New uploads only — never moves or renames. */
export async function importCasePhotos(batch: CasePhotoBatch): Promise<{ saved: number; skipped: number }> {
  const caseRow = await getCaseById(batch.caseNumber);
  if (!caseRow) {
    logger.warn('Case photo import: unknown case', { caseNumber: batch.caseNumber });
    return { saved: 0, skipped: batch.photos.length };
  }
  const folderPath = await resolveFolderPathForCase(batch.caseNumber, caseRow, PHOTOS_FOLDER);

  let saved = 0;
  let skipped = 0;
  for (const photo of batch.photos) {
    const filename = photoFilename(batch, photo);
    try {
      const bytes = await withRetries(photo.download);
      if (!bytes.length || bytes.length > MAX_BYTES) {
        throw new Error(`Unexpected image size (${bytes.length} bytes)`);
      }
      await uploadFileToDropbox(folderPath, filename, bytes);
      saved++;
      logger.info('Case photo saved to Dropbox', {
        caseNumber: batch.caseNumber,
        path: `${folderPath}/${filename}`,
      });
    } catch (err) {
      if (isDropboxFileConflict(err)) {
        skipped++;
        continue;
      }
      skipped++;
      logger.error('Case photo import failed', {
        caseNumber: batch.caseNumber,
        sourceId: photo.sourceId,
        err: extractDropboxError(err),
      });
    }
  }

  if (saved) await notifySaved(caseRow, batch, folderPath, saved);
  return { saved, skipped };
}

async function downloadSlackFile(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Slack file download failed: HTTP ${res.status}`);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error('Slack returned a login page — the bot token needs the files:read scope');
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Events sometimes omit URLs (file_access: check_file_info). */
async function lookupSlackFileUrl(fileId: string): Promise<string | null> {
  const res = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    file?: { url_private_download?: string; url_private?: string };
  };
  if (!data.ok) throw new Error(`Slack files.info failed: ${data.error ?? 'unknown'}`);
  return data.file?.url_private_download ?? data.file?.url_private ?? null;
}

interface SlackEventFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

/**
 * Staff dropped images into a case channel (message subtype file_share). Bot posts are
 * ignored — Quo Router texts arrive through /ingest/case-photos instead.
 */
export async function handleCaseChannelFileShare(event: Record<string, unknown>): Promise<void> {
  if (event.bot_id || event.subtype !== 'file_share') return;
  const channelId = typeof event.channel === 'string' ? event.channel : '';
  const files = (Array.isArray(event.files) ? event.files : []) as SlackEventFile[];
  const images = files.filter((f) => f.id && isImageMime(f.mimetype));
  if (!channelId || !images.length) return;

  const caseRow = await getCaseBySlackChannelId(channelId);
  if (!caseRow) return;

  const userId = typeof event.user === 'string' ? event.user : '';
  const uploader = userId ? await slackService.getUserDisplayName(userId).catch(() => '') : '';
  const ts = typeof event.ts === 'string' ? event.ts : '';

  await importCasePhotos({
    caseNumber: caseRow.case_number,
    label: uploader ? `Slack - ${uploader}` : 'Slack',
    sentAt: ts ? new Date(Number(ts) * 1000) : new Date(),
    photos: images.map((f) => ({
      sourceId: f.id!,
      mimeType: f.mimetype!,
      originalName: f.name ?? null,
      download: async () => {
        const url =
          f.url_private_download ?? f.url_private ?? (await lookupSlackFileUrl(f.id!));
        if (!url) throw new Error('Slack file has no download URL');
        return downloadSlackFile(url);
      },
    })),
    notify: ts ? { channelId, threadTs: ts } : undefined,
  });
}
