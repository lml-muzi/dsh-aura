/**
 * dsh-aura 日记系统自测（node 直接跑）
 *   node dsh-aura/dev/diary-selftest.mjs
 *
 * 用临时 HOME / DSH_HOME 隔离，不碰真实 soul/diary：
 *   规则日记（有事件 / 无事件 / 非当天）/ LLM prompt 要点 / 同日覆盖合并 /
 *   日期升序与 list 倒序 / generate 的 rule/llm/回退/跳过 / soul_diary 工具参数校验 /
 *   HTTP 路由与 fence / 写盘前 backup.snapshot('diary') 真的被调用。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as diary from '../host/diary.js'
import * as backup from '../host/backup.js'

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
const api = diary.createDiary({ home: diaryDir, getSoul, getConfig, llm: mockLlm, log: () => {} })

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
  ctx: fakeCtx,
})

await test('createDiary 传入 ctx 后注册 soul_diary 与 prefix 路由', () => {
  assert.ok(captured.tool)
  assert.equal(captured.tool.name, 'soul_diary')
  assert.match(captured.tool.description, /日记/)
  assert.match(captured.tool.description, /不是记忆/)
  assert.match(captured.tool.description, /不要每轮写/)
  assert.deepEqual(captured.tool.parameters.properties.action.enum, ['write', 'read', 'list', 'today'])
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

for (const instance of [api, ctxApi]) {
  try { instance.dispose() } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
rmSync(root, { recursive: true, force: true })
