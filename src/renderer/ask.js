/* 问一问弹窗渲染层：豆包风格交互
   - 引用选中内容提问 / 自动追问（弹窗内划词）
   - 流式回复（含思考过程）、终止、重新生成
   - 编辑用户消息并重发
   - 图片（多模态）与文本文件附件
   - 新话题 / 历史话题 / 模型切换 */
const $ = s => document.querySelector(s)

const els = {
  thread: $('#thread'),
  scroll: $('#scroll'),
  input: $('#input'),
  chips: $('#chips'),
  quoteChip: $('#quote-chip'),
  quoteText: $('#quote-text'),
  attachChips: $('#attach-chips'),
  btnSend: $('#btn-send'),
  btnModel: $('#btn-model'),
  modelLabel: $('#model-label'),
  modelMenu: $('#model-menu'),
  btnEffort: $('#btn-effort'),
  effortLabel: $('#effort-label'),
  effortMenu: $('#effort-menu'),
  btnAgent: $('#btn-agent'),
  agentMenu: $('#agent-menu'),
  plusMenu: $('#plus-menu'),
  moreMenu: $('#more-menu'),
  historyPanel: $('#history-panel'),
  historyList: $('#history-list'),
  banner: $('#banner'),
  selbar: $('#selbar'),
  toast: $('#toast'),
  btnPin: $('#btn-pin'),
  imgInput: $('#img-input'),
  fileInput: $('#file-input'),
  imageMenu: $('#image-menu'),
  imagePreview: $('#image-preview'),
  previewImg: $('#preview-img')
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

let config = { model: 'glm-5.3-flash', models: ['glm-5.3-flash'], effort: 'max', hasKey: true, localAgent: 'auto', agentExec: true }
let agentSummary = null
const sessions = new Map()
let session = newSession()
sessions.set(session.id, session)
let pending = session.draft // 当前话题的待发送引用与附件
let toastTimer = null
let intentPending = false

function newSession() {
  return {
    id: uid(),
    title: '新话题',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    draft: { text: '', quote: '', images: [], files: [] },
    streamingReqId: null
  }
}

function normalizeSession(s) {
  s.messages = s.messages || []
  s.draft = {
    text: s.draft?.text || '',
    quote: s.draft?.quote || '',
    images: [...(s.draft?.images || [])],
    files: [...(s.draft?.files || [])]
  }
  s.streamingReqId = null
  return s
}

function activeStream(target = session) {
  return !!target.streamingReqId
}

function readDraft() {
  return {
    text: els.input.value,
    quote: pending.quote || '',
    images: [...(pending.images || [])],
    files: [...(pending.files || [])]
  }
}

function writeDraft(draft = {}) {
  pending = session.draft
  pending.text = draft.text || ''
  pending.quote = draft.quote || ''
  pending.images = [...(draft.images || [])]
  pending.files = [...(draft.files || [])]
  els.input.value = pending.text
  autoGrow()
  renderAttachChips()
  updateSendBtn()
}

function syncDraft() {
  session.draft = readDraft()
  pending = session.draft
}

/* ---------------- 工具 ---------------- */
function toast(msg, ms = 2200) {
  els.toast.textContent = msg
  els.toast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms)
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

const PRESETS = {
  summary: { label: '总结', tpl: q => `请总结以下内容的要点，用简洁清晰的列表输出：\n\n${q}` },
  translate: { label: '翻译', tpl: q => `请将以下内容翻译成中文；如果原文已是中文，请翻译成英文。只输出译文，不要解释：\n\n${q}` },
  explain: { label: '解释', tpl: q => `请解释以下内容的含义，尽量通俗易懂，必要时举例：\n\n${q}` }
}

function buildUserContent(m) {
  let text = m.text || ''
  if (m.preset && PRESETS[m.preset]) {
    text = PRESETS[m.preset].tpl(m.quote || '')
  } else if (m.quote) {
    text = `[选中的内容]\n${m.quote}\n\n[我的问题]\n${text || '请针对以上选中的内容进行回答'}`
  }
  for (const f of m.files || []) {
    text += f.text != null
      ? `\n\n[附件文件：${f.name}]\n${f.text}`
      : `\n\n[二进制附件：${f.name}；大小 ${Math.max(1, Math.round((f.size || 0) / 1024))}KB；本地路径 ${f.path || '未知'}]`
  }
  return { text, images: m.images || [] }
}

function toApiMessages(messages) {
  const out = [{
    role: 'system',
    content: '你是 GLM 助手。用 Markdown 组织回复，代码放进代码块；回答保持简洁、结构清晰，用中文（除非用户要求其他语言）。'
  }]
  for (const m of messages) {
    if (m.role === 'user') {
      const { text, images } = buildUserContent(m)
      const parts = [{ type: 'text', text }]
      for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
      out.push({ role: 'user', content: parts })
    } else if (typeof m.text === 'string' && m.text) {
      out.push({ role: 'assistant', content: m.text })
    }
  }
  return out
}

function mdToHtml(src) {
  try {
    return DOMPurify.sanitize(marked.parse(src || '', { gfm: true, breaks: true }))
  } catch {
    return ''
  }
}

function fullHtmlSource(src) {
  const match = String(src || '').match(/```(?:html?|svg)\s*\n([\s\S]+?)\n```/i)
  const source = match ? match[1] : ''
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(source) ? source : ''
}

// 预览源码运行在 unique-origin 沙箱里，不能直接读 document。
// 注入一个极小的 reporter：展开源页面里固定高度/滚动的容器，
// 然后通过 postMessage 把真实内容高度同步给父窗口。
function buildHtmlPreviewSource(source) {
  const raw = String(source || '')
  // 源页面自己的 CSP 可能禁止这段 inline reporter；预览已有沙箱保护，可移除。
  const clean = raw.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    ''
  )
  const runtime = `<script>(function(){
    var lastHeight = -1, raf = 0;
    function naturalHeight() {
      var d = document.documentElement, b = document.body;
      return Math.ceil(Math.max(
        d ? d.scrollHeight || 0 : 0,
        b ? b.scrollHeight || 0 : 0,
        d ? d.getBoundingClientRect().bottom + (window.scrollY || 0) : 0,
        b ? b.getBoundingClientRect().bottom + (window.scrollY || 0) : 0
      ));
    }
    function unlockScrollAreas() {
      [document.documentElement, document.body].forEach(function(el) {
        if (!el) return;
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('min-height', '0', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
      });
      Array.prototype.forEach.call(document.querySelectorAll('*'), function(el) {
        var cs;
        try { cs = getComputedStyle(el); } catch (e) { return; }
        if (!cs || !/(auto|scroll)/i.test(cs.overflowY)) return;
        if (el.scrollHeight <= el.clientHeight + 2) return;
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('min-height', '0', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
      });
    }
    function sync() {
      unlockScrollAreas();
      var h = naturalHeight();
      if (Math.abs(h - lastHeight) > 1) {
        lastHeight = h;
        parent.postMessage({ __glmHtmlPreview: true, height: h }, '*');
      }
    }
    function schedule() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function() {
        raf = 0;
        sync();
        setTimeout(sync, 60);
        setTimeout(sync, 250);
      });
    }
    if (window.ResizeObserver && document.documentElement) {
      new ResizeObserver(schedule).observe(document.documentElement);
    }
    if (window.MutationObserver && document.documentElement) {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
    }
    window.addEventListener('resize', schedule);
    document.addEventListener('DOMContentLoaded', schedule);
    window.addEventListener('load', schedule);
    schedule();
  })();<\/script>`

  if (/<\/head\s*>/i.test(clean)) return clean.replace(/<\/head\s*>/i, runtime + '</head>')
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head[^>]*>/i, match => match + runtime)
  if (/<html[^>]*>/i.test(clean)) return clean.replace(/<html[^>]*>/i, match => match + '<head>' + runtime + '</head>')
  if (/<!doctype\s+html\s*>/i.test(clean)) return clean.replace(/<!doctype\s+html\s*>/i, match => match + runtime)
  return runtime + clean
}

