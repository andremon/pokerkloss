-- PokerKloss – PostgreSQL-skjema.
-- Merk: sjetonger lagres ALDRI på spilleren. Kun rating og historikk.

CREATE TABLE IF NOT EXISTS poker_players (
  user_id      TEXT PRIMARY KEY,           -- fra AuthArena v2
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poker_seasons (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at   TIMESTAMPTZ,
  league_id TEXT                            -- valgfri klubbliga (MedlemArena)
);

CREATE TABLE IF NOT EXISTS poker_ratings (
  user_id      TEXT NOT NULL REFERENCES poker_players(user_id),
  season_id    INTEGER NOT NULL REFERENCES poker_seasons(id),
  mu           DOUBLE PRECISION NOT NULL,
  sigma        DOUBLE PRECISION NOT NULL,
  display      INTEGER NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, season_id)
);
CREATE INDEX IF NOT EXISTS poker_ratings_board ON poker_ratings (season_id, display DESC);

CREATE TABLE IF NOT EXISTS poker_tournaments (
  id              TEXT PRIMARY KEY,
  format          TEXT NOT NULL,            -- hu | sng6 | sng9 | training | scheduled
  rated           BOOLEAN NOT NULL,
  season_id       INTEGER REFERENCES poker_seasons(id),
  blind_structure JSONB NOT NULL,
  status          TEXT NOT NULL,            -- running | finished
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS poker_entries (
  tournament_id TEXT NOT NULL REFERENCES poker_tournaments(id),
  user_id       TEXT NOT NULL,              -- bots har id «bot:*» og ingen rad i poker_players
  placement     INTEGER,
  mu_before     DOUBLE PRECISION,
  mu_after      DOUBLE PRECISION,
  display_delta INTEGER,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS poker_hands (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES poker_tournaments(id),
  seed_hash     TEXT NOT NULL,
  seed          TEXT NOT NULL,
  button_seat   INTEGER NOT NULL,
  board         TEXT[] NOT NULL,
  players       JSONB NOT NULL,             -- [{seat, userId, startStack, holeCards}]
  result        JSONB NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS poker_hands_tournament ON poker_hands (tournament_id);

CREATE TABLE IF NOT EXISTS poker_hand_actions (
  hand_id TEXT NOT NULL REFERENCES poker_hands(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  street  TEXT NOT NULL,
  seat    INTEGER NOT NULL,
  type    TEXT NOT NULL,
  amount  INTEGER NOT NULL,
  PRIMARY KEY (hand_id, seq)
);

CREATE TABLE IF NOT EXISTS poker_flags (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  tournament_id TEXT,
  reason        TEXT NOT NULL,
  score         DOUBLE PRECISION,
  reviewed      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Første sesong opprettes automatisk.
INSERT INTO poker_seasons (name, starts_at)
SELECT 'Sesong 1', now()
WHERE NOT EXISTS (SELECT 1 FROM poker_seasons);

-- ---------- Fase 4: ligaer, planlagte turneringer ----------

CREATE TABLE IF NOT EXISTS poker_leagues (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE poker_tournaments ADD COLUMN IF NOT EXISTS league_id TEXT REFERENCES poker_leagues(id);
ALTER TABLE poker_tournaments ADD COLUMN IF NOT EXISTS entrants INTEGER;
CREATE INDEX IF NOT EXISTS poker_tournaments_league ON poker_tournaments (league_id, season_id);

CREATE TABLE IF NOT EXISTS poker_scheduled (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  start_at      TIMESTAMPTZ NOT NULL,
  max_players   INTEGER NOT NULL,
  max_seats     INTEGER NOT NULL DEFAULT 9,
  structure     TEXT NOT NULL DEFAULT 'turnering',
  league_id     TEXT REFERENCES poker_leagues(id),
  status        TEXT NOT NULL DEFAULT 'open',   -- open | running | finished | cancelled
  tournament_id TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS poker_scheduled_start ON poker_scheduled (status, start_at);

CREATE TABLE IF NOT EXISTS poker_registrations (
  scheduled_id  TEXT NOT NULL REFERENCES poker_scheduled(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES poker_players(user_id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scheduled_id, user_id)
);

-- ---------- SMS-innlogging og kallenavn ----------

ALTER TABLE poker_players ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS poker_players_name_lower ON poker_players (lower(display_name));

CREATE TABLE IF NOT EXISTS poker_otp (
  phone        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
