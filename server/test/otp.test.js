// SMS-innlogging: engangskode via (falsk) Ayno Connect → Arena-JWT → spill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { generateKeyPair, exportPKCS8, exportSPKI, jwtVerify, importSPKI } from 'jose';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/auth.js';
import { createMembership } from '../src/membership.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createPokerServer } from '../src/app.js';

let privatePemEscaped, publicPem, ayno, aynoUrl;
const sent = [];
let aynoFail = false;

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privatePemEscaped = (await exportPKCS8(keys.privateKey)).trim().replace(/\n/g, '\\n');
  publicPem = await exportSPKI(keys.publicKey);
  // Falsk Ayno Connect med samme kontrakt som sms.ay.no
  const app = express();
  app.use(express.json());
  app.post('/api/3rdparty/v1/message', (req, res) => {
    if (req.headers.authorization !== 'Bearer sk_test_ayno') return res.status(401).json({ error: 'bad key' });
    if (aynoFail) return res.status(500).json({ error: 'gateway nede' });
    sent.push(req.body);
    res.json({ status: 'sent', messageId: `m${sent.length}`, queued: 1, tenant: 'Ayno Connect' });
  });
  ayno = http.createServer(app);
  aynoUrl = await listen(ayno);
});

after(() => ayno.close());

async function start(env = {}) {
  const config = loadConfig({
    ARENA_JWT_PRIVATE_KEY: privatePemEscaped,
    AYNO_BASE_URL: aynoUrl,
    AYNO_API_KEY: 'sk_test_ayno',
    OTP_PEPPER: 'pepper',
    POKER_SCHEDULER_TICK_MS: '50',
    ...env,
  });
  const store = createMemoryStore();
  const poker = createPokerServer({ config, store, auth: createAuth(config), membership: createMembership(config), log: { error: () => {} } });
  const base = await listen(poker.server);
  return { poker, base, store };
}