function enhanceCode(container, autoRender = false) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.__enhanced) return
    pre.__enhanced = true
    const code = pre.querySelector('code')
    const source = (code || pre).textContent || ''
    const langMatch = code ? code.className.match(/language-([\w+-]+)/) : null
    const lang = langMatch ? langMatch[1] : ''
    const isHtml = /^(html?|svg|vue|jsx|tsx)$/i.test(lang) ||
      /^\s*<!doctype\s+html\s*>/i.test(source) ||
      /^\s*<html[\s>]/i.test(source)
    const wrap = document.createElement('div')
    wrap.className = 'codewrap'
    if (isHtml) wrap.classList.add('html-capable')
    const bar = document.createElement('div')
    bar.className = 'code-bar'
    bar.innerHTML = `<span>${lang}</span>`
    const btn = document.createElement('button')
    let htmlRenderBtn = null
    btn.textContent = '复制代码'
    btn.onclick = async () => {
      await window.askAPI.copyText(code ? code.textContent : pre.textContent)
      btn.textContent = '已复制'
      setTimeout(() => (btn.textContent = '复制代码'), 1200)
    }
    bar.appendChild(btn)
    if (isHtml) {
      // HTML 代码块支持在沙箱 iframe 中直接渲染；默认仍显示源码，
      // 避免把模型解释里的示例代码突然替换成页面。
      htmlRenderBtn = document.createElement('button')
      htmlRenderBtn.className = 'html-render-btn'
      htmlRenderBtn.textContent = '渲染'
      htmlRenderBtn.onclick = () => {
        const preview = wrap.querySelector('.html-preview')
        if (preview) {
          preview.remove()
          pre.style.display = ''
          htmlRenderBtn.textContent = '渲染'
          wrap.classList.remove('rendering')
          return
        }
        const frame = document.createElement('iframe')
        frame.className = 'html-preview'
        frame.title = 'HTML 预览'
        // 高度由 reporter 同步；预览自身不产生第二个滚动容器。
        frame.style.height = '120px'
        frame.setAttribute('scrolling', 'no')
        // 不给 allow-same-origin：脚本在唯一 origin 中执行，无法访问 Electron
        // API、父窗口或本机资源；这里保留 scripts/forms/popups 支持真实 demo。
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
        frame.srcdoc = buildHtmlPreviewSource(source)
        const syncHeight = event => {
          if (event.source !== frame.contentWindow || !event.data?.__glmHtmlPreview) return
          const height = Number(event.data.height)
          if (Number.isFinite(height) && height > 0) {
            frame.style.height = `${Math.min(Math.max(Math.ceil(height), 120), 24000)}px`
          }
        }
        window.addEventListener('message', syncHeight)
        pre.style.display = 'none'
        wrap.classList.add('rendering')
        wrap.appendChild(frame)
        htmlRenderBtn.textContent = '源码'
      }
      bar.appendChild(htmlRenderBtn)
    }
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(bar)
    wrap.appendChild(pre)
    if (isHtml && autoRender && !pre.__autoRendered) {
      // 必须等 wrap/pre 的 DOM 顺序完成后再渲染，保证工具栏始终在预览上方。
      pre.__autoRendered = true
      htmlRenderBtn?.click()
    }
  })
}

/* ---------------- 滚动 ---------------- */
function nearBottom() {
  // 只有真正贴底才自动跟随；用户稍微往上翻看历史时保持当前位置。
  return els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight <= 4
}
function stickScroll(stick) {
  if (stick) els.scroll.scrollTop = els.scroll.scrollHeight
}

/* ---------------- 渲染消息 ---------------- */
function renderQuoteBox(q) {
  const box = document.createElement('div')
  box.className = 'u-quote'
  box.textContent = q
  return box
}

function renderMsg(m, idx) {
  const el = document.createElement('div')
  el.className = `msg ${m.role}` + (m.role === 'assistant' && !m.done ? ' streaming' : '')
  el.dataset.id = m.id

  if (m.role === 'user') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (m.quote) bubble.appendChild(renderQuoteBox(m.quote))
    if (m.images && m.images.length) {
      const imgs = document.createElement('div')
      imgs.className = 'u-images'
      for (const src of m.images) {
        const im = document.createElement('img')
        im.src = src
        imgs.appendChild(im)
      }
      bubble.appendChild(imgs)
    }
    if (m.files && m.files.length) {
      const fl = document.createElement('div')
      fl.className = 'u-files'
      for (const f of m.files) {
        const chip = document.createElement('span')
        chip.className = 'file-chip'
        chip.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8L14 2.5z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M14 2.5V8h5.5"/></svg>'
        const name = document.createElement('span')
        name.className = 'fname'
        name.textContent = f.name
        name.title = f.binary ? `${f.path || ''}\n二进制文件（内容未直接注入对话）` : (f.path || f.name)
        chip.appendChild(name)
        fl.appendChild(chip)
      }
      bubble.appendChild(fl)
    }
    const textEl = document.createElement('span')
    textEl.textContent = m.text || ''
    bubble.appendChild(textEl)
    el.appendChild(bubble)
    el.appendChild(buildUserActions(m, idx))
  } else {
    const content = document.createElement('div')
    content.className = 'content'
    if (m.reasoning) content.appendChild(buildReasoning(m))
    const trace = buildToolTrace(m)
    if (trace) content.appendChild(trace)
    const md = document.createElement('div')
    md.className = 'md'
    if (m.text) {
      md.innerHTML = mdToHtml(m.text)
      enhanceCode(md, !!m.done && !!fullHtmlSource(m.text))
    }
    if (!m.done && !m.__started) {
      const dots = document.createElement('div')
      dots.className = 'loading-dots'
      dots.innerHTML = '<i></i><i></i><i></i>'
      md.appendChild(dots)
    }
    if (!m.done && m.__started && Date.now() - (m.__lastEventAt || 0) > 2500) {
      const wait = document.createElement('div')
      wait.className = 'stream-wait'
      wait.innerHTML = '<i></i><i></i><i></i><span>仍在执行…</span>'
      content.appendChild(wait)
    }
    if (m.done && !m.__started && !m.error) {
      const tip = document.createElement('div')
      tip.className = 'stopped-tip'
      tip.textContent = '已停止'
      md.appendChild(tip)
    }
    content.appendChild(md)
    if (m.error) {
      const err = document.createElement('div')
      err.className = 'err'
      const span = document.createElement('span')
      span.textContent = m.error
      const btn = document.createElement('button')
      btn.textContent = '重试'
      btn.onclick = () => retryFromError(m.id)
      err.appendChild(span)
      err.appendChild(btn)
      content.appendChild(err)
    }
    el.appendChild(content)
    el.appendChild(buildActions(m, idx))
    if (m.durationMs != null) {
      const meta = document.createElement('div')
      meta.className = 'reply-meta'
      meta.textContent = `回复耗时 ${formatDuration(m.durationMs)}`
      el.appendChild(meta)
    }
  }
  return el
}

/* 用户消息底部操作栏：常驻显示（复制 / 编辑），不依赖 hover */
function buildUserActions(m, idx) {
  const row = document.createElement('div')
  row.className = 'actions user-actions'
  const copy = document.createElement('button')
  copy.title = '复制'
  copy.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 15H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2V5"/></svg>'
  copy.onclick = () => window.askAPI.copyText(m.text || m.quote || '')
  const edit = document.createElement('button')
  edit.title = '编辑并重新发送'
  edit.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
  edit.onclick = () => {
    // 编辑会截断后续上下文；若当前正在生成，先中断这次生成再进入编辑。
    if (activeStream()) {
      const reqId = session.streamingReqId
      session.streamingReqId = null
      window.askAPI.abort(reqId)
      updateSendBtn()
    }
    startEdit(idx)
  }
  row.appendChild(copy)
  row.appendChild(edit)
  return row
}

