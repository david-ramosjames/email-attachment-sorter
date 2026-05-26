import type { EmailProviderAdapter } from './types.js';
import { genericEmailAdapter } from './genericAdapter.js';
import { sendgridEmailAdapter } from './sendgridAdapter.js';
import type { InboundEmailPayload } from '../../types/index.js';

const adapters: EmailProviderAdapter[] = [
  sendgridEmailAdapter,
  genericEmailAdapter,
];

export function resolveEmailAdapter(
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): EmailProviderAdapter {
  for (const adapter of adapters) {
    if (adapter.canHandle(headers, body)) return adapter;
  }
  return genericEmailAdapter;
}

export function parseInboundEmail(
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): InboundEmailPayload {
  const adapter = resolveEmailAdapter(headers, body);
  return adapter.parse(body);
}

export { genericEmailAdapter, sendgridEmailAdapter };
