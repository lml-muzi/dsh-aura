/**
 * 短期记忆独立存储（Host 侧）：$DSH_HOME/dsh-aura/memory.json。
 *
 * 数据形状（schema v2，兼容 v1）：
 *   {
 *     version: 2,
 *     events: [], notes: { user: [], us: [], self: [] }, topics: {},
 *     facts: [{ id, subject, predicate, value, text, confidence, source,
 *               firstSeenAt, lastSeenAt, supersededBy, lastDecayAt }],
 *     entities: [{ id, name, type, aliases, firstSeenAt, lastSeenAt }],
 *     reflection: { lastReflectAt, lastSource, userState, pendingDue, lastCompactDayKey }
 *   }
 *
 * 设计约束：
 * - 记忆不再住在 soul.json 里：soul 只覆盖身份/关系/情绪/成长，soul.json 落盘前会删掉 memory。
 * - 写盘统一 tmp + rename（本机文件系统不允许 hardlink）。
 * - 读到坏 JSON 时先把原文件备份成 memory.json.corrupt（已存在则加时间戳），再回退空记忆；
 *   绝不静默覆盖用户还能人工抢救的文件。
 * - v1 读取时自动补 facts/entities 并写回一次（损坏文件不写回）。
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

export const MEMORY_VERSION = 2
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

/** 事实卡 / 实体卡上限。 */
export const FACT_LIMIT = 200
export const ENTITY_LIMIT = 100
/** 单条事实卡各字段硬上限（码点）。 */
export const FACT_TEXT_MAX = 60
export const FACT_SUBJECT_MAX = 24
export const FACT_PREDICATE_MAX = 16
export const FACT_VALUE_MAX = 60
export const ENTITY_NAME_MAX = 20
export const ENTITY_ALIAS_MAX = 8
export const FACT_SOURCES = Object.freeze(['user', 'aura', 'reflection'])
export const ENTITY_TYPES = Object.freeze(['person', 'pet', 'place', 'project', 'other'])
/** 周期整理：多久没被确认的事实开始衰减、已取代事实保留多久、无关联实体保留多久。 */
export const FACT_DECAY_AFTER_DAYS = 30
export const FACT_DECAY_PER_DAY = 0.02
export const FACT_CONFIDENCE_FLOOR = 0.3
export const SUPERSEDED_TTL_DAYS = 60
export const ENTITY_TTL_DAYS = 90
const DAY_MS = 86_400_000

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
    facts: [],
    entities: [],
    reflection: {
      lastReflectAt: 0,
      lastSource: '',
      userState: null,
      pendingDue: [],
      lastCompactDayKey: '',
    },
  }
}

// ---------- 事实卡 ----------

function factSource(value) {
  return FACT_SOURCES.includes(value) ? value : 'user'
}

function normalizeFact(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const subject = codepointSlice(String(raw.subject ?? '').trim(), FACT_SUBJECT_MAX)
  const predicate = codepointSlice(String(raw.predicate ?? '').trim(), FACT_PREDICATE_MAX)
  const value = codepointSlice(String(raw.value ?? '').trim(), FACT_VALUE_MAX)
  if (!subject || !predicate || !value) return null
  const id = asString(raw.id, '').trim() || newId('fact')
  const text = codepointSlice(
    String(raw.text ?? '').trim() || `${subject}${predicate}${value}`,
    FACT_TEXT_MAX,
  )
  const firstSeenAt = asNumber(raw.firstSeenAt, now)
  const lastSeenAt = Math.max(firstSeenAt, asNumber(raw.lastSeenAt, firstSeenAt))
  const supersededBy = asString(raw.supersededBy, '').trim()
  return {
    id,
    subject,
    predicate,
    value,
    text,
    confidence: clamp(asNumber(raw.confidence, 0.6), 0, 1),
    source: factSource(raw.source),
    firstSeenAt,
    lastSeenAt,
    supersededBy: supersededBy && supersededBy !== id ? supersededBy : null,
    lastDecayAt: Math.max(0, asNumber(raw.lastDecayAt, lastSeenAt)),
  }
}

