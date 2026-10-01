// Postgres-lager (Railway). Samme grensesnitt som minnelageret.

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { newRating, displayRating, seasonReset } from '@arena/poker-rating';
import { leaguePoints } from './memory.js';

export async function migrate(pool) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function createPostgresStore(databaseUrl, { runMigrations = true } = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  if (runMigrations) await migrate(pool);

  async function currentSeason() {
    const { rows } = await pool.query(
      `SELECT id FROM poker_seasons WHERE starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
       ORDER BY starts_at DESC LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  const mapRating = (r) => ({
    userId: r.user_id,
    mu: r.mu,
    sigma: r.sigma,
    display: r.display,
    gamesPlayed: r.games_played,
    wins: r.wins,
  });

  const mapScheduled = (r) => ({
    id: r.id,
    name: r.name,
    startAt: r.start_at,
    maxPlayers: r.max_players,
    maxSeats: r.max_seats,
    structure: r.structure,
    leagueId: r.league_id,
    status: r.status,
    tournamentId: r.tournament_id,
    createdBy: r.created_by,
    registered: r.registered,
  });

  return {
    kind: 'postgres',
    pool,
    currentSeason,
    async upsertPlayer({ userId, name }) {
      await pool.query(
        `INSERT INTO poker_players (user_id, display_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [userId, name],
      );
    },
    async ensurePlayer({ userId, name }) {
      const { rows } = await pool.query(
        `INSERT INTO poker_players (user_id, display_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING user_id, display_name, age_confirmed_at`,
        [userId, name],
      );
      return { userId: rows[0].user_id, name: rows[0].display_name, ageConfirmed: !!rows[0].age_confirmed_at };
    },
    async getPlayer(userId) {
      const { rows } = await pool.query('SELECT user_id, display_name, age_confirmed_at FROM poker_players WHERE user_id = $1', [userId]);
      return rows[0] ? { userId: rows[0].user_id, name: rows[0].display_name, ageConfirmed: !!rows[0].age_confirmed_at } : null;
    },
    async setDisplayName(userId, name) {
      const taken = await pool.query('SELECT 1 FROM poker_players WHERE lower(display_name) = lower($1) AND user_id <> $2', [name, userId]);
      if (taken.rows.length) throw Object.assign(new Error('Kallenavnet er opptatt'), { status: 409, code: 'name_taken' });
      const { rowCount } = await pool.query('UPDATE poker_players SET display_name = $2 WHERE user_id = $1', [userId, name]);
      if (!rowCount) throw Object.assign(new Error('Ukjent spiller'), { status: 404, code: 'not_found' });
    },
    async confirmAge(userId) {
      await pool.query('UPDATE poker_players SET age_confirmed_at = COALESCE(age_confirmed_at, now()) WHERE user_id = $1', [userId]);
    },
    async saveOtp(phone, { codeHash, expiresAt }) {
      await pool.query(
        `INSERT INTO poker_otp (phone, code_hash, expires_at, attempts, last_sent_at) VALUES ($1, $2, $3, 0, now())
         ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, last_sent_at = now()`,
        [phone, codeHash, expiresAt],
      );
    },
    async getOtp(phone) {
      const { rows } = await pool.query('SELECT * FROM poker_otp WHERE phone = $1', [phone]);
      const r = rows[0];
      return r ? { phone: r.phone, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: r.attempts, lastSentAt: r.last_sent_at } : null;
    },
    async bumpOtpAttempts(phone) {
      await pool.query('UPDATE poker_otp SET attempts = attempts + 1 WHERE phone = $1', [phone]);
    },
    async deleteOtp(phone) {
      await pool.query('DELETE FROM poker_otp WHERE phone = $1', [phone]);
    },
    async getRating(userId, season) {
      season ??= await currentSeason();
      const { rows } = await pool.query('SELECT * FROM poker_ratings WHERE user_id = $1 AND season_id = $2', [userId, season]);
      return rows[0] ? mapRating(rows[0]) : null;
    },
    async getRatings(userIds, season) {
      season ??= await currentSeason();
      const { rows } = await pool.query('SELECT * FROM poker_ratings WHERE user_id = ANY($1) AND season_id = $2', [
        userIds,
        season,
      ]);
      return new Map(rows.map((r) => [r.user_id, mapRating(r)]));
    },
    async createTournament({ id, format, rated, seasonId, leagueId, structure }) {
      await pool.query(
        `INSERT INTO poker_tournaments (id, format, rated, season_id, league_id, blind_structure, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
        [id, format, rated, seasonId ?? null, leagueId ?? null, JSON.stringify(structure)],
      );
    },
    async finishTournament({ id, seasonId, results }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE poker_tournaments SET status = 'finished', finished_at = now(), entrants = $2 WHERE id = $1`, [
          id,
          results.length,
        ]);
        for (const r of results) {
          await client.query(
            `INSERT INTO poker_entries (tournament_id, user_id, placement, mu_before, mu_after, display_delta)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, r.userId, r.placement, r.rating?.before.mu ?? null, r.rating?.after.mu ?? null, r.rating?.delta ?? null],
          );
          if (!r.rating) continue;
          await client.query(
            `INSERT INTO poker_ratings (user_id, season_id, mu, sigma, display, games_played, wins)
             VALUES ($1, $2, $3, $4, $5, 1, $6)
             ON CONFLICT (user_id, season_id) DO UPDATE SET
               mu = EXCLUDED.mu, sigma = EXCLUDED.sigma, display = EXCLUDED.display,
               games_played = poker_ratings.games_played + 1,
               wins = poker_ratings.wins + EXCLUDED.wins,
               updated_at = now()`,
            [r.userId, seasonId, r.rating.after.mu, r.rating.after.sigma, r.rating.displayAfter, r.placement === 1 ? 1 : 0],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async saveHand(h) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO poker_hands (id, tournament_id, seed_hash, seed, button_seat, board, players, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [h.id, h.tournamentId, h.seedHash, h.seed, h.buttonSeat, h.board, JSON.stringify(h.players), JSON.stringify(h.result)],
        );
        let seq = 0;
        for (const a of h.actions) {
          await client.query(
            `INSERT INTO poker_hand_actions (hand_id, seq, street, seat, type, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
            [h.id, seq++, a.street, a.seat, a.type, a.amount],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async getHand(id) {
      const { rows } = await pool.query('SELECT * FROM poker_hands WHERE id = $1', [id]);
      if (!rows[0]) return null;
      const h = rows[0];
      const acts = await pool.query('SELECT street, seat, type, amount FROM poker_hand_actions WHERE hand_id = $1 ORDER BY seq', [id]);
      return {
        id: h.id,
        tournamentId: h.tournament_id,
        seedHash: h.seed_hash,
        seed: h.seed,
        buttonSeat: h.button_seat,
        board: h.board,
        players: h.players,
        result: h.result,
        actions: acts.rows,
      };
    },
    async leaderboard(season, limit = 50) {
      season ??= await currentSeason();
      const { rows } = await pool.query(
        `SELECT r.*, p.display_name FROM poker_ratings r JOIN poker_players p USING (user_id)
         WHERE r.season_id = $1 AND r.games_played > 0 ORDER BY r.display DESC LIMIT $2`,
        [season, limit],
      );
      return rows.map((r) => ({ ...mapRating(r), name: r.display_name }));
    },
    async playerStats(userId, season) {
      season ??= await currentSeason();
      const r = await this.getRating(userId, season);
      const { rows } = await pool.query(
        `SELECT e.tournament_id, e.placement, e.display_delta, t.format, t.finished_at
         FROM poker_entries e JOIN poker_tournaments t ON t.id = e.tournament_id
         WHERE e.user_id = $1 ORDER BY t.finished_at DESC NULLS LAST LIMIT 10`,
        [userId],
      );
      return {
        rating: r ? r.display : displayRating(newRating()),
        gamesPlayed: r?.gamesPlayed ?? 0,
        wins: r?.wins ?? 0,
        recent: rows.map((x) => ({
          tournamentId: x.tournament_id,
          placement: x.placement,
          delta: x.display_delta,
          format: x.format,
          finishedAt: x.finished_at,
        })),
      };
    },

    async getSeason() {
      const { rows } = await pool.query(
        `SELECT id, name, starts_at FROM poker_seasons WHERE starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY starts_at DESC LIMIT 1`,
      );
      return rows[0] ? { id: rows[0].id, name: rows[0].name, startsAt: rows[0].starts_at } : null;
    },
    async newSeason(name) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const old = await client.query(
          `SELECT id FROM poker_seasons WHERE ends_at IS NULL ORDER BY starts_at DESC LIMIT 1 FOR UPDATE`,
        );
        const oldId = old.rows[0]?.id ?? null;
        await client.query(`UPDATE poker_seasons SET ends_at = now() WHERE ends_at IS NULL`);
        const ins = await client.query(`INSERT INTO poker_seasons (name, starts_at) VALUES ($1, now()) RETURNING id`, [name]);
        const id = ins.rows[0].id;
        let carried = 0;
        if (oldId != null) {
          const { rows } = await client.query('SELECT user_id, mu, sigma FROM poker_ratings WHERE season_id = $1', [oldId]);
          for (const r of rows) {
            const next = seasonReset({ mu: r.mu, sigma: r.sigma });
            await client.query(
              `INSERT INTO poker_ratings (user_id, season_id, mu, sigma, display, games_played, wins) VALUES ($1, $2, $3, $4, $5, 0, 0)`,
              [r.user_id, id, next.mu, next.sigma, displayRating(next)],
            );
            carried++;
          }
        }
        await client.query('COMMIT');
        return { id, name, carried };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    // ---------- ligaer ----------
    async createLeague({ id, name }) {
      try {
        await pool.query('INSERT INTO poker_leagues (id, name) VALUES ($1, $2)', [id, name]);
      } catch (e) {
        if (e.code === '23505') throw Object.assign(new Error('Ligaen finnes allerede'), { status: 409, code: 'exists' });
        throw e;
      }
      return { id, name };
    },
    async getLeague(id) {
      const { rows } = await pool.query('SELECT id, name, created_at FROM poker_leagues WHERE id = $1', [id]);
      return rows[0] ? { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at } : null;
    },
    async listLeagues() {
      const { rows } = await pool.query('SELECT id, name, created_at FROM poker_leagues ORDER BY name');
      return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
    },
    async leagueStandings(leagueId, season) {
      season ??= await currentSeason();
      const { rows } = await pool.query(
        `SELECT e.user_id, p.display_name, e.placement, t.entrants
         FROM poker_entries e
         JOIN poker_tournaments t ON t.id = e.tournament_id
         JOIN poker_players p ON p.user_id = e.user_id
         WHERE t.league_id = $1 AND t.season_id = $2 AND t.status = 'finished'`,
        [leagueId, season],
      );
      const table = new Map();
      for (const r of rows) {
        const row = table.get(r.user_id) ?? { userId: r.user_id, name: r.display_name, points: 0, played: 0, wins: 0 };
        row.points += leaguePoints(r.entrants, r.placement);
        row.played += 1;
        row.wins += r.placement === 1 ? 1 : 0;
        table.set(r.user_id, row);
      }
      return [...table.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
    },

    // ---------- planlagte turneringer ----------
    async createScheduled(s) {
      await pool.query(
        `INSERT INTO poker_scheduled (id, name, start_at, max_players, max_seats, structure, league_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.id, s.name, s.startAt, s.maxPlayers, s.maxSeats, s.structure, s.leagueId ?? null, s.createdBy],
      );
      return this.getScheduled(s.id);
    },
    async getScheduled(id) {
      const { rows } = await pool.query(
        `SELECT s.*, (SELECT count(*)::int FROM poker_registrations r WHERE r.scheduled_id = s.id) AS registered
         FROM poker_scheduled s WHERE s.id = $1`,
        [id],
      );
      return rows[0] ? mapScheduled(rows[0]) : null;
    },
    async listScheduled({ statuses = ['open', 'running'] } = {}) {
      const { rows } = await pool.query(
        `SELECT s.*, (SELECT count(*)::int FROM poker_registrations r WHERE r.scheduled_id = s.id) AS registered
         FROM poker_scheduled s WHERE s.status = ANY($1) ORDER BY s.start_at`,
        [statuses],
      );
      return rows.map(mapScheduled);
    },
    async dueScheduled(now = new Date()) {
      const { rows } = await pool.query(
        `SELECT s.*, 0 AS registered FROM poker_scheduled s WHERE s.status = 'open' AND s.start_at <= $1`,
        [now],
      );
      return rows.map(mapScheduled);
    },
    async register(id, userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT status, max_players FROM poker_scheduled WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw Object.assign(new Error('Turneringen finnes ikke'), { status: 404, code: 'not_found' });
        if (rows[0].status !== 'open') throw Object.assign(new Error('Påmeldingen er stengt'), { status: 409, code: 'closed' });
        const exists = await client.query('SELECT 1 FROM poker_registrations WHERE scheduled_id = $1 AND user_id = $2', [id, userId]);
        if (exists.rows.length) {
          await client.query('COMMIT');
          return false;
        }
        const cnt = await client.query('SELECT count(*)::int AS n FROM poker_registrations WHERE scheduled_id = $1', [id]);
        if (cnt.rows[0].n >= rows[0].max_players) throw Object.assign(new Error('Turneringen er full'), { status: 409, code: 'full' });
        await client.query('INSERT INTO poker_registrations (scheduled_id, user_id) VALUES ($1, $2)', [id, userId]);
        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async unregister(id, userId) {
      const { rowCount } = await pool.query(
        `DELETE FROM poker_registrations r USING poker_scheduled s
         WHERE r.scheduled_id = s.id AND s.id = $1 AND r.user_id = $2 AND s.status = 'open'`,
        [id, userId],
      );
      return rowCount > 0;
    },
    async isRegistered(id, userId) {
      const { rows } = await pool.query('SELECT 1 FROM poker_registrations WHERE scheduled_id = $1 AND user_id = $2', [id, userId]);
      return rows.length > 0;
    },
    async registrations(id) {
      const { rows } = await pool.query(
        `SELECT r.user_id, p.display_name FROM poker_registrations r JOIN poker_players p USING (user_id)
         WHERE r.scheduled_id = $1 ORDER BY r.registered_at`,
        [id],
      );
      return rows.map((r) => ({ userId: r.user_id, name: r.display_name }));
    },
    async setScheduledStatus(id, status, tournamentId = null) {
      await pool.query('UPDATE poker_scheduled SET status = $2, tournament_id = COALESCE($3, tournament_id) WHERE id = $1', [
        id,
        status,
        tournamentId,
      ]);
    },
    async close() {
      await pool.end();
    },
  };
}
