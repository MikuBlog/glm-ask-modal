// 构建期准备：拷贝渲染层静态资源/UMD 依赖，并编译原生划词助手。
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const root = path.join(__dirname, '../..')
const distDir = path.join(root, 'dist')
const distRenderer = path.join(distDir, 'renderer')
const sourceRenderer = path.join(root, 'src', 'renderer')

function copyRendererAssets(): void {
  fs.mkdirSync(distRenderer, { recursive: true })
  fs.cpSync(sourceRenderer, distRenderer, {
    recursive: true,
    filter: (src: string) => !src.endsWith('.ts') && !src.includes(`${path.sep}vendor${path.sep}`)
  })
  console.log('[static]', sourceRenderer, '->', distRenderer)
}

function copyVendorDependencies(): void {
  const pairs: Array<[string, string]> = [
    ['marked/lib/marked.umd.js', 'marked.min.js'],
    ['dompurify/dist/purify.min.js', 'purify.min.js']
  ]
  const destDir = path.join(distRenderer, 'vendor')
  fs.mkdirSync(destDir, { recursive: true })

  for (const [src, dest] of pairs) {
    const from = path.join(root, 'node_modules', src)
    const to = path.join(destDir, dest)
    try {
      fs.copyFileSync(from, to)
      console.log('[vendor]', src, '->', to)
    } catch (e: any) {
      console.warn('[vendor] 缺少或拷贝失败:', src, e.message)
    }
  }
}

function macToolchain(): any {
  if (process.platform !== 'darwin') return null
  const xcodeDeveloper = '/Applications/Xcode.app/Contents/Developer'
  const clang = path.join(xcodeDeveloper, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang')
  const swiftc = path.join(xcodeDeveloper, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc')
  const sdkRoot = '/Library/Developer/CommandLineTools/SDKs'
  const sdks = fs.existsSync(sdkRoot)
    ? fs.readdirSync(sdkRoot)
        .filter((name: string) => /^MacOSX\d+\.\d+\.sdk$/.test(name))
        .sort((a: string, b: string) => Number(b.match(/\d+\.\d+/)![0]) - Number(a.match(/\d+\.\d+/)![0]))
    : []
  const compatible = sdks.find((name: string) => name.startsWith('MacOSX26.'))
  const sdk = compatible ? path.join(sdkRoot, compatible) : (sdks.length ? path.join(sdkRoot, sdks[0]) : null)
  return {
    clang: fs.existsSync(clang) ? clang : 'clang',
    swiftc: fs.existsSync(swiftc) ? swiftc : 'swiftc',
    sdk
  }
}

function adhocSign(file: string): void {
  try { execFileSync('codesign', ['-s', '-', '--force', file], { stdio: 'pipe', timeout: 30000 }) } catch {}
}

function buildHelper(): boolean {
  const tc = macToolchain()
  if (!tc) return false
  const helperBin = path.join(distDir, 'native', 'selected-text')
  const helperSrc = path.join(root, 'src', 'native', 'get_selected_text.swift')
  try {
    const args: string[] = ['-O', '-o', helperBin, helperSrc]
    if (tc.sdk) args.unshift('-sdk', tc.sdk)
    fs.mkdirSync(path.dirname(helperBin), { recursive: true })
    execFileSync(tc.swiftc, args, { stdio: 'pipe', timeout: 120000 })
    console.log('[helper] 原生划词助手编译成功:', helperBin)
    adhocSign(helperBin)
    return true
  } catch (e: any) {
    console.warn('[helper] 编译失败（应用将使用 Cmd+C 兜底读取选中文本）：', (e.stderr || e.message || '').toString().slice(0, 240))
    return false
  }
}

copyRendererAssets()
copyVendorDependencies()
if (process.platform === 'darwin') buildHelper()
process.exit(0)
