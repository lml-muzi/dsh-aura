/**
 * dsh-aura 日记系统自测（node 直接跑）
 *   node dsh-aura/dev/diary-selftest.mjs
 *
 * 用临时 HOME / DSH_HOME 隔离，不碰真实 soul/diary：
 *   规则日记（有事件 / 无事件 / 非当天）/ LLM prompt 要点 / 同日覆盖合并 /
 *   日期升序与 list 倒序 / generate 的 rule/llm/回退/跳过 / soul_diary 工具参数校验 /
 *   HTTP 路由与 fence / 写盘前 backup.snapshot('diary') 真的被调用 /
 *   自动写：开关 / 到点 / 跨天补昨天 / 事件不足 / 已有条目 / 每日最多 2 篇 /
 *   手动 autoWrite / 定时器与 dispose / 面板配置夹取。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as diary from '../host/diary.js'
import * as backup from '../host/backup.js'
import * as state from '../host/state.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-diary-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh-native')
const diaryDir = join(process.env.DSH_HOME, 'dsh-aura')
mkdirSync(diaryDir, { recursive: true })

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n${title}`)
}

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

const day = '2024-05-20'
const otherDay = '2024-05-19'
const laterDay = '2024-05-21'
const toolDate = '2031-03-04'
const webDate = '2032-01-02'

function atOn(date, hour, minute) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime()
}

const chatEvent = {
  id: 'evt-chat',
  at: atOn(day, 21, 10),
  kind: 'chat',
  summary: '用户说「今天加班到十点」；她回「辛苦了，早点睡」',
  topics: ['加班'],
  salience: 0.72,
  source: 'rule',
}
const milestoneEvent = {
  id: 'evt-milestone',
  at: atOn(day, 23, 0),
  kind: 'milestone',
  summary: '关系阶段从「熟悉」升到「亲密」',
  topics: [],
  salience: 0.9,
  source: 'relation',
}

function makeSoul(events = [chatEvent, milestoneEvent]) {
  return {
    identity: { name: 'Aura', address: { userPreferred: '木子', nickname: '' } },
    relation: { stage: 'close', score: 52.4, turns: 18 },
    emotion: {
      transient: {
        label: '开心',
        valence: 0.42,
        arousal: 0.5,
        intensity: 0.7,
        cause: '木子记得我说的话',
      },
      mood: { valence: 0.3, arousal: 0.3 },
      affection: 0.72,
      drive: { energy: 0.38 },
    },
    memory: { events: events.slice(), notes: { user: [], us: [], self: [] }, topics: {} },
  }
}

let soul = makeSoul()
const config = {
  soulName: 'Aura',
  soulUserNickname: '木子',
  memoryProvider: 'mock',
  memoryModel: 'mock-diary',
}

let llmCalls = 0
const mockLlm = async () => {
  llmCalls += 1
  return '```json\n' + JSON.stringify({
    summary: '今天木子说加班到十点，我有点心疼，也提醒他早点睡。',
    highlights: ['加班', '心疼'],
  }) + '\n```'
}

const getSoul = () => soul
const getConfig = () => config

section('1. 纯函数：规则日记与 LLM prompt')
await test('有当天事件时生成第一人称摘要与 highlights', () => {
  const result = diary.renderRuleDiary({ date: day, soul, config })
  assert.ok(result)
  assert.match(result.summary, /木子/)
  assert.match(result.summary, /加班/)
  assert.match(result.summary, /开心/)
  assert.match(result.summary, /关系阶段/)
  assert.ok(result.highlights.includes('加班'))
  assert.ok(diary.codepointLength(result.summary) <= diary.DIARY_PROMPT_MAX)
})

await test('没有事件 / 不是当天事件时返回 null', () => {
  assert.equal(diary.renderRuleDiary({ date: day, soul: makeSoul([]), config }), null)
  assert.equal(diary.renderRuleDiary({ date: otherDay, soul, config }), null)
  assert.equal(diary.renderRuleDiary({ date: 'not-a-date', soul, config }), null)
})

await test('buildDiaryPrompt 含日期 / 第一人称 / ≤200 字 / JSON / 事件 / 情绪', () => {
  const prompt = diary.buildDiaryPrompt({ date: day, soul, config })
  assert.match(prompt, /2024-05-20/)
  assert.match(prompt, /第一人称/)
  assert.match(prompt, /私人日记/)
  assert.match(prompt, /200 字/)
  assert.match(prompt, /JSON/)
  assert.match(prompt, /木子/)
  assert.match(prompt, /加班到十点/)
  assert.match(prompt, /开心/)
  assert.match(prompt, /关系里程碑/)
})

await test('空事件 prompt 仍可生成（明说没有事件记录）', () => {
  const prompt = diary.buildDiaryPrompt({ date: day, soul: makeSoul([]), config })
  assert.match(prompt, /没有留下事件记录/)
})

await test('parseDiaryOutput 兼容围栏 / 前后废话 / 坏 JSON', () => {
  const parsed = diary.parseDiaryOutput('说明\n```json\n{"summary":"今天很好。","highlights":["好"]}\n```')
  assert.deepEqual(parsed, { summary: '今天很好。', highlights: ['好'] })
  assert.equal(diary.parseDiaryOutput('not json'), null)
  assert.equal(diary.parseDiaryOutput('{"highlights":[]}'), null)
})

section('2. 存储：同日覆盖合并 / 日期升序 / list 倒序')
const api = diary.createDiary({ home: diaryDir, getSoul, getConfig, llm: mockLlm, log: () => {}, autoSchedule: false })

await test('初始没有日记文件，read/list 返回空', () => {
  assert.equal(api.read(), null)
  assert.deepEqual(api.list(), [])
  assert.equal(existsSync(join(diaryDir, diary.DIARY_FILE)), false)
})

let backupsBefore = 0
await test('第一次 save 写 diary.json 并调用 backup.snapshot("diary")', async () => {
  backupsBefore = (await backup.listBackups(100)).length
  const result = await api.save({
    date: day,
    summary: '第一版日记',
    highlights: ['加班'],
    private: true,
  }, { source: 'self' })
  assert.equal(result.ok, true)
  assert.equal(result.overwritten, false)
  assert.equal(result.entry.date, day)
  assert.equal(result.entry.source, 'self')
  assert.equal(result.entry.private, true)
  assert.equal(result.entry.mood.label, '开心')
  assert.equal(result.entry.mood.energy, 0.38)
  assert.ok(existsSync(join(diaryDir, diary.DIARY_FILE)))

  const disk = JSON.parse(readFileSync(join(diaryDir, diary.DIARY_FILE), 'utf8'))
  assert.equal(disk.version, 1)
  assert.equal(disk.entries.length, 1)
  assert.equal(disk.entries[0].summary, '第一版日记')

  const backupsAfter = (await backup.listBackups(100)).length
  assert.ok(backupsAfter > backupsBefore, '写盘前应产生一份备份')
  const latest = (await backup.listBackups(100)).find((item) => item.label === 'diary')
  assert.ok(latest, '应存在 label=diary 的快照')
})

await test('同一天再次写入：覆盖 summary/source、合并 highlights、保留 private', async () => {
  const result = await api.save({
    date: day,
    summary: '第二版日记',
    highlights: ['奶茶'],
  }, { source: 'user' })
  assert.equal(result.ok, true)
  assert.equal(result.overwritten, true)
  assert.equal(result.entry.summary, '第二版日记')
  assert.equal(result.entry.source, 'user')
  assert.deepEqual(result.entry.highlights, ['加班', '奶茶'])
  assert.equal(result.entry.private, true)

  const disk = JSON.parse(readFileSync(join(diaryDir, diary.DIARY_FILE), 'utf8'))
  assert.equal(disk.entries.length, 1, '同一天只能留一条')
  assert.equal(disk.entries[0].summary, '第二版日记')

  const latest = (await backup.listBackups(100)).find((item) => item.label === 'diary')
  assert.ok(latest.files.some((item) => item.name === 'diary.json'), '第二次写前快照应包含旧 diary.json')
  const oldCopy = JSON.parse(readFileSync(join(backup.backupsDir(), latest.id, 'diary.json'), 'utf8'))
  assert.equal(oldCopy.entries[0].summary, '第一版日记')
})

await test('多日期按 date 升序落盘，list 最近在前', async () => {
  await api.save({ date: otherDay, summary: '前一天', highlights: [] }, { source: 'self' })
  await api.save({ date: laterDay, summary: '后一天', highlights: [] }, { source: 'self' })

  const disk = JSON.parse(readFileSync(join(diaryDir, diary.DIARY_FILE), 'utf8'))
  assert.deepEqual(disk.entries.map((item) => item.date), [otherDay, day, laterDay])
  assert.deepEqual(api.list(10).map((item) => item.date), [laterDay, day, otherDay])
  assert.equal(api.read().date, laterDay)
  assert.equal(api.read(otherDay).summary, '前一天')
  assert.equal(api.read('bad-date'), null)
})

await test('remove 删除指定日期；不存在时 removed=false', async () => {
  const removed = await api.remove(laterDay)
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, true)
  assert.equal(api.read(laterDay), null)
  const again = await api.remove(laterDay)
  assert.equal(again.ok, true)
  assert.equal(again.removed, false)
})

section('3. generate：跳过 / 规则 / LLM / 回退 / 空事件')
await test('当天已有条目且 force=false 时直接返回 existing', async () => {
  const result = await api.generate({ date: day, mode: 'rule' })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'exists')
  assert.equal(result.entry.summary, '第二版日记')
})

await test('mode=rule 生成规则日记，不调用 LLM', async () => {
  await api.remove(day)
  const before = llmCalls
  const result = await api.generate({ date: day, mode: 'rule' })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.via, 'rule')
  assert.equal(result.entry.source, 'auto')
  assert.match(result.entry.summary, /木子/)
  assert.equal(llmCalls, before)
})

await test('mode=llm 调 LLM 并解析 JSON', async () => {
  await api.remove(day)
  llmCalls = 0
  const result = await api.generate({ date: day, mode: 'llm' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'llm')
  assert.equal(llmCalls, 1)
  assert.match(result.entry.summary, /心疼/)
  assert.deepEqual(result.entry.highlights, ['加班', '心疼'])
  assert.equal(result.entry.source, 'auto')
})

await test('force=true 覆盖已有条目', async () => {
  const result = await api.generate({ date: day, mode: 'rule', force: true })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.overwritten, true)
  assert.equal(result.via, 'rule')
})

await test('LLM 抛错时回退规则日记', async () => {
  const badApi = diary.createDiary({
    home: diaryDir,
    getSoul,
    getConfig,
    llm: async () => { throw new Error('mock boom') },
    log: () => {},
    autoSchedule: false,
  })
  await badApi.remove(day)
  const result = await badApi.generate({ date: day, mode: 'llm' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'rule')
  assert.match(result.entry.summary, /加班/)
})

await test('LLM 返回非 JSON 时回退规则日记', async () => {
  const badApi = diary.createDiary({
    home: diaryDir,
    getSoul,
    getConfig,
    llm: async () => '抱歉，我写不出来',
    log: () => {},
    autoSchedule: false,
  })
  await badApi.remove(day)
  const result = await badApi.generate({ date: day, mode: 'llm' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'rule')
})

await test('LLM 对象适配器 generate({text}) 可用', async () => {
  const objectApi = diary.createDiary({
    home: diaryDir,
    getSoul,
    getConfig,
    llm: {
      async generate() {
        return { text: '{"summary":"对象 LLM 写的日记。","highlights":["测试"]}' }
      },
    },
    log: () => {},
    autoSchedule: false,
  })
  await objectApi.remove(day)
  const result = await objectApi.generate({ date: day, mode: 'llm' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'llm')
  assert.equal(result.entry.summary, '对象 LLM 写的日记。')
})

await test('没有当天事件时 generate 不写空日记', async () => {
  const emptySoul = makeSoul([])
  const emptyApi = diary.createDiary({
    home: diaryDir,
    getSoul: () => emptySoul,
    getConfig,
    llm: mockLlm,
    log: () => {},
    autoSchedule: false,
  })
  await emptyApi.remove(day)
  const result = await emptyApi.generate({ date: day, mode: 'rule' })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'empty')
  assert.equal(result.entry, null)
})

section('4. soul_diary 工具与 HTTP 路由')
const captured = {}
const webServer = {
  register(registration) {
    captured.route = registration
    return () => { captured.routeDisposed = true }
  },
}
const tools = {
  register(tool) {
    captured.tool = tool
    return () => { captured.toolDisposed = true }
  },
}
const fakeCtx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'tools') return tools
    return undefined
  },
  webServer,
  tools,
  effect(fn) {
    const handle = fn()
    return () => { if (typeof handle === 'function') handle() }
  },
}

const ctxApi = diary.createDiary({
  home: diaryDir,
  getSoul: () => soul,
  getConfig,
  llm: mockLlm,
  log: () => {},
  autoSchedule: false,
  ctx: fakeCtx,
})

await test('createDiary 传入 ctx 后注册 soul_diary 与 prefix 路由', () => {
  assert.ok(captured.tool)
  assert.equal(captured.tool.name, 'soul_diary')
  assert.match(captured.tool.description, /日记/)
  assert.match(captured.tool.description, /不是记忆/)
  assert.match(captured.tool.description, /不要每轮写/)
  assert.deepEqual(captured.tool.parameters.properties.action.enum, ['write', 'read', 'list', 'today', 'auto'])
  assert.equal(captured.tool.parameters.properties.force.type, 'boolean')
  assert.equal(captured.tool.parameters.properties.date.type, 'string')
  assert.equal(captured.tool.parameters.properties.highlights.type, 'array')
  assert.equal(captured.tool.parameters.properties.private.type, 'boolean')
  assert.equal(captured.route.kind, 'prefix')
  assert.equal(captured.route.path, diary.DIARY_API_PREFIX)
})

await test('工具 write/read/list/today 正常读写', async () => {
  const write = await captured.tool.execute({
    action: 'write',
    date: toolDate,
    text: '今天有点累，但还是想记一笔。',
    highlights: ['有点累'],
  })
  assert.equal(write.ok, true)
  assert.equal(write.entry.date, toolDate)
  assert.equal(write.entry.source, 'self')
  assert.deepEqual(write.entry.highlights, ['有点累'])

  const read = await captured.tool.execute({ action: 'read', date: toolDate })
  assert.equal(read.ok, true)
  assert.equal(read.entry.summary, '今天有点累，但还是想记一笔。')

  const latest = await captured.tool.execute({ action: 'read' })
  assert.equal(latest.entry.date, toolDate)

  const listResult = await captured.tool.execute({ action: 'list' })
  assert.equal(listResult.ok, true)
  assert.ok(listResult.entries.length >= 1)
  assert.equal(listResult.count, listResult.entries.length)

  const today = await captured.tool.execute({ action: 'today' })
  assert.equal(today.ok, true)
  assert.equal(today.date, diary.localDayKey(Date.now()))
  assert.ok(today.entry === null || today.entry.date === today.date)
})

await test('工具参数校验：缺 action / 坏枚举 / 坏类型 / 坏日期 / 空正文', async () => {
  await assert.rejects(() => captured.tool.execute({}), /invalid arguments/)
  await assert.rejects(() => captured.tool.execute({ action: 'nope' }), /invalid arguments/)
  await assert.rejects(() => captured.tool.execute({
    action: 'write', date: toolDate, summary: 'x', private: 'yes',
  }), /invalid arguments/)

  const badDate = await captured.tool.execute({ action: 'write', date: '2024-02-30', summary: 'x' })
  assert.equal(badDate.ok, false)
  assert.equal(badDate.reason, 'invalid-date')

  const empty = await captured.tool.execute({ action: 'write', date: toolDate, summary: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'empty')
})

function fakeReq(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

function fakeRawReq(method, url, raw, headers = {}) {
  const stream = Readable.from([Buffer.from(raw)])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(data) {
      this.body = data && data.length ? JSON.parse(String(data)) : null
    },
  }
}

await test('HTTP fence：非本机 Host / 跨站 / 非本机 Origin 均 403', async () => {
  let res = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=list', undefined, { host: 'evil.example:80' }), res)
  assert.equal(res.status, 403)
  assert.equal(res.body.ok, false)

  res = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=list', undefined, { 'sec-fetch-site': 'cross-site' }), res)
  assert.equal(res.status, 403)

  res = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=list', undefined, { origin: 'http://evil.example' }), res)
  assert.equal(res.status, 403)

  res = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=list', undefined, { origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
})

await test('GET list / get / today 返回 {ok, entries/entry}', async () => {
  const listRes = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=list&limit=3'), listRes)
  assert.equal(listRes.status, 200)
  assert.equal(listRes.body.ok, true)
  assert.ok(Array.isArray(listRes.body.entries))
  assert.equal(listRes.body.count, listRes.body.entries.length)

  const getRes = fakeRes()
  await captured.route.handler(fakeReq('GET', `/dsh-aura/diary-api?action=get&date=${toolDate}`), getRes)
  assert.equal(getRes.status, 200)
  assert.equal(getRes.body.ok, true)
  assert.equal(getRes.body.date, toolDate)
  assert.equal(getRes.body.entry.date, toolDate)

  const latestRes = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=get'), latestRes)
  assert.equal(latestRes.status, 200)
  assert.equal(latestRes.body.entry.date, toolDate)

  const todayRes = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=today'), todayRes)
  assert.equal(todayRes.status, 200)
  assert.equal(todayRes.body.ok, true)
  assert.equal(todayRes.body.date, diary.localDayKey(Date.now()))

  const badDateRes = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=get&date=nope'), badDateRes)
  assert.equal(badDateRes.status, 400)

  const unknownRes = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/diary-api?action=nope'), unknownRes)
  assert.equal(unknownRes.status, 400)
})

await test('POST save 覆盖同日并返回 {ok, entry, overwritten}', async () => {
  const firstRes = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'save',
    date: webDate,
    summary: '从网页写的日记。',
    highlights: ['网页'],
    private: true,
    source: 'user',
  }), firstRes)
  assert.equal(firstRes.status, 200)
  assert.equal(firstRes.body.ok, true)
  assert.equal(firstRes.body.overwritten, false)
  assert.equal(firstRes.body.entry.source, 'user')
  assert.equal(firstRes.body.entry.private, true)

  const secondRes = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'save',
    date: webDate,
    summary: '网页第二版。',
    highlights: ['再记一笔'],
  }), secondRes)
  assert.equal(secondRes.status, 200)
  assert.equal(secondRes.body.ok, true)
  assert.equal(secondRes.body.overwritten, true)
  assert.equal(secondRes.body.entry.summary, '网页第二版。')
  assert.deepEqual(secondRes.body.entry.highlights, ['网页', '再记一笔'])
  assert.equal(secondRes.body.entry.private, true)
})

await test('POST generate / delete / 未知 action / 坏 JSON', async () => {
  const generated = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'generate', date: day, mode: 'rule', force: true,
  }), generated)
  assert.equal(generated.status, 200)
  assert.equal(generated.body.ok, true)
  assert.equal(generated.body.skipped, false)
  assert.equal(generated.body.via, 'rule')

  const emptyGenerated = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'generate', date: '2033-01-01', mode: 'rule', force: true,
  }), emptyGenerated)
  assert.equal(emptyGenerated.status, 200)
  assert.equal(emptyGenerated.body.ok, true)
  assert.equal(emptyGenerated.body.skipped, true)
  assert.equal(emptyGenerated.body.reason, 'empty')

  const deleted = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'delete', date: webDate,
  }), deleted)
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.ok, true)
  assert.equal(deleted.body.removed, true)

  const deletedAgain = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', {
    action: 'delete', date: webDate,
  }), deletedAgain)
  assert.equal(deletedAgain.status, 200)
  assert.equal(deletedAgain.body.removed, false)

  const unknown = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/diary-api', { action: 'nope' }), unknown)
  assert.equal(unknown.status, 400)

  const badJson = fakeRes()
  await captured.route.handler(fakeRawReq('POST', '/dsh-aura/diary-api', '{oops'), badJson)
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.ok, false)
})

await test('dispose 卸掉工具与路由', () => {
  ctxApi.dispose()
  assert.equal(captured.toolDisposed, true)
  assert.equal(captured.routeDisposed, true)
})

section('5. 备份与数据一致性')
await test('存在 label=diary 且包含 diary.json 的快照', async () => {
  const backups = await backup.listBackups(100)
  const diaryBackups = backups.filter((item) => item.label === 'diary')
  assert.ok(diaryBackups.length > 0)
  assert.ok(diaryBackups.some((item) => item.files.some((file) => file.name === 'diary.json')))
})

await test('diary.json 版本/升序/同日唯一', () => {
  const disk = JSON.parse(readFileSync(join(diaryDir, diary.DIARY_FILE), 'utf8'))
  assert.equal(disk.version, diary.DIARY_VERSION)
  assert.deepEqual(disk.entries.map((item) => item.date), [...disk.entries.map((item) => item.date)].sort())
  assert.equal(new Set(disk.entries.map((item) => item.date)).size, disk.entries.length)
})

// ---------- 6. 日记自动写 ----------
section('6. 日记自动写：开关 / 到点 / 跨天 / 上限 / 手动 / 定时器')

function makeFakeTimers() {
  const list = []
  const timers = {
    setTimeout(fn, ms) {
      const handle = { kind: 'timeout', fn, ms, cleared: false, unref() { return this } }
      list.push(handle)
      return handle
    },
    setInterval(fn, ms) {
      const handle = { kind: 'interval', fn, ms, cleared: false, unref() { return this } }
      list.push(handle)
      return handle
    },
    clearTimeout(handle) { if (handle) handle.cleared = true },
    clearInterval(handle) { if (handle) handle.cleared = true },
  }
  return { timers, list }
}

function eventsOn(dateKey, hour, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'auto-' + dateKey + '-' + index,
    at: atOn(dateKey, hour, 10 + index),
    kind: 'chat',
    summary: '用户说「' + dateKey + ' 第 ' + (index + 1) + ' 次加班」；她回「早点睡」',
    topics: ['加班'],
    salience: 0.6,
    source: 'rule',
  }))
}

const autoToday = '2034-06-01'
const autoPrev = '2034-05-31'
let autoSeq = 0

/** 每个用例独立的 home 目录 + 假定时器 + 可注入时钟。 */
function makeAutoCase(options = {}) {
  autoSeq += 1
  const dir = join(root, 'auto-' + autoSeq)
  mkdirSync(dir, { recursive: true })
  const autoSoul = makeSoul(options.events || [])
  const autoConfig = {
    soulName: 'Aura',
    soulUserNickname: '木子',
    diaryAuto: true,
    diaryAutoHour: 22,
    diaryAutoMinEvents: 3,
    ...(options.config || {}),
  }
  const fake = makeFakeTimers()
  const nowFn = () => (typeof options.clock === 'function' ? options.clock() : options.clock)
  const instance = diary.createDiary({
    home: dir,
    getSoul: () => autoSoul,
    getConfig: () => autoConfig,
    now: nowFn,
    timers: fake.timers,
    autoSchedule: options.autoSchedule === true,
    log: () => {},
  })
  return { api: instance, dir, fake, config: autoConfig, soul: autoSoul }
}

