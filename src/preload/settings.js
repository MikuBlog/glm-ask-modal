const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cfgAPI', {
  get: () => ipcRenderer.invoke('cfg:get'),
  save: patch => ipcRenderer.invoke('cfg:save', patch),
  test: p => ipcRenderer.invoke('cfg:test', p),
  checkPermission: () => ipcRenderer.invoke('cfg:check-permission'),
  openAccessibilityPane: () => ipcRenderer.invoke('perm:open-system-settings'),
  appInfo: () => ipcRenderer.invoke('perm:app-info'),
  closeWindow: () => ipcRenderer.send('perm:close'),
  openGuide: () => ipcRenderer.send('perm:open-guide')
})
