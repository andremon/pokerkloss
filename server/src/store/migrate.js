// Kjør: DATABASE_URL=postgres://... npm run migrate
import pg from 'pg';
import { migrate } from './postgres.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL mangler');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
await migrate(pool);
await pool.end();
console.log('PokerKloss-skjema er oppdatert.');
