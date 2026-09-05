// The only bridge between the renderers and the main process. Renderers get no
// Node access and no direct ipcRenderer: just this fixed list of calls.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('hud', {
  getConfig: () => invoke('config:get'),
  saveConfig: (partial) => invoke('config:save', partial),
  getState: () => invoke('state:get'),
  pollNow: () => invoke('poll:now'),
  openSettings: () => invoke('settings:open'),
  quit: () => invoke('app:quit'),
  resetPosition: () => invoke('hud:resetPosition'),

  googleSignIn: () => invoke('google:signin'),
  googleSignOut: () => invoke('google:signout'),
  slackConnect: (token) => invoke('slack:connect', token),
  slackDisconnect: () => invoke('slack:disconnect'),
  slackMarkSeen: (items) => invoke('slack:markSeen', items),

  openExternal: (url) => invoke('open:external', url),
  topProcesses: () => invoke('memory:processes'),
  listDisks: () => invoke('disks:list'),

  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onMemory: (cb) => ipcRenderer.on('memory', (_e, m) => cb(m)),
  onPeek: (cb) => ipcRenderer.on('peek', (_e, on) => cb(on)),
});
