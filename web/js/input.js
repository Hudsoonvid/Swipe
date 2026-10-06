// Viewer-side input: maps mouse, touch and keyboard to remote input events,
// and handles local zoom/pan of the remote screen.
//
// Remote coordinates are normalized to [0, 1] across the shared screen.

const LONG_PRESS_MS = 550;
const TAP_SLOP_PX = 10;
const PM_INTERVAL_MS = 8;
const MAX_ZOOM = 6;

const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- zoom / pan of the remote screen ----------

export class View {
  constructor(stage, video) {
    this.stage = stage;
    this.video = video;
    this.s = 1;
    this.ox = 0;
    this.oy = 0;
    this.fw = 0;
    this.fh = 0;
    this.onchange = null;
  }

  layout() {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const fit = Math.min(W / vw, H / vh);
    const prevW = this.fw * this.s;
    this.fw = vw * fit;
    this.fh = vh * fit;
    if (this.s === 1 || !prevW) {
      this.s = 1;
      this.ox = (W - this.fw) / 2;
      this.oy = (H - this.fh) / 2;
    }
    this._clamp();
    this.apply();
  }

  get zoomed() {
    return this.s > 1.001;
  }

  apply() {
    const v = this.video.style;
    v.width = `${this.fw * this.s}px`;
    v.height = `${this.fh * this.s}px`;
    v.transform = `translate(${this.ox}px, ${this.oy}px)`;
    this.onchange?.();
  }

  _clamp() {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const w = this.fw * this.s;
    const h = this.fh * this.s;
    this.ox = w <= W ? (W - w) / 2 : clamp(this.ox, W - w, 0);
    this.oy = h <= H ? (H - h) / 2 : clamp(this.oy, H - h, 0);
  }

  // (px, py) are stage-relative.
  zoomAt(px, py, factor) {
    const s = clamp(this.s * factor, 1, MAX_ZOOM);
    const k = s / this.s;
    this.ox = px - (px - this.ox) * k;
    this.oy = py - (py - this.oy) * k;
    this.s = s;
    this._clamp();
    this.apply();
  }

  pan(dx, dy) {
    this.ox += dx;
    this.oy += dy;
    this._clamp();
    this.apply();
  }

  reset() {
    this.s = 1;
    this.layout();
  }

  stagePoint(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  toNorm(clientX, clientY) {
    const p = this.stagePoint(clientX, clientY);
    return {
      x: clamp((p.x - this.ox) / (this.fw * this.s), 0, 1),
      y: clamp((p.y - this.oy) / (this.fh * this.s), 0, 1),
    };
  }

  fromNorm(x, y) {
    return { x: this.ox + x * this.fw * this.s, y: this.oy + y * this.fh * this.s };
  }

  // Keep a normalized point visible (used to follow the trackpad cursor).
  ensureVisible(x, y, margin = 40) {
    if (!this.zoomed) return;
    const p = this.fromNorm(x, y);
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    let dx = 0;
    let dy = 0;
    if (p.x < margin) dx = margin - p.x;
    else if (p.x > W - margin) dx = W - margin - p.x;
    if (p.y < margin) dy = margin - p.y;
    else if (p.y > H - margin) dy = H - margin - p.y;
    if (dx || dy) this.pan(dx, dy);
  }
}

// ---------- input controller ----------

export class InputController {
  /**
   * session: { control, send(evt), info }  (ViewerSession)
   * cursor:  element drawn as the remote pointer in trackpad mode
   * textInput: hidden <textarea> used to summon the on-screen keyboard
   */
  constructor({ stage, video, session, cursor, textInput, getTouchMode, viewerPlatform }) {
    this.stage = stage;
    this.session = session;
    this.cursor = cursor;
    this.textInput = textInput;
    this.getTouchMode = getTouchMode;
    this.viewerPlatform = viewerPlatform;
    this.view = new View(stage, video);
    this.view.onchange = () => this._drawCursor();
    this.pointers = new Map();
    this.gesture = null;
    this.cursorPos = { x: 0.5, y: 0.5 };
    this.downKeys = new Set();
    this.downButtons = new Set();
    this.sticky = new Set(); // on-screen modifier toggles: Control, Alt, Meta, Shift
    this._pmPending = null;
    this._pmLast = 0;
    this._wheel = null;
    this._lastTap = null;
    this._abort = new AbortController();
    this._bind();
  }

  get control() {
    return this.session.control;
  }

  destroy() {
    this.releaseAll();
    this._abort.abort();
    clearTimeout(this._pmTimer);
    clearTimeout(this.gesture?.timer);
  }

