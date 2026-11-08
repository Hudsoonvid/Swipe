// Builds swipe.html: one self-contained file (paste into any HTML runner, or
// open directly in a browser). Run: npm run build:standalone
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const crypto = readFileSync(new URL('web/js/crypto.js', root), 'utf8')
  .replace(/^export (?=(async )?(function|class|const|let) )/gm, '');
if (/^\s*(export|import)\b/m.test(crypto)) throw new Error('crypto.js has module syntax the build cannot inline');
// QR code generator (MIT, Kazuhiko Arase), as a plain script defining `qrcode`.
const qr = readFileSync(new URL('web/vendor/qrcode.mjs', root), 'utf8')
  .replace(/^export const qrcode = /m, 'var qrcode = ')
  .replace(/^export default qrcode;\s*$/m, '')
  .replace(/^export const stringToBytes = qrcode\.stringToBytes;\s*$/m, '');
if (/^\s*export\b/m.test(qr)) throw new Error('qrcode.mjs has module syntax the build cannot inline');
// Remote-control input (mouse, touch, keyboard, zoom) shared with the web app.
const input = readFileSync(new URL('web/js/input.js', root), 'utf8').replace(/^export (?=class )/gm, '');
if (/^\s*(export|import)\b/m.test(input)) throw new Error('input.js has module syntax the build cannot inline');
// The tablet control deck (keyboard, trackpad, hotkeys); a plain script.
const deck = readFileSync(new URL('standalone/deck.js', root), 'utf8');
const template = readFileSync(new URL('standalone/template.html', root), 'utf8');
const out = template
  .replace('/*__CRYPTO__*/', () => crypto.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__QRCODE__*/', () => qr.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__INPUT__*/', () => input.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__DECK__*/', () => deck.replace(/<\/script/gi, '<\\/script'));
writeFileSync(new URL('swipe.html', root), out);
console.log(`wrote swipe.html (${(out.length / 1024).toFixed(0)} KB)`);
