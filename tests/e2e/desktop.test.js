// End-to-end test of the desktop app: real screen capture and real injected
// mouse/keyboard input, driven from a viewer browser.
//
// Needs an X display (Linux: `xvfb-run -a -s "-screen 0 1280x800x24" npm run test:e2e`)
// and `npm install` in desktop/. Skipped otherwise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, _electron } from 'playwright-core';
import { createServer } from '../../server/src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDir = path.join(root, 'desktop');
// Resolving the electron package downloads its binary on first use.
function findElectron() {
  try {
    return createRequire(path.join(desktopDir, 'package.json'))('electron');
  } catch {
    return null;
  }
}
const electronBin = process.platform === 'linux' && process.env.DISPLAY ? findElectron() : null;
const skip = !electronBin || !existsSync(electronBin) ? 'needs Linux + X display + `npm install` in desktop/' : false;

let srv, base, browser, app;

before(async () => {
  if (skip) return;
  srv = createServer({ stunUrls: [], limits: { joinBurst: 100 } });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});

after(async () => {
  await app?.close().catch(() => {});
  await browser?.close();
  await srv?.close();
});

test('desktop app: viewer sees the real screen and types into it', { skip, timeout: 90_000 }, async () => {
  app = await _electron.launch({
    executablePath: electronBin,
    args: ['--no-sandbox', desktopDir],
    env: { ...process.env, SWIPE_SERVER: base },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => /^\d{3} \d{3} \d{3}$/.test(document.getElementById('myCode')?.textContent || ''), null, { timeout: 30_000 });
  const code = (await win.textContent('#myCode')).replace(/\s/g, '');
  const password = await win.textContent('#myPw');
  assert.equal(await win.evaluate(() => window.swipeNative.canControl), true);

  // Where is the app's "code" input on the physical screen?
  const target = await win.evaluate(() => {
    const r = document.getElementById('codeInput').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setAlwaysOnTop(true);
    return { content: w.getContentBounds(), display: screen.getPrimaryDisplay().bounds };
  });
  const nx = (geo.content.x + target.x - geo.display.x) / geo.display.width;
  const ny = (geo.content.y + target.y - geo.display.y) / geo.display.height;

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.fill('#codeInput', code);
  await page.fill('#pwInput', password);
  await page.click('#connectBtn');
  await page.waitForFunction(
    () => {
      const v = document.getElementById('remoteVideo');
      return v.videoWidth > 0 && v.currentTime > 0.2 && document.getElementById('overlay').hidden && window.__swipe.viewer?.ctrl?.readyState === 'open';
    },
    null,
    { timeout: 30_000 }
  );
  const dims = await page.evaluate(() => [document.getElementById('remoteVideo').videoWidth, document.getElementById('remoteVideo').videoHeight]);
  assert.ok(dims[0] >= 640 && dims[1] >= 400, `video ${dims}`);

  // Click the remote input field and type into it.
  const box = await page.locator('#remoteVideo').boundingBox();
  await page.mouse.click(box.x + nx * box.width, box.y + ny * box.height);
  await win.waitForFunction(() => document.activeElement?.id === 'codeInput', null, { timeout: 5000 });
  await page.keyboard.type('42');
  await win.waitForFunction(() => document.getElementById('codeInput').value.replace(/\s/g, '') === '42', null, { timeout: 5000 });

  // The pointer really moved there.
  const cursor = await app.evaluate(({ screen }) => screen.getCursorScreenPoint());
  assert.ok(Math.abs(cursor.x - (geo.content.x + target.x)) <= 3 && Math.abs(cursor.y - (geo.content.y + target.y)) <= 3, JSON.stringify({ cursor, geo, target }));

  // Backspace via a special key.
  await page.keyboard.press('Backspace');
  await win.waitForFunction(() => document.getElementById('codeInput').value.replace(/\s/g, '') === '4', null, { timeout: 5000 });

  await ctx.close();
});
