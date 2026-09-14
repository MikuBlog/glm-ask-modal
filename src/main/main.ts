// 主进程：窗口编排 + IPC + 划词流程
const { app, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, Menu, shell, dialog, nativeImage, nativeTheme, systemPreferences } = require('electron')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const llm = require('./llm')
const localAgents = require('./localAgents')
const { initSelection, stopSelection, captureSelection, checkAccessibility, helperPath, startHookRetry, stopHookRetry } = require('./selection')

const isSmoke = !!process.env.GLM_ASK_SMOKE
if (isSmoke) {
  // smoke 不读写真实用户配置，避免窗口尺寸回归测试污染 userData。
  app.setPath('userData', path.join(app.getPath('temp'), 'glm-ask-smoke-userData'))
}
// GLM_ASK_DEV=1：独立 userData 启动第二个实例（与打包实例并存，用于开发诊断）
if (process.env.GLM_ASK_DEV) {
  app.setPath('userData', path.join(app.getPath('userData'), 'dev'))
}

app.setName('GLM问问')
nativeTheme.themeSource = 'light'

if (!isSmoke && !process.env.GLM_ASK_DEV && !app.requestSingleInstanceLock()) {
  app.quit()
}

// ---------- 窗口状态 ----------
let toolbarWin = null
let askWin = null
let settingsWin = null
let permissionWin = null
let lastCapture = null // { text, appName, bundleId }
let captureToken = 0
let emptyCaptures = 0
// 截图抑制：截图快捷键按下后进入武装态，期间划词捕获不发 Cmd+C
// （截图工具会把模拟的 Cmd+C 当成"复制并完成截图"）。
// 解除时机：Esc/回车（取消/完成）、框选拖选结束（危险期已过）、
// 武装 3 秒后的点击（进入标注/完成阶段）、硬上限 12 秒。
const SCREENSHOT_SUPPRESS_MS = +(process.env.GLM_SHOT_MS) || 12000
let screenshotArmed = false
let screenshotArmedAt = 0
let hintSent = false
let hookFailed = false
let hotkeyConflict = false
let spaceObserverId = null
let askShowToken = 0
let askResizeTimer = null
let filePickerCount = 0
app.isQuitting = false

const TOOLBAR_W = 480
const TOOLBAR_CLOSED_H = 52
const TOOLBAR_PAD = 6
const TOOLBAR_HPADDING = 8
const DROP_ESTIMATE = 140
const ASK_HOTKEY = 'CommandOrControl+Shift+Space'
const ASK_MIN_W = 560
const ASK_MIN_H = 480
const ASK_MAX_W = 1600
const ASK_MAX_H = 1200
// Electron 的 screen-saver 是最高公开层级；设置/权限引导必须高于问一问 panel。
const TOP_WINDOW_LEVEL = 'screen-saver'
const debugLog = (...args) => {
  if (process.env.GLM_ASK_DEBUG) console.log('[ask-debug]', new Date().toISOString(), ...args)
}

function zoneAt(pt) {
  try {
    if (toolbarWin && toolbarWin.isVisible() && toolbarWin.__hitRel) {
      const b = toolbarWin.getBounds()
      const r = toolbarWin.__hitRel
      if (inBounds(pt, { x: b.x + r.x, y: b.y + r.y, width: r.w, height: r.h })) return 'toolbar'
    }
    // 只挡「可见」的窗口：隐藏后的弹窗不应有幽灵边界
    if (askWin && askWin.isVisible() && inBounds(pt, askWin.getBounds())) return 'own'
    if (settingsWin && settingsWin.isVisible() && inBounds(pt, settingsWin.getBounds())) return 'own'
  } catch {}
  return null
}
function inBounds(pt, b) {
  return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
}

function normalizedAskSize(width, height) {
  const toInt = value => Number.parseInt(String(value), 10)
  return {
    askWidth: Math.min(Math.max(Number.isFinite(toInt(width)) ? toInt(width) : 780, ASK_MIN_W), ASK_MAX_W),
    askHeight: Math.min(Math.max(Number.isFinite(toInt(height)) ? toInt(height) : 640, ASK_MIN_H), ASK_MAX_H)
  }
}

