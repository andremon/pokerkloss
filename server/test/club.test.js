import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, connect, autoPlay } from './helpers.js';
import { createMemoryStore, leaguePoints } from '../src/store/memory.js';
import { createPostgresStore } from '../src/store/postgres.js';

const year = new Date().getFullYear();
const pgUrl = process.env.PG_TEST_URL;

async function clubNight(store) {
  const { poker, base, port, membership } = await startTestServer({ store });
  const ADMIN = 'dev:admin:Styret';
  try {
    // --- administrasjon ---
    const notAdmin = await api(base, 'dev:ola:Ola', 'POST', '/poker/admin/leagues', { name: 'Hack' });
    assert.equal(notAdmin.status, 403);
    const league = await api(base, ADMIN, 'POST', '/poker/admin/leagues', { name: 'Klubbkveld Østlandet' });
    assert.equal(league.status, 201);
    assert.equal(league.body.id, 'klubbkveld-ostlandet');
    const dupe = await api(base, ADMIN, 'POST', '/poker/admin/leagues', { name: 'Klubbkveld Østlandet' });
    assert.equal(dupe.status, 409);

    const bad = await api(base, ADMIN, 'POST', '/poker/admin/tournaments', { name: 'X', startAt: 'i morgen' });
    assert.equal(bad.status, 400);

    const startAt = new Date(Date.now() + 1500).toISOString();
    const created = await api(base, ADMIN, 'POST', '/poker/admin/tournaments', {
      name: 'Onsdagspoker',
      startAt,
      maxPlayers: 20,
      maxSeats: 4,
      structure: 'sng',
      leagueId: 'klubbkveld-ostlandet',
    });
    assert.equal(created.status, 201);
    const sid = created.body.id;

    // --- påmelding ---
    const N = 11;
    const ids = Array.from({ length: N }, (_, i) => `m${i}`);
    for (const id of ids) membership.setDevMember(id, { aktiv: true, aldersgruppe: 'voksen' });
    const clients = [];
    for (const [i, id] of ids.entries()) {
      const c = await connect(port, `dev:${id}:Medlem ${i}`);
      // Litt ulike spillestiler slik at noen ryker tidlig og bordene må balanseres.
      autoPlay(c, (t) => {
        if (i % 3 === 0 && t.canRaise) return { type: 'allin' };
        if (i % 3 === 1 && !t.canCheck && t.toCall > 200) return { type: 'fold' };
        return t.canCheck ? { type: 'check' } : { type: 'call' };
      });
      clients.push(c);
      const r = await api(base, `dev:${id}:Medlem ${i}`, 'POST', `/poker/tournaments/${sid}/register`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const guest = await api(base, 'dev:gjest:Gjest', 'POST', `/poker/tournaments/${sid}/register`);
    assert.equal(guest.status, 403, 'ikke-medlem kan ikke melde seg på');
    const again = await api(base, 'dev:m0:Medlem 0', 'POST', `/poker/tournaments/${sid}/register`);
    assert.equal(again.body.added, false);

    const list = await api(base, 'dev:m1:Medlem 1', 'GET', '/poker/tournaments');
    const mine = list.body.tournaments.find((t) => t.id === sid);
    assert.equal(mine.registered, N);
    assert.equal(mine.registeredMe, true);

    // Av- og påmelding igjen
    assert.equal((await api(base, 'dev:m1:Medlem 1', 'DELETE', `/poker/tournaments/${sid}/register`)).body.removed, true);
    await api(base, 'dev:m1:Medlem 1', 'POST', `/poker/tournaments/${sid}/register`);

    // --- start og spill ---
    const started = await Promise.all(clients.map((c) => c.waitFor((m) => m.type === 'scheduled.started', 10_000)));
    const tid = started[0].tournamentId;
    assert.ok(started.every((m) => m.tournamentId === tid));
    const firstState = await clients[0].waitFor((m) => m.type === 'table.state' && m.tournamentId === tid);
    assert.equal(firstState.state.overview.tables.length, 3, '11 spillere på 4-mannsbord = 3 bord');

    // Påmeldingen er stengt når turneringen har startet.
    const late = await api(base, 'dev:m1:Medlem 1', 'DELETE', `/poker/tournaments/${sid}/register`);
    assert.equal(late.body.removed, false);

    // En som ryker ut blir frigjort med én gang.
    const out = await Promise.race(clients.map((c, i) => c.waitFor((m) => m.type === 'eliminated', 60_000).then((m) => ({ i, m }))));
    const meOut = await api(base, `dev:${ids[out.i]}:Medlem ${out.i}`, 'GET', '/poker/me');
    assert.equal(meOut.body.activeTournament, null);

    const results = await Promise.all(
      clients.map((c) => c.waitFor((m) => m.type === 'events' && m.events.some((e) => e.type === 'tournament.result'), 120_000)),
    );
    const tr = results[0].events.find((e) => e.type === 'tournament.result');
    assert.equal(tr.placings.length, N);
    assert.equal(tr.rated, true);
    assert.ok(clients.some((c) => c.messages.some((m) => m.type === 'table.moved')), 'minst én spiller ble flyttet');
    // Ingen fikk andres hullkort.
    for (const c of clients) {
      const seats = new Map();
      for (const m of c.messages) {
        if (m.type !== 'events') continue;
        for (const e of m.events) {
          if (e.type === 'hand.start') seats.set(e.handId, e.seats.find((s) => s.id === c.messages[0].userId)?.seat);
          if (e.type === 'cards.private') assert.ok([...seats.values()].includes(e.seat));
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));

    // --- liga, toppliste og status ---
    const st = await api(base, 'dev:m2:Medlem 2', 'GET', '/poker/leagues/klubbkveld-ostlandet/standings');
    assert.equal(st.status, 200);
    assert.equal(st.body.standings.length, N);
    assert.equal(st.body.standings[0].userId, tr.placings[0].userId);
    assert.equal(st.body.standings[0].points, leaguePoints(N, 1));
    assert.equal(st.body.standings.at(-1).points, leaguePoints(N, tr.placings.at(-1).place), 'sistemann (delt plass mulig)');

    const lb = await api(base, 'dev:m2:Medlem 2', 'GET', '/poker/leaderboard');
    assert.equal(lb.body.players.length, N);

    const detail = await api(base, 'dev:m2:Medlem 2', 'GET', `/poker/tournaments/${sid}`);
    assert.equal(detail.body.status, 'finished');
    assert.equal(detail.body.results.length, N);

    // --- ny sesong ---
    const season = await api(base, ADMIN, 'POST', '/poker/admin/seasons', { name: 'Vår 2027' });
    assert.equal(season.status, 201);
    assert.equal(season.body.carried, N);
    const cur = await api(base, ADMIN, 'GET', '/poker/seasons/current');
    assert.equal(cur.body.name, 'Vår 2027');
    const lb2 = await api(base, ADMIN, 'GET', '/poker/leaderboard');
    assert.equal(lb2.body.players.length, 0, 'ny sesong: ingen har spilt ennå');
    const winnerStats = await api(base, ADMIN, 'GET', `/poker/players/${tr.placings[0].userId}`);
    assert.equal(winnerStats.body.gamesPlayed, 0);
    assert.ok(winnerStats.body.rating > 1000, 'ferdigheten følger med over i ny sesong');

    for (const c of clients) c.close();
  } finally {
    await poker.close();
  }
}

test('klubbkveld: admin, påmelding, flerbordsturnering, liga og ny sesong (minne)', async () => {
  await clubNight(createMemoryStore());
});

test('klubbkveld med Postgres', { skip: !pgUrl && 'PG_TEST_URL ikke satt' }, async () => {
  const store = await createPostgresStore(pgUrl);
  await store.pool.query(
    'TRUNCATE poker_registrations, poker_scheduled, poker_hand_actions, poker_hands, poker_entries, poker_ratings, poker_tournaments, poker_leagues, poker_players, poker_flags CASCADE',
  );
  await store.pool.query(`DELETE FROM poker_seasons; INSERT INTO poker_seasons (name, starts_at) VALUES ('Sesong 1', now() - interval '1 minute')`);
  try {
    await clubNight(store);
  } finally {
    await store.close();
  }
});

test('planlagt turnering med for få påmeldte avlyses og varsler', async () => {
  const { poker, base, port, membership } = await startTestServer();
  try {
    membership.setDevMember('solo', { aktiv: true, aldersgruppe: 'ungdom', husstand: true, over16: true });
    const c = await connect(port, 'dev:solo:Solo');
    const s = await api(base, 'dev:admin:Styret', 'POST', '/poker/admin/tournaments', {
      name: 'Tynn kveld',
      startAt: new Date(Date.now() + 300).toISOString(),
      maxPlayers: 10,
    });
    await api(base, 'dev:solo:Solo', 'POST', `/poker/tournaments/${s.body.id}/register`);
    const msg = await c.waitFor((m) => m.type === 'scheduled.cancelled', 5_000);
    assert.equal(msg.scheduledId, s.body.id);
    const d = await api(base, 'dev:solo:Solo', 'GET', `/poker/tournaments/${s.body.id}`);
    assert.equal(d.body.status, 'cancelled');
    // Full turnering
    const full = await api(base, 'dev:admin:Styret', 'POST', '/poker/admin/tournaments', {
      name: 'Liten',
      startAt: new Date(Date.now() + 60_000).toISOString(),
      maxPlayers: 2,
    });
    membership.setDevMember('a1', { aktiv: true, aldersgruppe: 'voksen' });
    membership.setDevMember('a2', { aktiv: true, aldersgruppe: 'voksen' });
    assert.equal((await api(base, 'dev:a1:A1', 'POST', `/poker/tournaments/${full.body.id}/register`)).status, 200);
    assert.equal((await api(base, 'dev:a2:A2', 'POST', `/poker/tournaments/${full.body.id}/register`)).status, 200);
    const third = await api(base, 'dev:solo:Solo', 'POST', `/poker/tournaments/${full.body.id}/register`);
    assert.equal(third.status, 409);
    assert.equal(third.body.error, 'full');
    // Admin kan avlyse
    assert.equal((await api(base, 'dev:admin:Styret', 'DELETE', `/poker/admin/tournaments/${full.body.id}`)).status, 200);
    c.close();
  } finally {
    await poker.close();
  }
});
