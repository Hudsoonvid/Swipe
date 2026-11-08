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

test('iPad control deck: keyboard, trackpad and hotkeys with no video; layouts and keyboard sizes', { timeout: 120_000 }, async () => {
  const host = await open(true, { native: true });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  await host.page.uncheck('#askNew');
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');

  const ipad = await open();
  await ipad.page.setViewportSize({ width: 1180, height: 820 });
  await ipad.page.fill('#codeIn', code);
  await ipad.page.fill('#pwIn', password);
  await ipad.page.fill('#nameIn', 'iPad');
  await ipad.page.click('#deckConnectBtn');
  await ipad.page.waitForSelector('#deck .kb button[data-code="KeyA"]', { timeout: 30_000 });
  assert.equal(await ipad.page.isHidden('#overlay'), true);
  // No video is sent to a keyboard & trackpad device.
  await host.page.waitForFunction(() => [...window.__swipe.host.viewers.values()].some((v) => v.authed && v.deck));
  assert.equal(await host.page.evaluate(() => [...window.__swipe.host.viewers.values()].find((v) => v.authed).call), undefined);
  assert.match(await host.page.textContent('#viewerList'), /iPad \(keyboard & trackpad\)/);
  await host.page.waitForFunction(() => window.__swipe.host.viewers.size && [...window.__swipe.host.viewers.values()][0].inputConn?.open, null, { timeout: 10_000 });

  const inputs = () => host.page.evaluate(() => window.__inputs.filter((e) => e.t !== 'release'));
  const clear = () => host.page.evaluate(() => (window.__inputs.length = 0));
  const waitFor = (pred) => host.page.waitForFunction(`window.__inputs.some(${pred})`, null, { timeout: 10_000 });
  const tapKey = async (code) => {
    const b = ipad.page.locator(`#deck .kb button[data-code="${code}"]`).first();
    await b.dispatchEvent('pointerdown', { pointerId: 7, isPrimary: true });
    await b.dispatchEvent('pointerup', { pointerId: 7, isPrimary: true });
  };

  // Default: keyboard on top, trackpad below, 80% keyboard.
  assert.deepEqual(await ipad.page.evaluate(() => [...document.querySelectorAll('#deck .dwin')].map((p) => p.dataset.panel).sort()), ['keyboard', 'trackpad']);
  assert.ok(await ipad.page.locator('#deck .kb button[data-code="F12"]').count());

  // Keys: a plain key, then Ctrl tapped alone sticks for the next key (Ctrl+C).
  await clear();
  await tapKey('KeyA');
  await tapKey('ControlLeft');
  await tapKey('KeyC');
  await waitFor("(e) => e.t === 'ku' && e.code === 'ControlLeft'");
  assert.deepEqual((await inputs()).map((e) => `${e.t}:${e.code}`), ['kd:KeyA', 'ku:KeyA', 'kd:ControlLeft', 'kd:KeyC', 'ku:KeyC', 'ku:ControlLeft']);

  // Trackpad: moving a finger moves the PC pointer (relative, across all monitors); a tap clicks.
  await clear();
  const box = await ipad.page.locator('#tpSurface').boundingBox();
  await ipad.page.mouse.move(box.x + 50, box.y + 50);
  await ipad.page.mouse.down();
  await ipad.page.mouse.move(box.x + 150, box.y + 80, { steps: 10 });
  await ipad.page.mouse.up();
  await waitFor("(e) => e.t === 'mm'");
  const moved = (await inputs()).filter((e) => e.t === 'mm');
  assert.ok(moved.every((e) => e.all === 1));
  assert.ok(moved.reduce((s, e) => s + e.dx, 0) > 100, JSON.stringify(moved));
  assert.equal((await inputs()).some((e) => e.t === 'pd'), false); // a drag is not a click
  await clear();
  await ipad.page.mouse.click(box.x + 60, box.y + 60);
  await waitFor("(e) => e.t === 'pu' && e.b === 0");
  // Two-finger tap = right click; two-finger drag = scroll.
  await clear();
  await ipad.page.evaluate(() => {
    const s = document.getElementById('tpSurface');
    const r = s.getBoundingClientRect();
    const ev = (type, id, x, y) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch' }));
    ev('pointerdown', 1, 50, 50); ev('pointerdown', 2, 90, 50);
    ev('pointerup', 1, 50, 50); ev('pointerup', 2, 90, 50);
  });
  await waitFor("(e) => e.t === 'pu' && e.b === 2");
  await ipad.page.evaluate(async () => {
    const s = document.getElementById('tpSurface');
    const r = s.getBoundingClientRect();
    const ev = (type, id, x, y) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch' }));
    ev('pointerdown', 3, 50, 150); ev('pointerdown', 4, 90, 150);
    for (let i = 1; i <= 10; i++) {
      ev('pointermove', 3, 50, 150 - i * 8); ev('pointermove', 4, 90, 150 - i * 8);
      await new Promise((r) => requestAnimationFrame(r));
    }
    ev('pointerup', 3, 50, 70); ev('pointerup', 4, 90, 70);
  });
  await waitFor("(e) => e.t === 'wh' && e.dy > 0"); // fingers up = scroll down (natural)
  await ipad.page.waitForTimeout(1500); // let the scroll glide finish

  // Layout settings: presets, keyboard size and the Fn layer.
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button:has-text("Keyboard left, trackpad right")');
  await ipad.page.click('#deckSheet button:has-text("60%")');
  await ipad.page.click('#deckSheet button:has-text("Done")');
  const kbBox = await ipad.page.locator('#deck .dwin[data-panel="keyboard"]').boundingBox();
  const tpBox = await ipad.page.locator('#deck .dwin[data-panel="trackpad"]').boundingBox();
  assert.ok(kbBox.x < tpBox.x && Math.abs(kbBox.y - tpBox.y) < 2, 'keyboard left, trackpad right');
  assert.equal(await ipad.page.locator('#deck .kb button[data-code="F12"]').count(), 0);
  await clear();
  await tapKey('Fn');
  await tapKey('Digit1');
  await waitFor("(e) => e.t === 'kd' && e.code === 'F1'");
  for (const size of ['70%', '90%', '100%']) {
    await ipad.page.click('#deckBtn');
    await ipad.page.click(`#deckSheet button:has-text("${size}")`);
    await ipad.page.click('#deckSheet button:has-text("Done")');
  }
  assert.ok(await ipad.page.locator('#deck .kb button[data-code="NumpadEnter"]').count());

  // Hotkeys: a built-in one, then a new macro made in the editor.
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button:has-text("Hotkeys + trackpad")');
  await ipad.page.click('#deckSheet button:has-text("Done")');
  await clear();
  await ipad.page.click('#deck .hk button:has-text("Task Manager")');
  await waitFor("(e) => e.t === 'ku' && e.code === 'ControlLeft'");
  assert.deepEqual((await inputs()).map((e) => `${e.t}:${e.code}`), ['kd:ControlLeft', 'kd:ShiftLeft', 'kd:Escape', 'ku:Escape', 'ku:ShiftLeft', 'ku:ControlLeft']);
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button:has-text("Edit hotkeys")');
  await ipad.page.click('#deck .hk button.add');
  await ipad.page.fill('#hkIcon', '📝');
  await ipad.page.fill('#hkLabel', 'Notepad');
  await ipad.page.fill('#hkAction', 'Ctrl+Banana');
  await ipad.page.click('#hkSave');
  assert.equal(await ipad.page.textContent('#deckSheet .err'), 'Unknown key "Banana"'); // bad input is explained, not saved
  await ipad.page.fill('#hkAction', 'Win+R, wait 100, "notepad", Enter');
  await ipad.page.click('#hkSave');
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button:has-text("Done editing")');
  await clear();
  await ipad.page.click('#deck .hk button:has-text("Notepad")');
  await waitFor("(e) => e.t === 'ku' && e.code === 'Enter'");
  assert.deepEqual((await inputs()).map((e) => e.t === 'tx' ? `tx:${e.text}` : `${e.t}:${e.code}`),
    ['kd:MetaLeft', 'kd:KeyR', 'ku:KeyR', 'ku:MetaLeft', 'tx:notepad', 'kd:Enter', 'ku:Enter']);

  // The layout is remembered for next time.
  await ipad.page.click('#endBtn');
  await ipad.page.click('#pcList .deck-go');
  await ipad.page.waitForSelector('#deck .hk button:has-text("Notepad")', { timeout: 30_000 });
  for (const c of [ipad, host]) await c.ctx.close();
});

