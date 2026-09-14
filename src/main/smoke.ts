// smoke 自检：用示例数据渲染三个窗口并截图到 /tmp/glm-ask-smoke，用于无交互验证 UI
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const store = require('./store')

const sleep = ms => new Promise(r => setTimeout(r, ms))

module.exports = function runSmoke(deps) {
  const { openAsk, showToolbar, openSettings, checkAccessibility, openPermissionGuide, localAgentsSummary } = deps
  const dir = '/tmp/glm-ask-smoke'
  const out: any = { steps: [], pngs: {}, failed: false }

  // 兜底强退
  setTimeout(() => { app.exit(0) }, 45000).unref()

  app.whenReady().then(async () => {
    fs.mkdirSync(dir, { recursive: true })

    // vendor 依赖检查
    for (const f of ['marked.min.js', 'purify.min.js']) {
      const p = path.join(__dirname, '..', 'renderer', 'vendor', f)
      out.steps.push(`vendor ${f}: ${fs.existsSync(p) ? 'OK' : 'MISSING'}`)
    }

    // 全局鼠标钩子加载（打包后 asar 环境验证）
    try {
      const { uIOhook } = require('uiohook-napi')
      uIOhook.start()
      await sleep(300)
      uIOhook.stop()
      out.steps.push('uiohook: OK')
    } catch (e) {
      out.steps.push('uiohook: FAIL ' + e.message)
    }

    // 权限探测
    try {
      out.steps.push('ax probe: ' + JSON.stringify(await checkAccessibility()))
    } catch (e) {
      out.steps.push('ax probe error: ' + e.message)
    }

    try {
      const local = await localAgentsSummary()
      const found = local.available.length > 0 && local.totals.skills + local.totals.mcps + local.totals.plugins > 0
      out.steps.push(`local-agents: ${found ? `OK (${local.available.join('/')}；skills ${local.totals.skills}, mcp ${local.totals.mcps}, plugins ${local.totals.plugins})` : 'SKIP (no local agent ecosystem)'}`)
    } catch (e) {
      out.failed = true
      out.steps.push('local-agents: FAIL ' + e.message)
    }

    // 1) ask 窗口：示例会话
    const demo = {
      demo: true,
      config: { model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'glm-5.3'], hasKey: true },
      messages: [
        {
          id: 'd1', role: 'user', text: '帮我看下这段代码有什么问题？', quote: 'const arr = [1,2,3]\nconsole.log(arr[3])', images: [], files: []
        },
        {
          id: 'd2', role: 'assistant', done: true,
          reasoning: '用户访问了数组越界的元素 arr[3]，数组长度为 3，最大下标是 2。',
          text: '这段代码会输出 `undefined`，**不会报错**。\n\n## 原因\n\nJavaScript 中访问超出数组长度的下标不会抛出异常，而是返回 `undefined`：\n\n```js\nconst arr = [1, 2, 3]\nconsole.log(arr.length) // 3\nconsole.log(arr[3])     // undefined\n```\n\n## 建议\n\n- 访问前先判断下标：`if (i < arr.length)`\n- 或使用 `arr.at(3)` 同样返回 `undefined`\n- 需要报错提醒时可以用类型检查或断言库'
        }
        ,
        {
          id: 'd3', role: 'assistant', done: true,
          text: 'HTML 渲染测试：\n\n```html\n<!doctype html>\n<html><body style="font:600 28px system-ui;display:grid;place-items:center;gap:24px;margin:0"><div>HTML Render OK</div><div style="width:80%;height:80px;overflow:auto;border:1px solid #ddd"><div style="height:320px;display:grid;place-items:center">Scroll Area Unlocked</div></div></body></html>\n```'
        }
      ]
    }
    const askWin = openAsk(demo)
    await sleep(1600)
    await askWin.setSize(920, 720)
    await sleep(450)
    // 等待“短暂跨桌面唤起 → 退出集合”的流程完成。
    await sleep(120)
    const saved = store.loadConfig()
    const sizeOk = saved.askWidth === 920 && saved.askHeight === 720
    out.steps.push(`ask-size-persist: ${sizeOk ? 'OK' : `FAIL (${saved.askWidth}x${saved.askHeight})`}`)
    if (!sizeOk) out.failed = true
    // panel 必须全 Space 可达；触控板/键盘切 Space 由手势钩子立即 hide。
    const reachable = askWin.isVisibleOnAllWorkspaces()
    out.steps.push(`ask-space-reachable: ${reachable ? 'OK' : 'FAIL (not available on all spaces)'}`)
    if (!reachable) out.failed = true
    await sleep(250)
    try {
      const focused = await askWin.webContents.executeJavaScript(`document.activeElement && document.activeElement.id || ''`)
      out.steps.push(`ask-input-autofocus: ${focused === 'input' ? 'OK' : `FAIL (${focused || 'none'})`}`)
      if (focused !== 'input') out.failed = true
    } catch (e) {
      out.failed = true
      out.steps.push('ask-input-autofocus: FAIL ' + e.message)
    }
    await snap('ask', askWin)
    // 滚动到顶部，验证用户消息底部操作栏
    await askWin.webContents.executeJavaScript("document.querySelector('#scroll').scrollTo(0,0)")
    await sleep(300)
    await snap('ask-top', askWin)
    out.steps.push('ask alwaysOnTop(置顶): ' + (askWin.isAlwaysOnTop() ? 'OK' : 'FAIL'))

    try {
      await sleep(300)
      const rendered = await askWin.webContents.executeJavaScript(`!!document.querySelector('.html-preview')`)
      out.steps.push(`html-render: ${rendered ? 'OK' : 'FAIL (preview missing)'}`)
      if (!rendered) out.failed = true
      const preview = await askWin.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector('.html-preview')
        return frame ? { height: Number.parseInt(frame.style.height, 10) || 0, scrolling: frame.getAttribute('scrolling') } : null
      })()`)
      const autoHeight = !!preview && preview.height >= 280 && preview.scrolling === 'no'
      out.steps.push(`html-auto-height: ${autoHeight ? 'OK' : `FAIL (${JSON.stringify(preview)})`}`)
      if (!autoHeight) out.failed = true
      // 完整 HTML 文档自动渲染；再验证可切回源码/渲染双向切换。
      await askWin.webContents.executeJavaScript(`document.querySelector('.html-render-btn')?.click()`)
      await sleep(120)
      const backToSource = await askWin.webContents.executeJavaScript(`!document.querySelector('.html-preview')`)
      out.steps.push(`html-render-toggle: ${backToSource ? 'OK' : 'FAIL'}`)
      if (!backToSource) out.failed = true
      await askWin.webContents.executeJavaScript(`document.querySelector('.html-render-btn')?.click()`)
      await askWin.webContents.executeJavaScript(`document.querySelector('.html-render-btn')?.click()`)
    } catch (e) {
      out.failed = true
      out.steps.push('html-render: FAIL ' + e.message)
    }

    // 2) 工具条
    showToolbar({ text: 'GLM-5.3-Flash 是 GLM-5 系列首个原生多模态模型，适合代码生成、代码理解、问题修复等代码任务。', appName: 'Safari' }, { x: 300, y: 300 })
    await sleep(900)
    await snap('toolbar', global.__toolbarWinRef)
    await assertToolbarFit('down')

    // 打开下拉菜单状态
    global.__toolbarWinRef?.webContents.executeJavaScript('document.querySelector(".more-btn").click()')
    await sleep(600)
    await snap('toolbar-menu', global.__toolbarWinRef)
    await assertToolbarFit('down-menu')

    // 底边反向弹出：展开菜单时药丸的屏幕 Y 必须保持不动
    const display = require('electron').screen.getPrimaryDisplay()
    showToolbar({ text: '底边反向弹出', appName: 'Safari' }, { x: 300, y: display.workArea.y + display.workArea.height - 100 })
    await sleep(700)
    global.__toolbarWinRef?.webContents.executeJavaScript('document.querySelector(".more-btn").click()')
    await sleep(600)
    await snap('toolbar-menu-up', global.__toolbarWinRef)
    await assertToolbarFit('up-menu')

    // 3) 设置窗口
    const sw = openSettings()
    await sleep(1200)
    await snap('settings', sw)
    out.steps.push('settings alwaysOnTop: ' + (sw.isAlwaysOnTop() ? 'OK' : 'FAIL'))

    // 4) 权限引导窗口
    const pw = openPermissionGuide()
    await sleep(900)
    await snap('permission', pw)

    // 5) 「保存后自动关闭」端到端：真实点击保存按钮，断言窗口随后隐藏
    try {
      await sw.webContents.executeJavaScript("document.querySelector('#save-btn').click()")
      await sleep(900)
      const closed = !sw.isVisible()
      out.steps.push('save-closes-settings: ' + (closed ? 'OK' : 'FAIL'))
    } catch (e) {
      out.steps.push('save-closes-settings: FAIL ' + e.message)
    }

    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(out, null, 2))
    if (out.failed) console.error('[smoke] FAILED:\n' + out.steps.filter(s => s.includes(': FAIL')).join('\n'))
    setTimeout(() => app.exit(0), 500)
  })

  async function snap(name, win) {
    try {
      if (!win || win.isDestroyed()) throw new Error('no window')
      if (!win.isVisible()) win.showInactive ? win.showInactive() : win.show()
      await sleep(300)
      const img = await win.webContents.capturePage()
      const buf = img.toPNG()
      if (buf.length < 800) throw new Error('capture too small: ' + buf.length)
      fs.writeFileSync(path.join(dir, name + '.png'), buf)
      out.pngs[name] = buf.length
      out.steps.push(`snap ${name}: OK (${buf.length} bytes)`)
    } catch (e) {
      out.steps.push(`snap ${name}: FAIL ${e.message}`)
    }
  }

  // 验证渲染层尺寸上报、主进程窗口贴合和展开菜单时的药丸锚定。
  async function assertToolbarFit(caseName) {
    const win = global.__toolbarWinRef
    try {
      if (!win || win.isDestroyed()) throw new Error('toolbar missing')
      const b = win.getBounds()
      const hit = win.__hitRel
      const dom = await win.webContents.executeJavaScript(`(() => {
        const pill = document.getElementById('pill').getBoundingClientRect()
        const dd = document.getElementById('dropdown')
        const ddr0 = dd.classList.contains('hidden') ? null : dd.getBoundingClientRect()
        const ddr = ddr0 ? { x: ddr0.x, y: ddr0.y, width: ddr0.width, height: ddr0.height } : null
        return { pill: { x: pill.x, y: pill.y, width: pill.width, height: pill.height }, dropdown: ddr }
      })()`)
      const contentTop = dom.dropdown ? Math.min(dom.pill.y, dom.dropdown.y) : dom.pill.y
      const checks = [
        Math.abs(hit.x - 8) <= 1,
        Math.abs(hit.y - contentTop) <= 1,
        Math.abs(hit.w - dom.pill.width) <= 1,
        Math.abs(hit.h - dom.pill.height - (dom.dropdown ? 10 + dom.dropdown.height : 0)) <= 1,
        Math.abs(b.width - dom.pill.width - 16) <= 1,
        b.x + hit.x >= b.x,
        b.x + hit.x + hit.w <= b.x + b.width + 1,
        b.y + hit.y + hit.h <= b.y + b.height + 1
      ]
      if (!checks.every(Boolean)) throw new Error(`bounds=${JSON.stringify(b)} pillY=${win.__pillY} hit=${JSON.stringify(hit)} dom=${JSON.stringify(dom)}`)
      out.steps.push(`toolbar-fit ${caseName}: OK`)
    } catch (e) {
      out.failed = true
      out.steps.push(`toolbar-fit ${caseName}: FAIL ${e.message}`)
    }
  }
}

export {}
