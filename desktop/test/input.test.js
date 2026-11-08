'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Injector, robotKey } = require('../input');

function fakeRobot() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    setMouseDelay: rec('setMouseDelay'),
    setKeyboardDelay: rec('setKeyboardDelay'),
    moveMouse: rec('moveMouse'),
    dragMouse: rec('dragMouse'),
    mouseToggle: rec('mouseToggle'),
    mouseClick: rec('mouseClick'),
    scrollMouse: rec('scrollMouse'),
    keyToggle: (k, d) => {
      if (k === 'bogus') throw new Error('Invalid key code specified.');
      calls.push(['keyToggle', k, d]);
    },
    typeString: rec('typeString'),
    pos: { x: 3000, y: 700 },
    getMousePos() {
      return { ...this.pos };
    },
  };
}

const bounds = () => ({ x: 1920, y: 0, width: 2560, height: 1440 });

test('maps DOM key codes to robotjs names', () => {
  assert.equal(robotKey('KeyA', 'a'), 'a');
  assert.equal(robotKey('Digit7', '&'), '7');
  assert.equal(robotKey('ArrowLeft'), 'left');
  assert.equal(robotKey('ControlLeft'), 'control');
  assert.equal(robotKey('MetaLeft'), 'command');
  assert.equal(robotKey('F11'), 'f11');
  assert.equal(robotKey('Numpad4'), 'numpad_4');
  assert.equal(robotKey('Slash', '/'), '/');
  assert.equal(robotKey('', 'Enter'), 'enter');
  assert.equal(robotKey('Unknown', 'Dead'), null);
});

test('disables robotjs per-event delays', () => {
  const r = fakeRobot();
  new Injector({ robot: r, getBounds: bounds, platform: 'win32' });
  assert.deepEqual(r.calls.slice(0, 2), [['setMouseDelay', 0], ['setKeyboardDelay', 0]]);
});

test('normalized coordinates land on the shared display', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'win32' });
  inj.handle({ t: 'pm', x: 0, y: 0 });
  inj.handle({ t: 'pm', x: 1, y: 1 });
  inj.handle({ t: 'pm', x: 0.5, y: 0.5 });
  inj.handle({ t: 'pm', x: 7, y: -3 }); // clamped
  assert.deepEqual(r.calls.filter((c) => c[0] === 'moveMouse'), [
    ['moveMouse', 1920, 0],
    ['moveMouse', 4479, 1439],
    ['moveMouse', 3200, 720],
    ['moveMouse', 4479, 0],
  ]);
});

test('buttons, keys, text and release', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'linux' });
  inj.handle({ t: 'pd', x: 0.1, y: 0.1, b: 2 });
  inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift' });
  inj.handle({ t: 'kd', code: 'Bogus', key: 'bogus' }); // ignored safely
  inj.handle({ t: 'tx', text: 'héllo' });
  inj.releaseAll();
  const relevant = r.calls.filter((c) => ['mouseToggle', 'keyToggle', 'typeString'].includes(c[0]));
  assert.deepEqual(relevant, [
    ['mouseToggle', 'down', 'right'],
    ['keyToggle', 'shift', 'down'],
    ['typeString', 'héllo'],
    ['mouseToggle', 'up', 'right'],
    ['keyToggle', 'shift', 'up'],
  ]);
});

test('macOS: drags use drag events and double clicks get a click count', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'darwin' });
  inj.handle({ t: 'pd', x: 0.5, y: 0.5, b: 0 });
  inj.handle({ t: 'pm', x: 0.6, y: 0.5 });
  inj.handle({ t: 'pu', x: 0.6, y: 0.5, b: 0 });
  inj.handle({ t: 'pd', x: 0.6, y: 0.5, b: 0 });
  inj.handle({ t: 'pu', x: 0.6, y: 0.5, b: 0 });
  inj.handle({ t: 'pd', x: 0.6, y: 0.5, b: 0 });
  inj.handle({ t: 'pu', x: 0.6, y: 0.5, b: 0 });
  const names = r.calls.map((c) => c.slice(0, 3).join(' '));
  assert.ok(names.includes('dragMouse 3455 720'), names.join('|'));
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'mouseToggle' || c[0] === 'mouseClick'),
    [
      ['mouseToggle', 'down', 'left'], // drag
      ['mouseToggle', 'up', 'left'],
      ['mouseToggle', 'down', 'left'], // click somewhere else
      ['mouseToggle', 'up', 'left'],
      ['mouseClick', 'left', true], // same spot again = double click
    ]
  );
});

test('wheel deltas per platform', () => {
  for (const [platform, expected] of [
    ['win32', [['scrollMouse', -0, -120]]],
    ['darwin', [['scrollMouse', -0, -100]]],
    ['linux', [['scrollMouse', -0, -2]]],
  ]) {
    const r = fakeRobot();
    const inj = new Injector({ robot: r, getBounds: bounds, platform });
    inj.handle({ t: 'wh', x: 0.5, y: 0.5, dx: 0, dy: 100 });
    assert.deepEqual(r.calls.filter((c) => c[0] === 'scrollMouse'), expected, platform);
  }
  // X11 keeps sub-click remainders
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'linux' });
  inj.handle({ t: 'wh', x: 0.5, y: 0.5, dx: 0, dy: 30 });
  inj.handle({ t: 'wh', x: 0.5, y: 0.5, dx: 0, dy: 30 });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'scrollMouse'), [['scrollMouse', -0, -1]]);
});