test('iPad deck: Screen window (touch directly), Direct mode, monitor switch, Apple Pencil, Mac gestures, windows you can move', { timeout: 150_000 }, async () => {
  const host = await open(true, { native: true });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  await host.page.uncheck('#askNew');
  // Two monitors on the PC.
  await host.page.evaluate(() => {
    window.swipeNative.getScreens = async () => [{ id: 's1', name: 'Screen 1' }, { id: 's2', name: 'Screen 2' }];
    window.swipeNative.platform = 'win32'; // gestures map to Windows shortcuts
  });
  await host.page.click('#stopBtn');
  await host.page.click('#shareBtn');
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');

  const ipad = await open();
  await ipad.page.setViewportSize({ width: 1180, height: 820 });
  await ipad.page.fill('#codeIn', code);
  await ipad.page.fill('#pwIn', password);
  await ipad.page.click('#deckConnectBtn');
  await ipad.page.waitForSelector('#deck .kb', { timeout: 30_000 });
  await host.page.waitForFunction(() => [...window.__swipe.host.viewers.values()].some((v) => v.authed && v.inputConn?.open), null, { timeout: 10_000 });
  const inputs = () => host.page.evaluate(() => window.__inputs.filter((e) => e.t !== 'release'));
  const clear = () => host.page.evaluate(() => (window.__inputs.length = 0));
  const waitFor = (pred) => host.page.waitForFunction(`window.__inputs.some(${pred})`, null, { timeout: 10_000 });
  const viewerHasVideo = () => host.page.evaluate(() => !![...window.__swipe.host.viewers.values()].find((v) => v.authed).call);
  assert.equal(await viewerHasVideo(), false);

  // Screen + keyboard preset: the PC sends its picture only now.
  await ipad.page.evaluate(() => window.__swipe.deck.applyPreset('screen-kb'));
  await ipad.page.waitForFunction(() => document.querySelector('#deck .scr video')?.videoWidth > 0, null, { timeout: 20_000 });
  assert.equal(await viewerHasVideo(), true);
  // A tap on the middle of the picture taps the middle of the screen (snapping on by default).
  await clear();
  const box = await ipad.page.locator('#scrSurface').boundingBox();
  const vr = await ipad.page.evaluate(() => { const v = document.querySelector('#deck .scr video'); return [v.videoWidth, v.videoHeight]; });
  await ipad.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor("(e) => e.t === 'tap'");
  const tap = (await inputs()).find((e) => e.t === 'tap');
  assert.ok(Math.abs(tap.x - 0.5) < 0.02 && Math.abs(tap.y - 0.5) < 0.02 && tap.snap === 1 && tap.b === 0, JSON.stringify({ tap, vr }));
  // Monitor switch from the Screen window.
  await ipad.page.waitForSelector('#deck .scr-bar:not([hidden])');
  await ipad.page.click('#deck .scr-bar button:has-text("▶")');
  await host.page.waitForFunction(() => window.__swipe.host.active === 1, null, { timeout: 10_000 });
  await ipad.page.waitForFunction(() => document.querySelector('#deck .scr-bar span').textContent.includes('2/2'));

  // Apple Pencil on the picture: hover, a stroke with pressure and tilt, then a quick tap that may snap.
  await clear();
  await ipad.page.evaluate(async () => {
    const s = document.getElementById('scrSurface');
    const r = s.getBoundingClientRect();
    const ev = (type, x, y, extra = {}) => s.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', clientX: r.left + x, clientY: r.top + y, bubbles: true, ...extra }));
    ev('pointermove', 100, 100, { pressure: 0 });
    await new Promise((res) => setTimeout(res, 30));
    ev('pointerdown', 100, 100, { pressure: 0.3, tiltX: 20, tiltY: -5, buttons: 1 });
    for (let i = 1; i <= 5; i++) ev('pointermove', 100 + i * 10, 100, { pressure: 0.3 + i * 0.1, tiltX: 20, buttons: 1 });
    ev('pointerup', 150, 100, { pressure: 0 });
    // A palm touching the screen while writing is ignored.
    s.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: r.left + 300, clientY: r.top + 200, bubbles: true }));
    s.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'touch', clientX: r.left + 300, clientY: r.top + 200, bubbles: true }));
    await new Promise((res) => setTimeout(res, 50));
    ev('pointerdown', 200, 150, { pressure: 0.5, buttons: 1 });
    ev('pointerup', 200, 150, { pressure: 0 });
  });
  await waitFor("(e) => e.t === 'tap'");
  const pen = (await inputs()).filter((e) => e.t === 'pen');
  assert.deepEqual(pen.map((e) => e.s), ['hover', 'down', 'move', 'move', 'move', 'move', 'move', 'up']);
  assert.equal(pen[1].p, 0.3);
  assert.equal(pen[1].tx, 20);
  assert.ok(pen[5].p > pen[2].p, 'pressure follows the pencil');
  assert.equal((await inputs()).filter((e) => e.t === 'tap').length, 1, 'palm ignored, pencil tap sent once');

  // Hide the screen: the picture stops, the device stays connected.
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button[data-panel="screen"]');
  await ipad.page.click('#deckSheet button:has-text("Done")');
  await host.page.waitForFunction(() => ![...window.__swipe.host.viewers.values()].find((v) => v.authed).call, null, { timeout: 10_000 });
  await ipad.page.click('#deckBtn');
  await ipad.page.click('#deckSheet button[data-panel="trackpad"]');
  await ipad.page.click('#deckSheet button:has-text("Done")');

  // Direct mode on the trackpad: no picture, but the spot you touch is the spot on screen.
  await ipad.page.click('#tpMode');
  await ipad.page.waitForSelector('#tpMode:has-text("Direct")');
  await clear();
  const tp = await ipad.page.locator('#tpSurface').boundingBox();
  await ipad.page.mouse.click(tp.x + tp.width * 0.25, tp.y + tp.height * 0.75);
  await waitFor("(e) => e.t === 'tap'");
  const dt = (await inputs()).find((e) => e.t === 'tap');
  assert.ok(Math.abs(dt.x - 0.25) < 0.02 && Math.abs(dt.y - 0.75) < 0.02, JSON.stringify(dt));
  await ipad.page.click('#tpMode');

  const touch = async (fingers) => ipad.page.evaluate(async (fingers) => {
    const s = document.getElementById('tpSurface');
    const r = s.getBoundingClientRect();
    const ev = (type, id, x, y) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, bubbles: true }));
    const n = fingers.length;
    fingers.forEach((f, i) => ev('pointerdown', 10 + i, f[0][0], f[0][1]));
    const steps = fingers[0].length;
    for (let k = 1; k < steps; k++) {
      fingers.forEach((f, i) => ev('pointermove', 10 + i, f[k][0], f[k][1]));
      await new Promise((res) => requestAnimationFrame(res));
    }
    fingers.forEach((f, i) => ev('pointerup', 10 + i, f[steps - 1][0], f[steps - 1][1]));
    return n;
  }, fingers);
  const line = (x0, y0, x1, y1, n = 8) => Array.from({ length: n + 1 }, (_, k) => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  const combo = async () => (await inputs()).filter((e) => e.t === 'kd' || e.t === 'ku').map((e) => `${e.t}:${e.code}`);

  // Three fingers up: Task View (Win+Tab).
  await clear();
  await touch([line(100, 250, 100, 120), line(160, 250, 160, 120), line(220, 250, 220, 120)]);
  await waitFor("(e) => e.t === 'ku' && e.code === 'MetaLeft'");
  assert.deepEqual(await combo(), ['kd:MetaLeft', 'kd:Tab', 'ku:Tab', 'ku:MetaLeft']);
  // Three fingers left: next desktop (Ctrl+Win+Right).
  await clear();
  await touch([line(300, 150, 150, 150), line(300, 200, 150, 200), line(300, 250, 150, 250)]);
  await waitFor("(e) => e.t === 'ku' && e.code === 'ControlLeft'");
  assert.deepEqual(await combo(), ['kd:ControlLeft', 'kd:MetaLeft', 'kd:ArrowRight', 'ku:ArrowRight', 'ku:MetaLeft', 'ku:ControlLeft']);
  // Pinch out: zoom in with Ctrl + wheel.
  await clear();
  await touch([line(200, 200, 120, 200), line(260, 200, 340, 200)]);
  await waitFor("(e) => e.t === 'wh' && e.dy < 0");
  assert.equal((await inputs())[0].code, 'ControlLeft');
  // Three-finger tap: middle click.
  await clear();
  await touch([line(100, 100, 101, 100, 1), line(150, 100, 151, 100, 1), line(200, 100, 201, 100, 1)]);
  await waitFor("(e) => e.t === 'pu' && e.b === 1");
  // Two-finger flick scrolls further than the fingers moved (momentum, faster).
  await clear();
  await touch([line(150, 300, 150, 120, 6), line(210, 300, 210, 120, 6)]);
  await host.page.waitForTimeout(600);
  const scrolled = (await inputs()).filter((e) => e.t === 'wh').reduce((t, e) => t + e.dy, 0);
  assert.ok(scrolled > 400, `scrolled ${scrolled}`);

  // Hold the space bar and slide: the keyboard becomes a trackpad (no space typed).
  await clear();
  const space = ipad.page.locator('#deck .kb button[data-code="Space"]');
  const sb = await space.boundingBox();
  await ipad.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await ipad.page.mouse.down();
  await ipad.page.waitForTimeout(500);
  await ipad.page.mouse.move(sb.x + sb.width / 2 + 60, sb.y + sb.height / 2, { steps: 6 });
  await ipad.page.mouse.up();
  await waitFor("(e) => e.t === 'mm'");
  assert.equal((await inputs()).some((e) => e.code === 'Space'), false);
  await clear();
  await space.dispatchEvent('pointerdown', { pointerId: 4 });
  await space.dispatchEvent('pointerup', { pointerId: 4 });
  await waitFor("(e) => e.t === 'ku' && e.code === 'Space'");

  // Arrange (Stage Manager style): shrink the keyboard window from its corner, then drag it by its bar.
  await ipad.page.click('#deckArrangeBtn');
  await ipad.page.waitForSelector('#deck.arranging .dwin[data-panel="keyboard"] .dwin-bar');
  const before = await ipad.page.evaluate(() => ({ ...window.__swipe.deck.config.windows.keyboard }));
  const size = await ipad.page.locator('#deck .dwin[data-panel="keyboard"] .dwin-size').boundingBox();
  await ipad.page.mouse.move(size.x + 10, size.y + 10);
  await ipad.page.mouse.down();
  await ipad.page.mouse.move(size.x - 500, size.y + 10, { steps: 6 });
  await ipad.page.mouse.up();
  const after = await ipad.page.evaluate(() => ({ ...window.__swipe.deck.config.windows.keyboard }));
  assert.ok(after.w < before.w - 30, JSON.stringify({ before, after }));
  const bar = await ipad.page.locator('#deck .dwin[data-panel="keyboard"] .dwin-bar').boundingBox();
  await ipad.page.mouse.move(bar.x + 60, bar.y + 15);
  await ipad.page.mouse.down();
  await ipad.page.mouse.move(bar.x + 60 + 300, bar.y + 15 - 200, { steps: 8 });
  await ipad.page.mouse.up();
  const resized = await ipad.page.evaluate(() => ({ ...window.__swipe.deck.config.windows.keyboard }));
  assert.ok(resized.x > after.x + 10 && resized.y < after.y - 10, JSON.stringify({ after, resized }));
  await ipad.page.click('#deckArrangeBtn');
  assert.equal(await ipad.page.locator('#deck.arranging').count(), 0);
  await ipad.page.reload();
  assert.deepEqual(await ipad.page.evaluate(() => JSON.parse(localStorage.getItem('swipe1.deck')).windows.keyboard), resized);
  for (const c of [ipad, host]) await c.ctx.close();
});

