/**
 * 灵魂/人设/配置的版本备份与回滚（Host 侧）。
 *
 * 备份目录：$DSH_HOME/dsh-aura/backups/<YYYYMMDDTHHmmssSSS>-<label>/
 * 每个目录里是当时存在的 soul.json / persona.json / config.json / diary.json 副本，
 * 外加一份 manifest.json：{ id, at, label, files: [{ name, bytes, sha256 }] }。
 *
 * 设计约束：
 * - 零新增依赖、Node ESM；文件写入统一走 tmp + rename，避免半截文件。
 * - 快照永远「尽力而为」：调用方（soul/persona 的保存路径）失败只 warn，不阻塞保存。
 * - 回滚只覆盖备份里真实存在的文件，并且恢复前先给当前状态做一次 before-restore 快照，
 *   保证回滚本身可回滚。
 * - id 只允许 [A-Za-z0-9._-]，解析后再做一次 resolve 包含校验，拒绝 ../ 路径穿越。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { zipStore } from './meme-zip.js'

/** 与 host/persona.js 的 auraHome() 同口径：DSH_HOME 优先，否则 ~/.dsh-native。 */
export function auraHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh-native')
}

/** dsh-aura 数据目录（soul.json / persona.json / config.json 都在这）。 */
export function dataDir() {
  return join(auraHome(), 'dsh-aura')
}

/** 备份根目录。 */
export function backupsDir() {
  return join(dataDir(), 'backups')
}

/** 参与备份的文件；不存在就跳过。顺序即 manifest.files 顺序。 */
export const BACKUP_FILES = Object.freeze(['soul.json', 'persona.json', 'config.json', 'diary.json'])

/** 默认保留最近 30 份，超出删最旧。 */
export const RETAIN_LAST = 30

export const BACKUP_API_PREFIX = '/dsh-aura/backup-api'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const MAX_LABEL = 40

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function warnOf(log) {
  return typeof log === 'function' ? log : (...args) => console.warn('[dsh-aura]', ...args)
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** 本地时间戳：YYYYMMDDTHHmmssSSS（id 可字典序排序）。 */
function timestampOf(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
}

/** 标签清洗：只留 [A-Za-z0-9._-]，避免路径穿越和奇怪目录名。 */
export function sanitizeLabel(label) {
  const text = String(label ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, MAX_LABEL)
  return text || 'snapshot'
}

/**
 * 校验并解析备份目录。
 * 先按白名单校验 id，再 resolve 后确认仍在 backups 根目录内（双保险）。
 * @returns {string|null} 合法时返回绝对路径，否则 null
 */
export function resolveBackupDir(id) {
  const text = String(id ?? '')
  if (!ID_PATTERN.test(text)) return null
  const root = resolve(backupsDir())
  const target = resolve(root, text)
  if (target === root) return null
  if (!target.startsWith(root + sep)) return null
  const rel = relative(root, target)
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) return null
  return target
}

function manifestPath(dir) {
  return join(dir, 'manifest.json')
}

function readManifest(dir) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(dir), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null
    const files = Array.isArray(raw.files)
      ? raw.files
          .filter((item) => item && typeof item.name === 'string' && BACKUP_FILES.includes(item.name))
          .map((item) => ({
            name: item.name,
            bytes: Number.isFinite(item.bytes) ? item.bytes : 0,
            sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
          }))
      : []
    return {
      id: raw.id,
      at: typeof raw.at === 'string' ? raw.at : '',
      label: typeof raw.label === 'string' ? raw.label : '',
      files,
    }
  } catch {
    return null
  }
}

function writeManifest(dir, manifest) {
  const target = manifestPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8')
  renameSync(tmp, target)
}