function persistAskSize() {
  if (!askWin || askWin.isDestroyed()) return
  const bounds = askWin.getBounds()
  store.saveConfig(normalizedAskSize(bounds.width, bounds.height))
}

function scheduleAskSizePersist() {
  if (app.isQuitting) return
  clearTimeout(askResizeTimer)
  askResizeTimer = setTimeout(() => {
    askResizeTimer = null
    try { persistAskSize() } catch (e) { console.warn('[window] 保存弹窗尺寸失败：', e.message) }
  }, 250)
}

// ---------- 工具条 ----------
function createToolbar() {
  toolbarWin = new BrowserWindow({
    width: TOOLBAR_W,
    height: TOOLBAR_CLOSED_H,
    show: false,
    frame: false,
    transparent: true,
    roundedCorners: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'toolbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // 划词工具条和下拉菜单必须压在普通应用、全屏应用与系统浮动面板之上。
  toolbarWin.setAlwaysOnTop(true, 'screen-saver')
  toolbarWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  toolbarWin.loadFile(path.join(__dirname, '..', 'renderer', 'toolbar.html'))
  toolbarWin.webContents.once('did-finish-load', () => {
    toolbarWin.__ready = true
    if (toolbarWin.__payload) toolbarWin.webContents.send('tb:payload', toolbarWin.__payload)
  })
  toolbarWin.__pillY = TOOLBAR_PAD
  toolbarWin.__hitRel = { x: TOOLBAR_HPADDING, y: TOOLBAR_PAD, w: TOOLBAR_W - TOOLBAR_HPADDING * 2, h: 40 }
  global.__toolbarWinRef = toolbarWin
  return toolbarWin
}

// 划词捕获确认拿到文本后展示（约 300ms），杜绝截图/拖拽类误弹
function showToolbar(payload, pt) {
  if (!toolbarWin || toolbarWin.isDestroyed()) createToolbar()
  const wa = screen.getDisplayNearestPoint(pt).workArea
  // 水平：工具条左缘 ≈ 落点左侧 30px（左缘固定，fit 自适应宽度只向右伸展）
  const x = Math.min(Math.max(Math.round(pt.x - 30), wa.x + 4), wa.x + wa.width - TOOLBAR_W - 4)
  // 垂直：默认在落点下方 14px；贴近屏幕底部则翻转到上方
  let y = Math.round(pt.y + 14)
  if (y + TOOLBAR_CLOSED_H > wa.y + wa.height - 4) y = Math.round(pt.y - TOOLBAR_CLOSED_H - 14)
  y = Math.min(Math.max(y, wa.y + 2), wa.y + wa.height - TOOLBAR_CLOSED_H - 2)
  const menuDir = y + TOOLBAR_CLOSED_H + DROP_ESTIMATE > wa.y + wa.height - 4 ? 'up' : 'down'
  toolbarWin.__menuDir = menuDir
  toolbarWin.__anchor = { x: Math.round(pt.x), y: Math.round(pt.y) }
  toolbarWin.__pillY = TOOLBAR_PAD
  toolbarWin.setBounds({ x, y, width: TOOLBAR_W, height: TOOLBAR_CLOSED_H })
  const full = { ...payload, menuDir }
  toolbarWin.__payload = full
  if (toolbarWin.__ready) toolbarWin.webContents.send('tb:payload', full)
  toolbarWin.showInactive()
}

function hideToolbar() {
  if (toolbarWin && !toolbarWin.isDestroyed() && toolbarWin.isVisible()) toolbarWin.hide()
}

// Space 切换兜底：键盘快捷键已由全局钩子先行处理；触控板手势、Mission Control
// 或系统自定义切换方式无法都拦截，这里在 Workspace 通知到达时立即收起浮层。
function hideTransientWindowsForSpaceChange() {
  debugLog('hideTransientWindowsForSpaceChange', { stack: process.env.GLM_ASK_TRACE ? new Error().stack : undefined })
  try {
    askShowToken++ // 取消尚未执行的 show 延时，避免切换完成后又被旧 show 拉起
  } catch {}
  try {
    if (askWin && !askWin.isDestroyed() && askWin.isVisible()) askWin.hide()
  } catch {}
  hideToolbar()
}

// ---------- 问一问窗口 ----------
function createAsk() {
  const cfg = store.loadConfig()
  const saved = normalizedAskSize(cfg.askWidth, cfg.askHeight)
  askWin = new BrowserWindow({
    // panel 是 macOS 非激活浮层；只有它能保证快捷键在任意桌面立即唤起。
    type: 'panel',
    width: saved.askWidth,
    height: saved.askHeight,
    minWidth: ASK_MIN_W,
    minHeight: ASK_MIN_H,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    title: 'GLM问问',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ask.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  // macOS 可能用 NSWindow 自动保存的旧 frame 覆盖构造尺寸；首次显示后强制还原。
  askWin.__restoreSavedSize = true
  // 最高层级 + 全空间可达；真正从屏幕消失由 onSwitchSpace/horizontal swipe hide 完成。
  askWin.__pinned = true
  askWin.setAlwaysOnTop(true, 'screen-saver')
  askWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  askWin.loadFile(path.join(__dirname, '..', 'renderer', 'ask.html'))
  askWin.webContents.once('did-finish-load', () => {
    askWin.__ready = true
  })
  askWin.on('resize', scheduleAskSizePersist)
  askWin.on('hide', () => debugLog('ask hide event', { stack: process.env.GLM_ASK_TRACE ? new Error().stack : undefined }))
  // 不用 blur 自动隐藏：点击外部由全局 mousedown 兜底，切桌面由手势钩子
  // 和 Workspace 通知兜底，避免 macOS 的瞬时 resign key 误伤刚打开的窗口。
  askWin.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault()
      askWin.hide()
    }
  })
  return askWin
}

function ensureAsk() {
  if (!askWin || askWin.isDestroyed()) createAsk()
  return askWin
}

function askCfgSnapshot() {
  const cfg = store.loadConfig()
  return {
    model: cfg.model,
    models: cfg.models,
    effort: cfg.effort || 'max',
    hasKey: !!cfg.apiKey,
    localAgent: cfg.localAgent || 'auto',
    intentModel: cfg.intentModel || 'glm-5.3-flash',
    agentExec: cfg.agentExec !== false
  }
}

function applyLoginItem(openAtLogin) {
  if (process.platform !== 'darwin') return
  try {
    app.setLoginItemSettings({
      openAtLogin: !!openAtLogin,
      openAsHidden: true,
      args: ['--login-hidden']
    })
  } catch (err) {
    console.warn('[login-item] 设置开机自启动失败:', err)
  }
}

// 唤起规则：panel 全 Space 可达；切换意图（Ctrl+箭头 / 触控板横扫 /
// Mission Control）由原生 CGEventTap + NSEvent global monitor 立刻 hide。
function showAskOnActiveSpace() {
  const win = askWin
  const token = ++askShowToken
  debugLog('showAskOnActiveSpace', { token })
  if (win.isVisible()) win.hide()
  setTimeout(() => {
    try {
      if (token !== askShowToken) return
      if (!win.isVisible()) win.showInactive()
      debugLog('ask shown', { token, visible: win.isVisible() })
      win.focus()
      if (win.__restoreSavedSize) {
        // macOS 的 frame restore 会在 show 后一小段时间才覆盖构造尺寸；
        // 等它完成后再还原到配置尺寸。
        setTimeout(() => {
          if (app.isQuitting || token !== askShowToken || !win.__restoreSavedSize) return
          const saved = normalizedAskSize(store.loadConfig().askWidth, store.loadConfig().askHeight)
          win.setBounds({ ...win.getBounds(), width: saved.askWidth, height: saved.askHeight })
          win.__restoreSavedSize = false
        }, 120)
      }
      win.focus()
      // BrowserWindow.focus() 只保证 native key window；Chromium 文档不一定
      // 自动恢复到 textarea。这里显式抢焦到 #input，点击「问问GLM」后可直接输入。
      setTimeout(() => {
        if (app.isQuitting || token !== askShowToken || !win.isVisible() || win.webContents.isDestroyed()) return
        win.webContents.focus()
        win.webContents.executeJavaScript(`
          (() => {
            const input = document.querySelector('#input')
            if (input) {
              input.focus({ preventScroll: true })
              input.setSelectionRange(input.value.length, input.value.length)
            }
          })()
        `).catch(() => {})
      }, 0)
    } catch {}
  }, 40)
}

function openAsk(payload = {}) {
  const win = ensureAsk()
  const send = () => {
    win.__ready && win.webContents.send('ask:init', { ...payload, config: askCfgSnapshot(), hookFailed, hotkeyConflict })
  }
  if (win.__ready && !win.isVisible()) {
    showAskOnActiveSpace()
  } else if (!win.isVisible()) {
    win.once('ready-to-show', () => showAskOnActiveSpace())
  }
  if (win.__ready) send()
  else win.webContents.once('did-finish-load', send)
  return win
}

// ---------- 设置窗口 ----------
function openSettings() {  if (!settingsWin || settingsWin.isDestroyed()) {
    settingsWin = new BrowserWindow({
      width: 560,
      height: 620,
      minWidth: 480,
      minHeight: 480,
      show: false,
      title: '设置',
      backgroundColor: '#f5f6f7',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'settings.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'))
    // 在同一 screen-saver 层级上 +1，确保固定高于问一问，而不是靠窗口顺序。
    settingsWin.setAlwaysOnTop(true, TOP_WINDOW_LEVEL, 1)
    settingsWin.on('close', e => {
      if (!app.isQuitting) {
        e.preventDefault()
        settingsWin.hide()
      }
    })
  }
  if (settingsWin.isVisible()) settingsWin.moveTop()
  settingsWin.show()
  settingsWin.moveTop()
  return settingsWin
}

// ---------- 权限引导窗口 ----------
function openPermissionGuide() {
  if (!permissionWin || permissionWin.isDestroyed()) {
    permissionWin = new BrowserWindow({
      width: 500,
      height: 420,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '权限引导',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'settings.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    permissionWin.loadFile(path.join(__dirname, '..', 'renderer', 'permission.html'))
    permissionWin.setAlwaysOnTop(true, TOP_WINDOW_LEVEL, 2)
    permissionWin.on('close', e => {
      if (!app.isQuitting) {
        e.preventDefault()
        permissionWin.hide()
      }
    })
  }
  if (permissionWin.isVisible()) permissionWin.moveTop()
  permissionWin.show()
  permissionWin.moveTop()
  return permissionWin
}

function closePermissionGuide() {
  if (permissionWin && !permissionWin.isDestroyed() && permissionWin.isVisible()) permissionWin.hide()
}

// ---------- 划词流程 ----------
function startSelectionFlow() {
  return initSelection({
    onScreenshotTrigger: () => {
      screenshotArmed = true
      screenshotArmedAt = Date.now()
      hideToolbar()
    },
    onScreenshotCancel: () => {
      screenshotArmed = false
    },
    onSwitchSpace: () => {
      debugLog('keyboard space switch')
      // 用户按下 Ctrl+方向键切换桌面：立即隐藏弹窗/工具条（先于切换动画）。
      // 工具条是 visibleOnAllWorkspaces，若不主动隐藏会跟着出现在新桌面。
      try {
        if (askWin && !askWin.isDestroyed() && askWin.isVisible()) askWin.hide()
      } catch {}
      hideToolbar()
    },
    onHotkeyKeys: () => toggleAsk(),
    onPress: pt => {
      // macOS 文件选择器可能在主窗口边界外；全局鼠标钩子会把对话框内的
      // 点击误判为“点击弹窗外部”，选文件期间必须禁止隐藏主弹窗。
      if (filePickerCount > 0) return
      if (zoneAt(pt) !== 'toolbar') hideToolbar()
      // 武装 3 秒后的点击 = 已进入标注/完成阶段，解除抑制
      if (screenshotArmed && Date.now() - screenshotArmedAt > 3000) screenshotArmed = false
      // 点击弹窗以外任意位置 → 自动隐藏弹窗（设置/权限窗口打开时例外）
      try {
        if (askWin && !askWin.isDestroyed() && askWin.isVisible() && !inBounds(pt, askWin.getBounds())) {
          if ((settingsWin && settingsWin.isVisible()) || (permissionWin && permissionWin.isVisible())) return
          askWin.hide()
        }
      } catch {}
    },
    onGesture: async (pt, kind) => {
      if (zoneAt(pt)) return // 点击/划选发生在自己窗口内
      if (screenshotArmed) {
        // 截图抑制中：不发 Cmd+C。框选拖选结束 = 危险的框选阶段已过，解除抑制
        if (Date.now() - screenshotArmedAt > SCREENSHOT_SUPPRESS_MS) screenshotArmed = false
        else if (kind === 'drag') screenshotArmed = false
        return
      }
      hideToolbar()
      const token = ++captureToken
      // 先捕获、确认拿到文本后再展示工具条（约 300ms）——
      // 截图框选、拖图标、拖窗口等不产生文本复制的操作绝不误弹
      const meta = await captureSelection()
      if (token !== captureToken) return
      const text = (meta.text || '').trim()
      if (!text) {
        emptyCaptures++
        if (emptyCaptures >= 3 && !hintSent && askWin && !askWin.isDestroyed()) {
          hintSent = true
          askWin.webContents.send('ask:hint', '无法获取选中文本。若持续出现，请在「设置 → 权限检测」里检查辅助功能权限。')
        }
        return
      }
      emptyCaptures = 0
      const cfg = store.loadConfig()
      if (meta.bundleId && cfg.blacklist.includes(meta.bundleId)) return
      lastCapture = meta
      showToolbar({ text, appName: meta.appName }, pt)
    }
  })
}

// ---------- IPC ----------
// 推理强度 → 请求体参数（已经接口实测：三档推理行为真实可区分）
const EFFORT_BODY = {
  low: { thinking: { type: 'disabled' } },
  high: { thinking: { type: 'enabled' } },
  max: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
}

function registerIpc() {
  // 工具条
  ipcMain.on('tb:fit', (e, { height, width, pillY, content }) => {
    if (!toolbarWin || toolbarWin.isDestroyed()) return
    const b = toolbarWin.getBounds()
    // 自适应宽度：左缘固定（与 showToolbar 的落点锚定一致），只向右伸展
    const W = Math.min(Math.max(Math.round(width || TOOLBAR_W), 180), 720)
    let x = b.x
    // 以药丸当前位置为锚：展开/收起时药丸屏幕位置不变
    const pillTopAbs = b.y + (toolbarWin.__pillY ?? TOOLBAR_PAD)
    let y = pillTopAbs - pillY
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
    if (x + W > wa.x + wa.width - 4) x = wa.x + wa.width - W - 4
    x = Math.max(x, wa.x + 4)
    y = Math.min(Math.max(Math.round(y), wa.y + 2), wa.y + wa.height - height - 2)
    toolbarWin.__pillY = pillY
    toolbarWin.__hitRel = content
    if (height !== b.height || y !== b.y || W !== b.width || x !== b.x) {
      toolbarWin.setBounds({ x, y, width: W, height })
    }
  })
  ipcMain.handle('tb:ask', async (e, mode) => {
    const text = lastCapture?.text?.trim() || ''
    hideToolbar()
    if (!text) return openAsk({ fresh: true })
    openAsk(
      mode === 'ask'
        ? { fresh: true, quote: text }
        : { fresh: true, quote: text, preset: mode, auto: true }
    )
  })
  ipcMain.handle('tb:copy', async () => {
    if (lastCapture?.text) clipboard.writeText(lastCapture.text)
    return true
  })
  ipcMain.on('tb:disable', () => {
    const bid = lastCapture?.bundleId
    if (bid) {
      const cfg = store.loadConfig()
      if (!cfg.blacklist.includes(bid)) store.saveConfig({ blacklist: [...cfg.blacklist, bid] })
    }
    hideToolbar()
  })
  ipcMain.on('tb:settings', () => {
    hideToolbar()
    openSettings()
  })

  // 问一问窗口
  ipcMain.on('ask:ready', e => {
    e.returnValue = true
  })
  ipcMain.on('ask:min', () => askWin?.hide())
  ipcMain.handle('ask:pin', () => {
    if (!askWin) return false
    askWin.__pinned = !askWin.__pinned
    askWin.setAlwaysOnTop(!!askWin.__pinned, 'floating')
    return !!askWin.__pinned
  })
  ipcMain.on('ask:open-settings', () => openSettings())
  ipcMain.on('ask:quit', () => app.quit())
  ipcMain.handle('ask:cfg', () => askCfgSnapshot())
  ipcMain.handle('util:copy', (e, text) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  ipcMain.handle('util:copy-image', (e, dataUrl) => {
    const image = nativeImage.createFromDataURL(String(dataUrl || ''))
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })
  ipcMain.handle('util:open-external', (e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle('llm:chat', (e, { reqId, messages, model }) => {
    const cfg = store.loadConfig()
    if (!cfg.apiKey) {
      e.sender.send('llm:event', { reqId, type: 'done', ok: false, error: '未配置 API Key，请先在设置中填写' })
      return
    }
    llm.stream({
      reqId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: model || cfg.model,
      messages,
      extra: EFFORT_BODY[cfg.effort] || EFFORT_BODY.max,
      onEvent: ev => {
        if (!e.sender.isDestroyed()) e.sender.send('llm:event', { reqId, ...ev })
      }
    })
  })
  ipcMain.handle('local-agents:summary', () => {
    const summary = localAgents.discover()
    return { ...summary, promptContext: localAgents.buildPromptContext(summary, false) }
  })
  ipcMain.handle('agent:classify', async (e, payload) => {
    const cfg = store.loadConfig()
    if (!cfg.apiKey) return { ok: false, error: '未配置 API Key' }
    const summary = localAgents.discover()
    const caps = summary.skills.slice(0, 80).map(x => x.name)
      .concat(summary.mcps.slice(0, 40).map(x => `MCP:${x.name}`))
      .concat(summary.plugins.slice(0, 40).map(x => `Plugin:${x.name}`))
    const history = Array.isArray(payload?.history) ? payload.history.slice(-10) : []
    const system = [
      '你是本地 Agent 路由意图识别器。只输出一个 JSON 对象，不要 Markdown，不要解释。',
      '输出格式：{"use_agent":true/false,"confidence":0到1,"reason":"不超过50字"}',
      '判断标准：',
      '- true：最新请求需要真实执行、查询外部系统、联网获取实时数据、操作 Skill/MCP/CLI/文件，或继续处理之前 Agent 创建/修改的成果。',
      '- false：纯概念解释、推理、写代码、改写文本、数学计算等 GLM 可直接完成的请求。',
      '- 如果用户明确不要工具，返回 false。'
    ].join('\n')
    const user = {
      current_request: String(payload?.prompt || '').slice(0, 6000),
      has_binary_file: !!payload?.hasBinaryFile,
      available_agents: summary.available,
      preferred_agent: summary.preferred,
      discovered_capabilities: caps,
      recent_conversation: history
    }
    const raw = await llm.complete({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.intentModel || 'glm-5.3-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) }
      ],
      temperature: 0,
      maxTokens: 160,
      timeoutMs: 10000
    })
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('意图识别返回格式无效')
    const parsed = JSON.parse(match[0])
    return {
      ok: true,
      useAgent: parsed.use_agent === true,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 160)
    }
  })
  ipcMain.handle('local-agent:run', (e, req) => {
    const cfg = store.loadConfig()
    return localAgents.run({
      reqId: req.reqId,
      messages: req.messages || [],
      agent: req.agent || cfg.localAgent || 'auto',
      cwd: req.cwd || cfg.agentWorkspace || app.getPath('home'),
      summary: req.includeContext ? localAgents.discover() : null,
      execute: req.execute !== false,
      onEvent: ev => {
        if (!e.sender.isDestroyed()) e.sender.send('llm:event', { reqId: req.reqId, ...ev })
      }
    })
  })
  ipcMain.handle('llm:abort', (e, { reqId }) => {
    localAgents.stop(reqId)
    llm.abort(reqId)
    return true
  })
  ipcMain.handle('ask:save-session', (e, session) => {
    store.saveSession(session)
    return true
  })
  ipcMain.handle('ask:history-list', () => store.listSessions())
  ipcMain.handle('ask:history-get', (e, id) => store.getSession(id))
  ipcMain.handle('ask:history-del', (e, id) => {
    store.deleteSession(id)
    return true
  })
  ipcMain.handle('ask:pick', async (e, kind) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    filePickerCount++
    try {
      if (kind === 'image') {
        const r = await dialog.showOpenDialog(win, {
          title: '选择图片',
          modal: true,
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
          properties: ['openFile', 'multiSelections']
        })
        if (r.canceled || !r.filePaths.length) return { ok: false }

        const images = []
        for (const p of r.filePaths.slice(0, 6)) {
          try {
            const stat = fs.statSync(p)
            if (stat.size > 10 * 1024 * 1024) {
              return { ok: false, error: '文件需小于 10MB：' + path.basename(p) }
            }
            const mime = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp'
            }[path.extname(p).toLowerCase()] || 'image/png'
            images.push(`data:${mime};base64,${fs.readFileSync(p).toString('base64')}`)
          } catch (err) {
            return { ok: false, error: err.message }
          }
        }
        return { ok: true, images }
      }

      // 所有附件统一限制 10MB；文本内容随消息发送，二进制文件保留路径给 Agent。
      const r = await dialog.showOpenDialog(win, {
        title: '选择文件',
        modal: true,
        properties: ['openFile', 'multiSelections']
      })
      if (r.canceled || !r.filePaths.length) return { ok: false }

      const files = []
      for (const p of r.filePaths.slice(0, 4)) {
        try {
          const stat = fs.statSync(p)
          if (stat.size > 10 * 1024 * 1024) {
            return { ok: false, error: '文件需小于 10MB：' + path.basename(p) }
          }
          const buf = fs.readFileSync(p)
          if (buf.includes(0)) {
            files.push({ name: path.basename(p), path: p, size: stat.size, binary: true })
          } else {
            files.push({ name: path.basename(p), path: p, size: stat.size, text: buf.toString('utf8') })
          }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      }
      return { ok: true, files }
    } finally {
      filePickerCount--
    }
  })


  // 设置窗口
  ipcMain.handle('cfg:get', () => {
    const loginItem = process.platform === 'darwin' ? app.getLoginItemSettings() : {}
    return {
      ...store.loadConfig(),
      openAtLogin: !!loginItem.openAtLogin,
      loginItemRegistered: process.platform === 'darwin' ? !!loginItem.openAtLogin : false,
      hotkeyRegistered: !hotkeyConflict
    }
  })
  ipcMain.handle('cfg:save', (e, patch) => {
    const cfg = store.saveConfig(patch || {})
    if (typeof patch?.openAtLogin === 'boolean') applyLoginItem(cfg.openAtLogin)
    askWin && !askWin.isDestroyed() && askWin.webContents.send('cfg-changed', askCfgSnapshot())
    // 设置页里开关快捷键必须立即生效；仅保存配置不会重启应用。
    if (cfg.hotkeyEnabled === false) {
      try { globalShortcut.unregister(ASK_HOTKEY) } catch {}
      hotkeyConflict = false
    } else {
      registerHotkey()
    }
    return cfg
  })
  ipcMain.handle('cfg:test', (e, { baseUrl, apiKey, model }) => llm.testConnection({ baseUrl, apiKey, model }))
  ipcMain.handle('cfg:check-permission', async () => {
    const r = await checkAccessibility()
    if (r.granted) {
      hookFailed = false
      closePermissionGuide()
      askWin && !askWin.isDestroyed() && askWin.webContents.send('ask:hook-ready')
    }
    return r
  })
  // 权限引导窗口
  ipcMain.on('perm:close', e => {
    const w = BrowserWindow.fromWebContents(e.sender)
    w && w.hide()
  })
  ipcMain.on('perm:open-guide', () => openPermissionGuide())
  ipcMain.handle('perm:app-info', () => ({ name: app.getName(), packaged: app.isPackaged }))
  ipcMain.handle('perm:open-system-settings', async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    return true
  })
}

// ---------- 应用生命周期 ----------
let lastToggleAt = 0

function toggleAsk() {
  // globalShortcut 与 uiohook 兜底可能对同一次按键各触发一次；
  // macOS 下兜底事件偶尔会晚几百毫秒入队，250ms 去抖不够。
  const now = Date.now()
  if (now - lastToggleAt < 600) return
  lastToggleAt = now
  debugLog('toggleAsk', { visible: askWin?.isVisible?.() })

  const win = ensureAsk()
  // 纯可见性开关：可见（无论是否聚焦）即隐藏，隐藏则唤起聚焦
  if (win.isVisible()) {
    win.hide()
    return
  }
  showAskOnActiveSpace()
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' }, { role: 'quit' }]
      },
      { role: 'editMenu' },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] }
    ])
  )
}

