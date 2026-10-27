/**
 * dsh-aura 记忆罗盘自测（node 直接跑）
 *   node dsh-aura/dev/archive-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不碰真实存档。覆盖：
 *   写入 schema / 追加写 / 5 秒去重 / 空文本与 tool/system 跳过 / 4000 码点截断；
 *   只存 Aura 会话（qq 或 emotionScope=all），普通网页会话不存；
 *   搜索：全词优先、任一词兜底、时间/session/limit、片段、空 query、坏行跳过；
 *   时间轴：补零、天数夹取；保留：archiveDays/archiveMaxFiles 清理；
 *   soul_archive 工具注册/参数/渲染；/dsh-aura/archive-api 的 loopback+Origin fence；
 *   dispose 后不再写。
 */
import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-archive-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
mkdirSync(dataDir, { recursive: true })
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

const state = await import('../host/state.js')
const archiveMod = await import('../host/archive.js')
const {
  ARCHIVE_API_PREFIX,
  ARCHIVE_DEDUP_MS,
  ARCHIVE_TEXT_MAX,
  archiveStats,
  dateKeyOf,
  initArchive,
  installArchive,
  makeArchiveSnippet,
  monthKeyOf,
  parseArchiveTime,
  pruneArchive,
  randomOld,
  readArchiveMonth,
  seededRandom,
  renderArchiveToolText,
  searchArchive,
  timeline,
} = archiveMod

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

function makeFakeSoul() {
  const listeners = new Map()
  return {
    on(kind, fn) {
      if (!listeners.has(kind)) listeners.set(kind, new Set())
      listeners.get(kind).add(fn)
      return () => listeners.get(kind).delete(fn)
    },
    emit(kind, payload) {
      for (const fn of listeners.get(kind) || []) fn(payload)
    },
    count(kind) {
      return (listeners.get(kind) || new Set()).size
    },
  }
}

function makeFakeCtx() {
  const tools = []
  const registrations = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
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
    registrations,
    dispose() {
      for (const fn of disposers.reverse()) {
        try { fn() } catch { /* ignore */ }
      }
    },
  }
}

function archiveFile(at = Date.now()) {
  return join(dataDir, 'archive', monthKeyOf(at) + '.jsonl')
}

function readLines(file) {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return rows
}

function resetArchiveDir() {
  rmSync(join(dataDir, 'archive'), { recursive: true, force: true })
}

function resetConfig() {
  state.writeConfig({
    soulEnabled: true,
    emotionScope: 'qq',
    archiveEnabled: true,
    archiveDays: 365,
    archiveMaxFiles: 120,
  })
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(data) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      this.body = JSON.parse(text)
    },
  }
}

async function callApi(registration, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const res = makeRes()
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    body,
  }
  await registration.handler(req, res)
  return res
}

resetConfig()
resetArchiveDir()
const soul = makeFakeSoul()
const fake = makeFakeCtx()
const archive = initArchive({ ctx: fake.ctx, state, soul, log: () => {} })

// ---------- 1. 配置 ----------
section('1. 配置：archiveEnabled / archiveDays 30-3650 / archiveMaxFiles 默认 120')

await test('DEFAULT_CONFIG 有记忆罗盘默认值', () => {
  assert.equal(state.DEFAULT_CONFIG.archiveEnabled, true)
  assert.equal(state.DEFAULT_CONFIG.archiveDays, 365)
  assert.equal(state.DEFAULT_CONFIG.archiveMaxFiles, 120)
})

await test('normalizeConfig 夹取 archiveDays / archiveMaxFiles / 布尔', () => {
  let cfg = state.normalizeConfig({ archiveDays: 10, archiveMaxFiles: 1 })
  assert.equal(cfg.archiveDays, 30, '低于 30 夹到 30')
  assert.equal(cfg.archiveMaxFiles, 12, '低于 12 夹到 12')
  cfg = state.normalizeConfig({ archiveDays: 9999, archiveMaxFiles: 5000 })
  assert.equal(cfg.archiveDays, 3650, '高于 3650 夹到 3650')
  assert.equal(cfg.archiveMaxFiles, 120, '高于 120 夹到 120（保留上限）')
  cfg = state.normalizeConfig({ archiveEnabled: 'yes' })
  assert.equal(cfg.archiveEnabled, false, '非 true 一律 false')
  cfg = state.normalizeConfig({ archiveEnabled: false, archiveDays: 'abc' })
  assert.equal(cfg.archiveDays, 365, '非法天数回落默认')
})

