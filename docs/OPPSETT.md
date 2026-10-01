# Oppsett av PokerKloss på Railway

Denne guiden tar deg fra ZIP til en PokerKloss-server i drift. Medlemmene logger inn med SMS-kode via sms.ay.no, og telefonnummeret vises aldri for andre spillere.

Du trenger ingen egen AuthArena-tjeneste. PokerKloss sender kodene og lager innloggingstokenet selv, i samme format som AuthArena v2: RS256, issuer `ay.no`, bruker-id `tel:+47…`. Når du senere setter opp AuthArena eller medlemsportalen med det samme nøkkelparet, godtar de hverandres innlogginger uten endringer.

## Oversikt

```
App ──telefonnummer──▶ PokerKloss /auth/otp/request ──SMS──▶ sms.ay.no ──▶ medlemmets telefon
App ──kode──────────▶ PokerKloss /auth/otp/verify  ──▶ Arena-JWT (30 dager)
App ──Bearer-token──▶ PokerKloss REST + WebSocket   (tokenet sjekkes lokalt)
```

## Steg 1: Lag nøkler (på din maskin, 1 min)

```powershell
cd D:\Fl\pokerkloss
npm install
npm run nokler -w server
```

Da lages `server\arena-nokler.env` med tre linjer:

| Linje | Hva | Hvor den skal |
| --- | --- | --- |
| `ARENA_JWT_PRIVATE_KEY` | Signerer innloggingene | Bare i PokerKloss (og AuthArena senere) |
| `ARENA_JWT_PUBLIC_KEY` | Sjekker innloggingene | Trengs ikke i PokerKloss. Ta vare på den til andre tjenester. |
| `OTP_PEPPER` | Gjør lagrede koder umulige å gjette | Bare i PokerKloss |

Legg filen i passordmanageren din og slett den fra disken etterpå. Den skal aldri inn i git, i en chat eller i et skjermbilde med verdiene synlige. Filen er lagt i `.gitignore`.

## Steg 2: Railway-prosjekt og database

1. Railway → **New Project** → **Deploy from GitHub repo**. Velg repoet med PokerKloss. Er det ikke på GitHub ennå: `git init`, commit og push rotmappen `pokerkloss` til et nytt privat repo først.
2. Tjenesten skal bygge fra **rotmappen** (ikke `server`). Railway kjører `npm install` og `npm start` av seg selv.
3. Legg til database: i prosjektet **+ Create → Database → PostgreSQL**.
4. Gi prosjektet navnet `pokerkloss`, så det ligger ved siden av DriveArena, aymedia og sms-gateway-server.

## Steg 3: Variabler

