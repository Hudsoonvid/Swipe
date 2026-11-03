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
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
      let calls = 0;
      navigator.mediaDevices.getDisplayMedia = async () => {
        // First "screen" is 1280x720, any later one 800x600.
        const c = document.createElement('canvas');
        c.width = calls ? 800 : 1280;
        c.height = calls++ ? 600 : 720;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => { g.fillStyle = `hsl(${(i += 9) % 360} 70% 45%)`; g.fillRect(0, 0, c.width, c.height); }, 33);
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

test('switch between shared screens and chat with everyone', { timeout: 90_000 }, async () => {
  const host = await open(true);
  await host.page.click('#shareBtn');
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');

  async function join(name) {
    const v = await open();
    await v.page.fill('#codeIn', code);
    await v.page.fill('#pwIn', password);
    await v.page.fill('#nameIn', name);
    await v.page.click('#connectBtn');
    await v.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden, null, { timeout: 30_000 });
    return v;
  }
  const sam = await join('Sam'); // desktop-sized viewport, so labels are long
  const alex = await join('Alex');

  // Only one screen: no switch buttons yet.
  assert.equal(await sam.page.isHidden('#nextScreenBtn'), true);

  // Host adds a second screen; it is shown right away and viewers get the buttons.
  await host.page.click('#addScreenBtn');
  await sam.page.waitForFunction(() => document.getElementById('video').videoWidth === 800, null, { timeout: 15_000 });
  await sam.page.waitForSelector('#nextScreenBtn:not([hidden])');
  assert.equal(await sam.page.textContent('#screenLabel'), 'Screen 2 (2/2)');

  // A viewer taps ▶: everyone moves to the next screen (wraps to Screen 1).
  await sam.page.click('#nextScreenBtn');
  for (const v of [sam, alex]) {
    await v.page.waitForFunction(() => document.getElementById('video').videoWidth === 1280, null, { timeout: 15_000 });
    await v.page.waitForFunction(() => document.getElementById('screenLabel').textContent === 'Screen 1 (1/2)');
  }
  assert.equal(await host.page.textContent('#hostScreens .chip.on'), 'Screen 1');

  // Chat: Sam writes, Alex and the host see it; the host replies to both.
  await sam.page.click('#chatBtn');
  await sam.page.fill('#viewChatIn', 'hello <b>everyone</b>');
  await sam.page.press('#viewChatIn', 'Enter');
  await host.page.waitForFunction(() => document.getElementById('hostChat').textContent.includes('Samhello <b>everyone</b>'));
  await alex.page.waitForSelector('#chatBadge:not([hidden])');
  assert.equal(await alex.page.textContent('#chatPop'), 'Samhello <b>everyone</b>');
  assert.equal(await alex.page.locator('#viewChat b').count(), 1); // text is not turned into HTML
  await host.page.fill('#hostChatIn', 'hi both');
  await host.page.press('#hostChatIn', 'Enter');
  for (const v of [sam, alex]) {
    await v.page.waitForFunction(() => document.getElementById('viewChat').textContent.includes('hi both'));
  }
  assert.match(await sam.page.textContent('#viewChat'), /Alex joined/);

  // A viewer leaving shows up in chat for everyone else.
  await alex.ctx.close();
  await sam.page.waitForFunction(() => document.getElementById('viewChat').textContent.includes('Alex left'), null, { timeout: 15_000 });
  await sam.ctx.close();
  await host.ctx.close();
});

