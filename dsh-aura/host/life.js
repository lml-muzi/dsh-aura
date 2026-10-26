/**
 * 生活层（Host 侧）：她自己的作息状态机。
 *
 * 文件：$DSH_HOME/dsh-aura/life.json（tmp + rename 原子写；坏文件改名 .corrupt 后回默认）。
 * 状态：awake / work / play / rest / sleep / out。
 * 唤醒：fixed（闹钟）/ random（最早~最晚之间概率自然醒）/ open（不定闹钟，只对 sleep/play 有兜底）。
 *
 * 边界：
 * - 这里只关心「她此刻在干嘛」，不写 prompt；presence 段由 soul.js 通过 describeLife() 渲染。
 * - 不做任务/日程；闹钟只是生活状态，不承担提醒职责（提醒走 schedule / diary）。
 * - 不 import soul.js（避免循环）：soul.js 只 import 本文件的纯函数 describeLife。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const FILE = 'life.json'
export const LIFE_VERSION = 1
export const LIFE_API_PREFIX = '/dsh-aura/life-api'
export const TICK_MS = 60 * 1000
export const HISTORY_LIMIT = 200

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const MAX_PLAN_MINUTES = 7 * 24 * 60

/** 状态机允许的状态（顺序也用于文案/列表展示）。 */
export const LIFE_STATES = Object.freeze(['awake', 'work', 'play', 'rest', 'sleep', 'out'])
const STATE_SET = new Set(LIFE_STATES)
export const WAKE_MODES = Object.freeze(['fixed', 'random', 'open'])
const WAKE_MODE_SET = new Set(WAKE_MODES)
export const SOURCES = Object.freeze(['self', 'random', 'auto', 'user'])
const SOURCE_SET = new Set(SOURCES)

export const STATE_LABEL = Object.freeze({
  awake: '醒着',
  work: '在忙',
  play: '在玩',
  rest: '在休息',
  sleep: '在睡',
  out: '在外面',
})

/** random 唤醒窗口的默认分钟区间（按状态）。 */
export const RANDOM_WAKE_MINUTES = Object.freeze({
  sleep: [300, 540], // 5~9h
  play: [60, 180], // 1~3h
  work: [30, 120],
  rest: [20, 60],
  out: [60, 180],
  awake: [20, 60],
})

const MID_WAKE_CHECK_MS = 10 * MINUTE_MS
const MID_WAKE_CHANCE = 0.03
const MID_WAKE_MIN_MS = 5 * MINUTE_MS
const MID_WAKE_MAX_MS = 15 * MINUTE_MS
const OPEN_SLEEP_LIMIT_MS = 6 * HOUR_MS
const OPEN_SLEEP_CHANCE = 0.03
const OPEN_PLAY_LIMIT_MS = 4 * HOUR_MS
const OPEN_PLAY_CHANCE = 0.05
const RANDOM_LIFE_AFTER_MS = 2 * HOUR_MS
const RANDOM_LIFE_CHANCE = 0.02

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function codepointLength(text) {
  return Array.from(String(text ?? '')).length
}

function sliceCodepoints(text, max) {
  return Array.from(String(text ?? '')).slice(0, max).join('')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function randomRangeOf(state) {
  return RANDOM_WAKE_MINUTES[state] || RANDOM_WAKE_MINUTES.awake
}

function randomUnit(random) {
  try {
    const value = Number(typeof random === 'function' ? random() : Math.random())
    return Number.isFinite(value) ? clamp(value, 0, 1) : 0.5
  } catch {
    return 0.5
  }
}

function randomBetween(random, min, max) {
  return min + randomUnit(random) * Math.max(0, max - min)
}

/** 本地 HH:MM（只用于文案）。 */
function clockOf(epoch) {
  const date = new Date(epoch)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** until 接受毫秒时间戳或可被 Date.parse 解析的时间字符串。 */
function parseUntil(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = str(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

/** $DSH_HOME/dsh-aura/life.json 所在目录；优先复用 state.stateDir()。 */
export function lifeHome({ state, dir } = {}) {
  if (dir) return dir
  try {
    if (state && typeof state.stateDir === 'function') return state.stateDir()
  } catch { /* ignore */ }
  const env = process.env.DSH_HOME
  const home = env && env.trim() ? env.trim() : join(homedir(), '.dsh-native')
  return join(home, 'dsh-aura')
}

function writeLifeFile(file, life) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(life, null, 2))
  renameSync(tmp, file)
}

/** 读文件；坏 JSON 改名 .corrupt，返回 null 让调用方回默认。 */
function loadLifeFile(file, logger) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') logger('[life] 读取 life.json 失败:', errorText(error))
    return { life: null, corrupt: false, exists: false }
  }
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('life.json 不是对象')
    return { life: normalizeLife(raw, Date.now()), corrupt: false, exists: true }
  } catch (error) {
    const target = `${file}.corrupt`
    try {
      renameSync(file, target)
      logger(`[life] life.json 解析失败（${errorText(error)}），已改名为 ${target}，回到默认状态`)
    } catch (renameError) {
      logger('[life] life.json 解析失败，且改名 .corrupt 也失败:', errorText(renameError))
    }
    return { life: null, corrupt: true, exists: true }
  }
}

/* ------------------------------------------------------------------ */
/* 归一化 / 默认值                                                     */
/* ------------------------------------------------------------------ */

export function defaultsLife(now = Date.now()) {
  return {
    version: LIFE_VERSION,
    state: 'awake',
    activity: '',
    note: '',
    startedAt: now,
    until: null,
    wakeMode: 'open',
    wakeEarliest: null,
    wakeLatest: null,
    source: 'self',
    interruptedFrom: null,
    updatedAt: now,
    history: [],
    // 内部字段：中途醒之后「接着睡」要恢复的原计划；以及每 10 分钟一次的抽查时间点。
    resume: null,
    midWakeCheckedAt: null,
  }
}

function normalizeResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const wakeMode = WAKE_MODE_SET.has(str(raw.wakeMode)) ? str(raw.wakeMode) : 'open'
  return {
    until: numOrNull(raw.until),
    wakeMode,
    wakeEarliest: numOrNull(raw.wakeEarliest),
    wakeLatest: numOrNull(raw.wakeLatest),
  }
}

function normalizeHistory(rows, now) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const state = str(row.state)
    if (!STATE_SET.has(state)) continue
    out.push({
      at: num(row.at, now),
      state,
      activity: sliceCodepoints(str(row.activity).trim(), 40),
      until: numOrNull(row.until),
      wakeMode: WAKE_MODE_SET.has(str(row.wakeMode)) ? str(row.wakeMode) : 'open',
      source: SOURCE_SET.has(str(row.source)) ? str(row.source) : 'self',
    })
  }
  return out.slice(-HISTORY_LIMIT)
}

/** 把任意（旧版/半截）life 对象洗成完整 schema；无法判断的字段回落默认。 */
export function normalizeLife(raw = {}, now = Date.now()) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const state = STATE_SET.has(str(source.state)) ? str(source.state) : 'awake'
  const rawUntil = numOrNull(source.until)
  const until = rawUntil !== null && rawUntil > 0 ? rawUntil : null
  let wakeMode = WAKE_MODE_SET.has(str(source.wakeMode)) ? str(source.wakeMode) : 'open'
  let wakeEarliest = numOrNull(source.wakeEarliest)
  let wakeLatest = numOrNull(source.wakeLatest)

  if (wakeMode === 'fixed' && until === null) wakeMode = 'open'
  if (wakeMode !== 'random') {
    wakeEarliest = null
    wakeLatest = null
  }
  if (wakeMode === 'random' && (wakeEarliest === null || wakeLatest === null || wakeEarliest >= wakeLatest)) {
    const [minMinutes, maxMinutes] = randomRangeOf(state)
    wakeEarliest = now + minMinutes * MINUTE_MS
    wakeLatest = now + maxMinutes * MINUTE_MS
  }

  const interruptedFrom = state === 'awake' && str(source.interruptedFrom) === 'sleep' && until !== null
    ? 'sleep'
    : null
  const rawStartedAt = num(source.startedAt, now)
  const rawUpdatedAt = num(source.updatedAt, now)
  const startedAt = rawStartedAt > 0 ? Math.min(rawStartedAt, now) : now
  const updatedAt = rawUpdatedAt > 0 ? Math.min(rawUpdatedAt, now) : now

  return {
    version: LIFE_VERSION,
    state,
    activity: sliceCodepoints(str(source.activity).trim(), 40),
    note: sliceCodepoints(str(source.note).trim(), 120),
    startedAt,
    until,
    wakeMode,
    wakeEarliest,
    wakeLatest,
    source: SOURCE_SET.has(str(source.source)) ? str(source.source) : 'self',
    interruptedFrom,
    updatedAt,
    history: normalizeHistory(source.history, now),
    resume: normalizeResume(source.resume),
    midWakeCheckedAt: numOrNull(source.midWakeCheckedAt),
  }
}

function pushHistory(life, now) {
  const rows = Array.isArray(life.history) ? life.history : []
  life.history = [...rows, {
    at: now,
    state: life.state,
    activity: life.activity,
    until: life.until,
    wakeMode: life.wakeMode,
    source: life.source,
  }].slice(-HISTORY_LIMIT)
}

/* ------------------------------------------------------------------ */
/* plan：参数校验 + 落状态                                             */
/* ------------------------------------------------------------------ */

function parseMinutesArg(value, label) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const n = num(value, NaN)
  if (!Number.isFinite(n) || n < 1 || n > MAX_PLAN_MINUTES) {
    return { ok: false, reason: `${label} 需要 1~${MAX_PLAN_MINUTES} 之间的分钟数` }
  }
  return { ok: true, value: n }
}

/**
 * 校验 plan 参数并算出落盘字段（不修改 life）。
 * wakeMode 省略时：给了 minutes/until → fixed；awake → open；其他状态 → random（自然醒）。
 */
