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

// Meeting buttons live in the ⋯ More menu.
async function more(page, sel) {
  if (await page.isHidden('#moreMenu')) await page.click('#moreBtn');
  await page.click(`#moreMenu ${sel}`);
}

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
  await more(sam.page, '#camBtn');
  await more(sam.page, '#micBtn');
  for (const p of [host.page, alex.page]) {
    await p.waitForFunction((id) => {
      const v = document.querySelector(`.tile[data-id="${id}"] video`);
      return v && v.videoWidth > 0 && !v.muted && !document.querySelector(`.tile[data-id="${id}"] .name`).textContent.includes('🔇');
    }, samId, { timeout: 20_000 });
  }
  // Sam's own preview is shown (muted, never played back to Sam).
  assert.equal(await sam.page.evaluate(() => document.querySelector('#tiles .tile.me video')?.muted), true);

  // Muting updates everyone's view.
  await more(sam.page, '#micBtn');
  await alex.page.waitForFunction((id) => document.querySelector(`.tile[data-id="${id}"] .name`)?.textContent.includes('🔇'), samId);

  // The host turns on a mic too; viewers get it.
  await host.page.click('#hostMicBtn');
  const hostId = await host.page.evaluate(() => window.__swipe.host.peer.id);
  await sam.page.waitForFunction((id) => !!document.querySelector(`.tile[data-id="${id}"] video`), hostId, { timeout: 20_000 });

  // Raise hand.
  await more(alex.page, '#handBtn');
  await host.page.waitForFunction(() => document.getElementById('hostChat').textContent.includes('✋ Alex raised a hand'));
  await sam.page.waitForFunction(() => [...document.querySelectorAll('#tiles .name')].some((n) => n.textContent.includes('✋')));

  // Reactions float up for everyone.
  await more(sam.page, '#reactBtn');
  await sam.page.click('#reactMenu >> text=🎉');
  for (const p of [host.page, alex.page, sam.page]) await p.waitForSelector('#reactLayer .react:has-text("🎉")', { timeout: 5000 });

  // Pointer: Alex taps the middle of the screen; Sam and the host see it there.
  await more(alex.page, '#pointBtn');
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
  await more(sam.page, '[data-q="saver"]');
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
  // Keyboard goes to the PC; meeting shortcuts are off while controlling.
  await tablet.page.keyboard.press('m');
  await tablet.page.keyboard.press('Escape');
  await waitInput("(e) => e.t === 'kd' && e.code === 'Escape'");
  assert.ok((await inputs()).some((e) => (e.t === 'kd' && e.code === 'KeyM') || (e.t === 'tx' && e.text === 'm')));
  assert.equal(await tablet.page.evaluate(() => window.__swipe.meet.mic), false);

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
