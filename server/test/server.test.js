import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, connect, autoPlay } from './helpers.js';
import { evaluateStatus } from '../src/membership.js';
import { Matchmaker } from '../src/matchmaker.js';
import { verifySeed, shuffleDeck } from '@arena/poker-core';


test('treningsbord: spiller mot bots til turneringen er ferdig, ser bare egne kort', async () => {
  const { poker, base, port } = await startTestServer();
  try {
    const c = await connect(port, 'dev:anne:Anne');
    await c.waitFor((m) => m.type === 'hello');
    autoPlay(c, (turn) => (turn.canCheck ? { type: 'check' } : { type: 'call' }));
    const r = await api(base, 'dev:anne:Anne', 'POST', '/poker/training', { bots: 3 });
    assert.equal(r.status, 201);
    const tableId = r.body.tournamentId;
    const state = await c.waitFor((m) => m.type === 'table.state');
    assert.equal(state.state.seats.filter(Boolean).length, 4);
    assert.equal(state.state.rated, false);
    assert.ok(state.state.seats.filter((s) => s?.bot).every((s) => s.name.startsWith('Ai-Bot')));

    const result = await c.waitFor((m) => m.type === 'events' && m.events.some((e) => e.type === 'tournament.result'), 60_000);
    const tr = result.events.find((e) => e.type === 'tournament.result');
    assert.equal(tr.placings.length, 4);
    assert.equal(tr.rated, false);
    assert.equal(tr.placings[0].delta, null, 'ingen rating på treningsbord');

    const mySeat = state.state.mySeat;
    const priv = c.events().filter((e) => e.type === 'cards.private');
    assert.ok(priv.length > 0);
    assert.ok(priv.every((e) => e.seat === mySeat), 'fikk aldri andres hullkort');

    // Etterprøv stokkingen på første hånd.
    const start = c.events().find((e) => e.type === 'hand.start');
    const end = c.events().find((e) => e.type === 'hand.end' && e.handId === start.handId);
    assert.ok(verifySeed(end.seed, start.seedHash));

    // Håndhistorikk kan hentes av deltakeren, ikke av andre.
    await new Promise((r) => setTimeout(r, 50));
    const h = await api(base, 'dev:anne:Anne', 'GET', `/poker/hands/${start.handId}`);
    assert.equal(h.status, 200);
    const deck = shuffleDeck(h.body.seed);
    assert.equal(deck.length, 52);
    const me = h.body.players.find((p) => p.userId === 'anne');
    assert.equal(me.holeCards.length, 2);
    const other = await api(base, 'dev:ola:Ola', 'GET', `/poker/hands/${start.handId}`);
    assert.equal(other.status, 404);

    // Treningsbord gir ingen plass på topplisten.
    const lb = await api(base, 'dev:anne:Anne', 'GET', '/poker/leaderboard');
    assert.equal(lb.body.players.length, 0);
    assert.ok(tableId.startsWith('training-'));
    c.close();
  } finally {
    await poker.close();
  }
});

test('ratet heads-up via kø: krever medlemskap, oppdaterer rating og toppliste', async () => {
  const { poker, base, port, membership } = await startTestServer();
  try {
    // Ikke-medlem avvises.
    const denied = await api(base, 'dev:gjest:Gjest', 'POST', '/poker/sng/queue', { format: 'hu' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'not_eligible');

    membership.setDevMember('kari', { aktiv: true, aldersgruppe: 'voksen' });
    membership.setDevMember('per', { aktiv: true, aldersgruppe: 'ungdom', husstand: true, over16: true });

    const kari = await connect(port, 'dev:kari:Kari');
    const per = await connect(port, 'dev:per:Per');
    autoPlay(kari, (t) => (t.canRaise ? { type: 'allin' } : { type: 'call' }));
    autoPlay(per, (t) => (t.canCheck ? { type: 'check' } : { type: 'call' }));

    const q1 = await api(base, 'dev:kari:Kari', 'POST', '/poker/sng/queue', { format: 'hu' }, { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(q1.status, 200);
    assert.equal(q1.body.position.waiting, 1);
    const q2 = await api(base, 'dev:per:Per', 'POST', '/poker/sng/queue', { format: 'hu' }, { 'x-forwarded-for': '10.0.0.2' });
    assert.equal(q2.status, 200);

    const found = await kari.waitFor((m) => m.type === 'match.found');
    assert.equal(found.format, 'hu');
    await per.waitFor((m) => m.type === 'match.found' && m.tournamentId === found.tournamentId);

    const res = await kari.waitFor((m) => m.type === 'events' && m.events.some((e) => e.type === 'tournament.result'), 30_000);
    const tr = res.events.find((e) => e.type === 'tournament.result');
    assert.equal(tr.rated, true);
    const winner = tr.placings[0];
    const loser = tr.placings[1];
    assert.equal(winner.place, 1);
    assert.ok(winner.delta > 0, 'vinneren går opp');
    assert.ok(loser.delta < 0 || loser.ratingAfter < winner.ratingAfter);

    await new Promise((r) => setTimeout(r, 50));
    const lb = await api(base, 'dev:kari:Kari', 'GET', '/poker/leaderboard');
    assert.equal(lb.body.players.length, 2);
    assert.equal(lb.body.players[0].userId, winner.userId);
    assert.equal(lb.body.players[0].wins, 1);

    const me = await api(base, 'dev:per:Per', 'GET', '/poker/me');
    assert.equal(me.body.rated, true, '17 år med familieinnmelding kan spille ratet');
    assert.equal(me.body.gamesPlayed, 1);
    assert.equal(me.body.activeTournament, null, 'bordet er frigjort etter turneringen');
    kari.close();
    per.close();
  } finally {
    await poker.close();
  }
});

test('ugyldig handling gir feilmelding, frakoblet spiller handles automatisk', async () => {
  const { poker, base, port } = await startTestServer();
  try {
    const c = await connect(port, 'dev:ola:Ola');
    const r = await api(base, 'dev:ola:Ola', 'POST', '/poker/training', { bots: 2 });
    const tableId = r.body.tournamentId;
    const st = await c.waitFor((m) => m.type === 'table.state');
    // Ugyldig handling avvises (enten fordi det ikke er min tur, eller fordi typen er ukjent).
    c.send({ type: 'action', tournamentId: tableId, action: { type: 'dans' } });
    const bad = await c.waitFor((m) => m.type === 'error' && m.ref === 'action');
    assert.ok(['turn', 'action', 'state'].includes(bad.code), bad.code);
    c.send({ type: 'action', tournamentId: 'finnes-ikke', action: { type: 'fold' } });
    const err = await c.waitFor((m) => m.type === 'error' && m.code === 'table');
    assert.match(err.message, /Ukjent turnering/);
    assert.ok(st.state.mySeat === 0);

    // Kobler fra: bordet skal spille ferdig med automatiske check/fold.
    const runner = poker.tournaments.get(tableId);
    const done = new Promise((resolve) => runner.once('finished', resolve));
    c.close();
    const placings = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('ble aldri ferdig')), 60_000))]);
    assert.equal(placings.length, 3);
    // Kan starte nytt bord etterpå.
    const again = await api(base, 'dev:ola:Ola', 'POST', '/poker/training', { bots: 1 });
    assert.equal(again.status, 201);
  } finally {
    await poker.close();
  }
});

