import { Router } from 'express';
import path from 'path';
import { getEnv } from '../config/env.js';
import { listFileSorterItemsByReceivedDates } from '../db/supabase.js';
import { slackService } from '../services/slackService.js';
import type { FileSorterItem, FileSorterItemStatus } from '../types/index.js';
import { slackQueueMessageUrl } from '../utils/slackMessageUrl.js';
import { logger } from '../utils/logger.js';

export const dashboardRouter = Router();

const dashboardPath = path.join(process.cwd(), 'public', 'dashboard.html');
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface DashboardItemRow {
  id: string;
  subject: string;
  attachmentFilename: string;
  status: FileSorterItemStatus;
  statusLabel: string;
  outcome: 'sorted' | 'pending' | 'skipped';
  caseConfidence: number | null;
  caseConfidenceLabel: string;
  suggestedCaseNumber: string | null;
  receivedAt: string;
  slackUrl: string | null;
  taggedUserIds: string[];
  taggedUserLabel: string;
}

export interface DashboardUserMetric {
  userId: string;
  displayName: string;
  tagged: number;
  completed: number;
  pending: number;
  skipped: number;
}

export interface DashboardSummary {
  from: string;
  to: string;
  timeZone: string;
  summary: {
    total: number;
    sorted: number;
    pending: number;
    skipped: number;
  };
  userMetrics: DashboardUserMetric[];
  items: DashboardItemRow[];
}

export function parseTaggedUserIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function statusLabel(status: FileSorterItemStatus): string {
  const map: Record<FileSorterItemStatus, string> = {
    saved: 'Sorted',
    pending_review: 'Pending review',
    needs_attention: 'Needs attention',
    approved: 'Approved',
    ignored: 'Do not sort',
    failed: 'Failed',
  };
  return map[status] ?? status;
}

function outcomeForStatus(status: FileSorterItemStatus): DashboardItemRow['outcome'] {
  if (status === 'saved') return 'sorted';
  if (status === 'ignored') return 'skipped';
  return 'pending';
}

function itemReceivedAt(item: FileSorterItem): string {
  return item.email_received_at ?? item.created_at;
}

function formatCaseConfidence(confidence: number | null): string {
  if (confidence == null || Number.isNaN(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

function toDashboardRow(item: FileSorterItem): DashboardItemRow {
  const taggedUserIds = parseTaggedUserIds(item.queue_tagged_slack_user_id);
  return {
    id: item.id,
    subject: item.subject?.trim() || '(no subject)',
    attachmentFilename: item.attachment_filename,
    status: item.status,
    statusLabel: statusLabel(item.status),
    outcome: outcomeForStatus(item.status),
    caseConfidence: item.ai_case_confidence,
    caseConfidenceLabel: formatCaseConfidence(item.ai_case_confidence),
    suggestedCaseNumber: item.suggested_case_number,
    receivedAt: itemReceivedAt(item),
    slackUrl: slackQueueMessageUrl(item.slack_queue_channel_id, item.slack_queue_message_ts),
    taggedUserIds,
    taggedUserLabel: '—',
  };
}

export function buildUserMetrics(
  rows: DashboardItemRow[],
  displayNames: Map<string, string>
): DashboardUserMetric[] {
  const byUser = new Map<string, DashboardUserMetric>();

  for (const row of rows) {
    for (const userId of row.taggedUserIds) {
      let metric = byUser.get(userId);
      if (!metric) {
        metric = {
          userId,
          displayName: displayNames.get(userId) ?? userId,
          tagged: 0,
          completed: 0,
          pending: 0,
          skipped: 0,
        };
        byUser.set(userId, metric);
      }
      metric.tagged++;
      if (row.outcome === 'sorted') metric.completed++;
      else if (row.outcome === 'skipped') metric.skipped++;
      else metric.pending++;
    }
  }

  return [...byUser.values()].sort(
    (a, b) => b.tagged - a.tagged || a.displayName.localeCompare(b.displayName)
  );
}

async function resolveTaggedUserLabels(
  rows: DashboardItemRow[]
): Promise<Map<string, string>> {
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const id of row.taggedUserIds) userIds.add(id);
  }

  const displayNames = new Map<string, string>();
  await Promise.all(
    [...userIds].map(async (userId) => {
      displayNames.set(userId, await slackService.getUserDisplayName(userId));
    })
  );

  for (const row of rows) {
    row.taggedUserLabel = row.taggedUserIds.length
      ? row.taggedUserIds.map((id) => displayNames.get(id) ?? id).join(', ')
      : '—';
  }

  return displayNames;
}

export async function buildDashboardSummary(
  from: string,
  to: string,
  timeZone: string,
  items: FileSorterItem[]
): Promise<DashboardSummary> {
  const rows = items.map(toDashboardRow);
  const displayNames = await resolveTaggedUserLabels(rows);
  const userMetrics = buildUserMetrics(rows, displayNames);

  return {
    from,
    to,
    timeZone,
    summary: {
      total: rows.length,
      sorted: rows.filter((r) => r.outcome === 'sorted').length,
      pending: rows.filter((r) => r.outcome === 'pending').length,
      skipped: rows.filter((r) => r.outcome === 'skipped').length,
    },
    userMetrics,
    items: rows,
  };
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateRangeQuery(req: {
  query: Record<string, unknown>;
}): { from: string; to: string } {
  const fromRaw = String(req.query.from ?? '').trim();
  const toRaw = String(req.query.to ?? '').trim();

  if (fromRaw && toRaw && YMD.test(fromRaw) && YMD.test(toRaw)) {
    return fromRaw <= toRaw ? { from: fromRaw, to: toRaw } : { from: toRaw, to: fromRaw };
  }

  const daysParsed = parseInt(String(req.query.days ?? 7), 10);
  const days = Number.isFinite(daysParsed) ? Math.min(Math.max(daysParsed, 1), 30) : 7;
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  return { from: formatYmd(from), to: formatYmd(to) };
}

dashboardRouter.get('/dashboard', (_req, res) => {
  res.sendFile(dashboardPath, (err) => {
    if (err) res.status(404).send('Dashboard not found');
  });
});

dashboardRouter.get('/api/dashboard/recent', async (req, res) => {
  try {
    const timeZone = getEnv().SLACK_REMINDER_TIMEZONE.trim() || 'America/Chicago';
    const { from, to } = parseDateRangeQuery(req);
    const items = await listFileSorterItemsByReceivedDates(from, to, timeZone);
    const summary = await buildDashboardSummary(from, to, timeZone, items);
    res.json(summary);
  } catch (err) {
    logger.error('Dashboard recent items failed', { err: String(err) });
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});
