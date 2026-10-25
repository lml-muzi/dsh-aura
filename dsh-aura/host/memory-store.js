/**
 * 短期记忆独立存储（Host 侧）：$DSH_HOME/dsh-aura/memory.json。
 *
 * 数据形状（version 1）：
 *   { version: 1, events: [], notes: { user: [], us: [], self: [] }, topics: {}, reflection: {
 *       lastReflectAt, lastSource, userState, pendingDue
 *   } }
 *
 * 设计约束：
 * - 记忆不再住在 soul.json 里：soul 只保留身份/关系/情绪/成长，soul.json 落盘前会删掉 memory。
 * - 写盘统一 tmp + rename（本机文件系统不允许 hardlink）。
 * - 读到坏 JSON 时先把原文件备份成 memory.json.corrupt（已存在则加时间戳），再回退空记忆；
 *   绝不静默覆盖用户还能人工抢救的文件。
 * - 首次升级：memory.json 不存在且旧 soul.memory 有内容时迁移一次，迁移前备份（失败只 warn），
 *   写完后清掉 soul.memory，之后 soul.json 不再存短期记忆。
 * - 本模块不注册定时器、不依赖 Cordis；纯 Host 侧文件存储，方便自测与以后复用。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { snapshotSync as backupSnapshotSync } from './backup.js'

export const MEMORY_VERSION = 1
export const MEMORY_FILE = 'memory.json'
/** 短期 ring 硬上限（与 memory.js 的 EVENT_MAX 同口径）。 */
export const EVENT_LIMIT = 40
/** 每类笔记上限。 */
export const NOTE_LIMIT = 30
/** 单条笔记硬上限（码点）。 */
export const NOTE_TEXT_MAX = 80
export const TOPIC_LIMIT = 60
export const PENDING_DUE_LIMIT = 20
export const NOTE_CATEGORIES = Object.freeze(['user', 'us', 'self'])
const EVENT_KINDS = new Set(['chat', 'proactive', 'milestone', 'diary', 'note'])

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, asNumber(value, min)))
}

