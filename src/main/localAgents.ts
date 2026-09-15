// 发现并复用本机已有 Coding Agent 生态：ZCode / Claude Code / Codex。
// 这里只读取本地清单与配置，用于：
// 1) 让 GLM 回答时优先声明/命中已有 skill、MCP、plugin；
// 2) 必要时把任务交给本地 agent 的 headless 入口（自动加载它们自己的生态）。
// 绝不把 MCP env（可能含 token）返回给渲染层。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const home = os.homedir()
let cache = null
let cacheAt = 0
const CACHE_MS = 5000

function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}

function firstExisting(paths) {
  return paths.find(p => p && exists(p))
}

function findNodeBin() {
  const dirs = []
  if (process.env.PATH) dirs.push(...process.env.PATH.split(':').filter(Boolean))
  try {
    for (const v of fs.readdirSync(path.join(home, '.nvm/versions/node'))) {
      dirs.push(path.join(home, '.nvm/versions/node', v, 'bin'))
    }
  } catch {}
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  return dirs.map(d => path.join(d, 'node')).find(p => exists(p))
}

function findCli(name) {
  const dirs = []
  if (process.env.PATH) dirs.push(...process.env.PATH.split(':').filter(Boolean))
  try {
    for (const v of fs.readdirSync(path.join(home, '.nvm/versions/node'))) {
      dirs.push(path.join(home, '.nvm/versions/node', v, 'bin'))
    }
  } catch {}
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  return dirs.map(d => path.join(d, name)).find(p => exists(p))
}

function safeReadJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function frontmatter(text: string): any {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: any = {}
  let current: any = null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^description\s*:\s*\|/.test(line)) { current = 'description'; out.description = ''; continue }
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (kv) {
      current = null
      out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
      continue
    }
    if (current && /^\s{2,}/.test(line)) out[current] += (out[current] ? ' ' : '') + line.trim()
  }
  return out
}

function discoverSkills(agent: string, root: string, out: any[]) {
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.system') continue
    const dir = path.join(root, ent.name)
    const skillFile = path.join(dir, 'SKILL.md')
    if (!exists(skillFile)) continue
    const meta = frontmatter(fs.readFileSync(skillFile, 'utf8'))
    const name = meta.name || path.basename(dir)
    const id = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    const item = {
      id, name,
      description: meta.description || meta['short-description'] || '',
      agent, path: skillFile
    }
    // 用户指定优先级：zcode > claude > codex；同名单去重。
    if (!out.some(x => x.id === id)) out.push(item)
  }
}

