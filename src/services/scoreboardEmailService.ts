import { getAppSetting, upsertAppSetting } from '../db/supabase.js';
import { getEnv } from '../config/env.js';
import {
  buildDashboardSummaryForLastHours,
  type DashboardSummary,
  type DashboardUserMetric,
} from '../routes/dashboard.js';
import { isEodReportDue } from './eodStatusReportService.js';
import { sendGmailMessage } from './gmailSendService.js';
import { resolveServiceAccountIdentity } from './googleAuth.js';
import { logger } from '../utils/logger.js';

const SETTINGS_KEY = 'scoreboard_email_settings';
const LAST_SENT_KEY = 'scoreboard_email_last_sent';

export const SCOREBOARD_WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type ScoreboardWeekday = (typeof SCOREBOARD_WEEKDAYS)[number];

export interface ScoreboardEmailSettings {
  enabled: boolean;
  /** Comma-separated or array of recipient emails. */
  recipients: string[];
  /** Workspace user to send as (overrides GOOGLE_WORKSPACE_IMPERSONATED_USER when set). */
  sendAs: string;
  /** Local 24h time HH:MM (default 16:45). */
  sendTime: string;
  /** Days to send (default Friday only). */
  days: ScoreboardWeekday[];
  /** Rolling lookback window in hours (default 24). */
  hours: number;
  /** Optional email subject override. */
  subject: string;
}

const DEFAULT_SETTINGS: ScoreboardEmailSettings = {
  enabled: true,
  recipients: [],
  sendAs: '',
  sendTime: '16:45',
  days: ['fri'],
  hours: 24,
  subject: 'File Sorter scoreboard',
};

const WEEKDAY_FROM_SHORT: Record<string, ScoreboardWeekday> = {
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sun: 'sun',
  sunday: 'sun',
};

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
  return `${base}?${new URLSearchParams({ from, to }).toString()}`;
}

function parseEmailList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((v) => String(v ?? '').trim().toLowerCase())
      .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,;\n]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

function normalizeSendTime(raw: unknown, fallback: string): string {
  const value = String(raw ?? '').trim();
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return fallback;
}

export function parseScoreboardDays(raw: unknown): ScoreboardWeekday[] {
  const parts = Array.isArray(raw)
    ? raw.map((v) => String(v ?? '').trim().toLowerCase())
    : typeof raw === 'string'
      ? raw.split(/[,;\s]+/).map((p) => p.trim().toLowerCase())
      : [];

  const days: ScoreboardWeekday[] = [];
  for (const part of parts) {
    const day = WEEKDAY_FROM_SHORT[part];
    if (day && !days.includes(day)) days.push(day);
  }
  return days;
}

function localWeekday(tz: string, at: Date = new Date()): ScoreboardWeekday {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  })
    .format(at)
    .toLowerCase()
    .slice(0, 3);
  return WEEKDAY_FROM_SHORT[short] ?? 'mon';
}

export function isScoreboardSendDay(
  days: ScoreboardWeekday[],
  tz: string,
  at: Date = new Date()
): boolean {
  if (!days.length) return false;
  return days.includes(localWeekday(tz, at));
}

