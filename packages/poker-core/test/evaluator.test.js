import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, score5, CATEGORY, categoryOf } from '../src/evaluator.js';

const cat = (cards) => evaluate(cards).category;
const beats = (a, b) => evaluate(a).score > evaluate(b).score;

test('kategorier gjenkjennes', () => {
  assert.equal(cat(['As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c']), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat(['9h', '9d', '9s', '9c', 'Ah', '2d', '3c']), CATEGORY.QUADS);
  assert.equal(cat(['9h', '9d', '9s', 'Kc', 'Kh', '2d', '3c']), CATEGORY.FULL_HOUSE);
  assert.equal(cat(['2h', '7h', '9h', 'Jh', 'Kh', '2d', '3c']), CATEGORY.FLUSH);
  assert.equal(cat(['5h', '6d', '7s', '8c', '9h', '2d', '2c']), CATEGORY.STRAIGHT);
  assert.equal(cat(['Ah', '2d', '3s', '4c', '5h', 'Kd', 'Qc']), CATEGORY.STRAIGHT);
  assert.equal(cat(['9h', '9d', '9s', '4c', 'Kh', '2d', '3c']), CATEGORY.TRIPS);
  assert.equal(cat(['9h', '9d', '4s', '4c', 'Kh', '2d', '3c']), CATEGORY.TWO_PAIR);
  assert.equal(cat(['9h', '9d', '5s', '4c', 'Kh', '2d', '3c']), CATEGORY.PAIR);
  assert.equal(cat(['9h', 'Td', '5s', '4c', 'Kh', '2d', '3c']), CATEGORY.HIGH_CARD);
});

test('hjul (A-5) er laveste straight', () => {
  assert.ok(beats(['2h', '3d', '4s', '5c', '6h'], ['Ah', '2d', '3s', '4c', '5h']));
  assert.equal(evaluate(['Ah', '2d', '3s', '4c', '5h']).cards.length, 5);
});

test('straight flush hjul slår fire like', () => {
  assert.ok(beats(['Ah', '2h', '3h', '4h', '5h'], ['Kd', 'Ks', 'Kc', 'Kh', 'Ah']));
});

test('kicker avgjør', () => {
  assert.ok(beats(['Ah', 'Ad', 'Ks', '7c', '3h'], ['As', 'Ac', 'Qs', 'Jc', 'Th']));
  assert.ok(beats(['Kh', 'Kd', '4s', '4c', 'Ah'], ['Ks', 'Kc', '4h', '4d', 'Qh']));
});

test('to par: høyeste par først, så andre par, så kicker', () => {
  assert.ok(beats(['Ah', 'Ad', '2s', '2c', '3h'], ['Ks', 'Kc', 'Qh', 'Qd', 'Jh']));
});

test('hus: tre like avgjør før par', () => {
  assert.ok(beats(['4h', '4d', '4s', '2c', '2h'], ['3s', '3d', '3c', 'Ah', 'Ad']));
});

test('flush sammenlignes kort for kort', () => {
  assert.ok(beats(['Ah', 'Jh', '8h', '6h', '2h'], ['Ad', 'Jd', '8d', '5d', '4d']));
});

test('lik hånd gir lik score (split)', () => {
  const board = ['Ah', 'Kd', 'Qs', 'Jc', 'Th'];
  assert.equal(evaluate([...board, '2c', '3d']).score, evaluate([...board, '4c', '5d']).score);
});

test('beste 5 av 7 velges', () => {
  const r = evaluate(['2c', '2d', 'Ah', 'Kh', 'Qh', 'Jh', 'Th']);
  assert.equal(r.category, CATEGORY.STRAIGHT_FLUSH);
  assert.deepEqual([...r.cards].sort(), ['Ah', 'Jh', 'Kh', 'Qh', 'Th'].sort());
});

test('score5 avviser feil antall kort', () => {
  assert.throws(() => score5(['Ah', 'Kh']));
  assert.equal(categoryOf(score5(['Ah', 'Kh', 'Qh', 'Jh', '9h'])), CATEGORY.FLUSH);
});

test('alle 7462 ulike 5-kortshender gir riktig antall per kategori (full oppregning)', () => {
  // Klassisk kontroll: 2 598 960 hender fordelt på kjente antall.
  const expected = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
  const deck = [];
  for (const s of 'cdhs') for (const r of '23456789TJQKA') deck.push(r + s);
  const counts = new Array(9).fill(0);
  const distinct = new Set();
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++) {
            const s = score5([deck[a], deck[b], deck[c], deck[d], deck[e]]);
            counts[categoryOf(s)]++;
            distinct.add(s);
          }
  assert.deepEqual(counts, expected);
  assert.equal(distinct.size, 7462);
});
