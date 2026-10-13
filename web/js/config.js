// Settings, device identity and environment detection.

import { bytesToBase64, randomBytes } from './crypto.js';

// Native shells (desktop app) expose a bridge; plain browsers do not.
export const native = globalThis.swipeNative || null;

const PREFIX = 'swipe.';

function load(key, dflt) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? dflt : JSON.parse(v);
  } catch {
    return dflt;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

const ua = navigator.userAgent;
const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

export const env = {
  isIOS: /iPhone|iPod/.test(ua) || isIPad,
  isIPad,
  isAndroid: /Android/.test(ua),
  isTouch: navigator.maxTouchPoints > 0 || 'ontouchstart' in globalThis,
  // Browsers can capture the screen only on desktop operating systems.
  canCaptureScreen: !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod/.test(ua) && !isIPad,
  isApp: !!native,
};

export function platformName() {
  if (native?.platform) return { win32: 'windows', darwin: 'mac', linux: 'linux' }[native.platform] || native.platform;
  if (env.isIPad) return 'ipad';
  if (env.isIOS) return 'iphone';
  if (env.isAndroid) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Mac/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'web';
}

const PLATFORM_LABELS = {
  windows: 'Windows PC',
  mac: 'Mac',
  linux: 'Linux PC',
  chromeos: 'Chromebook',
  ipad: 'iPad',
  iphone: 'iPhone',
  android: 'Android',
  web: 'Device',
};

export function platformLabel(p) {
  return PLATFORM_LABELS[p] || 'Device';
}

function defaultServer() {
  if (native?.defaultServer) return native.defaultServer;
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  return '';
}

const DEFAULTS = {
  server: '',
  deviceName: '',
  quality: 'auto', // auto | text | motion
  maxRes: 1080, // 720 | 1080 | 1440 | 0 (native)
  codec: 'auto', // auto | h264 | vp8 | vp9 | av1
  keepPassword: !!native,
  allowControl: true,
  touchMode: 'direct', // direct | trackpad
  showStats: false,
};

export const settings = {
  get(key) {
    return load('settings', {})[key] ?? DEFAULTS[key];
  },
  set(key, value) {
    const all = load('settings', {});
    all[key] = value;
    save('settings', all);
  },
  server() {
    return (this.get('server') || defaultServer()).replace(/\/+$/, '');
  },
  deviceName() {
    return this.get('deviceName') || native?.hostname || platformLabel(platformName());
  },
};

// Random secret identifying this device to the server (gives a stable code).
export function deviceKey() {
  let k = load('deviceKey', null);
  if (!k) {
    k = bytesToBase64(randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    save('deviceKey', k);
  }
  return k;
}

export const storedPassword = {
  get: () => load('password', null),
  set: (pw) => save('password', pw),
};

// Recently used connections (most recent first).
export const recents = {
  list: () => load('recents', []),
  add(entry) {
    const list = recents.list().filter((r) => r.code !== entry.code);
    list.unshift({ ...entry, at: Date.now() });
    save('recents', list.slice(0, 8));
  },
  remove(code) {
    save(
      'recents',
      recents.list().filter((r) => r.code !== code)
    );
  },
};

export function wsUrl(server) {
  return server.replace(/^http/, 'ws') + '/ws';
}
