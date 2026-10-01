// PokerKloss rating: OpenSkill (Plackett-Luce) på sluttplassering i turneringer.
//
// Bare plassering teller – aldri antall sjetonger. Da er det ingenting å tjene på å
// gi bort sjetonger, og poengene kan ikke brukes som valuta.

import { rating as osRating, rate as osRate, ordinal } from 'openskill';

export const DEFAULT_MU = 25;
export const DEFAULT_SIGMA = 25 / 3;

/** Ny spiller. */
export function newRating() {
  return osRating({ mu: DEFAULT_MU, sigma: DEFAULT_SIGMA });
}

/**
 * Vist rating (heltall). Ny spiller = 1000. Konservativ: mu − 3·sigma, skalert ×40.
 * Stiger etter hvert som systemet blir sikrere på ferdighetene.
 */
export function displayRating(r) {
  return Math.max(0, Math.round(1000 + ordinal(r) * 40));
}

/**
 * Oppdaterer rating etter én turnering.
 * @param {{id:string, rating?:{mu:number,sigma:number}, place:number}[]} entries
 * @returns {{id:string, place:number, before:object, after:object, displayBefore:number, displayAfter:number, delta:number}[]}
 */
export function rateTournament(entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('Minst to deltakere kreves for rating');
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw new Error('Samme spiller kan ikke være med to ganger');
  for (const e of entries) {
    if (!Number.isInteger(e.place) || e.place < 1) throw new Error(`Ugyldig plass for ${e.id}`);
  }
  const before = entries.map((e) => (e.rating ? osRating({ mu: e.rating.mu, sigma: e.rating.sigma }) : newRating()));
  const teams = before.map((r) => [r]);
  const after = osRate(teams, { rank: entries.map((e) => e.place) }).map((t) => t[0]);
  return entries.map((e, i) => {
    const db = displayRating(before[i]);
    const da = displayRating(after[i]);
    return {
      id: e.id,
      place: e.place,
      before: { mu: before[i].mu, sigma: before[i].sigma },
      after: { mu: after[i].mu, sigma: after[i].sigma },
      displayBefore: db,
      displayAfter: da,
      delta: da - db,
    };
  });
}

/**
 * Myk nullstilling ved ny sesong: ferdighet (mu) beholdes, usikkerhet (sigma) økes,
 * slik at ratingen raskt kan justeres igjen.
 */
export function seasonReset(r, sigmaBoost = 2) {
  return { mu: r.mu, sigma: Math.min(DEFAULT_SIGMA, r.sigma + sigmaBoost) };
}
