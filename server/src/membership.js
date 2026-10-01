// Medlemskap via MedlemArena (medlem.ay.no) – avgjør hvem som får spille ratet.
//
// PokerKloss spør MedlemArena med BRUKERENS EGEN Arena-JWT, akkurat som
// medlemarena_klient-byggeklossen i appene:
//
//   GET {MEDLEMARENA_URL}/api/v1/status      Authorization: Bearer <brukerens token>
//   → { aktiv, gyldigTil, aldersgruppe: 'barn'|'ungdom'|'voksen', grenser,
//       husstand?: boolean, over16?: boolean }
//
// Regel for ratet spill:
//   - aktiv medlem og aldersgruppe «voksen» (18+), eller
//   - aktiv medlem, «ungdom», husstand === true og over16 === true (familieinnmelding, 16+).
// «husstand» og «over16» finnes ikke i dagens MedlemArena-status – se docs/OPPSETT-AUTHARENA.md
// for det lille tillegget. Uten dem får ungdom ikke ratet spill (trygg standard).
// Treningsbord (ikke ratet) er åpne for alle innloggede.

export function evaluateStatus(status) {
  if (!status) return { rated: false, reason: 'Fant ikke medlemskap i A5 Arena' };
  if (!status.aktiv) return { rated: false, reason: 'Ratet spill krever aktivt medlemskap i A5 Arena' };
  if (status.gyldigTil && new Date(status.gyldigTil) < new Date(new Date().toDateString())) {
    return { rated: false, reason: 'Medlemskapet ditt har utløpt' };
  }
  if (status.aldersgruppe === 'voksen') return { rated: true, reason: null };
  if (status.aldersgruppe === 'ungdom') {
    if (status.husstand === true && status.over16 === true) return { rated: true, reason: null };
    return { rated: false, reason: 'Ratet spill krever 18 år, eller 16 år ved familieinnmelding' };
  }
  if (status.aldersgruppe === 'barn') return { rated: false, reason: 'Ratet spill krever 18 år, eller 16 år ved familieinnmelding' };
  return { rated: false, reason: 'Alder mangler i medlemsregisteret' };
}

export function createMembership(config, fetchImpl = globalThis.fetch) {
  const lastKnown = new Map(); // userId -> { result, at }
  const devMembers = new Map();
  const TTL = 60_000;

  async function fetchStatus(token) {
    const res = await fetchImpl(`${config.medlemArenaUrl.replace(/\/$/, '')}/api/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401 || res.status === 404) return null;
    if (!res.ok) throw new Error(`MedlemArena svarte ${res.status}`);
    return res.json();
  }

  return {
    /**
     * @param {string} userId
     * @param {string} [token]  Brukerens Arena-JWT. Uten token brukes siste kjente svar.
     */
    async eligibility(userId, token) {
      if (devMembers.has(userId)) return evaluateStatus(devMembers.get(userId));
      const hit = lastKnown.get(userId);
      if (hit && Date.now() - hit.at < TTL) return hit.result;
      if (!config.medlemArenaUrl) {
        return { rated: false, reason: 'MedlemArena er ikke koblet til (MEDLEMARENA_URL mangler)' };
      }
      if (!token || token.startsWith('dev:')) {
        // Planleggeren har ikke brukerens token – bruk siste verifiserte svar.
        return hit ? hit.result : { rated: false, reason: 'Medlemskap ikke bekreftet ennå' };
      }
      try {
        const result = evaluateStatus(await fetchStatus(token));
        lastKnown.set(userId, { result, at: Date.now() });
        return result;
      } catch {
        // MedlemArena nede: bruk siste kjente svar hvis vi har det.
        if (hit) return hit.result;
        return { rated: false, reason: 'Fikk ikke kontakt med medlemsregisteret. Prøv igjen snart.' };
      }
    },
    /** Siste verifiserte svar uten nettkall (brukes av planleggeren ved turneringsstart). */
    lastKnown(userId) {
      if (devMembers.has(userId)) return evaluateStatus(devMembers.get(userId));
      return lastKnown.get(userId)?.result ?? null;
    },
    /** Kun utvikling/test: registrer et medlem lokalt med samme felter som MedlemArena-status. */
    setDevMember(userId, status) {
      devMembers.set(userId, status);
    },
  };
}
