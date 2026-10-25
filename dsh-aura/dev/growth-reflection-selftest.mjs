/**
 * dsh-aura 每日成长反思自测（node 直接跑）
 *   node dsh-aura/dev/growth-reflection-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不联网、不碰真实 soul/config/backup。覆盖：
 *   prompt / 输出解析（JSON、skip、think 包裹、非法输入）；
 *   首次反思写入 growth（source=reflection）+ 更新 soul.growthReflection + 落盘；
 *   写前备份 snapshot('soul-reflection')（备份里的 soul.json 是写入前的 0 条）；
 *   20h 冷却 / 当天已反思 / 最近 24h 事件 <3 的 skip；
 *   force 跳过时间与事件数限制，但每天最多 2 条的硬上限仍然生效；
 *   LLM 抛错 / 非法 JSON / {"skip":true} / 无 llm 服务都不写入；
 *   soulGrowthReflection=false 全关；dispose 清理定时器（排队中的反思不再执行）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-growth-reflection-selftest-'))
const originalHome = process.env.DSH_HOME

const soulMod = await import('../host/soul.js')
const reflectionMod = await import('../host/growth-reflection.js')
const state = await import('../host/state.js')

const { defaultsSoul, installSoul, normalizeSoul } = soulMod
const {
  REFLECTION_BACKUP_LABEL,
  REFLECTION_COOLDOWN_MS,
  REFLECTION_DAILY_LIMIT,
  buildGrowthReflectionPrompt,
  createGrowthReflection,
  localDayKey,
  normalizeReflectionState,
  parseGrowthReflectionOutput,
} = reflectionMod

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${(error && error.stack) || error}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 假宿主 ----------

function makeFakeCtx({ llm } = {}) {
  const sections = []
  const contexts = []
  const disposers = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
      context(spec) {
        contexts.push(spec)
        return () => {}
      },
    },
    tools: {
      register() {
        return () => {}
      },
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      }
      return undefined
    },
  }
  return {
    ctx,
    sections,
    contexts,
    dispose() {
      for (const fn of disposers.reverse()) {
        try {
          fn()
        } catch {
          /* noop */
        }
      }
    },
  }
}

const DEFAULT_TEXT = '我比想象中更能接住沉默'

/** 假 LLM：content 可以是字符串或 (callIndex) => string；mode=throw 时生成阶段抛错。 */
function makeLlm({ content = JSON.stringify({ kind: 'trait', text: DEFAULT_TEXT, note: '最近几次夜里聊天' }), mode = 'ok' } = {}) {
  const calls = []
  return {
    calls,
    stream(request) {
      calls.push(request)
      const callIndex = calls.length
      const text = typeof content === 'function' ? content(callIndex) : content
      return (async function* () {
        if (mode === 'throw') throw new Error('fake llm down')
        for (const ch of String(text)) yield { type: 'text-delta', text: ch }
      })()
    },
  }
}

function memoryFixture(count, now = Date.now()) {
  return {
    version: 1,
    events: Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      at: now - (i + 1) * 3_600_000,
      kind: 'chat',
      summary: `第 ${i + 1} 次聊天，聊到最近在折腾的项目`,
      salience: 0.5,
      topics: ['项目', '近况'],
      mood: { label: '平静', valence: 0.1 },
      source: 'rule',
      sessionId: 'qq:test',
    })),
    notes: {
      user: [{ id: 'n1', category: 'user', text: '最近在赶一个项目', importance: 0.6, createdAt: now - 7_200_000, updatedAt: now - 7_200_000, hits: 0, dueAt: 0 }],
      us: [],
      self: [],
    },
    topics: { 项目: { lastAt: now, count: 2 } },
    reflection: { lastReflectAt: 0, lastSource: '', userState: null, pendingDue: [] },
  }
}

function seedSoulWithReflection({ lastAt = 0, dayKey = '', count = 0 } = {}) {
  const seed = defaultsSoul(Date.now())
  seed.growthReflection = { lastAt, dayKey, count }
  return seed
}

let worldSeq = 0
async function makeWorld({ events = 4, config = null, llm = makeLlm(), seedSoul = null } = {}) {
  worldSeq += 1
  const dir = mkdtempSync(join(root, `world-${worldSeq}-`))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
  mkdirSync(dataDir, { recursive: true })
  if (config) state.writeJson('config.json', config)
  if (seedSoul) state.writeJson('soul.json', seedSoul)
  state.writeJson('memory.json', memoryFixture(events))

  const fake = makeFakeCtx({ llm })
  const installed = installSoul(fake.ctx, { state, log: () => {} })
  // 关掉 installSoul 内部的 5s 首跑，避免测试期间多一个定时器干扰计数。
  installed.growthReflection.dispose()
  const reflection = createGrowthReflection({ ctx: fake.ctx, state, soul: installed, log: () => {} })
  return {
    dir,
    dataDir,
    fake,
    installed,
    reflection,
    llm,
    calls() {
      return llm?.calls?.length ?? 0
    },
    backupsOf(label) {
      const dirBackups = join(dataDir, 'backups')
      try {
        return readdirSync(dirBackups).filter((id) => id.endsWith(`-${label}`))
      } catch {
        return []
      }
    },
    dispose() {
      reflection.dispose()
      fake.dispose()
    },
  }
}

