import { supabase } from '../lib/supabase';
import { MockBackend } from './mock';
import { SupabaseBackend } from './supabase';
import type { GameBackend } from './types';

export * from './types';
export { MockBackend, SupabaseBackend };

let instance: GameBackend | null = null;

/**
 * Pick the backend for this session: SupabaseBackend when the two env vars
 * are set (see src/lib/supabase.ts), otherwise the in-memory demo backend.
 */
export function getBackend(): GameBackend {
  if (!instance) {
    instance = supabase ? new SupabaseBackend(supabase) : new MockBackend();
  }
  return instance;
}