await test('diaryAuto=false：到点也不自动写', async () => {
  const c = makeAutoCase({
    events: eventsOn(autoToday, 21, 4),
    clock: atOn(autoToday, 23, 5),
    config: { diaryAuto: false },
  })
  const result = await c.api.autoWrite()
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'disabled')
  assert.deepEqual(result.dates, [])
  assert.equal(c.api.read(autoToday), null)
  c.api.dispose()
})

await test('到点且事件够 → 自动写今天（rule，source=auto，auto meta 落盘）', async () => {
  const c = makeAutoCase({ events: eventsOn(autoToday, 21, 4), clock: atOn(autoToday, 22, 30) })
  const result = await c.api.autoWrite()
  assert.equal(result.skipped, false)
  assert.deepEqual(result.dates, [autoToday])
  const entry = c.api.read(autoToday)
  assert.ok(entry)
  assert.equal(entry.source, 'auto')
  assert.match(entry.summary, /木子/)
  assert.equal(c.api.read(autoPrev), null)
  const disk = JSON.parse(readFileSync(join(c.dir, diary.DIARY_FILE), 'utf8'))
  assert.ok(disk.auto[autoToday] > 0, 'diary.json 应记 auto meta')
  c.api.dispose()
})

await test('没到 diaryAutoHour → 不写今天，reason=before-hour', async () => {
  const c = makeAutoCase({ events: eventsOn(autoToday, 9, 4), clock: atOn(autoToday, 12, 0) })
  const result = await c.api.autoWrite()
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'before-hour')
  assert.equal(c.api.read(autoToday), null)
  c.api.dispose()
})