test('meeting: cameras and mics, hands, reactions, pointer, quality, reconnect, kick, invite link', { timeout: 120_000 }, async () => {
  const host = await open(true);
  await host.page.click('#shareBtn');
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');
  // The host sees a live preview of what viewers see.
  await host.page.waitForFunction(() => document.getElementById('hostPreview').videoWidth === 1280);

  async function join(name) {
    const v = await open();
    await v.page.fill('#codeIn', code);
    await v.page.fill('#pwIn', password);
    await v.page.fill('#nameIn', name);
    await v.page.click('#connectBtn');
    await v.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden, null, { timeout: 30_000 });
    return v;
  }
  const sam = await join('Sam');
  // Alex joins with an invite link that carries the code and password.
  const alex = await open();
  await alex.page.evaluate(() => localStorage.setItem('swipe1.name', 'Alex')); // remembered name
  await alex.page.goto('about:blank');
  await alex.page.goto(`${pageUrl}#c=${code}&p=${password}`);
  await alex.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden, null, { timeout: 30_000 });
  assert.equal(await alex.page.evaluate(() => location.hash), '');
  const samId = await sam.page.evaluate(() => window.__swipe.view.peer.id);

  // Everyone appears as a tile.
  await host.page.waitForFunction(() => document.querySelectorAll('#hostPeople .tile').length === 3);
  await sam.page.waitForFunction(() => document.querySelectorAll('#tiles .tile').length === 3);

  // Sam turns on camera and mic: the host and Alex get Sam's live video.
  await sam.page.click('#camBtn');
  await sam.page.click('#micBtn');
  for (const p of [host.page, alex.page]) {
    await p.waitForFunction((id) => {
      const v = document.querySelector(`.tile[data-id="${id}"] video`);
      return v && v.videoWidth > 0 && !v.muted && !document.querySelector(`.tile[data-id="${id}"] .name`).textContent.includes('🔇');
    }, samId, { timeout: 20_000 });
  }
  // Sam's own preview is shown (muted, never played back to Sam).
  assert.equal(await sam.page.evaluate(() => document.querySelector('#tiles .tile.me video')?.muted), true);

  // Muting updates everyone's view.
  await sam.page.click('#micBtn');
  await alex.page.waitForFunction((id) => document.querySelector(`.tile[data-id="${id}"] .name`)?.textContent.includes('🔇'), samId);

  // The host turns on a mic too; viewers get it.
  await host.page.click('#hostMicBtn');
  const hostId = await host.page.evaluate(() => window.__swipe.host.peer.id);
  await sam.page.waitForFunction((id) => !!document.querySelector(`.tile[data-id="${id}"] video`), hostId, { timeout: 20_000 });

  // Raise hand.
  await alex.page.click('#handBtn');
  await host.page.waitForFunction(() => document.getElementById('hostChat').textContent.includes('✋ Alex raised a hand'));
  await sam.page.waitForFunction(() => [...document.querySelectorAll('#tiles .name')].some((n) => n.textContent.includes('✋')));

  // Reactions float up for everyone.
  await sam.page.click('#reactBtn');
  await sam.page.click('#reactMenu >> text=🎉');
  for (const p of [host.page, alex.page, sam.page]) await p.waitForSelector('#reactLayer .react:has-text("🎉")', { timeout: 5000 });

  // Pointer: Alex taps the middle of the screen; Sam and the host see it there.
  await alex.page.click('#pointBtn');
  const box = await alex.page.locator('#video').boundingBox();
  await alex.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sam.page.waitForSelector('#pingLayer .ping', { state: 'attached', timeout: 5000 });
  await host.page.waitForSelector('#hostPingLayer .ping', { state: 'attached', timeout: 5000 });
  const pos = await host.page.evaluate(() => {
    const p = document.querySelector('#hostPingLayer .ping').getBoundingClientRect();
    const r = document.getElementById('hostPreview').getBoundingClientRect();
    return { x: (p.left - r.left) / r.width, y: (p.top - r.top) / r.height };
  });
  assert.ok(Math.abs(pos.x - 0.5) < 0.05 && Math.abs(pos.y - 0.5) < 0.05, JSON.stringify(pos));

  // Data saver: the host lowers the bitrate for Sam only.
  await sam.page.click('#moreBtn');
  await sam.page.click('#moreMenu [data-q="saver"]');
  const bitrates = async () => host.page.evaluate(() => [...window.__swipe.host.viewers.values()].map((v) => {
    const s = v.call.peerConnection.getSenders().find((x) => x.track?.kind === 'video');
    return [v.name, s.getParameters().encodings[0].maxBitrate];
  }));
  for (let i = 0; i < 50 && !(await bitrates()).some(([n, b]) => n === 'Sam' && b === 800000); i++) await host.page.waitForTimeout(100);
  assert.deepEqual(Object.fromEntries(await bitrates()), { Sam: 800000, Alex: 10000000 });

  // Network drop: Sam reconnects by itself and is back with video.
  await sam.page.evaluate(() => window.__swipe.view.conn.peerConnection.close());
  await sam.page.waitForFunction(() => document.getElementById('overlayText').textContent.includes('Reconnecting'), null, { timeout: 10_000 });
  await sam.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden && window.__swipe.view.authed, null, { timeout: 40_000 });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('2 devices watching'), null, { timeout: 15_000 });

  // Kicked viewers don't come back on their own.
  await host.page.click('#viewerList li:has-text("Alex") button');
  await alex.page.waitForSelector('#home:not([hidden])', { timeout: 10_000 });
  assert.match(await alex.page.textContent('#connectErr'), /disconnected you/);
  await alex.page.waitForTimeout(3000);
  assert.equal(await alex.page.isVisible('#session'), false);

  for (const c of [sam, alex, host]) await c.ctx.close();
});
