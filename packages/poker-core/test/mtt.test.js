import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiTableTournament } from '../src/mtt.js';
import { makeRng } from '../src/bot.js';

/** Deterministiske seeds, så testene gir samme kortstokker hver gang. */
const seeds = (start) => {
  let n = start;
  return () => `test-seed-${n++}-${'x'.repeat(32)}`;
};

/** Rask tilfeldig spiller: mest call/check, en del all-in, litt fold. */
function quickAction(hand, seat, rng) {
  const l = hand.legalActions(seat);
  const r = rng();
  const me = hand.players.find((p) => p.seat === seat);
  if (l.toCall > me.stack / 3 && rng() < 0.75) return { type: 'fold' };
  if (r < 0.25 && !l.canCheck) return { type: 'fold' };
  if (r < 0.26 && l.canRaise) return { type: 'allin' };
  if (r < 0.4 && l.canRaise) return { type: 'raise', amount: l.minRaiseTo };
  return l.canCheck ? { type: 'check' } : { type: 'call' };
}

/** Kjører en MTT der bordene spiller «samtidig»: én handling om gangen, bord for bord. */
function runMtt(t, rng, checks = () => {}) {
  const all = [];
  let steps = 0;
  while (!t.finished) {
    if (++steps > 500000) throw new Error('ble aldri ferdig');
    for (const tid of t.readyTables()) {
      const r = t.startNextHand(tid);
      if (r) all.push(...r.events, ...r.extra);
    }
    const running = [...t.tables.values()].filter((x) => x.hand && !x.hand.complete);
    if (!running.length) {
      if (!t.finished && !t.readyTables().length) throw new Error('Låst: ingen bord kan spille');
      continue;
    }
    const table = running[Math.floor(rng() * running.length)];
    const seat = table.hand.toActSeat;
    const { events, extra } = t.act(table.id, seat, quickAction(table.hand, seat, rng));
    all.push(...events, ...extra);
    checks(t);
  }
  return all;
}

function invariants(t, total) {
  // Ingen bord over maks, ingen spiller to steder.
  const seen = new Set();
  let chips = 0;
  for (const tb of t.tables.values()) {
    assert.ok(tb.seats.length === t.maxSeats);
    for (const pid of tb.seats) {
      if (pid == null) continue;
      assert.ok(!seen.has(pid), `${pid} sitter to steder`);
      seen.add(pid);
      assert.equal(t.players.get(pid).tableId, tb.id);
    }
    // Sjetonger: ved pågående hånd telles stack + innsats fra hånden.
    if (tb.hand && !tb.hand.complete) {
      for (const hp of tb.hand.players) chips += hp.stack + hp.committed;
      for (const pid of tb.seats) {
        if (pid != null && !tb.hand.players.some((hp) => hp.id === pid)) chips += t.players.get(pid).stack;
      }
    } else {
      for (const pid of tb.seats) if (pid != null) chips += t.players.get(pid).stack;
    }
  }
  assert.equal(chips, total, 'sjetonger bevart');
  for (const p of t.players.values()) {
    if (p.stack > 0) assert.ok(seen.has(p.id), `${p.id} har sjetonger men ingen plass`);
  }
}

test('startfordeling: 30 spillere på 4 bord med 7–8 hver', () => {
  const t = new MultiTableTournament({ players: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}` })) });
  const sizes = [...t.tables.values()].map((x) => t.occupants(x).length).sort();
  assert.deepEqual(sizes, [7, 7, 8, 8]);
});

test('ett bord (sit-and-go) fungerer som før', () => {
  const rng = makeRng(3);
  const t = new MultiTableTournament({ players: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}` })), handsPerLevel: 5, seedFn: seeds(1) });
  assert.equal(t.tables.size, 1);
  runMtt(t, rng);
  const res = t.results();
  assert.equal(res.length, 6);
  assert.equal(res[0].place, 1);
});

test('45 spillere på 5 bord: balansering, bordbrudd og finalebord', () => {
  const rng = makeRng(11);
  const n = 45;
  const t = new MultiTableTournament({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })), handsPerLevel: 15, seedFn: seeds(1000) });
  let maxDiffAtIdle = 0;
  const events = runMtt(t, rng, (tt) => {
    invariants(tt, n * 1500);
    if (!tt.finished && [...tt.tables.values()].every((x) => tt.isIdle(x))) {
      const sizes = [...tt.tables.values()].map((x) => tt.occupants(x).length);
      maxDiffAtIdle = Math.max(maxDiffAtIdle, Math.max(...sizes) - Math.min(...sizes));
    }
  });
  const res = t.results();
  assert.ok(t.totalHands > 50, `bare ${t.totalHands} hender`);
  assert.equal(res.length, n);
  assert.equal(res.filter((r) => r.place === 1).length, 1);
  assert.ok(events.some((e) => e.type === 'table.broken'), 'bord ble brutt');
  assert.ok(events.some((e) => e.type === 'player.moved'), 'spillere ble flyttet');
  assert.equal(t.tables.size, 1, 'endte på ett finalebord');
  assert.ok(maxDiffAtIdle <= 1, `ubalanse ${maxDiffAtIdle} når alle bord var ledige`);
  // Hver plass 1..n brukt (eller delt), og alle plasser er gyldige.
  for (const r of res) assert.ok(r.place >= 1 && r.place <= n);
  const winner = [...t.players.values()].find((p) => p.stack > 0);
  assert.equal(winner.stack, n * 1500);
});

test('mange tilfeldige MTT-er (2–60 spillere, 6- og 9-bord) blir alltid ferdige', () => {
  for (let k = 0; k < 25; k++) {
    const rng = makeRng(500 + k);
    const n = 2 + Math.floor(rng() * 59);
    const maxSeats = k % 2 ? 6 : 9;
    const t = new MultiTableTournament({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })), maxSeats, handsPerLevel: 4, seedFn: seeds(k * 100000) });
    runMtt(t, rng, (tt) => invariants(tt, n * 1500));
    assert.equal(t.results().length, n);
  }
});

test('overview viser gjenværende og snitt-stack', () => {
  const t = new MultiTableTournament({ players: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Spiller ${i}` })) });
  const o = t.overview();
  assert.equal(o.remaining, 12);
  assert.equal(o.averageStack, 1500);
  assert.equal(o.tables.length, 2);
  assert.equal(t.seatsOf('T1').filter(Boolean)[0].name, 'Spiller 0');
});