Gå til PokerKloss-tjenesten → **Variables → Raw Editor** og lim inn dette. Bytt ut det som står i `<…>`:

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
ARENA_JWT_PRIVATE_KEY="<hele verdien fra arena-nokler.env>"
OTP_PEPPER="<verdien fra arena-nokler.env>"
AYNO_BASE_URL=https://sms.ay.no
AYNO_API_KEY=<samme som AYNO_API_KEY i drivearena-backend, eller en egen nøkkel fra Ayno Connect>
AYNO_SENDER_NAME=PokerKloss
POKER_ADMIN_IDS=tel:+47<ditt nummer>
```

| Variabel | Kommentar |
| --- | --- |
| `NODE_ENV` | Hindrer at dev-innlogging kan slås på ved en feil |
| `DATABASE_URL` | Railway-referanse. Tabellene lages automatisk ved oppstart. |
| `ARENA_JWT_PRIVATE_KEY` | Med `\n` i én linje, slik skriptet lager den |
| `AYNO_API_KEY` | Samme verdi som i DriveArena fungerer. Kan Ayno Connect lage flere nøkler, er en egen for PokerKloss ryddigst, for da kan den trekkes tilbake alene. |
| `AYNO_SMS_PATH` | Trengs ikke. Standard er `/api/3rdparty/v1/message`, samme som DriveArena bruker. |
| `POKER_ADMIN_IDS` | Din bruker-id er `tel:` + nummeret ditt med +47, f.eks. `tel:+4792200977`. Flere skilles med komma. |

Disse skal **ikke** settes nå: `POKER_DEV_AUTH` (serveren nekter å starte med den i produksjon), `POKER_KREV_MEDLEMSKAP` og `MEDLEMARENA_URL` (se steg 6).

## Steg 4: Domene

Tjenesten → **Settings → Networking → Generate Domain** gir en `…up.railway.app`-adresse. Vil du heller ha `poker.ay.no`: **Custom Domain** → `poker.ay.no`, og legg inn CNAME-posten Railway viser hos DNS-leverandøren din. WebSocket virker uten ekstra oppsett.

Etter deploy viser loggen (Deployments → siste → Logs):

```
PokerKloss-server på port 8080
  lager: postgres · innlogging: AuthArena (offentlig nøkkel) · issuer: ay.no
  SMS-innlogging: på (https://sms.ay.no)
  ratet spill: alle innloggede som har bekreftet 18 år · admin: tel:+47…
```

| Står det … | Betyr det |
| --- | --- |
| `SMS-innlogging: av (ARENA_JWT_PRIVATE_KEY mangler)` | Nøkkelen er ikke satt |
| `ARENA_JWT_PRIVATE_KEY kunne ikke leses` | Nøkkelen er limt inn feil. Ta hele linjen fra filen, med `-----BEGIN` og `-----END`. |
| `nøkkel OK, men AYNO_* mangler` | `AYNO_BASE_URL` eller `AYNO_API_KEY` mangler |
| `lager: memory` | `DATABASE_URL` mangler. Alt forsvinner ved omstart. |

## Steg 5: Test innloggingen fra PowerShell

```powershell
$base = "https://poker.ay.no"      # eller Railway-adressen

# 1. Be om kode. SMS kommer til telefonen.
Invoke-RestMethod -Method Post "$base/auth/otp/request" -ContentType "application/json" -Body '{"phone":"92200977"}'

# 2. Bekreft med koden fra SMS-en
$r = Invoke-RestMethod -Method Post "$base/auth/otp/verify" -ContentType "application/json" -Body '{"phone":"92200977","code":"123456"}'
$h = @{ Authorization = "Bearer $($r.token)" }

# 3. Velg kallenavn og bekreft alder
Invoke-RestMethod -Method Put "$base/poker/me/name" -Headers $h -ContentType "application/json" -Body '{"name":"Andre"}'
Invoke-RestMethod -Method Post "$base/poker/me/confirm-age" -Headers $h -ContentType "application/json" -Body '{"over18":true}'

# 4. Sjekk
Invoke-RestMethod "$base/poker/me" -Headers $h
```

Forventet i steg 4: `userId: tel:+4792200977`, `name: Andre`, `rated: True`, `admin: True`.

**Kommer det ingen SMS**, men steg 1 svarer `ok: True`? Da har sms.ay.no tatt imot meldingen, men gateway-telefonen har ikke sendt den. Det er samme situasjon som dere feilsøkte med DriveArena i juni: sjekk at Ayno Connect-appen kjører på gateway-telefonen, og at den har SMS-tillatelse. Svarer steg 1 med `sms_failed`, avviste sms.ay.no kallet. Sjekk `AYNO_API_KEY`.

## Steg 6: Senere, når medlemsportalen er i drift

Frem til medlem.ay.no er ute, kan alle som logger inn med SMS og bekrefter at de er 18 år spille ratet. Treningsbord er åpne for alle innloggede.

Når medlemsportalen kjører:

1. Gi medlemsportalen **samme** `ARENA_JWT_PRIVATE_KEY`, eller bare `ARENA_JWT_PUBLIC_KEY` hvis den ikke selv skal utstede innlogging. Da er `tel:+47…` den samme brukeren begge steder.
2. Legg til de to feltene `husstand` og `over16` i `/api/v1/status` hvis 16-årsregelen for familieinnmeldte skal gjelde (se nederst).
3. Sett i PokerKloss: `MEDLEMARENA_URL=https://medlem.ay.no` og `POKER_KREV_MEDLEMSKAP=1`.

Da gjelder: aktivt medlem og 18 år, eller 16 år ved familieinnmelding. Egenbekreftelsen av alder brukes ikke lenger.

Tillegget i status-ruten til medlemsportalen (tilpass til koden din):

```js
const alder = medlem.fodselsaar ? new Date().getFullYear() - Number(medlem.fodselsaar) - 1 : null; // konservativt
res.json({ aktiv, gyldigTil, aldersgruppe: aldersgruppeFor(medlem.fodselsaar), grenser,
  husstand: !!medlem.husstand_id, over16: alder !== null && alder >= 16 });
```

## Sikkerhet som er bygget inn

- Koden er 6 siffer, gyldig i 5 minutter og kan brukes én gang. Den lagres bare som hash med pepper.
- Maks 5 feil forsøk per kode, 30 sekunder mellom hver SMS til samme nummer, maks 5 SMS per nummer per time og maks 20 forespørsler per IP per 10 minutter.
- Telefonnummeret vises aldri for andre. Nye brukere får et midlertidig navn (`Spiller-K7QX`) til de velger kallenavn, og nummer som kallenavn avvises. Kallenavn er unike, og `Ai-Bot` er reservert for botene.
- Tokenet varer i 30 dager (`POKER_TOKEN_DAYS`). Appen ber om ny kode når det går ut.

## API for Flutter-appen

| Kall | Body | Svar |
| --- | --- | --- |
| `POST /auth/otp/request` | `{ phone }` | `{ ok, expiresInSeconds }`. Feil: 400 ugyldig nummer, 429 vent litt, 502 SMS feilet. |
| `POST /auth/otp/verify` | `{ phone, code }` | `{ token, userId, name, needsName }`. Feil: 401 feil kode, 410 utløpt, 429 for mange forsøk. |
| `PUT /poker/me/name` | `{ name }` | 409 hvis opptatt |
| `POST /poker/me/confirm-age` | `{ over18: true }` | |
| `GET /poker/me` | | `needsName`, `ageConfirmed`, `rated`, `ratedReason`, `admin` … |

Flyten i appen blir: telefonnummer → kode → (hvis `needsName`) velg kallenavn → (før første ratede spill) «Jeg bekrefter at jeg er 18 år» → lobby. Lagre tokenet i `flutter_secure_storage` og send det som `Authorization: Bearer` på REST og som `?token=` på WebSocket.