await test('parseArchiveTime：epoch / 数字串 / YYYY-MM-DD 本地日界', () => {
  assert.equal(parseArchiveTime(1700000000000), 1700000000000)
  assert.equal(parseArchiveTime('1700000000000'), 1700000000000)
  const start = parseArchiveTime('2026-10-27')
  const end = parseArchiveTime('2026-10-27', { endOfDay: true })
  const date = new Date(start)
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 9)
  assert.equal(date.getDate(), 27)
  assert.equal(date.getHours(), 0)
  assert.equal(end - start, 86_400_000 - 1)
  assert.equal(parseArchiveTime(''), null)
  assert.equal(parseArchiveTime('nonsense'), null)
})

// ---------- 2. 写入 ----------
section('2. 写入：schema / 去重 / 跳过 / 截断 / 只存 Aura 会话')

await test('user 事件按月文件追加，schema 为 {t,at,sessionId,role,text}', () => {
  const at = Date.now() - 5000
  soul.emit('user', { sessionId: 'qq:test', text: '今天加班到十点', at })
  const file = archiveFile(at)
  assert.ok(existsSync(file), '应生成 YYYY-MM.jsonl')
  const rows = readLines(file)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.deepEqual(Object.keys(row).sort(), ['at', 'role', 'sessionId', 't', 'text'])
  assert.equal(row.at, at)
  assert.equal(row.sessionId, 'qq:test')
  assert.equal(row.role, 'user')
  assert.equal(row.text, '今天加班到十点')
  assert.equal(row.t, new Date(at).toISOString())
})

await test('同 session + role + 同文本 5 秒内去重，超过 5 秒再存', () => {
  const at = Date.now() - 4000
  soul.emit('assistant', { sessionId: 'qq:test', text: '那今晚早点睡', at })
  soul.emit('assistant', { sessionId: 'qq:test', text: '那今晚早点睡', at: at + 1000 })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === '那今晚早点睡').length, 1)
  soul.emit('assistant', { sessionId: 'qq:test', text: '那今晚早点睡', at: at + ARCHIVE_DEDUP_MS + 10 })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === '那今晚早点睡').length, 2)
  // 换个角色不算重复
  soul.emit('user', { sessionId: 'qq:test', text: '那今晚早点睡', at: at + 2000 })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === '那今晚早点睡').length, 3)
})

await test('空文本 / tool call / system 消息跳过', () => {
  const before = archiveStats(archive.dir).total
  soul.emit('user', { sessionId: 'qq:test', text: '   ', at: Date.now() })
  soul.emit('user', { sessionId: 'qq:test', text: '工具调用', tool: true, at: Date.now() })
  soul.emit('assistant', { sessionId: 'qq:test', text: '工具调用2', toolCall: { name: 'x' }, at: Date.now() })
  soul.emit('user', { role: 'system', sessionId: 'qq:test', text: '系统消息', at: Date.now() })
  assert.equal(archiveStats(archive.dir).total, before)
})

await test('单条 text 截到 4000 码点（不丢整条）', () => {
  const at = Date.now() - 3000
  soul.emit('user', { sessionId: 'qq:test', text: '字'.repeat(5000), at })
  const row = readLines(archiveFile(at)).find(item => item.at === at)
  assert.ok(row)
  assert.equal(Array.from(row.text).length, ARCHIVE_TEXT_MAX)
})

