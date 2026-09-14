const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('askAPI', {
  onInit: cb => ipcRenderer.on('ask:init', (e, d) => cb(d)),
  onLlm: cb => ipcRenderer.on('llm:event', (e, d) => cb(d)),
  onCfgChanged: cb => ipcRenderer.on('cfg-changed', (e, d) => cb(d)),
  onHint: cb => ipcRenderer.on('ask:hint', (e, msg) => cb(msg)),
  onHookReady: cb => ipcRenderer.on('ask:hook-ready', () => cb()),
  cfg: () => ipcRenderer.invoke('ask:cfg'),
  localAgents: () => ipcRenderer.invoke('local-agents:summary'),
  classifyIntent: payload => ipcRenderer.invoke('agent:classify', payload),
  localAgentRun: req => ipcRenderer.invoke('local-agent:run', req),
  saveConfig: patch => ipcRenderer.invoke('cfg:save', patch),
  chat: payload => ipcRenderer.invoke('llm:chat', payload),
  abort: reqId => ipcRenderer.invoke('llm:abort', { reqId }),
  copyText: t => ipcRenderer.invoke('util:copy', t),
  copyImage: u => ipcRenderer.invoke('util:copy-image', u),
  openExternal: u => ipcRenderer.invoke('util:open-external', u),
  min: () => ipcRenderer.send('ask:min'),
  togglePin: () => ipcRenderer.invoke('ask:pin'),
  openSettings: () => ipcRenderer.send('ask:open-settings'),
  quit: () => ipcRenderer.send('ask:quit'),
  saveSession: s => ipcRenderer.invoke('ask:save-session', s),
  listHistory: () => ipcRenderer.invoke('ask:history-list'),
  loadHistory: id => ipcRenderer.invoke('ask:history-get', id),
  deleteHistory: id => ipcRenderer.invoke('ask:history-del', id),
  pick: kind => ipcRenderer.invoke('ask:pick', kind)
})

export {}
