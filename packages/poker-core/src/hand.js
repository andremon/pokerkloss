// Tilstandsmaskin for én hånd Texas Hold'em (no-limit).
//
// Hand er ren logikk: ingen nettverk, ingen klokke, ingen database.
// Serveren kaller start() og act(), sender ut hendelsene som returneres,
// og bruker viewFor(seat) for å bygge det hver enkelt klient får se.

import { shuffleDeck, hashSeed, newSeed } from './shuffle.js';
import { evaluate } from './evaluator.js';
import { buildPots, awardPots } from './pots.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

export class PokerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Hand {
  /**
   * @param {object} opts
   * @param {{seat:number,id:string,stack:number}[]} opts.players  Spillere med sjetonger, i bordrekkefølge.
   * @param {number} opts.buttonSeat
   * @param {number} opts.smallBlind
   * @param {number} opts.bigBlind
   * @param {number} [opts.ante=0]
   * @param {string} [opts.seed]    Hemmelig seed; lages automatisk hvis den mangler.
   * @param {string} [opts.handId]
   */
  constructor({ players, buttonSeat, smallBlind, bigBlind, ante = 0, seed, handId }) {
    if (!Array.isArray(players) || players.length < 2) throw new PokerError('players', 'Minst to spillere kreves');
    if (!(bigBlind > 0) || !(smallBlind > 0) || smallBlind > bigBlind) throw new PokerError('blinds', 'Ugyldige blinds');
    const seats = new Set();
    for (const p of players) {
      if (!(p.stack > 0)) throw new PokerError('stack', `Sete ${p.seat} har ingen sjetonger`);
      if (seats.has(p.seat)) throw new PokerError('seat', `Sete ${p.seat} er brukt to ganger`);
      seats.add(p.seat);
    }
    this.handId = handId ?? null;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.ante = ante;
    this.seed = seed ?? newSeed();
    this.seedHash = hashSeed(this.seed);
    this.players = players.map((p) => ({
      seat: p.seat,
      id: p.id,
      startStack: p.stack,
      stack: p.stack,
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      holeCards: [],
    }));
    this.buttonIndex = this.players.findIndex((p) => p.seat === buttonSeat);
    if (this.buttonIndex < 0) throw new PokerError('button', 'Knappen må stå på en spiller i hånden');
    // opts.deck er kun for tester (forhåndsbestemt kortrekkefølge). Serveren skal aldri sette den.
    this.deck = arguments[0].deck ? [...arguments[0].deck] : shuffleDeck(this.seed);
    this.deckPos = 0;
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.toActIndex = -1;
    this.complete = false;
    this.result = null;
    this.actions = []; // håndhistorikk
    this.started = false;
  }

  // ---------- hjelpere ----------

  get n() {
    return this.players.length;
  }

  next(i) {
    return (i + 1) % this.n;
  }

  playerBySeat(seat) {
    const p = this.players.find((x) => x.seat === seat);
    if (!p) throw new PokerError('seat', `Sete ${seat} er ikke med i hånden`);
    return p;
  }

  get sbIndex() {
    return this.n === 2 ? this.buttonIndex : this.next(this.buttonIndex);
  }

  get bbIndex() {
    return this.next(this.sbIndex);
  }

  /** Seter fra første etter knappen – brukes for rest-sjetonger og visningsrekkefølge. */
  seatOrderFromButton() {
    const order = [];
    let i = this.next(this.buttonIndex);
    for (let k = 0; k < this.n; k++) {
      order.push(this.players[i].seat);
      i = this.next(i);
    }
    return order;
  }

  livePlayers() {
    return this.players.filter((p) => !p.folded);
  }

  canActPlayers() {
    return this.players.filter((p) => !p.folded && !p.allIn);
  }

  needsAction(p) {
    if (p.folded || p.allIn) return false;
    if (p.bet < this.currentBet) return true;
    if (p.hasActed) return false;
    // Ingen andre kan svare → ingen grunn til å handle (f.eks. alle andre er all-in).
    return this.players.some((o) => o !== p && !o.folded && !o.allIn);
  }

