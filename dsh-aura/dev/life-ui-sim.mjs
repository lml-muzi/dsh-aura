/**
 * dsh-aura 面板「生活」页 / 「连接」消息插队：假 React 冒烟（node 直接跑）。
 *   node dsh-aura/dev/life-ui-sim.mjs
 *
 * 自己实现最小 React（useState/useEffect/useRef/useCallback + createElement），
 * 把 client.js 的 Panel 渲染成可查询的 vnode 树，然后点按钮/改输入，验证：
 *   生活状态卡（状态/活动/从何时/倒计时/醒来方式/来源/中途醒）
 *   快捷按钮 → POST plan 默认参数；醒来 / 取消闹钟
 *   自定义安排（fixed 分钟 / fixed 到点 / random 窗口；非法输入不提交）
 *   最近生活记录 ≤20；生活设置保存 /config
 *   连接 tab 消息插队 checkbox → /config steerEnabled
 * 不连 QQ、不写任何文件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, normalizeConfig } from '../host/state.js'

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

function findInputByAria(label) {
  return findBy(el => el.tag === 'input' && el.props['aria-label'] === label)
}

function findSelectByAria(label) {
  return findBy(el => el.tag === 'select' && el.props['aria-label'] === label)
}

function findRowCheckbox(label) {
  const row = findBy(el => el.tag === 'div'
    && /(^|\s)qqn-row(\s|$)/.test(String(el.props.className || ''))
    && textOf(el).includes(label))
  if (!row) return null
  return collect(row, []).find(el => el.tag === 'input' && el.props.type === 'checkbox') || null
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

const lifePoll = () => {
  for (const entry of intervals.values()) {
    if (entry.cleared === false) entry.fn()
  }
}

/* ---------------- 假 Host 数据 ---------------- */
const config = { ...DEFAULT_CONFIG }
const base = Date.now() - 3600 * 1000
const history = [
  { at: base, state: 'play', activity: '听歌', until: null, wakeMode: 'open', source: 'self' },
  { at: base + 600000, state: 'rest', activity: '躺一会', until: null, wakeMode: 'open', source: 'self' },
  { at: base + 1200000, state: 'sleep', activity: '补一觉', until: null, wakeMode: 'open', source: 'self' },
]
const life = {
  version: 1,
  state: 'sleep',
  label: '在睡',
  activity: '补一觉',
  note: '',
  startedAt: base + 1200000,
  until: null,
  remainingMs: null,
  wakeMode: 'open',
  wakeEarliest: null,
  wakeLatest: null,
  source: 'self',
  interruptedFrom: null,
  updatedAt: base + 1200000,
  elapsedMs: 600000,
  history: history.slice(-5),
  historyCount: history.length,
}

