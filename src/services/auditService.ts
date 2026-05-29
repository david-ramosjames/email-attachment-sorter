import { createAuditEvent, listAuditEvents } from '../db/supabase.js';
import type { AuditEvent } from '../types/index.js';

export type AuditEventType =
  | 'email_received'
  | 'classification_complete'
  | 'slack_queued'
  | 'approved'
  | 'saved_to_dropbox'
  | 'needs_attention'
  | 'ignored'
  | 'failed'
  | 'thread_override'
  | 'duplicate_detected'
  | 'case_channel_cross_post_failed'
  | 'reindex_folders'
  | 'matching_hint_saved';

export const auditService = {
  async log(
    fileSorterItemId: string,
    eventType: AuditEventType,
    payload: Record<string, unknown> = {},
    createdBy?: string
  ): Promise<AuditEvent> {
    return createAuditEvent(fileSorterItemId, eventType, payload, createdBy);
  },

  async getTrail(fileSorterItemId: string): Promise<AuditEvent[]> {
    return listAuditEvents(fileSorterItemId);
  },
};