export function codepointSlice(text, max) {
  const points = Array.from(String(text ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

function newId(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 一份空记忆（归一化后的形状）。 */
export function emptyMemory() {
  return {
    version: MEMORY_VERSION,
    events: [],
    notes: { user: [], us: [], self: [] },
    topics: {},
    reflection: {
      lastReflectAt: 0,
      lastSource: '',
      userState: null,
      pendingDue: [],
    },
  }
}

function normalizeNote(raw, category, now) {
  if (!raw || typeof raw !== 'object') return null
  const text = codepointSlice(String(raw.text ?? '').trim(), NOTE_TEXT_MAX)
  if (!text) return null
  return {
    id: asString(raw.id, '').trim() || newId('note'),
    category,
    text,
    importance: clamp(asNumber(raw.importance, 0.5), 0, 1),
    createdAt: asNumber(raw.createdAt, now),
    updatedAt: asNumber(raw.updatedAt, now),
    hits: Math.max(0, Math.round(asNumber(raw.hits, 0))),
    dueAt: asNumber(raw.dueAt, 0) || 0,
  }
}

function normalizeEvent(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const summary = codepointSlice(String(raw.summary ?? '').trim(), 80)
  if (!summary) return null
  return {
    id: asString(raw.id, '').trim() || newId('evt'),
    at: asNumber(raw.at, now),
    kind: EVENT_KINDS.has(raw.kind) ? raw.kind : 'chat',
    summary,
    salience: clamp(asNumber(raw.salience, 0.3), 0, 1),
    topics: asArray(raw.topics).map((topic) => String(topic).slice(0, 8)).filter(Boolean).slice(0, 4),
    mood: {
      label: asString(raw.mood?.label, '').slice(0, 4),
      valence: clamp(asNumber(raw.mood?.valence, 0), -1, 1),
    },
    source: asString(raw.source, 'rule').slice(0, 12),
    sessionId: asString(raw.sessionId, ''),
  }
}

function normalizeTopics(raw) {
  const topics = {}
  const entries = Object.entries(asObject(raw))
    .map(([key, value]) => {
      const name = String(key).trim().slice(0, 12)
      if (!name) return null
      return {
        key: name,
        lastAt: asNumber(value?.lastAt, asNumber(value, 0)) || 0,
        count: Math.max(1, Math.round(asNumber(value?.count, 1))),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, TOPIC_LIMIT)
  for (const item of entries) topics[item.key] = { lastAt: item.lastAt, count: item.count }
  return topics
}

function normalizePendingDue(raw) {
  return asArray(raw)
    .filter((item) => item && typeof item === 'object' && asNumber(item.at, 0) > 0)
    .map((item) => ({
      id: asString(item.id, '').trim() || newId('due'),
      noteId: asString(item.noteId, ''),
      at: asNumber(item.at, 0),
      text: codepointSlice(asString(item.text, ''), 120),
    }))
    .slice(-PENDING_DUE_LIMIT)
}

/**
 * 把磁盘上/迁移来的 raw 洗成一定可用的记忆。坏条丢弃，不整份回默认。
 * 兼容旧 soul.memory：允许 reflection 缺失、lastReflectAt/pendingDue/userState 在顶层。
 */
export function normalizeMemory(raw, now = Date.now()) {
  const base = emptyMemory()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  base.events = asArray(raw.events).map((event) => normalizeEvent(event, now)).filter(Boolean).slice(-EVENT_LIMIT)
  for (const key of NOTE_CATEGORIES) {
    const seen = new Set()
    base.notes[key] = asArray(raw.notes?.[key])
      .map((note) => normalizeNote(note, key, now))
      .filter((note) => {
        if (!note) return false
        if (seen.has(note.text)) return false
        seen.add(note.text)
        return true
      })
      .slice(-NOTE_LIMIT)
  }
  base.topics = normalizeTopics(raw.topics)
  const reflection = asObject(raw.reflection)
  const lastReflectAt = reflection.lastReflectAt !== undefined ? reflection.lastReflectAt : raw.lastReflectAt
  const userState = reflection.userState !== undefined ? reflection.userState : raw.userState
  const pendingDue = reflection.pendingDue !== undefined ? reflection.pendingDue : raw.pendingDue
  base.reflection = {
    lastReflectAt: asNumber(lastReflectAt, 0),
    lastSource: asString(reflection.lastSource ?? raw.lastSource, '').slice(0, 12),
    userState: userState && typeof userState === 'object'
      ? { label: codepointSlice(asString(userState.label, ''), 8), at: asNumber(userState.at, 0) }
      : null,
    pendingDue: normalizePendingDue(pendingDue),
  }
  return base
}

/** 旧 soul.memory 是否有值得迁移的内容。 */
export function hasMemoryContent(memory) {
  if (!memory || typeof memory !== 'object') return false
  if (asArray(memory.events).length > 0) return true
  if (NOTE_CATEGORIES.some((key) => asArray(memory.notes?.[key]).length > 0)) return true
  return Object.keys(asObject(memory.topics)).length > 0
}

function defaultHome() {
  const env = process.env.DSH_HOME
  const root = env && env.trim() ? env.trim() : join(homedir(), '.dsh')
  return join(root, 'dsh-aura')
}

function memoryOfSoul(input) {
  if (!input || typeof input !== 'object') return null
  if (typeof input.get === 'function') {
    try {
      return asObject(input.get()?.memory)
    } catch {
      return null
    }
  }
  if (input.memory && typeof input.memory === 'object') return input.memory
  if (input.events || input.notes || input.topics) return input
  return null
}

function clearSoulMemory(input) {
  if (!input || typeof input !== 'object') return false
  try {
    if (typeof input.clearMemory === 'function') {
      input.clearMemory()
      return true
    }
    if (typeof input.get === 'function') {
      const soul = input.get()
      if (!soul || typeof soul !== 'object') return false
      soul.memory = {}
      if (typeof input.saveNow === 'function') {
        try {
          input.saveNow({ reason: 'memory-migrate', skipBackup: true, force: true })
        } catch {
          /* 清不了盘也不阻塞迁移结果 */
        }
      }
      return true
    }
    if ('memory' in input) {
      input.memory = {}
      return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * 创建记忆存储。
 * @param {object} [options]
 * @param {string} [options.home] dsh-aura 数据目录（memory.json 所在目录）
 * @param {Function} [options.log] 日志
 * @param {Function} [options.snapshotSync] 迁移前备份函数（label, options）→ result；默认 backup.snapshotSync
 * @param {string} [options.fileName='memory.json']
 */
export function createMemoryStore({ home, log, snapshotSync, fileName = MEMORY_FILE } = {}) {
  const warn = typeof log === 'function'
    ? (...args) => {
      try {
        log(...args)
      } catch {
        /* 日志失败不影响存储 */
      }
    }
    : (...args) => console.log('[dsh-aura]', ...args)
  const dir = typeof home === 'string' && home.trim() ? home.trim() : defaultHome()
  const file = join(dir, fileName)
  let disposed = false
  let corruptWarned = false

  function backupCorrupt(error) {
    let target = `${file}.corrupt`
    try {
      if (existsSync(target)) target = `${file}.corrupt-${Date.now()}`
      copyFileSync(file, target)
      warn('[soul] memory.json 损坏，已备份为', target, '并回退空记忆:', error instanceof Error ? error.message : error)
    } catch (copyError) {
      warn('[soul] memory.json 损坏且备份失败，回退空记忆:', copyError instanceof Error ? copyError.message : copyError)
    }
  }

  const api = {
    home: dir,
    file,
    fileName,

    exists() {
      return existsSync(file)
    },

    read() {
      if (disposed) return emptyMemory()
      let raw
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        if (error && error.code === 'ENOENT') return emptyMemory()
        if (!corruptWarned) {
          corruptWarned = true
          backupCorrupt(error)
        }
        return emptyMemory()
      }
      corruptWarned = false
      return normalizeMemory(raw)
    },

    write(next) {
      if (disposed) throw new Error('memory store 已卸载')
      const data = normalizeMemory(next)
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      try {
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
        renameSync(tmp, file)
      } catch (error) {
        throw error
      }
      return data
    },

    update(fn) {
      if (typeof fn !== 'function') throw new TypeError('memory store update 需要函数')
      const current = api.read()
      const next = fn(current)
      return api.write(next === undefined ? current : next)
    },

    stats() {
      const memory = api.read()
      let bytes = 0
      try {
        bytes = statSync(file).size
      } catch {
        bytes = 0
      }
      return {
        file,
        exists: existsSync(file),
        bytes,
        version: memory.version,
        events: asArray(memory.events).length,
        notes: {
          user: asArray(memory.notes.user).length,
          us: asArray(memory.notes.us).length,
          self: asArray(memory.notes.self).length,
        },
        topics: Object.keys(asObject(memory.topics)).length,
        pendingDue: asArray(memory.reflection?.pendingDue).length,
        lastReflectAt: asNumber(memory.reflection?.lastReflectAt, 0),
        userState: memory.reflection?.userState ?? null,
      }
    },

    /**
     * 从旧 soul.memory 迁移一次。memory.json 已存在时只清 soul.memory，不覆盖已有数据。
     * @param {object|{get:Function}} soul 旧 soul 对象 / soul 句柄 / { memory, clearMemory }
     */
    migrateFromSoul(soul) {
      const legacy = memoryOfSoul(soul)
      let existed = existsSync(file)
      let corrupt = false
      if (existed) {
        try {
          JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          // 文件坏了：先让 read() 把原文件备份成 .corrupt，再用旧 soul.memory 恢复一份可用的。
          existed = false
          corrupt = true
        }
      }
      if (existed) {
        const cleared = hasMemoryContent(legacy) ? clearSoulMemory(soul) : false
        return { migrated: false, reason: 'exists', cleared }
      }
      if (corrupt) api.read()
      const candidate = normalizeMemory({
        version: MEMORY_VERSION,
        events: legacy?.events,
        notes: legacy?.notes,
        topics: legacy?.topics,
        reflection: {
          lastReflectAt: legacy?.lastReflectAt,
          lastSource: legacy?.lastSource,
          userState: legacy?.userState,
          pendingDue: legacy?.pendingDue,
        },
      })
      if (!hasMemoryContent(candidate)) {
        return { migrated: false, reason: 'empty', cleared: false }
      }

      // 写前备份：失败只 warn，继续迁移（备份不是迁移的前置条件）。
      let backup = null
      try {
        const snapshotFn = typeof snapshotSync === 'function' ? snapshotSync : backupSnapshotSync
        if (typeof snapshotFn === 'function') {
          backup = snapshotFn('memory-migrate', { reason: 'memory-migrate' })
        }
        if (backup && backup.ok === false) {
          warn('[soul] 记忆迁移前备份失败（继续迁移）:', backup.error || 'unknown')
        }
      } catch (error) {
        warn('[soul] 记忆迁移前备份失败（继续迁移）:', error instanceof Error ? error.message : error)
      }

      api.write(candidate)
      const cleared = clearSoulMemory(soul)
      return {
        migrated: true,
        reason: 'migrated',
        events: candidate.events.length,
        notes: NOTE_CATEGORIES.reduce((sum, key) => sum + candidate.notes[key].length, 0),
        topics: Object.keys(candidate.topics).length,
        pendingDue: candidate.reflection.pendingDue.length,
        backup: backup && backup.id ? backup.id : '',
        cleared,
      }
    },

    dispose() {
      disposed = true
    },
  }

  return api
}