const call = (base, method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.1` },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const lastCodeTo = (phone) => [...sent].reverse().find((m) => m.to === phone)?.message.match(/\b(\d{6})\b/)?.[1];

test('full SMS-innlogging: kode, token, kallenavn, aldersbekreftelse og ratet kø', async () => {
  const { poker, base } = await start();
  try {
    const r = await call(base, 'POST', '/auth/otp/request', { phone: '922 00 977' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.devCode, undefined, 'koden returneres aldri i produksjon');
    const msg = sent.at(-1);
    assert.equal(msg.to, '+4792200977');
    assert.equal(msg.sender, 'PokerKloss');
    assert.match(msg.message, /PokerKloss: engangskoden din er \d{6}/);
    const code = lastCodeTo('+4792200977');

    // Rask ny forespørsel stoppes
    assert.equal((await call(base, 'POST', '/auth/otp/request', { phone: '92200977' })).status, 429);

    // Feil kode, så riktig
    const wrong = code === '111111' ? '222222' : '111111';
    assert.equal((await call(base, 'POST', '/auth/otp/verify', { phone: '92200977', code: wrong })).status, 401);
    const v = await call(base, 'POST', '/auth/otp/verify', { phone: '+47 922 00 977', code });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.userId, 'tel:+4792200977');
    assert.match(v.body.name, /^Spiller-[A-Z0-9]{4}$/);
    assert.equal(v.body.needsName, true);
    // Koden kan ikke brukes to ganger
    assert.equal((await call(base, 'POST', '/auth/otp/verify', { phone: '92200977', code })).status, 400);

    // Tokenet er en ekte Arena-JWT som andre tjenester med den offentlige nøkkelen godtar
    const { payload } = await jwtVerify(v.body.token, await importSPKI(publicPem, 'RS256'), { issuer: 'ay.no' });
    assert.equal(payload.sub, 'tel:+4792200977');
    assert.equal(payload.login, 'otp');
    assert.ok(!JSON.stringify(payload).includes('92200977') || payload.sub.includes('92200977'), 'nummer bare i sub');
    assert.ok(!String(payload.name).includes('922'), 'navnet i tokenet er ikke telefonnummeret');
    assert.ok(payload.exp - payload.iat >= 29 * 86400);

    const t = v.body.token;
    let me = await call(base, 'GET', '/poker/me', null, t);
    assert.equal(me.status, 200);
    assert.equal(me.body.rated, false);
    assert.match(me.body.ratedReason, /18 år/);
    assert.equal(me.body.requireMembership, false);

    // Kallenavn
    assert.equal((await call(base, 'PUT', '/poker/me/name', { name: '92200977' }, t)).status, 400);
    assert.equal((await call(base, 'PUT', '/poker/me/name', { name: 'x' }, t)).status, 400);
    assert.equal((await call(base, 'PUT', '/poker/me/name', { name: 'Ai-Bot Ask' }, t)).status, 400);
    assert.equal((await call(base, 'PUT', '/poker/me/name', { name: 'Andre Ess' }, t)).status, 200);

    // Aldersbekreftelse → ratet
    assert.equal((await call(base, 'POST', '/poker/me/confirm-age', { over18: 'ja' }, t)).status, 400);
    assert.equal((await call(base, 'POST', '/poker/me/confirm-age', { over18: true }, t)).status, 200);
    me = await call(base, 'GET', '/poker/me', null, t);
    assert.equal(me.body.name, 'Andre Ess');
    assert.equal(me.body.needsName, false);
    assert.equal(me.body.rated, true);
    const q = await call(base, 'POST', '/poker/sng/queue', { format: 'hu' }, t);
    assert.equal(q.status, 200);

    // En annen bruker kan ikke ta samme kallenavn
    await call(base, 'POST', '/auth/otp/request', { phone: '98765432' });
    const v2 = await call(base, 'POST', '/auth/otp/verify', { phone: '98765432', code: lastCodeTo('+4798765432') });
    const taken = await call(base, 'PUT', '/poker/me/name', { name: 'andre ess' }, v2.body.token);
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'name_taken');
    // Uten bekreftet alder: ingen ratet kø
    assert.equal((await call(base, 'POST', '/poker/sng/queue', { format: 'hu' }, v2.body.token)).status, 403);
  } finally {
    await poker.close();
  }
});

test('for mange feil forsøk sperrer koden', async () => {
  const { poker, base } = await start();
  try {
    await call(base, 'POST', '/auth/otp/request', { phone: '41111111' });
    const code = lastCodeTo('+4741111111');
    const wrong = code === '000000' ? '999999' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await call(base, 'POST', '/auth/otp/verify', { phone: '41111111', code: wrong })).status, 401);
    const blocked = await call(base, 'POST', '/auth/otp/verify', { phone: '41111111', code });
    assert.equal(blocked.status, 429, 'selv riktig kode avvises etter 5 feil');
  } finally {
    await poker.close();
  }
});

test('utløpt kode, Ayno nede, ugyldig nummer og manglende nøkkel', async () => {
  const exp = await start({ OTP_TTL_MIN: '0' });
  try {
    await call(exp.base, 'POST', '/auth/otp/request', { phone: '42222222' });
    await new Promise((r) => setTimeout(r, 5));
    const r = await call(exp.base, 'POST', '/auth/otp/verify', { phone: '42222222', code: lastCodeTo('+4742222222') });
    assert.equal(r.status, 410);
    assert.equal((await call(exp.base, 'POST', '/auth/otp/request', { phone: 'abc' })).status, 400);
    aynoFail = true;
    const f = await call(exp.base, 'POST', '/auth/otp/request', { phone: '43333333' });
    assert.equal(f.status, 502);
    aynoFail = false;
    assert.equal((await call(exp.base, 'POST', '/auth/otp/request', { phone: '43333333' })).status, 200, 'kan prøve igjen med en gang etter SMS-feil');
  } finally {
    aynoFail = false;
    await exp.poker.close();
  }
  const nokey = await start({ ARENA_JWT_PRIVATE_KEY: '' });
  try {
    const r = await call(nokey.base, 'POST', '/auth/otp/request', { phone: '44444444' });
    assert.equal(r.status, 503);
    assert.match(r.body.message, /ARENA_JWT_PRIVATE_KEY/);
  } finally {
    await nokey.poker.close();
  }
});

test('dev-modus uten Ayno returnerer koden i svaret', async () => {
  const { poker, base } = await start({ AYNO_BASE_URL: '', POKER_DEV_AUTH: '1' });
  try {
    const r = await call(base, 'POST', '/auth/otp/request', { phone: '45555555' });
    assert.equal(r.status, 200);
    assert.match(r.body.devCode, /^\d{6}$/);
    const v = await call(base, 'POST', '/auth/otp/verify', { phone: '45555555', code: r.body.devCode });
    assert.equal(v.status, 200);
  } finally {
    await poker.close();
  }
});

test('med POKER_KREV_MEDLEMSKAP=1 og uten MedlemArena: ingen ratet spill', async () => {
  const { poker, base } = await start({ POKER_KREV_MEDLEMSKAP: '1' });
  try {
    await call(base, 'POST', '/auth/otp/request', { phone: '46666666' });
    const v = await call(base, 'POST', '/auth/otp/verify', { phone: '46666666', code: lastCodeTo('+4746666666') });
    await call(base, 'POST', '/poker/me/confirm-age', { over18: true }, v.body.token);
    const me = await call(base, 'GET', '/poker/me', null, v.body.token);
    assert.equal(me.body.rated, false);
    assert.match(me.body.ratedReason, /MEDLEMARENA_URL/);
  } finally {
    await poker.close();
  }
});
