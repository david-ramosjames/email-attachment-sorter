import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let cachedAccessToken: string | null = null;
/** Unix ms — refresh 5 minutes before Dropbox expiry */
let accessTokenExpiresAt = 0;

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

export function dropboxAuthMode(): 'refresh_token' | 'static_access_token' {
  return usesDropboxRefreshToken() ? 'refresh_token' : 'static_access_token';
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
    throw new Error(
      data.error_description ?? data.error ?? `Dropbox token refresh failed (${res.status})`
    );
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 14_400,
  };
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
    });
    return access_token;
  }

  const staticToken = getEnv().DROPBOX_ACCESS_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  throw new Error(
    'Dropbox not configured: set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET, or DROPBOX_ACCESS_TOKEN'
  );
}

/** Warm token on boot so misconfiguration fails early in logs. */
export async function ensureDropboxAccessToken(): Promise<void> {
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
