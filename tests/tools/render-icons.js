// Renders PNG app icons from web/icons/icon.svg (run: npm run icons).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../../web/icons/icon.svg', import.meta.url), 'utf8');
const out = (f) => new URL(`../../web/icons/${f}`, import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(file, size, { maskable = false, radius = true } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const inner = radius ? svg : svg.replace('rx="112"', 'rx="0"');
  const pad = maskable ? Math.round(size * 0.1) : 0;
  await page.setContent(`<html><body style="margin:0;background:${maskable ? '#5a76ff' : 'transparent'}">
    <div style="padding:${pad}px;width:${size}px;height:${size}px;box-sizing:border-box">${inner.replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `)}</div></body></html>`);
  await page.screenshot({ path: out(file), omitBackground: !maskable });
}
await render('icon-192.png', 192);
await render('icon-512.png', 512);
await render('icon-maskable-512.png', 512, { maskable: true, radius: false });
await render('apple-touch-icon.png', 180, { radius: false });
await browser.close();
console.log('icons written');
