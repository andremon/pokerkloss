// Flerbordsturnering (MTT). Brukes for alle turneringsformater:
// heads-up og sit-and-go er bare en MTT med ett bord.
//
// Hvert bord spiller sine hender uavhengig av de andre. Når en hånd er ferdig ved et bord:
//   1. Spillere som gikk tom får plass (størst start-stack i hånden = best plass).
//   2. Bordene balanseres. Bare bord uten pågående hånd («ledige» bord) kan avgi spillere,
//      men spillere kan settes inn på ledige seter ved alle bord – de blir med fra neste hånd.
//      a) Er det flere bord enn nødvendig, brytes det ledige bordet med færrest spillere.
//      b) Har et ledig bord minst to spillere mer enn det minste bordet, flyttes spillere dit.
//   3. Når én spiller er igjen, er turneringen ferdig.

import { Hand, PokerError } from './hand.js';
import { STRUCTURES, levelIndexAt, levelIndexByHands } from './blinds.js';

export class MultiTableTournament {
  /**
   * @param {object} o
   * @param {{id:string,name?:string}[]} o.players  Rekkefølgen bestemmer seteplassering (serveren stokker).
   * @param {number} [o.maxSeats=9]
   * @param {object} [o.structure]
   * @param {number} [o.handsPerLevel]  Nivå per antall hender ved bordet i stedet for tid (test/trening).
   * @param {() => number} [o.now]
   * @param {() => string} [o.seedFn]
   * @param {string} [o.id]
   */
  constructor({ players, maxSeats = 9, structure = STRUCTURES.sng, handsPerLevel, now = () => Date.now(), seedFn, id }) {
    if (!Array.isArray(players) || players.length < 2) throw new PokerError('players', 'Minst to spillere');
    if (!(maxSeats >= 2 && maxSeats <= 10)) throw new PokerError('seats', 'Bordstørrelse må være 2–10');
    if (new Set(players.map((p) => p.id)).size !== players.length) {
      throw new PokerError('players', 'Samme spiller kan ikke være med to ganger');
    }
    this.id = id ?? 'mtt';
    this.maxSeats = maxSeats;
    this.structure = structure;
    this.handsPerLevel = handsPerLevel ?? null;
    this.now = now;
    this.seedFn = seedFn;
    this.startedAt = null;
    this.finished = false;
    this.placements = new Map(); // playerId -> plass
    this.players = new Map(); // playerId -> { id, name, stack, tableId, seat }
    this.tables = new Map(); // tableId -> { id, seats: (playerId|null)[], buttonSeat, hand, handsPlayed }
    this.totalHands = 0;

    const tableCount = Math.ceil(players.length / maxSeats);
    for (let t = 0; t < tableCount; t++) {
      const tid = `T${t + 1}`;
      this.tables.set(tid, { id: tid, seats: new Array(maxSeats).fill(null), buttonSeat: null, hand: null, handsPlayed: 0 });
    }
    // Fordel jevnt: spiller i går til bord i % antall, seter fylles fra 0.
    const tableIds = [...this.tables.keys()];
    players.forEach((p, i) => {
      const table = this.tables.get(tableIds[i % tableCount]);
      const seat = table.seats.indexOf(null);
      table.seats[seat] = p.id;
      this.players.set(p.id, { id: p.id, name: p.name ?? p.id, stack: structure.startingStack, tableId: table.id, seat });
    });
  }

  // ---------- oppslag ----------

