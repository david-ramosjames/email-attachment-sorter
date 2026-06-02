import { EXTERNAL_FILE_LINK_MIME } from '../constants/externalLinks.js';
import type { FileSorterItem, InboundAttachment } from '../types/index.js';

export interface ExternalFileLink {
  url: string;
  provider: 'google_drive' | 'dropbox' | 'other';
  fileId: string | null;
  label: string;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

const GOOGLE_DRIVE_FILE =
  /https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|document\/d\/)([a-zA-Z0-9_-]+)[^\s<>"']*/gi;

const DROPBOX_SHARED = /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|scl|sh)\/[^\s<>"']+/gi;

const HTML_HREF = /href=["']([^"']+)["']/gi;

function normalizeUrl(url: string): string {
  return url
    .replace(/&amp;/g, '&')
    .replace(/[),.]+$/g, '')
    .trim();
}

function addGoogleDriveLink(links: ExternalFileLink[], seen: Set<string>, rawUrl: string): void {
  const url = normalizeUrl(rawUrl);
  const match = url.match(
    /(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|document\/d\/)([a-zA-Z0-9_-]+)/i
  );
  if (!match) return;
  const canonical = `https://drive.google.com/file/d/${match[1]}/view`;
  if (seen.has(canonical)) return;
  seen.add(canonical);
  links.push({
    url: canonical,
    provider: 'google_drive',
    fileId: match[1] ?? null,
    label: match[1] ? `Google Drive file (${shortId(match[1])})` : 'Google Drive file',
  });
}

function addDropboxLink(links: ExternalFileLink[], seen: Set<string>, rawUrl: string): void {
  const url = normalizeUrl(rawUrl);
  if (!/(?:www\.)?dropbox\.com\/(?:s|scl|sh)\//i.test(url)) return;
  if (seen.has(url)) return;
  seen.add(url);
  links.push({
    url,
    provider: 'dropbox',
    fileId: null,
    label: 'Dropbox shared link',
  });
}

export function extractExternalFileLinks(text: string): ExternalFileLink[] {
  const links: ExternalFileLink[] = [];
  const seen = new Set<string>();
  const source = text || '';

  for (const match of source.matchAll(GOOGLE_DRIVE_FILE)) {
    addGoogleDriveLink(links, seen, match[0]);
  }

  for (const match of source.matchAll(DROPBOX_SHARED)) {
    addDropboxLink(links, seen, match[0]);
  }

  for (const match of source.matchAll(HTML_HREF)) {
    const href = match[1];
    if (!href) continue;
    if (/drive\.google\.com|docs\.google\.com/i.test(href)) {
      addGoogleDriveLink(links, seen, href);
    } else if (/dropbox\.com/i.test(href)) {
      addDropboxLink(links, seen, href);
    }
  }

  return links;
}

export function externalLinkToAttachment(link: ExternalFileLink): InboundAttachment {
  return {
    filename: link.label,
    mimeType: EXTERNAL_FILE_LINK_MIME,
    size: 0,
    downloadUrl: link.url,
  };
}

export function isExternalLinkAttachment(attachment: InboundAttachment): boolean {
  return attachment.mimeType === EXTERNAL_FILE_LINK_MIME;
}

export function isExternalLinkItem(item: FileSorterItem): boolean {
  return item.attachment_mime_type === EXTERNAL_FILE_LINK_MIME;
}

export function externalLinkUrlFromItem(item: FileSorterItem): string | null {
  if (!isExternalLinkItem(item)) return null;
  return item.temp_storage_url?.trim() || null;
}
