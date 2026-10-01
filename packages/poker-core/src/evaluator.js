// Hånd-evaluator: beste 5 av 5–7 kort.
// Returnerer en numerisk score der høyere alltid slår lavere, pluss kategori og de fem kortene.

import { rankValue, suitOf } from './cards.js';

export const CATEGORY = Object.freeze({
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
});

export const CATEGORY_NAME_NO = [
  'Høyt kort',
  'Ett par',
  'To par',
  'Tre like',
  'Straight',
  'Flush',
  'Hus',
  'Fire like',
  'Straight flush',
];

function pack(category, kickers) {
  // category * 16^5 + k0*16^4 + ... + k4
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (kickers[i] ?? 0);
  return score;
}

/** Vurderer nøyaktig fem kort. */
export function score5(cards) {
  if (cards.length !== 5) throw new Error('score5 krever nøyaktig 5 kort');
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const flush = suits.every((s) => s === suits[0]);

  // Straight (inkl. hjul A-2-3-4-5)
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  if (flush && straightHigh) return pack(CATEGORY.STRAIGHT_FLUSH, [straightHigh]);

  // Grupper etter antall, deretter rang
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const order = groups.map((g) => g[0]);

  if (shape === '41') return pack(CATEGORY.QUADS, order);
  if (shape === '32') return pack(CATEGORY.FULL_HOUSE, order);
  if (flush) return pack(CATEGORY.FLUSH, ranks);
  if (straightHigh) return pack(CATEGORY.STRAIGHT, [straightHigh]);
  if (shape === '311') return pack(CATEGORY.TRIPS, order);
  if (shape === '221') return pack(CATEGORY.TWO_PAIR, order);
  if (shape === '2111') return pack(CATEGORY.PAIR, order);
  return pack(CATEGORY.HIGH_CARD, ranks);
}

export function categoryOf(score) {
  return Math.floor(score / 16 ** 5);
}

/** Beste hånd av 5–7 kort. */
export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error('evaluate krever 5–7 kort');
  let best = -1;
  let bestCards = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(five);
            if (s > best) {
              best = s;
              bestCards = five;
            }
          }
  const category = categoryOf(best);
  return { score: best, category, name: CATEGORY_NAME_NO[category], cards: bestCards };
}
