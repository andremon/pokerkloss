// SMS via Ayno Connect (sms.ay.no) – samme kontrakt som DriveArena bruker:
//   POST {AYNO_BASE_URL}{AYNO_SMS_PATH}   Authorization: Bearer {AYNO_API_KEY}
//   body { to, message, sender }  →  { status: 'sent', messageId, queued, tenant }

/** Normaliserer til E.164. Åtte siffer uten landkode regnes som norsk. Returnerer null hvis ugyldig. */
export function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    if (/^\d{8}$/.test(p)) p = '+47' + p;
    else p = '+' + p;
  }
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

export function createAyno(config, fetchImpl = globalThis.fetch) {
  const { baseUrl, smsPath, apiKey, sender } = config.ayno;
  return {
    configured: !!(baseUrl && apiKey),
    async send(to, message) {
      if (!baseUrl || !apiKey) throw new Error('Ayno er ikke konfigurert (AYNO_BASE_URL / AYNO_API_KEY mangler)');
      const res = await fetchImpl(baseUrl.replace(/\/$/, '') + smsPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ to, message, sender }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Ayno ${res.status}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    },
  };
}
