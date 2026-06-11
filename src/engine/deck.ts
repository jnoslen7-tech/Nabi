import { COPIES, type Card, type CardNumber, suitsFor } from './types';

/** Build an ordered (unshuffled) deck for the given suit count. */
export function createDeck(suits: 4 | 5 | 6): Card[] {
  const deck: Card[] = [];
  let id = 0;
  for (const color of suitsFor(suits)) {
    for (const number of [1, 2, 3, 4, 5] as CardNumber[]) {
      for (let copy = 0; copy < COPIES[number]; copy++) {
        deck.push({ id: id++, color, number });
      }
    }
  }
  return deck;
}

/** Deterministic RNG (mulberry32) so shuffles are reproducible in tests and rematches. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle; returns a new array. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
