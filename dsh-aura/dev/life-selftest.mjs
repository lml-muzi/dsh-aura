/**
 * dsh-aura 生活层自测（node 直接跑，不连 DSH / 不联网 / 不发消息）
 *
 *   node dsh-aura/dev/life-selftest.mjs
 *
 * 覆盖：
 * - life.json schema / 默认值 / normalize / 坏文件 .corrupt 回退 / 原子写落盘；
 * - plan 参数校验（state、fixed 需要 until、random 窗口默认值、open 无 until、字数限制）；
 * - fixed 到点醒、random 概率自然醒（到最早/最晚边界）、open 6h/4h 兜底；
 * - sleep 中途醒（每 10 分钟 3%）→ 短暂 awake → until 到点接着睡（fixed/random/open 三种恢复）；
 * - history ring 200；事件 wake/resume-sleep；
 * - soul_life 工具行为（status/plan/wake/cancel/list + 非法参数）+ HTTP 路由；
 * - presence 文案优先读 life（soul.renderPresenceContext / installSoul 注册 order 50）；
 * - speak 联动：睡眠硬门控、work/play ×0.4、rest ×1.2、out ×0.6、prompt 注入、notifyWake；
 * - dispose 清理假定时器 + 落盘。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-life-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh-native')
mkdirSync(join(process.env.DSH_HOME, 'dsh-aura'), { recursive: true })

const state = await import('../host/state.js')
const lifeMod = await import('../host/life.js')
const soulMod = await import('../host/soul.js')
const speakMod = await import('../host/speak.js')

const {
  defaultsLife,
  normalizeLife,
  validatePlanArgs,
  planLife,
  wakeLife,
  cancelLife,
  resumeSleepLife,
  tickLife,
  randomWakeChance,
  describeLife,
  lifeSnapshot,
  lifeHome,
  initLife,
  LIFE_STATES,
  HISTORY_LIMIT,
  STATE_LABEL,
} = lifeMod

const { installSoul, defaultsSoul, renderPresenceContext } = soulMod
const { installSpeak, lifeFactorOf, buildIntentBody } = speakMod

// 本地时区固定：2026-10-26 是周一；用本地构造避免 CI 时区差异。
const T0 = new Date(2026, 9, 26, 4, 45, 0).getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.error(`  FAIL ${name}`)
    console.error(`       ${(error && error.stack) || error}`)
  }
}

function section(title) {
  console.log(`\n[${title}]`)
}

const clone = value => JSON.parse(JSON.stringify(value))
const readLife = file => JSON.parse(readFileSync(file, 'utf8'))

/* ------------------------------------------------------------------ */
section('1. life.json schema / 默认值 / normalize')
/* ------------------------------------------------------------------ */

await test('默认：awake + open + until null + 空 history', () => {
  const life = defaultsLife(T0)
  assert.equal(life.version, 1)
  assert.equal(life.state, 'awake')
  assert.equal(life.wakeMode, 'open')
  assert.equal(life.until, null)
  assert.equal(life.source, 'self')
  assert.equal(life.interruptedFrom, null)
  assert.deepEqual(life.history, [])
  assert.equal(life.startedAt, T0)
  assert.equal(life.updatedAt, T0)
})

await test('normalizeLife 洗坏值：非法 state/wakeMode/负时间戳都回落', () => {
  const life = normalizeLife({
    version: 99,
    state: 'sleeping',
    wakeMode: 'alarm',
    until: -5,
    startedAt: -1,
    wakeEarliest: 'x',
    history: [null, { state: 'nope' }, { state: 'play', at: 10, wakeMode: 'random', source: 'auto' }],
  }, T0)
  assert.equal(life.state, 'awake')
  assert.equal(life.wakeMode, 'open')
  assert.equal(life.until, null)
  assert.equal(life.startedAt, T0)
  assert.equal(life.wakeEarliest, null)
  assert.equal(life.history.length, 1)
  assert.deepEqual(Object.keys(life.history[0]).sort(), ['activity', 'at', 'source', 'state', 'until', 'wakeMode'])
})

await test('normalizeLife：fixed 但没 until → open；random 缺窗口 → 按状态默认补', () => {
  const fixed = normalizeLife({ state: 'work', wakeMode: 'fixed', until: null }, T0)
  assert.equal(fixed.wakeMode, 'open')
  const random = normalizeLife({ state: 'sleep', wakeMode: 'random' }, T0)
  assert.equal(random.wakeMode, 'random')
  assert.equal(random.wakeLatest - random.wakeEarliest, (540 - 300) * MIN)
})

await test('normalizeLife：中途醒的短暂 awake 没有 until 时清掉 interruptedFrom，避免卡死', () => {
  const life = normalizeLife({ state: 'awake', interruptedFrom: 'sleep', until: null }, T0)
  assert.equal(life.interruptedFrom, null)
  const alive = normalizeLife({ state: 'awake', interruptedFrom: 'sleep', until: T0 + 5 * MIN }, T0)
  assert.equal(alive.interruptedFrom, 'sleep')
})

/* ------------------------------------------------------------------ */
section('2. plan 参数校验')
/* ------------------------------------------------------------------ */