  get aliveCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.stack > 0) n++;
    return n;
  }

  tableOf(playerId) {
    return this.players.get(playerId)?.tableId ?? null;
  }

  occupants(table) {
    return table.seats.filter((x) => x != null);
  }

  isIdle(table) {
    return !table.hand || table.hand.complete;
  }

  getTable(tableId) {
    const t = this.tables.get(tableId);
    if (!t) throw new PokerError('table', `Ukjent bord ${tableId}`);
    return t;
  }

  currentLevel(table) {
    let idx;
    if (this.handsPerLevel != null) {
      idx = levelIndexByHands(this.structure, table ? table.handsPlayed : 0, this.handsPerLevel);
    } else {
      idx = levelIndexAt(this.structure, this.startedAt == null ? 0 : this.now() - this.startedAt);
    }
    return { index: idx, ...this.structure.levels[idx] };
  }

  /** Bord som kan starte en ny hånd nå. */
  readyTables() {
    if (this.finished) return [];
    return [...this.tables.values()].filter((t) => this.isIdle(t) && this.occupants(t).length >= 2).map((t) => t.id);
  }

  // ---------- spill ----------

  nextButton(table) {
    const n = table.seats.length;
    const start = table.buttonSeat == null ? -1 : table.buttonSeat;
    for (let k = 1; k <= n; k++) {
      const s = (start + k + n) % n;
      if (table.seats[s] != null) return s;
    }
    throw new PokerError('state', 'Ingen spillere ved bordet');
  }

  /** Starter neste hånd ved et bord. Returnerer { hand, events } eller null hvis bordet må vente. */
  startNextHand(tableId) {
    if (this.finished) throw new PokerError('state', 'Turneringen er ferdig');
    const table = this.getTable(tableId);
    if (!this.isIdle(table)) throw new PokerError('state', 'Hånden ved bordet pågår fortsatt');
    if (this.occupants(table).length < 2) return null;
    if (this.startedAt == null) this.startedAt = this.now();
    const level = this.currentLevel(table);
    table.buttonSeat = this.nextButton(table);
    table.handsPlayed += 1;
    this.totalHands += 1;
    const players = [];
    table.seats.forEach((pid, seat) => {
      if (pid != null) players.push({ seat, id: pid, stack: this.players.get(pid).stack });
    });
    table.hand = new Hand({
      handId: `${this.id}-${table.id}-${table.handsPlayed}`,
      players,
      buttonSeat: table.buttonSeat,
      smallBlind: level.sb,
      bigBlind: level.bb,
      ante: level.ante,
      seed: this.seedFn?.(),
    });
    const events = table.hand.start();
    events.unshift({ type: 'level', ...level });
    const extra = table.hand.complete ? this.onHandComplete(table) : [];
    return { hand: table.hand, events, extra };
  }

  /**
   * Handling ved et bord. Returnerer { events, extra }:
   * events = hendelser for dette bordet, extra = turneringshendelser (utslag, flytting, slutt).
   */
  act(tableId, seat, action) {
    const table = this.getTable(tableId);
    if (!table.hand || table.hand.complete) throw new PokerError('state', 'Ingen hånd pågår ved bordet');
    const events = table.hand.act(seat, action);
    const extra = table.hand.complete ? this.onHandComplete(table) : [];
    return { events, extra };
  }

  onHandComplete(table) {
    const res = table.hand.result;
    const extra = [];
    for (const [seat, stack] of Object.entries(res.stacks)) {
      const pid = table.seats[seat];
      if (pid != null) this.players.get(pid).stack = stack;
    }
    // Utslåtte: fjernes fra bordet og får plass.
    const busted = table.seats
      .map((pid, seat) => ({ pid, seat }))
      .filter((x) => x.pid != null && this.players.get(x.pid).stack === 0)
      .sort((a, b) => res.startStacks[b.seat] - res.startStacks[a.seat]);
    let better = this.aliveCount;
    let i = 0;
    while (i < busted.length) {
      let j = i;
      while (j + 1 < busted.length && res.startStacks[busted[j + 1].seat] === res.startStacks[busted[i].seat]) j++;
      const place = better + 1;
      for (let k = i; k <= j; k++) {
        const b = busted[k];
        this.placements.set(b.pid, place);
        table.seats[b.seat] = null;
        const p = this.players.get(b.pid);
        p.tableId = null;
        p.seat = null;
        extra.push({ type: 'player.eliminated', tableId: table.id, seat: b.seat, id: b.pid, place });
      }
      better += j - i + 1;
      i = j + 1;
    }
    if (this.aliveCount === 1) {
      const winner = [...this.players.values()].find((p) => p.stack > 0);
      this.placements.set(winner.id, 1);
      this.finished = true;
      extra.push({ type: 'tournament.end', placings: this.results() });
      return extra;
    }
    extra.push(...this.balance());
    return extra;
  }

  // ---------- balansering ----------

  movePlayer(pid, toTable) {
    const p = this.players.get(pid);
    const from = this.tables.get(p.tableId);
    const seat = toTable.seats.indexOf(null);
    if (seat < 0) throw new PokerError('state', 'Ingen ledig plass');
    from.seats[p.seat] = null;
    toTable.seats[seat] = pid;
    const ev = { type: 'player.moved', id: pid, fromTable: from.id, fromSeat: p.seat, toTable: toTable.id, toSeat: seat };
    p.tableId = toTable.id;
    p.seat = seat;
    return ev;
  }

  balance() {
    const events = [];
    const needed = Math.ceil(this.aliveCount / this.maxSeats);

    // a) Bryt overflødige bord (ledig bord med færrest spillere).
    for (;;) {
      const tables = [...this.tables.values()];
      if (tables.length <= needed) break;
      const idle = tables.filter((t) => this.isIdle(t)).sort((a, b) => this.occupants(a).length - this.occupants(b).length);
      if (!idle.length) break;
      const victim = idle[0];
      const others = tables.filter((t) => t !== victim);
      for (const pid of this.occupants(victim)) {
        const target = others
          .filter((t) => t.seats.includes(null))
          .sort((a, b) => this.occupants(a).length - this.occupants(b).length)[0];
        if (!target) throw new PokerError('state', 'Fant ikke plass ved bordbrudd');
        events.push(this.movePlayer(pid, target));
      }
      this.tables.delete(victim.id);
      events.push({ type: 'table.broken', tableId: victim.id, remainingTables: this.tables.size });
    }

    // b) Jevn ut: flytt fra ledige bord som har minst to flere enn det minste bordet.
    for (let guard = 0; guard < 100; guard++) {
      const tables = [...this.tables.values()];
      if (tables.length < 2) break;
      const min = tables.reduce((a, b) => (this.occupants(a).length <= this.occupants(b).length ? a : b));
      const donor = tables
        .filter((t) => t !== min && this.isIdle(t) && this.occupants(t).length - this.occupants(min).length >= 2)
        .sort((a, b) => this.occupants(b).length - this.occupants(a).length)[0];
      if (!donor) break;
      // Flytt spilleren som sitter sist ved bordet (enkelt og forutsigbart).
      const seats = donor.seats.map((pid, s) => ({ pid, s })).filter((x) => x.pid != null);
      events.push(this.movePlayer(seats[seats.length - 1].pid, min));
    }
    return events;
  }

  // ---------- resultat og visning ----------

  results() {
    return [...this.players.values()]
      .filter((p) => this.placements.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, place: this.placements.get(p.id) }))
      .sort((a, b) => a.place - b.place);
  }

  overview() {
    const alive = [...this.players.values()].filter((p) => p.stack > 0);
    const total = alive.reduce((s, p) => s + p.stack, 0);
    return {
      id: this.id,
      entrants: this.players.size,
      remaining: alive.length,
      averageStack: alive.length ? Math.round(total / alive.length) : 0,
      tables: [...this.tables.values()].map((t) => ({ id: t.id, players: this.occupants(t).length })),
      finished: this.finished,
    };
  }

  /** Stacker ved et bord mellom hender (under en hånd: bruk hand.viewFor). */
  seatsOf(tableId) {
    const t = this.getTable(tableId);
    return t.seats.map((pid, seat) =>
      pid == null ? null : { seat, id: pid, name: this.players.get(pid).name, stack: this.players.get(pid).stack },
    );
  }
}
