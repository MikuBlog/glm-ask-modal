import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync('src/main/main.ts', 'utf8')
const llmSource = fs.readFileSync('src/main/llm.ts', 'utf8')
const match = source.match(/maxTokens:\s*(\d+)/)
assert.ok(match, 'intent classification maxTokens is missing')
assert.ok(Number(match[1]) >= 1024, 'intent classification must leave room for model reasoning before JSON output')

function fn(name) {
  const start = llmSource.indexOf(`async function ${name}(`) >= 0
    ? llmSource.indexOf(`async function ${name}(`)
    : llmSource.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is missing`)
  const open = llmSource.indexOf('{', llmSource.indexOf(') {', start))
  let depth = 0
  for (let i = open; i < llmSource.length; i++) {
    if (llmSource[i] === '{') depth++
    else if (llmSource[i] === '}') {
      depth--
      if (depth === 0) return llmSource.slice(start, i + 1)
    }
  }
  assert.fail(`Unable to extract ${name}`)
}

function makeComplete(fetchImpl) {
  const context = {
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext([
    fn('chatUrl'),
    fn('normalizeUsage'),
    fn('parseJsonObject'),
    fn('sumUsage'),
    fn('complete')
  ].join('\n'), context)
  return context.complete
}

const thinkingModes = []
let fallbackComplete = await makeComplete(async (url, options) => {
  const body = JSON.parse(options.body)
  thinkingModes.push(body.thinking)
  if (thinkingModes.length === 1) {
    return {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: { message: 'This model always engages in thinking and cannot be disabled; please use low, high, or max' }
      })
    }
  }
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"use_agent":false}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    })
  }
})({
  baseUrl: 'https://example.invalid/v4',
  apiKey: 'test',
  model: 'test',
  messages: [],
  maxTokens: 1024
})
assert.deepEqual(thinkingModes, [
  { type: 'disabled' },
  { type: 'enabled', effort: 'low' }
])
assert.equal(JSON.stringify(fallbackComplete), JSON.stringify({
  text: '{"use_agent":false}',
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
}))

const fastModes = []
const fastComplete = await makeComplete(async (url, options) => {
  fastModes.push(JSON.parse(options.body).thinking)
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] })
  }
})({
  baseUrl: 'https://example.invalid/v4',
  apiKey: 'test',
  model: 'test',
  messages: []
})
assert.deepEqual(fastModes, [{ type: 'disabled' }])
assert.equal(fastComplete.text, 'ok')

const invalidModes = []
const invalidUsage = []
const retryComplete = await makeComplete(async (url, options) => {
  const body = JSON.parse(options.body)
  invalidModes.push(body.thinking)
  const invalid = invalidModes.length === 1
  invalidUsage.push(invalid ? 1 : 2)
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: invalid ? 'not-json' : '{"use_agent":true}' } }],
      usage: invalid
        ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        : { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 }
    })
  }
})({
  baseUrl: 'https://example.invalid/v4',
  apiKey: 'test',
  model: 'test',
  messages: [],
  maxTokens: 1024,
  requireObject: true
})
assert.deepEqual(invalidModes, [
  { type: 'disabled' },
  { type: 'enabled', effort: 'low' }
])
assert.equal(retryComplete.text, '{"use_agent":true}')
assert.equal(JSON.stringify(retryComplete.usage), JSON.stringify({
  promptTokens: 30,
  completionTokens: 11,
  totalTokens: 41
}))

console.log('intent classification check: OK')
