import { JWT } from 'google-auth-library';
import { getEnv } from '../config/env.js';

export interface ServiceAccountIdentity {
  clientEmail: string;
  privateKey: string;
  clientId?: string;
}

/** Resolve service account email + private key from env (JSON blob or split vars). */
export function resolveServiceAccountIdentity(): ServiceAccountIdentity {
  const env = getEnv();
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let parsed: {
      client_email?: string;
      private_key?: string;
      client_id?: string;
    };
    try {
      parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
        client_email?: string;
        private_key?: string;
        client_id?: string;
      };
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key');
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      clientId: parsed.client_id ?? env.GOOGLE_CLIENT_ID,
    };
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error(
      'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or ' +
        'GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.'
    );
  }

  return {
    clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientId: env.GOOGLE_CLIENT_ID,
  };
}

export function createServiceAccountJwt(opts: {
  scopes: string[];
  /** Workspace user to impersonate (domain-wide delegation). */
  subject?: string | null;
}): JWT {
  const identity = resolveServiceAccountIdentity();
  return new JWT({
    email: identity.clientEmail,
    key: identity.privateKey,
    scopes: opts.scopes,
    ...(opts.subject?.trim() ? { subject: opts.subject.trim() } : {}),
  });
}

export async function getGoogleAccessToken(opts: {
  scopes: string[];
  subject?: string | null;
}): Promise<string> {
  const client = createServiceAccountJwt(opts);
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse.token;
  if (!token) throw new Error('Google auth failed: no access token');
  return token;
}