export function validatePlanArgs(args = {}, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: '参数需要对象' }
  const state = str(args.state).trim()
  if (!STATE_SET.has(state)) return { ok: false, reason: `state 必须是 ${LIFE_STATES.join(' / ')} 之一` }

  const minutesArg = parseMinutesArg(args.minutes, 'minutes')
  if (!minutesArg.ok) return minutesArg
  const minutes = minutesArg.value

  let until = null
  if (args.until !== undefined && args.until !== null && args.until !== '') {
    until = parseUntil(args.until)
    if (until === null) return { ok: false, reason: 'until 需要毫秒时间戳或可解析的时间字符串' }
    if (until <= now) return { ok: false, reason: 'until 需要晚于现在' }
  }
  if (until !== null && minutes !== null) return { ok: false, reason: 'minutes 和 until 只能给一个' }

  let wakeMode = str(args.wakeMode).trim()
  if (wakeMode && !WAKE_MODE_SET.has(wakeMode)) {
    return { ok: false, reason: `wakeMode 必须是 ${WAKE_MODES.join(' / ')} 之一` }
  }
  if (!wakeMode) {
    if (until !== null || minutes !== null) wakeMode = 'fixed'
    else wakeMode = state === 'awake' ? 'open' : 'random'
  }

  // random/open 不接受 minutes/until：避免「给了分钟但没定时」的静默误解
  if (wakeMode !== 'fixed' && (minutes !== null || until !== null)) {
    return { ok: false, reason: `${wakeMode} 模式不能给 minutes/until（要定时就用 fixed）` }
  }

  const activity = sliceCodepoints(str(args.activity).replace(/\s+/g, ' ').trim(), 40)
  if (codepointLength(str(args.activity).replace(/\s+/g, ' ').trim()) > 40) {
    return { ok: false, reason: 'activity 最多 40 字' }
  }
  const note = sliceCodepoints(str(args.note).replace(/\s+/g, ' ').trim(), 120)
  if (codepointLength(str(args.note).replace(/\s+/g, ' ').trim()) > 120) {
    return { ok: false, reason: 'note 最多 120 字' }
  }
  const source = SOURCE_SET.has(str(args.source)) ? str(args.source) : 'self'

  let wakeEarliest = null
  let wakeLatest = null

  if (wakeMode === 'fixed') {
    if (until === null) {
      if (minutes === null) return { ok: false, reason: 'fixed 需要 until 或 minutes' }
      until = now + Math.round(minutes) * MINUTE_MS
    }
  } else if (wakeMode === 'open') {
    until = null
  } else {
    // random：不给窗口就按状态默认；只给一头时另一头向外扩 5 分钟。
    until = null
    const earliestArg = parseMinutesArg(args.wakeEarliestMinutes, 'wakeEarliestMinutes')
    if (!earliestArg.ok) return earliestArg
    const latestArg = parseMinutesArg(args.wakeLatestMinutes, 'wakeLatestMinutes')
    if (!latestArg.ok) return latestArg
    const [defaultEarliest, defaultLatest] = randomRangeOf(state)
    let earliestMinutes = earliestArg.value
    let latestMinutes = latestArg.value
    if (earliestMinutes !== null && latestMinutes === null) {
      latestMinutes = Math.max(earliestMinutes + 5, defaultLatest)
    } else if (latestMinutes !== null && earliestMinutes === null) {
      earliestMinutes = Math.max(1, Math.min(defaultEarliest, latestMinutes - 5))
    }
    if (earliestMinutes === null) earliestMinutes = defaultEarliest
    if (latestMinutes === null) latestMinutes = defaultLatest
    if (earliestMinutes >= latestMinutes) {
      return { ok: false, reason: 'wakeEarliestMinutes 需要小于 wakeLatestMinutes' }
    }
    wakeEarliest = now + Math.round(earliestMinutes) * MINUTE_MS
    wakeLatest = now + Math.round(latestMinutes) * MINUTE_MS
  }

  return {
    ok: true,
    state,
    activity,
    note,
    until,
    wakeMode,
    wakeEarliest,
    wakeLatest,
    source,
  }
}

function applyPlan(life, plan, now) {
  life.state = plan.state
  life.activity = plan.activity
  life.note = plan.note
  life.startedAt = now
  life.until = plan.until
  life.wakeMode = plan.wakeMode
  life.wakeEarliest = plan.wakeEarliest
  life.wakeLatest = plan.wakeLatest
  life.source = plan.source
  life.interruptedFrom = null
  life.resume = null
  life.midWakeCheckedAt = plan.state === 'sleep' ? now : null
  life.updatedAt = now
  pushHistory(life, now)
}

/** 安排/切换生活状态（直接改 life 对象）。返回 {ok, state, until, ...}。 */
export function planLife(life, args = {}, now = Date.now()) {
  if (!life || typeof life !== 'object') return { ok: false, reason: '没有 life 状态容器' }
  const checked = validatePlanArgs(args, now)
  if (!checked.ok) return checked
  applyPlan(life, checked, now)
  return {
    ok: true,
    action: 'plan',
    state: life.state,
    until: life.until,
    wakeMode: life.wakeMode,
    wakeEarliest: life.wakeEarliest,
    wakeLatest: life.wakeLatest,
    source: life.source,
  }
}

/* ------------------------------------------------------------------ */
/* wake / cancel / 中途醒 / 回睡                                       */
/* ------------------------------------------------------------------ */

/** 回 awake，清闹钟；interruptedFrom='sleep' 且 resume 未禁用时改为「接着睡」。 */
export function wakeLife(life, options = {}) {
  if (!life || typeof life !== 'object') return { ok: false, reason: '没有 life 状态容器' }
  const now = num(options.now, Date.now())
  if (life.state === 'awake' && life.interruptedFrom !== 'sleep') {
    return { ok: true, woke: false, resumed: false, state: 'awake', from: 'awake', at: now }
  }
  if (life.state === 'awake' && life.interruptedFrom === 'sleep' && options.resume !== false) {
    return resumeSleepLife(life, now, options.random)
  }
  const from = life.state
  life.state = 'awake'
  life.activity = ''
  life.note = ''
  life.startedAt = now
  life.until = null
  life.wakeMode = 'open'
  life.wakeEarliest = null
  life.wakeLatest = null
  life.source = SOURCE_SET.has(str(options.source)) ? str(options.source) : 'self'
  life.interruptedFrom = null
  life.resume = null
  life.midWakeCheckedAt = null
  life.updatedAt = now
  pushHistory(life, now)
  return { ok: true, woke: true, resumed: false, from, state: 'awake', source: life.source, at: now }
}

