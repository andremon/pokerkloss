// PokerKloss-server: Express (REST) + ws (sanntid).

import http from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PokerError, STRUCTURES } from '@arena/poker-core';
import { displayRating, newRating } from '@arena/poker-rating';
import { bearer } from './auth.js';
import { TournamentRunner } from './tournamentRunner.js';
import { Matchmaker, FORMATS } from './matchmaker.js';
import { createOtpRouter } from './otp.js';
import { createAyno } from './ayno.js';
import { createIssuer } from './tokens.js';

/** Midlertidig navn for nye SMS-brukere – telefonnummeret vises aldri. */
function tempName() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += abc[randomInt(abc.length)];
  return `Spiller-${s}`;
}
const isTempName = (n) => /^Spiller-[A-Z0-9]{4}$/.test(n);

const BOT_NAMES = ['Ai-Bot Ask', 'Ai-Bot Bjørk', 'Ai-Bot Eik', 'Ai-Bot Furu', 'Ai-Bot Gran', 'Ai-Bot Hegg', 'Ai-Bot Lind', 'Ai-Bot Osp'];

const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createPokerServer({ config, store, auth, membership, log = console, ayno = createAyno(config), issuer = createIssuer(config) }) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.set('trust proxy', true); // Railway står bak proxy

  /** Sørger for at spilleren finnes. SMS-brukere (tel:) får et midlertidig kallenavn. */
  async function ensurePlayer(user) {
    const initial = user.userId.startsWith('tel:') || /^\+?\d{8,15}$/.test(user.name ?? '') ? tempName() : user.name;
    const p = await store.ensurePlayer({ userId: user.userId, name: initial });
    return { ...p, needsName: isTempName(p.name) };
  }

  /**
   * Kan brukeren spille ratet?
   *  - POKER_KREV_MEDLEMSKAP=1: MedlemArena avgjør (18 år, eller 16 ved familieinnmelding).
   *  - ellers: brukeren må ha bekreftet at hen er 18 år.
   */
  async function eligibility(userId, token) {
    if (config.requireMembership) return membership.eligibility(userId, token);
    const p = await store.getPlayer(userId);
    return p?.ageConfirmed ? { rated: true, reason: null } : { rated: false, reason: 'Bekreft at du er 18 år for å spille ratet' };
  }

  app.use(
    '/auth/otp',
    createOtpRouter({ config, store, ayno, issuer, log, onLogin: (sub) => ensurePlayer({ userId: sub, name: null }) }),
  );

  const tournaments = new Map(); // tournamentId -> TournamentRunner
  const active = new Map(); // userId -> tournamentId (der spilleren fortsatt er med)
  const sockets = new Map(); // userId -> Set<ws>

  function notify(userId, msg) {
    for (const ws of sockets.get(userId) ?? []) ws.sendJson(msg);
  }

  function attachSockets(runner, userId) {
    for (const ws of sockets.get(userId) ?? []) {
      if (!ws.subscribed.has(runner.id)) {
        runner.subscribe(userId, ws.sendJson);
        ws.subscribed.add(runner.id);
      }
    }
  }

  /** Oppretter, registrerer og starter en turnering. */
  function launch(opts, humans) {
    const runner = new TournamentRunner({
      store,
      timing: config.timing,
      handsPerLevel: config.handsPerLevel ?? undefined,
      ...opts,
    });
    tournaments.set(runner.id, runner);
    for (const h of humans) active.set(h.userId, runner.id);
    runner.on('error', (e) => log.error?.(`[turnering ${runner.id}]`, e));
    runner.on('eliminated', (userId) => {
      if (active.get(userId) === runner.id) active.delete(userId);
    });
    runner.on('finished', () => {
      for (const h of humans) if (active.get(h.userId) === runner.id) active.delete(h.userId);
      setTimeout(() => tournaments.delete(runner.id), 10 * 60_000).unref?.();
    });
    for (const h of humans) attachSockets(runner, h.userId);
    runner.start();
    return runner;
  }

  // ---------- matchmaking (heads-up / sit-and-go) ----------

  const matchmaker = new Matchmaker({
    config: config.matchmaking,
    onMatch: async (format, entries) => {
      const humans = shuffle(entries).map((e) => ({ userId: e.userId, name: e.name }));
      const runner = launch(
        {
          id: `${format}-${randomUUID().slice(0, 8)}`,
          name: FORMATS[format].name,
          format,
          rated: true,
          players: humans,
          structure: STRUCTURES.sng,
          maxSeats: FORMATS[format].size,
          seasonId: await store.currentSeason(),
        },
        humans,
      );
      for (const h of humans) notify(h.userId, { type: 'match.found', tournamentId: runner.id, format });
    },
  });

  // ---------- planlagte turneringer ----------

  let schedulerBusy = false;
  async function schedulerTick() {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      for (const s of await store.dueScheduled(new Date())) {
        const regs = await store.registrations(s.id);
        // Medlemskap ble sjekket ved påmelding. Ved start brukes siste kjente svar fra
        // MedlemArena (fra påmelding eller senere kall); har det endret seg til «ikke gyldig»,
        // tas spilleren ut. De som sitter ved et annet bord hoppes over.
        const ok = [];
        for (const r of regs) {
          if (active.has(r.userId)) continue;
          if (config.requireMembership) {
            const known = membership.lastKnown(r.userId);
            if (known === null || known.rated) ok.push(r);
          } else if ((await eligibility(r.userId)).rated) ok.push(r);
        }
        if (ok.length < 2) {
          await store.setScheduledStatus(s.id, 'cancelled');
          for (const r of regs) notify(r.userId, { type: 'scheduled.cancelled', scheduledId: s.id, reason: 'For få påmeldte' });
          continue;
        }
        for (const r of ok) matchmaker.leave(r.userId);
        const humans = shuffle(ok);
        const runner = launch(
          {
            id: `club-${s.id}`,
            name: s.name,
            format: 'scheduled',
            rated: true,
            players: humans,
            structure: STRUCTURES[s.structure] ?? STRUCTURES.turnering,
            maxSeats: s.maxSeats,
            seasonId: await store.currentSeason(),
            leagueId: s.leagueId ?? null,
          },
          humans,
        );
        await store.setScheduledStatus(s.id, 'running', runner.id);
        runner.on('finished', () => store.setScheduledStatus(s.id, 'finished').catch(() => {}));
        for (const r of humans) notify(r.userId, { type: 'scheduled.started', scheduledId: s.id, tournamentId: runner.id });
      }
    } catch (e) {
      log.error?.('[planlegger]', e);
    } finally {
      schedulerBusy = false;
    }
  }
  const scheduler = setInterval(schedulerTick, config.schedulerTickMs);
  scheduler.unref?.();

  // ---------- REST ----------

  const requireUser = async (req, res, next) => {
    const user = await auth(bearer(req));
    if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Logg inn med AuthArena' });
    req.token = bearer(req);
    try {
      const p = await ensurePlayer(user);
      req.user = { ...user, name: p.name, needsName: p.needsName, ageConfirmed: p.ageConfirmed };
    } catch (e) {
      return res.status(500).json({ error: 'error', message: e.message });
    }
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (!config.adminIds.includes(req.user.userId)) {
      return res.status(403).json({ error: 'forbidden', message: 'Kun for administratorer i A5 Arena' });
    }
    next();
  };

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e instanceof PokerError ? 400 : e.status ?? 500;
      if (status === 500) log.error?.(e);
      res.status(status).json({ error: e.code ?? 'error', message: e.message });
    });

  const requireEligible = async (req) => {
    const elig = await eligibility(req.user.userId, req.token);
    if (!elig.rated) throw httpError(403, 'not_eligible', elig.reason);
  };

  if (config.devAuth) {
    // Enkel nettleserklient for testing. Kun i utviklingsmodus.
    app.get('/dev', (req, res) => res.sendFile(new URL('../public/dev.html', import.meta.url).pathname));
  }

  app.get('/health', (req, res) => res.json({ ok: true, tournaments: tournaments.size, store: store.kind }));

  app.get(
    '/poker/me',
    requireUser,
    wrap(async (req, res) => {
      const { userId, name } = req.user;
      const [elig, stats] = await Promise.all([eligibility(userId, req.token), store.playerStats(userId)]);
      res.json({
        userId,
        name,
        needsName: req.user.needsName,
        ageConfirmed: req.user.ageConfirmed,
        requireMembership: config.requireMembership,
        rated: elig.rated,
        ratedReason: elig.reason,
        admin: config.adminIds.includes(userId),
        rating: stats.rating,
        gamesPlayed: stats.gamesPlayed,
        activeTournament: active.get(userId) ?? null,
        queue: matchmaker.position(userId),
      });
    }),
  );

  app.put(
    '/poker/me/name',
    requireUser,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
      if (!/^[\p{L}\p{N} ._-]{2,20}$/u.test(name)) throw httpError(400, 'name', 'Kallenavn må være 2–20 tegn: bokstaver, tall, mellomrom, punktum, - eller _');
      if (/^\+?\d[\d ]{6,}$/.test(name)) throw httpError(400, 'name', 'Bruk et kallenavn, ikke et telefonnummer');
      if (isTempName(name)) throw httpError(400, 'name', 'Velg ditt eget kallenavn');
      if (/^ai-bot/i.test(name)) throw httpError(400, 'name', 'Navnet er reservert');
      await store.setDisplayName(req.user.userId, name);
      res.json({ name });
    }),
  );

  app.post(
    '/poker/me/confirm-age',
    requireUser,
    wrap(async (req, res) => {
      if (req.body?.over18 !== true) throw httpError(400, 'over18', 'Send { "over18": true } for å bekrefte');
      await store.confirmAge(req.user.userId);
      res.json({ ageConfirmed: true });
    }),
  );

  app.get(
    '/poker/lobby',
    requireUser,
    wrap(async (req, res) => {
      res.json({
        tournaments: [...tournaments.values()].filter((t) => t.status === 'running').map((t) => t.summary()),
        queues: Object.fromEntries(
          Object.entries(FORMATS).map(([f, def]) => [f, { name: def.name, size: def.size, waiting: matchmaker.queues[f].length }]),
        ),
        scheduled: (await store.listScheduled({ statuses: ['open'] })).slice(0, 10),
      });
    }),
  );

  app.post(
    '/poker/sng/queue',
    requireUser,
    wrap(async (req, res) => {
      const { userId, name } = req.user;
      const format = req.body?.format;
      if (!FORMATS[format]) throw httpError(400, 'format', 'Ukjent format');
      if (active.has(userId)) throw httpError(409, 'busy', 'Du er allerede med i en turnering');
      await requireEligible(req);
      const r = await store.getRating(userId);
      const position = matchmaker.join(format, { userId, name, rating: r ? r.display : displayRating(newRating()), ip: req.ip });
      res.json({ queued: !!position, position, activeTournament: active.get(userId) ?? null });
    }),
  );

  app.delete(
    '/poker/sng/queue',
    requireUser,
    wrap(async (req, res) => res.json({ left: matchmaker.leave(req.user.userId) })),
  );

  app.post(
    '/poker/training',
    requireUser,
    wrap(async (req, res) => {
      const { userId, name } = req.user;
      if (active.has(userId)) throw httpError(409, 'busy', 'Du er allerede med i en turnering');
      matchmaker.leave(userId);
      const bots = Math.min(8, Math.max(1, Number.parseInt(req.body?.bots ?? 5, 10) || 5));
      const id = `training-${randomUUID().slice(0, 8)}`;
      const players = [{ userId, name }];
      for (let i = 0; i < bots; i++) players.push({ userId: `bot:${id}:${i}`, name: BOT_NAMES[i], bot: true });
      launch({ id, name: 'Treningsbord', format: 'training', rated: false, players, structure: STRUCTURES.sng, maxSeats: 9 }, [{ userId }]);
      res.status(201).json({ tournamentId: id });
    }),
  );

  // --- planlagte turneringer (klubbkvelder) ---

  app.get(
    '/poker/tournaments',
    requireUser,
    wrap(async (req, res) => {
      const list = await store.listScheduled({ statuses: ['open', 'running'] });
      const out = [];
      for (const s of list) out.push({ ...s, registeredMe: await store.isRegistered(s.id, req.user.userId) });
      res.json({ tournaments: out });
    }),
  );

  app.get(
    '/poker/tournaments/:id',
    requireUser,
    wrap(async (req, res) => {
      const s = await store.getScheduled(req.params.id);
      if (!s) throw httpError(404, 'not_found', 'Turneringen finnes ikke');
      const runner = s.tournamentId ? tournaments.get(s.tournamentId) : null;
      res.json({
        ...s,
        registeredMe: await store.isRegistered(s.id, req.user.userId),
        players: await store.registrations(s.id),
        live: runner ? runner.summary() : null,
        results: runner?.finalResults ?? null,
      });
    }),
  );

  app.post(
    '/poker/tournaments/:id/register',
    requireUser,
    wrap(async (req, res) => {
      await requireEligible(req);
      const added = await store.register(req.params.id, req.user.userId);
      res.json({ registered: true, added });
    }),
  );

  app.delete(
    '/poker/tournaments/:id/register',
    requireUser,
    wrap(async (req, res) => res.json({ removed: await store.unregister(req.params.id, req.user.userId) })),
  );

  // --- ligaer og sesonger ---

  app.get(
    '/poker/leagues',
    requireUser,
    wrap(async (req, res) => res.json({ leagues: await store.listLeagues() })),
  );

  app.get(
    '/poker/leagues/:id/standings',
    requireUser,
    wrap(async (req, res) => {
      const league = await store.getLeague(req.params.id);
      if (!league) throw httpError(404, 'not_found', 'Ligaen finnes ikke');
      const season = await store.getSeason();
      const rows = await store.leagueStandings(league.id, season.id);
      res.json({ league, season, standings: rows.map((r, i) => ({ rank: i + 1, ...r })) });
    }),
  );

  app.get(
    '/poker/seasons/current',
    requireUser,
    wrap(async (req, res) => res.json(await store.getSeason())),
  );

  // --- administrasjon ---

  app.post(
    '/poker/admin/tournaments',
    requireUser,
    requireAdmin,
    wrap(async (req, res) => {
      const b = req.body ?? {};
      const name = String(b.name ?? '').trim().slice(0, 80);
      const startAt = new Date(b.startAt);
      const maxPlayers = Number.parseInt(b.maxPlayers ?? 100, 10);
      const maxSeats = Number.parseInt(b.maxSeats ?? 9, 10);
      const structure = b.structure ?? 'turnering';
      if (!name) throw httpError(400, 'name', 'Navn mangler');
      if (Number.isNaN(startAt.getTime())) throw httpError(400, 'startAt', 'Ugyldig starttid');
      if (!(maxPlayers >= 2 && maxPlayers <= 500)) throw httpError(400, 'maxPlayers', 'maxPlayers må være 2–500');
      if (!(maxSeats >= 2 && maxSeats <= 10)) throw httpError(400, 'maxSeats', 'maxSeats må være 2–10');
      if (!STRUCTURES[structure]) throw httpError(400, 'structure', `Ukjent struktur: ${structure}`);
      if (b.leagueId && !(await store.getLeague(b.leagueId))) throw httpError(400, 'leagueId', 'Ukjent liga');
      const s = await store.createScheduled({
        id: randomUUID().slice(0, 12),
        name,
        startAt,
        maxPlayers,
        maxSeats,
        structure,
        leagueId: b.leagueId || null,
        createdBy: req.user.userId,
      });
      res.status(201).json(s);
    }),
  );

  app.delete(
    '/poker/admin/tournaments/:id',
    requireUser,
    requireAdmin,
    wrap(async (req, res) => {
      const s = await store.getScheduled(req.params.id);
      if (!s) throw httpError(404, 'not_found', 'Turneringen finnes ikke');
      if (s.status !== 'open') throw httpError(409, 'closed', 'Kan bare avlyse turneringer som ikke har startet');
      await store.setScheduledStatus(s.id, 'cancelled');
      for (const r of await store.registrations(s.id)) notify(r.userId, { type: 'scheduled.cancelled', scheduledId: s.id, reason: 'Avlyst' });
      res.json({ cancelled: true });
    }),
  );

  app.post(
    '/poker/admin/leagues',
    requireUser,
    requireAdmin,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'name', 'Navn mangler');
      const id =
        String(req.body?.id ?? name)
          .toLowerCase()
          .replace(/æ/g, 'ae')
          .replace(/ø/g, 'o')
          .replace(/å/g, 'a')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || randomUUID().slice(0, 8);
      res.status(201).json(await store.createLeague({ id, name }));
    }),
  );

  app.post(
    '/poker/admin/seasons',
    requireUser,
    requireAdmin,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'name', 'Navn mangler');
      res.status(201).json(await store.newSeason(name));
    }),
  );

  // --- spillere, toppliste, historikk ---

  app.get(
    '/poker/players/:id',
    requireUser,
    wrap(async (req, res) => {
      const p = await store.getPlayer(req.params.id);
      if (!p) throw httpError(404, 'not_found', 'Ukjent spiller');
      res.json({ userId: p.userId, name: p.name, ...(await store.playerStats(p.userId)) });
    }),
  );

  app.get(
    '/poker/leaderboard',
    requireUser,
    wrap(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? 50, 10) || 50));
      const rows = await store.leaderboard(undefined, limit);
      res.json({
        season: await store.currentSeason(),
        players: rows.map((r, i) => ({ rank: i + 1, userId: r.userId, name: r.name, rating: r.display, games: r.gamesPlayed, wins: r.wins })),
      });
    }),
  );

  app.get(
    '/poker/hands/:id',
    requireUser,
    wrap(async (req, res) => {
      const h = await store.getHand(req.params.id);
      const me = h?.players.find((p) => p.userId === req.user.userId);
      // Bare de som satt i hånden kan se historikken.
      if (!h || !me) throw httpError(404, 'not_found', 'Hånden finnes ikke');
      const shown = new Set((h.result.hands ?? []).map((x) => x.seat));
      res.json({
        id: h.id,
        tournamentId: h.tournamentId,
        buttonSeat: h.buttonSeat,
        board: h.board,
        seedHash: h.seedHash,
        seed: h.seed,
        players: h.players.map((p) => ({
          seat: p.seat,
          userId: p.userId,
          startStack: p.startStack,
          holeCards: p.userId === req.user.userId || shown.has(p.seat) ? p.holeCards : null,
        })),
        actions: h.actions,
        result: { pots: h.result.pots, stacks: h.result.stacks, showdown: h.result.showdown, hands: h.result.hands },
      });
    }),
  );

  // ---------- WebSocket ----------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/poker/ws') return socket.destroy();
    const user = await auth(url.searchParams.get('token')).catch(() => null);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });

  wss.on('connection', (ws, req, user) => {
    const { userId } = user;
    ws.subscribed = new Set();
    ws.sendJson = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(ws);
    ensurePlayer(user)
      .then((p) => ws.sendJson({ type: 'hello', userId, name: p.name, needsName: p.needsName, activeTournament: active.get(userId) ?? null }))
      .catch(() => ws.sendJson({ type: 'hello', userId, name: user.name, activeTournament: active.get(userId) ?? null }));

    const tid = active.get(userId);
    if (tid && tournaments.has(tid)) {
      tournaments.get(tid).subscribe(userId, ws.sendJson);
      ws.subscribed.add(tid);
    }

    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.sendJson({ type: 'error', code: 'json', message: 'Ugyldig melding' });
      }
      try {
        const id = msg.tournamentId ?? msg.tableId; // tableId godtas for bakoverkompatibilitet
        const runner = id ? tournaments.get(id) : null;
        switch (msg.type) {
          case 'ping':
            return ws.sendJson({ type: 'pong', t: msg.t ?? null });
          case 'table.join':
            if (!runner) throw new PokerError('table', 'Ukjent turnering');
            if (!ws.subscribed.has(runner.id)) {
              runner.subscribe(userId, ws.sendJson);
              ws.subscribed.add(runner.id);
            } else ws.sendJson({ type: 'table.state', tournamentId: runner.id, state: runner.stateFor(userId) });
            return;
          case 'action':
            if (!runner) throw new PokerError('table', 'Ukjent turnering');
            runner.handleAction(userId, msg.action);
            return;
          case 'sitout':
          case 'sitin':
            if (!runner) throw new PokerError('table', 'Ukjent turnering');
            runner.setSittingOut(userId, msg.type === 'sitout');
            return ws.sendJson({ type: msg.type, tournamentId: runner.id });
          default:
            throw new PokerError('type', `Ukjent meldingstype: ${msg.type}`);
        }
      } catch (e) {
        ws.sendJson({ type: 'error', code: e.code ?? 'error', message: e.message, ref: msg?.type });
      }
    });

    ws.on('close', () => {
      sockets.get(userId)?.delete(ws);
      if (sockets.get(userId)?.size === 0) sockets.delete(userId);
      for (const id of ws.subscribed) tournaments.get(id)?.unsubscribe(userId, ws.sendJson);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  matchmaker.startTicking();

  return {
    app,
    server,
    tournaments,
    matchmaker,
    membership,
    schedulerTick,
    async close() {
      clearInterval(heartbeat);
      clearInterval(scheduler);
      matchmaker.stop();
      for (const t of tournaments.values()) t.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