function buildActions(m, idx) {
  const row = document.createElement('div')
  row.className = 'actions'
  const copy = document.createElement('button')
  copy.title = '复制'
  copy.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 15H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2V5"/></svg>'
  copy.onclick = () => window.askAPI.copyText(m.text || '')
  const regen = document.createElement('button')
  regen.title = '重新生成'
  regen.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M23 4v6h-6M1 20v-6h6"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'
  regen.onclick = () => regenerate()
  row.appendChild(copy)
  row.appendChild(regen)
  return row
}

function buildReasoning(m) {
  const box = document.createElement('div')
  box.className = 'reasoning' + (m.reasoningCollapsed ? ' collapsed' : '')
  const head = document.createElement('button')
  head.className = 'rs-head'
  head.innerHTML = `<svg viewBox="0 0 24 24" class="chev"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg><span>思考过程</span>`
  head.onclick = () => {
    m.reasoningCollapsed = !m.reasoningCollapsed
    box.classList.toggle('collapsed', m.reasoningCollapsed)
  }
  const body = document.createElement('div')
  body.className = 'rs-body'
  body.textContent = m.reasoning
  box.appendChild(head)
  box.appendChild(body)
  return box
}

function buildToolTrace(m) {
  if (!m.tools?.length) return null
  const groupKey = `group:${m.id}`
  const anyRunning = !m.done && m.tools.some(t => t.state === 'running' || t.state === undefined)
  const anyError = m.tools.some(t => t.state === 'error')
  const groupState = anyRunning ? 'running' : anyError ? 'error' : 'done'
  const groupTitle = anyRunning ? '执行中' : anyError ? '执行失败' : '执行完成'

  const root = document.createElement('details')
  root.className = `tool-trace ${groupState}`
  const groupStartedAt = m.tools
    .map(t => t.startedAt)
    .filter(Boolean)
    .sort((a, b) => a - b)[0] || Date.now()
  root.dataset.startedAt = String(groupStartedAt)
  root.open = toolTraceGroupOpen.has(groupKey)

  const groupHead = document.createElement('summary')
  groupHead.className = 'tool-group-head'
  const groupDot = document.createElement('span')
  groupDot.className = 'tool-dot'
  const groupTitleEl = document.createElement('span')
  groupTitleEl.className = 'tool-title'
  groupTitleEl.textContent = groupTitle
  const groupCount = document.createElement('span')
  groupCount.className = 'tool-count'
  groupCount.textContent = `${m.tools.length} 项`
  const groupChev = document.createElement('span')
  groupChev.className = 'tool-chev'
  groupHead.append(groupDot, groupTitleEl, groupCount, groupChev)
  root.appendChild(groupHead)

  root.addEventListener('toggle', () => {
    if (root.open) toolTraceGroupOpen.add(groupKey)
    else toolTraceGroupOpen.delete(groupKey)
  })

  const list = document.createElement('div')
  list.className = 'tool-list'
  for (const t of m.tools) {
    const key = `${m.id}:${t.id}`
    const row = document.createElement('details')
    const itemState = m.done && (t.state === 'running' || !t.state) ? 'aborted' : (t.state || 'running')
    row.className = `tool-item ${itemState}`
    row.dataset.startedAt = String(t.startedAt || '')
    row.open = toolTraceOpen.has(key)
    const head = document.createElement('summary')
    head.className = 'tool-head'
    const dot = document.createElement('span')
    dot.className = 'tool-dot'
    const title = document.createElement('span')
    title.className = 'tool-title'
    title.textContent = t.title || t.id || '工具调用'
    const state = document.createElement('span')
    state.className = 'tool-state'
    state.textContent = itemState === 'done' ? '已完成'
      : itemState === 'error' ? '失败'
      : itemState === 'aborted' ? '已中止' : '正在运行'
    head.appendChild(dot)
    head.appendChild(title)
    head.appendChild(state)
    const chev = document.createElement('span')
    chev.className = 'tool-chev'
    head.appendChild(chev)
    row.appendChild(head)
    if (t.detail) {
      const detail = document.createElement('pre')
      detail.className = 'tool-detail'
      detail.textContent = String(t.detail).slice(0, 1200)
      row.appendChild(detail)
    }
    row.addEventListener('toggle', () => {
      if (row.open) toolTraceOpen.add(key)
      else toolTraceOpen.delete(key)
    })
    list.appendChild(row)
  }
  root.appendChild(list)
  return root
}

function renderAll() {
  els.thread.innerHTML = ''
  session.messages.forEach((m, i) => els.thread.appendChild(renderMsg(m, i)))
  els.scroll.scrollTop = els.scroll.scrollHeight
}

function refreshMsgEl(m) {
  const stick = nearBottom()
  const prevTop = els.scroll.scrollTop
  const idx = session.messages.indexOf(m)
  const old = els.thread.querySelector(`[data-id="${m.id}"]`)
  if (old) {
    old.replaceWith(renderMsg(m, idx))
    els.scroll.scrollTop = stick ? els.scroll.scrollHeight : prevTop
  }
}