  send(evt) {
    return this.session.send(evt);
  }

  _bind() {
    const opts = { signal: this._abort.signal };
    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this._onDown(e), opts);
    s.addEventListener('pointermove', (e) => this._onMove(e), opts);
    s.addEventListener('pointerup', (e) => this._onUp(e, false), opts);
    s.addEventListener('pointercancel', (e) => this._onUp(e, true), opts);
    s.addEventListener('wheel', (e) => this._onWheel(e), { ...opts, passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    // Safari pinch gestures would otherwise zoom the page.
    s.addEventListener('gesturestart', (e) => e.preventDefault(), opts);
    // Stop emulated mouse events, so tapping the screen keeps the on-screen
    // keyboard open and does not trigger text selection or callouts.
    s.addEventListener('touchstart', (e) => !e.target.closest?.('[data-ui]') && e.preventDefault(), { ...opts, passive: false });
    window.addEventListener('keydown', (e) => this._onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this._onKey(e, false), opts);
    window.addEventListener('blur', () => this.releaseAll(), opts);
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll(), opts);
    window.addEventListener('resize', () => this.view.layout(), opts);
    this.view.video.addEventListener('resize', () => this.view.layout(), opts);
    this.view.video.addEventListener('loadedmetadata', () => this.view.layout(), opts);
    this._bindTextInput(opts);
  }

  // ---------- pointer moves ----------

  _sendMove(p) {
    this._pmPending = p;
    const now = performance.now();
    const wait = PM_INTERVAL_MS - (now - this._pmLast);
    if (wait <= 0) this._flushMove();
    else if (!this._pmTimer) this._pmTimer = setTimeout(() => this._flushMove(), wait);
  }

  _flushMove() {
    clearTimeout(this._pmTimer);
    this._pmTimer = null;
    if (!this._pmPending) return;
    const { x, y } = this._pmPending;
    this._pmPending = null;
    this._pmLast = performance.now();
    this.send({ t: 'pm', x: round(x), y: round(y) });
  }

  _button(t, p, b) {
    this._flushMove();
    const evt = { t, x: round(p.x), y: round(p.y), b };
    if (t === 'pd') this.downButtons.add(b);
    else this.downButtons.delete(b);
    this.send(evt);
  }

  _click(p, b = 0) {
    this.send({ t: 'pm', x: round(p.x), y: round(p.y) });
    this._button('pd', p, b);
    this._button('pu', p, b);
  }

  // ---------- pointer events ----------

  _onDown(e) {
    if (e.target.closest?.('[data-ui]')) return;
    e.preventDefault();
    this.stage.setPointerCapture?.(e.pointerId);
    this.textInput && document.activeElement === this.textInput && e.pointerType === 'mouse' && this.textInput.blur();
    const pt = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: e.timeStamp, type: e.pointerType };
    this.pointers.set(e.pointerId, pt);

    if (e.pointerType === 'mouse') return this._mouseDown(e);

    if (this.pointers.size === 1) this._touchStart(e, pt);
    else if (this.pointers.size === 2) this._twoStart();
  }

  _onMove(e) {
    const pt = this.pointers.get(e.pointerId);
    if (e.pointerType === 'mouse') {
      if (pt) Object.assign(pt, { x: e.clientX, y: e.clientY });
      return this._mouseMove(e);
    }
    if (!pt) return;
    const dx = e.clientX - pt.x;
    const dy = e.clientY - pt.y;
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (this.gesture?.kind === 'two' || this.gesture?.kind === 'ended') {
      if (this.gesture.kind === 'two') this._twoMove();
      return;
    }
    if (this.pointers.size === 1) this._touchMove(e, pt, dx, dy);
  }

  _onUp(e, cancelled) {
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    if (e.pointerType === 'mouse') {
      this.pointers.delete(e.pointerId);
      return this._mouseUp(e);
    }
    const g = this.gesture;
    if (g?.kind === 'two') this._twoEnd(cancelled);
    else if (g && this.pointers.size === 1) this._touchEnd(e, pt, cancelled);
    this.pointers.delete(e.pointerId);
    if (!this.pointers.size) this.gesture = null;
  }

  // ---------- mouse ----------

