import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')
const store = fs.readFileSync('dist/main/store.js', 'utf8')

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
vm.runInNewContext([
  fn('normalizeImage'),
  fn('normalizeImages'),
  fn('emptyUsageTotal'),
  fn('normalizeUsageTotal'),
  fn('normalizeSession')
].join('\n'), context)

const session = {
  messages: [
    { role: 'user', text: '测试' },
    {
      role: 'assistant',
      done: false,
      reasoning: '正在执行…',
      reasoningDone: false,
      tools: [{ id: 'agent', state: 'running' }]
    }
  ],
  draft: {}
}
context.normalizeSession(session)
const interrupted = session.messages[1]
assert.equal(interrupted.done, true)
assert.equal(interrupted.reasoningDone, true)
assert.equal(interrupted.interrupted, true)
assert.match(interrupted.error, /应用意外退出/)
assert.equal(session.streamingReqId, null)

const focus = fn('focusSessionById')
assert.match(focus, /if \(target && !activeStream\(target\)\)/, 'cached sessions must also be normalized when their stream is gone')
assert.match(focus, /target = normalizeSession\(target\)/)

const storeStart = store.indexOf('function normalizeStoredSession(')
assert.ok(storeStart >= 0, 'main-process stored-session normalization is missing')
const storeContext = {}
vm.runInNewContext(store.slice(storeStart, store.indexOf('\nfunction readAllSessions', storeStart)), storeContext)
const stored = {
  messages: [{ role: 'assistant', done: false, reasoningDone: false }]
}
storeContext.normalizeStoredSession(stored)
assert.equal(stored.messages[0].done, true)
assert.equal(stored.messages[0].interrupted, true)
assert.match(stored.messages[0].error, /应用意外退出/)
assert.match(store, /return normalizeStoredSession\(readAllSessions\(\)\.find/)

console.log('interrupted session check: OK')
