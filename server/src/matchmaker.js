// Matchmaking for ratet sit-and-go og heads-up.
// Fyller bord med spillere innen et ratingvindu som utvides jo lenger den eldste har ventet.
// To spillere fra samme IP-adresse settes ikke ved samme ratede bord.

export const FORMATS = Object.freeze({
  hu: { size: 2, name: 'Heads-up' },
  sng6: { size: 6, name: 'Sit-and-go 6' },
  sng9: { size: 9, name: 'Sit-and-go 9' },
});

export class Matchmaker {
  /**
   * @param {object} o
   * @param {object} o.config  matchmaking-delen av config
   * @param {(format:string, entries:object[]) => void} o.onMatch
   * @param {() => number} [o.now]
   */
  constructor({ config, onMatch, now = () => Date.now() }) {
    this.config = config;
    this.onMatch = onMatch;
    this.now = now;
    this.queues = Object.fromEntries(Object.keys(FORMATS).map((f) => [f, []]));
    this.interval = null;
  }

  startTicking() {
    this.interval ??= setInterval(() => this.tick(), this.config.tickMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  queuedFormat(userId) {
    for (const [f, q] of Object.entries(this.queues)) if (q.some((e) => e.userId === userId)) return f;
    return null;
  }

  /** entry: { userId, name, rating (vist), ip } */
  join(format, entry) {
    if (!FORMATS[format]) throw new Error(`Ukjent format: ${format}`);
    if (this.queuedFormat(entry.userId)) throw new Error('Du står allerede i kø');
    this.queues[format].push({ ...entry, joinedAt: this.now() });
    this.tick();
    return this.position(entry.userId);
  }

  leave(userId) {
    for (const q of Object.values(this.queues)) {
      const i = q.findIndex((e) => e.userId === userId);
      if (i >= 0) {
        q.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  position(userId) {
    const f = this.queuedFormat(userId);
    if (!f) return null;
    return { format: f, waiting: this.queues[f].length, size: FORMATS[f].size };
  }

  windowFor(waitedMs) {
    const { baseWindow, widenAfterMs, widenStep, widenEveryMs } = this.config;
    if (waitedMs < widenAfterMs) return baseWindow;
    return baseWindow + widenStep * (1 + Math.floor((waitedMs - widenAfterMs) / widenEveryMs));
  }

  tick() {
    for (const [format, q] of Object.entries(this.queues)) {
      const size = FORMATS[format].size;
      let matched = true;
      while (matched && q.length >= size) {
        matched = false;
        // Prøv med den som har ventet lengst som anker.
        for (const anchor of [...q].sort((a, b) => a.joinedAt - b.joinedAt)) {
          const window = this.windowFor(this.now() - anchor.joinedAt);
          const picked = [anchor];
          const ips = new Set(anchor.ip ? [anchor.ip] : []);
          const candidates = q
            .filter((e) => e !== anchor && Math.abs(e.rating - anchor.rating) <= window)
            .sort((a, b) => a.joinedAt - b.joinedAt);
          for (const c of candidates) {
            if (picked.length === size) break;
            if (c.ip && ips.has(c.ip)) continue;
            picked.push(c);
            if (c.ip) ips.add(c.ip);
          }
          if (picked.length === size) {
            for (const p of picked) q.splice(q.indexOf(p), 1);
            this.onMatch(format, picked);
            matched = true;
            break;
          }
        }
      }
    }
  }
}