function registerHotkey(attempt = 0) {
  try {
    const cfg = store.loadConfig()
    if (cfg.hotkeyEnabled === false) return
    const acc = ASK_HOTKEY
    if (globalShortcut.isRegistered(acc)) {
      hotkeyConflict = false
      return
    }
    // 别的进程可能刚释放快捷键（如本应用新旧实例交接）：失败后重试几次
    const ok = globalShortcut.register(acc, toggleAsk)
    const prevFailed = hotkeyConflict
    hotkeyConflict = !ok
    if (ok && prevFailed) {
      askWin && !askWin.isDestroyed() && askWin.webContents.send('ask:hint', '快捷键 ⌘⇧Space 已生效')
    }
    if (!ok && attempt < 5) {
      setTimeout(() => registerHotkey(attempt + 1), 3000 * (attempt + 1))
    }
  } catch (e) {
    hotkeyConflict = true
    console.warn('[hotkey] 注册失败：', e.message)
  }
}

app.on('before-quit', () => {
  app.isQuitting = true
  clearTimeout(askResizeTimer)
  askResizeTimer = null
  try { persistAskSize() } catch {}
  if (spaceObserverId !== null) {
    try { systemPreferences.unsubscribeWorkspaceNotification(spaceObserverId) } catch {}
    spaceObserverId = null
  }
  stopSelection()
  stopHookRetry()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Mac 上保持常驻（菜单栏/ dock 可再次唤起）
})

