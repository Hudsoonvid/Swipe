// ---------- control deck: keyboard + trackpad + hotkeys for a tablet ----------
//
// Turns an iPad (or any touch screen) into the PC's keyboard, trackpad and
// hotkey pad, and optionally a live screen to touch directly. Every panel is
// a window you can move and resize (Stage Manager style); keyboard size
// 60%–100%, Mac trackpad gestures, Apple Pencil with pressure, and a Stream
// Deck-style grid of hotkeys/macros. Saved per device.
//
// Uses from the main script: $, store, toast, remote, view.

const deck = (() => {
  const css = `
  .deck { position:absolute; inset:0; top:calc(56px + env(safe-area-inset-top,0px)); padding:4px; padding-bottom:calc(4px + env(safe-area-inset-bottom,0px)); background:#07090e; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
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
  .deck-area { position:relative; width:100%; height:100%; }
  .deck-empty { color:#8f9bb0; text-align:center; margin-top:20%; }
  .dwin { position:absolute; padding:4px; display:flex; flex-direction:column; min-width:0; min-height:0; }
  .dwin-body { flex:1; min-height:0; display:flex; flex-direction:column; position:relative; }
  .deck.arranging .dwin { outline:2px dashed #4c8dff88; outline-offset:-2px; border-radius:14px; background:#0b0e14cc; }
  .deck.arranging .dwin-body { pointer-events:none; opacity:.55; }
  .dwin-bar { height:34px; flex:none; display:flex; align-items:center; justify-content:space-between; padding:0 6px 0 10px; margin-bottom:4px; border-radius:10px; background:#4c8dff; color:#fff; font:700 .85rem system-ui,sans-serif; cursor:grab; touch-action:none; }
  .dwin-bar button { border:0; background:none; color:#fff; font-size:1rem; padding:4px 8px; cursor:pointer; }
  .dwin-size { position:absolute; right:0; bottom:0; width:36px; height:36px; border-radius:0 0 14px 0; background:linear-gradient(135deg, transparent 50%, #4c8dff 50%); cursor:nwse-resize; touch-action:none; z-index:2; }
  .tp-buttons .tp-mode { flex:0 0 auto; padding:0 12px; color:#e8ecf3; }
  .scr-switch { display:flex; align-items:center; gap:4px; }
  .scr-switch span { font:600 .8rem system-ui,sans-serif; color:#e8ecf3; white-space:nowrap; padding:0 4px; }
  .scr-switch button { border-radius:10px; border:1px solid #2b3446; background:#161c28; color:#e8ecf3; min-width:40px; height:100%; min-height:32px; font-size:.9rem; }
  .tp-switch { flex:0 0 auto; }
  .scr { flex:1; position:relative; border-radius:14px; overflow:hidden; background:#000; border:1px solid #2b3446; min-height:0; }
  .scr video { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; pointer-events:none; }
  .scr-surface { position:absolute; inset:0; touch-action:none; }
  .scr-msg { position:absolute; inset:0; display:grid; place-items:center; color:#8f9bb0; font-size:.9rem; }
  .scr-bar { position:absolute; right:8px; top:8px; z-index:2; padding:4px; border-radius:12px; background:rgba(18,23,34,.85); }
  .kb.kb-pad button:not([data-code=Space]) { opacity:.25; }
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
  // Every panel is a window placed in % of the deck: {x, y, w, h, z}. Presets
  // are starting positions; "Arrange" lets you drag and resize them freely.
  const PANELS = { screen: 'Screen', keyboard: 'Keyboard', trackpad: 'Trackpad', hotkeys: 'Hotkeys' };
  const R = (x, y, w, h) => ({ x, y, w, h });
  const PRESETS = {
    'kb-top': { label: 'Keyboard top, trackpad bottom', win: { keyboard: R(0, 0, 100, 56), trackpad: R(0, 56, 100, 44) } },
    'pad-top': { label: 'Trackpad top, keyboard bottom', win: { trackpad: R(0, 0, 100, 44), keyboard: R(0, 44, 100, 56) } },
    'kb-left': { label: 'Keyboard left, trackpad right', win: { keyboard: R(0, 0, 62, 100), trackpad: R(62, 0, 38, 100) } },
    'kb-right': { label: 'Trackpad left, keyboard right', win: { trackpad: R(0, 0, 38, 100), keyboard: R(38, 0, 62, 100) } },
    pad: { label: 'Trackpad only', win: { trackpad: R(0, 0, 100, 100) } },
    kb: { label: 'Keyboard only', win: { keyboard: R(0, 0, 100, 100) } },
    deck: { label: 'Hotkeys + trackpad', win: { hotkeys: R(0, 0, 55, 100), trackpad: R(55, 0, 45, 100) } },
    'screen-kb': { label: 'Screen + keyboard', win: { screen: R(0, 0, 100, 60), keyboard: R(0, 60, 100, 40) } },
    screen: { label: 'Screen only (touch it directly)', win: { screen: R(0, 0, 100, 100) } },
  };
  const HIDDEN = () => ({ show: false, x: 15, y: 12, w: 70, h: 70, z: 0 });
  function presetWindows(id) {
    const p = PRESETS[id] || PRESETS['kb-top'];
    const out = {};
    let z = 1;
    for (const pid of Object.keys(PANELS)) out[pid] = p.win[pid] ? { show: true, ...p.win[pid], z: z++ } : HIDDEN();
    return out;
  }
  function defaults() {
    return {
      preset: 'kb-top', windows: presetWindows('kb-top'), kb: 80, cols: 4,
      padMode: 'trackpad', speed: 1, scroll: 1, natural: true, snap: true, penMouse: false, gestures: true, threeDrag: false,
      hotkeys: DEFAULT_HOTKEYS.map((x) => ({ ...x })),
    };
  }
  let cfg = load();
  function load() {
    try {
      const c = JSON.parse(store.get('deck') || 'null');
      if (c && Array.isArray(c.hotkeys)) {
        const m = { ...defaults(), ...c };
        if (!c.windows) m.windows = presetWindows(PRESETS[c.preset] ? c.preset : 'kb-top'); // older saved layout
        for (const pid of Object.keys(PANELS)) m.windows[pid] ??= HIDDEN();
        delete m.panels;
        delete m.dir;
        return m;
      }
    } catch {}
    return defaults();
  }
  function save() { store.set('deck', JSON.stringify(cfg)); }
  function applyPreset(id) {
    cfg.preset = id;
    cfg.windows = presetWindows(id);
    save();
    render();
  }

  // ----- DOM -----
  let root = null;
  let editing = false; // editing hotkeys
  let arranging = false; // moving & resizing windows
  let stream = null; // the PC's picture, for the Screen window
  let videoWanted = null; // what we last asked the PC for
  const pens = new Set();
  const state = { fn: false, latched: new Set(), held: new Map(), usedWhileHeld: false, repeat: null };

  function send(evt) { return remote.send(evt); }
  function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch {} }
  function down(code) { send({ t: 'kd', code, key: code }); }
  function up(code) { send({ t: 'ku', code, key: code }); }
  const penBusy = () => [...pens].some((p) => p.active); // palm rejection
  const r5 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100000) / 100000;
  const norm = (rect, x, y) => ({ x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height });

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
        if (it.code === 'Space') bindSpace(b, el);
        else bindKey(b);
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
  // Like the iPad keyboard: hold the space bar and slide to move the pointer.
  function bindSpace(b, kb) {
    let t = 0, pad = false, last = null;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(b, e);
      b.classList.add('down');
      last = { x: e.clientX, y: e.clientY };
      pad = false;
      t = setTimeout(() => { pad = true; kb.classList.add('kb-pad'); }, 400);
    });
    b.addEventListener('pointermove', (e) => {
      if (!pad || !last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      const gain = cfg.speed * 2.2;
      const mx = Math.round(dx * gain), my = Math.round(dy * gain);
      if (mx || my) send({ t: 'mm', dx: mx, dy: my, all: 1 });
    });
    const end = (e) => {
      if (!b.classList.contains('down')) return;
      clearTimeout(t);
      b.classList.remove('down');
      kb.classList.remove('kb-pad');
      last = null;
      if (pad || e.type === 'pointercancel') { pad = false; return; }
      down('Space');
      up('Space');
      if (state.latched.size) {
        for (const m of [...state.latched].reverse()) up(m);
        state.latched.clear();
        relabel();
      }
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
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

  // Mac trackpad gestures, sent as the matching shortcut for the PC's system.
  const SYS = {
    overview: { windows: 'Win+Tab', mac: 'Ctrl+Up', linux: 'Win' }, // swipe up: Mission Control / Task View
    appWindows: { windows: 'Win+D', mac: 'Ctrl+Down', linux: 'Win' }, // swipe down: App Exposé / show desktop
    deskNext: { windows: 'Ctrl+Win+Right', mac: 'Ctrl+Right', linux: 'Ctrl+Alt+Right' }, // swipe left
    deskPrev: { windows: 'Ctrl+Win+Left', mac: 'Ctrl+Left', linux: 'Ctrl+Alt+Left' }, // swipe right
    launcher: { windows: 'Win', mac: 'Cmd+Space', linux: 'Win' }, // pinch thumb + 3 fingers: Launchpad / Start
    desktop: { windows: 'Win+D', mac: 'Cmd+F3', linux: 'Win+D' }, // spread thumb + 3 fingers
    notifications: { windows: 'Win+N', mac: '', linux: '' }, // 2 fingers in from the right edge
    lookUp: { windows: '', mac: 'Ctrl+Cmd+D', linux: '' }, // 3-finger tap (Windows/Linux: middle click)
    zoomReset: { windows: 'Ctrl+0', mac: 'Cmd+0', linux: 'Ctrl+0' },
  };
  function sysGesture(name) {
    const plat = ['mac', 'linux'].includes(view.hostPlatform) ? view.hostPlatform : 'windows';
    const action = SYS[name]?.[plat];
    if (action) runAction(action).catch(() => {});
    return !!action;
  }
  // One pinch step: Ctrl + wheel on Windows/Linux, ⌘= / ⌘- on a Mac.
  function zoomStep(dir, p) {
    if (mac()) return runAction(dir > 0 ? 'Cmd+=' : 'Cmd+-').catch(() => {});
    down('ControlLeft');
    send(p ? { t: 'wh', x: r5(p.x), y: r5(p.y), dx: 0, dy: dir > 0 ? -100 : 100 } : { t: 'wh', dx: 0, dy: dir > 0 ? -100 : 100 });
    up('ControlLeft');
  }

  // Two-finger scrolling with momentum, like a laptop trackpad.
  function makeScroller(getPoint) {
    const acc = { x: 0, y: 0 };
    let vel = { x: 0, y: 0 };
    let lastT = 0;
    let raf = 0;
    let glide = 0;
    const flush = () => {
      raf = 0;
      const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y);
      if (!dx && !dy) return;
      acc.x -= dx;
      acc.y -= dy;
      const p = getPoint?.();
      send(p ? { t: 'wh', x: r5(p.x), y: r5(p.y), dx, dy } : { t: 'wh', dx, dy });
    };
    return {
      // dx, dy: how far the fingers moved (CSS px); t: event time
      move(dx, dy, t) {
        cancelAnimationFrame(glide);
        glide = 0;
        const k = 3.2 * cfg.scroll * (cfg.natural ? -1 : 1);
        acc.x += dx * k;
        acc.y += dy * k;
        const dt = Math.max(1, t - lastT);
        lastT = t;
        vel = { x: 0.7 * vel.x + 0.3 * ((dx * k) / dt), y: 0.7 * vel.y + 0.3 * ((dy * k) / dt) };
        if (!raf) raf = requestAnimationFrame(flush);
      },
      // Fingers lifted while moving: keep gliding and slow down.
      end(t) {
        if (t - lastT > 90 || Math.hypot(vel.x, vel.y) < 0.4) return;
        const v = { ...vel };
        let prev = performance.now();
        const step = (now) => {
          const dt = Math.min(50, now - prev);
          prev = now;
          acc.x += v.x * dt;
          acc.y += v.y * dt;
          const f = Math.pow(0.9955, dt);
          v.x *= f;
          v.y *= f;
          flush();
          glide = Math.hypot(v.x, v.y) > 0.05 ? requestAnimationFrame(step) : 0;
        };
        glide = requestAnimationFrame(step);
      },
      stop() {
        cancelAnimationFrame(glide);
        glide = 0;
        vel = { x: 0, y: 0 };
      },
    };
  }

  // ◀ Screen 1/2 ▶ for PCs with several monitors.
  function screenSwitch(cls) {
    const el = document.createElement('div');
    el.className = cls;
    const prev = btn('◀', () => stepScreen(-1));
    const label = document.createElement('span');
    const next = btn('▶', () => stepScreen(1));
    el.append(prev, label, next);
    el._update = () => {
      const sc = view.screens;
      el.hidden = !(sc && sc.list.length > 1);
      if (!el.hidden) label.textContent = `${sc.list[sc.active] || 'Screen'} (${sc.active + 1}/${sc.list.length})`;
    };
    el._update();
    return el;
  }
  function updateScreens() { root?.querySelectorAll('.scr-switch').forEach((s) => s._update?.()); }

  function buildTrackpad() {
    const el = document.createElement('div');
    el.className = 'tp';
    const surface = document.createElement('div');
    surface.className = 'tp-surface';
    surface.id = 'tpSurface';
    const direct = cfg.padMode === 'direct';
    surface.innerHTML = direct
      ? 'Direct<br><small>each spot here is the same spot on the PC screen · tap clicks · hold right-clicks · drag drags · 2 fingers scroll</small>'
      : 'Trackpad<br><small>1 finger moves · tap clicks · 2 fingers scroll · 2-finger tap right-clicks · tap then drag to drag · Apple Pencil points directly</small>';
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
    const mode = btn(direct ? '🎯 Direct' : '🖱 Trackpad', () => { cfg.padMode = direct ? 'trackpad' : 'direct'; save(); render(); });
    mode.className = 'tp-mode';
    mode.id = 'tpMode';
    btns.append(mode);
    if (direct) btns.append(screenSwitch('scr-switch tp-switch'));
    el.append(surface, btns);
    bindSurface(surface, { direct: () => cfg.padMode === 'direct', rect: () => surface.getBoundingClientRect() });
    return el;
  }

  // Touch & pen on a surface. Pencil: always absolute. Fingers: relative
  // (trackpad) or absolute (direct: that spot on the surface = that spot on the screen).
  function bindSurface(s, { direct, rect }) {
    const pen = new PenInput({
      send,
      toNorm: (x, y) => norm(rect(), x, y),
      snap: () => cfg.snap,
      mouse: () => cfg.penMouse,
    });
    pens.add(pen);
    const pts = new Map();
    let g = null;
    let lastTapAt = -Infinity; // timestamps start at page load, so 0 would look like a recent tap
    const acc = { x: 0, y: 0 };
    let raf = 0;
    let pmPending = null;
    const flush = () => {
      raf = 0;
      const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y);
      if (dx || dy) { acc.x -= dx; acc.y -= dy; send({ t: 'mm', dx, dy, all: 1 }); }
      if (pmPending) { send({ t: 'pm', x: r5(pmPending.x), y: r5(pmPending.y) }); pmPending = null; }
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };
    const mid = () => {
      const [a, b] = [...pts.values()];
      return norm(rect(), (a.x + b.x) / 2, (a.y + b.y) / 2);
    };
    // Centre and spread (average distance from the centre) of the fingers down.
    const shape = () => {
      const all = [...pts.values()];
      const cx = all.reduce((t, q) => t + q.x, 0) / all.length, cy = all.reduce((t, q) => t + q.y, 0) / all.length;
      return { cx, cy, spread: all.reduce((t, q) => t + Math.hypot(q.x - cx, q.y - cy), 0) / all.length, dist: all.length === 2 ? Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y) : 0 };
    };
    let lastTwoTap = -Infinity;
    let rightTimer = 0;
    let smartZoomed = false;
    const scroller = makeScroller(() => (direct() && pts.size >= 2 ? mid() : null));
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(s, e);
      if (e.pointerType === 'pen') return pen.down(e);
      if (penBusy()) return; // palm resting while using the Pencil
      scroller.stop();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (pts.size === 1) {
        const p = norm(rect(), e.clientX, e.clientY);
        g = { kind: 'one', start: e.timeStamp, sx: e.clientX, sy: e.clientY, p, moved: 0, dragArm: e.timeStamp - lastTapAt < 300, dragging: false };
        if (direct()) {
          const me = g;
          g.timer = setTimeout(() => {
            if (g !== me || me.moved > 10) return;
            me.done = true; // held still: right-click there
            send({ t: 'tap', x: r5(me.p.x), y: r5(me.p.y), b: 2 });
            navigator.vibrate?.(15);
          }, 550);
        }
      } else if (pts.size === 2) {
        clearTimeout(g?.timer);
        if (g?.dragging) send(direct() ? { t: 'pu', x: r5(g.last?.x ?? g.p.x), y: r5(g.last?.y ?? g.p.y), b: 0 } : { t: 'pu', b: 0 });
        const sh = shape(), r = rect();
        g = { kind: 'two', start: g?.start ?? e.timeStamp, moved: 0, mode: null, d0: sh.dist, dl: sh.dist, c0: sh, edge: cfg.gestures && r.left + r.width - sh.cx < 40 };
      } else if (g) {
        // Three or more fingers: system gestures (or three-finger drag).
        if (g.dragging) send({ t: 'pu', b: 0 });
        const sh = shape();
        g = { kind: 'many', n: pts.size, start: g.start, moved: 0, c0: sh, c: sh, dragging: false };
      }
    });
    s.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen') return pen.move(e);
      const pt = pts.get(e.pointerId);
      if (!pt || !g) return;
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y, dt = Math.max(1, e.timeStamp - pt.t);
      pt.x = e.clientX; pt.y = e.clientY; pt.t = e.timeStamp;
      g.moved += Math.hypot(dx, dy);
      if (g.kind === 'one' && direct()) {
        const p = norm(rect(), e.clientX, e.clientY);
        g.last = p;
        if (!g.dragging && !g.done && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 10) {
          clearTimeout(g.timer);
          g.dragging = true;
          send({ t: 'pm', x: r5(g.p.x), y: r5(g.p.y) });
          send({ t: 'pd', x: r5(g.p.x), y: r5(g.p.y), b: 0 });
        }
        if (g.dragging) { pmPending = p; queue(); }
      } else if (g.kind === 'one') {
        if (g.dragArm && !g.dragging && g.moved > 6) { g.dragging = true; send({ t: 'pd', b: 0 }); }
        // Pointer acceleration: slow moves are precise, fast moves cover the screen.
        const v = Math.hypot(dx, dy) / dt;
        const gain = cfg.speed * (1.4 + Math.min(v, 2.5) * 1.6);
        acc.x += dx * gain;
        acc.y += dy * gain;
        queue();
      } else if (g.kind === 'two' && pts.size === 2) {
        const sh = shape();
        if (!g.mode) {
          const pan = Math.hypot(sh.cx - g.c0.cx, sh.cy - g.c0.cy);
          if (cfg.gestures && Math.abs(sh.dist - g.d0) > 30 && Math.abs(sh.dist - g.d0) > pan) g.mode = 'zoom';
          else if (g.edge && pan > 40) g.mode = sh.cx - g.c0.cx < -30 && Math.abs(sh.cy - g.c0.cy) < 40 ? 'edge' : 'scroll';
          else if (!g.edge && pan > 10) g.mode = 'scroll';
        }
        if (g.mode === 'scroll') scroller.move(dx / 2, dy / 2, e.timeStamp); // each finger reports the move
        else if (g.mode === 'zoom') {
          while (Math.abs(sh.dist - g.dl) >= 45) {
            const dir = Math.sign(sh.dist - g.dl);
            g.dl += 45 * dir;
            zoomStep(dir, direct() ? mid() : null);
          }
        }
      } else if (g.kind === 'many') {
        if (pts.size > g.n) { g.n = pts.size; g.c0 = g.c = shape(); return; }
        if (pts.size !== g.n) return; // a finger is lifting
        const sh = shape();
        if (cfg.threeDrag && g.n === 3) {
          if (!g.dragging && Math.hypot(sh.cx - g.c0.cx, sh.cy - g.c0.cy) > 6) { g.dragging = true; send({ t: 'pd', b: 0 }); }
          if (g.dragging) {
            acc.x += (sh.cx - g.c.cx) * cfg.speed * 1.8;
            acc.y += (sh.cy - g.c.cy) * cfg.speed * 1.8;
            queue();
          }
        }
        g.c = sh;
      }
    });
    const end = (e) => {
      if (e.pointerType === 'pen') return pen.up(e, e.type === 'pointercancel');
      if (!pts.delete(e.pointerId) || !g) return;
      if (pts.size) return;
      clearTimeout(g.timer);
      const dur = e.timeStamp - g.start;
      if (g.kind === 'one' && direct()) {
        if (g.dragging) {
          flush();
          const p = g.last || g.p;
          send({ t: 'pu', x: r5(p.x), y: r5(p.y), b: 0 });
        } else if (!g.done && e.type !== 'pointercancel') {
          send({ t: 'tap', x: r5(g.p.x), y: r5(g.p.y), b: 0, ...(cfg.snap ? { snap: 1 } : {}) });
        }
      } else if (g.kind === 'one') {
        if (g.dragging) send({ t: 'pu', b: 0 });
        else if (dur < 230 && g.moved < 10) {
          send({ t: 'pd', b: 0 });
          send({ t: 'pu', b: 0 });
          lastTapAt = e.timeStamp;
        }
      } else if (g.kind === 'two') {
        if (dur < 280 && g.moved < 16) {
          const p = direct() ? norm(rect(), e.clientX, e.clientY) : null;
          const rightClick = () => {
            send(p ? { t: 'tap', x: r5(p.x), y: r5(p.y), b: 2 } : { t: 'pd', b: 2 });
            if (!p) send({ t: 'pu', b: 2 });
          };
          if (!cfg.gestures) rightClick();
          else if (e.timeStamp - lastTwoTap < 350) {
            // Two-finger double tap: smart zoom (in, then back to normal).
            clearTimeout(rightTimer);
            lastTwoTap = -Infinity;
            if (smartZoomed) sysGesture('zoomReset');
            else { zoomStep(1, p); zoomStep(1, p); }
            smartZoomed = !smartZoomed;
          } else {
            lastTwoTap = e.timeStamp;
            rightTimer = setTimeout(rightClick, 300); // unless a second tap makes it smart zoom
          }
        } else if (g.mode === 'edge') sysGesture('notifications');
        else if (g.mode === 'scroll') scroller.end(e.timeStamp);
      } else if (g.kind === 'many') {
        if (g.dragging) { flush(); send({ t: 'pu', b: 0 }); }
        else if (cfg.gestures) {
          const dx = g.c.cx - g.c0.cx, dy = g.c.cy - g.c0.cy, ratio = g.c.spread / Math.max(1, g.c0.spread);
          if (g.n >= 4 && ratio < 0.65) sysGesture('launcher');
          else if (g.n >= 4 && ratio > 1.5) sysGesture('desktop');
          else if (Math.hypot(dx, dy) > 70) {
            if (Math.abs(dy) > Math.abs(dx)) sysGesture(dy < 0 ? 'overview' : 'appWindows');
            else sysGesture(dx < 0 ? 'deskNext' : 'deskPrev');
          } else if (g.n === 3 && dur < 300 && g.moved < 30) {
            if (!sysGesture('lookUp')) { send({ t: 'pd', b: 1 }); send({ t: 'pu', b: 1 }); } // middle click
          }
        }
      }
      g = null;
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('pointerleave', (e) => e.pointerType === 'pen' && pen.leave(e));
    s.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // The PC's live picture: touch it directly (and use the Pencil on it).
  function buildScreen() {
    const el = document.createElement('div');
    el.className = 'scr';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    const msg = document.createElement('div');
    msg.className = 'scr-msg';
    msg.textContent = 'Starting the picture…';
    msg.hidden = !!stream;
    const surf = document.createElement('div');
    surf.className = 'scr-surface';
    surf.id = 'scrSurface';
    el.append(video, msg, surf, screenSwitch('scr-switch scr-bar'));
    video.play?.().catch(() => {});
    // Where the picture is inside the window (letterboxed).
    const rect = () => {
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return r;
      const k = Math.min(r.width / vw, r.height / vh);
      const w = vw * k, h = vh * k;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    };
    bindSurface(surf, { direct: () => true, rect });
    return el;
  }
  function setStream(s) {
    stream = s;
    root?.querySelectorAll('.scr').forEach((el) => {
      const v = el.querySelector('video');
      v.srcObject = s;
      v.play?.().catch(() => {});
      el.querySelector('.scr-msg').hidden = !!s;
    });
  }
  function wantsVideo() { return !!cfg.windows.screen?.show; }
  function syncVideo() {
    const want = wantsVideo();
    if (want === videoWanted) return;
    if (typeof setDeckVideo === 'function' && setDeckVideo(want)) videoWanted = want;
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
    pens.clear();
    root.className = 'deck' + (arranging ? ' arranging' : '');
    const build = { screen: buildScreen, keyboard: buildKeyboard, trackpad: buildTrackpad, hotkeys: buildHotkeys };
    const area = document.createElement('div');
    area.className = 'deck-area';
    const wins = Object.entries(cfg.windows).filter(([id, w]) => w.show && build[id]).sort((a, b) => a[1].z - b[1].z);
    for (const [id, w] of wins) {
      const win = document.createElement('div');
      win.className = 'dwin';
      win.dataset.panel = id;
      place(win, w);
      const body = document.createElement('div');
      body.className = 'dwin-body';
      body.append(build[id]());
      if (arranging) {
        const bar = document.createElement('div');
        bar.className = 'dwin-bar';
        bar.append(Object.assign(document.createElement('b'), { textContent: `⠿ ${PANELS[id]}` }), btn('✕', () => { w.show = false; cfg.preset = ''; save(); render(); }));
        const size = document.createElement('div');
        size.className = 'dwin-size';
        win.append(bar, body, size);
        bindArrange(win, id, bar, size, area);
      } else win.append(body);
      area.append(win);
    }
    if (!wins.length) area.append(Object.assign(document.createElement('p'), { className: 'deck-empty', textContent: 'No windows shown. Tap ⚙ Layout to pick a preset or turn windows on.' }));
    root.replaceChildren(area);
    syncVideo();
  }
  function place(el, w) {
    el.style.left = `${w.x}%`;
    el.style.top = `${w.y}%`;
    el.style.width = `${w.w}%`;
    el.style.height = `${w.h}%`;
    el.style.zIndex = String(w.z || 0);
  }
  // Stage Manager style: drag a window by its bar, resize from the corner.
  // Edges snap to the deck's edges and to other windows' edges.
  function bindArrange(win, id, bar, size, area) {
    const w = cfg.windows[id];
    const front = () => {
      const top = Math.max(0, ...Object.values(cfg.windows).map((x) => x.z || 0));
      if (w.z !== top) { w.z = top + 1; win.style.zIndex = String(w.z); }
    };
    const edges = (axis) => {
      const out = [0, 100];
      for (const [oid, o] of Object.entries(cfg.windows)) {
        if (oid === id || !o.show) continue;
        if (axis === 'x') out.push(o.x, o.x + o.w);
        else out.push(o.y, o.y + o.h);
      }
      return out;
    };
    const snap = (v, cands) => {
      for (const c of cands) if (Math.abs(v - c) < 2) return c;
      return Math.round(v * 2) / 2;
    };
    const drag = (handle, resize) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        capture(handle, e);
        front();
        const r = area.getBoundingClientRect();
        const s0 = { px: e.clientX, py: e.clientY, xp: w.x, yp: w.y, w: w.w, h: w.h };
        const move = (ev) => {
          const dx = ((ev.clientX - s0.px) / r.width) * 100;
          const dy = ((ev.clientY - s0.py) / r.height) * 100;
          if (resize) {
            const right = snap(s0.xp + s0.w + dx, edges('x'));
            const bottom = snap(s0.yp + s0.h + dy, edges('y'));
            w.w = Math.max(14, Math.min(100 - w.x, right - w.x));
            w.h = Math.max(12, Math.min(100 - w.y, bottom - w.y));
          } else {
            const xs = edges('x'), ys = edges('y');
            let x = s0.xp + dx, y = s0.yp + dy;
            const sx = snap(x, xs), sxr = snap(x + w.w, xs) - w.w;
            x = Math.abs(sx - x) <= Math.abs(sxr - x) ? sx : sxr;
            const sy = snap(y, ys), syb = snap(y + w.h, ys) - w.h;
            y = Math.abs(sy - y) <= Math.abs(syb - y) ? sy : syb;
            w.x = Math.max(0, Math.min(100 - w.w, x));
            w.y = Math.max(0, Math.min(100 - w.h, y));
          }
          place(win, w);
        };
        const done = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', done);
          handle.removeEventListener('pointercancel', done);
          cfg.preset = '';
          save();
          render(); // panels re-measure at their new size
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', done);
        handle.addEventListener('pointercancel', done);
      });
    };
    drag(bar, false);
    drag(size, true);
    win.addEventListener('pointerdown', front);
  }
  function toggleArrange(on = !arranging) {
    arranging = on;
    editing = false;
    closeSheet();
    render();
    if (on) toast('Drag a window by its top bar, resize it from the corner. Tap ⤢ again when done.', 5000);
    return arranging;
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

      box.append(h('h4', 'Windows'));
      const wins = document.createElement('div');
      wins.className = 'opts';
      for (const [pid, label] of Object.entries(PANELS)) {
        const w = cfg.windows[pid];
        const b = btn(`${w.show ? '☑' : '☐'} ${label}`, () => {
          w.show = !w.show;
          if (w.show) w.z = Math.max(0, ...Object.values(cfg.windows).map((x) => x.z || 0)) + 1;
          cfg.preset = '';
          save();
          render();
          openSettings();
        }, w.show ? 'on' : '');
        b.dataset.panel = pid;
        wins.append(b);
      }
      box.append(wins);
      const arr = document.createElement('div');
      arr.className = 'opts';
      arr.style.marginTop = '6px';
      arr.append(btn('⤢ Move & resize windows', () => toggleArrange(true)));
      box.append(arr);
      box.append(Object.assign(h('p', 'Windows can overlap; drag them anywhere and resize them from the corner, like Stage Manager. The Screen window shows the PC’s picture so you can touch it directly.'), { className: 'hint' }));

      box.append(h('h4', 'Keyboard size'));
      const sizes = document.createElement('div');
      sizes.className = 'opts';
      for (const [n, label] of [[60, '60%'], [70, '70% (+ arrows)'], [80, '80% (TKL)'], [90, '90% (+ numpad)'], [100, '100% (full)']]) {
        sizes.append(btn(label, () => { cfg.kb = n; save(); render(); openSettings(); }, cfg.kb === n ? 'on' : ''));
      }
      box.append(sizes);
      box.append(Object.assign(h('p', 'On 60% and 70%, Fn + number row gives F1–F12, Fn + I J K L gives arrows, Fn + Esc gives `.'), { className: 'hint' }));

      box.append(h('h4', 'Trackpad'));
      const modes = document.createElement('div');
      modes.className = 'opts';
      for (const [m, label] of [['trackpad', '🖱 Trackpad (moves the pointer)'], ['direct', '🎯 Direct (spot = spot on screen)']]) {
        modes.append(btn(label, () => { cfg.padMode = m; save(); render(); openSettings(); }, cfg.padMode === m ? 'on' : ''));
      }
      box.append(modes);
      const slider = (label, key, min, max, step) => {
        const row = document.createElement('div');
        row.className = 'row';
        const r = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value: cfg[key] });
        r.dataset.key = key;
        r.oninput = () => { cfg[key] = Number(r.value); save(); };
        row.append(h('label', label), r);
        box.append(row);
      };
      slider('Pointer speed', 'speed', 0.3, 3, 0.1);
      slider('Scroll speed', 'scroll', 0.3, 4, 0.1);
      const check = (label, key, after) => {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!cfg[key] });
        cb.style.width = 'auto';
        cb.dataset.key = key;
        cb.onchange = () => { cfg[key] = cb.checked; save(); after?.(); };
        lab.append(cb, ` ${label}`);
        row.append(lab);
        box.append(row);
      };
      check('Natural scrolling (content follows your fingers)', 'natural');
      check('Mac trackpad gestures (pinch, smart zoom, 3–4 finger swipes, …)', 'gestures');
      check('Three-finger drag (move windows with three fingers)', 'threeDrag');
      box.append(Object.assign(h('p', 'Pinch: zoom · two-finger double-tap: smart zoom · 3 or 4 fingers up: Task View / Mission Control · down: show desktop / App Exposé · left/right: switch desktops · pinch thumb and 3 fingers: Start / Launchpad · spread them: show desktop · 3-finger tap: middle click / Look Up · 2 fingers in from the right edge: notifications · hold the space bar and slide: move the pointer.'), { className: 'hint' }));

      box.append(h('h4', 'Apple Pencil & taps'));
      check('Snap taps to the nearest button (Pencil, and fingers in Direct / Screen)', 'snap');
      check('Pencil acts as a plain mouse (no pressure)', 'penMouse');
      box.append(Object.assign(h('p', 'The Pencil always points exactly where you touch: on the Screen window, in Direct mode, and on the trackpad (like a drawing tablet). Pressure and tilt reach drawing apps on Windows. Your palm is ignored while you write. Snapping uses Windows’ accessibility info to find buttons, links and menus near a tap.'), { className: 'hint' }));

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
        arranging = false;
        if (editing && !cfg.windows.hotkeys.show) {
          cfg.windows.hotkeys.show = true;
          cfg.windows.hotkeys.z = Math.max(0, ...Object.values(cfg.windows).map((x) => x.z || 0)) + 1;
          save();
        }
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
    videoWanted = null; // ask the PC again after (re)connecting
    render();
  }
  function hide() {
    closeSheet();
    editing = false;
    arranging = false;
    for (const m of state.latched) up(m);
    for (const m of state.held.keys()) up(m);
    state.latched.clear();
    state.held.clear();
    clearTimeout(state.repeat?.t);
    clearInterval(state.repeat?.i);
    stream = null;
    videoWanted = null;
    pens.clear();
    root?.remove();
    root = null;
  }
  return {
    show, hide, openSettings, parseAction, runAction, applyPreset, toggleArrange, setStream, wantsVideo, updateScreens,
    get config() { return cfg; },
    get arranging() { return arranging; },
  };
})();
