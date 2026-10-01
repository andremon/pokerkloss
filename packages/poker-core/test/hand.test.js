import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand, PokerError, eventsFor } from '../src/hand.js';
import { makeRng } from '../src/bot.js';
import { riggedDeck, SEED, chipTotal } from './helpers.js';

const three = (stacks = [1000, 1000, 1000], extra = {}) =>
  new Hand({
    players: stacks.map((s, i) => ({ seat: i, id: `p${i}`, stack: s })),
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: SEED,
    ...extra,
  });

test('heads-up: knappen poster SB og handler først preflop, sist etter floppen', () => {
  const h = new Hand({
    players: [
      { seat: 3, id: 'a', stack: 500 },
      { seat: 7, id: 'b', stack: 500 },
    ],
    buttonSeat: 3,
    smallBlind: 10,
    bigBlind: 20,
    seed: SEED,
  });
  const ev = h.start();
  const posts = ev.filter((e) => e.type === 'post');
  assert.deepEqual(posts.map((p) => [p.seat, p.kind, p.amount]), [
    [3, 'sb', 10],
    [7, 'bb', 20],
  ]);
  assert.equal(h.toActSeat, 3);
  h.act(3, { type: 'call' });
  assert.equal(h.toActSeat, 7, 'BB har option');
  h.act(7, { type: 'check' });
  assert.equal(h.street, 'flop');
  assert.equal(h.toActSeat, 7, 'BB handler først etter floppen');
});

test('tre spillere: knappen handler først preflop, BB får option', () => {
  const h = three();
  h.start();
  assert.equal(h.toActSeat, 0);
  h.act(0, { type: 'call' });
  h.act(1, { type: 'call' });
  assert.equal(h.toActSeat, 2);
  const legal = h.legalActions(2);
  assert.ok(legal.canCheck);
  assert.ok(legal.canRaise);
  h.act(2, { type: 'check' });
  assert.equal(h.street, 'flop');
  assert.equal(h.toActSeat, 1, 'SB handler først etter floppen');
  assert.equal(h.board.length, 3);
});

test('alle folder: vinneren får potten, umøtt innsats tilbake', () => {
  const h = three();
  h.start();
  const total = chipTotal(h);
  h.act(0, { type: 'raise', amount: 100 });
  const ev1 = h.act(1, { type: 'fold' });
  assert.ok(!h.complete);
  const ev = h.act(2, { type: 'fold' });
  assert.ok(h.complete);
  assert.ok(ev.some((e) => e.type === 'uncalled.returned' && e.seat === 0 && e.amount === 80));
  assert.deepEqual(h.result.stacks, { 0: 1030, 1: 990, 2: 980 });
  assert.equal(chipTotal(h), total);
  assert.ok(!h.result.showdown);
  assert.ok(ev1.length > 0);
});

test('minste høyning håndheves og full høyning åpner runden', () => {
  const h = three();
  h.start();
  assert.throws(() => h.act(0, { type: 'raise', amount: 30 }), (e) => e instanceof PokerError && e.code === 'amount');
  h.act(0, { type: 'raise', amount: 60 }); // høyning på 40
  const legal = h.legalActions(1);
  assert.equal(legal.minRaiseTo, 100, 'neste min = 60 + 40');
  h.act(1, { type: 'raise', amount: 100 });
  h.act(2, { type: 'call' });
  assert.equal(h.toActSeat, 0);
  assert.ok(h.legalActions(0).canRaise, 'full høyning åpner for knappen igjen');
});

test('ufullstendig all-in-høyning åpner ikke for den som allerede har handlet', () => {
  const h = three([1000, 1000, 130]);
  h.start();
  h.act(0, { type: 'raise', amount: 100 }); // høyning 80, min neste = 180
  h.act(1, { type: 'fold' });
  h.act(2, { type: 'allin' }); // til 130: bare 30 mer, ufullstendig
  assert.equal(h.toActSeat, 0);
  const legal = h.legalActions(0);
  assert.equal(legal.toCall, 30);
  assert.equal(legal.canRaise, false);
  assert.throws(() => h.act(0, { type: 'raise', amount: 400 }), PokerError);
  h.act(0, { type: 'call' });
  assert.ok(h.complete, 'én all-in og én uten motstander → kjøres ut');
});

test('all-in med side-poter og riggede kort gir riktig utbetaling', () => {
  // Knapp sete 0. Delerekkefølge: sete 1, 2, 0.
  // Sete 1 (200): AA – vinner hovedpot. Sete 2 (500): KK – vinner side-pot. Sete 0 (1000): QQ.
  const deck = riggedDeck(
    [
      ['Ah', 'Ad'],
      ['Kh', 'Kd'],
      ['Qh', 'Qd'],
    ],
    ['2c', '7s', '9d', '3h', '4s'],
  );
  const h = three([1000, 200, 500], { deck });
  h.start();
  const total = chipTotal(h);
  h.act(0, { type: 'allin' });
  h.act(1, { type: 'allin' });
  const ev = h.act(2, { type: 'allin' });
  assert.ok(h.complete);
  assert.ok(ev.some((e) => e.type === 'allin.runout'));
  assert.ok(ev.some((e) => e.type === 'uncalled.returned' && e.seat === 0 && e.amount === 500));
  assert.deepEqual(h.result.pots.map((p) => [p.amount, p.winners]), [
    [600, [1]],
    [600, [2]],
  ]);
  assert.deepEqual(h.result.stacks, { 0: 500, 1: 600, 2: 600 });
  assert.equal(chipTotal(h), total);
});

