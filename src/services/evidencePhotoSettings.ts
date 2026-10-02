import { getAppSetting, upsertAppSetting } from '../db/supabase.js';
import { getEnv } from '../config/env.js';

const SETTINGS_KEY = 'evidence_photos_settings';
const CACHE_MS = 30_000;

export const EVIDENCE_IMAGE_DETAILS = ['low', 'high', 'auto'] as const;
export type EvidenceImageDetail = (typeof EVIDENCE_IMAGE_DETAILS)[number];

export interface EvidencePhotoSettings {
  /** Master switch: Dropbox sync, webhook processing, and captioning. */
  enabled: boolean;
  /** Pause just the AI captioning (sync keeps importing). */
  captioningEnabled: boolean;
  /** Blank = OPENAI_VISION_MODEL, then OPENAI_MODEL. */
  model: string;
  /** OpenAI image detail. 'low' is ~9x fewer tokens on gpt-4o-mini; 'high' reads fine print. */
  imageDetail: EvidenceImageDetail;
  /** Cap so the backlog doesn't starve the OpenAI rate limit shared with the sorter. */
  maxPerMinute: number;
  /** Safety-net poll of the Dropbox change cursor in case a webhook is missed. 0 = webhook only. */
  pollIntervalMinutes: number;
  /** Local time (24h HH:MM) for the nightly full reconciliation. */
  reconcileTime: string;
  /** Top-level case subfolders to import from (case-insensitive, subfolders included). */
  scanFolders: string[];
}

export const DEFAULT_EVIDENCE_SETTINGS: EvidencePhotoSettings = {
  enabled: true,
  captioningEnabled: true,
  model: '',
  imageDetail: 'low',
  maxPerMinute: 10,
  pollIntervalMinutes: 15,
  reconcileTime: '02:00',
  scanFolders: ['Photos', 'PD', 'Investigation', 'Intake'],
};

export function parseScanFolders(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/[,\n]/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const name = part.trim().replace(/^\/+|\/+$/g, '');
    if (!name || name.includes('/') || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

let cached: { value: EvidencePhotoSettings; at: number } | null = null;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalize(raw: Partial<EvidencePhotoSettings> | null | undefined): EvidencePhotoSettings {
  const d = DEFAULT_EVIDENCE_SETTINGS;
  const time = typeof raw?.reconcileTime === 'string' ? raw.reconcileTime.trim() : '';
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    captioningEnabled:
      typeof raw?.captioningEnabled === 'boolean' ? raw.captioningEnabled : d.captioningEnabled,
    model: typeof raw?.model === 'string' ? raw.model.trim() : d.model,
    imageDetail: EVIDENCE_IMAGE_DETAILS.includes(raw?.imageDetail as EvidenceImageDetail)
      ? (raw!.imageDetail as EvidenceImageDetail)
      : d.imageDetail,
    maxPerMinute: clampInt(raw?.maxPerMinute, 1, 120, d.maxPerMinute),
    pollIntervalMinutes: clampInt(raw?.pollIntervalMinutes, 0, 1440, d.pollIntervalMinutes),
    reconcileTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : d.reconcileTime,
    scanFolders: (() => {
      const folders = parseScanFolders(raw?.scanFolders);
      return folders.length ? folders : [...d.scanFolders];
    })(),
  };
}

export async function getEvidencePhotoSettings(): Promise<EvidencePhotoSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const stored = await getAppSetting<Partial<EvidencePhotoSettings>>(SETTINGS_KEY);
  const value = normalize(stored);
  cached = { value, at: Date.now() };
  return value;
}

export async function saveEvidencePhotoSettings(
  patch: Partial<EvidencePhotoSettings>
): Promise<EvidencePhotoSettings> {
  const current = await getEvidencePhotoSettings();
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)
  ) as Partial<EvidencePhotoSettings>;
  const next = normalize({ ...current, ...defined });
  await upsertAppSetting(SETTINGS_KEY, { ...next });
  cached = { value: next, at: Date.now() };
  return next;
}

export function resolveEvidenceModel(settings: EvidencePhotoSettings): string {
  const env = getEnv();
  return settings.model || env.OPENAI_VISION_MODEL || env.OPENAI_MODEL;
}