function upsertToolTrace(m, tool) {
  if (!Array.isArray(m.tools)) m.tools = []
  const idx = m.tools.findIndex(x => x.id === tool.id)
  if (idx >= 0) m.tools[idx] = { ...m.tools[idx], ...tool, startedAt: m.tools[idx].startedAt || tool.startedAt }
  else m.tools.push(tool)
  refreshMsgEl(m)
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms || 0) / 1000)
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`
}

/* ---------------- 会话持久化 ---------------- */
async function saveSession(target = session) {
  if (target === session) syncDraft()
  if (!target.messages.length) return
  target.updatedAt = Date.now()
  await window.askAPI.saveSession(JSON.parse(JSON.stringify(target)))
}

/* ---------------- 发送 / 流式 ---------------- */
function updateSendBtn() {
  const hasDraft = !!(els.input.value.trim() || pending.quote || pending.images.length || pending.files.length)
  const stopMode = activeStream() && !hasDraft
  els.btnSend.classList.toggle('stoppable', stopMode)
  els.btnSend.querySelector('.send-arrow').classList.toggle('hidden', stopMode)
  els.btnSend.querySelector('.send-stop').classList.toggle('hidden', !stopMode)
  els.btnSend.title = intentPending ? '意图识别中…'
    : stopMode ? '停止生成'
    : activeStream() ? '发送补充内容' : '发送'
  const hasText = els.input.value.trim() || pending.quote || pending.images.length || pending.files.length
  els.btnSend.classList.toggle('disabled', !stopMode && !hasText)
}

async function send() {
  const replyStartedAt = Date.now()
  if (intentPending) return
  const text = els.input.value.trim()
  const quote = pending.quote
  const images = [...pending.images]
  const files = [...pending.files]
  const hasDraft = !!(text || quote || images.length || files.length)
  if (activeStream()) {
    if (!hasDraft) {
    window.askAPI.abort(session.streamingReqId)
      session.streamingReqId = null
      const active = [...session.messages].reverse().find(m => m.role === 'assistant' && !m.done)
      if (active) {
        active.done = true
        active.aborted = true
        refreshMsgEl(active)
      }
      updateSendBtn()
    return
  }
    supersedeActiveStream()
  }
  if (!hasDraft) return

  const m = { id: uid(), role: 'user', text, quote, images, files }
  session.messages.push(m)
  clearPending()
  els.input.value = ''
  autoGrow()
  if (session.messages.filter(x => x.role === 'user').length === 1) {
    session.title = (text || quote || (images.length ? '[图片]' : files[0]?.name || '')).slice(0, 24)
  }
  const el = renderMsg(m, session.messages.length - 1)
  els.thread.appendChild(el)
  els.scroll.scrollTop = els.scroll.scrollHeight

  // 图片请求必须走多模态模型；本地 Agent 通道当前只接收文本，不能处理图片。
  const toolPrompt = [text, quote, ...files.map(f => `${f.name}\n${f.text || ''}`)].join('\n').slice(0, 12000)

  // 意图识别过程也作为回复链路的一部分展示；后续响应会复用这条 assistant 消息。
  const intentMsg = {
    id: uid(),
    role: 'assistant',
    text: '',
    reasoning: '正在分析请求意图…',
    done: false,
    tools: []
  }
  intentMsg.replyStartedAt = replyStartedAt
  session.messages.push(intentMsg)
  renderAll()

  intentPending = true
  updateSendBtn()
  let route = { delegated: false, reason: '' }
  try {
    route = await routeRequest(toolPrompt, {
      imageOnly: images.length > 0,
      hasBinaryFile: files.some(f => f.binary)
    }, tool => upsertToolTrace(intentMsg, tool))
  } finally {
    intentPending = false
    updateSendBtn()
  }

  intentMsg.done = true
  intentMsg.reasoning = `意图识别：${route.reason || '已完成'}`
  refreshMsgEl(intentMsg)

  if (!config.hasKey && !delegated) {
    els.banner.classList.remove('hidden')
    toast('请先配置 API Key')
    window.askAPI.openSettings()
    return
  }
  respond(route.delegated, intentMsg)
}

function supersedeActiveStream() {
  const reqId = session.streamingReqId
  if (!reqId) return
  const active = [...session.messages].reverse().find(m => m.role === 'assistant' && !m.done)
  if (active) {
    active.done = true
    active.aborted = true
    active.durationMs = Date.now() - (active.replyStartedAt || Date.now())
    refreshMsgEl(active)
  }
  window.askAPI.abort(reqId)
  session.streamingReqId = null
  updateSendBtn()
}

async function respond(delegated = false, existing = null) {
  const owner = session
  const m = existing || { id: uid(), role: 'assistant', text: '', reasoning: '', done: false, tools: [] }
  if (!existing) owner.messages.push(m)
  m.replyStartedAt = m.replyStartedAt || Date.now()
  m.done = false
  m.error = null
  m.aborted = false
  if (session === owner) {
    if (!existing) els.thread.appendChild(renderMsg(m, owner.messages.length - 1))
    else refreshMsgEl(m)
    els.scroll.scrollTop = els.scroll.scrollHeight
  }

  const reqId = uid()
  owner.streamingReqId = reqId
  m.__lastEventAt = Date.now()
  m.__waitingShown = false
  streamHandlers.set(reqId, null)
  m.__started = false
  if (delegated) {
    const routeNote = `已路由到本机 Agent（${config.localAgent === 'auto' ? '自动选择' : config.localAgent}），正在调用 Skill / MCP / CLI…`
    m.reasoning = m.reasoning ? `${m.reasoning}\n${routeNote}` : routeNote
    m.__rsPainted = true
  }
  updateSendBtn()
  hideSelbar()

  let lastRender = 0
  const paint = force => {
    if (session !== owner || !owner.messages.includes(m)) return
    const now = Date.now()
    if (!force && now - lastRender < 80) return
    lastRender = now
    const stick = nearBottom()
    refreshMsgEl(m)
    stickScroll(stick)
  }

  const ctl = {
    reqId,
    onEvent(ev) {
      if (ev.reqId !== reqId) return
      m.__lastEventAt = Date.now()
      m.__waitingShown = false
      if (ev.type === 'reasoning') {
        m.reasoning = (m.reasoning || '') + ev.text
        if (!m.__rsPainted) {
          m.__rsPainted = true
          if (m.reasoning) m.reasoning += '\n'
          paint(true)
        } else {
          // 增量更新思考文本，不重建整个节点
          const box = els.thread.querySelector(`[data-id="${m.id}"] .rs-body`)
          if (box) {
            const stick = nearBottom()
            box.textContent = m.reasoning
            stickScroll(stick)
          }
      }
      return
    }
    if (ev.type === 'tool') {
      if (!Array.isArray(m.tools)) m.tools = []
      const tool = ev.tool || {}
      const idx = m.tools.findIndex(x => x.id === tool.id)
      if (idx >= 0) m.tools[idx] = { ...m.tools[idx], ...tool, startedAt: m.tools[idx].startedAt || tool.startedAt }
      else m.tools.push(tool)
      paint(true)
      return
    }
      if (ev.type === 'content') {
        if (!m.__started) {
          m.__started = true
          m.reasoningCollapsed = true
        }
        m.text += ev.text
        paint()
        return
      }
      if (ev.type === 'done') {
        m.done = true
        m.durationMs = Date.now() - (m.replyStartedAt || m.__lastEventAt || Date.now())
        if (typeof ev.final === 'string') {
          m.text = ev.final
          m.__started = !!ev.final
        }
        if (ev.ok && ev.aborted) m.aborted = true
        if (!ev.ok) m.error = ev.error || '请求失败'
        if (owner.streamingReqId === reqId) owner.streamingReqId = null
        streamHandlers.delete(reqId)
        if (session === owner) updateSendBtn()
        paint(true)
        saveSession(owner)
      }
    }
  }
  streamHandlers.set(reqId, ctl)
  streamingCtl = session === owner ? ctl : null

  try {
    let summary = agentSummary
    if (!summary) summary = await window.askAPI.localAgents()
    agentSummary = summary
    refreshAgentLabel(summary)
    const messages = toApiMessages(owner.messages.slice(0, -1))
    if (delegated) {
      await window.askAPI.localAgentRun({
        reqId,
        messages,
        agent: config.localAgent,
        includeContext: true,
        execute: config.agentExec !== false
      })
      return
    }
    if (summary.totals && (summary.totals.skills + summary.totals.mcps + summary.totals.plugins) > 0) {
      messages.splice(1, 0, { role: 'system', content: summary.promptContext })
    }
    window.askAPI.chat({ reqId, model: config.model, messages })
  } catch (err) {
    m.done = true
    m.durationMs = Date.now() - (m.replyStartedAt || m.__lastEventAt || Date.now())
    m.error = err?.message || '发送失败'
    owner.streamingReqId = null
    streamHandlers.delete(reqId)
    if (session === owner) updateSendBtn()
    paint(true)
    saveSession(owner)
  }
}

function hasRecentToolContext() {
  return session.messages.slice(-8).some(m => m.role === 'assistant' && !!m.tools?.length)
}

function buildIntentHistory() {
  return session.messages.slice(-10).filter(m => !(m.role === 'assistant' && m.tools?.some(t => t.id === 'intent'))).map(m => {
    const text = String(m.text || m.quote || '').slice(0, 700)
    const tools = (m.tools || [])
      .filter(t => t.id !== 'agent')
      .map(t => `${t.title || t.id}:${String(t.detail || '').slice(0, 240)}`)
      .join(' | ')
    return {
      role: m.role,
      content: text,
      tools: tools ? [tools] : []
    }
  })
}

async function routeRequest(prompt = '', options = {}, onIntent) {
  const emitIntent = (state, detail) => {
    onIntent?.({
      id: 'intent',
      title: `意图识别 · ${config.intentModel || 'glm-5.3-flash'}`,
      state,
      detail,
      startedAt: Date.now() - (state === 'running' ? 0 : 600),
      finishedAt: state === 'running' ? undefined : Date.now()
    })
  }

  if (options.imageOnly) {
    emitIntent('done', '图片请求将走多模态模型，不路由本地 Agent。')
    return { delegated: false, reason: '图片请求使用多模态模型' }
  }

  if (config.localAgent === 'direct') {
    emitIntent('done', '当前已选择「仅 GLM」，不路由本地 Agent。')
    return { delegated: false, reason: '已选择仅 GLM' }
  }

  agentSummary = agentSummary || await window.askAPI.localAgents()

  if (config.localAgent !== 'auto') {
    const available = agentSummary.available?.includes(config.localAgent)
    emitIntent(available ? 'done' : 'error', available
      ? `已手动选择 ${config.localAgent}，直接路由本地 Agent。`
      : `本机未找到已选择的 ${config.localAgent}。`)
    return { delegated: available, reason: available ? `手动选择 ${config.localAgent}` : '所选 Agent 不可用' }
  }

  if (!agentSummary.preferred) {
    emitIntent('done', '未发现可用的本机 Agent，继续使用 GLM 直答。')
    return { delegated: false, reason: '没有可用 Agent' }
  }

  emitIntent('running', '正在由独立模型分析当前请求与最近上下文…')
  if (config.localAgent === 'auto') {
    try {
      const result = await window.askAPI.classifyIntent({
        prompt,
        history: buildIntentHistory(),
        hasBinaryFile: !!options.hasBinaryFile
      })
      if (!result.ok) {
        console.warn('[intent] 本地 Agent 意图识别失败:', result.error)
        emitIntent('error', result.error || '意图识别失败')
        return { delegated: false, reason: result.error || '意图识别失败' }
      }
      const delegated = result.useAgent && result.confidence >= 0.55
      const detail = `${delegated ? '路由本地 Agent' : 'GLM 直答'}；置信度 ${Math.round((result.confidence || 0) * 100)}%；${result.reason || '无补充说明'}`
      emitIntent(delegated ? 'done' : 'done', detail)
      return { delegated, reason: result.reason || '', confidence: result.confidence }
    } catch (err) {
      console.warn('[intent] 本地 Agent 意图识别失败:', err)
      emitIntent('error', err?.message || '意图识别失败')
      return { delegated: false, reason: err?.message || '意图识别失败' }
    }
  }
  return { delegated: false, reason: '未知路由状态' }
}

async function shouldDelegate(prompt = '', options = {}) {
  const route = await routeRequest(prompt, options)
  return route.delegated
}
let streamingCtl = null
const streamHandlers = new Map()

async function retryFromError(msgId) {
  if (activeStream()) return
  const idx = session.messages.findIndex(m => m.id === msgId)
  if (idx < 0) return
  session.messages.splice(idx, 1) // 移除出错消息
  renderAll()
  respond(false)
}

async function regenerate() {
  if (activeStream()) return
  const last = session.messages[session.messages.length - 1]
  if (!last || last.role !== 'assistant') return
  session.messages.pop()
  renderAll()
  respond(false)
}

async function stopStream() {
  if (activeStream()) window.askAPI.abort(session.streamingReqId)
}

/* ---------------- 编辑用户消息并重发 ---------------- */
let editingId = null
let editingData = null
let editingRender = null
const toolTraceOpen = new Set()
const toolTraceGroupOpen = new Set()

function createEditField(label, className, value) {
  const wrap = document.createElement('div')
  wrap.className = 'edit-field'
  const title = document.createElement('div')
  title.className = 'edit-label'
  title.textContent = label
  const ta = document.createElement('textarea')
  ta.className = className
  ta.value = value || ''
  wrap.appendChild(title)
  wrap.appendChild(ta)
  return { wrap, ta }
}

async function appendEditImages(fileList) {
  const imageFiles = [...(fileList || [])].filter(f => f.type.startsWith('image/'))
  if (!imageFiles.length || !editingData || !editingRender) return false
  const capacity = 6 - editingData.images.length
  if (capacity <= 0) {
    toast('最多添加 6 张图片')
    return true
  }
  const accepted = imageFiles.slice(0, capacity)
  if (imageFiles.length > capacity) toast('最多添加 6 张图片')
  for (const file of accepted) {
    if (file.size > 10 * 1024 * 1024) {
      toast(`文件需小于 10MB：${file.name}`)
      continue
    }
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    editingData.images.push(url)
  }
  editingRender()
  updateSendBtn()
  return true
}

function startEdit(idx) {
  if (activeStream() || editingId) return
  const m = session.messages[idx]
  if (!m || m.role !== 'user') return
  editingId = m.id
  const holder = els.thread.querySelector(`[data-id="${m.id}"]`)
  if (!holder) return
  const data = {
    text: m.text || '',
    quote: m.quote || '',
    images: [...(m.images || [])],
    files: [...(m.files || [])]
  }
  editingData = data
  holder.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'edit-box'

  let quoteTa = null
  if (data.quote) {
  const quoteField = createEditField('引用内容', 'edit-quote', data.quote)
  quoteTa = quoteField.ta
  quoteTa.oninput = () => { data.quote = quoteTa.value }
  box.appendChild(quoteField.wrap)
  }
  const textField = createEditField('消息内容', 'edit-text', data.text)
  const ta = textField.ta
  ta.oninput = () => { data.text = ta.value }
  box.appendChild(textField.wrap)

  const attachments = document.createElement('div')
  attachments.className = 'edit-attachments'
  box.appendChild(attachments)
  const renderEditAttachments = () => {
    attachments.innerHTML = ''
    if (data.images.length) {
      const imgs = document.createElement('div')
      imgs.className = 'u-images edit-images'
      data.images.forEach((src, i) => {
        const item = document.createElement('div')
        item.className = 'edit-img'
        const im = document.createElement('img')
        im.src = src
        im.title = '点击预览'
        im.onclick = () => openImagePreview(src)
        const x = document.createElement('button')
        x.className = 'chip-x'
        x.title = '移除图片'
        x.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>'
        x.onclick = () => { data.images.splice(i, 1); renderEditAttachments() }
        item.appendChild(im)
        item.appendChild(x)
        imgs.appendChild(item)
      })
      attachments.appendChild(imgs)
    }
    if (data.files.length) {
      const files = document.createElement('div')
      files.className = 'u-files edit-files'
      data.files.forEach((file, i) => {
        const chip = document.createElement('span')
        chip.className = 'file-chip'
        chip.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8L14 2.5z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M14 2.5V8h5.5"/></svg>'
        const name = document.createElement('span')
        name.className = 'fname'
        name.textContent = file.name
        const x = document.createElement('button')
        x.className = 'chip-x'
        x.title = '移除文件'
        x.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>'
        x.onclick = () => { data.files.splice(i, 1); renderEditAttachments() }
        chip.appendChild(name)
        chip.appendChild(x)
        files.appendChild(chip)
      })
      attachments.appendChild(files)
    }
    const tools = document.createElement('div')
    tools.className = 'edit-tools'
    const addImg = document.createElement('button')
    addImg.type = 'button'
    addImg.textContent = '添加图片'
    addImg.onclick = async () => {
      const r = await window.askAPI.pick('image')
      if (r?.error) toast(r.error)
      if (r?.ok && r.images?.length) {
        if (data.images.length + r.images.length > 6) return toast('最多添加 6 张图片')
        data.images.push(...r.images)
        renderEditAttachments()
      }
    }
    const addFile = document.createElement('button')
    addFile.type = 'button'
    addFile.textContent = '添加文件'
    addFile.onclick = async () => {
      const r = await window.askAPI.pick('file')
      if (r?.error) toast(r.error)
      if (r?.ok && r.files?.length) {
        data.files.push(...r.files)
        renderEditAttachments()
      }
    }
    tools.appendChild(addImg)
    tools.appendChild(addFile)
    attachments.appendChild(tools)
  }
  renderEditAttachments()
  editingRender = renderEditAttachments

  const acts = document.createElement('div')
  acts.className = 'edit-actions'
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  cancel.onclick = () => {
    editingId = null
    editingData = null
    editingRender = null
    refreshMsgEl(m)
  }
  const ok = document.createElement('button')
  ok.className = 'primary'
  ok.textContent = '发送'
  ok.onclick = () => saveEdit(m, data)
  acts.appendChild(cancel)
  acts.appendChild(ok)
  box.appendChild(ta)
  box.appendChild(acts)
  holder.appendChild(box)
  ta.focus()
  ta.selectionStart = ta.value.length
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveEdit(m, data) }
    if (e.key === 'Escape') {
      editingId = null
      editingData = null
      editingRender = null
      refreshMsgEl(m)
    }
  }
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px' }
  ta.oninput = () => {
    data.text = ta.value
    grow()
  }
  grow()
}

async function saveEdit(m, data) {
  const idx = session.messages.indexOf(m)
  m.text = (data.text || '').trim()
  m.quote = (data.quote || '').trim()
  m.images = data.images
  m.files = data.files
  editingId = null
  editingData = null
  editingRender = null
  // 截断该消息之后的所有内容，重新生成
  session.messages = session.messages.slice(0, idx + 1)
  renderAll()
  const prompt = [m.text, m.quote, ...(m.files || []).map(f => `${f.name}\n${f.text || ''}`)].join('\n').slice(0, 12000)
  const delegated = await shouldDelegate(prompt, {
    hasBinaryFile: (m.files || []).some(f => f.binary)
  })
  respond(delegated)
}

/* ---------------- 引用 / 附件 ---------------- */
function quoteIntoInput(text) {
  const t = (text || '').trim()
  if (!t) return
  pending.quote = t
  els.quoteText.textContent = t
  els.quoteChip.classList.remove('hidden')
  els.chips.classList.remove('hidden')
  updateSendBtn()
  els.input.focus()
}

function clearPending() {
  pending = session.draft
  pending.text = ''
  pending.quote = ''
  pending.images.length = 0
  pending.files.length = 0
  els.quoteChip.classList.add('hidden')
  els.attachChips.innerHTML = ''
  els.chips.classList.add('hidden')
  updateSendBtn()
}

function renderAttachChips() {
  els.attachChips.innerHTML = ''
  pending.images.forEach((src, i) => {
    const d = document.createElement('div')
    d.className = 'attach-img'
    const im = document.createElement('img')
    im.src = src
    const x = document.createElement('button')
    x.className = 'chip-x'
    x.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>'
    x.onclick = () => { pending.images.splice(i, 1); renderAttachChips(); updateSendBtn() }
    d.appendChild(im)
    d.appendChild(x)
    els.attachChips.appendChild(d)
  })
  pending.files.forEach((f, i) => {
    const chip = document.createElement('span')
    chip.className = 'attach-file'
    chip.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8L14 2.5z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M14 2.5V8h5.5"/></svg>'
    const name = document.createElement('span')
    name.textContent = f.name
    name.title = f.binary ? `${f.path || ''}\n二进制文件（内容未直接注入对话）` : (f.path || f.name)
    const x = document.createElement('button')
    x.className = 'chip-x'
    x.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>'
    x.onclick = () => { pending.files.splice(i, 1); renderAttachChips(); updateSendBtn() }
    chip.appendChild(name)
    chip.appendChild(x)
    els.attachChips.appendChild(chip)
  })
  const any = pending.images.length || pending.files.length || pending.quote
  els.chips.classList.toggle('hidden', !any)
}

async function addImages(urls) {
  if (!urls.length) return
  if (pending.images.length + urls.length > 6) return toast('最多添加 6 张图片')
  pending.images.push(...urls)
  renderAttachChips()
  updateSendBtn()
}

async function addFiles(files) {
  if (!files.length) return
  pending.files.push(...files)
  renderAttachChips()
  updateSendBtn()
}

/* ---------------- 弹窗内划词追问 ---------------- */
let selText = ''

function hideSelbar() {
  els.selbar.classList.add('hidden')
  selText = ''
}

function showSelbar(rect) {
  const bar = els.selbar
  bar.classList.remove('hidden')
  const w = bar.offsetWidth
  const h = bar.offsetHeight
  const margin = 8
  let x = rect.left + rect.width / 2 - w / 2
  // 优先展示在选区上方；顶部放不下翻到下方；下方也放不下则贴顶
  let y = rect.top - h - margin
  if (y < margin) y = rect.bottom + margin
  if (y + h > window.innerHeight - margin) y = Math.max(margin, rect.top - h - margin)
  x = Math.min(Math.max(x, margin), window.innerWidth - w - margin)
  bar.style.left = x + 'px'
  bar.style.top = y + 'px'
}

document.addEventListener('mouseup', e => {
  if (e.target.closest('#selbar')) return
  const sel = window.getSelection()
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : ''
  if (!text || activeStream() || !els.thread.contains(sel.anchorNode)) {
    if (!e.target.closest('#selbar')) hideSelbar()
    return
  }
  selText = text
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  showSelbar(rect)
})

els.selbar.addEventListener('mousedown', e => e.preventDefault())
els.selbar.addEventListener('click', e => {
  const btn = e.target.closest('button')
  if (!btn) return
  const text = selText
  hideSelbar()
  window.getSelection().removeAllRanges()
  if (btn.dataset.act === 'copy') window.askAPI.copyText(text)
  else if (btn.dataset.act === 'ask') quoteIntoInput(text)
})

els.scroll.addEventListener('scroll', hideSelbar)

/* ---------------- 图片预览 / 右键复制 ---------------- */
let contextImageSrc = ''

function hideImageMenu() {
  els.imageMenu.classList.add('hidden')
  contextImageSrc = ''
}

function showImageMenu(src, x, y) {
  contextImageSrc = src
  els.imageMenu.classList.remove('hidden')
  const w = els.imageMenu.offsetWidth
  const h = els.imageMenu.offsetHeight
  els.imageMenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px'
  els.imageMenu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px'
}

function openImagePreview(src) {
  els.previewImg.src = src
  els.imagePreview.classList.remove('hidden')
  hideImageMenu()
}

function closeImagePreview() {
  els.imagePreview.classList.add('hidden')
  els.previewImg.removeAttribute('src')
}

document.addEventListener('contextmenu', e => {
  const im = e.target.closest('img')
  if (im && (im.closest('.u-images') || im.closest('.attach-img'))) {
    e.preventDefault()
    showImageMenu(im.src, e.clientX, e.clientY)
  } else {
    hideImageMenu()
  }
})

els.imageMenu.addEventListener('click', async e => {
  const btn = e.target.closest('button')
  if (!btn || !contextImageSrc) return
  const src = contextImageSrc
  const act = btn.dataset.act
  hideImageMenu()
  if (act === 'preview') openImagePreview(src)
  if (act === 'copy') {
    const ok = await window.askAPI.copyImage(src)
    toast(ok ? '图片已复制' : '图片复制失败')
  }
})

els.imagePreview.addEventListener('click', e => {
  if (e.target === els.imagePreview || e.target.closest('#preview-close')) closeImagePreview()
})

document.addEventListener('mousedown', e => {
  if (!e.target.closest('#image-menu')) hideImageMenu()
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeImagePreview()
    hideImageMenu()
  }
})

/* ---------------- 模型菜单 ---------------- */
async function refreshConfig() {
  config = await window.askAPI.cfg()
  els.modelLabel.textContent = config.model
  els.effortLabel.textContent = (EFFORTS.find(x => x.id === config.effort) || EFFORTS[2]).label
  els.banner.classList.toggle('hidden', !!config.hasKey)
}

const EFFORTS = [
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' }
]

const AGENTS = [
  { id: 'auto', label: '自动优先', hint: 'GLM 直答；工具任务转本地 Agent' },
  { id: 'zcode', label: 'ZCode', hint: '本机 ZCode 生态' },
  { id: 'claude', label: 'Claude Code', hint: '本机 Claude 生态' },
  { id: 'codex', label: 'Codex', hint: '本机 Codex 生态' },
  { id: 'direct', label: '仅 GLM', hint: '不交给本地 Agent' }
]

function agentLabelText(summary = agentSummary) {
  if (config.localAgent === 'direct') return '仅GLM'
  if (config.localAgent !== 'auto') return AGENTS.find(a => a.id === config.localAgent)?.label || 'Agent'
  return summary?.preferred ? `自动·${summary.preferred}` : '自动'
}

function refreshAgentLabel(summary = agentSummary) {
  els.btnAgent.title = `本地Agent：${agentLabelText(summary)}（Skill / MCP / Plugin）`
}

function renderAgentMenu() {
  els.agentMenu.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'hint'
  head.style.padding = '4px 10px 6px'
  head.style.fontSize = '12px'
  head.style.color = '#86909c'
  head.textContent = agentSummary
    ? `已发现 Skill ${agentSummary.totals.skills} · MCP ${agentSummary.totals.mcps} · Plugin ${agentSummary.totals.plugins}`
    : '正在扫描本机 Agent 能力…'
  els.agentMenu.appendChild(head)
  for (const a of AGENTS) {
    const row = document.createElement('button')
    row.className = 'row' + (config.localAgent === a.id ? ' active' : '')
    const main = document.createElement('span')
    main.textContent = a.label
    main.style.flex = '1'
    row.appendChild(main)
    if (config.localAgent === a.id) {
      const check = document.createElement('span')
      check.className = 'check'
      check.textContent = '✓'
      row.appendChild(check)
    }
    row.onclick = async () => {
      config.localAgent = a.id
      refreshAgentLabel()
      toggleMenu(els.agentMenu, false)
      await window.askAPI.saveConfig({ localAgent: a.id })
    }
    els.agentMenu.appendChild(row)
  }
  const execRow = document.createElement('button')
  execRow.className = 'row'
  const execMain = document.createElement('span')
  execMain.textContent = '允许真实执行'
  execMain.style.flex = '1'
  const execState = document.createElement('span')
  execState.textContent = config.agentExec !== false ? '开' : '关'
  execState.style.color = config.agentExec !== false ? 'var(--accent)' : 'var(--sub)'
  execRow.appendChild(execMain)
  execRow.appendChild(execState)
  execRow.onclick = async () => {
    config.agentExec = config.agentExec === false
    execState.textContent = config.agentExec ? '开' : '关'
    execState.style.color = config.agentExec ? 'var(--accent)' : 'var(--sub)'
    await window.askAPI.saveConfig({ agentExec: config.agentExec })
  }
  els.agentMenu.appendChild(execRow)
}

function renderEffortMenu() {
  els.effortMenu.innerHTML = ''
  for (const it of EFFORTS) {
    const row = document.createElement('button')
    row.className = 'row' + (config.effort === it.id ? ' active' : '')
    const label = document.createElement('span')
    label.textContent = it.label
    label.style.flex = '1'
    row.appendChild(label)
    if (config.effort === it.id) {
      const check = document.createElement('span')
      check.className = 'check'
      check.innerHTML = '<svg viewBox="0 0 24 24" style="width:14px;height:14px"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5L20 7"/></svg>'
      row.appendChild(check)
    }
    row.onclick = async () => {
      config.effort = it.id
      els.effortLabel.textContent = it.label
      toggleMenu(els.effortMenu, false)
      await window.askAPI.saveConfig({ effort: it.id })
    }
    els.effortMenu.appendChild(row)
  }
}

function renderModelMenu() {
  els.modelMenu.innerHTML = ''
  for (const m of config.models) {
    const row = document.createElement('button')
    row.className = 'row' + (m === config.model ? ' active' : '')
    row.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path fill="currentColor" d="M12 2.5l2.1 5.7 5.7 2.1-5.7 2.1L12 18.1l-2.1-5.7-5.7-2.1 5.7-2.1L12 2.5z"/></svg><span>${m}</span>`
    row.onclick = async () => {
      config.model = m
      els.modelLabel.textContent = m
      toggleMenu(els.modelMenu, false)
      await window.askAPI.saveConfig({ model: m })
    }
    els.modelMenu.appendChild(row)
  }
  const sep = document.createElement('div')
  sep.className = 'sep'
  els.modelMenu.appendChild(sep)
  const manage = document.createElement('button')
  manage.className = 'row'
  manage.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>模型设置…</span>'
  manage.onclick = () => {
    toggleMenu(els.modelMenu, false)
    window.askAPI.openSettings()
  }
  els.modelMenu.appendChild(manage)
}

