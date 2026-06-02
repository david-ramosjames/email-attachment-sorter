import { z } from 'zod';

/** Railway sometimes sets empty strings — treat as unset. */
const optionalString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().optional()
);

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  /** Vision/OCR model for scanned PDFs and photos (defaults to OPENAI_MODEL) */
  OPENAI_VISION_MODEL: optionalString,
  /** Re-analyze attachment when email-only confidence is below this (0–1) */
  DOCUMENT_ANALYSIS_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_FILE_SORTER_QUEUE_CHANNEL_ID: z.string().min(1),
  /** Short-lived (~4h); use refresh-token trio instead */
  DROPBOX_ACCESS_TOKEN: optionalString,
  DROPBOX_APP_KEY: optionalString,
  DROPBOX_APP_SECRET: optionalString,
  DROPBOX_REFRESH_TOKEN: optionalString,
  /** Root Dropbox folder containing all case folders */
  DROPBOX_CASES_ROOT: z.string().default('/RJL Cases'),
  /** Dropbox Business home namespace id (from /admin/dropbox-connection) */
  DROPBOX_NAMESPACE_ID: optionalString,
  /** How often to scan Dropbox for new case folders (minutes). 0 = disabled. */
  DROPBOX_SYNC_INTERVAL_MINUTES: z.coerce.number().default(60),
  INBOUND_EMAIL_WEBHOOK_SECRET: optionalString,
  /** Delete staged attachments from Storage after this many hours (default 1). */
  TEMP_STORAGE_TTL_HOURS: z.coerce.number().min(0).default(1),
  /** How often to purge expired temp files (minutes). 0 = only on Approve / Do Not Sort. */
  TEMP_STORAGE_CLEANUP_INTERVAL_MINUTES: z.coerce.number().default(15),
  /** Google Sheet that lists cases ↔ Slack channels (service account must have Viewer access). */
  GOOGLE_SHEETS_SPREADSHEET_ID: optionalString,
  /** A1 notation range, e.g. Cases!A:F */
  GOOGLE_SHEETS_RANGE: z.string().default('Cases!A:F'),
  /** Full JSON key file contents (preferred on Railway), or use email + private key below */
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: optionalString,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: optionalString,
  /** How often to sync case_slack_channels from the sheet (minutes). 0 = manual only. */
  CASE_SHEET_SYNC_INTERVAL_MINUTES: z.coerce.number().default(0),
  /** How often to sync cases from Slack channel list (minutes). 0 = manual only. */
  SLACK_CASE_SYNC_INTERVAL_MINUTES: z.coerce.number().default(360),
  /** Comma-separated Slack channel names to skip (lowercase, without #). */
  SLACK_CASE_CHANNEL_EXCLUDE_NAMES: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Human-readable hint when Dropbox sync/upload cannot run. */
export function getDropboxConfigIssue(): string | null {
  const env = getEnv();
  const access = env.DROPBOX_ACCESS_TOKEN;
  const key = env.DROPBOX_APP_KEY;
  const secret = env.DROPBOX_APP_SECRET;
  const refresh = env.DROPBOX_REFRESH_TOKEN;

  if (access) return null;
  if (key && secret && refresh) return null;

  const missing: string[] = [];
  if (!key) missing.push('DROPBOX_APP_KEY');
  if (!secret) missing.push('DROPBOX_APP_SECRET');
  if (!refresh) missing.push('DROPBOX_REFRESH_TOKEN');

  if (missing.length === 3) {
    return (
      'Dropbox not configured. On Railway set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and ' +
      'DROPBOX_REFRESH_TOKEN (or temporarily DROPBOX_ACCESS_TOKEN).'
    );
  }
  return `Dropbox refresh auth incomplete — missing: ${missing.join(', ')}`;
}

/** Human-readable hint when Google Sheets case sync is not configured. */
export function getGoogleSheetsConfigIssue(): string | null {
  const env = getEnv();
  if (!env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return 'GOOGLE_SHEETS_SPREADSHEET_ID is not set.';
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return null;
  }
  return (
    'Google Sheets auth not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON (recommended) or ' +
    'GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.'
  );
}