await test('普通网页会话不存；emotionScope=all 时才存', () => {
  const before = archiveStats(archive.dir).total
  soul.emit('user', { sessionId: 'web:dev-session', text: '这是普通网页会话', at: Date.now() - 2000 })
  assert.equal(archiveStats(archive.dir).total, before, '默认 emotionScope=qq 不存网页会话')
  state.writeConfig({ emotionScope: 'all' })
  const at = Date.now() - 1000
  soul.emit('user', { sessionId: 'web:dev-session', text: '这是普通网页会话', at })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === '这是普通网页会话').length, 1)
  state.writeConfig({ emotionScope: 'qq' })
})

await test('坏行跳过：手写坏 JSON 不影响搜索与统计', () => {
  const file = archiveFile()
  appendFileSync(file, '{this is not json}\n', 'utf8')
  appendFileSync(file, JSON.stringify({ t: 'x', at: Date.now(), sessionId: 'qq:test', role: 'user', text: '坏行之后的好行' }) + '\n', 'utf8')
  const rows = readArchiveMonth(file)
  assert.ok(rows.some(row => row.text === '坏行之后的好行'))
  assert.equal(rows.filter(row => row.text === '{this is not json}').length, 0)
})

// ---------- 3. 搜索 ----------
section('3. 搜索：全词优先 / 任一词 / 时间 / session / limit / 片段 / 空 query')

const now = Date.now()
const tA = now - 2 * 3600 * 1000
const tB = now - 90 * 60 * 1000
const tC = now - 60 * 60 * 1000
const tD = now - 30 * 60 * 1000
soul.emit('user', { sessionId: 'qq:test', text: '昨天咖啡喝多了睡不着', at: tA })
soul.emit('assistant', { sessionId: 'qq:test', text: '那今晚别喝了，早点睡', at: tB })
soul.emit('user', { sessionId: 'qq:test', text: '项目上线前要加班', at: tC })
soul.emit('assistant', { sessionId: 'qq:test', text: '加班也要吃饭', at: tD })
soul.emit('user', { sessionId: 'qq:other', text: '别的会话也在加班', at: now - 10 * 60 * 1000 })

await test('关键词：命中两条，按时间倒序', () => {
  const rows = searchArchive({ query: '加班' }, archive.dir)
  assert.equal(rows.length, 4)
  assert.ok(rows[0].at >= rows[1].at)
  for (const row of rows) {
    assert.ok(row.snippet.includes('加班'))
    assert.ok(row.score > 0)
    assert.ok(row.text.includes('加班'))
  }
})

await test('多个词：全部命中优先，只有部分命中的排在后面', () => {
  const rows = searchArchive({ query: '加班 吃饭' }, archive.dir)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].text, '加班也要吃饭', '全词命中排第一')
  assert.equal(rows[0].score, 1)
  for (const row of rows.slice(1)) assert.ok(row.score > 0 && row.score < 1, '只命中一个词排后面')
})

await test('时间过滤：from 之后 / to 之前（epoch ms）', () => {
  const after = searchArchive({ query: '加班', from: tB + 1 }, archive.dir)
  assert.equal(after.length, 4)
  const before = searchArchive({ query: '加班', to: tC - 1 }, archive.dir)
  assert.equal(before.length, 0, 'tC 之前没有加班记录')
  const between = searchArchive({ query: '加班', from: tC - 1, to: tD + 1 }, archive.dir)
  assert.equal(between.length, 2)
})

await test('时间过滤：YYYY-MM-DD 日期', () => {
  const day = dateKeyOf(tC)
  const rows = searchArchive({ query: '加班', from: day, to: day }, archive.dir)
  assert.ok(rows.length >= 2)
  for (const row of rows) assert.equal(dateKeyOf(row.at), day)
})

await test('sessionId 精确过滤', () => {
  const rows = searchArchive({ query: '加班', sessionId: 'qq:other' }, archive.dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'qq:other')
  const none = searchArchive({ query: '加班', sessionId: 'qq:nope' }, archive.dir)
  assert.equal(none.length, 0)
})

