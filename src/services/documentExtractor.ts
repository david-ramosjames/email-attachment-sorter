import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import {
  MAX_DOCUMENT_EXCERPT_CHARS,
  MAX_DOCUMENT_PAGES,
  MAX_VISION_PAGES,
  MIN_EXTRACTED_TEXT_CHARS,
} from '../constants/classification.js';
import { extractTextWithVision } from './documentVision.js';
import { logger } from '../utils/logger.js';

export interface DocumentExtractionResult {
  excerpt: string;
  method:
    | 'pdf-text'
    | 'pdf-vision'
    | 'doc-text'
    | 'docx-text'
    | 'image-vision'
    | 'unsupported';
}

function truncate(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DOCUMENT_EXCERPT_CHARS);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function isPdf(mimeType: string, filename: string): boolean {
  return mimeType === 'application/pdf' || extensionOf(filename) === 'pdf';
}

function isDocx(mimeType: string, filename: string): boolean {
  const ext = extensionOf(filename);
  return (
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  );
}

/** Legacy Word 97–2003 (.doc), not .docx */
function isDoc(mimeType: string, filename: string): boolean {
  if (isDocx(mimeType, filename)) return false;
  const ext = extensionOf(filename);
  return mimeType === 'application/msword' || ext === 'doc';
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: MAX_DOCUMENT_PAGES });
    return result.text ?? '';
  } finally {
    await parser.destroy();
  }
}

async function extractPdfPageImages(buffer: Buffer): Promise<Buffer[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getScreenshot({
      first: MAX_VISION_PAGES,
      imageBuffer: true,
      scale: 1.5,
    });
    const pages: Buffer[] = [];
    for (const p of result.pages) {
      if (p.data?.length) pages.push(Buffer.from(p.data));
    }
    return pages;
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

async function extractDocText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody() ?? '';
}

/**
 * Pull text from PDF, Word, scanned PDF, or image attachments.
 */
export async function extractDocumentExcerpt(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<DocumentExtractionResult | null> {
  try {
    if (isImageMime(mimeType)) {
      const excerpt = await extractTextWithVision([buffer], mimeType);
      if (!excerpt) return null;
      return { excerpt: truncate(excerpt), method: 'image-vision' };
    }

    if (isPdf(mimeType, filename)) {
      const text = truncate(await extractPdfText(buffer));
      if (text.length >= MIN_EXTRACTED_TEXT_CHARS) {
        return { excerpt: text, method: 'pdf-text' };
      }

      logger.info('PDF text sparse — using vision', {
        filename,
        textChars: text.length,
      });
      const pages = await extractPdfPageImages(buffer);
      if (!pages.length) {
        return text ? { excerpt: text, method: 'pdf-text' } : null;
      }
      const visionText = await extractTextWithVision(pages, 'image/png');
      const combined = truncate(
        [text, visionText].filter(Boolean).join('\n\n')
      );
      return combined
        ? { excerpt: combined, method: 'pdf-vision' }
        : null;
    }

    if (isDoc(mimeType, filename)) {
      const text = truncate(await extractDocText(buffer));
      return text ? { excerpt: text, method: 'doc-text' } : null;
    }

    if (isDocx(mimeType, filename)) {
      const text = truncate(await extractDocxText(buffer));
      return text ? { excerpt: text, method: 'docx-text' } : null;
    }

    logger.info('Unsupported attachment type for extraction', {
      filename,
      mimeType,
    });
    return null;
  } catch (err) {
    logger.warn('Document extraction failed', {
      filename,
      mimeType,
      err: String(err),
    });
    return null;
  }
}
