/**
 * dsh-aura 面板「情绪」tab：假 React 冒烟（node 直接跑）。
 *   node dsh-aura/dev/emotion-ui-sim.mjs
 *
 * 不连 Host、不写任何文件。覆盖：
 *   「此刻情绪」卡：active episode 的类型中文/轻中重/原因/note/倾向/剩余时间；
 *   空状态「现在没有特别挂着的情绪」；
 *   nudge 卡显示 reasons/tags，「知道了」→ POST /dsh-aura/emotion-api {action:'clearNudge'}；
 *   清除后卡片消失；旧的四维 / 曲线 / 设置仍然渲染。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG } from '../host/state.js'

const FRAGMENT = Symbol('fragment')
let failures = 0
const check = (name, ok, extra) => {
  if (ok) console.log('  ok  ' + name)
  else {
    failures += 1
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 400)))
  }
}

/* ---------------- 最小 React ---------------- */
let currentInstance = null
let dirty = true
let pendingEffects = []
let panelInstance = null
let tree = null

function createElement(type, props, ...children) {
  const next = { ...(props || {}) }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  return { type, props: next }
}

function useState(initial) {
  const inst = currentInstance
  const index = inst.index++
  if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
  const set = value => {
    const previous = inst.hooks[index]
    const next = typeof value === 'function' ? value(previous) : value
    if (Object.is(next, previous)) return
    inst.hooks[index] = next
    dirty = true
  }
  return [inst.hooks[index], set]
}

