import { getDropboxConfigIssue, getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let cachedAccessToken: string | null = null;
/** Unix ms — refresh 5 minutes before Dropbox expiry */
let accessTokenExpiresAt = 0;
let lastRefreshError: string | null = null;

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function clearDropboxTokenCache(): void {
  cachedAccessToken = null;
  accessTokenExpiresAt = 0;
}

export function usesDropboxRefreshToken(): boolean {
  const env = getEnv();
  return Boolean(
    env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET
  );
}

export function dropboxAuthMode(): 'refresh_token' | 'static_access_token' | 'misconfigured' {
  if (usesDropboxRefreshToken()) return 'refresh_token';
  if (getEnv().DROPBOX_ACCESS_TOKEN) return 'static_access_token';
  return 'misconfigured';
}

export function getDropboxAuthStatus(): {
  mode: ReturnType<typeof dropboxAuthMode>;
  configured: boolean;
  configIssue: string | null;
  tokenCached: boolean;
  expiresAt: string | null;
  lastRefreshError: string | null;
  staticTokenWarning: string | null;
} {
  const mode = dropboxAuthMode();
  const configIssue = getDropboxConfigIssue();
  let staticTokenWarning: string | null = null;
  const staticToken = getEnv().DROPBOX_ACCESS_TOKEN;
  if (staticToken?.startsWith('sl.') && !usesDropboxRefreshToken()) {
    staticTokenWarning =
      'DROPBOX_ACCESS_TOKEN is short-lived (~4 hours). Add DROPBOX_REFRESH_TOKEN + APP_KEY + APP_SECRET.';
  }
  if (usesDropboxRefreshToken() && staticToken) {
    staticTokenWarning =
      'DROPBOX_ACCESS_TOKEN is set but ignored — remove it from Railway to avoid confusion.';
  }
  return {
    mode,
    configured: configIssue === null,
    configIssue,
    tokenCached: Boolean(cachedAccessToken),
    expiresAt: accessTokenExpiresAt > 0 ? new Date(accessTokenExpiresAt).toISOString() : null,
    lastRefreshError,
    staticTokenWarning,
  };
}

async function fetchAccessTokenFromRefresh(): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const env = getEnv();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.DROPBOX_REFRESH_TOKEN!,
    client_id: env.DROPBOX_APP_KEY!,
    client_secret: env.DROPBOX_APP_SECRET!,
  });

  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    const msg =
      data.error_description ?? data.error ?? `Dropbox token refresh failed (${res.status})`;
    lastRefreshError = msg;
    throw new Error(msg);
  }

  lastRefreshError = null;
  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 14_400,
  };
}

/**
 * Force a new access token from the refresh token (bypasses cache).
 */
export async function refreshDropboxAccessToken(): Promise<string> {
  clearDropboxTokenCache();
  return getDropboxAccessToken();
}

/**
 * Returns a valid Dropbox access token, refreshing automatically when configured.
 */
export async function getDropboxAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && accessTokenExpiresAt > now) {
    return cachedAccessToken;
  }

  if (usesDropboxRefreshToken()) {
    const { access_token, expires_in } = await fetchAccessTokenFromRefresh();
    cachedAccessToken = access_token;
    accessTokenExpiresAt = now + expires_in * 1000 - EXPIRY_BUFFER_MS;
    logger.info('Dropbox access token refreshed', {
      expiresInSeconds: expires_in,
      expiresAt: new Date(accessTokenExpiresAt).toISOString(),
    });
    return access_token;
  }

  const staticToken = getEnv().DROPBOX_ACCESS_TOKEN;
  if (staticToken) {
    if (staticToken.startsWith('sl.')) {
      logger.warn(
        'Using short-lived DROPBOX_ACCESS_TOKEN without refresh — will expire in ~4 hours'
      );
    }
    return staticToken;
  }

  const issue = getDropboxConfigIssue();
  throw new Error(issue ?? 'Dropbox not configured');
}

/** Warm token on boot so misconfiguration fails early in logs. */
export async function ensureDropboxAccessToken(): Promise<void> {
  if (usesDropboxRefreshToken()) {
    await refreshDropboxAccessToken();
    return;
  }
  await getDropboxAccessToken();
}

export function isExpiredDropboxTokenError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('expired_access_token') ||
    lower.includes('invalid_access_token') ||
    lower.includes('expired access token')
  );
}

export function staticTokenRetryHelp(): string {
  return (
    'DROPBOX_ACCESS_TOKEN is expired (sl. tokens last ~4 hours). ' +
    'On Railway set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and DROPBOX_REFRESH_TOKEN, ' +
    'then remove DROPBOX_ACCESS_TOKEN.'
  );
}