function localDateKey(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function localWhenLabel(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

export function getScoreboardEmailConfigIssue(settings?: ScoreboardEmailSettings): string | null {
  try {
    resolveServiceAccountIdentity();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const sendAs =
    settings?.sendAs?.trim() || getEnv().GOOGLE_WORKSPACE_IMPERSONATED_USER?.trim() || '';
  if (!sendAs) {
    return (
      'No From / send-as user. Set GOOGLE_WORKSPACE_IMPERSONATED_USER or save a From address in FAQ Settings.'
    );
  }
  if (settings && !settings.days.length) {
    return 'No send days selected. Choose at least one day in FAQ Settings.';
  }
  return null;
}

export async function getScoreboardEmailSettings(): Promise<ScoreboardEmailSettings> {
  const env = getEnv();
  const stored = await getAppSetting<Partial<ScoreboardEmailSettings> & Record<string, unknown>>(
    SETTINGS_KEY
  );
  const envRecipients = parseEmailList(env.SCOREBOARD_EMAIL_RECIPIENTS ?? '');
  const envSendAs = env.GOOGLE_WORKSPACE_IMPERSONATED_USER?.trim() ?? '';
  const storedDays = parseScoreboardDays(stored?.days);
  const envDays = parseScoreboardDays(env.SCOREBOARD_EMAIL_DAYS);

  return {
    enabled:
      typeof stored?.enabled === 'boolean'
        ? stored.enabled
        : env.SCOREBOARD_EMAIL_ENABLED,
    recipients: stored?.recipients?.length
      ? parseEmailList(stored.recipients)
      : envRecipients,
    sendAs:
      (typeof stored?.sendAs === 'string' && stored.sendAs.trim()) ||
      envSendAs ||
      DEFAULT_SETTINGS.sendAs,
    sendTime: normalizeSendTime(
      stored?.sendTime ?? env.SCOREBOARD_EMAIL_TIME,
      DEFAULT_SETTINGS.sendTime
    ),
    days: storedDays.length
      ? storedDays
      : envDays.length
        ? envDays
        : [...DEFAULT_SETTINGS.days],
    hours: (() => {
      const n = Number(stored?.hours ?? env.SCOREBOARD_EMAIL_HOURS);
      if (Number.isFinite(n) && n >= 1 && n <= 168) return Math.round(n);
      return DEFAULT_SETTINGS.hours;
    })(),
    subject:
      (typeof stored?.subject === 'string' && stored.subject.trim()) ||
      DEFAULT_SETTINGS.subject,
  };
}

export async function saveScoreboardEmailSettings(
  patch: Partial<ScoreboardEmailSettings> & { recipientsText?: string; daysText?: string }
): Promise<ScoreboardEmailSettings> {
  const current = await getScoreboardEmailSettings();
  const nextDays =
    patch.daysText != null
      ? parseScoreboardDays(patch.daysText)
      : patch.days != null
        ? parseScoreboardDays(patch.days)
        : current.days;

  const next: ScoreboardEmailSettings = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    recipients:
      patch.recipientsText != null
        ? parseEmailList(patch.recipientsText)
        : patch.recipients != null
          ? parseEmailList(patch.recipients)
          : current.recipients,
    sendAs:
      typeof patch.sendAs === 'string' ? patch.sendAs.trim() : current.sendAs,
    sendTime: normalizeSendTime(patch.sendTime ?? current.sendTime, current.sendTime),
    days: nextDays,
    hours: (() => {
      if (patch.hours == null) return current.hours;
      const n = Number(patch.hours);
      if (!Number.isFinite(n)) return current.hours;
      return Math.min(168, Math.max(1, Math.round(n)));
    })(),
    subject:
      typeof patch.subject === 'string' && patch.subject.trim()
        ? patch.subject.trim()
        : current.subject,
  };

  await upsertAppSetting(SETTINGS_KEY, { ...next });
  return next;
}

async function hasScoreboardEmailBeenSent(dateKey: string): Promise<boolean> {
  const state = await getAppSetting<{ dateKey?: string }>(LAST_SENT_KEY);
  return state?.dateKey === dateKey;
}

async function markScoreboardEmailSent(dateKey: string): Promise<void> {
  await upsertAppSetting(LAST_SENT_KEY, {
    dateKey,
    sentAt: new Date().toISOString(),
  });
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAssigneeRows(metrics: DashboardUserMetric[]): string {
  if (!metrics.length) {
    return '<p style="color:#4a5568;margin:0;">No tagged assignments in this window.</p>';
  }
  const rows = metrics
    .map(
      (m) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(m.displayName)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${m.tagged}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#0f766e;">${m.completed}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#b45309;">${m.pending}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#64748b;">${m.skipped}</td>
      </tr>`
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f6f8fb;text-align:left;">
          <th style="padding:8px 10px;">Assignee</th>
          <th style="padding:8px 10px;text-align:right;">Tagged</th>
          <th style="padding:8px 10px;text-align:right;">Completed</th>
          <th style="padding:8px 10px;text-align:right;">Pending</th>
          <th style="padding:8px 10px;text-align:right;">Do not sort</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function formatScoreboardEmailHtml(
  summary: DashboardSummary,
  options?: { at?: Date; timeZone?: string; hours?: number }
): string {
  const tz = options?.timeZone ?? summary.timeZone;
  const at = options?.at ?? new Date();
  const hours = options?.hours ?? 24;
  const whenLabel = localWhenLabel(tz, at);
  const link = dashboardUrl(summary.from, summary.to);
  const s = summary.summary;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f6f8fb;font-family:Segoe UI,Arial,sans-serif;color:#0b1526;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
    <div style="padding:20px 24px;background:#0b1526;color:#fff;">
      <div style="font-size:13px;opacity:0.8;letter-spacing:0.04em;text-transform:uppercase;">RJL File Sorter</div>
      <h1 style="margin:6px 0 0;font-size:22px;">Daily scoreboard</h1>
      <div style="margin-top:8px;font-size:13px;opacity:0.85;">Prior ${hours} hours · ${escapeHtml(whenLabel)}</div>
    </div>
    <div style="padding:20px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin-bottom:18px;">
        <tr>
          <td style="background:#f6f8fb;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:11px;color:#4a5568;text-transform:uppercase;">Total</div>
            <div style="font-size:24px;font-weight:700;">${s.total}</div>
          </td>
          <td style="background:#ecfdf5;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:11px;color:#0f766e;text-transform:uppercase;">Sorted</div>
            <div style="font-size:24px;font-weight:700;color:#0f766e;">${s.sorted}</div>
          </td>
          <td style="background:#fffbeb;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:11px;color:#b45309;text-transform:uppercase;">Not sorted</div>
            <div style="font-size:24px;font-weight:700;color:#b45309;">${s.pending}</div>
          </td>
          <td style="background:#f8fafc;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;">Do not sort</div>
            <div style="font-size:24px;font-weight:700;color:#64748b;">${s.skipped}</div>
          </td>
        </tr>
      </table>

      <h2 style="font-size:16px;margin:0 0 10px;">By assignee</h2>
      ${formatAssigneeRows(summary.userMetrics)}

      <p style="margin:20px 0 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#e8488a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">
          Open activity dashboard
        </a>
      </p>
    </div>
    <div style="padding:14px 24px;background:#f6f8fb;color:#6b7280;font-size:12px;">
      Ramos James Law · Internal · Edit recipients/time on the FAQ Settings page
    </div>
  </div>
</body>
</html>`;
}

export function formatScoreboardEmailText(
  summary: DashboardSummary,
  options?: { at?: Date; timeZone?: string; hours?: number }
): string {
  const tz = options?.timeZone ?? summary.timeZone;
  const at = options?.at ?? new Date();
  const hours = options?.hours ?? 24;
  const whenLabel = localWhenLabel(tz, at);
  const s = summary.summary;
  const lines = [
    'RJL File Sorter — Daily scoreboard',
    `Prior ${hours} hours · ${whenLabel}`,
    '',
    `Totals — ${s.total} items · ${s.sorted} sorted · ${s.pending} not sorted · ${s.skipped} do not sort`,
  ];

  if (summary.userMetrics.length) {
    lines.push('', 'By assignee');
    for (const m of summary.userMetrics) {
      lines.push(
        `• ${m.displayName} — Tagged ${m.tagged} · Completed ${m.completed} · Pending ${m.pending} · Do not sort ${m.skipped}`
      );
    }
  } else {
    lines.push('', 'No tagged assignments in this window.');
  }

  lines.push('', dashboardUrl(summary.from, summary.to));
  return lines.join('\n');
}

export async function runScoreboardEmail(options?: {
  force?: boolean;
}): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  if (reportInProgress) return { sent: false, reason: 'already_running' };

  const settings = await getScoreboardEmailSettings();
  if (!settings.enabled && !options?.force) {
    return { sent: false, reason: 'disabled' };
  }

  const configIssue = getScoreboardEmailConfigIssue(settings);
  if (configIssue) return { sent: false, reason: configIssue };

  if (!settings.recipients.length) {
    return { sent: false, reason: 'no_recipients' };
  }

  const tz = reportTimezone();
  const now = new Date();
  const dateKey = localDateKey(tz, now);
  const checkInterval = getEnv().SCOREBOARD_EMAIL_CHECK_INTERVAL_MINUTES;

  if (!options?.force) {
    if (!isScoreboardSendDay(settings.days, tz, now)) {
      return { sent: false, reason: 'not_send_day' };
    }
    if (!isEodReportDue(tz, settings.sendTime, checkInterval, now)) {
      return { sent: false, reason: 'not_due' };
    }
    if (await hasScoreboardEmailBeenSent(dateKey)) {
      return { sent: false, reason: 'already_sent' };
    }
  }

  reportInProgress = true;
  try {
    const summary = await buildDashboardSummaryForLastHours(settings.hours, tz);
    const subject = `${settings.subject} — ${summary.from} to ${summary.to}`;
    const htmlBody = formatScoreboardEmailHtml(summary, {
      at: now,
      timeZone: tz,
      hours: settings.hours,
    });
    const textBody = formatScoreboardEmailText(summary, {
      at: now,
      timeZone: tz,
      hours: settings.hours,
    });

    const result = await sendGmailMessage({
      sendAs: settings.sendAs,
      to: settings.recipients,
      subject,
      textBody,
      htmlBody,
    });

    await markScoreboardEmailSent(dateKey);

    logger.info('Scoreboard email sent', {
      dateKey,
      messageId: result.id,
      recipients: settings.recipients.length,
      totals: summary.summary,
      hours: settings.hours,
    });

    return { sent: true, messageId: result.id };
  } finally {
    reportInProgress = false;
  }
}

export function startScoreboardEmailScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0) return;

  const run = () => {
    runScoreboardEmail()
      .then((result) => {
        if (result.sent) {
          logger.info('Scoreboard email pass complete', result);
        }
      })
      .catch((err) => {
        logger.error('Scoreboard email failed', { err: String(err) });
      });
  };

  setTimeout(run, 90_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Scoreboard email scheduler started', {
    intervalMinutes,
    defaultTime: DEFAULT_SETTINGS.sendTime,
    timezone: reportTimezone(),
  });
}