// ---------- 1. 纯函数 ----------

section('1. 状态归一化 / prompt / 输出解析（纯函数）')
await test('defaultsSoul / normalizeSoul 都带 growthReflection，坏值被夹取', () => {
  assert.deepEqual(defaultsSoul().growthReflection, { lastAt: 0, dayKey: '', count: 0 })
  const restored = normalizeSoul({
    v: 2,
    growthReflection: { lastAt: 123, dayKey: '2026-10-26', count: 2 },
  })
  assert.deepEqual(restored.growthReflection, { lastAt: 123, dayKey: '2026-10-26', count: 2 })
  const bad = normalizeSoul({ v: 2, growthReflection: { lastAt: -5, dayKey: 'nope', count: -3 } })
  assert.deepEqual(bad.growthReflection, { lastAt: 0, dayKey: '', count: 0 })
  assert.deepEqual(normalizeReflectionState({ lastAt: 10.6, dayKey: '2026-01-02', count: 3.4 }), {
    lastAt: 11,
    dayKey: '2026-01-02',
    count: 3,
  })
})

await test('prompt 含最近事件/已有成长，并强调 JSON、skip 与「不是短期记忆/隐私/琐事」', () => {
  const prompt = buildGrowthReflectionPrompt({
    events: [{ at: Date.now(), kind: 'chat', summary: '聊到项目卡住了', topics: ['项目'], mood: { label: '平静' } }],
    notes: [{ category: 'user', text: '最近在赶项目' }],
    growth: [{ kind: 'trait', text: '我会先听完再回答' }],
    identity: { interests: ['听歌'], strengths: ['记得住细节'] },
  })
  assert.ok(prompt.includes('聊到项目卡住了'))
  assert.ok(prompt.includes('- [trait] 我会先听完再回答'))
  assert.ok(prompt.includes('- [user] 最近在赶项目'))
  assert.ok(prompt.includes('{"kind":"trait|interest|habit|bond|self"'))
  assert.ok(prompt.includes('{"skip":true}'))
  assert.ok(prompt.includes('不是短期记忆、不是用户隐私、不是一次琐事'))
  assert.ok(prompt.includes('第一人称'))
})

await test('parse：think 包裹/前后废话/非法 JSON/空 text/skip/长度截断', () => {
  assert.deepEqual(parseGrowthReflectionOutput('废话 <think>乱想</think> {"kind":"habit","text":"我会先听一会儿再说","note":"聊天"} 尾巴'), {
    skip: false,
    kind: 'habit',
    text: '我会先听一会儿再说',
    note: '聊天',
  })
  assert.deepEqual(parseGrowthReflectionOutput('{"skip":true}'), { skip: true })
  assert.equal(parseGrowthReflectionOutput('这不是 JSON'), null)
  assert.equal(parseGrowthReflectionOutput('{"kind":"trait","text":"   "}'), null)
  assert.equal(parseGrowthReflectionOutput('{}'), null)
  assert.equal(parseGrowthReflectionOutput('[]'), null)
  const long = parseGrowthReflectionOutput(JSON.stringify({ kind: 'nope', text: '我'.repeat(200), note: 'n'.repeat(200) }))
  assert.equal(long.kind, 'trait', '非法 kind 回落 trait')
  assert.equal(Array.from(long.text).length, 120)
  assert.equal(Array.from(long.note).length, 120)
})

// ---------- 2. 真实 installSoul + 反思器 ----------

section('2. 首次反思：写入 growth + 状态更新 + 备份')
const mainWorld = await makeWorld({
  events: 4,
  llm: makeLlm({
    content: (n) => JSON.stringify({
      kind: 'trait',
      text: n === 1 ? DEFAULT_TEXT : '我开始把停顿当成对话的一部分',
      note: `第 ${n} 次反思`,
    }),
  }),
})

await test('installSoul 的返回句柄带 grow，disposition 初始可反思', () => {
  assert.equal(typeof mainWorld.installed.grow, 'function')
  const d = mainWorld.reflection.disposition()
  assert.equal(d.enabled, true)
  assert.equal(d.eligible, true)
  assert.equal(d.dailyLimit, REFLECTION_DAILY_LIMIT)
  assert.equal(d.todayCount, 0)
  assert.equal(d.remaining, 2)
  assert.deepEqual(mainWorld.reflection.lastState(), { at: 0, ok: false, reason: 'never', attempts: 0 })
})