function normalizeEntity(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const name = codepointSlice(String(raw.name ?? '').trim(), ENTITY_NAME_MAX)
  if (!name) return null
  const type = ENTITY_TYPES.includes(raw.type) ? raw.type : 'other'
  const seen = new Set([name.toLowerCase()])
  const aliases = []
  for (const item of asArray(raw.aliases)) {
    const alias = codepointSlice(String(item ?? '').trim(), ENTITY_NAME_MAX)
    if (!alias || seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())
    aliases.push(alias)
    if (aliases.length >= ENTITY_ALIAS_MAX) break
  }
  const firstSeenAt = asNumber(raw.firstSeenAt, now)
  return {
    id: asString(raw.id, '').trim() || newId('ent'),
    name,
    type,
    aliases,
    firstSeenAt,
    lastSeenAt: Math.max(firstSeenAt, asNumber(raw.lastSeenAt, firstSeenAt)),
  }
}

/** 事实超上限时裁剪：先删已取代的（最旧优先），再删置信度最低、最久没出现的。 */
export function pruneFacts(memory) {
  if (!memory || typeof memory !== 'object') return 0
  const facts = asArray(memory.facts)
  if (facts.length <= FACT_LIMIT) {
    memory.facts = facts
    return 0
  }
  const ranked = facts.slice().sort((a, b) => {
    const aGone = a?.supersededBy ? 0 : 1
    const bGone = b?.supersededBy ? 0 : 1
    if (aGone !== bGone) return aGone - bGone
    if (aGone === 0 && bGone === 0) return asNumber(a.lastSeenAt, 0) - asNumber(b.lastSeenAt, 0)
    const confidenceDelta = asNumber(a.confidence, 0) - asNumber(b.confidence, 0)
    if (confidenceDelta !== 0) return confidenceDelta
    return asNumber(a.lastSeenAt, 0) - asNumber(b.lastSeenAt, 0)
  })
  const remove = new Set(ranked.slice(0, facts.length - FACT_LIMIT))
  memory.facts = facts.filter((fact) => !remove.has(fact))
  return remove.size
}

/** 实体超上限时裁剪：先删最久没出现的。 */
export function pruneEntities(memory) {
  if (!memory || typeof memory !== 'object') return 0
  const entities = asArray(memory.entities)
  if (entities.length <= ENTITY_LIMIT) {
    memory.entities = entities
    return 0
  }
  const ranked = entities.slice().sort((a, b) => {
    const delta = asNumber(a.lastSeenAt, 0) - asNumber(b.lastSeenAt, 0)
    if (delta !== 0) return delta
    return asNumber(a.firstSeenAt, 0) - asNumber(b.firstSeenAt, 0)
  })
  const remove = new Set(ranked.slice(0, entities.length - ENTITY_LIMIT))
  memory.entities = entities.filter((entity) => !remove.has(entity))
  return remove.size
}

/**
 * 写入一条事实卡（原地修改 memory）。
 * - 同 subject+predicate+value：合并，confidence 提升、lastSeenAt/lastDecayAt 更新；
 * - 同 subject+predicate 但 value 不同：旧的 supersededBy=新 id，新卡继承较高置信度；
 * - 返回 { ok, fact, created, merged, superseded }。
 */
export function addFact(memory, input = {}, now = Date.now()) {
  if (!memory || typeof memory !== 'object' || !input || typeof input !== 'object') return { ok: false }
  if (!Array.isArray(memory.facts)) memory.facts = []
  const at = asNumber(now, Date.now())
  const subject = codepointSlice(String(input.subject ?? '').trim(), FACT_SUBJECT_MAX)
  const predicate = codepointSlice(String(input.predicate ?? '').trim(), FACT_PREDICATE_MAX)
  const value = codepointSlice(String(input.value ?? '').trim(), FACT_VALUE_MAX)
  if (!subject || !predicate || !value) return { ok: false, reason: 'empty' }
  const confidence = clamp(asNumber(input.confidence, 0.6), 0, 1)
  const source = factSource(input.source)
  const text = codepointSlice(
    String(input.text ?? '').trim() || `${subject}${predicate}${value}`,
    FACT_TEXT_MAX,
  )
  const active = memory.facts.filter((fact) => fact && !fact.supersededBy
    && fact.subject === subject && fact.predicate === predicate)
  const sameValue = active.find((fact) => fact.value === value)
  if (sameValue) {
    sameValue.confidence = clamp(Math.max(asNumber(sameValue.confidence, 0.6), confidence) + 0.05, 0, 1)
    sameValue.lastSeenAt = at
    sameValue.lastDecayAt = at
    if (source === 'user' && sameValue.source !== 'user') sameValue.source = source
    if (Array.from(text).length > Array.from(String(sameValue.text ?? '')).length) sameValue.text = text
    return { ok: true, fact: sameValue, created: false, merged: true, superseded: 0 }
  }
  const inherited = active.reduce((max, fact) => Math.max(max, asNumber(fact.confidence, 0)), 0)
  const fact = {
    id: newId('fact'),
    subject,
    predicate,
    value,
    text,
    confidence: Math.max(confidence, inherited),
    source,
    firstSeenAt: at,
    lastSeenAt: at,
    supersededBy: null,
    lastDecayAt: at,
  }
  for (const old of active) {
    old.supersededBy = fact.id
    // 旧卡的最后一次“被看见”就是被新值取代的这一刻，60 天后才清理。
    old.lastSeenAt = at
    old.lastDecayAt = at
  }
  memory.facts.push(fact)
  pruneFacts(memory)
  return { ok: true, fact, created: true, merged: false, superseded: active.length }
}

