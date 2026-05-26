import type { InboundEmailPayload } from '../../types/index.js';

export interface EmailProviderAdapter {
  readonly name: string;
  canHandle(headers: Record<string, string | string[] | undefined>, body: unknown): boolean;
  parse(body: unknown): InboundEmailPayload;
}