await test('state 必须合法', () => {
  assert.equal(validatePlanArgs({ state: 'nope' }, T0).ok, false)
  assert.equal(validatePlanArgs({}, T0).ok, false)
  assert.equal(validatePlanArgs(null, T0).ok, false)
  for (const item of LIFE_STATES) assert.equal(validatePlanArgs({ state: item }, T0).ok, true, item)
})

await test('fixed 需要 until 或 minutes；until 不能是过去；不能用不存在的 wakeMode', () => {
  assert.match(validatePlanArgs({ state: 'work', wakeMode: 'fixed' }, T0).reason, /until 或 minutes/)
  assert.match(validatePlanArgs({ state: 'work', until: T0 - 1000, wakeMode: 'fixed' }, T0).reason, /晚于现在/)
  assert.match(validatePlanArgs({ state: 'work', wakeMode: 'alarm' }, T0).reason, /wakeMode/)
  assert.match(validatePlanArgs({ state: 'work', minutes: 0 }, T0).reason, /minutes/)
  assert.match(validatePlanArgs({ state: 'work', minutes: 999999 }, T0).reason, /minutes/)
  assert.match(validatePlanArgs({ state: 'work', minutes: 30, until: T0 + 3600000, wakeMode: 'fixed' }, T0).reason, /只能给一个/)
})

await test('random 窗口：默认按状态；两头都给要 earliest < latest；只给一头自动补齐', () => {
  const sleep = validatePlanArgs({ state: 'sleep', wakeMode: 'random' }, T0)
  assert.equal(sleep.ok, true)
  assert.equal(sleep.until, null)
  assert.equal(sleep.wakeLatest - sleep.wakeEarliest, (540 - 300) * MIN)

  assert.match(validatePlanArgs({ state: 'rest', wakeMode: 'random', wakeEarliestMinutes: 50, wakeLatestMinutes: 30 }, T0).reason, /小于/)

  assert.match(validatePlanArgs({ state: 'sleep', wakeMode: 'random', minutes: 30 }, T0).reason, /不能给 minutes/)
  assert.match(validatePlanArgs({ state: 'sleep', wakeMode: 'open', until: T0 + 100000 }, T0).reason, /不能给 minutes/)

  const onlyEarliest = validatePlanArgs({ state: 'rest', wakeMode: 'random', wakeEarliestMinutes: 45 }, T0)
  assert.equal(onlyEarliest.wakeEarliest, T0 + 45 * MIN)
  assert.equal(onlyEarliest.wakeLatest, T0 + 60 * MIN) // max(45+5, 默认 60) = 60
  const onlyLatest = validatePlanArgs({ state: 'rest', wakeMode: 'random', wakeLatestMinutes: 30 }, T0)
  assert.equal(onlyLatest.wakeEarliest, T0 + 20 * MIN) // min(默认 20, 30-5)
  assert.equal(onlyLatest.wakeLatest, T0 + 30 * MIN)
})

await test('wakeMode 默认：给 minutes → fixed；awake → open；其他 → random', () => {
  assert.equal(validatePlanArgs({ state: 'play', minutes: 90 }, T0).wakeMode, 'fixed')
  assert.equal(validatePlanArgs({ state: 'awake' }, T0).wakeMode, 'open')
  assert.equal(validatePlanArgs({ state: 'play' }, T0).wakeMode, 'random')
})

await test('activity/note 字数限制；source 非法回落 self', () => {
  assert.match(validatePlanArgs({ state: 'work', activity: '字'.repeat(41) }, T0).reason, /activity/)
  assert.match(validatePlanArgs({ state: 'work', note: '字'.repeat(121) }, T0).reason, /note/)
  assert.equal(validatePlanArgs({ state: 'work', source: 'hacker' }, T0).source, 'self')
  assert.equal(validatePlanArgs({ state: 'work', source: 'user' }, T0).source, 'user')
})

await test('planLife 写状态 + 记 history；until 按 minutes 精确到毫秒', () => {
  const life = defaultsLife(T0)
  const result = planLife(life, { state: 'work', activity: '改代码', minutes: 30, source: 'self' }, T0)
  assert.equal(result.ok, true)
  assert.equal(life.state, 'work')
  assert.equal(life.activity, '改代码')
  assert.equal(life.wakeMode, 'fixed')
  assert.equal(life.until, T0 + 30 * MIN)
  assert.equal(life.history.length, 1)
  assert.equal(life.history[0].state, 'work')
  assert.equal(life.history[0].source, 'self')
})

/* ------------------------------------------------------------------ */
section('3. fixed / random / open 的醒法')
/* ------------------------------------------------------------------ */

await test('fixed：到点前不动，到点醒；history 记 source=auto', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'work', minutes: 30 }, T0)
  const before = tickLife(life, life.until - 1, () => 0)
  assert.equal(before.changed, false)
  assert.equal(life.state, 'work')

  const at = tickLife(life, life.until, () => 0)
  assert.equal(at.events.length, 1)
  assert.equal(at.events[0].type, 'wake')
  assert.equal(at.events[0].from, 'work')
  assert.equal(life.state, 'awake')
  assert.equal(life.until, null)
  assert.equal(life.wakeMode, 'open')
  assert.equal(life.history.at(-1).state, 'awake')
  assert.equal(life.history.at(-1).source, 'auto')
})

