// The single-file swipe.html: two browsers pair through a (local) PeerJS
// server using code + password and stream the screen peer-to-peer.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const peerjs = readFileSync(require.resolve('peerjs/dist/peerjs.min.js'), 'utf8');
let server, browser, pageUrl;

before(async () => {
  server = spawn(process.execPath, [path.join(root, 'tests', 'tools', 'peer-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  pageUrl = `${pathToFileURL(path.join(root, 'swipe.html'))}?peerHost=127.0.0.1&peerPort=${port}&peerSecure=0`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function open(fakeScreen = false) {
  const ctx = await browser.newContext();
  // Serve the CDN copy of PeerJS locally.
  await ctx.route(/peerjs\.min\.js$/, (route) => route.fulfill({ contentType: 'text/javascript', body: peerjs }));
  // Public TURN servers are unreachable in CI; only use local candidates.
  await ctx.addInitScript(() => {
    const Orig = RTCPeerConnection;
    window.RTCPeerConnection = function (cfg = {}) {
      return new Orig({ ...cfg, iceServers: [] });
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
    window.RTCPeerConnection.generateCertificate = Orig.generateCertificate.bind(Orig);
  });
  if (fakeScreen) {
    await ctx.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => { g.fillStyle = `hsl(${(i += 9) % 360} 70% 45%)`; g.fillRect(0, 0, 1280, 720); }, 33);
        return c.captureStream(30);
      };
    });
  }
  const page = await ctx.newPage();
  await page.goto(pageUrl);
  return { ctx, page };
}

test('single-file page: share, connect with code + password, receive video', { timeout: 60_000 }, async () => {
  const host = await open(true);
  await host.page.click('#shareBtn');
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');
  assert.match(code, /^\d{9}$/);

  // Wrong password first.
  const bad = await open();
  await bad.page.fill('#codeIn', code);
  await bad.page.fill('#pwIn', 'WRONGPW2');
  await bad.page.click('#connectBtn');
  await bad.page.waitForSelector('#connectErr:not([hidden])', { timeout: 15_000 });
  assert.equal(await bad.page.textContent('#connectErr'), 'Wrong password.');
  await bad.ctx.close();

  const viewer = await open();
  await viewer.page.fill('#codeIn', code);
  await viewer.page.fill('#pwIn', password.toLowerCase());
  await viewer.page.click('#connectBtn');
  await viewer.page.waitForFunction(() => {
    const v = document.getElementById('video');
    return v.videoWidth === 1280 && v.currentTime > 0.3 && document.getElementById('overlay').hidden;
  }, null, { timeout: 30_000 });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('1 device watching'));

  // Host disconnects the viewer.
  await host.page.click('#viewerList button');
  await viewer.page.waitForSelector('#home:not([hidden])', { timeout: 10_000 });
  await viewer.ctx.close();
  await host.ctx.close();
});

test('unknown code shows a helpful error', { timeout: 30_000 }, async () => {
  const viewer = await open();
  await viewer.page.fill('#codeIn', '123 123 123');
  await viewer.page.fill('#pwIn', 'ABCDEFGH');
  await viewer.page.click('#connectBtn');
  await viewer.page.waitForSelector('#connectErr:not([hidden])', { timeout: 20_000 });
  assert.match(await viewer.page.textContent('#connectErr'), /No device is sharing/);
  await viewer.ctx.close();
});
