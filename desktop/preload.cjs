// Bridge between the Swipe web client and the desktop app (sandboxed).

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('info');
let screens = [];

async function getScreens() {
  screens = await ipcRenderer.invoke('screens');
  return screens;
}

getScreens();
ipcRenderer.on('screens-changed', () => getScreens());

contextBridge.exposeInMainWorld('swipeNative', {
  isApp: true,
  platform: info.platform,
  hostname: info.hostname,
  defaultServer: info.defaultServer,
  canControl: info.canControl,
  warning: info.warning,
  version: info.version,
  getScreens,
  cachedScreens: () => screens,
  selectScreen: (id) => ipcRenderer.invoke('select-screen', id ?? null),
  input: (evt) => ipcRenderer.send('input', evt),
  releaseInput: () => ipcRenderer.send('release-input'),
  setStatus: (s) => ipcRenderer.send('status', s),
  notifyViewers: (names) => ipcRenderer.send('viewers', names),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd) => cb(cmd)),
});
