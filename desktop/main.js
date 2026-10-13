// Swipe desktop app: hosts the Swipe web client and adds what browsers can't
// do -- picking a screen without prompts and injecting the remote mouse and
// keyboard input.

'use strict';

const path = require('node:path');
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
const pkg = require('./package.json');

const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');
const ICON = path.join(WEB_ROOT, 'icons', 'icon-512.png');
const DEFAULT_SERVER = process.env.SWIPE_SERVER || pkg.swipeServer || '';
const WAYLAND = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

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
    title: 'Swipe',
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
  win.loadURL('app://swipe/index.html');

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
      { label: 'Open Swipe', click: showWindow },
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

const injector = robot ? new Injector({ robot, getBounds: inputBounds }) : null;

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

ipcMain.on('status', (_e, s) => {
  hostStatus = { ...hostStatus, ...s };
  updateTray();
});

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
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
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
    async (_request, callback) => {
      try {
        const source = await sourceForSelected();
        callback(source ? { video: source } : {});
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

  createTray();
  if (process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden) {
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
