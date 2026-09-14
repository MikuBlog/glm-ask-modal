// 配置与会话历史持久化（userData 下的 JSON 文件）
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const DEFAULTS = {
  apiKey: '',
  // 智谱开放平台 OpenAI 兼容端点；GLM Coding Plan 用户可换成
  // https://open.bigmodel.cn/api/coding/paas/v4 （或 z.ai 国际版对应地址）
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  models: ['glm-5.3-flash', 'glm-5.3'],
  model: 'glm-5.3-flash',
  effort: 'max', // 推理强度：low（低，关闭思考）/ high（高）/ max（最高，深度思考）
  blacklist: [], // 在这些应用中禁用划词工具条（bundleId）
  hotkeyEnabled: true,
  openAtLogin: false, // 登录时后台启动，不自动弹出窗口
  localAgent: 'auto', // auto/zcode/claude/codex/direct
  intentModel: 'glm-5.3-flash', // 独立意图识别模型
  agentExec: true, // 本地 Agent 是否获得真实执行权限（Skill / MCP / CLI）
  askWidth: 780, // 问一问弹窗持久化宽度
  askHeight: 640 // 问一问弹窗持久化高度
}

let cfg = null

function filePath(name) {
  return path.join(app.getPath('userData'), name)
}

function loadConfig() {
  if (cfg) return cfg
  try {
    const raw = JSON.parse(fs.readFileSync(filePath('config.json'), 'utf8'))
    cfg = { ...DEFAULTS, ...raw }
  } catch {
    cfg = { ...DEFAULTS }
  }
  return cfg
}

function saveConfig(patch) {
  cfg = { ...loadConfig(), ...patch }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(filePath('config.json'), JSON.stringify(cfg, null, 2))
  return cfg
}

// ---------- 会话历史 ----------
function readAllSessions() {
  try {
    return JSON.parse(fs.readFileSync(filePath('history.json'), 'utf8')).sessions || []
  } catch {
    return []
  }
}

function writeAllSessions(list) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(filePath('history.json'), JSON.stringify({ sessions: list.slice(0, 50) }, null, 2))
}

function listSessions() {
  return readAllSessions()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
}

function saveSession(session) {
  if (!session || !session.messages || !session.messages.length) return
  const list = readAllSessions().filter(s => s.id !== session.id)
  list.push(session)
  writeAllSessions(list)
}

function getSession(id) {
  return readAllSessions().find(s => s.id === id) || null
}

function deleteSession(id) {
  writeAllSessions(readAllSessions().filter(s => s.id !== id))
}

module.exports = { loadConfig, saveConfig, listSessions, saveSession, getSession, deleteSession }

export {}