await test('跨天：昨天没日记且事件够 → 任何时间都补写昨天', async () => {
  const c = makeAutoCase({
    events: [...eventsOn(autoPrev, 20, 4), ...eventsOn(autoToday, 9, 1)],
    clock: atOn(autoToday, 8, 30),
  })
  const result = await c.api.autoWrite()
  assert.deepEqual(result.dates, [autoPrev])
  assert.equal(c.api.read(autoPrev).source, 'auto')
  assert.equal(c.api.read(autoToday), null, '今天还没到点，不写')
  c.api.dispose()
})

await test('事件不足 diaryAutoMinEvents → 跳过（rule 无素材不落空日记）', async () => {
  const c = makeAutoCase({ events: eventsOn(autoToday, 21, 2), clock: atOn(autoToday, 22, 30) })
  const result = await c.api.autoWrite()
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'few-events')
  assert.deepEqual(result.dates, [])
  assert.equal(c.api.read(autoToday), null)
  c.api.dispose()
})

await test('已有条目 force=false 不覆盖（你手写的日记保住）', async () => {
  const c = makeAutoCase({ events: eventsOn(autoToday, 21, 4), clock: atOn(autoToday, 22, 30) })
  await c.api.save({ date: autoToday, summary: '我自己写的今天', highlights: [] }, { source: 'user' })
  const result = await c.api.autoWrite()
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'exists')
  assert.equal(c.api.read(autoToday).summary, '我自己写的今天')
  assert.equal(c.api.read(autoToday).source, 'user')
  c.api.dispose()
})

