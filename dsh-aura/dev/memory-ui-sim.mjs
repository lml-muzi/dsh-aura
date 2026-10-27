/**
 * dsh-aura 面板「记忆」tab 的「记忆罗盘」假 React 冒烟（node 直接跑）。
 *   node dsh-aura/dev/memory-ui-sim.mjs
 *
 * 不连 Host、不写任何文件。覆盖：
 *   搜索框 / 范围（全部/7天/30天/90天）/ 搜索 / 清空；
 *   结果列表（时间、角色、会话短名、snippet、点击展开完整片段）；
 *   最近 30 天时间轴（柱状条、hover title、点某天填入范围并搜索）；
 *   总条数/最早最晚、加载/空状态/错误；
 *   原「记忆设置 / 立即整理 / 事实 / 实体 / 关系」仍并存。
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

/* ---------------- 假 Host 数据 ---------------- */
const config = { ...DEFAULT_CONFIG }
const now = Date.now()
const pad = value => String(value).padStart(2, '0')
const dayKey = ms => {
  const date = new Date(ms)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
const timelineRows = Array.from({ length: 30 }, (_, index) => {
  const ms = now - (29 - index) * 86400000
  const counts = index === 28 ? { user: 2, assistant: 1 } : index === 27 ? { user: 1, assistant: 1 } : { user: 0, assistant: 0 }
  return { date: dayKey(ms), count: counts.user + counts.assistant, user: counts.user, assistant: counts.assistant }
})
const archiveStats = {
  files: 2,
  total: 34,
  earliest: now - 30 * 86400000,
  latest: now - 3600000,
  enabled: true,
  days: 365,
}
const searchRows = [
  {
    at: now - 3600000,
    sessionId: 'qq:10001',
    role: 'assistant',
    snippet: '…加班也要吃饭，别硬扛…',
    score: 0.5,
    text: '加班也要吃饭，别硬扛，我先去把汤热一下。',
  },
  {
    at: now - 7200000,
    sessionId: 'qq:10001',
    role: 'user',
    snippet: '项目上线前要加班，可能到十点',
    score: 1,
    text: '项目上线前要加班，可能到十点，你先睡。',
  },
]
let searchFail = false
const requests = []

function respond(data, status = 200) {
  return { ok: status < 400, status, json: async () => data }
}

function timelineFromUrl(url) {
  const days = Number(url.searchParams.get('days')) || 30
  return timelineRows.slice(Math.max(0, timelineRows.length - days))
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  requests.push({ url: target, init })
  if (target === '/dsh-aura/api/state') {
    return respond({
      ok: true,
      config: { ...config },
      status: { online: false, startedAt: 0, lastError: '' },
      soul: {
        identity: { name: 'Aura' },
        relation: { stage: 'close', score: 50, days: 2, turns: 20, milestones: [] },
        emotion: { valence: 0.2, arousal: 0.3, affection: 0.5, energy: 0.7, updatedAt: now },
        memory: {
          events: [{ at: now - 1000, summary: '聊到加班' }],
          notes: { user: [{ text: '对方最近在赶项目' }], us: [], self: [] },
          topics: { 加班: { count: 3 } },
          facts: [],
          entities: [],
          relations: [],
        },
        speak: {},
        growth: [],
        explainLog: [],
      },
      proactive: {},
      sessions: [],
    })
  }
  if (target.startsWith('/dsh-aura/memory-api/state')) return respond({ ok: true, facts: [], entities: [], relations: [] })
  if (target.startsWith('/dsh-aura/persona-api/state')) return respond({ ok: true, config: { ...config }, presets: [], activeId: '' })
  if (target.startsWith('/dsh-aura/life-api')) {
    return respond({ ok: true, life: { state: 'awake', label: '醒着', wakeMode: 'open', history: [] }, history: [] })
  }
  if (target.startsWith('/dsh-aura/speak-api')) return respond({ ok: true })
  if (target.startsWith('/dsh-aura/diary-api')) return respond({ ok: true, entries: [] })
  if (target.startsWith('/dsh-aura/archive-api')) {
    const url = new URL('http://127.0.0.1' + target)
    const action = url.searchParams.get('action') || 'state'
    if (action === 'state') return respond({ ok: true, action: 'state', ...archiveStats })
    if (action === 'timeline') return respond({ ok: true, action: 'timeline', days: 30, timeline: timelineFromUrl(url) })
    if (action === 'search') {
      if (searchFail) return respond({ ok: false, error: '存档坏了' }, 500)
      const q = url.searchParams.get('q') || ''
      if (!q) return respond({ ok: true, action: 'search', query: '', count: 3, results: searchRows.slice(0, 3) })
      if (q.includes('没有')) return respond({ ok: true, action: 'search', query: q, count: 0, results: [] })
      const rows = searchRows.filter(row => (row.snippet + row.text).includes(q))
      return respond({ ok: true, action: 'search', query: q, count: rows.length, results: rows })
    }
  }
  if (target === '/dsh-aura/api/config' && String(init.method || 'GET').toUpperCase() === 'POST') {
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

async function changeInput(element, label, value) {
  if (!element) throw new Error('找不到输入控件：' + label)
  element.props.onChange && element.props.onChange({ target: { value } })
  await settle()
}

function findInputByAria(label) {
  return findBy(el => el.tag === 'input' && el.props['aria-label'] === label)
}

function archiveRequests(action) {
  return requests.filter(item => item.url.startsWith('/dsh-aura/archive-api')
    && (action === undefined || new URL('http://127.0.0.1' + item.url).searchParams.get('action') === action))
}

function lastArchiveRequest(action) {
  const list = archiveRequests(action)
  return list[list.length - 1] || null
}

function textNow() {
  return tidy(textOf(tree))
}

/* ---------------- 测试 ---------------- */
console.log('\n[memory-ui] 假 React 冒烟')
await settle()
check('Panel 注册成功', typeof Panel === 'function')

await clickButton('记忆')
check('切到记忆 tab 后出现「记忆罗盘」块', textNow().includes('记忆罗盘') && textNow().includes('翻原始聊天存档'))

const searchInput = findInputByAria('搜索原始聊天')
check('搜索输入框存在（placeholder 说明空格分词）', !!searchInput && String(searchInput.props.placeholder).includes('空格'))
check('范围有 全部 / 7 天 / 30 天 / 90 天', !!findByText('全部') && !!findByText('7 天') && !!findByText('30 天') && !!findByText('90 天'))
check('有「搜索」和「清空」按钮', !!findByText('搜索') && !!findByText('清空'))

const bars = elements().filter(el => hasClass(el, 'aura-archive-bar'))
check('时间轴渲染最近 30 天柱状条', bars.length === 30, bars.length)
check('时间轴柱状条有 hover title（日期 + 条数）', bars.some(bar => String(bar.props.title).includes('·') && String(bar.props.title).includes('条')))
check('显示总条数 / 最早最晚', textNow().includes('共 34 条') && textNow().includes('最早'))
check('进入记忆 tab 请求 state 与 timeline', archiveRequests('state').length >= 1 && archiveRequests('timeline').length >= 1)

// 搜索
await changeInput(findInputByAria('搜索原始聊天'), '搜索原始聊天', '加班')
await clickButton('搜索')
const searchReq = lastArchiveRequest('search')
check('点搜索发出 archive search 请求', !!searchReq)
check('搜索请求带 q 和 limit', !!searchReq && searchReq.url.includes('q=%E5%8A%A0%E7%8F%AD') && searchReq.url.includes('limit=12'))
check('结果列表显示条数', textNow().includes('找到 2 条'))
check('结果显示时间 / 角色 / 会话短名 / 片段', textNow().includes('她') && textNow().includes('你')
  && textNow().includes('会话 10001') && textNow().includes('加班也要吃饭'))

const resultRows = elements().filter(el => hasClass(el, 'aura-archive-result'))
check('结果行渲染 2 条', resultRows.length === 2, resultRows.length)
check('展开前只显示 snippet，不显示完整片段', !textNow().includes('我先去把汤热一下'))
resultRows[0].props.onClick && resultRows[0].props.onClick({})
await settle()
check('点击结果展开完整片段', textNow().includes('我先去把汤热一下'))
check('展开行有 aura-archive-result-open', elements().some(el => hasClass(el, 'aura-archive-result-open')))

// 范围
await clickButton('30 天')
await clickButton('搜索')
const rangeReq = lastArchiveRequest('search')
check('选 30 天后搜索带 from（epoch ms）', !!rangeReq && new URL('http://127.0.0.1' + rangeReq.url).searchParams.get('from') !== null)

// 时间轴点某天
const dayBar = bars.find(bar => String(bar.props.title).startsWith(timelineRows[28].date))
check('能定位到有数据的那天', !!dayBar)
dayBar.props.onClick && dayBar.props.onClick({})
await settle()
const dayReq = lastArchiveRequest('search')
check('点某天自动按那天搜索（from=to=YYYY-MM-DD）', !!dayReq
  && new URL('http://127.0.0.1' + dayReq.url).searchParams.get('from') === timelineRows[28].date
  && new URL('http://127.0.0.1' + dayReq.url).searchParams.get('to') === timelineRows[28].date)
check('那天按钮显示为选中范围', textNow().includes(timelineRows[28].date.slice(5)))

// 空状态
await changeInput(findInputByAria('搜索原始聊天'), '搜索原始聊天', '没有的词')
await clickButton('搜索')
check('空结果显示「没有翻到相关记录」', textNow().includes('没有翻到相关记录') && textNow().includes('换个词'))
check('空结果时不渲染结果行', elements().filter(el => hasClass(el, 'aura-archive-result')).length === 0)

// 清空
await clickButton('清空')
const clearedInput = findInputByAria('搜索原始聊天')
check('清空后输入框为空', !!clearedInput && clearedInput.props.value === '')
check('清空后结果消失且回到空状态', !textNow().includes('没有翻到相关记录') && !textNow().includes('找到'))
check('清空后范围回到全部', elements().some(el => el.tag === 'button' && tidy(textOf(el)) === '全部' && el.props['aria-pressed'] === true))

// 错误
searchFail = true
await changeInput(findInputByAria('搜索原始聊天'), '搜索原始聊天', '加班')
await clickButton('搜索')
check('搜索失败显示错误', textNow().includes('存档坏了'))
searchFail = false

// 原记忆面板仍在
check('原「记忆设置」仍在', textNow().includes('记忆设置'))
check('原「立即整理 / 整理这段会话」仍在', !!findByText('立即整理') && !!findByText('整理这段会话'))
check('原「事实卡 / 实体卡 / 关系」仍在', textNow().includes('事实卡') && textNow().includes('实体卡') && textNow().includes('关系'))
check('原「清空记忆」仍在', !!findByText('清空记忆'))

// 稀疏注入设置：新字段渲染 / 保存走 /config
const gateInputs = {
  budget: findInputByAria('上下文预算'),
  anchor: findInputByAria('锚点间隔轮数'),
  idle: findInputByAria('久别分钟'),
  oldDays: findInputByAria('旧事天数'),
  recentDays: findInputByAria('最近天数'),
  oldEvery: findInputByAria('旧事间隔轮数'),
  chance: findInputByAria('旧事概率'),
}
check('稀疏注入设置：上下文预算/锚点间隔/久别分钟输入框', !!gateInputs.budget && !!gateInputs.anchor && !!gateInputs.idle)
check('稀疏注入设置：旧事天数/最近天数/间隔轮数/概率输入框', !!gateInputs.oldDays && !!gateInputs.recentDays && !!gateInputs.oldEvery && !!gateInputs.chance)
const oldModeSelect = findBy(el => el.tag === 'select' && el.props['aria-label'] === '旧事门槛模式')
const oldModeValues = oldModeSelect ? (oldModeSelect.children || []).filter(child => child.tag === 'option').map(child => child.props.value) : []
check('旧事门槛模式是下拉（days / exceptRecent）', !!oldModeSelect && oldModeValues.includes('days') && oldModeValues.includes('exceptRecent'), oldModeValues)

await changeInput(gateInputs.budget, '上下文预算', '320')
await changeInput(gateInputs.anchor, '锚点间隔轮数', '6')
await changeInput(gateInputs.idle, '久别分钟', '480')
await changeInput(gateInputs.oldDays, '旧事天数', '45')
await changeInput(gateInputs.recentDays, '最近天数', '5')
await changeInput(gateInputs.oldEvery, '旧事间隔轮数', '12')
await changeInput(gateInputs.chance, '旧事概率', '0.5')
oldModeSelect.props.onChange && oldModeSelect.props.onChange({ target: { value: 'exceptRecent' } })
await settle()
check('改值后保存按钮可用（草稿 dirty）', !!findByText('保存记忆设置'))

const savesBefore = requests.filter(item => item.url === '/dsh-aura/api/config' && String(item.init.method || '').toUpperCase() === 'POST').length
await clickButton('保存记忆设置')
const saveRequests = requests.filter(item => item.url === '/dsh-aura/api/config' && String(item.init.method || '').toUpperCase() === 'POST')
check('点保存向 /config 发 POST', saveRequests.length === savesBefore + 1, saveRequests.length)
const saveBody = saveRequests.length > 0 ? JSON.parse(saveRequests[saveRequests.length - 1].init.body || '{}') : {}
check('保存 payload 带上下文预算/锚点间隔/久别分钟', saveBody.memoryContextBudget === 320 && saveBody.memoryAnchorEveryTurns === 6 && saveBody.memoryInjectIdleMinutes === 480, saveBody)
check('保存 payload 带旧事模式/天数/概率', saveBody.memoryOldMode === 'exceptRecent' && saveBody.memoryOldAfterDays === 45 && saveBody.memoryOldRecentDays === 5 && saveBody.memoryOldEveryTurns === 12 && saveBody.memoryOldChance === 0.5, saveBody)
check('原记忆设置仍在 payload 里', saveBody.memoryEnabled === true && saveBody.memoryRecallLimit !== undefined && saveBody.memorySessionDigest !== undefined, saveBody)
check('保存后显示已保存提示', textNow().includes('记忆设置已保存'))

console.log('\n' + (failures === 0 ? '✅ 记忆罗盘面板冒烟全部通过' : '❌ 记忆罗盘面板冒烟失败 ' + failures + ' 项'))
process.exitCode = failures === 0 ? 0 : 1
