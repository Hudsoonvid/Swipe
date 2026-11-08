// Swipe Host app: shares this PC like Steam Link. It runs swipe.html (or the
// Swipe server's web client when a server is configured) and adds what
// browsers can't do -- capturing every monitor without prompts and injecting
// the remote mouse, keyboard and controller input.

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');
const { pathToFileURL } = require('node:url');
const { Injector } = require('./input');
const fsSync = require('node:fs');
const pkg = require('./package.json');

const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');
const ICON = path.join(WEB_ROOT, 'icons', 'icon-512.png');
const DEFAULT_SERVER = process.env.SWIPE_SERVER || pkg.swipeServer || '';
// Without a Swipe server, the app uses the single-file edition (PeerJS).
const SWIPE_HTML = app.isPackaged ? path.join(WEB_ROOT, 'swipe.html') : path.join(__dirname, '..', 'swipe.html');
const START_PAGE = DEFAULT_SERVER ? 'index.html' : 'swipe.html';
// Optional self-hosted PeerJS server for swipe.html.
const PEER_SERVER = process.env.SWIPE_PEER_HOST
  ? {
      host: process.env.SWIPE_PEER_HOST,
      port: Number(process.env.SWIPE_PEER_PORT) || 443,
      path: process.env.SWIPE_PEER_PATH || '/',
      secure: process.env.SWIPE_PEER_SECURE !== '0',
    }
  : null;
const WAYLAND = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

// Updates: installers are published on GitHub; the app checks for a newer
// one and installs it when no device is connected (Windows and AppImage;
// unsigned Mac apps can't update themselves).
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {}
let updateReady = null; // version downloaded and waiting to install
let installTimer = null;

let robot = null;
let robotError = '';
try {
  robot = require('@jitsi/robotjs');
} catch (e) {
  robotError = e.message;
}

let win = null;
let tray = null;
let quitting = false;
let selectedScreen = null; // display id (string) being shared
let hostStatus = { status: 'offline', viewers: 0 };
let knownViewers = new Set();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- screens ----------

function displays() {
  return screen.getAllDisplays();
}

function listScreens() {
  return displays().map((d, i) => ({
    id: String(d.id),
    name: displays().length > 1 ? `Screen ${i + 1}` : 'Screen',
    width: d.size.width,
    height: d.size.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
}

function selectedDisplay() {
  return displays().find((d) => String(d.id) === String(selectedScreen)) || screen.getPrimaryDisplay();
}

// Bounds of the shared display in the coordinate space robotjs uses.
// Bounds of a display in robotjs's coordinate space.
function robotRect(d) {
  const b = d.bounds;
  if (process.platform === 'win32') return screen.dipToScreenRect(null, b); // physical pixels
  if (process.platform === 'linux') {
    const s = d.scaleFactor || 1;
    return { x: Math.round(b.x * s), y: Math.round(b.y * s), width: Math.round(b.width * s), height: Math.round(b.height * s) };
  }
  return b; // macOS: points
}

// All monitors together (the trackpad mode moves across every screen).
function allInputBounds() {
  const rs = displays().map(robotRect);
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  const r = Math.max(...rs.map((q) => q.x + q.width)), btm = Math.max(...rs.map((q) => q.y + q.height));
  return { x, y, width: r - x, height: btm - y };
}

function inputBounds() {
  const d = selectedDisplay();
  const b = d.bounds;
  if (process.platform === 'win32') return screen.dipToScreenRect(null, b); // physical pixels
  if (process.platform === 'linux') {
    const s = d.scaleFactor || 1;
    return { x: Math.round(b.x * s), y: Math.round(b.y * s), width: Math.round(b.width * s), height: Math.round(b.height * s) };
  }
  return b; // macOS: points
}

async function sourceForSelected() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const d = selectedDisplay();
  return (
    sources.find((s) => s.display_id && s.display_id === String(d.id)) ||
    sources[displays().findIndex((x) => x.id === d.id)] ||
    sources[0]
  );
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b0e14',
    title: 'Swipe Host',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep streaming smoothly while minimized
    },
  });
  win.loadURL(`app://swipe/${START_PAGE}`);

  // Open external links in the real browser; never navigate the app away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://swipe/')) e.preventDefault();
  });

  win.on('close', (e) => {
    // Keep sharing in the background; quit from the tray menu.
    if (!quitting && tray && hostStatus.status !== 'offline') {
      e.preventDefault();
      win.hide();
      if (!app._toldAboutTray) {
        app._toldAboutTray = true;
        notify('Swipe is still running', 'Your devices can still connect. Use the tray icon to quit.');
      }
    }
  });
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function updateTray() {
  if (!tray) return;
  const { status, viewers, code } = hostStatus;
  const sharing = status !== 'offline';
  tray.setToolTip(
    sharing ? `Swipe — code ${code ? code.replace(/(\d{3})(?=\d)/g, '$1 ') : '…'}${viewers ? ` · ${viewers} connected` : ''}` : 'Swipe'
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Swipe Host', click: showWindow },
      { label: `Version ${app.getVersion()}`, enabled: false },
      ...(updateReady ? [{ label: `Restart to update (${updateReady})`, click: installUpdate }] : []),
      { type: 'separator' },
      sharing
        ? { label: 'Stop sharing', click: () => win?.webContents.send('command', 'stop-sharing') }
        : { label: 'Start sharing', click: () => win?.webContents.send('command', 'start-sharing') },
      {
        label: 'Start Swipe when I log in',
        type: 'checkbox',
        visible: process.platform !== 'linux',
        checked: process.platform !== 'linux' && app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
      },
      { type: 'separator' },
      {
        label: 'Quit Swipe',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: process.platform === 'darwin' ? 18 : 24 });
    tray = new Tray(img);
    tray.on('click', showWindow);
    updateTray();
  } catch {
    tray = null; // some Linux desktops have no tray
  }
}

