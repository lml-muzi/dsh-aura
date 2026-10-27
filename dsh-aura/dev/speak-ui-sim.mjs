/**
 * dsh-aura 面板「生活」页的主动概率区：假 React 冒烟（node 直接跑）。
 *   node dsh-aura/dev/speak-ui-sim.mjs
 *
 * 覆盖：
 *   主动概率区（命中线/概率/分解/情绪 chip/今天至少一次）
 *   四张图：按生活状态柱状、按时段柱状、按情绪 valence 折线（SVG）、按触发源柱状
 *   pendingShare 卡（内容/强度/剩余时间/清除按钮）
 *   simulate 5s 轮询 + 「刷新」按钮
 *   主动设置里的「允许分享欲」「情绪权重」保存到 /config（走真实 normalizeConfig）
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
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 500)))
  }
}

/* ---------------- 最小 React ---------------- */
let currentInstance = null
let dirty = true
let pendingEffects = []
const panelInstance = { hooks: [], index: 0 }
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

const poll = () => {
  for (const entry of intervals.values()) {
    if (entry.cleared === false) entry.fn()
  }
}

/* ---------------- 假 Host 数据 ---------------- */
const config = { ...DEFAULT_CONFIG }
const now = Date.now()
const lifeHistory = [
  { at: now - 3600000, state: 'play', activity: '听歌', until: null, wakeMode: 'open', source: 'self' },
  { at: now - 1200000, state: 'awake', activity: '', until: null, wakeMode: 'open', source: 'self' },
]
const life = {
  version: 1,
  state: 'awake',
  label: '醒着',
  activity: '',
  note: '',
  startedAt: now - 1200000,
  until: null,
  remainingMs: null,
  wakeMode: 'open',
  wakeEarliest: null,
  wakeLatest: null,
  source: 'self',
  interruptedFrom: null,
  updatedAt: now - 1200000,
  elapsedMs: 1200000,
  history: lifeHistory.slice(-5),
  historyCount: lifeHistory.length,
}

const simState = {
  line: 34,
  gatesSleep: false,
  share: {
    text: '刚听到一首歌，想分你一半',
    reason: '单曲循环',
    strength: 0.8,
    createdAt: now - 1200000,
    expiresAt: now + 2 * 3600 * 1000,
    remainingMs: 2 * 3600 * 1000,
    source: 'life',
    active: true,
  },
}

