// End-to-end: a host browser shares a (synthetic) screen, viewer browsers
// connect with code + password, receive video and send input.
//
// Run: npm run test:e2e   (needs a Chromium for playwright-core; set
// CHROMIUM_PATH or install with `npx playwright install chromium`).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from '../../server/src/server.js';

let srv, base, browser;

before(async () => {
  srv = createServer({ stunUrls: [], limits: { joinBurst: 100 } });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  await browser?.close();
  await srv?.close();
});

// A moving test pattern stands in for the real screen.
function fakeScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext('2d');
    let i = 0;
    setInterval(() => {
      ctx.fillStyle = `hsl(${(i += 7) % 360} 70% 45%)`;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      ctx.font = '64px sans-serif';
      ctx.fillText(String(i), 40, 100);
    }, 33);
    return c.captureStream(30);
  };
}

// Stand-in for the desktop app's native bridge: records injected input.
function fakeNative(server) {
  window.__inputs = [];
  const screens = [
    { id: 's1', name: 'Screen 1' },
    { id: 's2', name: 'Screen 2' },
  ];
  window.swipeNative = {
    platform: 'linux',
    hostname: 'Test PC',
    defaultServer: server,
    canControl: true,
    getScreens: async () => screens,
    cachedScreens: () => screens,
    selectScreen: async (id) => (window.__screen = id),
    input: (evt) => window.__inputs.push(evt),
    onCommand: () => {},
    setStatus: () => {},
  };
}

async function startAppHost() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakeScreen);
  await ctx.addInitScript(fakeNative, base);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => /^\d{3} \d{3} \d{3}$/.test(document.getElementById('myCode').textContent));
  const code = (await page.textContent('#myCode')).replace(/\s/g, '');
  const password = await page.textContent('#myPw');
  return { ctx, page, code, password };
}

async function openViewer(opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(base);
  return { ctx, page };
}

async function connectViewer(page, code, password) {
  await page.fill('#codeInput', code);
  await page.fill('#pwInput', password);
  await page.click('#connectBtn');
}

async function waitForVideo(page) {
  await page.waitForFunction(
    () => {
      const v = document.getElementById('remoteVideo');
      return v.videoWidth > 0 && v.currentTime > 0.3 && document.getElementById('overlay').hidden;
    },
    null,
    { timeout: 20_000 }
  );
}