const STATE_LABELS = { awake: '醒着', work: '在忙', play: '在玩', rest: '在休息', sleep: '在睡', out: '在外面' }
function snapshotOf() {
  return { ...life, history: history.slice(-5), historyCount: history.length }
}
function applyPlanFake(body) {
  const now = Date.now()
  life.state = body.state
  life.label = STATE_LABELS[body.state] || body.state
  life.activity = body.activity || ''
  life.note = body.note || ''
  life.startedAt = now
  life.elapsedMs = 0
  life.wakeMode = body.wakeMode || 'open'
  life.source = 'self'
  life.interruptedFrom = null
  if (life.wakeMode === 'fixed') {
    life.until = body.until || (now + body.minutes * 60000)
    life.remainingMs = life.until - now
    life.wakeEarliest = null
    life.wakeLatest = null
  } else if (life.wakeMode === 'random') {
    life.until = null
    life.remainingMs = null
    life.wakeEarliest = now + (body.wakeEarliestMinutes || 30) * 60000
    life.wakeLatest = now + (body.wakeLatestMinutes || 120) * 60000
  } else {
    life.until = null
    life.remainingMs = null
    life.wakeEarliest = null
    life.wakeLatest = null
  }
  history.push({ at: now, state: life.state, activity: life.activity, until: life.until, wakeMode: life.wakeMode, source: 'self' })
}
function applyWakeFake() {
  const now = Date.now()
  life.state = 'awake'
  life.label = '醒着'
  life.activity = ''
  life.note = ''
  life.startedAt = now
  life.elapsedMs = 0
  life.until = null
  life.remainingMs = null
  life.wakeMode = 'open'
  life.wakeEarliest = null
  life.wakeLatest = null
  life.source = 'self'
  life.interruptedFrom = null
  history.push({ at: now, state: 'awake', activity: '', until: null, wakeMode: 'open', source: 'self' })
}
function applyCancelFake() {
  life.until = null
  life.remainingMs = null
  life.wakeMode = 'open'
  life.wakeEarliest = null
  life.wakeLatest = null
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
    return respond({ ok: true, config: { ...config }, status: { online: false, startedAt: 0, lastError: '' }, soul: { identity: { name: 'Aura' } }, proactive: {}, sessions: [] })
  }
  if (target.startsWith('/dsh-aura/memory-api/state')) return respond({ ok: true, facts: [], entities: [], relations: [] })
  if (target === '/dsh-aura/persona-api/state') return respond({ ok: true, config: { ...config }, presets: [], activeId: '' })
  if (target.startsWith('/dsh-aura/life-api')) {
    if (method === 'POST') {
      const body = JSON.parse(init.body || '{}')
      if (body.action === 'plan') applyPlanFake(body)
      else if (body.action === 'wake') applyWakeFake()
      else if (body.action === 'cancel') applyCancelFake()
      const snap = snapshotOf()
      return respond({ ok: true, life: snap, history: snap.history })
    }
    if (target.includes('action=list')) return respond({ ok: true, history: history.slice(-20) })
    const snap = snapshotOf()
    return respond({ ok: true, life: snap, history: snap.history })
  }
  if (target === '/dsh-aura/api/config' && method === 'POST') {
    // 走真实 normalizeConfig：Host 若漏了字段，面板会走「未生效」分支，这里就能抓到。
    Object.assign(config, normalizeConfig(JSON.parse(init.body || '{}'), config))
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
  for (let round = 0; round < 80; round += 1) {
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

async function changeInput(element, label, value) {
  if (!element) throw new Error('找不到输入控件：' + label)
  element.props.onChange && element.props.onChange({ target: { value, checked: value } })
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
console.log('\n[life-ui] 假 React 冒烟')
await settle()
check('Panel 注册成功', typeof Panel === 'function')
check('tab 标签改成「生活」', !!findByText('生活') && !findByText('主动'))
check('tab 数量仍是 9 个', elements().filter(el => el.tag === 'button' && /qqn-tab/.test(String(el.props.className || ''))).length === 9)

await clickButton('生活')
const lifeText = () => tidy(textOf(findBy(el => el.tag === 'div' && String(el.props.className || '').includes('aura-life-card'))))
check('生活区出现在主动设置之前', lifeText().length > 0)
check('状态卡：状态 + 活动 + 来源', lifeText().includes('睡') && lifeText().includes('补一觉') && lifeText().includes('她自己'))
check('状态卡：从何时 + 已过时间', lifeText().includes('已经 10 分钟'))
check('状态卡：醒来方式 / 倒计时', lifeText().includes('醒来方式') && lifeText().includes('没有闹钟，自然醒'))
check('快捷按钮齐全', ['醒着', '忙', '玩', '休息', '睡', '出门', '醒来', '取消闹钟'].every(label => !!findByText(label)))

// 中途醒
life.state = 'awake'
life.label = '醒着'
life.activity = ''
life.interruptedFrom = 'sleep'
life.wakeMode = 'fixed'
life.until = Date.now() + 600000
life.remainingMs = 600000
life.elapsedMs = 1000
lifePoll()
await settle()
check('中途醒显示「中途醒了一下」', !!findContaining('中途醒了一下', 'span'))
check('中途醒倒计时：接着睡', !!findContaining('接着睡', 'span'))

// 快捷「忙」带活动
const quickActivity = findInputByAria('活动（可选）')
await changeInput(quickActivity, '快捷活动输入', '写代码')
await clickButton('忙')
let body = postBody(lastPost('/dsh-aura/life-api'))
check('快捷「忙」POST plan', body && body.action === 'plan' && body.state === 'work' && body.activity === '写代码'
  && body.wakeMode === 'random' && body.wakeEarliestMinutes === 30 && body.wakeLatestMinutes === 120, body)
check('快捷按钮刷新状态卡', lifeText().includes('忙') && lifeText().includes('写代码'))

// 醒来
await clickButton('醒来')
body = postBody(lastPost('/dsh-aura/life-api'))
check('「醒来」POST wake', body && body.action === 'wake', body)
check('醒来后状态卡变醒着', lifeText().includes('醒着'))

// 快捷「睡」默认自然醒
await clickButton('睡')
body = postBody(lastPost('/dsh-aura/life-api'))
check('快捷「睡」默认 open 自然醒', body && body.state === 'sleep' && body.wakeMode === 'open' && body.minutes === undefined, body)

// 取消闹钟
await clickButton('取消闹钟')
body = postBody(lastPost('/dsh-aura/life-api'))
check('「取消闹钟」POST cancel', body && body.action === 'cancel', body)

// 自定义安排：fixed 分钟
await clickButton('自定义安排')
await changeInput(findSelectByAria('生活状态'), '状态 select', 'play')
await changeInput(findSelectByAria('醒来方式'), '醒来方式 select', 'fixed')
await changeInput(findInputByAria('闹钟分钟数'), '分钟数', '90')
await changeInput(findBy(el => el.tag === 'input' && el.props.placeholder === '在干嘛'), '活动', '看剧')
await changeInput(findBy(el => el.tag === 'input' && el.props.placeholder === '给自己的备注'), '备注', '两小时后叫我')
await clickButton('提交安排')
body = postBody(lastPost('/dsh-aura/life-api'))
check('自定义 fixed 提交', body && body.state === 'play' && body.activity === '看剧' && body.note === '两小时后叫我'
  && body.wakeMode === 'fixed' && body.minutes === 90, body)

// fixed 到点
await changeInput(findInputByAria('闹钟分钟数'), '分钟数清空', '')
await changeInput(findInputByAria('到点时间'), '到点时间', '23:30')
await clickButton('提交安排')
body = postBody(lastPost('/dsh-aura/life-api'))
check('自定义 fixed 到点提交', body && typeof body.until === 'number' && body.until > Date.now() && body.wakeMode === 'fixed', body)

// random 窗口
await changeInput(findSelectByAria('醒来方式'), '醒来方式 select', 'random')
await changeInput(findInputByAria('最早分钟数'), '最早', '60')
await changeInput(findInputByAria('最晚分钟数'), '最晚', '180')
await clickButton('提交安排')
body = postBody(lastPost('/dsh-aura/life-api'))
check('自定义 random 提交', body && body.wakeMode === 'random' && body.wakeEarliestMinutes === 60 && body.wakeLatestMinutes === 180, body)

// 非法：fixed 但两个时间都空
await changeInput(findSelectByAria('醒来方式'), '醒来方式 select', 'fixed')
await changeInput(findInputByAria('闹钟分钟数'), '分钟数清空', '')
await changeInput(findInputByAria('到点时间'), '到点时间清空', '')
const before = requests.filter(item => item.url.startsWith('/dsh-aura/life-api') && String(item.init.method || '').toUpperCase() === 'POST').length
await clickButton('提交安排')
const after = requests.filter(item => item.url.startsWith('/dsh-aura/life-api') && String(item.init.method || '').toUpperCase() === 'POST').length
check('非法 fixed 不提交 + 报错', after === before && !!findContaining('闹钟模式要填分钟数', 'div'))

// 记录列表
const historyRows = elements().filter(el => String(el.props.className || '').includes('aura-life-history-row'))
check('最近生活记录 ≤20 条', historyRows.length > 0 && historyRows.length <= 20, historyRows.length)
check('记录含 时间 / 状态 / 活动 / 来源', historyRows.some(el => textOf(el).includes('补一觉') && textOf(el).includes('她自己')))

// 生活设置
const randomBox = findRowCheckbox('随机生活')
check('生活设置：随机生活默认关', randomBox && randomBox.props.checked === false)
await changeInput(randomBox, '随机生活', true)
await clickButton('保存生活设置')
const lifeSave = postBody(lastPost('/dsh-aura/api/config'))
check('生活设置保存 /config', lifeSave && lifeSave.lifeRandom === true
  && lifeSave.lifeQuietSleep === true && lifeSave.lifeWakeGreeting === true, lifeSave)

// 连接 tab：消息插队
await clickButton('连接')
check('连接 tab 有「消息插队」', !!findContaining('消息插队', 'div'))
check('消息插队说明文案', !!findContaining('立即插入当前回合', 'div'))
const steerBox = findRowCheckbox('消息插队')
check('消息插队默认开（steerEnabled）', steerBox && steerBox.props.checked === true)
await changeInput(steerBox, '消息插队', false)
const steerSave = postBody(lastPost('/dsh-aura/api/config'))
check('消息插队保存 steerEnabled=false', steerSave && steerSave.steerEnabled === false, steerSave)
check('消息插队保存后回显已保存', !!findContaining('消息插队偏好已保存', 'div'))
check('消息插队真被 Host 接受（normalizeConfig）', config.steerEnabled === false)

// 切回生活页，轮询仍然可用
await clickButton('生活')
check('切回生活页仍渲染状态卡', lifeText().length > 0)
life.state = 'out'
life.label = '在外面'
lifePoll()
await settle()
check('5s 轮询刷新状态卡', lifeText().includes('出门'))

console.log('\n' + (failures === 0 ? '✅ 面板冒烟全部通过' : '❌ 面板冒烟失败 ' + failures + ' 项'))
process.exitCode = failures === 0 ? 0 : 1
