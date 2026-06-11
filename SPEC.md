# Prompt: Build a Remote Multiplayer Hanabi Web App

## Instructions for Claude Code (read first)

1. Save this entire document as `SPEC.md` in the repo root so it persists across sessions.
1. Start with steps 1–2 of the Build order below (game engine with unit tests + mock-mode UI). Do NOT touch Supabase yet — the credentials section may be blank.
1. When mock mode is playable, deploy a preview (e.g., Vercel) so I can test on my phone.
1. In future sessions, re-read `SPEC.md` before doing anything.

## My Supabase config (fill in before running, or leave blank — see Setup section)

- SUPABASE_URL: [paste here]
- SUPABASE_ANON_KEY: [paste here]
- GitHub repo (if created): [paste here]

Build a web app for the cooperative card game **Hanabi**, played by 2–3 humans on separate devices (phone, iPad, or laptop browser), typically while talking over FaceTime/Zoom. No in-app chat or voice is needed — communication happens off-app, but all clue-giving must go through the game’s clue mechanic.

## Multiplayer architecture

- **Room system:** the host creates a game (choosing settings), gets a short shareable room code (e.g., “FOX-742”) and a join link; friends enter the code or tap the link to join. Game starts when the host taps Start.
- **Real-time sync:** use **Supabase** (Postgres + Realtime channels) so every action appears on all devices within ~1 second. Turn-based, so polling every 1–2s is an acceptable fallback if Realtime is unavailable.
- **Config isolation:** ALL Supabase credentials live in a single `.env` file (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) read in exactly one file, `src/lib/supabase.ts` — nothing else in the codebase touches credentials. Include a committed `.env.example`.
- **Mock mode:** if env vars are missing, the app runs in a local single-device demo mode (in-memory state, simulated second player or hotseat) so the UI and game logic are fully buildable and testable before Supabase is connected. A small banner indicates “Demo mode — no backend connected.”
- **Database setup as a file:** generate the complete schema as a single migration file (`supabase/migrations/001_init.sql`) — tables for rooms, players, game state, and actions, with Row Level Security policies — plus a `SETUP.md` with step-by-step instructions for pasting it into the Supabase SQL editor and enabling Realtime on the relevant tables. Assume I will do this from the Supabase web dashboard.
- **Hidden information enforced server-side:** each client only ever receives the data it’s allowed to see — a player’s own card identities are never sent to their device, only the clue information they’ve accumulated. Partners’ cards are sent face-up.
- **Reconnection:** if someone refreshes or drops, rejoining with the same room code restores their seat and full game state. Show a “waiting for [name]” indicator to others.
- **Turn indicator:** make it unmistakable whose turn it is (banner + subtle device vibration/sound on your turn, toggleable).

## Core rules

- Deck: for each color — three 1s, two each of 2s/3s/4s, one 5.
- Each player holds 5 cards (2–3 players). **Your own cards are face-down to you** (card backs only); all partners’ cards are fully visible, like real Hanabi.
- Goal: cooperatively build one ascending stack per color (1→2→3→4→5), displayed like solitaire foundation piles in the center.
- On your turn, do exactly one of:
1. **Give a clue** (costs 1 clue token): pick a partner and name a color OR a number; the app highlights ALL of their cards matching it, on every screen. You cannot clue yourself.
1. **Discard a card** (regain 1 clue token, up to max): goes to a shared visible discard pile; draw a replacement.
1. **Play a card**: if it’s the next number on its color stack it plays; otherwise it’s discarded and one error/fuse token is lost. Completing a 5 restores one clue token. Draw a replacement.
- Game ends when errors run out (loss), all stacks complete (perfect score), or the deck empties and each player gets one final turn. Score = sum of top cards on all stacks.

## Settings (host configures before start)

- **Players:** 2 or 3.
- **Clue tokens:** adjustable 2–10 (default 8).
- **Errors allowed:** adjustable 0–4 (default 3). At 0, the first misplay immediately ends the game — sudden-death mode.
- **Colors:** 4, 5, or 6 suits. The 6th suit is **rainbow**, which matches ANY color clue but builds its own stack. Options: remove rainbow (standard 5-color), or 4 colors for an easier game.
- Preset Easy/Standard/Hard labels mapping to combinations of the above, plus Custom.

## Per-player preferences (each player sets their own, changeable mid-game)

