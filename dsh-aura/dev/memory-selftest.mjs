/**
 * dsh-aura 记忆存储自测（node 直接跑）
 *   node dsh-aura/dev/memory-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不碰真实 soul/config/memory.json。覆盖：
 *   memory-store：原子写、损坏 .corrupt 回退、归一化裁剪（40 事件 / 30 笔记 / 80 字）；
 *   迁移：soul.memory → memory.json、写前 backup('memory-migrate')、soul 清空、二次不覆盖；
 *   真实 installSoul + installMemory：旧 soul.json 自动迁移、soul.json 不再写 memory、reset 不清 memory.json；
 *   ring 裁剪（memoryMaxEvents 可调 5..40）、压实（>30 最旧 10 条 → notes）、context 预算与最近 2 条；
 *   soul_memory writeNote / soul_recall / pendingDue 行为、diary 注入 getMemoryStore 读 events；
 *   v2：v1→v2 迁移、facts/entities 上限、addFact 合并/取代、queryFacts、规则抽取、
 *   compact 去重/清理/衰减、soul_memory addFact、context 事实注入、实体别名去重。
 *   v2.1 实体图：relations schema/坏值清洗/300 上限、addFact 建边、co 共现加权、
 *   1 跳召回（context / soul_recall / memory-api / snapshot）、compactRelations 衰减清理。
 *   v2.2 记忆控制面：soul_memory 九种 action、笔记 id 迁移/更新/删除、实体删除清边、
 *   实体合并重定向、写前 backup('memory')、memory-api POST compact/delete*、
 *   memoryAutoCompact 自动整理开关、配置范围夹取。
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-memory-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
mkdirSync(dataDir, { recursive: true })
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

const state = await import('../host/state.js')
const soulMod = await import('../host/soul.js')
const memoryMod = await import('../host/memory.js')
const storeMod = await import('../host/memory-store.js')
const diaryMod = await import('../host/diary.js')
const {
  MEMORY_FILE,
  MEMORY_VERSION,
  FACT_LIMIT,
  ENTITY_LIMIT,
  RELATION_LIMIT,
  createMemoryStore,
  emptyMemory,
  normalizeMemory,
  resolveEntity,
} = storeMod
const {
  EVENT_MAX,
  MEMORY_CONTEXT_BUDGET,
  MEMORY_CONTEXT_BUDGET_MAX,
  NOTE_MAX,
  NOTE_MAX_CHARS,
  addFact,
  compactEvents,
  compactMemoryFacts,
  compactRelations,
  extractFacts,
  forgetFact,
  installMemory,
  listEntities,
  listFacts,
  listRelations,
  queryFacts,
  relationsForEntity,
  renderMemoryContext,
  upsertEntity,
  upsertRelation,
} = memoryMod

const lengthOf = (text) => Array.from(String(text ?? '')).length
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

function makeFakeCtx() {
  const tools = []
  const contexts = []
  const disposers = []
  const registrations = []
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
      section() {
        return () => {}
      },
      context(spec) {
        contexts.push(spec)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    webServer: {
      register(registration) {
        registrations.push(registration)
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  return {
    ctx,
    tools,
    contexts,
    registrations,
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

function eventText(i, at = Date.now()) {
  return {
    id: `evt-${i}`,
    at,
    kind: 'chat',
    summary: `事件编号${i}`,
    salience: 0.3,
    topics: ['加班'],
    source: 'rule',
    sessionId: 'qq:test',
  }
}

// ---------- 1. memory-store 纯存储 ----------
section('1. memory-store：原子写 / 损坏回退 / 归一化裁剪 / 重启读取')

await test('write/read：version 2、原子 tmp+rename、没有残留 tmp 文件', () => {
  const dir = join(root, 'store-a')
  const store = createMemoryStore({ home: dir, log: () => {} })
  const written = store.write({
    events: [eventText(1, 1000)],
    notes: { user: [{ text: 'n'.repeat(200) }], us: [], self: [] },
    topics: { 加班: { lastAt: 1000, count: 2 } },
    reflection: { lastReflectAt: 123, pendingDue: [{ at: 5000, text: '面试' }] },
  })
  assert.equal(written.version, MEMORY_VERSION)
  const disk = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(disk.version, MEMORY_VERSION)
  assert.deepEqual(disk.facts, [])
  assert.deepEqual(disk.entities, [])
  assert.equal(disk.events.length, 1)
  assert.equal(lengthOf(disk.notes.user[0].text), NOTE_MAX_CHARS)
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '不应残留 tmp 文件')

  const memory = store.read()
  assert.equal(memory.events[0].summary, '事件编号1')
  assert.deepEqual(memory.topics.加班, { lastAt: 1000, count: 2 })
  assert.equal(memory.reflection.lastReflectAt, 123)
  assert.equal(memory.reflection.pendingDue[0].text, '面试')
  assert.equal(memory.notes.user[0].text.length, 80)
  store.dispose()
})

await test('坏 JSON：回退空记忆，原文件备份成 memory.json.corrupt', () => {
  const dir = join(root, 'store-corrupt')
  const store = createMemoryStore({ home: dir, log: () => {} })
  store.write({ events: [eventText(2)] })
  writeFileSync(store.file, '{ not-json', 'utf8')
  const memory = store.read()
  assert.equal(memory.events.length, 0, '损坏时应回退空记忆')
  assert.ok(existsSync(`${store.file}.corrupt`), '应生成 .corrupt 备份')
  assert.equal(readFileSync(`${store.file}.corrupt`, 'utf8'), '{ not-json')
  // 下一次正常写入后，损坏标记解除
  store.write({ events: [eventText(3)] })
  assert.equal(store.read().events.length, 1)
  store.dispose()
})

await test('归一化：事件 ≤120、每类笔记 ≤30 且单条 ≤80 字、话题限长', () => {
  const dir = join(root, 'store-normalize')
  const store = createMemoryStore({ home: dir, log: () => {} })
  store.write({
    events: Array.from({ length: 155 }, (_, index) => eventText(index, index + 1)),
    notes: {
      user: Array.from({ length: 40 }, (_, index) => ({ text: `用户笔记${index}-${'长'.repeat(100)}` })),
      us: [{ text: '   ' }],
      self: [{ text: '我会承认不确定' }],
    },
    topics: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`话题${index}`, { lastAt: index, count: 1 }])),
  })
  const memory = store.read()
  assert.equal(memory.events.length, EVENT_MAX)
  assert.deepEqual(memory.events.map((item) => item.at), Array.from({ length: 120 }, (_, index) => index + 36))
  assert.equal(memory.notes.user.length, NOTE_MAX)
  assert.equal(memory.notes.self.length, 1)
  assert.ok(memory.notes.user.every((note) => lengthOf(note.text) <= NOTE_MAX_CHARS))
  assert.equal(Object.keys(memory.topics).length, 60)
  assert.equal(store.stats().events, EVENT_MAX)
  // 重启读取：新 store 实例读同一文件
  const again = createMemoryStore({ home: dir, log: () => {} })
  assert.equal(again.read().notes.self[0].text, '我会承认不确定')
  assert.equal(again.stats().notes.user, NOTE_MAX)
  store.dispose()
  again.dispose()
})

// ---------- 2. 迁移 ----------
section('2. 迁移：soul.memory → memory.json（写前 backup，soul 清空）')

const legacyMemory = {
  events: [eventText(1, 1000), eventText(2, 2000)],
  notes: { user: [{ id: 'n1', text: '用户叫木子' }], us: [], self: [] },
  topics: { 加班: { lastAt: 2000, count: 3 } },
  pendingDue: [{ id: 'd1', at: 9000, text: '记得面试' }],
  lastReflectAt: 456,
}

await test('migrateFromSoul：复制数据、调用 snapshotSync(memory-migrate)、清空 soul.memory', () => {
  const dir = join(root, 'migrate-a')
  const calls = []
  const store = createMemoryStore({
    home: dir,
    log: () => {},
    snapshotSync: (label, options) => {
      calls.push({ label, options })
      return { ok: true, id: `snap-${label}` }
    },
  })
  const soul = { memory: legacyMemory }
  const result = store.migrateFromSoul(soul)
  assert.equal(result.migrated, true)
  assert.equal(result.events, 2)
  assert.equal(result.notes, 1)
  assert.equal(result.topics, 1)
  assert.equal(result.cleared, true)
  assert.deepEqual(calls.map((item) => item.label), ['memory-migrate'])
  assert.deepEqual(soul.memory, {}, '迁移后 soul.memory 应清空')
  const memory = store.read()
  assert.equal(memory.events.length, 2)
  assert.equal(memory.notes.user[0].text, '用户叫木子')
  assert.equal(memory.reflection.lastReflectAt, 456)
  assert.equal(memory.reflection.pendingDue[0].text, '记得面试')
  // 二次迁移：不覆盖已有 memory.json
  const second = store.migrateFromSoul({ memory: { events: [eventText(99)] } })
  assert.equal(second.migrated, false)
  assert.equal(second.reason, 'exists')
  assert.equal(store.read().events.length, 2)
  store.dispose()
})

await test('备份失败只 warn，迁移继续写入', () => {
  const dir = join(root, 'migrate-backup-fail')
  const warnings = []
  const store = createMemoryStore({
    home: dir,
    log: (...args) => warnings.push(args.join(' ')),
    snapshotSync: () => {
      throw new Error('backup boom')
    },
  })
  const result = store.migrateFromSoul({ memory: { events: [eventText(7)] } })
  assert.equal(result.migrated, true)
  assert.equal(store.read().events.length, 1)
  assert.ok(warnings.some((line) => line.includes('备份失败')))
  store.dispose()
})

await test('memory.json 损坏时：先备份 .corrupt，再用旧 soul.memory 恢复', () => {
  const dir = join(root, 'migrate-corrupt')
  mkdirSync(dir, { recursive: true })
  const store = createMemoryStore({ home: dir, log: () => {}, snapshotSync: () => ({ ok: true, id: 'snap' }) })
  writeFileSync(store.file, '{ broken', 'utf8')
  const soul = { memory: { events: [eventText(5)] } }
  const result = store.migrateFromSoul(soul)
  assert.equal(result.migrated, true)
  assert.equal(store.read().events.length, 1)
  assert.ok(existsSync(`${store.file}.corrupt`), '损坏文件应先备份')
  assert.deepEqual(soul.memory, {})
  store.dispose()
})

// ---------- 3. 真实 installSoul + installMemory ----------
section('3. 真实宿装载：旧 soul.json 迁移、soul.json 不再写 memory、reset 不清 memory.json')

const legacySoulJson = {
  v: 2,
  identity: { name: 'Aura', address: { userPreferred: '木子' } },
  relation: { stage: 'familiar', score: 12, firstMetAt: 1000, turns: 3 },
  memory: legacyMemory,
  growth: [],
}
state.writeJson('soul.json', legacySoulJson)
assert.equal(soulMod.normalizeSoul(legacySoulJson).memory.events.length, 0, 'normalizeSoul 不再保留 memory')

const soulFake = makeFakeCtx()
const soul = soulMod.installSoul(soulFake.ctx, { state, log: () => {} })
const memFake = makeFakeCtx()
const memory = installMemory({ ctx: memFake.ctx, state, soul, log: () => {} })

await test('installSoul 暂存旧 memory，installMemory 迁移后清空并改写 soul.json', () => {
  assert.ok(memory.store, '应导出 store')
  assert.equal(memory.store.file, join(dataDir, MEMORY_FILE))
  const diskMemory = memory.store.read()
  assert.equal(diskMemory.events.length, 2)
  assert.equal(diskMemory.notes.user[0].text, '用户叫木子')
  assert.deepEqual(soul.get().memory, {}, '迁移后内存 soul.memory 应清空')
  const diskSoul = JSON.parse(readFileSync(join(dataDir, 'soul.json'), 'utf8'))
  assert.equal('memory' in diskSoul, false, 'soul.json 不应再写 memory')
  assert.ok(memFake.contexts.some((spec) => spec.name === 'aura:memory'), '应注册记忆 context')
  const backupIds = readdirSync(join(dataDir, 'backups')).filter((id) => id.endsWith('-memory-migrate'))
  assert.ok(backupIds.length >= 1, '迁移前应有一条 memory-migrate 备份')
  const manifest = JSON.parse(readFileSync(join(dataDir, 'backups', backupIds[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.label, 'memory-migrate')
  assert.ok(manifest.files.some((file) => file.name === 'soul.json'))
  const backupSoul = JSON.parse(readFileSync(join(dataDir, 'backups', backupIds[0], 'soul.json'), 'utf8'))
  assert.equal(backupSoul.memory.events.length, 2, '迁移前备份里应保留旧 memory')
})

await test('reset(all) 不改 memory.json', () => {
  const before = memory.store.read()
  const result = soul.reset('all')
  assert.equal(result.ok, true)
  const after = memory.store.read()
  assert.equal(after.events.length, before.events.length)
  assert.equal(after.notes.user[0].text, '用户叫木子')
  assert.ok(existsSync(memory.store.file))
})

// ---------- 4. ring 裁剪 / 压实 / context ----------
section('4. ring 裁剪、压实规则、context 预算')

await test('短期 ring：memoryMaxEvents=5 时只留最近 5 条', () => {
  state.writeConfig({ memoryMaxEvents: 5 })
  memory.clear()
  for (let index = 1; index <= 10; index += 1) {
    memory.addEvent(eventText(index, 10_000 + index * 2000))
  }
  const events = memory.store.read().events
  assert.equal(events.length, 5)
  assert.equal(events.at(-1).summary, '事件编号10')
  assert.equal(events.some((event) => event.summary === '事件编号1'), false)
  state.writeConfig({ memoryMaxEvents: 120 })
})

await test('压实：事件超过 30 时最旧 10 条汇总成 notes，events 减少且去重', () => {
  memory.clear()
  for (let index = 1; index <= 35; index += 1) {
    memory.addEvent(eventText(index, 20_000 + index * 2000))
  }
  const memoryNow = memory.store.read()
  assert.ok(memoryNow.events.length < 35, `events 应被压实，实际 ${memoryNow.events.length}`)
  assert.equal(memoryNow.events.length, 25)
  const noteCount = memoryNow.notes.user.length + memoryNow.notes.us.length + memoryNow.notes.self.length
  assert.ok(noteCount > 0, '应生成 notes')
  assert.ok(noteCount <= 3, `同类话题应去重，实际 ${noteCount}`)
  assert.ok(memoryNow.notes.us.some((note) => note.text.includes('聊过加班')))
  assert.ok([...memoryNow.notes.user, ...memoryNow.notes.us, ...memoryNow.notes.self]
    .every((note) => lengthOf(note.text) <= NOTE_MAX_CHARS))
  // 纯函数强制压实：再删 10 条
  const forced = compactEvents(memoryNow, { force: true, count: 10 })
  assert.equal(forced.compacted, 10)
  assert.equal(memoryNow.events.length, 15)
})

await test('renderMemoryContext：预算 ≤240，最近事件不自动注入', () => {
  memory.clear()
  memory.note('user', '用户叫木子', 0.9)
  memory.note('user', '用户喜欢听歌', 0.8)
  memory.note('us', '你们约好周末看电影', 0.8)
  for (let index = 1; index <= 5; index += 1) {
    memory.addEvent(eventText(index, Date.now() + index * 2000))
  }
  const config = state.readConfig()
  const context = memory.renderContext(Date.now(), { lastUserText: '木子' })
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET_MAX, `预算应 ≤${MEMORY_CONTEXT_BUDGET_MAX}，实际 ${lengthOf(context)}`)
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET, `当前预算 ${MEMORY_CONTEXT_BUDGET}`)
  assert.equal(context.includes('（最近：'), false, '最近事件不再按旧格式注入')
  assert.ok(context.includes('木子'))

  // 旧签名兼容：传 soul（带 memory）也能渲染
  const legacyContext = renderMemoryContext(
    { memory: { events: [eventText(8), eventText(9)], notes: { user: [{ text: '旧记忆' }], us: [], self: [] }, topics: {} }, relation: { lastUserText: '旧' } },
    config,
    { now: Date.now() },
  )
  assert.ok(lengthOf(legacyContext) <= MEMORY_CONTEXT_BUDGET_MAX)
  assert.ok(legacyContext.includes('旧记忆'))
})

await test('onUserMessage/onAssistantMessage/onTurnEnd：配对成事件，规则反思写 notes', () => {
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({ text: '我明天要去面试', at: base, sessionId: 'qq:turn' })
  memory.onAssistantMessage({ text: '那早点睡', at: base + 1000, sessionId: 'qq:turn' })
  memory.onTurnEnd({ at: base + 2000, sessionId: 'qq:turn', reason: 'complete' })
  const current = memory.store.read()
  assert.equal(current.events.length, 1)
  assert.ok(current.events[0].summary.includes('面试'))
  // 自披露会触发立即规则反思：至少有一条 us 笔记（"用户说过明天要去…"）
  const allNotes = [...current.notes.user, ...current.notes.us, ...current.notes.self]
  assert.ok(allNotes.length > 0, '规则反思应写 notes')
  assert.ok(allNotes.some((note) => note.text.includes('面试')))
})

// ---------- 5. 工具与到点提醒 ----------
section('5. soul_memory writeNote / soul_recall / pendingDue')

await test('soul_memory writeNote 写入 memory.json，soul_recall 能召回；单条 ≤80 字', async () => {
  memory.clear()
  const noteTool = memFake.tools.find((tool) => tool.name === 'soul_memory')
  const recallTool = memFake.tools.find((tool) => tool.name === 'soul_recall')
  assert.ok(noteTool && recallTool)
  const written = await noteTool.execute({ action: 'writeNote', category: 'user', text: '用户叫木子', importance: 0.9 })
  assert.equal(written.ok, true)
  assert.equal(written.note.category, 'user')
  const long = await noteTool.execute({ action: 'writeNote', category: 'self', text: '长'.repeat(200), importance: 0.5 })
  assert.equal(long.ok, true)
  assert.ok(lengthOf(long.note.text) <= NOTE_MAX_CHARS)
  const found = await recallTool.execute({ query: '木子' })
  assert.ok(found.items.some((item) => item.text.includes('木子')))
  const disk = JSON.parse(readFileSync(memory.store.file, 'utf8'))
  assert.ok(disk.notes.user.some((note) => note.text === '用户叫木子'))
})

await test('soul_memory writeNote 支持 dueAt（吃掉原 soul_note 的承诺提醒）', async () => {
  memory.clear()
  const noteTool = memFake.tools.find((tool) => tool.name === 'soul_memory')
  const later = Date.now() + 3_600_000
  const promised = await noteTool.execute({
    action: 'writeNote',
    category: 'us',
    text: '提醒你面试',
    importance: 0.7,
    dueAt: new Date(later).toISOString(),
  })
  assert.equal(promised.ok, true)
  assert.equal(memory.pendingDue(Date.now()).length, 0, '还没到点')
  assert.ok(memory.pendingDue(later + 1000).some((item) => item.text === '提醒你面试'))
  const past = await noteTool.execute({
    action: 'writeNote', category: 'us', text: '过去的事', dueAt: new Date(Date.now() - 1000).toISOString(),
  })
  assert.equal(past.ok, true)
  assert.equal(memory.store.read().reflection.pendingDue.some((item) => item.text === '过去的事'), false)
  const broken = await noteTool.execute({ action: 'writeNote', text: '坏 dueAt', dueAt: 'not-a-date' })
  assert.equal(broken.ok, true)
  assert.equal(memory.store.read().reflection.pendingDue.some((item) => item.text === '坏 dueAt'), false)
})

await test('pendingDue / consumeDue：到点才给，用掉即清', () => {
  memory.clear()
  memory.note('us', '提醒你面试', 0.7, Date.now() - 1000)
  const due = memory.pendingDue(Date.now())
  assert.equal(due.length, 1)
  assert.equal(due[0].text, '提醒你面试')
  const consumed = memory.consumeDue(Date.now())
  assert.equal(consumed.length, 1)
  assert.equal(memory.pendingDue(Date.now()).length, 0)
  assert.equal(memory.store.read().reflection.pendingDue.length, 0)
})

// ---------- 6. diary 读取 ----------
section('6. diary：注入 getMemoryStore 后从 memory.json 读 events')

await test('renderRuleDiary 支持只传 memory；createDiary 注入 store 后能生成当天日记', async () => {
  memory.clear()
  const today = diaryMod.localDayKey(Date.now())
  const now = Date.now()
  memory.addEvent({
    id: 'evt-diary',
    at: now,
    kind: 'chat',
    summary: '用户说「今天加班到很晚」；她回「早点睡」',
    salience: 0.5,
    topics: ['加班'],
    sessionId: 'qq:test',
  })
  const pure = diaryMod.renderRuleDiary({ date: today, memory: memory.store.read(), config: state.readConfig() })
  assert.ok(pure && pure.summary.includes('加班'))

  const diaryHome = join(root, 'diary-home')
  mkdirSync(diaryHome, { recursive: true })
  const diary = diaryMod.createDiary({
    home: diaryHome,
    getSoul: () => soul.get(),
    getConfig: () => state.readConfig(),
    getMemoryStore: () => memory.store,
    log: () => {},
  })
  const generated = await diary.generate({ date: today })
  assert.equal(generated.ok, true)
  assert.equal(generated.via, 'rule')
  assert.ok(generated.entry && generated.entry.summary.includes('加班'))
  const stored = JSON.parse(readFileSync(join(diaryHome, 'diary.json'), 'utf8'))
  assert.equal(stored.entries.length, 1)
  diary.dispose()
})

// ---------- 7. schema v2：迁移与上限 ----------
section('7. schema v2：v1→v2 迁移、facts 200 / entities 100 上限')

await test('v1→v2：读取自动补 facts/entities/lastCompactDayKey 并写回一次', () => {
  const dir = join(root, 'store-v1')
  mkdirSync(dir, { recursive: true })
  const store = createMemoryStore({ home: dir, log: () => {} })
  writeFileSync(store.file, JSON.stringify({
    version: 1,
    events: [eventText(1, 1000)],
    notes: { user: [{ text: '旧笔记' }], us: [], self: [] },
    topics: { 加班: { lastAt: 1000, count: 1 } },
    reflection: { lastReflectAt: 99, pendingDue: [] },
  }), 'utf8')
  const memory = store.read()
  assert.equal(memory.version, MEMORY_VERSION)
  assert.deepEqual(memory.facts, [])
  assert.deepEqual(memory.entities, [])
  assert.equal(memory.reflection.lastCompactDayKey, '')
  assert.equal(memory.events.length, 1)
  const disk = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(disk.version, MEMORY_VERSION)
  assert.ok(Array.isArray(disk.facts) && Array.isArray(disk.entities))
  assert.ok('lastCompactDayKey' in disk.reflection)
  // 第二次读不应再写回：塞一个 sentinel，读后还在说明没有重写。
  disk.sentinel = 'keep-me'
  writeFileSync(store.file, JSON.stringify(disk), 'utf8')
  store.read()
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).sentinel, 'keep-me')
  store.dispose()
})

await test('上限裁剪：facts 超 200 先删 superseded，entities 超 100 删最旧', () => {
  const memory = emptyMemory()
  memory.facts = Array.from({ length: FACT_LIMIT }, (_, index) => ({
    id: `old-fact-${index}`,
    subject: `主体${index}`,
    predicate: '喜欢',
    value: `值${index}`,
    text: '旧卡',
    confidence: 0.3,
    source: 'user',
    firstSeenAt: index,
    lastSeenAt: index,
    supersededBy: index < 50 ? `gone-${index}` : null,
    lastDecayAt: index,
  }))
  const added = addFact(memory, {
    subject: '新主体', predicate: '喜欢', value: '听歌', confidence: 0.9,
  }, 500)
  assert.equal(added.created, true)
  assert.equal(memory.facts.length, FACT_LIMIT)
  assert.equal(memory.facts.filter(fact => fact.supersededBy).length, 49, '应优先删已取代的卡')
  assert.equal(memory.facts.some(fact => fact.id === 'old-fact-0'), false)

  memory.entities = Array.from({ length: ENTITY_LIMIT }, (_, index) => ({
    id: `old-ent-${index}`,
    name: `实体${index}`,
    type: 'other',
    aliases: [],
    firstSeenAt: index,
    lastSeenAt: index,
  }))
  const entity = upsertEntity(memory, '团子', { type: 'pet', aliases: ['猫'] }, 900)
  assert.equal(entity.created, true)
  assert.equal(memory.entities.length, ENTITY_LIMIT)
  assert.equal(memory.entities.some(item => item.name === '实体0'), false)
  assert.ok(memory.entities.some(item => item.name === '团子'))
})

await test('memory-store 便捷方法：store.addFact / queryFacts / upsertEntity / compactFacts', () => {
  const dir = join(root, 'store-facts')
  const store = createMemoryStore({ home: dir, log: () => {} })
  const added = store.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  assert.equal(added.ok, true)
  assert.equal(store.queryFacts('听歌').length, 1)
  assert.equal(store.listFacts().length, 1)
  const entity = store.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  assert.equal(entity.created, true)
  assert.equal(store.listEntities()[0].name, '团子')
  const compacted = store.compactFacts()
  assert.equal(compacted.factsMerged, 0)
  assert.equal(store.forgetFact(added.fact.id), true)
  assert.equal(store.listFacts().length, 0)
  store.dispose()
})

// ---------- 8. 事实卡 / 实体卡 API ----------
section('8. addFact / queryFacts / listFacts / forgetFact / upsertEntity')

await test('addFact：同值合并提升 confidence、不同值取代旧卡、confidence 取高', () => {
  const memory = emptyMemory()
  const first = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.6, source: 'user', text: '木子喜欢听歌',
  }, 1000)
  assert.equal(first.created, true)
  assert.equal(first.fact.firstSeenAt, 1000)
  assert.equal(first.fact.lastSeenAt, 1000)

  const merged = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.6, source: 'user',
  }, 2000)
  assert.equal(merged.merged, true)
  assert.equal(memory.facts.length, 1)
  assert.ok(Math.abs(merged.fact.confidence - 0.65) < 1e-9)
  assert.equal(merged.fact.lastSeenAt, 2000)
  assert.equal(merged.fact.firstSeenAt, 1000)

  const replaced = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '看电影', confidence: 0.8, source: 'reflection',
  }, 3000)
  assert.equal(replaced.created, true)
  assert.equal(replaced.superseded, 1)
  const oldFact = memory.facts.find(fact => fact.value === '听歌')
  assert.equal(oldFact.supersededBy, replaced.fact.id)
  assert.equal(replaced.fact.confidence, 0.8)

  const high = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '跑步', confidence: 0.95,
  }, 4000)
  const lower = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '爬山', confidence: 0.6,
  }, 5000)
  assert.equal(high.created, true)
  assert.equal(lower.fact.confidence, 0.95, '新卡应继承旧卡更高置信度')
})

await test('queryFacts：subject/value/predicate token 命中 + recency，跳过 superseded', () => {
  const memory = emptyMemory()
  addFact(memory, { subject: '木子', predicate: '居住地', value: '杭州', text: '木子住在杭州' }, 1000)
  addFact(memory, { subject: '木子', predicate: '生日', value: '5月3日', text: '木子生日是5月3日' }, 2000)
  addFact(memory, { subject: '木子', predicate: '工作', value: '字节', text: '木子在字节上班' }, 3000)
  addFact(memory, { subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌' }, 4000)
  addFact(memory, { subject: '木子', predicate: '喜欢', value: '看电影', text: '木子喜欢看电影' }, 5000)

  assert.equal(queryFacts(memory, '杭州')[0].predicate, '居住地')
  assert.equal(queryFacts(memory, '生日')[0].value, '5月3日')
  assert.equal(queryFacts(memory, '字节')[0].predicate, '工作')
  assert.equal(queryFacts(memory, '喜欢')[0].value, '看电影')
  assert.equal(queryFacts(memory, '听歌').length, 0, 'superseded 不应命中')
  assert.equal(listFacts(memory).length, 4)
  assert.equal(listFacts(memory)[0].value, '看电影')

  const forgot = forgetFact(memory, memory.facts.find(fact => fact.value === '看电影').id)
  assert.equal(forgot, true)
  assert.equal(queryFacts(memory, '喜欢').length, 0)
  assert.equal(forgetFact(memory, 'does-not-exist'), false)
})

await test('upsertEntity：名字/别名去重，类型更新，lastSeenAt 刷新', () => {
  const memory = emptyMemory()
  const first = upsertEntity(memory, '团子', { type: 'pet', aliases: ['猫', '咪咪'] }, 1000)
  assert.equal(first.created, true)
  const second = upsertEntity(memory, '咪咪', { type: 'pet', aliases: ['团子', '猫猫'] }, 2000)
  assert.equal(second.created, false)
  assert.equal(memory.entities.length, 1)
  assert.equal(second.entity.name, '团子')
  assert.deepEqual(second.entity.aliases.sort(), ['猫', '猫猫', '咪咪'].sort())
  assert.equal(second.entity.lastSeenAt, 2000)
  assert.equal(second.entity.firstSeenAt, 1000)
})

// ---------- 9. 规则抽取 ----------
section('9. 规则抽取：称呼/喜欢/讨厌/宠物/居住/在做/生日/工作/约定')

await test('每种句式都能抽出事实；约定 0.9，普通规则 0.6，单条 ≤60 字', () => {
  const cases = [
    ['我叫木子', '称呼', '木子'],
    ['我喜欢听歌', '喜欢', '听歌'],
    ['我不喜欢香菜', '讨厌', '香菜'],
    ['我养了一只猫叫团子', '宠物', '团子'],
    ['我住在杭州', '居住地', '杭州'],
    ['我最近在忙长期记忆项目', '在忙', '长期记忆项目'],
    ['我生日是5月3日', '生日', '5月3日'],
    ['我在字节上班', '工作', '字节'],
    ['答应你周末陪你看电影', '约定', '你周末陪你看电影'],
  ]
  for (const [text, predicate, value] of cases) {
    const extracted = extractFacts(text, { subject: '木子' })
    const fact = extracted.facts.find(item => item.predicate === predicate)
    assert.ok(fact, `「${text}」应抽出 ${predicate}`)
    assert.equal(fact.value, value)
    assert.ok(lengthOf(fact.text) <= 60, `事实 text 应 ≤60 字，实际 ${lengthOf(fact.text)}`)
    assert.ok(lengthOf(fact.value) <= 60)
    if (predicate === '约定') assert.equal(fact.confidence, 0.9)
    else assert.equal(fact.confidence, 0.6)
  }
})

await test('抽取保守：叫我起床 / 我住的地方 / 模糊生日 不产生事实', () => {
  assert.equal(extractFacts('叫我起床').facts.length, 0)
  assert.equal(extractFacts('我住的地方很吵').facts.length, 0)
  assert.equal(extractFacts('我生日快到了').facts.length, 0)
  assert.equal(extractFacts('我在上班').facts.length, 0)
  const longText = extractFacts('我喜欢' + '很长的爱好'.repeat(20))
  assert.ok(longText.facts.every(fact => lengthOf(fact.text) <= 60))
})

await test('宠物/居住/工作生成对应实体（pet / place）', () => {
  const pet = extractFacts('我养了一只猫叫团子')
  assert.ok(pet.entities.some(entity => entity.name === '团子' && entity.type === 'pet'))
  const live = extractFacts('我住在杭州')
  assert.ok(live.entities.some(entity => entity.name === '杭州' && entity.type === 'place'))
  const work = extractFacts('我在字节上班')
  assert.ok(work.entities.some(entity => entity.name === '字节' && entity.type === 'place'))
})

await test('onUserMessage：规则抽取真的写进 memory.json', () => {
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({
    text: '我养了一只猫叫团子，我住在杭州，我喜欢听歌',
    at: base,
    sessionId: 'qq:extract',
  })
  const disk = memory.store.read()
  assert.ok(disk.facts.some(fact => fact.predicate === '宠物' && fact.value === '团子'))
  assert.ok(disk.facts.some(fact => fact.predicate === '居住地' && fact.value === '杭州'))
  assert.ok(disk.facts.some(fact => fact.predicate === '喜欢' && fact.value === '听歌'))
  assert.ok(disk.entities.some(entity => entity.name === '团子' && entity.type === 'pet'))
  assert.ok(disk.entities.some(entity => entity.name === '杭州' && entity.type === 'place'))
  assert.ok(disk.facts.every(fact => lengthOf(fact.text) <= 60))
})

// ---------- 10. 周期整理 ----------
section('10. compact：去重 / 60 天清理 / 30 天衰减 / 90 天实体清理 / 每天一次')

await test('compactMemoryFacts：合并同 subject+predicate+value 重复卡', () => {
  const now = Date.now()
  const memory = emptyMemory()
  const first = addFact(memory, {
    subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.6, text: '木子喜欢听歌',
  }, now - 2000)
  memory.facts.push({
    ...first.fact,
    id: 'fact-duplicate',
    confidence: 0.9,
    lastSeenAt: now - 1000,
    text: '木子喜欢听歌（重复）',
  })
  const result = compactMemoryFacts(memory, now)
  assert.equal(result.factsMerged, 1)
  assert.equal(memory.facts.filter(fact => !fact.supersededBy).length, 1)
  assert.equal(memory.facts[0].confidence, 0.9)
})

await test('compactMemoryFacts：清理 60 天前 superseded，30 天后每天 -0.02（下限 0.3）', () => {
  const now = Date.now()
  const day = 86_400_000
  const memory = emptyMemory()
  addFact(memory, { subject: '木子', predicate: '喜欢', value: '旧爱好', confidence: 0.8 }, now - 70 * day)
  addFact(memory, { subject: '木子', predicate: '喜欢', value: '新爱好', confidence: 0.8 }, now - 70 * day + 1)
  const decay = addFact(memory, { subject: '木子', predicate: '在做', value: '长期项目', confidence: 0.9 }, now - 40 * day)
  decay.fact.lastDecayAt = now - 40 * day
  const floor = addFact(memory, { subject: '木子', predicate: '在学', value: '旧项目', confidence: 0.5 }, now - 200 * day)
  floor.fact.lastDecayAt = now - 200 * day

  const result = compactMemoryFacts(memory, now)
  assert.ok(result.factsPruned >= 1, '应清理旧的 superseded')
  assert.equal(memory.facts.some(fact => fact.value === '旧爱好'), false)
  const decayed = memory.facts.find(fact => fact.value === '长期项目')
  assert.ok(Math.abs(decayed.confidence - 0.7) < 1e-9, `40 天应衰减到 0.7，实际 ${decayed.confidence}`)
  const floored = memory.facts.find(fact => fact.value === '旧项目')
  assert.equal(floored.confidence, 0.3, '衰减不应低于 0.3')
  // 第二天再整理：应再降 0.02，而不是重新等 30 天
  compactMemoryFacts(memory, now + day)
  assert.ok(Math.abs(memory.facts.find(fact => fact.value === '长期项目').confidence - 0.68) < 1e-9)
})

await test('compactMemoryFacts：90 天无事实关联的实体清理，有关联的保留', () => {
  const now = Date.now()
  const day = 86_400_000
  const memory = emptyMemory()
  upsertEntity(memory, '杭州', { type: 'place' }, now - 100 * day)
  memory.entities.find(entity => entity.name === '杭州').lastSeenAt = now - 100 * day
  upsertEntity(memory, '团子', { type: 'pet' }, now - 100 * day)
  memory.entities.find(entity => entity.name === '团子').lastSeenAt = now - 100 * day
  addFact(memory, { subject: '木子', predicate: '宠物', value: '团子', confidence: 0.9 }, now)
  const result = compactMemoryFacts(memory, now)
  assert.equal(result.entitiesPruned, 1)
  assert.equal(memory.entities.some(entity => entity.name === '杭州'), false)
  assert.equal(memory.entities.some(entity => entity.name === '团子'), true)
})

await test('compact()：每天最多一次，force 可强制再跑', () => {
  memory.clear()
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  const first = memory.compact(false)
  assert.equal(first.skipped, false)
  assert.equal(memory.snapshot().lastCompactDayKey, diaryMod.localDayKey(Date.now()))
  const second = memory.compact(false)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'daily')
  const forced = memory.compact(true)
  assert.equal(forced.skipped, false)
})

// ---------- 11. soul_memory addFact / soul_recall ----------
section('11. soul_memory addFact / forgetFact / soul_recall 附带 facts+entities')

await test('soul_memory addFact / forgetFact：加 → 搜 → 忘 全流程', async () => {
  memory.clear()
  const factTool = memFake.tools.find(tool => tool.name === 'soul_memory')
  assert.ok(factTool, '应注册 soul_memory')
  const added = await factTool.execute({
    action: 'addFact', subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9,
  })
  assert.equal(added.ok, true)
  assert.equal(added.fact.subject, '木子')
  assert.equal(added.fact.value, '听歌')
  assert.equal(added.fact.confidence, 0.9)

  // text 兜底当 value
  const viaText = await factTool.execute({ action: 'addFact', subject: '木子', predicate: '居住地', text: '杭州' })
  assert.equal(viaText.ok, true)
  assert.equal(viaText.fact.value, '杭州')
  // 整段「甲 · 乙 · 丙」拆开
  const parsed = await factTool.execute({ action: 'addFact', text: '木子 · 养的猫 · 团子' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.fact.subject, '木子')
  assert.equal(parsed.fact.predicate, '养的猫')
  assert.equal(parsed.fact.value, '团子')

  const queried = await factTool.execute({ action: 'search', query: '听歌' })
  assert.ok(queried.facts.some(fact => fact.value === '听歌'))
  const forgotten = await factTool.execute({ action: 'forgetFact', id: added.fact.id })
  assert.equal(forgotten.forgotten, true)
  const after = await factTool.execute({ action: 'search', query: '听歌' })
  assert.equal(after.facts.some(fact => fact.value === '听歌'), false)
  const missing = await factTool.execute({ action: 'forgetFact', id: 'fact-nope' })
  assert.equal(missing.ok, false)
  const empty = await factTool.execute({ action: 'addFact', subject: '' })
  assert.equal(empty.ok, false)
  const bad = await factTool.execute({ action: 'unknown' })
  assert.equal(bad.ok, false)
})

await test('soul_recall 结果附带命中的 facts 与 entities', async () => {
  memory.clear()
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌', confidence: 0.9 })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  const recallTool = memFake.tools.find(tool => tool.name === 'soul_recall')
  assert.ok(recallTool)
  const factRecall = await recallTool.execute({ query: '听歌' })
  assert.ok(Array.isArray(factRecall.facts))
  assert.ok(factRecall.facts.some(fact => fact.value === '听歌'))
  const entityRecall = await recallTool.execute({ query: '团子' })
  assert.ok(Array.isArray(entityRecall.entities))
  assert.ok(entityRecall.entities.some(entity => entity.name === '团子'))
  assert.equal(entityRecall.entities[0].type, 'pet')
})

await test('memory-api：面板只读接口返回 facts/entities，非本机请求 403', async () => {
  const registration = memFake.registrations.find(item => item.path === '/dsh-aura/memory-api')
  assert.ok(registration, 'installMemory 应注册 /dsh-aura/memory-api')
  memory.clear()
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌', confidence: 0.9 })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  const response = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  await registration.handler({
    method: 'GET',
    url: '/dsh-aura/memory-api/state?limit=12',
    headers: { host: '127.0.0.1:3080' },
  }, response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.ok(body.facts.some(fact => fact.value === '听歌'))
  assert.ok(body.entities.some(entity => entity.name === '团子'))
  assert.equal(body.facts.some(fact => fact.supersededBy), false)

  const forbidden = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  await registration.handler({
    method: 'GET',
    url: '/dsh-aura/memory-api/state',
    headers: { host: 'example.com' },
  }, forbidden)
  assert.equal(forbidden.status, 403)
})

// ---------- 12. context / snapshot ----------
section('12. context 注入事实/实体且 ≤240；snapshot 带 facts/entities')

await test('context：query 命中事实 + top2 实体，superseded 不注入', () => {
  memory.clear()
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌', confidence: 0.9 })
  memory.addFact({ subject: '木子', predicate: '居住地', value: '杭州', text: '木子住在杭州', confidence: 0.9 })
  memory.addFact({ subject: '木子', predicate: '生日', value: '5月3日', text: '木子生日是5月3日', confidence: 0.9 })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '看电影', text: '木子喜欢看电影', confidence: 0.9 })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.upsertEntity('杭州', { type: 'place' })
  for (let index = 1; index <= 5; index += 1) {
    memory.addEvent(eventText(index, Date.now() + index * 1000))
  }
  const context = memory.renderContext(Date.now(), { lastUserText: '喜欢' })
  assert.ok(context.includes('（你记得：'), context)
  assert.ok(context.includes('木子喜欢看电影'), '应注入当前有效事实')
  assert.equal(context.includes('木子喜欢听歌'), false, 'superseded 不应注入')
  assert.ok(context.includes('团子（宠物）'))
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET, `预算应 ≤${MEMORY_CONTEXT_BUDGET}，实际 ${lengthOf(context)}`)
  assert.equal(context.includes('（最近：'), false, '最近事件不再按旧格式注入')
})

await test('旧事：≥14 天且非当前会话的 events 才注入', () => {
  const oldAt = Date.now() - 20 * 86_400_000
  memory.addEvent({ kind: 'chat', summary: '旧的约定', at: oldAt, sessionId: 'qq:dm:old' })
  const context = memory.renderContext(Date.now(), { sessionId: 'qq:dm:new' })
  assert.ok(context.includes('旧事'), context)
  assert.ok(context.includes('旧的约定'))
  const same = memory.renderContext(Date.now(), { sessionId: 'qq:dm:old' })
  assert.equal(same.includes('旧的约定'), false)
})

await test('snapshot 带 facts/entities，且事实不含 superseded', () => {
  const snap = memory.snapshot()
  assert.ok(Array.isArray(snap.facts))
  assert.ok(Array.isArray(snap.entities))
  assert.ok(snap.facts.length > 0)
  assert.ok(snap.entities.length > 0)
  assert.ok(snap.facts.every(fact => !fact.supersededBy))
  assert.ok(snap.factCount >= snap.facts.length)
  assert.ok(snap.entities.every(entity => Array.isArray(entity.aliases)))
})

// ---------- 13. 关系图 schema ----------
section('13. relations schema：v1 补 []、坏值清洗、上限 300')

await test('relations：v1 补 []、悬空/自环清掉、co 反向合并、权重限幅', () => {
  assert.deepEqual(normalizeMemory({ version: 1, events: [], notes: {}, topics: {} }).relations, [])
  const draft = emptyMemory()
  const a = upsertEntity(draft, '木子', { type: 'person' }, 1000).entity
  const b = upsertEntity(draft, '团子', { type: 'pet', aliases: ['猫'] }, 1000).entity
  const normalized = normalizeMemory({
    version: 2,
    entities: [a, b],
    relations: [
      { id: 'r1', from: a.id, to: b.id, type: '养', weight: 0.8, firstSeenAt: 10, lastSeenAt: 20 },
      { id: 'r2', from: a.id, to: 'missing-entity', type: '养', weight: 0.9 },
      { id: 'r3', from: a.id, to: a.id, type: '自己', weight: 0.9 },
      { id: 'r4', from: b.id, to: a.id, type: 'co', weight: 3 },
      { id: 'r5', from: a.id, to: b.id, type: 'co', weight: 0.2 },
      { id: 'r6', from: a.id, to: b.id, type: '别名', weight: 'x' },
    ],
  }, 2000)
  assert.equal(normalized.relations.some(rel => rel.id === 'r2'), false, '悬空边应清掉')
  assert.equal(normalized.relations.some(rel => rel.id === 'r3'), false, '自环应清掉')
  const co = normalized.relations.filter(rel => rel.type === 'co')
  assert.equal(co.length, 1, '反向重复的 co 边应合并成一条')
  assert.equal(co[0].weight, 1, 'weight 超界应限幅到 1')
  const badWeight = normalized.relations.find(rel => rel.id === 'r6')
  assert.equal(badWeight.weight, 0.8, '坏 weight 回默认 0.8')
  const kept = normalized.relations.find(rel => rel.id === 'r1')
  assert.equal(kept.firstSeenAt, 10)
  assert.equal(kept.lastSeenAt, 20)
  assert.equal(kept.from, a.id, 'from/to 应是 entity id')
})

await test('memory.json 写读 relations；超过 300 条先删 weight 最低、最旧的', () => {
  const dir = join(root, 'store-relations')
  const store = createMemoryStore({ home: dir, log: () => {} })
  const draft = emptyMemory()
  const a = upsertEntity(draft, '甲', { type: 'person' }, 1000).entity
  const b = upsertEntity(draft, '乙', { type: 'person' }, 1000).entity
  draft.relations = Array.from({ length: RELATION_LIMIT + 5 }, (_, index) => ({
    id: `rel-${index}`,
    from: a.id,
    to: b.id,
    type: `t${index}`,
    weight: 0.2 + (index % 5) * 0.05,
    firstSeenAt: index,
    lastSeenAt: index,
  }))
  store.write(draft)
  const disk = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(disk.relations.length, RELATION_LIMIT)
  const loaded = store.read()
  assert.equal(loaded.relations.length, RELATION_LIMIT)
  const keptIds = new Set(loaded.relations.map(rel => rel.id))
  assert.ok(['rel-0', 'rel-5', 'rel-10', 'rel-15', 'rel-20'].every(id => !keptIds.has(id)), '应删最轻且最旧的 5 条')
  assert.ok(keptIds.has('rel-24'), '较新的低权重边应保留')
  assert.equal(store.stats().relations, RELATION_LIMIT)

  // store 级便捷方法：upsertRelation / listRelations / relationsForEntity / compactRelations
  const manual = store.upsertRelation({ from: a.id, to: b.id, type: '手动', weight: 0.5 }, 9999)
  assert.equal(manual.ok, true)
  assert.equal(store.listRelations(5)[0].type, '手动')
  assert.ok(store.relationsForEntity('甲').some(rel => rel.type === '手动'))
  assert.equal(store.relationsForEntity('不存在').length, 0)
  const compacted = store.compactRelations(Date.now())
  assert.equal(typeof compacted.relationsPruned, 'number')
  assert.equal(typeof compacted.relationsDecayed, 'number')
  store.dispose()
})

// ---------- 14. 建边：自动 + 手动 ----------
section('14. 建边：addFact predicate 边 / co 共现边 / 重复加权 / 别名')

await test('addFact 建边：subject 和 value 都能解析到实体时落一条 predicate 边（0.8）', () => {
  const graph = emptyMemory()
  upsertEntity(graph, '木子', { type: 'person' }, 1000)
  upsertEntity(graph, '团子', { type: 'pet', aliases: ['猫'] }, 1000)
  const added = addFact(graph, { subject: '木子', predicate: '养', value: '团子' }, 2000)
  assert.equal(added.created, true)
  assert.ok(added.relation, '应返回建出的关系边')
  assert.equal(graph.relations.length, 1)
  const relation = graph.relations[0]
  assert.equal(relation.type, '养')
  assert.equal(relation.weight, 0.8)
  assert.equal(relation.from, resolveEntity(graph, '木子').id)
  assert.equal(relation.to, resolveEntity(graph, '团子').id)
  assert.equal(relation.firstSeenAt, 2000)
  addFact(graph, { subject: '木子', predicate: '养', value: '团子' }, 3000)
  assert.equal(graph.relations.length, 1, '同一条边不重复')
  const unresolved = addFact(graph, { subject: '陌生人', predicate: '喜欢', value: '团子' }, 4000)
  assert.equal(unresolved.ok, true)
  assert.equal(unresolved.relation, null, 'subject 解析不到实体就不建边')
  assert.equal(graph.relations.length, 1)
  // 手动建边：名字/别名都能解析，未知实体返回 ok:false
  const manual = upsertRelation(graph, { from: '猫', to: '木子', type: '喜欢', weight: 0.5 }, 5000)
  assert.equal(manual.ok, true)
  assert.equal(manual.created, true)
  assert.equal(manual.relation.from, resolveEntity(graph, '团子').id)
  assert.equal(upsertRelation(graph, { from: '团子', to: '不存在', type: '养' }).ok, false)
})

await test('co 边：事件摘要里的实体两两建边，重复出现 +0.1，上限 1', () => {
  memory.clear()
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.upsertEntity('杭州', { type: 'place' })
  memory.upsertEntity('木子', { type: 'person' })
  const base = Date.now()
  memory.addEvent({ id: 'evt-co-1', at: base - 30000, kind: 'chat', summary: '木子带团子回杭州', topics: [], sessionId: 'qq:co' })
  let graph = memory.store.read()
  const coEdges = listRelations(graph, 10).filter(rel => rel.type === 'co')
  assert.equal(coEdges.length, 3, '三个实体两两三条 co 边')
  const petEdge = coEdges.find(rel => rel.fromName === '团子' && rel.toName === '木子')
  assert.ok(petEdge, '团子 → 木子 应有 co 边')
  assert.equal(petEdge.weight, 0.3, 'co 边从 0.3 起')
  const aliasEdges = relationsForEntity(graph, '猫')
  assert.equal(aliasEdges.length, 2, '别名「猫」应解析到团子的两条边')
  assert.ok(aliasEdges.every(rel => rel.fromName === '团子' || rel.toName === '团子'))

  memory.addEvent({ id: 'evt-co-2', at: base - 20000, kind: 'chat', summary: '团子和木子又聊到杭州', topics: [], sessionId: 'qq:co' })
  graph = memory.store.read()
  const bumped = relationsForEntity(graph, '团子').find(rel => rel.fromName === '木子' || rel.toName === '木子')
  assert.equal(bumped.weight, 0.4, '重复出现 +0.1')

  for (let index = 0; index < 9; index += 1) {
    memory.addEvent({
      id: `evt-co-x${index}`,
      at: base - 10000 + index * 100,
      kind: 'chat',
      summary: '木子团子杭州',
      topics: [],
      sessionId: `qq:co-${index}`,
    })
  }
  graph = memory.store.read()
  const capped = relationsForEntity(graph, '团子')
  assert.ok(capped.every(rel => rel.weight <= 1), 'weight 不应超过 1')
  assert.ok(capped.some(rel => rel.weight === 1), '反复出现应到 1')
})

await test('onUserMessage：同一句话里的实体自动建 co 边（0.3 起）', () => {
  memory.clear()
  memory.onUserMessage({ text: '我养了一只猫叫团子，我住在杭州', at: Date.now(), sessionId: 'qq:co-user' })
  const graph = memory.store.read()
  const co = listRelations(graph, 10).find(rel => rel.type === 'co')
  assert.ok(co, '团子与杭州应建 co 边')
  assert.deepEqual([co.fromName, co.toName].sort(), ['团子', '杭州'].sort())
  assert.equal(co.weight, 0.3)
  assert.ok(graph.facts.some(fact => fact.predicate === '宠物' && fact.value === '团子'))
})

// ---------- 15. 1 跳召回 ----------
section('15. 1 跳召回：context / soul_recall / memory-api / snapshot')

await test('renderMemoryContext：命中实体 → 关系边 → 邻居事实，预算仍 ≤240', () => {
  memory.clear()
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌', confidence: 0.9 })
  const linked = memory.upsertRelation({ from: '团子', to: '木子', type: 'co', weight: 0.6 })
  assert.equal(linked.ok, true)
  // 用别名「猫咪」查：命中团子，但「木子喜欢听歌」不是直接命中，才走 1 跳。
  const context = memory.renderContext(Date.now(), { lastUserText: '猫咪' })
  assert.ok(context.includes('（关联：团子（宠物）→ 木子）'), context)
  assert.ok(context.includes('（顺着关系想起：木子喜欢听歌）'), context)
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET, `预算应 ≤${MEMORY_CONTEXT_BUDGET}，实际 ${lengthOf(context)}`)
})

await test('soul_recall 带 relations / relatedFacts，渲染出关系与关联事实', async () => {
  memory.clear()
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', text: '木子喜欢听歌', confidence: 0.9 })
  memory.upsertRelation({ from: '团子', to: '木子', type: 'co', weight: 0.6 })
  const recallTool = memFake.tools.find(tool => tool.name === 'soul_recall')
  assert.ok(recallTool)
  const recalled = await recallTool.execute({ query: '团子' })
  assert.ok(Array.isArray(recalled.relations))
  assert.equal(recalled.relations.length, 1)
  assert.equal(recalled.relations[0].fromName, '团子')
  assert.equal(recalled.relations[0].toName, '木子')
  assert.equal(recalled.relations[0].weight, 0.6)
  assert.ok(recalled.relatedFacts.some(fact => fact.value === '听歌'))
  const lines = recallTool.output.render({}, recalled)
  const text = lines.map(line => line.text).join('\n')
  assert.ok(text.includes('关系：团子（宠物）→ 木子'), text)
  assert.ok(text.includes('关联事实：木子 · 喜欢 · 听歌'), text)
})

await test('memory-api/state 返回 relations（≤50）与 relationCount；snapshot 也带', async () => {
  memory.clear()
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.upsertEntity('杭州', { type: 'place' })
  memory.upsertRelation({ from: '团子', to: '木子', type: 'co', weight: 0.6 })
  memory.upsertRelation({ from: '木子', to: '杭州', type: '住在', weight: 0.8 })
  const registration = memFake.registrations.find(item => item.path === '/dsh-aura/memory-api')
  assert.ok(registration)
  const response = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  await registration.handler({
    method: 'GET',
    url: '/dsh-aura/memory-api/state?limit=12',
    headers: { host: '127.0.0.1:3080' },
  }, response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(Array.isArray(body.relations), true)
  assert.equal(body.relations.length, 2)
  assert.ok(body.relations.length <= 50)
  assert.ok(body.relations.every(rel => rel.fromName && rel.toName && rel.type))
  assert.equal(body.relationCount, 2)
  assert.ok(body.relations.some(rel => rel.fromName === '木子' && rel.toName === '杭州' && rel.type === '住在'))
  const snap = memory.snapshot()
  assert.equal(Array.isArray(snap.relations), true)
  assert.equal(snap.relationCount, 2)
  assert.ok(snap.relations.some(rel => rel.fromName === '团子' && rel.toName === '木子'))
})

// ---------- 16. 关系整理 / 预算压力 ----------
section('16. compactRelations 衰减清理 / context 预算压力')

await test('compactRelations：清悬空与自环、co 90 天减半、低于 0.15 删除', () => {
  const now = Date.now()
  const day = 86_400_000
  const graph = emptyMemory()
  const a = upsertEntity(graph, '木子', { type: 'person' }, now).entity
  const b = upsertEntity(graph, '团子', { type: 'pet' }, now).entity
  graph.relations = [
    { id: 'r-keep', from: a.id, to: b.id, type: 'co', weight: 0.4, firstSeenAt: now - 200 * day, lastSeenAt: now - 100 * day },
    { id: 'r-drop', from: b.id, to: a.id, type: 'co', weight: 0.2, firstSeenAt: now - 200 * day, lastSeenAt: now - 200 * day },
    { id: 'r-dangling', from: a.id, to: 'gone', type: '养', weight: 0.9, firstSeenAt: now, lastSeenAt: now },
    { id: 'r-self', from: a.id, to: a.id, type: '自己', weight: 0.9, firstSeenAt: now, lastSeenAt: now },
    { id: 'r-fresh', from: a.id, to: b.id, type: '养', weight: 0.8, firstSeenAt: now, lastSeenAt: now },
  ]
  const result = compactRelations(graph, now)
  assert.equal(graph.relations.some(rel => rel.id === 'r-dangling'), false)
  assert.equal(graph.relations.some(rel => rel.id === 'r-self'), false)
  assert.equal(graph.relations.find(rel => rel.id === 'r-keep').weight, 0.2, '90 天没更新的 co 边减半')
  assert.equal(graph.relations.some(rel => rel.id === 'r-drop'), false, '减半后 <0.15 应删除')
  assert.equal(graph.relations.find(rel => rel.id === 'r-fresh').weight, 0.8, '新边不衰减')
  assert.equal(result.relationsDecayed, 2)
  assert.equal(result.relationsPruned, 3)
})

await test('context 预算压力：笔记/事实/关系/事件都多时仍 ≤240，笔记优先', () => {
  memory.clear()
  for (let index = 0; index < 5; index += 1) {
    memory.note('user', `笔记内容${index}-${'很长'.repeat(6)}`, 0.6 + index * 0.05)
  }
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  for (let index = 0; index < 6; index += 1) {
    memory.addFact({ subject: '木子', predicate: `爱好${index}`, value: `兴趣${index}`, text: `木子爱好${index}是兴趣${index}` })
  }
  for (let index = 0; index < 4; index += 1) {
    memory.upsertRelation({ from: '团子', to: '木子', type: `边${index}`, weight: 0.8 })
  }
  for (let index = 0; index < 6; index += 1) {
    memory.addEvent(eventText(index, Date.now() + index * 1000))
  }
  const context = memory.renderContext(Date.now(), { lastUserText: '木子' })
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET, `预算应 ≤${MEMORY_CONTEXT_BUDGET}，实际 ${lengthOf(context)}`)
  assert.ok(context.startsWith('（关于对方/你们，你记得：'), '笔记应最先保留')
  assert.ok(context.includes('（你记得：'), '直接事实次优先')
  assert.ok(memory.snapshot().relationCount >= 4)
})


// ---------- 17. soul_memory 统一记忆工具 ----------
section('17. soul_memory：stats / search / writeNote / updateNote / deleteNote / deleteFact / deleteEntity / mergeEntities / compact')

const memoryTool = () => memFake.tools.find((tool) => tool.name === 'soul_memory')

await test('soul_memory 注册：action 必填、output schema json；stats 返回 counts/lastCompactDayKey/pendingDue', async () => {
  const tool = memoryTool()
  assert.ok(tool, 'installMemory 应注册 soul_memory')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.ok(tool.parameters.required.includes('action'), 'action 必填')
  // 源码里 output.schema 是 { type: 'json' }；defineTool 会归一化成任意 JSON schema。
  assert.equal(typeof tool.output.schema, 'object')
  memory.clear()
  memory.addEvent(eventText(1, Date.now()))
  memory.note('user', '用户叫木子', 0.9, Date.now() - 1000)
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  memory.upsertRelation({ from: '团子', to: '木子', type: 'co', weight: 0.5 })
  const stats = await tool.execute({ action: 'stats' })
  assert.equal(stats.ok, true)
  assert.equal(stats.counts.events, 1)
  assert.ok(stats.counts.notes >= 1)
  assert.equal(stats.counts.facts, 1)
  assert.equal(stats.counts.entities, 2)
  assert.equal(stats.counts.relations, 1)
  assert.equal(stats.lastCompactDayKey, '')
  assert.equal(stats.pendingDue, 1)
  const text = tool.output.render({}, stats).map((line) => line.text).join('\n')
  assert.ok(text.includes('事件 1'), text)
  assert.ok(text.includes('待办 1 条'), text)
  const unknown = await tool.execute({ action: 'nope' })
  assert.equal(unknown.ok, false)
})

await test('soul_memory search：四类各 ≤5，事实跳过 superseded', async () => {
  memory.clear()
  memory.note('user', '用户叫木子', 0.9)
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet' })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '看电影', confidence: 0.9 })
  memory.upsertRelation({ from: '团子', to: '木子', type: 'co', weight: 0.6 })
  const found = await memoryTool().execute({ action: 'search', query: '木子' })
  assert.equal(found.ok, true)
  assert.ok(found.notes.some((note) => note.text.includes('木子')))
  assert.ok(found.facts.some((fact) => fact.value === '看电影'))
  assert.equal(found.facts.some((fact) => fact.value === '听歌'), false, 'superseded 不应出现')
  assert.ok(found.entities.some((entity) => entity.name === '木子'))
  assert.ok(found.relations.some((relation) => relation.fromName === '团子' || relation.toName === '团子'))
  for (const key of ['notes', 'facts', 'entities', 'relations']) {
    assert.ok(found[key].length <= 5, `${key} 最多 5 条`)
  }
  const recent = await memoryTool().execute({ action: 'search' })
  assert.equal(recent.ok, true)
  assert.ok(recent.entities.length >= 1, '空 query 返回最近的实体')
})

await test('soul_memory writeNote：生成稳定 id、写前备份、超长按笔记上限截断', async () => {
  memory.clear()
  const written = await memoryTool().execute({
    action: 'writeNote', category: 'us', text: '你答应周末陪我看电影', importance: 0.9,
  })
  assert.equal(written.ok, true)
  assert.ok(written.note && written.note.id, '应生成 id')
  assert.equal(written.note.category, 'us')
  const disk = memory.store.read()
  const saved = disk.notes.us.find((note) => note.id === written.note.id)
  assert.ok(saved, '磁盘笔记应带同一个 id')
  assert.equal(saved.text, '你答应周末陪我看电影')
  const long = await memoryTool().execute({ action: 'writeNote', category: 'self', text: '长'.repeat(220) })
  assert.equal(long.ok, true)
  assert.ok(lengthOf(long.note.text) <= NOTE_MAX_CHARS)
  const empty = await memoryTool().execute({ action: 'writeNote', text: '   ' })
  assert.equal(empty.ok, false)
  const backupIds = existsSync(join(dataDir, 'backups'))
    ? readdirSync(join(dataDir, 'backups')).filter((id) => id.endsWith('-memory'))
    : []
  assert.ok(backupIds.length >= 1, '写笔记前应做 memory 备份')
  const manifest = JSON.parse(readFileSync(join(dataDir, 'backups', backupIds.at(-1), 'manifest.json'), 'utf8'))
  assert.equal(manifest.label, 'memory')
  assert.ok(manifest.files.some((file) => file.name === 'memory.json'))
})

await test('soul_memory updateNote：按 id / 旧文本定位；deleteNote 按 id / 文本并清 pendingDue', async () => {
  memory.clear()
  const made = await memoryTool().execute({
    action: 'writeNote', category: 'user', text: '用户住在杭州', importance: 0.5,
  })
  const updated = await memoryTool().execute({
    action: 'updateNote', id: made.note.id, text: '用户住在上海', importance: 0.95,
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.id, made.note.id)
  assert.ok(updated.updated.includes('text') && updated.updated.includes('importance'))
  let disk = memory.store.read()
  let note = disk.notes.user.find((item) => item.id === made.note.id)
  assert.equal(note.text, '用户住在上海')
  assert.equal(note.importance, 0.95)
  assert.equal(note.createdAt, made.note.createdAt, 'createdAt 不应被改')
  const byText = await memoryTool().execute({ action: 'updateNote', oldText: '用户住在上海', importance: 0.7 })
  assert.equal(byText.ok, true)
  assert.equal(byText.id, made.note.id)
  assert.equal((await memoryTool().execute({ action: 'updateNote', id: made.note.id })).ok, false)
  assert.equal((await memoryTool().execute({ action: 'updateNote', text: '没有定位' })).ok, false)

  const deleted = await memoryTool().execute({ action: 'deleteNote', id: made.note.id })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.id, made.note.id)
  disk = memory.store.read()
  assert.equal(disk.notes.user.some((item) => item.id === made.note.id), false)

  memory.note('us', '提醒你面试', 0.7, Date.now() - 1000)
  assert.equal(memory.store.read().reflection.pendingDue.length, 1)
  const byTextDeleted = await memoryTool().execute({ action: 'deleteNote', text: '提醒你面试' })
  assert.equal(byTextDeleted.ok, true)
  assert.equal(byTextDeleted.dueRemoved, 1)
  assert.equal(memory.store.read().reflection.pendingDue.length, 0)
  assert.equal((await memoryTool().execute({ action: 'deleteNote', text: '不存在的笔记' })).ok, false)
})

await test('旧笔记补 id：读取时写回，二次读取 id 不变', () => {
  const dir = join(root, 'store-note-id')
  mkdirSync(dir, { recursive: true })
  const store = createMemoryStore({ home: dir, log: () => {} })
  writeFileSync(store.file, JSON.stringify({
    version: 2,
    events: [],
    notes: { user: [{ text: '旧笔记没有 id' }], us: [], self: [] },
    topics: {},
    facts: [],
    entities: [],
    relations: [],
    reflection: { lastCompactDayKey: '' },
  }), 'utf8')
  const first = store.read()
  const id = first.notes.user[0].id
  assert.ok(id, '迁移时旧笔记应补 id')
  const second = store.read()
  assert.equal(second.notes.user[0].id, id, '第一次读取应把 id 写回磁盘')
  const disk = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(disk.notes.user[0].id, id)
  store.dispose()
})

await test('soul_memory deleteFact / deleteEntity：事实删除；实体删除同时清关系但保留事实文本', async () => {
  memory.clear()
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  const factId = memory.store.read().facts[0].id
  const deletedFact = await memoryTool().execute({ action: 'deleteFact', id: factId })
  assert.equal(deletedFact.ok, true)
  assert.equal(deletedFact.deleted, true)
  assert.equal(memory.store.read().facts.length, 0)
  assert.equal((await memoryTool().execute({ action: 'deleteFact', id: factId })).ok, false)

  memory.clear()
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet' })
  memory.addFact({ subject: '木子', predicate: '养', value: '团子', confidence: 0.9 })
  const entityId = memory.store.read().entities.find((entity) => entity.name === '团子').id
  assert.ok(memory.store.read().relations.length >= 1)
  const deletedEntity = await memoryTool().execute({ action: 'deleteEntity', id: entityId })
  assert.equal(deletedEntity.ok, true)
  assert.equal(deletedEntity.removedRelations, 1)
  const disk = memory.store.read()
  assert.equal(disk.entities.some((entity) => entity.id === entityId), false)
  assert.equal(disk.relations.length, 0, '相关关系边应一起清掉')
  assert.ok(disk.facts.some((fact) => fact.subject === '木子' && fact.value === '团子'), '事实文本保守保留')
})

await test('soul_memory mergeEntities：事实文本替换、关系重定向去重、别名合并、删除 from', async () => {
  memory.clear()
  memory.upsertEntity('木子', { type: 'person' })
  memory.upsertEntity('团子', { type: 'pet', aliases: ['猫'] })
  memory.upsertEntity('咪咪', { type: 'pet', aliases: ['猫猫'] })
  memory.addFact({ subject: '木子', predicate: '养', value: '团子', confidence: 0.9 })
  memory.addFact({ subject: '团子', predicate: '喜欢', value: '咪咪', confidence: 0.8 })
  memory.upsertRelation({ from: '木子', to: '团子', type: '陪', weight: 0.6 })
  const before = memory.store.read()
  const from = before.entities.find((entity) => entity.name === '团子')
  const to = before.entities.find((entity) => entity.name === '咪咪')
  const merged = await memoryTool().execute({ action: 'mergeEntities', fromId: from.id, toId: to.id })
  assert.equal(merged.ok, true)
  assert.ok(merged.factsUpdated >= 2)
  const disk = memory.store.read()
  assert.equal(disk.entities.some((entity) => entity.id === from.id), false)
  const target = disk.entities.find((entity) => entity.id === to.id)
  assert.ok(target.aliases.includes('团子') && target.aliases.includes('猫'), '名字/别名应并进目标')
  assert.ok(disk.facts.every((fact) => fact.subject !== '团子' && fact.value !== '团子'))
  assert.ok(disk.facts.some((fact) => fact.subject === '木子' && fact.value === '咪咪'))
  assert.equal(disk.relations.some((relation) => relation.from === relation.to), false, '合并后的自环应清掉')
  assert.ok(disk.relations.some((relation) => (
    relation.from === resolveEntity(disk, '木子').id && relation.to === to.id
  )), '木子→团子 应重定向成 木子→咪咪')
  assert.equal(disk.relations.some((relation) => relation.from === from.id || relation.to === from.id), false)
})

await test('mergeEntities 纯函数：同向重复边合并权重、co 反向合并、自环丢弃', () => {
  const draft = emptyMemory()
  const a = upsertEntity(draft, '甲', { type: 'person' }, 1000).entity
  const b = upsertEntity(draft, '乙', { type: 'person' }, 1000).entity
  const c = upsertEntity(draft, '丙', { type: 'person' }, 1000).entity
  draft.relations = [
    { id: 'r1', from: a.id, to: b.id, type: 'co', weight: 0.3, firstSeenAt: 1, lastSeenAt: 2 },
    { id: 'r2', from: b.id, to: a.id, type: 'co', weight: 0.5, firstSeenAt: 1, lastSeenAt: 3 },
    { id: 'r3', from: a.id, to: b.id, type: '养', weight: 0.4, firstSeenAt: 1, lastSeenAt: 2 },
    { id: 'r4', from: c.id, to: b.id, type: '养', weight: 0.6, firstSeenAt: 1, lastSeenAt: 4 },
    { id: 'r5', from: a.id, to: c.id, type: '养', weight: 0.7, firstSeenAt: 1, lastSeenAt: 5 },
  ]
  const result = storeMod.mergeEntities(draft, b.id, c.id, 10)
  assert.equal(result.ok, true)
  assert.equal(draft.entities.some((entity) => entity.id === b.id), false)
  const co = draft.relations.filter((relation) => relation.type === 'co')
  assert.equal(co.length, 1, 'co 反向重复应合并成一条')
  assert.equal(co[0].weight, 0.5, '权重取较大值')
  const feed = draft.relations.filter((relation) => relation.type === '养')
  assert.equal(feed.length, 1, '同向重复的 predicate 边应去重')
  assert.equal(feed[0].weight, 0.7)
  assert.equal(result.relationsDropped, 1, 'c→b 合并后自环应丢弃')
  assert.equal(draft.relations.some((relation) => relation.from === relation.to), false)
})

await test('soul_memory compact：force 立即整理，返回 before/after', async () => {
  memory.clear()
  for (let index = 1; index <= 12; index += 1) {
    memory.addEvent(eventText(index, Date.now() + index * 1000))
  }
  const before = memory.snapshot()
  const result = await memoryTool().execute({ action: 'compact' })
  assert.equal(result.ok, true)
  assert.equal(result.before.events, 12)
  assert.equal(result.after.events, 2, 'force 应压实最旧 10 条事件')
  assert.ok(result.after.notes >= result.before.notes)
  assert.equal(result.result.compacted, 10)
  assert.equal(memory.snapshot().lastCompactDayKey, diaryMod.localDayKey(Date.now()))
  const again = await memoryTool().execute({ action: 'compact' })
  assert.equal(again.ok, true, '同一天 force 仍可再整理')
  assert.equal(again.before.events, 2)
})

// ---------- 18. memory-api POST / 配置 / 自动整理开关 ----------
section('18. memory-api POST：compact / deleteFact / deleteNote / deleteEntity；memoryAutoCompact；配置夹取')

function httpResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

async function postMemory(body, headers = { host: '127.0.0.1:3080' }) {
  const registration = memFake.registrations.find((item) => item.path === '/dsh-aura/memory-api')
  assert.ok(registration, '应注册 /dsh-aura/memory-api')
  const response = httpResponse()
  await registration.handler({
    method: 'POST',
    url: '/dsh-aura/memory-api',
    headers,
    body: JSON.stringify(body),
  }, response)
  return response
}

await test('memory-api POST compact：200 + before/after 统计 + lastCompactDayKey', async () => {
  memory.clear()
  for (let index = 1; index <= 12; index += 1) {
    memory.addEvent(eventText(index, Date.now() + index * 1000))
  }
  const response = await postMemory({ action: 'compact' })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.action, 'compact')
  assert.equal(body.before.events, 12)
  assert.equal(body.after.events, 2)
  assert.equal(typeof body.before.notes, 'number')
  assert.equal(memory.snapshot().lastCompactDayKey, diaryMod.localDayKey(Date.now()))
})

await test('memory-api POST deleteFact/deleteNote/deleteEntity；缺 id 404/400；跨站 403', async () => {
  memory.clear()
  memory.note('user', '用户叫木子', 0.9)
  memory.addFact({ subject: '木子', predicate: '喜欢', value: '听歌', confidence: 0.9 })
  memory.upsertEntity('团子', { type: 'pet' })
  const noteId = memory.store.read().notes.user[0].id
  const factId = memory.store.read().facts[0].id
  const entityId = memory.store.read().entities[0].id

  let response = await postMemory({ action: 'deleteFact', id: factId })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).deleted, true)
  assert.equal(memory.store.read().facts.length, 0)

  response = await postMemory({ action: 'deleteNote', id: noteId })
  assert.equal(response.status, 200)
  assert.equal(memory.store.read().notes.user.some((note) => note.id === noteId), false)

  response = await postMemory({ action: 'deleteEntity', id: entityId })
  assert.equal(response.status, 200)
  assert.equal(memory.store.read().entities.length, 0)

  response = await postMemory({ action: 'deleteFact', id: 'missing' })
  assert.equal(response.status, 404)
  response = await postMemory({ action: 'deleteFact' })
  assert.equal(response.status, 400)
  response = await postMemory({ action: 'what' })
  assert.equal(response.status, 400)
  response = await postMemory({ action: 'compact' }, { host: 'example.com' })
  assert.equal(response.status, 403)
})

await test('memoryAutoCompact=false：onTurnEnd 不自动整理；打开后当天自动整理一次', () => {
  state.writeConfig({ memoryAutoCompact: false, memoryReflectionEvery: 50 })
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({ text: '今天天气不错', at: base, sessionId: 'qq:auto-off' })
  memory.onAssistantMessage({ text: '适合散步', at: base + 1000, sessionId: 'qq:auto-off' })
  memory.onTurnEnd({ at: base + 2000, sessionId: 'qq:auto-off', reason: 'complete' })
  assert.equal(memory.snapshot().lastCompactDayKey, '', '关闭自动整理时不应写 lastCompactDayKey')

  state.writeConfig({ memoryAutoCompact: true })
  const next = base + 60_000
  memory.onUserMessage({ text: '晚上吃点好的', at: next, sessionId: 'qq:auto-on' })
  memory.onAssistantMessage({ text: '好呀', at: next + 1000, sessionId: 'qq:auto-on' })
  memory.onTurnEnd({ at: next + 2000, sessionId: 'qq:auto-on', reason: 'complete' })
  assert.equal(memory.snapshot().lastCompactDayKey, diaryMod.localDayKey(Date.now()), '打开后当天应自动整理')
  state.writeConfig({ memoryAutoCompact: true, memoryReflectionEvery: 3 })
})

await test('配置范围：memoryEnabled/memoryAutoCompact 持久化；events 5-120、notes 5-200、recall 1-3、reflection 1-50', () => {
  state.writeConfig({
    memoryEnabled: false,
    memoryAutoCompact: false,
    memoryMaxEvents: 999,
    memoryMaxNotes: 1,
    memoryRecallLimit: 9,
    memoryReflectionEvery: 100,
  })
  const config = state.readConfig()
  assert.equal(config.memoryEnabled, false)
  assert.equal(config.memoryAutoCompact, false)
  assert.equal(config.memoryMaxEvents, 120)
  assert.equal(config.memoryMaxNotes, 5)
  assert.equal(config.memoryRecallLimit, 3)
  assert.equal(config.memoryReflectionEvery, 50)
  state.writeConfig({
    memoryEnabled: true,
    memoryAutoCompact: true,
    memoryMaxEvents: 40,
    memoryMaxNotes: 20,
    memoryRecallLimit: 3,
    memoryReflectionEvery: 3,
  })
})


// ---------- 19. 立即记忆 ----------
section('19. 立即记忆：约定 / 重要事实 / 开关 / 24h 去重')

await test('约定关键词：立即写 us 笔记（≤120、0.9）+ 约定事实 0.9', () => {
  state.writeConfig({ memoryImmediate: true, memoryReflectionEvery: 50 })
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({ text: '说好周末一起看电影', at: base, sessionId: 'qq:immediate' })
  let disk = memory.store.read()
  const note = disk.notes.us.find((item) => item.kind === 'promise')
  assert.ok(note, '应先写一条 promise 笔记')
  assert.equal(note.importance, 0.9)
  assert.ok(lengthOf(note.text) <= 120)
  assert.ok(note.text.includes('周末一起看电影'), note.text)
  const fact = disk.facts.find((item) => item.predicate === '约定')
  assert.ok(fact, '应有约定事实')
  assert.equal(fact.confidence, 0.9)
  assert.equal(fact.source, 'user')
  for (const [index, text] of ['别忘了带伞', '我答应你早点睡', '约定好了周末爬山', '说定了别迟到'].entries()) {
    memory.onUserMessage({ text, at: base + 1000 + index, sessionId: 'qq:immediate' })
  }
  disk = memory.store.read()
  assert.ok(disk.notes.us.filter((item) => item.kind === 'promise').length >= 4)
  assert.ok(disk.facts.filter((item) => item.predicate === '约定').length >= 4)
})

await test('名字/生日/住址/宠物/好恶：额外写 user 笔记（0.8，简短）', () => {
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({
    text: '我叫木子，我生日是5月3日，我住在杭州，我养了一只猫叫团子，我喜欢听歌',
    at: base,
    sessionId: 'qq:important',
  })
  const disk = memory.store.read()
  const notes = disk.notes.user.filter((item) => item.kind === 'immediate')
  assert.ok(notes.length >= 5, `重要事实应各写一条笔记，实际 ${notes.length}`)
  assert.ok(notes.every((item) => item.importance === 0.8))
  assert.ok(notes.every((item) => lengthOf(item.text) <= 80))
  for (const predicate of ['称呼', '生日', '居住地', '宠物', '喜欢']) {
    assert.ok(disk.facts.some((item) => item.predicate === predicate), `应有 ${predicate} 事实`)
  }
  assert.ok(notes.some((item) => item.text.includes('木子')))
  assert.ok(notes.some((item) => item.text.includes('杭州')))
})

await test('24h 去重：同文本 / 同事实不重复写；普通寒暄不写', () => {
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({ text: '记住给我带伞', at: base, sessionId: 'qq:dedup' })
  const first = memory.store.read()
  const noteCount = first.notes.us.length
  const factCount = first.facts.length
  memory.onUserMessage({ text: '记住给我带伞', at: base + 60_000, sessionId: 'qq:dedup' })
  const second = memory.store.read()
  assert.equal(second.notes.us.length, noteCount, '24h 内同一文本不重复写笔记')
  assert.equal(second.facts.filter((item) => !item.supersededBy).length, factCount, '24h 内同一事实不重复写')
  memory.onUserMessage({ text: '今天天气不错', at: base + 120_000, sessionId: 'qq:dedup' })
  const third = memory.store.read()
  assert.equal(third.notes.us.length, noteCount)
  assert.equal(third.notes.user.length, 0)
})

await test('memoryImmediate=false：新增笔记与约定笔记跳过，已有规则事实保持', () => {
  state.writeConfig({ memoryImmediate: false })
  memory.clear()
  const base = Date.now()
  memory.onUserMessage({ text: '记住带伞，我叫木子，我养了一只猫叫团子', at: base, sessionId: 'qq:immediate-off' })
  const disk = memory.store.read()
  assert.equal(disk.notes.us.length, 0, '关闭立即记忆后不写约定笔记')
  assert.equal(disk.notes.user.length, 0, '关闭立即记忆后不写重要事实笔记')
  assert.ok(disk.facts.some((item) => item.predicate === '约定'), '规则事实抽取保持')
  assert.ok(disk.facts.some((item) => item.predicate === '宠物'))
  assert.ok(disk.facts.some((item) => item.predicate === '称呼'))
  state.writeConfig({ memoryImmediate: true })
})

// ---------- 20. 会话整理 ----------
section('20. 会话整理：手动 / 定时器 / 窗口 / 每日上限 / 空闲触发 / 落盘 / API')

function makeFakeTimers() {
  const list = []
  return {
    list,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false }
      list.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true
    },
  }
}

const fakeTimers = makeFakeTimers()
const memFake2 = makeFakeCtx()
const memory2 = installMemory({ ctx: memFake2.ctx, state, soul, log: () => {}, timers: fakeTimers })
const settle = (ms = 140) => new Promise((resolve) => setTimeout(resolve, ms))
const memoryTool2 = () => memFake2.tools.find((tool) => tool.name === 'soul_memory')
/** 每次定时器断言前清空观察列表（memory2 内部仍持有旧 timer，互不影响）。 */
const resetFakeTimers = () => {
  fakeTimers.list.length = 0
}