  draw() {
    return this.deck[this.deckPos++];
  }

  put(p, amount) {
    const a = Math.min(amount, p.stack);
    p.stack -= a;
    p.bet += a;
    p.committed += a;
    if (p.stack === 0) p.allIn = true;
    return a;
  }

  // ---------- start ----------

  start() {
    if (this.started) throw new PokerError('state', 'Hånden er allerede startet');
    this.started = true;
    const events = [];
    events.push({
      type: 'hand.start',
      handId: this.handId,
      seedHash: this.seedHash,
      buttonSeat: this.players[this.buttonIndex].seat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      ante: this.ante,
      seats: this.players.map((p) => ({ seat: p.seat, id: p.id, stack: p.stack })),
    });

    // Ante er død innsats: teller i potten, men ikke mot currentBet.
    if (this.ante > 0) {
      for (const p of this.players) {
        const a = Math.min(this.ante, p.stack);
        p.stack -= a;
        p.committed += a;
        if (p.stack === 0) p.allIn = true;
        this.actions.push({ street: 'preflop', seat: p.seat, type: 'ante', amount: a });
        events.push({ type: 'post', seat: p.seat, kind: 'ante', amount: a });
      }
    }

    const sb = this.players[this.sbIndex];
    const bb = this.players[this.bbIndex];
    const sbAmt = sb.allIn ? 0 : this.put(sb, this.smallBlind);
    const bbAmt = bb.allIn ? 0 : this.put(bb, this.bigBlind);
    this.actions.push({ street: 'preflop', seat: sb.seat, type: 'sb', amount: sbAmt });
    this.actions.push({ street: 'preflop', seat: bb.seat, type: 'bb', amount: bbAmt });
    events.push({ type: 'post', seat: sb.seat, kind: 'sb', amount: sbAmt });
    events.push({ type: 'post', seat: bb.seat, kind: 'bb', amount: bbAmt });
    // Innsatsen å møte er alltid minst big blind, selv om BB er short.
    this.currentBet = Math.max(this.bigBlind, ...this.players.map((p) => p.bet));
    this.minRaise = this.bigBlind;

    // Del to kort, ett om gangen, fra første etter knappen.
    let i = this.next(this.buttonIndex);
    for (let round = 0; round < 2; round++) {
      for (let k = 0; k < this.n; k++) {
        this.players[i].holeCards.push(this.draw());
        i = this.next(i);
      }
    }
    for (const p of this.players) {
      events.push({ type: 'cards.private', seat: p.seat, cards: [...p.holeCards], private: true });
    }

    // Preflop starter spilleren etter BB.
    this.toActIndex = this.bbIndex;
    this.advance(events);
    return events;
  }

  // ---------- handlinger ----------

  get toActSeat() {
    return this.toActIndex >= 0 && !this.complete ? this.players[this.toActIndex].seat : null;
  }

  /** Lovlige handlinger for spilleren som står for tur. */
  legalActions(seat) {
    if (this.complete || seat !== this.toActSeat) return null;
    const p = this.playerBySeat(seat);
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const maxTo = p.bet + p.stack;
    // Har spilleren allerede handlet og møter bare en ufullstendig all-in-høyning, kan hen ikke høyne igjen.
    const reopened = !p.hasActed;
    const canRaise = reopened && maxTo > this.currentBet && this.players.some((o) => o !== p && !o.folded && !o.allIn);
    const minTo = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.minRaise;
    return {
      seat,
      canFold: true,
      canCheck: p.bet >= this.currentBet,
      toCall,
      canRaise,
      raiseKind: this.currentBet === 0 ? 'bet' : 'raise',
      minRaiseTo: canRaise ? Math.min(minTo, maxTo) : null,
      maxRaiseTo: canRaise ? maxTo : null,
    };
  }

