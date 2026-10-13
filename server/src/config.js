import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

function list(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  webRoot: path.resolve(env.WEB_ROOT || path.join(here, '..', '..', 'web')),
  // Directory for persisting device -> code assignments (optional).
  dataDir: env.DATA_DIR || '',
  // Use X-Forwarded-For for client IPs (only behind a trusted reverse proxy).
  trustProxy: bool(env.TRUST_PROXY),

  stunUrls: env.STUN_URLS !== undefined ? list(env.STUN_URLS) : ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  // TURN relays make connections work across strict NATs / mobile networks.
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '', // coturn "use-auth-secret" shared secret
  turnUsername: env.TURN_USERNAME || '', // or static credentials
  turnPassword: env.TURN_PASSWORD || '',
  turnTtl: Number(env.TURN_TTL || 12 * 3600),
  // Cloudflare Realtime TURN (https://developers.cloudflare.com/realtime/turn/)
  cfTurnKeyId: env.CF_TURN_KEY_ID || '',
  cfTurnToken: env.CF_TURN_API_TOKEN || '',

  limits: {
    maxViewersPerHost: Number(env.MAX_VIEWERS || 8),
    maxPendingPerHost: 3,
    joinBurst: 12, // join attempts per IP before throttling (then 1 per 10 s)
    pendingTimeoutMs: 60_000,
    maxConnsPerIp: Number(env.MAX_CONNS_PER_IP || 40),
    maxPayload: 64 * 1024,
    msgsPerSecond: 300,
    // failed password attempts on one code before it is temporarily locked
    failuresBeforeLock: 5,
    failureWindowMs: 15 * 60_000,
    codeExpiryDays: Number(env.CODE_EXPIRY_DAYS || 60),
  },
};
