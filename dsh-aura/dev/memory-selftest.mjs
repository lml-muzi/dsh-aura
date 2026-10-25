/**
 * dsh-aura 记忆存储自测（node 直接跑）
 *   node dsh-aura/dev/memory-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不碰真实 soul/config/memory.json。覆盖：
 *   memory-store：原子写、损坏 .corrupt 回退、归一化裁剪（40 事件 / 30 笔记 / 80 字）；
 *   迁移：soul.memory → memory.json、写前 backup('memory-migrate')、soul 清空、二次不覆盖；
 *   真实 installSoul + installMemory：旧 soul.json 自动迁移、soul.json 不再写 memory、reset 不清 memory.json；
 *   ring 裁剪（memoryMaxEvents 可调 5..40）、压实（>30 最旧 10 条 → notes）、context 预算与最近 2 条；
 *   soul_note/soul_recall/pendingDue 行为、diary 注入 getMemoryStore 读 events。
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

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-memory-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
mkdirSync(dataDir, { recursive: true })

const state = await import('../host/state.js')
const soulMod = await import('../host/soul.js')
const memoryMod = await import('../host/memory.js')
const storeMod = await import('../host/memory-store.js')
const diaryMod = await import('../host/diary.js')
const {
  MEMORY_FILE,
  createMemoryStore,
  emptyMemory,
  normalizeMemory,
} = storeMod
const {
  EVENT_MAX,
  MEMORY_CONTEXT_BUDGET,
  MEMORY_CONTEXT_BUDGET_MAX,
  NOTE_MAX,
  NOTE_MAX_CHARS,
  compactEvents,
  installMemory,
  renderMemoryContext,
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
    get() {
      return undefined
    },
  }
  return {
    ctx,
    tools,
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

await test('write/read：version 1、原子 tmp+rename、没有残留 tmp 文件', () => {
  const dir = join(root, 'store-a')
  const store = createMemoryStore({ home: dir, log: () => {} })
  const written = store.write({
    events: [eventText(1, 1000)],
    notes: { user: [{ text: 'n'.repeat(200) }], us: [], self: [] },
    topics: { 加班: { lastAt: 1000, count: 2 } },
    reflection: { lastReflectAt: 123, pendingDue: [{ at: 5000, text: '面试' }] },
  })
  assert.equal(written.version, 1)
  const disk = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(disk.version, 1)
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

await test('归一化：事件 ≤40、每类笔记 ≤30 且单条 ≤80 字、话题限长', () => {
  const dir = join(root, 'store-normalize')
  const store = createMemoryStore({ home: dir, log: () => {} })
  store.write({
    events: Array.from({ length: 55 }, (_, index) => eventText(index, index + 1)),
    notes: {
      user: Array.from({ length: 40 }, (_, index) => ({ text: `用户笔记${index}-${'长'.repeat(100)}` })),
      us: [{ text: '   ' }],
      self: [{ text: '我会承认不确定' }],
    },
    topics: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`话题${index}`, { lastAt: index, count: 1 }])),
  })
  const memory = store.read()
  assert.equal(memory.events.length, EVENT_MAX)
  assert.deepEqual(memory.events.map((item) => item.at), Array.from({ length: 40 }, (_, index) => index + 16))
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
  state.writeConfig({ memoryMaxEvents: 40 })
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

await test('renderMemoryContext：预算 ≤220（当前 180），只含最近 2 条事件', () => {
  memory.clear()
  memory.note('user', '用户叫木子', 0.9)
  memory.note('user', '用户喜欢听歌', 0.8)
  memory.note('us', '你们约好周末看电影', 0.8)
  for (let index = 1; index <= 5; index += 1) {
    memory.addEvent(eventText(index, 30_000 + index * 2000))
  }
  const config = state.readConfig()
  const context = memory.renderContext(Date.now(), { lastUserText: '木子' })
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET_MAX, `预算应 ≤${MEMORY_CONTEXT_BUDGET_MAX}，实际 ${lengthOf(context)}`)
  assert.ok(lengthOf(context) <= MEMORY_CONTEXT_BUDGET, `当前预算 ${MEMORY_CONTEXT_BUDGET}`)
  assert.ok(context.includes('事件编号5'))
  assert.ok(context.includes('事件编号4'))
  assert.equal(context.includes('事件编号1'), false)
  assert.equal(context.includes('事件编号2'), false)
  assert.equal(context.includes('事件编号3'), false)
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
section('5. soul_note / soul_recall / pendingDue')

await test('soul_note 写入 memory.json，soul_recall 能召回；单条 ≤80 字', async () => {
  memory.clear()
  const noteTool = memFake.tools.find((tool) => tool.name === 'soul_note')
  const recallTool = memFake.tools.find((tool) => tool.name === 'soul_recall')
  assert.ok(noteTool && recallTool)
  const written = await noteTool.execute({ category: 'user', text: '用户叫木子', importance: 0.9 })
  assert.equal(written.ok, true)
  const long = await noteTool.execute({ category: 'self', text: '长'.repeat(200), importance: 0.5 })
  assert.equal(long.ok, true)
  assert.ok(lengthOf(long.note.text) <= NOTE_MAX_CHARS)
  const found = await recallTool.execute({ query: '木子' })
  assert.ok(found.items.some((item) => item.text.includes('木子')))
  const disk = JSON.parse(readFileSync(memory.store.file, 'utf8'))
  assert.ok(disk.notes.user.some((note) => note.text === '用户叫木子'))
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

// 收尾
soulFake.dispose()
memFake.dispose()
await new Promise((resolve) => setTimeout(resolve, 100))
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
