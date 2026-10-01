// Kort representeres som to-tegns strenger: rang + farge, f.eks. "As", "Td", "7h".
// Rang: 2-9, T, J, Q, K, A. Farge: c (kløver), d (ruter), h (hjerter), s (spar).

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

/** Ny, sortert kortstokk med 52 kort. */
export function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Rangverdi 2..14 (ess = 14). */
export function rankValue(card) {
  const v = RANKS.indexOf(card[0]);
  if (v < 0) throw new Error(`Ugyldig kort: ${card}`);
  return v + 2;
}

export function suitOf(card) {
  if (!SUITS.includes(card[1])) throw new Error(`Ugyldig kort: ${card}`);
  return card[1];
}

export function isValidCard(card) {
  return typeof card === 'string' && card.length === 2 && RANKS.includes(card[0]) && SUITS.includes(card[1]);
}
