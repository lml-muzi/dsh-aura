/**
 * 装配级冒烟：不连 QQ、不进 DSH，用假 ctx 跑 index.apply 装配 + 一轮假会话事件，
 * 验证 soul/emotion/memory/speak 注册、prompt 注入、工具、面板 /state。
 * 运行：DSH_HOME=/data/data/com.termux/files/home/workspace/.devhome node dev/aura-integration-sim.mjs
 */
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME
if (!home || !home.includes('.devhome')) {
  console.error('请把 DSH_HOME 指到临时目录（含 .devhome）')
  process.exit(1)
}
rmSync(join(home, 'dsh-aura'), { recursive: true, force: true })

const { apply } = await import('../index.js')

const handlers = new Map()
const effects = []
const routes = []
const tools = new Map()
const sections = []
const contexts = []
const provided = new Map()
let failures = 0
const check = (name, ok, extra) => {
  if (ok) console.log('  ok  ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')) }
}
const on = (name, fn) => { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); return () => {} }
const emit = (name, ...args) => { for (const fn of handlers.get(name) || []) fn(...args) }

const ctx = {
  on,
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return () => {} },
  provide(name, value) { provided.set(name, value); return () => {} },
  get(name) {
    if (name === 'credentials') return undefined
    if (name === 'workspaceRegistry') return { list: () => [] }
    if (name === 'workingDirectory') return { defaultDirectory: '/tmp' }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
    if (name === 'llm') return undefined
    if (name === 'schedule') return { create: async () => ({ id: 's1' }) }
    return undefined
  },
  systemPrompt: {
    section(config) { sections.push(config); return () => {} },
    context(config) { contexts.push(config); return () => {} },
  },
  tools: {
    register(def) { tools.set(def.name, def); return () => {} },
    restrict() { return () => {} },
    guard() { return () => {} },
  },
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  agents: { get: () => undefined },
  agentPresets: { mount: async () => {} },
}

// 一份不自动连接的配置：只测装配
const { writeJson } = await import('../host/state.js')
writeJson('config.json', { appId: '1', appSecret: 'x', autoConnect: false, speakEnabled: true, speakDryRun: true, quietStart: '00:00', quietEnd: '00:00', expressionStyle: 'explicit' })

apply(ctx, {})
console.log('装配完成：sections', sections.length, 'contexts', contexts.length, 'tools', [...tools.keys()].join(','), 'routes', routes.length)

check('注册了身份 section', sections.some(s => s.name === 'aura:soul-identity'))
check('注册了情绪 context', contexts.some(c => c.name === 'aura:emotion'))
check('注册了记忆 context', contexts.some(c => c.name === 'aura:memory'))
check('注册了临场 context', contexts.some(c => c.name === 'aura:presence'))
check('注册了主动念头 context', contexts.some(c => c.name === 'aura:intent'))
for (const tool of ['soul_mood', 'soul_note', 'soul_recall', 'dsh_im_return_file']) {
  check(`注册工具 ${tool}`, tools.has(tool))
}
check('提供了 dshAura 服务', provided.has('dshAura'))

// ---- 一轮假会话：QQ 会话 user/message → assistant/message → turn/end ----
const now = Date.now()
const session = { id: 'qq:dm:1:USER1', header: { cwd: '/tmp' } }
emit('session/event', session, {
  type: 'user/message', time: now,
  data: {
    id: 'qq-11111111-1111-1111-1111-111111111111',
    role: 'user',
    content: [{ type: 'text', text: '今天加班到十点，累死了，不过项目终于上线了，好开心' }],
    source: { kind: 'user', rpcId: 'qq-11111111-1111-1111-1111-111111111111' },
  },
})
await new Promise(r => setTimeout(r, 120))
emit('session/event', session, {
  type: 'assistant/message', time: now + 1000, surfaceOp: 'append',
  data: { message: { content: [{ type: 'text', text: '辛苦啦，上线是大事，值得庆祝一下。' }] }, turn: 1 },
})
emit('session/event', session, { type: 'turn/end', time: now + 1200, data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise(r => setTimeout(r, 1400))

const soulFile = join(home, 'dsh-aura', 'soul.json')
check('soul.json 已落盘', existsSync(soulFile))
const soul = existsSync(soulFile) ? JSON.parse(readFileSync(soulFile, 'utf8')) : {}
check('关系回合数 +1', (soul.relation?.turns || 0) >= 1, soul.relation?.turns)
check('关系分 > 0', (soul.relation?.score || 0) > 0, soul.relation?.score)
check('情绪被用户消息推动（有 updatedAt）', (soul.emotion?.transient?.updatedAt || 0) > 0)
check('记忆事件流有记录', (soul.memory?.events?.length || 0) > 0, soul.memory?.events?.length)

// ---- prompt 文本真的出内容 ----
const assembly = { agent: { session } }
const textOf = (config) => { try { return String(config.text(assembly) || '') } catch { return '' } }
check('身份段文本非空', textOf(sections.find(s => s.name === 'aura:soul-identity')).length > 50)
check('情绪段文本非空', textOf(contexts.find(c => c.name === 'aura:emotion')).length > 0)
check('记忆段文本非空（有事件后）', textOf(contexts.find(c => c.name === 'aura:memory')).length > 0)
check('临场段文本非空', textOf(contexts.find(c => c.name === 'aura:presence')).length > 0)

// ---- 工具：soul_mood 自报 ----
const mood = await tools.get('soul_mood').execute({ valence: 0.8, arousal: 0.6, cause: '项目上线' }, { agent: { session } })
check('soul_mood 返回 ok', mood && mood.ok !== false, mood)
const note = await tools.get('soul_note').execute({ category: 'user', text: '用户在做项目上线，经常加班', importance: 0.8 }, { agent: { session } })
check('soul_note 返回 ok', note && note.ok !== false, note)
const recall = await tools.get('soul_recall').execute({ query: '加班 项目', limit: 5 }, { agent: { session } })
check('soul_recall 能召回', Array.isArray(recall?.items) || Array.isArray(recall) || (recall && recall.ok !== false), recall)

// ---- 面板 API：/state ----
const apiRoute = routes.find(r => r.path === '/dsh-aura/api')
check('注册了面板路由', !!apiRoute)
if (apiRoute) {
  const result = await new Promise((resolve) => {
    const req = { method: 'GET', url: '/dsh-aura/api/state', headers: { host: '127.0.0.1:3080' }, on() {}, destroy() {} }
    const chunks = []
    const res = {
      writeHead() {},
      end(data) { resolve(JSON.parse(String(data))) },
    }
    Promise.resolve(apiRoute.handler(req, res)).catch(error => resolve({ error: String(error) }))
  })
  check('GET /state ok', result?.ok === true, result)
  check('/state 带 soul 快照', !!result?.soul?.identity, result?.soul && Object.keys(result.soul))
  check('/state memory 有事件', (result?.soul?.memory?.events?.length || 0) > 0, result?.soul?.memory)
  check('/state 带 speak 快照', !!result?.soul?.speak && result.soul.speak.dryRun !== undefined, result?.soul?.speak)
}

const service = provided.get('dshAura')
const statusNow = service?.status?.()
check('dshAura.status() 有 soul', !!statusNow?.soul?.identity, statusNow && Object.keys(statusNow.soul || {}))

for (const dispose of effects) { try { dispose() } catch { /* ignore */ } }
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
