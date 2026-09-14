// 全局划词捕获：
// 1) uiohook-napi 监听全局鼠标（拖拽松开 / 双击 → 触发一次捕获）
// 2) 优先调用原生划词助手（AX API 读选中文本，不污染剪贴板；需 swiftc 编译成功）
// 3) 助手不可用时兜底：JXA 取前台应用 → 模拟 Cmd+C 读剪贴板 → 恢复原剪贴板
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const { clipboard } = require('electron')
const { uIOhook, UiohookKey } = require('uiohook-napi')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// JXA A：记录 changeCount → 注入 Cmd+C → 轮询 changeCount → 直读文本。
// changeCount 是「复制真的发生了」的权威判据：截图框选、拖图标、拖窗口
// 都不会改变它（或只存图片无文本），因此绝不误弹；选中文本恰与剪贴板
// 原内容相同时依然可靠。
const JXA_CAPTURE = `
ObjC.import('AppKit');
function run() {
  var gp = $.NSPasteboard.generalPasteboard;
  var out = { changed: false, text: '' };
  var c0 = Number(gp.changeCount);
  try {
    var se = Application('System Events');
    se.keystroke('c', { using: 'command down' });
  } catch (e) {}
  var deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    if (Number(gp.changeCount) !== c0) {
      out.changed = true;
      try {
        var s = ObjC.unwrap(gp.stringForType($.NSPasteboardTypeString));
        if (s) out.text = String(s);
      } catch (e) {}
      break;
    }
    $.NSThread.sleepForTimeInterval(0.02);
  }
  return JSON.stringify(out);
}`

// JXA B：并行取前台应用信息（供黑名单/禁用标签使用）
const JXA_FRONTMOST = `
function run() {
  var out = { bundleId: '', appName: '' };
  try {
    var se = Application('System Events');
    var procs = se.applicationProcesses.whose({ frontmost: true });
    if (procs.length) {
      try { out.bundleId = procs[0].bundleIdentifier() || ''; } catch (e) {}
      try { out.appName = procs[0].name() || ''; } catch (e) {}
    }
  } catch (e) {}
  return JSON.stringify(out);
}`

