/**
 * 记忆层（Host 侧）：短期事件流 / 长期笔记 / 话题索引 / 关键词召回 / 反思 / 记忆工具 /
 * 实体图（facts → entities → relations，1 跳召回）、立即记忆、会话整理（digest）。
 *
 * 设计依据：docs/aura-soul-design.md 的 C（记忆）、E.4（context order 40）、E.5.2/E.5.3（soul_memory/soul_recall）。
 *
 * 状态所有权：
 * - 短期记忆已和灵魂分离，存在独立 memory.json（host/memory-store.js）。本模块是唯一读写方。
 * - soul.json 只保留身份/关系/情绪/成长；soul.memory 只在首次升级时作为迁移来源出现一次。
 * - renderMemoryContext 优先接收 store；旧调用传 soul 对象也兼容（读 soul.memory）。
 *
 * 成本策略：默认**规则反思**（零 token）；只有用户显式打开 memoryReflectionLlm 且宿主有可用模型时才走 LLM 反思，
 * 且失败自动回退规则。绝不为每轮对话起一次模型调用。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { seededRandom, OLD_MIN_CHARS, OLD_MAX_CHARS } from './archive.js'
import {
  clamp,
  codepointSlice,
  codepointLength,
  isSoulSession,
} from './soul.js'
import {
  MEMORY_FILE,
  MEMORY_VERSION,
  FACT_LIMIT,
  ENTITY_LIMIT,
  RELATION_LIMIT,
  RELATION_CO,
  FACT_TEXT_MAX,
  NOTE_DIGEST_MAX,
  NOTE_PROMISE_MAX,
  addFact as addFactToMemory,
  compactMemoryFacts,
  compactRelations,
  createMemoryStore,
  deleteEntity as deleteEntityInMemory,
  deleteNote as deleteNoteInMemory,
  emptyMemory,
  entitiesInText,
  forgetFact as forgetFactInMemory,
  hasMemoryContent,
  linkCooccurrence,
  locateNote as locateNoteInMemory,
  mergeEntities as mergeEntitiesInMemory,
  listEntities as listEntitiesInMemory,
  listFacts as listFactsInMemory,
  listRelations as listRelationsInMemory,
  queryEntities as queryEntitiesInMemory,
  queryFacts as queryFactsInMemory,
  relationsForEntity as relationsForEntityInMemory,
  updateNote as updateNoteInMemory,
  upsertEntity as upsertEntityInMemory,
  upsertRelation as upsertRelationInMemory,
} from './memory-store.js'

export const SUMMARY_MAX = 80
/** 记忆上下文总预算：默认 240，配置范围 60–600。 */
export const MEMORY_CONTEXT_BUDGET = 240
export const MEMORY_CONTEXT_BUDGET_MIN = 60
export const MEMORY_CONTEXT_BUDGET_MAX = 600
/** 每个会话的注入状态（turns/lastUserAt/anchorNext/lastOldText/lastOldAt）最多保留多少个会话。 */
export const INJECT_SESSION_LIMIT = 50
/** 同一条旧事 30 天内不重复提。 */
export const OLD_REPEAT_MS = 30 * 86_400_000
const DAY_MS = 86_400_000
/** 面板事实/实体卡/关系只读接口（web.js 的 /state 不透传新字段，这里另开一个小路由）。 */
export const MEMORY_API_PREFIX = '/dsh-aura/memory-api'

/** 事实卡 / 实体卡纯函数从存储层导出（memory.js 是公共入口）。 */
export {
  addFactToMemory as addFact,
  compactMemoryFacts,
  compactRelations,
  entitiesInText,
  forgetFactInMemory as forgetFact,
  linkCooccurrence,
  listEntitiesInMemory as listEntities,
  listFactsInMemory as listFacts,
  listRelationsInMemory as listRelations,
  queryEntitiesInMemory as queryEntities,
  queryFactsInMemory as queryFacts,
  relationsForEntityInMemory as relationsForEntity,
  upsertEntityInMemory as upsertEntity,
  upsertRelationInMemory as upsertRelation,
}

export const NOTE_MAX_CHARS = 80
export const NOTE_MAX = 30
export const EVENT_MAX = 120
export const TOPIC_MAX = 60
/** 短期 ring 里只把最近 2 条事件放进 context。 */
export const EVENT_CONTEXT_RECENT = 2
/** 事件超过 30 条时触发压实；每次把最旧 10 条汇总成 notes。 */
export const EVENT_COMPACT_THRESHOLD = 30
export const EVENT_COMPACT_BATCH = 10

/** 立即记忆：约定类笔记最长 120、重要事实笔记 80；同文本/同事实 24h 内不重复写。 */
export const IMMEDIATE_NOTE_MAX = NOTE_PROMISE_MAX
export const DEDUP_WINDOW_MS = 86_400_000
export const IMMEDIATE_PROMISE_RE = /记住|别忘|答应|说好|约好|约定|说定了/
export const DIGEST_IMPORTANT_PREDICATES = Object.freeze(['称呼', '生日', '居住地', '宠物', '喜欢', '讨厌'])

/** 会话整理：窗口最多 12 条事件 / 5 条新事实，摘要单条 ≤200 字。 */
export const DIGEST_NOTE_MAX = NOTE_DIGEST_MAX
export const DIGEST_EVENT_WINDOW = 12
export const DIGEST_FACT_WINDOW = 5

/** 话题词表（够用即可，不引入分词依赖）。 */
export const TOPIC_VOCAB = [
  '加班', '上班', '下班', '面试', '考试', '项目', '插件', '代码', 'bug', '部署', '出差',
  '周末', '假期', '旅游', '看海', '爬山', '电影', '追剧', '游戏', '开黑', '听歌', '唱歌',
  '健身', '跑步', '奶茶', '咖啡', '火锅', '外卖', '做饭', '搬家', '房租', '买房', '装修',
  '家人', '爸妈', '父母', '朋友', '同事', '领导', '老板', '对象', '恋爱', '结婚', '分手',
  '生日', '纪念日', '礼物', '生病', '医院', '失眠', '熬夜', '早睡', '养猫', '养狗', '宠物',
  '学习', '看书', '论文', '实习', '找工作', '涨薪', '辞职', '看展', '演唱会', '旅行',
  '天气', '下雨', '冬天', '夏天', '星座', '番剧', '小说', '画画', '摄影', '编程',
]

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

function newId(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------- 纯函数：相似度 / 话题 / 摘要 ----------

export function bigrams(text) {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  if (set.size === 0 && clean.length === 1) set.add(clean)
  return set
}

export function jaccard(a, b) {
  const left = a instanceof Set ? a : bigrams(a)
  const right = b instanceof Set ? b : bigrams(b)
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const gram of left) if (right.has(gram)) intersection += 1
  const union = left.size + right.size - intersection
  return union <= 0 ? 0 : intersection / union
}

export function textSimilarity(a, b) {
  return jaccard(bigrams(a), bigrams(b))
}

const STOP_CHARS = new Set(Array.from('的了吗呢吧啊呀哦嗯我你他她它在是有和就不都很还也这那么怎什'))
/** 单字重合度：解决中文 bigram 命中不了「猫」这类单关键词的问题。 */
export function charOverlap(query, text) {
  const chars = Array.from(new Set(String(query ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')))
    .filter((ch) => !STOP_CHARS.has(ch))
  if (chars.length === 0) return 0
  const target = String(text ?? '')
  let hit = 0
  for (const ch of chars) if (target.includes(ch)) hit += 1
  return hit / chars.length
}

/** 从文本里抽话题键（命中词表 + 几个常见句式），最多 3 个。 */
export function topicKeys(text) {
  const source = String(text ?? '')
  const keys = []
  const seen = new Set()
  for (const word of TOPIC_VOCAB) {
    if (source.includes(word) && !seen.has(word)) {
      seen.add(word)
      keys.push(word)
    }
  }
  const patterns = [
    /(?:在|做|忙|写|赶|搞|研究)([\u4e00-\u9fa5]{2,6})(?:的事|项目|工作|东西|任务)/g,
    /(?:看|追|玩|听|读)([\u4e00-\u9fa5]{2,8})/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const key = String(match[1] ?? '').trim()
      if (key.length >= 2 && key.length <= 8 && !seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
      if (keys.length >= 6) break
    }
  }
  return keys.slice(0, 3)
}

/** 规则摘要：不存原文全文，只留够模型回忆的片段。 */
export function ruleSummary(userText, assistantText) {
  const user = codepointSlice(String(userText ?? '').trim(), 36)
  const assistant = codepointSlice(String(assistantText ?? '').trim(), 24)
  if (!user) return ''
  return codepointSlice(assistant ? `用户说「${user}」；她回「${assistant}」` : `用户说「${user}」`, SUMMARY_MAX)
}

export function eventSalience(intensity, kind = 'chat') {
  const base = kind === 'milestone' ? 0.9 : kind === 'proactive' ? 0.55 : 0.3
  return clamp(base + (Number(intensity) || 0) * 0.45, 0, 1)
}

/** 事件裁剪：先保 salience 高的，其余按时间补满；总数 ≤ max。 */
export function trimEvents(events, max = EVENT_MAX) {
  const list = asArray(events).filter((e) => e && typeof e === 'object')
  if (list.length <= max) return list.slice()
  const bySalience = list.slice().sort((a, b) => asNumber(b.salience, 0) - asNumber(a.salience, 0))
  const keep = new Set()
  for (const event of bySalience) {
    if (keep.size >= Math.floor(max / 2)) break
    if (asNumber(event.salience, 0) >= 0.75) keep.add(event)
  }
  const rest = list
    .filter((event) => !keep.has(event))
    .sort((a, b) => asNumber(a.at, 0) - asNumber(b.at, 0))
  for (let i = rest.length - 1; i >= 0 && keep.size < max; i--) keep.add(rest[i])
  return list.filter((event) => keep.has(event)).slice(-max)
}

// ---------- 纯函数：笔记 ----------

export function makeNote(category, text, importance, now = Date.now(), dueAt = 0) {
  const clean = codepointSlice(String(text ?? '').trim(), NOTE_MAX_CHARS)
  if (!clean) return null
  return {
    id: newId('note'),
    category: ['user', 'us', 'self'].includes(category) ? category : 'user',
    text: clean,
    importance: clamp(asNumber(importance, 0.5), 0, 1),
    createdAt: now,
    updatedAt: now,
    hits: 0,
    dueAt: asNumber(dueAt, 0) || 0,
  }
}

/**
 * 合并一条笔记进 notes 数组（原地）。相似度 ≥0.5 视为同一条：更新文本/重要性，不新增。
 * 返回 { merged, note }。
 */
export function mergeNote(notes, note, max = NOTE_MAX) {
  if (!Array.isArray(notes) || !note) return { merged: false, note: null }
  const target = bigrams(note.text)
  for (const existing of notes) {
    if (!existing || typeof existing.text !== 'string') continue
    if (jaccard(target, bigrams(existing.text)) >= 0.5) {
      if (codepointLength(note.text) > codepointLength(existing.text)) existing.text = note.text
      existing.importance = Math.max(asNumber(existing.importance, 0.5), note.importance)
      existing.updatedAt = note.updatedAt
      existing.category = note.category
      // 长文本类型（digest/promise）优先，避免合并时把 200/120 字笔记降级成 80 字。
      if (note.kind === 'digest' || note.kind === 'promise') existing.kind = note.kind
      if (note.dueAt) existing.dueAt = note.dueAt
      return { merged: true, note: existing }
    }
  }
  notes.push(note)
  if (notes.length > max) {
    // 先淘汰「重要性低 + 很久没被召回」的
    let weakest = 0
    let weakestScore = Infinity
    notes.forEach((item, index) => {
      const score = asNumber(item.importance, 0.5) * 0.7 + Math.min(5, asNumber(item.hits, 0)) * 0.06
      if (score < weakestScore) {
        weakestScore = score
        weakest = index
      }
    })
    notes.splice(weakest, 1)
  }
  return { merged: false, note }
}

function recencyBonus(at, now) {
  const age = Math.max(0, now - asNumber(at, 0))
  if (age < 86_400_000) return 0.12
  if (age < 7 * 86_400_000) return 0.06
  if (age < 30 * 86_400_000) return 0.02
  return 0
}

export function emptyMemoryView() {
  return emptyMemory()
}

/** 统一取记忆：store / soul 句柄 / 裸 soul / 裸 memory 都兼容。 */
export function memoryOf(source) {
  if (!source || typeof source !== 'object') return emptyMemoryView()
  if (typeof source.read === 'function') {
    try {
      const memory = source.read()
      return memory && typeof memory === 'object' ? memory : emptyMemoryView()
    } catch {
      return emptyMemoryView()
    }
  }
  if (typeof source.get === 'function') {
    try {
      return asObject(source.get()?.memory)
    } catch {
      return emptyMemoryView()
    }
  }
  if (source.memory && typeof source.memory === 'object') return source.memory
  if (source.events || source.notes || source.topics) return source
  return emptyMemoryView()
}

function soulOf(source) {
  if (!source || typeof source !== 'object') return null
  if (typeof source.get === 'function') {
    try {
      return source.get()
    } catch {
      return null
    }
  }
  if (source.speak || source.relation || source.emotion) return source
  return null
}

/** 关键词召回笔记（纯函数，不写状态）。source 可以是 store / soul / memory。 */
export function recallNotes(source, query, options = {}) {
  const now = asNumber(options.now, Date.now())
  const limit = clamp(asNumber(options.limit, 3), 1, 8)
  const category = options.category
  const memory = memoryOf(source)
  const pool = []
  for (const key of ['user', 'us', 'self']) {
    if (category && category !== key) continue
    for (const note of asArray(memory.notes?.[key])) pool.push(note)
  }
  const queryGrams = bigrams(String(query ?? ''))
  const scored = []
  for (const note of pool) {
    if (!note || typeof note.text !== 'string') continue
    const overlap = queryGrams.size > 0 ? jaccard(queryGrams, bigrams(note.text)) : 0
    const charScore = queryGrams.size > 0 ? charOverlap(query, note.text) : 0
    if (queryGrams.size > 0 && overlap <= 0 && charScore <= 0) continue
    const score = overlap * 1.0 + charScore * 0.7 + asNumber(note.importance, 0.5) * 0.6
      + Math.min(5, asNumber(note.hits, 0)) * 0.04 + recencyBonus(note.updatedAt, now)
    scored.push({ note, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const result = scored.slice(0, limit).map(({ note }) => note)
  if (result.length === 0 && queryGrams.size > 0 && options.fallback !== false) {
    // 关键词没命中时，退而给「最重要的长期事实」（≤2 条），避免记忆段整段空掉
    return pool
      .filter((note) => asNumber(note.importance, 0.5) >= 0.75)
      .sort((a, b) => asNumber(b.importance, 0.5) - asNumber(a.importance, 0.5))
      .slice(0, Math.min(2, limit))
  }
  return result
}

/** 召回最近事件（纯函数）。 */
export function recallEvents(source, query, limit = 2, now = Date.now()) {
  const memory = memoryOf(source)
  const events = asArray(memory.events)
  const queryGrams = bigrams(String(query ?? ''))
  const scored = []
  for (const event of events) {
    if (!event || typeof event.summary !== 'string') continue
    const overlap = queryGrams.size > 0 ? jaccard(queryGrams, bigrams(event.summary)) : 0
    const charScore = queryGrams.size > 0 ? charOverlap(query, event.summary) : 0
    if (queryGrams.size > 0 && overlap <= 0 && charScore <= 0) continue
    scored.push({
      event,
      score: overlap + charScore * 0.6 + asNumber(event.salience, 0.3) * 0.5 + recencyBonus(event.at, now),
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, limit)).map(({ event }) => event)
}

/** 短期 ring 的最近 N 条事件（按写入顺序，不按关键词）。 */
export function recentEvents(source, limit = EVENT_CONTEXT_RECENT) {
  const memory = memoryOf(source)
  const n = Math.max(0, Math.round(asNumber(limit, EVENT_CONTEXT_RECENT)))
  return n > 0 ? asArray(memory.events).slice(-n) : []
}

function recentTopics(source, limit = 3, now = Date.now()) {
  const memory = memoryOf(source)
  const topics = asObject(memory.topics)
  return Object.entries(topics)
    .map(([key, value]) => ({ key, lastAt: asNumber(value?.lastAt, 0), count: asNumber(value?.count, 1) }))
    .filter((item) => now - item.lastAt < 14 * 86_400_000)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
}

// ---------- 规则抽取：用户消息 → 事实卡 / 实体卡（零 token） ----------

export const RULE_CONFIDENCE = 0.6
export const EXPLICIT_CONFIDENCE = 0.9
export const ENTITY_TYPE_LABELS = Object.freeze({
  person: '人物',
  pet: '宠物',
  place: '地点',
  project: '项目',
  other: '其他',
})
const NAME_BLACKLIST = new Set([
  '起床', '起来', '一声', '早点', '回去', '过来', '看看', '知道', '外卖', '车', '醒',
])

function cleanFactValue(raw, max) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^[\s，,、。；;：:！？!?]+/, '').replace(/[\s，,、。；;：:！？!?]+$/, '')
  text = text.replace(/^(?:了|个|份|点)/, '')
  text = text.replace(/(?:的事情|的事|的东西|之类)$/, '')
  return codepointSlice(text, max)
}

/**
 * 保守的规则抽取：只认明确句式，单条事实 ≤60 字，避免把整句复制进来。
 * 返回 { facts, entities }；confidence 规则 0.6，记住/答应/说好 0.9。
 */
export function extractFacts(text, options = {}) {
  const source = String(text ?? '').trim()
  const result = { facts: [], entities: [] }
  if (!source) return result
  const subject = codepointSlice(String(options.subject ?? '对方').trim() || '对方', 24)
  const seenFacts = new Set()
  const seenEntities = new Set()

  const pushFact = (predicate, rawValue, config = {}) => {
    const value = cleanFactValue(rawValue, config.max ?? 30)
    if (!value) return null
    const key = `${predicate}\u0001${value}`
    if (seenFacts.has(key)) return null
    seenFacts.add(key)
    const factSubject = codepointSlice(String(config.subject ?? subject).trim() || subject, 24)
    const fact = {
      subject: factSubject,
      predicate,
      value,
      text: codepointSlice(
        String(config.text ?? `${factSubject}${predicate}${value}`),
        FACT_TEXT_MAX,
      ),
      confidence: clamp(asNumber(config.confidence, RULE_CONFIDENCE), 0, 1),
      source: 'user',
    }
    result.facts.push(fact)
    return fact
  }

  const pushEntity = (rawName, type, aliases = []) => {
    const name = codepointSlice(String(rawName ?? '').trim(), 20)
    if (!name) return null
    const key = name.toLowerCase()
    if (seenEntities.has(key)) return null
    seenEntities.add(key)
    const cleanAliases = asArray(aliases)
      .map((alias) => codepointSlice(String(alias ?? '').trim(), 20))
      .filter((alias) => alias && alias.toLowerCase() !== key)
      .slice(0, 8)
    const entity = { name, type, aliases: cleanAliases }
    result.entities.push(entity)
    return entity
  }

  // 称呼：我叫/叫我 X（排除“叫我起床/叫了外卖”这类动词/量词误判）
  const nameMatch = /(?:我叫|叫我)\s*([\u4e00-\u9fa5A-Za-z0-9·]{1,12})/.exec(source)
  if (nameMatch) {
    const value = cleanFactValue(nameMatch[1], 12)
    if (value && !NAME_BLACKLIST.has(value) && !/^[我你他她]/.test(value)) {
      pushFact('称呼', value, { text: `${subject}希望被叫「${value}」`, confidence: RULE_CONFIDENCE })
    }
  }

  // 喜欢 / 讨厌（“不喜欢”归到讨厌）
  const dislikeMatch = /(?:我(?:很|也|特别|最)?讨厌|我(?:很|也|特别|最)?不喜欢)([^，,。！？!?\n]{1,30})/.exec(source)
  if (dislikeMatch) {
    const value = cleanFactValue(dislikeMatch[1], 20)
    if (value) pushFact('讨厌', value, { text: `${subject}讨厌${value}` })
  }
  const likeMatch = /(?:我(?:很|也|特别|最)?喜欢|我(?:很|也|特别|最)?爱)([^，,。！？!?\n]{1,30})/.exec(source)
  if (likeMatch) {
    const value = cleanFactValue(likeMatch[1], 20)
    if (value) pushFact('喜欢', value, { text: `${subject}喜欢${value}` })
  }

  // 宠物：优先“叫 X”的实体名；只有物种时记“养了猫”。
  let petHandled = false
  const speciesNamed = /(?:我养了|我家养了)(?:一只|一个|条|只)?([\u4e00-\u9fa5]{1,6})(?:叫|名叫)([\u4e00-\u9fa5A-Za-z0-9·]{1,8})/.exec(source)
  if (speciesNamed) {
    const species = cleanFactValue(speciesNamed[1], 6)
    const petName = cleanFactValue(speciesNamed[2], 8)
    if (species && petName) {
      pushFact('宠物', petName, { text: `${subject}养了${species}「${petName}」`, max: 8 })
      pushEntity(petName, 'pet', [species])
      petHandled = true
    }
  }
  if (!petHandled) {
    const petNamed = /(?:我养了|我家养了|我有一只|我家有只|我有只)(?:一只|一个|条|只)?(?:宠物)?(?:叫|名叫)([\u4e00-\u9fa5A-Za-z0-9·]{1,8})/.exec(source)
    if (petNamed) {
      const petName = cleanFactValue(petNamed[1], 8)
      if (petName) {
        pushFact('宠物', petName, { text: `${subject}养了宠物「${petName}」`, max: 8 })
        pushEntity(petName, 'pet')
        petHandled = true
      }
    }
  }
  if (!petHandled) {
    const petOnly = /(?:我养了|我家养了|我有一只|我家有只|我有只)(?:一只|一个|条|只)?(?:宠物)?([\u4e00-\u9fa5]{1,6})/.exec(source)
    if (petOnly) {
      const species = cleanFactValue(petOnly[1], 6)
      if (species && !/[和跟与及]/.test(species)) {
        pushFact('宠物', species, { text: `${subject}养了${species}` })
        pushEntity(species, 'pet')
      }
    }
  }

  // 居住地：我住在/我住 X
  const liveMatch = /我(?:现在)?住\s*在?\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12})/.exec(source)
  if (liveMatch) {
    const value = cleanFactValue(liveMatch[1], 12)
    if (value && !/^(?:的|在|过)/.test(value) && !/(?:地方|附近|这里|那里)$/.test(value)) {
      pushFact('居住地', value, { text: `${subject}住在${value}` })
      pushEntity(value, 'place')
    }
  }

  // 工作：我在 X 上班/工作
  const workMatch = /我在\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16}?)\s*(?:上班|工作)/.exec(source)
  if (workMatch) {
    const value = cleanFactValue(workMatch[1], 16)
    if (value) {
      pushFact('工作', value, { text: `${subject}在${value}上班` })
      pushEntity(value, 'place')
    }
  }

  // 在做 / 在学 / 在忙（一句只取一个）
  const doingPatterns = [
    ['在做', /我(?:最近)?在做([^，,。！？!?\n]{2,24})/],
    ['在学', /我(?:最近)?在学([^，,。！？!?\n]{2,24})/],
    ['在忙', /我(?:最近)?在忙([^，,。！？!?\n]{2,24})/],
    ['在做', /我(?:最近)?在写([^，,。！？!?\n]{2,24})/],
    ['在做', /我(?:最近)?在赶([^，,。！？!?\n]{2,24})/],
  ]
  for (const [predicate, pattern] of doingPatterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const value = cleanFactValue(match[1], 24)
    if (value) pushFact(predicate, value, { text: `${subject}${predicate}${value}` })
    break
  }

  // 生日：只认具体日期，避免“我生日快到了”这种模糊句
  const birthdayMatch = /(?:我的?生日|生日)(?:是|在)?\s*(\d{1,2}月\d{1,2}[日号]?|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})/.exec(source)
  if (birthdayMatch) {
    const value = cleanFactValue(birthdayMatch[1], 16)
    if (value) pushFact('生日', value, { text: `${subject}生日是${value}` })
  }

  // 约定：记住/答应/说好 X → us，显式 0.9
  const promiseMatch = /(?:记住|别忘|答应|说好|约好|约定|说定了)([^，,。！？!?\n]{1,50})/.exec(source)
  if (promiseMatch) {
    const value = cleanFactValue(promiseMatch[1], 40)
    if (value) {
      pushFact('约定', value, { subject: '你们', text: `你们约好${value}`, confidence: EXPLICIT_CONFIDENCE, max: 40 })
    }
  }

  return result
}

