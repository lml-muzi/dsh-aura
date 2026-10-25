/**
 * dsh-aura 表情包模块离线自测（不需要起 webServer、不连 QQ）。
 *
 * 运行：
 *   DSH_MEME_HOME="$PWD/../.devhome/meme-selftest" node dev/meme-selftest.mjs
 * 或直接（默认就落在 workspace/.devhome/meme-selftest）：
 *   node dev/meme-selftest.mjs
 *
 * 覆盖：合并图库（内置 dafeiyu-001 + 用户 pack）、关键词搜索、情绪抽样、
 * 上传→列表→更新→删除 roundtrip、图片路由与目录穿越、fence、
 * send_meme/learn_meme 工具、systemPrompt 段、getMemeState/dispose。
 * node:sqlite 在旧版 Node 需要 --experimental-sqlite；本机 Node 25 直接可用。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const workspace = resolve(pluginDir, '..')
const home = process.env.DSH_MEME_HOME || join(workspace, '.devhome', 'meme-selftest')
if (!home.includes('.devhome')) {
  console.error('DSH_MEME_HOME 必须指向 workspace/.devhome 下的隔离目录，拒绝动真实 ~/.dsh')
  process.exit(1)
}
process.env.DSH_MEME_HOME = home
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7ZkAAAAASUVORK5CYII=',
  'base64',
)
const SCHEMA = 'CREATE TABLE IF NOT EXISTS memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT, mtime REAL, captioned_at REAL)'
const API = '/dsh-aura/memes-api'
const IMAGES = '/dsh-aura/memes'

let passed = 0
function ok(label, condition) {
  assert.ok(condition, label)
  passed += 1
  console.log('  ✓ ' + label)
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected)
  passed += 1
  console.log('  ✓ ' + label)
}
function section(title) {
  console.log('\n[' + title + ']')
}

/* ---- 用户 pack：在隔离 home 里造一个真实 index.db ---- */
const packsRoot = join(home, '.dsh', 'meme-packs')
const testPackDir = join(packsRoot, 'testpack')
mkdirSync(join(testPackDir, 'memes', 'happy'), { recursive: true })
writeFileSync(join(testPackDir, 'memes', 'happy', 'test.png'), PNG)
{
  const db = new DatabaseSync(join(testPackDir, 'index.db'))
  db.exec(SCHEMA)
  db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('memes/happy/test.png', 'happy', 'test.png', '自测干饭猫', '测试 干饭 猫', Date.now(), Date.now())
  db.close()
}
writeFileSync(join(testPackDir, 'manifest.json'), JSON.stringify({ id: 'testpack', name: '自测图库', version: '1.0.0' }, null, 2))
mkdirSync(join(home, '.dsh'), { recursive: true })
writeFileSync(join(home, '.dsh', 'dsh-expression.json'), JSON.stringify({
  packId: 'dafeiyu-001',
  enabledPacks: ['dafeiyu-001', 'testpack'],
  sendMode: 'auto',
}, null, 2))

/* ---- 假 ctx：只实现表情包模块用到的服务 ---- */
function makeHarness() {
  const routes = new Map()
  const tools = new Map()
  const sections = []
  const disposers = []
  const webServer = {
    host: '127.0.0.1',
    port: 3080,
    register(route) {
      const key = route.kind + ':' + route.path
      if (routes.has(key)) throw new Error('duplicate route ' + key)
      routes.set(key, route)
      return () => routes.delete(key)
    },
  }
  const toolsService = {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  }
  const promptService = {
    section(entry) {
      sections.push(entry)
      return () => {
        const index = sections.indexOf(entry)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer,
    tools: toolsService,
    systemPrompt: promptService,
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'tools') return toolsService
      if (name === 'systemPrompt') return promptService
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, routes, tools, sections, disposers }
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
    },
  }
  Object.defineProperty(res, 'body', { get() { return Buffer.concat(this.chunks) } })
  Object.defineProperty(res, 'text', { get() { return this.body.toString('utf8') } })
  Object.defineProperty(res, 'json', { get() { return JSON.parse(this.text) } })
  return res
}

