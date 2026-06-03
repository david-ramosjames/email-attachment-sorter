import { getFoldersForCase, listAllCases } from '../db/supabase.js';
import type { Case, CaseCandidate } from '../types/index.js';
import { logger } from '../utils/logger.js';

/** Keep catalog compact but include every indexed case for LLM matching. */
const MAX_CATALOG_CHARS = 120_000;

function clientLabelFromCase(caseRow: Case): string {
  const parts = [caseRow.slack_channel_name];
  if (caseRow.dropbox_folder_name?.trim()) {
    parts.push(caseRow.dropbox_folder_name.trim());
  }
  return parts.join(' · ');
}

function buildCatalogLines(cases: Case[]): string[] {
  return cases.map((c) => {
    const stage = c.topic_stage?.trim() ? ` stage="${c.topic_stage.trim()}"` : '';
    return `case_number="${c.case_number}" client="${clientLabelFromCase(c)}"${stage}`;
  });
}

export interface CaseCatalogForAi {
  /** One entry per indexed case (folders loaded later for the chosen case only). */
  entries: CaseCandidate[];
  catalogPrompt: string;
  caseNumbers: Set<string>;
}

/** Full case index for OpenAI — client names live in slack channel + Dropbox folder labels. */
export async function loadCaseCatalogForAi(): Promise<CaseCatalogForAi> {
  const cases = await listAllCases();
  const lines = buildCatalogLines(cases);

  let catalogPrompt = lines.join('\n');
  if (catalogPrompt.length > MAX_CATALOG_CHARS) {
    logger.warn('Case catalog truncated for AI context limit', {
      caseCount: cases.length,
      chars: catalogPrompt.length,
      maxChars: MAX_CATALOG_CHARS,
    });
    catalogPrompt = catalogPrompt.slice(0, MAX_CATALOG_CHARS);
  }

  const entries: CaseCandidate[] = cases.map((caseRow) => ({
    case: caseRow,
    folders: [],
    matchScore: 0,
    matchReasons: [],
  }));

  logger.info('Case catalog loaded for AI classification', { caseCount: cases.length });

  return {
    entries,
    catalogPrompt,
    caseNumbers: new Set(cases.map((c) => c.case_number)),
  };
}

export async function foldersForCaseNumber(caseNumber: string) {
  return getFoldersForCase(caseNumber);
}
