import { Router } from 'express';
import path from 'path';
import { getEnv } from '../config/env.js';
import { isCaseQueueChannel } from '../utils/queueChannel.js';
import {
  listFileSorterItemsByReceivedDates,
  listFileSorterItemsReceivedSinceHours,
  listCases,
  receivedDateKey,
} from '../db/supabase.js';
import { getSlackUserDisplayNames } from '../services/slackUserDirectory.js';
import type { Case, FileSorterItem, FileSorterItemStatus } from '../types/index.js';
import {
  caseStaffDisplayName,
  isSlackUserId,
  storedTaggedNameMap,
} from '../utils/mentionDisplay.js';
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
  /** Case attorney (filter only — not used for assignee scoring). */
  attorneyUserId: string | null;
  attorneyLabel: string;
  routedToCaseChannel: boolean;
  reviewChannelLabel: string;
}

export interface DashboardUserMetric {
  userId: string;
  displayName: string;
  tagged: number;
  completed: number;
  pending: number;
  skipped: number;
}

export interface DashboardAttorneyOption {
  userId: string;
  displayName: string;
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
  attorneys: DashboardAttorneyOption[];
  items: DashboardItemRow[];
}

export function parseTaggedUserIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Dashboard assignee: paralegal only on case-channel cards; all tagged users on shared queue. */
export function dashboardAssigneeUserIds(item: FileSorterItem): string[] {
  const ids = parseTaggedUserIds(item.queue_tagged_slack_user_id);
  if (!isCaseQueueChannel(item.slack_queue_channel_id)) return ids;
  if (ids.length <= 1) return ids;
  return [ids[ids.length - 1]!];
}

/**
 * Attorney for team filtering: case record first, else first mention on case-channel cards
 * when attorney + paralegal were both tagged (attorney is tagged first).
 */
