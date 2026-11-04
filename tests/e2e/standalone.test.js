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

async function open(fakeScreen = false, { native = false } = {}) {
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
  if (native) {
    // Stands in for the Swipe Host app's preload bridge; records injected input.
    await ctx.addInitScript(() => {
      window.__inputs = [];
      window.swipeNative = {
        platform: 'linux',
        hostname: 'Test PC',
        canControl: true,
        getScreens: async () => [{ id: 's1', name: 'Screen 1' }],
        selectScreen: async () => {},
        input: (e) => window.__inputs.push(e),
        releaseInput: () => window.__inputs.push({ t: 'release' }),
        setStatus() {},
        notifyViewers() {},
        onCommand() {},
        attention: () => (window.__attention = (window.__attention || 0) + 1),
      };
    });
  }
  const page = await ctx.newPage();
  await page.goto(pageUrl);
  return { ctx, page };
}

test('browser host (view only): connect with code + password, receive video, see why there is no control', { timeout: 60_000 }, async () => {
  const host = await open(true);
  // A plain browser offers the Swipe Host download first; view-only sharing is the fallback.
  assert.equal(await host.page.isVisible('#dlMain'), true);
  assert.match(await host.page.getAttribute('#dlMain', 'href'), /releases\/latest/);
  await host.page.click('#viewOnlyBtn');
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');
  assert.match(code, /^\d{9}$/);
  assert.match(await host.page.textContent('#controlNote'), /Install Swipe Host/);

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
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('1 device connected'));
  // The device is told plainly why it can't control this PC.
  await viewer.page.waitForSelector('#viewOnlyNote:not([hidden])');
  assert.match(await viewer.page.textContent('#viewOnlyNote'), /web browser.*Install Swipe Host/);
  assert.equal(await viewer.page.isHidden('#kbBtn'), true);

  // No meeting features anywhere.
  for (const id of ['chatBtn', 'micBtn', 'camBtn', 'handBtn', 'reactBtn', 'pointBtn', 'tiles', 'hostChat', 'hostMicBtn']) {
    assert.equal(await viewer.page.locator(`#${id}`).count(), 0, id);
  }

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
  assert.match(await viewer.page.textContent('#connectErr'), /isn.t online right now/);
  await viewer.ctx.close();
});

test('several monitors: devices switch screens; quality, auto-reconnect, invite link', { timeout: 120_000 }, async () => {
  const host = await open(true);
  await host.page.click('#viewOnlyBtn');
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
  const sam = await join('Laptop'); // desktop-sized viewport, so labels are long
  assert.equal(await sam.page.isHidden('#nextScreenBtn'), true);

  // A second screen appears for the device, which can flip between them.
  await host.page.click('#addScreenBtn');
  await sam.page.waitForFunction(() => document.getElementById('video').videoWidth === 800, null, { timeout: 15_000 });
  await sam.page.waitForSelector('#nextScreenBtn:not([hidden])');
  assert.equal(await sam.page.textContent('#screenLabel'), 'Screen 2 (2/2)');
  await sam.page.click('#nextScreenBtn');
  await sam.page.waitForFunction(() => document.getElementById('video').videoWidth === 1280 && document.getElementById('screenLabel').textContent === 'Screen 1 (1/2)', null, { timeout: 15_000 });
  assert.equal(await host.page.textContent('#hostScreens .chip.on'), 'Screen 1');

  // A second device joins with a link that carries the code and password.
  const tv = await open();
  await tv.page.evaluate(() => localStorage.setItem('swipe1.name', 'TV'));
  await tv.page.goto('about:blank');
  await tv.page.goto(`${pageUrl}#c=${code}&p=${password}`);
  await tv.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden, null, { timeout: 30_000 });
  assert.equal(await tv.page.evaluate(() => location.hash), '');

  // Data saver lowers the bitrate for that device only.
  await sam.page.click('#moreBtn');
  await sam.page.click('#moreMenu [data-q="saver"]');
  const bitrates = async () => host.page.evaluate(() => [...window.__swipe.host.viewers.values()].map((v) => {
    const s = v.call.peerConnection.getSenders().find((x) => x.track?.kind === 'video');
    return [v.name, s.getParameters().encodings[0].maxBitrate];
  }));
  for (let i = 0; i < 50 && !(await bitrates()).some(([n, b]) => n === 'Laptop' && b === 800000); i++) await host.page.waitForTimeout(100);
  assert.deepEqual(Object.fromEntries(await bitrates()), { Laptop: 800000, TV: 10000000 });

  // Network drop: the device reconnects by itself.
  await sam.page.evaluate(() => window.__swipe.view.conn.peerConnection.close());
  await sam.page.waitForFunction(() => document.getElementById('overlayText').textContent.includes('Reconnecting'), null, { timeout: 10_000 });
  await sam.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden && window.__swipe.view.authed, null, { timeout: 40_000 });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('2 devices connected'), null, { timeout: 15_000 });

  // A disconnected device doesn't come back on its own.
  await host.page.click('#viewerList li:has-text("TV") button');
  await tv.page.waitForSelector('#home:not([hidden])', { timeout: 10_000 });
  assert.match(await tv.page.textContent('#connectErr'), /disconnected you/);
  await tv.page.waitForTimeout(3000);
  assert.equal(await tv.page.isVisible('#session'), false);

  for (const c of [sam, tv, host]) await c.ctx.close();
});

