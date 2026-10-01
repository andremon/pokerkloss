// SMS-innlogging: engangskode via Ayno Connect → Arena-JWT.
//
//   POST /auth/otp/request { phone }        → { ok, expiresInSeconds, devCode? }
//   POST /auth/otp/verify  { phone, code }  → { token, userId, name, needsName }
//
// Sikkerhet: koden lagres bare som hash (SHA-256 med OTP_PEPPER), maks 5 forsøk per kode,
// 30 sek mellom hver SMS til samme nummer, maks 5 SMS per nummer per time og
// maks 20 forespørsler per IP per 10 min. Telefonnummeret vises aldri for andre spillere.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { normalizePhone } from './ayno.js';

const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30_000;
const PHONE_LIMIT = { max: 5, windowMs: 60 * 60_000 };
const IP_LIMIT = { max: 20, windowMs: 10 * 60_000 };

function limiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

export function createOtpRouter({ config, store, ayno, issuer, onLogin, log = console }) {
  const router = Router();
  const perPhone = limiter(PHONE_LIMIT);
  const perIp = limiter(IP_LIMIT);
  const hash = (phone, code) => createHash('sha256').update(`${config.otpPepper}:${phone}:${code}`).digest('hex');
  const devMode = config.devAuth && !ayno.configured;

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e.status ?? 500;
      if (status === 500) log.error?.('[otp]', e);
      res.status(status).json({ error: e.code ?? 'error', message: e.message });
    });

  router.post(
    '/request',
    wrap(async (req, res) => {
      if (!issuer) throw httpError(503, 'not_configured', 'SMS-innlogging er ikke satt opp (ARENA_JWT_PRIVATE_KEY mangler)');
      if (!ayno.configured && !devMode) throw httpError(503, 'not_configured', 'SMS-innlogging er ikke satt opp (AYNO_* mangler)');
      const phone = normalizePhone(req.body?.phone);
      if (!phone) throw httpError(400, 'phone', 'Ugyldig telefonnummer');
      if (!perIp(req.ip)) throw httpError(429, 'rate_limit', 'For mange forespørsler. Prøv igjen om litt.');
      const existing = await store.getOtp(phone);
      if (existing && Date.now() - new Date(existing.lastSentAt).getTime() < COOLDOWN_MS) {
        throw httpError(429, 'cooldown', 'Vent litt før du ber om en ny kode.');
      }
      if (!perPhone(phone)) throw httpError(429, 'rate_limit', 'For mange koder til dette nummeret. Prøv igjen senere.');

      const code = String(randomInt(100000, 1000000));
      const expiresAt = new Date(Date.now() + config.otpTtlMin * 60_000);
      await store.saveOtp(phone, { codeHash: hash(phone, code), expiresAt });
      const text = `PokerKloss: engangskoden din er ${code}. Gyldig i ${config.otpTtlMin} minutter.`;
      if (devMode) {
        return res.json({ ok: true, expiresInSeconds: config.otpTtlMin * 60, devCode: code });
      }
      try {
        await ayno.send(phone, text);
      } catch (e) {
        await store.deleteOtp(phone);
        log.error?.('[otp] SMS feilet', e.message);
        throw httpError(502, 'sms_failed', 'Kunne ikke sende SMS akkurat nå. Prøv igjen snart.');
      }
      res.json({ ok: true, expiresInSeconds: config.otpTtlMin * 60 });
    }),
  );

  router.post(
    '/verify',
    wrap(async (req, res) => {
      if (!issuer) throw httpError(503, 'not_configured', 'SMS-innlogging er ikke satt opp');
      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code ?? '').trim();
      if (!phone || !/^\d{6}$/.test(code)) throw httpError(400, 'input', 'Telefonnummer og sekssifret kode kreves');
      if (!perIp(`v:${req.ip}`)) throw httpError(429, 'rate_limit', 'For mange forsøk. Prøv igjen om litt.');
      const row = await store.getOtp(phone);
      if (!row) throw httpError(400, 'no_request', 'Be om en ny kode.');
      if (new Date(row.expiresAt) < new Date()) {
        await store.deleteOtp(phone);
        throw httpError(410, 'expired', 'Koden er utløpt. Be om en ny.');
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        await store.deleteOtp(phone);
        throw httpError(429, 'too_many', 'For mange feil forsøk. Be om en ny kode.');
      }
      const a = Buffer.from(hash(phone, code), 'hex');
      const b = Buffer.from(row.codeHash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        await store.bumpOtpAttempts(phone);
        throw httpError(401, 'bad_code', 'Feil kode.');
      }
      await store.deleteOtp(phone);
      const sub = `tel:${phone}`;
      const player = await onLogin(sub);
      // Navnet i tokenet er kallenavnet – aldri telefonnummeret.
      const token = await issuer.issue(sub, { name: player.name });
      res.json({ token, userId: sub, name: player.name, needsName: player.needsName, expiresInDays: config.tokenDays });
    }),
  );

  return router;
}
