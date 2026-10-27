/**
 * 记忆罗盘（Host 侧）：原始会话存档 + 关键词搜索 + 时间轴。
 *
 * 和 memory.json 的区别：
 * - memory.json 是「提炼过的记忆」（事件/笔记/事实卡），会被注入对话上下文。
 * - archive/YYYY-MM.jsonl 是「原始聊天流水」，只留在本地，**不会自动注入**；
 *   只有显式调用 soul_archive 或面板 /dsh-aura/archive-api 才会翻。
 *
 * 存储：
 *   $DSH_HOME/dsh-aura/archive/YYYY-MM.jsonl
 *   每行 {"t": ISO 时间, "at": epoch ms, "sessionId": "...", "role": "user|assistant", "text": "..."}
 *   追加写；坏行/坏 JSON 跳过，不影响其它行。
 *
 * 隐私：只存 Aura 会话（isSoulSession：QQ 或 emotionScope=all），开发/普通网页会话不存；
 * 不写入 backups（原始流水体积大），也不会出现在系统提示里。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clamp, codepointSlice, isSoulSession } from './soul.js'

export const ARCHIVE_DIR_NAME = 'archive'
export const ARCHIVE_API_PREFIX = '/dsh-aura/archive-api'

/** 单条原始消息最多存 4000 码点（超出截断，不丢整条）。 */
export const ARCHIVE_TEXT_MAX = 4000
/** 同 session + role + 同文本 5 秒内只存一次。 */
export const ARCHIVE_DEDUP_MS = 5000
/** 搜索片段：命中位置前后各 40 字。 */
export const ARCHIVE_SNIPPET_RADIUS = 40
/** 空 query / 时间轴默认条数。 */
export const ARCHIVE_DEFAULT_LIMIT = 10
export const ARCHIVE_LIMIT_MAX = 30
export const ARCHIVE_TIMELINE_DAYS = 30
/** 最多保留的月份文件数（配置默认值也是上限）。 */
export const ARCHIVE_MAX_FILES = 120
/** 随机旧事：候选文本长度范围（码点）。 */
export const OLD_MIN_CHARS = 6
export const OLD_MAX_CHARS = 200

export const ARCHIVE_DEFAULT_CONFIG = Object.freeze({
  archiveEnabled: true,
  archiveDays: 365,
  archiveMaxFiles: ARCHIVE_MAX_FILES,
})

const MONTH_PATTERN = /^(\d{4})-(\d{2})\.jsonl$/
const DAY_MS = 86_400_000
const ROLE_SET = new Set(['user', 'assistant'])

function pad2(value) {
  return String(value).padStart(2, '0')
}

function asNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clampInt(value, min, max, fallback) {
  const n = asNumber(value, fallback)
  return Math.max(min, Math.min(max, Math.round(n)))
}

function loggerOf(log) {
  return typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
}

