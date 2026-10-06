// Regenerates docs/test-vectors.json. Run: node server/test/gen-vectors.js
import { writeFileSync } from 'node:fs';
import { Spake2, passwordScalar, bytesToHex } from '../../web/js/crypto.js';

const cases = [
  { code: '123456789', password: 'K7M2-PX9Q', x: '1f'.repeat(40), y: '2e'.repeat(40) },
  { code: '987 654 321', password: 'hunter two', x: 'a5'.repeat(40), y: '5a'.repeat(40) },
];
const out = { note: 'SPAKE2 test vectors; see docs/PROTOCOL.md. Message sealed with the viewer->host key.', spake2: [] };
for (const c of cases) {
  const v = new Spake2('viewer', c.code, c.password, { scalar: BigInt('0x' + c.x) });
  const h = new Spake2('host', c.code, c.password, { scalar: BigInt('0x' + c.y) });
  const X = await v.start(), Y = await h.start();
  const confirmHost = await h.finish(X), confirmViewer = await v.finish(Y);
  const plain = { type: 'offer', sdp: 'v=0' };
  const ch = await v.channel();
  out.spake2.push({
    ...c, w: (await passwordScalar(c.code, c.password)).toString(16).padStart(64, '0'),
    X, Y, transcript: bytesToHex(v.transcript), confirmViewer, confirmHost,
    keyV2H: bytesToHex(v.keys.v2h), keyH2V: bytesToHex(v.keys.h2v),
    message: { plain, plainJson: JSON.stringify(plain), sealed: await ch.seal(plain) },
  });
}
writeFileSync(new URL('../../docs/test-vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('wrote docs/test-vectors.json');
