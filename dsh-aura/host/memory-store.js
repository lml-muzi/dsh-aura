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
 *     relations: [{ id, from, to, type, weight, firstSeenAt, lastSeenAt }],
 *     reflection: { lastReflectAt, lastSource, userState, pendingDue, lastCompactDayKey }
 *   }
 *
 * 设计约束：
 * - 记忆不再住在 soul.json 里：soul 只覆盖身份/关系/情绪/成长，soul.json 落盘前会删掉 memory。
 * - 写盘统一 tmp + rename（本机文件系统不允许 hardlink）。
 * - 读到坏 JSON 时先把原文件备份成 memory.json.corrupt（已存在则加时间戳），再回退空记忆；
 *   绝不静默覆盖用户还能人工抢救的文件。
 * - v1 读取时自动补 facts/entities 并写回一次（损坏文件不写回）；relations 缺失同样补 []。
 * - 关系边 from/to 只认 entity id：坏值（悬空/自环/重复）在归一化时清掉。
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
/**
 * 关系边（实体图）上限与阈值。
 * - from/to 用 entity id，名字/别名只用于解析与展示。
 * - co（共现）边无向：同一对实体只留一条，重复出现 +0.1。
 */
export const RELATION_LIMIT = 300
export const RELATION_TYPE_MAX = 16
export const RELATION_CO = 'co'
export const RELATION_FACT_WEIGHT = 0.8
export const RELATION_CO_BASE = 0.3
export const RELATION_CO_STEP = 0.1
export const RELATION_CO_DECAY_DAYS = 90
export const RELATION_WEIGHT_MIN = 0.15
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
    relations: [],
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
  // 事实卡同时落一条关系边：subject 和 value 都能解析到实体（名字/别名）时。
  // 解析失败（常见：subject 是昵称但还没建实体）就安静跳过，不影响事实写入。
  const linkRelation = () => {
    const fromEntity = resolveEntity(memory, subject)
    const toEntity = resolveEntity(memory, value)
    if (!fromEntity || !toEntity || fromEntity.id === toEntity.id) return null
    const linked = upsertRelation(memory, {
      from: fromEntity.id,
      to: toEntity.id,
      type: predicate,
      weight: RELATION_FACT_WEIGHT,
    }, at)
    return linked && linked.ok ? linked.relation : null
  }
  const active = memory.facts.filter((fact) => fact && !fact.supersededBy
    && fact.subject === subject && fact.predicate === predicate)
  const sameValue = active.find((fact) => fact.value === value)
  if (sameValue) {
    sameValue.confidence = clamp(Math.max(asNumber(sameValue.confidence, 0.6), confidence) + 0.05, 0, 1)
    sameValue.lastSeenAt = at
    sameValue.lastDecayAt = at
    if (source === 'user' && sameValue.source !== 'user') sameValue.source = source
    if (Array.from(text).length > Array.from(String(sameValue.text ?? '')).length) sameValue.text = text
    return { ok: true, fact: sameValue, created: false, merged: true, superseded: 0, relation: linkRelation() }
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
  return { ok: true, fact, created: true, merged: false, superseded: active.length, relation: linkRelation() }
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

// ---------- 关系图（实体之间的边） ----------

function relationType(value) {
  return codepointSlice(String(value ?? '').trim(), RELATION_TYPE_MAX) || RELATION_CO
}

function normalizeRelation(raw, now, entityIds) {
  if (!raw || typeof raw !== 'object') return null
  const type = relationType(raw.type)
  const from = asString(raw.from, '').trim()
  const to = asString(raw.to, '').trim()
  if (!from || !to || from === to) return null
  // from/to 必须是已知 entity id；悬空边直接丢弃（compactRelations 也会清）。
  if (entityIds && (!entityIds.has(from) || !entityIds.has(to))) return null
  const firstSeenAt = asNumber(raw.firstSeenAt, now)
  return {
    id: asString(raw.id, '').trim() || newId('rel'),
    from,
    to,
    type,
    weight: clamp(asNumber(raw.weight, RELATION_FACT_WEIGHT), 0, 1),
    firstSeenAt,
    lastSeenAt: Math.max(firstSeenAt, asNumber(raw.lastSeenAt, firstSeenAt)),
  }
}

/** 关系边超上限时裁剪：先删 weight 最低的，再删最久没更新的。 */
export function pruneRelations(memory) {
  if (!memory || typeof memory !== 'object') return 0
  const relations = asArray(memory.relations)
  if (relations.length <= RELATION_LIMIT) {
    memory.relations = relations
    return 0
  }
  const ranked = relations.slice().sort((a, b) => {
    const weightDelta = asNumber(a?.weight, 0) - asNumber(b?.weight, 0)
    if (weightDelta !== 0) return weightDelta
    return asNumber(a?.lastSeenAt, 0) - asNumber(b?.lastSeenAt, 0)
  })
  const remove = new Set(ranked.slice(0, relations.length - RELATION_LIMIT))
  memory.relations = relations.filter((relation) => !remove.has(relation))
  return remove.size
}

/** 按 entity id / 名字 / 别名找实体（只认精确匹配，不做模糊）。 */
export function resolveEntity(memory, nameOrId) {
  const key = String(nameOrId ?? '').trim()
  if (!key) return null
  const entities = asArray(memory?.entities).filter((entity) => entity && entity.name)
  const byId = entities.find((entity) => entity.id === key)
  if (byId) return byId
  const lower = key.toLowerCase()
  return entities.find((entity) => String(entity.name ?? '').toLowerCase() === lower
    || asArray(entity.aliases).some((alias) => String(alias ?? '').toLowerCase() === lower)) || null
}

/**
 * 文本里出现的实体（名字/别名子串命中）。
 * 单字名（如「猫」）噪声太大，只认 ≥2 字的；同一实体只算一次。
 */
export function entitiesInText(memory, text) {
  const haystack = String(text ?? '').trim().toLowerCase()
  const found = []
  if (!haystack) return found
  for (const entity of asArray(memory?.entities)) {
    if (!entity || !entity.name) continue
    const names = [entity.name, ...asArray(entity.aliases)]
      .map((name) => String(name ?? '').trim())
      .filter((name) => Array.from(name).length >= 2)
    if (names.length === 0) continue
    if (names.some((name) => haystack.includes(name.toLowerCase()))) found.push(entity)
  }
  return found
}

/**
 * 写入/加权一条关系边（原地修改 memory）。
 * - from/to 可以是 entity id，也可以是名字/别名；解析不到就返回 ok:false；
 * - 同 from+to+type 的边只保留一条：weight 取较大值，firstSeenAt 取更早，lastSeenAt 刷新。
 * 返回 { ok, relation, created, reason? }。
 */
export function upsertRelation(memory, input = {}, now = Date.now()) {
  if (!memory || typeof memory !== 'object' || !input || typeof input !== 'object') {
    return { ok: false, reason: 'empty' }
  }
  if (!Array.isArray(memory.relations)) memory.relations = []
  const at = asNumber(now, Date.now())
  const type = relationType(input.type)
  const fromEntity = resolveEntity(memory, input.from)
  const toEntity = resolveEntity(memory, input.to)
  if (!fromEntity || !toEntity) return { ok: false, reason: 'unknown-entity' }
  if (fromEntity.id === toEntity.id) return { ok: false, reason: 'self' }
  const weight = clamp(asNumber(input.weight, RELATION_FACT_WEIGHT), 0, 1)
  // co 边无向：同一对实体反向重复也只留一条（保留先写入的方向）。
  const existing = memory.relations.find((relation) => {
    if (!relation || relation.type !== type) return false
    if (type === RELATION_CO) {
      return (relation.from === fromEntity.id && relation.to === toEntity.id)
        || (relation.from === toEntity.id && relation.to === fromEntity.id)
    }
    return relation.from === fromEntity.id && relation.to === toEntity.id
  })
  if (existing) {
    existing.weight = clamp(Math.max(asNumber(existing.weight, 0), weight), 0, 1)
    existing.firstSeenAt = Math.min(asNumber(existing.firstSeenAt, at), at)
    existing.lastSeenAt = Math.max(asNumber(existing.lastSeenAt, 0), at)
    return { ok: true, relation: existing, created: false }
  }
  const relation = {
    id: newId('rel'),
    from: fromEntity.id,
    to: toEntity.id,
    type,
    weight,
    firstSeenAt: at,
    lastSeenAt: at,
  }
  memory.relations.push(relation)
  pruneRelations(memory)
  return { ok: true, relation, created: true }
}

function entityIndex(memory) {
  const map = new Map()
  for (const entity of asArray(memory?.entities)) {
    if (entity && entity.id) map.set(entity.id, entity)
  }
  return map
}

/** 给面板/文案用的关系视图：边两端带名字和类型。 */
function relationView(index, relation) {
  const from = index.get(relation.from)
  const to = index.get(relation.to)
  return {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    type: relation.type,
    weight: asNumber(relation.weight, 0),
    firstSeenAt: asNumber(relation.firstSeenAt, 0),
    lastSeenAt: asNumber(relation.lastSeenAt, 0),
    fromName: from ? String(from.name ?? '') : '',
    fromType: from ? String(from.type ?? 'other') : 'other',
    toName: to ? String(to.name ?? '') : '',
    toType: to ? String(to.type ?? 'other') : 'other',
  }
}

/** 最重/最新的关系边（跳过悬空边）。 */
export function listRelations(memory, limit = 50) {
  const max = clamp(limit, 1, RELATION_LIMIT)
  const index = entityIndex(memory)
  return asArray(memory?.relations)
    .filter((relation) => relation && index.has(relation.from) && index.has(relation.to)
      && relation.from !== relation.to)
    .map((relation) => relationView(index, relation))
    .sort((a, b) => {
      const weightDelta = b.weight - a.weight
      if (weightDelta !== 0) return weightDelta
      return b.lastSeenAt - a.lastSeenAt
    })
    .slice(0, max)
}

/** 某个实体（id/名字/别名）的 1 跳关系边。 */
export function relationsForEntity(memory, nameOrId, options = {}) {
  const entity = resolveEntity(memory, nameOrId)
  if (!entity) return []
  const opts = options && typeof options === 'object' ? options : {}
  // 注意：clamp(undefined, …) 会退化成下限，这里必须显式给默认 8。
  const max = clamp(opts.limit === undefined ? 8 : opts.limit, 1, 20)
  const index = entityIndex(memory)
  return asArray(memory?.relations)
    .filter((relation) => relation && (relation.from === entity.id || relation.to === entity.id)
      && index.has(relation.from) && index.has(relation.to))
    .map((relation) => relationView(index, relation))
    .sort((a, b) => {
      const weightDelta = b.weight - a.weight
      if (weightDelta !== 0) return weightDelta
      return b.lastSeenAt - a.lastSeenAt
    })
    .slice(0, max)
}

/**
 * 关系图整理（原地修改 memory）：
 * - 清悬空实体边 / 自环 / 坏边；
 * - co 边 90 天没更新 weight 减半（四舍五入到 0.001）；
 * - 低于 0.15 的边删除；
 * - 最后按 300 上限裁剪。
 */
export function compactRelations(memory, now = Date.now()) {
  const result = { relationsPruned: 0, relationsDecayed: 0 }
  if (!memory || typeof memory !== 'object') return result
  const at = asNumber(now, Date.now())
  const ids = new Set(asArray(memory.entities).filter((entity) => entity && entity.id).map((entity) => entity.id))
  const kept = []
  for (const relation of asArray(memory.relations)) {
    if (!relation || !relation.from || !relation.to) {
      result.relationsPruned += 1
      continue
    }
    if (relation.from === relation.to || !ids.has(relation.from) || !ids.has(relation.to)) {
      result.relationsPruned += 1
      continue
    }
    let weight = clamp(asNumber(relation.weight, 0), 0, 1)
    if (relation.type === RELATION_CO
      && at - asNumber(relation.lastSeenAt, at) > RELATION_CO_DECAY_DAYS * DAY_MS) {
      weight = Math.round(weight * 0.5 * 1000) / 1000
      result.relationsDecayed += 1
    }
    if (weight < RELATION_WEIGHT_MIN) {
      result.relationsPruned += 1
      continue
    }
    relation.weight = weight
    kept.push(relation)
  }
  memory.relations = kept
  result.relationsPruned += pruneRelations(memory)
  return result
}

/**
 * 同一段文本里出现的多个实体两两建/加 co 边：
 * 首次 0.3，之后每出现一次 +0.1（上限 1），每次出现都刷新 lastSeenAt。
 * entities 可以是实体对象、id 或名字。
 */
export function linkCooccurrence(memory, entities, now = Date.now()) {
  if (!memory || typeof memory !== 'object') return { edges: 0 }
  const at = asNumber(now, Date.now())
  const unique = []
  const seen = new Set()
  for (const item of asArray(entities)) {
    const entity = typeof item === 'string'
      ? resolveEntity(memory, item)
      : (item && item.id ? item : resolveEntity(memory, item?.name))
    if (!entity || !entity.id || seen.has(entity.id)) continue
    seen.add(entity.id)
    unique.push(entity)
  }
  if (unique.length < 2) return { edges: 0 }
  let edges = 0
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const existing = asArray(memory.relations).find((relation) => relation
        && relation.type === RELATION_CO
        && ((relation.from === unique[i].id && relation.to === unique[j].id)
          || (relation.from === unique[j].id && relation.to === unique[i].id)))
      const next = existing
        ? Math.min(1, Math.round((asNumber(existing.weight, RELATION_CO_BASE) + RELATION_CO_STEP) * 1000) / 1000)
        : RELATION_CO_BASE
      const linked = upsertRelation(memory, {
        from: unique[i].id,
        to: unique[j].id,
        type: RELATION_CO,
        weight: next,
      }, at)
      if (linked.ok) edges += 1
    }
  }
  return { edges }
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
  // relations：from/to 必须是已知 entity id；同一条边（from+to+type）归一化时合并。
  // 用 pruneEntities 之后的 id 集合，避免实体超上限被裁掉后留下悬空边。
  const liveEntityIds = new Set(base.entities.map((entity) => entity.id))
  const relationSeen = new Map()
  for (const rawRelation of asArray(raw.relations)) {
    const relation = normalizeRelation(rawRelation, now, liveEntityIds)
    if (!relation) continue
    const ends = relation.type === RELATION_CO
      ? [relation.from, relation.to].sort().join('\u0001')
      : `${relation.from}\u0001${relation.to}`
    const key = `${ends}\u0001${relation.type}`
    const existing = relationSeen.get(key)
    if (!existing) {
      relationSeen.set(key, relation)
      continue
    }
    existing.weight = Math.max(asNumber(existing.weight, 0), asNumber(relation.weight, 0))
    existing.firstSeenAt = Math.min(asNumber(existing.firstSeenAt, relation.firstSeenAt), relation.firstSeenAt)
    existing.lastSeenAt = Math.max(asNumber(existing.lastSeenAt, 0), asNumber(relation.lastSeenAt, 0))
  }
  base.relations = [...relationSeen.values()]
  pruneRelations(base)
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
  if (asArray(memory.relations).length > 0) return true
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
      const notesNeedId = NOTE_CATEGORIES.some((category) => asArray(record?.notes?.[category])
        .some((note) => note && typeof note === 'object' && !asString(note.id, '').trim()))
      const needsUpgrade = record !== null && (
        asNumber(record.version, 0) < MEMORY_VERSION
        || !Array.isArray(record.facts)
        || !Array.isArray(record.entities)
        || !Array.isArray(record.relations)
        || !record.reflection || typeof record.reflection !== 'object'
        || !('lastCompactDayKey' in record.reflection)
        || notesNeedId
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
      let result = {
        factsMerged: 0, factsPruned: 0, factsDecayed: 0, entitiesPruned: 0,
        relationsPruned: 0, relationsDecayed: 0,
      }
      api.update((memory) => {
        result = { ...compactMemoryFacts(memory, now), ...compactRelations(memory, now) }
        return memory
      })
      return result
    },

    /** 关系边便捷入口（v2.1 实体图）。 */
    upsertRelation(input = {}, now = Date.now()) {
      let result = { ok: false }
      api.update((memory) => {
        result = upsertRelation(memory, input, now)
        return memory
      })
      return result
    },

    listRelations(limit = 50) {
      return listRelations(api.read(), limit)
    },

    relationsForEntity(nameOrId, options = {}) {
      return relationsForEntity(api.read(), nameOrId, options)
    },

    compactRelations(now = Date.now()) {
      let result = { relationsPruned: 0, relationsDecayed: 0 }
      api.update((memory) => {
        result = compactRelations(memory, now)
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
        relations: asArray(memory.relations).length,
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
        relations: legacy?.relations,
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
        relations: candidate.relations.length,
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

// ---------- 笔记读写 / 实体整理（soul_memory 控制面） ----------

function noteRef(input) {
  if (typeof input === 'string') return { id: input.trim(), text: '' }
  const source = input && typeof input === 'object' ? input : {}
  return {
    id: asString(source.id, '').trim(),
    text: asString(source.text ?? source.oldText, '').trim(),
  }
}

/**
 * 定位一条笔记：id 优先；否则按 text 精确匹配，并且必须唯一（跨 category 也算一条）。
 * 返回 { ok:true, category, index, note, list } 或 { ok:false, reason, matches }。
 * 旧笔记没有 id 时在这里补一个并写回 note（store.update 落盘后 id 就稳定了）。
 */
export function locateNote(memory, input) {
  if (!memory || typeof memory !== 'object') return { ok: false, reason: 'empty-memory' }
  const ref = noteRef(input)
  if (!ref.id && !ref.text) return { ok: false, reason: 'need-id-or-text' }
  const matches = []
  for (const category of NOTE_CATEGORIES) {
    const list = asArray(memory.notes?.[category])
    list.forEach((note, index) => {
      if (!note || typeof note !== 'object') return
      const noteId = asString(note.id, '').trim()
      if (ref.id) {
        if (noteId === ref.id) matches.push({ category, index, note, list })
        return
      }
      if (asString(note.text, '').trim() === ref.text) matches.push({ category, index, note, list })
    })
  }
  if (matches.length === 0) return { ok: false, reason: 'not-found' }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      matches: matches.map((item) => ({
        category: item.category,
        id: asString(item.note.id, ''),
        text: item.note.text,
      })),
    }
  }
  const found = matches[0]
  if (!asString(found.note.id, '').trim()) found.note.id = newId('note')
  return { ok: true, category: found.category, index: found.index, note: found.note, list: found.list }
}

/** 更新笔记：id 或 oldText 定位；text / importance 至少给一个。 */
export function updateNote(memory, input = {}, now = Date.now()) {
  if (!memory || typeof memory !== 'object') return { ok: false, reason: 'empty-memory' }
  const source = input && typeof input === 'object' ? input : {}
  const located = locateNote(memory, { id: source.id, text: source.oldText })
  if (!located.ok) return located
  const note = located.note
  const updated = []
  if (source.text !== undefined) {
    const text = codepointSlice(String(source.text ?? '').trim(), NOTE_TEXT_MAX)
    if (!text) return { ok: false, reason: 'empty-text' }
    note.text = text
    updated.push('text')
  }
  if (source.importance !== undefined) {
    note.importance = clamp(asNumber(source.importance, note.importance), 0, 1)
    updated.push('importance')
  }
  if (updated.length === 0) return { ok: false, reason: 'nothing-to-update' }
  note.updatedAt = asNumber(now, Date.now())
  return { ok: true, id: note.id, category: located.category, note, updated }
}

/** 删除笔记：id 或 text 精确/唯一匹配；顺手清掉指向它的到点提醒。 */
export function deleteNote(memory, input = {}) {
  if (!memory || typeof memory !== 'object') return { ok: false, reason: 'empty-memory' }
  const located = locateNote(memory, input)
  if (!located.ok) return located
  const [removed] = located.list.splice(located.index, 1)
  let dueRemoved = 0
  const removedId = asString(removed?.id, '').trim()
  if (removedId) {
    const pending = asArray(memory.reflection?.pendingDue)
    const kept = pending.filter((item) => {
      const hit = item && asString(item.noteId, '') === removedId
      if (hit) dueRemoved += 1
      return !hit
    })
    if (dueRemoved > 0 && memory.reflection && typeof memory.reflection === 'object') {
      memory.reflection.pendingDue = kept
    }
  }
  return {
    ok: true,
    id: removedId,
    category: located.category,
    note: removed,
    removed: 1,
    dueRemoved,
  }
}

/**
 * 删除实体卡：同时清掉所有以它为端点的关系边。
 * 保守：不动 facts 的 subject/value 文本（历史事实仍可读），只删实体和悬空边。
 */
export function deleteEntity(memory, id) {
  const key = String(id ?? '').trim()
  if (!memory || typeof memory !== 'object') return { ok: false, reason: 'empty-memory' }
  if (!key) return { ok: false, reason: 'id-empty' }
  const entities = asArray(memory.entities)
  const index = entities.findIndex((entity) => entity && asString(entity.id, '') === key)
  if (index < 0) return { ok: false, reason: 'not-found' }
  const [entity] = entities.splice(index, 1)
  const before = asArray(memory.relations)
  const relations = before.filter((relation) => !relation || (
    asString(relation.from, '') !== key && asString(relation.to, '') !== key
  ))
  memory.relations = relations
  return {
    ok: true,
    id: key,
    entity,
    removedRelations: before.length - relations.length,
  }
}

/**
 * 合并实体：from 并入 to。
 * - facts 的 subject/value 文本里等于 from 名字/别名的，替换成 to.name；
 * - relations 端点 from.id → to.id，并去重（co 无向）、清掉自环；
 * - 别名并进 to，firstSeenAt 取更早、lastSeenAt 取更晚，最后删掉 from。
 */
export function mergeEntities(memory, fromId, toId, now = Date.now()) {
  if (!memory || typeof memory !== 'object') return { ok: false, reason: 'empty-memory' }
  const from = resolveEntity(memory, fromId)
  const to = resolveEntity(memory, toId)
  if (!from) return { ok: false, reason: 'from-not-found' }
  if (!to) return { ok: false, reason: 'to-not-found' }
  if (from.id === to.id) return { ok: false, reason: 'same-entity' }
  const at = asNumber(now, Date.now())
  const fromNames = new Set([from.name.toLowerCase(), ...asArray(from.aliases).map((alias) => String(alias).toLowerCase())])

  const aliases = asArray(to.aliases).map((alias) => codepointSlice(String(alias ?? '').trim(), ENTITY_NAME_MAX)).filter(Boolean)
  const seen = new Set([to.name.toLowerCase(), ...aliases.map((alias) => alias.toLowerCase())])
  let aliasesAdded = 0
  const addAlias = (name) => {
    const clean = codepointSlice(String(name ?? '').trim(), ENTITY_NAME_MAX)
    if (!clean) return
    const lower = clean.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    aliases.push(clean)
    aliasesAdded += 1
  }
  addAlias(from.name)
  for (const alias of asArray(from.aliases)) addAlias(alias)
  to.aliases = aliases.slice(0, ENTITY_ALIAS_MAX)
  to.firstSeenAt = Math.min(asNumber(to.firstSeenAt, at), asNumber(from.firstSeenAt, at))
  to.lastSeenAt = Math.max(asNumber(to.lastSeenAt, at), asNumber(from.lastSeenAt, at))

  const replaceName = (value) => {
    const text = String(value ?? '').trim()
    if (!text) return value
    return fromNames.has(text.toLowerCase()) ? to.name : value
  }
  let factsUpdated = 0
  for (const fact of asArray(memory.facts)) {
    if (!fact || typeof fact !== 'object') continue
    let changed = false
    const subject = replaceName(fact.subject)
    if (subject !== fact.subject) {
      fact.subject = subject
      changed = true
    }
    const value = replaceName(fact.value)
    if (value !== fact.value) {
      fact.value = value
      changed = true
    }
    if (changed) factsUpdated += 1
  }

  const relationSeen = new Map()
  let redirected = 0
  let merged = 0
  let droppedSelf = 0
  for (const relation of asArray(memory.relations)) {
    if (!relation || typeof relation !== 'object') continue
    const next = { ...relation }
    let touched = false
    if (asString(next.from, '') === from.id) {
      next.from = to.id
      touched = true
    }
    if (asString(next.to, '') === from.id) {
      next.to = to.id
      touched = true
    }
    if (next.from === next.to) {
      droppedSelf += 1
      continue
    }
    if (touched) redirected += 1
    const type = asString(next.type, '')
    const ends = type === RELATION_CO
      ? [next.from, next.to].sort().join('\u0001')
      : `${next.from}\u0001${next.to}`
    const key = `${ends}\u0001${type}`
    const existing = relationSeen.get(key)
    if (!existing) {
      relationSeen.set(key, next)
      continue
    }
    existing.weight = Math.max(asNumber(existing.weight, 0), asNumber(next.weight, 0))
    existing.firstSeenAt = Math.min(asNumber(existing.firstSeenAt, at), asNumber(next.firstSeenAt, at))
    existing.lastSeenAt = Math.max(asNumber(existing.lastSeenAt, 0), asNumber(next.lastSeenAt, 0))
    merged += 1
  }
  memory.relations = [...relationSeen.values()]
  memory.entities = asArray(memory.entities).filter((entity) => entity && asString(entity.id, '') !== from.id)
  return {
    ok: true,
    fromId: from.id,
    toId: to.id,
    fromName: from.name,
    toName: to.name,
    aliasesAdded,
    factsUpdated,
    relationsRedirected: redirected,
    relationsMerged: merged,
    relationsDropped: droppedSelf,
  }
}
