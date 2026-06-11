/** Card colors. `rainbow` matches every color clue but builds its own stack. */
export const ALL_COLORS = ['red', 'yellow', 'green', 'blue', 'white', 'rainbow'] as const;
export type Color = (typeof ALL_COLORS)[number];

export type CardNumber = 1 | 2 | 3 | 4 | 5;

export interface Card {
  /** Unique id within a game; stable across reorders so the server always knows true identities. */
  id: number;
  color: Color;
  number: CardNumber;
}

export interface GameSettings {
  playerCount: 2 | 3;
  /** Maximum (and starting) clue tokens. 2–10, default 8. */
  maxClues: number;
  /** Misplays the team can survive. 0–4, default 3. At 0 the first misplay ends the game. */
  errorsAllowed: number;
  /** 4, 5, or 6 suits. The 6th suit is rainbow. */
  suits: 4 | 5 | 6;
  /** House rule: allow discarding while at max clue tokens (default false = standard rule). */
  allowDiscardAtMaxClues: boolean;
}

export type Preset = 'easy' | 'standard' | 'hard' | 'custom';

export const PRESETS: Record<Exclude<Preset, 'custom'>, Omit<GameSettings, 'playerCount'>> = {
  easy: { maxClues: 10, errorsAllowed: 4, suits: 4, allowDiscardAtMaxClues: false },
  standard: { maxClues: 8, errorsAllowed: 3, suits: 5, allowDiscardAtMaxClues: false },
  hard: { maxClues: 8, errorsAllowed: 2, suits: 6, allowDiscardAtMaxClues: false },
};

export const DEFAULT_SETTINGS: GameSettings = {
  playerCount: 2,
  ...PRESETS.standard,
};

export type Clue =
  | { kind: 'color'; color: Exclude<Color, 'rainbow'> }
  | { kind: 'number'; number: CardNumber };

/** What a player has been told (and can deduce negatively) about one of their own cards. */
export interface CardKnowledge {
  /** Positive color clues that touched this card. Rainbow cards accumulate several. */
  cluedColors: Color[];
  /** Positive number clue, if any. */
  cluedNumber: CardNumber | null;
  /** Colors this card is known NOT to be. */
  notColors: Color[];
  /** Numbers this card is known NOT to be. */
  notNumbers: CardNumber[];
}

export type DrawSide = 'left' | 'right';

export type GameAction =
  | { type: 'clue'; targetPlayer: number; clue: Clue }
  | { type: 'play'; cardId: number; drawSide?: DrawSide }
  | { type: 'discard'; cardId: number; drawSide?: DrawSide };

export type LogEntry =
  | {
      type: 'clue';
      turn: number;
      actor: number;
      target: number;
      clue: Clue;
      /** Hand positions (in the target's current order) that matched. */
      positions: number[];
      cardIds: number[];
    }
  | {
      type: 'play';
      turn: number;
      actor: number;
      card: Card;
      success: boolean;
      completedStack: boolean;
    }
  | { type: 'discard'; turn: number; actor: number; card: Card }
  | { type: 'draw'; turn: number; actor: number; cardId: number }
  | { type: 'gameEnd'; turn: number; outcome: GameOutcome; score: number };

export type GameOutcome = 'won' | 'lost' | 'finished';
export type GameStatus = 'playing' | GameOutcome;

/** Full authoritative game state. Never send this to clients — use getPlayerView. */
export interface GameState {
  settings: GameSettings;
  /** Draw pile; cards are drawn from the end. */
  deck: Card[];
  /** Per player, in that player's chosen display order. */
  hands: Card[][];
  /** Top card per color stack (0 = empty). */
  stacks: Partial<Record<Color, number>>;
  discard: Card[];
  clues: number;
  /** Misplays so far. */
  errors: number;
  /** Whose turn (player index). */
  currentPlayer: number;
  /** 1-based turn counter, increments on every turn action. */
  turn: number;
  /** Once the deck empties: how many turns remain (each player gets one). null while deck has cards. */
  finalTurnsRemaining: number | null;
  status: GameStatus;
  knowledge: Record<number, CardKnowledge>;
  log: LogEntry[];
  /** Most recent clue, for the "replay last clue" feature. */
  lastClue: Extract<LogEntry, { type: 'clue' }> | null;
}

/** A card as seen by its own holder: identity stripped, knowledge attached. */
export interface HiddenCard {
  id: number;
  knowledge: CardKnowledge;
}

/** Everything one client is allowed to see. */
export interface PlayerView {
  playerIndex: number;
  settings: GameSettings;
  deckCount: number;
  /** Your own hand, identities redacted. */
  ownHand: HiddenCard[];
  /** Partners' hands, face up, keyed by player index. */
  partnerHands: Record<number, Card[]>;
  /** Partners' knowledge too, so you can see what they know. */
  partnerKnowledge: Record<number, CardKnowledge>;
  stacks: Partial<Record<Color, number>>;
  /** Colors whose stack can no longer be completed. */
  deadStacks: Color[];
  discard: Card[];
  clues: number;
  errors: number;
  currentPlayer: number;
  turn: number;
  finalTurnsRemaining: number | null;
  status: GameStatus;
  score: number;
  log: LogEntry[];
  lastClue: Extract<LogEntry, { type: 'clue' }> | null;
}

/** Suits in play for a given setting. */
export function suitsFor(suits: 4 | 5 | 6): Color[] {
  return ALL_COLORS.slice(0, suits) as Color[];
}

/** Copies per number in each suit: three 1s, two 2s/3s/4s, one 5. */
export const COPIES: Record<CardNumber, number> = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1 };

export const HAND_SIZE = 5;
