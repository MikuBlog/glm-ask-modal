import assert from 'node:assert/strict'
import fs from 'node:fs'

const selection = fs.readFileSync('dist/main/selection.js', 'utf8')
const main = fs.readFileSync('dist/main/main.js', 'utf8')

assert.doesNotMatch(selection, /MULTICLICK_DEBOUNCE_MS|AMBIGUOUS_MICRO_DRAG_WAIT_MS|MULTICLICK_STABLE_MS/)
assert.doesNotMatch(selection, /scheduleMulticlickProbe\(/)
assert.match(selection, /clicks >= 2/)
assert.match(main, /SELECTION_SETTLE_MS = 50/)
assert.match(main, /MULTICLICK_PRESENT_MS = 500/)
assert.match(main, /const gestureStartedAt = Date\.now\(\)/)
assert.match(main, /MULTICLICK_PRESENT_MS - \(Date\.now\(\) - gestureStartedAt\)/)
assert.match(main, /await new Promise\(resolve => setTimeout\(resolve, SELECTION_SETTLE_MS\)\)/)
console.log('selection settle check: OK')
