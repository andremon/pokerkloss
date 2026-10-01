// Turnering ved ett bord (heads-up eller sit-and-go, 2–9 spillere).
//
// Alle starter med like mange sjetonger. Sjetongene lever bare i denne turneringen.
// Resultatet er en plasseringsliste som ratingmodulen bruker – ingenting annet følger med ut.

import { Hand, PokerError } from './hand.js';
import { STRUCTURES, levelIndexAt, levelIndexByHands } from './blinds.js';

export const MAX_SEATS = 9;

export class Tournament {
  /**
   * @param {object} opts
   * @param {{id:string,name?:string}[]} opts.players  I seterekkefølge (serveren bør stokke rekkefølgen).
   * @param {object} [opts.structure]   Blindstruktur, standard STRUCTURES.sng
   * @param {number} [opts.handsPerLevel]  Hvis satt: nivå øker per antall hender i stedet for tid.
   * @param {() => number} [opts.now]
   * @param {() => string} [opts.seedFn]  For tester; ellers lager Hand egen seed.
   * @param {string} [opts.id]
   */
  constructor({ players, structure = STRUCTURES.sng, handsPerLevel, now = () => Date.now(), seedFn, id }) {
    if (!Array.isArray(players) || players.length < 2) throw new PokerError('players', 'Minst to spillere');
    if (players.length > MAX_SEATS) throw new PokerError('players', `Maks ${MAX_SEATS} spillere ved ett bord`);
    const ids = new Set(players.map((p) => p.id));
    if (ids.size !== players.length) throw new PokerError('players', 'Samme spiller kan ikke sitte to ganger');
    this.id = id ?? null;
    this.structure = structure;
    this.handsPerLevel = handsPerLevel ?? null;
    this.now = now;
    this.seedFn = seedFn;
    this.seats = players.map((p, i) => ({ seat: i, id: p.id, name: p.name ?? p.id, stack: structure.startingStack }));
    this.startedAt = null;
    this.handsPlayed = 0;
    this.buttonSeat = null;
    this.hand = null;
    this.placements = new Map(); // id -> plass (1 = vinner)
    this.finished = false;
  }

  get alive() {
    return this.seats.filter((s) => s.stack > 0);
  }

  currentLevel() {
    const elapsed = this.startedAt == null ? 0 : this.now() - this.startedAt;
    const idx =
      this.handsPerLevel != null
        ? levelIndexByHands(this.structure, this.handsPlayed, this.handsPerLevel)
        : levelIndexAt(this.structure, elapsed);
    return { index: idx, ...this.structure.levels[idx] };
  }

  nextButton() {
    const alive = this.alive;
    if (this.buttonSeat == null) return alive[0].seat;
    // Flyttende knapp: neste sete med sjetonger etter forrige knapp.
    for (let k = 1; k <= this.seats.length; k++) {
      const s = this.seats[(this.buttonSeat + k) % this.seats.length];
      if (s.stack > 0) return s.seat;
    }
    return alive[0].seat;
  }

  /** Starter neste hånd. Returnerer { hand, events }. */
  startNextHand() {
    if (this.finished) throw new PokerError('state', 'Turneringen er ferdig');
    if (this.hand && !this.hand.complete) throw new PokerError('state', 'Forrige hånd pågår fortsatt');
    if (this.startedAt == null) this.startedAt = this.now();
    const level = this.currentLevel();
    this.buttonSeat = this.nextButton();
    this.handsPlayed += 1;
    this.hand = new Hand({
      handId: `${this.id ?? 't'}-${this.handsPlayed}`,
      players: this.alive.map((s) => ({ seat: s.seat, id: s.id, stack: s.stack })),
      buttonSeat: this.buttonSeat,
      smallBlind: level.sb,
      bigBlind: level.bb,
      ante: level.ante,
      seed: this.seedFn?.(),
    });
    const events = this.hand.start();
    events.unshift({ type: 'level', ...level });
    if (this.hand.complete) events.push(...this.onHandComplete());
    return { hand: this.hand, events };
  }

  /** Utfører en handling i gjeldende hånd, og oppdaterer turneringen når hånden er ferdig. */
  act(seat, action) {
    if (!this.hand || this.hand.complete) throw new PokerError('state', 'Ingen hånd pågår');
    const events = this.hand.act(seat, action);
    if (this.hand.complete) events.push(...this.onHandComplete());
    return events;
  }

  onHandComplete() {
    const res = this.hand.result;
    const events = [];
    for (const s of this.seats) {
      if (res.stacks[s.seat] != null) s.stack = res.stacks[s.seat];
    }
    // Spillere som gikk tom i denne hånden. Den med størst stack ved starten av hånden får best plass.
    const busted = this.seats
      .filter((s) => s.stack === 0 && res.startStacks[s.seat] != null && !this.placements.has(s.id))
      .sort((a, b) => res.startStacks[b.seat] - res.startStacks[a.seat]);
    // De som ryker nå tar plassene rett bak de som fortsatt er med.
    let better = this.alive.length;
    let i = 0;
    while (i < busted.length) {
      // Like start-stacker deler plass.
      let j = i;
      while (j + 1 < busted.length && res.startStacks[busted[j + 1].seat] === res.startStacks[busted[i].seat]) j++;
      const place = better + 1;
      for (let k = i; k <= j; k++) {
        this.placements.set(busted[k].id, place);
        events.push({ type: 'player.eliminated', seat: busted[k].seat, id: busted[k].id, place });
      }
      better += j - i + 1;
      i = j + 1;
    }
    if (this.alive.length === 1) {
      const winner = this.alive[0];
      this.placements.set(winner.id, 1);
      this.finished = true;
      events.push({ type: 'tournament.end', placings: this.results() });
    }
    return events;
  }

  /** Plasseringsliste, beste først: [{ id, name, place }]. */
  results() {
    return this.seats
      .filter((s) => this.placements.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, place: this.placements.get(s.id) }))
      .sort((a, b) => a.place - b.place);
  }
}
