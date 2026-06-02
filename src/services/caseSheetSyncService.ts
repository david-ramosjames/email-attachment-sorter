import { batchUpsertCaseSlackChannels } from '../db/supabase.js';
import { getGoogleSheetsConfigIssue } from '../config/env.js';
import { fetchSheetValues } from './googleSheetsClient.js';
import { parseCaseRowsFromSheet, type ParsedSheetCase } from '../utils/sheetCaseParser.js';
import { logger } from '../utils/logger.js';
import { getEnv } from '../config/env.js';

export interface CaseSheetSyncResult {
  spreadsheetId: string | null;
  range: string;
  rowsRead: number;
  casesParsed: number;
  casesUpserted: number;
  skippedRows: number;
  headerFields: Record<string, number>;
  syncedAt: string;
  skipped?: boolean;
  error?: string;
}

let lastSyncAt: Date | null = null;
let syncInProgress = false;

export function getLastCaseSheetSyncAt(): Date | null {
  return lastSyncAt;
}

/**
 * Reads the configured Google Sheet and upserts rows into case_slack_channels.
 */
export async function syncCasesFromGoogleSheet(): Promise<CaseSheetSyncResult> {
  const env = getEnv();
  const range = env.GOOGLE_SHEETS_RANGE;
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID ?? null;

  if (syncInProgress) {
    return {
      spreadsheetId,
      range,
      rowsRead: 0,
      casesParsed: 0,
      casesUpserted: 0,
      skippedRows: 0,
      headerFields: {},
      syncedAt: new Date().toISOString(),
      skipped: true,
      error: 'Case sheet sync already running. Wait a minute and try again.',
    };
  }

  const configIssue = getGoogleSheetsConfigIssue();
  if (configIssue) {
    return {
      spreadsheetId,
      range,
      rowsRead: 0,
      casesParsed: 0,
      casesUpserted: 0,
      skippedRows: 0,
      headerFields: {},
      syncedAt: new Date().toISOString(),
      error: configIssue,
    };
  }

  syncInProgress = true;
  try {
    const values = await fetchSheetValues(range);
    const { cases, skippedRows, headerFields } = parseCaseRowsFromSheet(values);

    if (!cases.length) {
      return {
        spreadsheetId,
        range,
        rowsRead: values.length,
        casesParsed: 0,
        casesUpserted: 0,
        skippedRows,
        headerFields: headerFields as Record<string, number>,
        syncedAt: new Date().toISOString(),
        error:
          values.length === 0
            ? 'Sheet range returned no rows. Check GOOGLE_SHEETS_RANGE and share the sheet with the service account.'
            : 'No valid case rows found. Expected columns like Case Number and Slack Channel (or name).',
      };
    }

    const upserted = await batchUpsertCaseSlackChannels(
      cases.map((c: ParsedSheetCase) => ({
        case_number: c.case_number,
        slack_channel_name: c.slack_channel_name,
        slack_channel_id: c.slack_channel_id,
        topic_stage: c.topic_stage,
        dropbox_folder_name: c.dropbox_folder_name,
      }))
    );

    lastSyncAt = new Date();
    const result: CaseSheetSyncResult = {
      spreadsheetId,
      range,
      rowsRead: values.length,
      casesParsed: cases.length,
      casesUpserted: upserted,
      skippedRows,
      headerFields: headerFields as Record<string, number>,
      syncedAt: lastSyncAt.toISOString(),
    };
    logger.info('Google Sheet case sync complete', { ...result });
    return result;
  } catch (err) {
    logger.error('Google Sheet case sync error', { err: String(err) });
    return {
      spreadsheetId,
      range,
      rowsRead: 0,
      casesParsed: 0,
      casesUpserted: 0,
      skippedRows: 0,
      headerFields: {},
      syncedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    syncInProgress = false;
  }
}

export function startCaseSheetSyncScheduler(intervalMinutes: number): void {
  if (intervalMinutes <= 0) return;
  const issue = getGoogleSheetsConfigIssue();
  if (issue) {
    logger.warn('Case sheet sync scheduler not started', { issue });
    return;
  }

  const run = () => {
    if (syncInProgress) {
      logger.info('Skipping scheduled case sheet sync — previous sync still running');
      return;
    }
    syncCasesFromGoogleSheet().catch((err) => {
      logger.error('Scheduled case sheet sync failed', { err: String(err) });
    });
  };

  setTimeout(run, 90_000);
  setInterval(run, intervalMinutes * 60 * 1000);
  logger.info('Case sheet sync scheduler started', { intervalMinutes, firstRunDelaySec: 90 });
}
