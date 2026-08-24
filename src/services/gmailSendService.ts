import { getGoogleAccessToken } from './googleAuth.js';
import { logger } from '../utils/logger.js';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function encodeBase64Url(value: string | Buffer): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 for non-ASCII display names / subjects
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface SendGmailMessageOpts {
  /** Workspace user to send as (must be delegated to the service account). */
  sendAs: string;
  to: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  cc?: string[];
  replyTo?: string;
}

function buildMimeMessage(opts: SendGmailMessageOpts): string {
  const to = opts.to.join(', ');
  const cc = opts.cc?.length ? opts.cc.join(', ') : '';
  const boundary = `boundary_${Date.now().toString(36)}`;
  const hasHtml = Boolean(opts.htmlBody?.trim());

  const headers = [
    `From: ${opts.sendAs}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (!hasHtml) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      opts.textBody,
    ].join('\r\n');
  }

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.textBody,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.htmlBody,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Send email via Gmail API using domain-wide delegation (impersonated Workspace user). */
export async function sendGmailMessage(opts: SendGmailMessageOpts): Promise<{ id: string }> {
  if (!opts.sendAs.trim()) throw new Error('sendAs is required');
  if (!opts.to.length) throw new Error('At least one recipient is required');

  const token = await getGoogleAccessToken({
    scopes: [GMAIL_SEND_SCOPE],
    subject: opts.sendAs,
  });

  const raw = encodeBase64Url(buildMimeMessage(opts));
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error('Gmail send failed', {
      status: res.status,
      sendAs: opts.sendAs,
      toCount: opts.to.length,
      body: body.slice(0, 500),
    });
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? 'unknown' };
}

export function isGmailSendConfigured(sendAs?: string | null): {
  ok: boolean;
  issue?: string;
} {
  const as = sendAs?.trim();
  if (!as) {
    return {
      ok: false,
      issue:
        'No send-as user configured. Set GOOGLE_WORKSPACE_IMPERSONATED_USER or Save a From address in FAQ Settings.',
    };
  }
  return { ok: true };
}
