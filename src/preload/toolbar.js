const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tbAPI', {
  onPayload: cb => ipcRenderer.on('tb:payload', (e, d) => cb(d)),
  ask: mode => ipcRenderer.invoke('tb:ask', mode),
  copy: () => ipcRenderer.invoke('tb:copy'),
  // 渲染层一次性上报完整尺寸；避免位置参数错位导致窗口/命中区偏移。
  fit: metrics => ipcRenderer.send('tb:fit', metrics),
  disableApp: () => ipcRenderer.send('tb:disable'),
  openSettings: () => ipcRenderer.send('tb:settings')
})