function writeBufferAtomic(data, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  const tmp = `${destination}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, destination)
  return data
}

function entryTimestamp(entry) {
  const parsed = Date.parse(entry.at || '')
  return Number.isFinite(parsed) ? parsed : entry.mtimeMs
}

/** 扫描备份目录；无 manifest 的残留目录跳过。 */
function scanEntries() {
  const root = backupsDir()
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const entries = []
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue
    if (!ID_PATTERN.test(dirent.name)) continue
    const dir = join(root, dirent.name)
    const manifest = readManifest(dir)
    if (!manifest) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch {
      mtimeMs = 0
    }
    entries.push({ ...manifest, dir, mtimeMs })
  }
  return entries
}

/** 最新在前。 */
function sortNewestFirst(entries) {
  return entries.slice().sort((a, b) => {
    const delta = entryTimestamp(b) - entryTimestamp(a)
    if (delta !== 0) return delta
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    return b.id.localeCompare(a.id)
  })
}

/**
 * 删除超出保留上限的旧备份（最旧优先；同一时间戳按 mtime，再按 id）。
 * @param {number} [retainLast] 保留数量，默认 30；自测可注入更小的值
 * @returns {{ok:boolean, kept:number, removed:string[]}}
 */
export function prune(retainLast = RETAIN_LAST) {
  const limit = Number.isFinite(retainLast) && retainLast >= 0 ? Math.floor(retainLast) : RETAIN_LAST
  const entries = scanEntries()
  if (entries.length <= limit) return { ok: true, kept: entries.length, removed: [] }
  const ordered = sortNewestFirst(entries)
  const doomed = ordered.slice(limit)
  const removed = []
  for (const entry of doomed) {
    try {
      rmSync(entry.dir, { recursive: true, force: true })
      removed.push(entry.id)
    } catch {
      // 删不掉就留着；下次 prune 再试，不影响本次快照。
    }
  }
  return { ok: true, kept: ordered.length - removed.length, removed }
}

/**
 * 同步快照核心。公开 API 是 async snapshot()；这里额外导出给「同步保存点」用，
 * 让 soul.saveNow 这类同步写盘路径也能在落盘前完成拷贝。
 */
export function snapshotSync(label = 'manual', options = {}) {
  const at = new Date()
  const atIso = at.toISOString()
  const safeLabel = sanitizeLabel(label)
  const root = backupsDir()
  let id = `${timestampOf(at)}-${safeLabel}`
  try {
    mkdirSync(root, { recursive: true })
    let suffix = 1
    while (existsSync(join(root, id))) {
      id = `${timestampOf(at)}-${safeLabel}-${suffix}`
      suffix += 1
    }
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    const files = []
    for (const name of BACKUP_FILES) {
      const source = join(dataDir(), name)
      let stat
      try {
        stat = statSync(source)
      } catch {
        continue // 文件不存在：跳过
      }
      if (!stat.isFile()) continue
      const data = readFileSync(source)
      const target = join(dir, name)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, data)
      renameSync(tmp, target)
      files.push({ name, bytes: data.length, sha256: sha256(data) })
    }
    const manifest = { id, at: atIso, label: safeLabel, files }
    writeManifest(dir, manifest)
    const pruned = prune(options.retainLast)
    return {
      ok: true,
      id,
      at: atIso,
      label: safeLabel,
      files,
      pruned: pruned.removed,
    }
  } catch (error) {
    return { ok: false, error: errorText(error), id, at: atIso, label: safeLabel, files: [] }
  }
}

/**
 * 对当前 soul.json / persona.json / config.json / diary.json 做一次快照。
 * @param {string} [label='manual'] 目录名后缀，会被清洗
 * @param {{reason?: string, retainLast?: number}} [options]
 * @returns {Promise<{ok:boolean, id:string, at:string, label:string, files:Array}>}
 */
export async function snapshot(label = 'manual', options = {}) {
  return snapshotSync(label, options)
}

/**
 * 列出备份，最新在前。
 * @param {number} [limit=30]
 * @returns {Promise<Array<{id:string, at:string, label:string, files:Array}>>}
 */
export async function listBackups(limit = 30) {
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : RETAIN_LAST
  return sortNewestFirst(scanEntries())
    .slice(0, size)
    .map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      files: entry.files.map((item) => ({ ...item })),
    }))
}

/**
 * 回滚到指定备份。只覆盖备份里存在的文件；恢复前先 snapshot('before-restore')。
 * 可选 files 限定恢复哪些文件。
 * @param {string} id
 * @param {{files?: string[]}} [options]
 * @returns {Promise<{ok:boolean, backupId?:string, beforeRestore?:string, restored?:string[], skipped?:string[], error?:string}>}
 */
export async function restoreBackup(id, options = {}) {
  const dir = resolveBackupDir(id)
  if (!dir) return { ok: false, error: '非法的备份 id' }
  const manifest = readManifest(dir)
  if (!manifest) return { ok: false, error: `备份不存在或 manifest 损坏：${String(id)}` }

  const requestedRaw = Array.isArray(options.files) && options.files.length > 0
    ? [...new Set(options.files.map((name) => String(name)))]
    : null
  const requested = requestedRaw
    ? new Set(requestedRaw.filter((name) => BACKUP_FILES.includes(name)))
    : null
  const plan = manifest.files.filter((item) => !requested || requested.has(item.name))
  const skipped = requestedRaw
    ? requestedRaw.filter((name) => !manifest.files.some((item) => item.name === name))
    : []

  // 先校验完整性并把内容读进内存，再动任何文件。
  // （before-restore 快照可能触发保留上限裁剪，若目标正好是最旧备份，
  //  直接按路径读会在裁剪后失效；内存副本不受影响。）
  const contents = new Map()
  for (const item of plan) {
    const source = join(dir, item.name)
    let data
    try {
      data = readFileSync(source)
    } catch {
      return { ok: false, error: `备份文件缺失：${item.name}` }
    }
    if (item.sha256 && sha256(data) !== item.sha256) {
      return { ok: false, error: `备份文件校验失败：${item.name}` }
    }
    contents.set(item.name, data)
  }

  const before = await snapshot('before-restore', { reason: `restore:${manifest.id}` })
  if (!before || before.ok === false) {
    return { ok: false, error: `恢复前快照失败，已中止：${(before && before.error) || 'unknown'}` }
  }

  const restored = []
  for (const item of plan) {
    const data = contents.get(item.name)
    if (!data) {
      skipped.push(item.name)
      continue
    }
    try {
      writeBufferAtomic(data, join(dataDir(), item.name))
      restored.push(item.name)
    } catch (error) {
      return {
        ok: false,
        backupId: manifest.id,
        beforeRestore: before.id,
        restored,
        skipped,
        error: `写入 ${item.name} 失败：${errorText(error)}`,
      }
    }
  }

  return {
    ok: true,
    backupId: manifest.id,
    beforeRestore: before.id,
    restored,
    skipped,
  }
}

/**
 * 把一次备份打成 store 模式的 ZIP（复用 meme-zip.js，零依赖）。
 * @param {string} id
 * @returns {Buffer}
 */
export function exportBackupZip(id) {
  const dir = resolveBackupDir(id)
  if (!dir) throw new Error('非法的备份 id')
  const manifest = readManifest(dir)
  if (!manifest) throw new Error(`备份不存在或 manifest 损坏：${String(id)}`)
  const files = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }]
  for (const item of manifest.files) {
    const source = join(dir, item.name)
    try {
      files.push({ name: item.name, data: readFileSync(source) })
    } catch {
      // 缺失文件不进包，manifest 里仍有记录。
    }
  }
  return zipStore(files)
}

/* ------------------------------------------------------------------ */
/* HTTP API（/dsh-aura/backup-api）                                    */
/* ------------------------------------------------------------------ */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostIsLoopback(req) {
  const host = req && req.headers && req.headers.host
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

/** 与 host/persona.js / host/web.js 同口径：本机 Host + 非跨站 + Origin 缺省或同源。 */
function fence(req) {
  if (!hostIsLoopback(req)) return false
  const site = req.headers && req.headers['sec-fetch-site']
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req.headers && req.headers.origin
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
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolvePromise(value && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendZip(res, buffer, id) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'cache-control': 'no-store',
    'content-length': buffer.length,
    'content-disposition': `attachment; filename="dsh-aura-backup-${id}.zip"`,
  })
  res.end(buffer)
}

function createRegistration(warn) {
  return {
    kind: 'prefix',
    path: BACKUP_API_PREFIX,
    async handler(req, res) {
      if (!fence(req)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const url = new URL(String((req && req.url) || '/'), 'http://localhost')
      const route = url.pathname.replace(/^\/dsh-aura\/backup-api/, '') || '/'
      try {
        if (route !== '/' && route !== '') {
          json(res, 404, { ok: false, error: 'not found' })
          return
        }

        if (req.method === 'GET') {
          const action = url.searchParams.get('action') || 'list'
          if (action === 'list') {
            const raw = Number(url.searchParams.get('limit') || 20)
            const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.floor(raw))) : 20
            json(res, 200, { ok: true, backups: await listBackups(limit) })
            return
          }
          if (action === 'export') {
            const id = String(url.searchParams.get('id') || '')
            if (!resolveBackupDir(id)) {
              json(res, 400, { ok: false, error: '非法的备份 id' })
              return
            }
            const buffer = exportBackupZip(id)
            sendZip(res, buffer, id)
            return
          }
          json(res, 400, { ok: false, error: `未知的 action：${action}` })
          return
        }

        if (req.method === 'POST') {
          const body = await readBody(req)
          const action = String(body.action || '')
          if (action === 'snapshot') {
            const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'manual'
            const result = await snapshot(label, { reason: 'http' })
            if (!result.ok) {
              json(res, 500, { ok: false, error: result.error || '快照失败' })
              return
            }
            json(res, 200, {
              ok: true,
              id: result.id,
              at: result.at,
              label: result.label,
              files: result.files,
              pruned: result.pruned || [],
            })
            return
          }
          if (action === 'restore') {
            const id = String(body.id || '')
            if (!resolveBackupDir(id)) {
              json(res, 400, { ok: false, error: '非法的备份 id' })
              return
            }
            const result = await restoreBackup(id, { files: body.files })
            if (!result.ok) {
              json(res, 400, { ok: false, error: result.error || '恢复失败' })
              return
            }
            json(res, 200, {
              ok: true,
              restored: result.restored,
              backupId: result.backupId,
              beforeRestore: result.beforeRestore,
              skipped: result.skipped,
            })
            return
          }
          json(res, 400, { ok: false, error: `未知的 action：${action}` })
          return
        }

        json(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        warn('[aura] 备份 API 失败:', errorText(error))
        const message = errorText(error)
        const status = message === 'invalid json' || message === 'body too large' ? 400 : 500
        json(res, status, { ok: false, error: message })
      }
    },
  }
}

/**
 * 初始化备份模块：注册 /dsh-aura/backup-api，返回可直接调用的 API。
 * @param {{ctx?: any, state?: any, log?: Function}} [options]
 * @returns {{snapshot:Function, listBackups:Function, restoreBackup:Function, exportBackupZip:Function, prune:Function, dispose:Function}}
 */
export function initBackup({ ctx, state, log } = {}) {
  void state
  const warn = warnOf(log)
  const disposers = []
  let disposed = false

  const addDisposer = (value) => {
    if (typeof value === 'function') disposers.push(value)
    else if (value && typeof value.dispose === 'function') disposers.push(() => value.dispose())
  }

  try {
    const webServer = (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null) ||
      (ctx && ctx.webServer)
    if (webServer && typeof webServer.register === 'function') {
      const registration = createRegistration(warn)
      if (ctx && typeof ctx.effect === 'function') {
        addDisposer(ctx.effect(() => webServer.register(registration)))
      } else {
        addDisposer(webServer.register(registration))
      }
    } else {
      warn('[aura] 没有 webServer，备份 API 未注册')
    }
  } catch (error) {
    warn('[aura] 备份 API 注册失败:', errorText(error))
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.reverse()) {
      try {
        disposer()
      } catch {
        // ignore
      }
    }
    disposers.length = 0
  }

  return {
    snapshot: (label, options) => snapshot(label, options),
    listBackups: (limit) => listBackups(limit),
    restoreBackup: (id, options) => restoreBackup(id, options),
    exportBackupZip: (id) => exportBackupZip(id),
    prune: (retainLast) => prune(retainLast),
    dispose,
  }
}