  _mouseDown(e) {
    const p = this.view.toNorm(e.clientX, e.clientY);
    if (this.control === 'desktop') {
      this.send({ t: 'pm', x: round(p.x), y: round(p.y) });
      this._button('pd', p, e.button);
    } else if (this.control === 'touch') {
      if (e.button === 2) this.send({ t: 'nav', a: 'back' });
      else if (e.button === 0) this.gesture = { kind: 'path', pts: [[round(p.x), round(p.y), 0]], t0: e.timeStamp };
    } else if (this.view.zoomed) {
      this.gesture = { kind: 'pan' };
    }
  }

  _mouseMove(e) {
    const p = this.view.toNorm(e.clientX, e.clientY);
    if (this.control === 'desktop') this._sendMove(p);
    else if (this.gesture?.kind === 'path') this._addPathPoint(p, e.timeStamp);
    else if (this.gesture?.kind === 'pan') this.view.pan(e.movementX, e.movementY);
  }

  _mouseUp(e) {
    const p = this.view.toNorm(e.clientX, e.clientY);
    if (this.control === 'desktop') this._button('pu', p, e.button);
    else if (this.gesture?.kind === 'path') this._sendPath(p, e.timeStamp);
    this.gesture = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey && this.control === 'none') {
      const p = this.view.stagePoint(e.clientX, e.clientY);
      this.view.zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * 0.01));
      return;
    }
    if (this.control === 'none') {
      if (this.view.zoomed) this.view.pan(-e.deltaX * unit, -e.deltaY * unit);
      return;
    }
    const p = this.view.toNorm(e.clientX, e.clientY);
    this._queueScroll(p, e.deltaX * unit, e.deltaY * unit);
  }

  // dx/dy in CSS pixels, positive = content moves up/left (like a wheel).
  _queueScroll(p, dx, dy) {
    if (!this._wheel) {
      this._wheel = { x: p.x, y: p.y, dx: 0, dy: 0 };
      setTimeout(() => {
        const w = this._wheel;
        this._wheel = null;
        if (!w || (!Math.round(w.dx) && !Math.round(w.dy))) return;
        const t = this.control === 'touch' ? 'scroll' : 'wh';
        this.send({ t, x: round(w.x), y: round(w.y), dx: Math.round(w.dx), dy: Math.round(w.dy) });
      }, 16);
    }
    this._wheel.dx += dx;
    this._wheel.dy += dy;
  }

  // ---------- one finger ----------

  _touchStart(e, pt) {
    const p = this.view.toNorm(e.clientX, e.clientY);
    const mode = this.getTouchMode();
    const g = { kind: 'pending', start: p, t0: e.timeStamp };
    this.gesture = g;
    if (this.control === 'desktop' && mode === 'direct') {
      g.timer = setTimeout(() => {
        if (this.gesture === g && g.kind === 'pending') {
          g.kind = 'done';
          this._click(g.start, 2); // long press = right click
          navigator.vibrate?.(15);
        }
      }, LONG_PRESS_MS);
    } else if (this.control === 'desktop' && mode === 'trackpad') {
      const lt = this._lastTap;
      if (lt && e.timeStamp - lt.t < 300 && Math.hypot(pt.x - lt.x, pt.y - lt.y) < 40) {
        g.kind = 'tapdrag';
        this._button('pd', this.cursorPos, 0);
      }
    } else if (this.control === 'touch') {
      g.kind = 'path';
      g.pts = [[round(p.x), round(p.y), 0]];
    }
  }

  _touchMove(e, pt, dx, dy) {
    const g = this.gesture;
    if (!g) return;
    const moved = Math.hypot(pt.x - pt.sx, pt.y - pt.sy) > TAP_SLOP_PX;
    const mode = this.getTouchMode();
    if (this.control === 'desktop' && mode === 'direct') {
      const p = this.view.toNorm(e.clientX, e.clientY);
      if (g.kind === 'pending' && moved) {
        clearTimeout(g.timer);
        g.kind = 'drag';
        this.send({ t: 'pm', x: round(g.start.x), y: round(g.start.y) });
        this._button('pd', g.start, 0);
      }
      if (g.kind === 'drag') this._sendMove(p);
    } else if (this.control === 'desktop' && mode === 'trackpad') {
      if (g.kind === 'pending' && moved) g.kind = 'move';
      // Relative movement with mild acceleration, like a laptop trackpad.
      const speed = 1.2 + Math.min(Math.hypot(dx, dy) / 12, 1.8);
      const w = this.view.fw * this.view.s;
      const h = this.view.fh * this.view.s;
      this.cursorPos = {
        x: clamp(this.cursorPos.x + (dx * speed) / w, 0, 1),
        y: clamp(this.cursorPos.y + (dy * speed) / h, 0, 1),
      };
      this._sendMove(this.cursorPos);
      this.view.ensureVisible(this.cursorPos.x, this.cursorPos.y);
      this._drawCursor();
    } else if (this.control === 'touch') {
      this._addPathPoint(this.view.toNorm(e.clientX, e.clientY), e.timeStamp);
    } else if (this.view.zoomed) {
      this.view.pan(dx, dy);
    }
  }

  _touchEnd(e, pt, cancelled) {
    const g = this.gesture;
    clearTimeout(g.timer);
    const mode = this.getTouchMode();
    const p = this.view.toNorm(e.clientX, e.clientY);
    if (this.control === 'desktop' && mode === 'direct') {
      if (g.kind === 'pending' && !cancelled) this._click(g.start, 0);
      else if (g.kind === 'drag') this._button('pu', p, 0);
    } else if (this.control === 'desktop' && mode === 'trackpad') {
      if (g.kind === 'tapdrag') this._button('pu', this.cursorPos, 0);
      else if (g.kind === 'pending' && !cancelled && e.timeStamp - g.t0 < 300) {
        this._click(this.cursorPos, 0);
        this._lastTap = { t: e.timeStamp, x: pt.x, y: pt.y };
        return;
      }
      this._lastTap = null;
    } else if (this.control === 'touch' && g.kind === 'path' && !cancelled) {
      this._sendPath(p, e.timeStamp);
    }
  }

  _addPathPoint(p, ts) {
    const g = this.gesture;
    const last = g.pts[g.pts.length - 1];
    const t = Math.round(ts - g.t0);
    if (t - last[2] < 12 && Math.hypot(p.x - last[0], p.y - last[1]) < 0.004) return;
    g.pts.push([round(p.x), round(p.y), t]);
  }

  _sendPath(p, ts) {
    const g = this.gesture;
    this._addPathPoint(p, ts);
    let pts = g.pts;
    if (pts.length > 80) {
      const step = pts.length / 80;
      pts = Array.from({ length: 80 }, (_, i) => pts[Math.floor(i * step)]).concat([pts[pts.length - 1]]);
    }
    this.send({ t: 'gesture', pts });
    this.gesture = null;
  }

  // ---------- two fingers: scroll, pinch-zoom, two-finger tap ----------

  _twoMetrics() {
    const [a, b] = [...this.pointers.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  _twoStart() {
    const g = this.gesture;
    if (g) {
      clearTimeout(g.timer);
      if (g.kind === 'drag') this._button('pu', this.view.toNorm(this.pointers.values().next().value.x, this.pointers.values().next().value.y), 0);
      if (g.kind === 'tapdrag') this._button('pu', this.cursorPos, 0);
    }
    const m = this._twoMetrics();
    this.gesture = { kind: 'two', mode: null, startDist: m.dist, lastDist: m.dist, startMid: m.mid, lastMid: m.mid, t0: performance.now() };
  }

  _twoMove() {
    const g = this.gesture;
    const m = this._twoMetrics();
    if (!g.mode) {
      if (Math.abs(m.dist - g.startDist) > 40) g.mode = 'zoom';
      else if (Math.hypot(m.mid.x - g.startMid.x, m.mid.y - g.startMid.y) > 12) {
        g.mode = this.control === 'none' || (this.view.zoomed && this.control === 'touch') ? 'zoom' : 'scroll';
      }
      if (!g.mode) return;
      g.lastDist = m.dist;
      g.lastMid = m.mid;
    }
    const ddx = m.mid.x - g.lastMid.x;
    const ddy = m.mid.y - g.lastMid.y;
    if (g.mode === 'zoom') {
      const sp = this.view.stagePoint(m.mid.x, m.mid.y);
      this.view.zoomAt(sp.x, sp.y, m.dist / g.lastDist);
      this.view.pan(ddx, ddy);
    } else {
      const p = this.view.toNorm(g.startMid.x, g.startMid.y);
      this._queueScroll(p, -ddx * 2, -ddy * 2);
    }
    g.lastDist = m.dist;
    g.lastMid = m.mid;
  }

  _twoEnd(cancelled) {
    const g = this.gesture;
    if (!g.mode && !cancelled && performance.now() - g.t0 < 300 && this.control === 'desktop') {
      const p = this.getTouchMode() === 'trackpad' ? this.cursorPos : this.view.toNorm(g.startMid.x, g.startMid.y);
      this._click(p, 2); // two-finger tap = right click
    }
    this.gesture = { kind: 'ended' };
  }

  // ---------- trackpad cursor overlay ----------

  showCursor(visible) {
    this.cursorVisible = visible;
    this._drawCursor();
  }

  _drawCursor() {
    if (!this.cursor) return;
    const show = this.cursorVisible && this.control === 'desktop';
    this.cursor.hidden = !show;
    if (!show) return;
    const p = this.view.fromNorm(this.cursorPos.x, this.cursorPos.y);
    this.cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // ---------- keyboard ----------

  _mapCode(code) {
    // Mac/iPad users press Cmd for shortcuts; PCs expect Ctrl.
    const host = this.session.info?.platform;
    const macViewer = ['mac', 'ipad', 'iphone'].includes(this.viewerPlatform);
    if (macViewer && host && !['mac', 'ipad', 'iphone'].includes(host)) {
      if (code === 'MetaLeft') return 'ControlLeft';
      if (code === 'MetaRight') return 'ControlRight';
    }
    return code;
  }

  key(code, key, down) {
    code = this._mapCode(code);
    if (down) this.downKeys.add(code);
    else this.downKeys.delete(code);
    this.send({ t: down ? 'kd' : 'ku', code, key });
  }

  tap(code, key) {
    // Apply on-screen sticky modifiers, then clear them.
    const mods = [...this.sticky];
    for (const m of mods) this.key(m, m.replace(/(Left|Right)$/, ''), true);
    this.key(code, key, true);
    this.key(code, key, false);
    for (const m of mods.reverse()) this.key(m, m.replace(/(Left|Right)$/, ''), false);
    if (mods.length) {
      this.sticky.clear();
      this.onstickychange?.();
    }
  }

  // Text from the soft keyboard or paste. Single characters combine with
  // sticky modifiers (e.g. Ctrl + C).
  text(str) {
    if (!str) return;
    if (this.sticky.size && str.length === 1) {
      const ch = str;
      const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : '';
      if (code) return this.tap(code, ch);
    }
    const parts = str.split(/(\n)/);
    for (const part of parts) {
      if (part === '\n') this.tap('Enter', 'Enter');
      else if (part) this.send({ t: 'tx', text: part });
    }
  }

  _onKey(e, down) {
    if (this.control === 'none') return;
    const t = e.target;
    const inOurTextBox = t === this.textInput;
    if (!inOurTextBox && t?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Unidentified' || e.keyCode === 229 || e.isComposing) return; // IME; handled via input events
    const printable = e.key.length === 1 && (!(e.ctrlKey || e.metaKey || e.altKey) || (e.ctrlKey && e.altKey && !e.metaKey));
    if (printable) {
      // With the text box focused, characters arrive through 'input' events.
      if (inOurTextBox) return;
      e.preventDefault();
      if (down) this.text(e.key);
      return;
    }
    e.preventDefault();
    if (down && e.repeat && MODIFIER_CODES.has(e.code)) return;
    this.key(e.code || e.key, e.key, down);
  }

  releaseAll() {
    for (const code of [...this.downKeys]) this.send({ t: 'ku', code, key: '' });
    this.downKeys.clear();
    for (const b of [...this.downButtons]) this._button('pu', this.cursorPos, b);
    this.downButtons.clear();
  }

  // ---------- on-screen keyboard (hidden textarea) ----------

  _bindTextInput(opts) {
    const ta = this.textInput;
    if (!ta) return;
    const BASE = '  ';
    let last = BASE;
    let composing = false;
    const reset = () => {
      ta.value = BASE;
      last = BASE;
      ta.setSelectionRange(BASE.length, BASE.length);
    };
    reset();
    ta.addEventListener('focus', reset, opts);
    ta.addEventListener('compositionstart', () => (composing = true), opts);
    ta.addEventListener(
      'compositionend',
      () => {
        composing = false;
        sync();
      },
      opts
    );
    // Diff the box against what we already sent: handles autocorrect,
    // predictive text and backspace on every mobile keyboard.
    const sync = () => {
      const cur = ta.value;
      let i = 0;
      while (i < cur.length && i < last.length && cur[i] === last[i]) i++;
      const removed = last.length - i;
      const added = cur.slice(i);
      for (let k = 0; k < removed; k++) this.tap('Backspace', 'Backspace');
      this.text(added);
      last = cur;
      if (!composing && (cur.length > 40 || !cur.startsWith(BASE))) reset();
    };
    ta.addEventListener('input', sync, opts);
  }
}

function round(v) {
  return Math.round(v * 100000) / 100000;
}