await test('limit 1–30 夹取', () => {
  assert.equal(searchArchive({ query: '加班', limit: 1 }, archive.dir).length, 1)
  assert.equal(searchArchive({ query: '加班', limit: 0 }, archive.dir).length, 1)
  assert.equal(searchArchive({ query: '加班', limit: 999 }, archive.dir).length, 4, '最多 30，实际只有 4 条')
})

await test('空 query 返回最近 N 条，按时间倒序', () => {
  const rows = searchArchive({ limit: 3 }, archive.dir)
  assert.equal(rows.length, 3)
  assert.ok(rows[0].at >= rows[1].at && rows[1].at >= rows[2].at)
  assert.ok(rows[0].at >= rows[1].at)
})

await test('片段：命中词前后各 40 码点，带省略号', () => {
  const long = '前'.repeat(60) + '关键证据' + '后'.repeat(60)
  const snippet = makeArchiveSnippet(long, ['关键证据'])
  assert.ok(snippet.includes('关键证据'))
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'))
  assert.ok(Array.from(snippet).length <= 40 * 2 + Array.from('关键证据').length + 4)
  const emptyQuery = makeArchiveSnippet('短句', [])
  assert.equal(emptyQuery, '短句')
})

// ---------- 4. 时间轴 ----------
section('4. 时间轴：按天补零 / 天数夹取 / 角色计数')

await test('timeline(days=30)：30 天、最后一天是今天、今天有计数', () => {
  const rows = timeline({ days: 30 }, archive.dir)
  assert.equal(rows.length, 30)
  assert.equal(rows[29].date, dateKeyOf(Date.now()))
  assert.equal(rows[0].date < rows[29].date, true)
  const today = rows[rows.length - 1]
  assert.ok(today.count >= 4)
  assert.ok(today.user >= 1 && today.assistant >= 1)
  const emptyDays = rows.filter(row => row.count === 0)
  assert.ok(emptyDays.length > 0, '缺失天应补 0')
})

await test('timeline 天数夹取：默认 30、最少 1、最多 365', () => {
  assert.equal(timeline({}, archive.dir).length, 30)
  assert.equal(timeline({ days: 0 }, archive.dir).length, 1)
  assert.equal(timeline({ days: 9999 }, archive.dir).length, 365)
})

await test('archiveStats：文件数 / 总条数 / 最早最晚', () => {
  const stats = archiveStats(archive.dir)
  assert.ok(stats.files >= 1)
  const recent = searchArchive({ limit: 30 }, archive.dir)
  assert.ok(stats.total >= recent.length, '总条数不应少于可见条数')
  assert.ok(stats.earliest > 0 && stats.latest >= stats.earliest)
})

// ---------- 5. 保留清理 ----------
section('5. 保留：archiveDays 超期月份 / archiveMaxFiles 只留最新')

await test('pruneArchive：删掉超期月份 + 只保留最新 N 个文件', () => {
  const dir = join(root, 'prune-dir')
  mkdirSync(dir, { recursive: true })
  for (const month of ['2020-01', '2020-02', '2020-03', '2020-04', '2020-05']) {
    writeFileSync(join(dir, month + '.jsonl'), '', 'utf8')
  }
  writeFileSync(join(dir, 'not-a-month.txt'), 'keep', 'utf8')
  const result = pruneArchive(dir, { days: 3650, maxFiles: 3 })
  const left = ['2020-01', '2020-02', '2020-03', '2020-04', '2020-05'].filter(month => existsSync(join(dir, month + '.jsonl')))
  assert.deepEqual(left, ['2020-03', '2020-04', '2020-05'])
  assert.ok(result.removed.includes('2020-01.jsonl'))
  assert.ok(existsSync(join(dir, 'not-a-month.txt')), '非月份文件不动')
})

await test('安装时清理超期文件', () => {
  const oldFile = join(dataDir, 'archive', '2000-01.jsonl')
  writeFileSync(oldFile, '', 'utf8')
  const localSoul = makeFakeSoul()
  const localCtx = makeFakeCtx()
  const local = initArchive({ ctx: localCtx.ctx, state, soul: localSoul, log: () => {} })
  assert.equal(existsSync(oldFile), false, '安装时应删除超期月份')
  local.dispose()
})

