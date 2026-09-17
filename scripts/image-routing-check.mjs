import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const file = process.argv[2] || 'dist/renderer/ask.js'
const src = fs.readFileSync(file, 'utf8')

function fn(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is missing`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`Unable to extract ${name}`)
}

assert.equal(src.includes("type: 'image_url'"), false, 'GLM request must be text-only')

const context = {}
vm.runInNewContext([
  fn('normalizeImage'),
  fn('normalizeImages'),
  fn('imagePrompt'),
  fn('buildUserContent')
].join('\n'), context)

const content = context.buildUserContent({
  text: '这个是啥',
  images: [{ src: 'data:image/png;base64,AAA', path: '/tmp/a.png', name: 'a.png' }]
})
assert.equal(typeof content.text, 'string')
assert.match(content.text, /\/tmp\/a\.png/)
assert.equal('images' in content, false)

console.log('image routing check: OK')
