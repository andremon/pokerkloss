import { freshDeck } from '../src/cards.js';

/**
 * Lager en kortstokk som gir bestemte kort.
 * holes: hullkort i delerekkefølge (første spiller etter knappen først).
 * board: 5 kort (flop, turn, river).
 */
export function riggedDeck(holes, board = []) {
  const order = [];
  for (let r = 0; r < 2; r++) for (const h of holes) order.push(h[r]);
  const b = [...board];
  const burns = [];
  const used = new Set([...order, ...b]);
  const spare = freshDeck().filter((c) => !used.has(c));
  const nextSpare = () => spare.shift();
  order.push(nextSpare(), b[0] ?? nextSpare(), b[1] ?? nextSpare(), b[2] ?? nextSpare());
  order.push(nextSpare(), b[3] ?? nextSpare());
  order.push(nextSpare(), b[4] ?? nextSpare());
  burns.push(...spare);
  return [...order, ...burns];
}

export const SEED = 'a'.repeat(64);

/** Totalt antall sjetonger i hånden (stack + innsats). */
export function chipTotal(hand) {
  // Etter at hånden er ferdig er potten utbetalt til stackene.
  return hand.players.reduce((s, p) => s + p.stack + (hand.complete ? 0 : p.committed), 0);
}