/** 字符串/数字种子 → 32 位哈希（FNV-1a）。 */
function hashSeed(seed) {
  const text = typeof seed === 'string' ? seed : String(seed ?? '')
  let hash = 2166136261 >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * 确定性伪随机：同一 seed 永远给出同一序列（mulberry32）。
 * 记忆注入的「掷骰」和旧事抽样都靠它，保证同一 turn 多次渲染结果一致。
 */
export function seededRandom(seed) {
  let state = hashSeed(seed)
  return function next() {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** 本地时区的 YYYY-MM（存档按月切文件）。 */
export function monthKeyOf(at) {
  const date = new Date(asNumber(at, Date.now()))
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

/** 本地时区的 YYYY-MM-DD（时间轴按天统计）。 */
export function dateKeyOf(at) {
  const date = new Date(asNumber(at, Date.now()))
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 时间参数：epoch ms（数字/数字串）、YYYY-MM-DD（本地日界）、或 ISO 字符串。
 * options.endOfDay=true 时 YYYY-MM-DD 取当天 23:59:59.999（用于 to 边界）。
 */
export function parseArchiveTime(value, options = {}) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  const text = String(value).trim()
  if (!text) return null
  if (/^\d{10,16}$/.test(text)) {
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
    if (!Number.isFinite(start)) return null
    return options.endOfDay === true ? start + DAY_MS - 1 : start
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function startOfDay(at) {
  const date = new Date(asNumber(at, Date.now()))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** $DSH_HOME/dsh-aura/archive；state 可用时优先走 state.stateDir()。 */
export function resolveArchiveDir(state) {
  try {
    if (state && typeof state.stateDir === 'function') {
      const home = state.stateDir()
      if (home) return join(home, ARCHIVE_DIR_NAME)
    }
  } catch {
    /* 回落到 DSH_HOME */
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-aura', ARCHIVE_DIR_NAME)
}

function fileOfMonth(dir, at) {
  return join(dir, `${monthKeyOf(at)}.jsonl`)
}

function isInside(dir, file) {
  const root = resolve(dir)
  const target = resolve(file)
  return target === root || target.startsWith(root + sep)
}

function listArchiveFiles(dir) {
  try {
    return readdirSync(dir)
      .filter(name => MONTH_PATTERN.test(name))
      .sort()
      .map(name => join(dir, name))
  } catch {
    return []
  }
}

/** 读一个月文件；坏行/坏 JSON 跳过。 */
export function readArchiveMonth(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let row
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const role = String(row.role ?? '')
    const sessionId = String(row.sessionId ?? '').trim()
    const body = typeof row.text === 'string' ? row.text.trim() : ''
    const at = asNumber(row.at, NaN)
    if (!ROLE_SET.has(role) || !sessionId || !body || !Number.isFinite(at)) continue
    entries.push({
      t: typeof row.t === 'string' ? row.t : new Date(at).toISOString(),
      at,
      sessionId,
      role,
      text: body,
    })
  }
  return entries
}

/** 读时间范围内的存档（from/to 为 null 表示不限）；返回按时间正序。 */
export function readArchiveEntries(dir, options = {}) {
  const from = options.from === undefined || options.from === null ? null : asNumber(options.from, null)
  const to = options.to === undefined || options.to === null ? null : asNumber(options.to, null)
  const fromKey = from === null ? '' : monthKeyOf(from)
  const toKey = to === null ? '' : monthKeyOf(to)
  const entries = []
  for (const file of listArchiveFiles(dir)) {
    const name = file.slice(file.lastIndexOf(sep) + 1)
    const key = name.replace(/\.jsonl$/, '')
    if (fromKey && key < fromKey) continue
    if (toKey && key > toKey) continue
    for (const entry of readArchiveMonth(file)) {
      if (from !== null && entry.at < from) continue
      if (to !== null && entry.at > to) continue
      entries.push(entry)
    }
  }
  entries.sort((a, b) => a.at - b.at)
  return entries
}

/**
 * 从存档里随机抽一条「旧事」：before 之前、role=user 的短句。
 *
 * - 只扫 before 之前的月份文件（readArchiveEntries to 边界）；
 * - 文本长度按码点过滤（minChars/maxChars），同一文本去重；
 * - seededRandom(seed) 决定选哪条，同 seed 可复现；
 * - excludeSessionId 排除当前会话，excludeText 排除刚提过的旧事；
 * - 存档不可用/为空时安静返回 null，不抛错。
 *
 * @returns {{text:string, at:number, sessionId:string}|null}
 */
export function randomOld(options = {}, dir = resolveArchiveDir()) {
  try {
    const before = asNumber(options.before, Date.now())
    if (!Number.isFinite(before) || before <= 0) return null
    const excludeSessionId = String(options.excludeSessionId ?? '').trim()
    const excludeText = String(options.excludeText ?? '').trim()
    const minChars = clampInt(options.minChars, 1, ARCHIVE_TEXT_MAX, OLD_MIN_CHARS)
    const maxChars = clampInt(options.maxChars, minChars, ARCHIVE_TEXT_MAX, OLD_MAX_CHARS)
    const rows = readArchiveEntries(dir, { to: before - 1 })
    const seen = new Set()
    const candidates = []
    for (const entry of rows) {
      if (entry.role !== 'user') continue
      if (entry.at >= before) continue
      if (excludeSessionId && entry.sessionId === excludeSessionId) continue
      const text = entry.text
      const length = Array.from(text).length
      if (length < minChars || length > maxChars) continue
      if (excludeText && text === excludeText) continue
      if (seen.has(text)) continue
      seen.add(text)
      candidates.push({ text, at: entry.at, sessionId: entry.sessionId })
    }
    if (candidates.length === 0) return null
    candidates.sort((left, right) => left.at - right.at || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
    const random = seededRandom(options.seed ?? `old:${before}`)
    const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
    return { ...candidates[index] }
  } catch {
    return null
  }
}

function findCodepointIndex(chars, term) {
  const needle = Array.from(String(term).toLowerCase())
  if (needle.length === 0) return -1
  const hay = chars.map(ch => ch.toLowerCase())
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let hit = true
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return i
  }
  return -1
}

/** 片段：命中位置前后各 40 码点；没有命中的最近记录取开头 80 码点。 */
export function makeArchiveSnippet(text, terms = [], radius = ARCHIVE_SNIPPET_RADIUS) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length === 0) return ''
  let bestIndex = -1
  let bestLength = 0
  for (const term of terms) {
    const index = findCodepointIndex(chars, term)
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index
      bestLength = Array.from(String(term)).length
    }
  }
  if (bestIndex < 0) {
    return chars.length > 80 ? chars.slice(0, 80).join('') + '…' : chars.join('')
  }
  const start = Math.max(0, bestIndex - radius)
  const end = Math.min(chars.length, bestIndex + bestLength + radius)
  return (start > 0 ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '')
}

function splitTerms(query) {
  return String(query ?? '')
    .trim()
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean)
}

function scoreOf(entry, terms) {
  if (terms.length === 0) return { score: 0, all: false, hits: 0 }
  const lower = entry.text.toLowerCase()
  let hits = 0
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) hits += 1
  }
  if (hits === 0) return { score: 0, all: false, hits: 0 }
  const all = hits === terms.length
  return { score: all ? 1 : (hits / terms.length) * 0.5, all, hits }
}

/**
 * 搜索原始存档。
 * @param {{query?:string,from?:number|string,to?:number|string,sessionId?:string,limit?:number}} options
 * @param {string} [dir]
 * @returns {Array<{at:number,sessionId:string,role:string,snippet:string,score:number,text:string}>}
 */
export function searchArchive(options = {}, dir = resolveArchiveDir()) {
  const limit = clampInt(options.limit, 1, ARCHIVE_LIMIT_MAX, ARCHIVE_DEFAULT_LIMIT)
  const from = parseArchiveTime(options.from)
  const to = parseArchiveTime(options.to, { endOfDay: true })
  const sessionId = String(options.sessionId ?? options.session ?? '').trim()
  const terms = splitTerms(options.query)
  const rows = readArchiveEntries(dir, { from, to })
  const matched = []
  for (const entry of rows) {
    if (sessionId && entry.sessionId !== sessionId) continue
    const info = scoreOf(entry, terms)
    if (terms.length > 0 && info.hits === 0) continue
    matched.push({ entry, info })
  }
  matched.sort((left, right) => {
    if (left.info.all !== right.info.all) return left.info.all ? -1 : 1
    return right.entry.at - left.entry.at
  })
  return matched.slice(0, limit).map(({ entry, info }) => ({
    at: entry.at,
    sessionId: entry.sessionId,
    role: entry.role,
    snippet: makeArchiveSnippet(entry.text, terms),
    score: info.score,
    text: entry.text,
  }))
}

/**
 * 最近 N 天每天条数/角色数（缺失天补 0）。
 * @param {{days?:number,now?:number}} options
 * @param {string} [dir]
 * @returns {Array<{date:string,count:number,user:number,assistant:number}>}
 */
export function timeline(options = {}, dir = resolveArchiveDir()) {
  const days = clampInt(options.days, 1, 365, ARCHIVE_TIMELINE_DAYS)
  const now = asNumber(options.now, Date.now())
  const endDate = new Date(now)
  endDate.setHours(0, 0, 0, 0)
  const dates = []
  const counts = new Map()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(endDate)
    date.setDate(endDate.getDate() - offset)
    const key = dateKeyOf(date.getTime())
    dates.push(key)
    counts.set(key, { date: key, count: 0, user: 0, assistant: 0 })
  }
  const start = new Date(endDate)
  start.setDate(endDate.getDate() - (days - 1))
  const rows = readArchiveEntries(dir, { from: start.getTime(), to: now })
  for (const entry of rows) {
    const bucket = counts.get(dateKeyOf(entry.at))
    if (!bucket) continue
    bucket.count += 1
    if (entry.role === 'user') bucket.user += 1
    else if (entry.role === 'assistant') bucket.assistant += 1
  }
  return dates.map(date => counts.get(date))
}