test('delt pot når bordet spiller', () => {
  const deck = riggedDeck(
    [
      ['2c', '3d'],
      ['4c', '5d'],
      ['6c', '7d'],
    ],
    ['Ah', 'Kh', 'Qs', 'Jc', 'Td'],
  );
  const h = three([1000, 1000, 1000], { deck });
  h.start();
  h.act(0, { type: 'call' });
  h.act(1, { type: 'call' });
  h.act(2, { type: 'check' });
  for (let s = 0; s < 3; s++) {
    // flop, turn, river: alle checker (SB først)
    h.act(1, { type: 'check' });
    h.act(2, { type: 'check' });
    h.act(0, { type: 'check' });
  }
  assert.ok(h.complete);
  assert.deepEqual(h.result.pots[0].winners.sort(), [0, 1, 2]);
  assert.deepEqual(h.result.stacks, { 0: 1000, 1: 1000, 2: 1000 });
});

test('kort BB går all-in på blind, SB kan fortsatt handle', () => {
  const h = three([1000, 1000, 15]);
  h.start();
  const bb = h.players.find((p) => p.seat === 2);
  assert.ok(bb.allIn);
  assert.equal(h.currentBet, 20);
  h.act(0, { type: 'fold' });
  assert.equal(h.legalActions(1).toCall, 10);
  h.act(1, { type: 'call' });
  assert.ok(h.complete, 'SB mot all-in BB → kjøres ut');
  const sum = Object.values(h.result.stacks).reduce((a, b) => a + b, 0);
  assert.equal(sum, 2015);
});

test('tidsavbrudd: check når mulig, ellers fold', () => {
  const h = three();
  h.start();
  h.act(0, { type: 'timeout' });
  assert.ok(h.players.find((p) => p.seat === 0).folded);
  h.act(1, { type: 'call' });
  h.act(2, { type: 'timeout' });
  assert.ok(!h.players.find((p) => p.seat === 2).folded);
  assert.equal(h.street, 'flop');
});

test('feil spiller eller ferdig hånd gir feil', () => {
  const h = three();
  h.start();
  assert.throws(() => h.act(1, { type: 'call' }), (e) => e.code === 'turn');
  assert.throws(() => h.act(0, { type: 'dance' }), (e) => e.code === 'action');
  assert.throws(() => h.act(0, { type: 'check' }), (e) => e.code === 'action');
});

test('visning skjuler andres kort til showdown', () => {
  const h = three();
  const ev = h.start();
  const v = h.viewFor(1);
  assert.deepEqual(v.players.find((p) => p.seat === 1).cards.length, 2);
  assert.ok(v.players.find((p) => p.seat === 1).cards.every((c) => c !== '??'));
  assert.deepEqual(v.players.find((p) => p.seat === 0).cards, ['??', '??']);
  const mine = eventsFor(ev, 1).filter((e) => e.type === 'cards.private');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].seat, 1);
  assert.equal(h.viewFor(null).legal, null);
});

test('hånd-slutt avslører seed som stemmer med seedHash', async () => {
  const { verifySeed, shuffleDeck } = await import('../src/shuffle.js');
  const h = three([1000, 1000, 1000], { seed: undefined });
  const start = h.start();
  const hash = start.find((e) => e.type === 'hand.start').seedHash;
  const end = [...h.act(0, { type: 'fold' }), ...h.act(1, { type: 'fold' })].find((e) => e.type === 'hand.end');
  assert.ok(verifySeed(end.seed, hash));
  const deck = shuffleDeck(end.seed);
  // Delerekkefølge: sete 1, 2, 0, 1, 2, 0
  assert.deepEqual(h.players.find((p) => p.seat === 1).holeCards, [deck[0], deck[3]]);
});

test('fuzz: tilfeldige lovlige handlinger bevarer sjetonger i 3000 hender', () => {
  const rng = makeRng(42);
  for (let n = 0; n < 3000; n++) {
    const count = 2 + Math.floor(rng() * 8);
    const players = [];
    for (let i = 0; i < count; i++) players.push({ seat: i * 2, id: `p${i}`, stack: 1 + Math.floor(rng() * 3000) });
    const button = players[Math.floor(rng() * count)].seat;
    const h = new Hand({ players, buttonSeat: button, smallBlind: 10, bigBlind: 20, ante: rng() < 0.3 ? 5 : 0 });
    const total = players.reduce((s, p) => s + p.stack, 0);
    h.start();
    let guard = 0;
    while (!h.complete) {
      if (++guard > 500) throw new Error('uendelig løkke');
      const seat = h.toActSeat;
      const l = h.legalActions(seat);
      const r = rng();
      let a;
      if (r < 0.15) a = { type: 'fold' };
      else if (r < 0.55) a = l.canCheck ? { type: 'check' } : { type: 'call' };
      else if (r < 0.9 && l.canRaise) {
        const to = l.minRaiseTo + Math.floor(rng() * (l.maxRaiseTo - l.minRaiseTo + 1));
        a = { type: 'raise', amount: to };
      } else if (l.canRaise) a = { type: 'allin' };
      else a = { type: 'call' };
      h.act(seat, a);
      for (const p of h.players) assert.ok(p.stack >= 0, 'negativ stack');
    }
    const after = Object.values(h.result.stacks).reduce((a, b) => a + b, 0);
    assert.equal(after, total, `sjetonger forsvant i hånd ${n}`);
    const paid = Object.values(h.result.payouts).reduce((a, b) => a + b, 0);
    const pot = h.result.pots.reduce((a, p) => a + p.amount, 0);
    assert.equal(paid, pot, 'alt i potten ble utbetalt');
    if (h.result.showdown) assert.equal(h.board.length, 5);
  }
});
