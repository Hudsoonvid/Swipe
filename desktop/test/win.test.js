'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const koffi = require('koffi');
const { defineTypes, flagsFor, FLAG, createPenInjector } = require('../pen-win');
const { createSnapper, SCRIPT } = require('../snap-win');

test('pen structs match the Windows x64 layout', () => {
  const t = defineTypes(koffi);
  assert.equal(koffi.sizeof(t.POINTER_INFO), 96);
  assert.equal(koffi.sizeof(t.POINTER_PEN_INFO), 120);
  assert.equal(koffi.sizeof(t.POINTER_TOUCH_INFO), 144);
  assert.equal(koffi.sizeof(t.POINTER_TYPE_INFO), 152);
  assert.equal(koffi.offsetof(t.POINTER_INFO, 'sourceDevice'), 16);
  assert.equal(koffi.offsetof(t.POINTER_INFO, 'PerformanceCount'), 80);
  assert.equal(koffi.offsetof(t.POINTER_PEN_INFO, 'pressure'), 104);
});

test('pen flags follow hover → down → move → up → leave', () => {
  assert.equal(flagsFor('hover', false), FLAG.INRANGE | FLAG.UPDATE | FLAG.NEW);
  assert.equal(flagsFor('hover', true), FLAG.INRANGE | FLAG.UPDATE);
  assert.equal(flagsFor('down'), FLAG.INRANGE | FLAG.INCONTACT | FLAG.FIRSTBUTTON | FLAG.DOWN);
  assert.equal(flagsFor('move'), FLAG.INRANGE | FLAG.INCONTACT | FLAG.FIRSTBUTTON | FLAG.UPDATE);
  assert.equal(flagsFor('up'), FLAG.INRANGE | FLAG.UP);
  assert.equal(flagsFor('leave'), FLAG.UPDATE);
  assert.equal(createPenInjector({ platform: 'linux' }), null);
});

test('snapper: asks UI Automation over a pipe, falls back to the tapped point on "-", "=" or timeout', async () => {
  assert.equal(createSnapper({ platform: 'linux' }), null);
  const lines = [];
  let started;
  const fakeSpawn = (cmd, args) => {
    assert.equal(cmd, 'powershell.exe');
    assert.equal(Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), SCRIPT);
    const p = new EventEmitter();
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.kill = () => p.emit('exit');
    p.stdin.on('data', (d) => {
      for (const l of String(d).trim().split('\n')) {
        lines.push(l);
        const [id, x] = l.split(' ');
        if (x === '10') p.stdout.write(`${id} 40 50\n`);
        else if (x === '20') p.stdout.write(`${id} -\n`);
        else if (x === '30') p.stdout.write(`${id} =\n`);
        // x === '99': never answers
      }
    });
    started = p;
    return p;
  };
  const s = createSnapper({ platform: 'win32', spawn: fakeSpawn, timeoutMs: 50 });
  assert.equal(await s.find(10, 10, 20), null); // still starting
  started.stdout.write('ready\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await s.find(10, 11, 20), { x: 40, y: 50 });
  assert.equal(await s.find(20, 11, 20), null);
  assert.equal(await s.find(30, 11, 20), null);
  assert.equal(await s.find(99, 11, 20), null);
  assert.deepEqual(lines, ['1 10 11 20', '2 20 11 20', '3 30 11 20', '4 99 11 20']);
  s.stop();
});
