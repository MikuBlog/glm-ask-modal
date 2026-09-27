import assert from 'node:assert/strict'
import fs from 'node:fs'

const main = fs.readFileSync('dist/main/main.js', 'utf8')

function fn(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is missing`)
  const open = main.indexOf('{', start)
  let depth = 0
  for (let i = open; i < main.length; i++) {
    if (main[i] === '{') depth++
    else if (main[i] === '}') {
      depth--
      if (depth === 0) return main.slice(start, i + 1)
    }
  }
  assert.fail(`Unable to extract ${name}`)
}

assert.match(fn('createToolbar'), /setAlwaysOnTop\(true,\s*'screen-saver'\)/)
assert.match(fn('createAsk'), /setAlwaysOnTop\(true,\s*'floating'\)/)
assert.doesNotMatch(fn('createAsk'), /setAlwaysOnTop\(true,\s*'screen-saver'\)/)
console.log('window level check: OK')