// ---------- IPC ----------

const injector = robot ? new Injector({ robot, getBounds: inputBounds, getAllBounds: allInputBounds }) : null;

function canControl() {
  if (!injector) return false;
  if (process.platform === 'darwin') return systemPreferences.isTrustedAccessibilityClient(false);
  return true;
}

function controlWarning() {
  if (!robot) return `Remote control is unavailable: ${robotError}`;
  if (WAYLAND) return 'Remote control may not work on Wayland. Log in with an "X11"/"Xorg" session for full control.';
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    return 'To allow remote control, enable Swipe in System Settings → Privacy & Security → Accessibility, then restart Swipe.';
  }
  return '';
}

ipcMain.on('info', (e) => {
  e.returnValue = {
    platform: process.platform,
    hostname: os.hostname().replace(/\.local$/, ''),
    defaultServer: DEFAULT_SERVER,
    peerServer: PEER_SERVER,
    canControl: canControl(),
    warning: controlWarning(),
    version: app.getVersion(),
  };
});

ipcMain.handle('screens', () => listScreens());

ipcMain.handle('select-screen', (_e, id) => {
  if (id !== null && id !== undefined && displays().some((d) => String(d.id) === String(id))) selectedScreen = String(id);
  else selectedScreen = String(screen.getPrimaryDisplay().id);
  return selectedScreen;
});

ipcMain.on('input', (_e, evt) => {
  if (injector && hostStatus.status !== 'offline') injector.handle(evt);
});

ipcMain.on('release-input', () => injector?.releaseAll());

// A device is asking to connect: bring the window up so someone can answer.
ipcMain.on('attention', (_e, msg) => {
  showWindow();
  win?.flashFrame(true);
  notify('Swipe', String(msg || 'A device wants to connect').slice(0, 200));
});

ipcMain.on('status', (_e, s) => {
  hostStatus = { ...hostStatus, ...s };
  updateTray();
  scheduleInstall();
});

// ---------- updates ----------

const START_HIDDEN_ONCE = () => path.join(app.getPath('userData'), 'start-hidden-once');

function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  if (process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE)) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = null;
  autoUpdater.on('error', () => {}); // offline etc.: try again later
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTray();
    scheduleInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 20_000);
  setInterval(check, 3 * 3600_000);
}

// Install once nobody has been connected for a minute, then come back in the tray.
function scheduleInstall() {
  clearTimeout(installTimer);
  if (!updateReady || hostStatus.viewers > 0) return;
  installTimer = setTimeout(installUpdate, 60_000);
}

function installUpdate() {
  if (!updateReady || hostStatus.viewers > 0) return;
  try {
    fsSync.writeFileSync(START_HIDDEN_ONCE(), '1');
  } catch {}
  quitting = true;
  injector?.releaseAll();
  autoUpdater.quitAndInstall(true, true);
}

ipcMain.on('viewers', (_e, names) => {
  // Tell the user whenever a new device starts watching.
  const current = new Set(names);
  for (const n of current) if (!knownViewers.has(n)) notify('Device connected', `${n} can now see this screen.`);
  knownViewers = current;
});

// ---------- startup ----------

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || START_PAGE;
    if (rel === 'swipe.html') {
      // Single file with inline scripts and styles; PeerJS comes bundled.
      return new Response(await fs.readFile(SWIPE_HTML), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss: http: ws:; frame-ancestors 'none'",
        },
      });
    }
    if (rel === 'peerjs.min.js') {
      return new Response(await fs.readFile(require.resolve('peerjs/dist/peerjs.min.js')), { headers: { 'Content-Type': 'text/javascript' } });
    }
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.html')) {
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss: http: ws:; frame-ancestors 'none'"
      );
    }
    if (file.endsWith('.mjs') || file.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
    return new Response(res.body, { status: res.status, headers });
  });

  // Screen capture without the browser's picker: the viewer chooses the
  // display from its toolbar, the app selects it here.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const source = await sourceForSelected();
        // Windows can also capture what the PC is playing.
        const audio = request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {};
        callback(source ? { video: source, ...audio } : {});
      } catch (e) {
        console.error('capture failed', e);
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'keyboardLock', 'wake-lock'].includes(permission));
  });

  if (process.platform === 'darwin' && robot && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS permission prompt
  }

  screen.on('display-added', () => {
    robot?.updateScreenMetrics?.();
    win?.webContents.send('screens-changed');
  });
  screen.on('display-removed', () => {
    robot?.updateScreenMetrics?.();
    win?.webContents.send('screens-changed');
  });
  screen.on('display-metrics-changed', () => robot?.updateScreenMetrics?.());

  // Like Steam Link: the PC should be reachable after a restart, so start
  // with the computer by default (once; the tray menu can turn it off).
  const firstRun = path.join(app.getPath('userData'), 'first-run-done');
  if (process.platform !== 'linux' && app.isPackaged && !require('node:fs').existsSync(firstRun)) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
    require('node:fs').writeFileSync(firstRun, '1');
  }

  createTray();
  let hiddenAfterUpdate = false;
  try {
    hiddenAfterUpdate = fsSync.existsSync(START_HIDDEN_ONCE());
    if (hiddenAfterUpdate) fsSync.unlinkSync(START_HIDDEN_ONCE());
  } catch {}
  setupUpdates();
  if (hiddenAfterUpdate || process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden) {
    createWindow();
    win.hide();
  } else {
    createWindow();
  }
});

app.on('activate', showWindow);

app.on('before-quit', () => {
  quitting = true;
  injector?.releaseAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
});
