/**
 * The ONLY file in the codebase that reads Supabase credentials.
 * Everything else asks this module whether a backend is configured.
 *
 * With no .env (or blank values) the app runs in demo/mock mode.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

export const supabaseConfig: { url: string; anonKey: string } | null =
  url && anonKey ? { url, anonKey } : null;

export const isBackendConfigured = supabaseConfig !== null;

/** Shared client, or null in demo mode. No auth/accounts — access goes through RPCs. */
export const supabase: SupabaseClient | null = supabaseConfig
  ? createClient(supabaseConfig.url, supabaseConfig.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