/** 取消闹钟/自然醒窗口，保持当前状态（不再自动醒）。 */
export function cancelLife(life, now = Date.now()) {
  if (!life || typeof life !== 'object') return { ok: false, reason: '没有 life 状态容器' }
  const clearedUntil = life.until
  const clearedMode = life.wakeMode
  life.until = null
  life.wakeMode = 'open'
  life.wakeEarliest = null
  life.wakeLatest = null
  life.interruptedFrom = null
  life.resume = null
  if (life.state !== 'sleep') life.midWakeCheckedAt = null
  life.updatedAt = now
  return { ok: true, action: 'cancel', state: life.state, clearedUntil, clearedMode, at: now }
}

/** 睡到一半短暂醒：state=awake、until=5~15 分钟后、interruptedFrom='sleep'。 */
function interruptSleepLife(life, now, random) {
  life.resume = {
    until: life.until,
    wakeMode: life.wakeMode,
    wakeEarliest: life.wakeEarliest,
    wakeLatest: life.wakeLatest,
  }
  const span = randomBetween(random, MID_WAKE_MIN_MS, MID_WAKE_MAX_MS)
  life.state = 'awake'
  life.activity = ''
  life.note = ''
  life.startedAt = now
  life.until = Math.round(now + span)
  life.wakeMode = 'fixed'
  life.wakeEarliest = null
  life.wakeLatest = null
  life.source = 'auto'
  life.interruptedFrom = 'sleep'
  life.midWakeCheckedAt = null
  life.updatedAt = now
  pushHistory(life, now)
  return { ok: true, at: now, until: life.until }
}

function regenerateRandomWindow(state, now) {
  const [minMinutes, maxMinutes] = randomRangeOf(state)
  return {
    earliest: now + minMinutes * MINUTE_MS,
    latest: now + maxMinutes * MINUTE_MS,
  }
}

/** 中途醒结束后接着睡：按原 wakeMode 恢复（fixed 到点过就转 random，random 窗口过就重开）。 */
export function resumeSleepLife(life, now = Date.now(), random = Math.random) {
  if (!life || typeof life !== 'object') return { ok: false, reason: '没有 life 状态容器' }
  const stash = life.resume && typeof life.resume === 'object' ? life.resume : null
  let wakeMode = stash && WAKE_MODE_SET.has(str(stash.wakeMode)) ? str(stash.wakeMode) : 'random'
  let until = null
  let wakeEarliest = null
  let wakeLatest = null

  if (wakeMode === 'fixed') {
    const originalUntil = numOrNull(stash?.until)
    if (originalUntil !== null && originalUntil > now) until = originalUntil
    else wakeMode = 'random'
  }
  if (wakeMode === 'random') {
    const originalEarliest = numOrNull(stash?.wakeEarliest)
    const originalLatest = numOrNull(stash?.wakeLatest)
    if (originalEarliest !== null && originalLatest !== null && originalLatest > now) {
      wakeEarliest = Math.max(now + MINUTE_MS, originalEarliest)
      wakeLatest = originalLatest
    } else {
      const window = regenerateRandomWindow('sleep', now)
      wakeEarliest = window.earliest
      wakeLatest = window.latest
    }
  }

  life.state = 'sleep'
  life.activity = ''
  life.note = ''
  life.startedAt = now
  life.until = until
  life.wakeMode = wakeMode
  life.wakeEarliest = wakeEarliest
  life.wakeLatest = wakeLatest
  life.source = 'auto'
  life.interruptedFrom = null
  life.resume = null
  life.midWakeCheckedAt = now
  life.updatedAt = now
  pushHistory(life, now)
  return { ok: true, woke: false, resumed: true, state: 'sleep', wakeMode, until, at: now }
}

/* ------------------------------------------------------------------ */
/* tick：60s 一次的自动醒判定                                          */
/* ------------------------------------------------------------------ */

/** random 模式下此刻醒来的概率：越接近最晚越高，夹在 0.05~0.5；到最晚为 1。 */
export function randomWakeChance(life, now = Date.now()) {
  const earliest = numOrNull(life?.wakeEarliest)
  const latest = numOrNull(life?.wakeLatest)
  if (earliest === null || latest === null || latest <= earliest) return 0
  if (now >= latest) return 1
  if (now < earliest) return 0
  return clamp((now - earliest) / (latest - earliest), 0.05, 0.5)
}

/** 醒着太久时随机进入一种生活状态（lifeRandom 打开才走；默认关）。 */
function autoRandomLife(life, now, random) {
  const awakeFor = Math.max(0, now - num(life.startedAt, now))
  if (awakeFor < RANDOM_LIFE_AFTER_MS) return false
  if (randomUnit(random) >= RANDOM_LIFE_CHANCE) return false
  const pool = ['work', 'play', 'rest', 'out', 'sleep']
  const state = pool[Math.min(pool.length - 1, Math.floor(randomUnit(random) * pool.length))]
  const result = planLife(life, { state, wakeMode: 'random', source: 'random' }, now)
  return result.ok === true
}

/**
 * 单次 tick，直接改 life。返回 { changed, events }。
 * events: {type:'wake'|'mid-wake'|'resume-sleep'|'plan', ...} 交给 initLife emit。
 */
