import { deadStacks, getScore } from './game';
import type { Card, CardKnowledge, GameState, HiddenCard, LogEntry, PlayerView } from './types';

/**
 * Project the authoritative state down to exactly what one player may see.
 * The player's own card identities are stripped — only ids + accumulated clue
 * knowledge are included. This is the ONLY shape that should ever cross the
 * network to a client (the Supabase backend enforces the same projection
 * server-side).
 */
export function getPlayerView(state: GameState, playerIndex: number): PlayerView {
  const ownHand: HiddenCard[] = state.hands[playerIndex].map((card) => ({
    id: card.id,
    knowledge: structuredClone(state.knowledge[card.id]),
  }));

  const partnerHands: Record<number, Card[]> = {};
  const partnerKnowledge: Record<number, CardKnowledge> = {};
  for (let p = 0; p < state.settings.playerCount; p++) {
    if (p === playerIndex) continue;
    partnerHands[p] = structuredClone(state.hands[p]);
    for (const card of state.hands[p]) {
      partnerKnowledge[card.id] = structuredClone(state.knowledge[card.id]);
    }
  }

  return {
    playerIndex,
    settings: structuredClone(state.settings),
    deckCount: state.deck.length,
    ownHand,
    partnerHands,
    partnerKnowledge,
    stacks: structuredClone(state.stacks),
    deadStacks: deadStacks(state),
    discard: structuredClone(state.discard),
    clues: state.clues,
    errors: state.errors,
    currentPlayer: state.currentPlayer,
    turn: state.turn,
    finalTurnsRemaining: state.finalTurnsRemaining,
    status: state.status,
    score: getScore(state),
    log: redactLog(state.log, playerIndex),
    lastClue: state.lastClue ? structuredClone(state.lastClue) : null,
  };
}

/**
 * Draw log entries reveal which card id a player drew; the drawer must not be
 * able to cross-reference anything about their own draws beyond the id (which
 * is already visible in their hand), so draws are safe. Play/discard entries
 * reveal full card identity — fine, those cards are public once they leave a
 * hand. Nothing in the log leaks hidden info, so the engine-level log is the
 * same for everyone. (Clue-censoring for the indicators-off preference is a
 * DISPLAY choice, applied in the UI, so toggling the preference mid-game
 * behaves correctly without needing new data.)
 */
function redactLog(log: LogEntry[], _playerIndex: number): LogEntry[] {
  return structuredClone(log);
}

/** Standard Hanabi score-tier flavor text (25-point scale, scaled for 4/6 suits). */
export function scoreFlavor(score: number, maxPossible: number): string {
  if (score >= maxPossible) return 'Legendary! The crowd will never forget this night.';
  const pct = score / maxPossible;
  if (pct >= 0.96) return 'Extraordinary! The crowd is amazed.';
  if (pct >= 0.84) return 'Excellent! The crowd is delighted.';
  if (pct >= 0.64) return 'Very good! The crowd is pleased.';
  if (pct >= 0.44) return 'Honorable, but the crowd hoped for more.';
  if (pct >= 0.24) return 'A modest show. Polite applause.';
  if (pct >= 0.04) return 'A few scattered sparks. The crowd shuffles away.';
  return 'The fireworks never left the ground...';
}