await test('random：概率随接近最晚升高（0.05~0.5），超过最晚必醒', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'play', wakeMode: 'random', wakeEarliestMinutes: 60, wakeLatestMinutes: 180 }, T0)
  const start = life.wakeEarliest
  const end = life.wakeLatest
  assert.equal(randomWakeChance(life, start - 1), 0)
  assert.equal(randomWakeChance(life, start), 0.05)
  assert.ok(Math.abs(randomWakeChance(life, start + (end - start) * 0.1) - 0.1) < 1e-9)
  assert.equal(randomWakeChance(life, start + (end - start) * 0.9), 0.5)
  assert.equal(randomWakeChance(life, end), 1)

  // 最早点：掷 0.9 不醒（概率 0.05）；掷 0.01 醒
  assert.equal(tickLife(life, start, () => 0.9).changed, false)
  assert.equal(life.state, 'play')
  assert.equal(tickLife(life, start, () => 0.01).events[0].type, 'wake')
  assert.equal(life.state, 'awake')

  // 超过最晚：掷什么都必醒
  const other = defaultsLife(T0)
  planLife(other, { state: 'out', wakeMode: 'random', wakeEarliestMinutes: 30, wakeLatestMinutes: 60 }, T0)
  const hit = tickLife(other, other.wakeLatest + 1, () => 0.999)
  assert.equal(hit.events[0].type, 'wake')
  assert.equal(other.state, 'awake')
})

await test('open：sleep 6h 后每 tick 3% 醒；play 4h 后 5%；其他状态不自动醒', () => {
  const sleepy = defaultsLife(T0)
  planLife(sleepy, { state: 'sleep', wakeMode: 'open' }, T0)
  assert.equal(tickLife(sleepy, T0 + 6 * HOUR, () => 0.9).changed, false)
  assert.equal(sleepy.state, 'sleep')
  const woke = tickLife(sleepy, T0 + 6 * HOUR, () => 0.01)
  assert.equal(woke.events[0].type, 'wake')
  assert.equal(sleepy.state, 'awake')

  const player = defaultsLife(T0)
  planLife(player, { state: 'play', wakeMode: 'open' }, T0)
  assert.equal(tickLife(player, T0 + 4 * HOUR - 1, () => 0).changed, false)
  assert.equal(tickLife(player, T0 + 4 * HOUR, () => 0.04).events[0].type, 'wake')

  const outside = defaultsLife(T0)
  planLife(outside, { state: 'out', wakeMode: 'open' }, T0)
  assert.equal(tickLife(outside, T0 + 30 * HOUR, () => 0).changed, false)
  assert.equal(outside.state, 'out')
})

await test('lifeRandom：默认关；打开后醒着太久会随机进入一种生活状态', () => {
  const off = defaultsLife(T0)
  off.startedAt = T0 - 3 * HOUR
  assert.equal(tickLife(off, T0, () => 0).changed, false)
  assert.equal(off.state, 'awake')

  const on = defaultsLife(T0)
  on.startedAt = T0 - 3 * HOUR
  const result = tickLife(on, T0, () => 0, { randomLife: true })
  assert.equal(result.changed, true)
  assert.equal(result.events[0].type, 'plan')
  assert.notEqual(on.state, 'awake')
  assert.equal(on.source, 'random')
})

/* ------------------------------------------------------------------ */
section('4. sleep 中途醒 / 回睡')
/* ------------------------------------------------------------------ */

await test('每 10 分钟抽查一次 3%；命中进入 5~15 分钟的短暂 awake', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'sleep', wakeMode: 'open' }, T0)
  assert.equal(life.midWakeCheckedAt, T0)

  // 9 分钟：还没到抽查点
  assert.equal(tickLife(life, T0 + 9 * MIN, () => 0).changed, false)
  assert.equal(life.state, 'sleep')

  // 10 分钟：抽查但没中（0.5 >= 0.03）
  const checked = tickLife(life, T0 + 10 * MIN, () => 0.5)
  assert.equal(checked.changed, true)
  assert.equal(life.state, 'sleep')
  assert.equal(life.midWakeCheckedAt, T0 + 10 * MIN)

  // 15 分钟：距上次抽查不到 10 分钟，掷 0 也不该醒
  assert.equal(tickLife(life, T0 + 15 * MIN, () => 0).changed, false)
  assert.equal(life.state, 'sleep')

  // 20 分钟：抽查命中
  const mid = tickLife(life, T0 + 20 * MIN, () => 0)
  assert.equal(mid.events[0].type, 'mid-wake')
  assert.equal(life.state, 'awake')
  assert.equal(life.interruptedFrom, 'sleep')
  assert.equal(life.wakeMode, 'fixed')
  assert.equal(life.until, T0 + 25 * MIN) // random()=0 → 5 分钟
  assert.equal(life.history.at(-1).state, 'awake')
})

