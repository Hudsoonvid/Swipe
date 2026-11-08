// ---------- control deck: keyboard + trackpad + hotkeys for a tablet ----------
//
// Turns an iPad (or any touch screen) into the PC's keyboard and trackpad,
// without video. The layout is fully customizable: which panels show, their
// order, side by side or stacked, their sizes, the keyboard size (60%–100%)
// and a Stream Deck-style grid of hotkeys/macros. Saved per device.
//
// Uses from the main script: $, store, toast, remote, view.

const deck = (() => {
  const css = `
  .deck { position:absolute; inset:0; top:calc(56px + env(safe-area-inset-top,0px)); display:flex; gap:8px; padding:8px; padding-bottom:calc(8px + env(safe-area-inset-bottom,0px)); background:#07090e; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
  .deck.row { flex-direction:row; } .deck.column { flex-direction:column; }
  .dpanel { flex:1 1 0; min-width:0; min-height:0; position:relative; display:flex; flex-direction:column; }
  .kb { flex:1; display:grid; column-gap:0; row-gap:var(--kgap,4px); min-height:0; justify-content:center; align-content:center; }
  .kb button { margin:0 calc(var(--kgap,4px) / 2); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; min-width:0; min-height:0; padding:0 2px; border-radius:calc(var(--ku,40px) * .14); border:1px solid #2b3446; border-bottom-width:3px; background:#1a2130; color:#e8ecf3; font:600 var(--kfs,14px)/1.05 system-ui,-apple-system,Segoe UI,sans-serif; cursor:pointer; overflow:hidden; white-space:nowrap; }
  .kb button small { font-size:.72em; opacity:.6; font-weight:500; }
  .kb button.mod { background:#141a26; color:#b9c4d8; font-size:calc(var(--kfs,14px) * .85); }
  .kb button.down { background:#4c8dff; border-color:#4c8dff; color:#fff; transform:translateY(1px); }
  .kb button.latched { background:#2d4f8f; border-color:#4c8dff; color:#fff; }
  .tp { flex:1; display:flex; flex-direction:column; gap:6px; min-height:0; }
  .tp-surface { flex:1; border-radius:16px; background:radial-gradient(circle at 50% 40%, #1b2333, #121722); border:1px solid #2b3446; display:grid; place-items:center; color:#3c475c; font-size:.9rem; text-align:center; padding:12px; touch-action:none; }
  .tp-buttons { display:flex; gap:6px; height:clamp(36px, 14%, 64px); }
  .tp-buttons button { flex:1; border-radius:12px; border:1px solid #2b3446; background:#161c28; color:#8f9bb0; font:600 .85rem system-ui,sans-serif; }
  .tp-buttons button.down { background:#4c8dff; color:#fff; }
  .hk { flex:1; display:grid; gap:8px; grid-template-columns:repeat(var(--cols,4), minmax(0,1fr)); grid-auto-rows:minmax(64px, 1fr); overflow-y:auto; align-content:start; }
  .hk button { position:relative; border-radius:14px; border:1px solid #2b3446; background:linear-gradient(160deg,#1e2738,#141a26); color:#e8ecf3; font:600 .8rem system-ui,sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:6px; overflow:hidden; cursor:pointer; }
  .hk button .ic { font-size:1.7rem; line-height:1; }
  .hk button.down { background:#4c8dff; }
  .hk.editing button:not(.add)::after { content:'✎'; position:absolute; right:6px; top:4px; font-size:.8rem; color:#9cc0ff; }
  .hk button.add { border-style:dashed; color:#8f9bb0; background:none; }
  .sheet { position:absolute; inset:0; z-index:8; background:rgba(5,7,12,.7); display:grid; place-items:center; padding:12px; }
  .sheet > div { width:min(560px,100%); max-height:100%; overflow:auto; background:#161c28; border:1px solid #262e3d; border-radius:16px; padding:16px; }
  .sheet h3 { margin:0 0 10px; } .sheet h4 { margin:14px 0 6px; font-size:.85rem; color:#8f9bb0; text-transform:uppercase; letter-spacing:.04em; }
  .sheet .opts { display:flex; flex-wrap:wrap; gap:6px; }
  .sheet .opts button, .sheet .row button { font:600 .85rem system-ui,sans-serif; padding:8px 12px; border-radius:10px; border:1px solid #262e3d; background:#121722; color:#e8ecf3; cursor:pointer; }
  .sheet .opts button.on { background:#4c8dff; border-color:#4c8dff; }
  .sheet .row { display:flex; align-items:center; gap:8px; margin:6px 0; flex-wrap:wrap; }
  .sheet .row label { margin:0; flex:1; min-width:90px; color:#e8ecf3; font-size:.9rem; }
  .sheet input[type=range] { flex:2; min-width:120px; }
  .sheet input[type=text], .sheet textarea { width:100%; font:1rem system-ui,sans-serif; letter-spacing:normal; padding:10px; border-radius:10px; border:1px solid #262e3d; background:#121722; color:#e8ecf3; }
  .sheet textarea { min-height:70px; resize:vertical; }
  .sheet .hint { color:#8f9bb0; font-size:.8rem; margin:4px 0; }
  .sheet .err { color:#ff5c6c; font-size:.85rem; }
  .sheet .end { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; flex-wrap:wrap; }
  `;
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));

  // ----- keys -----
  const MODS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
  const k = (code, label, w = 1, h = 1, alt = '') => ({ code, label, w, h, alt });
  const gap = (w) => ({ gap: w });
  const letters = (s) => [...s].map((c) => k(`Key${c}`, c));
  const mac = () => view.hostPlatform === 'mac';
  const winLabel = () => (mac() ? '⌘' : 'Win');
  const altLabel = () => (mac() ? '⌥' : 'Alt');

  const numRow = (first) => [
    first, ...'1234567890'.split('').map((d, i) => k(`Digit${d}`, d, 1, 1, '!@#$%^&*()'[i])),
    k('Minus', '-', 1, 1, '_'), k('Equal', '=', 1, 1, '+'), k('Backspace', '⌫', 2),
  ];
  const row2 = () => [k('Tab', 'Tab', 1.5), ...letters('QWERTYUIOP'), k('BracketLeft', '[', 1, 1, '{'), k('BracketRight', ']', 1, 1, '}'), k('Backslash', '\\', 1.5, 1, '|')];
  const row3 = () => [k('CapsLock', 'Caps', 1.75), ...letters('ASDFGHJKL'), k('Semicolon', ';', 1, 1, ':'), k('Quote', "'", 1, 1, '"'), k('Enter', 'Enter', 2.25)];
  const row4 = (rightShift = 2.75) => [k('ShiftLeft', 'Shift', 2.25), ...letters('ZXCVBNM'), k('Comma', ',', 1, 1, '<'), k('Period', '.', 1, 1, '>'), k('Slash', '/', 1, 1, '?'), k('ShiftRight', 'Shift', rightShift)];
  const bottomMods = () => [k('ControlLeft', 'Ctrl', 1.25), k('MetaLeft', winLabel(), 1.25), k('AltLeft', altLabel(), 1.25), k('Space', '', 6.25)];
  const fRow = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => k(`F${from + i}`, `F${from + i}`));
  const navCluster = [
    [k('Insert', 'Ins'), k('Home', 'Home'), k('PageUp', 'PgUp')],
    [k('Delete', 'Del'), k('End', 'End'), k('PageDown', 'PgDn')],
  ];
  const numpad = [
    [k('NumLock', 'Num'), k('NumpadDivide', '/'), k('NumpadMultiply', '*'), k('NumpadSubtract', '−')],
    [k('Numpad7', '7'), k('Numpad8', '8'), k('Numpad9', '9'), k('NumpadAdd', '+', 1, 2)],
    [k('Numpad4', '4'), k('Numpad5', '5'), k('Numpad6', '6'), gap(1)],
    [k('Numpad1', '1'), k('Numpad2', '2'), k('Numpad3', '3'), k('NumpadEnter', '↵', 1, 2)],
    [k('Numpad0', '0', 2), k('NumpadDecimal', '.'), gap(1)],
  ];
  const fnRowTKL = () => [k('Escape', 'Esc'), gap(1), ...fRow(1, 4), gap(0.5), ...fRow(5, 8), gap(0.5), ...fRow(9, 12)];

  const LAYOUTS = {
    60: () => [
      numRow(k('Escape', 'Esc', 1, 1, '`')), row2(), row3(), row4(),
      [...bottomMods(), k('AltRight', altLabel(), 1.25), k('Fn', 'Fn', 1.25), k('ContextMenu', '☰', 1.25), k('ControlRight', 'Ctrl', 1.25)],
    ],
    70: () => [
      [...numRow(k('Escape', 'Esc', 1, 1, '`')), k('Delete', 'Del')],
      [...row2(), k('PageUp', 'PgUp')],
      [...row3(), k('PageDown', 'PgDn')],
      [...row4(1.75), k('ArrowUp', '↑'), k('End', 'End')],
      [...bottomMods(), k('AltRight', altLabel()), k('Fn', 'Fn'), k('ControlRight', 'Ctrl'), k('ArrowLeft', '←'), k('ArrowDown', '↓'), k('ArrowRight', '→')],
    ],
    80: () => [
      [...fnRowTKL(), gap(0.5), k('PrintScreen', 'PrtSc'), k('ScrollLock', 'ScrLk'), k('Pause', 'Pause')],
      [...numRow(k('Backquote', '`', 1, 1, '~')), gap(0.5), ...navCluster[0]],
      [...row2(), gap(0.5), ...navCluster[1]],
      [...row3()],
      [...row4(), gap(1.5), k('ArrowUp', '↑')],
      [...bottomMods(), k('AltRight', altLabel(), 1.25), k('MetaRight', winLabel(), 1.25), k('ContextMenu', '☰', 1.25), k('ControlRight', 'Ctrl', 1.25), gap(0.5), k('ArrowLeft', '←'), k('ArrowDown', '↓'), k('ArrowRight', '→')],
    ],
    90: () => [
      [k('Escape', 'Esc'), ...fRow(1, 12), k('PrintScreen', 'PrtSc'), k('Delete', 'Del'), gap(1), k('Home', 'Home'), k('End', 'End'), k('PageUp', 'PgUp'), k('PageDown', 'PgDn')],
      [...numRow(k('Backquote', '`', 1, 1, '~')), k('Insert', 'Ins'), ...numpad[0]],
      [...row2(), gap(1), ...numpad[1]],
      [...row3(), gap(1), ...numpad[2]],
      [...row4(1.75), k('ArrowUp', '↑'), gap(1), ...numpad[3]],
      [k('ControlLeft', 'Ctrl', 1.25), k('MetaLeft', winLabel(), 1.25), k('AltLeft', altLabel(), 1.25), k('Space', '', 6.25), k('AltRight', altLabel()), k('ControlRight', 'Ctrl'), k('ArrowLeft', '←'), k('ArrowDown', '↓'), k('ArrowRight', '→'), gap(1), ...numpad[4]],
    ],
    100: () => [
      [...fnRowTKL(), gap(0.5), k('PrintScreen', 'PrtSc'), k('ScrollLock', 'ScrLk'), k('Pause', 'Pause')],
      [...numRow(k('Backquote', '`', 1, 1, '~')), gap(0.5), ...navCluster[0], gap(0.5), ...numpad[0]],
      [...row2(), gap(0.5), ...navCluster[1], gap(0.5), ...numpad[1]],
      [...row3(), gap(4), ...numpad[2]],
      [...row4(), gap(1.5), k('ArrowUp', '↑'), gap(1.5), ...numpad[3]],
      [...bottomMods(), k('AltRight', altLabel(), 1.25), k('MetaRight', winLabel(), 1.25), k('ContextMenu', '☰', 1.25), k('ControlRight', 'Ctrl', 1.25), gap(0.5), k('ArrowLeft', '←'), k('ArrowDown', '↓'), k('ArrowRight', '→'), gap(0.5), ...numpad[4]],
    ],
  };
  // The Fn layer on the small keyboards.
  const FN = {
    Escape: ['Backquote', '`'], Backspace: ['Delete', 'Del'],
    Digit1: ['F1'], Digit2: ['F2'], Digit3: ['F3'], Digit4: ['F4'], Digit5: ['F5'], Digit6: ['F6'],
    Digit7: ['F7'], Digit8: ['F8'], Digit9: ['F9'], Digit0: ['F10'], Minus: ['F11'], Equal: ['F12'],
    KeyI: ['ArrowUp', '↑'], KeyJ: ['ArrowLeft', '←'], KeyK: ['ArrowDown', '↓'], KeyL: ['ArrowRight', '→'],
    KeyU: ['Home', 'Home'], KeyO: ['End', 'End'], KeyY: ['PageUp', 'PgUp'], KeyH: ['PageDown', 'PgDn'], KeyP: ['PrintScreen', 'PrtSc'],
  };

  // ----- hotkeys: "Ctrl+Shift+Esc", "\"text\"", "wait 300", joined with commas -----
  const NAMES = {
    ctrl: 'ControlLeft', control: 'ControlLeft', shift: 'ShiftLeft', alt: 'AltLeft', option: 'AltLeft', opt: 'AltLeft',
    win: 'MetaLeft', windows: 'MetaLeft', cmd: 'MetaLeft', command: 'MetaLeft', meta: 'MetaLeft', super: 'MetaLeft',
    esc: 'Escape', escape: 'Escape', tab: 'Tab', enter: 'Enter', return: 'Enter', space: 'Space', backspace: 'Backspace',
    del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert', home: 'Home', end: 'End',
    pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    prtsc: 'PrintScreen', printscreen: 'PrintScreen', capslock: 'CapsLock', menu: 'ContextMenu',
    volup: 'AudioVolumeUp', voldown: 'AudioVolumeDown', mute: 'AudioVolumeMute',
    play: 'MediaPlayPause', playpause: 'MediaPlayPause', next: 'MediaTrackNext', prev: 'MediaTrackPrevious', stop: 'MediaStop',
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
    "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
  };
  function keyCode(name) {
    const n = name.trim().toLowerCase();
    if (n === 'mod') return mac() ? 'MetaLeft' : 'ControlLeft';
    if (NAMES[n]) return NAMES[n];
    if (/^[a-z]$/.test(n)) return `Key${n.toUpperCase()}`;
    if (/^[0-9]$/.test(n)) return `Digit${n}`;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return n.toUpperCase();
    return null;
  }
  function parseAction(src) {
    const steps = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|[^,]+)\s*(?:,|$)/g;
    let m;
    const text = String(src || '').trim();
    if (!text) throw new Error('Enter keys, "text" or wait');
    while ((m = re.exec(text)) && m[0]) {
      const part = m[1].trim();
      if (!part) continue;
      if (part.startsWith('"')) {
        steps.push({ text: JSON.parse(part) });
      } else if (/^wait(\s+\d+)?$/i.test(part)) {
        steps.push({ wait: Math.min(5000, Number(part.split(/\s+/)[1]) || 300) });
      } else {
        const codes = part.split('+').map((p) => p.trim()).filter(Boolean).map((p) => {
          const c = keyCode(p);
          if (!c) throw new Error(`Unknown key "${p}"`);
          return c;
        });
        if (!codes.length) throw new Error(`Empty step in "${part}"`);
        steps.push({ keys: codes });
      }
    }
    return steps;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runAction(src) {
    const steps = parseAction(src);
    for (const s of steps) {
      if (s.wait) await sleep(s.wait);
      else if (s.text) remote.send({ t: 'tx', text: s.text });
      else {
        for (const c of s.keys) remote.send({ t: 'kd', code: c, key: c });
        for (const c of [...s.keys].reverse()) remote.send({ t: 'ku', code: c, key: c });
        await sleep(30);
      }
    }
  }
  const DEFAULT_HOTKEYS = [
    { icon: '📋', label: 'Copy', action: 'Mod+C' },
    { icon: '📥', label: 'Paste', action: 'Mod+V' },
    { icon: '↩️', label: 'Undo', action: 'Mod+Z' },
    { icon: '🔀', label: 'Switch app', action: 'Alt+Tab' },
    { icon: '🖥', label: 'Desktop', action: 'Win+D' },
    { icon: '✂️', label: 'Screenshot', action: 'Win+Shift+S' },
    { icon: '📊', label: 'Task Manager', action: 'Ctrl+Shift+Esc' },
    { icon: '❌', label: 'Close', action: 'Alt+F4' },
    { icon: '⏯', label: 'Play/Pause', action: 'PlayPause' },
    { icon: '🔉', label: 'Volume −', action: 'VolDown' },
    { icon: '🔊', label: 'Volume +', action: 'VolUp' },
    { icon: '🔇', label: 'Mute', action: 'Mute' },
  ];

  // ----- settings -----
  const PRESETS = {
    'kb-top': { label: 'Keyboard top, trackpad bottom', dir: 'column', order: ['keyboard', 'trackpad'], sizes: { keyboard: 55, trackpad: 45 } },
    'pad-top': { label: 'Trackpad top, keyboard bottom', dir: 'column', order: ['trackpad', 'keyboard'], sizes: { keyboard: 55, trackpad: 45 } },
    'kb-left': { label: 'Keyboard left, trackpad right', dir: 'row', order: ['keyboard', 'trackpad'], sizes: { keyboard: 62, trackpad: 38 } },
    'kb-right': { label: 'Trackpad left, keyboard right', dir: 'row', order: ['trackpad', 'keyboard'], sizes: { keyboard: 62, trackpad: 38 } },
    pad: { label: 'Trackpad only', dir: 'column', order: ['trackpad'], sizes: { trackpad: 100 } },
    kb: { label: 'Keyboard only', dir: 'column', order: ['keyboard'], sizes: { keyboard: 100 } },
    deck: { label: 'Hotkeys + trackpad', dir: 'row', order: ['hotkeys', 'trackpad'], sizes: { hotkeys: 55, trackpad: 45 } },
  };
  const PANELS = { keyboard: 'Keyboard', trackpad: 'Trackpad', hotkeys: 'Hotkeys' };
  function defaults() {
    return { preset: 'kb-top', dir: 'column', panels: [
      { id: 'hotkeys', show: false, size: 22 }, { id: 'keyboard', show: true, size: 55 }, { id: 'trackpad', show: true, size: 45 },
    ], kb: 80, speed: 1, natural: true, cols: 4, hotkeys: DEFAULT_HOTKEYS.map((h) => ({ ...h })) };
  }
  let cfg = load();
  function load() {
    try {
      const c = JSON.parse(store.get('deck') || 'null');
      if (c && Array.isArray(c.panels) && Array.isArray(c.hotkeys)) return { ...defaults(), ...c };
    } catch {}
    return defaults();
  }
  function save() { store.set('deck', JSON.stringify(cfg)); }
  function applyPreset(id) {
    const p = PRESETS[id];
    const hk = cfg.panels.find((x) => x.id === 'hotkeys');
    const keepHotkeys = id !== 'deck' && hk?.show;
    const order = keepHotkeys ? ['hotkeys', ...p.order] : p.order;
    cfg.preset = id;
    cfg.dir = p.dir;
    cfg.panels = [...order, ...Object.keys(PANELS).filter((x) => !order.includes(x))].map((pid) => ({
      id: pid, show: order.includes(pid), size: p.sizes[pid] ?? (pid === 'hotkeys' ? 22 : 40),
    }));
    save();
    render();
  }

  // ----- DOM -----
  let root = null;
  let editing = false;
  const state = { fn: false, latched: new Set(), held: new Map(), usedWhileHeld: false, repeat: null };

  function send(evt) { return remote.send(evt); }
  function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch {} }
  function down(code) { send({ t: 'kd', code, key: code }); }
  function up(code) { send({ t: 'ku', code, key: code }); }

  function buildKeyboard() {
    const el = document.createElement('div');
    el.className = 'kb';
    const rows = (LAYOUTS[cfg.kb] || LAYOUTS[80])();
    const width = Math.max(...rows.map((r) => r.reduce((s, it) => s + (it.gap ?? it.w), 0)));
    el.style.gridTemplateColumns = `repeat(${Math.round(width * 4)}, minmax(0,1fr))`;
    el.style.gridTemplateRows = `repeat(${rows.length}, minmax(0,1fr))`;
    el.dataset.units = String(width);
    el.dataset.rows = String(rows.length);
    rows.forEach((row, r) => {
      let x = 0;
      for (const it of row) {
        if (it.gap !== undefined) { x += it.gap; continue; }
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.code = it.code;
        b.style.gridColumn = `${Math.round(x * 4) + 1} / span ${Math.round(it.w * 4)}`;
        b.style.gridRow = `${r + 1} / span ${it.h}`;
        if (MODS.has(it.code) || it.code === 'Fn' || it.w > 1.2) b.classList.add('mod');
        b._key = it;
        labelKey(b);
        bindKey(b);
        el.append(b);
        x += it.w;
      }
    });
    requestAnimationFrame(() => el.parentElement && new ResizeObserver(() => sizeKeyboard(el)).observe(el.parentElement));
    return el;
  }
  function labelKey(b) {
    const it = b._key;
    const fn = state.fn && FN[it.code];
    const label = fn ? (fn[1] || fn[0]) : it.label;
    b.replaceChildren();
    if (it.alt && !fn) b.append(Object.assign(document.createElement('small'), { textContent: it.alt }));
    b.append(document.createTextNode(label));
    b.classList.toggle('latched', state.latched.has(it.code) || (it.code === 'Fn' && state.fn));
  }
  function relabel() { root?.querySelectorAll('.kb button').forEach(labelKey); }
  function sizeKeyboard(el) {
    const units = Number(el.dataset.units), rows = Number(el.dataset.rows);
    const W = el.parentElement.clientWidth, H = el.parentElement.clientHeight;
    const u0 = Math.min(W / units, H / rows);
    const g = Math.max(2, Math.min(6, u0 * 0.08));
    // Keep keys key-shaped: never much taller or wider than they should be.
    const colW = Math.min(W / units, u0 * 1.3) / 4;
    const rowH = Math.min((H - g * (rows - 1)) / rows, u0 * 1.2);
    el.style.gridTemplateColumns = `repeat(${Math.round(units * 4)}, ${colW}px)`;
    el.style.gridTemplateRows = `repeat(${rows}, ${rowH}px)`;
    el.style.setProperty('--ku', `${u0}px`);
    el.style.setProperty('--kfs', `${Math.max(9, Math.min(22, u0 * 0.34))}px`);
    el.style.setProperty('--kgap', `${g}px`);
  }
  function bindKey(b) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(b, e);
      const code = b._key.code;
      if (code === 'Fn') { state.fn = !state.fn; relabel(); return; }
      if (MODS.has(code)) {
        if (state.latched.has(code)) { state.latched.delete(code); up(code); relabel(); return; }
        state.held.set(code, false);
        down(code);
        b.classList.add('down');
        return;
      }
      for (const m of state.held.keys()) state.held.set(m, true); // used as a chord
      const real = state.fn && FN[code] ? FN[code][0] : code;
      b._sent = real;
      down(real);
      b.classList.add('down');
      clearTimeout(state.repeat?.t);
      clearInterval(state.repeat?.i);
      const rep = { t: setTimeout(() => (rep.i = setInterval(() => down(real), 45)), 420) };
      state.repeat = rep;
    });
    const end = () => {
      const code = b._key.code;
      if (!b.classList.contains('down')) return;
      b.classList.remove('down');
      if (MODS.has(code)) {
        const used = state.held.get(code);
        state.held.delete(code);
        if (used) up(code);
        else { state.latched.add(code); relabel(); } // tapped alone: applies to the next key
        return;
      }
      clearTimeout(state.repeat?.t);
      clearInterval(state.repeat?.i);
      up(b._sent || code);
      if (state.latched.size) {
        for (const m of [...state.latched].reverse()) up(m);
        state.latched.clear();
        relabel();
      }
      if (state.fn) { state.fn = false; relabel(); }
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function buildTrackpad() {
    const el = document.createElement('div');
    el.className = 'tp';
    const surface = document.createElement('div');
    surface.className = 'tp-surface';
    surface.id = 'tpSurface';
    surface.innerHTML = 'Trackpad<br><small>1 finger moves · tap clicks · 2 fingers scroll · 2-finger tap right-clicks · tap then drag to drag</small>';
    const btns = document.createElement('div');
    btns.className = 'tp-buttons';
    for (const [label, b] of [['Left click', 0], ['Right click', 2]]) {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = label;
      x.dataset.b = String(b);
      x.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(x, e); x.classList.add('down'); send({ t: 'pd', b }); });
      const end = () => { if (x.classList.contains('down')) { x.classList.remove('down'); send({ t: 'pu', b }); } };
      x.addEventListener('pointerup', end);
      x.addEventListener('pointercancel', end);
      btns.append(x);
    }
    el.append(surface, btns);
    bindTrackpad(surface);
    return el;
  }
  function bindTrackpad(s) {
    const pts = new Map();
    let g = null; // current gesture
    let lastTapAt = 0;
    const acc = { x: 0, y: 0, sx: 0, sy: 0 };
    let raf = 0;
    const flush = () => {
      raf = 0;
      const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y);
      if (dx || dy) { acc.x -= dx; acc.y -= dy; send({ t: 'mm', dx, dy, all: 1 }); }
      const sx = Math.trunc(acc.sx), sy = Math.trunc(acc.sy);
      if (sx || sy) { acc.sx -= sx; acc.sy -= sy; send({ t: 'wh', dx: sx, dy: sy }); }
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(s, e);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (pts.size === 1) {
        g = { kind: 'one', start: e.timeStamp, moved: 0, dragArm: e.timeStamp - lastTapAt < 300, dragging: false };
      } else if (pts.size === 2) {
        if (g?.dragging) { send({ t: 'pu', b: 0 }); }
        g = { kind: 'two', start: g?.start ?? e.timeStamp, moved: 0 };
      } else if (g) g.kind = 'many';
    });
    s.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p || !g) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      g.moved += Math.hypot(dx, dy);
      if (g.kind === 'one') {
        if (g.dragArm && !g.dragging && g.moved > 6) { g.dragging = true; send({ t: 'pd', b: 0 }); }
        // Pointer acceleration: slow moves are precise, fast moves cover the screen.
        const v = Math.hypot(dx, dy) / dt;
        const gain = cfg.speed * (1.4 + Math.min(v, 2.5) * 1.6);
        acc.x += dx * gain;
        acc.y += dy * gain;
        queue();
      } else if (g.kind === 'two') {
        const k2 = (cfg.natural ? -1 : 1) * 1.6 / 2; // two pointers each report the move
        acc.sx += dx * k2;
        acc.sy += dy * k2;
        queue();
      }
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId) || !g) return;
      if (pts.size) return;
      const dur = e.timeStamp - g.start;
      if (g.kind === 'one') {
        if (g.dragging) send({ t: 'pu', b: 0 });
        else if (dur < 230 && g.moved < 10) {
          send({ t: 'pd', b: 0 });
          send({ t: 'pu', b: 0 });
          lastTapAt = e.timeStamp;
        }
      } else if (g.kind === 'two' && dur < 280 && g.moved < 16) {
        send({ t: 'pd', b: 2 });
        send({ t: 'pu', b: 2 });
      }
      g = null;
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function buildHotkeys() {
    const el = document.createElement('div');
    el.className = 'hk' + (editing ? ' editing' : '');
    el.style.setProperty('--cols', String(cfg.cols));
    cfg.hotkeys.forEach((h, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = h.action;
      b.append(Object.assign(document.createElement('span'), { className: 'ic', textContent: h.icon || '⬜' }), Object.assign(document.createElement('span'), { textContent: h.label || h.action }));
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.onclick = async () => {
        if (editing) return editHotkey(i);
        b.classList.add('down');
        setTimeout(() => b.classList.remove('down'), 150);
        try { await runAction(h.action); } catch (err) { toast(`${h.label}: ${err.message}`); }
      };
      el.append(b);
    });
    if (editing) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add';
      add.textContent = '+ Add';
      add.onclick = () => editHotkey(-1);
      el.append(add);
    }
    return el;
  }

  function render() {
    if (!root) return;
    for (const m of state.latched) up(m);
    state.latched.clear();
    state.fn = false;
    root.className = `deck ${cfg.dir === 'row' ? 'row' : 'column'}`;
    const build = { keyboard: buildKeyboard, trackpad: buildTrackpad, hotkeys: buildHotkeys };
    root.replaceChildren(...cfg.panels.filter((p) => p.show && build[p.id]).map((p) => {
      const panel = document.createElement('div');
      panel.className = 'dpanel';
      panel.dataset.panel = p.id;
      panel.style.flex = `${Math.max(5, p.size)} 1 0`;
      panel.append(build[p.id]());
      return panel;
    }));
  }

  // ----- settings sheet -----
  function sheet(build) {
    closeSheet();
    const s = document.createElement('div');
    s.className = 'sheet';
    s.id = 'deckSheet';
    const box = document.createElement('div');
    s.append(box);
    s.addEventListener('pointerdown', (e) => { if (e.target === s) closeSheet(); });
    build(box);
    $('session').append(s);
    return box;
  }
  function closeSheet() { $('deckSheet')?.remove(); }
  const btn = (label, onclick, cls = '') => Object.assign(document.createElement('button'), { type: 'button', textContent: label, onclick, className: cls });
  const h = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

  function openSettings() {
    sheet((box) => {
      box.append(h('h3', 'Layout'));
      box.append(h('h4', 'Presets'));
      const presets = document.createElement('div');
      presets.className = 'opts';
      for (const [id, p] of Object.entries(PRESETS)) presets.append(btn(p.label, () => { applyPreset(id); openSettings(); }, cfg.preset === id ? 'on' : ''));
      box.append(presets);

      box.append(h('h4', 'Arrange'));
      const dir = document.createElement('div');
      dir.className = 'opts';
      for (const [id, label] of [['column', 'Stacked (top to bottom)'], ['row', 'Side by side']]) {
        dir.append(btn(label, () => { cfg.dir = id; cfg.preset = ''; save(); render(); openSettings(); }, cfg.dir === id ? 'on' : ''));
      }
      box.append(dir);
      cfg.panels.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.show });
        cb.style.width = 'auto';
        cb.dataset.panel = p.id;
        cb.onchange = () => { p.show = cb.checked; cfg.preset = ''; save(); render(); };
        lab.append(cb, ` ${PANELS[p.id]}`);
        const size = Object.assign(document.createElement('input'), { type: 'range', min: 10, max: 90, value: p.size });
        size.oninput = () => { p.size = Number(size.value); cfg.preset = ''; save(); render(); };
        row.append(lab, size,
          btn('↑', () => { if (i) { [cfg.panels[i - 1], cfg.panels[i]] = [cfg.panels[i], cfg.panels[i - 1]]; cfg.preset = ''; save(); render(); openSettings(); } }),
          btn('↓', () => { if (i < cfg.panels.length - 1) { [cfg.panels[i + 1], cfg.panels[i]] = [cfg.panels[i], cfg.panels[i + 1]]; cfg.preset = ''; save(); render(); openSettings(); } }));
        box.append(row);
      });
      box.append(Object.assign(h('p', '↑ ↓ change the order (top/left first). Sliders set each panel’s share of the screen.'), { className: 'hint' }));

      box.append(h('h4', 'Keyboard size'));
      const sizes = document.createElement('div');
      sizes.className = 'opts';
      for (const [n, label] of [[60, '60%'], [70, '70% (+ arrows)'], [80, '80% (TKL)'], [90, '90% (+ numpad)'], [100, '100% (full)']]) {
        sizes.append(btn(label, () => { cfg.kb = n; save(); render(); openSettings(); }, cfg.kb === n ? 'on' : ''));
      }
      box.append(sizes);
      box.append(Object.assign(h('p', 'On 60% and 70%, Fn + number row gives F1–F12, Fn + I J K L gives arrows, Fn + Esc gives `.'), { className: 'hint' }));

      box.append(h('h4', 'Trackpad'));
      const sp = document.createElement('div');
      sp.className = 'row';
      const speed = Object.assign(document.createElement('input'), { type: 'range', min: 0.3, max: 3, step: 0.1, value: cfg.speed });
      speed.oninput = () => { cfg.speed = Number(speed.value); save(); };
      sp.append(h('label', 'Pointer speed'), speed);
      const nat = document.createElement('div');
      nat.className = 'row';
      const natLab = document.createElement('label');
      const natCb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: cfg.natural });
      natCb.style.width = 'auto';
      natCb.onchange = () => { cfg.natural = natCb.checked; save(); };
      natLab.append(natCb, ' Natural scrolling (content follows your fingers)');
      nat.append(natLab);
      box.append(sp, nat);

      box.append(h('h4', 'Hotkeys'));
      const hc = document.createElement('div');
      hc.className = 'row';
      const cols = Object.assign(document.createElement('input'), { type: 'range', min: 2, max: 8, step: 1, value: cfg.cols });
      cols.oninput = () => { cfg.cols = Number(cols.value); save(); render(); };
      hc.append(h('label', 'Columns'), cols);
      box.append(hc);
      const hb = document.createElement('div');
      hb.className = 'opts';
      hb.append(btn(editing ? 'Done editing hotkeys' : '✎ Edit hotkeys', () => {
        editing = !editing;
        const hk = cfg.panels.find((p) => p.id === 'hotkeys');
        if (editing && !hk.show) { hk.show = true; save(); }
        render();
        closeSheet();
        if (editing) toast('Tap a hotkey to change it, or + Add. Tap ⚙ → Done editing when finished.', 5000);
      }, editing ? 'on' : ''), btn('Reset hotkeys', () => { if (confirm('Put back the default hotkeys?')) { cfg.hotkeys = DEFAULT_HOTKEYS.map((x) => ({ ...x })); save(); render(); } }));
      box.append(hb);

      const end = document.createElement('div');
      end.className = 'end';
      end.append(btn('Reset everything', () => { if (confirm('Reset the whole layout?')) { cfg = defaults(); save(); render(); openSettings(); } }), btn('Done', closeSheet));
      box.append(end);
    });
  }

  function editHotkey(i) {
    const cur = i >= 0 ? cfg.hotkeys[i] : { icon: '⭐', label: '', action: '' };
    sheet((box) => {
      box.append(h('h3', i >= 0 ? 'Edit hotkey' : 'New hotkey'));
      const field = (label, value, tag = 'input') => {
        const w = document.createElement('div');
        w.className = 'row';
        w.style.display = 'block';
        const el = Object.assign(document.createElement(tag), { value });
        if (tag === 'input') el.type = 'text';
        w.append(h('label', label), el);
        box.append(w);
        return el;
      };
      const icon = field('Icon (an emoji)', cur.icon);
      icon.id = 'hkIcon';
      const label = field('Name', cur.label);
      label.id = 'hkLabel';
      const action = field('Keys or macro', cur.action, 'textarea');
      action.id = 'hkAction';
      box.append(Object.assign(h('p', 'Examples: Ctrl+C · Win+Shift+S · Alt+F4 · VolUp · "hello" (types text) · Win+R, wait 400, "notepad", Enter. Steps run in order, separated by commas. Mod = Ctrl on Windows, ⌘ on Mac.'), { className: 'hint' }));
      const err = Object.assign(document.createElement('p'), { className: 'err' });
      box.append(err);
      const end = document.createElement('div');
      end.className = 'end';
      const check = () => {
        try { parseAction(action.value); err.textContent = ''; return true; } catch (e) { err.textContent = e.message; return false; }
      };
      if (i >= 0) {
        end.append(btn('Delete', () => { cfg.hotkeys.splice(i, 1); save(); render(); closeSheet(); }));
        end.append(btn('◀ Move', () => { if (i > 0) { [cfg.hotkeys[i - 1], cfg.hotkeys[i]] = [cfg.hotkeys[i], cfg.hotkeys[i - 1]]; save(); render(); editHotkey(i - 1); } }));
        end.append(btn('Move ▶', () => { if (i < cfg.hotkeys.length - 1) { [cfg.hotkeys[i + 1], cfg.hotkeys[i]] = [cfg.hotkeys[i], cfg.hotkeys[i + 1]]; save(); render(); editHotkey(i + 1); } }));
      }
      end.append(btn('Try it', () => { if (check()) runAction(action.value).catch(() => {}); }));
      end.append(btn('Cancel', closeSheet));
      const saveBtn = btn('Save', () => {
        if (!check()) return;
        const item = { icon: icon.value.trim().slice(0, 8), label: label.value.trim().slice(0, 30), action: action.value.trim().slice(0, 500) };
        if (i >= 0) cfg.hotkeys[i] = item;
        else cfg.hotkeys.push(item);
        save();
        render();
        closeSheet();
      });
      saveBtn.id = 'hkSave';
      end.append(saveBtn);
      box.append(end);
    });
  }

  function show() {
    if (!root) {
      root = document.createElement('div');
      root.id = 'deck';
      $('session').append(root);
    }
    root.hidden = false;
    cfg = load();
    render();
  }
  function hide() {
    closeSheet();
    editing = false;
    for (const m of state.latched) up(m);
    for (const m of state.held.keys()) up(m);
    state.latched.clear();
    state.held.clear();
    clearTimeout(state.repeat?.t);
    clearInterval(state.repeat?.i);
    root?.remove();
    root = null;
  }
  return { show, hide, openSettings, parseAction, runAction, get config() { return cfg; }, applyPreset };
})();
