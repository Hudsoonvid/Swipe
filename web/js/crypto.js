// Swipe pairing crypto.
//
// A viewer proves it knows the host's password with SPAKE2 (a password-
// authenticated key exchange). The signaling server only relays opaque
// messages: it never learns the password, cannot test password guesses
// offline, and cannot tamper with the WebRTC offer/answer, because those are
// sent through a SecureChannel keyed by the SPAKE2 result.
//
// The exact byte layout is specified in docs/PROTOCOL.md and mirrored by the
// Android (Kotlin) and iOS (Swift) hosts. Test vectors: server/test/crypto.test.js.
//
// Works in browsers and in Node >= 20 (uses globalThis.crypto).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// RFC 3526 2048-bit MODP group (group 14), generator 2. 2 generates the
// subgroup of prime order Q = (P - 1) / 2.
export const P = BigInt(
  '0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff'
);
export const Q = (P - 1n) / 2n;
export const G = 2n;
// M and N have no known discrete log: each is (SHA-256 expansion of a label
// mod P)^2. See deriveConstant() and the test that re-derives them.
export const M = BigInt(
  '0x4e8bcbcd6027c51d25c4a67455821583123238f421d6151584d264ab765dd2d6685f2652844df349d01c6bd2ada22d4ce2331be4a695416badaa9926f289c93098cb92ee73af2d3570066d145432e0c025ba3c23fc7e66c7c2aaa3cb6c41fa3a09ba71fee3f8a1012a9e824c4d21246c50e368e9f7ec066c0cc7d0cf800b734ce59c893d7995b523ecb668a98e76a09117cac5e7c726cc7bba279fe9700a01987f27013b26d2a516295500d67474092b6d7fb068229a1a824fd7ba2b0556466d52cccd1f9e9cda12d0fef2792f55d2cd8ac213b17fa292fdb2b061575fdd18365f010b121725ff03bb36948657b8d97b525a5b142920abfcc2b2c79077f88055'
);
export const N = BigInt(
  '0x5b41daf0c14a2106a4e789f111c2b3a4a3e4df3261c7fa816b2e424db2ec9af3c715d46d8c0d4c43264cd41870253dfe0a06f63fac7825464081f041cb990ea484fe3a6e514a4bc0db49d390325fa0eba52356083d073e5bd76f75ee35c30bb92b542daa575b8f06916e17c8cbea9d5b966c7fa1bdeb262e81a138c26a41b097e2e5920421bfee4cb74b6fff4287fbf6cd4d543e0be12eafda0f6f69f882062f764b468c08c8f697351c7bdc72d66b434700839f8e9a8cb87c0d3f527a808dc08731f706617a965f673c5881934d4ef2d11045b37e3662037b7423154ef20893c6c4d0122dd283d026cf5d504568c0c6411c5a86df61d86aeb0ad29ec39a9b27'
);

const ELEMENT_BYTES = 256;
const SCALAR_BYTES = 40; // 320-bit ephemeral exponents
const PROTOCOL_LABEL = 'swipe-pake-v1';

// ---------- encoding helpers ----------

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bigToBytes(n, len) {
  const hex = n.toString(16).padStart(len * 2, '0');
  if (hex.length > len * 2) throw new Error('integer too large');
  return hexToBytes(hex);
}

export function bytesToBig(bytes) {
  return bytes.length ? BigInt('0x' + bytesToHex(bytes)) : 0n;
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// Constant-time-ish comparison of two equal-length byte arrays.
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- normalization ----------

// Session codes are 9 digits; users may type spaces or dashes.
export function normalizeCode(code) {
  return String(code ?? '').replace(/\D/g, '');
}

// Passwords are case-insensitive and ignore spaces/dashes, so they are easy to
// type on phone keyboards (which auto-capitalize). Only ASCII whitespace is
// stripped so every platform normalizes identically.
export function normalizePassword(pw) {
  return String(pw ?? '').normalize('NFKC').replace(/[ \t\r\n-]/g, '').toUpperCase();
}

// 8 characters from an alphabet without look-alikes (0/O, 1/I/L): ~39 bits.
const PW_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generatePassword(len = 8) {
  const out = [];
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      // rejection sampling keeps the distribution uniform
      if (b < 248 && out.length < len) out.push(PW_ALPHABET[b % PW_ALPHABET.length]);
    }
  }
  return out.join('');
}

export function formatPassword(pw) {
  const n = normalizePassword(pw);
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : pw;
}

export function formatCode(code) {
  const c = normalizeCode(code);
  return c.replace(/(\d{3})(?=\d)/g, '$1 ');
}

// ---------- math ----------

// Modular exponentiation with a 4-bit fixed window.
export function modPow(base, exp, mod) {
  base %= mod;
  if (exp === 0n) return 1n;
  const table = [1n, base];
  for (let i = 2; i < 16; i++) table.push((table[i - 1] * base) % mod);
  const hex = exp.toString(16);
  let r = 1n;
  for (let i = 0; i < hex.length; i++) {
    if (i) for (let s = 0; s < 4; s++) r = (r * r) % mod;
    const d = parseInt(hex[i], 16);
    if (d) r = (r * table[d]) % mod;
  }
  return r;
}

// Group membership check for a received element: in range and in the
// prime-order subgroup.
export function isValidElement(e) {
  return e > 1n && e < P - 1n && modPow(e, Q, P) === 1n;
}

async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}

