// TournamentRunner: kjører én turnering i sanntid – ett eller flere bord.
// Heads-up, sit-and-go, treningsbord og planlagte klubbturneringer går alle gjennom denne.
// Spillelogikk og bordbalansering ligger i @arena/poker-core (MultiTableTournament).

import { EventEmitter } from 'node:events';
import { MultiTableTournament, STRUCTURES, eventsFor, botDecide, PokerError } from '@arena/poker-core';
import { rateTournament } from '@arena/poker-rating';

export class TournamentRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.format   hu | sng6 | sng9 | training | scheduled
   * @param {boolean} o.rated
   * @param {{userId:string,name:string,bot?:boolean}[]} o.players  Rekkefølgen gir seteplassering.
   * @param {object} o.store
   * @param {object} o.timing
   * @param {object} [o.structure]
   * @param {number} [o.maxSeats=9]
   * @param {number} [o.handsPerLevel]
   * @param {number|null} [o.seasonId]
   * @param {string|null} [o.leagueId]
   * @param {string} [o.name]
   */
  constructor({ id, format, rated, players, store, timing, structure = STRUCTURES.sng, maxSeats = 9, handsPerLevel, seasonId = null, leagueId = null, name, now }) {
    super();
    if (rated && players.some((p) => p.bot)) throw new Error('Bots kan ikke delta i ratet spill');
    this.id = id;
    this.name = name ?? id;
    this.format = format;
    this.rated = rated;
    this.store = store;
    this.timing = timing;
    this.structure = structure;
    this.seasonId = seasonId;
    this.leagueId = leagueId;
    this.meta = new Map(
      players.map((p) => [p.userId, { userId: p.userId, name: p.name, bot: !!p.bot, sittingOut: false, connected: !!p.bot, timebankMs: timing.timebankMs }]),
    );
    this.mtt = new MultiTableTournament({
      id,
      players: players.map((p) => ({ id: p.userId, name: p.name })),
      maxSeats,
      structure,
      handsPerLevel,
      now,
    });
    this.subs = new Map(); // userId -> Set<send>
    this.turnTimers = new Map(); // tableId -> timeout
    this.startTimers = new Map(); // tableId -> timeout (pause mellom hender)
    this.turnStartedAt = new Map(); // tableId -> ms
    this.status = 'waiting';
    this.finalResults = null;
    this.pending = Promise.resolve();
  }

  // ---------- tilkoblinger ----------

  hasPlayer(userId) {
    return this.meta.has(userId);
  }

  subscribe(userId, send) {
    if (!this.hasPlayer(userId)) throw new PokerError('seat', 'Du er ikke med i denne turneringen');
    if (!this.subs.has(userId)) this.subs.set(userId, new Set());
    this.subs.get(userId).add(send);
    this.meta.get(userId).connected = true;
    send({ type: 'table.state', tournamentId: this.id, state: this.stateFor(userId) });
  }

  unsubscribe(userId, send) {
    const set = this.subs.get(userId);
    if (!set) return;
    set.delete(send);
    if (set.size) return;
    this.subs.delete(userId);
    this.meta.get(userId).connected = false;
    const tid = this.mtt.tableOf(userId);
    const table = tid && this.mtt.tables.get(tid);
    if (table?.hand && !table.hand.complete && table.hand.toActSeat === this.mtt.players.get(userId).seat) this.scheduleTurn(tid);
  }

  send(userId, msg) {
    for (const s of this.subs.get(userId) ?? []) {
      try {
        s(msg);
      } catch {
        /* død tilkobling */
      }
    }
  }

  sendAll(msg) {
    for (const uid of this.subs.keys()) this.send(uid, msg);
  }

  /** Mottakere av hendelser ved et bord: alle i hånden + alle som sitter der nå. */
  recipients(tableId) {
    const out = new Map(); // userId -> seat
    const table = this.mtt.tables.get(tableId);
    if (!table) return out;
    for (const hp of table.hand?.players ?? []) out.set(hp.id, hp.seat);
    table.seats.forEach((pid, seat) => {
      if (pid != null && !out.has(pid)) out.set(pid, seat);
    });
    return out;
  }

  broadcastTable(tableId, events, recipients) {
    if (!events.length) return;
    for (const [uid, seat] of recipients) {
      if (this.meta.get(uid)?.bot) continue;
      const mine = eventsFor(events, seat);
      if (mine.length) this.send(uid, { type: 'events', tournamentId: this.id, tableId, events: mine });
    }
    this.emit('events', tableId, events);
  }

  // ---------- flyt ----------

  async start() {
    this.status = 'running';
    await this.store
      .createTournament({ id: this.id, format: this.format, rated: this.rated, seasonId: this.seasonId, leagueId: this.leagueId, structure: this.structure })
      .catch((e) => this.emit('error', e));
    for (const tid of this.mtt.readyTables()) this.startHand(tid);
  }

  scheduleReadyTables() {
    for (const tid of this.mtt.readyTables()) {
      if (this.startTimers.has(tid)) continue;
      this.startTimers.set(
        tid,
        setTimeout(() => {
          this.startTimers.delete(tid);
          this.startHand(tid);
        }, this.timing.nextHandDelayMs),
      );
    }
  }

  startHand(tableId) {
    if (this.status !== 'running' || !this.mtt.tables.has(tableId)) return;
    const table = this.mtt.tables.get(tableId);
    if (!this.mtt.isIdle(table)) return;
    const r = this.mtt.startNextHand(tableId);
    if (!r) return; // venter på flere spillere ved bordet
    this.decorate(r.events);
    this.broadcastTable(tableId, r.events, this.recipients(tableId));
    this.handleExtra(r.extra);
    // Hånden kan bli ferdig allerede ved start (alle all-in på blinds), og bordet kan da være brutt.
    if (r.hand.complete) this.onHandComplete(tableId, r.hand);
    else this.scheduleTurn(tableId);
  }

  decorate(events) {
    for (const e of events) {
      if (e.type === 'hand.start') {
        for (const s of e.seats) {
          const m = this.meta.get(s.id);
          s.name = m.name;
          s.bot = m.bot;
        }
      }
    }
  }

  handleExtra(extra) {
    let changed = false;
    for (const e of extra) {
      if (e.type === 'player.eliminated') {
        changed = true;
        this.send(e.id, { type: 'eliminated', tournamentId: this.id, place: e.place });
        this.emit('eliminated', e.id, e.place);
      } else if (e.type === 'player.moved') {
        changed = true;
        this.send(e.id, { type: 'table.moved', tournamentId: this.id, fromTable: e.fromTable, toTable: e.toTable });
        this.send(e.id, { type: 'table.state', tournamentId: this.id, state: this.stateFor(e.id) });
      } else if (e.type === 'table.broken') {
        changed = true;
        this.clearTable(e.tableId);
      }
    }
    if (changed && !this.mtt.finished) this.sendAll({ type: 'tournament.update', tournamentId: this.id, overview: this.mtt.overview() });
  }

  clearTable(tableId) {
    clearTimeout(this.turnTimers.get(tableId));
    this.turnTimers.delete(tableId);
    clearTimeout(this.startTimers.get(tableId));
    this.startTimers.delete(tableId);
  }

  scheduleTurn(tableId) {
    clearTimeout(this.turnTimers.get(tableId));
    this.turnTimers.delete(tableId);
    const table = this.mtt.tables.get(tableId);
    const hand = table?.hand;
    if (!hand || hand.complete || this.status !== 'running') return;
    const seat = hand.toActSeat;
    const uid = table.seats[seat] ?? hand.players.find((p) => p.seat === seat).id;
    const m = this.meta.get(uid);
    this.turnStartedAt.set(tableId, Date.now());
    const set = (fn, ms) => this.turnTimers.set(tableId, setTimeout(fn, ms));
    if (m.bot) return set(() => this.botAct(tableId, seat), this.timing.botDelayMs);
    if (m.sittingOut || !m.connected) return set(() => this.applyAction(tableId, seat, { type: 'timeout' }, true), this.timing.sitOutActMs);
    const total = this.timing.turnMs + m.timebankMs;
    this.send(uid, { type: 'turn.deadline', tournamentId: this.id, tableId, seat, deadline: Date.now() + total, timebankMs: m.timebankMs });
    set(() => {
      m.sittingOut = true;
      m.timebankMs = 0;
      this.send(uid, { type: 'sitout', tournamentId: this.id, reason: 'timeout' });
      this.applyAction(tableId, seat, { type: 'timeout' }, true);
    }, total);
  }

  botAct(tableId, seat) {
    const hand = this.mtt.tables.get(tableId)?.hand;
    if (!hand || hand.complete || hand.toActSeat !== seat) return;
    this.applyAction(tableId, seat, botDecide(hand, seat, { iterations: 150 }) ?? { type: 'fold' }, true);
  }

  handleAction(userId, action) {
    const p = this.mtt.players.get(userId);
    if (!p) throw new PokerError('seat', 'Du er ikke med i denne turneringen');
    if (p.tableId == null) throw new PokerError('state', 'Du er ute av turneringen');
    const hand = this.mtt.tables.get(p.tableId).hand;
    if (!hand || hand.complete) throw new PokerError('state', 'Ingen hånd pågår');
    if (hand.toActSeat !== p.seat) throw new PokerError('turn', 'Det er ikke din tur');
    if (action?.type === 'timeout') throw new PokerError('action', 'Ugyldig handling');
    const m = this.meta.get(userId);
    const used = Date.now() - (this.turnStartedAt.get(p.tableId) ?? Date.now()) - this.timing.turnMs;
    if (used > 0) m.timebankMs = Math.max(0, m.timebankMs - used);
    this.applyAction(p.tableId, p.seat, action, false);
  }

  applyAction(tableId, seat, action, auto) {
    const table = this.mtt.tables.get(tableId);
    const hand = table?.hand;
    if (!hand || hand.complete || hand.toActSeat !== seat) return;
    const recipients = this.recipients(tableId);
    let result;
    try {
      result = this.mtt.act(tableId, seat, action);
    } catch (e) {
      if (!auto) throw e; // klienten får feilmelding; eksisterende frist gjelder fortsatt
      result = this.mtt.act(tableId, seat, { type: 'timeout' });
    }
    clearTimeout(this.turnTimers.get(tableId));
    this.turnTimers.delete(tableId);
    this.broadcastTable(tableId, result.events, recipients);
    const handRef = hand;
    this.handleExtra(result.extra);
    if (handRef.complete) this.onHandComplete(tableId, handRef);
    else this.scheduleTurn(tableId);
  }

  onHandComplete(tableId, hand) {
    const record = {
      id: hand.handId,
      tournamentId: this.id,
      seedHash: hand.seedHash,
      seed: hand.seed,
      buttonSeat: hand.players[hand.buttonIndex].seat,
      board: [...hand.board],
      players: hand.players.map((p) => ({ seat: p.seat, userId: p.id, startStack: p.startStack, holeCards: [...p.holeCards] })),
      result: hand.result,
      actions: hand.actions,
    };
    this.pending = this.pending.then(() => this.store.saveHand(record)).catch((e) => this.emit('error', e));
    if (this.mtt.finished) {
      this.finish();
      return;
    }
    this.scheduleReadyTables();
  }

  setSittingOut(userId, value) {
    const m = this.meta.get(userId);
    if (!m) throw new PokerError('seat', 'Du er ikke med i denne turneringen');
    m.sittingOut = value;
    if (!value) m.timebankMs = Math.max(m.timebankMs, Math.floor(this.timing.timebankMs / 3));
    const p = this.mtt.players.get(userId);
    const hand = p.tableId && this.mtt.tables.get(p.tableId)?.hand;
    if (hand && !hand.complete && hand.toActSeat === p.seat) this.scheduleTurn(p.tableId);
  }

  async finish() {
    if (this.status === 'finished') return;
    this.status = 'finished';
    for (const tid of [...this.turnTimers.keys(), ...this.startTimers.keys()]) this.clearTable(tid);
    const placings = this.mtt.results();
    let rated = null;
    if (this.rated) {
      const current = await this.store.getRatings(placings.map((p) => p.id), this.seasonId).catch(() => new Map());
      rated = rateTournament(placings.map((p) => ({ id: p.id, place: p.place, rating: current.get(p.id) ?? undefined })));
    }
    const byId = new Map((rated ?? []).map((r) => [r.id, r]));
    const results = placings.map((p) => ({ userId: p.id, placement: p.place, rating: byId.get(p.id) ?? null }));
    this.finalResults = results.map((r) => ({
      userId: r.userId,
      name: this.meta.get(r.userId)?.name,
      place: r.placement,
      ratingBefore: r.rating?.displayBefore ?? null,
      ratingAfter: r.rating?.displayAfter ?? null,
      delta: r.rating?.delta ?? null,
    }));
    await this.pending;
    await this.store.finishTournament({ id: this.id, seasonId: this.seasonId, results }).catch((e) => this.emit('error', e));
    const msg = { type: 'events', tournamentId: this.id, tableId: null, events: [{ type: 'tournament.result', rated: this.rated, placings: this.finalResults }] };
    this.sendAll(msg);
    this.emit('finished', this.finalResults);
  }

  stop() {
    for (const tid of [...this.turnTimers.keys(), ...this.startTimers.keys()]) this.clearTable(tid);
    this.status = 'stopped';
  }

  // ---------- visning ----------

  stateFor(userId) {
    const p = this.mtt.players.get(userId);
    const tableId = p?.tableId ?? null;
    const table = tableId ? this.mtt.tables.get(tableId) : null;
    const handSeat = table?.hand?.players.some((hp) => hp.id === userId) ? p.seat : null;
    return {
      tournamentId: this.id,
      name: this.name,
      format: this.format,
      rated: this.rated,
      status: this.status,
      tableId,
      level: this.mtt.startedAt != null ? this.mtt.currentLevel(table) : null,
      mySeat: p?.seat ?? null,
      myPlace: this.mtt.placements.get(userId) ?? null,
      seats: table
        ? this.mtt.seatsOf(tableId).map((s) =>
            s == null ? null : { ...s, userId: s.id, bot: this.meta.get(s.id).bot, sittingOut: this.meta.get(s.id).sittingOut, connected: this.meta.get(s.id).connected },
          )
        : [],
      hand: table?.hand ? table.hand.viewFor(handSeat) : null,
      overview: this.mtt.overview(),
      results: this.finalResults,
    };
  }

  summary() {
    const o = this.mtt.overview();
    return {
      id: this.id,
      name: this.name,
      format: this.format,
      rated: this.rated,
      status: this.status,
      leagueId: this.leagueId,
      entrants: o.entrants,
      remaining: o.remaining,
      tables: o.tables.length,
      players: [...this.meta.values()].map((m) => ({ name: m.name, bot: m.bot })),
      level: this.mtt.startedAt != null ? this.mtt.currentLevel(null) : null,
      handsPlayed: this.mtt.totalHands,
    };
  }
}