const TOKEN_STOP = new Set(Array.from('的了吗呢吧啊呀哦嗯我你他她它在是有和就不都很还也这那么怎什'))

function tokensOf(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  for (const ch of clean) if (!TOKEN_STOP.has(ch)) set.add(ch)
  return set
}

function recencyScore(at, now) {
  const age = Math.max(0, now - asNumber(at, 0))
  if (age < DAY_MS) return 0.12
  if (age < 7 * DAY_MS) return 0.06
  if (age < 30 * DAY_MS) return 0.02
  return 0
}

/** 事实检索：subject/predicate/value 的 token 命中 + 置信度 + recency；跳过 superseded。 */
export function queryFacts(memory, query, limit = 5, now = Date.now()) {
  const max = clamp(limit, 1, 50)
  const at = asNumber(now, Date.now())
  const facts = asArray(memory?.facts).filter((fact) => fact && !fact.supersededBy)
  const text = String(query ?? '').trim()
  if (!text) {
    return facts
      .slice()
      .sort((a, b) => (asNumber(b.confidence, 0) + recencyScore(b.lastSeenAt, at))
        - (asNumber(a.confidence, 0) + recencyScore(a.lastSeenAt, at)))
      .slice(0, max)
  }
  const tokens = [...tokensOf(text)]
  const scored = []
  for (const fact of facts) {
    const primary = `${fact.subject}\u0001${fact.predicate}\u0001${fact.value}`.toLowerCase()
    const full = `${primary}\u0001${fact.text ?? ''}`.toLowerCase()
    let hit = 0
    for (const token of tokens) {
      if (primary.includes(token)) hit += 1
      else if (full.includes(token)) hit += 0.5
    }
    const ratio = tokens.length > 0 ? hit / tokens.length : 0
    const exact = full.includes(text.toLowerCase()) ? 0.4 : 0
    if (ratio <= 0 && exact <= 0) continue
    scored.push({
      fact,
      score: ratio + exact + asNumber(fact.confidence, 0.6) * 0.5 + recencyScore(fact.lastSeenAt, at),
    })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return asNumber(b.fact.lastSeenAt, 0) - asNumber(a.fact.lastSeenAt, 0)
  })
  return scored.slice(0, max).map((item) => item.fact)
}

/** 最近的事实卡（不返回已取代的）。 */
export function listFacts(memory, limit = 50) {
  const max = clamp(limit, 1, FACT_LIMIT)
  return asArray(memory?.facts)
    .filter((fact) => fact && !fact.supersededBy)
    .slice()
    .sort((a, b) => {
      const delta = asNumber(b.lastSeenAt, 0) - asNumber(a.lastSeenAt, 0)
      return delta !== 0 ? delta : asNumber(b.confidence, 0) - asNumber(a.confidence, 0)
    })
    .slice(0, max)
}

/** 忘掉一条事实卡；返回是否删除。 */
export function forgetFact(memory, id) {
  const key = String(id ?? '').trim()
  if (!memory || !key) return false
  const facts = asArray(memory.facts)
  const index = facts.findIndex((fact) => fact && fact.id === key)
  if (index < 0) return false
  facts.splice(index, 1)
  memory.facts = facts
  return true
}

// ---------- 实体卡 ----------