function runOsa(script, timeout = 1500) {
  return new Promise(resolve => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

function execBin(cmd, args, timeout) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

// ---------- 原生划词助手 ----------
let helperPathCache

function helperPath() {
  if (helperPathCache !== undefined) return helperPathCache
  let p = path.join(__dirname, '..', 'native', 'selected-text')
  // 打包后二进制在 asar.unpacked 中
  if (__dirname.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked')
  }
  helperPathCache = fs.existsSync(p) ? p : null
  return helperPathCache
}

// 恢复被 Cmd+C 覆盖的剪贴板（仅当期间未被用户改写时）
function scheduleClipboardRestore(prev, captured) {
  if (!prev || prev === captured) return
  setTimeout(() => {
    try {
      if (clipboard.readText() === captured) clipboard.writeText(prev)
    } catch {}
  }, 600)
}

async function captureSelection() {
  // 路径 A：原生助手（AX 直读，不碰剪贴板）
  let helperError = -2
  let helperBundleId = ''
  const helper = helperPath()
  if (helper) {
    const raw = await execBin(helper, [], 900)
    if (raw) {
      try {
        const j = JSON.parse(raw)
        helperError = j.err ?? 0
        helperBundleId = j.bundleId || ''
        if ((j.text || '').trim()) {
          return {
            text: j.text || '',
            appName: j.appName || '',
            bundleId: j.bundleId || '',
            axError: helperError,
            simulated: false
          }
        }
      } catch { /* 落入兜底 */ }
    }
  }
  if (process.env.GLM_ASK_DEBUG) console.log('[selection] AX 未取到文本，进入 Cmd+C 兜底', helperError)

  // Finder 双击文件夹/空白处没有文本选区；此时注入 Cmd+C 只会触发系统提示音。
  if (helperBundleId === 'com.apple.finder') {
    return {
      text: '',
      appName: 'Finder',
      bundleId: helperBundleId,
      axError: helperError,
      simulated: false
    }
  }

  // AX 助手可能在 Edge/部分 Electron 应用里返回 -25204 或空文本。
  // 这不是“确认没有选中文本”，必须继续走 Cmd+C 兜底，否则工具条完全不出现。

  // 路径 B：两个 osascript 并行 —— 捕获（Cmd+C + changeCount + 取文本）
  // 与前台应用信息，工具条在确认文本后立即展示（约 300ms）
  const prev = clipboard.readText()
  const [capRaw, metaRaw] = await Promise.all([
    runOsa(JXA_CAPTURE, 1600),
    runOsa(JXA_FRONTMOST, 1200)
  ])
  let cap = { changed: false, text: '' }
  let meta = { bundleId: '', appName: '' }
  if (capRaw) { try { cap = JSON.parse(capRaw) } catch {} }
  if (metaRaw) { try { meta = JSON.parse(metaRaw) } catch {} }
  const text = (cap.changed && cap.text && cap.text.trim()) ? cap.text : ''
  // 某些应用会先写一条无 string 类型的 pasteboard 变更；NSPasteboard/JXA
  // 读不到时，Electron clipboard 可能仍能读到纯文本。
  let textCandidate = text
  if (cap.changed && !textCandidate.trim()) {
    try { textCandidate = clipboard.readText() || '' } catch {}
  }
  const finalText = textCandidate.trim()
  if (text) scheduleClipboardRestore(prev, text)
  if (finalText) scheduleClipboardRestore(prev, finalText)
  if (process.env.GLM_ASK_DEBUG) console.log('[selection] Cmd+C capture', { changed: cap.changed, length: finalText.length, appName: meta.appName, bundleId: meta.bundleId })
  return {
    text: finalText,
    appName: meta.appName || '',
    bundleId: meta.bundleId || '',
    axError: finalText ? 0 : helperError,
    simulated: true
  }
}

// ---------- 全局鼠标手势 ----------
// 拖选（位移 ≥ DRAG_MIN 且时长 ≥ 50ms）与双击/三击选词都会触发捕获；
// 是否弹工具条由捕获结果决定（未复制出文本就不弹）——截图框选、拖图标、
// 拖窗口等操作不会误弹。
const DRAG_MIN = 12
let downPoint = null
let lastClick = null // { t, x, y, count }
let hookRunning = false
let retryTimer = null

function tryStartHook() {
  if (hookRunning) return true
  try {
    uIOhook.start()
    hookRunning = true
    return true
  } catch (e) {
    hookRunning = false
    return false
  }
}

// 用户在系统设置里授权后无需重启应用：每 2.5s 重试拉起钩子，成功后回调
function startHookRetry(onReady) {
  if (hookRunning || retryTimer) return
  retryTimer = setInterval(() => {
    if (tryStartHook()) {
      clearInterval(retryTimer)
      retryTimer = null
      onReady && onReady()
    }
  }, 2500)
}

function stopHookRetry() {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

function initSelection({ onPress, onGesture, onHotkeyKeys, onScreenshotTrigger, onScreenshotCancel, onSwitchSpace }) {
  let lastHotkeyDown = 0
  let lastShotDown = 0
  try {
    uIOhook.on('mousedown', e => {
      if (e.button !== 1) return
      downPoint = { x: e.x, y: e.y, t: Date.now() }
      onPress({ x: e.x, y: e.y })
    })
    uIOhook.on('mouseup', e => {
      if (e.button !== 1 || !downPoint) return
      const from = downPoint
      downPoint = null
      const dist = Math.hypot(e.x - from.x, e.y - from.y)
      const dur = Date.now() - from.t
      if (dist >= DRAG_MIN && dur >= 50) {
        onGesture({ x: e.x, y: e.y }, 'drag')
        return
      }
      // 双击/三击选词：450ms 内同点连续点击
      const now = Date.now()
      if (lastClick && now - lastClick.t < 450 && Math.hypot(e.x - lastClick.x, e.y - lastClick.y) < 40) {
        lastClick.count++
        lastClick.t = now
        if (lastClick.count >= 2) onGesture({ x: e.x, y: e.y }, 'multiclick')
      } else {
        lastClick = { t: now, x: e.x, y: e.y, count: 1 }
      }
    })
    // 键盘监听：
    // 1) ⌘⇧Space 兜底触发（Carbon 注册成功但被输入法拦截时仍可用）
    // 2) 截图快捷键（⌘⌥A / ⌘⇧A / ⌥A，微信/QQ/钉钉/飞书截图默认键）→
    //    通知主进程进入抑制期，期间划词捕获不发 Cmd+C，
    //    否则模拟的 Cmd+C 会被截图工具当成"复制并完成截图"。
    // 3) Esc / 回车 → 通知主进程解除抑制（截图取消或完成）
    //    按住按键的键盘重复用 1s 间隔防护过滤。
    uIOhook.on('keydown', e => {
      const now = Date.now()
      const isSpaceCombo = e.keycode === UiohookKey.Space && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
      const isShotCombo = e.keycode === UiohookKey.A && !e.ctrlKey &&
        ((e.metaKey && e.altKey) || (e.metaKey && e.shiftKey) || (e.altKey && !e.metaKey && !e.shiftKey))
      if (isShotCombo) {
        if (now - lastShotDown > 1000) {
          lastShotDown = now
          onScreenshotTrigger && onScreenshotTrigger()
        }
        return
      }
      if ((e.keycode === UiohookKey.Escape || e.keycode === UiohookKey.Enter) && !e.metaKey && !e.altKey && !e.ctrlKey) {
        onScreenshotCancel && onScreenshotCancel()
      }
      // Ctrl+方向键 = 切换桌面（Mission Control 默认键）：主动隐藏弹窗，
      // 让它在空间切换动画开始前就消失。注意 uiohook 的方向键码是 0xE04B 系
      // 不再严格要求 Ctrl 是唯一修饰键：部分系统/键盘组合会附带 Fn 状态，
      // 造成真实切换桌面时 keydown 在主进程里匹配不到。
      if (e.ctrlKey &&
          [UiohookKey.ArrowLeft, UiohookKey.ArrowRight, UiohookKey.ArrowUp, UiohookKey.ArrowDown].indexOf(e.keycode) >= 0) {
        onSwitchSpace && onSwitchSpace()
      }
      if (isSpaceCombo && now - lastHotkeyDown > 1000) {
        lastHotkeyDown = now
        onHotkeyKeys && onHotkeyKeys()
      }
    })
  } catch (e) {
    console.warn('[selection] 注册鼠标/键盘事件失败：', e.message)
  }
  return { hookStarted: tryStartHook() }
}

// 权限检测：以本进程的 uiohook（CGEventTap）能否启动为准。osascript 探测
// 的是终端/宿主进程的权限，对打包后的 .app 会误报。检测成功时钩子保持
// 运行 —— 授权后无需重启应用即可生效。
async function checkAccessibility() {
  if (hookRunning || tryStartHook()) return { granted: true }
  return { granted: false, err: -1719, hint: '未获得辅助功能权限（请勾选 GLM问问 或你运行它的终端 App）' }
}

function stopSelection() {
  try { uIOhook.stop() } catch {}
}

module.exports = { initSelection, stopSelection, captureSelection, checkAccessibility, helperPath, startHookRetry, stopHookRetry }
