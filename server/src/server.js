import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { createMembership } from './membership.js';
import { createMemoryStore } from './store/memory.js';
import { createPostgresStore } from './store/postgres.js';
import { createPokerServer } from './app.js';

// «npm run dev» (eller --dev) slår på dev-innlogging og /dev-klienten, også på Windows.
if (process.argv.includes('--dev')) process.env.POKER_DEV_AUTH = '1';
const config = loadConfig();
if (config.devAuth && process.env.NODE_ENV === 'production') {
  console.error('POKER_DEV_AUTH kan ikke brukes i produksjon.');
  process.exit(1);
}
const store = config.databaseUrl ? await createPostgresStore(config.databaseUrl) : createMemoryStore();
const auth = createAuth(config);
const membership = createMembership(config);

if (config.devAuth && config.requireMembership && !config.medlemArenaUrl) {
  // Utvikling uten MedlemArena: «dev:*»-brukere regnes som voksne medlemmer, så ratet spill kan testes.
  const orig = membership.eligibility;
  membership.eligibility = async (userId, token) =>
    token?.startsWith('dev:') ? { rated: true, reason: null } : orig(userId, token);
  const origKnown = membership.lastKnown;
  membership.lastKnown = (userId) => origKnown(userId) ?? { rated: true, reason: null };
}

const poker = createPokerServer({ config, store, auth, membership });
poker.server.listen(config.port, () => {
  const authTxt = { 'public-key': 'AuthArena (offentlig nøkkel)', jwks: 'AuthArena (JWKS)', none: 'INGEN AuthArena-nøkkel' }[auth.mode];
  console.log(`PokerKloss-server på port ${config.port}`);
  console.log(`  lager: ${store.kind} · innlogging: ${authTxt}${config.devAuth ? ' + dev-innlogging' : ''} · issuer: ${config.arenaIssuer}`);
  const smsTxt = config.arenaPrivateKey ? (config.ayno.baseUrl && config.ayno.apiKey ? `på (${config.ayno.baseUrl})` : 'nøkkel OK, men AYNO_* mangler') : 'av (ARENA_JWT_PRIVATE_KEY mangler)';
  console.log(`  SMS-innlogging: ${smsTxt}`);
  console.log(`  ratet spill: ${config.requireMembership ? `krever medlemskap (${config.medlemArenaUrl ?? 'MEDLEMARENA_URL mangler!'})` : 'alle innloggede som har bekreftet 18 år'} · admin: ${config.adminIds.length ? config.adminIds.join(', ') : 'ingen'}`);
  if (auth.mode === 'none' && !config.devAuth) console.warn('  ADVARSEL: ingen kan logge inn. Sett ARENA_JWT_PUBLIC_KEY eller AUTHARENA_JWKS_URL.');
});

const shutdown = async () => {
  await poker.close();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
