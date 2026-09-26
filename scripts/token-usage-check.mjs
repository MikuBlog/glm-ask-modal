import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const llm = fs.readFileSync('dist/main/llm.js', 'utf8')
const localAgents = fs.readFileSync('dist/main/localAgents.js', 'utf8')
const html = fs.readFileSync('dist/renderer/ask.html', 'utf8')
const css = fs.readFileSync('dist/renderer/ask.css', 'utf8')
const main = fs.readFileSync('dist/main/main.js', 'utf8')
const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')

assert.match(llm, /stream_options:\s*\{\s*include_usage:\s*true\s*\}/)
assert.match(llm, /usage:\s*lastUsage/)

assert.match(main, /usage:\s*raw\.usage/)
assert.match(localAgents, /usage:\s*agentUsage/)
assert.match(renderer, /addUsage\(intentMsg\.usage,\s*route\.usage\)/)
assert.match(renderer, /addUsage\(m\.usage,\s*ev\.usage\)/)
assert.match(html, /id="btn-usage"/)
assert.match(html, /id="usage-menu"/)
assert.match(html, /class="usage-text">Tokens<\/span>\s*<span id="usage-label">0<\/span>/)
assert.doesNotMatch(html, /class="sigma"/)
assert.match(renderer, /usageTotal/)
assert.match(renderer, /recordSessionUsage\(owner,\s*route\.usage\)/)
assert.match(renderer, /recordSessionUsage\(owner,\s*ev\.usage\)/)
assert.match(renderer, /renderSessionUsage\(\)/)
assert.match(fn('clearPending'), /renderSessionUsage\(\)/, 'clearing a fresh session must refresh session usage')
assert.match(renderer, /positionUsageMenu\(\)/)
assert.match(renderer, /usageLabel\.textContent = formatTokenCount/)
assert.doesNotMatch(renderer, /usageLabel\.textContent = `Tokens /)
assert.match(renderer, /当前会话累计消耗/)
assert.match(renderer, /recordContextUsage\(owner,\s*ev\.usage/)
assert.match(renderer, /formatContextUsage/)

const usageMenuCss = css.match(/#usage-menu\s*\{[\s\S]*?\}/)?.[0] || ''
assert.match(usageMenuCss, /width:\s*320px/)
assert.match(usageMenuCss, /right:\s*auto/)
assert.match(css, /\.usage-context-track/)
assert.match(css, /\.usage-context-fill/)
assert.match(css, /linear-gradient\(90deg/)

function fn(name) {
  const start = renderer.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is missing`)
  const open = renderer.indexOf('{', start)
  let depth = 0
  for (let i = open; i < renderer.length; i++) {
    if (renderer[i] === '{') depth++
    else if (renderer[i] === '}') {
      depth--
      if (depth === 0) return renderer.slice(start, i + 1)
    }
  }
  assert.fail(`Unable to extract ${name}`)
}

const context = {}
context.session = {}
context.window = { addEventListener: () => {} }
context.els = {
  btnUsage: {
    classList: { toggle(name, show) { this.visible = show } },
    title: ''
  },
  usageLabel: { textContent: '' },
  usageMenu: {
    classList: { contains: () => true },
    innerHTML: '',
    style: {},
    offsetWidth: 320
  },
  dockbar: { clientWidth: 600 }
}
vm.runInNewContext([
  fn('addUsage'),
  fn('emptyUsageTotal'),
  fn('normalizeUsageTotal'),
  fn('formatTokenCount'),
  fn('formatContextTokens'),
  fn('formatTokenUsage'),
  fn('recordSessionUsage'),
  fn('contextLimitForModel'),
  fn('recordContextUsage'),
  fn('formatContextUsage'),
  fn('renderSessionUsage'),
  fn('renderUsageMenu'),
  fn('positionUsageMenu')
].join('\n'), context)
const usage = context.addUsage(
  { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  { promptTokens: 15, completionTokens: 16, totalTokens: 31 }
)
assert.equal(JSON.stringify(usage), JSON.stringify({ promptTokens: 115, completionTokens: 36, totalTokens: 151 }))
assert.equal(
  context.formatTokenUsage(usage),
  ' · Tokens 151（输入 115 / 输出 36）'
)

const agentContext = {}
const agentStart = localAgents.indexOf('function usageFromAgentEvent(')
assert.ok(agentStart >= 0, 'usageFromAgentEvent is missing')
vm.runInNewContext(localAgents.slice(agentStart, localAgents.indexOf('\nfunction stream(', agentStart)), agentContext)
assert.equal(JSON.stringify(agentContext.usageFromAgentEvent('claude', {
  type: 'result',
  usage: { input_tokens: 24293, output_tokens: 30 }
})), JSON.stringify({ promptTokens: 24293, completionTokens: 30, totalTokens: 24323 }))
assert.equal(JSON.stringify(agentContext.usageFromAgentEvent('codex', {
  type: 'turn.completed',
  usage: { input_tokens: 37594, output_tokens: 44 }
})), JSON.stringify({ promptTokens: 37594, completionTokens: 44, totalTokens: 37638 }))

const session = context.session
context.recordSessionUsage(session, { promptTokens: 100, completionTokens: 20, totalTokens: 120 })
context.recordSessionUsage(session, { promptTokens: 15, completionTokens: 16, totalTokens: 31 })
context.recordSessionUsage(session, null)
assert.equal(JSON.stringify(session.usageTotal), JSON.stringify({
  promptTokens: 115,
  completionTokens: 36,
  totalTokens: 151,
  reportedRequests: 2,
  missingUsageRequests: 1
}))
context.renderSessionUsage()
assert.equal(context.els.usageLabel.textContent, '151')
assert.match(context.els.btnUsage.title, /Tokens 151/)

context.session.contextUsage = null
context.recordContextUsage(context.session, {
  promptTokens: 158000,
  completionTokens: 10000,
  contextLimit: 1000000,
  contextModel: 'glm-5.3-flash'
}, null)
assert.equal(
  JSON.stringify(context.session.contextUsage),
  JSON.stringify({
    tokens: 168000,
    limit: 1000000,
    model: 'glm-5.3-flash'
  })
)
assert.equal(context.formatContextUsage(context.session.contextUsage), '16.8万/100万（16.8%）')
assert.equal(context.formatContextUsage(null), '')

Object.assign(context.els.btnUsage, { offsetLeft: 300, offsetWidth: 100, offsetParent: context.els.dockbar })
context.positionUsageMenu()
assert.equal(context.els.usageMenu.style.left, '190px')
assert.equal(context.els.usageMenu.style.right, 'auto')
console.log('token usage check: OK')
