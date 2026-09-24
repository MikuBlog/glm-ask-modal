import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/main/localAgents.ts', 'utf8')
assert.doesNotMatch(source, /240_000|执行超时/, 'local Agent must have no total runtime limit')
assert.match(source, /60_000[\s\S]*无响应/, 'local Agent must keep the inactivity guard')

console.log('agent timeout check: OK')
