/** Below this, re-run matching + classification using attachment content. */
export const DOCUMENT_ANALYSIS_CONFIDENCE_THRESHOLD = 0.5;

/** Final Slack review threshold (unchanged). */
export const CONFIDENCE_THRESHOLD = 0.75;

/** If PDF/DOCX text extraction yields less than this, treat as scanned → vision. */
export const MIN_EXTRACTED_TEXT_CHARS = 80;

export const MAX_DOCUMENT_EXCERPT_CHARS = 6000;

/** Max PDF pages to read as text or render for vision. */
export const MAX_DOCUMENT_PAGES = 5;

/** Max pages sent to vision API (cost control). */
export const MAX_VISION_PAGES = 2;
