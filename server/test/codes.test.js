import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeRegistry, isValidDeviceKey } from '../src/codes.js';

test('codes persist across restarts when DATA_DIR is set', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'swipe-'));
  const a = new CodeRegistry({ dataDir: dir });
  const code = a.codeFor('k'.repeat(43));
  assert.match(code, /^[1-9]\d{8}$/);
  assert.notEqual(a.codeFor('j'.repeat(43)), code);
  await new Promise((r) => setTimeout(r, 2200)); // debounced save
  const saved = JSON.parse(readFileSync(path.join(dir, 'codes.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 2);
  assert.ok(!JSON.stringify(saved).includes('kkkk'), 'raw device keys are never stored');
  const b = new CodeRegistry({ dataDir: dir });
  assert.equal(b.codeFor('k'.repeat(43)), code);
});

test('device key validation', () => {
  assert.ok(isValidDeviceKey('A'.repeat(43)));
  assert.ok(!isValidDeviceKey('short'));
  assert.ok(!isValidDeviceKey('a b'.repeat(20)));
  assert.ok(!isValidDeviceKey(42));
});
