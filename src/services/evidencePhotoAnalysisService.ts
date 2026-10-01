import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { requireClientSupabase } from '../db/clientSupabase.js';
import { getDropboxThumbnailJpeg } from './dropboxService.js';
import { logger } from '../utils/logger.js';

const CLAIM_BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MAX_TITLE_WORDS = 8;
const MAX_ERROR_CHARS = 300;

export const EVIDENCE_PHOTO_CATEGORIES = [
  'Vehicle Damage',
  'Injury',
  'Accident Scene',
  'Property Damage',
  'Medical',
  'Document',
  'Other',
] as const;

type EvidenceCategory = (typeof EVIDENCE_PHOTO_CATEGORIES)[number];

const SYSTEM_PROMPT = `You write neutral captions for photos stored in a personal injury law firm's case files.

Return a short title and a plain factual description of what is visibly shown in the image.

Rules:
- Describe only what is visible right now in the frame: objects, their positions, and their
  visible condition. Describe states, not events. Do not guess at what happened before the photo.
- Do NOT state or imply fault, liability, or causation (who or what caused anything). Do not use
  event or cause words such as "crash", "collision", "collided", "hit", "struck", "impact",
  "caused by", "due to", "resulting in", or "after the accident". Say "a car is in contact with
  a tree" or "a car is next to a tree", never "a car crashed into a tree".
- Do NOT judge severity of damage or injuries. Avoid words like "minor", "major", "severe",
  "significant", "serious", "extensive", or "totaled". Describe what is visible instead
  (for example "the hood appears crumpled and the windshield appears cracked").
- Do NOT give a medical diagnosis or name medical conditions (for example say "a red mark on
  the forearm", not "a burn" or "a contusion").
- Do NOT estimate vehicle speed or reconstruct how an accident happened.
- Do NOT comment on whether the photo is authentic, edited, staged, or truthful.
- No legal conclusions or opinions about the case.
- Use "appears to" for anything you are not certain about.
- Do not read out personal identifiers such as license plate numbers, ID or account numbers,
  addresses, phone numbers, or dates of birth. If a document or ID is shown, say a document is
  present and what kind it appears to be, without transcribing its contents.

Output:
- title: at most 8 words, a neutral label of what is shown (for example
  "Black sedan with front-end damage near tree"), not an event name.
- description: 2 to 4 sentences.
- category: the single best fit from the allowed list. Use "Document" for paperwork, screenshots,
  or IDs; "Medical" for medical settings, equipment, or records; "Other" when nothing fits.`;

/** Causation, fault, severity, and diagnosis language the captions must never contain. */
const BANNED_TERMS =
  /\b(crash(es|ed|ing)?|collid(e|es|ed|ing)|collisions?|struck|impact(s|ed)?|caused|causing|due to|resulting|as a result|after the (accident|crash|collision|incident)|fault|liab(le|ility)|negligen(t|ce)|reckless|minor|major|severe(ly)?|significant(ly)?|serious(ly)?|extensive(ly)?|totaled|fractur(e|es|ed)|broken bones?|concussion|whiplash|contusions?|lacerations?|sprain(ed)?|speed(ing)?|mph)\b/gi;

const REWRITE_PROMPT = `Rewrite this photo caption so it only describes what is visible.
Remove or replace these words and phrases: {terms}.
Do not state or imply causation, fault, severity, speed, or any medical diagnosis.
Keep the same facts otherwise, the title at most 8 words, the description 2 to 4 sentences,
and the same category.`;

function bannedTermsIn(text: string): string[] {
  return [...new Set((text.match(BANNED_TERMS) ?? []).map((t) => t.toLowerCase()))];
}

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' as const },
    description: { type: 'string' as const },
    category: { type: 'string' as const, enum: [...EVIDENCE_PHOTO_CATEGORIES] },
  },
  required: ['title', 'description', 'category'],
  additionalProperties: false,
};

interface ClaimedPhoto {
  id: string;
  dropbox_file_id: string;
  dropbox_path: string;
  dropbox_rev: string | null;
  original_filename: string;
  analysis_attempts: number;
}

interface PhotoAnalysis {
  title: string;
  description: string;
  category: EvidenceCategory;
  model: string;
}