  /**
   * Utfører en handling.
   * @param {number} seat
   * @param {{type:string, amount?:number}} action  amount = totalt beløp denne gaten («høyn til»).
   * @returns {object[]} hendelser
   */
  act(seat, action) {
    if (this.complete) throw new PokerError('state', 'Hånden er ferdig');
    if (seat !== this.toActSeat) throw new PokerError('turn', `Det er ikke sete ${seat} sin tur`);
    const legal = this.legalActions(seat);
    const p = this.playerBySeat(seat);
    const events = [];
    let { type, amount } = action ?? {};

    if (type === 'timeout') type = legal.canCheck ? 'check' : 'fold';
    if (!ACTIONS.includes(type)) throw new PokerError('action', `Ukjent handling: ${type}`);

    // Normaliser: bet/raise til hele stacken = all-in; all-in som bare dekker call = call.
    if ((type === 'bet' || type === 'raise') && Number.isFinite(amount) && amount >= p.bet + p.stack) type = 'allin';
    if (type === 'allin' && p.bet + p.stack <= this.currentBet) type = 'call';
    if (type === 'call' && legal.toCall === 0) type = 'check';

    switch (type) {
      case 'fold':
        p.folded = true;
        break;
      case 'check':
        if (!legal.canCheck) throw new PokerError('action', 'Kan ikke checke – det er en innsats å møte');
        break;
      case 'call':
        amount = this.put(p, legal.toCall);
        break;
      case 'bet':
      case 'raise': {
        // bet og raise behandles likt; typen rettes etter situasjonen.
        type = this.currentBet === 0 ? 'bet' : 'raise';
        if (!legal.canRaise) throw new PokerError('action', 'Høyning er ikke tillatt her');
        if (!Number.isInteger(amount)) throw new PokerError('amount', 'Beløp må være et heltall');
        if (amount < legal.minRaiseTo) throw new PokerError('amount', `Minste ${type} er ${legal.minRaiseTo}`);
        this.raiseTo(p, amount);
        break;
      }
      case 'allin': {
        const to = p.bet + p.stack;
        if (!legal.canRaise) throw new PokerError('action', 'Høyning er ikke tillatt her – du kan bare calle eller folde');
        this.raiseTo(p, to);
        amount = to;
        break;
      }
    }
    p.hasActed = true;
    this.actions.push({ street: this.street, seat, type, amount: amount ?? 0 });
    events.push({
      type: 'action.applied',
      seat,
      action: type,
      amount: amount ?? 0,
      stack: p.stack,
      bet: p.bet,
      pot: this.potTotal(),
    });
    this.advance(events);
    return events;
  }

  raiseTo(p, to) {
    const raiseSize = to - this.currentBet;
    this.put(p, to - p.bet);
    if (raiseSize >= this.minRaise) {
      // Full høyning: åpner runden igjen for alle andre.
      this.minRaise = raiseSize;
      for (const o of this.players) if (o !== p) o.hasActed = false;
    }
    // Ufullstendig all-in-høyning: andre må svare, men de som allerede har handlet kan ikke høyne igjen.
    this.currentBet = Math.max(this.currentBet, to);
  }

  potTotal() {
    return this.players.reduce((s, p) => s + p.committed, 0);
  }

  // ---------- flyt ----------

  advance(events) {
    if (this.livePlayers().length === 1) {
      this.returnUncalled(events);
      this.finish(events, false);
      return;
    }
    // Neste som må handle, fra spilleren etter den som sist handlet.
    let i = this.next(this.toActIndex);
    for (let k = 0; k < this.n; k++) {
      if (this.needsAction(this.players[i])) {
        this.toActIndex = i;
        events.push(this.turnEvent());
        return;
      }
      i = this.next(i);
    }
    // Runden er ferdig.
    this.returnUncalled(events);
    if (this.street === 'river') {
      this.finish(events, true);
      return;
    }
    if (this.canActPlayers().length <= 1) {
      // Alle (unntatt maks én) er all-in: del resten av bordet og gå til showdown.
      events.push({
        type: 'allin.runout',
        hands: this.livePlayers().map((p) => ({ seat: p.seat, cards: [...p.holeCards] })),
      });
      while (this.street !== 'river') this.dealNextStreet(events);
      this.finish(events, true);
      return;
    }
    this.dealNextStreet(events);
    // Etter floppen starter første aktive spiller etter knappen.
    this.toActIndex = this.buttonIndex;
    this.advance(events);
  }