await test('soul_memory digest：窗口内事件/事实 → us 摘要（≤200、0.7），digests + reflection 落盘', async () => {
  state.writeConfig({
    memorySessionDigest: true,
    memoryDigestIdleMinutes: 60,
    memoryDigestDailyCap: 2,
    memoryMaxNotes: 20,
    memoryReflectionEvery: 50,
    memoryAutoCompact: false,
    memoryImmediate: true,
  })
  memory2.clear()
  const base = Date.now()
  memory2.onUserMessage({ text: '我明天要面试，对了说好周末一起看电影', at: base, sessionId: 'qq:digest' })
  memory2.onAssistantMessage({ text: '加油', at: base + 500, sessionId: 'qq:digest' })
  memory2.onTurnEnd({ at: base + 500, sessionId: 'qq:digest' })
  const backupDir = join(dataDir, 'backups')
  // 保留上限 30 会淘汰最旧的一份，所以按「新出现的 id」判断，而不是数量。
  const memoryBackupIds = () => (existsSync(backupDir)
    ? readdirSync(backupDir).filter((id) => id.endsWith('-memory')).sort()
    : [])
  const backupsBefore = new Set(memoryBackupIds())
  const result = await memoryTool2().execute({ action: 'digest', sessionId: 'qq:digest' })
  const freshBackups = memoryBackupIds().filter((id) => !backupsBefore.has(id))
  assert.ok(freshBackups.length > 0, '整理写盘前应 backup.snapshot(\'memory\')')
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'qq:digest')
  assert.ok(result.note && result.note.text, '应生成摘要笔记')
  assert.equal(result.note.kind, 'digest')
  assert.equal(result.note.importance, 0.7)
  assert.ok(lengthOf(result.note.text) <= memoryMod.DIGEST_NOTE_MAX)
  assert.ok(result.note.text.startsWith('聊到：'), result.note.text)
  assert.ok(result.note.text.includes('约定：'), result.note.text)
  assert.ok(result.window.events >= 1)
  assert.ok(result.window.facts >= 1)
  assert.ok(Array.isArray(result.facts))
  assert.ok(result.facts.some((fact) => fact.predicate === '约定'))
  const disk = memory2.store.read()
  assert.ok(disk.notes.us.some((note) => note.kind === 'digest' && note.text === result.note.text))
  const digest = disk.digests['qq:digest']
  assert.ok(digest, 'digests 应记录该会话')
  assert.equal(typeof digest.lastAt, 'number')
  assert.equal(typeof digest.lastEventAt, 'number')
  assert.equal(digest.turns, 1, '窗口内 1 条事件应计入 turns')
  assert.equal(disk.reflection.lastDigestDayKey, diaryMod.localDayKey(Date.now()))
  assert.equal(disk.reflection.digestCount, 1)
  const raw = JSON.parse(readFileSync(memory2.store.file, 'utf8'))
  assert.ok(raw.digests['qq:digest'], 'digests 应落盘')
  assert.ok('lastAt' in raw.digests['qq:digest'])
  assert.ok('lastEventAt' in raw.digests['qq:digest'])
  assert.ok('turns' in raw.digests['qq:digest'])
  const text = memoryTool2().output.render({}, result).map((line) => line.text).join('\n')
  assert.ok(text.includes('会话整理完成'), text)
  assert.ok(text.includes('聊到：'), text)
})