/** 存档总览：文件数 / 总条数 / 最早最晚。 */
export function archiveStats(dir = resolveArchiveDir()) {
  const files = listArchiveFiles(dir)
  let total = 0
  let earliest = 0
  let latest = 0
  let bytes = 0
  for (const file of files) {
    try {
      bytes += statSync(file).size
    } catch {
      /* 文件刚好被删：忽略 */
    }
    for (const entry of readArchiveMonth(file)) {
      total += 1
      if (!earliest || entry.at < earliest) earliest = entry.at
      if (!latest || entry.at > latest) latest = entry.at
    }
  }
  return {
    files: files.length,
    total,
    earliest,
    latest,
    bytes,
  }
}

/**
 * 保留清理：删掉超过 archiveDays 的月份文件，再按 archiveMaxFiles 只留最新 N 个。
 * 只处理形如 YYYY-MM.jsonl 的文件，任何删除前都确认仍在存档目录内。
 */
export function pruneArchive(dir = resolveArchiveDir(), options = {}) {
  const days = clampInt(options.days, 1, 3650, ARCHIVE_DEFAULT_CONFIG.archiveDays)
  const maxFiles = clampInt(options.maxFiles, 1, 1200, ARCHIVE_DEFAULT_CONFIG.archiveMaxFiles)
  const cutoff = Date.now() - days * DAY_MS
  const cutoffKey = monthKeyOf(cutoff)
  const removed = []
  let files = listArchiveFiles(dir)
  for (const file of files.slice()) {
    const name = file.slice(file.lastIndexOf(sep) + 1)
    const key = name.replace(/\.jsonl$/, '')
    if (key >= cutoffKey) continue
    if (!isInside(dir, file)) continue
    try {
      unlinkSync(file)
      removed.push(name)
      files = files.filter(item => item !== file)
    } catch {
      /* 删不掉就留着，下次再试 */
    }
  }
  files.sort()
  if (files.length > maxFiles) {
    for (const file of files.slice(0, files.length - maxFiles)) {
      const name = file.slice(file.lastIndexOf(sep) + 1)
      if (!isInside(dir, file)) continue
      try {
        unlinkSync(file)
        removed.push(name)
      } catch {
        /* ignore */
      }
    }
  }
  return { removed, kept: Math.max(0, Math.min(files.length, maxFiles)) }
}