function useRef(initial) {
  const inst = currentInstance
  const index = inst.index++
  if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
  return inst.hooks[index]
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

function useCallback(fn, deps) {
  const inst = currentInstance
  const index = inst.index++
  const previous = inst.hooks[index]
  if (previous && sameDeps(previous.deps, deps)) return previous.fn
  inst.hooks[index] = { fn, deps }
  return fn
}

function useEffect(fn, deps) {
  const inst = currentInstance
  const index = inst.index++
  const previous = inst.hooks[index]
  if (previous && sameDeps(previous.deps, deps)) return
  inst.hooks[index] = { deps, fn, cleanup: previous ? previous.cleanup : undefined, pending: true }
  pendingEffects.push({ inst, index })
}

const React = { createElement, Fragment: FRAGMENT, useState, useEffect, useRef, useCallback }

function flushEffects() {
  const batch = pendingEffects
  pendingEffects = []
  for (const { inst, index } of batch) {
    const slot = inst.hooks[index]
    if (!slot || slot.pending !== true) continue
    slot.pending = false
    if (typeof slot.cleanup === 'function') {
      try { slot.cleanup() } catch { /* ignore */ }
    }
    const result = slot.fn()
    slot.cleanup = typeof result === 'function' ? result : undefined
  }
}

function childrenOf(props) {
  const value = props ? props.children : undefined
  if (value === undefined || value === null || value === false || value === true) return []
  return Array.isArray(value) ? value : [value]
}

function build(vnode) {
  if (vnode === null || vnode === undefined || vnode === false || vnode === true) return null
  if (typeof vnode === 'string' || typeof vnode === 'number') return { kind: 'text', text: String(vnode) }
  if (Array.isArray(vnode)) return { kind: 'fragment', children: vnode.map(build).filter(Boolean) }
  const { type, props } = vnode
  if (type === FRAGMENT) return { kind: 'fragment', children: childrenOf(props).map(build).filter(Boolean) }
  if (typeof type === 'function') return build(type(props || {}))
  return { kind: 'element', tag: type, props: props || {}, children: childrenOf(props).map(build).filter(Boolean) }
}

function textOf(node) {
  if (!node) return ''
  if (node.kind === 'text') return node.text
  return (node.children || []).map(textOf).join(' ')
}

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function collect(node, out) {
  if (!node) return out
  if (node.kind === 'element') out.push(node)
  for (const child of node.children || []) collect(child, out)
  return out
}

function elements() {
  return collect(tree, [])
}

function findBy(predicate) {
  return elements().find(predicate) || null
}

function findByText(label, tag) {
  return findBy(el => el.tag === (tag || 'button') && tidy(textOf(el)) === label)
}

function findContaining(label, tag) {
  return findBy(el => el.tag === (tag || 'button') && textOf(el).includes(label))
}

function hasClass(element, name) {
  if (!element) return false
  return String(element.props.className || '').split(/\s+/).includes(name)
}

/* ---------------- 假定时器 / fetch ---------------- */
let timerSeq = 0
const intervals = new Map()
globalThis.setInterval = (fn, ms) => {
  const id = ++timerSeq
  intervals.set(id, { fn, ms, cleared: false })
  return id
}
globalThis.clearInterval = id => {
  const entry = intervals.get(id)
  if (entry) entry.cleared = true
}
globalThis.setTimeout = () => ++timerSeq
globalThis.clearTimeout = () => {}

function poll() {
  for (const entry of intervals.values()) {
    if (entry.cleared === false) entry.fn()
  }
}

/* ---------------- 假 Host 数据 ---------------- */
const config = { ...DEFAULT_CONFIG }
const base = Date.now() - 3600 * 1000
const history = [
  { at: base, valence: 0.1, arousal: 0.3, affection: 0.5, energy: 0.7, label: '平静', cause: '聊天', weight: 1 },
  { at: base + 600000, valence: 0.3, arousal: 0.4, affection: 0.55, energy: 0.68, label: '开心', cause: '你说好笑的事', weight: 1 },
]
function episode(type, intensity, level, cause, note, tendency, minutes) {
  const now = Date.now()
  return {
    id: 'ep-' + type + '-' + minutes,
    type,
    intensity,
    level,
    cause,
    note,
    tendency,
    source: 'tool',
    startedAt: now - 600000,
    expiresAt: now + minutes * 60000,
    updatedAt: now - 600000,
  }
}
const episodes = [
  episode('sadness', 0.5, 'medium', '忘了答应她的事', '有点闷，说不上来', 'repair', 30),
  episode('curiosity', 0.2, 'light', '你提到一个好玩的', '', 'share', 90),
]
const nudge = {
  tags: ['被否定', '烦死'],
  reasons: '那句像在否定她；如果她很在意你的看法，可能会被扎到。',
  at: Date.now() - 60000,
  expiresAt: Date.now() + 3600000,
}

function emotionSnapshot() {
  return {
    enabled: true,
    label: '难过',
    valence: -0.2,
    arousal: 0.35,
    affection: 0.55,
    energy: 0.68,
    socialNeed: 0.4,
    intensity: 0.5,
    mood: { valence: -0.1, arousal: 0.3 },
    cause: '忘了答应她的事',
    source: 'tool',
    style: 'subtle',
    stage: 'close',
    stageLabel: '亲密',
    updatedAt: base + 600000,
    baseline: { valence: 0.05, arousal: 0.4, affection: 0.5, energy: 0.7, updatedAt: base },
    trend: { direction: 'down', delta: -0.1, windowHours: 6, volatility: 0.05, reference: 'history' },
    history: history.slice(),
    lastChange: { at: base + 600000, label: '难过', cause: '忘了答应她的事', weight: 1 },
    episodes: episodes.filter(item => item.expiresAt > Date.now()).map(item => ({ ...item })),
    nudge: nudge && nudge.expiresAt > Date.now() ? { ...nudge } : null,
  }
}

const requests = []
function respond(data, status = 200) {
  return { ok: status < 400, status, json: async () => data }
}
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  requests.push({ url: target, init })
  const method = String(init.method || 'GET').toUpperCase()
  if (target === '/dsh-aura/api/state') {
    return respond({
      ok: true,
      config: { ...config },
      status: { online: false, startedAt: 0, lastError: '' },
      soul: {
        identity: { name: 'Aura' },
        relation: { stage: 'close', score: 50, days: 2, turns: 20, milestones: [] },
        emotion: emotionSnapshot(),
        speak: {},
        growth: [],
        explainLog: [],
      },
      proactive: {},
      sessions: [],
    })
  }
  if (target.startsWith('/dsh-aura/memory-api/state')) return respond({ ok: true, facts: [], entities: [], relations: [] })
  if (target === '/dsh-aura/persona-api/state') return respond({ ok: true, config: { ...config }, presets: [], activeId: '' })
  if (target.startsWith('/dsh-aura/life-api')) {
    return respond({
      ok: true,
      life: { state: 'awake', label: '醒着', activity: '', startedAt: base, elapsedMs: 600000, wakeMode: 'open', history: [] },
      history: [],
    })
  }
  if (target.startsWith('/dsh-aura/speak-api')) return respond({ ok: true })
  if (target === '/dsh-aura/emotion-api') {
    const body = method === 'POST' ? JSON.parse(init.body || '{}') : {}
    if (method === 'POST' && body.action === 'clearNudge') {
      nudge.expiresAt = 0
      return respond({ ok: true, cleared: true, nudge: null })
    }
    return respond({ ok: true, emotion: emotionSnapshot() })
  }
  if (target === '/dsh-aura/api/config' && method === 'POST') {
    Object.assign(config, JSON.parse(init.body || '{}'))
    return respond({ ok: true, config: { ...config }, status: {} })
  }
  return respond({ ok: false, error: 'unhandled ' + target }, 404)
}

