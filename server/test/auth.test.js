// Ekte AuthArena-flyt: RS256 Arena-JWT + MedlemArena /api/v1/status, uten dev-innlogging.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { generateKeyPair, exportSPKI, exportJWK, SignJWT, jwtVerify } from 'jose';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/auth.js';
import { createMembership } from '../src/membership.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createPokerServer } from '../src/app.js';

let keys, otherKeys, medlem, medlemUrl, medlemDown = false;
const members = {
  'otp:+4790000001': { aktiv: true, gyldigTil: '2099-01-01', aldersgruppe: 'voksen' },
  'otp:+4790000002': { aktiv: true, gyldigTil: '2099-01-01', aldersgruppe: 'ungdom' }, // uten husstand/over16
  'otp:+4790000003': { aktiv: true, gyldigTil: '2099-01-01', aldersgruppe: 'ungdom', husstand: true, over16: true },
};

const sign = (claims, { key = keys.privateKey, iss = 'ay.no', exp = '1h' } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(key);

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startPoker(env) {
  const config = loadConfig({ POKER_SCHEDULER_TICK_MS: '50', MEDLEMARENA_URL: medlemUrl, POKER_KREV_MEDLEMSKAP: '1', ...env });
  const auth = createAuth(config);
  const poker = createPokerServer({ config, store: createMemoryStore(), auth, membership: createMembership(config), log: { error: () => {} } });
  const base = await listen(poker.server);
  return { poker, base, port: poker.server.address().port, auth };
}

const get = (base, path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  otherKeys = await generateKeyPair('RS256', { extractable: true });
  // Falsk MedlemArena: verifiserer Arena-JWT som den ekte, og svarer status for «sub».
  const app = express();
  app.get('/api/v1/status', async (req, res) => {
    if (medlemDown) return res.status(503).end();
    try {
      const { payload } = await jwtVerify((req.headers.authorization || '').slice(7), keys.publicKey, { issuer: 'ay.no' });
      const m = members[payload.sub];
      if (!m) return res.json({ aktiv: false, gyldigTil: null, aldersgruppe: null });
      res.json(m);
    } catch {
      res.status(401).end();
    }
  });
  app.get('/.well-known/jwks.json', async (req, res) => res.json({ keys: [{ ...(await exportJWK(keys.publicKey)), alg: 'RS256', use: 'sig', kid: 'arena-1' }] }));
  medlem = http.createServer(app);
  medlemUrl = await listen(medlem);
});

after(() => medlem.close());

test('Arena-JWT med offentlig nøkkel (PEM med \\n slik Railway lagrer den)', async () => {
  const pem = (await exportSPKI(keys.publicKey)).replace(/\n/g, '\\n');
  const { poker, base, port, auth } = await startPoker({ ARENA_JWT_PUBLIC_KEY: pem, POKER_ADMIN_IDS: 'otp:+4790000001' });
  try {
    assert.equal(auth.mode, 'public-key');
    const kari = await sign({ sub: 'otp:+4790000001', name: 'Kari Nordmann', role: 'user' });
    const me = await get(base, '/poker/me', kari);
    assert.equal(me.status, 200);
    assert.equal(me.body.userId, 'otp:+4790000001');
    assert.equal(me.body.name, 'Kari Nordmann');
    assert.equal(me.body.rated, true);
    assert.equal(me.body.admin, true);

    // Avvisninger
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'x' }, { iss: 'feil.no' }))).status, 401, 'feil issuer');
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'x' }, { key: otherKeys.privateKey }))).status, 401, 'feil nøkkel');
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'x' }, { exp: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, 'utløpt');
    assert.equal((await get(base, '/poker/me', await sign({ name: 'uten sub' }))).status, 401, 'mangler sub');
    assert.equal((await get(base, '/poker/me', 'dev:kari:Kari')).status, 401, 'dev-token avvist når dev er av');
    assert.equal((await get(base, '/poker/me')).status, 401);

    // Aldersregler via MedlemArena
    const ung = await get(base, '/poker/me', await sign({ sub: 'otp:+4790000002', name: 'Ung' }));
    assert.equal(ung.body.rated, false);
    assert.match(ung.body.ratedReason, /16 år ved familieinnmelding/);
    const fam = await get(base, '/poker/me', await sign({ sub: 'otp:+4790000003', name: 'Familie' }));
    assert.equal(fam.body.rated, true);
    const ikke = await get(base, '/poker/me', await sign({ sub: 'google:123', name: 'Ikke medlem' }));
    assert.equal(ikke.body.rated, false);
    assert.match(ikke.body.ratedReason, /aktivt medlemskap/);

    // WebSocket med ekte token
    const ws = new WebSocket(`ws://127.0.0.1:${port}/poker/ws?token=${encodeURIComponent(kari)}`);
    const hello = await new Promise((resolve, reject) => {
      ws.once('message', (m) => resolve(JSON.parse(m.toString())));
      ws.once('error', reject);
    });
    assert.equal(hello.userId, 'otp:+4790000001');
    ws.close();
  } finally {
    await poker.close();
  }
});

test('Arena-JWT via JWKS-endepunkt', async () => {
  const { poker, base, auth } = await startPoker({ AUTHARENA_JWKS_URL: `${medlemUrl}/.well-known/jwks.json` });
  try {
    assert.equal(auth.mode, 'jwks');
    const t = await sign({ sub: 'otp:+4790000001', name: 'Kari' });
    assert.equal((await get(base, '/poker/me', t)).status, 200);
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'x' }, { key: otherKeys.privateKey }))).status, 401);
  } finally {
    await poker.close();
  }
});

test('audience sjekkes bare når AUTHARENA_AUDIENCE er satt', async () => {
  const pem = await exportSPKI(keys.publicKey);
  const { poker, base } = await startPoker({ ARENA_JWT_PUBLIC_KEY: pem, AUTHARENA_AUDIENCE: 'pokerkloss' });
  try {
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'otp:+4790000001', aud: 'pokerkloss' }))).status, 200);
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'otp:+4790000001', aud: 'borsarena' }))).status, 401);
  } finally {
    await poker.close();
  }
});

test('MedlemArena nede: siste kjente svar brukes, ellers tydelig melding', async () => {
  const pem = await exportSPKI(keys.publicKey);
  const { poker, base } = await startPoker({ ARENA_JWT_PUBLIC_KEY: pem });
  try {
    medlemDown = true;
    const ny = await get(base, '/poker/me', await sign({ sub: 'otp:+4790000003', name: 'F' }));
    assert.equal(ny.body.rated, false);
    assert.match(ny.body.ratedReason, /medlemsregisteret/);
    medlemDown = false;
    const t = await sign({ sub: 'otp:+4790000001', name: 'K' });
    assert.equal((await get(base, '/poker/me', t)).body.rated, true);
    medlemDown = true;
    assert.equal((await get(base, '/poker/me', t)).body.rated, true, 'bruker siste kjente svar');
  } finally {
    medlemDown = false;
    await poker.close();
  }
});

test('ingen nøkkel og ikke dev: ingen kan logge inn', async () => {
  const { poker, base, auth } = await startPoker({});
  try {
    assert.equal(auth.mode, 'none');
    assert.equal((await get(base, '/poker/me', await sign({ sub: 'otp:+4790000001' }))).status, 401);
  } finally {
    await poker.close();
  }
});
