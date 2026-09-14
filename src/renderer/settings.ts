;(function () {
const $ = s => document.querySelector(s)
const els = {
  apiKey: $('#api-key'),
  baseSelect: $('#base-select'),
  baseCustom: $('#base-custom'),
  modelList: $('#model-list'),
  newModel: $('#new-model'),
  blacklist: $('#blacklist'),
  hotkey: $('#hotkey-enabled'),
  openAtLogin: $('#open-at-login'),
  hotkeyStatus: $('#hotkey-status'),
  permResult: $('#perm-result'),
  testResult: $('#test-result')
}

const PRESET_URLS = [
  'https://open.bigmodel.cn/api/paas/v4',
  'https://open.bigmodel.cn/api/coding/paas/v4',
  'https://api.z.ai/api/paas/v4',
  'https://api.z.ai/api/coding/paas/v4'
]

let cfg = null

async function load() {
  cfg = await window.cfgAPI.get()
  els.apiKey.value = cfg.apiKey || ''
  if (PRESET_URLS.includes(cfg.baseUrl)) {
    els.baseSelect.value = cfg.baseUrl
    els.baseCustom.classList.add('hidden')
  } else {
    els.baseSelect.value = 'custom'
    els.baseCustom.classList.remove('hidden')
    els.baseCustom.value = cfg.baseUrl
  }
  els.hotkey.checked = cfg.hotkeyEnabled !== false
  els.openAtLogin.checked = cfg.openAtLogin === true
  if (cfg.hotkeyRegistered === false) {
    els.hotkeyStatus.textContent = 'Command + Shift + Space（⚠ 注册失败：可能被其他应用占用，稍后自动重试）'
    els.hotkeyStatus.style.color = '#d54941'
  }
  renderModels()
  renderBlacklist()
}

function collect() {
  const baseUrl = els.baseSelect.value === 'custom'
    ? (els.baseCustom.value.trim() || PRESET_URLS[0])
    : els.baseSelect.value
  return {
    apiKey: els.apiKey.value.trim(),
    baseUrl,
    models: cfg.models,
    model: cfg.model,
    blacklist: cfg.blacklist,
    hotkeyEnabled: els.hotkey.checked,
    openAtLogin: els.openAtLogin.checked
  }
}

function renderModels() {
  els.modelList.innerHTML = ''
  if (!cfg.models.length) {
    els.modelList.innerHTML = '<div class="hint">暂无模型，请添加</div>'
    return
  }
  cfg.models.forEach((m, i) => {
    const item = document.createElement('div')
    item.className = 'model-item'
    const mid = document.createElement('span')
    mid.className = 'mid'
    mid.textContent = m
    item.appendChild(mid)
    if (m === cfg.model) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = '默认'
      item.appendChild(badge)
    } else {
      const set = document.createElement('button')
      set.textContent = '设为默认'
      set.onclick = () => { cfg.model = m; renderModels() }
      item.appendChild(set)
    }
    const del = document.createElement('button')
    del.textContent = '删除'
    del.className = 'danger'
    del.onclick = () => {
      cfg.models.splice(i, 1)
      if (cfg.model === m && cfg.models.length) cfg.model = cfg.models[0]
      renderModels()
    }
    item.appendChild(del)
    els.modelList.appendChild(item)
  })
}

function renderBlacklist() {
  els.blacklist.innerHTML = ''
  if (!cfg.blacklist.length) {
    els.blacklist.innerHTML = '<span class="empty">暂无（在划词工具条的下拉菜单中可禁用当前应用）</span>'
    return
  }
  cfg.blacklist.forEach((bid, i) => {
    const item = document.createElement('span')
    item.className = 'bl-item'
    item.textContent = bid
    const del = document.createElement('button')
    del.textContent = '×'
    del.onclick = () => { cfg.blacklist.splice(i, 1); renderBlacklist() }
    item.appendChild(del)
    els.blacklist.appendChild(item)
  })
}

$('#toggle-key').onclick = () => {
  const show = els.apiKey.type === 'password'
  els.apiKey.type = show ? 'text' : 'password'
  $('#toggle-key').textContent = show ? '隐藏' : '显示'
}

els.baseSelect.onchange = () => {
  els.baseCustom.classList.toggle('hidden', els.baseSelect.value !== 'custom')
}

$('#add-model').onclick = () => {
  const v = els.newModel.value.trim()
  if (!v) return
  if (cfg.models.includes(v)) return
  cfg.models.push(v)
  if (!cfg.model) cfg.model = v
  els.newModel.value = ''
  renderModels()
}
$('#new-model').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#add-model').click()
})

$('#check-perm').onclick = async () => {
  els.permResult.textContent = '检测中…'
  const r = await window.cfgAPI.checkPermission()
  els.permResult.textContent = r.granted
    ? '✅ 辅助功能权限正常，划词工具条已激活。'
    : `❌ ${r.hint || '未获得辅助功能权限'}。点击「权限引导」按步骤授权（无需重启应用）。`
}

$('#open-guide').onclick = () => window.cfgAPI.openGuide()

$('#test-btn').onclick = async () => {
  const c = collect()
  if (!c.apiKey) {
    els.testResult.textContent = '请先填写 API Key'
    els.testResult.className = 'fail'
    return
  }
  els.testResult.textContent = '测试中…'
  els.testResult.className = ''
  const r = await window.cfgAPI.test({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.models[0] || c.model })
  if (r.ok) {
    els.testResult.textContent = `✅ 连接成功（模型 ${c.models[0] || c.model} 返回：${r.sample || ''}）`
    els.testResult.className = 'ok'
  } else {
    els.testResult.textContent = `❌ ${r.error}`
    els.testResult.className = 'fail'
  }
}

$('#save-btn').onclick = async () => {
  await window.cfgAPI.save(collect())
  // 保存是同步落盘的 IPC；成功后立即收起，不做额外等待。
  window.cfgAPI.closeWindow()
}

load()
})();
