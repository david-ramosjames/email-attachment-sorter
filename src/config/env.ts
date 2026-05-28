import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  /** Vision/OCR model for scanned PDFs and photos (defaults to OPENAI_MODEL) */
  OPENAI_VISION_MODEL: z.string().optional(),
  /** Re-analyze attachment when email-only confidence is below this (0–1) */
  DOCUMENT_ANALYSIS_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_FILE_SORTER_QUEUE_CHANNEL_ID: z.string().min(1),
  DROPBOX_ACCESS_TOKEN: z.string().min(1),
  /** Root Dropbox folder containing all case folders */
  DROPBOX_CASES_ROOT: z.string().default('/RJL Cases'),
  /** Dropbox Business home namespace id (from /admin/dropbox-connection) */
  DROPBOX_NAMESPACE_ID: z.string().optional(),
  /** How often to scan Dropbox for new case folders (minutes). 0 = disabled. */
  DROPBOX_SYNC_INTERVAL_MINUTES: z.coerce.number().default(60),
  INBOUND_EMAIL_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
