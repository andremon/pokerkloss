# PokerKloss

Gratis Texas Hold'em for A5 Arena. Ingen penger, ingen kjøp. Det eneste som står på spill er en ferdighetsrating.

## Innhold

| Mappe | Hva |
| --- | --- |
| `packages/poker-core` | Spillmotoren. Ren logikk uten nett og database: tilstandsmaskin, etterprøvbar stokking, hånd-evaluator, side-poter, flerbordsturnering med bordbalansering, blindstrukturer og Ai-treningsbot. Ingen avhengigheter. |
| `packages/poker-rating` | OpenSkill-rating (Plackett-Luce) basert på sluttplassering. Vist rating starter på 1000. |
| `server` | Node/Express + WebSocket. Treningsbord mot bots, ratet kø (heads-up, SNG 6, SNG 9), planlagte klubbturneringer over flere bord, ligaer, sesonger, toppliste, håndhistorikk, Postgres- eller minnelager. |
| `server/public/dev.html` | Enkel nettleserklient for testing (bare i dev-modus, på `/dev`). Flutter-appen kommer i neste fase. |

## Kom i gang (Windows / PowerShell)

Prosjektet er et npm-workspace. Kjør `npm install` én gang i rotmappen, så installeres alt for alle pakkene.

```powershell
cd D:\Fl\pokerkloss
npm install
npm run dev          # dev-innlogging på, åpne http://localhost:8080/dev
```

`npm start` starter uten dev-innlogging (produksjon). Da må `ARENA_JWT_PRIVATE_KEY` og `AYNO_*` være satt for at noen skal kunne logge inn (se docs/OPPSETT.md).

Med Postgres (Railway):

```powershell
$env:DATABASE_URL="postgres://..."; npm run migrate -w server; npm start
```

Har du en eldre utpakking med `node_modules` i `server` eller `packages\*`, slett dem før `npm install`.

## Tester

```powershell
npm test                  # alt, fra rotmappen
# eller hver for seg:
cd packages\poker-core;   npm test   # 44 tester, inkl. alle 2 598 960 hender, 3000 tilfeldige hender og 25 simulerte flerbordsturneringer
cd ..\poker-rating;       npm test
cd ..\..\server;          npm test   # integrasjon over ekte WebSocket, inkl. en hel klubbkveld med 11 spillere på 3 bord
$env:PG_TEST_URL="postgres://postgres@localhost:5432/poker_test"; npm test   # også Postgres-lageret
```

## Regler som er bygd inn

- Sjetonger lagres aldri på spilleren. De lever bare i én turnering, og alle starter likt (1 500).
- Rating oppdateres bare av plassering, ikke av antall sjetonger. Da gir det ingenting å gi bort sjetonger.
- Ratet spill krever aktivt medlemskap i A5 Arena: 18 år, eller 16 år ved familieinnmelding. Treningsbord er åpne for alle innloggede.
- Bots får aldri være med i ratet spill og heter alltid «Ai-Bot …».
- To spillere fra samme IP-adresse settes ikke ved samme ratede bord.
- Stokking kan etterprøves: `seedHash` sendes ved start av hånden og `seed` ved slutt. `shuffleDeck(seed)` gir nøyaktig kortene som ble delt.

## Innlogging og medlemskap

Medlemmene logger inn med SMS-kode via sms.ay.no (Ayno Connect). PokerKloss utsteder selv en Arena-JWT (RS256, issuer `ay.no`, bruker-id `tel:+47…`), i samme format som AuthArena v2. Telefonnummeret vises aldri for andre spillere; alle velger kallenavn.

Ratet spill: frem til medlemsportalen er i drift, kreves at brukeren bekrefter 18 år. Med `POKER_KREV_MEDLEMSKAP=1` og `MEDLEMARENA_URL` avgjør MedlemArena (18 år, eller 16 ved familieinnmelding).

**Steg for steg på Railway, med test fra PowerShell: [docs/OPPSETT.md](docs/OPPSETT.md).**

## Miljøvariabler (server)

| Variabel | Standard | Hva |
| --- | --- | --- |
| `PORT` | 8080 | |
| `DATABASE_URL` | – | Tom = minnelager (bare for utvikling) |
| `POKER_DEV_AUTH` | – | `1` (eller `npm run dev`) = `dev:<id>:<navn>`-tokens og `/dev`-klient. Stopper hvis `NODE_ENV=production`. |
| `ARENA_JWT_PRIVATE_KEY` | – | Signerer SMS-innlogginger (lag med `npm run nokler -w server`) |
| `OTP_PEPPER` | – | Hemmelig tillegg til kode-hashen |
| `AYNO_BASE_URL`, `AYNO_API_KEY` | – | sms.ay.no, samme som DriveArena |
| `AYNO_SENDER_NAME` / `AYNO_SMS_PATH` | PokerKloss / `/api/3rdparty/v1/message` | |
| `OTP_TTL_MIN` / `POKER_TOKEN_DAYS` | 5 / 30 | Kodens og tokenets levetid |
| `POKER_KREV_MEDLEMSKAP` | – | `1` = ratet spill krever medlemskap i MedlemArena |
| `ARENA_JWT_PUBLIC_KEY` | – | Bare hvis tokens utstedes et annet sted (AuthArena). Ellers avledes den fra den private. |
| `AUTHARENA_JWKS_URL` | – | Alternativ til offentlig nøkkel |
| `ARENA_JWT_ISSUER` | ay.no | |
| `AUTHARENA_AUDIENCE` | – | Kreves bare hvis satt |
| `MEDLEMARENA_URL` | – | f.eks. `https://medlem.ay.no` |
| `POKER_TURN_MS` / `POKER_TIMEBANK_MS` | 20000 / 30000 | Betenkningstid og tidsbank |
| `POKER_NEXT_HAND_MS` | 3000 | Pause mellom hender |
| `POKER_ADMIN_IDS` | – | Kommaseparerte bruker-id-er (AuthArena) som kan opprette turneringer, ligaer og sesonger |
| `POKER_SCHEDULER_TICK_MS` | 5000 | Hvor ofte planlagte turneringer sjekkes for start |