  dealNextStreet(events) {
    const idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    this.draw(); // brennkort
    const count = this.street === 'flop' ? 3 : 1;
    const cards = [];
    for (let k = 0; k < count; k++) cards.push(this.draw());
    this.board.push(...cards);
    for (const p of this.players) {
      p.bet = 0;
      p.hasActed = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    events.push({ type: 'board', street: this.street, cards, board: [...this.board], pot: this.potTotal() });
  }

  /** Gir tilbake den delen av en innsats som ingen har møtt. */
  returnUncalled(events) {
    const sorted = [...this.players].sort((a, b) => b.bet - a.bet);
    const top = sorted[0];
    const second = sorted[1]?.bet ?? 0;
    if (top.bet > second) {
      const refund = top.bet - second;
      top.bet -= refund;
      top.committed -= refund;
      top.stack += refund;
      if (top.stack > 0) top.allIn = false;
      this.currentBet = second;
      events.push({ type: 'uncalled.returned', seat: top.seat, amount: refund });
    }
  }

  finish(events, showdown) {
    const live = this.livePlayers();
    const pots = buildPots(this.players);
    const scores = new Map();
    const hands = [];
    if (showdown) {
      for (const p of live) {
        const ev = evaluate([...p.holeCards, ...this.board]);
        scores.set(p.seat, ev.score);
        hands.push({ seat: p.seat, cards: [...p.holeCards], best: ev.cards, rank: ev.name, score: ev.score });
      }
    } else {
      scores.set(live[0].seat, 1);
    }
    const { payouts, results } = awardPots(pots, scores, this.seatOrderFromButton());
    for (const [seat, amt] of payouts) this.playerBySeat(seat).stack += amt;
    for (const p of this.players) {
      p.bet = 0;
      p.allIn = false;
    }
    this.street = showdown ? 'showdown' : this.street;
    this.complete = true;
    this.toActIndex = -1;
    this.result = {
      showdown,
      board: [...this.board],
      hands,
      pots: results,
      payouts: Object.fromEntries(payouts),
      stacks: Object.fromEntries(this.players.map((p) => [p.seat, p.stack])),
      startStacks: Object.fromEntries(this.players.map((p) => [p.seat, p.startStack])),
    };
    if (showdown) events.push({ type: 'showdown', hands, board: [...this.board] });
    events.push({ type: 'pots.awarded', pots: results, payouts: this.result.payouts });
    events.push({ type: 'hand.end', handId: this.handId, seed: this.seed, stacks: this.result.stacks });
  }

  turnEvent() {
    const p = this.players[this.toActIndex];
    const legal = this.legalActions(p.seat);
    return {
      type: 'turn',
      seat: p.seat,
      toCall: legal.toCall,
      canCheck: legal.canCheck,
      canRaise: legal.canRaise,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
      pot: this.potTotal(),
    };
  }

  // ---------- visning ----------

  /** Tilstanden sett fra ett sete. Andres hullkort vises kun etter showdown. seat=null gir tilskuervisning. */
  viewFor(seat) {
    const revealed = new Set(this.result?.showdown ? this.result.hands.map((h) => h.seat) : []);
    return {
      handId: this.handId,
      seedHash: this.seedHash,
      street: this.street,
      board: [...this.board],
      pot: this.potTotal(),
      currentBet: this.currentBet,
      buttonSeat: this.players[this.buttonIndex].seat,
      toActSeat: this.toActSeat,
      complete: this.complete,
      players: this.players.map((p) => ({
        seat: p.seat,
        id: p.id,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        cards: p.seat === seat || revealed.has(p.seat) ? [...p.holeCards] : p.holeCards.length ? ['??', '??'] : [],
      })),
      legal: seat != null ? this.legalActions(seat) : null,
    };
  }
}

/** Fjerner private hendelser som ikke tilhører et gitt sete. */
export function eventsFor(events, seat) {
  return events.filter((e) => !e.private || e.seat === seat);
}
