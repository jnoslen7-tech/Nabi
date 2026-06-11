import { createDeck, makeRng, shuffle } from './deck';
import {
  COPIES,
  HAND_SIZE,
  suitsFor,
  type Card,
  type CardKnowledge,
  type Clue,
  type Color,
  type DrawSide,
  type GameAction,
  type GameSettings,
  type GameState,
  type LogEntry,
} from './types';

export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

function emptyKnowledge(): CardKnowledge {
  return { cluedColors: [], cluedNumber: null, notColors: [], notNumbers: [] };
}

export function validateSettings(s: GameSettings): void {
  if (s.playerCount !== 2 && s.playerCount !== 3) throw new GameError('settings', 'Players must be 2 or 3');
  if (s.maxClues < 2 || s.maxClues > 10) throw new GameError('settings', 'Clue tokens must be 2–10');
  if (s.errorsAllowed < 0 || s.errorsAllowed > 4) throw new GameError('settings', 'Errors allowed must be 0–4');
  if (![4, 5, 6].includes(s.suits)) throw new GameError('settings', 'Suits must be 4, 5, or 6');
}

/** Deal a fresh game. Same seed + settings ⇒ same deal (used for tests; rematches use a new seed). */
export function createGame(settings: GameSettings, seed: number = Date.now() >>> 0): GameState {
  validateSettings(settings);
  const rng = makeRng(seed);
  const deck = shuffle(createDeck(settings.suits), rng);

  const hands: Card[][] = [];
  for (let p = 0; p < settings.playerCount; p++) {
    hands.push(deck.splice(deck.length - HAND_SIZE, HAND_SIZE).reverse());
  }

  const stacks: Partial<Record<Color, number>> = {};
  for (const color of suitsFor(settings.suits)) stacks[color] = 0;

  const knowledge: Record<number, CardKnowledge> = {};
  for (const card of [...deck, ...hands.flat()]) knowledge[card.id] = emptyKnowledge();

  return {
    settings,
    deck,
    hands,
    stacks,
    discard: [],
    clues: settings.maxClues,
    errors: 0,
    currentPlayer: 0,
    turn: 1,
    finalTurnsRemaining: null,
    status: 'playing',
    knowledge,
    log: [],
    lastClue: null,
  };
}

/** Does this card match the given clue? Rainbow matches every COLOR clue; numbers match normally. */
export function clueMatches(card: Card, clue: Clue): boolean {
  if (clue.kind === 'number') return card.number === clue.number;
  return card.color === clue.color || card.color === 'rainbow';
}

export function getScore(state: Pick<GameState, 'stacks'>): number {
  return Object.values(state.stacks).reduce((sum, h) => sum + (h ?? 0), 0);
}

export function maxScore(settings: GameSettings): number {
  return settings.suits * 5;
}

/**
 * Colors whose stack can never be completed because a needed card is fully discarded.
 * A stack is dead if the NEXT needed rank has all copies in the discard pile.
 */
export function deadStacks(state: Pick<GameState, 'stacks' | 'discard' | 'settings'>): Color[] {
  const dead: Color[] = [];
  for (const color of suitsFor(state.settings.suits)) {
    const height = state.stacks[color] ?? 0;
    if (height >= 5) continue;
    const needed = (height + 1) as 1 | 2 | 3 | 4 | 5;
    const discarded = state.discard.filter((c) => c.color === color && c.number === needed).length;
    if (discarded >= COPIES[needed]) dead.push(color);
  }
  return dead;
}

/** Highest score still reachable given what's been discarded. */
export function maxReachableScore(state: Pick<GameState, 'stacks' | 'discard' | 'settings'>): number {
  let total = 0;
  for (const color of suitsFor(state.settings.suits)) {
    let height = state.stacks[color] ?? 0;
    for (let n = height + 1; n <= 5; n++) {
      const discarded = state.discard.filter((c) => c.color === color && c.number === n).length;
      if (discarded >= COPIES[n as 1 | 2 | 3 | 4 | 5]) break;
      height = n;
    }
    total += height;
  }
  return total;
}

function findInHand(state: GameState, player: number, cardId: number): number {
  const idx = state.hands[player].findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameError('not_in_hand', 'That card is not in your hand');
  return idx;
}

/** Draw a replacement into the player's hand on their preferred side. Mutates the (cloned) state. */
function draw(state: GameState, player: number, side: DrawSide): void {
  if (state.deck.length === 0) return;
  const card = state.deck.pop()!;
  if (side === 'left') state.hands[player].unshift(card);
  else state.hands[player].push(card);
  state.log.push({ type: 'draw', turn: state.turn, actor: player, cardId: card.id });
  if (state.deck.length === 0) {
    // Last card drawn: everyone, including this player, gets one final turn.
    // +1 because endTurn decrements at the end of the current (drawing) turn.
    state.finalTurnsRemaining = state.settings.playerCount + 1;
  }
}

