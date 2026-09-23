import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')
const start = renderer.indexOf('function toolTraceStatus(')
assert.ok(start >= 0, 'toolTraceStatus is missing')
const open = renderer.indexOf('{', start)
let depth = 0
let end = -1
for (let i = open; i < renderer.length; i++) {
  if (renderer[i] === '{') depth++
  else if (renderer[i] === '}') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
assert.ok(end > 0, 'Unable to extract toolTraceStatus')

const context = {}
vm.runInNewContext(renderer.slice(start, end), context)
const status = context.toolTraceStatus
function assertStatus(input, state, title) {
  const actual = status(input)
  assert.equal(actual.state, state)
  assert.equal(actual.title, title)
}

assertStatus({ done: true, error: null, text: '最终回答', tools: [{ state: 'done' }, { state: 'error' }] }, 'done', '执行完成')
assertStatus({ done: true, error: '请求失败', text: '', tools: [{ state: 'done' }] }, 'error', '执行失败')
assertStatus({ done: false, error: null, text: '', tools: [{ state: 'done' }] }, 'running', '执行中')
assertStatus({ done: true, aborted: true, error: null, text: '', tools: [{ state: 'done' }] }, 'done', '已停止')
assertStatus({ done: true, error: null, text: '', tools: [{ state: 'done' }] }, 'done', '执行完成')

console.log('tool status check: OK')
