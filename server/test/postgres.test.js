// Kjøres bare når PG_TEST_URL er satt, f.eks.:
//   PG_TEST_URL=postgres://postgres@127.0.0.1:5433/poker_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore } from '../src/store/postgres.js';
import { startTestServer, api, connect, autoPlay } from './helpers.js';

const url = process.env.PG_TEST_URL;

test('Postgres-lager: full ratet heads-up lagrer hender, entries og rating', { skip: !url && 'PG_TEST_URL ikke satt' }, async () => {
  const store = await createPostgresStore(url);
  await store.pool.query(
    'TRUNCATE poker_hand_actions, poker_hands, poker_entries, poker_ratings, poker_tournaments, poker_players, poker_flags CASCADE',
  );
  const { poker, base, port, membership } = await startTestServer({ store });
  const year = new Date().getFullYear();
  try {
    membership.setDevMember('liv', { aktiv: true, aldersgruppe: 'voksen' });
    membership.setDevMember('odd', { aktiv: true, aldersgruppe: 'voksen' });
    const liv = await connect(port, 'dev:liv:Liv');
    const odd = await connect(port, 'dev:odd:Odd');
    autoPlay(liv, (t) => (t.canRaise ? { type: 'allin' } : { type: 'call' }));
    autoPlay(odd, (t) => (t.canCheck ? { type: 'check' } : { type: 'call' }));
    await api(base, 'dev:liv:Liv', 'POST', '/poker/sng/queue', { format: 'hu' }, { 'x-forwarded-for': '10.1.0.1' });
    await api(base, 'dev:odd:Odd', 'POST', '/poker/sng/queue', { format: 'hu' }, { 'x-forwarded-for': '10.1.0.2' });
    const res = await liv.waitFor((m) => m.type === 'events' && m.events.some((e) => e.type === 'tournament.result'), 30_000);
    const tr = res.events.find((e) => e.type === 'tournament.result');
    await new Promise((r) => setTimeout(r, 200));

    const lb = await api(base, 'dev:liv:Liv', 'GET', '/poker/leaderboard');
    assert.equal(lb.status, 200);
    assert.equal(lb.body.players.length, 2);
    assert.equal(lb.body.players[0].userId, tr.placings[0].userId);

    const { rows: t } = await store.pool.query('SELECT status, rated FROM poker_tournaments');
    assert.deepEqual(t, [{ status: 'finished', rated: true }]);
    const { rows: hands } = await store.pool.query('SELECT count(*)::int AS n FROM poker_hands');
    assert.ok(hands[0].n >= 1);
    const { rows: acts } = await store.pool.query('SELECT count(*)::int AS n FROM poker_hand_actions');
    assert.ok(acts[0].n >= 2);

    const hid = liv.events().find((e) => e.type === 'hand.start').handId;
    const h = await api(base, 'dev:odd:Odd', 'GET', `/poker/hands/${hid}`);
    assert.equal(h.status, 200);
    assert.ok(h.body.actions.length >= 2);

    const stats = await api(base, 'dev:liv:Liv', 'GET', '/poker/players/odd');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.gamesPlayed, 1);
    assert.equal(stats.body.recent.length, 1);
    liv.close();
    odd.close();
  } finally {
    await poker.close();
    await store.close();
  }
});