/** 新建或更新实体（按名字/别名去重，别名合并去重）。 */
export function upsertEntity(memory, name, options = {}, now = Date.now()) {
  if (!memory || typeof memory !== 'object') return { ok: false }
  if (!Array.isArray(memory.entities)) memory.entities = []
  const at = asNumber(now, Date.now())
  const cleanName = codepointSlice(String(name ?? '').trim(), ENTITY_NAME_MAX)
  if (!cleanName) return { ok: false, reason: 'empty' }
  const opts = options && typeof options === 'object' ? options : {}
  const type = ENTITY_TYPES.includes(opts.type) ? opts.type : 'other'
  const lower = cleanName.toLowerCase()
  const existing = memory.entities.find((entity) => entity && (
    String(entity.name ?? '').toLowerCase() === lower
    || asArray(entity.aliases).some((alias) => String(alias ?? '').toLowerCase() === lower)
  ))
  if (existing) {
    if (ENTITY_TYPES.includes(opts.type)) existing.type = type
    const seen = new Set([String(existing.name ?? '').toLowerCase(), ...asArray(existing.aliases).map((alias) => String(alias ?? '').toLowerCase())])
    for (const item of asArray(opts.aliases)) {
      const alias = codepointSlice(String(item ?? '').trim(), ENTITY_NAME_MAX)
      if (!alias || seen.has(alias.toLowerCase())) continue
      seen.add(alias.toLowerCase())
      existing.aliases.push(alias)
      if (existing.aliases.length >= ENTITY_ALIAS_MAX) break
    }
    existing.lastSeenAt = at
    return { ok: true, entity: existing, created: false }
  }
  const entity = {
    id: newId('ent'),
    name: cleanName,
    type,
    aliases: [],
    firstSeenAt: at,
    lastSeenAt: at,
  }
  const seen = new Set([lower])
  for (const item of asArray(opts.aliases)) {
    const alias = codepointSlice(String(item ?? '').trim(), ENTITY_NAME_MAX)
    if (!alias || seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())
    entity.aliases.push(alias)
    if (entity.aliases.length >= ENTITY_ALIAS_MAX) break
  }
  memory.entities.push(entity)
  pruneEntities(memory)
  return { ok: true, entity, created: true }
}

/** 最近的实体卡。 */
export function listEntities(memory, limit = 50) {
  const max = clamp(limit, 1, ENTITY_LIMIT)
  return asArray(memory?.entities)
    .filter((entity) => entity && entity.name)
    .slice()
    .sort((a, b) => asNumber(b.lastSeenAt, 0) - asNumber(a.lastSeenAt, 0))
    .slice(0, max)
}

/** 实体检索：名字/别名 token 命中；没命中时默认退回最近实体（fallback:false 可关闭）。 */
export function queryEntities(memory, query, limit = 2, now = Date.now(), options = {}) {
  const max = clamp(limit, 1, 20)
  const at = asNumber(now, Date.now())
  const entities = asArray(memory?.entities).filter((entity) => entity && entity.name)
  const text = String(query ?? '').trim()
  if (!text) return listEntities(memory, max)
  const tokens = [...tokensOf(text)]
  const scored = []
  for (const entity of entities) {
    const haystack = `${entity.name}\u0001${asArray(entity.aliases).join('\u0001')}`.toLowerCase()
    let hit = 0
    for (const token of tokens) if (haystack.includes(token)) hit += 1
    const ratio = tokens.length > 0 ? hit / tokens.length : 0
    if (ratio <= 0) continue
    scored.push({ entity, score: ratio + recencyScore(entity.lastSeenAt, at) })
  }
  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) {
    return options && options.fallback === false ? [] : listEntities(memory, max)
  }
  return scored.slice(0, max).map((item) => item.entity)
}

// ---------- 周期整理 ----------

function entityHasFact(entity, facts) {
  const names = [entity.name, ...asArray(entity.aliases)]
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter(Boolean)
  if (names.length === 0) return false
  return facts.some((fact) => {
    if (!fact || fact.supersededBy) return false
    const subject = String(fact.subject ?? '').toLowerCase()
    const value = String(fact.value ?? '').toLowerCase()
    const text = String(fact.text ?? '').toLowerCase()
    return names.includes(subject)
      || names.some((name) => value.includes(name) || text.includes(name))
  })
}

/**
 * 事实/实体周期整理（原地修改 memory）：
 * - 合并同 subject+predicate+value 的重复卡；
 * - 清理 60 天前已被取代的事实；
 * - 未被确认超过 30 天的事实 confidence 每天 -0.02（下限 0.3）；
 * - 清理 90 天没有事实关联、也没有再出现的实体。
 */