async function call(route, options) {
  const req = fakeReq(options)
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

async function main() {
  ok('内置图库 dafeiyu-001 已随包复制', existsSync(join(pluginDir, 'memes', 'dafeiyu-001', 'index.db')))

  const bridge = {
    chatOfSession(sessionId) {
      return sessionId === 'qq-session' ? { kind: 'dm', chatId: 'qq-chat', key: 'dm:qq-chat' } : null
    },
  }
  const logs = []
  const { initMeme, dispose, getMemeState, fenceRequest, hostIsLoopback } = await import('../host/meme.js')
  const harness = makeHarness()
  const handle = await initMeme({
    ctx: harness.ctx,
    state: {},
    log: (...parts) => logs.push(parts.join(' ')),
    bridge,
  })

  section('合并图库与搜索')
  {
    const list = handle.store.list()
    eq('合并后共 25 张（24 内置 + 1 用户）', list.memes.length, 25)
    ok('每条都有 pack 与绝对 path', list.memes.every(row => row.pack && isAbsolute(row.path) && existsSync(row.path)))
    const packs = handle.store.packs()
    ok('能扫描到内置与用户 pack', packs.some(p => p.id === 'dafeiyu-001') && packs.some(p => p.id === 'testpack'))
    eq('tags 是 6 个情绪桶', list.tags, ['happy', 'angry', 'sad', 'shy', 'confused', 'daily'])

    const found = handle.store.search('干饭', 10)
    ok('关键词搜索同时命中两个 pack', found.memes.some(m => m.pack === 'dafeiyu-001') && found.memes.some(m => m.pack === 'testpack'))
    const mood = handle.store.sampleMood('happy', '', 5)
    ok('情绪抽样 mood=happy 且非空', mood.mood === 'happy' && mood.memes.length > 0)
    const state = getMemeState()
    eq('getMemeState.count = 25', state.count, 25)
    ok('getMemeState 报告启用项', state.enabled.includes('dafeiyu-001') && state.enabled.includes('testpack'))
  }

  const apiRoute = harness.routes.get('prefix:' + API)
  const imageRoute = harness.routes.get('prefix:' + IMAGES)
  ok('已注册 API 路由', !!apiRoute)
  ok('已注册图片路由', !!imageRoute)

  section('上传 → 列表 → 图片 → 更新 → 删除')
  let uploaded
  {
    const res = await call(apiRoute, {
      method: 'POST',
      url: API,
      body: JSON.stringify({
        action: 'upload',
        data: PNG.toString('base64'),
        name: '自测图.png',
        tag: 'happy',
        caption: '自测上传图',
        keywords: '自测 上传 图',
      }),
    })
    eq('upload 返回 200', res.status, 200)
    uploaded = res.json.meme
    ok('upload 落到默认 aura 图库', uploaded.pack === 'aura')
    ok('upload 写入了绝对路径对应文件', isAbsolute(uploaded.path) && existsSync(uploaded.path))
    ok('默认用户图库 ~/.dsh/meme-packs/aura 已创建', existsSync(join(packsRoot, 'aura', 'index.db')))

    const listed = await call(apiRoute, { method: 'GET', url: API + '?action=list&pack=aura' })
    eq('列表里能看到刚上传的图', listed.json.total, 1)
    eq('列表条目 relPath 一致', listed.json.memes[0].relPath, uploaded.relPath)

    const imageUrl = IMAGES + '/' + uploaded.pack + '/' + uploaded.relPath.split('/').map(encodeURIComponent).join('/')
    const image = await call(imageRoute, { method: 'GET', url: imageUrl })
    eq('图片路由 200', image.status, 200)
    eq('Content-Type 按扩展名', image.headers['Content-Type'], 'image/png')
    ok('图片字节一致', Buffer.compare(image.body, PNG) === 0)

    const updated = await call(apiRoute, {
      method: 'POST',
      url: API,
      body: JSON.stringify({ action: 'update', pack: uploaded.pack, relPath: uploaded.relPath, caption: '改过的描述', keywords: '改过 关键词' }),
    })
    eq('update 返回 200', updated.status, 200)
    eq('update 后的 caption', updated.json.meme.caption, '改过的描述')
    const relisted = await call(apiRoute, { method: 'GET', url: API + '?action=list&pack=aura' })
    eq('列表读到更新后的 caption', relisted.json.memes[0].caption, '改过的描述')

    const deleted = await call(apiRoute, {
      method: 'POST',
      url: API,
      body: JSON.stringify({ action: 'delete', pack: uploaded.pack, relPath: uploaded.relPath }),
    })
    eq('delete 返回 200', deleted.status, 200)
    ok('文件已删除', !existsSync(uploaded.path))
    const afterDelete = await call(apiRoute, { method: 'GET', url: API + '?action=list&pack=aura' })
    eq('列表已不含删除项', afterDelete.json.total, 0)
  }

  section('路由围栏与目录穿越')
  {
    const badHost = await call(apiRoute, { method: 'GET', url: API + '?action=list', headers: { host: 'evil.example:3080' } })
    eq('非回环 Host 被拒（403）', badHost.status, 403)
    const badOrigin = await call(apiRoute, { method: 'GET', url: API + '?action=packs', headers: { origin: 'https://evil.example' } })
    eq('跨站 Origin 被拒（403）', badOrigin.status, 403)
    const goodOrigin = await call(apiRoute, { method: 'GET', url: API + '?action=packs', headers: { origin: 'http://127.0.0.1:3080' } })
    eq('同源 Origin 放行', goodOrigin.status, 200)
    ok('fenceRequest 直判同源', fenceRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }) === true)
    ok('hostIsLoopback 拒绝外部域名', hostIsLoopback({ headers: { host: 'evil.example' } }) === false)

    const traversal = await call(imageRoute, { method: 'GET', url: IMAGES + '/testpack/../../dsh-aura/host/meme.js' })
    eq('目录穿越 404', traversal.status, 404)
    const encodedTraversal = await call(imageRoute, { method: 'GET', url: IMAGES + '/testpack/%2e%2e/%2e%2e/host/web.js' })
    eq('编码穿越 404', encodedTraversal.status, 404)
  }

  section('发送方式 / setPack')
  {
    const textMode = await call(apiRoute, { method: 'POST', url: API, body: JSON.stringify({ action: 'setSendMode', mode: 'text' }) })
    eq('setSendMode text', textMode.json.sendMode, 'text')
    const sendMeme = harness.tools.get('send_meme')
    ok('send_meme 已注册', !!sendMeme)
    const textResult = await sendMeme.execute({ tag: 'happy', limit: 3 }, { agent: { session: { id: 'web-session' } } })
    ok('纯文字模式不发图、候选不带 path', textResult.ok === true && textResult.hits.every(hit => hit.path === undefined) && textResult.message.includes('纯文字'))

    await call(apiRoute, { method: 'POST', url: API, body: JSON.stringify({ action: 'setSendMode', mode: 'auto' }) })
    const webResult = await sendMeme.execute({ query: '干饭', limit: 2 }, { agent: { session: { id: 'web-session' } } })
    ok('Web 会话给 [表情: 描述] 写法', webResult.ok === true && webResult.hits.length === 2 && webResult.message.includes('[表情:') && webResult.message.includes('写进回复'))
    ok('候选里带绝对 path', webResult.hits.every(hit => isAbsolute(hit.path)))

    const qqResult = await sendMeme.execute({ query: '干饭', limit: 1 }, { agent: { session: { id: 'qq-session' } } })
    ok('QQ 会话提示 dsh_im_return_file', qqResult.ok === true && qqResult.message.includes('dsh_im_return_file') && isAbsolute(qqResult.hits[0].path))

    const off = await call(apiRoute, { method: 'POST', url: API, body: JSON.stringify({ action: 'setPack', packId: 'testpack', enabled: false }) })
    ok('setPack 关闭 testpack', !off.json.enabled.includes('testpack'))
    const listOff = await call(apiRoute, { method: 'GET', url: API + '?action=list' })
    ok('关闭后合并列表不再含 testpack', !listOff.json.memes.some(row => row.pack === 'testpack'))
    const on = await call(apiRoute, { method: 'POST', url: API, body: JSON.stringify({ action: 'setPack', packId: 'testpack', enabled: true }) })
    ok('setPack 重新打开 testpack', on.json.enabled.includes('testpack'))
  }

  section('learn_meme 与提示词')
  {
    const learnMeme = harness.tools.get('learn_meme')
    ok('learn_meme 已注册', !!learnMeme)
    const learned = await learnMeme.execute({
      path: join(testPackDir, 'memes', 'happy', 'test.png'),
      tag: 'shy',
      caption: '学来的测试图',
      keywords: '学图 自测',
    }, { agent: { session: { id: 'web-session', header: { cwd: workspace } } } })
    ok('显式 path 收录成功', learned.ok === true && existsSync(learned.path) && learned.tag === 'shy')
    const auraRows = handle.store.list({ pack: 'aura' }).memes
    ok('收录后能在 aura 列表看到', auraRows.some(row => row.relPath === learned.relPath))
    await call(apiRoute, {
      method: 'POST',
      url: API,
      body: JSON.stringify({ action: 'delete', pack: learned.pack, relPath: learned.relPath }),
    })

    const sectionEntry = harness.sections.find(entry => entry.name === 'aura:meme')
    ok('systemPrompt.section 已注册且 order=55', !!sectionEntry && sectionEntry.order === 55)
    const promptText = typeof sectionEntry.text === 'function' ? sectionEntry.text() : sectionEntry.text
    ok('提示词包含 Web/QQ 两种发送写法', promptText.includes('[表情:') && promptText.includes('dsh_im_return_file'))
  }

  section('卸载')
  {
    handle.dispose()
    ok('API 路由已摘除', !harness.routes.has('prefix:' + API))
    ok('图片路由已摘除', !harness.routes.has('prefix:' + IMAGES))
    ok('工具已摘除', !harness.tools.has('send_meme') && !harness.tools.has('learn_meme'))
    eq('dispose 后 getMemeState 归零', getMemeState().count, 0)
    dispose()
  }

  console.log('\n全部通过：' + passed + ' 项断言')
  const errLogs = logs.filter(line => /失败|error|Error/.test(line))
  if (errLogs.length) console.log('（初始化日志里有失败项：\n  ' + errLogs.join('\n  ') + '）')
}

try {
  await main()
} catch (error) {
  console.error('\n✗ 自测失败：', error)
  process.exitCode = 1
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
}