function readArchiveConfig(state) {
  let raw = {}
  try {
    raw = state && typeof state.readConfig === 'function' ? state.readConfig() : {}
  } catch {
    raw = {}
  }
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    raw: cfg,
    enabled: cfg.archiveEnabled !== false,
    days: clampInt(cfg.archiveDays, 30, 3650, ARCHIVE_DEFAULT_CONFIG.archiveDays),
    maxFiles: clampInt(cfg.archiveMaxFiles, 12, ARCHIVE_MAX_FILES, ARCHIVE_DEFAULT_CONFIG.archiveMaxFiles),
  }
}

function hostIsLoopback(req) {
  const host = req && req.headers ? req.headers.host : ''
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
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(name.toLowerCase())
}

/** 与 memory-api 同口径：loopback + Origin/Sec-Fetch-Site fence。 */
function archiveApiAllowed(req) {
  if (!hostIsLoopback(req)) return false
  const site = req && req.headers ? req.headers['sec-fetch-site'] : ''
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req && req.headers ? req.headers.origin : ''
  if (origin) {
    try {
      const url = new URL(String(origin))
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }
  return true
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  })
  res.end(data)
}

function formatClock(at) {
  const date = new Date(asNumber(at, Date.now()))
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function shortSession(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('qq:') ? text.slice(3) : text.slice(-12)
}

function roleLabel(role) {
  return role === 'assistant' ? '她' : '你'
}

/** soul_archive 的人类可读渲染。 */
export function renderArchiveToolText(value) {
  if (!value || value.ok === false) return `（存档没翻成：${value && value.reason ? value.reason : '未知原因'}）`
  if (value.action === 'timeline') {
    const rows = Array.isArray(value.timeline) ? value.timeline : []
    if (rows.length === 0) return '（时间轴是空的）'
    const total = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0)
    const lines = [`最近 ${rows.length} 天存档：共 ${total} 条`]
    for (const row of rows) {
      if (!row || Number(row.count) <= 0) continue
      lines.push(`- ${row.date}：${row.count} 条（你 ${row.user || 0} / 她 ${row.assistant || 0}）`)
    }
    return lines.join('\n')
  }
  const rows = Array.isArray(value.results) ? value.results : []
  if (rows.length === 0) return `（没有翻到${value.query ? `「${value.query}」` : '最近的记录'}）`
  const lines = [`存档搜索${value.query ? `「${value.query}」` : '（最近）'}：${rows.length} 条`]
  for (const row of rows) {
    lines.push(`- [${formatClock(row.at)}] ${roleLabel(row.role)} · 会话 ${shortSession(row.sessionId)}：${row.snippet}`)
  }
  return lines.join('\n')
}