test('uten innlogging: 401 på REST og avvist WebSocket', async () => {
  const { poker, base, port } = await startTestServer();
  try {
    const r = await fetch(`${base}/poker/lobby`);
    assert.equal(r.status, 401);
    await assert.rejects(connect(port, 'feil-token'));
    const ok = await api(base, 'dev:x:X', 'GET', '/poker/lobby');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.queues.hu.size, 2);
  } finally {
    await poker.close();
  }
});

test('regler for ratet spill ut fra MedlemArena-status', () => {
  const ok = (st) => evaluateStatus(st).rated;
  assert.equal(ok({ aktiv: true, aldersgruppe: 'voksen' }), true);
  assert.equal(ok({ aktiv: false, aldersgruppe: 'voksen' }), false);
  assert.equal(ok({ aktiv: true, aldersgruppe: 'voksen', gyldigTil: '2000-01-01' }), false, 'utløpt');
  assert.equal(ok({ aktiv: true, aldersgruppe: 'ungdom', husstand: true, over16: true }), true, '16+ i husstand');
  assert.equal(ok({ aktiv: true, aldersgruppe: 'ungdom', husstand: true, over16: false }), false, 'under 16');
  assert.equal(ok({ aktiv: true, aldersgruppe: 'ungdom', husstand: false, over16: true }), false, 'ikke familieinnmeldt');
  assert.equal(ok({ aktiv: true, aldersgruppe: 'ungdom' }), false, 'mangler felter → nei');
  assert.equal(ok({ aktiv: true, aldersgruppe: 'barn', husstand: true }), false);
  assert.equal(ok({ aktiv: true, aldersgruppe: null }), false);
  assert.equal(ok(null), false);
});

test('matchmaking: ratingvindu utvides og samme IP settes ikke sammen', () => {
  let now = 0;
  const matches = [];
  const mm = new Matchmaker({
    config: { tickMs: 1000, baseWindow: 300, widenAfterMs: 30_000, widenStep: 100, widenEveryMs: 10_000 },
    onMatch: (f, e) => matches.push(e.map((x) => x.userId)),
    now: () => now,
  });
  mm.join('hu', { userId: 'a', name: 'A', rating: 1000, ip: '1' });
  mm.join('hu', { userId: 'b', name: 'B', rating: 1500, ip: '2' });
  assert.equal(matches.length, 0, 'for stor ratingforskjell');
  now = 30_000 + 30_000; // vindu 300 + 4*100 = 700
  mm.tick();
  assert.deepEqual(matches, [['a', 'b']]);

  mm.join('hu', { userId: 'c', name: 'C', rating: 1000, ip: '9' });
  mm.join('hu', { userId: 'd', name: 'D', rating: 1000, ip: '9' });
  assert.equal(matches.length, 1, 'samme IP matches ikke');
  mm.join('hu', { userId: 'e', name: 'E', rating: 1050, ip: '8' });
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[1], ['c', 'e']);
  assert.throws(() => mm.join('hu', { userId: 'd', name: 'D', rating: 1000 }), /allerede/);
  assert.ok(mm.leave('d'));
});
