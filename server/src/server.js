// Swipe signaling server.
//
// Hosts register with a device key and get a 9-digit code. Viewers join a
// code; the server then relays opaque messages between them. Passwords are
// verified end-to-end between the devices (SPAKE2), so the server never sees
// them -- it only enforces rate limits and lockouts that hosts report.
//
// Message reference: docs/PROTOCOL.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config as defaultConfig } from './config.js';
import { CodeRegistry, isValidDeviceKey } from './codes.js';
import { RateLimiter, FailureTracker } from './ratelimit.js';
import { iceServers } from './ice.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob: mediastream:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'display-capture=(self), fullscreen=(self), clipboard-read=(self), clipboard-write=(self)',
};

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function createServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, limits: { ...defaultConfig.limits, ...(overrides.limits || {}) } };
  const L = config.limits;
  const registry = new CodeRegistry({ dataDir: config.dataDir, expiryDays: L.codeExpiryDays });
  const joinLimiter = new RateLimiter({ capacity: L.joinBurst, refillPerSec: 1 / 10 }); // per IP
  const hostLimiter = new RateLimiter({ capacity: 10, refillPerSec: 1 / 6 }); // per IP
  const apiLimiter = new RateLimiter({ capacity: 20, refillPerSec: 1 / 3 }); // per IP
  const codeFailures = new FailureTracker({ threshold: L.failuresBeforeLock, windowMs: L.failureWindowMs });
  const ipFailures = new FailureTracker({ threshold: L.failuresBeforeLock * 4, windowMs: L.failureWindowMs });

  const hosts = new Map(); // code -> host connection
  const connsPerIp = new Map();

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '?';
  }

  // ---------- HTTP ----------

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(obj));
  }

  function readBody(req, max = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(config.webRoot, urlPath));
    if (!file.startsWith(config.webRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': MIME['.txt'], ...SECURITY_HEADERS }).end('Not found');
        return;
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
        ...SECURITY_HEADERS,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, hosts: hosts.size });
      return;
    }
    if (url.pathname === '/api/code' && req.method === 'POST') {
      // Lets a device learn its code without hosting yet (used by the iOS app,
      // whose broadcast extension does the actual hosting).
      if (!apiLimiter.take(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
      try {
        const body = JSON.parse(await readBody(req));
        if (!isValidDeviceKey(body.key)) return sendJson(res, 400, { error: 'bad_key' });
        return sendJson(res, 200, { code: registry.codeFor(body.key) });
      } catch {
        return sendJson(res, 400, { error: 'bad_request' });
      }
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res);
  });

  // ---------- WebSocket signaling ----------

  const wss = new WebSocketServer({ noServer: true, maxPayload: L.maxPayload });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if ((connsPerIp.get(ip) || 0) >= L.maxConnsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function fail(ws, error, extra = {}) {
    send(ws, { t: 'error', error, ...extra });
  }

  function onConnection(ws, ip) {
    connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
    const conn = { ws, ip, role: null, msgCount: 0, msgWindow: Date.now() };
    ws.on('pong', () => (ws._swipeAlive = true));
    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      if (now - conn.msgWindow > 1000) {
        conn.msgWindow = now;
        conn.msgCount = 0;
      }
      if (++conn.msgCount > L.msgsPerSecond) {
        ws.close(4008, 'rate limited');
        return;
      }
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      handle(conn, msg).catch((e) => console.error('[ws] handler error', e));
    });
    ws.on('close', () => {
      const n = (connsPerIp.get(ip) || 1) - 1;
      if (n <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n);
      onClose(conn);
    });
    ws.on('error', () => {});
  }

  async function handle(conn, msg) {
    switch (msg.t) {
      case 'ping':
        send(conn.ws, { t: 'pong' });
        return;
      case 'host':
        return onHost(conn, msg);
      case 'join':
        return onJoin(conn, msg);
    }
    if (conn.role === 'host') return onHostMessage(conn, msg);
    if (conn.role === 'viewer') return onViewerMessage(conn, msg);
  }

  function hostInfo(msg) {
    return {
      name: str(msg.name, 64) || 'Device',
      platform: str(msg.platform, 32),
      // what the host can do: "desktop" (mouse + keyboard), "touch", or "none"
      control: ['desktop', 'touch', 'none'].includes(msg.control) ? msg.control : 'none',
    };
  }

  async function onHost(conn, msg) {
    if (conn.role) return fail(conn.ws, 'bad_state');
    if (!hostLimiter.take(conn.ip)) return fail(conn.ws, 'rate_limited');
    if (!isValidDeviceKey(msg.key)) return fail(conn.ws, 'bad_key');
    const code = registry.codeFor(msg.key);
    const prev = hosts.get(code);
    if (prev) {
      // Same device reconnected (or a second instance): the newest wins.
      send(prev.ws, { t: 'error', error: 'replaced' });
      prev.ws.close(4001, 'replaced');
      dropHost(prev);
    }
    conn.role = 'host';
    conn.code = code;
    conn.info = hostInfo(msg);
    conn.viewers = new Map();
    hosts.set(code, conn);
    send(conn.ws, { t: 'hosted', code, ice: await iceServers(config) });
  }

  function onHostMessage(conn, msg) {
    const v = conn.viewers.get(msg.sid ?? msg.to);
    switch (msg.t) {
      case 'update':
        conn.info = hostInfo({ ...conn.info, ...msg });
        return;
      case 'msg':
        if (v && msg.data && typeof msg.data === 'object') {
          // Once the host has answered, the viewer has made a password guess.
          v.guessed = true;
          send(v.ws, { t: 'msg', data: msg.data });
        }
        return;
      case 'authok':
        if (v) {
          v.authed = true;
          clearTimeout(v.pendingTimer);
        }
        return;
      case 'authfail':
        if (v) {
          countFailure(v);
          fail(v.ws, 'auth_failed');
          v.ws.close(4003, 'auth failed');
        }
        return;
      case 'kick':
        if (v) {
          fail(v.ws, 'kicked');
          v.ws.close(4004, 'kicked');
        }
        return;
    }
  }

  async function onJoin(conn, msg) {
    if (conn.role) return fail(conn.ws, 'bad_state');
    if (ipFailures.lockedFor(conn.ip)) return fail(conn.ws, 'rate_limited');
    if (!joinLimiter.take(conn.ip)) return fail(conn.ws, 'rate_limited');
    const code = String(msg.code ?? '').replace(/\D/g, '');
    const host = hosts.get(code);
    if (!host) return fail(conn.ws, 'not_found');
    const locked = codeFailures.lockedFor(code);
    if (locked) return fail(conn.ws, 'locked', { retryIn: Math.ceil(locked / 1000) });
    if (host.viewers.size >= L.maxViewersPerHost) return fail(conn.ws, 'full');
    let pending = 0;
    for (const v of host.viewers.values()) if (!v.authed) pending++;
    if (pending >= L.maxPendingPerHost) return fail(conn.ws, 'busy');

    conn.role = 'viewer';
    conn.sid = randomBytes(9).toString('base64url');
    conn.host = host;
    conn.authed = false;
    host.viewers.set(conn.sid, conn);
    // Unauthenticated viewers may not linger.
    conn.pendingTimer = setTimeout(() => {
      if (!conn.authed) {
        fail(conn.ws, 'timeout');
        conn.ws.close(4005, 'auth timeout');
      }
    }, L.pendingTimeoutMs);
    conn.pendingTimer.unref?.();
    send(host.ws, { t: 'viewer', sid: conn.sid });
    send(conn.ws, { t: 'joined', code, host: host.info, ice: await iceServers(config) });
  }

  function onViewerMessage(conn, msg) {
    if (msg.t === 'msg' && conn.host && msg.data && typeof msg.data === 'object') {
      send(conn.host.ws, { t: 'msg', from: conn.sid, data: msg.data });
    }
  }

  function countFailure(v) {
    if (v.failCounted || v.authed || !v.host) return;
    v.failCounted = true;
    codeFailures.fail(v.host.code);
    ipFailures.fail(v.ip);
  }

  function dropHost(host) {
    if (hosts.get(host.code) === host) hosts.delete(host.code);
    for (const v of host.viewers.values()) {
      v.host = null;
      send(v.ws, { t: 'hostgone' });
    }
    host.viewers.clear();
  }

  function onClose(conn) {
    if (conn.role === 'host') dropHost(conn);
    else if (conn.role === 'viewer') {
      clearTimeout(conn.pendingTimer);
      // Leaving after a guess without authenticating counts as a failure, so
      // a client cannot probe passwords by silently disconnecting.
      if (conn.guessed) countFailure(conn);
      if (conn.host) {
        conn.host.viewers.delete(conn.sid);
        send(conn.host.ws, { t: 'left', sid: conn.sid });
      }
    }
  }

  // Keep connections alive through proxies and drop dead peers.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._swipeAlive === false) {
        ws.terminate();
        continue;
      }
      ws._swipeAlive = false;
      ws.ping();
    }
  }, 25_000);
  heartbeat.unref?.();

  function close() {
    clearInterval(heartbeat);
    joinLimiter.close();
    hostLimiter.close();
    apiLimiter.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return new Promise((r) => server.close(r));
  }

  return { server, wss, close, config, hosts };
}

// Run directly: node src/server.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { server, config } = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Swipe server listening on http://${config.host}:${config.port}`);
    console.log(`  web root: ${config.webRoot}`);
    if (!config.turnUrls.length && !config.cfTurnKeyId) {
      console.log('  note: no TURN server configured; some networks (e.g. mobile data) may fail to connect.');
    }
  });
}