## Klubbturneringer, ligaer og sesonger (fase 4)

Alle turneringer kjører på flerbordsmotoren. Heads-up og sit-and-go er bare en turnering med ett bord.

- **Planlagt turnering:** en administrator oppretter med navn, starttid, maks antall spillere, bordstørrelse, blindstruktur og eventuell liga. Medlemmer melder seg på og av frem til start.
- **Ved start:** medlemskap og alder sjekkes på nytt. Er færre enn 2 gyldige påmeldt, avlyses turneringen og de påmeldte varsles. Ellers fordeles spillerne tilfeldig på bord.
- **Underveis:** bordene balanseres etter hver hånd. Overflødige bord brytes, og til slutt blir det ett finalebord. Den som ryker ut, frigjøres med én gang og kan spille noe annet.
- **Ligapoeng:** antall spillere du endte foran + 1. Vinneren av en turnering med 20 spillere får 20 poeng og sistemann 1. Poengene summeres per liga og sesong.
- **Ny sesong:** ferdigheten (mu) tas med videre, men usikkerheten (sigma) økes, slik at ratingen kan justere seg raskt. Topplisten starter tom, og du kommer på den etter første ratede turnering.

Admin-eksempler (PowerShell):

```powershell
$h = @{ Authorization = "Bearer <token>" }
Invoke-RestMethod -Method Post -Uri $base/poker/admin/leagues -Headers $h -ContentType 'application/json' -Body '{"name":"Klubbkveld Oslo"}'
Invoke-RestMethod -Method Post -Uri $base/poker/admin/tournaments -Headers $h -ContentType 'application/json' `
  -Body '{"name":"Onsdagspoker","startAt":"2026-10-07T19:00:00+02:00","maxPlayers":60,"maxSeats":9,"structure":"turnering","leagueId":"klubbkveld-oslo"}'
Invoke-RestMethod -Method Post -Uri $base/poker/admin/seasons -Headers $h -ContentType 'application/json' -Body '{"name":"Vår 2027"}'
```

## REST

| Metode | Sti | Hva |
| --- | --- | --- |
| GET | `/poker/me` | Profil, om du kan spille ratet, aktiv turnering, kø |
| GET | `/poker/lobby` | Pågående turneringer, køer, kommende klubbturneringer |
| POST / DELETE | `/poker/sng/queue` | Stå i / gå ut av ratet kø `{format: hu\|sng6\|sng9}` |
| POST | `/poker/training` | Treningsbord mot Ai-bots `{bots: 1–8}` |
| GET | `/poker/tournaments`, `/poker/tournaments/:id` | Planlagte turneringer, påmeldte, live-status og resultat |
| POST / DELETE | `/poker/tournaments/:id/register` | Meld på / av |
| GET | `/poker/leagues`, `/poker/leagues/:id/standings` | Ligaer og ligatabell for gjeldende sesong |
| GET | `/poker/seasons/current` | Gjeldende sesong |
| GET | `/poker/leaderboard`, `/poker/players/:id` | Toppliste og spillerprofil |
| GET | `/poker/hands/:id` | Håndhistorikk (bare for de som satt i hånden) |
| POST | `/poker/admin/tournaments`, `/poker/admin/leagues`, `/poker/admin/seasons` | Administrasjon |
| DELETE | `/poker/admin/tournaments/:id` | Avlys før start |

## WebSocket-protokoll (`/poker/ws?token=...`)

Alle meldinger om spill har `tournamentId`. Hendelser har i tillegg `tableId` (bordet i turneringen, f.eks. `T2`).

Klient → server: `table.join {tournamentId}`, `action {tournamentId, action:{type, amount?}}` der type er `fold|check|call|bet|raise|allin` og `amount` er «høyn til», `sitout`/`sitin {tournamentId}`, `ping`.

Server → klient: `hello`, `match.found`, `scheduled.started`, `scheduled.cancelled`, `table.state`, `table.moved`, `tournament.update` (gjenværende, bord, snitt-stack), `eliminated`, `turn.deadline`, `sitout`, `error`, og `events` med motorens hendelser: `level`, `hand.start`, `post`, `cards.private` (bare egne kort), `turn`, `action.applied`, `board`, `uncalled.returned`, `allin.runout`, `showdown`, `pots.awarded`, `hand.end` (med `seed`), `tournament.result`.

Endret fra v0.1: `tableId` i klientmeldinger heter nå `tournamentId` (gammelt navn godtas fortsatt), og `table.state.seats` har fast lengde med `null` for tomme seter.

## Kjente forenklinger (v0.1)

- Flyttende knapp (ikke «dead button»). Ved overgang til heads-up kan en spiller i sjeldne tilfeller betale BB to ganger på rad.
- Flere ufullstendige all-in-høyninger som til sammen utgjør en full høyning, åpner ikke runden igjen.
- Ved showdown vises alle gjenværende hender (ingen mucking ennå).
- Spilleren som flyttes ved balansering er den som sitter sist ved bordet, ikke den som står for tur til big blind.
- Ingen sen påmelding eller re-buy.
- Bordtilstand ligger i minnet på én serverinstans. En omstart avbryter pågående bord.
