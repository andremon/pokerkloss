// Lager et nytt Arena-nøkkelpar (RS256) og en OTP-pepper, klart til å limes inn i Railway.
//
//   npm run nokler -w server
//
// Kjør dette på DIN maskin. Den private nøkkelen skal bare inn i tjenester som UTSTEDER
// innlogging (PokerKloss nå, AuthArena senere). Den offentlige kan deles med alle tjenester
// som bare skal SJEKKE innlogging.
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
const priv = oneLine(await exportPKCS8(privateKey));
const pub = oneLine(await exportSPKI(publicKey));
const pepper = randomBytes(24).toString('base64url');

const file = 'arena-nokler.env';
writeFileSync(file, `ARENA_JWT_PRIVATE_KEY="${priv}"\nARENA_JWT_PUBLIC_KEY="${pub}"\nOTP_PEPPER="${pepper}"\n`, { mode: 0o600 });

console.log(`Nytt Arena-nøkkelpar er lagret i server/${file}`);
console.log('');
console.log('Lim inn i Railway (PokerKloss-tjenesten → Variables → Raw Editor):');
console.log('  ARENA_JWT_PRIVATE_KEY  (hele linjen fra filen)');
console.log('  OTP_PEPPER             (hele linjen fra filen)');
console.log('');
console.log('ARENA_JWT_PUBLIC_KEY trengs ikke i PokerKloss (den regnes ut fra den private),');
console.log('men ta vare på den – andre tjenester som skal godta innloggingen, trenger den.');
console.log('');
console.log('Oppbevar filen trygt (f.eks. passordmanager) og slett den fra disken etterpå.');
console.log('Den er lagt i .gitignore og skal aldri sjekkes inn eller limes inn i en chat.');
