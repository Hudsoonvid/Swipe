// Real pen input on Windows (10 1809+): pressure and tilt reach drawing apps
// as if a pen tablet were attached. Uses the system's synthetic pointer API
// through koffi (no native build step). Returns null elsewhere.

'use strict';

const PT_PEN = 3;
const POINTER_FEEDBACK_DEFAULT = 1;
const FLAG = {
  NEW: 0x1,
  INRANGE: 0x2,
  INCONTACT: 0x4,
  FIRSTBUTTON: 0x10,
  PRIMARY: 0x2000,
  DOWN: 0x10000,
  UPDATE: 0x20000,
  UP: 0x40000,
};
const PEN_MASK = { PRESSURE: 0x1, TILT_X: 0x4, TILT_Y: 0x8 };

// Struct layouts from WinUser.h (x64). Exported for the layout test.
function defineTypes(koffi) {
  const POINT = koffi.struct('SWIPE_POINT', { x: 'int32', y: 'int32' });
  const RECT = koffi.struct('SWIPE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const POINTER_INFO = koffi.struct('SWIPE_POINTER_INFO', {
    pointerType: 'uint32',
    pointerId: 'uint32',
    frameId: 'uint32',
    pointerFlags: 'uint32',
    sourceDevice: 'void *',
    hwndTarget: 'void *',
    ptPixelLocation: POINT,
    ptHimetricLocation: POINT,
    ptPixelLocationRaw: POINT,
    ptHimetricLocationRaw: POINT,
    dwTime: 'uint32',
    historyCount: 'uint32',
    InputData: 'int32',
    dwKeyStates: 'uint32',
    PerformanceCount: 'uint64',
    ButtonChangeType: 'int32',
  });
  const POINTER_TOUCH_INFO = koffi.struct('SWIPE_POINTER_TOUCH_INFO', {
    pointerInfo: POINTER_INFO,
    touchFlags: 'uint32',
    touchMask: 'uint32',
    rcContact: RECT,
    rcContactRaw: RECT,
    orientation: 'uint32',
    pressure: 'uint32',
  });
  const POINTER_PEN_INFO = koffi.struct('SWIPE_POINTER_PEN_INFO', {
    pointerInfo: POINTER_INFO,
    penFlags: 'uint32',
    penMask: 'uint32',
    pressure: 'uint32',
    rotation: 'uint32',
    tiltX: 'int32',
    tiltY: 'int32',
  });
  const U = koffi.union('SWIPE_POINTER_TYPE_INFO_U', { touchInfo: POINTER_TOUCH_INFO, penInfo: POINTER_PEN_INFO });
  const POINTER_TYPE_INFO = koffi.struct('SWIPE_POINTER_TYPE_INFO', { type: 'uint32', u: U });
  return { POINT, RECT, POINTER_INFO, POINTER_TOUCH_INFO, POINTER_PEN_INFO, POINTER_TYPE_INFO };
}

// Turns pen states into the flag sequence Windows expects.
function flagsFor(state, wasInRange) {
  switch (state) {
    case 'hover':
      return FLAG.INRANGE | FLAG.UPDATE | (wasInRange ? 0 : FLAG.NEW);
    case 'down':
      return FLAG.INRANGE | FLAG.INCONTACT | FLAG.FIRSTBUTTON | FLAG.DOWN;
    case 'move':
      return FLAG.INRANGE | FLAG.INCONTACT | FLAG.FIRSTBUTTON | FLAG.UPDATE;
    case 'up':
      return FLAG.INRANGE | FLAG.UP;
    case 'leave':
      return FLAG.UPDATE;
    default:
      return 0;
  }
}

function createPenInjector({ platform = process.platform, koffi: k = null } = {}) {
  if (platform !== 'win32') return null;
  let koffi = k;
  try {
    koffi ??= require('koffi');
    const user32 = koffi.load('user32.dll');
    const { POINTER_TYPE_INFO } = defineTypes(koffi);
    const create = user32.func('void * __stdcall CreateSyntheticPointerDevice(uint32 pointerType, uint32 maxCount, uint32 mode)');
    const inject = user32.func('bool __stdcall InjectSyntheticPointerInput(void * device, const SWIPE_POINTER_TYPE_INFO * pointerInfo, uint32 count)');
    void POINTER_TYPE_INFO;
    const device = create(PT_PEN, 1, POINTER_FEEDBACK_DEFAULT);
    if (!device) return null;
    let frame = 0;
    let inRange = false;
    let contact = false;
    const send = (state, p, pressure, tiltX, tiltY) => {
      const info = {
        type: PT_PEN,
        u: {
          penInfo: {
            pointerInfo: {
              pointerType: PT_PEN,
              pointerId: 0,
              frameId: ++frame,
              pointerFlags: flagsFor(state, inRange) | FLAG.PRIMARY,
              sourceDevice: null,
              hwndTarget: null,
              ptPixelLocation: { x: Math.round(p.x), y: Math.round(p.y) },
              ptHimetricLocation: { x: 0, y: 0 },
              ptPixelLocationRaw: { x: Math.round(p.x), y: Math.round(p.y) },
              ptHimetricLocationRaw: { x: 0, y: 0 },
              dwTime: 0,
              historyCount: 0,
              InputData: 0,
              dwKeyStates: 0,
              PerformanceCount: 0,
              ButtonChangeType: state === 'down' ? 1 : state === 'up' ? 2 : 0, // FIRSTBUTTON_DOWN / _UP
            },
            penFlags: 0,
            penMask: PEN_MASK.PRESSURE | PEN_MASK.TILT_X | PEN_MASK.TILT_Y,
            pressure: Math.round(Math.max(0, Math.min(1, pressure)) * 1024),
            rotation: 0,
            tiltX: Math.round(tiltX),
            tiltY: Math.round(tiltY),
          },
        },
      };
      return !!inject(device, info, 1);
    };
    return {
      inject(state, p, pressure, tiltX, tiltY) {
        // Windows wants the pen in range before it touches, and lifted before it leaves.
        if (state === 'down' && !inRange && !send('hover', p, 0, tiltX, tiltY)) return false;
        if (state === 'leave' && contact) send('up', p, 0, tiltX, tiltY);
        if ((state === 'move' || state === 'up') && !contact) state = state === 'move' ? 'hover' : 'hover';
        const ok = send(state, p, pressure, tiltX, tiltY);
        if (ok) {
          inRange = state !== 'leave';
          contact = state === 'down' || state === 'move';
        }
        return ok;
      },
    };
  } catch {
    return null;
  }
}

module.exports = { createPenInjector, defineTypes, flagsFor, FLAG };
