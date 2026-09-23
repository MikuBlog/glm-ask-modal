import assert from 'node:assert/strict'
import fs from 'node:fs'

const renderer = fs.readFileSync('dist/renderer/ask.js', 'utf8')

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

for (const name of ['retryFromError', 'regenerate']) {
  const body = fn(name)
  assert.match(body, /routeAndRespond\(/, `${name} must re-enter intent routing`)
  assert.doesNotMatch(body, /respond\(false\)/, `${name} must not bypass routing`)
}

assert.match(fn('routeAndRespond'), /routeRequest\(/)
assert.match(fn('focusSessionById'), /rememberScrollTop\(\)/)
assert.match(fn('focusSessionById'), /renderAll\(sessionScrollTops\.get\(target\.id\)\)/)

console.log('retry routing check: OK')
