/**
 * dsh-aura 表情包模块（Host 半）。
 *
 * 替代已停用的 dsh-meme：图库存储/搜索复用 host/meme-store.js（dsh-meme 的
 * memes.js，MIT），这里负责多图库合并、HTTP API、图片路由、模型工具和提示词。
 *
 * 数据兼容：
 *   - 设置沿用 ~/.dsh/dsh-expression.json（memeRoot / packId / enabledPacks / sendMode）；
 *   - 用户图库扫描 ~/.dsh/meme-packs，内置图库是 dsh-aura/memes/dafeiyu-001；
 *   - 每个图库一个 index.db（表 memes(path, tag, file_name, caption, keywords, mtime, captioned_at)）。
 *
 * 路由（只接受本机回环 + 同源）：
 *   GET  /dsh-aura/memes-api?action=list|packs|tags|state&pack=&tag=&query=
 *   GET  /dsh-aura/memes-api?action=export&pack=<id>   图库 ZIP（application/zip）
 *   POST /dsh-aura/memes-api  {action:'upload'|'update'|'delete'|'setPack'|'setSendMode'|'import', ...}
 *   GET  /dsh-aura/memes/<pack>/<relPath...>
 *
 * 工具：send_meme（挑候选/发图说明）、learn_meme（收录图片）。
 * 导出：initMeme({ ctx, state, log, bridge }) / dispose() / getMemeState()。
 *
 * node:sqlite 在旧版 Node（22.x）需要 --experimental-sqlite；本机 Node 25 可直接用
 * （只会打印 ExperimentalWarning）。不新增任何 npm 依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MemesStore,
  dshHome,
  defaultPacksDir,
  defaultMemeRoot,
  scanPacks,
  readPackMeta,
  enabledPackIds,
  openIndexWriter,
  searchRows,
  resolveMood,
  moodNames,
  SEND_MODES,
  normalizeSendMode,
} from './meme-store.js'
import { zipStore, unzipStore } from './meme-zip.js'

const PREFIX = '/dsh-aura/memes'
const API_PREFIX = '/dsh-aura/memes-api'
const DEFAULT_UPLOAD_PACK = 'aura'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 图库 ZIP 导入上限：压缩包本身（不是 base64 文本）不超过 100MB。 */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024
// ZIP 走 base64 传输（体积 +1/3），所以请求体上限要比图库包上限宽一档。
const MAX_BODY_BYTES = Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 1024 * 1024

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
}
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
const TAG_RE = /^[a-z0-9_-]{1,40}$/
const SCHEMA_SQL = 'CREATE TABLE IF NOT EXISTS memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT, mtime REAL, captioned_at REAL)'
const SELECT_ROW = "SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes WHERE path = ?"
const MOOD_DICT = 'happy 开心(卖萌/可爱/喜欢) / angry 生气 / sad 难过(无语/求饶) / shy 害羞 / confused 困惑惊讶 / daily 日常(睡觉/上班/早上好)'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/* ------------------------------------------------------------------ */
/* 请求围栏 / HTTP 小工具                                                */
/* ------------------------------------------------------------------ */

/** Host 头是否指向本机回环（与 host/web.js 的 fence 同一套判据）。 */
export function hostIsLoopback(req) {
  const raw = String(req?.headers?.host || '')
  if (!raw) return true
  let name = raw
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    name = end >= 0 ? raw.slice(0, end + 1) : raw
  } else {
    const colon = raw.lastIndexOf(':')
    if (colon > 0) name = raw.slice(0, colon)
  }
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

/** 本机回环 + 非跨站 + Origin 缺省或同源。图片与 API 共用。 */
export function fenceRequest(req) {
  if (!hostIsLoopback(req)) return false
  const site = req?.headers?.['sec-fetch-site']
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req?.headers?.origin
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

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大(>' + Math.round(limit / 1024 / 1024) + 'MB)'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolvePromise(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        reject(new Error('无效的 JSON 请求体'))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ */
/* 图片格式嗅探 / 文件名                                                */
/* ------------------------------------------------------------------ */

function sniffImageMime(buf) {
  if (!buf || buf.length < 3) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'
  if (buf.length >= 6 && buf.toString('latin1', 0, 6).startsWith('GIF8')) return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

function mimeOfName(name) {
  return MIME[extname(String(name || '')).slice(1).toLowerCase()] || ''
}

function sanitizeStem(name) {
  const base = basename(String(name || '')).replace(/\.[^.]+$/, '')
  const clean = base.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return clean || 'meme'
}

function validTag(value, fallback = '') {
  const tag = String(value ?? '').trim().toLowerCase()
  if (!tag) {
    if (fallback) return fallback
    throw new Error('tag 不能为空')
  }
  if (!TAG_RE.test(tag)) throw new Error('tag 只能是小写字母/数字/-/_')
  return tag
}

function clampLimit(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 8
  return Math.max(1, Math.min(20, Math.floor(n)))
}

function normalizeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.split('/').some(segment => !segment || segment === '..' || segment === '.')) return ''
  return rel
}

function shuffle(rows) {
  const copy = rows.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function takeImageRefs(content, out) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block && block.type === 'image' && block.attachment) out.push(block.attachment)
    if (block && block.type === 'tool-result') takeImageRefs(block.content, out)
  }
}