test('controller: relative moves stay on the shared display; clicks and scrolls stay put', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'linux' });
  inj.handle({ t: 'mm', dx: 24, dy: -10 });
  r.pos = { x: 1925, y: 5 };
  inj.handle({ t: 'mm', dx: -24, dy: -24 }); // clamped to the display's corner
  inj.handle({ t: 'mm', dx: 99999, dy: 0 }); // capped per event (400)
  inj.handle({ t: 'mm', dx: 0, dy: 0 });
  inj.handle({ t: 'pd', b: 0 });
  inj.handle({ t: 'pu', b: 0 });
  inj.handle({ t: 'wh', dx: 0, dy: 100 });
  assert.deepEqual(r.calls.filter((c) => c[0] !== 'setMouseDelay' && c[0] !== 'setKeyboardDelay'), [
    ['moveMouse', 3024, 690],
    ['moveMouse', 1920, 0],
    ['moveMouse', 2325, 5],
    ['mouseToggle', 'down', 'left'],
    ['mouseToggle', 'up', 'left'],
    ['scrollMouse', -0, -2],
  ]);
});

test('trackpad: relative moves can cross onto other monitors', () => {
  const r = fakeRobot();
  const all = () => ({ x: 0, y: 0, width: 4480, height: 1440 }); // two monitors side by side
  const inj = new Injector({ robot: r, getBounds: bounds, getAllBounds: all, platform: 'win32' });
  r.pos = { x: 1925, y: 100 };
  inj.handle({ t: 'mm', dx: -300, dy: 0, all: true }); // onto the left monitor
  inj.handle({ t: 'mm', dx: -300, dy: 0 }); // a controller stays on the shared one
  assert.deepEqual(r.calls.filter((c) => c[0] === 'moveMouse'), [
    ['moveMouse', 1625, 100],
    ['moveMouse', 1920, 100],
  ]);
});

test('pen without a pen driver acts as a mouse: hover moves, touching holds the left button', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'win32' });
  inj.handle({ t: 'pen', s: 'hover', x: 0.5, y: 0.5, p: 0 });
  inj.handle({ t: 'pen', s: 'down', x: 0.5, y: 0.5, p: 0.4 });
  inj.handle({ t: 'pen', s: 'move', x: 0.6, y: 0.5, p: 0.7 });
  inj.handle({ t: 'pen', s: 'up', x: 0.6, y: 0.5, p: 0 });
  inj.handle({ t: 'pen', s: 'bogus', x: 0.6, y: 0.5 });
  assert.deepEqual(r.calls.filter((c) => c[0] !== 'setMouseDelay' && c[0] !== 'setKeyboardDelay'), [
    ['moveMouse', 3200, 720],
    ['moveMouse', 3200, 720],
    ['mouseToggle', 'down', 'left'],
    ['moveMouse', 3455, 720],
    ['moveMouse', 3455, 720],
    ['mouseToggle', 'up', 'left'],
  ]);
});

test('pen with a pen driver sends pressure and tilt; falls back to the mouse if injection fails', () => {
  const r = fakeRobot();
  const seen = [];
  let fail = false;
  const pen = { inject: (s, p, pressure, tx, ty) => (seen.push([s, p.x, p.y, pressure, tx, ty]), !fail) };
  const inj = new Injector({ robot: r, getBounds: bounds, pen, platform: 'win32' });
  inj.handle({ t: 'pen', s: 'down', x: 0, y: 0, p: 0.25, tx: 120, ty: -10 });
  inj.handle({ t: 'pen', s: 'move', x: 1, y: 1, p: 2 });
  assert.deepEqual(seen, [['down', 1920, 0, 0.25, 90, -10], ['move', 4479, 1439, 1, 0, 0]]);
  inj.releaseAll(); // lifts the pen if a device goes away mid-stroke
  assert.deepEqual(seen.at(-1)[0], 'up');
  assert.equal(r.calls.filter((c) => c[0] === 'mouseToggle').length, 0);
  // "m" asks for plain mouse behaviour even when a pen driver exists.
  inj.handle({ t: 'pen', s: 'down', x: 0.5, y: 0.5, p: 0.5, m: 1 });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'mouseToggle'), [['mouseToggle', 'down', 'left']]);
  inj.handle({ t: 'pen', s: 'up', x: 0.5, y: 0.5, m: 1 });
  fail = true;
  inj.handle({ t: 'pen', s: 'down', x: 0.5, y: 0.5, p: 0.5 });
  assert.equal(inj.pen, null);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'mouseToggle').at(-1), ['mouseToggle', 'down', 'left']);
});

test('tap clicks once at the point (snapping is done by the caller)', () => {
  const r = fakeRobot();
  const inj = new Injector({ robot: r, getBounds: bounds, platform: 'win32' });
  inj.handle({ t: 'tap', x: 0.5, y: 0.5, b: 0 });
  inj.tapAt({ x: 100, y: 200 }, 2);
  assert.deepEqual(r.calls.filter((c) => c[0] !== 'setMouseDelay' && c[0] !== 'setKeyboardDelay'), [
    ['moveMouse', 3200, 720], ['mouseToggle', 'down', 'left'], ['mouseToggle', 'up', 'left'],
    ['moveMouse', 100, 200], ['mouseToggle', 'down', 'right'], ['mouseToggle', 'up', 'right'],
  ]);
});
