import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')
const main = fs.readFileSync('dist/main/main.js', 'utf8')
const css = fs.readFileSync('dist/renderer/ask.css', 'utf8')

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

const outer = { scrollTop: 300, scrollHeight: 1000, clientHeight: 100, parentElement: null, dataset: { overflow: 'auto' } }
const list = { scrollTop: 0, scrollHeight: 300, clientHeight: 100, parentElement: outer, dataset: { overflow: 'auto' } }
const inner = { scrollTop: 0, scrollHeight: 200, clientHeight: 100, parentElement: list, dataset: { overflow: 'auto' } }
const context = {
  els: { scroll: outer },
  window: { getComputedStyle: el => ({ overflowY: el.dataset.overflow }) }
}
vm.runInNewContext([
  fn('isWheelScrollable'),
  fn('chainWheelScroll')
].join('\n'), context)

assert.equal(context.chainWheelScroll(inner, -100), true)
assert.equal(inner.scrollTop, 0)
assert.equal(list.scrollTop, 0)
assert.equal(outer.scrollTop, 200)

inner.scrollTop = 50
assert.equal(context.chainWheelScroll(inner, -100), true)
assert.equal(inner.scrollTop, 0)
assert.equal(outer.scrollTop, 200)

assert.match(renderer, /lastFocusSessionRequest/)
assert.match(renderer, /onFocusSession/)
assert.match(main, /requestId/)

const toolList = css.match(/\.tool-list\s*\{[\s\S]*?\}/)?.[0] || ''
assert.doesNotMatch(toolList, /overscroll-behavior:\s*contain/)

console.log('scroll behavior check: OK')
