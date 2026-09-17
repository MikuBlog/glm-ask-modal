// 全局划词捕获：
// 1) uiohook-napi 监听全局鼠标（拖拽松开 / 双击 → 触发一次捕获）
// 2) 优先调用原生划词助手（AX API / Text Marker 读选中文本，不污染剪贴板）
// 3) AX 读不到时，优先执行前台应用自己的「编辑 ▸ 拷贝」菜单动作，
//    并在原生助手里备份/恢复完整剪贴板 flavors（对齐 SelectedTextKit/Easydict）
// 4) 最后把 Cmd+C 事件直接投递给目标进程，不进入全局事件流
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const { screen, systemPreferences } = require('electron')
const { uIOhook, UiohookKey } = require('uiohook-napi')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function execBin(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err && process.env.GLM_ASK_DEBUG) console.log('[selection] helper exec failed', { code: (err as any).code, signal: (err as any).signal, message: err.message })
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

type GesturePoint = { x: number; y: number }

async function probeDragPasteboards(timeout = 250): Promise<Record<string, number> | null> {
  const helper = helperPath()
  if (!helper) return null
  const raw = await execBin(helper, ['--drag-pasteboards'], timeout)
  if (!raw) return null
  const result = JSON.parse(raw)
  const boards = result?.dragPasteboards || {}
  const counts: Record<string, number> = {}
  for (const [name, board] of Object.entries(boards)) {
    counts[name] = Number((board as any)?.changeCount || 0)
  }
  return counts
}

function dragPasteboardAdvanced(baseline: Record<string, number> | null, current: Record<string, number> | null) {
  if (!baseline || !current) return false
  return Object.keys(current).some(name => current[name] > Number(baseline[name] || 0))
}