// ---------- 6. dispose ----------
section('6. dispose：清理监听器，之后不再写')

await test('dispose 后 soul 事件不再落盘', () => {
  const localSoul = makeFakeSoul()
  const localCtx = makeFakeCtx()
  const local = initArchive({ ctx: localCtx.ctx, state, soul: localSoul, log: () => {} })
  const at = Date.now() + 1000
  localSoul.emit('user', { sessionId: 'qq:dispose', text: 'dispose 之前', at })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === 'dispose 之前').length, 1)
  local.dispose()
  assert.equal(localSoul.count('user'), 0, 'dispose 应移除监听器')
  localSoul.emit('user', { sessionId: 'qq:dispose', text: 'dispose 之后', at: at + 10000 })
  assert.equal(readLines(archiveFile(at)).filter(row => row.text === 'dispose 之后').length, 0)
})

// ---------- 7. soul_archive 工具 ----------
section('7. 工具 soul_archive：注册 / 参数 / 执行 / 渲染')

await test('注册一次，参数完整，description 说明显式调用不注入', () => {
  const tool = fake.tools.find(item => item.name === 'soul_archive')
  assert.ok(tool, '应注册 soul_archive')
  assert.equal(fake.tools.filter(item => item.name === 'soul_archive').length, 1)
  const props = tool.parameters.properties
  for (const key of ['action', 'query', 'from', 'to', 'sessionId', 'limit', 'days']) {
    assert.ok(props[key], '应有参数 ' + key)
  }
  assert.ok(Array.isArray(tool.parameters.required) && tool.parameters.required.includes('action'), 'action 必填')
  assert.ok(tool.description.includes('search'))
  assert.ok(tool.description.includes('timeline'))
  assert.ok(/不.*(自动)?注入/.test(tool.description), '描述应说明不自动注入')
})

await test('execute(search)：返回片段并按参数过滤', async () => {
  const tool = fake.tools.find(item => item.name === 'soul_archive')
  const value = await tool.execute({ action: 'search', query: '加班', sessionId: 'qq:test', limit: 5 })
  assert.equal(value.ok, true)
  assert.equal(value.action, 'search')
  assert.equal(value.count, value.results.length)
  assert.ok(value.count >= 2)
  for (const row of value.results) {
    assert.equal(row.sessionId, 'qq:test')
    assert.ok(row.snippet.includes('加班'))
  }
  const text = tool.output.render({}, value)[0].text
  assert.ok(text.includes('存档搜索'))
  assert.ok(text.includes('加班'))
})

await test('execute(timeline) 与未知 action / 渲染兜底', async () => {
  const tool = fake.tools.find(item => item.name === 'soul_archive')
  const value = await tool.execute({ action: 'timeline', days: 7 })
  assert.equal(value.ok, true)
  assert.equal(value.timeline.length, 7)
  const text = tool.output.render({}, value)[0].text
  assert.ok(text.includes('最近 7 天'))
  const bad = await tool.execute({ action: 'nope' })
  assert.equal(bad.ok, false)
  assert.ok(renderArchiveToolText(bad).includes('存档没翻成'))
  assert.ok(renderArchiveToolText({ ok: true, action: 'search', results: [] }).includes('没有翻到'))
})

// ---------- 8. HTTP fence ----------
section('8. /dsh-aura/archive-api：loopback + Origin fence / state/search/timeline')

await test('注册 prefix 路由', () => {
  const registration = fake.registrations.find(item => item.path === ARCHIVE_API_PREFIX)
  assert.ok(registration)
  assert.equal(registration.kind, 'prefix')
})

