import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffleDeck, hashSeed, verifySeed, newSeed } from '../src/shuffle.js';
import { buildPots, awardPots } from '../src/pots.js';

test('samme seed gir samme stokk, ulik seed gir ulik', () => {
  const s = newSeed();
  assert.deepEqual(shuffleDeck(s), shuffleDeck(s));
  assert.notDeepEqual(shuffleDeck(s), shuffleDeck(newSeed()));
});

test('stokken har 52 unike kort', () => {
  const d = shuffleDeck(newSeed());
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
});

test('seed-hash kan etterprøves', () => {
  const s = newSeed();
  const h = hashSeed(s);
  assert.equal(h.length, 64);
  assert.ok(verifySeed(s, h));
  assert.ok(!verifySeed(newSeed(), h));
});

test('stokkingen er tilnærmet uniform (kjikvadrat på første kort)', () => {
  const counts = new Map();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const c = shuffleDeck(`seed-${i}-${'x'.repeat(32)}`)[0];
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const exp = N / 52;
  let chi = 0;
  for (const v of counts.values()) chi += (v - exp) ** 2 / exp;
  // 51 frihetsgrader: p=0.001 ved ca. 87
  assert.ok(chi < 87, `chi2 = ${chi.toFixed(1)}`);
  assert.equal(counts.size, 52);
});

test('side-poter ved to all-in med ulike stacker', () => {
  const pots = buildPots([
    { seat: 0, committed: 100, folded: false },
    { seat: 1, committed: 300, folded: false },
    { seat: 2, committed: 500, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
    { amount: 200, eligible: [2] },
  ]);
});

test('foldet spillers sjetonger blir i potten, men kan ikke vinnes av hen', () => {
  const pots = buildPots([
    { seat: 0, committed: 50, folded: true },
    { seat: 1, committed: 200, folded: false },
    { seat: 2, committed: 200, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 450, eligible: [1, 2] }]);
});

test('delt pot med rest-sjetong til første etter knappen', () => {
  const pots = [{ amount: 101, eligible: [0, 1] }];
  const scores = new Map([
    [0, 10],
    [1, 10],
  ]);
  const { payouts } = awardPots(pots, scores, [1, 0]);
  assert.equal(payouts.get(1), 51);
  assert.equal(payouts.get(0), 50);
});

test('kort stack vinner bare hovedpotten', () => {
  const pots = buildPots([
    { seat: 0, committed: 100, folded: false },
    { seat: 1, committed: 400, folded: false },
    { seat: 2, committed: 400, folded: false },
  ]);
  const scores = new Map([
    [0, 99],
    [1, 50],
    [2, 10],
  ]);
  const { payouts } = awardPots(pots, scores, [0, 1, 2]);
  assert.equal(payouts.get(0), 300);
  assert.equal(payouts.get(1), 600);
  assert.equal(payouts.get(2), undefined);
});
