import { JWT } from 'google-auth-library';
import { getEnv, getGoogleSheetsConfigIssue } from '../config/env.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function getServiceAccountJwt(): JWT {
  const env = getEnv();
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
        client_email?: string;
        private_key?: string;
      };
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key');
    }
    return new JWT({
      email: parsed.client_email,
      key: parsed.private_key,
      scopes: [SHEETS_SCOPE],
    });
  }

  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, '\n');
  return new JWT({ email, key, scopes: [SHEETS_SCOPE] });
}

/** Fetch raw cell values from a Google Sheet range (includes header row). */
export async function fetchSheetValues(range: string): Promise<string[][]> {
  const issue = getGoogleSheetsConfigIssue();
  if (issue) throw new Error(issue);

  const spreadsheetId = getEnv().GOOGLE_SHEETS_SPREADSHEET_ID!;
  const client = getServiceAccountJwt();
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