await test('digest 窗口：第二次只整理上次之后的新事件/新事实', async () => {
  const empty = await memoryTool2().execute({ action: 'digest', sessionId: 'qq:digest' })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'empty')
  const base = Date.now()
  memory2.onUserMessage({ text: '我最近在忙长期记忆项目', at: base, sessionId: 'qq:digest' })
  memory2.onAssistantMessage({ text: '听起来挺费脑', at: base + 200, sessionId: 'qq:digest' })
  memory2.onTurnEnd({ at: base + 200, sessionId: 'qq:digest' })
  await settle(30)
  const result = await memoryTool2().execute({ action: 'digest', sessionId: 'qq:digest' })
  assert.equal(result.ok, true)
  assert.equal(result.window.events, 1, '窗口只含上次 digest 之后的事件')
  assert.ok(result.window.facts >= 1)
  assert.ok(result.note.text.includes('长期记忆项目') || result.note.text.includes('新增：'), result.note.text)
  assert.equal(result.note.text.includes('周末一起看电影'), false, '旧窗口的约定不应再出现')
  assert.equal(memory2.store.read().digests['qq:digest'].turns, 2)
})

await test('每日上限：自动整理受 memoryDigestDailyCap 限制，手动仍可整理', async () => {
  state.writeConfig({ memorySessionDigest: true, memoryDigestDailyCap: 1, memoryDigestIdleMinutes: 60, memoryReflectionEvery: 50 })
  memory2.clear()
  const base = Date.now()
  memory2.onUserMessage({ text: '今天加班到很晚', at: base, sessionId: 'qq:cap' })
  memory2.onAssistantMessage({ text: '早点睡', at: base + 100, sessionId: 'qq:cap' })
  memory2.onTurnEnd({ at: base + 100, sessionId: 'qq:cap' })
  const first = await memory2.digest({ sessionId: 'qq:cap', manual: false, now: Date.now() })
  assert.equal(first.ok, true)
  assert.equal(memory2.store.read().reflection.digestCount, 1)
  const t2 = Date.now()
  memory2.onUserMessage({ text: '面试通过了', at: t2, sessionId: 'qq:cap' })
  memory2.onAssistantMessage({ text: '恭喜', at: t2 + 100, sessionId: 'qq:cap' })
  memory2.onTurnEnd({ at: t2 + 100, sessionId: 'qq:cap' })
  const second = await memory2.digest({ sessionId: 'qq:cap', manual: false, now: t2 + 500 })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'daily-cap')
  assert.equal(second.cap, 1)
  assert.equal(memory2.store.read().reflection.digestCount, 1, '超上限的自动整理不计数')
  const manual = await memory2.digest({ sessionId: 'qq:cap', manual: true, now: t2 + 1000 })
  assert.equal(manual.ok, true, '手动整理不受每日上限限制')
  assert.equal(memory2.store.read().reflection.digestCount, 2)
  state.writeConfig({ memoryDigestDailyCap: 2 })
})