await test('首次反思：growth(source=reflection) + growthReflection + soul.json 落盘 + 身份段变化', async () => {
  const before = mainWorld.installed.listGrowth().length
  const result = await mainWorld.reflection.maybeReflect()
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.reason, 'written')
  assert.equal(result.growth.source, 'reflection')
  assert.equal(result.growth.kind, 'trait')
  assert.equal(result.growth.text, DEFAULT_TEXT)
  assert.ok(String(result.backupId).endsWith(`-${REFLECTION_BACKUP_LABEL}`))

  const soul = mainWorld.installed.get()
  assert.equal(soul.growth.length, before + 1)
  assert.equal(soul.growth[0].text, DEFAULT_TEXT)
  assert.equal(soul.growthReflection.count, 1)
  assert.equal(soul.growthReflection.dayKey, localDayKey())
  assert.ok(soul.growthReflection.lastAt > 0)
  assert.equal(mainWorld.calls(), 1)

  const disk = JSON.parse(readFileSync(join(mainWorld.dataDir, 'soul.json'), 'utf8'))
  assert.equal(disk.growth.length, 1)
  assert.equal(disk.growth[0].source, 'reflection')
  assert.deepEqual(disk.growthReflection, soul.growthReflection)

  const identity = mainWorld.fake.sections.find((spec) => spec.name === 'aura:soul-identity')
  assert.ok(identity.text().includes(DEFAULT_TEXT))

  const last = mainWorld.reflection.lastState()
  assert.equal(last.ok, true)
  assert.equal(last.reason, 'written')
  assert.equal(last.attempts, 1)
})

await test('写前备份：snapshot(soul-reflection)，备份里的 soul.json 是写入前（0 条成长）', () => {
  const ids = mainWorld.backupsOf(REFLECTION_BACKUP_LABEL)
  assert.equal(ids.length, 1, `应有 1 份 soul-reflection 备份，实际 ${ids.length}`)
  const dir = join(mainWorld.dataDir, 'backups', ids[0])
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.label, REFLECTION_BACKUP_LABEL)
  assert.ok(manifest.files.some((file) => file.name === 'soul.json'))
  const snap = JSON.parse(readFileSync(join(dir, 'soul.json'), 'utf8'))
  assert.equal(snap.growth.length, 0, '备份必须在 addGrowth 之前')
})

await test('今天已反思过：非 force 直接 skip，不调用 LLM', async () => {
  const before = mainWorld.calls()
  const result = await mainWorld.reflection.maybeReflect()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'already-today')
  assert.equal(result.skipped, true)
  assert.equal(mainWorld.calls(), before)
  const d = mainWorld.reflection.disposition()
  assert.equal(d.eligible, false)
  assert.equal(d.reason, 'already-today')
})

await test('force 跳过当天限制：写第 2 条；再 force 触发每天上限 2', async () => {
  const second = await mainWorld.reflection.maybeReflect({ force: true })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.usedToday, 2)
  assert.equal(mainWorld.installed.get().growthReflection.count, 2)
  assert.equal(mainWorld.installed.listGrowth().length, 2)
  assert.equal(mainWorld.calls(), 2)

  const third = await mainWorld.reflection.maybeReflect({ force: true })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'daily-limit')
  assert.equal(mainWorld.calls(), 2, '到上限后不应再调用 LLM')
  assert.equal(mainWorld.installed.get().growthReflection.count, 2)
  assert.equal(mainWorld.reflection.disposition().reason, 'daily-limit')
})
mainWorld.dispose()

section('3. 冷却 / 事件数 / force 边界')
await test('距上次 <20h（dayKey 为空）非 force 走 cooldown，force 可写', async () => {
  const now = Date.now()
  const world = await makeWorld({
    events: 4,
    seedSoul: seedSoulWithReflection({ lastAt: now - 3_600_000, dayKey: '', count: 1 }),
  })
  try {
    const skipped = await world.reflection.maybeReflect()
    assert.equal(skipped.ok, false)
    assert.equal(skipped.reason, 'cooldown')
    assert.ok(skipped.cooldownUntil > now)
    assert.equal(world.calls(), 0)

    const forced = await world.reflection.maybeReflect({ force: true })
    assert.equal(forced.ok, true)
    assert.equal(forced.usedToday, 1)
    assert.equal(world.installed.get().growthReflection.count, 1)
  } finally {
    world.dispose()
  }
})