await test('跨站 Origin / Sec-Fetch-Site 拒绝（403）', async () => {
  const registration = fake.registrations.find(item => item.path === ARCHIVE_API_PREFIX)
  const evilOrigin = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/state', headers: { origin: 'https://evil.example' } })
  assert.equal(evilOrigin.status, 403)
  assert.equal(evilOrigin.body.ok, false)
  const crossSite = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/state', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const loopback = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/state', headers: { origin: 'http://127.0.0.1:3080' } })
  assert.equal(loopback.status, 200, '本机 Origin 放行')
  const localhost = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/state', headers: { origin: 'http://localhost:3080' } })
  assert.equal(localhost.status, 200)
})

await test('GET state 返回文件数 / 总条数 / 最早最晚', async () => {
  const registration = fake.registrations.find(item => item.path === ARCHIVE_API_PREFIX)
  const res = await callApi(registration, { url: ARCHIVE_API_PREFIX })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.action, 'state')
  assert.ok(res.body.files >= 1)
  assert.ok(res.body.total > 0)
  assert.ok(res.body.earliest > 0 && res.body.latest >= res.body.earliest)
})

await test('GET timeline / search 与参数校验', async () => {
  const registration = fake.registrations.find(item => item.path === ARCHIVE_API_PREFIX)
  const timelineRes = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/timeline?days=7' })
  assert.equal(timelineRes.status, 200)
  assert.equal(timelineRes.body.timeline.length, 7)
  const searchRes = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/search?q=' + encodeURIComponent('加班') + '&session=qq:test&limit=5' })
  assert.equal(searchRes.status, 200)
  assert.ok(searchRes.body.results.length >= 2)
  for (const row of searchRes.body.results) assert.equal(row.sessionId, 'qq:test')
  const badLimit = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/search?q=' + encodeURIComponent('加班') + '&limit=0' })
  assert.equal(badLimit.body.results.length, 1, 'limit 夹到 1')
})

await test('POST search / state / 未知 action / 405', async () => {
  const registration = fake.registrations.find(item => item.path === ARCHIVE_API_PREFIX)
  const postSearch = await callApi(registration, {
    method: 'POST',
    url: ARCHIVE_API_PREFIX,
    body: { action: 'search', q: '加班', session: 'qq:test', limit: 3 },
  })
  assert.equal(postSearch.status, 200)
  assert.equal(postSearch.body.action, 'search')
  assert.ok(postSearch.body.results.length >= 2)
  const postState = await callApi(registration, { method: 'POST', url: ARCHIVE_API_PREFIX, body: { action: 'state' } })
  assert.equal(postState.status, 200)
  assert.ok(postState.body.total > 0)
  const postBad = await callApi(registration, { method: 'POST', url: ARCHIVE_API_PREFIX, body: { action: 'nope' } })
  assert.equal(postBad.status, 400)
  const put = await callApi(registration, { method: 'PUT', url: ARCHIVE_API_PREFIX })
  assert.equal(put.status, 405)
  const getBad = await callApi(registration, { url: ARCHIVE_API_PREFIX + '/nope' })
  assert.equal(getBad.status, 404)
})

await test('installArchive 是 initArchive 的安装别名', () => {
  assert.equal(typeof installArchive, 'function')
})

// ---------- 9. randomOld：随机旧事 -------------------------------------
section('9. randomOld：只抽 user 短句 / 排除会话 / seed 可复现 / 空存档')

function writeRows(dir, rows) {
  mkdirSync(dir, { recursive: true })
  for (const row of rows) {
    const file = join(dir, monthKeyOf(row.at) + '.jsonl')
    appendFileSync(file, JSON.stringify({
      t: new Date(row.at).toISOString(),
      at: row.at,
      sessionId: row.sessionId,
      role: row.role,
      text: row.text,
    }) + '\n', 'utf8')
  }
}

await test('randomOld：过滤 role/短句/超长，只返回 {text,at,sessionId}', () => {
  const dir = join(root, 'random-old-basic')
  const nowAt = Date.now()
  writeRows(dir, [
    { at: nowAt - 40 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '你还记得那次一起看海吗' },
    { at: nowAt - 41 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '太短' },
    { at: nowAt - 42 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '字'.repeat(300) },
    { at: nowAt - 43 * 86_400_000, sessionId: 'qq:a', role: 'assistant', text: '她说的旧话不算数' },
  ])
  const picked = randomOld({ before: nowAt, seed: 'basic' }, dir)
  assert.ok(picked, '应抽到一条')
  assert.deepEqual(Object.keys(picked).sort(), ['at', 'sessionId', 'text'])
  assert.equal(picked.text, '你还记得那次一起看海吗')
})

