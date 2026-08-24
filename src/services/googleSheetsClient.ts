import { getEnv, getGoogleSheetsConfigIssue } from '../config/env.js';
import { createServiceAccountJwt } from './googleAuth.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Fetch raw cell values from a Google Sheet range (includes header row). */
export async function fetchSheetValues(range: string): Promise<string[][]> {
  const issue = getGoogleSheetsConfigIssue();
  if (issue) throw new Error(issue);

  const spreadsheetId = getEnv().GOOGLE_SHEETS_SPREADSHEET_ID!;
  const client = createServiceAccountJwt({ scopes: [SHEETS_SCOPE] });
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse.token;
  if (!token) throw new Error('Google Sheets auth failed: no access token');

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Sheets API ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
}
