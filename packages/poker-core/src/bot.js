// Enkel treningsbot. Brukes bare på treningsbord (aldri i ratet spill) og er alltid merket som bot.
// Strategi: estimert vinnersjanse (Monte Carlo) mot antall motstandere, sammenlignet med pot odds.

import { freshDeck } from './cards.js';
import { evaluate } from './evaluator.js';

/** Enkel deterministisk PRNG (mulberry32) slik at bot-tester kan gjentas. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Vinnersjanse 0..1 for hullkort + bord mot n tilfeldige motstandere. */
export function estimateEquity(hole, board, opponents, iterations = 300, rng = Math.random) {
  const known = new Set([...hole, ...board]);
  const rest = freshDeck().filter((c) => !known.has(c));
  let wins = 0;
  for (let it = 0; it < iterations; it++) {
    // Delvis Fisher-Yates: trekk bare kortene vi trenger.
    const need = opponents * 2 + (5 - board.length);
    const d = rest.slice();
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (d.length - i));
      [d[i], d[j]] = [d[j], d[i]];
    }
    let pos = 0;
    const fullBoard = [...board];
    while (fullBoard.length < 5) fullBoard.push(d[pos++]);
    const mine = evaluate([...hole, ...fullBoard]).score;
    let best = true;
    let tie = 0;
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluate([d[pos++], d[pos++], ...fullBoard]).score;
      if (theirs > mine) {
        best = false;
        break;
      }
      if (theirs === mine) tie++;
    }
    if (best) wins += tie ? 1 / (tie + 1) : 1;
  }
  return wins / iterations;
}

/**
 * Velger en handling for setet som står for tur.
 * @param {import('./hand.js').Hand} hand
 * @param {number} seat
 * @param {{style?:'tight'|'loose', rng?:() => number, iterations?:number}} [opts]
 */
export function botDecide(hand, seat, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const legal = hand.legalActions(seat);
  if (!legal) return null;
  const view = hand.viewFor(seat);
  const me = view.players.find((p) => p.seat === seat);
  const opponents = view.players.filter((p) => p.seat !== seat && !p.folded).length;
  const equity = estimateEquity(me.cards, view.board, Math.max(1, opponents), opts.iterations ?? 200, rng);
  const pot = view.pot;
  const potOdds = legal.toCall > 0 ? legal.toCall / (pot + legal.toCall) : 0;
  const loose = opts.style === 'loose' ? 0.05 : 0;
  const strong = 1 / (opponents + 1) + 0.25 - loose; // klart bedre enn snittet
  const noise = (rng() - 0.5) * 0.06;
  const e = equity + noise;

  if (legal.canRaise && e > strong) {
    // Høyn omtrent 2/3 pot, innenfor lovlige grenser.
    const target = view.currentBet + Math.round((pot * 2) / 3);
    const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
    return { type: to === legal.maxRaiseTo ? 'allin' : legal.raiseKind, amount: to };
  }
  if (legal.canCheck) return { type: 'check' };
  if (e >= potOdds - loose) return { type: 'call' };
  return { type: 'fold' };
}
