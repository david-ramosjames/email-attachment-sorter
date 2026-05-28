import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { MAX_DOCUMENT_EXCERPT_CHARS } from '../constants/classification.js';
import { logger } from '../utils/logger.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

const VISION_SYSTEM_PROMPT = `You extract text from legal documents for a law firm filing system.
Return ONLY the readable text from the image(s), preserving names, dates, case numbers, and headers.
Do not summarize or add commentary. If no text is visible, return an empty string.`;

/**
 * OCR / vision fallback for scanned PDFs, photos, and other image attachments.
 */
export async function extractTextWithVision(
  imageBuffers: Buffer[],
  mimeType = 'image/png'
): Promise<string> {
  if (!imageBuffers.length) return '';

  const model = getEnv().OPENAI_VISION_MODEL ?? getEnv().OPENAI_MODEL;
  const imageParts = imageBuffers.slice(0, 3).map((buf) => ({
    type: 'image_url' as const,
    image_url: {
      url: `data:${mimeType};base64,${buf.toString('base64')}`,
      detail: 'high' as const,
    },
  }));

  const response = await getOpenAI().chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all readable text from these document page(s).',
          },
          ...imageParts,
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  logger.info('Vision text extraction complete', {
    model,
    pages: imageBuffers.length,
    chars: text.length,
  });
  return text.slice(0, MAX_DOCUMENT_EXCERPT_CHARS);
}