await test('定时器：turnEnd 排空闲定时器，新消息取消，下一次 turnEnd 重排；触发后写摘要', async () => {
  state.writeConfig({
    memorySessionDigest: true,
    memoryDigestIdleMinutes: 60,
    memoryDigestDailyCap: 5,
    memoryReflectionEvery: 50,
    memoryAutoCompact: false,
  })
  memory2.clear()
  resetFakeTimers()
  const base = Date.now()
  memory2.onUserMessage({ text: '今天加班到很晚', at: base - 3000, sessionId: 'qq:timer' })
  memory2.onAssistantMessage({ text: '早点睡', at: base - 2000, sessionId: 'qq:timer' })
  memory2.onTurnEnd({ at: base - 2000, sessionId: 'qq:timer' })
  const first = fakeTimers.list.filter((timer) => !timer.cleared)
  assert.equal(first.length, 1, 'turnEnd 应排一个定时器')
  assert.equal(first[0].ms, 60 * 60 * 1000)
  // 新消息取消
  memory2.onUserMessage({ text: '晚安', at: base, sessionId: 'qq:timer' })
  assert.equal(first[0].cleared, true, '新消息应取消待触发的整理')
  memory2.onAssistantMessage({ text: '晚安', at: base + 100, sessionId: 'qq:timer' })
  memory2.onTurnEnd({ at: base + 100, sessionId: 'qq:timer' })
  const next = fakeTimers.list.filter((timer) => !timer.cleared)
  assert.equal(next.length, 1, '下一次 turnEnd 应重排')
  next[0].fn()
  await settle()
  const disk = memory2.store.read()
  const note = disk.notes.us.find((item) => item.kind === 'digest')
  assert.ok(note, '定时器触发后应写摘要笔记')
  assert.ok(note.text.includes('加班'), note.text)
  assert.ok(disk.digests['qq:timer'])
})