export function compactMemoryFacts(memory, now = Date.now()) {
  const result = { factsMerged: 0, factsPruned: 0, factsDecayed: 0, entitiesPruned: 0 }
  if (!memory || typeof memory !== 'object') return result
  if (!Array.isArray(memory.facts)) memory.facts = []
  if (!Array.isArray(memory.entities)) memory.entities = []
  const at = asNumber(now, Date.now())

  const groups = new Map()
  for (const fact of memory.facts) {
    if (!fact || fact.supersededBy) continue
    const key = `${fact.subject}\u0001${fact.predicate}\u0001${fact.value}`
    const list = groups.get(key)
    if (list) list.push(fact)
    else groups.set(key, [fact])
  }
  const dropDuplicates = new Set()
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => {
      const confidenceDelta = asNumber(b.confidence, 0) - asNumber(a.confidence, 0)
      if (confidenceDelta !== 0) return confidenceDelta
      return asNumber(b.lastSeenAt, 0) - asNumber(a.lastSeenAt, 0)
    })
    const keeper = group[0]
    for (const extra of group.slice(1)) {
      keeper.firstSeenAt = Math.min(asNumber(keeper.firstSeenAt, at), asNumber(extra.firstSeenAt, at))
      keeper.lastSeenAt = Math.max(asNumber(keeper.lastSeenAt, at), asNumber(extra.lastSeenAt, at))
      keeper.lastDecayAt = Math.max(asNumber(keeper.lastDecayAt, 0), asNumber(extra.lastDecayAt, 0))
      keeper.confidence = Math.max(asNumber(keeper.confidence, 0), asNumber(extra.confidence, 0))
      if (Array.from(String(extra.text ?? '')).length > Array.from(String(keeper.text ?? '')).length) keeper.text = extra.text
      dropDuplicates.add(extra)
    }
  }
  if (dropDuplicates.size > 0) {
    memory.facts = memory.facts.filter((fact) => !dropDuplicates.has(fact))
    result.factsMerged = dropDuplicates.size
  }

  const beforeSuperseded = memory.facts.length
  memory.facts = memory.facts.filter((fact) => {
    if (!fact || !fact.supersededBy) return true
    return at - asNumber(fact.lastSeenAt, at) <= SUPERSEDED_TTL_DAYS * DAY_MS
  })
  result.factsPruned += beforeSuperseded - memory.facts.length

  for (const fact of memory.facts) {
    if (!fact || fact.supersededBy) continue
    const lastSeen = asNumber(fact.lastSeenAt, at)
    // 30 天宽限期内不衰减；之后按“未衰减到的天数”一次补 0.02/天。
    const graceEnd = lastSeen + FACT_DECAY_AFTER_DAYS * DAY_MS
    const cursor = Math.max(graceEnd, asNumber(fact.lastDecayAt, 0))
    const steps = Math.floor((at - cursor) / DAY_MS)
    if (steps <= 0) continue
    const current = asNumber(fact.confidence, 0.6)
    const next = Math.max(FACT_CONFIDENCE_FLOOR, current - steps * FACT_DECAY_PER_DAY)
    if (next < current) {
      fact.confidence = Math.round(next * 1000) / 1000
      result.factsDecayed += 1
    }
    fact.lastDecayAt = cursor + steps * DAY_MS
  }

  const activeFacts = memory.facts.filter((fact) => fact && !fact.supersededBy)
  const beforeEntities = memory.entities.length
  memory.entities = memory.entities.filter((entity) => {
    if (!entity) return false
    if (at - asNumber(entity.lastSeenAt, at) <= ENTITY_TTL_DAYS * DAY_MS) return true
    return entityHasFact(entity, activeFacts)
  })
  result.entitiesPruned += beforeEntities - memory.entities.length

  pruneFacts(memory)
  pruneEntities(memory)
  return result
}

