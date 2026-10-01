// Konfigurasjon fra miljøvariabler. Alle tider i millisekunder.

const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8080),
    databaseUrl: env.DATABASE_URL || null, // tom = minnelager (kun utvikling)
    devAuth: env.POKER_DEV_AUTH === '1', // «dev:<id>:<navn>»-tokens, ALDRI i produksjon
    // AuthArena v2: Arena-JWT (RS256) verifiseres lokalt.
    arenaPublicKey: env.ARENA_JWT_PUBLIC_KEY || null,
    authArenaJwksUrl: env.AUTHARENA_JWKS_URL || null,
    arenaIssuer: env.ARENA_JWT_ISSUER || 'ay.no',
    authArenaAudience: env.AUTHARENA_AUDIENCE || null,
    // SMS-innlogging: PokerKloss utsteder Arena-JWT selv når den private nøkkelen er satt.
    arenaPrivateKey: env.ARENA_JWT_PRIVATE_KEY || null,
    tokenDays: num(env.POKER_TOKEN_DAYS, 30),
    otpTtlMin: num(env.OTP_TTL_MIN, 5),
    otpPepper: env.OTP_PEPPER || '',
    ayno: {
      baseUrl: env.AYNO_BASE_URL || null, // https://sms.ay.no
      smsPath: env.AYNO_SMS_PATH || '/api/3rdparty/v1/message',
      apiKey: env.AYNO_API_KEY || null,
      sender: env.AYNO_SENDER_NAME || 'PokerKloss',
    },
    // MedlemArena (f.eks. https://medlem.ay.no). Spørres med brukerens egen Arena-JWT.
    medlemArenaUrl: env.MEDLEMARENA_URL || null,
    // Av: alle innloggede som har bekreftet 18 år kan spille ratet. På: krever aktivt medlemskap i MedlemArena.
    requireMembership: env.POKER_KREV_MEDLEMSKAP === '1',
    timing: {
      turnMs: num(env.POKER_TURN_MS, 20_000),
      timebankMs: num(env.POKER_TIMEBANK_MS, 30_000),
      botDelayMs: num(env.POKER_BOT_DELAY_MS, 900),
      sitOutActMs: num(env.POKER_SITOUT_ACT_MS, 1_000),
      nextHandDelayMs: num(env.POKER_NEXT_HAND_MS, 3_000),
    },
    matchmaking: {
      tickMs: num(env.POKER_MM_TICK_MS, 1_000),
      baseWindow: num(env.POKER_MM_WINDOW, 300),
      widenAfterMs: num(env.POKER_MM_WIDEN_AFTER_MS, 30_000),
      widenStep: num(env.POKER_MM_WIDEN_STEP, 100),
      widenEveryMs: num(env.POKER_MM_WIDEN_EVERY_MS, 10_000),
    },
    // Bruker-id-er (AuthArena) som kan opprette turneringer, ligaer og sesonger. Kommaseparert.
    adminIds: (env.POKER_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean),
    schedulerTickMs: num(env.POKER_SCHEDULER_TICK_MS, 5_000),
    // Kun test/utvikling: øk blindnivå per antall hender i stedet for tid.
    handsPerLevel: env.POKER_HANDS_PER_LEVEL ? num(env.POKER_HANDS_PER_LEVEL, null) : null,
  };
}
