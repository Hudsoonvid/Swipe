import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  P, Q, G, M, N, modPow, deriveConstant, isValidElement, Spake2, SecureChannel,
  normalizePassword, normalizeCode, generatePassword, passwordScalar, bytesToHex,
} from '../../web/js/crypto.js';

const vectors = JSON.parse(readFileSync(new URL('../../docs/test-vectors.json', import.meta.url)));

test('group constants', async () => {
  assert.equal(P % 8n, 7n); // 2 is a quadratic residue => generates the order-Q subgroup
  assert.equal(modPow(G, Q, P), 1n);
  assert.equal(await deriveConstant('M'), M);
  assert.equal(await deriveConstant('N'), N);
  assert.ok(isValidElement(M) && isValidElement(N));
  assert.ok(!isValidElement(1n) && !isValidElement(P - 1n) && !isValidElement(P));
  assert.ok(!isValidElement(P - 2n)); // -2 is a non-residue (P = 7 mod 8)
});

test('modPow matches naive exponentiation', () => {
  const naive = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; e >>= 1n; b = b * b % m; } return r; };
  for (const [b, e] of [[3n, 0n], [3n, 1n], [5n, 0x10n], [M, 0xabcdef0123456789n], [N, Q - 5n]]) {
    assert.equal(modPow(b, e, P), naive(b, e, P));
  }
});

test('normalization', () => {
  assert.equal(normalizePassword(' k7m2-px9q '), 'K7M2PX9Q');
  assert.equal(normalizePassword('ａｂｃ'), 'ABC'); // NFKC full-width
  assert.equal(normalizeCode('123 456-789'), '123456789');
  const pw = generatePassword();
  assert.match(pw, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
});

async function handshake(code, pwViewer, pwHost) {
  const v = new Spake2('viewer', code, pwViewer);
  const h = new Spake2('host', code, pwHost);
  const X = await v.start();
  const Y = await h.start();
  const confirmHost = await h.finish(X);
  const confirmViewer = await v.finish(Y);
  return { v, h, ok: v.verify(confirmHost) && h.verify(confirmViewer) && v.verify(confirmHost) };
}

test('SPAKE2 succeeds with matching passwords (case/dash-insensitive)', async () => {
  const { v, h, ok } = await handshake('123456789', 'abcd-efgh', 'ABCDEFGH');
  assert.ok(ok);
  const cv = await v.channel();
  const ch = await h.channel();
  const m1 = await cv.seal({ type: 'offer', sdp: 'hello' });
  assert.deepEqual(await ch.open(m1), { type: 'offer', sdp: 'hello' });
  const m2 = await ch.seal({ type: 'answer' });
  assert.deepEqual(await cv.open(m2), { type: 'answer' });
  // replay is rejected
  await assert.rejects(cv.open(m2));
});

test('SPAKE2 fails with a wrong password or a different code', async () => {
  assert.equal((await handshake('123456789', 'abcdefgh', 'abcdefgi')).ok, false);
  const v = new Spake2('viewer', '123456789', 'pw');
  const h = new Spake2('host', '123456780', 'pw');
  const X = await v.start(); const Y = await h.start();
  const ch = await h.finish(X); const cv = await v.finish(Y);
  assert.ok(!v.verify(ch) && !h.verify(cv));
});

test('rejects invalid elements', async () => {
  const h = new Spake2('host', '123456789', 'pw');
  await h.start();
  for (const bad of [1n, 0n, P - 1n, P]) {
    await assert.rejects(h.finish(bad.toString(16).padStart(512, '0').slice(-512)));
  }
  await assert.rejects(h.finish('zz'));
});

test('tampered ciphertext is rejected', async () => {
  const { v, h } = await handshake('111222333', 'x', 'x');
  const cv = await v.channel(); const ch = await h.channel();
  const m = await cv.seal({ a: 1 });
  const bytes = Buffer.from(m.c, 'base64'); bytes[0] ^= 1;
  await assert.rejects(ch.open({ n: m.n, c: bytes.toString('base64') }));
});

test('published test vectors (shared with Android/iOS)', async () => {
  for (const tv of vectors.spake2) {
    assert.equal(bytesToHex(new Uint8Array(Buffer.from((await passwordScalar(tv.code, tv.password)).toString(16).padStart(64, '0'), 'hex'))), tv.w);
    const v = new Spake2('viewer', tv.code, tv.password, { scalar: BigInt('0x' + tv.x) });
    const h = new Spake2('host', tv.code, tv.password, { scalar: BigInt('0x' + tv.y) });
    assert.equal(await v.start(), tv.X);
    assert.equal(await h.start(), tv.Y);
    assert.equal(await h.finish(tv.X), tv.confirmHost);
    assert.equal(await v.finish(tv.Y), tv.confirmViewer);
    assert.equal(bytesToHex(v.transcript), tv.transcript);
    assert.equal(bytesToHex(v.keys.v2h), tv.keyV2H);
    assert.equal(bytesToHex(v.keys.h2v), tv.keyH2V);
    const cv = await v.channel();
    assert.deepEqual(await cv.seal(tv.message.plain), tv.message.sealed);
  }
});

test('a different context (e.g. swapped DTLS fingerprints) fails', async () => {
  const run = async (cv, ch) => {
    const v = new Spake2('viewer', '123456789', 'pw', { context: cv });
    const h = new Spake2('host', '123456789', 'pw', { context: ch });
    const X = await v.start(); const Y = await h.start();
    const c1 = await h.finish(X); const c2 = await v.finish(Y);
    return v.verify(c1) && h.verify(c2);
  };
  assert.ok(await run('v=aa|h=bb', 'v=aa|h=bb'));
  assert.ok(!(await run('v=aa|h=bb', 'v=aa|h=cc')));
});
