// Minnelager – samme grensesnitt som Postgres-lageret. Brukes i utvikling og tester.

import { newRating, displayRating, seasonReset } from '@arena/poker-rating';

/** Ligapoeng for én turnering: antall spillere du endte foran + 1. Vinneren av 20 får 20, sistemann 1. */
export function leaguePoints(entrants, place) {
  return Math.max(1, entrants - place + 1);
}

export function createMemoryStore() {
  const players = new Map();
  const ratings = new Map(); // `${userId}:${seasonId}` -> rating
  const tournaments = new Map();
  const entries = [];
  const hands = new Map();
  const seasons = [{ id: 1, name: 'Sesong 1', startsAt: new Date(), endsAt: null }];
  const leagues = new Map();
  const scheduled = new Map();
  const registrations = new Map(); // scheduledId -> Map<userId, Date>
  const otps = new Map(); // phone -> { codeHash, expiresAt, attempts, lastSentAt }

  const currentSeasonRow = () => seasons.find((s) => !s.endsAt);

  return {
    kind: 'memory',
    async currentSeason() {
      return currentSeasonRow().id;
    },
    async getSeason() {
      const s = currentSeasonRow();
      return { id: s.id, name: s.name, startsAt: s.startsAt };
    },
    async newSeason(name) {
      const old = currentSeasonRow();
      old.endsAt = new Date();
      const id = old.id + 1;
      seasons.push({ id, name, startsAt: new Date(), endsAt: null });
      let carried = 0;
      for (const [key, r] of [...ratings.entries()]) {
        if (!key.endsWith(`:${old.id}`)) continue;
        const next = seasonReset(r);
        ratings.set(`${r.userId}:${id}`, { userId: r.userId, ...next, display: displayRating(next), gamesPlayed: 0, wins: 0 });
        carried++;
      }
      return { id, name, carried };
    },
    async upsertPlayer({ userId, name }) {
      const existing = players.get(userId);
      players.set(userId, { ...existing, userId, name, createdAt: existing?.createdAt ?? new Date() });
    },
    /** Oppretter spilleren hvis den ikke finnes. Overskriver aldri et valgt kallenavn. */
    async ensurePlayer({ userId, name }) {
      if (!players.has(userId)) players.set(userId, { userId, name, ageConfirmedAt: null, createdAt: new Date() });
      const p = players.get(userId);
      return { userId: p.userId, name: p.name, ageConfirmed: !!p.ageConfirmedAt };
    },
    async getPlayer(userId) {
      const p = players.get(userId);
      return p ? { userId: p.userId, name: p.name, ageConfirmed: !!p.ageConfirmedAt } : null;
    },
    async setDisplayName(userId, name) {
      const taken = [...players.values()].some((p) => p.userId !== userId && p.name.toLowerCase() === name.toLowerCase());
      if (taken) throw Object.assign(new Error('Kallenavnet er opptatt'), { status: 409, code: 'name_taken' });
      const p = players.get(userId);
      if (!p) throw Object.assign(new Error('Ukjent spiller'), { status: 404, code: 'not_found' });
      p.name = name;
    },
    async confirmAge(userId) {
      const p = players.get(userId);
      if (p && !p.ageConfirmedAt) p.ageConfirmedAt = new Date();
    },
    // ---------- engangskoder (SMS) ----------
    async saveOtp(phone, { codeHash, expiresAt }) {
      otps.set(phone, { phone, codeHash, expiresAt, attempts: 0, lastSentAt: new Date() });
    },
    async getOtp(phone) {
      return otps.get(phone) ?? null;
    },
    async bumpOtpAttempts(phone) {
      const o = otps.get(phone);
      if (o) o.attempts += 1;
    },
    async deleteOtp(phone) {
      otps.delete(phone);
    },
    async getRating(userId, season) {
      season ??= currentSeasonRow().id;
      return ratings.get(`${userId}:${season}`) ?? null;
    },
    async getRatings(userIds, season) {
      season ??= currentSeasonRow().id;
      const out = new Map();
      for (const id of userIds) {
        const r = ratings.get(`${id}:${season}`);
        if (r) out.set(id, r);
      }
      return out;
    },
    async createTournament(t) {
      tournaments.set(t.id, { ...t, status: 'running', startedAt: new Date() });
    },
    async finishTournament({ id, seasonId: season, results }) {
      const t = tournaments.get(id);
      if (t) {
        t.status = 'finished';
        t.finishedAt = new Date();
        t.entrants = results.length;
      }
      for (const r of results) {
        entries.push({ tournamentId: id, userId: r.userId, placement: r.placement, delta: r.rating?.delta ?? null });
        if (!r.rating) continue;
        const key = `${r.userId}:${season}`;
        const prev = ratings.get(key) ?? { ...newRating(), gamesPlayed: 0, wins: 0 };
        ratings.set(key, {
          userId: r.userId,
          mu: r.rating.after.mu,
          sigma: r.rating.after.sigma,
          display: r.rating.displayAfter,
          gamesPlayed: prev.gamesPlayed + 1,
          wins: prev.wins + (r.placement === 1 ? 1 : 0),
        });
      }
    },
    async saveHand(h) {
      hands.set(h.id, h);
    },
    async getHand(id) {
      return hands.get(id) ?? null;
    },
    async leaderboard(season, limit = 50) {
      season ??= currentSeasonRow().id;
      return [...ratings.entries()]
        .filter(([k]) => k.endsWith(`:${season}`))
        .map(([, r]) => ({ ...r, name: players.get(r.userId)?.name ?? r.userId }))
        .filter((r) => r.gamesPlayed > 0)
        .sort((a, b) => b.display - a.display)
        .slice(0, limit);
    },
    async playerStats(userId, season) {
      season ??= currentSeasonRow().id;
      const r = ratings.get(`${userId}:${season}`);
      return {
        rating: r ? r.display : displayRating(newRating()),
        gamesPlayed: r?.gamesPlayed ?? 0,
        wins: r?.wins ?? 0,
        recent: entries.filter((e) => e.userId === userId).slice(-10).reverse(),
      };
    },

    // ---------- ligaer ----------
    async createLeague({ id, name }) {
      if (leagues.has(id)) throw Object.assign(new Error('Ligaen finnes allerede'), { status: 409, code: 'exists' });
      leagues.set(id, { id, name, createdAt: new Date() });
      return leagues.get(id);
    },
    async getLeague(id) {
      return leagues.get(id) ?? null;
    },
    async listLeagues() {
      return [...leagues.values()];
    },
    async leagueStandings(leagueId, season) {
      season ??= currentSeasonRow().id;
      const table = new Map();
      for (const e of entries) {
        const t = tournaments.get(e.tournamentId);
        if (!t || t.leagueId !== leagueId || t.seasonId !== season || t.status !== 'finished') continue;
        const row = table.get(e.userId) ?? { userId: e.userId, name: players.get(e.userId)?.name ?? e.userId, points: 0, played: 0, wins: 0 };
        row.points += leaguePoints(t.entrants, e.placement);
        row.played += 1;
        row.wins += e.placement === 1 ? 1 : 0;
        table.set(e.userId, row);
      }
      return [...table.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
    },

    // ---------- planlagte turneringer ----------
    async createScheduled(s) {
      scheduled.set(s.id, { ...s, status: 'open', tournamentId: null, createdAt: new Date() });
      registrations.set(s.id, new Map());
      return scheduled.get(s.id);
    },
    async getScheduled(id) {
      const s = scheduled.get(id);
      return s ? { ...s, registered: registrations.get(id).size } : null;
    },
    async listScheduled({ statuses = ['open', 'running'] } = {}) {
      return [...scheduled.values()]
        .filter((s) => statuses.includes(s.status))
        .sort((a, b) => a.startAt - b.startAt)
        .map((s) => ({ ...s, registered: registrations.get(s.id).size }));
    },
    async dueScheduled(now = new Date()) {
      return [...scheduled.values()].filter((s) => s.status === 'open' && s.startAt <= now);
    },
    async register(id, userId) {
      const s = scheduled.get(id);
      const regs = registrations.get(id);
      if (!s) throw Object.assign(new Error('Turneringen finnes ikke'), { status: 404, code: 'not_found' });
      if (s.status !== 'open') throw Object.assign(new Error('Påmeldingen er stengt'), { status: 409, code: 'closed' });
      if (regs.has(userId)) return false;
      if (regs.size >= s.maxPlayers) throw Object.assign(new Error('Turneringen er full'), { status: 409, code: 'full' });
      regs.set(userId, new Date());
      return true;
    },
    async unregister(id, userId) {
      const s = scheduled.get(id);
      if (!s || s.status !== 'open') return false;
      return registrations.get(id).delete(userId);
    },
    async isRegistered(id, userId) {
      return registrations.get(id)?.has(userId) ?? false;
    },
    async registrations(id) {
      return [...(registrations.get(id) ?? new Map()).entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([userId]) => ({ userId, name: players.get(userId)?.name ?? userId }));
    },
    async setScheduledStatus(id, status, tournamentId = null) {
      const s = scheduled.get(id);
      if (s) {
        s.status = status;
        if (tournamentId) s.tournamentId = tournamentId;
      }
    },
    async close() {},
  };
}
