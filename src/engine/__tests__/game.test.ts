import { describe, expect, it } from 'vitest';
import { createDeck, makeRng, shuffle } from '../deck';
import {
  GameError,
  applyAction,
  clueMatches,
  createGame,
  deadStacks,
  getScore,
  maxReachableScore,
  maxScore,
  reorderHand,
} from '../game';
import { getPlayerView, scoreFlavor } from '../view';
import {
  DEFAULT_SETTINGS,
  HAND_SIZE,
  type Card,
  type CardNumber,
  type Color,
  type GameSettings,
  type GameState,
} from '../types';

const settings = (overrides: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

/** Force a known hand for a player (test helper: swaps cards between deck and hand). */
function rig(state: GameState, player: number, wanted: Array<[Color, CardNumber]>): GameState {
  const s = structuredClone(state);
  const pool: Card[] = [...s.deck, ...s.hands.flat()];
  const used = new Set<number>();
  const hand: Card[] = wanted.map(([color, number]) => {
    const card = pool.find((c) => c.color === color && c.number === number && !used.has(c.id));
    if (!card) throw new Error(`No ${color} ${number} available`);
    used.add(card.id);
    return card;
  });
  // Everything not in the rigged hand goes back to deck/other hands in original order.
  const remaining = pool.filter((c) => !used.has(c.id));
  s.hands[player] = hand;
  for (let p = 0; p < s.settings.playerCount; p++) {
    if (p !== player) s.hands[p] = remaining.splice(0, HAND_SIZE);
  }
  s.deck = remaining;
  return s;
}

describe('deck construction', () => {
  it('builds 50 cards for 5 suits with correct distribution', () => {
    const deck = createDeck(5);
    expect(deck).toHaveLength(50);
    for (const color of ['red', 'yellow', 'green', 'blue', 'white'] as const) {
      const suit = deck.filter((c) => c.color === color);
      expect(suit).toHaveLength(10);
      expect(suit.filter((c) => c.number === 1)).toHaveLength(3);
      expect(suit.filter((c) => c.number === 2)).toHaveLength(2);
      expect(suit.filter((c) => c.number === 3)).toHaveLength(2);
      expect(suit.filter((c) => c.number === 4)).toHaveLength(2);
      expect(suit.filter((c) => c.number === 5)).toHaveLength(1);
    }
  });

  it('builds 40 cards for 4 suits and 60 for 6 (rainbow included)', () => {
    expect(createDeck(4)).toHaveLength(40);
    const six = createDeck(6);
    expect(six).toHaveLength(60);
    expect(six.some((c) => c.color === 'rainbow')).toBe(true);
    expect(createDeck(5).some((c) => c.color === 'rainbow')).toBe(false);
  });

  it('shuffle is deterministic per seed and a permutation', () => {
    const deck = createDeck(5);
    const a = shuffle(deck, makeRng(42));
    const b = shuffle(deck, makeRng(42));
    const c = shuffle(deck, makeRng(43));
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a.map((x) => x.id)).not.toEqual(c.map((x) => x.id));
    expect([...a].sort((x, y) => x.id - y.id)).toEqual(deck);
  });
});

describe('game creation', () => {
  it('deals 5 cards each and starts with full clue tokens', () => {
    const g = createGame(settings({ playerCount: 3 }), 1);
    expect(g.hands).toHaveLength(3);
    for (const hand of g.hands) expect(hand).toHaveLength(5);
    expect(g.deck).toHaveLength(50 - 15);
    expect(g.clues).toBe(8);
    expect(g.errors).toBe(0);
    expect(g.currentPlayer).toBe(0);
    expect(g.status).toBe('playing');
    expect(getScore(g)).toBe(0);
  });

  it('rejects invalid settings', () => {
    expect(() => createGame(settings({ maxClues: 1 }), 1)).toThrow(GameError);
    expect(() => createGame(settings({ maxClues: 11 }), 1)).toThrow(GameError);
    expect(() => createGame(settings({ errorsAllowed: 5 }), 1)).toThrow(GameError);
    expect(() => createGame(settings({ errorsAllowed: -1 }), 1)).toThrow(GameError);
  });
});

