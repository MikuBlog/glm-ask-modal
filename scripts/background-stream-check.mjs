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

const respond = fn('respond')
assert.match(respond, /owner = session\)/, 'respond must accept an explicit owner session')
assert.doesNotMatch(respond, /const owner = session/, 'respond must not re-read the currently selected session')
assert.match(fn('routeAndRespond'), /respond\(route\.delegated,\s*intentMsg,\s*route\.agent,\s*owner\)/, 'late intent completion must target its original session')

const newTopic = fn('newTopic')
assert.doesNotMatch(newTopic, /supersedeActiveStream|clearStreamingRequest|askAPI\.abort/, 'creating a new topic must not abort the old topic stream')

console.log('background stream check: OK')
