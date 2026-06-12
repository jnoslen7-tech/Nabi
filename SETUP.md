# Supabase setup — step by step

Everything is done from the Supabase web dashboard. Total time: ~3 minutes.

## 1. Run the migration

1. Open your project dashboard: `https://supabase.com/dashboard/project/<your-project-ref>`
2. In the left sidebar, click **SQL Editor**.
3. Click **New query** (or the `+` tab).
4. Open [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) from this
   repo, **copy the entire file**, and paste it into the editor.
5. Click **Run** (or press Cmd/Ctrl-Enter).
6. You should see **"Success. No rows returned"**. Warnings about
   "policy ... does not exist, skipping" are fine — the script is safe to re-run.

## 2. Verify Realtime is on for the `rooms` table

The migration enables this automatically, but confirm it:

1. Sidebar → **Database** → **Publications**.
2. Click **supabase_realtime**.
3. The `rooms` table should be listed/toggled on. If it isn't, toggle it on
   (only `rooms` is needed — game state is fetched via RPC, never broadcast).

If Realtime is ever unavailable, the app still works: it polls every 2.5 s.

## 3. Point the app at your project

Create `.env` in the repo root (copy `.env.example`):

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon / public key>
```

- Both values live in the dashboard under **Project Settings → Data API**.
- ⚠️ Use the **API URL** (`https://<ref>.supabase.co`), *not* the dashboard page URL.
- For a Vercel deployment, add the same two variables under
  **Vercel → Project → Settings → Environment Variables**, then redeploy.

That's the only code-side change: with the env vars present the app uses the
Supabase backend; without them it falls back to demo mode.

## How the security model works

- The full game state (everyone's cards) lives in the `games` table, which has
  Row Level Security enabled and **no read policies** — no client can ever
  select it, even with the anon key.
- Every read and write goes through Postgres functions (`create_room`,
  `join_room`, `submit_action`, `get_snapshot`, …) that run as `SECURITY
  DEFINER`. They authenticate each request with a per-player secret token
  (issued at join, stored only in that player's browser) and validate every
  move server-side — out-of-turn actions, empty clues, double-taps, and
  spectator forgeries are all rejected in the database.
- `get_snapshot` returns each caller **only their redacted view**: their own
  cards are stripped to card-id + accumulated clue knowledge; partners' cards
  are face-up. Your own card identities never leave the server.
- `rooms` and `players` are publicly readable but contain no hidden
  information; Realtime broadcasts only a version bump on `rooms` ("something
  changed — refetch your view").
- Rooms persist 48 hours, then are swept automatically.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Could not find the function public.create_room" | Migration not run — repeat step 1. |
| "Not authorized for this room" | Browser storage was cleared; rejoin with the room code to get a fresh seat. |
| Moves only appear after ~2.5 s | Realtime is off — check step 2 (polling fallback is carrying the game). |
| App shows "Demo mode" banner | `.env` missing/blank, or the dev server wasn't restarted after editing it. |