let openai: OpenAI | null = null;
let workerInProgress = false;
let workerRerunRequested = false;
let lastRunAt: string | null = null;
let lastError: string | null = null;

function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return openai;
}

function analysisModel(): string {
  const env = getEnv();
  return env.EVIDENCE_PHOTOS_MODEL ?? env.OPENAI_VISION_MODEL ?? env.OPENAI_MODEL;
}

function limitWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS) || 'Unknown error';
}

type CaptionMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];

async function requestCaption(
  messages: CaptionMessages
): Promise<{ analysis: Omit<PhotoAnalysis, 'model'>; raw: string; model: string }> {
  const model = analysisModel();
  const response = await getOpenAI().chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 400,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'evidence_photo_caption', strict: true, schema: RESPONSE_SCHEMA },
    },
    messages,
  });

  const choice = response.choices[0];
  if (choice?.message?.refusal) throw new Error(`Model refused: ${choice.message.refusal}`);
  const raw = choice?.message?.content;
  if (!raw) throw new Error('Model returned no content');

  const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown; category?: unknown };
  const title = limitWords(String(parsed.title ?? ''), MAX_TITLE_WORDS);
  const description = String(parsed.description ?? '').trim();
  if (!title || !description) throw new Error('Model returned an empty title or description');
  const category = EVIDENCE_PHOTO_CATEGORIES.includes(parsed.category as EvidenceCategory)
    ? (parsed.category as EvidenceCategory)
    : 'Other';

  return { analysis: { title, description, category }, raw, model: response.model ?? model };
}

