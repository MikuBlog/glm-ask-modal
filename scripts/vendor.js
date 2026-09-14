// 把渲染层需要的 UMD 依赖从 node_modules 拷到 renderer/vendor，
// 并编译原生划词助手。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')

// ---------- 渲染层 vendor ----------
const pairs = [
  ['marked/lib/marked.umd.js', 'marked.min.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js']
]

const destDir = path.join(root, 'src', 'renderer', 'vendor')
fs.mkdirSync(destDir, { recursive: true })

for (const [src, dest] of pairs) {
  const from = path.join(root, 'node_modules', src)
  const to = path.join(destDir, dest)
  try {
    fs.copyFileSync(from, to)
    console.log('[vendor]', src, '->', to)
  } catch (e) {
    console.warn('[vendor] 缺少或拷贝失败:', src, e.message)
  }
}

// ---------- 原生助手 ----------
const helperBin = path.join(root, 'src', 'native', 'selected-text')
const helperSrc = path.join(root, 'src', 'native', 'get_selected_text.swift')

// 本机可能选择了未同意 license 的 Xcode；直接调用 Xcode toolchain + CLT SDK
// 可以避免 xcrun 的 license gate。SDK 固定用与当前 clang ABI 相容的版本。
function macToolchain() {
  if (process.platform !== 'darwin') return null
  const xcodeDeveloper = '/Applications/Xcode.app/Contents/Developer'
  const clang = path.join(xcodeDeveloper, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang')
  const swiftc = path.join(xcodeDeveloper, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc')
  const sdkRoot = '/Library/Developer/CommandLineTools/SDKs'
  const sdks = fs.existsSync(sdkRoot) ? fs.readdirSync(sdkRoot)
    .filter(name => /^MacOSX\d+\.\d+\.sdk$/.test(name))
    .sort((a, b) => Number(b.match(/\d+\.\d+/)[0]) - Number(a.match(/\d+\.\d+/)[0])) : []
  // 新 SDK 的 tbd 可能包含新 toolchain 才认识的 arm64e ABI；26.x 是当前兼容兜底。
  const compatible = sdks.find(name => name.startsWith('MacOSX26.'))
  const sdk = compatible ? path.join(sdkRoot, compatible) : (sdks.length ? path.join(sdkRoot, sdks[0]) : null)
  return {
    clang: fs.existsSync(clang) ? clang : 'clang',
    swiftc: fs.existsSync(swiftc) ? swiftc : 'swiftc',
    sdk
  }
}

function adhocSign(file) {
  try { execFileSync('codesign', ['-s', '-', '--force', file], { stdio: 'pipe', timeout: 30000 }) } catch {}
}

function buildHelper() {
  const tc = macToolchain()
  if (!tc) return false
  try {
    const args = ['-O', '-o', helperBin, helperSrc]
    if (tc.sdk) args.unshift('-sdk', tc.sdk)
    execFileSync(tc.swiftc, args, { stdio: 'pipe', timeout: 120000 })
    console.log('[helper] 原生划词助手编译成功:', helperBin)
    adhocSign(helperBin)
    return true
  } catch (e) {
    console.warn('[helper] 编译失败（应用将使用 Cmd+C 兜底读取选中文本）：', (e.stderr || e.message || '').toString().slice(0, 240))
    return false
  }
}

if (process.platform === 'darwin') {
  buildHelper()
}
process.exit(0)