await test('每天最多自动写 2 篇：昨天 + 今天，再跑就 daily-cap', async () => {
  const c = makeAutoCase({
    events: [...eventsOn(autoPrev, 20, 4), ...eventsOn(autoToday, 10, 4)],
    clock: atOn(autoToday, 22, 40),
  })
  const first = await c.api.autoWrite()
  assert.deepEqual(first.dates, [autoPrev, autoToday])
  assert.equal(c.api.read(autoPrev).source, 'auto')
  assert.equal(c.api.read(autoToday).source, 'auto')
  const second = await c.api.autoWrite()
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'daily-cap')
  assert.deepEqual(second.dates, [])
  c.api.dispose()
})

await test('autoWrite({force:true})：越过开关/时间，但依旧不覆盖已有条目', async () => {
  const c = makeAutoCase({
    events: eventsOn(autoToday, 9, 4),
    clock: atOn(autoToday, 10, 0),
    config: { diaryAuto: false },
  })
  const plain = await c.api.autoWrite()
  assert.equal(plain.reason, 'disabled')
  const forced = await c.api.autoWrite({ force: true })
  assert.deepEqual(forced.dates, [autoToday])
  assert.equal(c.api.read(autoToday).source, 'auto')
  const again = await c.api.autoWrite({ force: true })
  assert.equal(again.reason, 'exists')
  assert.deepEqual(again.dates, [])
  assert.equal(c.api.read(autoToday).source, 'auto')
  c.api.dispose()
})