/** 注册 soul_archive 工具（只读；不写任何东西）。 */
function registerArchiveTool(ctx, api, logger) {
  try {
    ctx.tools?.register?.(defineTool({
      name: 'soul_archive',
      description: '翻原始聊天存档找证据（显式调用，不会自动注入上下文）：'
        + 'action=search 按关键词/时间/会话搜原始对话；action=timeline 看最近 N 天每天聊了多少条。'
        + '只在需要核对原话、时间线或找证据时用，不要每轮都翻。',
      parameters: {
        action: { type: 'string', description: 'search | timeline', required: true },
        query: { type: 'string', description: 'search：关键词，空格分隔；多个词全部命中优先，否则任一命中' },
        from: { type: 'string', description: 'search：起始时间，epoch ms 或 YYYY-MM-DD' },
        to: { type: 'string', description: 'search：结束时间，epoch ms 或 YYYY-MM-DD（含当天）' },
        sessionId: { type: 'string', description: 'search：只搜这个会话（精确匹配）' },
        limit: { type: 'number', description: 'search：返回条数，1–30，默认 10' },
        days: { type: 'number', description: 'timeline：最近几天，默认 30' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderArchiveToolText(value) }],
      },
      async execute(args = {}) {
        const action = String(args && args.action ? args.action : 'search').trim()
        try {
          if (action === 'search') {
            const results = api.search({
              query: args.query,
              from: args.from,
              to: args.to,
              sessionId: args.sessionId,
              limit: args.limit,
            })
            return { ok: true, action, query: String(args.query ?? ''), count: results.length, results }
          }
          if (action === 'timeline') {
            const rows = api.timeline({ days: args.days })
            return { ok: true, action, days: rows.length, timeline: rows }
          }
          return { ok: false, action, reason: '未知 action（search | timeline）' }
        } catch (error) {
          logger('[archive] soul_archive 失败:', error instanceof Error ? error.message : error)
          return { ok: false, action, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  } catch (error) {
    logger('[archive] 工具注册失败:', error instanceof Error ? error.message : error)
  }
}

async function readRequestBody(req, limit = 64 * 1024) {
  if (req && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      const text = req.body.trim()
      return text ? JSON.parse(text) : {}
    }
    if (typeof req.body === 'object') return req.body
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

/**
 * 初始化记忆罗盘：订阅 soul 事件、注册工具与 /dsh-aura/archive-api。
 * @param {{ctx?:object,state?:object,soul?:object,log?:Function}} options
 */
export function initArchive(options = {}) {
  const { ctx, state, soul } = options
  const logger = loggerOf(options.log)
  const dir = resolveArchiveDir(state)
  let disposed = false
  const listeners = []
  const dedup = new Map()
  let lastPruneDay = dateKeyOf(Date.now())
  let statsCache = null

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    logger('[archive] 存档目录创建失败:', error instanceof Error ? error.message : error)
  }

  // 安装时清一次超期/超额文件（之后每天第一次写入时再清）。
  try {
    const cfg = readArchiveConfig(state)
    pruneArchive(dir, { days: cfg.days, maxFiles: cfg.maxFiles })
  } catch (error) {
    logger('[archive] 安装清理失败:', error instanceof Error ? error.message : error)
  }

  function remember(key, at) {
    dedup.set(key, at)
    if (dedup.size <= 500) return
    for (const [oldKey, oldAt] of dedup) {
      if (at - oldAt > ARCHIVE_DEDUP_MS) dedup.delete(oldKey)
    }
  }

  function record(payload = {}, role) {
    if (disposed) return false
    try {
      if (!ROLE_SET.has(role)) return false
      const cfg = readArchiveConfig(state)
      if (!cfg.enabled) return false
      if (payload && (payload.role === 'system' || payload.tool || payload.toolCall
        || payload.type === 'tool' || payload.kind === 'system')) return false
      const sessionId = String(payload && (payload.sessionId ?? payload.session) || '').trim()
      if (!sessionId) return false
      if (!isSoulSession(cfg.raw, sessionId)) return false
      let text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) return false
      text = codepointSlice(text, ARCHIVE_TEXT_MAX)
      const at = asNumber(payload.at, Date.now())
      const key = `${sessionId}\u0000${role}\u0000${text}`
      const previous = dedup.get(key)
      if (previous !== undefined && at - previous < ARCHIVE_DEDUP_MS) return false
      remember(key, at)
      mkdirSync(dir, { recursive: true })
      const file = fileOfMonth(dir, at)
      const entry = {
        t: new Date(at).toISOString(),
        at,
        sessionId,
        role,
        text,
      }
      appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8' })
      statsCache = null
      const day = dateKeyOf(at)
      if (day !== lastPruneDay) {
        lastPruneDay = day
        try {
          pruneArchive(dir, { days: cfg.days, maxFiles: cfg.maxFiles })
        } catch {
          /* 清理失败不影响写入 */
        }
      }
      return true
    } catch (error) {
      logger('[archive] 写入失败:', error instanceof Error ? error.message : error)
      return false
    }
  }

  const onUser = payload => record(payload, 'user')
  const onAssistant = payload => record(payload, 'assistant')

  if (soul && typeof soul.on === 'function') {
    try {
      listeners.push(soul.on('user', onUser))
      listeners.push(soul.on('assistant', onAssistant))
    } catch (error) {
      logger('[archive] 事件订阅失败:', error instanceof Error ? error.message : error)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const off of listeners) {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* ignore */
      }
    }
    listeners.length = 0
    dedup.clear()
  }

  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'aura-archive: soul listeners')
    } catch {
      /* ignore */
    }
  }

  function search(options = {}) {
    return searchArchive(options, dir)
  }

  function timelineOf(options = {}) {
    return timeline(options, dir)
  }

  function stats() {
    if (statsCache !== null) return statsCache
    const cfg = readArchiveConfig(state)
    const base = archiveStats(dir)
    statsCache = { ...base, enabled: cfg.enabled, days: cfg.days, maxFiles: cfg.maxFiles }
    return statsCache
  }

  const api = {
    dir,
    search,
    searchArchive: search,
    randomOld: options => randomOld(options, dir),
    timeline: timelineOf,
    stats,
    prune: (extra = {}) => {
      const cfg = readArchiveConfig(state)
      statsCache = null
      return pruneArchive(dir, { days: cfg.days, maxFiles: cfg.maxFiles, ...extra })
    },
    record,
    dispose,
  }

  registerArchiveTool(ctx, api, logger)
  registerArchiveApi(ctx, api, state, logger)

  return api
}