function simBody() {
  const parts = { base: 45, stage: 1.4, timing: 1, unanswered: 1, life: 0.4, impulse: 15, miss: 10 }
  const emotionParts = {
    affection: 0.8, valence: 0.4, energy: 0.7, socialNeed: 0.6,
    affectionBonus: 9, energyBonus: 4, valenceBonus: 2, impulse: 15, weight: 1, unsuitable: false,
  }
  const byState = {
    awake: { line: 98, probability: 0.98 },
    work: { line: 39.2, probability: 0.392 },
    play: { line: 39.2, probability: 0.392 },
    rest: { line: 100, probability: 1 },
    sleep: { line: 0, probability: 0 },
    out: { line: 58.8, probability: 0.588 },
  }
  const byDaypart = {
    morning: { line: 30.8, probability: 0.308 },
    work: { line: 20.7, probability: 0.2072 },
    noon: { line: 28, probability: 0.28 },
    evening: { line: 39.2, probability: 0.392 },
    night: { line: 30.8, probability: 0.308 },
  }
  const byValence = []
  for (let step = -5; step <= 5; step += 1) {
    const x = step / 5
    byValence.push({ x, probability: Math.max(0, 0.34 - Math.abs(x) * 0.02), line: Math.round((0.34 - Math.abs(x) * 0.02) * 1000) / 10 })
  }
  const byTrigger = {
    impulse: { probability: 0.4, line: 40, available: true },
    due: { probability: 0.28, line: 28, available: true },
    ritual: { probability: 0.22, line: 22, available: true },
    return: { probability: 0.4, line: 40, available: true },
    idle: { probability: 0.392, line: 39.2, available: true },
    share: { probability: 0.34, line: 34, available: Boolean(simState.share) },
  }
  return {
    ok: true,
    now,
    current: {
      line: simState.line,
      probability: simState.line / 100,
      parts,
      emotionParts,
      trigger: simState.share ? 'share' : 'idle',
      note: (simState.share ? 100 : 45) + ' = ' + (simState.share
        ? '分享基线 85 × 生活 0.4 × 情绪 1 × 强度 1.3'
        : '晚间 45 × 关系 1.4') + ' × 生活 0.4',
      formula: '100 = 分享基线 85 × 生活 0.4 × 情绪 1 × 强度 1.3',
    },
    gates: {
      enabled: true, quiet: false, sleep: simState.gatesSleep, dailyCapReached: false,
      paused: false, suppressed: false, todayCount: 0, cap: 3,
    },
    byState,
    byDaypart,
    byValence,
    byTrigger,
    daily: {
      intervalMinutes: 30,
      ticksPerDay: 48,
      pAtLeastOne: 0.7125,
      cap: 3,
      shareDaily: { cap: 2, count: 1, dayKey: '2026-10-27' },
    },
    share: {
      enabled: config.speakShareEnabled !== false,
      line: 100,
      baseLine: 85,
      strength: 0.8,
      factors: { life: 0.4, emotion: 1, strength: 1.3 },
      cooldownMinutes: 45,
      cooldownActive: false,
      dailyCap: 2,
      dailyCount: 1,
      pendingShare: simState.share,
    },
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
      soul: { identity: { name: 'Aura' }, emotion: {}, speak: {} },
      proactive: {},
      sessions: [],
    })
  }
  if (target.startsWith('/dsh-aura/memory-api/state')) return respond({ ok: true, facts: [], entities: [], relations: [] })
  if (target === '/dsh-aura/persona-api/state') return respond({ ok: true, config: { ...config }, presets: [], activeId: '' })
  if (target.startsWith('/dsh-aura/life-api')) {
    const snap = { ...life, history: lifeHistory.slice(-5), historyCount: lifeHistory.length }
    if (String(init.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(init.body || '{}')
      if (body.action === 'plan') {
        life.state = body.state
        life.label = { awake: '醒着', work: '在忙', play: '在玩', rest: '在休息', sleep: '在睡', out: '在外面' }[body.state] || body.state
        life.activity = body.activity || ''
        life.startedAt = Date.now()
        lifeHistory.push({ at: Date.now(), state: life.state, activity: life.activity, until: null, wakeMode: 'open', source: 'self' })
      } else if (body.action === 'wake') {
        life.state = 'awake'
        life.label = '醒着'
        life.activity = ''
      }
      return respond({ ok: true, life: { ...snap, ...life, history: lifeHistory.slice(-5) }, history: lifeHistory.slice(-5) })
    }
    if (target.includes('action=list')) return respond({ ok: true, history: lifeHistory.slice(-20) })
    return respond({ ok: true, life: snap, history: snap.history })
  }
  if (target === '/dsh-aura/speak-api' && method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    if (body.action === 'simulate') return respond(simBody())
    if (body.action === 'clearShare') {
      simState.share = null
      return respond({ ...simBody(), cleared: true })
    }
    return respond({ ok: false, error: '未知 action' }, 400)
  }
  if (target === '/dsh-aura/api/config' && method === 'POST') {
    // 走真实 normalizeConfig：Host 漏字段/客户端漏传都会在这里暴露。
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
console.log('\n[speak-ui] 假 React 冒烟')
await settle()
check('Panel 注册成功', typeof Panel === 'function')
check('tab 数量仍是 9 个', elements().filter(el => el.tag === 'button' && /qqn-tab/.test(String(el.props.className || ''))).length === 9)

await clickButton('生活')
check('生活页保留状态卡', !!findBy(el => el.tag === 'div' && String(el.props.className || '').includes('aura-life-card') && textOf(el).includes('醒着')))
check('主动概率区存在', !!findContaining('主动概率', 'h2') || !!findContaining('主动概率', 'span'))

const probCard = () => findBy(el => el.tag === 'div' && /aura-prob-card/.test(String(el.props.className || '')))
check('概率卡渲染', !!probCard())
const probText = () => tidy(textOf(probCard()))
check('当前命中线 + 概率', probText().includes('当前命中线 34') && probText().includes('34%'), probText().slice(0, 200))
check('分解：基线/关系/时机/未回复/生活/情绪/没中', ['时段基线 45', '关系 ×1.4', '时机 ×1', '未回复 ×1', '生活 ×0.4', '情绪 +15', '没中 +10'].every(part => probText().includes(part)), probText().slice(0, 300))
check('情绪分解 chips', ['亲近 0.8', '愉悦度 0.4', '精力 0.7', '社交需求 0.6'].every(part => probText().includes(part)), probText().slice(0, 300))
check('触发源 badge', probText().includes('触发 分享'))
check('今天至少一次 %', probText().includes('今天至少一次 71%'), probText().slice(0, 400))
check('日上限说明', probText().includes('上限 3 次') && probText().includes('全天约 48 次'))

const barGroups = elements().filter(el => String(el.props.className || '') === 'aura-prob-bars')
const barRows = elements().filter(el => /aura-prob-bar-row/.test(String(el.props.className || '')))
check('三组柱状图（状态/时段/触发源）', barGroups.length === 3, barGroups.length)
check('柱状行数 = 6 + 5 + 6', barRows.length === 17, barRows.length)
check('生活状态柱状图 6 根', barRows.slice(0, 6).every(row => /%/.test(textOf(row))))
const svg = findBy(el => el.tag === 'svg' && /aura-prob-svg/.test(String(el.props.className || '')))
check('情绪折线 SVG', !!svg && !!findBy(el => el.tag === 'polyline' && /aura-prob-line/.test(String(el.props.className || ''))))
check('折线 11 个点', elements().filter(el => /aura-prob-dot/.test(String(el.props.className || ''))).length === 11)
check('折线点坐标有效', svg && svg.props.viewBox === '0 0 260 96', svg && svg.props.viewBox)

check('pendingShare 卡：内容', probText().includes('刚听到一首歌，想分你一半'))
check('pendingShare 卡：强度', probText().includes('强度 80%'))
check('pendingShare 卡：剩余时间', probText().includes('剩余'))
check('pendingShare 卡：理由/来源', probText().includes('理由：单曲循环') && probText().includes('来源 life'))
check('pendingShare 卡：清除按钮', !!findByText('清除分享'))
check('分享卡：命中线构成（生活/情绪/强度倍率）', probText().includes('命中线 100 = 85 × 生活 0.4 × 情绪 1 × 强度 1.3'), probText().slice(-400))
check('分享卡：分享日上限与冷却', probText().includes('今日分享 1/2') && probText().includes('分享冷却 45 分钟'), probText().slice(-400))

const beforeSimulate = requests.filter(item => item.url === '/dsh-aura/speak-api' && postBody(item)?.action === 'simulate').length
await clickButton('刷新')
const afterSimulate = requests.filter(item => item.url === '/dsh-aura/speak-api' && postBody(item)?.action === 'simulate').length
check('「刷新」重新拉 simulate', afterSimulate > beforeSimulate, { beforeSimulate, afterSimulate })

simState.line = 52
poll()
await settle()
check('5s 轮询刷新概率卡', probText().includes('当前命中线 52'), probText().slice(0, 120))

simState.gatesSleep = true
poll()
await settle()
check('门控 badge：睡着', probText().includes('睡着'))
simState.gatesSleep = false
poll()
await settle()

await clickButton('清除分享')
check('清除分享 POST clearShare', postBody(lastPost('/dsh-aura/speak-api'))?.action === 'clearShare')
check('清除后显示空态', probText().includes('现在没有想分享的事'), probText().slice(-200))

simState.share = {
  text: '过期的那条',
  reason: '',
  strength: 0.6,
  createdAt: now - 3 * 3600 * 1000,
  expiresAt: now - 1000,
  remainingMs: 0,
  source: 'life',
  active: false,
}
poll()
await settle()
check('过期分享显示「已过期」', probText().includes('已过期') && probText().includes('过期的那条'), probText().slice(-200))
simState.share = null
poll()
await settle()

// 主动设置：分享欲开关 + 情绪权重
const shareBox = findRowCheckbox('允许分享欲')
check('主动设置：允许分享欲默认开', shareBox && shareBox.props.checked === true)
await changeInput(shareBox, '允许分享欲', false)
const sensitivityInput = findInputByAria('情绪权重')
check('主动设置：情绪权重输入', !!sensitivityInput && Number(sensitivityInput.props.value) === 1)
await changeInput(sensitivityInput, '情绪权重', 1.5)
await clickButton('保存主动搭话')
const speakSave = postBody(lastPost('/dsh-aura/api/config'))
check('保存 speakShareEnabled=false', speakSave && speakSave.speakShareEnabled === false, speakSave)
check('保存 speakEmotionSensitivity=1.5', speakSave && speakSave.speakEmotionSensitivity === 1.5, speakSave)
check('Host 接受分享欲开关（normalizeConfig）', config.speakShareEnabled === false)
check('Host 接受情绪权重（normalizeConfig）', config.speakEmotionSensitivity === 1.5)
check('保存反馈', !!findContaining('主动搭话设置已保存', 'div'))
check('原有主动设置仍完整', !!findRowCheckbox('开启主动搭话') && !!findRowCheckbox('主动时允许发表情包'))

// 生活页主动设置：分享/普通主动窗口、分享冷却、分享日上限、社交需求权重
const shareWindowInput = findInputByAria('分享互动窗口')
const proactiveWindowInput = findInputByAria('普通主动互动窗口')
const shareCooldownInput = findInputByAria('分享冷却')
const shareCapInput = findInputByAria('分享日上限')
const socialWeightInput = findInputByAria('社交需求权重')
check('生活设置：五个新输入都在', Boolean(shareWindowInput && proactiveWindowInput && shareCooldownInput && shareCapInput && socialWeightInput))
check('生活设置：默认值', Number(shareWindowInput?.props.value) === 0
  && Number(proactiveWindowInput?.props.value) === 0
  && Number(shareCooldownInput?.props.value) === 45
  && Number(shareCapInput?.props.value) === 2
  && Number(socialWeightInput?.props.value) === 0.2,
{ shareWindow: shareWindowInput?.props.value, cooldown: shareCooldownInput?.props.value, cap: shareCapInput?.props.value, weight: socialWeightInput?.props.value })
await changeInput(shareWindowInput, '分享互动窗口', 6)
await changeInput(proactiveWindowInput, '普通主动互动窗口', 12)
await changeInput(shareCooldownInput, '分享冷却', 30)
await changeInput(shareCapInput, '分享日上限', 3)
await changeInput(socialWeightInput, '社交需求权重', 0.5)
await clickButton('保存生活设置')
const lifeSettingsSave = postBody(lastPost('/dsh-aura/api/config'))
check('生活设置保存五个字段', lifeSettingsSave
  && lifeSettingsSave.speakShareRecentHours === 6
  && lifeSettingsSave.speakProactiveRecentHours === 12
  && lifeSettingsSave.speakShareCooldownMinutes === 30
  && lifeSettingsSave.speakShareDailyCap === 3
  && lifeSettingsSave.speakSocialNeedWeight === 0.5, lifeSettingsSave)
check('Host 接受分享/主动窗口', config.speakShareRecentHours === 6 && config.speakProactiveRecentHours === 12)
check('Host 接受分享冷却/日上限/社交权重', config.speakShareCooldownMinutes === 30
  && config.speakShareDailyCap === 3 && config.speakSocialNeedWeight === 0.5, config)

// 关闭分享欲后 simulate 的 share 区也应显示关闭
poll()
await settle()
check('关闭后分享区仍在（enabled=false 也可读）', !!probCard())

console.log('\n' + (failures === 0 ? '✅ 主动概率面板冒烟全部通过' : '❌ 主动概率面板冒烟失败 ' + failures + ' 项'))
process.exitCode = failures === 0 ? 0 : 1
