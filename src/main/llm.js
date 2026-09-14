// GLM OpenAI 兼容端点的流式调用（在主进程发请求，规避 CORS；支持终止）
const controllers = new Map() // reqId -> AbortController

function chatUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions'
}

async function stream({ reqId, baseUrl, apiKey, model, messages, extra, onEvent }) {
  const ac = new AbortController()
  controllers.set(reqId, ac)
  let doneSent = false
  let connectTimedOut = false
  // 90 秒没有任何字节就判定链路异常，避免 UI 无限 loading。
  let idleTimer = null
  const armIdleTimer = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      connectTimedOut = true
    ac.abort()
    }, 90_000)
  }
  armIdleTimer()
  const finish = ev => {
    if (doneSent) return
    clearTimeout(idleTimer)
    doneSent = true
    onEvent({ type: 'done', ...ev })
  }
  try {
    const res = await fetch(chatUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: true, ...(extra || {}) }),
      signal: ac.signal
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let msg = `请求失败 (HTTP ${res.status})`
      try {
        const j = JSON.parse(body)
        msg += '：' + (j.error?.message || j.message || body.slice(0, 200))
      } catch {
        if (body) msg += '：' + body.slice(0, 200)
      }
      throw new Error(msg)
    }
    armIdleTimer()
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      armIdleTimer()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return finish({ ok: true })
        try {
          const j = JSON.parse(data)
          const delta = j.choices?.[0]?.delta || {}
          if (delta.reasoning_content) onEvent({ type: 'reasoning', text: delta.reasoning_content })
          if (delta.content) onEvent({ type: 'content', text: delta.content })
        } catch { /* 忽略心跳等非 JSON 行 */ }
      }
    }
    finish({ ok: true })
  } catch (err) {
    if (connectTimedOut) finish({ ok: false, error: '请求超时（90 秒无响应数据）' })
    if (err.name === 'AbortError') finish({ ok: true, aborted: true })
    else finish({ ok: false, error: err.message })
  } finally {
    clearTimeout(idleTimer)
    controllers.delete(reqId)
  }
}

function abort(reqId) {
  controllers.get(reqId)?.abort()
}

// 独立意图识别：一次性小请求，不占用主对话流式通道。
async function complete({ baseUrl, apiKey, model, messages, temperature = 0, maxTokens = 160, timeoutMs = 10000 }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(chatUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' }
      }),
      signal: ac.signal
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try {
        const j = JSON.parse(body)
        msg += `：${j.error?.message || j.message || body.slice(0, 160)}`
      } catch {
        if (body) msg += `：${body.slice(0, 160)}`
      }
      throw new Error(msg)
    }
    const j = await res.json()
    return String(j.choices?.[0]?.message?.content || '').trim()
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('意图识别超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 设置页「测试连接」：非流式小请求
async function testConnection({ baseUrl, apiKey, model }) {
  try {
    const res = await fetch(chatUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 8 })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try { msg += '：' + (JSON.parse(body).error?.message || '') } catch { if (body) msg += '：' + body.slice(0, 120) }
      return { ok: false, error: msg }
    }
    const j = await res.json()
    const text = j.choices?.[0]?.message?.content
    return { ok: true, sample: typeof text === 'string' ? text.slice(0, 40) : '(空回复)' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = { stream, abort, complete, testConnection }