describe('clues', () => {
  it('costs a token, records positive and negative knowledge', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 1, [['red', 1], ['red', 2], ['blue', 1], ['green', 3], ['white', 5]]);
    const next = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'red' } });
    expect(next.clues).toBe(7);
    const [r1, r2, b1, g3, w5] = next.hands[1];
    expect(next.knowledge[r1.id].cluedColors).toEqual(['red']);
    expect(next.knowledge[r2.id].cluedColors).toEqual(['red']);
    expect(next.knowledge[b1.id].notColors).toEqual(['red']);
    expect(next.knowledge[g3.id].notColors).toEqual(['red']);
    expect(next.knowledge[w5.id].notColors).toEqual(['red']);
    expect(next.currentPlayer).toBe(1);
    expect(next.lastClue?.positions).toEqual([0, 1]);
  });

  it('number clues record number knowledge', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 1, [['red', 1], ['blue', 1], ['green', 3], ['white', 4], ['yellow', 2]]);
    const next = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'number', number: 1 } });
    const [r1, b1, g3] = next.hands[1];
    expect(next.knowledge[r1.id].cluedNumber).toBe(1);
    expect(next.knowledge[b1.id].cluedNumber).toBe(1);
    expect(next.knowledge[g3.id].notNumbers).toEqual([1]);
  });

  it('rejects self-clues, empty clues, and clues at 0 tokens', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 1, [['red', 1], ['red', 2], ['red', 3], ['red', 4], ['red', 5]]);
    expect(() =>
      applyAction(g, 0, { type: 'clue', targetPlayer: 0, clue: { kind: 'color', color: 'red' } }),
    ).toThrow(/clue yourself/);
    expect(() =>
      applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'blue' } }),
    ).toThrow(/at least one card/);
    const broke = { ...g, clues: 0 };
    expect(() =>
      applyAction(broke, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'red' } }),
    ).toThrow(/No clue tokens/);
  });

  it('rainbow cards match EVERY color clue and accumulate multiple clued colors', () => {
    let g = createGame(settings({ suits: 6 }), 1);
    g = rig(g, 1, [['rainbow', 1], ['red', 1], ['blue', 2], ['green', 3], ['white', 4]]);
    const rainbowId = g.hands[1][0].id;

    let next = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'red' } });
    expect(next.lastClue?.cardIds).toContain(rainbowId);
    expect(next.knowledge[rainbowId].cluedColors).toEqual(['red']);

    next = applyAction(next, 1, { type: 'clue', targetPlayer: 0, clue: { kind: 'number', number: next.hands[0][0].number } });
    next = applyAction(next, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'blue' } });
    expect(next.knowledge[rainbowId].cluedColors).toEqual(['red', 'blue']);
    expect(next.knowledge[rainbowId].notColors).toEqual([]);
  });

  it('rainbow matches number clues normally', () => {
    expect(clueMatches({ id: 0, color: 'rainbow', number: 3 }, { kind: 'number', number: 3 })).toBe(true);
    expect(clueMatches({ id: 0, color: 'rainbow', number: 3 }, { kind: 'number', number: 2 })).toBe(false);
  });
});

describe('play', () => {
  it('plays the next card onto its stack and draws a replacement', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 0, [['red', 1], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 5]]);
    const cardId = g.hands[0][0].id;
    const deckBefore = g.deck.length;
    const next = applyAction(g, 0, { type: 'play', cardId });
    expect(next.stacks.red).toBe(1);
    expect(next.errors).toBe(0);
    expect(next.hands[0]).toHaveLength(5);
    expect(next.deck).toHaveLength(deckBefore - 1);
    expect(getScore(next)).toBe(1);
  });

  it('misplay goes to discard and burns an error', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 0, [['red', 2], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 5]]);
    const cardId = g.hands[0][0].id;
    const next = applyAction(g, 0, { type: 'play', cardId });
    expect(next.stacks.red).toBe(0);
    expect(next.errors).toBe(1);
    expect(next.discard.map((c) => c.id)).toContain(cardId);
    expect(next.status).toBe('playing');
  });

  it('sudden death: errorsAllowed 0 means first misplay loses immediately', () => {
    let g = createGame(settings({ errorsAllowed: 0 }), 1);
    g = rig(g, 0, [['red', 2], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 5]]);
    const next = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id });
    expect(next.status).toBe('lost');
  });

  it('loses after errorsAllowed+1 misplays', () => {
    let g = createGame(settings({ errorsAllowed: 1 }), 1);
    g = { ...structuredClone(g), errors: 1 };
    g = rig(g, 0, [['red', 5], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 5]]);
    const next = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id });
    expect(next.errors).toBe(2);
    expect(next.status).toBe('lost');
  });

  it('completing a 5 restores a clue token (capped at max)', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 0, [['red', 5], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 4]]);
    g.stacks.red = 4;
    g.clues = 3;
    const next = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id });
    expect(next.stacks.red).toBe(5);
    expect(next.clues).toBe(4);

    // Capped at max
    let g2 = createGame(settings(), 2);
    g2 = rig(g2, 0, [['red', 5], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 4]]);
    g2.stacks.red = 4;
    expect(g2.clues).toBe(8);
    const next2 = applyAction(g2, 0, { type: 'play', cardId: g2.hands[0][0].id });
    expect(next2.clues).toBe(8);
  });

  it('winning: completing all stacks ends the game as won', () => {
    let g = createGame(settings({ suits: 4 }), 1);
    g = rig(g, 0, [['red', 5], ['blue', 3], ['green', 2], ['blue', 4], ['yellow', 4]]);
    g.stacks = { red: 4, yellow: 5, green: 5, blue: 5 };
    const next = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id });
    expect(next.status).toBe('won');
    expect(getScore(next)).toBe(maxScore(g.settings));
  });

  it('respects drawSide preference', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 0, [['red', 1], ['blue', 3], ['green', 2], ['white', 4], ['yellow', 5]]);
    const topOfDeck = g.deck[g.deck.length - 1].id;
    const left = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id, drawSide: 'left' });
    expect(left.hands[0][0].id).toBe(topOfDeck);
    const right = applyAction(g, 0, { type: 'play', cardId: g.hands[0][0].id, drawSide: 'right' });
    expect(right.hands[0][4].id).toBe(topOfDeck);
  });
});