await test('短暂 awake 到点回 sleep：open 恢复自然醒、不留 until', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'sleep', wakeMode: 'open' }, T0)
  tickLife(life, T0 + 10 * MIN, () => 0)
  assert.equal(life.state, 'awake')
  const until = life.until
  assert.equal(tickLife(life, until - 1, () => 0.5).changed, false)
  const back = tickLife(life, until, () => 0.5)
  assert.equal(back.events[0].type, 'resume-sleep')
  assert.equal(life.state, 'sleep')
  assert.equal(life.interruptedFrom, null)
  assert.equal(life.wakeMode, 'open')
  assert.equal(life.until, null)
  assert.equal(life.history.at(-1).state, 'sleep')
  assert.equal(life.history.at(-1).source, 'auto')
})

await test('random 睡眠中途醒后：继续用原来的自然醒窗口', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'sleep', wakeMode: 'random', wakeEarliestMinutes: 300, wakeLatestMinutes: 540 }, T0)
  const earliest = life.wakeEarliest
  const latest = life.wakeLatest
  tickLife(life, T0 + 10 * MIN, () => 0) // 中途醒
  assert.equal(life.state, 'awake')
  tickLife(life, life.until, () => 0.5) // 回睡
  assert.equal(life.state, 'sleep')
  assert.equal(life.wakeMode, 'random')
  assert.equal(life.until, null)
  assert.equal(life.wakeEarliest, earliest)
  assert.equal(life.wakeLatest, latest)
})

await test('resumeSleepLife：fixed 闹钟已过 → 转 random 窗口', () => {
  const life = defaultsLife(T0)
  life.state = 'awake'
  life.interruptedFrom = 'sleep'
  life.until = T0 + 5 * MIN
  life.resume = { wakeMode: 'fixed', until: T0 + 2 * MIN, wakeEarliest: null, wakeLatest: null }
  const result = resumeSleepLife(life, T0 + 5 * MIN, () => 0.5)
  assert.equal(result.ok, true)
  assert.equal(life.state, 'sleep')
  assert.equal(life.wakeMode, 'random')
  assert.ok(life.wakeLatest > life.wakeEarliest)
})

await test('手动 wake 中途醒的状态 = 真的醒来（resume:false）', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'sleep', wakeMode: 'open' }, T0)
  tickLife(life, T0 + 10 * MIN, () => 0)
  assert.equal(life.state, 'awake')
  const result = wakeLife(life, { now: T0 + 12 * MIN, resume: false, source: 'self' })
  assert.equal(result.woke, true)
  assert.equal(result.resumed, false)
  assert.equal(life.interruptedFrom, null)
  assert.equal(life.until, null)
})

await test('cancel：清 until / 窗口，保持当前状态', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'work', minutes: 30 }, T0)
  const result = cancelLife(life, T0 + MIN)
  assert.equal(result.ok, true)
  assert.equal(life.state, 'work')
  assert.equal(life.until, null)
  assert.equal(life.wakeMode, 'open')
  assert.equal(life.wakeEarliest, null)
})

await test('工具 wake：中途醒时调用 = 真的醒来（不回睡）', async () => {
  const dir = join(root, 'life-tool-wake')
  let now = T0
  const { ctx, tools } = makeLifeCtx()
  const life = initLife({ ctx, state, log: () => {}, dir, now: () => now, random: () => 0, timers: fakeTimers() })
  const tool = tools.find(item => item.name === 'soul_life')

  await tool.execute({ action: 'plan', state: 'sleep', wakeMode: 'open' })
  now = T0 + 10 * MIN
  life.tick()
  assert.equal(life.get().state, 'awake')
  assert.equal(life.get().interruptedFrom, 'sleep')

  const result = await tool.execute({ action: 'wake' })
  assert.equal(result.state, 'awake')
  assert.equal(life.get().interruptedFrom, null)
  assert.equal(life.get().until, null)
  assert.equal(life.get().wakeMode, 'open')
  life.dispose()
})

/* ------------------------------------------------------------------ */
section('5. history ring 200 / 快照 / 文案')
/* ------------------------------------------------------------------ */

await test('history 最多 200 条，只保留最近的状态', () => {
  const life = defaultsLife(T0)
  for (let i = 0; i < 250; i += 1) {
    planLife(life, { state: i % 2 === 0 ? 'work' : 'rest', activity: `第 ${i} 条` }, T0 + i * MIN)
  }
  assert.equal(life.history.length, HISTORY_LIMIT)
  assert.equal(life.history.at(-1).activity, '第 249 条')
  assert.equal(life.history[0].activity, '第 50 条')
})

await test('lifeSnapshot：剩余时间 / 标签 / 最近 5 条', () => {
  const life = defaultsLife(T0)
  planLife(life, { state: 'work', minutes: 30 }, T0)
  const snap = lifeSnapshot(life, T0 + 10 * MIN)
  assert.equal(snap.label, '在忙')
  assert.equal(snap.remainingMs, 20 * MIN)
  assert.equal(snap.elapsedMs, 10 * MIN)
  assert.equal(snap.history.length, 1)
  assert.equal(snap.historyCount, 1)
})

await test('describeLife：状态 + activity + 醒法；无 life 返回空串', () => {
  assert.equal(describeLife(null, T0), '')
  assert.equal(describeLife({ state: 'nope' }, T0), '')

  const playing = defaultsLife(T0)
  planLife(playing, { state: 'play', activity: '听歌' }, T0)
  assert.equal(describeLife(playing, T0), '正在玩（听歌），预计自然醒')

  const sleeping = defaultsLife(T0)
  planLife(sleeping, { state: 'sleep', minutes: 480 }, T0)
  assert.equal(describeLife(sleeping, T0), '正在睡，闹钟 12:45')

  const awake = defaultsLife(T0)
  assert.equal(describeLife(awake, T0), '醒着')
})