export function dashboardAttorneyUserId(
  item: FileSorterItem,
  caseRow: Case | null
): string | null {
  const fromCase = caseRow?.attorney_slack_user_id?.trim();
  if (fromCase) return fromCase;

  const ids = parseTaggedUserIds(item.queue_tagged_slack_user_id);
  if (isCaseQueueChannel(item.slack_queue_channel_id) && ids.length >= 2) {
    return ids[0]!;
  }
  return null;
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

function toDashboardRow(item: FileSorterItem, caseRow: Case | null): DashboardItemRow {
  const taggedUserIds = dashboardAssigneeUserIds(item);
  const attorneyUserId = dashboardAttorneyUserId(item, caseRow);
  const routedToCaseChannel = isCaseQueueChannel(item.slack_queue_channel_id);
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
    taggedUserLabel: taggedUserIds.length ? '' : '—',
    attorneyUserId,
    attorneyLabel: '',
    routedToCaseChannel,
    reviewChannelLabel: routedToCaseChannel ? 'Case channel' : 'Queue',
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

export function buildAttorneyOptions(
  rows: DashboardItemRow[],
  displayNames: Map<string, string>
): DashboardAttorneyOption[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!row.attorneyUserId) continue;
    if (byId.has(row.attorneyUserId)) continue;
    byId.set(
      row.attorneyUserId,
      row.attorneyLabel?.trim() ||
        displayNames.get(row.attorneyUserId) ||
        row.attorneyUserId
    );
  }
  return [...byId.entries()]
    .map(([userId, displayName]) => ({ userId, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function loadCaseMap(items: FileSorterItem[]): Promise<Map<string, Case>> {
  const needed = new Set(
    items
      .map((item) => item.suggested_case_number?.trim())
      .filter((value): value is string => Boolean(value))
  );
  if (!needed.size) return new Map();

  const cases = await listCases();
  const map = new Map<string, Case>();
  for (const caseRow of cases) {
    if (needed.has(caseRow.case_number)) {
      map.set(caseRow.case_number, caseRow);
    }
  }
  return map;
}

async function resolveTaggedUserLabels(
  rows: DashboardItemRow[],
  items: FileSorterItem[],
  caseMap: Map<string, Case>
): Promise<Map<string, string>> {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const displayNames = new Map<string, string>();
  const idsNeedingLookup = new Set<string>();

  for (const row of rows) {
    const item = itemById.get(row.id);
    const allTaggedIds = parseTaggedUserIds(item?.queue_tagged_slack_user_id);
    const fullNameMap = storedTaggedNameMap(allTaggedIds, item?.queue_tagged_slack_user_name);
    const caseRow = item?.suggested_case_number
      ? caseMap.get(item.suggested_case_number) ?? null
      : null;

    if (row.attorneyUserId) {
      if (caseRow?.attorney_slack_user_id === row.attorneyUserId && caseRow.attorney_name?.trim()) {
        displayNames.set(row.attorneyUserId, caseRow.attorney_name.trim());
        row.attorneyLabel = caseRow.attorney_name.trim();
      } else {
        const fromStored = fullNameMap?.get(row.attorneyUserId);
        if (fromStored) {
          displayNames.set(row.attorneyUserId, fromStored);
          row.attorneyLabel = fromStored;
        } else {
          idsNeedingLookup.add(row.attorneyUserId);
        }
      }
    }

    for (const id of row.taggedUserIds) {
      const fromStored = fullNameMap?.get(id);
      if (fromStored) {
        displayNames.set(id, fromStored);
        continue;
      }

      const stored = row.taggedUserLabel?.trim();
      if (row.taggedUserIds.length === 1 && stored && stored !== '—' && !isSlackUserId(stored)) {
        displayNames.set(id, stored);
        continue;
      }
      idsNeedingLookup.add(id);
    }
  }

  if (idsNeedingLookup.size > 0) {
    const fromApi = await getSlackUserDisplayNames([...idsNeedingLookup]);
    for (const row of rows) {
      const item = itemById.get(row.id);
      const caseRow = item?.suggested_case_number
        ? caseMap.get(item.suggested_case_number) ?? null
        : null;

      const resolveOne = (id: string) => {
        if (!idsNeedingLookup.has(id) || displayNames.has(id)) return;
        const apiName = fromApi.get(id) ?? id;
        const name = isSlackUserId(apiName)
          ? caseStaffDisplayName(caseRow, id) ?? apiName
          : apiName;
        displayNames.set(id, name);
      };

      for (const id of row.taggedUserIds) resolveOne(id);
      if (row.attorneyUserId) resolveOne(row.attorneyUserId);
    }
  }

  for (const row of rows) {
    row.taggedUserLabel = row.taggedUserIds.length
      ? row.taggedUserIds.map((id) => displayNames.get(id) ?? id).join(', ')
      : '—';
    if (row.attorneyUserId) {
      row.attorneyLabel = displayNames.get(row.attorneyUserId) ?? row.attorneyUserId;
    }
  }

  return displayNames;
}

export async function buildDashboardSummary(
  from: string,
  to: string,
  timeZone: string,
  items: FileSorterItem[]
): Promise<DashboardSummary> {
  const caseMap = await loadCaseMap(items);
  const rows = items.map((item) =>
    toDashboardRow(
      item,
      item.suggested_case_number ? caseMap.get(item.suggested_case_number) ?? null : null
    )
  );
  const displayNames = await resolveTaggedUserLabels(rows, items, caseMap);
  const userMetrics = buildUserMetrics(rows, displayNames);
  const attorneys = buildAttorneyOptions(rows, displayNames);

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
    attorneys,
    items: rows,
  };
}

export async function buildDashboardSummaryForLastHours(
  hours: number,
  timeZone: string
): Promise<DashboardSummary & { windowStart: string; windowEnd: string }> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000);
  const items = await listFileSorterItemsReceivedSinceHours(hours, timeZone);
  const from = receivedDateKey(windowStart.toISOString(), timeZone);
  const to = receivedDateKey(windowEnd.toISOString(), timeZone);
  const summary = await buildDashboardSummary(from, to, timeZone, items);
  return {
    ...summary,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
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
