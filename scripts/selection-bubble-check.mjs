import assert from 'node:assert/strict'
import fs from 'node:fs'

const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')
const selection = fs.readFileSync('dist/main/selection.js', 'utf8')
const main = fs.readFileSync('dist/main/main.js', 'utf8')

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

assert.match(fn('clearPending'), /hideSelbar\(\)/, 'fresh sessions must clear the in-popup selection bubble')

const inputListeners = renderer.match(/els\.input\.addEventListener\('input',[^]+?\n\}\)/g) || []
assert.match(inputListeners.join('\n'), /hideSelbar\(\)/, 'typing must hide the in-popup selection bubble')
assert.match(renderer, /els\.input\.addEventListener\('focus',\s*\(\)\s*=>\s*hideSelbar\(\)\)/, 'focusing the input must hide a stale selection bubble')

assert.match(selection, /isTypingKey/)
assert.match(selection, /selectionTriggerTimer = null/, 'typing must cancel a pending keyboard selection probe')
assert.match(main, /onTyping:\s*\(\)\s*=>\s*hideToolbar\(\)/, 'typing in any app must hide the external selection toolbar')

console.log('selection bubble check: OK')