/* ------------------------------------------------------------------ */
section('6. initLife：文件 / 工具 / 路由 / 定时器 / dispose')
/* ------------------------------------------------------------------ */

function fakeTimers() {
  const intervals = []
  return {
    intervals,
    setInterval(fn, ms) {
      const handle = { fn, ms, cleared: false }
      intervals.push(handle)
      return handle
    },
    clearInterval(handle) {
      if (handle) handle.cleared = true
    },
  }
}

function makeLifeCtx() {
  const tools = []
  const routes = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(registration) {
            routes.push(registration)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  return { ctx, tools, routes }
}

function fakeReq(method, url, headers = {}) {
  const stream = Readable.from([])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
    },
  }
}

await test('initLife：首次落 life.json（schema 完整）；工具 soul_life 全 action 可用', async () => {
  const dir = join(root, 'life-tool')
  const timers = fakeTimers()
  let now = T0
  const { ctx, tools, routes } = makeLifeCtx()
  const life = initLife({ ctx, state, log: () => {}, dir, now: () => now, random: () => 0, timers })

  const file = join(dir, 'life.json')
  assert.equal(life.file, file)
  assert.equal(existsSync(file), true)
  const saved = readLife(file)
  for (const key of ['version', 'state', 'activity', 'note', 'startedAt', 'until', 'wakeMode', 'wakeEarliest', 'wakeLatest', 'source', 'interruptedFrom', 'updatedAt', 'history']) {
    assert.ok(key in saved, `life.json 缺字段 ${key}`)
  }
  assert.equal(saved.state, 'awake')
  assert.equal(saved.wakeMode, 'open')

  const tool = tools.find(item => item.name === 'soul_life')
  assert.ok(tool, '没有注册 soul_life 工具')
  assert.match(tool.description, /她自己的生活/)
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'plan', 'wake', 'cancel', 'list'])
  assert.ok(tool.parameters.required.includes('action'))

  let result = await tool.execute({ action: 'status' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'awake')
  assert.equal(result.history.length, 0)

  result = await tool.execute({ action: 'plan', state: 'play', activity: '听歌' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'play')
  assert.equal(result.activity, '听歌')
  assert.match(result.message, /正在玩/)

  result = await tool.execute({ action: 'plan', state: 'sleep', minutes: 45 })
  assert.equal(result.wakeMode, 'fixed')
  assert.equal(result.until, T0 + 45 * MIN)

  result = await tool.execute({ action: 'cancel' })
  assert.equal(result.ok, true)
  assert.equal(result.until, null)
  assert.equal(result.wakeMode, 'open')

  result = await tool.execute({ action: 'wake' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'awake')

  // 参数 schema 会先挡住非法枚举（ToolArgsError），业务校验再挡缺 state
  await assert.rejects(() => tool.execute({ action: 'plan', state: 'nope' }))
  await assert.rejects(() => tool.execute({ action: 'explode' }))
  result = await tool.execute({ action: 'plan' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /state/)

  result = await tool.execute({ action: 'list' })
  assert.equal(result.ok, true)
  assert.ok(result.history.length >= 3)
  assert.ok(result.history.length <= 20)

  // 落盘：工具写完后文件里是 awake + history
  const persisted = readLife(file)
  assert.equal(persisted.state, 'awake')
  assert.ok(persisted.history.length >= 3)

  // HTTP 路由：GET /dsh-aura/life-api
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/dsh-aura/life-api')
  const res = fakeRes()
  await routes[0].handler(fakeReq('GET', '/dsh-aura/life-api'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.state, 'awake')

  life.dispose()
  assert.equal(timers.intervals.length, 1)
  assert.equal(timers.intervals[0].ms, 60 * 1000)
  assert.equal(timers.intervals[0].cleared, true)
  assert.equal(life.tick().changed, false)
  assert.equal(life.plan({ state: 'work' }).ok, false)
})

await test('initLife：60s 定时器到点自动醒；wake 事件带 from/mode；落盘', async () => {
  const dir = join(root, 'life-timer')
  const timers = fakeTimers()
  let now = T0
  const { ctx } = makeLifeCtx()
  const life = initLife({ ctx, state, log: () => {}, dir, now: () => now, random: () => 0, timers })

  const events = []
  life.on('wake', payload => events.push(payload))
  life.plan({ state: 'sleep', minutes: 30 })
  assert.equal(life.get().state, 'sleep')

  now = T0 + 30 * MIN
  timers.intervals[0].fn()
  assert.equal(life.get().state, 'awake')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'wake')
  assert.equal(events[0].from, 'sleep')
  assert.equal(events[0].mode, 'fixed')
  assert.equal(readLife(join(dir, 'life.json')).state, 'awake')

  life.dispose()
})

await test('initLife：重启从 life.json 恢复；坏文件改名 .corrupt 并回默认', async () => {
  const dir = join(root, 'life-persist')
  const first = initLife({ ctx: makeLifeCtx().ctx, state, log: () => {}, dir, now: () => T0, random: () => 0, timers: fakeTimers() })
  first.plan({ state: 'play', activity: '听歌', wakeMode: 'open' })
  first.dispose()

  const second = initLife({ ctx: makeLifeCtx().ctx, state, log: () => {}, dir, now: () => T0 + MIN, random: () => 0, timers: fakeTimers() })
  assert.equal(second.get().state, 'play')
  assert.equal(second.get().activity, '听歌')
  second.dispose()

  const corruptDir = join(root, 'life-corrupt')
  mkdirSync(corruptDir, { recursive: true })
  const file = join(corruptDir, 'life.json')
  writeFileSync(file, '{"state": "sleep"')
  const recovered = initLife({ ctx: makeLifeCtx().ctx, state, log: () => {}, dir: corruptDir, now: () => T0, random: () => 0, timers: fakeTimers() })
  assert.equal(recovered.get().state, 'awake')
  assert.equal(existsSync(`${file}.corrupt`), true)
  assert.equal(readLife(file).state, 'awake')
  recovered.dispose()
})

/* ------------------------------------------------------------------ */
section('7. presence 文案（优先 life，缺失回退钟点）')
/* ------------------------------------------------------------------ */

await test('renderPresenceContext：有 life 用自己的状态；无 life 回退「还醒着」', () => {
  const soul = defaultsSoul(T0)
  soul.relation.stage = 'familiar'

  const playing = defaultsLife(T0)
  planLife(playing, { state: 'play', activity: '听歌' }, T0)
  const text = renderPresenceContext(soul, { soulUserNickname: '木子' }, T0, playing)
  assert.match(text, /（现在是周一 04:45；你正在玩（听歌），预计自然醒；还没和用户聊过）/)
  assert.match(text, /关系：熟悉/)

  const sleeping = defaultsLife(T0)
  planLife(sleeping, { state: 'sleep', minutes: 60 }, T0)
  assert.match(renderPresenceContext(soul, {}, T0, sleeping), /你正在睡，闹钟 05:45/)

  const fallback = renderPresenceContext(soul, {}, T0, null)
  assert.match(fallback, /你还醒着，有点困/)
})

await test('installSoul：presence context order 50，通过 getLife 懒读 life', () => {
  const contexts = []
  const disposers = []
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    systemPrompt: {
      section() { return () => {} },
      context(spec) { contexts.push(spec); return () => {} },
    },
    tools: { register() { return () => {} } },
    get() { return undefined },
  }
  const playing = defaultsLife(T0)
  planLife(playing, { state: 'play', activity: '听歌' }, T0)
  let current = playing
  // 真实接线传的是 initLife 实例（有 get()）；兼容裸 life 对象两种形状
  installSoul(fakeCtx, { state, log: () => {}, getLife: () => ({ get: () => current }) })

  const presence = contexts.find(item => item.name === 'aura:presence')
  assert.ok(presence)
  assert.equal(presence.order, 50)
  assert.match(presence.text(), /正在玩/)

  current = null
  assert.doesNotMatch(presence.text(), /正在玩/)

  for (const dispose of disposers.reverse()) {
    try { dispose() } catch { /* ignore */ }
  }
})

/* ------------------------------------------------------------------ */
section('8. speak 联动：权重 / 睡眠门控 / prompt / notifyWake')
/* ------------------------------------------------------------------ */

function makeSpeakEnv(lifeState, overrides = {}) {
  const clock = { ms: new Date(2026, 9, 26, 20, 0, 0).getTime() }
  const chat = { sessionId: 'qq:dm:1:u1', kind: 'dm', chatId: 'u1', lastActiveAt: clock.ms - 60 * MIN }
  const agent = { status: 'idle', sent: [], async followup(message) { this.sent.push(message) } }
  const soulData = {
    v: 2,
    relation: { stage: 'familiar', score: 15, lastUserAt: clock.ms - 60 * MIN },
    emotion: { transient: { valence: 0, arousal: 0.2 }, drive: { energy: 0.6 }, affection: 0.5 },
    memory: { events: [], topics: {}, pendingDue: [] },
    speak: { lastRollAt: clock.ms - 31 * MIN },
    explainLog: [],
  }
  const config = {
    speakEnabled: true,
    speakDryRun: true,
    speakIntervalMinutes: 30,
    speakCooldownMinutes: 45,
    speakDailyCap: 3,
    quietStart: '23:30',
    quietEnd: '07:30',
    lifeQuietSleep: true,
    lifeWakeGreeting: true,
    ...overrides,
  }
  const bridge = {
    isOnline: () => true,
    bindings: () => [chat],
    addInboundHook: () => () => {},
    addOutboundHook: () => () => {},
    passiveWindowActive: () => false,
    findLiveAgent: () => agent,
    chatOfSession: () => chat,
    touchRecord() {},
    markProactive() {},
    takeProactive() {},
  }
  const stateRef = { readConfig: () => ({ ...config }), readSessions: () => ({}), writeJson() {} }
  const emotion = { snapshot: () => ({ valence: 0, arousal: 0.2, affection: 0.5, drive: { energy: 0.6 } }) }
  const memory = { recentTopics: () => [], pendingDue: () => [] }
  const soul = { data: soulData, get: () => soulData, save() {}, saveSoon() {}, saveNow() {}, recordExplain() {}, explain() {}, on() { return () => {} } }
  const lifeValue = { state: lifeState, activity: lifeState === 'play' ? '听歌' : '', until: null, wakeMode: 'open', startedAt: clock.ms }
  const life = { get: () => lifeValue }
  const ctx = { systemPrompt: { context() {} }, get(name) { return name === 'workspaceRegistry' ? { archivedSessionIds: [] } : undefined } }
  const speak = installSpeak(ctx, {
    state: stateRef,
    soul,
    emotion,
    memory,
    bridge,
    life,
    log: () => {},
    random: () => 0,
    now: () => new Date(clock.ms),
    retryDelayMs: 1,
  })
  return { speak, clock, agent, soulData, lifeValue, soul, config }
}

await test('lifeFactorOf 权重表：sleep=0 / work·play=0.4 / rest=1.2 / out=0.6 / 其他=1', () => {
  assert.equal(lifeFactorOf('sleep'), 0)
  assert.equal(lifeFactorOf('work'), 0.4)
  assert.equal(lifeFactorOf('play'), 0.4)
  assert.equal(lifeFactorOf('rest'), 1.2)
  assert.equal(lifeFactorOf('out'), 0.6)
  assert.equal(lifeFactorOf('awake'), 1)
  assert.equal(lifeFactorOf(''), 1)
  assert.equal(lifeFactorOf(null), 1)
})

await test('sleep：完全不发（哪怕 random=0 必中也不会走投递）', async () => {
  const env = makeSpeakEnv('sleep')
  const result = await env.speak.tick()
  assert.equal(result.done, 'life-sleep')
  assert.equal(env.agent.sent.length, 0)
})

await test('work：命中线 ×0.4，公式标注生活', async () => {
  const awakeEnv = makeSpeakEnv('awake')
  const awakeLine = awakeEnv.speak.snapshot().nextLine
  const workEnv = makeSpeakEnv('work')
  const workSnap = workEnv.speak.snapshot()
  assert.match(workSnap.rule, /生活 0\.4/)
  assert.ok(workSnap.nextLine < awakeLine, `${workSnap.nextLine} !< ${awakeLine}`)
  const ratio = workSnap.nextLine / awakeLine
  assert.ok(ratio > 0.25 && ratio < 0.55, `ratio=${ratio}`)
  awakeEnv.speak.stop()
  workEnv.speak.stop()
})

await test('rest / play / out：倍数作用在掷骰命中线上', async () => {
  const base = makeSpeakEnv('awake').speak.snapshot().nextLine
  for (const [lifeState, expected] of [['rest', 1.2], ['play', 0.4], ['out', 0.6]]) {
    const env = makeSpeakEnv(lifeState)
    const line = env.speak.snapshot().nextLine
    assert.ok(Math.abs(line - base * expected) <= 0.2, `${lifeState}: ${line} vs ${base * expected}`)
    env.speak.stop()
  }
})

await test('prompt 注入「你现在：…」（followup 文本里能看到）', async () => {
  const env = makeSpeakEnv('play', { speakDryRun: false, speakWakeMode: 'followup' })
  const result = await env.speak.tick()
  assert.equal(result.hit, true)
  assert.equal(env.agent.sent.length, 1)
  const text = env.agent.sent[0].content[0].text
  assert.match(text, /【此刻】你现在：正在玩（听歌）/)
  env.speak.stop()
})

await test('buildIntentBody：传 lifeText 才注入，不传保持原文', () => {
  const withLife = buildIntentBody({ act: 'care', lifeText: '正在玩，预计自然醒', now: new Date(T0) })
  assert.match(withLife, /你现在：正在玩，预计自然醒/)
  const without = buildIntentBody({ act: 'care', now: new Date(T0) })
  assert.doesNotMatch(without, /【此刻】/)
})

await test('notifyWake：最近没互动 → no-recent；有互动 → 掷骰走高优先级线', async () => {
  const stale = makeSpeakEnv('awake')
  stale.soulData.relation.lastUserAt = stale.clock.ms - 7 * HOUR
  const staleResult = await stale.speak.notifyWake()
  assert.equal(staleResult.done, 'no-recent')
  stale.speak.stop()

  const env = makeSpeakEnv('awake')
  const result = await env.speak.notifyWake()
  assert.equal(result.trigger, 'wake')
  assert.equal(result.line, 80) // 固定高命中线
  assert.equal(result.hit, true)
  env.speak.stop()
})

await test('生活层 wake 事件 → speak.notifyWake（dry-run 走完一次 wake 触发）', async () => {
  const dir = join(root, 'life-speak')
  const clockMs = new Date(2026, 9, 26, 20, 0, 0).getTime()
  const lifeCtx = makeLifeCtx()
  const life = initLife({ ctx: lifeCtx.ctx, state, log: () => {}, dir, now: () => clockMs, random: () => 0, timers: fakeTimers() })

  const env = makeSpeakEnv('awake')
  const config = env.config
  const soulData = env.soulData
  const speak = installSpeak(
    { systemPrompt: { context() {} }, get(name) { return name === 'workspaceRegistry' ? { archivedSessionIds: [] } : undefined } },
    {
      state: { readConfig: () => ({ ...config }), readSessions: () => ({}), writeJson() {} },
      soul: { data: soulData, get: () => soulData, save() {}, saveSoon() {}, saveNow() {}, recordExplain() {}, explain() {}, on() { return () => {} } },
      emotion: { snapshot: () => ({ valence: 0, arousal: 0.2, affection: 0.5, drive: { energy: 0.6 } }) },
      memory: { recentTopics: () => [], pendingDue: () => [] },
      bridge: {
        isOnline: () => true,
        bindings: () => [{ sessionId: 'qq:dm:1:u1', kind: 'dm', chatId: 'u1', lastActiveAt: clockMs - HOUR }],
        addInboundHook: () => () => {},
        addOutboundHook: () => () => {},
        passiveWindowActive: () => false,
        findLiveAgent: () => ({ status: 'idle', async followup() {} }),
        chatOfSession: () => ({ sessionId: 'qq:dm:1:u1', kind: 'dm', chatId: 'u1', key: 'dm:u1' }),
        touchRecord() {},
        markProactive() {},
        takeProactive() {},
      },
      life,
      log: () => {},
      random: () => 0,
      now: () => new Date(clockMs),
      retryDelayMs: 1,
    },
  )

  life.plan({ state: 'sleep', wakeMode: 'open' })
  life.wake({ source: 'auto' })
  await new Promise(resolve => setTimeout(resolve, 30))

  const logs = Array.isArray(soulData.speak.log) ? soulData.speak.log : []
  const wakeLogs = logs.filter(entry => entry && entry.trigger === 'wake')
  assert.ok(wakeLogs.length >= 1, `没有 wake 触发日志: ${JSON.stringify(logs)}`)
  env.speak.stop()
  speak.stop()
  life.dispose()
})

await test('initLife HTTP：?action= 路由表 / 参数校验 / 405 / fence', async () => {
  const dir = join(root, 'life-http')
  const timers = fakeTimers()
  let now = T0
  const { ctx, routes } = makeLifeCtx()
  const life = initLife({ ctx, state, log: () => {}, dir, now: () => now, random: () => 0, timers })
  const route = routes[0]
  const call = async (method, url, body, headers = {}) => {
    const stream = body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(body))])
    stream.method = method
    stream.url = url
    stream.headers = { host: '127.0.0.1:3080', ...headers }
    const res = fakeRes()
    await route.handler(stream, res)
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }

  let out = await call('GET', '/dsh-aura/life-api?action=status')
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.life.state, 'awake')
  assert.ok(Array.isArray(out.body.history))
  assert.equal(out.body.life.history.length, out.body.history.length)

  out = await call('POST', '/dsh-aura/life-api', {
    action: 'plan', state: 'play', activity: '听歌', wakeMode: 'random', wakeEarliestMinutes: 60, wakeLatestMinutes: 180,
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.life.state, 'play')
  assert.equal(out.body.life.activity, '听歌')
  assert.equal(out.body.life.wakeMode, 'random')

  out = await call('POST', '/dsh-aura/life-api', { action: 'plan', state: 'nope' })
  assert.equal(out.status, 400)
  assert.match(out.body.error, /state/)

  out = await call('POST', '/dsh-aura/life-api', { action: 'plan', state: 'work', minutes: 0 })
  assert.equal(out.status, 400)

  out = await call('POST', '/dsh-aura/life-api', { action: 'explode' })
  assert.equal(out.status, 400)
  assert.match(out.body.error, /未知 action/)

  out = await call('GET', '/dsh-aura/life-api?action=nope')
  assert.equal(out.status, 400)

  out = await call('GET', '/dsh-aura/life-api?action=list&limit=1')
  assert.equal(out.status, 200)
  assert.equal(out.body.history.length, 1)

  out = await call('GET', '/dsh-aura/life-api?action=list&limit=0')
  assert.equal(out.status, 400)

  out = await call('GET', '/dsh-aura/life-api?action=wake')
  assert.equal(out.status, 405)

  out = await call('POST', '/dsh-aura/life-api', { action: 'status' })
  assert.equal(out.status, 405)

  out = await call('POST', '/dsh-aura/life-api', { action: 'wake' })
  assert.equal(out.status, 200)
  assert.equal(out.body.life.state, 'awake')

  out = await call('PUT', '/dsh-aura/life-api')
  assert.equal(out.status, 405)

  out = await call('GET', '/dsh-aura/life-api?action=status', undefined, { origin: 'http://evil.example' })
  assert.equal(out.status, 403)

  // 旧路径仍兼容：GET / 顶层带 state
  out = await call('GET', '/dsh-aura/life-api')
  assert.equal(out.status, 200)
  assert.equal(out.body.state, 'awake')

  life.dispose()
})

/* ------------------------------------------------------------------ */

try {
  rmSync(root, { recursive: true, force: true })
} catch { /* ignore */ }

if (failed > 0) {
  console.error(`\n❌ 生活层自测：${passed} 通过，${failed} 失败`)
  for (const item of failures) console.error(`   - ${item.name}`)
  process.exitCode = 1
} else {
  console.log(`\n✅ 生活层自测完成：${passed}/${passed} 通过，0 失败`)
}
