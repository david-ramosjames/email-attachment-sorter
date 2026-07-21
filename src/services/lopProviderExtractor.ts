import OpenAI from 'openai';
import { getEnv } from '../config/env.js';

const schema = {
  type: 'object' as const,
  properties: {
    is_lop: { type: 'boolean' as const },
    provider_name: { type: ['string', 'null'] as const },
    confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
  },
  required: ['is_lop', 'provider_name', 'confidence'],
  additionalProperties: false,
};

export async function extractLopProvider(opts: {
  filename: string;
  documentText: string;
}): Promise<{ isLop: boolean; providerName: string | null; confidence: number }> {
  const openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: getEnv().OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'lop_provider', strict: true, schema },
    },
    messages: [
      {
        role: 'system',
        content:
          'Identify whether this is a Letter of Protection (LOP) from a law firm to a medical provider. ' +
          'If it is, return the medical provider or facility receiving the protection. Do not return the law firm, patient, or insurer. ' +
          'Use null when the provider cannot be determined.',
      },
      {
        role: 'user',
        content: `Filename: ${opts.filename}\n\nDocument text:\n${opts.documentText.slice(0, 12_000)}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return { isLop: false, providerName: null, confidence: 0 };
  const parsed = JSON.parse(content) as {
    is_lop: boolean;
    provider_name: string | null;
    confidence: number;
  };
  return {
    isLop: parsed.is_lop,
    providerName: parsed.provider_name?.trim() || null,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
  };
}