test('remote control: approval, mouse and keys, trusted reconnect, view only, unpair', { timeout: 150_000 }, async () => {
  // The Swipe Host app starts sharing by itself and asks before a new device connects.
  const host = await open(true, { native: true });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  assert.equal(await host.page.isChecked('#askNew'), true);
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');

  const tablet = await open();
  await tablet.page.fill('#codeIn', code);
  await tablet.page.fill('#pwIn', password);
  await tablet.page.fill('#nameIn', 'Tablet');
  await tablet.page.click('#connectBtn');
  await tablet.page.waitForFunction(() => document.getElementById('overlayText').textContent.includes('Waiting for someone at the PC'), null, { timeout: 20_000 });
  await host.page.waitForSelector('#askBox:not([hidden])');
  assert.match(await host.page.textContent('#askText'), /Tablet.*control this PC/);
  assert.ok(await host.page.evaluate(() => window.__attention >= 1));
  await host.page.click('#askAllow');
  const live = (p) => p.waitForFunction(() => document.getElementById('video').videoWidth > 0 && document.getElementById('overlay').hidden && window.__swipe.view.authed, null, { timeout: 30_000 });
  await live(tablet.page);
  await tablet.page.waitForFunction(() => window.__swipe.view.control === 'desktop');
  assert.equal(await tablet.page.isVisible('#kbBtn'), true);
  assert.equal(await tablet.page.isHidden('#viewOnlyNote'), true);

  // Mouse: a click in the middle of the picture lands in the middle of the PC's screen.
  const inputs = () => host.page.evaluate(() => window.__inputs);
  const waitInput = (pred) => host.page.waitForFunction(`window.__inputs.some(${pred})`, null, { timeout: 10_000 });
  await host.page.waitForFunction(() => window.__swipe.host.viewers.size && [...window.__swipe.host.viewers.values()][0].inputConn?.open, null, { timeout: 10_000 });
  const box = await tablet.page.locator('#video').boundingBox();
  await tablet.page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await tablet.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await tablet.page.mouse.down();
  await tablet.page.mouse.up();
  await waitInput("(e) => e.t === 'pu'");
  const pd = (await inputs()).find((e) => e.t === 'pd');
  assert.ok(Math.abs(pd.x - 0.5) < 0.03 && Math.abs(pd.y - 0.5) < 0.03 && pd.b === 0, JSON.stringify(pd));
  await waitInput("(e) => e.t === 'pm'"); // moves use the lossy channel
  // Keyboard goes to the PC (even letters that are shortcuts when not controlling).
  await tablet.page.keyboard.press('f');
  await tablet.page.keyboard.press('Escape');
  await waitInput("(e) => e.t === 'kd' && e.code === 'Escape'");
  assert.ok((await inputs()).some((e) => (e.t === 'kd' && e.code === 'KeyF') || (e.t === 'tx' && e.text === 'f')));
  assert.equal(await tablet.page.evaluate(() => !!document.fullscreenElement), false);

  // Paired: after a reload the tablet lists the PC and reconnects without the password or a prompt.
  await host.page.waitForFunction(() => document.querySelectorAll('#deviceList .chip').length === 2);
  await tablet.page.reload();
  await tablet.page.waitForSelector('#pcList .main:has-text("Test PC")');
  assert.equal(await tablet.page.inputValue('#pwIn'), '');
  await tablet.page.click('#pcList .main');
  await live(tablet.page);
  assert.equal(await host.page.isHidden('#askBox'), true);
  await tablet.page.waitForFunction(() => window.__swipe.view.control === 'desktop');

  // The PC owner makes the tablet view-only: its input is ignored from then on.
  await host.page.click('#deviceList .chip:has-text("Can control")');
  await tablet.page.waitForFunction(() => window.__swipe.view.control === 'none');
  assert.equal(await tablet.page.isVisible('#kbBtn'), false);
  await host.page.evaluate(() => (window.__inputs.length = 0));
  await tablet.page.mouse.click(box.x + 10, box.y + 10);
  await tablet.page.keyboard.press('Enter');
  await host.page.waitForTimeout(800);
  assert.deepEqual((await inputs()).filter((e) => e.t !== 'release'), []);
  await host.page.click('#deviceList .chip:has-text("View only")');
  await tablet.page.waitForFunction(() => window.__swipe.view.control === 'desktop');

  // Unpair: the tablet is disconnected and needs the password again.
  await host.page.click('#deviceList button:has-text("Remove")');
  await tablet.page.waitForSelector('#home:not([hidden])', { timeout: 10_000 });
  await tablet.page.reload();
  await tablet.page.click('#pcList .main');
  await tablet.page.waitForSelector('#home:not([hidden])', { timeout: 20_000 });
  assert.match(await tablet.page.textContent('#connectErr'), /password/i);
  assert.equal(await tablet.page.isHidden('#pcsWrap'), true);

  // A stranger with the right password is turned away when the owner says no.
  const other = await open();
  await other.page.fill('#codeIn', code);
  await other.page.fill('#pwIn', password);
  await other.page.click('#connectBtn');
  await host.page.waitForSelector('#askBox:not([hidden])', { timeout: 20_000 });
  await host.page.click('#askDeny');
  await other.page.waitForSelector('#home:not([hidden])', { timeout: 10_000 });
  assert.match(await other.page.textContent('#connectErr'), /declined|denied|didn.t allow|not allow/i);

  for (const c of [tablet, other, host]) await c.ctx.close();
});