/** 关系边文案：团子（宠物）—养→ 木子；co 共现边用「→」。 */
function relationText(relation) {
  const fromLabel = `${relation.fromName}（${ENTITY_TYPE_LABELS[relation.fromType] || '其他'}）`
  const arrow = relation.type === 'co' ? '→ ' : `—${relation.type}→ `
  return `${fromLabel}${arrow}${relation.toName}`
}

/** 事实卡的 subject/value 是否命中某个实体名（1 跳召回用）。 */
function factTouchesEntity(fact, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (!key) return false
  const subject = String(fact.subject ?? '').trim().toLowerCase()
  const value = String(fact.value ?? '').trim().toLowerCase()
  return subject === key || subject.includes(key) || value === key || value.includes(key)
}

/**
 * 1 跳召回：query 命中的实体 → 它的关系边 → 邻居实体的相关事实。
 * 默认关系 3 条 / 关联事实 2 条（soul_recall 放宽到 6/3），可用 options 覆盖。
 * 只认真正命中的实体（fallback:false），不拿“最近实体”凑边，避免把无关记忆带进来。
 */
function recallOneHop(memory, query, options = {}) {
  const now = asNumber(options.now, Date.now())
  const hits = queryEntitiesInMemory(memory, query, 2, now, { fallback: false })
  const relations = []
  const seenRelations = new Set()
  // 同一对实体只讲一条：typed 边（养/喜欢/住在）weight 更高，会先于 co 边出现。
  const seenPairs = new Set()
  const neighbors = new Map()
  for (const entity of hits) {
    for (const relation of relationsForEntityInMemory(memory, entity.id, { limit: 4 })) {
      if (seenRelations.has(relation.id)) continue
      seenRelations.add(relation.id)
      const pairKey = [relation.from, relation.to].sort().join('|')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      relations.push(relation)
      const otherId = relation.from === entity.id ? relation.to : relation.from
      const otherName = relation.from === entity.id ? relation.toName : relation.fromName
      if (otherName) neighbors.set(otherId, otherName)
    }
  }
  const relationLimit = clamp(asNumber(options.relationLimit, 3), 1, 10)
  const factLimit = clamp(asNumber(options.factLimit, 2), 0, 6)
  const topRelations = relations.slice(0, relationLimit)
  const facts = []
  if (neighbors.size > 0 && factLimit > 0) {
    const excluded = new Set(asArray(options.excludeFacts).map((fact) => fact?.id))
    const names = [...neighbors.values()]
    for (const fact of asArray(memory?.facts)) {
      if (!fact || fact.supersededBy || excluded.has(fact.id)) continue
      if (facts.some((item) => item.id === fact.id)) continue
      if (!names.some((name) => factTouchesEntity(fact, name))) continue
      facts.push(fact)
      if (facts.length >= factLimit) break
    }
  }
  return { relations: topRelations, facts }
}

/**
 * 记忆上下文段（context order 40）。
 * source 优先是 memoryStore（read()），也兼容旧 soul 对象/句柄。
 * 总预算 ≤240，优先级：笔记 → 直接事实/实体 → 1 跳关系/关联事实 → 最近事件 → 念头 → 话题。
 * 任一优先级放不下就跳过（后面的更靠后），最后再按预算硬截断。
 */