await test('定时器：安装后 10s 一次 + 每 30 分钟一次；dispose 清掉', async () => {
  const c = makeAutoCase({
    events: eventsOn(autoToday, 21, 4),
    clock: atOn(autoToday, 22, 30),
    autoSchedule: true,
  })
  const timeouts = c.fake.list.filter((item) => item.kind === 'timeout')
  const intervals = c.fake.list.filter((item) => item.kind === 'interval')
  assert.equal(timeouts.length, 1)
  assert.equal(timeouts[0].ms, diary.DIARY_AUTO_INITIAL_DELAY_MS)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, diary.DIARY_AUTO_INTERVAL_MS)
  timeouts[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(c.api.read(autoToday), '安装 10s 后那次检查应写今天')
  assert.equal(c.api.read(autoToday).source, 'auto')
  c.api.dispose()
  assert.equal(c.fake.list.every((item) => item.cleared), true, 'dispose 应清掉定时器')
})

await test('HTTP POST autoWrite：返回 {ok, wrote, dates}，force 生效', async () => {
  const routeHolder = {}
  const autoWebServer = {
    register(registration) {
      routeHolder.route = registration
      return () => { routeHolder.disposed = true }
    },
  }
  const httpHome = join(root, 'auto-http')
  const httpApi = diary.createDiary({
    home: httpHome,
    getSoul: () => makeSoul(eventsOn(autoToday, 21, 4)),
    getConfig: () => ({ diaryAuto: false }),
    now: () => atOn(autoToday, 22, 30),
    timers: makeFakeTimers().timers,
    autoSchedule: false,
    log: () => {},
    ctx: { get: (name) => (name === 'webServer' ? autoWebServer : undefined), webServer: autoWebServer },
  })
  assert.ok(routeHolder.route, '应注册 diary-api 路由')

  const res = fakeRes()
  await routeHolder.route.handler(fakeReq('POST', '/dsh-aura/diary-api', { action: 'autoWrite', force: true }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.dates, [autoToday])
  assert.equal(res.body.wrote.length, 1)
  assert.equal(res.body.skipped, false)

  const again = fakeRes()
  await routeHolder.route.handler(fakeReq('POST', '/dsh-aura/diary-api', { action: 'autoWrite', force: true }), again)
  assert.equal(again.status, 200)
  assert.equal(again.body.skipped, true)
  assert.deepEqual(again.body.dates, [])
  httpApi.dispose()
})

await test('配置默认值与范围夹取：diaryAuto / hour 0-23 / minEvents 1-20', () => {
  const defaults = state.DEFAULT_CONFIG
  assert.equal(defaults.diaryAuto, true)
  assert.equal(defaults.diaryAutoHour, 22)
  assert.equal(defaults.diaryAutoMinEvents, 3)
  assert.equal(state.normalizeConfig({ diaryAutoHour: 99 }).diaryAutoHour, 23, '高于 23 夹到 23')
  assert.equal(state.normalizeConfig({ diaryAutoHour: -3 }).diaryAutoHour, 0, '低于 0 夹到 0')
  assert.equal(state.normalizeConfig({ diaryAutoMinEvents: 0 }).diaryAutoMinEvents, 1, '低于 1 夹到 1')
  assert.equal(state.normalizeConfig({ diaryAutoMinEvents: 99 }).diaryAutoMinEvents, 20, '高于 20 夹到 20')
  assert.equal(state.normalizeConfig({ diaryAutoHour: 'abc' }).diaryAutoHour, 22, '非数字回落默认')
  assert.equal(state.normalizeConfig({ diaryAuto: false }).diaryAuto, false)
  const written = state.writeConfig({ diaryAuto: false, diaryAutoHour: 7, diaryAutoMinEvents: 5 })
  assert.equal(written.diaryAuto, false)
  assert.equal(written.diaryAutoHour, 7)
  assert.equal(written.diaryAutoMinEvents, 5)
  const back = state.readConfig()
  assert.equal(back.diaryAutoHour, 7)
  assert.equal(back.diaryAutoMinEvents, 5)
  state.writeConfig({ diaryAuto: true, diaryAutoHour: 22, diaryAutoMinEvents: 3 })
})

await test('面板：日记设置夹取后 POST /config，且有「自动补一篇」按钮', () => {
  const client = readFileSync(join(pluginRoot, 'client.js'), 'utf8')
  assert.ok(client.includes('clampInt(diaryForm.diaryAutoHour, 0, 23, 22)'), '小时 0-23 夹取')
  assert.ok(client.includes('clampInt(diaryForm.diaryAutoMinEvents, 1, 20, 3)'), '最少事件 1-20 夹取')
  assert.ok(client.includes('diaryAuto: diaryForm.diaryAuto !== false'), '自动写开关走 /config')
  assert.ok(client.includes("action: 'autoWrite'"), '面板应调用 diary-api 的 autoWrite')
  assert.ok(client.includes("'diary.autoWrite': '自动补一篇'"), '应有「自动补一篇」按钮文案')
  assert.equal(/soul_note|soul_fact/.test(client), false, '面板里不该再提 soul_note / soul_fact')
})

for (const instance of [api, ctxApi]) {
  try { instance.dispose() } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
rmSync(root, { recursive: true, force: true })