async function analyzeImage(jpeg: Buffer): Promise<PhotoAnalysis> {
  const messages: CaptionMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Caption this case photo.' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
            detail: 'high',
          },
        },
      ],
    },
  ];

  const first = await requestCaption(messages);
  const banned = bannedTermsIn(`${first.analysis.title} ${first.analysis.description}`);
  if (!banned.length) return { ...first.analysis, model: first.model };

  // Text-only rewrite: the image isn't resent, so this pass is cheap.
  const rewrite = await requestCaption([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${REWRITE_PROMPT.replace('{terms}', banned.map((t) => `"${t}"`).join(', '))}\n\n${first.raw}`,
    },
  ]);
  const stillBanned = bannedTermsIn(`${rewrite.analysis.title} ${rewrite.analysis.description}`);
  if (stillBanned.length) {
    throw new Error(`Caption failed guardrail check (${stillBanned.join(', ')})`);
  }
  return { ...rewrite.analysis, category: first.analysis.category, model: rewrite.model };
}

async function saveSuccess(photo: ClaimedPhoto, analysis: PhotoAnalysis): Promise<void> {
  const supabase = requireClientSupabase();
  const now = new Date().toISOString();
  const statusFields = {
    analysis_status: 'complete',
    analysis_error: null,
    analyzed_rev: photo.dropbox_rev,
    processing_started_at: null,
  };

  // Only write AI fields if staff haven't edited and the file wasn't replaced mid-analysis.
  let full = supabase
    .from('evidence_photos')
    .update({
      ...statusFields,
      ai_title: analysis.title,
      ai_description: analysis.description,
      category: analysis.category,
      ai_model: analysis.model,
      analyzed_at: now,
    })
    .eq('id', photo.id)
    .eq('human_edited', false);
  full = photo.dropbox_rev ? full.eq('dropbox_rev', photo.dropbox_rev) : full.is('dropbox_rev', null);
  const { data, error } = await full.select('id');
  if (error) throw new Error(`Save analysis failed: ${error.message}`);
  if (data?.length) return;

  // Staff edited while we were processing: keep their fields, just close out the job.
  let statusOnly = supabase
    .from('evidence_photos')
    .update(statusFields)
    .eq('id', photo.id)
    .eq('human_edited', true);
  statusOnly = photo.dropbox_rev
    ? statusOnly.eq('dropbox_rev', photo.dropbox_rev)
    : statusOnly.is('dropbox_rev', null);
  const { error: statusError } = await statusOnly;
  if (statusError) throw new Error(`Save analysis status failed: ${statusError.message}`);
  // Otherwise the rev changed mid-analysis; sync already re-queued it.
}

async function saveFailure(photo: ClaimedPhoto, err: unknown): Promise<void> {
  const { error } = await requireClientSupabase()
    .from('evidence_photos')
    .update({
      analysis_status: 'failed',
      analysis_error: shortError(err),
      processing_started_at: null,
    })
    .eq('id', photo.id)
    .eq('analysis_status', 'processing');
  if (error) {
    logger.error('Evidence photo: saving failure state failed', {
      id: photo.id,
      err: error.message,
    });
  }
}

async function processPhoto(photo: ClaimedPhoto): Promise<boolean> {
  try {
    const jpeg = await getDropboxThumbnailJpeg(photo.dropbox_file_id);
    const analysis = await analyzeImage(jpeg);
    await saveSuccess(photo, analysis);
    return true;
  } catch (err) {
    logger.warn('Evidence photo analysis failed', {
      id: photo.id,
      path: photo.dropbox_path,
      attempt: photo.analysis_attempts,
      err: shortError(err),
    });
    await saveFailure(photo, err);
    return false;
  }
}

/** Failed rows under the attempt cap go back to pending after a short backoff. */
async function requeueRetryableFailures(): Promise<number> {
  const { data, error } = await requireClientSupabase()
    .from('evidence_photos')
    .update({ analysis_status: 'pending' })
    .eq('analysis_status', 'failed')
    .lt('analysis_attempts', MAX_ATTEMPTS)
    .is('deleted_at', null)
    .lt('updated_at', new Date(Date.now() - RETRY_BACKOFF_MS).toISOString())
    .select('id');
  if (error) throw new Error(`Requeue failed evidence photos failed: ${error.message}`);
  return data?.length ?? 0;
}

async function claimBatch(): Promise<ClaimedPhoto[]> {
  const { data, error } = await requireClientSupabase().rpc('claim_evidence_photos', {
    batch_size: CLAIM_BATCH_SIZE,
  });
  if (error) throw new Error(`claim_evidence_photos failed: ${error.message}`);
  return (data ?? []) as ClaimedPhoto[];
}

async function runWorkerOnce(): Promise<{ complete: number; failed: number }> {
  const totals = { complete: 0, failed: 0 };
  await requeueRetryableFailures();
  for (;;) {
    const batch = await claimBatch();
    if (!batch.length) break;
    const results = await Promise.all(batch.map(processPhoto));
    for (const ok of results) {
      if (ok) totals.complete++;
      else totals.failed++;
    }
  }
  return totals;
}

/** Drain the analysis queue. Single-flight; extra triggers re-run once the current pass ends. */
export async function runEvidenceAnalysisWorker(): Promise<void> {
  if (workerInProgress) {
    workerRerunRequested = true;
    return;
  }
  workerInProgress = true;
  try {
    do {
      workerRerunRequested = false;
      const totals = await runWorkerOnce();
      lastRunAt = new Date().toISOString();
      lastError = null;
      if (totals.complete || totals.failed) {
        logger.info('Evidence photo analysis pass complete', { ...totals, model: analysisModel() });
      }
    } while (workerRerunRequested);
  } catch (err) {
    lastError = shortError(err);
    throw err;
  } finally {
    workerInProgress = false;
  }
}

export function triggerEvidenceAnalysis(source: string): void {
  void runEvidenceAnalysisWorker().catch((err) => {
    logger.error('Evidence photo analysis worker failed', { source, err: shortError(err) });
  });
}

export function getEvidenceAnalysisStatus() {
  return { workerInProgress, lastRunAt, lastError, model: analysisModel() };
}

export function startEvidencePhotoAnalysisScheduler(intervalMinutes: number): void {
  if (!getEnv().EVIDENCE_PHOTOS_ENABLED || intervalMinutes <= 0) return;
  setTimeout(() => triggerEvidenceAnalysis('startup'), 60_000);
  setInterval(() => triggerEvidenceAnalysis('interval'), intervalMinutes * 60 * 1000);
  logger.info('Evidence photo analysis scheduler started', {
    intervalMinutes,
    model: analysisModel(),
  });
}