function parseTomlSections(text: string): any[] {
  const sections = []
  let current: any = null
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sec = line.match(/^\[(?:[^"'[\]]+|"[^"]+")\]$/)
    if (sec) {
      const name = line.slice(1, -1).trim()
      current = { name, values: {} }
      sections.push(current)
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (kv && current) current.values[kv[1]] = kv[2].trim()
  }
  return sections
}

function tomlArray(value) {
  if (!value || !value.startsWith('[') || !value.endsWith(']')) return []
  try { return JSON.parse(value.replace(/"/g, '"')) } catch { return [] }
}

function discoverCodex(out: any) {
  const cfgPath = path.join(home, '.codex/config.toml')
  if (!exists(cfgPath)) return
  const sections = parseTomlSections(fs.readFileSync(cfgPath, 'utf8'))
  for (const sec of sections) {
    let m = sec.name.match(/^mcp_servers\.(?:"([^"]+)"|([^.]+))$/)
    if (m) {
      const id = m[1] || m[2]
      if (sec.values.enabled === 'false') continue
      if (!out.mcps.some(x => x.id === id)) {
        out.mcps.push({ id, name: id, agent: 'codex', command: unquote(sec.values.command || ''), args: tomlArray(sec.values.args) })
      }
    }
    m = sec.name.match(/^plugins\.(?:"([^"]+)"|([^.]+))$/)
    if (m) {
      const id = m[1] || m[2]
      if (sec.values.enabled === 'true' && !out.plugins.some(x => x.id === id)) {
        out.plugins.push({ id, name: id.split('@')[0], agent: 'codex', version: '' })
      }
    }
  }
}

function unquote(v) { return String(v || '').replace(/^["']|["']$/g, '') }

function collectMcpJson(obj: any, source: string, out: any) {
  if (!obj || typeof obj !== 'object') return
  const servers = obj.mcpServers || obj.mcp_servers
  if (servers && typeof servers === 'object') {
    for (const [id, cfg] of Object.entries(servers) as [string, any][]) {
      if (cfg?.enabled === false || out.some(x => x.id === id)) continue
      out.mcps.push({ id, name: id, agent: source, command: cfg?.command || '', args: Array.isArray(cfg?.args) ? cfg.args : [] })
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !(Array.isArray(v))) collectMcpJson(v, source, out)
  }
}

function discoverCapabilities() {
  const skills = []
  const mcps = []
  const plugins = []
  discoverSkills('zcode', path.join(home, '.zcode/skills'), skills)
  discoverSkills('claude', path.join(home, '.claude/skills'), skills)
  discoverSkills('codex', path.join(home, '.codex/skills'), skills)
  discoverSkills('shared', path.join(home, '.agents/skills'), skills)
  discoverCodex({ mcps, plugins })

  const claudeGlobal = safeReadJson(path.join(home, '.claude.json'))
  collectMcpJson(claudeGlobal, 'claude', mcps)
  const claudeSettings = safeReadJson(path.join(home, '.claude/settings.json'))
  collectMcpJson(claudeSettings, 'claude', mcps)

  const claudeInstalled = safeReadJson(path.join(home, '.claude/plugins/installed_plugins.json'))
  const claudeEnabled = claudeSettings?.enabledPlugins || {}
  for (const [id, entries] of Object.entries(claudeInstalled?.plugins || {})) {
    if (claudeEnabled[id] === false) continue
    const first = Array.isArray(entries) ? entries[0] : entries
    if (!plugins.some(x => x.id === id)) plugins.push({ id, name: id.split('@')[0], agent: 'claude', version: first?.version || '' })
  }

  const zcodeInstalled = safeReadJson(path.join(home, '.zcode/cli/plugins/installed_plugins.json'))
  const zcodeConfig = safeReadJson(path.join(home, '.zcode/cli/config.json'))
  const zcodeEnabled = zcodeConfig?.plugins?.enabledPlugins || {}
  for (const p of zcodeInstalled?.plugins || []) {
    if (zcodeEnabled[p.id] === false) continue
    if (!plugins.some(x => x.id === p.id)) plugins.push({ id: p.id, name: p.name || p.id.split('@')[0], agent: 'zcode', version: p.version || '' })
  }

  return { skills, mcps, plugins }
}

function agentCommands() {
  const node = findNodeBin()
  const zcodeCjs = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
  const claude = findCli('claude')
  const codex = findCli('codex')
  const agents = []
  const zcodeCliCfg = safeReadJson(path.join(home, '.zcode/cli/config.json'))
  const zcodeReady = !!(zcodeCliCfg && (zcodeCliCfg.model || zcodeCliCfg.provider || zcodeCliCfg.providers))
  if (node && exists(zcodeCjs) && zcodeReady) agents.push({ id: 'zcode', label: 'ZCode', command: node, argsPrefix: [zcodeCjs], binPath: zcodeCjs })
  if (claude) agents.push({ id: 'claude', label: 'Claude Code', command: claude, argsPrefix: [], binPath: claude })
  if (codex) agents.push({ id: 'codex', label: 'Codex', command: codex, argsPrefix: [], binPath: codex })
  return agents
}

function discover() {
  const now = Date.now()
  if (cache && now - cacheAt < CACHE_MS) return cache
  const caps = discoverCapabilities()
  const agents = agentCommands()
  cache = {
    ...caps,
    agents,
    available: agents.map(a => a.id),
    totals: { skills: caps.skills.length, mcps: caps.mcps.length, plugins: caps.plugins.length },
    preferred: agents[0]?.id || null
  }
  cacheAt = now
  return cache
}

function buildPromptContext(summary, execute = false) {
  const line = items => items.slice(0, 120).map(x => `- ${x.name}${x.description ? `: ${x.description}` : ''}${x.agent ? `（来源：${x.agent}）` : ''}`).join('\n')
  return [
    '## 本机 Agent 能力上下文（优先复用）',
    `Skill：\n${line(summary.skills) || '- 无'}`,
    `MCP：\n${line(summary.mcps) || '- 无'}`,
    `Plugin：\n${line(summary.plugins) || '- 无'}`,
    execute
      ? '执行规则：你已经通过本地 Agent 获得真实的 Skill / MCP / Plugin / CLI 执行通道。命中能力时必须实际调用并返回真实结果或链接；不要声称没有工具，也不要编造执行结果。'
      : '能力说明：这些能力由本机 Agent 托管；当前 GLM 直答通道没有直接执行权。只有请求被路由到本地 Agent 后才可执行，不要伪造工具调用结果。'
  ].join('\n\n')
}

const localStreams = new Map()

function run(req) {
  const r = stream(req)
  if (r.ok && r.child) localStreams.set(req.reqId, r.child)
  return { ok: r.ok, delegated: r.delegated, agent: r.agent }
}

function stop(reqId) {
  abort(localStreams.get(reqId))
  localStreams.delete(reqId)
}

module.exports = { discover, buildPromptContext, run, stop }

function stripAnsi(text) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function buildAgentPrompt(messages, summary, execute = false) {
  const parts = []
  if (summary) parts.push(buildPromptContext(summary, execute))
  parts.push('<conversation>')
  for (const msg of messages.slice(-16)) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const content = typeof msg.content === 'string'
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '')
    if (!content) continue
    parts.push(`${msg.role.toUpperCase()}:\n${content}`)
  }
  parts.push('</conversation>')
  parts.push(execute
    ? '请继续处理最后一个用户请求；命中本机能力时必须实际调用 Skill/Plugin/MCP/CLI，完成操作后返回真实结果、链接或错误详情。除非用户明确确认，不要给高风险写入命令追加 --yes。'
    : '请继续处理最后一个用户请求；先给出执行计划，不要执行写入操作。')
  return parts.join('\n\n')
}

// 启动本地 agent 的 headless 入口。它们自身会加载各自配置里的 skills/plugins/MCP。
// execute=false 时保持只读/规划权限；execute=true 时才能真实调用 Skill/MCP/CLI。
function stream({ reqId, messages, agent = 'auto', cwd = home, summary, execute = false, onEvent }) {
  const all = agentCommands()
  const chosen = agent === 'auto' ? all[0] : all.find(a => a.id === agent)
  if (!chosen) {
    onEvent({ reqId, type: 'done', ok: false, error: '未找到可用的本地 Agent（zcode / claude / codex）' })
    return { ok: false, delegated: true }
  }

  const prompt = buildAgentPrompt(messages, summary, execute)
  const env = {
    ...process.env,
    // 保证 nvm 安装的 CLI 在 packaged Electron 中也能找到 node。
    PATH: (chosen.command.includes('/bin/node') ? path.dirname(chosen.command) + ':' : '') + process.env.PATH
  }
  let child
  const outPath = path.join(os.tmpdir(), `glm-ask-agent-${reqId}.md`)
  const toolRuns = new Map()
  const emitTool = (tool) => {
    toolRuns.set(tool.id, { ...(toolRuns.get(tool.id) || {}), ...tool })
    onEvent({ reqId, type: 'tool', tool })
  }
  emitTool({
    id: 'agent',
    title: `${chosen.label} · ${execute ? '执行模式' : '规划模式'}`,
    state: 'running'
  })
  if (chosen.id === 'zcode') {
    child = spawn(chosen.command, [
      ...chosen.argsPrefix, '--prompt', prompt, '--cwd', cwd,
      '--mode', execute ? 'agent' : 'plan'
    ], { cwd, env })
  } else if (chosen.id === 'claude') {
    child = spawn(chosen.command, [
      ...chosen.argsPrefix, '-p', prompt,
      ...(execute
        ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions']
        : ['--permission-mode', 'plan'])
    ], { cwd, env })
  } else {
    child = spawn(chosen.command, [
      ...chosen.argsPrefix, 'exec', prompt,
      '--sandbox', execute ? 'danger-full-access' : 'read-only',
      '--json', '--color', 'never', '--skip-git-repo-check',
      '--output-last-message', outPath
    ], { cwd, env })
  }

  let stdout = ''
  let claudeText = ''
  let claudeFinal = ''
  let codexFinal = ''
  let streamedContent = false
  let finished = false
  let lastActivityAt = Date.now()
  const startedAt = Date.now()
  let watchdog = null
  const emitContent = text => {
    if (!text) return
    streamedContent = true
    onEvent({ reqId, type: 'content', text })
  }
  const finish = ev => {
    if (finished) return false
    finished = true
    clearInterval(watchdog)
    onEvent({ reqId, type: 'done', ...ev })
    return true
  }
  const setToolState = (id, patch = {}) => {
    const current = toolRuns.get(id) || { id, title: '工具调用', state: 'running', startedAt: Date.now() }
    const next = { ...current, ...patch }
    toolRuns.set(id, next)
    emitTool(next)
    return next
  }
  const describeToolInput = (input: any = {}) => {
    if (typeof input === 'string') return input
    return input.command || input.description || input.prompt || input.url || input.query || input.path
      || input.file_path || input.skill || input.name || JSON.stringify(input).slice(0, 300)
  }
  function parseBalancedJSON(text: string): any {
    const start = text.search(/[[{]/)
    if (start < 0) return null
    const open = text[start]
    const close = open === '[' ? ']' : '}'
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return JSON.parse(text.slice(start, i + 1))
      }
    }
    return null
  }

  function truncateText(text: any, length = 520): string {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    return value.length > length ? `${value.slice(0, length)}…` : value
  }

  function formatToolResult(title: string, content: string): string {
    const query = content.match(/Web search results for query:\s*["“]([^"”]+)["”]/i)?.[1]
    const builtinMatch = content.match(/(?:\*\*)?\s*(?:🌐\s*)?([A-Za-z0-9_.-]+)\s+Built-in Tool:\s*([^\n*]+)/i)
    const provider = builtinMatch?.[1]
    const tool = builtinMatch?.[2]?.trim()
    const input = content.match(/\*\*Input:\*\*\s*```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
    const outputStart = content.search(/\*\*Output:\*\*/i)
    const output = outputStart >= 0 ? content.slice(outputStart).replace(/^\*\*Output:\*\*/i, '').trim() : ''
    if (provider && tool && /webreader/i.test(tool)) {
      const url = content.match(/"url"\s*:\s*"([^"]+)"/i)?.[1]
      const payloadText = content.slice(content.toLowerCase().indexOf('webreader_result_summary:'))
      const payload = parseBalancedJSON(payloadText)
      const node: any = Array.isArray(payload) ? payload[0] : payload
      const resultText: any = node?.text || node
      const summary = resultText?.description || resultText?.content || resultText?.summary
      return [
        `内嵌调用：${provider} ${tool}`,
        url ? `读取地址：${url}` : '',
        resultText?.title ? `页面标题：${resultText.title}` : '',
        summary ? `页面摘要：${truncateText(summary)}` : ''
      ].filter(Boolean).join('\n')
    }
    if (provider && tool) {
      return [
        `内嵌调用：${provider} ${tool}`,
        query ? `查询：${query}` : '',
        input ? `输入：${truncateText(input, 360)}` : '',
        output ? `输出：${truncateText(output, 520)}` : ''
      ].filter(Boolean).join('\n')
    }
    return [
      query ? `查询：${query}` : '',
      truncateText(content)
    ].filter(Boolean).join('\n')
  }
  function builtinToolMatch(text: string): { name: string, index: number } | null {
    const match = text.match(/(?:\*\*)?\s*(?:🌐\s*)?([A-Za-z0-9_.-]+)\s+Built-in Tool:\s*([^\n*]+)/i)
    return match ? { name: match[2]?.trim() || 'tool', index: match.index ?? 0 } : null
  }

  function builtinToolName(text: string): string | null {
    return builtinToolMatch(text)?.name || null
  }

  let buffer = ''
  let currentTextBlock = ''
  let currentTextInternal = false
  let currentTextMarkerAt = 0
  let currentTextEmitted = 0
  let zaiToolSequence = 0
  child.stdout.on('data', chunk => {
    lastActivityAt = Date.now()
    const text = stripAnsi(chunk.toString())
    stdout += text
    if (chosen.id === 'zcode') {
      onEvent({ reqId, type: 'content', text })
      return
    }
    buffer += text
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('{')) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (chosen.id === 'claude') {
        // 开启 partial 后，正文/思考用 delta 实时流式返回；完整 message 只用于工具状态。
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start') {
          const blockType = ev.event.content_block?.type
          if (blockType === 'text') {
            currentTextBlock = ''
            currentTextInternal = false
            currentTextMarkerAt = 0
            currentTextEmitted = 0
          }
          continue
        }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const delta = ev.event.delta || {}
          if (delta.type === 'text_delta' && delta.text) {
            claudeText += delta.text
            currentTextBlock += delta.text
            const toolMatch = builtinToolMatch(currentTextBlock)
            if (toolMatch && !currentTextInternal) {
              currentTextInternal = true
              currentTextMarkerAt = toolMatch.index
              // 当前 block 中可能先有正常说明；保留到内嵌工具标记前。
              const safeText = currentTextBlock.slice(0, currentTextMarkerAt)
              if (safeText.length < currentTextEmitted) {
                onEvent({ reqId, type: 'content-reset', text: safeText })
              }
              currentTextEmitted = safeText.length
            }
            if (currentTextInternal) {
              const chunk = currentTextBlock.slice(currentTextEmitted)
              if (chunk) {
                currentTextEmitted = currentTextBlock.length
                onEvent({ reqId, type: 'reasoning', text: chunk })
              }
              continue
            }
            if (currentTextBlock.length > currentTextEmitted) {
              emitContent(currentTextBlock.slice(currentTextEmitted))
              currentTextEmitted = currentTextBlock.length
            }
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            onEvent({ reqId, type: 'reasoning', text: delta.thinking })
          }
          continue
        }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_stop') {
          const blockType = ev.event.content_block?.type
          if (blockType === 'text' && currentTextInternal) {
            const toolName = builtinToolName(currentTextBlock) || 'built-in tool'
            const raw = currentTextBlock.slice(currentTextMarkerAt)
            setToolState(`zai-builtin-${++zaiToolSequence}`, {
              title: `Z.ai ${toolName}`,
              state: 'done',
              detail: formatToolResult(`Z.ai ${toolName}`, raw)
            })
          }
          if (blockType === 'text') {
            currentTextBlock = ''
            currentTextInternal = false
            currentTextMarkerAt = 0
            currentTextEmitted = 0
          }
          continue
        }
        if (ev.type === 'system' && ev.subtype === 'init') {
          setToolState('agent', { state: 'running', detail: `权限：${ev.permissionMode || 'default'}` })
        }
        for (const block of ev.message?.content || []) {
          if (block.type === 'tool_use') {
            setToolState(block.id, {
              title: block.name,
              detail: describeToolInput(block.input),
              state: 'running',
              startedAt: Date.now()
            })
          } else if (block.type === 'tool_result') {
            const content = Array.isArray(block.content)
              ? block.content.map(x => x.text || '').join('\n')
              : String(block.content || '')
            setToolState(block.tool_use_id, {
              state: block.is_error ? 'error' : 'done',
              finishedAt: Date.now(),
              detail: formatToolResult(block.name || '工具调用', content)
            })
          }
        }
        if (ev.type === 'result') {
          claudeFinal = ev.result || claudeText
          if (ev.is_error) finish({ ok: false, error: ev.result || ev.error || '本地 Agent 执行失败' })
        }
      } else {
        const item = ev.item
        if (ev.type === 'thread.started') {
          setToolState('agent', { state: 'running', detail: `thread ${ev.thread_id || ''}` })
        } else if (ev.type === 'item.started' && item) {
          setToolState(item.id, {
            title: item.type,
            detail: item.command || item.action || item.query || '',
            state: 'running',
            startedAt: Date.now()
          })
        } else if (ev.type === 'item.completed' && item) {
          if (item.type === 'agent_message' && item.text) {
            codexFinal = item.text
            emitContent(item.text)
          } else {
            setToolState(item.id, {
              state: item.exit_code === 0 || item.status === 'completed' ? 'done' : 'error',
              finishedAt: Date.now(),
              detail: String(item.aggregated_output || item.output || item.result || '').slice(0, 900)
            })
          }
        }
      }
    }
  })
  child.stderr.on('data', chunk => {
    lastActivityAt = Date.now()
    if (process.env.GLM_ASK_DEBUG) onEvent({ reqId, type: 'reasoning', text: stripAnsi(chunk.toString()) })
  })
  child.on('error', err => finish({ ok: false, error: err.message }))
  watchdog = setInterval(() => {
    const now = Date.now()
    if (now - lastActivityAt > 60_000) {
      finish({ ok: false, error: '本地 Agent 已 60 秒无响应，已自动停止' })
      abort(child)
    } else if (now - startedAt > 240_000) {
      finish({ ok: false, error: '本地 Agent 执行超时（4 分钟），已自动停止' })
      abort(child)
    }
  }, 1000)
  child.on('close', (code, signal) => {
    if (finished) return
    finished = true
    clearInterval(watchdog)
    if (signal) { onEvent({ reqId, type: 'done', ok: true, aborted: true }); return }
    let text = ''
    setToolState('agent', { state: signal ? 'error' : 'done', finishedAt: Date.now() })
    if (chosen.id === 'codex') {
      try { text = fs.readFileSync(outPath, 'utf8') } catch {}
      text = text.trim() || codexFinal
      try { fs.unlinkSync(outPath) } catch {}
    } else if (chosen.id === 'claude') {
      text = claudeFinal || claudeText
    } else {
      text = stdout
    }
    if (!text.trim()) onEvent({ reqId, type: 'done', ok: false, error: `本地 ${chosen.label} 未返回内容（exit ${code}）` })
    else {
      const finalText = text.trim()
      if (!streamedContent) onEvent({ reqId, type: 'content', text: finalText })
      onEvent({ reqId, type: 'done', ok: true, agent: chosen.id, final: finalText })
    }
  })
  return { ok: true, delegated: true, agent: chosen.id, child }
}

function abort(child) {
  try { child?.kill('TERM') } catch {}
}

export {}
