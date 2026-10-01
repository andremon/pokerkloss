// Lager en Arena-JWT for testing av PokerKloss mot ekte token-verifisering.
//
//   npm run token -w server -- <sub> "<navn>"
//
// Med ARENA_JWT_PRIVATE_KEY satt (samme nøkkel som AuthArena bruker) signeres tokenet med den,
// og det virker mot en server som har ARENA_JWT_PUBLIC_KEY. Uten nøkkel lages et midlertidig
// nøkkelpar, og både offentlig nøkkel og token skrives ut – start serveren med den nøkkelen.
//
// Tokenet varer i 12 timer. Bruk det bare til testing.
import { SignJWT, importPKCS8, generateKeyPair, exportSPKI } from 'jose';

const [sub = 'test:andre', name = 'Andre'] = process.argv.slice(2);
const issuer = process.env.ARENA_JWT_ISSUER || 'ay.no';
const pem = process.env.ARENA_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');

let privateKey;
if (pem) {
  privateKey = await importPKCS8(pem, 'RS256');
} else {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const pub = (await exportSPKI(pair.publicKey)).trim().replace(/\n/g, '\\n');
  console.log('Ingen ARENA_JWT_PRIVATE_KEY – laget et midlertidig nøkkelpar.');
  console.log('Start serveren med denne offentlige nøkkelen (PowerShell):\n');
  console.log(`$env:ARENA_JWT_PUBLIC_KEY="${pub}"\n`);
}

let jwt = new SignJWT({ sub, name, role: 'user' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setIssuedAt().setExpirationTime('12h');
if (process.env.AUTHARENA_AUDIENCE) jwt = jwt.setAudience(process.env.AUTHARENA_AUDIENCE);
console.log(`Token for sub=${sub} (${name}), issuer=${issuer}, gyldig 12 t:\n`);
console.log(await jwt.sign(privateKey));
