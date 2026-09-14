// 临时诊断：目标窗口为何不在屏幕上
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  console.log('whenReady fired')
  const w = new BrowserWindow({ width: 720, height: 300, x: 120, y: 130, alwaysOnTop: true })
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="font:26px/2 Menlo;margin:24px"><p>target text line for drag testing purposes here now ok</p></body></html>'))
  w.once('ready-to-show', () => { console.log('ready-to-show, showing'); w.show() })
  setTimeout(() => { console.log('visible:', w.isVisible(), 'bounds:', JSON.stringify(w.getBounds())) }, 2000)
})

export {}
