// Utsteder Arena-JWT (RS256) – samme format som AuthArena v2 / BørsArena sin OTP-innlogging:
//   sub = 'tel:+47XXXXXXXX', issuer = ARENA_JWT_ISSUER (ay.no), login = 'otp'
// Signeres med ARENA_JWT_PRIVATE_KEY. Alle tjenester med ARENA_JWT_PUBLIC_KEY godtar tokenet.

import { SignJWT, importPKCS8 } from 'jose';
import { normalizePem } from './auth.js';

export function createIssuer(config) {
  if (!config.arenaPrivateKey) return null;
  const keyPromise = importPKCS8(normalizePem(config.arenaPrivateKey), 'RS256');
  keyPromise.catch((e) => console.error(`ARENA_JWT_PRIVATE_KEY kunne ikke leses: ${e.message}`));
  return {
    async issue(sub, claims = {}) {
      let jwt = new SignJWT({ login: 'otp', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(sub)
        .setIssuer(config.arenaIssuer)
        .setIssuedAt()
        .setExpirationTime(`${config.tokenDays}d`);
      if (config.authArenaAudience) jwt = jwt.setAudience(config.authArenaAudience);
      return jwt.sign(await keyPromise);
    },
  };
}
