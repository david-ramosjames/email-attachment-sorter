import { z } from 'zod';
import type { EmailProviderAdapter } from './types.js';
import type { InboundEmailPayload } from '../../types/index.js';

const sendgridSchema = z.object({
  gmail_message_id: z.string().optional(),
  message_id: z.string().optional(),
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  received_at: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        type: z.string().optional(),
        size: z.number().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
});

function parseEmailList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.flatMap((s) =>
    s.split(',').map((e) => {
      const match = e.match(/<([^>]+)>/);
      return (match ? match[1] : e).trim();
    })
  );
}

export const sendgridEmailAdapter: EmailProviderAdapter = {
  name: 'sendgrid',

  canHandle(headers, body): boolean {
    const provider = headers['x-email-provider'] ?? headers['X-Email-Provider'];
    if (provider === 'sendgrid') return true;
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return typeof b.from === 'string' && (b.gmail_message_id !== undefined || b.message_id !== undefined);
  },

  parse(body: unknown): InboundEmailPayload {
    const parsed = sendgridSchema.parse(body);
    const attachments = parsed.attachments ?? [];
    if (attachments.length === 0) {
      throw new Error('No attachments in email payload');
    }

    return {
      gmailMessageId:
        parsed.gmail_message_id ?? parsed.message_id ?? `sendgrid-${Date.now()}`,
      fromEmail: parseEmailList(parsed.from)[0] ?? parsed.from,
      toEmails: parseEmailList(parsed.to),
      ccEmails: parseEmailList(parsed.cc),
      subject: parsed.subject ?? '',
      bodyExcerpt: (parsed.text ?? parsed.html ?? '').slice(0, 2000),
      receivedAt: parsed.received_at ?? new Date().toISOString(),
      attachments: attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.type ?? 'application/octet-stream',
        size: a.size ?? 0,
        contentBase64: a.content,
        downloadUrl: a.url,
      })),
    };
  },
};
