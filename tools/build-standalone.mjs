// Builds swipe.html: one self-contained file (paste into any HTML runner, or
// open directly in a browser). Run: npm run build:standalone
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const crypto = readFileSync(new URL('web/js/crypto.js', root), 'utf8')
  .replace(/^export (?=(async )?(function|class|const|let) )/gm, '');
if (/^\s*(export|import)\b/m.test(crypto)) throw new Error('crypto.js has module syntax the build cannot inline');
const template = readFileSync(new URL('standalone/template.html', root), 'utf8');
const out = template.replace('/*__CRYPTO__*/', () => crypto.replace(/<\/script/gi, '<\\/script'));
writeFileSync(new URL('swipe.html', root), out);
console.log(`wrote swipe.html (${(out.length / 1024).toFixed(0)} KB)`);