app.on('activate', () => {
  openAsk({ fresh: false })
})

app.on('second-instance', () => openAsk({ fresh: false }))

app.whenReady().then(() => {
  buildMenu()
  registerIpc()
  const cfg = store.loadConfig()
  applyLoginItem(cfg.openAtLogin === true)
  const openedAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
  if (!isSmoke) {
    try {
      spaceObserverId = systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceActiveSpaceDidChangeNotification',
        () => { if (!app.isQuitting) hideTransientWindowsForSpaceChange() }
      )
    } catch (e) {
      console.warn('[space] 订阅切换桌面通知失败：', e.message)
    }
    if (!openedAtLogin) openAsk({ fresh: false })
    try {
      const { hookStarted } = startSelectionFlow()
      hookFailed = !hookStarted
      if (hookFailed) {
        // 权限未授：弹出引导窗口，并轮询授权状态（授权后无需重启自动生效）
        startHookRetry(onHookReady)
        openPermissionGuide()
      }
    } catch (e) {
      console.error('[boot] startSelectionFlow exception:', e)
    }
    registerHotkey()
  } else {
    require('./smoke')({
      openAsk, showToolbar, openSettings, openPermissionGuide, captureSelection, checkAccessibility, askCfgSnapshot,
      localAgentsSummary: () => {
        const s = localAgents.discover()
        return { ...s, promptContext: localAgents.buildPromptContext(s, false) }
      }
    })
  }
})

function onHookReady() {
  hookFailed = false
  closePermissionGuide()
  askWin && !askWin.isDestroyed() && askWin.webContents.send('ask:hook-ready')
}

export {}