function toggleMenu(menu, show) {
  const willShow = show === undefined ? menu.classList.contains('hidden') : show
  if (willShow) {
    if (menu === els.modelMenu) renderModelMenu()
    if (menu === els.effortMenu) renderEffortMenu()
    if (menu === els.agentMenu) renderAgentMenu()
    ;[els.modelMenu, els.effortMenu, els.plusMenu, els.moreMenu].forEach(m => m !== menu && m.classList.add('hidden'))
    menu.classList.remove('hidden')
  } else {
    menu.classList.add('hidden')
  }
}

document.addEventListener('mousedown', e => {
  const inMenu = e.target.closest('.menu')
  const inBtn = e.target.closest('#btn-agent, #btn-model, #btn-effort, #btn-plus, #btn-more')
  if (!inMenu && !inBtn) {
    ;[els.agentMenu, els.modelMenu, els.effortMenu, els.plusMenu, els.moreMenu].forEach(m => m.classList.add('hidden'))
  }
  // 点击历史面板以外的任意区域时自动收起历史记录。
  if (!e.target.closest('#history-panel')) els.historyPanel.classList.add('hidden')
})

/* ---------------- 历史 ---------------- */
async function openHistory() {
  syncDraft()
  await saveSession()
  const list = await window.askAPI.listHistory()
  els.historyList.innerHTML = ''
  if (!list.length) {
    els.historyList.innerHTML = '<div class="history-empty">暂无历史话题</div>'
  }
  for (const s of list) {
    const item = document.createElement('div')
    item.className = 'history-item'
    const d = new Date(s.updatedAt)
    const time = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    item.innerHTML = `<div class="hi-main"><div class="hi-title"></div><div class="hi-time">${time}</div></div>`
    item.querySelector('.hi-title').textContent = s.title || '新话题'
    const del = document.createElement('button')
    del.className = 'hi-del'
    del.title = '删除'
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>'
    del.onclick = async e => {
      e.stopPropagation()
      await window.askAPI.deleteHistory(s.id)
      openHistory()
    }
    item.onclick = async () => {
      syncDraft()
      await saveSession()
      let target = sessions.get(s.id)
      if (!target) {
        const full = await window.askAPI.loadHistory(s.id)
        if (full) {
          target = normalizeSession(full)
          sessions.set(target.id, target)
        }
      }
      if (target) {
        session = target
        editingId = null
        writeDraft(target.draft)
        renderAll()
        updateSendBtn()
        refreshConfig()
      }
      els.historyPanel.classList.add('hidden')
    }
    item.appendChild(del)
    els.historyList.appendChild(item)
  }
  els.historyPanel.classList.remove('hidden')
}

