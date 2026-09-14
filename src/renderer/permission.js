const els = {
  targetApp: document.getElementById('target-app'),
  targetApp2: document.getElementById('target-app2'),
  openPane: document.getElementById('open-pane'),
  recheck: document.getElementById('recheck'),
  later: document.getElementById('later'),
  status: document.getElementById('status')
}

async function init() {
  try {
    const info = await window.cfgAPI.appInfo()
    const name = info.packaged ? 'GLM问问' : info.name
    els.targetApp.textContent = name
    els.targetApp2.textContent = name
    if (!info.packaged) {
      els.status.textContent = '当前为开发模式：需要勾选运行本应用的终端 App（如 ZCode / Terminal / iTerm）。'
      els.status.className = 'status fail'
    }
  } catch {}
}

els.openPane.onclick = async () => {
  await window.cfgAPI.openAccessibilityPane()
  els.status.textContent = '系统设置已打开：找到并勾选对应应用后，点击「重新检测」。'
  els.status.className = ''
}

els.recheck.onclick = async () => {
  els.recheck.disabled = true
  els.status.textContent = '检测中…'
  els.status.className = ''
  const r = await window.cfgAPI.checkPermission()
  els.recheck.disabled = false
  if (r.granted) {
    els.status.textContent = '✅ 权限已生效，划词工具条已激活！'
    els.status.className = 'status ok'
    setTimeout(() => window.cfgAPI.closeWindow(), 900)
  } else {
    els.status.textContent = '❌ 仍未检测到权限。若已打开开关但检测失败：先关闭开关再重新打开一次，或重启本应用。'
    els.status.className = 'status fail'
  }
}

els.later.onclick = () => window.cfgAPI.closeWindow()

init()
