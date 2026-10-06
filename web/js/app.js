import { generatePassword, formatPassword, formatCode, normalizeCode, normalizePassword } from './crypto.js';
import { native, env, settings, deviceKey, storedPassword, recents, platformName, platformLabel } from './config.js';
import { HostSession } from './host.js';
import { ViewerSession } from './viewer.js';
import { InputController } from './input.js';
import qrcode from '../vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);
const RELEASES_URL = 'https://github.com/Hudsoonvid/Swipe/releases';

// ---------- icons ----------

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  end: '<path d="M18 6 6 18M6 6l12 12"/>',
  keyboard: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 15h6"/>',
  keys: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  touch: '<path d="M9 11V5a2 2 0 0 1 4 0v6M13 10a2 2 0 0 1 4 0v2M17 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.4-2.6L3.3 16a2 2 0 0 1 3.2-2.4L9 16"/>',
  trackpad: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 15h18M12 15v5"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  unfull: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  stats: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  home: '<circle cx="12" cy="12" r="7"/>',
  recents: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

// ---------- small UI helpers ----------

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast(text);
  }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not allowed right now */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (host || viewer)) keepAwake(true);
});

function serverOrError() {
  const s = settings.server();
  if (!s) throw new Error('Set the server address in Settings first.');
  return s;
}

$('serverLabel').textContent = settings.server() ? `Server: ${settings.server().replace(/^https?:\/\//, '')}` : '';

// ---------- connect form ----------

const codeInput = $('codeInput');
const pwInput = $('pwInput');

codeInput.addEventListener('input', () => {
  const digits = normalizeCode(codeInput.value).slice(0, 9);
  const formatted = formatCode(digits);
  if (codeInput.value !== formatted) codeInput.value = formatted;
  if (digits.length === 9 && document.activeElement === codeInput) pwInput.focus();
});

$('connectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  connect(codeInput.value, pwInput.value, $('rememberPw').checked);
});

function renderRecents() {
  const list = recents.list();
  $('recentWrap').hidden = !list.length;
  const ul = $('recentList');
  ul.replaceChildren();
  for (const r of list) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'r-main';
    const name = document.createElement('div');
    name.className = 'r-name';
    name.textContent = r.name || platformLabel(r.platform);
    const code = document.createElement('div');
    code.className = 'r-code mono';
    code.textContent = formatCode(r.code) + (r.password ? ' · password saved' : '');
    main.append(name, code);
    const x = document.createElement('button');
    x.className = 'r-x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Forget');
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      recents.remove(r.code);
      renderRecents();
    });
    li.append(main, x);
    li.addEventListener('click', () => {
      codeInput.value = formatCode(r.code);
      if (r.password) {
        pwInput.value = r.password;
        $('rememberPw').checked = true;
        connect(r.code, r.password, true);
      } else pwInput.focus();
    });
    ul.append(li);
  }
}

// ---------- viewing a remote device ----------

let viewer = null;
let input = null;
let statsTimer = null;

async function connect(code, password, remember) {
  const err = $('connectError');
  showError(err, '');
  if (normalizeCode(code).length !== 9) return showError(err, 'Enter the 9-digit code from the other device.');
  if (!normalizePassword(password)) return showError(err, 'Enter the password from the other device.');
  if (viewer) return;
  let server;
  try {
    server = serverOrError();
  } catch (e) {
    return showError(err, e.message);
  }

  const session = new ViewerSession({ server, code, password, name: settings.deviceName(), platform: platformName() });
  viewer = session;
  enterSession(session);
  setOverlay('Connecting…');

  session.addEventListener('joined', (e) => setOverlay(`Connecting to ${e.detail.name}…`));
  session.addEventListener('track', () => {
    const video = $('remoteVideo');
    if (video.srcObject !== session.stream) video.srcObject = session.stream;
    video.play().catch(() => {});
    updateToolbar();
  });
  session.addEventListener('info', () => {
    updateToolbar();
    input?.view.layout();
  });
  session.addEventListener('state', (e) => {
    const { state, message } = e.detail;
    if (state === 'connected') setOverlay(null);
    else if (state === 'reconnecting') setOverlay('Reconnecting…');
    else if (state === 'closed' && viewer === session && session._connected) {
      leaveSession();
      if (message) showError(err, message);
    }
  });

  try {
    await session.connect();
    session._connected = true;
    keepAwake(true);
    recents.add({
      code: normalizeCode(code),
      name: session.hostInfo?.name,
      platform: session.hostInfo?.platform,
      password: remember ? password : undefined,
    });
    if (!remember) pwInput.value = '';
    renderRecents();
  } catch (e) {
    if (viewer === session) {
      session.close('error');
      leaveSession();
      showError(err, e.message || 'Could not connect.');
    }
  }
}