await test('randomOld：seed 可复现（同 seed 同一条）', () => {
  const dir = join(root, 'random-old-seed')
  const nowAt = Date.now()
  writeRows(dir, [
    { at: nowAt - 40 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '第一条值得翻出来的旧事' },
    { at: nowAt - 41 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '第二条值得翻出来的旧事' },
    { at: nowAt - 42 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '第三条值得翻出来的旧事' },
  ])
  const first = randomOld({ before: nowAt, seed: 'same-seed' }, dir)
  const second = randomOld({ before: nowAt, seed: 'same-seed' }, dir)
  assert.deepEqual(first, second)
  const randomA = seededRandom('seed-a')
  const randomB = seededRandom('seed-a')
  assert.equal(randomA(), randomB())
})

await test('randomOld：排除当前会话与 excludeText', () => {
  const dir = join(root, 'random-old-exclude')
  const nowAt = Date.now()
  writeRows(dir, [
    { at: nowAt - 40 * 86_400_000, sessionId: 'qq:now', role: 'user', text: '这是当前会话的旧话' },
    { at: nowAt - 41 * 86_400_000, sessionId: 'qq:old', role: 'user', text: '这是别的会话的旧话' },
  ])
  const picked = randomOld({ before: nowAt, excludeSessionId: 'qq:now', seed: 'x' }, dir)
  assert.equal(picked.text, '这是别的会话的旧话')
  const excludedText = randomOld({
    before: nowAt,
    excludeSessionId: 'qq:now',
    excludeText: '这是别的会话的旧话',
    seed: 'x',
  }, dir)
  assert.equal(excludedText, null, '唯一候选被 excludeText 排除后应安静返回 null')
})

await test('randomOld：before 边界只扫更早的月份；空目录返回 null', () => {
  const dir = join(root, 'random-old-before')
  writeRows(dir, [
    { at: new Date(2025, 0, 15, 12).getTime(), sessionId: 'qq:a', role: 'user', text: '一月里说过的旧事' },
    { at: new Date(2025, 1, 15, 12).getTime(), sessionId: 'qq:a', role: 'user', text: '二月里说过的旧事' },
  ])
  const boundary = new Date(2025, 1, 1).getTime()
  const picked = randomOld({ before: boundary, seed: 'before' }, dir)
  assert.ok(picked)
  assert.equal(picked.text, '一月里说过的旧事')
  const empty = join(root, 'random-old-empty')
  mkdirSync(empty, { recursive: true })
  assert.equal(randomOld({ before: Date.now() }, empty), null)
})

await test('randomOld：minChars/maxChars 可覆盖，archive api 也暴露 randomOld', () => {
  const dir = join(root, 'random-old-length')
  const nowAt = Date.now()
  writeRows(dir, [
    { at: nowAt - 40 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '短一点' },
    { at: nowAt - 41 * 86_400_000, sessionId: 'qq:a', role: 'user', text: '这是一个稍微长一点的旧句子' },
  ])
  const longOnly = randomOld({ before: nowAt, seed: 'len', minChars: 8, maxChars: 30 }, dir)
  assert.equal(longOnly.text, '这是一个稍微长一点的旧句子')
  const none = randomOld({ before: nowAt, seed: 'len', minChars: 30 }, dir)
  assert.equal(none, null)
  assert.equal(typeof archive.randomOld, 'function')
  const viaApi = archive.randomOld({ before: Date.now(), seed: 'api' })
  assert.ok(viaApi === null || (viaApi && typeof viaApi.text === 'string'))
})

// 收尾
archive.dispose()
fake.dispose()
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