// ---------- 归一化 ----------

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
  const factIds = new Set()
  base.facts = asArray(raw.facts)
    .map((fact) => normalizeFact(fact, now))
    .filter((fact) => {
      if (!fact) return false
      if (factIds.has(fact.id)) return false
      factIds.add(fact.id)
      return true
    })
  pruneFacts(base)
  const entityIds = new Set()
  base.entities = asArray(raw.entities)
    .map((entity) => normalizeEntity(entity, now))
    .filter((entity) => {
      if (!entity) return false
      if (entityIds.has(entity.id)) return false
      entityIds.add(entity.id)
      return true
    })
  pruneEntities(base)
  const reflection = asObject(raw.reflection)
  const lastReflectAt = reflection.lastReflectAt !== undefined ? reflection.lastReflectAt : raw.lastReflectAt
  const userState = reflection.userState !== undefined ? reflection.userState : raw.userState
  const pendingDue = reflection.pendingDue !== undefined ? reflection.pendingDue : raw.pendingDue
  const dayKey = asString(reflection.lastCompactDayKey, '')
  base.reflection = {
    lastReflectAt: asNumber(lastReflectAt, 0),
    lastSource: asString(reflection.lastSource ?? raw.lastSource, '').slice(0, 12),
    userState: userState && typeof userState === 'object'
      ? { label: codepointSlice(asString(userState.label, ''), 8), at: asNumber(userState.at, 0) }
      : null,
    pendingDue: normalizePendingDue(pendingDue),
    lastCompactDayKey: /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : '',
  }
  return base
}

/** 旧 soul.memory 是否有值得迁移的内容。 */
export function hasMemoryContent(memory) {
  if (!memory || typeof memory !== 'object') return false
  if (asArray(memory.events).length > 0) return true
  if (NOTE_CATEGORIES.some((key) => asArray(memory.notes?.[key]).length > 0)) return true
  if (asArray(memory.facts).length > 0 || asArray(memory.entities).length > 0) return true
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
  if (input.events || input.notes || input.topics || input.facts) return input
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
      const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
      // v1 → v2：补 facts/entities，并写回一次；坏文件已在上面回退，不会被覆盖。
      const needsUpgrade = record !== null && (
        asNumber(record.version, 0) < MEMORY_VERSION
        || !Array.isArray(record.facts)
        || !Array.isArray(record.entities)
        || !record.reflection || typeof record.reflection !== 'object'
        || !('lastCompactDayKey' in record.reflection)
      )
      const memory = normalizeMemory(raw)
      if (needsUpgrade) {
        try {
          api.write(memory)
        } catch (error) {
          warn('[soul] memory.json 升级写回失败（下次读取重试）:', error instanceof Error ? error.message : error)
        }
      }
      return memory
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

    // v2 事实卡/实体卡的便捷入口（页面/工具/自测都可以直接走 store）。
    addFact(input, now = Date.now()) {
      let result = { ok: false }
      api.update((memory) => {
        result = addFact(memory, input, now)
        return memory
      })
      return result
    },

    queryFacts(query, limit = 5, now = Date.now()) {
      return queryFacts(api.read(), query, limit, now)
    },

    listFacts(limit = 50) {
      return listFacts(api.read(), limit)
    },

    forgetFact(id) {
      let forgotten = false
      api.update((memory) => {
        forgotten = forgetFact(memory, id)
        return memory
      })
      return forgotten
    },

    upsertEntity(name, options = {}, now = Date.now()) {
      let result = { ok: false }
      api.update((memory) => {
        result = upsertEntity(memory, name, options, now)
        return memory
      })
      return result
    },

    listEntities(limit = 50) {
      return listEntities(api.read(), limit)
    },

    compactFacts(now = Date.now()) {
      let result = { factsMerged: 0, factsPruned: 0, factsDecayed: 0, entitiesPruned: 0 }
      api.update((memory) => {
        result = compactMemoryFacts(memory, now)
        return memory
      })
      return result
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
        facts: asArray(memory.facts).length,
        entities: asArray(memory.entities).length,
        pendingDue: asArray(memory.reflection?.pendingDue).length,
        lastReflectAt: asNumber(memory.reflection?.lastReflectAt, 0),
        userState: memory.reflection?.userState ?? null,
        lastCompactDayKey: memory.reflection?.lastCompactDayKey || '',
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
        facts: legacy?.facts,
        entities: legacy?.entities,
        reflection: {
          lastReflectAt: legacy?.lastReflectAt,
          lastSource: legacy?.lastSource,
          userState: legacy?.userState,
          pendingDue: legacy?.pendingDue,
          lastCompactDayKey: legacy?.lastCompactDayKey,
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
        facts: candidate.facts.length,
        entities: candidate.entities.length,
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
