// Pot-beregning: hovedpot og side-poter ut fra hva hver spiller har satset i hånden.
//
// players: [{ seat, committed, folded }]
// Returnerer [{ amount, eligible: [seat, ...] }] fra hovedpot til siste side-pot.
// Sjetonger fra spillere som har foldet teller i potene, men de kan ikke vinne.

export function buildPots(players) {
  const levels = [...new Set(players.filter((p) => p.committed > 0).map((p) => p.committed))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) {
      amount += Math.max(0, Math.min(p.committed, level) - prev);
    }
    const eligible = players.filter((p) => !p.folded && p.committed >= level).map((p) => p.seat);
    prev = level;
    if (amount === 0) continue;
    const last = pots[pots.length - 1];
    if (eligible.length === 0) {
      // Kun foldede spillere nådde dette nivået – legges til forrige pot.
      if (last) last.amount += amount;
      else pots.push({ amount, eligible: [] });
      continue;
    }
    if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  return pots;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Fordeler poter.
 * scores: Map<seat, number> (høyere er bedre) for spillere som er med til showdown.
 * seatOrderFromButton: seter i rekkefølge fra første etter knappen – brukes for rest-sjetonger.
 * Returnerer { payouts: Map<seat, amount>, results: [{ amount, eligible, winners, share }] }
 */
export function awardPots(pots, scores, seatOrderFromButton) {
  const payouts = new Map();
  const results = [];
  for (const pot of pots) {
    const contenders = pot.eligible.filter((s) => scores.has(s));
    if (contenders.length === 0) {
      results.push({ ...pot, winners: [], share: 0 });
      continue;
    }
    const best = Math.max(...contenders.map((s) => scores.get(s)));
    const winners = contenders.filter((s) => scores.get(s) === best);
    const ordered = seatOrderFromButton.filter((s) => winners.includes(s));
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const s of ordered) {
      let won = share;
      if (remainder > 0) {
        won += 1;
        remainder -= 1;
      }
      payouts.set(s, (payouts.get(s) || 0) + won);
    }
    results.push({ ...pot, winners: ordered, share });
  }
  return { payouts, results };
}
