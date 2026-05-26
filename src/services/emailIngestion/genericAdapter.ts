import { z } from 'zod';
import type { EmailProviderAdapter } from './types.js';

const attachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string().optional().default('application/octet-stream'),
  size: z.number().optional().default(0),
  contentBase64: z.string().optional(),
  downloadUrl: z.string().url().optional(),
});

const genericSchema = z.object({
  gmailMessageId: z.string(),
  fromEmail: z.string().email(),
  toEmails: z.array(z.string()).default([]),
  ccEmails: z.array(z.string()).default([]),
  subject: z.string().default(''),
  bodyExcerpt: z.string().default(''),
  receivedAt: z.string().datetime().optional(),
  attachments: z.array(attachmentSchema).min(1),
});

export const genericEmailAdapter: EmailProviderAdapter = {
  name: 'generic',

  canHandle(_headers, body): boolean {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return typeof b.gmailMessageId === 'string' && Array.isArray(b.attachments);
  },

  parse(body: unknown) {
    const parsed = genericSchema.parse(body);
    return {
      gmailMessageId: parsed.gmailMessageId,
      fromEmail: parsed.fromEmail,
      toEmails: parsed.toEmails,
      ccEmails: parsed.ccEmails,
      subject: parsed.subject,
      bodyExcerpt: parsed.bodyExcerpt,
      receivedAt: parsed.receivedAt ?? new Date().toISOString(),
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentBase64: a.contentBase64,
        downloadUrl: a.downloadUrl,
      })),
    };
  },
};
