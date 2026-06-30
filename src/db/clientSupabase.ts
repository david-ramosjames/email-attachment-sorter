import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';

let client: SupabaseClient | null = null;
let checked = false;

export function isClientSupabaseConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.CLIENT_SUPABASE_URL && env.CLIENT_SUPABASE_SERVICE_ROLE_KEY);
}

/** Client / case-tracker Supabase (medical billing lines). Returns null when not configured. */
export function getClientSupabase(): SupabaseClient | null {
  if (checked) return client;
  checked = true;

  const env = getEnv();
  if (!env.CLIENT_SUPABASE_URL || !env.CLIENT_SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  client = createClient(env.CLIENT_SUPABASE_URL, env.CLIENT_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
