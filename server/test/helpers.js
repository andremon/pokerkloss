import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/auth.js';
import { createMembership } from '../src/membership.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createPokerServer } from '../src/app.js';

export async function startTestServer({ store = createMemoryStore(), timing = {} } = {}) {
  const config = loadConfig({
    POKER_DEV_AUTH: '1',
    POKER_TURN_MS: '3000',
    POKER_TIMEBANK_MS: '0',
    POKER_BOT_DELAY_MS: '0',
    POKER_SITOUT_ACT_MS: '0',
    POKER_NEXT_HAND_MS: '0',
    POKER_MM_TICK_MS: '50',
    POKER_HANDS_PER_LEVEL: '4',
    POKER_SCHEDULER_TICK_MS: '50',
    POKER_ADMIN_IDS: 'admin',
    POKER_KREV_MEDLEMSKAP: '1',
  });
  Object.assign(config.timing, timing);
  const membership = createMembership(config);
  const poker = createPokerServer({ config, store, auth: createAuth(config), membership, log: { error: () => {} } });
  await new Promise((r) => poker.server.listen(0, r));
  const port = poker.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { poker, store, membership, config, base, port };
}

export async function api(base, token, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** WS-klient som samler alle meldinger og kan vente på bestemte. */
export async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/poker/ws?token=${encodeURIComponent(token)}`);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const client = {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor(pred, ms = 20_000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error('Tidsavbrudd i waitFor'));
          }
        }, ms).unref();
      });
    },
    /** Alle hendelser fra 'events'-meldinger, flatet ut. */
    events() {
      return messages.filter((m) => m.type === 'events').flatMap((m) => m.events);
    },
    close: () => ws.close(),
  };
  return client;
}

/** Lar en klient spille automatisk med en enkel strategi til turneringen er ferdig. */
export function autoPlay(client, strategy) {
  let mySeat = null;
  client.ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'table.state') mySeat = msg.state.mySeat;
    if (msg.type !== 'events') return;
    for (const e of msg.events) {
      if (e.type === 'turn' && e.seat === mySeat) {
        client.send({ type: 'action', tournamentId: msg.tournamentId, action: strategy(e) });
      }
    }
  });
  // Allerede mottatt tilstand?
  const st = client.messages.findLast?.((m) => m.type === 'table.state');
  if (st) mySeat = st.state.mySeat;
}
