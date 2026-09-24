import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/renderer/ask.ts', 'utf8')

assert.doesNotMatch(source, /inputMouseSelecting/, 'mouse selection must not be disabled in the input')
assert.doesNotMatch(source, /setSelectionRange\(input\.value\.length,\s*input\.value\.length\)/, 'partial input selections must not be collapsed')
assert.doesNotMatch(source, /#input[\s\S]{0,200}user-select:\s*none/, 'input text must remain selectable')

console.log('input selection check: OK')
