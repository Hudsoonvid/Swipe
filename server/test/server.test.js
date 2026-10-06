import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

let srv, base, wsUrl;

before(async () => {
  srv = createServer({ port: 0, stunUrls: ['stun:example.org:3478'], turnUrls: ['turn:turn.example.org:3478'], turnSecret: 's3cret', limits: { joinBurst: 100 } });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const { port } = srv.server.address();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(() => srv.close());

// Minimal client that queues incoming messages.
function client() {
  const ws = new WebSocket(wsUrl);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return {
    ws,
    closed,
    open: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((r, j) => {
            const t = setTimeout(() => j(new Error('timeout')), 2000);
            waiters.push((m) => (clearTimeout(t), r(m)));
          }),
  };
}

const key = (c) => c.repeat(43);

async function host(k = key('a'), extra = {}) {
  const h = client();
  await h.open;
  h.send({ t: 'host', key: k, name: 'Laptop', platform: 'linux', control: 'desktop', ...extra });
  const m = await h.next();
  assert.equal(m.t, 'hosted');
  return { h, code: m.code, ice: m.ice };
}

test('host gets a stable 9-digit code and ICE servers with TURN credentials', async () => {
  const { h, code, ice } = await host(key('b'));
  assert.match(code, /^\d{9}$/);
  assert.deepEqual(ice[0].urls, ['stun:example.org:3478']);
  assert.match(ice[1].username, /^\d+:[0-9a-f]+$/);
  assert.ok(ice[1].credential);
  h.ws.close();
  await h.closed;
  const again = await host(key('b'));
  assert.equal(again.code, code);
  again.h.ws.close();
});

test('viewer joins, messages are relayed both ways, leave is reported', async () => {
  const { h, code } = await host(key('c'));
  const v = client();
  await v.open;
  v.send({ t: 'join', code: code.replace(/(\d{3})/g, '$1 ') });
  const joined = await v.next();
  assert.equal(joined.t, 'joined');
  assert.deepEqual(joined.host, { name: 'Laptop', platform: 'linux', control: 'desktop' });
  const ann = await h.next();
  assert.equal(ann.t, 'viewer');
  v.send({ t: 'msg', data: { type: 'pake1', X: 'ab' } });
  assert.deepEqual(await h.next(), { t: 'msg', from: ann.sid, data: { type: 'pake1', X: 'ab' } });
  h.send({ t: 'msg', to: ann.sid, data: { type: 'pake2' } });
  assert.deepEqual(await v.next(), { t: 'msg', data: { type: 'pake2' } });
  v.ws.close();
  assert.deepEqual(await h.next(), { t: 'left', sid: ann.sid });
  h.ws.close();
});

test('unknown code is rejected', async () => {
  const v = client();
  await v.open;
  v.send({ t: 'join', code: '000000001' });
  assert.equal((await v.next()).error, 'not_found');
  v.ws.close();
});

test('repeated auth failures lock the code', async () => {
  const { h, code } = await host(key('d'));
  for (let i = 0; i < 5; i++) {
    const v = client();
    await v.open;
    v.send({ t: 'join', code });
    assert.equal((await v.next()).t, 'joined');
    const ann = await h.next();
    h.send({ t: 'authfail', sid: ann.sid });
    assert.equal((await v.next()).error, 'auth_failed');
    assert.equal(await v.closed, 4003);
    await h.next(); // left
  }
  const v = client();
  await v.open;
  v.send({ t: 'join', code });
  const m = await v.next();
  assert.equal(m.error, 'locked');
  assert.ok(m.retryIn > 0);
  v.ws.close();
  h.ws.close();
});

test('a second connection with the same device key replaces the first', async () => {
  const first = await host(key('e'));
  const second = await host(key('e'));
  assert.equal(second.code, first.code);
  assert.equal((await first.h.next()).error, 'replaced');
  assert.equal(await first.h.closed, 4001);
  second.h.ws.close();
});

test('viewers are told when the host leaves', async () => {
  const { h, code } = await host(key('f'));
  const v = client();
  await v.open;
  v.send({ t: 'join', code });
  await v.next();
  h.ws.close();
  assert.equal((await v.next()).t, 'hostgone');
  v.ws.close();
});

test('bad device keys are refused', async () => {
  const h = client();
  await h.open;
  h.send({ t: 'host', key: 'short' });
  assert.equal((await h.next()).error, 'bad_key');
  h.ws.close();
});

test('/api/code returns the same code the device hosts with', async () => {
  const res = await fetch(`${base}/api/code`, { method: 'POST', body: JSON.stringify({ key: key('g') }) });
  const { code } = await res.json();
  const { h, code: hosted } = await host(key('g'));
  assert.equal(hosted, code);
  h.ws.close();
  assert.equal((await fetch(`${base}/api/code`, { method: 'POST', body: '{"key":"x"}' })).status, 400);
});

test('serves the web app with security headers and blocks traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const js = await fetch(`${base}/js/crypto.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  const etag = js.headers.get('etag');
  assert.equal((await fetch(`${base}/js/crypto.js`, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/..%2fserver%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('viewers that disconnect after a password guess count as failures', async () => {
  const { h, code } = await host(key('h'));
  for (let i = 0; i < 5; i++) {
    const v = client();
    await v.open;
    v.send({ t: 'join', code });
    await v.next();
    const ann = await h.next();
    h.send({ t: 'msg', to: ann.sid, data: { type: 'pake2' } });
    await v.next();
    v.ws.close();
    await h.next(); // left
  }
  const v = client();
  await v.open;
  v.send({ t: 'join', code });
  assert.equal((await v.next()).error, 'locked');
  v.ws.close();
  h.ws.close();
});