await test('距上次 ≥20h 且 dayKey 是旧日期：正常写入，当天计数从 1 开始', async () => {
  const now = Date.now()
  const world = await makeWorld({
    events: 4,
    seedSoul: seedSoulWithReflection({ lastAt: now - REFLECTION_COOLDOWN_MS - 3_600_000, dayKey: '2000-01-01', count: 5 }),
  })
  try {
    const result = await world.reflection.maybeReflect()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.usedToday, 1)
    assert.equal(world.installed.get().growthReflection.dayKey, localDayKey(now))
    assert.equal(world.installed.get().growthReflection.count, 1)
  } finally {
    world.dispose()
  }
})

await test('最近 24h 事件 <3：非 force skip（不调 LLM），force 可写', async () => {
  const world = await makeWorld({ events: 2 })
  try {
    const skipped = await world.reflection.maybeReflect()
    assert.equal(skipped.ok, false)
    assert.equal(skipped.reason, 'not-enough-events')
    assert.equal(skipped.events, 2)
    assert.equal(world.calls(), 0)
    assert.equal(world.installed.listGrowth().length, 0)

    const forced = await world.reflection.maybeReflect({ force: true })
    assert.equal(forced.ok, true)
    assert.equal(world.installed.listGrowth().length, 1)
  } finally {
    world.dispose()
  }
})

section('4. LLM 失败 / 非法输出 / skip / 无模型 / 关闭开关')
await test('LLM 抛错：不写 growth、不记 count、不留 soul-reflection 备份', async () => {
  const world = await makeWorld({ events: 4, llm: makeLlm({ mode: 'throw' }) })
  try {
    const result = await world.reflection.maybeReflect()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'llm-failed')
    assert.equal(world.installed.listGrowth().length, 0)
    assert.equal(world.installed.get().growthReflection.count, 0)
    assert.equal(world.backupsOf(REFLECTION_BACKUP_LABEL).length, 0)
    assert.equal(world.calls(), 1)
  } finally {
    world.dispose()
  }
})

await test('非法 JSON / 缺 text：bad-output，不写入', async () => {
  for (const content of ['这不是 JSON', '{"kind":"trait"}', '{"kind":"trait","text":"   "}']) {
    const world = await makeWorld({ events: 4, llm: makeLlm({ content }) })
    try {
      const result = await world.reflection.maybeReflect()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'bad-output')
      assert.equal(world.installed.listGrowth().length, 0)
      assert.equal(world.installed.get().growthReflection.count, 0)
    } finally {
      world.dispose()
    }
  }
})

await test('{"skip":true}：不写入', async () => {
  const world = await makeWorld({ events: 4, llm: makeLlm({ content: '{"skip":true}' }) })
  try {
    const result = await world.reflection.maybeReflect()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'llm-skip')
    assert.equal(world.installed.listGrowth().length, 0)
    assert.equal(world.installed.get().growthReflection.count, 0)
  } finally {
    world.dispose()
  }
})

await test('拿不到 llm 服务：no-llm，安静 skip 不抛错', async () => {
  const world = await makeWorld({ events: 4, llm: null })
  try {
    const result = await world.reflection.maybeReflect()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-llm')
    assert.equal(world.installed.listGrowth().length, 0)
  } finally {
    world.dispose()
  }
})

await test('soulGrowthReflection=false：关闭（force 也不开），不调 LLM', async () => {
  const world = await makeWorld({ events: 4, config: { soulGrowthReflection: false } })
  try {
    for (const force of [false, true]) {
      const result = await world.reflection.maybeReflect({ force })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'disabled')
    }
    assert.equal(world.calls(), 0)
    assert.equal(world.installed.listGrowth().length, 0)
    assert.equal(world.reflection.disposition().enabled, false)
  } finally {
    world.dispose()
  }
})

section('5. 并发 / dispose')
await test('并发调用：第二个返回 busy，不会重复写', async () => {
  const world = await makeWorld({ events: 4 })
  try {
    const first = world.reflection.maybeReflect()
    const second = await world.reflection.maybeReflect()
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'busy')
    const settled = await first
    assert.equal(settled.ok, true)
    assert.equal(world.installed.listGrowth().length, 1)
    assert.equal(world.calls(), 1)
  } finally {
    world.dispose()
  }
})

await test('dispose 清理定时器：排队中的反思不再执行', async () => {
  const world = await makeWorld({ events: 4 })
  try {
    assert.deepEqual(world.reflection.schedule(10, { force: true }), { ok: true, scheduled: true, delay: 10 })
    world.reflection.dispose()
    await sleep(40)
    assert.equal(world.calls(), 0)
    assert.equal(world.installed.listGrowth().length, 0)
    const after = await world.reflection.maybeReflect()
    assert.equal(after.reason, 'disposed')
  } finally {
    world.dispose()
  }
})

// ---------- 清理 ----------

process.env.DSH_HOME = originalHome
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