export function tickLife(life, now = Date.now(), random = Math.random, options = {}) {
  const events = []
  if (!life || typeof life !== 'object' || !STATE_SET.has(str(life.state))) {
    return { changed: false, events }
  }
  let changed = false

  const wakeAuto = () => {
    const from = life.state
    const mode = life.wakeMode
    wakeLife(life, { now, source: 'auto' })
    changed = true
    events.push({ type: 'wake', at: now, from, mode })
  }

  // ① 中途醒的短暂状态到点 → 接着睡
  if (life.state === 'awake' && life.interruptedFrom === 'sleep') {
    const until = numOrNull(life.until)
    if (until !== null && now >= until) {
      const result = resumeSleepLife(life, now, random)
      if (result.ok) {
        changed = true
        events.push({ type: 'resume-sleep', at: now, until: result.until })
      }
    }
    return { changed, events }
  }

  // ② 醒着：不开闹钟就什么都不做（随机生活是可选开关）
  if (life.state === 'awake') {
    if (options.randomLife === true && autoRandomLife(life, now, random)) {
      changed = true
      events.push({ type: 'plan', at: now, state: life.state, source: 'random' })
    }
    return { changed, events }
  }

  // ③ fixed：到点必醒；睡着时仍然每 10 分钟可能中途醒一下
  if (life.wakeMode === 'fixed') {
    const until = numOrNull(life.until)
    if (until !== null && now >= until) {
      wakeAuto()
      return { changed, events }
    }
    if (life.state === 'sleep') {
      const mid = runMidWakeCheck(life, now, random)
      if (mid !== 'none') {
        changed = true
        if (mid === 'woke') events.push({ type: 'mid-wake', at: now, until: life.until })
      }
    }
    return { changed, events }
  }

  // ④ random：最早~最晚之间概率醒，超过最晚必醒；睡着时同样抽查中途醒
  if (life.wakeMode === 'random') {
    const chance = randomWakeChance(life, now)
    if (chance >= 1) {
      wakeAuto()
      return { changed, events }
    }
    if (chance > 0 && randomUnit(random) < chance) {
      wakeAuto()
      return { changed, events }
    }
    if (life.state === 'sleep') {
      const mid = runMidWakeCheck(life, now, random)
      if (mid !== 'none') {
        changed = true
        if (mid === 'woke') events.push({ type: 'mid-wake', at: now, until: life.until })
      }
    }
    return { changed, events }
  }

  // ⑤ open：只给 sleep / play 一个兜底，其他状态不自动醒
  if (life.state === 'sleep') {
    const asleepFor = Math.max(0, now - num(life.startedAt, now))
    if (asleepFor >= OPEN_SLEEP_LIMIT_MS) {
      if (randomUnit(random) < OPEN_SLEEP_CHANCE) wakeAuto()
      return { changed, events }
    }
    const mid = runMidWakeCheck(life, now, random)
    if (mid !== 'none') {
      changed = true
      if (mid === 'woke') events.push({ type: 'mid-wake', at: now, until: life.until })
    }
    return { changed, events }
  }
  if (life.state === 'play' && now - num(life.startedAt, now) >= OPEN_PLAY_LIMIT_MS) {
    if (randomUnit(random) < OPEN_PLAY_CHANCE) wakeAuto()
  }
  return { changed, events }
}

/** 每 10 分钟一次的「睡到一半醒一下」抽查：返回 none / checked / woke。 */
function runMidWakeCheck(life, now, random) {
  const checkedAt = numOrNull(life.midWakeCheckedAt)
  const base = checkedAt === null ? num(life.startedAt, now) : checkedAt
  if (now - base < MID_WAKE_CHECK_MS) return 'none'
  life.midWakeCheckedAt = now
  life.updatedAt = now
  if (randomUnit(random) >= MID_WAKE_CHANCE) return 'checked'
  interruptSleepLife(life, now, random)
  return 'woke'
}

/* ------------------------------------------------------------------ */
/* 只读视图 / 文案                                                     */
/* ------------------------------------------------------------------ */

/** 给面板/服务用的快照（history 取最近 5 条）。 */
export function lifeSnapshot(life, now = Date.now()) {
  if (!life || typeof life !== 'object') {
    const fallback = defaultsLife(now)
    return {
      ...fallback,
      label: STATE_LABEL[fallback.state],
      remainingMs: null,
      elapsedMs: 0,
      historyCount: 0,
    }
  }
  const until = numOrNull(life.until)
  return {
    version: LIFE_VERSION,
    state: life.state,
    label: STATE_LABEL[life.state] || life.state,
    activity: life.activity,
    note: life.note,
    startedAt: life.startedAt,
    until,
    remainingMs: until === null ? null : Math.max(0, until - now),
    wakeMode: life.wakeMode,
    wakeEarliest: life.wakeEarliest,
    wakeLatest: life.wakeLatest,
    source: life.source,
    interruptedFrom: life.interruptedFrom,
    updatedAt: life.updatedAt,
    elapsedMs: Math.max(0, now - num(life.startedAt, now)),
    history: (Array.isArray(life.history) ? life.history : []).slice(-5).map(row => ({ ...row })),
    historyCount: Array.isArray(life.history) ? life.history.length : 0,
  }
}

/**
 * presence / prompt 用的一句话：「正在玩，预计自然醒」。
 * 没有 life 或 state 非法时返回 ''，调用方回退到按钟点猜。
 */
export function describeLife(life, now = Date.now()) {
  if (!life || typeof life !== 'object') return ''
  const state = str(life.state)
  if (!STATE_SET.has(state)) return ''
  const phrase = {
    awake: '醒着',
    work: '正在忙',
    play: '正在玩',
    rest: '正在休息',
    sleep: '正在睡',
    out: '在外面',
  }[state]
  let text = phrase
  const activity = sliceCodepoints(str(life.activity).trim(), 40)

  if (state === 'awake' && str(life.interruptedFrom) === 'sleep') {
    text = '醒着（中途醒了一下）'
    const until = numOrNull(life.until)
    if (until !== null && until > now) {
      text += `，${Math.max(1, Math.round((until - now) / MINUTE_MS))} 分钟后接着睡`
    }
    return text
  }

  if (activity) text += `（${activity}）`

  if (state !== 'awake') {
    const wakeMode = WAKE_MODE_SET.has(str(life.wakeMode)) ? str(life.wakeMode) : 'open'
    const until = numOrNull(life.until)
    if (wakeMode === 'fixed' && until !== null && until > now) text += `，闹钟 ${clockOf(until)}`
    else if (wakeMode === 'random') text += '，预计自然醒'
    else if (wakeMode === 'open') text += '，自然醒'
  }
  return text
}