await test('空闲触发：下次 onUserMessage 距 lastEventAt ≥ idleMinutes 时先补整理（伪时间）', async () => {
  state.writeConfig({ memorySessionDigest: true, memoryDigestIdleMinutes: 60, memoryDigestDailyCap: 5 })
  memory2.clear()
  const base = Date.now()
  memory2.store.update((memory) => {
    memory.events.push({
      id: 'evt-idle-old',
      at: base - 3 * 3600_000,
      kind: 'chat',
      summary: '聊到加班和面试',
      salience: 0.3,
      topics: ['加班'],
      source: 'rule',
      sessionId: 'qq:idle',
    })
    memory.digests['qq:idle'] = {
      lastAt: base - 4 * 3600_000,
      lastEventAt: base - 2 * 3600_000,
      turns: 0,
    }
    return memory
  })
  memory2.onUserMessage({ text: '我回来了', at: base, sessionId: 'qq:idle' })
  await settle()
  const disk = memory2.store.read()
  const note = disk.notes.us.find((item) => item.kind === 'digest')
  assert.ok(note, '空闲后应先补一次整理')
  assert.ok(note.text.includes('加班'), note.text)
  assert.ok(disk.digests['qq:idle'].lastAt > base - 4 * 3600_000, '整理后 lastAt 应前进')
})