test('viewer connects with code + password, sees the screen and controls the host', async () => {
  const host = await startAppHost();
  assert.match(host.password, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const viewer = await openViewer({ viewport: { width: 1000, height: 700 } });
  // Lower-case and without the dash: passwords are forgiving.
  await connectViewer(viewer.page, host.code, host.password.toLowerCase().replace('-', ''));
  await waitForVideo(viewer.page);

  const dims = await viewer.page.evaluate(() => {
    const v = document.getElementById('remoteVideo');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  assert.deepEqual(dims, { w: 1280, h: 720 });

  // Host shows the viewer as connected.
  await host.page.waitForFunction(() => document.getElementById('shareStatus').textContent.includes('1 device connected'));

  // Click in the middle of the remote screen.
  await viewer.page.waitForFunction(() => window.__swipe.viewer?.ctrl?.readyState === 'open');
  const box = await viewer.page.locator('#remoteVideo').boundingBox();
  await viewer.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await viewer.page.mouse.down();
  await viewer.page.mouse.up();
  await viewer.page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75, { button: 'right' });
  await viewer.page.keyboard.type('hi');
  await viewer.page.keyboard.press('Control+c');
  await viewer.page.mouse.wheel(0, 120);

  await host.page.waitForFunction(() => window.__inputs.filter((e) => e.t === 'wh').length > 0, null, { timeout: 5000 });
  const inputs = await host.page.evaluate(() => window.__inputs);
  const pd = inputs.filter((e) => e.t === 'pd');
  assert.equal(pd.length, 2);
  assert.ok(Math.abs(pd[0].x - 0.5) < 0.01 && Math.abs(pd[0].y - 0.5) < 0.01, JSON.stringify(pd[0]));
  assert.equal(pd[0].b, 0);
  assert.equal(pd[1].b, 2);
  assert.ok(Math.abs(pd[1].x - 0.25) < 0.01 && Math.abs(pd[1].y - 0.75) < 0.01);
  assert.ok(inputs.some((e) => e.t === 'pm'));
  assert.deepEqual(
    inputs.filter((e) => e.t === 'tx').map((e) => e.text),
    ['h', 'i']
  );
  const keys = inputs.filter((e) => e.t === 'kd' || e.t === 'ku').map((e) => `${e.t}:${e.code}`);
  assert.deepEqual(keys, ['kd:ControlLeft', 'kd:KeyC', 'ku:KeyC', 'ku:ControlLeft']);
  assert.ok(inputs.find((e) => e.t === 'wh').dy > 0);

  // Viewer asks for the second monitor.
  await viewer.page.click('button[title="Show Screen 2"]');
  await host.page.waitForFunction(() => window.__screen === 's2');

  // Host disconnects the viewer.
  await host.page.click('#viewerList button');
  await viewer.page.waitForSelector('#home:not([hidden])');
  assert.match(await viewer.page.textContent('#connectError'), /ended/);

  await viewer.ctx.close();
  await host.ctx.close();
});

test('a wrong password is rejected and the connection never starts', async () => {
  const host = await startAppHost();
  const viewer = await openViewer();
  await connectViewer(viewer.page, host.code, 'WRONGPW1');
  await viewer.page.waitForSelector('#connectError:not([hidden])');
  assert.equal(await viewer.page.textContent('#connectError'), 'Wrong password.');
  assert.equal(await host.page.evaluate(() => window.__swipe.host.viewerList().length), 0);
  await viewer.ctx.close();
  await host.ctx.close();
});

test('unknown code shows a helpful error', async () => {
  const viewer = await openViewer();
  await connectViewer(viewer.page, '111 222 333', 'ABCDEFGH');
  await viewer.page.waitForSelector('#connectError:not([hidden])');
  assert.match(await viewer.page.textContent('#connectError'), /No device is sharing/);
  await viewer.ctx.close();
});

test('browser-only host is view-only; touch viewer joins via QR link', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakeScreen);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.click('#shareBtn');
  await page.waitForFunction(() => /^\d{3} \d{3} \d{3}$/.test(document.getElementById('myCode').textContent));
  await page.click('#qrWrap summary');
  assert.ok(await page.locator('#qr svg').count());
  const code = (await page.textContent('#myCode')).replace(/\s/g, '');
  const password = (await page.textContent('#myPw')).replace('-', '');

  // Phone-sized touch device opening the QR link.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const vp = await phone.newPage();
  await vp.goto(`${base}/#c=${code}&p=${password}`);
  await waitForVideo(vp);
  assert.equal(await vp.evaluate(() => location.hash), '');
  // No keyboard button: the host cannot be controlled from a plain browser.
  assert.equal(await vp.locator('button[title="Keyboard"]').count(), 0);

  await phone.close();
  await page.click('#stopShareBtn');
  await ctx.close();
});

test('touch viewer: tap clicks, long-press right-clicks on a desktop host', async () => {
  const host = await startAppHost();
  const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  const vp = await tablet.newPage();
  await vp.goto(base);
  await connectViewer(vp, host.code, host.password);
  await waitForVideo(vp);
  await vp.waitForFunction(() => window.__swipe.viewer?.ctrl?.readyState === 'open');
  const box = await vp.locator('#remoteVideo').boundingBox();
  await vp.touchscreen.tap(box.x + box.width * 0.1, box.y + box.height * 0.2);
  await host.page.waitForFunction(() => window.__inputs.some((e) => e.t === 'pu'));
  const inputs = await host.page.evaluate(() => window.__inputs);
  const pd = inputs.find((e) => e.t === 'pd');
  assert.ok(Math.abs(pd.x - 0.1) < 0.01 && Math.abs(pd.y - 0.2) < 0.01, JSON.stringify(pd));
  assert.equal(pd.b, 0);

  // Long press (touch held 800 ms) = right click.
  const cdp = await tablet.newCDPSession(vp);
  const pt = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await vp.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await host.page.waitForFunction(() => window.__inputs.some((e) => e.t === 'pd' && e.b === 2));
  const right = (await host.page.evaluate(() => window.__inputs)).find((e) => e.t === 'pd' && e.b === 2);
  assert.ok(Math.abs(right.x - 0.6) < 0.01 && Math.abs(right.y - 0.6) < 0.01);
  await tablet.close();
  await host.ctx.close();
});