async function captureSelection(from?: GesturePoint, to?: GesturePoint, options?: { dragPasteboardSeen?: boolean }) {
  // 路径 A：原生助手（AX/Text Marker 直读，不碰剪贴板）
  let helperError = -2
  let helperBundleId = ''
  let helperResult: any = null
  const helper = helperPath()
  if (helper) {
    // Chromium/Electron 偶尔在 mouse-up 后才提交 selectedText/selectedTextRange。
    // 原生助手内部已有短轮询；这里再做空转重试，覆盖焦点/AX tree 更新较慢的应用。
    for (const delay of [0, 100, 220]) {
      if (delay) await sleep(delay)
      const startedAt = Date.now()
      const args = from
        ? (to ? [String(from.x), String(from.y), String(to.x), String(to.y)] : [String(from.x), String(from.y)])
        : []
      const raw = await execBin(helper, args, 900)
      if (process.env.GLM_ASK_DEBUG) console.log('[selection] helper attempt', { delay, elapsed: Date.now() - startedAt, bytes: raw?.length || 0 })
      if (!raw) continue
      try {
        const j: any = JSON.parse(raw)
        helperResult = j
        helperError = j.err ?? 0
        helperBundleId = j.bundleId || ''
        const axText = String(j.text || '')
        if (axText.trim()) {
          return {
            text: axText,
            appName: j.appName || '',
            bundleId: j.bundleId || '',
            axError: helperError,
            simulated: false
          }
        }
      } catch { /* 继续重试 */ }
    }
  }
  const hit: any = helperResult?.hit
  const hitEnd: any = helperResult?.hitEnd
  const focused: any = helperResult?.focused
  const selectedRangeExists = [hit, hitEnd, focused].some(el => Number(el?.selectedTextRange?.length || 0) > 0)
  const nonTextHitRoles = new Set([
    'AXButton', 'AXImage', 'AXSlider', 'AXCheckBox', 'AXRadioButton',
    'AXPopUpButton', 'AXMenuButton', 'AXTabGroup', 'AXToolbar',
    'AXMenuBar', 'AXMenuBarItem', 'AXMenuItem', 'AXDockItem',
    'AXWindow', 'AXSheet'
  ])
  const isKnownNonText = !!hit && nonTextHitRoles.has(hit.role)

  // AX 直读已经拿到文字时，即使某个自绘应用误写了 drag pasteboard，
  // 也必须展示工具条；drag 信号只用于阻止后续复制类动作。
  // drag-and-drop 会在 drag pasteboard 上写入类型；文本划选不会。
  if (options?.dragPasteboardSeen) {
    if (process.env.GLM_ASK_DEBUG) console.log('[selection] drag session seen，跳过复制动作')
    return { text: '', appName: helperResult?.appName || '', bundleId: helperBundleId, axError: helperError, simulated: false }
  }

  if (from && hit && isKnownNonText && !selectedRangeExists) {
    if (process.env.GLM_ASK_DEBUG) console.log('[selection] 非文本拖拽，跳过复制动作', hit)
    return { text: '', appName: helperResult?.appName || '', bundleId: helperBundleId, axError: helperError, simulated: false }
  }

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

  // 路径 B：执行目标应用自己的 Edit ▸ Copy 菜单项。它不像全局 Cmd+C
  // 那样会进入截图/拖拽等场景的事件流；菜单禁用本身也能作为“无选区”的
  // 强信号。这里不做 AX 文本控件预筛，否则 Safari/自绘文本会继续漏判。
  let menuDiagnostics: any = null
  if (helper) {
    const args = from
      ? (to ? [String(from.x), String(from.y), String(to.x), String(to.y)] : [String(from.x), String(from.y)])
      : []
    const startedAt = Date.now()
    const raw = await execBin(helper, [...args, '--force-menu-copy'], 1800)
    if (process.env.GLM_ASK_DEBUG) console.log('[selection] menu-copy attempt', { elapsed: Date.now() - startedAt, bytes: raw?.length || 0 })
    if (raw) {
      try {
        const j: any = JSON.parse(raw)
        helperResult = j
        helperError = j.err ?? helperError
        helperBundleId = j.bundleId || helperBundleId
        menuDiagnostics = j.menu || null
        const menuText = String(j.text || '')
        if (menuText.trim()) {
          return {
            text: menuText,
            appName: j.appName || '',
            bundleId: j.bundleId || '',
            axError: 0,
            simulated: true,
            strategy: 'menu-action'
          }
        }
      } catch {}
    }
  }

  // 菜单项存在但显式禁用：目标应用已确认当前没有可复制选区，不要再注入
  // Cmd+C（避免提示音、Finder 激活和对象误复制）。
  if (menuDiagnostics?.enabled === false) {
    if (process.env.GLM_ASK_DEBUG) console.log('[selection] Copy 菜单禁用，跳过 Cmd+C', menuDiagnostics)
    return {
      text: '',
      appName: helperResult?.appName || '',
      bundleId: helperBundleId,
      axError: helperError,
      simulated: false,
      strategy: 'menu-action'
    }
  }

  // 路径 C：把 Cmd+C 直接投递给目标进程。与 osascript 全局 keystroke 不同，
  // 它不会激活 Finder，也不会进入截图/其他全局工具的事件流。
  if (helper) {
    const args = from
      ? (to ? [String(from.x), String(from.y), String(to.x), String(to.y)] : [String(from.x), String(from.y)])
      : []
    const startedAt = Date.now()
    const raw = await execBin(helper, [...args, '--shortcut-copy'], 1800)
    if (process.env.GLM_ASK_DEBUG) console.log('[selection] shortcut-copy attempt', { elapsed: Date.now() - startedAt, bytes: raw?.length || 0 })
    if (raw) {
      try {
        const j: any = JSON.parse(raw)
        const shortcutText = String(j.text || '')
        if (process.env.GLM_ASK_DEBUG) console.log('[selection] shortcut-copy result', { length: shortcutText.length, menu: j.menu })
        if (shortcutText.trim()) {
          return {
            text: shortcutText,
            appName: j.appName || helperResult?.appName || '',
            bundleId: j.bundleId || helperBundleId,
            axError: 0,
            simulated: true,
            strategy: 'shortcut'
          }
        }
      } catch {}
    }
  }

  return {
    text: '',
    appName: helperResult?.appName || '',
    bundleId: helperBundleId,
    axError: helperError,
    simulated: false,
    strategy: menuDiagnostics ? 'menu-action' : 'none'
  }
}

// ---------- 全局鼠标手势 ----------
// 拖选（位移 ≥ 3px 且时长 ≥ 20ms）与双击/三击/键盘选词都会触发捕获；
// 是否弹工具条由捕获结果决定（未复制出文本就不弹）——截图框选、拖图标、
// 拖窗口等操作不会误弹。
const DRAG_MIN = 3
  let downPoint = null
  let dragPasteboardSeen = false
  let dragPasteboardBaseline: Record<string, number> | null = null
  let dragProbeSession = 0
  let dragProbeTimer: any = null
  let dragProbeRunning = false
  let lastClick = null // { t, x, y, count }
let hookRunning = false
let retryTimer = null
let lastMousePoint: GesturePoint | null = null

function hasAccessibilityPermission() {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    // 老版本 Electron 没有该 API 时保持原行为。
    return true
  }
}