describe('discard', () => {
  it('regains a clue token and draws', () => {
    let g = createGame(settings(), 1);
    g.clues = 4;
    const cardId = g.hands[0][0].id;
    const next = applyAction(g, 0, { type: 'discard', cardId });
    expect(next.clues).toBe(5);
    expect(next.discard.map((c) => c.id)).toContain(cardId);
    expect(next.hands[0]).toHaveLength(5);
  });

  it('cannot discard at max clues by default; house rule allows it', () => {
    const g = createGame(settings(), 1);
    expect(g.clues).toBe(8);
    expect(() => applyAction(g, 0, { type: 'discard', cardId: g.hands[0][0].id })).toThrow(/maximum/);

    const loose = createGame(settings({ allowDiscardAtMaxClues: true }), 1);
    const next = applyAction(loose, 0, { type: 'discard', cardId: loose.hands[0][0].id });
    expect(next.clues).toBe(8); // capped
  });
});

describe('turn order and validation', () => {
  it('rejects out-of-turn actions and replayed (duplicate) submissions', () => {
    const g = createGame(settings(), 1);
    expect(() => applyAction(g, 1, { type: 'discard', cardId: g.hands[1][0].id })).toThrow(/not your turn/);
    // A duplicate submission of the same action against the NEW state fails
    // because the played card id is no longer in hand / it's no longer p0's turn.
    const g2 = { ...structuredClone(g), clues: 4 };
    const cardId = g2.hands[0][0].id;
    const next = applyAction(g2, 0, { type: 'discard', cardId });
    expect(() => applyAction(next, 0, { type: 'discard', cardId })).toThrow(/not your turn/);
  });

  it('cycles turns through all players', () => {
    let g = createGame(settings({ playerCount: 3 }), 1);
    g.clues = 0; // make discards legal & meaningful
    g = applyAction(g, 0, { type: 'discard', cardId: g.hands[0][0].id });
    expect(g.currentPlayer).toBe(1);
    g = applyAction(g, 1, { type: 'discard', cardId: g.hands[1][0].id });
    expect(g.currentPlayer).toBe(2);
    g = applyAction(g, 2, { type: 'discard', cardId: g.hands[2][0].id });
    expect(g.currentPlayer).toBe(0);
  });

  it('rejects playing a card not in your hand', () => {
    const g = createGame(settings(), 1);
    expect(() => applyAction(g, 0, { type: 'play', cardId: 9999 })).toThrow(/not in your hand/);
  });
});

describe('endgame: empty deck final round', () => {
  it('each player gets exactly one turn after the last draw, then the game finishes', () => {
    let g = createGame(settings({ playerCount: 2 }), 1);
    g.deck = g.deck.slice(0, 1); // one card left
    g.clues = 0;
    g = applyAction(g, 0, { type: 'discard', cardId: g.hands[0][0].id }); // draws last card
    expect(g.deck).toHaveLength(0);
    expect(g.finalTurnsRemaining).toBe(2);
    expect(g.status).toBe('playing');
    g = applyAction(g, 1, { type: 'discard', cardId: g.hands[1][0].id }); // no draw possible
    expect(g.status).toBe('playing');
    expect(g.finalTurnsRemaining).toBe(1);
    g = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'number', number: g.hands[1][0].number } });
    expect(g.status).toBe('finished');
    expect(() => applyAction(g, 1, { type: 'discard', cardId: g.hands[1][0].id })).toThrow(/over/);
  });
});

