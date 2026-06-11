import { isBackendConfigured } from '../lib/supabase';
import { MockBackend } from './mock';
import type { GameBackend } from './types';

export * from './types';
export { MockBackend };

let instance: GameBackend | null = null;

/**
 * Pick the backend for this session. With VITE_SUPABASE_URL/ANON_KEY set, the
 * SupabaseBackend will be returned here (build-order step 4); until it lands,
 * everything runs on the in-memory MockBackend.
 */
export function getBackend(): GameBackend {
  if (!instance) {
    if (isBackendConfigured) {
      // SupabaseBackend is the next build step (see SPEC.md). Fall back loudly.
      console.warn('Supabase env vars found, but SupabaseBackend is not implemented yet — using demo mode.');
    }
    instance = new MockBackend();
  }
  return instance;
}