async function newTopic() {
  syncDraft()
  await saveSession()
  const carriedDraft = readDraft()
  session = newSession()
  sessions.set(session.id, session)
  editingId = null
  writeDraft(carriedDraft)
  renderAll()
  updateSendBtn()
  refreshConfig()
  els.input.focus()
}

/* ---------------- 输入框 ---------------- */
function autoGrow() {
  els.input.style.height = 'auto'
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px'
}

els.input.addEventListener('input', () => { autoGrow(); updateSendBtn() })
// 输入内容跟随当前话题保存，切换历史 / 新话题时分别恢复。
els.input.addEventListener('input', () => {
  session.draft.text = els.input.value
})
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
})

els.input.addEventListener('paste', e => {
  const items = [...(e.clipboardData?.items || [])]
  const imgs = items.filter(i => i.type.startsWith('image/'))
  if (imgs.length) {
    e.preventDefault()
    const urls = []
    let loaded = 0
    imgs.forEach(item => {
      const file = item.getAsFile()
      if (!file) return
      if (file.size > 10 * 1024 * 1024) { toast('文件需小于 10MB'); return }
      const reader = new FileReader()
      reader.onload = () => {
        urls.push(reader.result)
        if (++loaded === imgs.length) addImages(urls)
      }
      reader.readAsDataURL(file)
    })
  }
})

