import { getAppSetting, upsertAppSetting } from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import {
  buildDashboardSummaryForLastHours,
  type DashboardSummary,
} from '../routes/dashboard.js';
import { ensureBotInQueueChannel } from './slackChannels.js';
import { isWorkdayInTimezone } from './queueReminderService.js';
import { slackMrkdwnLink } from '../utils/slackText.js';
import { logger } from '../utils/logger.js';

const SLACK_API = 'https://slack.com/api';
const EOD_SETTING_KEY = 'eod_status_report_last_sent';

let reportInProgress = false;

function reportTimezone(): string {
  return getEnv().SLACK_REMINDER_TIMEZONE.trim() || 'America/Chicago';
}

function publicAppUrl(): string {
  const raw = getEnv().PUBLIC_APP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return 'https://email-attachment-sorter-production.up.railway.app';
}

function dashboardUrl(from?: string, to?: string): string {
  const base = `${publicAppUrl()}/dashboard`;
  if (!from || !to) return base;
  const params = new URLSearchParams({ from, to });
  return `${base}?${params.toString()}`;
}

function parseReportTime(time: string): { hour: number; minute: number } | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function localDateTimeParts(tz: string, at: Date = new Date()): {
  dateKey: string;
  hour: number;
  minute: number;
  label: string;
} {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);

  return { dateKey, hour, minute, label };
}

export function isEodReportDue(
  tz: string,
  reportTime: string,
  windowMinutes: number,
  at: Date = new Date()
): boolean {
  const target = parseReportTime(reportTime);
  if (!target) return false;

  const { hour, minute } = localDateTimeParts(tz, at);
  const nowMins = hour * 60 + minute;
  const targetMins = target.hour * 60 + target.minute;
  return nowMins >= targetMins && nowMins < targetMins + windowMinutes;
}

async function hasEodReportBeenSent(dateKey: string): Promise<boolean> {
  const state = await getAppSetting<{ dateKey?: string }>(EOD_SETTING_KEY);
  return state?.dateKey === dateKey;
}

async function markEodReportSent(dateKey: string): Promise<void> {
  await upsertAppSetting(EOD_SETTING_KEY, {
    dateKey,
    sentAt: new Date().toISOString(),
  });
}

export function formatEodStatusSlackMessage(
  summary: DashboardSummary & { windowStart?: string; windowEnd?: string },
  options?: { at?: Date; timeZone?: string }
): string {
  const tz = options?.timeZone ?? summary.timeZone;
  const at = options?.at ?? new Date();
  const whenLabel = localDateTimeParts(tz, at).label;
  const link = slackMrkdwnLink(
    dashboardUrl(summary.from, summary.to),
    'Open activity dashboard'
  );

  const lines: string[] = [
    ':bar_chart: *File Sorter — End of day status*',
    `_Prior ${getEnv().SLACK_EOD_REPORT_HOURS} hours · ${whenLabel}_`,
    '',
    `*Totals* — ${summary.summary.total} items · ${summary.summary.sorted} sorted · ${summary.summary.pending} not sorted · ${summary.summary.skipped} do not sort`,
  ];

  if (summary.userMetrics.length) {
    lines.push('', '*By assignee*');
    for (const metric of summary.userMetrics) {
      lines.push(
        `• *${metric.displayName}* — Tagged ${metric.tagged} · Completed ${metric.completed} · Pending ${metric.pending}`
      );
    }
  } else {
    lines.push('', '_No tagged assignments in this window._');
  }

  lines.push('', link);
  return lines.join('\n');
}

async function postToQueueChannel(text: string): Promise<void> {
  const channel = getEnv().SLACK_FILE_SORTER_QUEUE_CHANNEL_ID;
  await ensureBotInQueueChannel();

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getEnv().SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error ?? 'unknown'}`);
  }
}

export async function runEodStatusReport(options?: {
  force?: boolean;
}): Promise<{ posted: boolean; reason?: string }> {
  if (reportInProgress) {
    return { posted: false, reason: 'already_running' };
  }

  const env = getEnv();
  if (!env.SLACK_EOD_REPORT_ENABLED) {
    return { posted: false, reason: 'disabled' };
  }

  const tz = reportTimezone();
  const now = new Date();
  const { dateKey } = localDateTimeParts(tz, now);

  if (!options?.force) {
    if (!isWorkdayInTimezone(tz, now)) {
      return { posted: false, reason: 'not_workday' };
    }
    if (
      !isEodReportDue(tz, env.SLACK_EOD_REPORT_TIME, env.SLACK_EOD_REPORT_CHECK_INTERVAL_MINUTES, now)
    ) {
      return { posted: false, reason: 'not_due' };
    }
    if (await hasEodReportBeenSent(dateKey)) {
      return { posted: false, reason: 'already_sent' };
    }
  }

  reportInProgress = true;
  try {
    const summary = await buildDashboardSummaryForLastHours(env.SLACK_EOD_REPORT_HOURS, tz);
    const text = formatEodStatusSlackMessage(summary, { at: now, timeZone: tz });
    await postToQueueChannel(text);
    await markEodReportSent(dateKey);

    logger.info('End-of-day status report posted', {
      dateKey,
      totals: summary.summary,
      assignees: summary.userMetrics.length,
      hours: env.SLACK_EOD_REPORT_HOURS,
    });

    return { posted: true };
  } finally {
    reportInProgress = false;
  }
}

export function startEodStatusReportScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0 || !getEnv().SLACK_EOD_REPORT_ENABLED) return;

  const run = () => {
    runEodStatusReport()
      .then((result) => {
        if (result.posted) {
          logger.info('EOD status report pass complete', result);
        }
      })
      .catch((err) => {
        logger.error('EOD status report failed', { err: String(err) });
      });
  };

  setTimeout(run, 60_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('EOD status report scheduler started', {
    intervalMinutes,
    reportTime: getEnv().SLACK_EOD_REPORT_TIME,
    reportHours: getEnv().SLACK_EOD_REPORT_HOURS,
    timezone: reportTimezone(),
    dashboardUrl: dashboardUrl(),
  });
}