/** 会话里用户发过的图片附件（最近的在最后）。 */
function userImageRefs(exec) {
  const out = []
  const agent = exec?.agent
  const inbox = agent?.inbox
  if (inbox) {
    for (const message of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) takeImageRefs(message.content, out)
  }
  const session = agent?.session
  if (session && typeof session.deriveMessages === 'function') {
    for (const message of session.deriveMessages()) {
      if (message && message.role === 'user') takeImageRefs(message.content, out)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 模块生命周期                                                         */
/* ------------------------------------------------------------------ */

let current = null

/** 宿主 web.js 的 /state 扩展用：当前图库/启用项/发送方式/张数。 */
export function getMemeState() {
  if (!current) return { packs: [], enabled: [], sendMode: 'auto', count: 0 }
  try {
    return current.getState()
  } catch {
    return { packs: [], enabled: [], sendMode: 'auto', count: 0 }
  }
}

/** 卸载路由、工具与提示词段（重复调用安全）。 */
export function dispose() {
  const handle = current
  current = null
  if (handle) {
    try { handle.dispose() } catch { /* 卸载失败不影响下一次挂载 */ }
  }
}

/**
 * 挂载表情包模块。
 * @param {object} options
 * @param {object} options.ctx 插件上下文（需要 get('webServer')/tools/systemPrompt/attachments/llm）
 * @param {object} [options.state] dsh-aura state 模块（签名保留，暂不直接使用）
 * @param {Function} [options.log] 日志函数
 * @param {object} [options.bridge] dsh-aura ChannelBridge（用于判断 QQ 会话）
 * @returns {Promise<object>} 模块句柄（store/api/getState/dispose）
 */
export async function initMeme({ ctx, state, log, bridge } = {}) {
  if (!ctx) throw new Error('initMeme 需要 ctx')
  if (current) {
    try { current.dispose() } catch { /* 旧实例可能已卸一半 */ }
    current = null
  }

  const logger = (...parts) => {
    try {
      if (typeof log === 'function') log('[meme]', ...parts)
      else console.log('[dsh-aura/meme]', ...parts)
    } catch { /* 日志失败不影响运行 */ }
  }

  const settingsFile = join(dshHome(), '.dsh', 'dsh-expression.json')
  const settingsDir = dirname(settingsFile)

  const readSettingsFile = () => {
    try {
      const value = JSON.parse(readFileSync(settingsFile, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      return {}
    }
  }
  const writeSettings = patch => {
    try {
      mkdirSync(settingsDir, { recursive: true })
      const next = { ...readSettingsFile(), ...patch }
      const tmp = settingsFile + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(next, null, 2))
      renameSync(tmp, settingsFile)
      return next
    } catch (error) {
      logger('写设置失败:', error instanceof Error ? error.message : error)
      return readSettingsFile()
    }
  }
  const currentSendMode = () => normalizeSendMode(readSettingsFile().sendMode)
  const packsDirNow = () => {
    const saved = readSettingsFile().packsDir
    return saved ? String(saved) : defaultPacksDir()
  }
  const listPacks = () => {
    try {
      return scanPacks(packsDirNow())
    } catch (error) {
      logger('扫描图库失败:', error instanceof Error ? error.message : error)
      return []
    }
  }

  // 首次挂载、还没有设置文件时：默认启用随包分发的大肥鱼。
  if (!existsSync(settingsFile)) {
    const initial = listPacks()
    const preferred = initial.find(pack => pack.id === 'dafeiyu-001') || initial[0]
    writeSettings({
      memeRoot: preferred?.path || defaultMemeRoot(),
      packId: preferred?.id || '',
      enabledPacks: preferred ? [preferred.id] : [],
      sendMode: 'auto',
    })
  }

  const activePackId = (packs = listPacks()) => {
    const saved = readSettingsFile()
    const explicit = String(saved.packId || '').trim()
    if (explicit && packs.some(pack => pack.id === explicit)) return explicit
    if (saved.memeRoot) {
      const root = resolve(String(saved.memeRoot))
      const hit = packs.find(pack => resolve(pack.path) === root)
      if (hit) return hit.id
    }
    return (packs.find(pack => pack.id === 'dafeiyu-001') || packs[0])?.id || ''
  }
  const enabledIds = (packs = listPacks()) => enabledPackIds(readSettingsFile(), packs, activePackId(packs))
  const packById = (id, packs = listPacks()) => packs.find(pack => pack.id === id) || null

  const urlOf = (packId, relPath) => {
    const rel = String(relPath || '').split('/').map(encodeURIComponent).join('/')
    return PREFIX + '/' + encodeURIComponent(packId) + '/' + rel
  }

  const rowsOfPack = pack => {
    const root = resolve(pack.path)
    let store
    try {
      store = new MemesStore(pack.path)
      const { memes } = store.list()
      const rows = []
      for (const row of memes) {
        const relPath = String(row.path || '').replace(/\\/g, '/')
        if (!relPath) continue
        const absolute = resolve(root, relPath)
        if (absolute !== root && !absolute.startsWith(root + sep)) continue
        rows.push({
          pack: pack.id,
          path: absolute,
          relPath,
          tag: String(row.tag || ''),
          caption: String(row.caption || ''),
          keywords: String(row.keywords || ''),
          file_name: String(row.file_name || basename(relPath)),
        })
      }
      return rows
    } catch {
      return []
    } finally {
      try { store?.close() } catch { /* 已关闭 */ }
    }
  }

  const filterRows = (rows, tag, query) => {
    let out = rows
    const wanted = String(tag || '').trim().toLowerCase()
    if (wanted) {
      const wantedMood = resolveMood(wanted)
      out = out.filter(row => {
        const rowTag = row.tag.toLowerCase()
        if (rowTag === wanted) return true
        if (!wantedMood) return false
        return resolveMood(rowTag) === wantedMood
      })
    }
    const text = String(query || '').trim().toLowerCase()
    if (text) {
      const tokens = text.split(/\s+/).filter(Boolean)
      out = out.filter(row => {
        const hay = (row.tag + ' ' + row.caption + ' ' + row.keywords + ' ' + row.file_name).toLowerCase()
        return tokens.some(token => hay.includes(token))
      })
    }
    return out
  }

  const packPayload = (packs, enabled) => packs.map(pack => ({
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    count: pack.count,
    cover: pack.cover,
    coverUrl: pack.cover ? urlOf(pack.id, pack.cover) : '',
    path: pack.path,
    source: pack.source,
    enabled: enabled.includes(pack.id),
  }))

  const allRows = (ids, packs) => {
    const byId = new Map(packs.map(pack => [pack.id, pack]))
    const rows = []
    for (const id of ids) {
      const pack = byId.get(id)
      if (pack) rows.push(...rowsOfPack(pack))
    }
    return rows
  }

  const store = {
    get root() {
      const pack = packById(activePackId())
      return pack ? pack.path : ''
    },
    activePackId,
    enabledIds,
    tags() {
      return moodNames()
    },
    packs() {
      const packs = listPacks()
      const enabled = enabledPackIds(readSettingsFile(), packs, activePackId(packs))
      return packPayload(packs, enabled)
    },
    /** 多图库合并列表；不传 pack 时只合并启用中的图库。 */
    list({ pack = '', tag = '', query = '' } = {}) {
      const packs = listPacks()
      const enabled = enabledPackIds(readSettingsFile(), packs, activePackId(packs))
      let ids = enabled
      if (pack) ids = packs.some(item => item.id === pack) ? [pack] : []
      const rows = filterRows(allRows(ids, packs), tag, query)
      return { memes: rows, packs: packPayload(packs, enabled), tags: moodNames(), enabled }
    },
    /** 关键词搜索（合并后统一排序，复用 dsh-meme 的 searchRows）。 */
    search(query, limit = 8, tag = '') {
      const { memes: rows } = store.list({ tag })
      return { ...searchRows(rows, query, clampLimit(limit)), tags: moodNames() }
    },
    /** 情绪桶随机抽样（复用 resolveMood / MOODS 语义）。 */
    sampleMood(tag, query, limit = 8) {
      const tags = moodNames()
      const ids = enabledIds()
      if (ids.length === 0) return { mood: null, memes: [], tags, reason: '当前没有打开任何图库，去设置里把要用的图库开关打开' }
      const mood = resolveMood(tag, query)
      if (!mood) return { mood: null, memes: [], tags }
      const { memes: rows } = store.list({ tag: mood })
      const pool = rows.filter(row => resolveMood(row.tag) === mood)
      return { mood, memes: shuffle(pool).slice(0, clampLimit(limit)), tags }
    },
    find(packId, relPath) {
      const pack = packById(packId)
      const rel = normalizeRel(relPath)
      if (!pack || !rel) return null
      const row = readRow(pack, rel)
      if (!row) return null
      return publicMeme({
        pack: pack.id,
        path: resolve(pack.path, rel),
        relPath: rel,
        tag: String(row.tag || ''),
        caption: String(row.caption || ''),
        keywords: String(row.keywords || ''),
        file_name: String(row.file_name || basename(rel)),
      })
    },
    count() {
      return store.packs().filter(pack => pack.enabled).reduce((sum, pack) => sum + (Number(pack.count) || 0), 0)
    },
    refresh() { /* 每次操作都现读 index.db，无需缓存刷新 */ },
  }

  const publicMeme = row => ({
    pack: row.pack,
    path: row.path,
    relPath: row.relPath,
    tag: row.tag,
    caption: row.caption,
    keywords: row.keywords,
    file_name: row.file_name,
    url: urlOf(row.pack, row.relPath),
  })

  const resolvePackFile = (pack, relPath) => {
    const root = resolve(pack.path)
    const absolute = resolve(root, relPath)
    if (absolute !== root && !absolute.startsWith(root + sep)) return null
    return absolute
  }

  const readRow = (pack, relPath) => {
    try {
      const db = new DatabaseSync(join(pack.path, 'index.db'), { readOnly: true })
      try {
        return db.prepare(SELECT_ROW).get(relPath) || null
      } finally {
        try { db.close() } catch { /* 已关闭 */ }
      }
    } catch {
      return null
    }
  }

  const insertRow = (pack, relPath, tag, fileName, caption, keywords) => {
    const now = Date.now()
    const writer = openIndexWriter(pack.path)
    try {
      writer.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(relPath, tag, fileName, caption, keywords, now, now)
    } finally {
      try { writer.close() } catch { /* 已关闭 */ }
    }
  }

  const ensurePack = (id = DEFAULT_UPLOAD_PACK) => {
    const packId = String(id || DEFAULT_UPLOAD_PACK).trim() || DEFAULT_UPLOAD_PACK
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(packId)) throw new Error('图库 ID 只能是小写字母/数字/-/_')
    const root = join(packsDirNow(), packId)
    mkdirSync(root, { recursive: true })
    const indexPath = join(root, 'index.db')
    if (!existsSync(indexPath)) {
      const db = new DatabaseSync(indexPath)
      try { db.exec(SCHEMA_SQL) } finally { try { db.close() } catch { /* 已关闭 */ } }
    }
    const manifestPath = join(root, 'manifest.json')
    if (!existsSync(manifestPath)) {
      writeFileSync(manifestPath, JSON.stringify({
        id: packId,
        name: packId === DEFAULT_UPLOAD_PACK ? 'Aura 图库' : packId,
        version: '1.0.0',
      }, null, 2))
    }
    return readPackMeta(root, packId, 'user')
  }

  const ensureEnabled = packId => {
    const packs = listPacks()
    const currentIds = enabledPackIds(readSettingsFile(), packs, activePackId(packs))
    if (currentIds.includes(packId)) return currentIds
    const next = [...new Set([...currentIds, packId])]
    writeSettings({ enabledPacks: next })
    return next
  }

  const uploadMeme = body => {
    const tag = validTag(body?.tag, 'daily')
    let raw = String(body?.data ?? body?.dataBase64 ?? '')
    const comma = raw.indexOf(',')
    if (/^data:/i.test(raw) && comma >= 0) raw = raw.slice(comma + 1)
    const buf = Buffer.from(String(raw).replace(/\s+/g, ''), 'base64')
    if (!buf.length) throw new Error('缺少图片数据')
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片大小超限(≤8MB)')
    const sniffed = sniffImageMime(buf)
    const named = extname(String(body?.name || '')).toLowerCase()
    const ext = (sniffed && EXT_BY_MIME[sniffed]) || (IMAGE_EXTS.has(named) ? named : '')
    if (!ext) throw new Error('仅支持 jpg/png/gif/webp 图片')
    const packId = String(body?.packId || DEFAULT_UPLOAD_PACK).trim() || DEFAULT_UPLOAD_PACK
    let pack = packById(packId)
    if (!pack) {
      if (packId !== DEFAULT_UPLOAD_PACK) throw new Error('未知图库: ' + packId)
      pack = ensurePack(packId)
    }
    const caption = String(body?.caption || '').trim().slice(0, 200)
    const keywords = String(body?.keywords || '').trim().slice(0, 200)
    const fileName = sanitizeStem(body?.name) + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + ext
    const relPath = ['memes', tag, fileName].join('/')
    mkdirSync(join(pack.path, 'memes', tag), { recursive: true })
    writeFileSync(join(pack.path, relPath), buf)
    insertRow(pack, relPath, tag, fileName, caption, keywords)
    ensureEnabled(pack.id)
    return publicMeme({
      pack: pack.id,
      path: resolve(pack.path, relPath),
      relPath,
      tag,
      caption,
      keywords,
      file_name: fileName,
    })
  }

  const updateMeme = body => {
    const packId = String(body?.pack || '').trim()
    const relPath = normalizeRel(body?.relPath)
    if (!packId || !relPath) throw new Error('需要 pack 与 relPath')
    const pack = packById(packId)
    if (!pack) throw new Error('未知图库: ' + packId)
    const row = readRow(pack, relPath)
    if (!row) throw new Error('未知路径: ' + relPath)
    const tag = body?.tag != null && String(body.tag).trim() ? validTag(body.tag) : String(row.tag || '')
    const caption = body?.caption != null ? String(body.caption).trim().slice(0, 200) : String(row.caption || '')
    const keywords = body?.keywords != null ? String(body.keywords).trim().slice(0, 200) : String(row.keywords || '')
    const writer = openIndexWriter(pack.path)
    try {
      writer.prepare('UPDATE memes SET tag = ?, caption = ?, keywords = ? WHERE path = ?').run(tag, caption, keywords, relPath)
    } finally {
      try { writer.close() } catch { /* 已关闭 */ }
    }
    return publicMeme({
      pack: pack.id,
      path: resolve(pack.path, relPath),
      relPath,
      tag,
      caption,
      keywords,
      file_name: String(row.file_name || basename(relPath)),
    })
  }

  const deleteMeme = body => {
    const packId = String(body?.pack || '').trim()
    const relPath = normalizeRel(body?.relPath)
    if (!packId || !relPath) throw new Error('需要 pack 与 relPath')
    const pack = packById(packId)
    if (!pack) throw new Error('未知图库: ' + packId)
    const row = readRow(pack, relPath)
    if (!row) throw new Error('未知路径: ' + relPath)
    const writer = openIndexWriter(pack.path)
    try {
      writer.prepare('DELETE FROM memes WHERE path = ?').run(relPath)
    } finally {
      try { writer.close() } catch { /* 已关闭 */ }
    }
    const file = resolvePackFile(pack, relPath)
    if (file) {
      try { unlinkSync(file) } catch { /* 文件可能已不存在 */ }
    }
    return { pack: pack.id, relPath }
  }

  const setPack = body => {
    const packId = String(body?.packId || '').trim()
    if (!packId) throw new Error('未指定图库')
    const packs = listPacks()
    if (!packs.some(pack => pack.id === packId)) throw new Error('未知图库: ' + packId)
    const currentIds = enabledPackIds(readSettingsFile(), packs, activePackId(packs))
    const enabled = body?.enabled !== false
    const next = enabled
      ? [...new Set([...currentIds, packId])]
      : currentIds.filter(id => id !== packId)
    writeSettings({ enabledPacks: next })
    return { packId, enabled: next.includes(packId), enabledPacks: next }
  }

  const setSendMode = body => {
    const mode = String(body?.mode ?? body?.sendMode ?? '').trim()
    if (!SEND_MODES.includes(mode)) throw new Error('发送方式只能是 auto / text / image')
    writeSettings({ sendMode: mode })
    return { sendMode: mode }
  }

  /* ---------------- 图库 ZIP 导出 / 导入 ---------------- */

  /** 图库 id 清洗：manifest.id / 文件名 → 目录名（与 ensurePack 的规则一致）。 */
  const slugId = value => String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

  /** ZIP 条目名不安全的原因；空串表示安全。拒绝绝对路径、盘符、反斜杠与 ..。 */
  const unsafeEntryName = name => {
    const raw = String(name || '')
    if (!raw) return '空条目名'
    if (raw.includes('\0')) return '含 NUL'
    if (raw.includes('\\')) return '含反斜杠'
    if (raw.startsWith('/')) return '绝对路径'
    if (/^[a-zA-Z]:/.test(raw)) return '带盘符的路径'
    if (raw.split('/').some(part => part === '..')) return '含 .. 路径段'
    return ''
  }

  /** 按 index.db 的行收集一个图库的 ZIP 内容：index.db + manifest.json（存在时）+ 索引图片。 */
  const buildPackZip = pack => {
    const root = resolve(pack.path)
    const dbPath = join(root, 'index.db')
    let rows
    try {
      const db = new DatabaseSync(dbPath)
      try {
        // index.db 可能是 WAL 模式，先把 WAL 里的改动并回主库，导出才完整。
        try { db.exec('PRAGMA wal_checkpoint(FULL)') } catch { /* 只读或无 WAL */ }
        rows = db.prepare('SELECT path FROM memes').all().map(row => String(row.path || ''))
      } finally {
        try { db.close() } catch { /* 已关闭 */ }
      }
    } catch (error) {
      throw new Error('图库索引不可读: ' + (error instanceof Error ? error.message : String(error)))
    }
    const files = [{ name: 'index.db', data: readFileSync(dbPath) }]
    const manifestPath = join(root, 'manifest.json')
    if (existsSync(manifestPath)) files.push({ name: 'manifest.json', data: readFileSync(manifestPath) })
    let images = 0
    for (const rowPath of rows) {
      const rel = normalizeRel(rowPath)
      if (!rel) continue
      const full = resolve(root, rel)
      if (full === root || !full.startsWith(root + sep)) continue
      try {
        if (!statSync(full).isFile()) continue
        files.push({ name: rel, data: readFileSync(full) })
        images += 1
      } catch { /* 索引里有、盘上已经没有的行直接跳过 */ }
    }
    if (images === 0) throw new Error('空图库，没有可导出的图片')
    return zipStore(files)
  }

  /** 解包 + 校验 + 落盘到 ~/.dsh/meme-packs/<id>，并自动写 enabledPacks。 */
  const importPack = body => {
    let raw = String(body?.data ?? body?.dataBase64 ?? '')
    const comma = raw.indexOf(',')
    if (/^data:/i.test(raw) && comma >= 0) raw = raw.slice(comma + 1)
    raw = raw.replace(/\s+/g, '')
    if (!raw) throw new Error('缺少 ZIP 数据')
    if (raw.length > Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 8) throw new Error('压缩包过大(≤100MB)')
    const buf = Buffer.from(raw, 'base64')
    if (!buf.length) throw new Error('ZIP 数据为空或不是合法 base64')
    if (buf.length > MAX_IMPORT_BYTES) throw new Error('压缩包过大(≤100MB)')
    let entries
    try {
      entries = unzipStore(buf)
    } catch (error) {
      throw new Error('解包失败: ' + (error instanceof Error ? error.message : String(error)))
    }
    for (const name of entries.keys()) {
      const reason = unsafeEntryName(name)
      if (reason) throw new Error('ZIP 条目路径不安全(' + reason + '): ' + name)
    }
    if (!entries.has('index.db')) throw new Error('ZIP 里没有 index.db，不是表情包图库')
    let manifest = {}
    const manifestRaw = entries.get('manifest.json')
    if (manifestRaw && manifestRaw.length > 0) {
      try {
        manifest = JSON.parse(manifestRaw.toString('utf8'))
      } catch {
        throw new Error('manifest.json 不是合法 JSON')
      }
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json 结构不对')
    const baseId = slugId(manifest.id) || slugId(body?.name) || 'meme-pack'
    const root = resolve(packsDirNow())
    mkdirSync(root, { recursive: true })
    // 同名图库已存在就往后排：<id>-imported-1、-imported-2 …
    let id = baseId
    let n = 0
    while (existsSync(join(root, id))) {
      n += 1
      id = baseId + '-imported-' + n
    }
    const target = resolve(join(root, id))
    if (target === root || !target.startsWith(root + sep)) throw new Error('图库目录越界')
    const stage = resolve(join(root, '.' + id + '.tmp-' + process.pid + '-' + Date.now().toString(36)))
    if (stage === root || !stage.startsWith(root + sep)) throw new Error('临时目录越界')
    let count = 0
    try {
      mkdirSync(stage, { recursive: true })
      for (const [name, data] of entries) {
        if (!name || name.endsWith('/')) continue
        const full = resolve(stage, name)
        if (full === stage || !full.startsWith(stage + sep)) throw new Error('ZIP 条目路径越界: ' + name)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, data)
      }
      let db
      try {
        db = new DatabaseSync(join(stage, 'index.db'), { readOnly: true })
      } catch {
        throw new Error('index.db 无法打开')
      }
      try {
        count = Number(db.prepare('SELECT COUNT(*) AS n FROM memes').get().n) || 0
      } catch {
        throw new Error('index.db 里没有可读的 memes 表')
      } finally {
        try { db.close() } catch { /* 已关闭 */ }
      }
      if (count === 0) throw new Error('空图库，没有可导入的图片')
      renameSync(stage, target)
    } catch (error) {
      try { rmSync(stage, { recursive: true, force: true }) } catch { /* 清理失败不影响原报错 */ }
      throw error
    }
    const packsBefore = listPacks()
    const enabledBefore = enabledPackIds(readSettingsFile(), packsBefore, activePackId(packsBefore))
    const enabled = [...new Set([...enabledBefore, id])]
    writeSettings({ enabledPacks: enabled })
    const packs = packPayload(listPacks(), enabled)
    const pack = packs.find(item => item.id === id) || null
    return { pack, packs, enabled, count }
  }

  const getState = () => {
    const packs = store.packs()
    const enabled = packs.filter(pack => pack.enabled).map(pack => pack.id)
    const count = packs.filter(pack => pack.enabled).reduce((sum, pack) => sum + (Number(pack.count) || 0), 0)
    return { packs, enabled, sendMode: currentSendMode(), count, packId: activePackId(), memeRoot: store.root }
  }

  /* ---------------- HTTP API ---------------- */

  const handleApi = async (req, res) => {
    if (!fenceRequest(req)) {
      json(res, 403, { ok: false, error: '拒绝: 只接受本机(回环地址)的同源请求' })
      return
    }
    try {
      if (req.method === 'GET') {
        const url = new URL(String(req.url || '/'), 'http://localhost')
        const action = String(url.searchParams.get('action') || 'list')
        if (action === 'packs') {
          return json(res, 200, { ok: true, packs: store.packs(), enabled: enabledIds(), sendMode: currentSendMode() })
        }
        if (action === 'tags') {
          return json(res, 200, { ok: true, tags: store.tags() })
        }
        if (action === 'state') {
          return json(res, 200, { ok: true, ...getState() })
        }
        if (action === 'export') {
          const wanted = String(url.searchParams.get('pack') || '').trim()
          const pack = wanted ? packById(wanted) : packById(activePackId())
          if (!pack) {
            return json(res, 400, { ok: false, error: wanted ? '图库不存在: ' + wanted : '没有可导出的图库' })
          }
          // 二进制响应：不走 json()，直接写 zip 字节。
          const zip = buildPackZip(pack)
          const stamp = new Date().toISOString().slice(0, 10)
          const safeName = String(pack.id).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'pack'
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': String(zip.byteLength),
            'Content-Disposition': 'attachment; filename="dsh-aura-pack-' + safeName + '-' + stamp + '.zip"',
            'Cache-Control': 'no-store',
          })
          res.end(zip)
          return
        }
        if (action !== 'list') {
          return json(res, 400, { ok: false, error: '未知 action: ' + action })
        }
        const result = store.list({
          pack: String(url.searchParams.get('pack') || '').trim(),
          tag: String(url.searchParams.get('tag') || '').trim(),
          query: String(url.searchParams.get('query') || '').trim(),
        })
        return json(res, 200, {
          ok: true,
          total: result.memes.length,
          memes: result.memes.map(publicMeme),
          packs: result.packs,
          tags: result.tags,
          enabled: result.enabled,
          sendMode: currentSendMode(),
        })
      }

      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'method not allowed' })
      }

      const body = await readBody(req)
      const action = String(body?.action || '')
      if (action === 'upload') {
        return json(res, 200, { ok: true, meme: uploadMeme(body), message: '已上传' })
      }
      if (action === 'update') {
        return json(res, 200, { ok: true, meme: updateMeme(body), message: '已更新' })
      }
      if (action === 'delete') {
        return json(res, 200, { ok: true, deleted: deleteMeme(body), message: '已删除' })
      }
      if (action === 'setPack') {
        return json(res, 200, { ok: true, ...setPack(body), packs: store.packs(), enabled: enabledIds(), message: '图库开关已更新' })
      }
      if (action === 'setSendMode') {
        return json(res, 200, { ok: true, ...setSendMode(body), message: '发送方式已更新，下一条消息生效' })
      }
      if (action === 'import') {
        const imported = importPack(body)
        return json(res, 200, {
          ok: true,
          pack: imported.pack,
          packs: imported.packs,
          enabled: imported.enabled,
          message: '已导入「' + (imported.pack?.name || imported.pack?.id || '图库') + '」，共 ' + imported.count + ' 张',
        })
      }
      return json(res, 400, { ok: false, error: '未知 action: ' + action })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleImage = (req, res) => {
    if (!fenceRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(String(req.url || '/').split('?')[0])
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    if (!pathname.startsWith(PREFIX + '/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const rest = pathname.slice(PREFIX.length + 1)
    const slash = rest.indexOf('/')
    if (slash <= 0 || slash >= rest.length - 1) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const packId = rest.slice(0, slash)
    const relPath = normalizeRel(rest.slice(slash + 1))
    if (!relPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const pack = packById(packId)
    if (!pack || !readRow(pack, relPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const file = resolvePackFile(pack, relPath)
    let bytes
    try {
      if (!file) throw new Error('bad path')
      const info = statSync(file)
      if (!info.isFile()) throw new Error('not a file')
      bytes = readFileSync(file)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const ext = extname(relPath).slice(1).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=3600',
    })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  /* ---------------- 模型工具 ---------------- */

  const isQqSession = exec => {
    try {
      const sessionId = String(exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? '')
      if (!sessionId || !bridge || typeof bridge.chatOfSession !== 'function') return false
      return !!bridge.chatOfSession(sessionId)
    } catch {
      return false
    }
  }

  const captionOf = row => String(row.caption || row.file_name || row.relPath || '').slice(0, 80)

  const sendResult = (rows, meta, options) => {
    const { textMode, qq, tag } = options
    const hits = rows.map(row => {
      const caption = captionOf(row)
      if (textMode) return { tag: row.tag, caption }
      return { tag: row.tag, caption, pack: row.pack, path: row.path, relPath: row.relPath }
    })
    const lines = rows.map((row, index) => {
      const caption = captionOf(row)
      if (textMode) return (index + 1) + '. 描述=' + caption + ' | 分类=' + row.tag
      if (qq) return (index + 1) + '. path=' + row.path + ' | 分类=' + row.tag + ' | [表情: ' + caption + ']'
      return (index + 1) + '. [表情: ' + caption + ']'
    })
    const howToSend = textMode
      ? '发图:当前发送方式是「纯文字」,不发图片——不要写 [表情: ...] 或 [任何描述] 这类方括号标记,不要调用 dsh_im_return_file,也不要把图片路径贴进回复;把下面某一行「描述=」的原文用进你的文字回复里。'
      : qq
        ? '发图:把挑中的那一行 path 原样传给 dsh_im_return_file,它会作为 QQ 原生图片发出;同时把同一行的 [表情: 描述] 原样写进回复(QQ 端会自动摘掉标记,网页端据此配图)。不要写 markdown 图片,也不要把本地路径贴进回复。'
        : '发图:把下面某一行的 [表情: ...] 整段原样写进回复(描述抄候选原文,可加一两句文字,不要加网址)。'
    const head = meta.mode === 'keyword'
      ? '关键词「' + meta.query + '」命中 ' + rows.length + ' 张' + (tag ? '(限在情绪 ' + tag + ' 里)' : '') + '。'
      : (meta.keywordMiss ? meta.keywordMiss + '下面按情绪抽:' : '') + '情绪 ' + meta.mood + ' 随机 ' + rows.length + ' 张。'
    return {
      ok: true,
      mode: meta.mode,
      ...(meta.mood ? { mood: meta.mood } : {}),
      ...(meta.query ? { query: meta.query } : {}),
      hits,
      message: head + '看 caption 贴就发;不满意再换词/换情绪。\n' + howToSend + '\n' + lines.join('\n'),
    }
  }

  const sendMemeTool = defineTool({
    name: 'send_meme',
    description: '发一张表情包。两种搜法:①只给 tag(情绪桶)→ 从该情绪里随机抽;②给 query(关键词)→ 在 caption/关键词/图名里搜;两个都给 = 在该情绪里按关键词筛。' +
      '流程:给 tag/query → 返回若干张候选(带 caption 与绝对 path,数量用 limit 定) → 看描述觉得贴就发;不满意再换一批。' +
      '情绪字典: ' + MOOD_DICT + '。' +
      '发送方式:Web 会话把 [表情: 描述] 原样写进回复;QQ 会话把候选 path 交给 dsh_im_return_file 发原生图片,同时把 [表情: 描述] 写进回复给网页渲染。' +
      '气氛对了就主动发;发完短接,让图自己说话。',
    parameters: {
      tag: {
        type: 'string',
        description: '情绪范围(可选): ' + MOOD_DICT + '。只给 tag = 在该情绪里随机抽;tag + query = 在该情绪里按关键词筛。',
      },
      query: {
        type: 'string',
        description: '关键词(可选): 按 caption/关键词/图名子串搜,空格分隔多个(如「猫」「生气 猫」);整词没命中会自动拆词重试。没给 tag 时也会用 query 推断情绪。',
      },
      limit: {
        type: 'number',
        description: '本次返回几张候选(1-20,默认 8)。拿不准就多抽点;不满意再 search 换一批。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message || '') }],
    },
    execute(args, exec) {
      const tag = String(args?.tag || '').trim().toLowerCase()
      const query = String(args?.query || '').trim()
      const limit = clampLimit(args?.limit)
      const sendMode = currentSendMode()
      const textMode = sendMode === 'text'
      const qq = !textMode && isQqSession(exec)
      let keywordMiss = ''
      if (query) {
        const found = store.search(query, limit, tag)
        if (found.memes.length > 0) {
          return sendResult(found.memes, { mode: 'keyword', query: found.query }, { textMode, qq, tag })
        }
        keywordMiss = '关键词「' + (found.query || query) + '」没找到图(caption/关键词里没有这几个词)。'
      }
      const sample = store.sampleMood(tag, query, limit)
      if (!sample.mood) {
        return { ok: false, message: keywordMiss + (sample.reason || '要么换个更常见的词,要么给一个情绪 tag。字典: ' + MOOD_DICT) }
      }
      if (sample.memes.length === 0) {
        return { ok: false, message: keywordMiss + '情绪「' + sample.mood + '」下也没有图。换一个: ' + MOOD_DICT }
      }
      return sendResult(sample.memes, { mode: 'mood', mood: sample.mood, keywordMiss }, { textMode, qq, tag })
    },
  })

  const learnMemeTool = defineTool({
    name: 'learn_meme',
    description: '把一张图片收录进表情包图库(自动学图)。' +
      '仅当用户明确要求收藏/收录/保存这张图时使用(如「收藏这个表情」「收进图库」)。用户发表情/发图是斗图,不是收藏请求。' +
      '可传 imageUrl / attachmentId / path 之一:path 是最稳的显式来源;不传 attachmentId 时默认收录最近一张用户图片。' +
      '有识图模型时会自动补分类/描述/关键词;没有模型也能用 tag/caption/keywords 手动指定,最少只要一张图。',
    parameters: {
      imageUrl: { type: 'string', description: '可选。图片 http(s) URL,与 path/附件三选一' },
      attachmentId: { type: 'string', description: '可选。对话附件 id;不传则收录最近一张用户图片' },
      tag: { type: 'string', description: '手动指定分类,如 angry/happy(可选,默认自动识别或 daily)' },
      caption: { type: 'string', description: '手动指定描述(可选,默认自动识别或文件名)' },
      keywords: { type: 'string', description: '手动指定搜索关键词,空格分隔(可选)' },
      path: { type: 'string', description: '可选。本地图片绝对路径(或相对当前工作目录),显式收录时最稳' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message || '') }],
    },
    async execute(args, exec) {
      const imageUrl = String(args?.imageUrl || '').trim()
      const attachmentId = String(args?.attachmentId || '').trim()
      const explicitPath = String(args?.path || '').trim()
      let tag = String(args?.tag || '').trim().toLowerCase()
      let caption = String(args?.caption || '').trim().slice(0, 200)
      let keywords = String(args?.keywords || '').trim().slice(0, 200)
      try {
        let buf
        let mime = ''
        let fileName = 'meme'
        if (explicitPath) {
          const cwd = String(exec?.agent?.session?.header?.cwd || '')
          const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(cwd || process.cwd(), explicitPath)
          const info = statSync(absolute)
          if (!info.isFile()) throw new Error('不是一个普通文件')
          if (info.size > MAX_IMAGE_BYTES) throw new Error('图片大小超限(≤8MB)')
          buf = readFileSync(absolute)
          fileName = basename(absolute)
          mime = sniffImageMime(buf) || mimeOfName(fileName)
        } else if (imageUrl) {
          if (!/^https?:\/\//i.test(imageUrl)) throw new Error('imageUrl 必须是 http(s) 链接')
          const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000), redirect: 'follow' })
          if (!response.ok) throw new Error('下载失败: HTTP ' + response.status)
          const ctype = String(response.headers.get('content-type') || '')
          const declared = /image\/(jpeg|png|gif|webp)/.exec(ctype)?.[1]
          if (!declared) throw new Error('该 URL 不是图片(jpg/png/gif/webp)')
          buf = Buffer.from(await response.arrayBuffer())
          if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('图片大小超限(≤8MB)')
          fileName = decodeURIComponent(imageUrl.split('/').pop() || 'meme')
          mime = sniffImageMime(buf) || ('image/' + declared)
        } else {
          const attachments = ctx.get?.('attachments')
          const refs = userImageRefs(exec)
          const ref = attachmentId
            ? refs.find(item => String(item.attachmentId) === attachmentId)
            : refs[refs.length - 1]
          if (!ref) throw new Error(attachmentId ? '找不到附件 ' + attachmentId : '没有可收录的图片:传 path 或 imageUrl,或先让用户发一张图')
          if (!attachments || typeof attachments.readImage !== 'function') throw new Error('附件服务不可用,请传 path 或 imageUrl')
          const stored = await attachments.readImage(ref)
          buf = stored.data
          fileName = String(stored.ref?.name || 'meme')
          mime = sniffImageMime(buf) || String(stored.ref?.mediaType || '')
        }
        if (!buf?.length || buf.length > MAX_IMAGE_BYTES) throw new Error('图片大小超限(≤8MB)')
        const namedExt = extname(fileName).toLowerCase()
        const ext = (mime && EXT_BY_MIME[mime]) || (IMAGE_EXTS.has(namedExt) ? namedExt : '')
        if (!ext) throw new Error('仅支持 jpg/png/gif/webp 图片')
        if (!tag || !caption) {
          const auto = await recognizeImage(buf, mime || 'image/jpeg', fileName, ctx)
          if (auto) {
            if (!tag && auto.tag) tag = auto.tag
            if (!caption && auto.caption) caption = auto.caption
            if (!keywords && auto.keywords) keywords = auto.keywords
          }
        }
        if (!tag || !TAG_RE.test(tag)) tag = 'daily'
        if (!caption) caption = sanitizeStem(fileName) || '手动收录的表情'
        const pack = ensurePack(DEFAULT_UPLOAD_PACK)
        const name = sanitizeStem(fileName) + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + ext
        const relPath = ['memes', tag, name].join('/')
        mkdirSync(join(pack.path, 'memes', tag), { recursive: true })
        writeFileSync(join(pack.path, relPath), buf)
        insertRow(pack, relPath, tag, name, caption, keywords)
        ensureEnabled(pack.id)
        return {
          ok: true,
          pack: pack.id,
          path: resolve(pack.path, relPath),
          relPath,
          tag,
          caption,
          keywords,
          url: urlOf(pack.id, relPath),
          message: '已收录: [' + tag + '] ' + caption + ' → ' + pack.id + '/' + relPath,
        }
      } catch (error) {
        return { ok: false, message: '收录失败: ' + (error instanceof Error ? error.message : String(error)) }
      }
    },
  })

  /** 有识图模型时自动分类；任何失败都静默降级到手动/占位 caption。 */
  async function recognizeImage(buf, mime, fileName, context) {
    try {
      const llm = context.get?.('llm')
      const selector = context.agentDefaultModel ?? context.get?.('agentDefaultModel')
      const selection = selector && typeof selector.currentSelection === 'function' ? selector.currentSelection() : null
      const attachments = context.get?.('attachments')
      if (!llm || !selection?.provider || !selection?.model || !attachments?.saveImage) return null
      const info = await llm.resolveModelInfo(selection.provider, selection.model)
      const modalities = info?.inputModalities
      if (!Array.isArray(modalities) || !modalities.includes('image')) return null
      const base = await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, maxTokens: 1024 })
      const prepared = await llm.prepareCall(base)
      const attachment = await attachments.saveImage({ data: buf, mediaType: mime, name: fileName })
      const prompt = '你是表情包分类助手。识别这张表情包图片,只输出 JSON(不要任何其他文字):\n' +
        '{"tag":"分类(小写英文,参考: angry生气 happy开心 sad难过 shy害羞 confused困惑 surprised惊讶 sleep睡觉 work上班 like喜欢 see看看 meow喵喵 speechless无语),选最贴切的一个","caption":"一句话中文描述这张图表达的情绪/梗","keywords":"3-5个中文搜索词,空格分隔"}\n'
      let out = ''
      for await (const chunk of prepared.stream({
        ...base,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', attachment }] }],
      })) {
        if (chunk.type === 'text-delta') out += chunk.text
      }
      const match = /\{[\s\S]*\}/.exec(out)
      if (!match) return null
      const parsed = JSON.parse(match[0])
      const autoTag = String(parsed.tag || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20)
      return {
        tag: TAG_RE.test(autoTag) ? autoTag : '',
        caption: String(parsed.caption || '').trim().slice(0, 200),
        keywords: String(parsed.keywords || '').trim().slice(0, 200),
      }
    } catch (error) {
      logger('自动识图跳过:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /* ---------------- 注册路由 / 工具 / 提示词 ---------------- */

  const disposers = []
  let closed = false

  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    const addRoute = (route, label) => {
      try {
        if (typeof ctx.effect === 'function') {
          const disposer = ctx.effect(() => webServer.register(route), label)
          if (typeof disposer === 'function') disposers.push(disposer)
        } else {
          const disposer = webServer.register(route)
          if (typeof disposer === 'function') disposers.push(disposer)
        }
      } catch (error) {
        logger('注册路由失败 ' + label + ':', error instanceof Error ? error.message : error)
      }
    }
    addRoute({ kind: 'prefix', path: API_PREFIX, handler: handleApi }, 'dsh-aura: 表情包 API')
    addRoute({ kind: 'prefix', path: PREFIX, handler: handleImage }, 'dsh-aura: 表情包图片')
  } else {
    logger('没有 webServer,表情包 HTTP 路由未注册')
  }

  const toolsService = ctx.tools ?? ctx.get?.('tools')
  if (toolsService && typeof toolsService.register === 'function') {
    for (const tool of [sendMemeTool, learnMemeTool]) {
      try {
        const disposer = toolsService.register(tool)
        if (typeof disposer === 'function') disposers.push(disposer)
      } catch (error) {
        logger('注册工具失败 ' + tool.name + ':', error instanceof Error ? error.message : error)
      }
    }
  } else {
    logger('没有 tools 服务,表情包工具未注册')
  }

  const promptService = ctx.systemPrompt ?? ctx.get?.('systemPrompt')
  if (promptService && typeof promptService.section === 'function') {
    const renderMemePrompt = () => {
      const mode = currentSendMode()
      const lines = [
        '表情包：气氛合适就主动用 send_meme 挑一张，不用等对方开口。tag 是情绪桶（happy/angry/sad/shy/confused/daily），query 是关键词（按 caption/关键词/图名搜），limit 控制候选数（默认 8）。先看候选 caption，觉得贴再发；不满意换词或换情绪。',
        'Web 会话：把挑中的 [表情: 描述] 原样写进回复，描述抄候选原文，前端会配图。',
        'QQ 会话：把挑中的候选 path 交给 dsh_im_return_file 发原生图片，同时把同一段 [表情: 描述] 写进回复给网页渲染；QQ 端会自动摘掉标记，只留原生图片。',
        '发完短接，让图说话；对方说正事时克制。',
      ]
      return lines.join('\n')
    }
    try {
      const disposer = promptService.section({
        name: 'aura:meme',
        order: 55,
        interpolate: false,
        text: renderMemePrompt,
      })
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      logger('注册提示词段失败:', error instanceof Error ? error.message : error)
    }
    // 发送方式是易变状态：放 runtime-context，不污染 system prompt 缓存。
    try {
      const modeDisposer = promptService.context?.({
        name: 'aura:meme-mode',
        order: 56,
        text: () => {
          const mode = currentSendMode()
          if (mode === 'text') return '（表情包发送方式：纯文字。不要发图、不要写 [表情: …]，需要时只把候选描述当文字素材。）'
          if (mode === 'image') return '（表情包发送方式：图片。挑好图必须真的发出去，不能只写文字。）'
          return ''
        },
      })
      if (typeof modeDisposer === 'function') disposers.push(modeDisposer)
    } catch (error) {
      logger('注册发送方式上下文失败:', error instanceof Error ? error.message : error)
    }
  }

  const disposeSelf = () => {
    if (closed) return
    closed = true
    for (const disposer of [...disposers].reverse()) {
      try { disposer() } catch { /* 单个卸载失败不影响其余 */ }
    }
    disposers.length = 0
    if (current && current.dispose === disposeSelf) current = null
  }

  const handle = {
    store,
    api: {
      list: options => store.list(options),
      packs: () => store.packs(),
      tags: () => store.tags(),
      upload: uploadMeme,
      update: updateMeme,
      delete: deleteMeme,
      setPack,
      setSendMode,
    },
    settings: { file: settingsFile, read: readSettingsFile, write: writeSettings },
    handlers: { api: handleApi, image: handleImage },
    getState,
    dispose: disposeSelf,
  }
  current = handle

  const packs = store.packs()
  logger('已挂载：图库 ' + packs.length + ' 个，启用 ' + enabledIds().length + ' 个，发送方式 ' + currentSendMode())
  return handle
}