async function hkdf(ikm, info, length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// Re-derives M / N from their labels (used by tests and documentation).
export async function deriveConstant(label) {
  const blocks = [];
  for (let i = 0; i < 9; i++) blocks.push(await sha256(enc.encode(`swipe-spake2-v1/${label}/${i}`)));
  const v = bytesToBig(concat(...blocks)) % P;
  return (v * v) % P;
}

export async function passwordScalar(code, password) {
  const data = concat(
    enc.encode(PROTOCOL_LABEL),
    new Uint8Array([0]),
    enc.encode(normalizeCode(code)),
    new Uint8Array([0]),
    enc.encode(normalizePassword(password))
  );
  return bytesToBig(await sha256(data));
}

// ---------- SPAKE2 ----------

// role: 'viewer' (sends X, uses M) or 'host' (sends Y, uses N).
export class Spake2 {
  constructor(role, code, password, { scalar } = {}) {
    if (role !== 'viewer' && role !== 'host') throw new Error('bad role');
    this.role = role;
    this.code = normalizeCode(code);
    this.password = password;
    this._scalar = scalar; // test hook only
  }

  // Returns this side's public element as hex.
  async start() {
    this.w = await passwordScalar(this.code, this.password);
    let x = this._scalar;
    while (!x) x = bytesToBig(randomBytes(SCALAR_BYTES));
    this.x = x;
    const mask = this.role === 'viewer' ? M : N;
    this.mine = (modPow(G, x, P) * modPow(mask, this.w, P)) % P;
    return bytesToHex(bigToBytes(this.mine, ELEMENT_BYTES));
  }

  // Consumes the peer's element; returns this side's confirmation MAC (hex).
  async finish(peerHex) {
    if (typeof peerHex !== 'string' || peerHex.length !== ELEMENT_BYTES * 2) throw new Error('bad element');
    const peer = bytesToBig(hexToBytes(peerHex));
    if (!isValidElement(peer)) throw new Error('invalid element');
    const peerMask = this.role === 'viewer' ? N : M;
    // peer / peerMask^w  ==  peer * peerMask^(Q - w)   (peerMask has order Q)
    const unmasked = (peer * modPow(peerMask, Q - (this.w % Q), P)) % P;
    const K = modPow(unmasked, this.x, P);
    const X = this.role === 'viewer' ? this.mine : peer;
    const Y = this.role === 'viewer' ? peer : this.mine;
    const tt = await sha256(
      concat(
        enc.encode(PROTOCOL_LABEL),
        new Uint8Array([0]),
        enc.encode(this.code),
        new Uint8Array([0]),
        bigToBytes(X, ELEMENT_BYTES),
        bigToBytes(Y, ELEMENT_BYTES),
        bigToBytes(K, ELEMENT_BYTES),
        bigToBytes(this.w, 32)
      )
    );
    this.transcript = tt;
    const kcViewer = await hkdf(tt, 'swipe/confirm/viewer');
    const kcHost = await hkdf(tt, 'swipe/confirm/host');
    this.keys = {
      v2h: await hkdf(tt, 'swipe/enc/v2h'),
      h2v: await hkdf(tt, 'swipe/enc/h2v'),
    };
    const myKc = this.role === 'viewer' ? kcViewer : kcHost;
    this._peerConfirm = await hmac(this.role === 'viewer' ? kcHost : kcViewer, tt);
    // Forget secrets that are no longer needed.
    this.x = undefined;
    return bytesToHex(await hmac(myKc, tt));
  }

  verify(peerConfirmHex) {
    if (typeof peerConfirmHex !== 'string' || peerConfirmHex.length !== 64) return false;
    let given;
    try {
      given = hexToBytes(peerConfirmHex);
    } catch {
      return false;
    }
    return bytesEqual(given, this._peerConfirm);
  }

  // Encrypted channel for the rest of the signaling (SDP/ICE).
  async channel() {
    const sendKey = this.role === 'viewer' ? this.keys.v2h : this.keys.h2v;
    const recvKey = this.role === 'viewer' ? this.keys.h2v : this.keys.v2h;
    return SecureChannel.create(sendKey, recvKey);
  }
}

// ---------- AES-256-GCM message channel ----------

const AAD = enc.encode('swipe/v1');

function nonceFor(counter) {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter));
  return n;
}

export class SecureChannel {
  static async create(sendKeyBytes, recvKeyBytes) {
    const ch = new SecureChannel();
    ch.sendKey = await subtle.importKey('raw', sendKeyBytes, 'AES-GCM', false, ['encrypt']);
    ch.recvKey = await subtle.importKey('raw', recvKeyBytes, 'AES-GCM', false, ['decrypt']);
    ch.sendCounter = 0;
    ch.recvCounter = 0;
    ch._recvQueue = Promise.resolve();
    return ch;
  }

  // Returns {n, c}: n is the message counter, c base64 ciphertext+tag.
  async seal(obj) {
    const n = this.sendCounter++;
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(n), additionalData: AAD },
      this.sendKey,
      enc.encode(JSON.stringify(obj))
    );
    return { n, c: bytesToBase64(new Uint8Array(ct)) };
  }

  // Messages must arrive in order (the relay is a single WebSocket); a
  // replayed, reordered or forged message throws.
  open(msg) {
    const run = async () => {
      if (!msg || msg.n !== this.recvCounter) throw new Error('out-of-order secure message');
      const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(msg.n), additionalData: AAD },
        this.recvKey,
        base64ToBytes(msg.c)
      );
      this.recvCounter++;
      return JSON.parse(dec.decode(pt));
    };
    const p = this._recvQueue.then(run);
    this._recvQueue = p.catch(() => {});
    return p;
  }
}