await test('memorySessionDigest=false：不自动整理（不排定时器），手动仍可用', async () => {
  state.writeConfig({ memorySessionDigest: false, memoryDigestIdleMinutes: 60, memoryReflectionEvery: 50, memoryAutoCompact: false })
  memory2.clear()
  resetFakeTimers()
  const base = Date.now()
  memory2.onUserMessage({ text: '最近在学画画', at: base, sessionId: 'qq:off' })
  memory2.onAssistantMessage({ text: '挺好的', at: base + 100, sessionId: 'qq:off' })
  memory2.onTurnEnd({ at: base + 100, sessionId: 'qq:off' })
  assert.equal(fakeTimers.list.filter((timer) => !timer.cleared).length, 0, '关闭后不应排定时器')
  const auto = await memory2.digest({ sessionId: 'qq:off', manual: false })
  assert.equal(auto.ok, false)
  assert.equal(auto.reason, 'disabled')
  const manual = await memory2.digest({ sessionId: 'qq:off', manual: true })
  assert.equal(manual.ok, true, '手动整理仍可用')
  assert.ok(manual.note.text.includes('画画'), manual.note.text)
  state.writeConfig({ memorySessionDigest: true })
})

await test('memory-api POST digest：缺省 sessionId 取最近活动会话，返回 note/facts/window', async () => {
  memory2.clear()
  const base = Date.now()
  memory2.onUserMessage({ text: '我在学做菜', at: base, sessionId: 'qq:api-digest' })
  memory2.onAssistantMessage({ text: '下次做给我看', at: base + 100, sessionId: 'qq:api-digest' })
  memory2.onTurnEnd({ at: base + 100, sessionId: 'qq:api-digest' })
  const registration = memFake2.registrations.find((item) => item.path === '/dsh-aura/memory-api')
  assert.ok(registration)
  const response = httpResponse()
  await registration.handler({
    method: 'POST',
    url: '/dsh-aura/memory-api',
    headers: { host: '127.0.0.1:3080' },
    body: JSON.stringify({ action: 'digest' }),
  }, response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.action, 'digest')
  assert.equal(body.sessionId, 'qq:api-digest')
  assert.ok(body.note && body.note.text)
  assert.ok(Array.isArray(body.facts))
  assert.ok(body.window && typeof body.window.events === 'number')
  assert.equal(body.window.events, 1)
})