test('screen view: Apple Pencil draws with pressure, a quick tap may snap, palms are ignored', { timeout: 90_000 }, async () => {
  const host = await open(true, { native: true });
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('Waiting'), null, { timeout: 15_000 });
  await host.page.uncheck('#askNew');
  const code = (await host.page.textContent('#myCode')).replace(/\s/g, '');
  const password = await host.page.textContent('#myPw');
  const v = await open();
  await v.page.fill('#codeIn', code);
  await v.page.fill('#pwIn', password);
  await v.page.click('#connectBtn');
  await v.page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && window.__swipe.view.control === 'desktop', null, { timeout: 30_000 });
  await host.page.evaluate(() => (window.__inputs.length = 0));
  await v.page.evaluate(async () => {
    const s = document.getElementById('stage');
    const vid = document.getElementById('video').getBoundingClientRect();
    const ev = (type, id, kind, x, y, p) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: kind, clientX: vid.left + vid.width * x, clientY: vid.top + vid.height * y, pressure: p, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
    ev('pointerdown', 5, 'pen', 0.25, 0.25, 0.6);
    ev('pointermove', 5, 'pen', 0.3, 0.25, 0.8);
    ev('pointerdown', 6, 'touch', 0.7, 0.7, 0); // palm
    ev('pointerup', 6, 'touch', 0.7, 0.7, 0);
    ev('pointerup', 5, 'pen', 0.3, 0.25, 0);
    await new Promise((r) => setTimeout(r, 30));
    ev('pointerdown', 5, 'pen', 0.5, 0.5, 0.4);
    ev('pointerup', 5, 'pen', 0.5, 0.5, 0);
  });
  await host.page.waitForFunction(() => window.__inputs.some((e) => e.t === 'tap'), null, { timeout: 10_000 });
  const got = await host.page.evaluate(() => window.__inputs.filter((e) => e.t !== 'release' && e.t !== 'pm'));
  assert.deepEqual(got.map((e) => e.t === 'pen' ? `pen:${e.s}` : e.t), ['pen:down', 'pen:move', 'pen:up', 'tap']);
  assert.ok(Math.abs(got[0].x - 0.25) < 0.02 && got[0].p === 0.6 && got[1].p === 0.8);
  assert.ok(Math.abs(got[3].x - 0.5) < 0.02 && got[3].snap === 1);
  for (const c of [v, host]) await c.ctx.close();
});
