/**
 * dsh-aura 灵魂/人设/配置备份与回滚自测（node 直接跑）
 *   node dsh-aura/dev/backup-selftest.mjs
 *
 * 用临时 HOME / DSH_HOME 隔离，不碰真实的 soul/persona/config：
 *   快照目录与 manifest（sha256/bytes）/ 只备份存在的文件 / list 最新在前 /
 *   restore 覆盖内容且先自动 before-restore / 保留上限裁剪 / id 路径穿越拒绝 /
 *   export zip 合法 / HTTP 路由（list/snapshot/restore/export + fence）。
 * 路由用 fake ctx / req / res 直接调 handler，不依赖 DSH 宿主。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as backup from '../host/backup.js'
import { unzipStore } from '../host/meme-zip.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-backup-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh-native')
const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
mkdirSync(dataDir, { recursive: true })

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const writeData = (name, value) => writeFileSync(join(dataDir, name), JSON.stringify(value))
const readData = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function fakeReq(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

function fakeRes() {
  const out = { status: 0, headers: {}, body: null, buffer: null }
  return {
    out,
    writeHead(status, headers = {}) {
      out.status = status
      out.headers = headers
    },
    end(data) {
      const type = String(out.headers['content-type'] || '')
      if (Buffer.isBuffer(data) && type.includes('application/zip')) out.buffer = data
      else out.body = data && data.length ? JSON.parse(String(data)) : null
    },
  }
}

section('1. 路径与「存在才备份」')
await test('DSH_HOME 生效，备份目录在 dsh-aura/backups 下', () => {
  assert.equal(backup.auraHome(), process.env.DSH_HOME)
  assert.equal(backup.dataDir(), dataDir)
  assert.equal(backup.backupsDir(), join(dataDir, 'backups'))
})

let partial = null
await test('只存在 soul.json 时 files 只含 soul.json', async () => {
  writeData('soul.json', { v: 2, who: 'one' })
  partial = await backup.snapshot('one-file')
  assert.equal(partial.ok, true)
  assert.deepEqual(partial.files.map((f) => f.name), ['soul.json'])
  assert.ok(existsSync(join(backup.backupsDir(), partial.id, 'manifest.json')))
})

section('2. 快照与 manifest')
writeData('persona.json', { v: 1, style: 'casual' })
writeData('config.json', { soulPromptBudget: 1500 })
writeData('diary.json', { entries: ['今天上线'] })

let first = null
await test('快照复制全部四类文件并写 manifest（bytes / sha256）', async () => {
  const result = await backup.snapshot('t1', { reason: 'selftest' })
  first = result
  assert.equal(result.ok, true)
  assert.match(result.id, /^\d{8}T\d{9}-t1$/)
  assert.deepEqual(result.files.map((f) => f.name), ['soul.json', 'persona.json', 'config.json', 'diary.json'])
  assert.equal(result.files.length, 4)

  const dir = join(backup.backupsDir(), result.id)
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, result.id)
  assert.equal(manifest.at, result.at)
  assert.equal(manifest.label, 't1')
  assert.equal(manifest.files.length, 4)
  for (const item of manifest.files) {
    const disk = readFileSync(join(dir, item.name))
    assert.equal(item.bytes, disk.length)
    assert.equal(item.sha256, sha256(disk))
    assert.deepEqual(JSON.parse(disk.toString('utf8')), JSON.parse(readFileSync(join(dataDir, item.name), 'utf8')))
  }
})

await test('label 清洗后不能带路径分隔符', async () => {
  const result = await backup.snapshot('bad/../../label')
  assert.equal(result.ok, true)
  assert.ok(!result.id.includes('/'))
  assert.match(result.id, /^[A-Za-z0-9][A-Za-z0-9._-]+$/)
})

section('3. 列表最新在前 + export zip')
let second = null
await test('listBackups 最新在前', async () => {
  await sleep(5)
  writeData('soul.json', { v: 2, who: 'two' })
  second = await backup.snapshot('t2')
  const list = await backup.listBackups(10)
  assert.equal(list[0].id, second.id)
  assert.ok(list.findIndex((item) => item.id === first.id) > 0)
})

await test('exportBackupZip 产出合法 store 模式 ZIP', () => {
  const zip = backup.exportBackupZip(second.id)
  assert.ok(Buffer.isBuffer(zip))
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  const entries = unzipStore(zip)
  assert.ok(entries.has('manifest.json'))
  for (const name of ['soul.json', 'persona.json', 'config.json', 'diary.json']) assert.ok(entries.has(name))
  assert.deepEqual(JSON.parse(entries.get('soul.json').toString('utf8')), { v: 2, who: 'two' })
})

section('4. restore：覆盖 + 自动 before-restore + 只恢复指定文件')
await test('restore 回滚内容，并先自动快照 before-restore', async () => {
  writeData('soul.json', { v: 2, who: 'three' })
  const beforeCount = (await backup.listBackups(100)).length
  const result = await backup.restoreBackup(first.id)
  assert.equal(result.ok, true)
  assert.equal(result.backupId, first.id)
  assert.deepEqual(result.restored, ['soul.json', 'persona.json', 'config.json', 'diary.json'])
  assert.deepEqual(readData('soul.json'), { v: 2, who: 'one' })

  const list = await backup.listBackups(100)
  assert.equal(list.length, beforeCount + 1)
  const pre = list.find((item) => item.label === 'before-restore')
  assert.ok(pre, '应存在 before-restore 快照')
  assert.equal(result.beforeRestore, pre.id)
  assert.deepEqual(JSON.parse(readFileSync(join(backup.backupsDir(), pre.id, 'soul.json'), 'utf8')), { v: 2, who: 'three' })
})

await test('restore files 限定只覆盖 persona.json，未知文件名进 skipped', async () => {
  writeData('soul.json', { v: 2, who: 'keep-me' })
  writeData('persona.json', { v: 1, style: 'current' })
  const result = await backup.restoreBackup(second.id, { files: ['persona.json', 'not-a-backup.json'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.restored, ['persona.json'])
  assert.deepEqual(result.skipped, ['not-a-backup.json'])
  assert.deepEqual(readData('persona.json'), { v: 1, style: 'casual' })
  assert.deepEqual(readData('soul.json'), { v: 2, who: 'keep-me' })
})

section('5. 安全：id 白名单 + 路径穿越')
await test('非法 id 一律拒绝', async () => {
  for (const bad of ['../x', '..', '.', 'a/b', '', 'a b', '.hidden', 'x'.repeat(130)]) {
    assert.equal(backup.resolveBackupDir(bad), null, `应拒绝 ${bad}`)
    const result = await backup.restoreBackup(bad)
    assert.equal(result.ok, false)
  }
  assert.throws(() => backup.exportBackupZip('../x'), /非法/)
})

section('6. 保留上限裁剪')
await test('retainLast=3 时只留最新 3 份（最旧被删）', async () => {
  for (let index = 1; index <= 4; index += 1) {
    await sleep(3)
    const result = await backup.snapshot(`ret${index}`, { retainLast: 3 })
    assert.equal(result.ok, true)
  }
  const list = await backup.listBackups(100)
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((item) => item.label), ['ret4', 'ret3', 'ret2'])
  assert.ok(!existsSync(join(backup.backupsDir(), first.id)))
})

section('7. HTTP 路由（/dsh-aura/backup-api）')
const captured = { route: null }
const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(registration) {
        captured.route = registration
        return () => {}
      },
    }
  },
  effect(fn) {
    return fn()
  },
}
const instance = backup.initBackup({ ctx, state: {}, log: () => {} })

await test('initBackup 返回 { snapshot, listBackups, restoreBackup, dispose }，路由为 prefix', () => {
  assert.equal(typeof instance.snapshot, 'function')
  assert.equal(typeof instance.listBackups, 'function')
  assert.equal(typeof instance.restoreBackup, 'function')
  assert.equal(typeof instance.dispose, 'function')
  assert.ok(captured.route)
  assert.equal(captured.route.kind, 'prefix')
  assert.equal(captured.route.path, '/dsh-aura/backup-api')
  assert.equal(typeof captured.route.handler, 'function')
})

await test('GET ?action=list&limit=2', async () => {
  const res = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/backup-api?action=list&limit=2'), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.equal(res.out.body.backups.length, 2)
})

let httpSnapshot = null
await test('POST {action:"snapshot"} 手动快照', async () => {
  const res = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/backup-api', { action: 'snapshot', label: 'http-test' }), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.match(res.out.body.id, /-http-test$/)
  httpSnapshot = res.out.body
})

await test('GET ?action=export&id=... 返回 application/zip', async () => {
  const res = fakeRes()
  await captured.route.handler(fakeReq('GET', `/dsh-aura/backup-api?action=export&id=${encodeURIComponent(httpSnapshot.id)}`), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.headers['content-type'], 'application/zip')
  assert.ok(res.out.buffer)
  const entries = unzipStore(res.out.buffer)
  assert.ok(entries.has('manifest.json'))
  assert.ok(entries.has('soul.json'))
})

await test('POST {action:"restore"} 恢复并返回 restored / backupId', async () => {
  const res = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/backup-api', { action: 'restore', id: httpSnapshot.id }), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.equal(res.out.body.backupId, httpSnapshot.id)
  assert.ok(res.out.body.restored.includes('persona.json'))
})

await test('路径穿越 / 跨站 / 非本机 Host 被拒绝', async () => {
  const traversalRestore = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/backup-api', { action: 'restore', id: '../../etc/passwd' }), traversalRestore)
  assert.equal(traversalRestore.out.status, 400)
  assert.equal(traversalRestore.out.body.ok, false)

  const traversalExport = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/backup-api?action=export&id=../../etc/passwd'), traversalExport)
  assert.equal(traversalExport.out.status, 400)

  const badHost = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/backup-api?action=list', undefined, { host: 'evil.example:80' }), badHost)
  assert.equal(badHost.out.status, 403)

  const badOrigin = fakeRes()
  await captured.route.handler(fakeReq('GET', '/dsh-aura/backup-api?action=list', undefined, { origin: 'https://evil.example' }), badOrigin)
  assert.equal(badOrigin.out.status, 403)
})

await test('未知 action 返回 400；dispose 可重复调用', async () => {
  const res = fakeRes()
  await captured.route.handler(fakeReq('POST', '/dsh-aura/backup-api', { action: 'nope' }), res)
  assert.equal(res.out.status, 400)
  instance.dispose()
  instance.dispose()
})

section('8. 清理')
await test('临时目录可删除', () => {
  rmSync(root, { recursive: true, force: true })
  assert.equal(existsSync(root), false)
})

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