/** initArchive 的显式安装别名。 */
export function installArchive(options = {}) {
  return initArchive(options)
}

/** /dsh-aura/archive-api：GET/POST 只读查询（state/search/timeline）。 */
function registerArchiveApi(ctx, api, state, logger) {
  try {
    const webServer = (() => {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      } catch {
        return undefined
      }
    })() || (ctx && ctx.webServer)
    if (!webServer || typeof webServer.register !== 'function') return

    const respond = (params) => {
      const action = String(params.action || 'state')
      if (action === 'search') {
        const results = api.search({
          query: params.q ?? params.query,
          from: params.from,
          to: params.to,
          sessionId: params.session ?? params.sessionId,
          limit: params.limit,
        })
        return {
          ok: true,
          action,
          query: String(params.q ?? params.query ?? ''),
          count: results.length,
          results,
        }
      }
      if (action === 'timeline') {
        const rows = api.timeline({ days: params.days })
        return { ok: true, action, days: rows.length, timeline: rows }
      }
      if (action === 'state' || action === 'stats') {
        return { ok: true, action: 'state', ...api.stats() }
      }
      return null
    }

    const registration = {
      kind: 'prefix',
      path: ARCHIVE_API_PREFIX,
      async handler(req, res) {
        if (!archiveApiAllowed(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(String(req.url || '/'), 'http://localhost')
        const route = url.pathname.replace(ARCHIVE_API_PREFIX, '') || '/'
        try {
          if (req.method === 'GET') {
            const requested = url.searchParams.get('action')
            let action = ''
            if (route === '/' || route === '' || route === '/state') action = requested || 'state'
            else if (route === '/search') action = 'search'
            else if (route === '/timeline') action = 'timeline'
            else action = requested || ''
            if (!action) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
            }
            const params = {
              action,
              q: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
              from: url.searchParams.get('from') ?? '',
              to: url.searchParams.get('to') ?? '',
              session: url.searchParams.get('session') ?? url.searchParams.get('sessionId') ?? '',
              limit: url.searchParams.get('limit') ?? undefined,
              days: url.searchParams.get('days') ?? undefined,
            }
            const body = respond(params)
            if (!body) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
            }
            sendJson(res, 200, body)
            return
          }
          if (req.method === 'POST') {
            let body
            try {
              body = await readRequestBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: `请求体解析失败：${error instanceof Error ? error.message : String(error)}` })
              return
            }
            const params = {
              action: body.action || 'state',
              q: body.q ?? body.query ?? '',
              from: body.from ?? '',
              to: body.to ?? '',
              session: body.session ?? body.sessionId ?? '',
              limit: body.limit,
              days: body.days,
            }
            const result = respond(params)
            if (!result) {
              sendJson(res, 400, { ok: false, error: 'unknown action（state | search | timeline）' })
              return
            }
            sendJson(res, 200, result)
            return
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          logger('[archive] HTTP 失败:', error instanceof Error ? error.message : error)
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => webServer.register(registration), 'aura-archive: http')
    } else {
      webServer.register(registration)
    }
  } catch (error) {
    logger('[archive] HTTP 路由注册失败:', error instanceof Error ? error.message : error)
  }
}