/* ------------------------------------------------------------------ */
/* HTTP（面板可选）/ 工具                                              */
/* ------------------------------------------------------------------ */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostIsLoopback(req) {
  const host = req?.headers?.host
  if (!host) return true
  const text = String(host)
  let name = text
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    name = end >= 0 ? text.slice(0, end + 1) : text
  } else {
    const colon = text.lastIndexOf(':')
    if (colon > 0) name = text.slice(0, colon)
  }
  return LOOPBACK.has(name.toLowerCase())
}

function fence(req) {
  if (!hostIsLoopback(req)) return false
  const site = req.headers?.['sec-fetch-site']
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin) {
    try {
      const url = new URL(String(origin))
      if (!LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }
  return true
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  })
  res.end(data)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

/**
 * 装载生活层：读 life.json、注册 soul_life 工具 / HTTP 路由 / 60s 定时器。
 * @returns {{file, get, snapshot, plan, wake, cancel, list, tick, on, describe, runAction, webRegistration, saveNow, dispose}}
 */
export function initLife(options = {}) {
  const { ctx, state, soul } = options
  const logger = typeof options.log === 'function' ? options.log : (...parts) => console.log('[dsh-aura]', ...parts)
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const randomFn = typeof options.random === 'function' ? options.random : Math.random
  const tickMs = Math.max(1000, num(options.tickMs, TICK_MS))
  const timerApi = options.timers && typeof options.timers.setInterval === 'function'
    ? options.timers
    : { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id) }
  const dir = lifeHome({ state, dir: options.dir })
  const file = join(dir, FILE)

  let closed = false
  let timerId = null
  const listeners = new Map()
  const disposers = []

  const readConfig = () => {
    try {
      return (typeof state?.readConfig === 'function' ? state.readConfig() : {}) || {}
    } catch {
      return {}
    }
  }

  const loaded = loadLifeFile(file, logger)
  const life = loaded.life || defaultsLife(nowFn())

  function saveNow() {
    try {
      writeLifeFile(file, life)
      return true
    } catch (error) {
      logger('[life] 写入 life.json 失败:', errorText(error))
      return false
    }
  }

  // 首次启动（或坏文件已改名 .corrupt）也落一份默认，方便面板/备份看到 life.json。
  if (!loaded.exists || loaded.corrupt) saveNow()

  function emit(event, payload) {
    const set = listeners.get(String(event))
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (error) {
        logger('[life] 事件回调失败:', errorText(error))
      }
    }
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {}
    const key = String(event)
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(fn)
    return () => { listeners.get(key)?.delete(fn) }
  }

  function get() {
    return life
  }

  function status(now = nowFn()) {
    return { ok: true, action: 'status', ...lifeSnapshot(life, now) }
  }

  // ---- 分享欲钩子：生活里发生了什么值得说的事，就往 speak 塞一条 pendingShare ----
  // 只在 speakShareEnabled !== false 且 speak 提供了 queueShare 时生效；失败不影响生活状态。
  function shareSpeak() {
    try {
      if (readConfig().speakShareEnabled === false) return null
    } catch {
      return null
    }
    const speak = typeof options.getSpeak === 'function' ? options.getSpeak() : null
    return speak && typeof speak.queueShare === 'function' ? speak : null
  }

  function queueLifeShare(text, reason) {
    const speak = shareSpeak()
    if (!speak) return
    try {
      speak.queueShare({ text, reason, strength: 0.6, ttlMinutes: 120, source: 'life' })
    } catch (error) {
      logger('[life] 分享欲入队失败:', errorText(error))
    }
  }

  function shareForPlan(result) {
    if (!result || result.ok !== true) return
    const state = str(result.state)
    const activity = sliceCodepoints(str(life.activity).trim(), 40)
    const worth = Boolean(activity) || state === 'play' || state === 'out' || state === 'rest'
    if (!worth) return
    const phrase = { awake: '醒着', work: '在忙', play: '在玩', rest: '在休息', sleep: '在睡', out: '在外面' }[state] || state
    queueLifeShare(activity ? `我现在${phrase}，${activity}。` : `我现在${phrase}，想跟你说一声。`, `life:plan:${state}`)
  }

  function shareForWake(result) {
    if (!result || result.ok !== true || result.woke !== true || result.resumed === true) return
    queueLifeShare('我刚醒了。', 'life:wake')
  }

  function plan(args = {}) {
    if (closed) return { ok: false, reason: 'life 已卸载' }
    const now = nowFn()
    const result = planLife(life, args, now)
    if (result.ok) {
      saveNow()
      emit('plan', { type: 'plan', at: now, state: life.state, source: life.source })
      shareForPlan(result)
    }
    return result
  }

  function wake(opts = {}) {
    const now = nowFn()
    // 工具/HTTP 的 wake 是「真的醒来」：即使是从中途醒的短暂状态叫的，也直接回 awake。
    // 中途醒到点自动回睡走 tickLife 里的 resumeSleepLife，不经过这里。
    const result = wakeLife(life, { resume: false, ...opts, now })
    if (result.ok && (result.woke || result.resumed)) {
      saveNow()
      emit(result.resumed ? 'resume-sleep' : 'wake', { type: result.resumed ? 'resume-sleep' : 'wake', ...result, at: now })
      shareForWake(result)
    }
    return result
  }

  function cancel() {
    const now = nowFn()
    const result = cancelLife(life, now)
    if (result.ok) {
      saveNow()
      emit('cancel', { type: 'cancel', at: now, state: life.state })
    }
    return result
  }

  function list(limit = 20) {
    const size = clamp(Math.round(num(limit, 20)), 1, HISTORY_LIMIT)
    return (Array.isArray(life.history) ? life.history : []).slice(-size).map(row => ({ ...row }))
  }

  function runTick() {
    if (closed) return { changed: false, events: [] }
    const now = nowFn()
    const config = readConfig()
    let result
    try {
      result = tickLife(life, now, randomFn, { randomLife: config.lifeRandom === true })
    } catch (error) {
      logger('[life] tick 失败:', errorText(error))
      return { changed: false, events: [] }
    }
    if (result.changed) saveNow()
    for (const event of result.events) {
      emit(event.type, { ...event, snapshot: lifeSnapshot(life, now) })
    }
    return result
  }

  async function runAction(args = {}) {
    const action = str(args?.action).trim() || 'status'
    const now = nowFn()
    if (action === 'status') return status(now)
    if (action === 'plan') {
      const result = plan(args)
      if (!result.ok) return { ok: false, reason: result.reason, action }
      return {
        ok: true,
        action,
        message: `安排好了：${describeLife(life, now) || STATE_LABEL[life.state]}`,
        ...lifeSnapshot(life, now),
      }
    }
    if (action === 'wake') {
      const result = wake({ source: 'self' })
      if (!result.ok) return { ok: false, reason: result.reason, action }
      return {
        ok: true,
        action,
        woke: result.woke === true,
        resumed: result.resumed === true,
        from: result.from,
        ...lifeSnapshot(life, now),
      }
    }
    if (action === 'cancel') {
      const result = cancel()
      if (!result.ok) return { ok: false, reason: result.reason, action }
      return { ok: true, action, message: '闹钟取消了，保持现在的状态', ...lifeSnapshot(life, now) }
    }
    if (action === 'list') {
      return { ok: true, action, count: Array.isArray(life.history) ? life.history.length : 0, history: list(20) }
    }
    return { ok: false, reason: 'action 必须是 status / plan / wake / cancel / list' }
  }

  const toolParameters = {
    action: {
      type: 'string',
      enum: ['status', 'plan', 'wake', 'cancel', 'list'],
      description: '必填：status 看现在；plan 安排状态；wake 醒来；cancel 取消闹钟保持现状；list 看最近 20 条生活记录',
      required: true,
    },
    state: {
      type: 'string',
      enum: [...LIFE_STATES],
      description: 'plan 必填：awake=醒着，work=忙，play=玩，rest=休息，sleep=睡，out=出门',
    },
    activity: { type: 'string', description: 'plan 可选：具体在干嘛（≤40 字，会写进 presence）' },
    minutes: { type: 'number', description: 'plan 可选：多久后（分钟）；给了就是闹钟。和 until 只给一个' },
    until: { type: 'number', description: 'plan 可选：到点的毫秒时间戳；和 minutes 只给一个' },
    wakeMode: {
      type: 'string',
      enum: ['fixed', 'random', 'open'],
      description: 'plan 可选：fixed=闹钟（需要 minutes/until）；random=自然醒窗口；open=不定闹钟。'
        + '省略时：给了 minutes/until → fixed，awake → open，其他状态 → random',
    },
    wakeEarliestMinutes: { type: 'number', description: 'random 可选：最早几分钟后可能醒；不给按状态默认' },
    wakeLatestMinutes: { type: 'number', description: 'random 可选：最晚几分钟后一定醒；不给按状态默认' },
    note: { type: 'string', description: 'plan 可选：给自己的备注（≤120 字）' },
  }

  const toolRender = (_args, value) => [{
    type: 'text',
    text: value?.ok === true
      ? (value.message || `现在是：${value.label || value.state || ''}`)
      : `没安排成：${String(value?.reason || '')}`,
  }]

  const toolDescription = '这是她自己的生活，不是任务：安排/切换此刻在做什么（醒着、忙、玩、休息、睡、出门），'
    + '以及怎么醒（闹钟、自然醒、不定闹钟）。'
    + '只在她真想安排或换状态时用，不要每轮调用；睡觉、玩可以自然醒不设闹钟。'

  function buildTool() {
    const base = {
      name: 'soul_life',
      description: toolDescription,
      parameters: toolParameters,
      render: toolRender,
      async execute(args = {}) {
        return runAction(args)
      },
    }
    // 当前 dsh-tools 走 output.schema/output.render；旧形状只认顶层 render。两种都给，谁认识用谁。
    try {
      return defineTool({ ...base, output: { schema: { type: 'object', additionalProperties: true }, render: toolRender } })
    } catch (firstError) {
      try {
        return defineTool(base)
      } catch (secondError) {
        logger('[life] soul_life 工具定义失败:', errorText(firstError), '/', errorText(secondError))
        return null
      }
    }
  }
  const tool = buildTool()

  function pushDisposer(handle) {
    if (!handle) return
    if (typeof handle === 'function') disposers.push(handle)
    else if (typeof handle.dispose === 'function') disposers.push(() => handle.dispose())
  }

  // 工具
  try {
    if (ctx) {
      const tools = (() => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('tools') : undefined
        } catch {
          return undefined
        }
      })() || ctx.tools
      if (tool && tools && typeof tools.register === 'function') {
        pushDisposer(tools.register(tool))
      } else if (tool && typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (toolsCtx) => {
          const service = toolsCtx?.tools
          if (!service || typeof service.register !== 'function') return
          pushDisposer(service.register(tool))
        })
      }
    }
  } catch (error) {
    logger('[life] soul_life 工具注册失败:', errorText(error))
  }

  // HTTP 路由（面板「生活」页）：GET ?action=… / POST {action:…}，prefix 前缀注册。
  // 响应统一带 {ok, life, history}；旧的路径式 /status /list /plan 仍然兼容。
  function webRegistration() {
    const snapshotOf = () => lifeSnapshot(life, nowFn())
    const KNOWN_ACTIONS = new Set(['status', 'list', 'plan', 'wake', 'cancel'])
    const LEGACY_GET = { '/': 'status', '/status': 'status', '/list': 'list' }
    const LEGACY_POST = { '/plan': 'plan', '/wake': 'wake', '/cancel': 'cancel' }

    /** 成功响应：life 是完整快照，history 是最近 5 条；顶层铺开字段兼容旧面板。 */
    const replyLife = (res, snapshot) => {
      json(res, 200, { ok: true, life: snapshot, history: snapshot.history, ...snapshot })
    }

    return {
      kind: 'prefix',
      path: LIFE_API_PREFIX,
      async handler(req, res) {
        if (!fence(req)) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const method = String(req.method || 'GET').toUpperCase()
        const url = new URL(String(req.url || '/'), 'http://localhost')
        const route = url.pathname.replace(/^\/dsh-aura\/life-api/, '') || '/'
        try {
          if (method === 'GET') {
            const action = url.searchParams.get('action') || LEGACY_GET[route] || ''
            if (!action) {
              json(res, 400, { ok: false, error: '未知 action（status / list / plan / wake / cancel）' })
              return
            }
            if (!KNOWN_ACTIONS.has(action)) {
              json(res, 400, { ok: false, error: `未知 action：${action}` })
              return
            }
            if (action === 'status') {
              replyLife(res, snapshotOf())
              return
            }
            if (action === 'list') {
              const limitText = url.searchParams.get('limit')
              let limit = 20
              if (limitText !== null && limitText.trim() !== '') {
                const parsed = Number(limitText)
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_LIMIT) {
                  json(res, 400, { ok: false, error: `limit 需要 1~${HISTORY_LIMIT} 的整数` })
                  return
                }
                limit = parsed
              }
              json(res, 200, { ok: true, history: list(limit) })
              return
            }
            json(res, 405, { ok: false, error: 'method not allowed', allow: 'POST' })
            return
          }
          if (method === 'POST') {
            const body = await readBody(req)
            const action = str(body.action).trim() || LEGACY_POST[route] || ''
            if (!action) {
              json(res, 400, { ok: false, error: '未知 action（plan / wake / cancel）' })
              return
            }
            if (!KNOWN_ACTIONS.has(action)) {
              json(res, 400, { ok: false, error: `未知 action：${action}` })
              return
            }
            if (action === 'status' || action === 'list') {
              json(res, 405, { ok: false, error: 'method not allowed', allow: 'GET' })
              return
            }
            if (action === 'plan') {
              const result = plan(body)
              if (!result.ok) {
                json(res, 400, { ok: false, error: result.reason || '参数不合法' })
                return
              }
              replyLife(res, snapshotOf())
              return
            }
            const result = action === 'wake' ? wake({ source: 'user' }) : cancel()
            if (!result.ok) {
              json(res, 400, { ok: false, error: result.reason || '操作失败' })
              return
            }
            replyLife(res, snapshotOf())
            return
          }
          json(res, 405, { ok: false, error: 'method not allowed', allow: 'GET, POST' })
        } catch (error) {
          const message = errorText(error)
          json(res, message === 'invalid json' || message === 'body too large' ? 400 : 500, { ok: false, error: message })
        }
      },
    }
  }

  try {
    const webServer = (() => {
      try {
        return typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
      } catch {
        return undefined
      }
    })() || ctx?.webServer
    if (webServer && typeof webServer.register === 'function') {
      pushDisposer(webServer.register(webRegistration()))
    }
  } catch (error) {
    logger('[life] HTTP 路由注册失败:', errorText(error))
  }

  // 定时器：固定 60s 一次（tick 内部自己判断）
  if (options.autoSchedule !== false) {
    timerId = timerApi.setInterval(() => {
      try {
        runTick()
      } catch (error) {
        logger('[life] tick 回调失败:', errorText(error))
      }
    }, tickMs)
    if (timerId && typeof timerId.unref === 'function') timerId.unref()
  }

  function dispose() {
    if (closed) return
    closed = true
    if (timerId !== null) {
      try {
        timerApi.clearInterval(timerId)
      } catch (error) {
        logger('[life] 清理定时器失败:', errorText(error))
      }
      timerId = null
    }
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch { /* ignore */ }
    }
    listeners.clear()
    saveNow()
  }

  function describe(now = nowFn()) {
    return describeLife(life, now)
  }

  logger(`[life] 生活层已装载：${STATE_LABEL[life.state] || life.state}${life.activity ? `（${life.activity}）` : ''} · ${file}`)

  return {
    version: LIFE_VERSION,
    file,
    dir,
    tool,
    get,
    snapshot: () => ({ ...lifeSnapshot(life, nowFn()), file }),
    status: () => status(),
    plan,
    wake,
    cancel,
    list,
    tick: () => runTick(),
    on,
    describe,
    runAction,
    webRegistration,
    saveNow,
    dispose,
    // soul 侧只需要只读引用；留个显式句柄避免被误用成可变容器
    soul: soul || null,
  }
}
