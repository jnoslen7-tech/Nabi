# Hanabi 花火

A remote multiplayer web app for the cooperative card game **Hanabi**, for 2–3 friends on
phones/tablets/laptops while talking over FaceTime/Zoom. See [`SPEC.md`](SPEC.md) for the full
product spec.

## Status

| Build-order step | Status |
| --- | --- |
| 1. Game engine (pure functions + unit tests) | ✅ done — `src/engine/`, 33 tests |
| 2. Full UI in mock/demo mode | ✅ done — lobby, settings, board, preferences, end screen |
| 3. `GameBackend` interface + `MockBackend` | ✅ done — `src/backend/` |
| 4. `SupabaseBackend` + migration SQL + `SETUP.md` | ✅ done — see [`SETUP.md`](SETUP.md) (one-time dashboard step required) |

With no `.env`, the app runs in **demo mode** (in-memory, hotseat — add local players in the
lobby and switch seats from the banner). With `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
set in `.env`, the app uses the Supabase backend — real multiplayer across devices. The
one-time database setup is in [`SETUP.md`](SETUP.md).

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # engine unit tests
npm run build      # production build → dist/
```

## Deploy a preview (Vercel)

1. Push this repo to GitHub (already done if you're reading this there).
2. [vercel.com/new](https://vercel.com/new) → Import the repo → Framework preset: **Vite** →
   Deploy. No env vars needed for demo mode.
3. Open the deployed URL on your phone — demo mode is fully playable single-device.

## Code map

- `src/engine/` — pure game logic: deck, clues (incl. rainbow), play/discard, scoring,
  dead-stack detection, hidden-information player views. Zero backend or React imports.
- `src/backend/` — the thin `GameBackend` interface and the in-memory `MockBackend`.
- `src/lib/supabase.ts` — the **only** file that reads Supabase credentials.
- `src/screens/`, `src/components/` — React UI (home → lobby → game → end).
- `src/styles.css` — the night-sky / lantern theme.
