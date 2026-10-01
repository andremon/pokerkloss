// Etterprøvbar stokking (commit–reveal).
//
// 1. Serveren lager en hemmelig seed (32 tilfeldige bytes) før hånden.
// 2. seedHash = SHA-256(seed) publiseres til alle ved hand.start.
// 3. Kortstokken stokkes deterministisk fra seed med Fisher-Yates, der
//    tilfeldighetene hentes fra en HMAC-SHA256-strøm (seed som nøkkel).
// 4. Seed avsløres ved hand.end. Alle kan da sjekke at SHA-256(seed) = seedHash
//    og at shuffleDeck(seed) gir nøyaktig de kortene som ble delt.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { freshDeck } from './cards.js';

export function newSeed() {
  return randomBytes(32).toString('hex');
}

export function hashSeed(seed) {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/** Deterministisk byte-strøm fra seed. */
function byteStream(seed) {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return function nextByte() {
    if (pos >= buf.length) {
      buf = createHmac('sha256', seed).update(`deck:${counter++}`).digest();
      pos = 0;
    }
    return buf[pos++];
  };
}

/** Uniformt heltall i [0, n) uten modulo-skjevhet (avvisningssampling). */
function uniformInt(nextByte, n) {
  // n <= 52, så 32 bit holder godt.
  const max = 0x100000000;
  const limit = max - (max % n);
  for (;;) {
    const x = ((nextByte() << 24) >>> 0) + (nextByte() << 16) + (nextByte() << 8) + nextByte();
    if (x < limit) return x % n;
  }
}

/** Fisher-Yates-stokking styrt av seed. Samme seed gir alltid samme rekkefølge. */
export function shuffleDeck(seed) {
  if (typeof seed !== 'string' || seed.length < 32) {
    throw new Error('Seed må være en streng på minst 32 tegn');
  }
  const deck = freshDeck();
  const next = byteStream(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = uniformInt(next, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Kontroll som klienter eller revisorer kan kjøre etter hånden. */
export function verifySeed(seed, seedHash) {
  return hashSeed(seed) === seedHash;
}