function tryStartHook() {
  // uiohook-napi 在未授权的打包进程中可能卡死在 hook_enable 的
  // uv_thread_join，不能直接在主线程试探；先走 Electron 的 TCC 检查。
  if (!hasAccessibilityPermission()) return false
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

function initSelection({ onPress, onGesture, onHotkeyKeys, onScreenshotTrigger, onScreenshotCancel, onSwitchSpace }: any) {
  let lastHotkeyDown = 0
  let lastShotDown = 0
  let selectionTriggerTimer: any = null
  const selectionNavigationKeys = new Set([
    UiohookKey.ArrowLeft, UiohookKey.ArrowRight, UiohookKey.ArrowUp, UiohookKey.ArrowDown,
    UiohookKey.Home, UiohookKey.End, UiohookKey.PageUp, UiohookKey.PageDown
  ])

  const selectionKeyDelay = (e: any) => {
    if (e.keycode === UiohookKey.C && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) return 180
    if (e.keycode === UiohookKey.A && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) return 180
    if (e.shiftKey && selectionNavigationKeys.has(e.keycode)) return 180
    return 0
  }

  const scheduleSelectionProbe = (delay: number) => {
    if (selectionTriggerTimer) clearTimeout(selectionTriggerTimer)
    selectionTriggerTimer = setTimeout(() => {
      selectionTriggerTimer = null
      const pt = lastMousePoint || screen.getCursorScreenPoint()
      onGesture({ x: pt.x, y: pt.y }, 'keyboard')
    }, delay)
  }

  try {
    uIOhook.on('mousemove', e => {
      lastMousePoint = { x: e.x, y: e.y }
    })
    uIOhook.on('mousedown', e => {
      if (e.button !== 1) return
      if (process.env.GLM_ASK_DEBUG) console.log('[selection] mousedown', { x: e.x, y: e.y })
      downPoint = { x: e.x, y: e.y, t: Date.now() }
      dragPasteboardSeen = false
      dragPasteboardBaseline = null
      const session = ++dragProbeSession
      if (!dragProbeTimer) {
        const probe = async () => {
          if (dragProbeRunning) return
          dragProbeRunning = true
          try {
            const current = await probeDragPasteboards()
            if (session !== dragProbeSession) return
            if (!dragPasteboardBaseline) {
              dragPasteboardBaseline = current
            } else if (dragPasteboardAdvanced(dragPasteboardBaseline, current)) {
              dragPasteboardSeen = true
            }
          } catch {} finally {
            dragProbeRunning = false
          }
        }
        void probe()
        dragProbeTimer = setInterval(probe, 120)
      }
      onPress({ x: e.x, y: e.y })
    })
    uIOhook.on('mouseup', e => {
      if (e.button !== 1 || !downPoint) return
      const from = downPoint
      downPoint = null
      dragProbeSession++
      if (dragProbeTimer) {
        clearInterval(dragProbeTimer)
        dragProbeTimer = null
      }
      const dist = Math.hypot(e.x - from.x, e.y - from.y)
      const dur = Date.now() - from.t
      if (process.env.GLM_ASK_DEBUG) console.log('[selection] mouseup', { x: e.x, y: e.y, dist, dur, dragPasteboardSeen })
      if (dist >= DRAG_MIN && dur >= 20) {
        onGesture({ x: e.x, y: e.y }, 'drag', from, dragPasteboardSeen)
        return
      }
      // 双击/三击选词：450ms 内同点连续点击
      const now = Date.now()
      if (lastClick && now - lastClick.t < 450 && Math.hypot(e.x - lastClick.x, e.y - lastClick.y) < 40) {
        lastClick.count++
        lastClick.t = now
        if (lastClick.count >= 2) onGesture({ x: e.x, y: e.y }, 'multiclick', from, dragPasteboardSeen)
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
      const selectionDelay = selectionKeyDelay(e)
      if (selectionDelay) {
        // uiohook 在部分前台应用里收不到 keyup；在 keydown（含按住重复）上
        // 做防抖，松手/组合键完成后自然触发一次探测。
        scheduleSelectionProbe(selectionDelay)
      }
      if (isShotCombo) {
        if (selectionTriggerTimer) clearTimeout(selectionTriggerTimer)
        if (now - lastShotDown > 1000) {
          lastShotDown = now
          onScreenshotTrigger && onScreenshotTrigger()
        }
        return
      }
      if ((e.keycode === UiohookKey.Escape || e.keycode === UiohookKey.Enter) && !e.metaKey && !e.altKey && !e.ctrlKey) {
        if (selectionTriggerTimer) clearTimeout(selectionTriggerTimer)
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
  // 首次执行新签名的原生二进制可能触发 macOS 校验，超过 mousedown 后的 250ms
  // 探测窗口。启动时预热一次，避免第一次对象拖拽因 baseline 缺失而误判。
  void probeDragPasteboards(1000).catch(() => {})
  const permission = hasAccessibilityPermission()
  const hookStarted = tryStartHook()
  if (process.env.GLM_ASK_DEBUG) console.log('[selection] boot', { permission, hookStarted })
  return { hookStarted }
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

export {}