// 编辑态中的任意位置都可 Cmd+V 粘贴图片；文本粘贴仍由 textarea 原生处理。
document.addEventListener('paste', async e => {
  if (!editingId || !editingData) return
  const images = [...(e.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean)
  if (!images.length) return
  e.preventDefault()
  await appendEditImages(images)
})

/* ---------------- 按钮 ---------------- */
els.btnSend.onclick = () => {
  const hasDraft = !!(els.input.value.trim() || pending.quote || pending.images.length || pending.files.length)
  if (activeStream() && !hasDraft) stopStream()
  else send()
}
$('#btn-min').onclick = () => window.askAPI.min()
$('#btn-new').onclick = () => newTopic()
$('#quote-clear').onclick = () => { pending.quote = ''; renderAttachChips(); updateSendBtn() }
$('#btn-plus').onclick = e => { e.stopPropagation(); toggleMenu(els.plusMenu) }
els.btnAgent.onclick = async e => {
  e.stopPropagation()
  agentSummary = agentSummary || await window.askAPI.localAgents()
  refreshAgentLabel()
  toggleMenu(els.agentMenu)
}
$('#btn-model').onclick = e => { e.stopPropagation(); toggleMenu(els.modelMenu) }
$('#btn-effort').onclick = e => { e.stopPropagation(); toggleMenu(els.effortMenu) }
$('#btn-more').onclick = e => { e.stopPropagation(); toggleMenu(els.moreMenu) }
$('#btn-pin').onclick = async () => {
  const pinned = await window.askAPI.togglePin()
  els.btnPin.classList.toggle('pinned', pinned)
}
$('#banner-btn').onclick = () => window.askAPI.openSettings()
$('#history-close').onclick = () => els.historyPanel.classList.add('hidden')
els.moreMenu.addEventListener('click', e => {
  const row = e.target.closest('.row')
  if (!row) return
  els.moreMenu.classList.add('hidden')
  if (row.dataset.act === 'history') openHistory()
  else if (row.dataset.act === 'settings') window.askAPI.openSettings()
  else if (row.dataset.act === 'quit') window.askAPI.quit()
})
els.plusMenu.addEventListener('click', async e => {
  const row = e.target.closest('.row')
  if (!row) return
  els.plusMenu.classList.add('hidden')
  const r = await window.askAPI.pick(row.dataset.act)
  if (r && r.ok) {
    if (r.images) await addImages(r.images)
    if (r.files) await addFiles(r.files)
  } else if (r && r.error) {
    toast(r.error)
  }
})

els.attachChips.addEventListener('click', e => {
  if (e.target.closest('.chip-x')) return
  const item = e.target.closest('.attach-img')
  if (item?.querySelector('img')) openImagePreview(item.querySelector('img').src)
})

// 消息里图片点击放大（新窗口查看 dataURL）
els.thread.addEventListener('click', e => {
  if (e.target.tagName === 'IMG' && e.target.closest('.u-images')) {
    openImagePreview(e.target.src)
  }
})
// markdown 链接外部打开
els.thread.addEventListener('click', e => {
  const a = e.target.closest('a')
  if (a) {
    e.preventDefault()
    window.askAPI.openExternal(a.href)
  }
})

/* ---------------- 初始化 ---------------- */
window.askAPI.onLlm(ev => {
  streamHandlers.get(ev.reqId)?.onEvent(ev)
})
window.askAPI.onCfgChanged(cfg => {
  config = { ...config, ...cfg }
  refreshAgentLabel()
  els.modelLabel.textContent = config.model
  els.effortLabel.textContent = (EFFORTS.find(x => x.id === config.effort) || EFFORTS[2]).label
  els.banner.classList.toggle('hidden', !!config.hasKey)
})
window.askAPI.onHint(msg => toast(msg, 5000))
window.askAPI.onHookReady(() => toast('划词工具条已激活，现在可以在任意应用中选中文字试一试', 4000))

// 弹窗默认置顶（📌 高亮）
els.btnPin.classList.add('pinned')

window.askAPI.onInit(async p => {
  config = p.config || config
  try {
    agentSummary = await window.askAPI.localAgents()
  } catch {}
  refreshAgentLabel()
  els.modelLabel.textContent = config.model
  els.effortLabel.textContent = (EFFORTS.find(x => x.id === config.effort) || EFFORTS[2]).label
  els.banner.classList.toggle('hidden', !!config.hasKey)

  if (p.hookFailed) {
    toast('划词工具条未激活：请在弹出的权限引导窗口中授权，授权后无需重启即可自动生效', 8000)
  }
  if (p.hotkeyConflict) {
    toast('快捷键 ⌘⇧Space 注册失败，可能被输入法或其他应用占用', 6000)
  }

  if (p.demo) {
    session = newSession()
    session.messages = p.messages || []
    renderAll()
    return
  }

  if (p.fresh) newTopicNoSave()

  if (p.quote) {
    pending.quote = p.quote
    els.quoteText.textContent = p.quote
    els.quoteChip.classList.remove('hidden')
    els.chips.classList.remove('hidden')
    updateSendBtn()
  }

  if (p.auto && p.preset && p.quote) {
    // 一键动作（总结/翻译/解释）：直接发送
    const m = { id: uid(), role: 'user', text: '', quote: p.quote, preset: p.preset, images: [], files: [] }
    session.messages.push(m)
    clearPending()
    if (session.messages.filter(x => x.role === 'user').length === 1) {
      session.title = `${PRESETS[p.preset].label}：${p.quote.slice(0, 20)}`
    }
    els.thread.appendChild(renderMsg(m, session.messages.length - 1))
    els.scroll.scrollTop = els.scroll.scrollHeight
    respond(false)
  } else {
    // 主进程会在窗口 native focus 后再抢焦一次；这里兜底处理 IPC 稍晚到达、
    // 或 macOS 恢复 first responder 的时序。
    requestAnimationFrame(() => els.input.focus({ preventScroll: true }))
    setTimeout(() => els.input.focus({ preventScroll: true }), 30)
    setTimeout(() => els.input.focus({ preventScroll: true }), 120)
  }
})

function newTopicNoSave() {
  session = newSession()
  sessions.set(session.id, session)
  editingId = null
  clearPending()
  renderAll()
  updateSendBtn()
}

autoGrow()
updateSendBtn()
els.input.focus()

// 流式输出可能长时间只有工具在跑；周期性把“仍在执行”状态画出来。
setInterval(() => {
  if (!activeStream()) return
  const active = [...session.messages].reverse().find(m => m.role === 'assistant' && !m.done)
  if (!active) return
  const waiting = Date.now() - (active.__lastEventAt || 0) > 2500
  if (active.__waitingShown !== waiting) {
    active.__waitingShown = waiting
    refreshMsgEl(active)
  }
  const root = els.thread.querySelector('.tool-trace.running[data-started-at]')
  if (root) {
    const elapsed = Math.max(1, Math.round((Date.now() - Number(root.dataset.startedAt)) / 1000))
    const title = root.querySelector(':scope > .tool-group-head .tool-title')
    if (title) title.textContent = `执行中 · ${elapsed}s`
    root.querySelectorAll('.tool-item.running').forEach(item => {
      const startedAt = Number(item.dataset.startedAt || root.dataset.startedAt)
      const state = item.querySelector('.tool-state')
      if (state && startedAt) state.textContent = `运行 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`
    })
  }
}, 1000)