- **Clue indicators on/off:** when off, your own cards show NO badges, rings, or negative info — you must remember clues yourself, like the physical game. The clue animation still plays in the moment it’s given (matching cards flash on every screen), but leaves no trace on your hand afterward. The action log also censors clues you received (e.g., “Maria gave you a clue” with no color/number/positions), so you can’t scroll back to recover them — clues given to partners stay fully visible. Indicators-off is the “expert” mode; default is on.
- **Reorder your own hand:** drag (touch and mouse) your face-down cards into any order at any time, even off-turn, as a memory aid — e.g., sliding clued cards to one side. Reordering is free (not a turn action), and the server keeps tracking true card identities regardless of position. Partners see your hand in your chosen order so clues highlight the correct positions.
- **Draw side:** choose whether newly drawn cards enter your hand on the left or the right, so your “oldest card” convention stays consistent.

## UI requirements

- Fully responsive: comfortable one-handed on a phone in portrait, and uses the space well on iPad/laptop.
- Layout: partners’ hands face-up at top with their names, foundation stacks center, discard pile + deck count to the side, your face-down hand at the bottom.
- Your own cards display received clue info (number badge, color ring, negative info on tap) — but only if your clue-indicators preference is on.
- Clue tokens and error tokens as clear icon counters visible at all times.
- Scrollable action log in plain English (“Maria clued your blues”, “You played a green 2 ✓”).
- End screen with score, the standard Hanabi score-tier flavor text, and Rematch (same settings, same room) / Change settings options.
- Clean, polished look; smooth card animations for clue highlights, plays, discards, and draws.

## Design direction

- **Theme:** lean into the name — *hanabi* means fireworks in Japanese. Night-sky palette (deep indigo/navy), cards and stacks glowing like lanterns, paper-texture accents, fireworks bursts as the reward animation. Serene and warm, not arcade-loud.
- **Vibe references:** the calm minimalism of *Mini Metro / Monument Valley*, the cozy tactile polish of digital *Wingspan*, the friction-free room-code flow of *Jackbox* or online *Codenames* (open link, type name, you’re in — no accounts required to play).
- **Functional reference:** study *hanab.live*‘s layout conventions for hidden-hand display, clue badges, and discard visibility — it’s the standard among serious players — but make ours dramatically warmer and more beautiful; hanab.live is a spreadsheet with cards.
- **Sound:** soft optional SFX — a paper slide on draw, a chime on a successful play, a distant firework on completing a stack. **Default off** (players will be on FaceTime/Zoom); easy toggle to turn on.

## Build order (so backend plugs in last)

1. Game engine as pure functions (deck, turns, clue/play/discard logic, scoring) with unit tests — zero backend dependencies.
1. Full UI in mock mode: lobby, settings, game board, per-player preferences, end screen.
1. A thin `GameBackend` interface (createRoom, joinRoom, submitAction, subscribe) with a `MockBackend` implementation used by demo mode.
1. A `SupabaseBackend` implementing the same interface, plus the migration SQL and `SETUP.md`. Swapping mock→Supabase should require only adding the two env vars — no other code changes.

## Long-distance play features

- **Confirm before play/discard:** require tap-then-confirm or a drag-to-zone gesture — never a single tap that can burn a fuse by accident.
- **Persistent rooms:** games survive ~48 hours, so an interrupted game resumes exactly where it left off. Optional browser notification when it becomes your turn, for casual async play.
- **Synced drama:** plays resolve simultaneously on both screens with a beat of suspense — the card flips, then a fireworks burst on success or a fuse-sizzle animation on a misplay, seen at the same moment.
- **Shared stats:** persistent head-to-head history per friend pair — games played, best score, win streak, scores by difficulty. Store in Supabase.
- **One-tap rematch:** same room, same settings, fresh deal.
- **Replay last clue:** a small replay button re-runs the most recent clue’s highlight animation (which cards flashed, and the color/number given) as many times as you like — but it’s only available until you take your turn, then it’s gone. This works even with clue indicators off; it’s the digital equivalent of “wait, say that again.”

## Edge cases

- Can’t clue at 0 tokens; can’t discard at max tokens (standard rule — make it a toggleable house rule).
- Clues must match at least one card (no empty clues).
- Rainbow cards register as matching every color clue.
- If a card needed to finish a stack has been fully discarded, mark that stack dead with a subtle cue.
- Handle a player acting out of turn (disable inputs when it’s not your turn) and double-taps/duplicate submissions (server validates the move against current state).