/* ---------------- 载入 client.js，拿到 Panel ---------------- */
let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory: loaded }) {
      factory = loaded
    },
  },
}
const requireFn = id => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}
const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
const runClient = new Function('require', 'window', source) // eslint-disable-line no-new-func
runClient(requireFn, globalThis.window)
if (!factory) {
  console.error('client.js 没有通过 __ModuleLoader__ 暴露 factory')
  process.exit(1)
}

const registrations = []
const ctx = {
  get: () => undefined,
  effect: () => () => {},
  slots: {
    inject: (_name, fn) => {
      const result = fn()
      return typeof result === 'function' ? result : () => {}
    },
    register: (registration, component) => {
      registrations.push({ registration, component })
      return () => {}
    },
  },
}
const mod = factory(requireFn)
mod.apply(ctx)
const Panel = (registrations.find(item => item.registration && item.registration.name === 'main') || {}).component
if (typeof Panel !== 'function') {
  console.error('没有注册 main 面板组件')
  process.exit(1)
}
panelInstance = { hooks: [], index: 0 }

function commit() {
  panelInstance.index = 0
  currentInstance = panelInstance
  let output
  try {
    output = Panel({})
  } finally {
    currentInstance = null
  }
  tree = build(output)
  dirty = false
  flushEffects()
}

async function settle() {
  for (let round = 0; round < 100; round += 1) {
    if (dirty) {
      commit()
      continue
    }
    await new Promise(resolve => setImmediate(resolve))
    if (!dirty) {
      await new Promise(resolve => setImmediate(resolve))
      if (!dirty) return
    }
  }
  throw new Error('渲染没有收敛（可能有 effect 每次都改状态）')
}

async function clickButton(label) {
  const button = findByText(label)
  if (!button) throw new Error('找不到按钮：' + label)
  button.props.onClick && button.props.onClick({})
  await settle()
}

function lastPost(prefix) {
  const list = requests.filter(item => item.url.startsWith(prefix) && String(item.init.method || '').toUpperCase() === 'POST')
  return list[list.length - 1] || null
}
function postBody(request) {
  if (!request) return null
  try { return JSON.parse(request.init.body || '{}') } catch { return null }
}

/* ---------------- 测试 ---------------- */
console.log('\n[emotion-ui] 假 React 冒烟')
await settle()
check('Panel 注册成功', typeof Panel === 'function')

await clickButton('情绪')
const nowCard = findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-now'))
const nowText = () => tidy(textOf(nowCard))
check('「此刻情绪」卡出现', !!nowCard && nowText().includes('此刻情绪'))
check('active episode：类型中文 + 轻中重', nowText().includes('难过') && nowText().includes('中') && nowText().includes('好奇') && nowText().includes('轻'))
check('active episode：原因 / note / 倾向', nowText().includes('忘了答应她的事') && nowText().includes('有点闷，说不上来') && nowText().includes('想补一句'))
check('active episode：剩余时间', nowText().includes('30 分钟后散去') && nowText().includes('90 分钟后散去'))

const nudgeCard = findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-nudge'))
const nudgeText = () => tidy(textOf(nudgeCard))
check('nudge 卡显示标题 / reasons / tags', !!nudgeCard && nudgeText().includes('刚才那句')
  && nudgeText().includes('那句像在否定她') && nudgeText().includes('被否定') && nudgeText().includes('烦死'))
check('nudge 有「知道了」按钮', !!findByText('知道了'))

await clickButton('知道了')
const clearPost = lastPost('/dsh-aura/emotion-api')
const clearBody = postBody(clearPost)
check('「知道了」POST clearNudge', clearBody && clearBody.action === 'clearNudge', clearBody)
check('清除后 nudge 卡消失', !findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-nudge')))

// 旧四维 / 曲线 / 设置仍在
check('四维曲线仍在渲染', !!findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-chart')))
check('四维数值仍在渲染', tidy(textOf(tree)).includes('愉悦') && tidy(textOf(tree)).includes('0.55'))
check('表达方式设置仍在', !!findContaining('表达方式', 'div') || !!findContaining('表达方式', 'h2'))

// 空状态：没有 active episode / nudge
episodes.length = 0
nudge.expiresAt = 0
poll()
await settle()
const emptyCard = findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-now'))
check('空状态：现在没有特别挂着的情绪', tidy(textOf(emptyCard)).includes('现在没有特别挂着的情绪'))
check('空状态不渲染 nudge 卡', !findBy(el => el.tag === 'div' && hasClass(el, 'aura-emotion-nudge')))

console.log('\n' + (failures === 0 ? '✅ 情绪面板冒烟全部通过' : '❌ 情绪面板冒烟失败 ' + failures + ' 项'))
process.exitCode = failures === 0 ? 0 : 1