function endTurn(state: GameState): void {
  if (state.status !== 'playing') {
    state.log.push({ type: 'gameEnd', turn: state.turn, outcome: state.status, score: getScore(state) });
    return;
  }
  if (state.finalTurnsRemaining !== null) {
    state.finalTurnsRemaining -= 1;
    if (state.finalTurnsRemaining <= 0) {
      state.status = 'finished';
      state.log.push({ type: 'gameEnd', turn: state.turn, outcome: 'finished', score: getScore(state) });
      return;
    }
  }
  state.turn += 1;
  state.currentPlayer = (state.currentPlayer + 1) % state.settings.playerCount;
}

/**
 * Apply a turn action. Pure: returns a new state, never mutates the input.
 * Throws GameError for any illegal move (wrong turn, empty clue, no tokens, ...),
 * which is also how duplicate/out-of-turn submissions are rejected server-side.
 */
export function applyAction(prev: GameState, player: number, action: GameAction): GameState {
  if (prev.status !== 'playing') throw new GameError('game_over', 'The game is over');
  if (player !== prev.currentPlayer) throw new GameError('not_your_turn', 'It is not your turn');

  const state: GameState = structuredClone(prev);

  switch (action.type) {
    case 'clue': {
      if (state.clues <= 0) throw new GameError('no_clues', 'No clue tokens left');
      if (action.targetPlayer === player) throw new GameError('self_clue', 'You cannot clue yourself');
      const targetHand = state.hands[action.targetPlayer];
      if (!targetHand) throw new GameError('bad_target', 'No such player');

      const matched = targetHand.filter((c) => clueMatches(c, action.clue));
      if (matched.length === 0) throw new GameError('empty_clue', 'Clues must match at least one card');

      state.clues -= 1;
      for (const card of targetHand) {
        const k = state.knowledge[card.id];
        if (clueMatches(card, action.clue)) {
          if (action.clue.kind === 'color') {
            if (!k.cluedColors.includes(action.clue.color)) k.cluedColors.push(action.clue.color);
          } else {
            k.cluedNumber = action.clue.number;
          }
        } else {
          if (action.clue.kind === 'color') {
            if (!k.notColors.includes(action.clue.color)) k.notColors.push(action.clue.color);
          } else {
            if (!k.notNumbers.includes(action.clue.number)) k.notNumbers.push(action.clue.number);
          }
        }
      }

      const entry: Extract<LogEntry, { type: 'clue' }> = {
        type: 'clue',
        turn: state.turn,
        actor: player,
        target: action.targetPlayer,
        clue: action.clue,
        positions: targetHand.map((c, i) => (clueMatches(c, action.clue) ? i : -1)).filter((i) => i >= 0),
        cardIds: matched.map((c) => c.id),
      };
      state.log.push(entry);
      state.lastClue = entry;
      break;
    }

    case 'discard': {
      if (!state.settings.allowDiscardAtMaxClues && state.clues >= state.settings.maxClues) {
        throw new GameError('max_clues', 'Cannot discard at maximum clue tokens');
      }
      const idx = findInHand(state, player, action.cardId);
      const [card] = state.hands[player].splice(idx, 1);
      state.discard.push(card);
      state.clues = Math.min(state.settings.maxClues, state.clues + 1);
      state.log.push({ type: 'discard', turn: state.turn, actor: player, card });
      draw(state, player, action.drawSide ?? 'right');
      break;
    }

    case 'play': {
      const idx = findInHand(state, player, action.cardId);
      const [card] = state.hands[player].splice(idx, 1);
      const height = state.stacks[card.color] ?? 0;
      const success = card.number === height + 1;
      let completedStack = false;

      if (success) {
        state.stacks[card.color] = card.number;
        if (card.number === 5) {
          completedStack = true;
          state.clues = Math.min(state.settings.maxClues, state.clues + 1);
        }
        if (getScore(state) === maxScore(state.settings)) {
          state.status = 'won';
        }
      } else {
        state.discard.push(card);
        state.errors += 1;
        if (state.errors > state.settings.errorsAllowed) {
          state.status = 'lost';
        }
      }

      state.log.push({ type: 'play', turn: state.turn, actor: player, card, success, completedStack });
      if (state.status === 'playing') draw(state, player, action.drawSide ?? 'right');
      break;
    }

    default:
      throw new GameError('bad_action', 'Unknown action');
  }

  endTurn(state);
  return state;
}

/**
 * Reorder a player's own hand. FREE — not a turn action, allowed any time while the
 * game is running, even off-turn. `order` must be a permutation of the player's card ids.
 */
export function reorderHand(prev: GameState, player: number, order: number[]): GameState {
  if (prev.status !== 'playing') throw new GameError('game_over', 'The game is over');
  const hand = prev.hands[player];
  if (!hand) throw new GameError('bad_player', 'No such player');
  const ids = new Set(hand.map((c) => c.id));
  if (order.length !== hand.length || !order.every((id) => ids.has(id)) || new Set(order).size !== order.length) {
    throw new GameError('bad_order', 'Order must be a permutation of your hand');
  }
  const state = structuredClone(prev);
  const byId = new Map(state.hands[player].map((c) => [c.id, c]));
  state.hands[player] = order.map((id) => byId.get(id)!);
  return state;
}