/** 注意力窗口：从最近事件里按显著性/新鲜度/未解决挑 1–N 条，给上下文一句提醒。 */
export function attentionEvents(source, options = {}) {
  const memory = memoryOf(source)
  const now = asNumber(options.now, Date.now())
  const currentSessionId = String(options.sessionId ?? '')
  const limit = clamp(asNumber(options.limit, 2), 0, 3)
  const threshold = clamp(asNumber(options.threshold, 0.35), 0, 1)
  if (limit <= 0) return []
  const scored = []
  for (const event of asArray(memory.events)) {
    if (!event || !event.summary) continue
    const at = asNumber(event.at, 0)
    if (at <= 0 || now - at > 7 * 86_400_000) continue
    if (currentSessionId && String(event.sessionId || '') === currentSessionId && now - at < 2 * 60 * 60 * 1000) continue
    const recency = Math.exp(-(now - at) / (72 * 60 * 60 * 1000))
    const unresolved = /约定|答应|还没|下次|说好|承诺|等你|回头|没定/.test(String(event.summary)) ? 1 : 0
    const score = 0.5 * clamp(asNumber(event.salience, 0.3), 0, 1) + 0.3 * recency + 0.2 * unresolved
    if (score >= threshold) scored.push({ event, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(item => item.event)
}

/* ------------------------------------------------------------------ */
/* 记忆注入门控：每个会话的回合状态（memory.json 的 inject 字段）        */
/* ------------------------------------------------------------------ */

/** 单个会话的注入状态；坏值回落默认，不整份丢。 */
export function normalizeInjectEntry(raw) {
  const source = asObject(raw)
  return {
    turns: Math.max(0, Math.round(asNumber(source.turns, 0))),
    lastUserAt: Math.max(0, asNumber(source.lastUserAt, 0)),
    anchorNext: source.anchorNext === true,
    lastOldText: codepointSlice(String(source.lastOldText ?? '').trim(), OLD_MAX_CHARS),
    lastOldAt: Math.max(0, asNumber(source.lastOldAt, 0)),
  }
}

/** memory.json.inject：sessionId → 注入状态。空/坏值补默认。 */
export function normalizeInjectState(raw) {
  const source = asObject(raw)
  const out = {}
  for (const [sessionId, value] of Object.entries(source)) {
    const key = String(sessionId ?? '').trim()
    if (!key) continue
    out[key] = normalizeInjectEntry(value)
  }
  return out
}

/** 只保留最近活跃的 50 个会话（按 lastUserAt，其次 turns）。原地修改并返回。 */
export function pruneInjectSessions(inject, limit = INJECT_SESSION_LIMIT) {
  if (!inject || typeof inject !== 'object') return inject
  const max = Math.max(1, Math.round(asNumber(limit, INJECT_SESSION_LIMIT)))
  const entries = Object.entries(inject)
  if (entries.length <= max) return inject
  entries.sort((left, right) => {
    const byUser = asNumber(right[1]?.lastUserAt, 0) - asNumber(left[1]?.lastUserAt, 0)
    if (byUser !== 0) return byUser
    return asNumber(right[1]?.turns, 0) - asNumber(left[1]?.turns, 0)
  })
  for (const [sessionId] of entries.slice(max)) delete inject[sessionId]
  return inject
}

/** render 里取 archive（兼容 options.archive / options.getArchive / 无存档）。 */
function archiveOf(options = {}) {
  try {
    if (options.archive && typeof options.archive.randomOld === 'function') return options.archive
    if (typeof options.getArchive === 'function') {
      const value = options.getArchive()
      if (value && typeof value.randomOld === 'function') return value
    }
  } catch {
    /* 存档不可用就安静 */
  }
  return null
}

/**
 * 记忆上下文段（context order 40）。
 * source 优先是 memoryStore（read()），也兼容旧 soul 对象/句柄。
 *
 * 注入门控：
 * - 没有 sessionId（测试/面板）或 options.force=true：保持旧行为，整段渲染；
 * - 有 sessionId 时按稀疏规则：
 *   * 稳定层（笔记/事实/实体/1跳/念头/注意力/最近聊过）只在 anchor 轮注入：
 *     turns<=1、turns%anchorEvery===0、或久别/首轮（anchorNext）；
 *   * 旧事独立：turns%oldEvery===0 且 seededRandom < oldChance，或久别 anchor 轮；
 *     每轮最多 1 条，30 天内不重复，只从 archive 取（不靠 events）。
 * 顺序：笔记 → 事实/实体 → 1跳 → 上次念头 → 注意力 → 最近聊过 → 旧事。
 * 预算取 config.memoryContextBudget（夹在 60–600），超预算按现有规则丢尾部。
 */
export function renderMemoryContext(source, config = {}, options = {}) {
  if (config?.soulEnabled === false) return ''
  const now = asNumber(options.now, Date.now())
  const soul = options.soul || soulOf(source)
  const query = String(options.lastUserText ?? soul?.relation?.lastUserText ?? '')
  const limit = clamp(asNumber(config?.memoryRecallLimit, 3), 1, 3)
  const memory = memoryOf(source)
  const budget = clamp(
    asNumber(config?.memoryContextBudget, MEMORY_CONTEXT_BUDGET),
    MEMORY_CONTEXT_BUDGET_MIN,
    MEMORY_CONTEXT_BUDGET_MAX,
  )
  const parts = []
  let used = 0
  const pushPart = (text) => {
    const value = String(text ?? '')
    if (!value) return false
    const length = codepointLength(value)
    // 第一段（笔记）允许超预算：后面统一 codepointSlice 截断，
    // 否则笔记一长，整段上下文会变成空串。
    if (parts.length > 0 && used + length > budget) return false
    parts.push(value)
    used += length
    return true
  }

  const sessionId = String(options.sessionId ?? '').trim()
  const gated = sessionId !== '' && options.force !== true
  const injectStates = options.inject && typeof options.inject === 'object'
    ? normalizeInjectState(options.inject)
    : normalizeInjectState(memory?.inject)
  const injectEntry = gated ? (injectStates[sessionId] || normalizeInjectEntry(null)) : null
  const anchorEvery = clamp(asNumber(config?.memoryAnchorEveryTurns, 8), 2, 30)
  const anchor = !gated
    || injectEntry.turns <= 1
    || (injectEntry.turns > 0 && injectEntry.turns % anchorEvery === 0)
    || injectEntry.anchorNext === true

  // ①–④.5 稳定层：只有 anchor 轮才注入。
  if (anchor) {
    // ① 笔记（最高优先级）
    const notes = recallNotes(memory, query, { limit, now })
    if (notes.length > 0) {
      pushPart(`（关于对方/你们，你记得：${notes.map((note) => note.text).join('；')}）`)
    }

    // ② 直接事实 + 命中实体
    const facts = queryFactsInMemory(memory, query, 3, now)
    const entities = queryEntitiesInMemory(memory, query, 2, now)
    if (facts.length > 0 || entities.length > 0) {
      const bits = facts.map((fact) => fact.text)
      for (const entity of entities) {
        bits.push(`${entity.name}（${ENTITY_TYPE_LABELS[entity.type] || '其他'}）`)
      }
      pushPart(`（你记得：${bits.join('；')}）`)
    }

    // ③ 1 跳：关系边 + 邻居实体相关事实
    const hop = recallOneHop(memory, query, { now, excludeFacts: facts })
    if (hop.relations.length > 0) {
      pushPart(`（关联：${hop.relations.map(relationText).join('；')}）`)
    }
    if (hop.facts.length > 0) {
      pushPart(`（顺着关系想起：${hop.facts.map((fact) => fact.text).join('；')}）`)
    }

    // ④ 上次没说的念头（比最近聊过更具体，优先级更高）
    const pendingThought = soul?.speak?.pendingThought
    if (pendingThought && typeof pendingThought === 'object' && asNumber(pendingThought.expiresAt, 0) > now) {
      const thought = String(pendingThought.text ?? pendingThought.summary ?? '').trim()
      if (thought) pushPart(`（你上次想说但没说出口的念头：${thought.slice(0, 80)}）`)
    }

    // ④.5 注意力窗口：只挑最近 7 天里仍挂着的 1–2 件，和已有笔记/事实去重。
    const attentionLimit = clamp(asNumber(config?.memoryAttentionCount, 2), 0, 3)
    const attentionThreshold = clamp(asNumber(config?.memoryAttentionThreshold, 0.35), 0, 1)
    const attention = attentionEvents(memory, {
      now,
      sessionId: options.sessionId,
      limit: attentionLimit,
      threshold: attentionThreshold,
    }).filter((event) => {
      const snippet = String(event.summary || '').slice(0, 10)
      return snippet && !parts.some(part => String(part).includes(snippet))
    })
    if (attention.length > 0) {
      pushPart(`（你脑子里还挂着：${attention.map((event) => event.summary).join('；')}）`)
    }

    const topics = recentTopics(memory, 3, now)
    if (topics.length > 0 && used < 120) {
      pushPart(`（最近聊过：${topics.map((item) => item.key).join('、')}）`)
    }
  }

  // ⑤ 旧事。旧行为（无 sessionId / force）：≥N 天的 events；新行为：archive.randomOld。
  if (!gated) {
    const oldDays = clamp(asNumber(config?.memoryOldAfterDays, 30), 7, 365)
    const oldLimit = clamp(asNumber(config?.memoryOldLimit, 1), 0, 3)
    const currentSessionId = String(options.sessionId ?? '')
    if (oldLimit > 0) {
      const cutoff = now - oldDays * DAY_MS
      const old = asArray(memory.events)
        .filter(event => event && asNumber(event.at, 0) > 0 && asNumber(event.at, 0) <= cutoff)
        .filter(event => !currentSessionId || String(event.sessionId || '') !== currentSessionId)
        .sort((a, b) => asNumber(b.at, 0) - asNumber(a.at, 0))
        .slice(0, oldLimit)
      if (old.length > 0) {
        pushPart(`（旧事，${oldDays} 天以前：${old.map((event) => event.summary).join('；')}）`)
      }
    }
    return codepointSlice(parts.join(''), budget)
  }

  const oldLimit = clamp(asNumber(config?.memoryOldLimit, 1), 0, 3)
  if (oldLimit > 0) {
    const oldEvery = clamp(asNumber(config?.memoryOldEveryTurns, 20), 5, 100)
    const oldChance = clamp(asNumber(config?.memoryOldChance, 0.3), 0, 1)
    const mode = config?.memoryOldMode === 'exceptRecent' ? 'exceptRecent' : 'days'
    const spanDays = mode === 'exceptRecent'
      ? clamp(asNumber(config?.memoryOldRecentDays, 3), 1, 30)
      : clamp(asNumber(config?.memoryOldAfterDays, 30), 7, 365)
    const random = typeof options.random === 'function'
      ? options.random
      : seededRandom(`${sessionId}|${injectEntry.turns}|old`)
    const byEvery = injectEntry.turns >= 1
      && injectEntry.turns % oldEvery === 0
      && random() < oldChance
    // 久别（anchorNext）：首轮不算久别，避免刚开场就翻旧账。
    const byAnchor = injectEntry.anchorNext === true && injectEntry.turns > 1
    const archive = archiveOf(options)
    if (archive && (byEvery || byAnchor)) {
      const sameRender = injectEntry.lastOldAt > 0 && Math.abs(now - injectEntry.lastOldAt) < 5000
      const repeatBlocked = !!injectEntry.lastOldText
        && injectEntry.lastOldAt > 0
        && !sameRender
        && (now - injectEntry.lastOldAt) < OLD_REPEAT_MS
      // 同一 turn 多次渲染时沿用同一次抽样（lastOldAt≈now），保证结果一致。
      const picked = sameRender && injectEntry.lastOldText
        ? { text: injectEntry.lastOldText, at: injectEntry.lastOldAt, sessionId }
        : archive.randomOld({
          before: now - spanDays * DAY_MS,
          excludeSessionId: sessionId,
          seed: `${sessionId}|${injectEntry.turns}|pick`,
          minChars: OLD_MIN_CHARS,
          maxChars: OLD_MAX_CHARS,
          excludeText: repeatBlocked ? injectEntry.lastOldText : '',
        })
      if (picked && picked.text) {
        pushPart(`（旧事，${spanDays} 天以前：${picked.text}）`)
        const nextEntry = {
          ...injectEntry,
          lastOldText: codepointSlice(String(picked.text).trim(), OLD_MAX_CHARS),
          lastOldAt: now,
        }
        if (options.inject && typeof options.inject === 'object') options.inject[sessionId] = nextEntry
        if (memory && typeof memory === 'object') {
          if (!memory.inject || typeof memory.inject !== 'object') memory.inject = {}
          memory.inject[sessionId] = nextEntry
        }
        if (typeof options.saveInject === 'function') options.saveInject(sessionId, nextEntry)
      }
    }
  }

  return codepointSlice(parts.join(''), budget)
}

// ---------- 压实：最旧事件 → notes ----------

const DISCLOSURE_RE = /(我叫|叫我|我喜欢|我讨厌|我不喜欢|我养了|我生日|我最近|我在做|我在忙|我明天|我下周|我周末|答应|说好|约好)/

function noteFromEvent(event) {
  const summary = String(event?.summary ?? '').trim()
  if (!summary) return null
  const topics = asArray(event?.topics).map((topic) => String(topic).slice(0, 8)).filter(Boolean).slice(0, 3)
  if (event.kind === 'milestone') {
    return { category: 'us', text: codepointSlice(`你们：${summary}`, NOTE_MAX_CHARS), importance: 0.75 }
  }
  if (event.kind === 'proactive') {
    return { category: 'self', text: codepointSlice(`我主动开口：${summary}`, NOTE_MAX_CHARS), importance: 0.5 }
  }
  const userMatch = /用户说「([\s\S]*?)」/.exec(summary)
  const userText = String(userMatch?.[1] ?? '').trim()
  if (userText && DISCLOSURE_RE.test(userText)) {
    return { category: 'user', text: codepointSlice(userText, NOTE_MAX_CHARS), importance: 0.65 }
  }
  if (topics.length > 0) {
    return { category: 'us', text: `聊过${topics.join('、')}`, importance: 0.45 }
  }
  if (userText) return { category: 'us', text: codepointSlice(`聊过：${userText}`, NOTE_MAX_CHARS), importance: 0.4 }
  return { category: 'us', text: codepointSlice(summary, NOTE_MAX_CHARS), importance: 0.4 }
}

/**
 * 把最旧的一批事件按 topic/反思规则汇总成 notes，并从 events 删除。
 * 默认只在事件超过 threshold(30) 时触发；force=true 时按 count 强制压实。
 * @returns {{compacted:number, notesAdded:number, eventsLeft:number}}
 */
export function compactEvents(memory, options = {}) {
  if (!memory || typeof memory !== 'object') {
    return { compacted: 0, notesAdded: 0, eventsLeft: 0 }
  }
  const events = asArray(memory.events)
  const threshold = Math.max(1, Math.round(asNumber(options.threshold, EVENT_COMPACT_THRESHOLD)))
  const force = options.force === true
  if (!force && events.length <= threshold) {
    return { compacted: 0, notesAdded: 0, eventsLeft: events.length }
  }
  const count = Math.max(1, Math.min(events.length, Math.round(asNumber(options.count, EVENT_COMPACT_BATCH))))
  const oldest = events.slice(0, count)
  memory.events = events.slice(count)
  if (!memory.notes || typeof memory.notes !== 'object') memory.notes = { user: [], us: [], self: [] }
  for (const key of ['user', 'us', 'self']) {
    if (!Array.isArray(memory.notes[key])) memory.notes[key] = []
  }
  const maxNotes = clamp(asNumber(options.maxNotes, NOTE_MAX), 5, NOTE_MAX)
  let notesAdded = 0
  for (const event of oldest) {
    const candidate = noteFromEvent(event)
    if (!candidate) continue
    const made = makeNote(
      candidate.category,
      codepointSlice(candidate.text, NOTE_MAX_CHARS),
      candidate.importance,
      asNumber(event?.at, Date.now()),
    )
    if (!made) continue
    const result = mergeNote(memory.notes[candidate.category], made, maxNotes)
    if (!result.merged) notesAdded += 1
  }
  for (const key of ['user', 'us', 'self']) {
    memory.notes[key] = asArray(memory.notes[key]).slice(-maxNotes)
  }
  return { compacted: oldest.length, notesAdded, eventsLeft: memory.events.length }
}

// ---------- 反思 ----------

const SELF_DISCLOSURE_RE = /(我叫|叫我|我喜欢|我讨厌|我不喜欢|我养了|我生日|我最近|我在做|我在忙|我明天|我下周|我周末|答应|说好|约好|我想去)/
const CONFLICT_RE = /(生气|吵架|烦你|讨厌你|不想理你|别跟我说话|冷战)/
const MAKE_UP_RE = /(对不起|抱歉|没事了|和好了|原谅|不怪你)/

/** 规则反思：从待反思的回合里抽事件/话题/笔记/关系变化（零 token）。纯函数。 */
export function analyzeRuleReflection(turns, now = Date.now()) {
  const list = asArray(turns).filter((turn) => turn && typeof turn.userText === 'string')
  const userText = list.map((turn) => turn.userText).join('\n')
  const lastUserText = list.length > 0 ? list[list.length - 1].userText : ''
  const newNotes = []
  const addNote = (category, text, importance, dueAt = 0) => {
    const note = makeNote(category, text, importance, now, dueAt)
    if (note) newNotes.push(note)
  }

  const name = /(?:我叫|叫我)([\u4e00-\u9fa5A-Za-z0-9]{1,12})/.exec(userText)
  if (name) addNote('user', `用户叫「${name[1]}」`, 0.9)

  const likes = /(?:我喜欢|我爱)([^，。！？\n]{1,20})/.exec(userText)
  if (likes) addNote('user', `用户喜欢${likes[1]}`, 0.75)

  const dislikes = /(?:我讨厌|我不喜欢)([^，。！？\n]{1,20})/.exec(userText)
  if (dislikes) addNote('user', `用户不喜欢${dislikes[1]}`, 0.75)

  const pet = /(?:我养了|我家)([^，。！？\n]{1,16})/.exec(userText)
  if (pet) addNote('user', `用户提到${pet[1]}`, 0.7)

  const busy = /(?:我最近在|我在做|我在忙|我在写|我在赶)([^，。！？\n]{2,24})/.exec(userText)
  if (busy) addNote('user', `用户最近在${busy[1]}`, 0.7)

  const plan = /(明天|后天|下周|周末|下个月)(?:要|会|得|去)([^，。！？\n]{1,24})/.exec(userText)
  let dueAt = 0
  if (plan) {
    const dayOffset = plan[1] === '明天' ? 1 : plan[1] === '后天' ? 2 : plan[1] === '下周' ? 7 : 0
    if (dayOffset > 0) {
      const d = new Date(now)
      d.setDate(d.getDate() + dayOffset)
      d.setHours(9, 0, 0, 0)
      dueAt = d.getTime()
    }
    addNote('us', `用户说过${plan[1]}要去${plan[2]}`, 0.7, dueAt)
  }

  const promise = /(?:答应|说好|约好)([^，。！？\n]{1,24})/.exec(userText)
  if (promise) addNote('us', `你们约好${promise[1]}`, 0.75)

  const affection = /(想你|喜欢你|爱你|抱抱)/.exec(userText)
  if (affection) addNote('us', '用户表达过亲近（想你/喜欢你）', 0.8)

  let relationDelta = 0
  if (CONFLICT_RE.test(userText)) relationDelta -= 1
  if (MAKE_UP_RE.test(userText)) relationDelta += 1
  if (affection) relationDelta += 1.2
  relationDelta = clamp(relationDelta, -2, 2)

  const stateMatch = /(累|困|忙|烦|难过|开心|兴奋|无聊|焦虑)/.exec(lastUserText)
  const userState = stateMatch ? stateMatch[1] : ''

  const topics = topicKeys(userText)
  const summary = ruleSummary(lastUserText, '')

  return {
    summary,
    topics,
    newNotes: newNotes.slice(0, 4),
    relationDelta,
    milestone: '',
    userState,
    closer: false,
    addressPreferred: name ? name[1] : '',
  }
}

export function buildReflectionPrompt({ turns, emotion, relation, existingNotes }) {
  const lines = []
  for (const turn of asArray(turns).slice(-6)) {
    lines.push(`用户：${codepointSlice(turn.userText, 120)}`)
    if (turn.assistantText) lines.push(`她：${codepointSlice(turn.assistantText, 80)}`)
  }
  const notes = asArray(existingNotes).slice(0, 8).map((note) => `- ${note.text}`).join('\n') || '（空）'
  return [
    '你在帮一个陪伴型 AI 整理刚才这段对话的记忆。只输出一行 JSON，不要解释，不要 markdown 代码块。',
    '',
    '最近对话：',
    lines.join('\n') || '（空）',
    '',
    `她此刻的情绪：${emotion?.transient?.label ?? '平静'}（愉悦 ${(Number(emotion?.transient?.valence) || 0).toFixed(2)}，`
      + `唤醒 ${(Number(emotion?.transient?.arousal) || 0.2).toFixed(2)}，亲近 ${(Number(emotion?.affection) || 0.5).toFixed(2)}）`,
    `当前关系阶段：${relation?.stage ?? 'stranger'}，关系分：${Number(relation?.score) || 0}`,
    '已有笔记（避免重复）：',
    notes,
    '',
    '输出字段：',
    '{"summary":"≤60 字，这段对话发生了什么",',
    ' "topics":["≤4 字话题键","最多 3 个"],',
    ' "salience":0.0,',
    ' "newNotes":[{"category":"user|us|self","text":"≤60 字，一条值得长期记住的事实/偏好/承诺/认识","importance":0.0}],',
    ' "relationDelta":-2.0,',
    ' "milestone":"可选：一句话里程碑",',
    ' "userState":"可选：一两字状态词，如累/忙/开心",',
    ' "closer":true,',
    ' "addressPreferred":"可选：用户希望被怎么称呼"}',
    '',
    '规则：newNotes 最多 2 条，没有值得记的就给空数组；隐私（住址/证件/账号/感情细节）不写具体内容；不要重复已有笔记；反讽/玩笑不要当事实记。',
  ].join('\n')
}

export function parseReflectionOutput(out) {
  const raw = String(out ?? '')
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
  const match = stripped.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const newNotes = asArray(parsed.newNotes)
    .filter((note) => note && typeof note.text === 'string' && note.text.trim())
    .slice(0, 2)
    .map((note) => makeNote(
      ['user', 'us', 'self'].includes(note.category) ? note.category : 'user',
      note.text,
      clamp(asNumber(note.importance, 0.6), 0, 1),
    ))
    .filter(Boolean)
  return {
    summary: codepointSlice(String(parsed.summary ?? '').trim(), SUMMARY_MAX),
    topics: asArray(parsed.topics).map((x) => String(x).trim().slice(0, 8)).filter(Boolean).slice(0, 3),
    newNotes,
    relationDelta: clamp(asNumber(parsed.relationDelta, 0), -2, 2),
    milestone: codepointSlice(String(parsed.milestone ?? '').trim(), 60),
    userState: codepointSlice(String(parsed.userState ?? '').trim(), 4),
    closer: parsed.closer === true,
    addressPreferred: codepointSlice(String(parsed.addressPreferred ?? '').trim(), 20),
  }
}

/** soul_memory 工具输出的人类可读文本（真正的返回值仍是 JSON）。 */
export function renderMemoryToolText(value) {
  const result = asObject(value)
  const reason = String(result.reason ?? result.error ?? '')
  const fmtCounts = (counts) => {
    const source = asObject(counts)
    return `事件 ${asNumber(source.events, 0)} · 笔记 ${asNumber(source.notes, 0)}`
      + ` · 事实 ${asNumber(source.facts, 0)} · 实体 ${asNumber(source.entities, 0)}`
      + ` · 关系 ${asNumber(source.relations, 0)}`
  }
  if (result.ok === false) return `没成功：${reason || '未知原因'}`
  if (result.sessionId && result.window) {
    const window = asObject(result.window)
    const topics = asArray(window.topics).map((topic) => String(topic)).filter(Boolean)
    const lines = [`会话整理完成：写了 ${result.note ? 1 : 0} 条笔记 · 事件 ${asNumber(window.events, 0)} 条 · 新增事实 ${asNumber(window.facts, 0)} 条`]
    if (result.note && result.note.text) lines.push(`- ${String(result.note.text)}`)
    if (topics.length > 0) lines.push(`聊到：${topics.join('、')}`)
    return lines.join('\n')
  }
  if (result.before && result.after) {
    return `整理完成：\n${fmtCounts(result.before)}\n→ ${fmtCounts(result.after)}`
  }
  if ('lastCompactDayKey' in result) {
    const last = String(result.lastCompactDayKey || '')
    return `记忆库：${fmtCounts(result.counts)}；上次整理 ${last || '还没整理'}；待办 ${asNumber(result.pendingDue, 0)} 条`
  }
  if (Array.isArray(result.notes) && Array.isArray(result.facts) && Array.isArray(result.entities)) {
    const lines = []
    for (const note of result.notes) lines.push(`- 笔记：${String(note?.text ?? '')}`)
    for (const fact of result.facts) lines.push(`- 事实：${fact?.subject} · ${fact?.predicate} · ${fact?.value}`)
    for (const entity of result.entities) lines.push(`- 实体：${entity?.name}`)
    for (const relation of result.relations) lines.push(`- 关系：${relation?.fromName} → ${relation?.toName}`)
    return lines.length > 0 ? lines.join('\n') : '（没搜到）'
  }
  if (result.entity && result.removedRelations !== undefined) {
    return `删掉了实体「${result.entity.name}」，清掉 ${asNumber(result.removedRelations, 0)} 条关系`
  }
  if (result.fact && result.fact.subject !== undefined) {
    return `记下了：${result.fact.subject} · ${result.fact.predicate} · ${result.fact.value}`
      + (result.merged ? '（已合并同类）' : '')
  }
  if (result.deleted) return `删掉了事实卡 ${String(result.id ?? '')}`
  if (result.note && result.removed) return `删掉了笔记：${String(result.note.text ?? '')}`
  if (result.note && Array.isArray(result.updated)) return `已更新：${String(result.note.text ?? '')}`
  if (result.fromName && result.toName) {
    return `已合并「${result.fromName}」到「${result.toName}」：改事实 ${asNumber(result.factsUpdated, 0)} 条，`
      + `迁移关系 ${asNumber(result.relationsRedirected, 0)} 条`
  }
  if (result.note) {
    return `已记住：${String(result.note.text ?? '')}（id ${String(result.id ?? result.note.id ?? '')}）`
  }
  return '完成'
}

// ---------- 安装 ----------

/**
 * 安装记忆层。兼容两种调用：
 *   installMemory(ctx, { state, soul, log })   // index.js 现有写法
 *   installMemory({ ctx, state, soul, log })    // 新写法
 */
export function installMemory(ctxOrOptions, maybeOptions = {}) {
  let ctx
  let options
  // 不能直接探 ctxOrOptions.ctx：旧调用第一个参数就是 Cordis ctx 代理，
  // 读不存在的属性会触发 "cannot get property ctx without inject" 而让整插件装不上。
  if (maybeOptions && typeof maybeOptions === 'object' && ('state' in maybeOptions || 'soul' in maybeOptions)) {
    ctx = ctxOrOptions
    options = maybeOptions || {}
  } else if (ctxOrOptions && typeof ctxOrOptions === 'object' && ctxOrOptions !== null
    && Object.prototype.hasOwnProperty.call(ctxOrOptions, 'ctx')) {
    ctx = ctxOrOptions.ctx
    options = ctxOrOptions
  } else {
    ctx = ctxOrOptions
    options = maybeOptions || {}
  }
  const { state, soul, log, timers, getArchive } = options
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  const disabledApi = {
    snapshot: () => ({}),
    renderContext: () => '',
    recall: () => [],
    pendingDue: () => [],
    note: () => ({ ok: false }),
    addFact: () => ({ ok: false }),
    queryFacts: () => [],
    listFacts: () => [],
    forgetFact: () => false,
    upsertEntity: () => ({ ok: false }),
    listEntities: () => [],
    listRelations: () => [],
    relationsForEntity: () => [],
    upsertRelation: () => ({ ok: false }),
    compactRelations: () => ({ relationsPruned: 0, relationsDecayed: 0 }),
    extractFacts: () => ({ facts: [], entities: [] }),
    reflect: async () => ({ ok: false }),
    compact: () => ({
      compacted: 0, notesAdded: 0, eventsLeft: 0,
      factsMerged: 0, factsPruned: 0, factsDecayed: 0, entitiesPruned: 0,
      relationsPruned: 0, relationsDecayed: 0,
    }),
    onUserMessage: () => {},
    onAssistantMessage: () => {},
    onTurnEnd: () => {},
    digest: async () => ({ ok: false, reason: 'disabled', sessionId: '', note: null, facts: [], window: null }),
    clear: () => ({ ok: false }),
    store: null,
    memoryStore: null,
  }
  if (!soul || typeof soul.get !== 'function') {
    logger('[soul] memory 未收到 soul 容器，本模块跳过安装')
    return disabledApi
  }

  const readSoul = () => soul.get()
  const home = (() => {
    try {
      return typeof state?.stateDir === 'function' ? state.stateDir() : undefined
    } catch {
      return undefined
    }
  })()
  let store
  try {
    store = createMemoryStore({ home, log: logger })
  } catch (error) {
    logger('[soul] memory.json 存储初始化失败:', error instanceof Error ? error.message : error)
    return disabledApi
  }

  // ---------- 会话注入状态（memory.json.inject）----------
  // memory-store 的 normalize 只认它自己的字段；inject 是本模块的元数据，
  // 在 store.read/write 外面包一层，避免被 normalize 丢掉。
  const injectSessions = (() => {
    try {
      const raw = JSON.parse(readFileSync(store.file, 'utf8'))
      return pruneInjectSessions(normalizeInjectState(raw?.inject))
    } catch {
      return {}
    }
  })()

  function persistInject() {
    try {
      let raw = {}
      try {
        raw = JSON.parse(readFileSync(store.file, 'utf8'))
      } catch {
        raw = {}
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = { version: MEMORY_VERSION }
      raw.inject = injectSessions
      const target = store.file
      const tmp = `${target}.${process.pid}.inject.tmp`
      writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
      renameSync(tmp, target)
    } catch (error) {
      logger('[soul] memory inject 状态写入失败:', error instanceof Error ? error.message : error)
    }
  }

  function saveInjectEntry(sessionId, entry) {
    const key = String(sessionId ?? '').trim()
    if (!key) return
    injectSessions[key] = normalizeInjectEntry(entry)
    pruneInjectSessions(injectSessions)
    persistInject()
  }

  const storeRead = store.read.bind(store)
  const storeWrite = store.write.bind(store)
  store.read = () => ({ ...storeRead(), inject: injectSessions })
  store.write = (next) => {
    const memory = storeWrite(next)
    persistInject()
    return { ...memory, inject: injectSessions }
  }

  const readMemory = () => store.read()

  const localDefaults = {
    soulEnabled: true,
    emotionScope: 'qq',
    memoryEnabled: true,
    memoryAutoCompact: true,
    memoryMaxEvents: EVENT_MAX,
    memoryMaxNotes: NOTE_MAX,
    memoryReflectionEvery: 3,
    memoryDiaryEnabled: false,
    memoryRecallLimit: 3,
    memoryContextBudget: MEMORY_CONTEXT_BUDGET,
    memoryAnchorEveryTurns: 8,
    memoryInjectIdleMinutes: 360,
    memoryOldAfterDays: 30,
    memoryOldMode: 'days',
    memoryOldRecentDays: 3,
    memoryOldEveryTurns: 20,
    memoryOldChance: 0.3,
    memoryOldLimit: 1,
    memoryAttentionCount: 2,
    memoryAttentionThreshold: 0.35,
    memoryImmediate: true,
    memorySessionDigest: true,
    memoryDigestIdleMinutes: 360,
    memoryDigestDailyCap: 2,
    memoryReflectionLlm: false,
    memoryProvider: '',
    memoryModel: '',
  }
  const readConfig = () => {
    let raw = {}
    try {
      raw = typeof state?.readConfig === 'function' ? state.readConfig() : {}
    } catch {
      raw = {}
    }
    return { ...localDefaults, ...(raw && typeof raw === 'object' ? raw : {}) }
  }

  function localDayKey(ms = Date.now()) {
    const date = new Date(asNumber(ms, Date.now()))
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  /** 事实卡里的“对方”用当前昵称，没有昵称时退回通用称呼。 */
  function userFactSubject() {
    const config = readConfig()
    const current = readSoul()
    const nickname = String(config?.soulUserNickname || '').trim()
      || String(current?.identity?.address?.userPreferred || '').trim()
      || '对方'
    return codepointSlice(nickname, 24)
  }

  /** 用户消息 → 事实卡/实体卡 + 实体共现边（零 token；都没命中就不写盘）。 */
  function applyUserFacts(text, now = Date.now(), source = 'user') {
    const extracted = extractFacts(text, { subject: userFactSubject(), now })
    const hasFacts = extracted.facts.length > 0 || extracted.entities.length > 0
    if (!hasFacts) {
      // 规则没抽到东西时，还要确认这句话是否提到了 ≥2 个已知实体（co 边）；
      // 都没提到就不写盘，保持“没内容不动磁盘”。
      let mentioned = []
      try {
        mentioned = entitiesInText(store.read(), text)
      } catch {
        mentioned = []
      }
      if (mentioned.length < 2) return { facts: 0, entities: 0, edges: 0 }
    }
    let facts = 0
    let edges = 0
    try {
      store.update((memory) => {
        for (const entity of extracted.entities) {
          upsertEntityInMemory(memory, entity.name, { type: entity.type, aliases: entity.aliases }, now)
        }
        for (const fact of extracted.facts) {
          // 同一个事实 24h 内不重复写（addFact 会刷新 lastSeenAt，这里直接跳过）。
          if (hasFreshFact(memory, fact, now)) continue
          const result = addFactToMemory(memory, { ...fact, source }, now)
          if (result?.ok) facts += 1
        }
        // 同一段话里出现的多个实体两两建 co 边（首次 0.3，再次 +0.1）。
        const coEntities = entitiesInText(memory, text)
        if (coEntities.length > 1) edges = linkCooccurrence(memory, coEntities, now).edges
        return memory
      })
    } catch (error) {
      logger('[soul] 事实抽取写入失败:', error instanceof Error ? error.message : error)
    }
    return { facts, entities: extracted.entities.length, edges }
  }

  /**
   * 立即记忆去重：同一段文本已经在笔记里（24h 内）就不再写。
   * 只在立即记忆/重要事实路径使用；普通 soul_memory writeNote 不受影响。
   */
  function findFreshNote(memory, text, now) {
    for (const key of ['user', 'us', 'self']) {
      for (const note of asArray(memory?.notes?.[key])) {
        if (!note || note.text !== text) continue
        if (now - asNumber(note.updatedAt, note.createdAt) < DEDUP_WINDOW_MS) return note
      }
    }
    return null
  }

  /** 同一个事实（subject+predicate+value）24h 内不重复写。 */
  function hasFreshFact(memory, fact, now) {
    const subject = String(fact?.subject ?? '')
    const predicate = String(fact?.predicate ?? '')
    const value = String(fact?.value ?? '')
    if (!subject || !predicate || !value) return false
    return asArray(memory?.facts).some((item) => item && !item.supersededBy
      && item.subject === subject && item.predicate === predicate && item.value === value
      && now - asNumber(item.lastSeenAt, 0) < DEDUP_WINDOW_MS)
  }

  /**
   * 重要信息立即入记忆（零 token）：
   * - 命中「记住/别忘/答应/说好/约好/约定/说定了」→ notes.us 一条（≤120，0.9）；
   * - 名字/生日/住址/宠物/好恶命中 → notes.user 各一条（0.8）；
   * - 同文本 24h 内不重复写；memoryImmediate=false 时整段跳过（事实抽取不受影响）。
   */
  function applyImmediateNotes(text, now, config) {
    const promiseHit = IMMEDIATE_PROMISE_RE.test(text)
    const extracted = extractFacts(text, { subject: userFactSubject(), now })
    const important = extracted.facts.filter((fact) => DIGEST_IMPORTANT_PREDICATES.includes(fact.predicate))
    if (!promiseHit && important.length === 0) return { notes: 0, skipped: 0, facts: 0 }
    const promiseFact = extracted.facts.find((fact) => fact.predicate === '约定') || null
    const maxNotes = clamp(asNumber(config?.memoryMaxNotes, NOTE_MAX), 5, NOTE_MAX)
    let added = 0
    let skipped = 0
    try {
      store.update((memory) => {
        if (!memory.notes || typeof memory.notes !== 'object') memory.notes = { user: [], us: [], self: [] }
        for (const key of ['user', 'us', 'self']) {
          if (!Array.isArray(memory.notes[key])) memory.notes[key] = []
        }
        const push = (category, rawText, importance, kind) => {
          const limit = kind === 'promise' ? IMMEDIATE_NOTE_MAX : NOTE_MAX_CHARS
          const clean = codepointSlice(String(rawText ?? '').trim(), limit)
          if (!clean) return
          if (findFreshNote(memory, clean, now)) {
            skipped += 1
            return
          }
          const made = {
            id: newId('note'),
            category,
            kind,
            text: clean,
            importance: clamp(asNumber(importance, 0.6), 0, 1),
            createdAt: now,
            updatedAt: now,
            hits: 0,
            dueAt: 0,
          }
          const merged = mergeNote(memory.notes[category], made, maxNotes)
          if (!merged.merged) added += 1
        }
        for (const fact of important) push('user', fact.text, 0.8, 'immediate')
        if (promiseHit) {
          const fallback = codepointSlice(
            String(text ?? '').replace(/[\s，,。；;：:！？!?]+$/g, ''),
            IMMEDIATE_NOTE_MAX - 5,
          )
          const value = promiseFact ? promiseFact.value : fallback
          if (value) push('us', `你们约定：${value}`, 0.9, 'promise')
        }
        return memory
      })
    } catch (error) {
      logger('[soul] 立即记忆写入失败:', error instanceof Error ? error.message : error)
    }
    return { notes: added, skipped, facts: important.length, promise: promiseHit }
  }

  // ⓪ 首次升级：soul.memory → memory.json（只发生一次，失败不阻塞启动）
  try {
    let legacy = asObject(readSoul()?.memory)
    if (!hasMemoryContent(legacy) && typeof state?.readJson === 'function') {
      try {
        const rawSoul = state.readJson('soul.json', null)
        if (hasMemoryContent(rawSoul?.memory)) legacy = rawSoul.memory
      } catch {
        /* ignore */
      }
    }
    if (hasMemoryContent(legacy)) {
      const migration = store.migrateFromSoul({
        memory: legacy,
        clearMemory: () => {
          const current = readSoul()
          if (current && typeof current === 'object') current.memory = {}
          try {
            soul.saveNow?.({ reason: 'memory-migrate', skipBackup: true, force: true })
          } catch (error) {
            logger('[soul] 迁移后清理 soul.json 失败:', error instanceof Error ? error.message : error)
          }
        },
      })
      if (migration && migration.migrated) {
        logger(`[soul] 短期记忆已迁到 memory.json：${migration.events} 事件 / ${migration.notes} 笔记 / ${migration.topics} 话题`)
      } else if (migration && migration.reason === 'exists') {
        logger('[soul] memory.json 已存在，已清理 soul.json 里的旧 memory')
      }
    }
  } catch (error) {
    logger('[soul] 记忆迁移失败（继续使用 memory.json）:', error instanceof Error ? error.message : error)
  }

  let pending = null
  let reflectBuffer = []
  let reflecting = false
  let lastReflectAttempt = 0

  /** 会话整理定时器：sessionId → timer；新消息取消、turnEnd 重排。 */
  const digestTimers = new Map()
  const setTimer = timers && typeof timers.setTimeout === 'function' ? timers.setTimeout.bind(timers) : setTimeout
  const clearTimer = timers && typeof timers.clearTimeout === 'function' ? timers.clearTimeout.bind(timers) : clearTimeout

  // ① 记忆 context（order 40，只对 QQ 陪伴会话）
  try {
    ctx.systemPrompt?.context?.({
      name: 'aura:memory',
      order: 40,
      text: (assembly) => {
        try {
          const config = readConfig()
          if (config.memoryEnabled === false) return ''
          const sessionId = String(assembly?.agent?.session?.id ?? assembly?.agent?.session?.header?.id ?? '')
          if (assembly && !assembly.agent && config.emotionScope !== 'all') return ''
          const preset = String(assembly?.agent?.session?.header?.agentPreset ?? '')
          if (!isSoulSession(config, sessionId, preset)) return ''
          return renderMemoryContext(store, config, {
            soul: readSoul(),
            sessionId,
            getArchive: () => (typeof getArchive === 'function' ? getArchive() : undefined),
            saveInject: saveInjectEntry,
          })
        } catch (error) {
          logger('[soul] memory context 渲染失败:', error instanceof Error ? error.message : error)
          return ''
        }
      },
    })
  } catch (error) {
    logger('[soul] memory context 注册失败:', error instanceof Error ? error.message : error)
  }

  // ② 事件流 / 话题索引写入（只写 memory.json）
  function pushEvent(event) {
    try {
      const config = readConfig()
      let stored = event
      store.update((memory) => {
        const events = asArray(memory.events)
        // 去重：同一事件（同 kind + 摘要 + 会话）在 1.5 秒内重复出现，多半是
        // session/event 在 agent resume/replay 时被再次投递；不要重复记账。
        const last = events[events.length - 1]
        if (last
          && last.kind === event.kind
          && last.summary === event.summary
          && String(last.sessionId ?? '') === String(event.sessionId ?? '')
          && Math.abs(Number(last.at ?? 0) - Number(event.at ?? 0)) < 1500) {
          stored = last
          return memory
        }
        events.push(event)
        memory.events = trimEvents(events, clamp(asNumber(config.memoryMaxEvents, EVENT_MAX), 5, EVENT_MAX))
        if (!memory.topics || typeof memory.topics !== 'object') memory.topics = {}
        for (const topic of asArray(event.topics)) {
          const key = String(topic).slice(0, 8)
          if (!key) continue
          const entry = asObject(memory.topics[key])
          memory.topics[key] = { lastAt: event.at, count: asNumber(entry.count, 0) + 1 }
        }
        const keys = Object.keys(memory.topics)
        if (keys.length > TOPIC_MAX) {
          const keep = keys
            .sort((a, b) => asNumber(memory.topics[b]?.lastAt, 0) - asNumber(memory.topics[a]?.lastAt, 0))
            .slice(0, TOPIC_MAX)
          memory.topics = Object.fromEntries(keep.map((key) => [key, memory.topics[key]]))
        }
        // 记录会话最近活动时间（会话整理的「空闲」判定用）。
        if (event.sessionId) {
          if (!memory.digests || typeof memory.digests !== 'object') memory.digests = {}
          const previous = asObject(memory.digests[event.sessionId])
          memory.digests[event.sessionId] = {
            lastAt: asNumber(previous.lastAt, 0),
            lastEventAt: Math.max(asNumber(previous.lastEventAt, 0), asNumber(event.at, 0)),
            turns: Math.max(0, Math.round(asNumber(previous.turns, 0))),
          }
        }
        // ring 超阈值时顺手压实最旧 10 条，避免事件无限涨。
        if (memory.events.length > EVENT_COMPACT_THRESHOLD) {
          compactEvents(memory, { threshold: EVENT_COMPACT_THRESHOLD })
        }
        // 同一事件摘要里出现的实体两两建 co 边（首次 0.3，重复出现 +0.1，上限 1）。
        const coEntities = entitiesInText(memory, event.summary)
        if (coEntities.length > 1) linkCooccurrence(memory, coEntities, event.at)
        return memory
      })
      return stored
    } catch (error) {
      logger('[soul] memory 事件写入失败:', error instanceof Error ? error.message : error)
      return event
    }
  }

  function makeEvent({ kind, summary, topics, salience, sessionId, at, source }) {
    const current = readSoul()
    return {
      id: newId('evt'),
      at: asNumber(at, Date.now()),
      kind: ['chat', 'proactive', 'milestone', 'diary', 'note'].includes(kind) ? kind : 'chat',
      summary: codepointSlice(String(summary ?? '').trim(), SUMMARY_MAX),
      salience: clamp(asNumber(salience, 0.3), 0, 1),
      topics: asArray(topics).map((topic) => String(topic).slice(0, 8)).filter(Boolean).slice(0, 4),
      mood: {
        label: current?.emotion?.transient?.label ?? '',
        valence: Number(current?.emotion?.transient?.valence) || 0,
      },
      source: source || 'rule',
      sessionId: String(sessionId ?? ''),
    }
  }

    // ②.5 会话整理（规则，零 token；手动/定时共用）

  function digestIdleMs(config = readConfig()) {
    return clamp(asNumber(config?.memoryDigestIdleMinutes, 360), 60, 1440) * 60_000
  }

  function digestDailyCap(config = readConfig()) {
    return clamp(asNumber(config?.memoryDigestDailyCap, 2), 1, 5)
  }

  function digestDayInfo(memory, dayKey) {
    const reflection = asObject(memory?.reflection)
    const stored = String(reflection.lastDigestDayKey ?? '')
    return {
      dayKey,
      count: stored === dayKey ? Math.max(0, Math.round(asNumber(reflection.digestCount, 0))) : 0,
    }
  }

  /** 缺省会话：digests 里最近活动的；没有就退回最近事件里的 sessionId。 */
  function latestSessionIdOf(memory) {
    const digests = asObject(memory?.digests)
    let best = ''
    let bestAt = -1
    for (const [sessionId, value] of Object.entries(digests)) {
      const at = Math.max(asNumber(value?.lastEventAt, 0), asNumber(value?.lastAt, 0))
      if (at > bestAt) {
        bestAt = at
        best = sessionId
      }
    }
    if (best) return best
    for (const event of asArray(memory?.events)) {
      const sessionId = String(event?.sessionId ?? '').trim()
      const at = asNumber(event?.at, 0)
      if (sessionId && at > bestAt) {
        bestAt = at
        best = sessionId
      }
    }
    return best
  }

  /** 窗口：该会话自上次 digest 之后的事件（最多 12）+ lastSeenAt 在窗口内的新事实（最多 5）。 */
  function digestWindowOf(memory, sessionId, now) {
    const entry = asObject(asObject(memory?.digests)[sessionId])
    const from = asNumber(entry.lastAt, 0)
    const events = asArray(memory?.events)
      .filter((event) => event && String(event.sessionId ?? '') === sessionId
        && asNumber(event.at, 0) > from && asNumber(event.at, 0) <= now)
      .slice(-DIGEST_EVENT_WINDOW)
    const facts = asArray(memory?.facts)
      .filter((fact) => fact && !fact.supersededBy
        && asNumber(fact.lastSeenAt, 0) > from && asNumber(fact.lastSeenAt, 0) <= now)
      .sort((left, right) => asNumber(left.lastSeenAt, 0) - asNumber(right.lastSeenAt, 0))
      .slice(-DIGEST_FACT_WINDOW)
    return { from, events, facts }
  }

  function digestTopicsOf(events) {
    const topics = []
    for (const event of events) {
      for (const topic of asArray(event?.topics)) {
        const key = String(topic ?? '').trim().slice(0, 8)
        if (!key || topics.includes(key)) continue
        topics.push(key)
        if (topics.length >= 5) return topics
      }
    }
    return topics
  }

  /** 摘要文案：聊到：…；新增：…；约定：…（空段省略，总长 ≤200）。 */
  function buildDigestText(events, facts) {
    const parts = []
    const topics = digestTopicsOf(events)
    let talked = topics.join('、')
    if (!talked && events.length > 0) {
      talked = codepointSlice(String(events[events.length - 1]?.summary ?? '').trim(), 60)
    }
    if (talked) parts.push(`聊到：${talked}`)
    const newFacts = facts.filter((fact) => fact && fact.predicate !== '约定').slice(-3)
    if (newFacts.length > 0) {
      parts.push(`新增：${newFacts.map((fact) => codepointSlice(String(fact.text || `${fact.subject}${fact.predicate}${fact.value}`), 36)).join('、')}`)
    }
    const promises = facts.filter((fact) => fact && fact.predicate === '约定')
    if (promises.length > 0) {
      parts.push(`约定：${promises.map((fact) => codepointSlice(String(fact.value ?? ''), 36)).join('、')}`)
    }
    return codepointSlice(parts.join('；'), DIGEST_NOTE_MAX)
  }

  function digestFactView(fact) {
    return {
      id: String(fact?.id ?? ''),
      subject: String(fact?.subject ?? ''),
      predicate: String(fact?.predicate ?? ''),
      value: String(fact?.value ?? ''),
      text: String(fact?.text ?? ''),
      confidence: asNumber(fact?.confidence, 0),
      lastSeenAt: asNumber(fact?.lastSeenAt, 0),
    }
  }

  /**
   * 整理一个会话：规则摘要 → notes.us（0.7）→ 更新 digests 与每日计数。
   * manual=true 时忽略 memorySessionDigest 开关与每日上限（显式操作总能跑）。
   */
  async function digestSession(options = {}) {
    const manual = options.manual === true
    const now = asNumber(options.now, Date.now())
    const config = readConfig()
    if (!manual && config.memorySessionDigest === false) {
      return { ok: false, reason: 'disabled', sessionId: '', note: null, facts: [], window: null }
    }
    const before = readMemory()
    const sessionId = String(options.sessionId ?? '').trim() || latestSessionIdOf(before)
    if (!sessionId) {
      return { ok: false, reason: 'no-session', sessionId: '', note: null, facts: [], window: null }
    }
    const dayKey = localDayKey(now)
    const cap = digestDailyCap(config)
    const dayBefore = digestDayInfo(before, dayKey)
    if (!manual && dayBefore.count >= cap) {
      return {
        ok: false,
        reason: 'daily-cap',
        sessionId,
        note: null,
        facts: [],
        window: null,
        dayKey,
        count: dayBefore.count,
        cap,
      }
    }
    const win = digestWindowOf(before, sessionId, now)
    const text = buildDigestText(win.events, win.facts)
    const windowInfo = {
      from: win.from,
      to: now,
      events: win.events.length,
      facts: win.facts.length,
      topics: digestTopicsOf(win.events),
    }
    if (!text) {
      return { ok: false, reason: 'empty', sessionId, note: null, facts: [], window: windowInfo }
    }
    // 写前备份（失败只 warn，不阻塞整理）。
    await backupMemoryBeforeWrite()
    const maxNotes = clamp(asNumber(config?.memoryMaxNotes, NOTE_MAX), 5, NOTE_MAX)
    let noteResult = null
    let countAfter = dayBefore.count + 1
    try {
      store.update((memory) => {
        if (!memory.notes || typeof memory.notes !== 'object') memory.notes = { user: [], us: [], self: [] }
        for (const key of ['user', 'us', 'self']) {
          if (!Array.isArray(memory.notes[key])) memory.notes[key] = []
        }
        const list = memory.notes.us
        const existing = list.find((note) => note && note.text === text)
        if (existing) {
          existing.importance = Math.max(asNumber(existing.importance, 0.5), 0.7)
          existing.updatedAt = now
          noteResult = { ...existing, category: 'us', created: false }
        } else {
          const made = {
            id: newId('note'),
            category: 'us',
            kind: 'digest',
            text,
            importance: 0.7,
            createdAt: now,
            updatedAt: now,
            hits: 0,
            dueAt: 0,
          }
          list.push(made)
          if (list.length > maxNotes) {
            let weakest = 0
            let weakestScore = Infinity
            list.forEach((item, index) => {
              const score = asNumber(item.importance, 0.5) * 0.7 + Math.min(5, asNumber(item.hits, 0)) * 0.06
              if (score < weakestScore) {
                weakestScore = score
                weakest = index
              }
            })
            list.splice(weakest, 1)
          }
          noteResult = { ...made, category: 'us', created: true }
        }
        if (!memory.digests || typeof memory.digests !== 'object') memory.digests = {}
        const previous = asObject(memory.digests[sessionId])
        const latestEventAt = win.events.reduce((max, event) => Math.max(max, asNumber(event.at, 0)), 0)
        memory.digests[sessionId] = {
          lastAt: now,
          lastEventAt: Math.max(asNumber(previous.lastEventAt, 0), latestEventAt),
          turns: Math.max(0, Math.round(asNumber(previous.turns, 0))) + win.events.length,
        }
        if (!memory.reflection || typeof memory.reflection !== 'object') memory.reflection = {}
        const dayNow = digestDayInfo(memory, dayKey)
        memory.reflection.lastDigestDayKey = dayKey
        memory.reflection.digestCount = dayNow.count + 1
        countAfter = memory.reflection.digestCount
        return memory
      })
    } catch (error) {
      logger('[soul] 会话整理写入失败:', error instanceof Error ? error.message : error)
      return { ok: false, reason: 'write-failed', sessionId, note: null, facts: [], window: windowInfo }
    }
    logger(`[soul] 会话整理完成(${sessionId})：${windowInfo.events} 条事件 / ${windowInfo.facts} 条事实`)
    return {
      ok: true,
      sessionId,
      note: noteResult,
      facts: win.facts.map(digestFactView),
      window: windowInfo,
      dayKey,
      count: countAfter,
      cap,
    }
  }

  function clearDigestTimer(sessionId) {
    const key = String(sessionId ?? '').trim()
    if (!key) return
    const timer = digestTimers.get(key)
    if (timer === undefined || timer === null) return
    try {
      clearTimer(timer)
    } catch {
      /* ignore */
    }
    digestTimers.delete(key)
  }

  /** turnEnd 排一个空闲定时器；新消息 / 下一次 turnEnd 会取消重排。 */
  function scheduleDigest(sessionId) {
    const key = String(sessionId ?? '').trim()
    if (!key) return
    const config = readConfig()
    if (config.memorySessionDigest === false) {
      clearDigestTimer(key)
      return
    }
    clearDigestTimer(key)
    const timer = setTimer(() => {
      digestTimers.delete(key)
      void digestSession({ sessionId: key, now: Date.now(), manual: false, reason: 'idle' })
    }, digestIdleMs(config))
    if (timer && typeof timer.unref === 'function') timer.unref()
    digestTimers.set(key, timer)
  }

  function clearAllDigestTimers() {
    for (const key of [...digestTimers.keys()]) clearDigestTimer(key)
  }

  // ③ 回合配对
  function onUserMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      const at = asNumber(payload.at, Date.now())
      const config = readConfig()
      const sessionId = String(payload.sessionId ?? '').trim()
      // 每个会话的注入门控状态：turns / lastUserAt / anchorNext。
      // anchorNext 只在「首轮」或「距上次说话 ≥ 久别阈值」时为 true；
      // 普通轮一律写回 false，避免久别之后每轮都 anchor。
      if (sessionId) {
        const previous = injectSessions[sessionId] || normalizeInjectEntry(null)
        const idleMs = clamp(asNumber(config.memoryInjectIdleMinutes, 360), 60, 1440) * 60_000
        const firstTurn = previous.turns <= 0 || previous.lastUserAt <= 0
        const longGap = previous.lastUserAt > 0 && at - previous.lastUserAt >= idleMs
        injectSessions[sessionId] = {
          ...previous,
          turns: previous.turns + 1,
          lastUserAt: at,
          anchorNext: firstTurn || longGap,
        }
        pruneInjectSessions(injectSessions)
      }
      // 有新消息：先取消这个会话待触发的空闲整理，由下一次 turnEnd 重排。
      clearDigestTimer(sessionId)
      // 距上次活动已经超过空闲阈值：趁现在先补一次整理（窗口在本条消息入事件前，正好干净）。
      if (config.memorySessionDigest !== false && sessionId) {
        const entry = asObject(asObject(readMemory().digests)[sessionId])
        const lastEventAt = asNumber(entry.lastEventAt, 0)
        if (lastEventAt > 0 && at - lastEventAt >= digestIdleMs(config)) {
          void digestSession({ sessionId, now: at, manual: false, reason: 'idle-catchup' })
        }
      }
      pending = {
        userText: text,
        at,
        sessionId,
        assistantText: '',
      }
      // 零 token 规则抽取：只认明确句式，写事实卡/实体卡。
      applyUserFacts(text, at, 'user')
      // 重要信息立即入记忆（零 token）；开关关闭时只跳过新增笔记，规则事实照旧。
      if (config.memoryImmediate !== false) applyImmediateNotes(text, at, config)
      // 回合状态最后落盘（前面的 store.update 会重写 memory.json，这里补回 inject）。
      if (sessionId) persistInject()
    } catch (error) {
      logger('[soul] memory onUserMessage 失败:', error instanceof Error ? error.message : error)
    }
  }

  function onAssistantMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      if (pending) {
        pending.assistantText = text
        pending.assistantAt = asNumber(payload.at, Date.now())
        return
      }
      // 没有待配对的用户消息：这是主动搭话那一轮（或用户消息被过滤），记一条 proactive 事件
      pushEvent(makeEvent({
        kind: 'proactive',
        summary: `她主动说「${codepointSlice(text, 48)}」`,
        topics: topicKeys(text),
        salience: 0.55,
        sessionId: String(payload.sessionId ?? ''),
        at: asNumber(payload.at, Date.now()),
        source: 'speak',
      }))
    } catch (error) {
      logger('[soul] memory onAssistantMessage 失败:', error instanceof Error ? error.message : error)
    }
  }

  function onTurnEnd(payload = {}) {
    try {
      if (!pending || !pending.userText) {
        pending = null
        return
      }
      const turn = pending
      pending = null
      const now = asNumber(payload.at, turn.at) || Date.now()
      const current = readSoul()
      const intensity = Number(current?.emotion?.transient?.intensity) || 0
      const topics = topicKeys(`${turn.userText}\n${turn.assistantText}`)
      pushEvent(makeEvent({
        kind: 'chat',
        summary: ruleSummary(turn.userText, turn.assistantText),
        topics,
        salience: eventSalience(intensity, 'chat'),
        sessionId: turn.sessionId,
        at: turn.at,
        source: 'rule',
      }))
      reflectBuffer.push({ ...turn, at: now })
      if (reflectBuffer.length > 12) reflectBuffer = reflectBuffer.slice(-12)
      const config = readConfig()
      const every = clamp(asNumber(config.memoryReflectionEvery, 3), 1, 50)
      const immediate = SELF_DISCLOSURE_RE.test(turn.userText) || CONFLICT_RE.test(turn.userText) || MAKE_UP_RE.test(turn.userText)
      if (reflectBuffer.length >= every || immediate) {
        void reflect({ reason: immediate ? 'immediate' : 'every-n' })
      }
      // turnEnd 后再尝试一次事件压实（pushEvent 里已按阈值处理，这里幂等）。
      try {
        store.update((memory) => {
          compactEvents(memory, { threshold: EVENT_COMPACT_THRESHOLD })
          return memory
        })
      } catch (error) {
        logger('[soul] 记忆压实失败:', error instanceof Error ? error.message : error)
      }
      // 周期整理（事实/实体）每天最多跑一次；onTurnEnd 是天然触发点。
      try {
        const autoCompactConfig = readConfig()
        if (autoCompactConfig.memoryAutoCompact !== false
          && (readMemory().reflection?.lastCompactDayKey || '') !== localDayKey(now)) {
          compact(false)
        }
      } catch (error) {
        logger('[soul] 记忆周期整理失败:', error instanceof Error ? error.message : error)
      }
      // 会话整理：这一轮结束后按空闲时长排定时器；新消息会取消并重排。
      try {
        const sessionId = String(turn.sessionId || payload.sessionId || '')
        if (sessionId) scheduleDigest(sessionId)
      } catch (error) {
        logger('[soul] 会话整理排期失败:', error instanceof Error ? error.message : error)
      }
    } catch (error) {
      logger('[soul] memory onTurnEnd 失败:', error instanceof Error ? error.message : error)
    }
  }

  // ④ 关系阶段事件 → 里程碑
  function onStage(payload = {}) {
    try {
      pushEvent(makeEvent({
        kind: 'milestone',
        summary: payload.direction === 'down'
          ? `关系阶段从「${payload.from}」退回「${payload.to}」`
          : `关系阶段从「${payload.from}」升到「${payload.to}」`,
        topics: [],
        salience: 0.9,
        at: asNumber(payload.at, Date.now()),
        source: 'relation',
      }))
    } catch (error) {
      logger('[soul] memory onStage 失败:', error instanceof Error ? error.message : error)
    }
  }

  // ⑤ 反思应用（规则或 LLM）：notes/topics/reflection → memory.json；关系/称呼/表达 → soul
  function applyReflection(result, source) {
    if (!result) return { ok: false }
    const config = readConfig()
    const now = Date.now()
    const maxNotes = clamp(asNumber(config.memoryMaxNotes, NOTE_MAX), 5, NOTE_MAX)
    let notesApplied = 0
    try {
      store.update((memory) => {
        if (!memory.notes || typeof memory.notes !== 'object') memory.notes = { user: [], us: [], self: [] }
        for (const key of ['user', 'us', 'self']) {
          if (!Array.isArray(memory.notes[key])) memory.notes[key] = []
        }
        if (!memory.reflection || typeof memory.reflection !== 'object') memory.reflection = {}
        for (const note of asArray(result.newNotes)) {
          if (!note || !note.text) continue
          const category = ['user', 'us', 'self'].includes(note.category) ? note.category : 'user'
          mergeNote(memory.notes[category], note, maxNotes)
          notesApplied += 1
          if (note.dueAt) {
            const pendingDue = asArray(memory.reflection.pendingDue)
            pendingDue.push({ id: newId('due'), noteId: note.id, at: note.dueAt, text: note.text })
            memory.reflection.pendingDue = pendingDue.slice(-20)
          }
        }
        if (!memory.topics || typeof memory.topics !== 'object') memory.topics = {}
        for (const topic of asArray(result.topics)) {
          const key = String(topic).slice(0, 8)
          if (!key) continue
          const entry = asObject(memory.topics[key])
          memory.topics[key] = { lastAt: now, count: asNumber(entry.count, 0) + 1 }
        }
        if (result.userState) memory.reflection.userState = { label: result.userState, at: now }
        memory.reflection.lastReflectAt = now
        memory.reflection.lastSource = String(source || 'rule').slice(0, 12)
        return memory
      })
    } catch (error) {
      logger('[soul] 反思写入 memory.json 失败:', error instanceof Error ? error.message : error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const current = readSoul()
    if (current && typeof current === 'object') {
      if (result.relationDelta) {
        const change = soul.addRelationScore(result.relationDelta, now)
        if (change.changed) logger(`[soul] 反思推动关系 ${change.from} → ${change.to}`)
      }
      if (result.addressPreferred && current.identity?.address) {
        current.identity.address.userPreferred = String(result.addressPreferred).slice(0, 20)
      }
      if (result.closer && current.speak) {
        current.speak.suppressUntil = Math.max(asNumber(current.speak.suppressUntil, 0), now + 12 * 3_600_000)
      }
      if (current.meta && typeof current.meta === 'object') current.meta.lastConsolidateAt = now
    }
    if (result.milestone) {
      pushEvent(makeEvent({ kind: 'milestone', summary: result.milestone, topics: result.topics, salience: 0.9, at: now, source }))
    }
    soul.saveSoon()
    return { ok: true, notes: notesApplied, relationDelta: result.relationDelta }
  }

  function resolveReflectionModel(config) {
    const provider = String(config.memoryProvider || config.emotionRecheckProvider || '').trim()
    const model = String(config.memoryModel || config.emotionRecheckModel || '').trim()
    if (provider && model) return { provider, model }
    try {
      const service = ctx.get?.('agentDefaultModel') || ctx.agentDefaultModel
      const selection = service?.currentSelection?.()
      if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    } catch {
      /* ignore */
    }
    return null
  }

  async function reflectWithLlm(turns, config) {
    const llm = (() => {
      try {
        return ctx.get?.('llm') || ctx.llm
      } catch {
        return undefined
      }
    })()
    if (!llm || typeof llm.stream !== 'function') return null
    const model = resolveReflectionModel(config)
    if (!model) return null
    const current = readSoul()
    const memory = readMemory()
    const existingNotes = []
    for (const key of ['user', 'us', 'self']) {
      for (const note of asArray(memory.notes?.[key])) existingNotes.push(note)
    }
    const prompt = buildReflectionPrompt({
      turns,
      emotion: current?.emotion,
      relation: current?.relation,
      existingNotes: existingNotes.slice(-8),
    })
    let out = ''
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system: '你是记忆整理器，为陪伴型 AI 从最近对话里沉淀长期记忆。只输出一行 JSON。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 700,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    return parseReflectionOutput(out)
  }

  async function reflect(options = {}) {
    const now = Date.now()
    if (reflecting) return { ok: false, reason: 'busy' }
    if (reflectBuffer.length === 0 && options.reason !== 'manual') return { ok: false, reason: 'empty' }
    if (options.reason !== 'manual' && now - lastReflectAttempt < 60_000) return { ok: false, reason: 'throttled' }
    reflecting = true
    lastReflectAttempt = now
    const turns = reflectBuffer.slice(-6)
    const config = readConfig()
    try {
      let result = null
      if (config.memoryReflectionLlm === true) {
        try {
          result = await reflectWithLlm(turns, config)
        } catch (error) {
          logger('[soul] LLM 反思失败，回退规则:', error instanceof Error ? error.message : error)
        }
      }
      const source = result ? 'llm' : 'rule'
      if (!result) {
        result = analyzeRuleReflection(turns, now)
        if (!result.summary) result.summary = turns.length > 0 ? ruleSummary(turns[turns.length - 1].userText, turns[turns.length - 1].assistantText) : ''
      }
      const applied = applyReflection(result, source)
      if (result.summary) {
        // 反思摘要并进最近一条事件（避免重复事件膨胀）
        try {
          store.update((memory) => {
            const events = asArray(memory.events)
            const lastEvent = events[events.length - 1]
            if (lastEvent && !lastEvent.summary) lastEvent.summary = result.summary
            return memory
          })
        } catch {
          /* ignore */
        }
      }
      reflectBuffer = []
      soul.saveSoon()
      logger(`[soul] 反思完成(${source})：+${applied.notes ?? 0} 笔记，关系 ${Number(result.relationDelta) || 0}`)
      return applied
    } catch (error) {
      logger('[soul] 反思失败:', error instanceof Error ? error.message : error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      reflecting = false
    }
  }

  // ⑥ 订阅 soul 事件
  const disposers = []
  try {
    disposers.push(soul.on('user', onUserMessage))
    disposers.push(soul.on('assistant', onAssistantMessage))
    disposers.push(soul.on('turnEnd', onTurnEnd))
    disposers.push(soul.on('stage', onStage))
  } catch (error) {
    logger('[soul] memory 事件订阅失败:', error instanceof Error ? error.message : error)
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* noop */
          }
        }
        clearAllDigestTimers()
        try {
          store.dispose()
        } catch {
          /* noop */
        }
      }, 'aura-memory: soul listeners')
    } catch {
      /* ignore */
    }
  }

  // ⑦ 工具
  function note(category, text, importance, dueAt = 0) {
    try {
      const clean = String(text ?? '').trim()
      if (!clean) return { ok: false, reason: '文本为空' }
      const config = readConfig()
      const maxNotes = clamp(asNumber(config.memoryMaxNotes, NOTE_MAX), 5, NOTE_MAX)
      const key = ['user', 'us', 'self'].includes(category) ? category : 'user'
      const made = makeNote(key, clean, clamp(asNumber(importance, 0.6), 0, 1), Date.now(), dueAt)
      if (!made) return { ok: false, reason: '文本为空' }
      let merged = { merged: false, note: made }
      let count = 0
      store.update((memory) => {
        if (!memory.notes || typeof memory.notes !== 'object') memory.notes = { user: [], us: [], self: [] }
        if (!Array.isArray(memory.notes[key])) memory.notes[key] = []
        if (!memory.reflection || typeof memory.reflection !== 'object') memory.reflection = {}
        merged = mergeNote(memory.notes[key], made, maxNotes)
        if (made.dueAt) {
          const pendingDue = asArray(memory.reflection.pendingDue)
          pendingDue.push({ id: newId('due'), noteId: made.id, at: made.dueAt, text: made.text })
          memory.reflection.pendingDue = pendingDue.slice(-20)
        }
        memory.reflection.lastReflectAt = Date.now()
        count = memory.notes[key].length
        return memory
      })
      return { ok: true, merged: merged.merged, note: merged.note ?? made, count }
    } catch (error) {
      logger('[soul] 写笔记失败:', error instanceof Error ? error.message : error)
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function recall(query, options = {}) {
    try {
      const now = Date.now()
      const limit = clamp(asNumber(options.limit, 5), 1, 8)
      const memory = readMemory()
      const notes = recallNotes(memory, query, { now, category: options.category, limit })
      const events = recallEvents(memory, query, limit, now)
      const items = [
        ...notes.map((item) => ({ kind: 'note', category: item.category, text: item.text, at: item.updatedAt })),
        ...events.map((item) => ({ kind: 'event', category: item.kind, text: item.summary, at: item.at })),
      ]
      items.sort((a, b) => asNumber(b.at, 0) - asNumber(a.at, 0))
      return items.slice(0, limit)
    } catch (error) {
      logger('[soul] recall 失败:', error instanceof Error ? error.message : error)
      return []
    }
  }

  try {
    ctx.tools?.register?.(defineTool({
      name: 'soul_recall',
      description: '回忆关于对方或你们之间的事。用户提到过去、问"你还记得吗"时调用。',
      parameters: {
        query: { type: 'string', description: '关键词，如"加班""生日"', required: true },
        category: { type: 'string', description: '可选：user | us | self' },
        limit: { type: 'number', description: '默认 5，最多 8' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const lines = []
          for (const item of Array.isArray(value?.items) ? value.items : []) lines.push(`- ${item.text}`)
          for (const fact of Array.isArray(value?.facts) ? value.facts : []) {
            lines.push(`- 事实：${fact.subject} · ${fact.predicate} · ${fact.value}`)
          }
          for (const entity of Array.isArray(value?.entities) ? value.entities : []) {
            lines.push(`- 实体：${entity.name}（${ENTITY_TYPE_LABELS[entity.type] || '其他'}）`)
          }
          for (const relation of Array.isArray(value?.relations) ? value.relations : []) {
            lines.push(`- 关系：${relationText(relation)}`)
          }
          for (const fact of Array.isArray(value?.relatedFacts) ? value.relatedFacts : []) {
            lines.push(`- 关联事实：${fact.subject} · ${fact.predicate} · ${fact.value}`)
          }
          return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '（想不起来了）' }]
        },
      },
      async execute(args = {}) {
        const items = recall(args?.query, { category: args?.category, limit: args?.limit })
        const memory = readMemory()
        const now = Date.now()
        const limit = clamp(asNumber(args?.limit, 5), 1, 5)
        const facts = queryFactsInMemory(memory, args?.query, limit, now)
        const entities = queryEntitiesInMemory(memory, args?.query, 3, now, { fallback: false })
        // soul_recall 是给人看的回忆：关联事实即使同时命中也保留（不同召回路径），
        // 条数比 context 宽松一点（relations 6 / 关联事实 3）。
        const hop = recallOneHop(memory, args?.query, {
          now,
          relationLimit: 6,
          factLimit: 3,
        })
        return {
          items,
          count: items.length,
          facts,
          entities,
          relations: hop.relations,
          relatedFacts: hop.facts,
        }
      },
    }))
    ctx.tools?.register?.(defineTool({
      name: 'soul_memory',
      description: '记忆库控制面：stats=统计，search=搜索笔记/事实/实体/关系，'
        + 'writeNote=写一条长期笔记（category：user=关于对方的事实/偏好/边界，us=你们之间的约定和共同经历，'
        + 'self=你对自己的认识；≤80 字，重复的会自动合并），updateNote/deleteNote=改/删笔记，'
        + 'addFact=记一条结构化事实卡（subject · predicate · value，如 木子 · 喜欢 · 听歌），'
        + 'forgetFact=忘掉一条事实卡（同 deleteFact），deleteEntity=删除实体卡，'
        + 'mergeEntities=合并两个实体（事实与关系一起迁移），compact=立即整理，'
        + 'digest=立即整理这段会话（窗口内事件+新事实 → us 摘要笔记）。写操作前会自动备份 memory.json。',
      parameters: {
        action: {
          type: 'string',
          description: 'stats | search | writeNote | updateNote | deleteNote | addFact | forgetFact | deleteFact | deleteEntity | mergeEntities | compact | digest',
          required: true,
        },
        sessionId: { type: 'string', description: 'digest：要整理的会话 id；省略时取最近活动的会话' },
        query: { type: 'string', description: 'search 关键词；为空时返回最近/最重的几条' },
        category: { type: 'string', description: 'writeNote：user | us | self，默认 user' },
        text: { type: 'string', description: 'writeNote 新笔记 / updateNote 新文本（≤200 字，落盘受笔记上限截断）；addFact 时可当 value 兜底' },
        oldText: { type: 'string', description: 'updateNote / deleteNote 定位用的旧文本（也可改用 id）' },
        importance: { type: 'number', description: '0..1，越重要越不容易被淘汰' },
        dueAt: { type: 'string', description: 'writeNote：到时要问的约定，填 ISO 时间（如"面试是明天"）' },
        subject: { type: 'string', description: 'addFact：主体，如 木子 / 你们 / 团子' },
        predicate: { type: 'string', description: 'addFact：关系词，如 喜欢 / 居住地 / 生日 / 约定' },
        value: { type: 'string', description: 'addFact：≤60 字的值' },
        confidence: { type: 'number', description: 'addFact：0..1；省略时默认 0.9（显式）' },
        source: { type: 'string', description: 'addFact：user | aura | reflection，默认 user' },
        id: { type: 'string', description: 'updateNote / deleteNote / addFact 之后忘卡用 forgetFact / deleteFact / deleteEntity 的 id' },
        fromId: { type: 'string', description: 'mergeEntities 被合并的实体 id（也接受名字/别名）' },
        toId: { type: 'string', description: 'mergeEntities 保留的实体 id（也接受名字/别名）' },
        limit: { type: 'number', description: 'search 每类条数，默认 5，最多 5' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderMemoryToolText(value) }],
      },
      async execute(args = {}) {
        const action = String(args?.action ?? '').trim()
        try {
          if (action === 'stats') return memoryStats()
          if (action === 'search') return memorySearch(args?.query, args?.limit)
          if (action === 'compact') {
            await backupMemoryBeforeWrite()
            return memoryCompact()
          }
          if (action === 'writeNote') {
            await backupMemoryBeforeWrite()
            return memoryWriteNote(args)
          }
          if (action === 'updateNote') {
            await backupMemoryBeforeWrite()
            return memoryUpdateNote(args)
          }
          if (action === 'deleteNote') {
            await backupMemoryBeforeWrite()
            return memoryDeleteNote(args)
          }
          if (action === 'addFact') {
            const parsed = factInputOf(args)
            if (!parsed.ok) return parsed
            await backupMemoryBeforeWrite()
            return memoryAddFact(parsed.input)
          }
          if (action === 'forgetFact' || action === 'deleteFact') {
            await backupMemoryBeforeWrite()
            return memoryDeleteFact(args?.id)
          }
          if (action === 'deleteEntity') {
            await backupMemoryBeforeWrite()
            return memoryDeleteEntity(args?.id)
          }
          if (action === 'mergeEntities') {
            await backupMemoryBeforeWrite()
            return memoryMergeEntities(args)
          }
          if (action === 'digest') {
            // 备份在 digestSession 内部做，这里不重复备份。
            return digestSession({ sessionId: args?.sessionId, manual: true, reason: 'manual' })
          }
          return {
            ok: false,
            reason: '未知 action（stats | search | writeNote | updateNote | deleteNote | addFact | forgetFact | deleteFact | deleteEntity | mergeEntities | compact | digest）',
          }
        } catch (error) {
          logger('[soul] soul_memory 失败:', error instanceof Error ? error.message : error)
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  } catch (error) {
    logger('[soul] 记忆工具注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑦.5 面板只读接口：/dsh-aura/memory-api/state（facts/entities）。
  // web.js 的 soulPayload 只透传 events/notes/topics，facts/entities 用这个独立路由补上。
  function hostIsLoopback(req) {
    const host = req?.headers?.host
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

  function memoryApiAllowed(req) {
    if (!hostIsLoopback(req)) return false
    const site = req?.headers?.['sec-fetch-site']
    if (site && String(site).toLowerCase() === 'cross-site') return false
    const origin = req?.headers?.origin
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

  try {
    const webServer = (() => {
      try {
        return ctx.get && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      } catch {
        return undefined
      }
    })() || ctx.webServer
    if (webServer && typeof webServer.register === 'function') {
      const registration = {
        kind: 'prefix',
        path: MEMORY_API_PREFIX,
        async handler(req, res) {
          if (!memoryApiAllowed(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const url = new URL(String(req.url || '/'), 'http://localhost')
          const route = url.pathname.replace(MEMORY_API_PREFIX, '') || '/'
          try {
            if (req.method === 'GET' && (route === '/' || route === '' || route === '/state')) {
              const memory = readMemory()
              const limit = clamp(asNumber(url.searchParams.get('limit'), 12), 1, 50)
              sendJson(res, 200, {
                ok: true,
                facts: listFactsInMemory(memory, limit),
                entities: listEntitiesInMemory(memory, limit),
                // 关系边最多 50 条（面板够用，也不至于把 payload 撑大）。
                relations: listRelationsInMemory(memory, 50),
                factCount: asArray(memory.facts).filter((fact) => fact && !fact.supersededBy).length,
                entityCount: asArray(memory.entities).length,
                relationCount: asArray(memory.relations).length,
              })
              return
            }
            if (req.method === 'POST' && (route === '/' || route === '' || route === '/state')) {
              await handleMemoryApiPost(req, res)
              return
            }
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            logger('[soul] memory HTTP 失败:', error instanceof Error ? error.message : error)
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => webServer.register(registration), 'aura-memory: http')
      } else {
        webServer.register(registration)
      }
    }
  } catch (error) {
    logger('[soul] memory HTTP 路由注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑧ API
  function snapshot() {
    try {
      const memory = readMemory()
      const stats = store.stats()
      const notes = memory.notes
      const counts = { user: asArray(notes.user).length, us: asArray(notes.us).length, self: asArray(notes.self).length }
      return {
        eventCount: asArray(memory.events).length,
        notes: counts,
        topics: Object.keys(asObject(memory.topics)).length,
        facts: listFactsInMemory(memory, 30).map((fact) => ({ ...fact })),
        entities: listEntitiesInMemory(memory, 30).map((entity) => ({
          ...entity,
          aliases: asArray(entity.aliases).slice(),
        })),
        relations: listRelationsInMemory(memory, 20),
        factCount: asArray(memory.facts).filter((fact) => fact && !fact.supersededBy).length,
        entityCount: asArray(memory.entities).length,
        relationCount: asArray(memory.relations).length,
        digests: Object.keys(asObject(memory.digests)).length,
        lastDigestDayKey: memory.reflection?.lastDigestDayKey || '',
        pendingDue: asArray(memory.reflection?.pendingDue).length,
        lastReflectAt: memory.reflection?.lastReflectAt || 0,
        lastCompactDayKey: memory.reflection?.lastCompactDayKey || '',
        recent: asArray(memory.events).slice(-5).map((event) => ({
          at: event.at,
          kind: event.kind,
          summary: event.summary,
          salience: event.salience,
        })),
        recentNotes: [
          ...asArray(notes.user).slice(-3),
          ...asArray(notes.us).slice(-3),
          ...asArray(notes.self).slice(-3),
        ].map((item) => ({ id: item.id, category: item.category, text: item.text, importance: item.importance, updatedAt: item.updatedAt })),
        userState: memory.reflection?.userState ?? null,
        reflectionLlm: readConfig().memoryReflectionLlm === true,
        store: stats,
      }
    } catch (error) {
      logger('[soul] memory snapshot 失败:', error instanceof Error ? error.message : error)
      return {}
    }
  }

  function clear() {
    try {
      for (const key of Object.keys(injectSessions)) delete injectSessions[key]
      store.write(emptyMemory())
      reflectBuffer = []
      logger('[soul] 记忆已清空（memory.json 的事件/笔记/话题/待办）')
      return { ok: true }
    } catch (error) {
      logger('[soul] 清空记忆失败:', error instanceof Error ? error.message : error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function compact(force = false) {
    const now = Date.now()
    const dayKey = localDayKey(now)
    const emptyResult = {
      compacted: 0,
      notesAdded: 0,
      eventsLeft: 0,
      factsMerged: 0,
      factsPruned: 0,
      factsDecayed: 0,
      entitiesPruned: 0,
      relationsPruned: 0,
      relationsDecayed: 0,
      skipped: false,
    }
    try {
      const current = readMemory()
      const lastDayKey = current.reflection?.lastCompactDayKey || ''
      if (force !== true && lastDayKey === dayKey) {
        return {
          ...emptyResult,
          eventsLeft: asArray(current.events).length,
          skipped: true,
          reason: 'daily',
        }
      }
      let result = { ...emptyResult }
      store.update((memory) => {
        const events = compactEvents(memory, {
          force: force === true,
          threshold: EVENT_COMPACT_THRESHOLD,
        })
        if (!memory.reflection || typeof memory.reflection !== 'object') memory.reflection = {}
        const facts = compactMemoryFacts(memory, now)
        const relations = compactRelations(memory, now)
        result = {
          compacted: events.compacted,
          notesAdded: events.notesAdded,
          eventsLeft: memory.events.length,
          factsMerged: facts.factsMerged,
          factsPruned: facts.factsPruned,
          factsDecayed: facts.factsDecayed,
          entitiesPruned: facts.entitiesPruned,
          relationsPruned: relations.relationsPruned,
          relationsDecayed: relations.relationsDecayed,
          skipped: false,
        }
        memory.reflection.lastCompactDayKey = dayKey
        return memory
      })
      return result
    } catch (error) {
      logger('[soul] 记忆压实失败:', error instanceof Error ? error.message : error)
      return { ...emptyResult }
    }
  }

  // ⑧.5 统一记忆控制面：soul_memory 工具与 memory-api 共用同一组实现。
  function memoryCounts(memory = readMemory()) {
    const noteCounts = { user: 0, us: 0, self: 0 }
    for (const key of ['user', 'us', 'self']) noteCounts[key] = asArray(memory?.notes?.[key]).length
    const facts = asArray(memory?.facts)
    return {
      events: asArray(memory?.events).length,
      notes: noteCounts.user + noteCounts.us + noteCounts.self,
      noteCounts,
      facts: facts.filter((fact) => fact && !fact.supersededBy).length,
      factsTotal: facts.length,
      entities: asArray(memory?.entities).length,
      relations: asArray(memory?.relations).length,
    }
  }

  function memoryStats() {
    const memory = readMemory()
    return {
      ok: true,
      counts: memoryCounts(memory),
      lastCompactDayKey: String(memory?.reflection?.lastCompactDayKey ?? ''),
      pendingDue: asArray(memory?.reflection?.pendingDue).length,
      /* dueNow 是「现在该提醒」的条数；pendingDue 是队列里全部待办。 */
      dueNow: pendingDue().length,
      lastReflectAt: asNumber(memory?.reflection?.lastReflectAt, 0),
    }
  }

  /** 写操作前的备份：动态 import backup.js，失败只 warn，绝不阻塞写入。 */
  async function backupMemoryBeforeWrite() {
    try {
      const backup = await import('./backup.js')
      const snapshot = typeof backup.snapshot === 'function' ? backup.snapshot : backup.snapshotSync
      if (typeof snapshot !== 'function') return null
      const result = await snapshot('memory')
      if (result && result.ok === false) {
        logger('[soul] 记忆写前备份失败（继续写入）:', result.error)
        return null
      }
      return result
    } catch (error) {
      logger('[soul] 记忆写前备份失败（继续写入）:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /** 关系搜索：按 fromName / toName / type 的 token 命中；空 query 返回最近的边。 */
  function searchRelations(memory, query, limit = 5) {
    const views = listRelationsInMemory(memory, RELATION_LIMIT)
    const text = String(query ?? '').trim().toLowerCase()
    if (!text) return views.slice(0, limit)
    const tokens = text.split(/\s+/).filter(Boolean)
    return views.filter((relation) => {
      const haystack = `${relation.fromName}\u0001${relation.toName}\u0001${relation.type}`.toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    }).slice(0, limit)
  }

  /** search：笔记 / 事实 / 实体 / 关系各最多 5 条；事实跳过 superseded 和所有 fallback。 */
  function memorySearch(query, limit = 5) {
    const max = clamp(asNumber(limit, 5), 1, 5)
    const now = Date.now()
    const memory = readMemory()
    const text = String(query ?? '').trim()
    const notes = recallNotes(memory, text, { now, limit: max, fallback: false }).map((note) => ({
      id: String(note?.id ?? ''),
      category: String(note?.category ?? ''),
      text: String(note?.text ?? ''),
      importance: asNumber(note?.importance, 0.5),
      updatedAt: asNumber(note?.updatedAt, 0),
    }))
    const facts = queryFactsInMemory(memory, text, max, now)
    const entities = queryEntitiesInMemory(memory, text, max, now, { fallback: false })
    const relations = searchRelations(memory, text, max)
    return {
      ok: true,
      query: text,
      notes,
      facts,
      entities,
      relations,
      counts: {
        notes: notes.length,
        facts: facts.length,
        entities: entities.length,
        relations: relations.length,
      },
    }
  }

  /** dueAt：ISO 字符串或毫秒数；只认未来时间，非法/过去的一律 0（不排提醒）。 */
  function resolveDueAt(value) {
    if (value === undefined || value === null || value === '') return 0
    const numeric = typeof value === 'number' ? value : Date.parse(String(value))
    if (!Number.isFinite(numeric) || numeric <= Date.now()) return 0
    return Math.round(numeric)
  }

  /** writeNote：text 最多接收 200 字；真正落盘仍受笔记库单条上限约束。 */
  function memoryWriteNote(input = {}) {
    const text = codepointSlice(String(input?.text ?? '').trim(), 200)
    if (!text) return { ok: false, reason: 'text 为空' }
    const category = ['user', 'us', 'self'].includes(input?.category) ? input.category : 'user'
    const importance = input?.importance === undefined
      ? 0.6
      : clamp(asNumber(input.importance, 0.6), 0, 1)
    return note(category, text, importance, resolveDueAt(input?.dueAt))
  }

  /** updateNote：id 或 oldText 定位；text / importance 至少给一个。 */
  function memoryUpdateNote(input = {}) {
    const id = String(input?.id ?? '').trim()
    const oldText = String(input?.oldText ?? '').trim()
    if (!id && !oldText) return { ok: false, reason: '需要 id 或 oldText' }
    if (input?.text === undefined && input?.importance === undefined) {
      return { ok: false, reason: '没有要更新的字段（text / importance）' }
    }
    const peek = locateNoteInMemory(readMemory(), id ? { id } : { text: oldText })
    if (!peek.ok) return peek
    let result = { ok: false, reason: 'not-found' }
    store.update((memory) => {
      result = updateNoteInMemory(memory, {
        id: id || undefined,
        oldText: id ? undefined : oldText,
        text: input?.text,
        importance: input?.importance,
      })
      return memory
    })
    return result
  }

  function memoryDeleteNote(input = {}) {
    const id = String(input?.id ?? '').trim()
    const text = String(input?.text ?? '').trim()
    if (!id && !text) return { ok: false, reason: '需要 id 或 text' }
    const peek = locateNoteInMemory(readMemory(), id ? { id } : { text })
    if (!peek.ok) return peek
    let result = { ok: false, reason: 'not-found' }
    store.update((memory) => {
      result = deleteNoteInMemory(memory, id ? { id } : { text })
      return memory
    })
    return result
  }

  /**
   * addFact 入参归一化：subject/predicate/value 优先；
   * value 缺省时用 text 兜底，整段 text 也能按「甲 · 乙 · 丙」拆开。
   */
  function factInputOf(args = {}) {
    const subject = String(args?.subject ?? '').trim()
    const predicate = String(args?.predicate ?? '').trim()
    const fallbackText = String(args?.text ?? '').trim()
    let factSubject = subject
    let factPredicate = predicate
    let value = String(args?.value ?? '').trim()
    if (!value && !subject && !predicate && fallbackText) {
      const parts = fallbackText.split(/\s*[·•|｜]\s*/).filter(Boolean)
      if (parts.length >= 3) {
        factSubject = parts[0]
        factPredicate = parts[1]
        value = parts.slice(2).join('·')
      }
    }
    if (!value && fallbackText) value = fallbackText
    if (!factSubject || !factPredicate || !value) {
      return { ok: false, reason: 'addFact 需要 subject / predicate / value（可用 text 兜底）' }
    }
    return {
      ok: true,
      input: {
        subject: factSubject,
        predicate: factPredicate,
        value,
        confidence: args?.confidence ?? 0.9,
        source: args?.source,
      },
    }
  }

  function memoryAddFact(input = {}) {
    let result = { ok: false, reason: '写入失败' }
    store.update((memory) => {
      result = addFactToMemory(memory, input, Date.now())
      return memory
    })
    return result
  }

  function memoryDeleteFact(id) {
    const key = String(id ?? '').trim()
    if (!key) return { ok: false, reason: 'id 为空' }
    const exists = asArray(readMemory().facts).some((fact) => fact && fact.id === key)
    if (!exists) return { ok: false, reason: 'not-found' }
    let forgotten = false
    store.update((memory) => {
      forgotten = forgetFactInMemory(memory, key)
      return memory
    })
    return { ok: true, deleted: forgotten, forgotten, id: key }
  }

  function memoryDeleteEntity(id) {
    const key = String(id ?? '').trim()
    if (!key) return { ok: false, reason: 'id 为空' }
    const exists = asArray(readMemory().entities).some((entity) => entity && entity.id === key)
    if (!exists) return { ok: false, reason: 'not-found' }
    let result = { ok: false, reason: 'not-found' }
    store.update((memory) => {
      result = deleteEntityInMemory(memory, key)
      return memory
    })
    return result
  }

  function memoryMergeEntities(input = {}) {
    const fromId = String(input?.fromId ?? '').trim()
    const toId = String(input?.toId ?? '').trim()
    if (!fromId || !toId) return { ok: false, reason: '需要 fromId 和 toId' }
    if (fromId === toId) return { ok: false, reason: 'same-entity' }
    let result = { ok: false, reason: 'not-found' }
    store.update((memory) => {
      result = mergeEntitiesInMemory(memory, fromId, toId)
      return memory
    })
    return result
  }

  /** compact：强制立即整理，返回前后统计。 */
  function memoryCompact() {
    const before = memoryCounts()
    const result = compact(true)
    const after = memoryCounts()
    return { ok: true, before, after, result }
  }

  /** memory-api POST 的请求体：支持 Node 流，也兼容测试直接塞 req.body。 */
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

  /** POST /dsh-aura/memory-api：{action:'compact'|'deleteFact'|'deleteNote'|'deleteEntity', id?} */
  async function handleMemoryApiPost(req, res) {
    let body
    try {
      body = await readRequestBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体解析失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const action = String(body?.action ?? '').trim()
    const id = String(body?.id ?? body?.noteId ?? '').trim()
    try {
      if (action === 'digest') {
        const result = await digestSession({
          sessionId: String(body?.sessionId ?? '').trim(),
          manual: true,
          reason: 'manual',
        })
        const status = result.ok === true || result.reason === 'empty' ? 200 : 400
        sendJson(res, status, { ...result, action })
        return
      }
      if (action === 'compact') {
        await backupMemoryBeforeWrite()
        sendJson(res, 200, { ok: true, action, ...memoryCompact() })
        return
      }
      if (action === 'deleteFact') {
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'id required' })
          return
        }
        const exists = asArray(readMemory().facts).some((fact) => fact && fact.id === id)
        if (!exists) {
          sendJson(res, 404, { ok: false, error: 'fact not found' })
          return
        }
        await backupMemoryBeforeWrite()
        sendJson(res, 200, { ok: true, action, ...memoryDeleteFact(id) })
        return
      }
      if (action === 'deleteNote') {
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'id required' })
          return
        }
        const peek = locateNoteInMemory(readMemory(), { id })
        if (!peek.ok) {
          sendJson(res, peek.reason === 'ambiguous' ? 400 : 404, { ok: false, error: peek.reason })
          return
        }
        await backupMemoryBeforeWrite()
        sendJson(res, 200, { ok: true, action, ...memoryDeleteNote({ id }) })
        return
      }
      if (action === 'deleteEntity') {
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'id required' })
          return
        }
        const exists = asArray(readMemory().entities).some((entity) => entity && entity.id === id)
        if (!exists) {
          sendJson(res, 404, { ok: false, error: 'entity not found' })
          return
        }
        await backupMemoryBeforeWrite()
        sendJson(res, 200, { ok: true, action, ...memoryDeleteEntity(id) })
        return
      }
      sendJson(res, 400, {
        ok: false,
        error: 'unknown action（compact | digest | deleteFact | deleteNote | deleteEntity）',
      })
    } catch (error) {
      logger('[soul] memory-api POST 失败:', error instanceof Error ? error.message : error)
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  function pendingDue(now = Date.now()) {
    try {
      return asArray(readMemory().reflection?.pendingDue)
        .filter((item) => item && asNumber(item.at, 0) > 0 && asNumber(item.at, 0) <= now)
        .sort((a, b) => asNumber(a.at, 0) - asNumber(b.at, 0))
    } catch {
      return []
    }
  }

  function consumeDue(now = Date.now()) {
    const due = pendingDue(now)
    try {
      const dueIds = new Set(due.map((item) => item.id))
      store.update((memory) => {
        if (!memory.reflection || typeof memory.reflection !== 'object') memory.reflection = {}
        memory.reflection.pendingDue = asArray(memory.reflection.pendingDue).filter((item) => !dueIds.has(item.id))
        return memory
      })
    } catch {
      /* ignore */
    }
    return due
  }

  const api = {
    file: store.file,
    store,
    memoryStore: store,
    snapshot,
    renderContext: (now, options = {}) => {
      try {
        return renderMemoryContext(store, readConfig(), {
          now: asNumber(now, Date.now()),
          soul: readSoul(),
          getArchive: () => (typeof getArchive === 'function' ? getArchive() : undefined),
          saveInject: saveInjectEntry,
          ...(options && typeof options === 'object' ? options : {}),
        })
      } catch {
        return ''
      }
    },
    recall,
    note,
    addFact: (input = {}) => {
      let result = { ok: false }
      try {
        store.update((memory) => {
          result = addFactToMemory(memory, input, Date.now())
          return memory
        })
      } catch (error) {
        logger('[soul] addFact 失败:', error instanceof Error ? error.message : error)
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      return result
    },
    queryFacts: (query, limit = 5) => queryFactsInMemory(readMemory(), query, clamp(asNumber(limit, 5), 1, 50), Date.now()),
    listFacts: (limit = 50) => listFactsInMemory(readMemory(), clamp(asNumber(limit, 50), 1, FACT_LIMIT)),
    forgetFact: (id) => {
      let forgotten = false
      try {
        store.update((memory) => {
          forgotten = forgetFactInMemory(memory, id)
          return memory
        })
      } catch (error) {
        logger('[soul] forgetFact 失败:', error instanceof Error ? error.message : error)
      }
      return forgotten
    },
    upsertEntity: (name, options = {}) => {
      let result = { ok: false }
      try {
        store.update((memory) => {
          result = upsertEntityInMemory(memory, name, options, Date.now())
          return memory
        })
      } catch (error) {
        logger('[soul] upsertEntity 失败:', error instanceof Error ? error.message : error)
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      return result
    },
    listEntities: (limit = 50) => listEntitiesInMemory(readMemory(), clamp(asNumber(limit, 50), 1, ENTITY_LIMIT)),
    listRelations: (limit = 50) => listRelationsInMemory(readMemory(), clamp(asNumber(limit, 50), 1, RELATION_LIMIT)),
    relationsForEntity: (nameOrId, options = {}) => relationsForEntityInMemory(readMemory(), nameOrId, options),
    upsertRelation: (input = {}) => {
      let result = { ok: false }
      try {
        store.update((memory) => {
          result = upsertRelationInMemory(memory, input, Date.now())
          return memory
        })
      } catch (error) {
        logger('[soul] upsertRelation 失败:', error instanceof Error ? error.message : error)
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      return result
    },
    compactRelations: (now = Date.now()) => {
      let result = { relationsPruned: 0, relationsDecayed: 0 }
      try {
        store.update((memory) => {
          result = compactRelations(memory, now)
          return memory
        })
      } catch (error) {
        logger('[soul] compactRelations 失败:', error instanceof Error ? error.message : error)
      }
      return result
    },
    stats: memoryStats,
    search: memorySearch,
    writeNote: memoryWriteNote,
    updateNote: memoryUpdateNote,
    deleteNote: memoryDeleteNote,
    deleteFact: memoryDeleteFact,
    deleteEntity: memoryDeleteEntity,
    mergeEntities: memoryMergeEntities,
    extractFacts,
    reflect,
    compact,
    pendingDue,
    consumeDue,
    clear,
    addEvent: (event) => pushEvent(event),
    /** 手动会话整理（面板按钮 / 自测）；manual=false 时走自动规则（受开关与每日上限约束）。 */
    digest: (input = {}) => digestSession({
      sessionId: input?.sessionId,
      now: input?.now,
      manual: input?.manual !== false,
      reason: input?.manual === false ? 'auto' : 'manual',
    }),
    onUserMessage,
    onAssistantMessage,
    onTurnEnd,
    constants: {
      TOPIC_VOCAB,
      SUMMARY_MAX,
      MEMORY_CONTEXT_BUDGET,
      MEMORY_CONTEXT_BUDGET_MIN,
      MEMORY_CONTEXT_BUDGET_MAX,
      INJECT_SESSION_LIMIT,
      NOTE_MAX,
      NOTE_MAX_CHARS,
      EVENT_MAX,
      EVENT_COMPACT_THRESHOLD,
      EVENT_COMPACT_BATCH,
      MEMORY_FILE,
      MEMORY_VERSION,
      FACT_LIMIT,
      ENTITY_LIMIT,
      RELATION_LIMIT,
      FACT_TEXT_MAX,
      MEMORY_API_PREFIX,
      ENTITY_TYPE_LABELS,
      IMMEDIATE_NOTE_MAX,
      IMMEDIATE_PROMISE_RE,
      DEDUP_WINDOW_MS,
      DIGEST_NOTE_MAX,
      DIGEST_EVENT_WINDOW,
      DIGEST_FACT_WINDOW,
    },
  }
  return api
}