function enterSession(session) {
  document.body.classList.add('in-session');
  $('home').hidden = true;
  $('session').hidden = false;
  $('keysPanel').hidden = true;
  const video = $('remoteVideo');
  video.muted = true;
  input = new InputController({
    stage: $('stage'),
    video,
    session,
    cursor: $('cursor'),
    textInput: $('kbInput'),
    getTouchMode: () => settings.get('touchMode'),
    viewerPlatform: platformName(),
  });
  input.onstickychange = renderKeysPanel;
  input.view.layout();
  updateToolbar();
  if (settings.get('showStats')) startStats();
}

function leaveSession() {
  input?.destroy();
  input = null;
  const s = viewer;
  viewer = null;
  s?.close();
  stopStats();
  keepAwake(!!host);
  const video = $('remoteVideo');
  video.srcObject = null;
  $('session').hidden = true;
  $('home').hidden = false;
  document.body.classList.remove('in-session');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function setOverlay(text) {
  $('overlay').hidden = !text;
  if (text) $('overlayText').textContent = text;
}

$('overlayCancel').addEventListener('click', () => leaveSession());

// ---------- session toolbar ----------

function tbButton(name, label, onClick, { cls = '', on = false, text } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tb-btn ${cls} ${on ? 'on' : ''}`;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = text ? '' : icon(name);
  if (text) b.textContent = text;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'tb-sep';
  return s;
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function toggleFullscreen() {
  const el = document.documentElement;
  try {
    if (isFullscreen()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else {
      await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      // Capture Esc, Alt+Tab, etc. where supported (Chrome/Edge).
      navigator.keyboard?.lock?.().catch(() => {});
    }
  } catch {
    toast('Full screen is not available here');
  }
  setTimeout(() => {
    input?.view.layout();
    updateToolbar();
  }, 250);
}

function updateToolbar() {
  const bar = $('tbMain');
  if (!viewer) return;
  const control = viewer.control;
  const info = viewer.info;
  const items = [];
  items.push(tbButton('end', 'Disconnect', () => leaveSession(), { cls: 'end' }));
  if (control !== 'none') {
    items.push(
      tbButton('keyboard', 'Keyboard', () => {
        const ta = $('kbInput');
        if (document.activeElement === ta) ta.blur();
        else ta.focus();
      })
    );
    items.push(
      tbButton('keys', 'Special keys', (b) => {
        $('keysPanel').hidden = !$('keysPanel').hidden;
        b.classList.toggle('on', !$('keysPanel').hidden);
        renderKeysPanel();
      }, { on: !$('keysPanel').hidden })
    );
  }
  if (control === 'desktop' && env.isTouch) {
    const trackpad = settings.get('touchMode') === 'trackpad';
    items.push(
      tbButton(trackpad ? 'trackpad' : 'touch', trackpad ? 'Trackpad mode (tap to switch to direct touch)' : 'Direct touch (tap to switch to trackpad)', () => {
        settings.set('touchMode', trackpad ? 'direct' : 'trackpad');
        input?.showCursor(!trackpad);
        toast(trackpad ? 'Direct touch: tap where you want to click' : 'Trackpad: drag to move the pointer, tap to click');
        updateToolbar();
      })
    );
    input?.showCursor(trackpad);
  } else input?.showCursor(false);
  if (control === 'touch') {
    items.push(sep());
    items.push(tbButton('back', 'Back', () => viewer.send({ t: 'nav', a: 'back' })));
    items.push(tbButton('home', 'Home', () => viewer.send({ t: 'nav', a: 'home' })));
    items.push(tbButton('recents', 'Recent apps', () => viewer.send({ t: 'nav', a: 'recents' })));
  }
  if (info?.screens?.length > 1) {
    items.push(sep());
    info.screens.forEach((s, i) =>
      items.push(
        tbButton('screen', `Show ${s.name}`, () => viewer.send({ t: 'screen', id: s.id }), {
          text: `${i + 1}`,
          on: s.id === info.screen,
        })
      )
    );
  }
  items.push(sep());
  if (input?.view.zoomed) items.push(tbButton('zoomout', 'Reset zoom', () => (input.view.reset(), updateToolbar())));
  if (viewer.stream.getAudioTracks().length) {
    const video = $('remoteVideo');
    items.push(
      tbButton(video.muted ? 'mute' : 'sound', video.muted ? 'Unmute' : 'Mute', () => {
        video.muted = !video.muted;
        updateToolbar();
      })
    );
  }
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    items.push(tbButton(isFullscreen() ? 'unfull' : 'full', 'Full screen', toggleFullscreen));
  }
  items.push(
    tbButton('stats', 'Connection stats', () => {
      if (statsTimer) stopStats();
      else startStats();
      updateToolbar();
    }, { on: !!statsTimer })
  );
  bar.replaceChildren(...items);
}

$('tbHandle').addEventListener('click', () => $('toolbar').classList.toggle('collapsed'));
document.addEventListener('fullscreenchange', () => setTimeout(() => (input?.view.layout(), updateToolbar()), 100));

const KEYS = [
  ['Esc', 'Escape', 'Escape'],
  ['Tab', 'Tab', 'Tab'],
  ['Ctrl', 'ControlLeft', 'Control', true],
  ['Alt', 'AltLeft', 'Alt', true],
  ['Shift', 'ShiftLeft', 'Shift', true],
  ['⌘/Win', 'MetaLeft', 'Meta', true],
  ['←', 'ArrowLeft', 'ArrowLeft'],
  ['↑', 'ArrowUp', 'ArrowUp'],
  ['↓', 'ArrowDown', 'ArrowDown'],
  ['→', 'ArrowRight', 'ArrowRight'],
  ['Del', 'Delete', 'Delete'],
  ['⌫', 'Backspace', 'Backspace'],
  ['Enter', 'Enter', 'Enter'],
  ['Home', 'Home', 'Home'],
  ['End', 'End', 'End'],
  ['PgUp', 'PageUp', 'PageUp'],
  ['PgDn', 'PageDown', 'PageDown'],
  ['F5', 'F5', 'F5'],
  ['Paste text', 'paste'],
];

function renderKeysPanel() {
  const panel = $('keysPanel');
  if (panel.hidden || !input) return;
  panel.replaceChildren(
    ...KEYS.map(([label, code, key, sticky]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key' + (sticky && input.sticky.has(code) ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (code === 'paste') {
          let text = '';
          try {
            text = await navigator.clipboard.readText();
          } catch {
            text = prompt('Text to type on the other device:') || '';
          }
          input.text(text);
        } else if (sticky) {
          if (input.sticky.has(code)) input.sticky.delete(code);
          else input.sticky.add(code);
          renderKeysPanel();
        } else {
          input.tap(code, key);
        }
      });
      return b;
    })
  );
}

function startStats() {
  const box = $('statsBox');
  box.hidden = false;
  box.textContent = '…';
  const tick = async () => {
    if (!viewer) return;
    const s = await viewer.stats();
    const parts = [];
    if (s.rttMs !== undefined) parts.push(`RTT ${s.rttMs} ms`);
    if (s.fps !== undefined) parts.push(`${s.fps} fps`);
    if (s.kbps !== undefined) parts.push(`${(s.kbps / 1000).toFixed(1)} Mbps`);
    if (s.width) parts.push(`${s.width}×${s.height}`);
    if (s.codec) parts.push(s.codec);
    if (s.bufferMs !== undefined) parts.push(`buffer ${s.bufferMs} ms`);
    if (s.relayed !== undefined) parts.push(s.relayed ? 'relayed' : 'direct');
    box.textContent = parts.join(' · ') || '…';
  };
  tick();
  statsTimer = setInterval(tick, 1000);
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  $('statsBox').hidden = true;
}

// ---------- sharing this device ----------

let host = null;
let password = null;
let screenId = null;

function captureConstraints() {
  const maxRes = Number(settings.get('maxRes'));
  const fps = settings.get('quality') === 'text' ? 30 : 60;
  const video = { frameRate: { ideal: fps, max: fps }, cursor: 'always' };
  if (maxRes) {
    video.height = { max: maxRes };
    video.width = { max: Math.round((maxRes * 16) / 9) };
  }
  return video;
}

async function captureScreen() {
  if (native) await native.selectScreen(screenId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: captureConstraints(),
    audio: !native,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
  });
  const track = stream.getVideoTracks()[0];
  if (track) track.contentHint = settings.get('quality') === 'motion' ? 'motion' : 'detail';
  return stream;
}

function setupShareCard() {
  const hint = $('shareHint');
  const btn = $('shareBtn');
  if (native) {
    hint.textContent = 'Let your other devices see and control this computer.';
    $('controlRow').hidden = false;
  } else if (env.canCaptureScreen) {
    hint.textContent =
      'Show this screen on another device. In a browser others can only watch; install the Swipe desktop app to let them control this computer too.';
    $('controlRow').hidden = true;
  } else {
    hint.innerHTML = '';
    const what = env.isIOS ? (env.isIPad ? 'iPad' : 'iPhone') : env.isAndroid ? 'phone or tablet' : 'device';
    hint.append(
      `Browsers can't share the screen of this ${what}. Install the Swipe app to share it. `,
      Object.assign(document.createElement('a'), { href: RELEASES_URL, textContent: 'Get the app', target: '_blank', rel: 'noopener' }),
      document.createElement('br'),
      document.createElement('br'),
      'You can still use this page to connect to and control your other devices.'
    );
    btn.hidden = true;
  }
}