await test('soul_memory digest：没有会话时返回 no-session，且不写盘', async () => {
  memory2.clear()
  const result = await memoryTool2().execute({ action: 'digest' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-session')
  assert.equal(memory2.store.read().notes.us.length, 0)
})

// ---------- 21. 配置 ----------
section('21. 配置：立即记忆 / 会话整理默认值、范围与持久化')

await test('默认值与范围：memoryImmediate / memorySessionDigest / idle 60-1440 / cap 1-5', () => {
  const defaults = state.DEFAULT_CONFIG
  assert.equal(defaults.memoryImmediate, true)
  assert.equal(defaults.memorySessionDigest, true)
  assert.equal(defaults.memoryDigestIdleMinutes, 360)
  assert.equal(defaults.memoryDigestDailyCap, 2)
  state.writeConfig({
    memoryImmediate: false,
    memorySessionDigest: false,
    memoryDigestIdleMinutes: 10,
    memoryDigestDailyCap: 9,
  })
  let config = state.readConfig()
  assert.equal(config.memoryImmediate, false)
  assert.equal(config.memorySessionDigest, false)
  assert.equal(config.memoryDigestIdleMinutes, 60, '低于下限夹到 60')
  assert.equal(config.memoryDigestDailyCap, 5, '高于上限夹到 5')
  state.writeConfig({
    memoryImmediate: true,
    memorySessionDigest: true,
    memoryDigestIdleMinutes: 9999,
    memoryDigestDailyCap: 0,
  })
  config = state.readConfig()
  assert.equal(config.memoryImmediate, true)
  assert.equal(config.memorySessionDigest, true)
  assert.equal(config.memoryDigestIdleMinutes, 1440, '高于上限夹到 1440')
  assert.equal(config.memoryDigestDailyCap, 1, '低于下限夹到 1')
  const normalized = state.normalizeConfig({ memoryDigestIdleMinutes: 'abc', memoryDigestDailyCap: '3' })
  assert.equal(normalized.memoryDigestIdleMinutes, 360)
  assert.equal(normalized.memoryDigestDailyCap, 3)
  state.writeConfig({
    memoryImmediate: true,
    memorySessionDigest: true,
    memoryDigestIdleMinutes: 360,
    memoryDigestDailyCap: 2,
  })
})


// ---------- 22. 工具合并：soul_note / soul_fact 并入 soul_memory ----------
section('22. 工具合并：注册集合不含 soul_note / soul_fact，提示词无旧名字')

await test('工具名集合：只有 soul_memory / soul_recall，没有 soul_note / soul_fact', () => {
  const names = new Set([...memFake.tools, ...memFake2.tools].map((tool) => tool.name))
  assert.equal(names.has('soul_note'), false, '不再注册 soul_note')
  assert.equal(names.has('soul_fact'), false, '不再注册 soul_fact')
  assert.equal(names.has('soul_memory'), true, '应注册 soul_memory')
  assert.equal(names.has('soul_recall'), true, '应注册 soul_recall')
  assert.equal(memFake.tools.filter((tool) => tool.name === 'soul_memory').length, 1, 'soul_memory 只注册一次')
  assert.equal(memFake.tools.filter((tool) => tool.name === 'soul_recall').length, 1, 'soul_recall 只注册一次')
})

await test('soul_memory 参数覆盖 addFact / forgetFact / writeNote', () => {
  const tool = memoryTool()
  assert.ok(tool)
  const props = tool.parameters.properties
  for (const key of [
    'action', 'sessionId', 'query', 'category', 'text', 'oldText', 'importance',
    'dueAt', 'subject', 'predicate', 'value', 'confidence', 'source', 'id', 'fromId', 'toId', 'limit',
  ]) {
    assert.ok(props[key], 'soul_memory 应有参数 ' + key)
  }
  const actionText = String(props.action.description)
  for (const name of ['writeNote', 'addFact', 'forgetFact', 'deleteFact', 'digest', 'mergeEntities', 'compact']) {
    assert.ok(actionText.includes(name), 'action 说明应含 ' + name)
  }
  for (const name of ['writeNote', 'addFact', 'forgetFact', 'digest']) {
    assert.ok(tool.description.includes(name), '工具描述应含 ' + name)
  }
})

await test('提示词 / 描述里不再出现 soul_note / soul_fact', () => {
  const contexts = [...memFake.contexts, ...memFake2.contexts, ...soulFake.contexts]
  const tools = [...memFake.tools, ...memFake2.tools, ...soulFake.tools]
  assert.ok(tools.length > 0)
  for (const tool of tools) {
    const text = String(tool.name || '') + ' ' + String(tool.description || '')
    assert.equal(/soul_note|soul_fact/.test(text), false, tool.name + ' 的描述不该提旧工具名')
  }
  for (const spec of contexts) {
    let text = ''
    try {
      text = typeof spec.text === 'function' ? String(spec.text({ agent: { session: {} } }) || '') : String(spec.text || '')
    } catch {
      text = ''
    }
    assert.equal(/soul_note|soul_fact/.test(text), false, 'context ' + String(spec.name) + ' 不该提旧工具名')
  }
})

await test('源码里不再出现 soul_note / soul_fact（提示词、注释一起清掉）', () => {
  const hostDir = join(pluginRoot, 'host')
  const files = readdirSync(hostDir).filter((name) => name.endsWith('.js'))
  assert.ok(files.length > 0)
  for (const name of files) {
    const text = readFileSync(join(hostDir, name), 'utf8')
    assert.equal(/soul_note|soul_fact/.test(text), false, name + ' 不该再提 soul_note / soul_fact')
  }
})

// 收尾
soulFake.dispose()
memFake.dispose()
memFake2.dispose()
await new Promise((resolve) => setTimeout(resolve, 100))
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
