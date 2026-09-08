const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AV', {
  bootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  refreshServers: () => ipcRenderer.invoke('servers:refresh'),
  launchGame: (server) => ipcRenderer.invoke('game:launch', server),
  updateDiscordRpc: (server, mode = 'browsing') => ipcRenderer.invoke('rpc:update', server, mode),
  getDiscordRpcEnabled: () => ipcRenderer.invoke('rpc:get-enabled'),
  setDiscordRpcEnabled: (enabled) => ipcRenderer.invoke('rpc:set-enabled', !!enabled),
  getPreferences: () => ipcRenderer.invoke('prefs:get'),
  setPreference: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
  pingServer: (server) => ipcRenderer.invoke('server:ping', server),
  gameStatus: () => ipcRenderer.invoke('game:status'),
  onGameStatus: (callback) => ipcRenderer.on('game:status-changed', (_event, data) => callback(data)),

  showRemote: (url) => ipcRenderer.invoke('view:remote', url),
  showLocal: () => ipcRenderer.invoke('view:local'),

  reloadLauncher: () => ipcRenderer.invoke('launcher:reload'),
  clearCache: () => ipcRenderer.invoke('launcher:clear-cache'),
  hideLauncher: () => ipcRenderer.invoke('launcher:hide'),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', url),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
});