function setPassword(pw) {
  password = normalizePassword(pw);
  storedPassword.set(password);
  host?.setPassword(password);
  $('myPw').textContent = formatPassword(password);
  renderQr();
}

function renderQr() {
  const box = $('qr');
  if (!host?.code || !password) return box.replaceChildren();
  const link = `${settings.server()}/#c=${host.code}&p=${encodeURIComponent(password)}`;
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function renderShareStatus() {
  const st = $('shareStatus');
  const viewers = host ? host.viewerList() : [];
  let text = '';
  let state = host?.status || 'offline';
  if (state === 'connecting') text = 'Connecting to the server…';
  else if (state === 'reconnecting') text = 'Reconnecting to the server…';
  else if (state === 'replaced') text = 'Sharing moved to another window.';
  else if (viewers.length) {
    state = 'live';
    text = `${viewers.length} device${viewers.length > 1 ? 's' : ''} connected`;
  } else if (state === 'online') text = 'Waiting for a device to connect';
  st.textContent = text;
  st.dataset.state = state;
  const ul = $('viewerList');
  ul.replaceChildren(
    ...viewers.map((v) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${v.name}${v.state === 'connected' ? '' : ` (${v.state})`}`;
      const kick = document.createElement('button');
      kick.className = 'chip';
      kick.type = 'button';
      kick.textContent = 'Disconnect';
      kick.addEventListener('click', () => host?.kick(v.sid));
      li.append(name, kick);
      return li;
    })
  );
  if (native) native.setStatus?.({ status: state, viewers: viewers.length, code: host?.code });
}

async function startSharing({ auto = false } = {}) {
  if (host) return;
  let server;
  try {
    server = serverOrError();
  } catch (e) {
    if (!auto) toast(e.message);
    return;
  }
  let stream = null;
  if (!native) {
    // Browsers require the capture prompt to come from a click.
    try {
      stream = await captureScreen();
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast(`Could not capture the screen: ${e.message}`);
      return;
    }
  }

  const keep = settings.get('keepPassword');
  const pw = (keep && storedPassword.get()) || generatePassword();
  if (native) screenId = (await native.getScreens())[0]?.id ?? null;

  host = new HostSession({
    server,
    deviceKey: deviceKey(),
    name: settings.deviceName(),
    platform: platformName(),
    password: normalizePassword(pw),
    control: native?.canControl ? 'desktop' : 'none',
    quality: settings.get('quality'),
    codec: settings.get('codec'),
    acquireStream: async () => {
      if (stream && stream.getVideoTracks()[0]?.readyState === 'live') return stream;
      stream = await captureScreen();
      return stream;
    },
    // In the app, stop capturing while nobody watches (it can restart silently).
    releaseStream: native
      ? (s) => {
          for (const t of s.getTracks()) t.stop();
          stream = null;
        }
      : undefined,
    onInput: (evt) => native?.input(evt),
    screens: () => (native ? native.cachedScreens() : []),
    screenId: () => screenId,
  });
  setPassword(pw);
  host.setControlAllowed(settings.get('allowControl'));
  $('allowControl').checked = settings.get('allowControl');
  host.addEventListener('status', () => {
    $('myCode').textContent = host?.code ? formatCode(host.code) : '··· ··· ···';
    renderQr();
    renderShareStatus();
  });
  let viewerCount = 0;
  host.addEventListener('viewers', (e) => {
    renderShareStatus();
    if (native) {
      native.notifyViewers?.(e.detail.map((v) => v.name));
      // Let go of any keys/buttons a departing viewer was holding.
      if (e.detail.length < viewerCount) native.releaseInput?.();
    }
    viewerCount = e.detail.length;
  });
  host.addEventListener('authfail', () => toast('Someone tried to connect with a wrong password'));
  host.addEventListener('streamended', () => {
    // The user pressed the browser's "Stop sharing" button.
    if (!native) stopSharing();
  });
  host.addEventListener('screenrequest', async (e) => {
    if (!native || e.detail === screenId) return;
    screenId = e.detail;
    try {
      if (host.stream) await host.replaceStream(await captureScreen());
      else host.broadcastInfo();
    } catch (err) {
      console.warn('screen switch failed', err);
    }
  });

  $('shareIdle').hidden = true;
  $('shareActive').hidden = false;
  keepAwake(true);
  try {
    await host.start();
  } catch (e) {
    toast(e.message);
    // keep trying in the background
    host._onSignalClose(host.sig);
  }
}

function stopSharing() {
  host?.stop();
  host = null;
  $('shareIdle').hidden = false;
  $('shareActive').hidden = true;
  keepAwake(!!viewer);
  renderShareStatus();
}

$('shareBtn').addEventListener('click', () => startSharing());
$('stopShareBtn').addEventListener('click', () => stopSharing());
$('copyCodeBtn').addEventListener('click', () => host?.code && copy(formatCode(host.code)));
$('newPwBtn').addEventListener('click', () => {
  setPassword(generatePassword());
  toast('New password set. Devices already connected stay connected.');
});
$('allowControl').addEventListener('change', (e) => {
  settings.set('allowControl', e.target.checked);
  host?.setControlAllowed(e.target.checked);
});

$('setPwBtn').addEventListener('click', () => {
  $('pwNew').value = '';
  showError($('pwError'), '');
  $('pwDialog').showModal();
});
$('pwForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const pw = normalizePassword($('pwNew').value);
  if (pw.length < 4) {
    e.preventDefault();
    showError($('pwError'), 'Use at least 4 characters.');
    return;
  }
  setPassword(pw);
  if (pw.length < 8) toast('Tip: longer passwords are safer for access over the internet', 4000);
});

// ---------- settings ----------

$('settingsBtn').addEventListener('click', () => {
  $('setName').value = settings.deviceName();
  $('setServer').value = settings.get('server');
  $('setServer').placeholder = settings.server() || 'https://swipe.example.com';
  $('setQuality').value = settings.get('quality');
  $('setMaxRes').value = String(settings.get('maxRes'));
  $('setCodec').value = settings.get('codec');
  $('setKeepPw').checked = settings.get('keepPassword');
  $('setStats').checked = settings.get('showStats');
  $('settingsDialog').showModal();
});

$('settingsForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const server = $('setServer').value.trim().replace(/\/+$/, '');
  if (server && !/^https?:\/\/[^\s]+$/.test(server)) {
    e.preventDefault();
    toast('The server address must start with https://');
    return;
  }
  settings.set('deviceName', $('setName').value.trim());
  settings.set('server', server);
  settings.set('quality', $('setQuality').value);
  settings.set('maxRes', Number($('setMaxRes').value));
  settings.set('codec', $('setCodec').value);
  settings.set('keepPassword', $('setKeepPw').checked);
  settings.set('showStats', $('setStats').checked);
  $('serverLabel').textContent = settings.server() ? `Server: ${settings.server().replace(/^https?:\/\//, '')}` : '';
  if (host) toast('Some changes apply the next time you start sharing');
  // The desktop app shares automatically once it knows its server.
  else if (native && settings.server()) startSharing({ auto: true });
});

// ---------- start-up ----------

setupShareCard();
renderRecents();

// Links like https://server/#c=123456789&p=ABCD2345 (from the QR code).
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('c')) {
  codeInput.value = formatCode(hash.get('c'));
  if (hash.get('p')) pwInput.value = hash.get('p');
  history.replaceState(null, '', location.pathname + location.search);
  if (hash.get('p')) connect(hash.get('c'), hash.get('p'), false);
}

if (native) {
  native.onCommand?.((cmd) => {
    if (cmd === 'start-sharing') startSharing();
    if (cmd === 'stop-sharing') stopSharing();
  });
  if (!settings.server()) toast('Open Settings (gear icon) and enter your Swipe server address', 6000);
  else if (native.warning) toast(native.warning, 9000);
  if (settings.get('autoShare') ?? true) startSharing({ auto: true });
} else if (!settings.server()) {
  toast('Open Settings (gear icon) and enter your Swipe server address', 6000);
}

// Expose for automated tests.
globalThis.__swipe = { get host() { return host; }, get viewer() { return viewer; }, connect, startSharing, stopSharing };
