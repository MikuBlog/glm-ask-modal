// 拖选回归测试的目标窗口：纯文本页面，供 scripts/drag-e2e.py 合成拖选
// 坐标从命令行传入，避开屏幕上已有窗口
const { app, BrowserWindow } = require('electron')

const TEXT = 'The quick brown fox jumps over the lazy dog again and again across the wide open meadow near the riverbank on a sunny afternoon morning breeze.'

app.whenReady().then(() => {
  const x = parseInt(process.argv[2] || '120', 10)
  const y = parseInt(process.argv[3] || '130', 10)
  const w = new BrowserWindow({
    width: 720,
    height: 300,
    x,
    y,
    alwaysOnTop: true,
    frame: false,
    title: 'GLMDRAGTARGET'
  })
  const html = '<html><body style="font:26px/2 Menlo,monospace;margin:24px;white-space:nowrap">' +
    `<p>${TEXT}</p><p>Second line for spare selection target with several more words here.</p></body></html>`
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
})
