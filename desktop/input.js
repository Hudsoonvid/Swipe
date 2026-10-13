// Turns Swipe input events (normalized coordinates, DOM key codes) into real
// mouse and keyboard input with robotjs.

'use strict';

const CODE_MAP = {
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  CapsLock: 'capslock',
  MetaLeft: 'command',
  MetaRight: 'command',
  OSLeft: 'command',
  OSRight: 'command',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  Space: 'space',
  PrintScreen: 'printscreen',
  Insert: 'insert',
  ContextMenu: 'menu',
  NumLock: 'numpad_lock',
  NumpadAdd: 'numpad_+',
  NumpadSubtract: 'numpad_-',
  NumpadMultiply: 'numpad_*',
  NumpadDivide: 'numpad_/',
  NumpadDecimal: 'numpad_.',
  AudioVolumeMute: 'audio_mute',
  AudioVolumeDown: 'audio_vol_down',
  AudioVolumeUp: 'audio_vol_up',
  MediaPlayPause: 'audio_play',
  MediaStop: 'audio_stop',
  MediaTrackNext: 'audio_next',
  MediaTrackPrevious: 'audio_prev',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

// Fallback by KeyboardEvent.key for events without a usable code.
const KEY_MAP = {
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Meta: 'command',
  Control: 'control',
  Alt: 'alt',
  Shift: 'shift',
  ' ': 'space',
};

function robotKey(code, key) {
  if (CODE_MAP[code]) return CODE_MAP[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `numpad_${m[1]}`;
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) <= 24) return `f${m[1]}`;
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (typeof key === 'string' && key.length === 1) return key.toLowerCase();
  return null;
}

const BUTTONS = ['left', 'middle', 'right'];
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

class Injector {
  /**
   * robot: the robotjs module (or a test double)
   * getBounds(): {x, y, width, height} of the shared display, in the
   *   coordinate space robot.moveMouse uses on this OS
   * platform: process.platform
   */
  constructor({ robot, getBounds, platform = process.platform }) {
    this.robot = robot;
    this.getBounds = getBounds;
    this.platform = platform;
    this.down = new Set(); // pressed mouse buttons
    this.keys = new Set(); // pressed robot key names
    this.lastClick = null;
    this.scrollRest = { x: 0, y: 0 };
    robot.setMouseDelay?.(0); // robotjs sleeps 10 ms after every event by default
    robot.setKeyboardDelay?.(0);
  }

  _point(evt) {
    const b = this.getBounds();
    // Stay strictly inside the display so the edge pixel maps to this screen.
    return {
      x: Math.round(b.x + clamp01(evt.x) * (b.width - 1)),
      y: Math.round(b.y + clamp01(evt.y) * (b.height - 1)),
    };
  }

  _move(evt) {
    const p = this._point(evt);
    if (this.platform === 'darwin' && this.down.size) {
      // macOS apps need "dragged" events while a button is held.
      this.robot.dragMouse(p.x, p.y, BUTTONS[[...this.down][0]] || 'left');
    } else {
      this.robot.moveMouse(p.x, p.y);
    }
    return p;
  }

  handle(evt) {
    if (!evt || typeof evt.t !== 'string') return;
    try {
      this._handle(evt);
    } catch (e) {
      // Unknown keys etc. must never crash the app.
      if (process.env.SWIPE_DEBUG) console.warn('input error', evt, e.message);
    }
  }

  _handle(evt) {
    const r = this.robot;
    switch (evt.t) {
      case 'pm':
        this._move(evt);
        break;
      case 'pd':
      case 'pu': {
        const b = evt.b === 1 || evt.b === 2 ? evt.b : 0;
        const p = this._move(evt);
        if (evt.t === 'pd') {
          const now = Date.now();
          const lc = this.lastClick;
          const isDouble = lc && lc.b === b && now - lc.t < 450 && Math.abs(lc.x - p.x) < 6 && Math.abs(lc.y - p.y) < 6;
          this.lastClick = isDouble ? null : { b, t: now, x: p.x, y: p.y };
          if (this.platform === 'darwin' && isDouble) {
            this.pendingDouble = b; // sent on release with click count 2
            this.down.add(b);
            break;
          }
          this.down.add(b);
          r.mouseToggle('down', BUTTONS[b]);
        } else {
          this.down.delete(b);
          if (this.pendingDouble === b) {
            this.pendingDouble = null;
            r.mouseClick(BUTTONS[b], true);
          } else {
            r.mouseToggle('up', BUTTONS[b]);
          }
        }
        break;
      }
      case 'wh':
        this._scroll(evt);
        break;
      case 'kd':
      case 'ku': {
        const key = robotKey(evt.code, evt.key);
        if (!key) break;
        if (evt.t === 'kd') this.keys.add(key);
        else this.keys.delete(key);
        r.keyToggle(key, evt.t === 'kd' ? 'down' : 'up');
        break;
      }
      case 'tx':
        if (typeof evt.text === 'string' && evt.text.length <= 4000) r.typeString(evt.text);
        break;
    }
  }

  // Wheel deltas arrive in CSS pixels (positive = scroll down / right).
  _scroll(evt) {
    this._move(evt);
    const dx = Number(evt.dx) || 0;
    const dy = Number(evt.dy) || 0;
    if (this.platform === 'darwin') {
      this.robot.scrollMouse(-Math.round(dx), -Math.round(dy));
    } else if (this.platform === 'win32') {
      // WHEEL_DELTA is 120 per notch; browsers report ~100 px per notch.
      this.robot.scrollMouse(-Math.round(dx * 1.2), -Math.round(dy * 1.2));
    } else {
      // X11 only knows whole wheel clicks; keep the remainder for later.
      const STEP = 50;
      this.scrollRest.x += dx;
      this.scrollRest.y += dy;
      const tx = Math.trunc(this.scrollRest.x / STEP);
      const ty = Math.trunc(this.scrollRest.y / STEP);
      this.scrollRest.x -= tx * STEP;
      this.scrollRest.y -= ty * STEP;
      if (tx || ty) this.robot.scrollMouse(-tx, -ty);
    }
  }

  // Release anything still held (viewer disconnected mid-drag, etc.).
  releaseAll() {
    for (const b of this.down) {
      try {
        this.robot.mouseToggle('up', BUTTONS[b]);
      } catch {}
    }
    this.down.clear();
    for (const k of this.keys) {
      try {
        this.robot.keyToggle(k, 'up');
      } catch {}
    }
    this.keys.clear();
  }
}

module.exports = { Injector, robotKey };