test('game controller drives the keyboard and mouse', { timeout: 90_000 }, async () => {
  const host = await open(true, { native: true });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  await host.page.uncheck('#askNew');
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');
  const tv = await open();
  await tv.page.evaluate(() => {
    const pad = { index: 0, id: 'Test pad', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  await tv.page.fill('#codeIn', code);
  await tv.page.fill('#pwIn', password);
  await tv.page.click('#connectBtn');
  await tv.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && window.__swipe.view.control === 'desktop', null, { timeout: 30_000 });
  await tv.page.evaluate(() => {
    const e = new Event('gamepadconnected');
    e.gamepad = window.__pad;
    window.dispatchEvent(e);
  });
  await tv.page.waitForSelector('#padBtn:not([hidden])');
  const waitInput = (pred) => host.page.waitForFunction(`window.__inputs.some(${pred})`, null, { timeout: 10_000 });
  // Games layout: A = Space, left stick = WASD, right stick = mouse, right trigger = left click.
  await tv.page.evaluate(() => { window.__pad.buttons[0].pressed = true; window.__pad.axes[1] = -1; window.__pad.axes[2] = 0.5; window.__pad.buttons[7].pressed = true; });
  await waitInput("(e) => e.t === 'kd' && e.code === 'Space'");
  await waitInput("(e) => e.t === 'kd' && e.code === 'KeyW'");
  await waitInput("(e) => e.t === 'mm' && e.dx > 0 && e.dy === 0");
  await waitInput("(e) => e.t === 'pd' && e.b === 0");
  await tv.page.evaluate(() => { window.__pad.buttons[0].pressed = false; window.__pad.axes[1] = 0; window.__pad.axes[2] = 0; window.__pad.buttons[7].pressed = false; });
  await waitInput("(e) => e.t === 'ku' && e.code === 'Space'");
  await waitInput("(e) => e.t === 'ku' && e.code === 'KeyW'");
  await waitInput("(e) => e.t === 'pu' && e.b === 0");
  // Desktop layout: left stick moves the pointer.
  await tv.page.click('#moreBtn');
  await tv.page.click('#moreMenu [data-pad="desktop"]');
  await host.page.evaluate(() => (window.__inputs.length = 0));
  await tv.page.evaluate(() => { window.__pad.axes[0] = -1; });
  await waitInput("(e) => e.t === 'mm' && e.dx === -24");
  for (const c of [tv, host]) await c.ctx.close();
});
