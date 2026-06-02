/**
 * Build a body excerpt that keeps forwarded-thread context (client name is often at the end).
 */
export function buildSmartBodyExcerpt(body: string, maxChars = 8000): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;

  const chunks: string[] = [];

  const signalPatterns = [
    /represents\s+[A-Za-z][\s\S]{5,120}?personal\s+injury/gi,
    /Employee Records Request\s*[-–:]\s*[A-Za-z][^\n]{4,80}/gi,
    /Subject:\s*[^\n]{5,120}/gi,
    /employment\s+(?:of|records? for)\s+[A-Z][A-Za-z\s.'-]{4,60}/gi,
    /authorize[\s\S]{0,300}?employment\s+records/gi,
    /Forwarded message[\s\S]{0,400}/gi,
    /From:\s*Jorge[^\n]*/gi,
    /From:\s*[^\n]*intake@ramosjames\.com[^\n]*/gi,
    /intake@ramosjames\.com[\s\S]{0,400}/gi,
    /(?:requesting|please provide|please send)[^\n]{0,200}/gi,
    /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"']+/gi,
  ];

  for (const pattern of signalPatterns) {
    for (const m of normalized.matchAll(pattern)) {
      const slice = m[0].replace(/\s+/g, ' ').trim();
      if (slice.length >= 10) chunks.push(slice);
    }
  }

  const headLen = Math.floor(maxChars * 0.3);
  const tailLen = Math.floor(maxChars * 0.55);
  const head = normalized.slice(0, headLen);
  const tail = normalized.slice(-tailLen);

  const combined = [...new Set(chunks), head, '\n--- forwarded tail ---\n', tail].join('\n');
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}
