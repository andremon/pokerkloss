// Innlogging via AuthArena v2.
//
// AuthArena utsteder én felles «Arena-JWT» for alle innloggingsveier
// (OIDC-bytte for Feide/Google/ID-porten, og SMS-engangskode via Ayno Connect):
//   - algoritme RS256, signert med den delte Arena-nøkkelen
//   - issuer  = ARENA_JWT_ISSUER (standard «ay.no»)
//   - claims  = { sub, name, role?, email?, provider?, exp, iat }
//
// PokerKloss verifiserer tokenet LOKALT – ingen kall til AuthArena per forespørsel.
// Nøkkel velges i denne rekkefølgen:
//   1. ARENA_JWT_PUBLIC_KEY  – den offentlige delen av Arena-nøkkelen (PEM, «\n» godtas)
//   2. AUTHARENA_JWKS_URL    – JWKS-endepunkt hos AuthArena (hvis du heller publiserer nøkkelen der)
// AUTHARENA_AUDIENCE er valgfri; settes den, må tokenet ha samme «aud».
//
// Utviklingsmodus (POKER_DEV_AUTH=1 / npm run dev): token «dev:<id>:<navn>» godtas i tillegg.

import { createPublicKey } from 'node:crypto';
import { importSPKI, jwtVerify, createRemoteJWKSet } from 'jose';

export function normalizePem(pem) {
  if (!pem) return null;
  let p = pem.trim().replace(/^"|"$/g, '');
  if (p.includes('\\n')) p = p.replace(/\\n/g, '\n');
  return p;
}

/** Offentlig nøkkel: ARENA_JWT_PUBLIC_KEY, eller avledet fra ARENA_JWT_PRIVATE_KEY. */
export function resolvePublicKey(config) {
  if (config.arenaPublicKey) return normalizePem(config.arenaPublicKey);
  if (config.arenaPrivateKey) {
    try {
      return createPublicKey(normalizePem(config.arenaPrivateKey)).export({ type: 'spki', format: 'pem' }).toString();
    } catch (e) {
      console.error(`ARENA_JWT_PRIVATE_KEY kunne ikke leses: ${e.message}`);
    }
  }
  return null;
}

export function authMode(config) {
  if (resolvePublicKey(config)) return 'public-key';
  if (config.authArenaJwksUrl) return 'jwks';
  return 'none';
}

export function createAuth(config) {
  const mode = authMode(config);
  let keyPromise = null;
  if (mode === 'public-key') {
    keyPromise = importSPKI(resolvePublicKey(config), 'RS256');
    // Gi tydelig feil ved oppstart i stedet for 401 på alle kall.
    keyPromise.catch((e) => console.error(`ARENA_JWT_PUBLIC_KEY kunne ikke leses: ${e.message}`));
  }
  const jwks = mode === 'jwks' ? createRemoteJWKSet(new URL(config.authArenaJwksUrl)) : null;
  const options = {
    algorithms: ['RS256'],
    issuer: config.arenaIssuer,
    ...(config.authArenaAudience ? { audience: config.authArenaAudience } : {}),
    clockTolerance: 30,
  };

  const verifyToken = async function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    if (config.devAuth && token.startsWith('dev:')) {
      const [, id, name] = token.split(':');
      if (!id) return null;
      return { userId: id, name: (name || id).slice(0, 40), role: 'dev' };
    }
    if (mode === 'none') return null;
    try {
      const key = mode === 'public-key' ? await keyPromise : jwks;
      const { payload } = await jwtVerify(token, key, options);
      if (!payload.sub) return null;
      return {
        userId: String(payload.sub),
        name: String(payload.name ?? payload.given_name ?? 'Spiller').slice(0, 40),
        role: payload.role ?? null,
        exp: payload.exp ?? null,
      };
    } catch {
      return null;
    }
  };
  verifyToken.mode = mode;
  return verifyToken;
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
