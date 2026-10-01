import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRating, displayRating, rateTournament, seasonReset, DEFAULT_SIGMA } from '../src/index.js';

test('ny spiller vises som 1000', () => {
  assert.equal(displayRating(newRating()), 1000);
});

test('vinneren går opp, sistemann går ned', () => {
  const res = rateTournament([
    { id: 'a', place: 1 },
    { id: 'b', place: 2 },
    { id: 'c', place: 3 },
    { id: 'd', place: 4 },
  ]);
  const by = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.ok(by.a.after.mu > by.a.before.mu);
  assert.ok(by.d.after.mu < by.d.before.mu);
  assert.ok(by.a.after.mu > by.b.after.mu && by.b.after.mu > by.c.after.mu);
  for (const r of res) assert.ok(r.after.sigma < r.before.sigma, 'usikkerheten synker');
});

test('delt plass gir lik oppdatering for like spillere', () => {
  const res = rateTournament([
    { id: 'a', place: 1 },
    { id: 'b', place: 2 },
    { id: 'c', place: 2 },
  ]);
  assert.equal(res[1].after.mu, res[2].after.mu);
});

test('å slå en sterk spiller gir mer enn å slå en svak', () => {
  const strong = { mu: 35, sigma: 3 };
  const weak = { mu: 15, sigma: 3 };
  const vsStrong = rateTournament([
    { id: 'x', place: 1 },
    { id: 's', place: 2, rating: strong },
  ])[0];
  const vsWeak = rateTournament([
    { id: 'x', place: 1 },
    { id: 'w', place: 2, rating: weak },
  ])[0];
  assert.ok(vsStrong.after.mu - vsStrong.before.mu > vsWeak.after.mu - vsWeak.before.mu);
});

test('en god spiller klatrer over mange turneringer', () => {
  let good = newRating();
  let others = Array.from({ length: 5 }, () => newRating());
  for (let k = 0; k < 30; k++) {
    const entries = [{ id: 'good', place: 1, rating: good }, ...others.map((r, i) => ({ id: `o${i}`, place: i + 2, rating: r }))];
    const res = rateTournament(entries);
    good = res[0].after;
    others = res.slice(1).map((r) => r.after);
  }
  assert.ok(displayRating(good) > 1800, `vist rating ${displayRating(good)}`);
});

test('sesongstart øker usikkerhet, men ikke over startverdien', () => {
  const r = seasonReset({ mu: 30, sigma: 2 });
  assert.equal(r.mu, 30);
  assert.equal(r.sigma, 4);
  assert.equal(seasonReset({ mu: 30, sigma: 8 }).sigma, DEFAULT_SIGMA);
});

test('ugyldig input avvises', () => {
  assert.throws(() => rateTournament([{ id: 'a', place: 1 }]));
  assert.throws(() => rateTournament([{ id: 'a', place: 1 }, { id: 'a', place: 2 }]));
  assert.throws(() => rateTournament([{ id: 'a', place: 0 }, { id: 'b', place: 2 }]));
});
