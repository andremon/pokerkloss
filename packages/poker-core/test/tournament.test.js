import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tournament } from '../src/tournament.js';
import { STRUCTURES, levelIndexAt } from '../src/blinds.js';
import { botDecide, makeRng } from '../src/bot.js';

function runWithBots(t, rng, maxHands = 2000) {
  let hands = 0;
  const allEvents = [];
  while (!t.finished) {
    if (++hands > maxHands) throw new Error('turneringen ble aldri ferdig');
    const { hand, events } = t.startNextHand();
    allEvents.push(...events);
    while (!hand.complete) {
      const seat = hand.toActSeat;
      const a = botDecide(hand, seat, { rng, iterations: 40 });
      allEvents.push(...t.act(seat, a));
    }
  }
  return allEvents;
}

test('full sit-and-go med 6 bots gir gyldige plasseringer 1..6', () => {
  const rng = makeRng(7);
  const players = Array.from({ length: 6 }, (_, i) => ({ id: `bot${i}` }));
  let sn = 0;
  const t = new Tournament({ players, handsPerLevel: 8, seedFn: () => `sng-${sn++}-${'x'.repeat(32)}` });
  const events = runWithBots(t, rng);
  const res = t.results();
  assert.equal(res.length, 6);
  assert.equal(res[0].place, 1);
  assert.equal(res.filter((r) => r.place === 1).length, 1);
  const total = t.seats.reduce((s, x) => s + x.stack, 0);
  assert.equal(total, 6 * STRUCTURES.sng.startingStack, 'alle sjetonger hos vinneren');
  assert.ok(events.some((e) => e.type === 'tournament.end'));
  for (const r of res) assert.ok(r.place >= 1 && r.place <= 6);
});

test('mange turneringer: sjetonger bevares og alle får plass', () => {
  for (let k = 0; k < 15; k++) {
    const rng = makeRng(100 + k);
    const n = 2 + (k % 8);
    let sn = k * 10000;
    const t = new Tournament({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })), handsPerLevel: 5, seedFn: () => `t-${sn++}-${'x'.repeat(32)}` });
    runWithBots(t, rng);
    const res = t.results();
    assert.equal(res.length, n);
    assert.equal(
      t.seats.reduce((s, x) => s + x.stack, 0),
      n * 1500,
    );
    // Plassene er sortert og innenfor 1..n
    for (let i = 1; i < res.length; i++) assert.ok(res[i].place >= res[i - 1].place);
  }
});

test('knappen flytter seg til neste sete med sjetonger', () => {
  const t = new Tournament({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], handsPerLevel: 100 });
  const buttons = [];
  for (let i = 0; i < 4; i++) {
    const { hand } = t.startNextHand();
    buttons.push(t.buttonSeat);
    // Alle folder til BB
    while (!hand.complete) t.act(hand.toActSeat, { type: 'fold' });
  }
  assert.deepEqual(buttons, [0, 1, 2, 0]);
});

test('to spillere ut i samme hånd: størst start-stack får best plass', () => {
  const t = new Tournament({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], handsPerLevel: 100 });
  // Simuler resultatet av en hånd der b og c røk samtidig.
  t.hand = { result: { stacks: { 0: 3300, 1: 0, 2: 0, 3: 2700 }, startStacks: { 0: 3000, 1: 200, 2: 100, 3: 2700 } } };
  const ev = t.onHandComplete();
  assert.deepEqual(
    ev.filter((e) => e.type === 'player.eliminated').map((e) => [e.id, e.place]),
    [
      ['b', 3],
      ['c', 4],
    ],
  );
  // Like start-stacker deler plass.
  t.hand = { result: { stacks: { 0: 6000, 3: 0 }, startStacks: { 0: 3300, 3: 2700 } } };
  const ev2 = t.onHandComplete();
  assert.ok(ev2.some((e) => e.type === 'tournament.end'));
  assert.deepEqual(t.results().map((r) => [r.id, r.place]), [
    ['a', 1],
    ['d', 2],
    ['b', 3],
    ['c', 4],
  ]);
});

test('like start-stacker som ryker samtidig deler plass', () => {
  const t = new Tournament({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], handsPerLevel: 100 });
  t.hand = { result: { stacks: { 0: 4500, 1: 0, 2: 0 }, startStacks: { 0: 1500, 1: 1500, 2: 1500 } } };
  t.onHandComplete();
  assert.deepEqual(t.results().map((r) => [r.id, r.place]), [
    ['a', 1],
    ['b', 2],
    ['c', 2],
  ]);
});

test('blindnivå øker med tid', () => {
  const s = STRUCTURES.sng;
  assert.equal(levelIndexAt(s, 0), 0);
  assert.equal(levelIndexAt(s, 5 * 60_000), 1);
  assert.equal(levelIndexAt(s, 999 * 60_000), s.levels.length - 1);
  let now = 0;
  const t = new Tournament({ players: [{ id: 'a' }, { id: 'b' }], now: () => now });
  t.startNextHand();
  assert.equal(t.currentLevel().bb, 20);
  now = 11 * 60_000;
  assert.equal(t.currentLevel().bb, 50);
});

test('ugyldig oppsett avvises', () => {
  assert.throws(() => new Tournament({ players: [{ id: 'a' }] }));
  assert.throws(() => new Tournament({ players: [{ id: 'a' }, { id: 'a' }] }));
  assert.throws(() => new Tournament({ players: Array.from({ length: 10 }, (_, i) => ({ id: `${i}` })) }));
});