describe('dead stacks', () => {
  it('marks a stack dead when all copies of the next needed card are discarded', () => {
    const g = createGame(settings(), 1);
    const allCards = [...g.deck, ...g.hands.flat()];
    const red2s = allCards.filter((c) => c.color === 'red' && c.number === 2);
    expect(red2s).toHaveLength(2);
    const state = { ...g, stacks: { ...g.stacks, red: 1 }, discard: red2s };
    expect(deadStacks(state)).toEqual(['red']);
    // Reachable score for red caps at 1; others can still hit 5.
    expect(maxReachableScore(state)).toBe(1 + 5 * 4);
  });

  it('single-copy 5s kill a stack when discarded', () => {
    const g = createGame(settings(), 1);
    const allCards = [...g.deck, ...g.hands.flat()];
    const blue5 = allCards.filter((c) => c.color === 'blue' && c.number === 5);
    const state = { ...g, stacks: { ...g.stacks, blue: 4 }, discard: blue5 };
    expect(deadStacks(state)).toEqual(['blue']);
  });
});

describe('hand reordering (free action)', () => {
  it('reorders without consuming a turn, even off-turn', () => {
    const g = createGame(settings(), 1);
    const ids = g.hands[1].map((c) => c.id);
    const reversed = [...ids].reverse();
    const next = reorderHand(g, 1, reversed);
    expect(next.hands[1].map((c) => c.id)).toEqual(reversed);
    expect(next.currentPlayer).toBe(g.currentPlayer);
    expect(next.turn).toBe(g.turn);
  });

  it('rejects orders that are not a permutation of the hand', () => {
    const g = createGame(settings(), 1);
    const ids = g.hands[0].map((c) => c.id);
    expect(() => reorderHand(g, 0, ids.slice(1))).toThrow(/permutation/);
    expect(() => reorderHand(g, 0, [ids[0], ids[0], ids[2], ids[3], ids[4]])).toThrow(/permutation/);
  });

  it('clue positions follow the reordered hand', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 1, [['red', 1], ['blue', 2], ['green', 3], ['white', 4], ['yellow', 5]]);
    const reversed = g.hands[1].map((c) => c.id).reverse();
    g = reorderHand(g, 1, reversed);
    const next = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'red' } });
    expect(next.lastClue?.positions).toEqual([4]); // red 1 is now rightmost
  });
});

describe('player views (hidden information)', () => {
  it("never includes the viewer's own card identities", () => {
    const g = createGame(settings({ playerCount: 3 }), 1);
    const view = getPlayerView(g, 0);
    const json = JSON.stringify(view.ownHand);
    expect(json).not.toMatch(/"color"/);
    expect(json).not.toMatch(/"number"/);
    expect(view.ownHand).toHaveLength(5);
    expect(view.ownHand[0].knowledge).toBeDefined();
    // Partners are face-up
    expect(view.partnerHands[1][0].color).toBeDefined();
    expect(view.partnerHands[2][0].number).toBeDefined();
    expect(view.partnerHands[0]).toBeUndefined();
  });

  it('reflects accumulated clue knowledge on own cards', () => {
    let g = createGame(settings(), 1);
    g = rig(g, 1, [['red', 1], ['blue', 2], ['green', 3], ['white', 4], ['yellow', 5]]);
    const next = applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'color', color: 'red' } });
    const view = getPlayerView(next, 1);
    expect(view.ownHand[0].knowledge.cluedColors).toEqual(['red']);
    expect(view.ownHand[1].knowledge.notColors).toEqual(['red']);
  });

  it('view mutations cannot corrupt the authoritative state', () => {
    const g = createGame(settings(), 1);
    const view = getPlayerView(g, 0);
    view.stacks.red = 5;
    view.discard.push({ id: -1, color: 'red', number: 1 });
    expect(g.stacks.red).toBe(0);
    expect(g.discard).toHaveLength(0);
  });
});

describe('immutability', () => {
  it('applyAction never mutates its input', () => {
    const g = createGame(settings(), 1);
    const frozen = JSON.stringify(g);
    applyAction(g, 0, { type: 'clue', targetPlayer: 1, clue: { kind: 'number', number: g.hands[1][0].number } });
    expect(JSON.stringify(g)).toBe(frozen);
  });
});

describe('score flavor text', () => {
  it('covers the standard tiers', () => {
    expect(scoreFlavor(25, 25)).toMatch(/Legendary/);
    expect(scoreFlavor(24, 25)).toMatch(/Extraordinary/);
    expect(scoreFlavor(21, 25)).toMatch(/Excellent/);
    expect(scoreFlavor(16, 25)).toMatch(/Very good/);
    expect(scoreFlavor(11, 25)).toMatch(/Honorable/);
    expect(scoreFlavor(6, 25)).toMatch(/modest/);
    expect(scoreFlavor(1, 25)).toMatch(/scattered sparks/);
    expect(scoreFlavor(0, 25)).toMatch(/never left the ground/);
  });
});
