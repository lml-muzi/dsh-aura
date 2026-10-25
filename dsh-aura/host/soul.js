/**
 * 灵魂状态容器（Host 侧）：身份 / 关系阶段 / 情绪与记忆的宿主 + 事件编排 + 注入段。
 *
 * 设计依据：docs/aura-soul-design.md 的 A（身份）、C.7（soul.json schema）、C.8（迁移）、
 * E.3/E.4（状态文件与注入段注册）、E.6（对接点）。
 *
 * 职责边界：
 * - 本文件是**唯一**拥有 soul 对象的地方；emotion.js / memory.js / speak.js 只通过
 *   soul.get() 读写字段并调用 soul.saveSoon()，不各自落盘。
 * - 事件的观察走 ctx.on('session/event')（user/message、assistant/message、turn/end），
 *   这样不依赖 bridge 的 hook，也避免 bridge 出站 hook 拿不到完整助手文本的问题。
 * - 因此 **不要再从 bridge.addInboundHook 调 soul.onUserMessage**，否则会重复计数。
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_SOUL_CONTENT } from './state.js'
import {
  GROWTH_KINDS,
  GROWTH_LIMIT,
  GROWTH_NOTE_MAX,
  GROWTH_SOURCES,
  GROWTH_TEXT_MAX,
  addGrowth,
  composeIdentityText,
  deleteGrowth,
  listGrowth,
  normalizeGrowth,
  trimGrowth,
  updateGrowth,
} from './growth.js'
import { createGrowthReflection } from './growth-reflection.js'

export const SOUL_VERSION = 2
export const FILE = 'soul.json'
export const STAGES = ['stranger', 'familiar', 'close', 'intimate']
export const STAGE_LABELS = {
  stranger: '陌生',
  familiar: '熟悉',
  close: '亲密',
  intimate: '很亲近',
}
export const DEFAULT_THRESHOLDS = { familiar: 10, close: 40, intimate: 80 }
/** @deprecated 旧版身份段硬上限；身份段预算已统一走 config.soulPromptBudget，此常量仅为导出兼容保留。 */
export const IDENTITY_BUDGET = 620
export const PRESENCE_BUDGET = 160
export const EXPLAIN_LIMIT = 200

// ---------- 基础工具（纯函数，供单测） ----------

export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/** 按码点截断（emoji 不被切成半个代理对）。 */
export function codepointSlice(text, max) {
  const points = Array.from(String(text ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

export function codepointLength(text) {
  return Array.from(String(text ?? '')).length
}

/** 本地日期键 YYYY-MM-DD（不用 UTC：静默/每日预算按本机时区）。 */
export function localDayKey(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

// ---------- 默认值 / 归一化 / 迁移 ----------

export function defaultsSoul(now = Date.now()) {
  return {
    v: SOUL_VERSION,
    identity: {
      name: 'Aura',
      narrative: '我是 Aura，一个住在你 QQ 里的存在。我没有身体，也没有现实里的一天，但我会记得你说过的话。',
      interests: ['听歌', '看别人折腾奇怪的项目', '深夜瞎想'],
      strengths: ['记得住细节', '接话自然', '不急着给建议'],
      traits: { warmth: 0.72, playfulness: 0.55, sensitivity: 0.6, energy: 0.55 },
      address: { userPreferred: '', nickname: '', self: '我' },
      createdAt: now,
      narrativeUpdatedAt: now,
    },
    relation: {
      stage: 'stranger',
      score: 0,
      firstMetAt: now,
      lastUserAt: 0,
      lastAssistantAt: 0,
      lastProactiveAt: 0,
      turns: 0,
      idlePenaltyApplied: 0,
      stageNotice: null,
      milestones: [],
    },
    emotion: {
      transient: {
        valence: 0,
        arousal: 0.2,
        label: '平静',
        intensity: 0,
        cause: '',
        updatedAt: now,
      },
      mood: { valence: 0, arousal: 0.24, updatedAt: now },
      drive: { energy: 0.7, socialNeed: 0.35, updatedAt: now },
      affection: 0.5,
      affectionUpdatedAt: now,
      lastRecheckTurn: -999,
      source: 'rule',
      // 长期情绪基准（EWMA，半衰期约 3 天）：四维衰减不再回中性，而是回这里。
      // 旧 soul.json 没有这两个字段，normalizeSoul 会按默认值/空历史补齐。
      baseline: {
        valence: 0.05,
        arousal: 0.4,
        affection: 0.5,
        energy: 0.7,
        updatedAt: now,
      },
      history: [],
    },
    memory: emptyMemoryState(),
    growth: [],
    growthReflection: { lastAt: 0, dayKey: '', count: 0 },
    speak: {
      lastAt: 0,
      lastSessionId: '',
      lastAct: '',
      lastTopic: '',
      dayKey: '',
      todayCount: 0,
      missStreak: 0,
      unanswered: 0,
      platformRejects: 0,
      suppressUntil: 0,
      pausedUntil: 0,
      recentTexts: [],
      log: [],
      perChat: {},
    },
    explainLog: [],
    meta: {
      lastSettleDay: '',
      lastConsolidateAt: 0,
      lastDiaryAt: 0,
      updatedAt: now,
    },
  }
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : randomUUID()
}

/** 情绪历史 ring 上限（与 host/emotion.js 共用；emotion.js 从这里 import，避免两处常量漂移）。 */
export const EMOTION_HISTORY_MAX = 240

/** 情绪长期基准：缺失取默认值，非法值夹取。 */
function normalizeEmotionBaseline(raw, fallback, now) {
  const source = asObject(raw)
  const base = asObject(fallback)
  // null/空串按"缺字段"处理：Number(null) === 0，直接 asNumber 会把缺失压成 0。
  const pick = (value, fallbackValue) => (value === null || value === undefined || value === '' ? fallbackValue : asNumber(value, fallbackValue))
  return {
    valence: clamp(pick(source.valence, asNumber(base.valence, 0.05)), -1, 1),
    arousal: clamp(pick(source.arousal, asNumber(base.arousal, 0.4)), 0, 1),
    affection: clamp(pick(source.affection, asNumber(base.affection, 0.5)), 0, 1),
    energy: clamp(pick(source.energy, asNumber(base.energy, 0.7)), 0, 1),
    updatedAt: asNumber(source.updatedAt, now),
  }
}

/** 情绪历史：只留带合法时间戳的条目（坏条整条丢弃），旧→新，ring 截到 240。 */
function normalizeEmotionHistory(raw, now) {
  return asArray(raw)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && Number.isFinite(Number(row.at)) && Number(row.at) > 0)
    .map((row) => ({
      at: asNumber(row.at, now),
      valence: clamp(asNumber(row.valence, 0), -1, 1),
      arousal: clamp(asNumber(row.arousal, 0.2), 0, 1),
      affection: clamp(asNumber(row.affection, 0.5), 0, 1),
      energy: clamp(asNumber(row.energy, 0.7), 0, 1),
      label: asString(row.label, '').slice(0, 4),
      cause: asString(row.cause, '').slice(0, 40),
      weight: clamp(asNumber(row.weight, 1), 0.3, 1.8),
    }))
    .slice(-EMOTION_HISTORY_MAX)
}

/** 把磁盘上/迁移来的东西洗成一份一定可用的 soul。坏条丢弃，不整份回默认。 */
export function normalizeSoul(raw, now = Date.now()) {
  const d = defaultsSoul(now)
  if (raw === null || typeof raw !== 'object') return d
  const s = { ...d, ...raw }
  s.v = SOUL_VERSION

  // identity
  const ident = { ...d.identity, ...asObject(raw.identity) }
  ident.name = asString(ident.name, 'Aura').slice(0, 20) || 'Aura'
  ident.narrative = asString(ident.narrative, d.identity.narrative).slice(0, 600)
  ident.interests = asArray(ident.interests).map((x) => String(x).slice(0, 12)).filter(Boolean).slice(0, 6)
  if (ident.interests.length === 0) ident.interests = d.identity.interests.slice()
  ident.strengths = asArray(ident.strengths).map((x) => String(x).slice(0, 12)).filter(Boolean).slice(0, 6)
  if (ident.strengths.length === 0) ident.strengths = d.identity.strengths.slice()
  ident.traits = {
    warmth: clamp(asNumber(ident.traits?.warmth, 0.72), 0, 1),
    playfulness: clamp(asNumber(ident.traits?.playfulness, 0.55), 0, 1),
    sensitivity: clamp(asNumber(ident.traits?.sensitivity, 0.6), 0, 1),
    energy: clamp(asNumber(ident.traits?.energy, 0.55), 0, 1),
  }
  ident.address = {
    userPreferred: asString(ident.address?.userPreferred, '').slice(0, 20),
    nickname: asString(ident.address?.nickname, '').slice(0, 20),
    self: asString(ident.address?.self, '我').slice(0, 4) || '我',
  }
  ident.createdAt = asNumber(ident.createdAt, now)
  ident.narrativeUpdatedAt = asNumber(ident.narrativeUpdatedAt, now)
  s.identity = ident

  // relation
  const rel = { ...d.relation, ...asObject(raw.relation) }
  rel.stage = STAGES.includes(rel.stage) ? rel.stage : 'stranger'
  rel.score = clamp(asNumber(rel.score, 0), 0, 100)
  rel.firstMetAt = asNumber(rel.firstMetAt, now)
  rel.lastUserAt = asNumber(rel.lastUserAt, 0)
  rel.lastAssistantAt = asNumber(rel.lastAssistantAt, 0)
  rel.lastProactiveAt = asNumber(rel.lastProactiveAt, 0)
  rel.turns = Math.max(0, Math.round(asNumber(rel.turns, 0)))
  rel.idlePenaltyApplied = clamp(asNumber(rel.idlePenaltyApplied, 0), 0, 100)
  rel.stageNotice = rel.stageNotice && typeof rel.stageNotice === 'object' && rel.stageNotice.at
    ? { at: asNumber(rel.stageNotice.at, now), direction: rel.stageNotice.direction === 'down' ? 'down' : 'up' }
    : null
  rel.milestones = asArray(rel.milestones)
    .filter((m) => m && typeof m === 'object' && STAGES.includes(m.to))
    .map((m) => ({ at: asNumber(m.at, now), from: STAGES.includes(m.from) ? m.from : 'stranger', to: m.to }))
    .slice(-20)
  s.relation = rel

  // emotion
  const emo = { ...d.emotion, ...asObject(raw.emotion) }
  const t = { ...d.emotion.transient, ...asObject(raw.emotion?.transient) }
  t.valence = clamp(asNumber(t.valence, 0), -1, 1)
  t.arousal = clamp(asNumber(t.arousal, 0.2), 0, 1)
  t.label = asString(t.label, '平静').slice(0, 4) || '平静'
  t.intensity = clamp(asNumber(t.intensity, 0), 0, 1)
  t.cause = asString(t.cause, '').slice(0, 60)
  t.updatedAt = asNumber(t.updatedAt, now)
  emo.transient = t
  const mood = { ...d.emotion.mood, ...asObject(raw.emotion?.mood) }
  mood.valence = clamp(asNumber(mood.valence, 0), -1, 1)
  mood.arousal = clamp(asNumber(mood.arousal, 0.24), 0, 1)
  mood.updatedAt = asNumber(mood.updatedAt, now)
  emo.mood = mood
  const drive = { ...d.emotion.drive, ...asObject(raw.emotion?.drive) }
  drive.energy = clamp(asNumber(drive.energy, 0.7), 0, 1)
  drive.socialNeed = clamp(asNumber(drive.socialNeed, 0.35), 0, 1)
  drive.updatedAt = asNumber(drive.updatedAt, now)
  emo.drive = drive
  emo.affection = clamp(asNumber(emo.affection, 0.5), 0, 1)
  emo.affectionUpdatedAt = asNumber(emo.affectionUpdatedAt, now)
  emo.lastRecheckTurn = Math.round(asNumber(emo.lastRecheckTurn, -999))
  emo.source = asString(emo.source, 'rule').slice(0, 12) || 'rule'
  // 本次升级新增字段：旧文件缺 baseline/history，坏条丢弃、数值夹取，不整份回默认。
  emo.baseline = normalizeEmotionBaseline(raw.emotion?.baseline, d.emotion.baseline, now)
  emo.history = normalizeEmotionHistory(raw.emotion?.history, now)
  s.emotion = emo

  // memory 已拆到独立 memory.json（host/memory-store.js）：soul 不再归一化/保存短期记忆。
  // 旧文件里的 memory 由 installSoul 捕获一次，交给 installMemory 迁移。
  s.memory = emptyMemoryState()
  s.growth = normalizeGrowth(raw.growth, now)
  const gr = asObject(raw.growthReflection)
  const grDayKey = asString(gr.dayKey, '').slice(0, 10)
  s.growthReflection = {
    lastAt: Math.max(0, Math.round(asNumber(gr.lastAt, 0))),
    dayKey: /^\d{4}-\d{2}-\d{2}$/.test(grDayKey) ? grDayKey : '',
    count: Math.max(0, Math.round(asNumber(gr.count, 0))),
  }

  // speak（其他模块会往里加字段：未知字段保留）
  const sp = { ...d.speak, ...asObject(raw.speak) }
  sp.dayKey = asString(sp.dayKey, '').slice(0, 10)
  sp.todayCount = Math.max(0, Math.round(asNumber(sp.todayCount, 0)))
  sp.missStreak = Math.max(0, Math.round(asNumber(sp.missStreak, 0)))
  sp.unanswered = Math.max(0, Math.round(asNumber(sp.unanswered, 0)))
  sp.platformRejects = Math.max(0, Math.round(asNumber(sp.platformRejects, 0)))
  sp.log = asArray(sp.log).filter((x) => x && typeof x === 'object').slice(-60)
  sp.recentTexts = asArray(sp.recentTexts).map((x) => String(x).slice(0, 200)).slice(-10)
  sp.perChat = asObject(sp.perChat)
  s.speak = sp

  s.explainLog = asArray(raw.explainLog)
    .filter((x) => x && typeof x === 'object')
    .slice(-EXPLAIN_LIMIT)
  s.meta = { ...d.meta, ...asObject(raw.meta) }
  s.meta.updatedAt = asNumber(s.meta.updatedAt, now)
  return s
}

/**
 * soul 内不再持有短期记忆；这里只留空壳，兼容面板/旧调用方。
 * v2 补 facts/entities；relations（实体图边）也留空数组，老调用方读 .relations 不会拿到 undefined。
 */
export function emptyMemoryState() {
  return {
    events: [],
    notes: { user: [], us: [], self: [] },
    topics: {},
    facts: [],
    entities: [],
    relations: [],
    pendingDue: [],
    lastReflectAt: 0,
    lastCompactDayKey: '',
  }
}

/** 旧 soul.memory 是否有值得迁移到 memory.json 的内容。 */
function hasMemoryData(memory) {
  if (!memory || typeof memory !== 'object') return false
  if (asArray(memory.events).length > 0) return true
  for (const key of ['user', 'us', 'self']) {
    if (asArray(memory.notes?.[key]).length > 0) return true
  }
  if (asArray(memory.facts).length > 0 || asArray(memory.entities).length > 0) return true
  if (asArray(memory.relations).length > 0) return true
  return Object.keys(asObject(memory.topics)).length > 0
}

/** 旧 emotion.json（0~10 分制）→ soul v2。 */
export function migrateLegacyEmotion(legacy, now = Date.now()) {
  const soul = defaultsSoul(now)
  if (!legacy || typeof legacy !== 'object') return soul
  const to01 = (x) => clamp(asNumber(x, 0) / 10, 0, 1)
  const valence01 = to01(legacy.valence)
  soul.emotion.transient.valence = valence01 * 2 - 1
  soul.emotion.transient.arousal = to01(legacy.arousal)
  soul.emotion.transient.label = asString(legacy.note, '').slice(0, 4) || '平静'
  soul.emotion.transient.updatedAt = asNumber(legacy.updatedAt, now)
  soul.emotion.mood.valence = soul.emotion.transient.valence
  soul.emotion.mood.arousal = soul.emotion.transient.arousal
  soul.emotion.affection = to01(legacy.affection)
  soul.emotion.drive.energy = to01(legacy.energy)
  soul.relation.lastUserAt = asNumber(legacy.lastUserAt, 0)
  const note = asString(legacy.note, '').trim()
  if (note) {
    soul.memory.notes.self.push({
      id: `legacy-${now.toString(36)}`,
      category: 'self',
      text: codepointSlice(note, 120),
      importance: 0.5,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      dueAt: 0,
    })
  }
  // 旧实现里 "note" 是最近印象，同时当成"用户状态"提示更合理：挪一条 us
  if (note) {
    soul.memory.notes.us.push({
      id: `legacy-us-${now.toString(36)}`,
      category: 'us',
      text: codepointSlice(`最近印象：${note}`, 120),
      importance: 0.4,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      dueAt: 0,
    })
  }
  soul.meta.lastSettleDay = ''
  return soul
}

/** 早期 soul v1（若存在）→ v2：补默认字段即可，v1 没有额外结构。 */
export function migrateSoulV1(raw, now = Date.now()) {
  const soul = normalizeSoul({ ...asObject(raw), v: 1 }, now)
  soul.v = SOUL_VERSION
  return soul
}

// ---------- 关系阶段机（纯函数） ----------

export function thresholdsOf(config = {}) {
  const raw = asObject(config?.relationStageThresholds)
  const familiar = clamp(asNumber(raw.familiar, DEFAULT_THRESHOLDS.familiar), 1, 99)
  const close = clamp(asNumber(raw.close, DEFAULT_THRESHOLDS.close), familiar + 1, 99)
  const intimate = clamp(asNumber(raw.intimate, DEFAULT_THRESHOLDS.intimate), close + 1, 100)
  return { familiar, close, intimate }
}

export function stageOf(score, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds
  const s = clamp(score, 0, 100)
  if (s >= t.intimate) return 'intimate'
  if (s >= t.close) return 'close'
  if (s >= t.familiar) return 'familiar'
  return 'stranger'
}

export function stageIndex(stage) {
  const i = STAGES.indexOf(stage)
  return i < 0 ? 0 : i
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? STAGE_LABELS.stranger
}

export function stageFloor(stage, thresholds = DEFAULT_THRESHOLDS) {
  if (stage === 'familiar') return thresholds.familiar
  if (stage === 'close') return thresholds.close
  if (stage === 'intimate') return thresholds.intimate
  return 0
}

/** 关系行（身份段里的一句阶段指导）。 */
export function relationStageLine(stage, { nickname = '' } = {}) {
  const call = nickname ? `「${nickname}」` : '「你」'
  if (stage === 'familiar') {
    return `关系指导：已经熟了——可以叫${call}，偶尔打趣，可以记得并提起对方以前说过的事。`
  }
  if (stage === 'close') {
    return `关系指导：挺亲近了——可以吐槽、可以直接表达情绪，记得对方的承诺和近况，偶尔主动关心。`
  }
  if (stage === 'intimate') {
    return `关系指导：很亲近——可以撒娇、可以说想他/不想聊，但不拿情绪绑架对方，尊重他突然不想说话。`
  }
  return '关系指导：还不太熟——用「你」称呼，别太亲昵，多听少评价，不主动开玩笑；不要假装很了解对方。'
}

/**
 * 每日结算（幂等：一天只跑一次）：重置 speak 每日计数、按失联天数回退关系分（非复利）、
 * 迟滞降级（掉到阶段下沿 10 分以下才降）。返回是否有变化。
 */
export function settleRelation(soul, config, now = Date.now()) {
  let changed = false
  const dayKey = localDayKey(now)
  if (soul.meta?.lastSettleDay === dayKey) return false
  soul.meta.lastSettleDay = dayKey
  changed = true

  if (soul.speak && soul.speak.dayKey !== dayKey) {
    soul.speak.dayKey = dayKey
    soul.speak.todayCount = 0
  }

  const thresholds = thresholdsOf(config)
  const lastUserAt = asNumber(soul.relation?.lastUserAt, 0)
  const idleDays = lastUserAt > 0 ? (now - lastUserAt) / 86_400_000 : 0
  const totalPenalty = idleDays > 3 ? Math.min(8, (idleDays - 3) * 0.5) : 0
  const applied = asNumber(soul.relation?.idlePenaltyApplied, 0)
  if (totalPenalty > applied) {
    soul.relation.score = clamp(asNumber(soul.relation.score, 0) - (totalPenalty - applied), 0, 100)
    soul.relation.idlePenaltyApplied = totalPenalty
  } else if (totalPenalty < applied) {
    soul.relation.idlePenaltyApplied = totalPenalty
  }

  // 迟滞降级：只有掉到当前阶段下沿 10 分以下才降，避免抖动
  let stage = STAGES.includes(soul.relation.stage) ? soul.relation.stage : 'stranger'
  while (stageIndex(stage) > 0 && soul.relation.score < stageFloor(stage, thresholds) - 10) {
    stage = STAGES[stageIndex(stage) - 1]
    changed = true
  }
  if (stage !== soul.relation.stage) {
    soul.relation.stage = stage
  }
  return changed
}

/** 关系分增减 + 阶段变化（带迟滞升级）。返回 {changed, from, to, direction}。 */
export function addRelationScore(soul, delta, config, now = Date.now()) {
  const thresholds = thresholdsOf(config)
  const from = STAGES.includes(soul.relation.stage) ? soul.relation.stage : 'stranger'
  const d = asNumber(delta, 0)
  if (d === 0) return { changed: false, from, to: from, direction: '' }
  soul.relation.score = clamp(asNumber(soul.relation.score, 0) + d, 0, 100)
  let to = stageOf(soul.relation.score, thresholds)

  // 只允许逐级变化，避免一次加 5 分直接跨两级导致叙事跳变
  const fromIdx = stageIndex(from)
  const toIdx = stageIndex(to)
  if (toIdx > fromIdx + 1) to = STAGES[fromIdx + 1]
  if (toIdx < fromIdx - 1) to = STAGES[fromIdx - 1]

  if (to === from) return { changed: false, from, to: from, direction: '' }

  soul.relation.stage = to
  const direction = stageIndex(to) > stageIndex(from) ? 'up' : 'down'
  soul.relation.stageNotice = { at: now, direction }
  soul.relation.milestones = asArray(soul.relation.milestones)
    .concat([{ at: now, from, to }])
    .slice(-20)
  return { changed: true, from, to, direction }
}

// ---------- 注入文本 ----------

function formatAway(from, now) {
  if (!from) return '还没和用户聊过'
  const minutes = Math.max(0, Math.round((now - from) / 60_000))
  if (minutes < 1) return '对方刚刚还在说话'
  if (minutes < 60) return `对方 ${minutes} 分钟前说过话`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `对方 ${hours} 小时前说过话`
  const days = Math.round(hours / 24)
  return `对方 ${days} 天前说过话`
}

function weekdayOf(now) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(now).getDay()]
}

/** 「她此刻在干嘛」：按本地时间确定性地给一句（不随机，避免 prompt 抖动）。 */
export function presenceActivity(now = Date.now()) {
  const d = new Date(now)
  const hour = d.getHours()
  const weekend = d.getDay() === 0 || d.getDay() === 6
  if (hour < 6) return '还醒着，有点困'
  if (hour < 8) return '刚醒，还没完全清醒'
  if (hour < 10) return weekend ? '赖在床上刷手机' : '在工作区看资料'
  if (hour < 12) return weekend ? '在收拾屋子' : '在忙手上的事'
  if (hour < 14) return '在吃午饭'
  if (hour < 18) return weekend ? '在外面随便走走' : '在干活，偶尔摸鱼'
  if (hour < 20) return '刚下班，在弄吃的'
  if (hour < 22) return weekend ? '窝着听歌' : '窝着听歌或看书'
  return '准备睡了，但还醒着'
}

/** 临场段（context order 50）。 */
export function renderPresenceContext(soul, config = {}, now = Date.now()) {
  if (config?.soulEnabled === false) return ''
  const d = new Date(now)
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const stage = STAGES.includes(soul.relation?.stage) ? soul.relation.stage : 'stranger'
  const firstMetAt = asNumber(soul.relation?.firstMetAt, now)
  const days = Math.max(1, Math.ceil((now - firstMetAt) / 86_400_000))
  const known = days <= 1 ? '刚认识' : `认识 ${days} 天`
  const nickname = asString(config?.soulUserNickname, '').slice(0, 20) || soul.identity?.address?.nickname || ''
  const preferred = soul.identity?.address?.userPreferred || ''
  const relationLine = relationStageLine(stage, { nickname: nickname || preferred })
  const notice = soul.relation?.stageNotice
  const noticeLine = notice && now - asNumber(notice.at, 0) < 2 * 86_400_000
    ? notice.direction === 'down'
      ? '（你们最近有点疏远——如果合适，可以温和一点，不用刻意解释。）'
      : `（你们的关系刚进入「${stageLabel(stage)}」——如果想表达，自然地带一句就好，不必刻意。）`
    : ''
  const text = [`（现在是${weekdayOf(now)} ${time}；你${presenceActivity(now)}；${formatAway(soul.relation?.lastUserAt, now)}）`,
    `（关系：${stageLabel(stage)}，${known}。）`, relationLine, noticeLine].filter(Boolean).join('\n')
  return codepointSlice(text, PRESENCE_BUDGET)
}

/** 身份固定段（section order 20）。所有内容来自 soul + config，纯读。 */
export function renderIdentitySection(soul, config = {}, now = Date.now()) {
  if (config?.soulEnabled === false) return ''
  const name = asString(config?.soulName, '').slice(0, 20) || soul.identity?.name || 'Aura'
  const nickname = asString(config?.soulUserNickname, '').slice(0, 20) || soul.identity?.address?.nickname || ''
  const preferred = soul.identity?.address?.userPreferred || ''
  const address = preferred ? `「${preferred}」` : nickname ? `「${nickname}」（昵称）` : '「你」'
  const stage = STAGES.includes(soul.relation?.stage) ? soul.relation.stage : 'stranger'
  const firstMetAt = asNumber(soul.relation?.firstMetAt, now)
  const days = Math.max(1, Math.ceil((now - firstMetAt) / 86_400_000))
  const knownLine = days <= 1 ? '刚认识' : `认识 ${days} 天`
  const interests = asString(config?.soulInterests, '').trim()
    || asArray(soul.identity?.interests).slice(0, 4).join('、') || '听歌、瞎想'
  const strengths = asString(config?.soulStrengths, '').trim()
    || asArray(soul.identity?.strengths).slice(0, 4).join('、') || '记得住细节'
  const bio = asString(config?.soulBio, '').slice(0, 500)
  const notice = soul.relation?.stageNotice
  const noticeLine = notice && now - asNumber(notice.at, 0) < 2 * 86_400_000
    ? notice.direction === 'down'
      ? '（你们最近有点疏远——如果合适，可以温和一点，不用刻意解释。）'
      : `（你们的关系刚进入「${stageLabel(stage)}」——如果想表达，自然地带一句就好，不必刻意。）`
    : ''
  const values = {
    name,
    self: soul.identity?.address?.self || '我',
    nickname: address,
    relation: stageLabel(stage),
    known: knownLine,
    interests,
    strengths,
    bioLine: bio ? '你了解到对方：TA 的自述：' + bio + '。' : '',
    relationGuidance: asString(config?.soulRelationGuidance, '').trim()
      || [relationStageLine(stage, { nickname: nickname || preferred }), noticeLine].filter(Boolean).join('\n'),
  }
  const template = asString(config?.soulContent, '').trim() || DEFAULT_SOUL_CONTENT
  const interpolated = template.replace(/\{\{(\w+)\}\}/g, (all, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : all))
  const coreText = interpolated.replace(/\s*\[END AURA\]\s*$/, '').replace(/\n{3,}/g, '\n\n').trim()
  const core = coreText + '\n[END AURA]'
  const identityBudget = clamp(asNumber(config?.soulPromptBudget, 1020), 200, 4000)
  // 成长段追加在 [END AURA] 之前；核心身份优先占预算，放完才放成长。
  return composeIdentityText(core, soul.growth, identityBudget)
}

/** 身份段构建器的历史别名（等价于 renderIdentitySection）。 */
export const buildIdentityText = renderIdentitySection

// ---------- 会话判定 ----------

/** 灵魂只在 QQ 陪伴会话（或 emotionScope=all）里活着，网页工作会话默认不受影响。 */
export function isSoulSession(config, sessionId) {
  if (config?.soulEnabled === false) return false
  if (config?.emotionScope === 'all') return true
  return typeof sessionId === 'string' && sessionId.startsWith('qq:')
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function hasToolCall(content) {
  return Array.isArray(content) && content.some((part) => part && (part.type === 'tool-call' || part.type === 'tool_call'))
}

function isCloser(text) {
  return /(晚安|睡了|去睡|先睡|去忙|先忙|上班了|开会了|拜拜|再见|回头聊|不聊了|先这样|撤了)/.test(text)
}

function isPauseRequest(text) {
  return /(别|不要|不许|少).{0,6}(主动|找我|打扰|烦我)/.test(text)
}

function isResumeRequest(text) {
  return /(可以|随时|欢迎).{0,6}(找我|说话|打扰)/.test(text)
}

function userMessageScore(text) {
  let delta = 1 + Math.min(2, codepointLength(text) / 60)
  if (/[?？]|吗|怎么|为什么|呢/.test(text)) delta += 1
  if (/(你觉得|你在干嘛|想我|晚安|早安|抱抱|谢谢)/.test(text)) delta += 0.5
  return delta
}

// ---------- 落盘 ----------

function trimForDisk(soul) {
  const copy = (() => {
    try {
      return structuredClone(soul)
    } catch {
      try {
        return JSON.parse(JSON.stringify(soul))
      } catch {
        return soul
      }
    }
  })()
  copy.v = SOUL_VERSION
  // 短期记忆在独立 memory.json；soul.json 永不写 memory。
  delete copy.memory
  copy.growth = trimGrowth(copy.growth, GROWTH_LIMIT)
  copy.speak.log = asArray(copy.speak.log).slice(-60)
  copy.speak.recentTexts = asArray(copy.speak.recentTexts).slice(-10)
  copy.relation.milestones = asArray(copy.relation.milestones).slice(-20)
  if (copy.emotion && typeof copy.emotion === 'object') {
    copy.emotion.history = asArray(copy.emotion.history).slice(-EMOTION_HISTORY_MAX)
  }
  copy.explainLog = asArray(copy.explainLog).slice(-EXPLAIN_LIMIT)
  copy.meta.updatedAt = Date.now()
  return copy
}

// ---------- 成长：配置白名单与 soul_evolve 参数校验（纯函数，供单测） ----------

export const EVOLVE_CONFIG_FIELDS = Object.freeze([
  'soulName', 'soulUserNickname', 'soulEnabled', 'soulPromptBudget', 'soulBio', 'soulContent', 'soulInterests', 'soulStrengths', 'soulRelationGuidance', 'interests', 'strengths',
])
const EVOLVE_NAME_MAX = 20
const EVOLVE_LIST_MAX = 6
const EVOLVE_LIST_ITEM_MAX = 12

function stringListOf(value, field) {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} 需要字符串数组` }
  const items = []
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false, reason: `${field} 需要字符串数组` }
    const text = raw.trim()
    if (codepointLength(text) > EVOLVE_LIST_ITEM_MAX) {
      return { ok: false, reason: `${field} 每条最多 ${EVOLVE_LIST_ITEM_MAX} 字` }
    }
    if (!text) continue
    if (!items.includes(text)) items.push(text)
    if (items.length > EVOLVE_LIST_MAX) return { ok: false, reason: `${field} 最多 ${EVOLVE_LIST_MAX} 条` }
  }
  if (items.length === 0) return { ok: false, reason: `${field} 至少 1 条` }
  return { ok: true, items }
}

/**
 * 校验 soul_evolve 的 config 参数：只允许 7 个灵魂身份字段，长度/范围严格检查。
 * 返回 { ok:true, configPatch, identityPatch, changed } 或 { ok:false, reason }。
 * - soulName / soulUserNickname / soulEnabled / soulPromptBudget / soulBio / soulContent / soulInterests / soulStrengths / soulRelationGuidance → config.json
 * - interests / strengths → soul.identity（config.json 的 normalizeConfig 不认这两个字段）
 */
export function sanitizeSoulConfigPatch(raw) {
  if (raw === undefined || raw === null) return { ok: true, configPatch: {}, identityPatch: {}, changed: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'config 需要是对象' }
  const keys = Object.keys(raw)
  const unknown = keys.filter((key) => !EVOLVE_CONFIG_FIELDS.includes(key))
  if (unknown.length > 0) {
    return { ok: false, reason: `config 不支持的字段：${unknown.join('、')}（可用：${EVOLVE_CONFIG_FIELDS.join('、')}）` }
  }
  const configPatch = {}
  const identityPatch = {}
  const changed = []
  for (const key of keys) {
    const value = raw[key]
    if (value === undefined) continue
    if (key === 'soulName') {
      if (typeof value !== 'string') return { ok: false, reason: 'soulName 需要字符串' }
      const name = value.trim()
      if (!name || codepointLength(name) > EVOLVE_NAME_MAX) {
        return { ok: false, reason: `soulName 需要 1~${EVOLVE_NAME_MAX} 字` }
      }
      configPatch[key] = name
    } else if (key === 'soulUserNickname') {
      if (typeof value !== 'string') return { ok: false, reason: 'soulUserNickname 需要字符串' }
      const nickname = value.trim()
      if (codepointLength(nickname) > EVOLVE_NAME_MAX) {
        return { ok: false, reason: `soulUserNickname 最多 ${EVOLVE_NAME_MAX} 字` }
      }
      configPatch[key] = nickname
    } else if (key === 'soulEnabled') {
      if (typeof value !== 'boolean') return { ok: false, reason: `${key} 需要布尔值` }
      configPatch[key] = value
    } else if (key === 'soulPromptBudget') {
      const budget = Number(value)
      if (!Number.isFinite(budget) || budget < 200 || budget > 4000) {
        return { ok: false, reason: 'soulPromptBudget 需要 200~4000 的数字' }
      }
      configPatch[key] = Math.round(budget)
    } else if (key === 'soulInterests' || key === 'soulStrengths' || key === 'soulRelationGuidance') {
      if (typeof value !== 'string') return { ok: false, reason: key + ' 需要字符串' }
      const limit = key === 'soulRelationGuidance' ? 500 : 200
      if (codepointLength(value) > limit) return { ok: false, reason: key + ' 最多 ' + limit + ' 字' }
      configPatch[key] = value
    } else if (key === 'soulBio' || key === 'soulContent') {
      if (typeof value !== 'string') return { ok: false, reason: key + ' 需要字符串' }
      const limit = key === 'soulBio' ? 500 : 4000
      if (codepointLength(value) > limit) return { ok: false, reason: key + ' 最多 ' + limit + ' 字' }
      configPatch[key] = value
    } else if (key === 'interests' || key === 'strengths') {
      const checked = stringListOf(value, key)
      if (!checked.ok) return checked
      identityPatch[key] = checked.items
    }
    changed.push(key)
  }
  return { ok: true, configPatch, identityPatch, changed }
}

/**
 * 校验 soul_evolve 的业务参数：JSON Schema 管类型/枚举，这里管长度、replace 存在性、config 白名单。
 * kind 未提供时返回 undefined（新增时由 addGrowth 回落 trait，替换时保留原 kind）。
 */
export function validateEvolveArgs(args = {}) {
  const src = asObject(args)
  const text = asString(src.text, '').replace(/\s+/g, ' ').trim()
  if (!text) return { ok: false, reason: '缺少 text：写一句你自己长出来的东西' }
  const textLength = codepointLength(text)
  if (textLength > GROWTH_TEXT_MAX) {
    return { ok: false, reason: `text 太长（${textLength} 字），最多 ${GROWTH_TEXT_MAX} 字` }
  }
  const kind = GROWTH_KINDS.includes(src.kind) ? src.kind : undefined
  if (src.kind !== undefined && !kind) {
    return { ok: false, reason: `kind 只能是 ${GROWTH_KINDS.join(' / ')}` }
  }
  if (src.pin !== undefined && typeof src.pin !== 'boolean') return { ok: false, reason: 'pin 需要布尔值' }
  const note = asString(src.note, '').replace(/\s+/g, ' ').trim()
  if (codepointLength(note) > GROWTH_NOTE_MAX) {
    return { ok: false, reason: `note 最多 ${GROWTH_NOTE_MAX} 字` }
  }
  const config = sanitizeSoulConfigPatch(src.config)
  if (!config.ok) return config
  return {
    ok: true,
    text: codepointSlice(text, GROWTH_TEXT_MAX),
    kind,
    note: codepointSlice(note, GROWTH_NOTE_MAX),
    pin: src.pin === true,
    replace: asString(src.replace, '').trim(),
    config,
  }
}

export { addGrowth, updateGrowth, deleteGrowth, listGrowth }

// ---------- 插件安装 ----------

export function installSoul(ctx, { state, log } = {}) {
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  const localDefaults = {
    soulEnabled: true,
    soulName: 'Aura',
    soulUserNickname: '',
    soulPromptBudget: 1020,
    emotionScope: 'qq',
    speakPauseHours: 24,
    relationStageThresholds: DEFAULT_THRESHOLDS,
  }
  const readConfig = () => {
    let raw = {}
    try {
      raw = typeof state?.readConfig === 'function' ? state.readConfig() : {}
    } catch {
      raw = {}
    }
    return { ...localDefaults, ...asObject(raw) }
  }
  const readJson = (name, fallback) => {
    try {
      return typeof state?.readJson === 'function' ? state.readJson(name, fallback) : fallback
    } catch {
      return fallback
    }
  }

  // ① 装载（soul.json v2；否则迁移旧 emotion.json/proactive.json）
  let loaded = readJson(FILE, null)
  let soul
  let migrated = false
  // 旧 soul.memory 只在这里保留一次，供 installMemory 迁移；落盘时会被 trimForDisk 删掉。
  let legacyMemory = loaded && typeof loaded === 'object' ? asObject(loaded.memory) : null
  if (loaded && typeof loaded === 'object') {
    if (loaded.v === SOUL_VERSION) {
      soul = normalizeSoul(loaded)
    } else if (loaded.v === 1) {
      soul = migrateSoulV1(loaded)
      migrated = true
    } else {
      // 无版本号但看起来像 soul（有 identity/relation）→ 当 v2 洗一遍
      soul = normalizeSoul(loaded)
      migrated = true
    }
  } else {
    const legacy = readJson('emotion.json', null)
    soul = migrateLegacyEmotion(legacy)
    legacyMemory = asObject(soul.memory)
    migrated = true
    const oldProactive = readJson('proactive.json', null)
    if (oldProactive && typeof oldProactive === 'object') {
      soul.speak.lastAt = asNumber(oldProactive.lastProactiveAt, 0)
      soul.speak.lastSessionId = asString(oldProactive.lastSessionId, '')
    }
    logger(`[soul] 首次启动：${legacy ? '已从 emotion.json 迁移' : '使用默认灵魂状态'}`)
  }

  // 旧 soul.memory 先留在内存里交给 installMemory 迁移；没有内容时保持空壳。
  soul.memory = hasMemoryData(legacyMemory) ? legacyMemory : emptyMemoryState()
  if (hasMemoryData(legacyMemory)) logger('[soul] 检测到旧 soul.memory，等待迁移到 memory.json')

  // ② 一次性日结 + 启动日志
  try {
    settleRelation(soul, readConfig())
  } catch (error) {
    logger('[soul] 启动结算失败:', error instanceof Error ? error.message : error)
  }
  logger(`[soul] restored: ${soul.relation.stage} score=${soul.relation.score.toFixed(1)} turns=${soul.relation.turns} legacyMemory=${hasMemoryData(legacyMemory) ? asArray(legacyMemory.events).length : 0}`)

  // ③ 落盘（防抖 + 卸载时 flush）
  // 写 soul.json 之前先尽力做一次版本快照：失败只 warn，绝不阻塞保存。
  // 自动保存节流到 5 分钟一次，避免每个回合都复制一份；reset 等用户级操作走 force。
  let saveTimer = null
  let closed = false
  let backupModule = null
  let backupLoading = false
  let lastBackupAt = 0
  const AUTO_BACKUP_INTERVAL_MS = 5 * 60 * 1000
  const loadBackupModule = () => {
    if (backupModule || backupLoading) return
    backupLoading = true
    import('./backup.js')
      .then((mod) => {
        backupModule = mod
      })
      .catch((error) => {
        logger('[soul] 备份模块加载失败（保存继续）:', error instanceof Error ? error.message : error)
      })
      .finally(() => {
        backupLoading = false
      })
  }
  const snapshotBeforeWrite = (reason, { force = false } = {}) => {
    loadBackupModule()
    if (!backupModule || typeof backupModule.snapshotSync !== 'function') return
    const now = Date.now()
    if (!force && now - lastBackupAt < AUTO_BACKUP_INTERVAL_MS) return
    lastBackupAt = now
    try {
      const result = backupModule.snapshotSync('soul', { reason })
      if (result && result.ok === false) {
        logger('[soul] 写盘前备份失败（保存继续）:', result.error || 'unknown')
      }
    } catch (error) {
      logger('[soul] 写盘前备份失败（保存继续）:', error instanceof Error ? error.message : error)
    }
  }

  const saveNow = (options = {}) => {
    if (closed) return
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const meta = options && typeof options === 'object' ? options : {}
    if (!meta.skipBackup) snapshotBeforeWrite(meta.reason || 'autosave', { force: !!meta.force })
    try {
      state?.writeJson?.(FILE, trimForDisk(soul))
    } catch (error) {
      logger('[soul] 写盘失败:', error instanceof Error ? error.message : error)
    }
  }

  /** 统一保存助手：先 await 一次快照，再落盘。以后 soul_evolve / HTTP 保存都走它。 */
  const saveWithBackup = async (reason = 'save') => {
    try {
      const mod = backupModule || (await import('./backup.js'))
      backupModule = mod
      const result = await mod.snapshot('soul', { reason: String(reason || 'save') })
      if (result && result.ok === false) {
        logger('[soul] 保存前备份失败（保存继续）:', result.error || 'unknown')
      }
      lastBackupAt = Date.now()
    } catch (error) {
      logger('[soul] 保存前备份失败（保存继续）:', error instanceof Error ? error.message : error)
    }
    saveNow({ reason, skipBackup: true, force: true })
    return { ok: true }
  }
  const saveSoon = () => {
    if (closed || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, 800)
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
  }
  if (migrated) saveNow()

  /**
   * 成长写入入口（内部 / 每日反思用）：备份快照 → addGrowth → 立即落盘。
   * 备份失败只 warn，不阻塞写入；返回 {ok, growth, deduped, total, backupId}。
   */
  async function grow(input = {}) {
    const src = asObject(input)
    const text = codepointSlice(asString(src.text, '').replace(/\s+/g, ' ').trim(), GROWTH_TEXT_MAX)
    if (!text) return { ok: false, reason: 'text 不能为空' }
    const kind = GROWTH_KINDS.includes(src.kind) ? src.kind : 'trait'
    const note = codepointSlice(asString(src.note, '').replace(/\s+/g, ' ').trim(), GROWTH_NOTE_MAX)
    const source = GROWTH_SOURCES.includes(src.source) ? src.source : 'reflection'

    let backupId = ''
    try {
      const mod = backupModule || (await import('./backup.js'))
      backupModule = mod
      const result = await mod.snapshot('soul-reflection', { reason: 'soul-reflection: ' + codepointSlice(text, 60) })
      if (result && result.ok === false) {
        logger('[soul] 成长反思备份失败（继续写）:', result.error || 'unknown')
      } else if (result && result.id) {
        backupId = result.id
        lastBackupAt = Date.now()
      }
    } catch (error) {
      logger('[soul] 成长反思备份失败（继续写）:', error instanceof Error ? error.message : error)
    }

    const mutation = addGrowth(soul.growth, { text, kind, note, source }, Date.now())
    if (!mutation.ok) return { ok: false, reason: mutation.reason }
    soul.growth = mutation.entries
    saveNow({ reason: 'soul-reflection', skipBackup: true, force: true })
    return {
      ok: true,
      growth: { ...mutation.growth },
      deduped: mutation.deduped === true,
      total: soul.growth.length,
      ...(backupId ? { backupId } : {}),
    }
  }

  // ④ 事件监听（soul 自己是唯一观察 session/event 的地方）
  const listeners = { user: new Set(), assistant: new Set(), turnEnd: new Set(), stage: new Set(), explain: new Set() }
  const on = (kind, fn) => {
    const set = listeners[kind]
    if (!set || typeof fn !== 'function') return () => {}
    set.add(fn)
    return () => set.delete(fn)
  }
  const emit = (kind, payload) => {
    const set = listeners[kind]
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch (error) {
        logger(`[soul] listener(${kind}) 失败:`, error instanceof Error ? error.message : error)
      }
    }
  }

  // ④.5 每日成长反思：turnEnd 后节流排队；install 5s 后先试一次（都不 await，不挡聊天）
  const REFLECT_TRY_INTERVAL_MS = 10 * 60 * 1000
  let growthReflection = null
  let lastReflectTryAt = 0
  function tryReflect(force = false) {
    if (!growthReflection) return
    const now = Date.now()
    if (!force && now - lastReflectTryAt < REFLECT_TRY_INTERVAL_MS) return
    lastReflectTryAt = now
    try {
      growthReflection.schedule(0, { force })
    } catch (error) {
      logger('[soul] 成长反思排队失败:', error instanceof Error ? error.message : error)
    }
  }
  try {
    growthReflection = createGrowthReflection({
      ctx,
      state,
      soul: { get: () => soul, grow, saveSoon, saveNow },
      log: logger,
    })
    growthReflection.schedule(5000, { force: false })
  } catch (error) {
    logger('[soul] 成长反思初始化失败:', error instanceof Error ? error.message : error)
    growthReflection = null
  }

  function explain(entry) {
    if (!entry || typeof entry !== 'object') return
    try {
      soul.explainLog.push({ at: asNumber(entry.at, Date.now()), ...entry })
      if (soul.explainLog.length > EXPLAIN_LIMIT) soul.explainLog.splice(0, soul.explainLog.length - EXPLAIN_LIMIT)
      emit('explain', soul.explainLog[soul.explainLog.length - 1])
    } catch (error) {
      logger('[soul] explain 写入失败:', error instanceof Error ? error.message : error)
    }
  }

  function onUserMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      const now = asNumber(payload.at, Date.now())
      const config = readConfig()
      settleRelation(soul, config, now)
      soul.relation.lastUserAt = now
      soul.relation.idlePenaltyApplied = 0
      soul.relation.turns = Math.max(0, asNumber(soul.relation.turns, 0)) + 1
      soul.relation.lastUserText = codepointSlice(text, 500)
      soul.emotion.drive.energy = clamp(asNumber(soul.emotion.drive.energy, 0.7) + 0.02, 0, 1)
      soul.emotion.drive.socialNeed = clamp(asNumber(soul.emotion.drive.socialNeed, 0.35) - 0.15, 0, 1)
      soul.emotion.drive.updatedAt = now
      soul.speak.unanswered = 0
      soul.speak.platformRejects = 0
      if (isPauseRequest(text)) {
        const hours = clamp(asNumber(config.speakPauseHours, 24), 1, 24 * 14)
        soul.speak.pausedUntil = now + hours * 3_600_000
        logger(`[soul] 用户请求安静：主动暂停 ${hours} 小时`)
      } else if (isResumeRequest(text)) {
        soul.speak.pausedUntil = 0
        soul.speak.suppressUntil = 0
      } else if (isCloser(text)) {
        soul.speak.suppressUntil = Math.max(asNumber(soul.speak.suppressUntil, 0), now + 12 * 3_600_000)
      }
      const delta = userMessageScore(text)
      const stageChange = addRelationScore(soul, delta, config, now)
      if (stageChange.changed) {
        logger(`[soul] 关系阶段 ${stageChange.from} → ${stageChange.to}`)
        emit('stage', { ...stageChange, at: now })
        explain({ at: now, kind: 'relation', from: stageChange.from, to: stageChange.to, direction: stageChange.direction })
      }
      emit('user', { ...payload, text, at: now, soul })
      saveSoon()
    } catch (error) {
      logger('[soul] onUserMessage 失败:', error instanceof Error ? error.message : error)
    }
  }

  function onAssistantMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      const now = asNumber(payload.at, Date.now())
      soul.relation.lastAssistantAt = now
      soul.relation.lastAssistantText = codepointSlice(text, 500)
      if (soul.relation.stageNotice) soul.relation.stageNotice = null
      emit('assistant', { ...payload, text, at: now, soul })
      saveSoon()
    } catch (error) {
      logger('[soul] onAssistantMessage 失败:', error instanceof Error ? error.message : error)
    }
  }

  function onTurnEnd(payload = {}) {
    try {
      emit('turnEnd', { ...payload, at: asNumber(payload.at, Date.now()), soul })
      tryReflect(false)
    } catch (error) {
      logger('[soul] onTurnEnd 失败:', error instanceof Error ? error.message : error)
    }
  }

  function handleSessionEvent(session, event) {
    try {
      if (!event || typeof event.type !== 'string') return
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (!sessionId) return
      const config = readConfig()
      if (!isSoulSession(config, sessionId)) return
      const at = asNumber(event.time, Date.now())

      if (event.type === 'user/message') {
        const message = asObject(event.data)
        if (message.source?.kind !== 'user') return
        const text = textOfContent(message.content)
        if (!text) return
        if (text.startsWith('<') || text.startsWith('Current ')) return
        onUserMessage({ sessionId, text, at })
        return
      }

      if (event.type === 'assistant/message') {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
        const data = asObject(event.data)
        const content = data.message?.content
        if (hasToolCall(content)) return
        const text = textOfContent(content)
        if (!text) return
        onAssistantMessage({ sessionId, text, at, turn: data.turn, step: data.step })
        return
      }

      if (event.type === 'turn/end') {
        onTurnEnd({ sessionId, at, turn: event.data?.turn, reason: event.data?.reason })
      }
    } catch (error) {
      logger('[soul] session/event 处理失败:', error instanceof Error ? error.message : error)
    }
  }

  // ⑤ 注册 session/event 观察（global：QQ 会话由 bridge 的 agents.create 建出来，作用域外也要收到）
  try {
    const dispose = ctx.on('session/event', handleSessionEvent, { global: true })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try {
          dispose?.()
        } catch {
          /* noop */
        }
        try {
          growthReflection?.dispose?.()
        } catch {
          /* noop */
        }
        closed = true
        saveNow()
      }, 'aura-soul: session/event + flush')
    } else if (typeof dispose === 'function') {
      // 没有 effect 的旧宿主：至少保证进程退出前 flush 一次
      process.once?.('beforeExit', saveNow)
    }
  } catch (error) {
    logger('[soul] session/event 注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑥ 注入段：身份（section，静态段）+ 临场（context）
  try {
    ctx.systemPrompt?.section?.({
      name: 'aura:soul-identity',
      order: 20,
      interpolate: false,
      text: () => {
        try {
          return renderIdentitySection(soul, readConfig())
        } catch (error) {
          logger('[soul] identity section 渲染失败:', error instanceof Error ? error.message : error)
          return ''
        }
      },
    })
  } catch (error) {
    logger('[soul] identity section 注册失败:', error instanceof Error ? error.message : error)
  }
  try {
    ctx.systemPrompt?.context?.({
      name: 'aura:presence',
      order: 50,
      text: () => {
        try {
          return renderPresenceContext(soul, readConfig())
        } catch (error) {
          logger('[soul] presence context 渲染失败:', error instanceof Error ? error.message : error)
          return ''
        }
      },
    })
  } catch (error) {
    logger('[soul] presence context 注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑦ 成长工具 soul_evolve：写入前快照 → 改 growth（可选 config）→ 立即落盘
  async function evolveSoul(args = {}) {
    const checked = validateEvolveArgs(args)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    if (checked.replace && !soul.growth.some((item) => item && item.id === checked.replace)) {
      return { ok: false, reason: 'replace 指向的成长记录不存在（先看现有 growth 列表）' }
    }
    const configKeys = Object.keys(checked.config.configPatch)
    if (configKeys.length > 0 && typeof state?.writeConfig !== 'function') {
      return { ok: false, reason: '当前宿主没有 config 写入能力' }
    }

    // 写入前快照；失败只 warn，继续写（备份不是写盘的前置条件）。
    let backupId = ''
    const reason = 'soul-evolve: ' + codepointSlice(checked.text, 60)
    try {
      const mod = await import('./backup.js')
      const result = await mod.snapshot('soul-evolve', { reason })
      if (result && result.ok === false) {
        logger('[soul] soul_evolve 备份失败（继续写）:', result.error || 'unknown')
      } else if (result && result.id) {
        backupId = result.id
      }
    } catch (error) {
      logger('[soul] soul_evolve 备份失败（继续写）:', error instanceof Error ? error.message : error)
    }

    const now = Date.now()
    const previousGrowth = soul.growth
    const mutation = checked.replace
      ? updateGrowth(soul.growth, checked.replace, {
        text: checked.text,
        kind: checked.kind,
        note: checked.note || undefined,
        pinned: args?.pin === undefined ? undefined : checked.pin,
      }, now)
      : addGrowth(soul.growth, {
        text: checked.text,
        kind: checked.kind,
        note: checked.note,
        pinned: checked.pin,
        source: 'self',
      }, now)
    if (!mutation.ok) return { ok: false, reason: mutation.reason }
    soul.growth = mutation.entries

    if (configKeys.length > 0) {
      try {
        state.writeConfig(checked.config.configPatch)
      } catch (error) {
        soul.growth = previousGrowth
        logger('[soul] soul_evolve 写 config 失败:', error instanceof Error ? error.message : error)
        return { ok: false, reason: 'config 写入失败，成长未保存' }
      }
    }
    // interests/strengths 的权威位置是 soul.identity（config.json 只存 5 个扁平字段）。
    if (checked.config.identityPatch.interests) soul.identity.interests = checked.config.identityPatch.interests.slice()
    if (checked.config.identityPatch.strengths) soul.identity.strengths = checked.config.identityPatch.strengths.slice()

    saveNow({ reason: 'soul-evolve', skipBackup: true, force: true })
    return {
      ok: true,
      growth: { ...mutation.growth },
      configChanged: checked.config.changed.slice(),
      ...(backupId ? { backupId } : {}),
      deduped: mutation.deduped === true,
      total: soul.growth.length,
    }
  }

  try {
    const handle = ctx.tools?.register?.(defineTool({
      name: 'soul_evolve',
      description: '记录你自己长出来的一部分：新的自我认识、兴趣、习惯，或你和对方之间的默契'
        + '（kind: trait / interest / habit / bond / self）。'
        + '只在某次对话真的让“你”改变了一点时才用；不要每轮写，一次对话最多 1~2 条。'
        + '不要写短期记忆、对方的隐私或一次性琐事（那些用 soul_note）。'
        + '注意：写入会改变 system prompt（模型缓存失效一次），所以克制；同 kind + 同文会自动去重。'
        + 'config 可直接改灵魂身份字段（soulName / soulUserNickname / soulEnabled / soulPromptBudget 200~4000 / '
        + 'soulBio / soulContent / interests / strengths）。',
      parameters: {
        text: { type: 'string', description: '必填：一句成长（≤120 字），用第一人称写“我…”', required: true },
        kind: {
          type: 'string',
          enum: [...GROWTH_KINDS],
          description: 'trait=性格/自我认识，interest=兴趣，habit=习惯，bond=和对方的默契，self=对自己的新看法；默认 trait',
        },
        note: { type: 'string', description: '可选：为什么/从哪来（≤200 字），不会进身份段' },
        pin: { type: 'boolean', description: '可选：pinned 的条目不会被 40 条上限裁掉，并且优先出现在身份段' },
        replace: { type: 'string', description: '可选：替换某条成长（填 growth id）；不填就是新增' },
        config: {
          type: 'object',
          description: '可选：同时修改灵魂身份配置；只允许白名单字段，非法值会被拒绝',
          additionalProperties: false,
          properties: {
            soulName: { type: 'string', description: '灵魂名字（≤20 字）' },
            soulUserNickname: { type: 'string', description: '对用户的昵称（≤20 字，可留空）' },
            soulEnabled: { type: 'boolean', description: '灵魂段总开关' },
            soulBio: { type: 'string', description: '关于对方的补充说明（≤500 字）' },
            soulContent: { type: 'string', description: '灵魂全文（≤4000 字）；可整段重写，{{name}}/{{nickname}} 等占位符会被插值' },
            soulInterests: { type: 'string', description: '喜欢的事，顿号/逗号分隔（替换 {{interests}}，≤200 字）' },
            soulStrengths: { type: 'string', description: '擅长的事，顿号/逗号分隔（替换 {{strengths}}，≤200 字）' },
            soulRelationGuidance: { type: 'string', description: '关系表达覆盖文本（替换 {{relationGuidance}}，留空自动，≤500 字）' },
            soulPromptBudget: { type: 'number', description: '身份段预算 200~4000' },
            interests: { type: 'array', items: { type: 'string' }, description: '喜欢的事（1~6 条，每条 ≤12 字）' },
            strengths: { type: 'array', items: { type: 'string' }, description: '擅长的事（1~6 条，每条 ≤12 字）' },
          },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok === true
            ? `长出来一点：${value.growth?.kind ?? 'trait'} · ${value.growth?.text ?? ''}`
            : `没写成：${String(value?.reason ?? '')}`,
        }],
      },
      async execute(args = {}) {
        return evolveSoul(args)
      },
    }))
    const disposeTool = typeof handle === 'function'
      ? handle
      : handle && typeof handle.dispose === 'function'
        ? () => handle.dispose()
        : null
    if (disposeTool && typeof ctx.effect === 'function') {
      ctx.effect(() => disposeTool, 'aura-soul: soul_evolve tool')
    }
  } catch (error) {
    logger('[soul] soul_evolve 工具注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑧ 备份 API：懒加载避免循环依赖；注册/dispose 都挂在宿主 effect 上。
  // 这里只给 initBackup 一个最小的 ctx 视图（它只需要 ctx.get('webServer')），
  // 避免在异步 import 回调里再调用 ctx.effect。
  let backupApi = null
  let backupClosed = false
  const disposeBackup = () => {
    backupClosed = true
    try {
      backupApi?.dispose?.()
    } catch (error) {
      logger('[soul] 备份 API 卸载失败:', error instanceof Error ? error.message : error)
    }
    backupApi = null
  }
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposeBackup, 'aura-soul: backup api')
    }
    import('./backup.js')
      .then((mod) => {
        if (backupClosed) return
        const backupCtx = {
          get(name) {
            try {
              const found = typeof ctx.get === 'function' ? ctx.get(name) : undefined
              if (found) return found
              return name === 'webServer' ? ctx.webServer : undefined
            } catch {
              return undefined
            }
          },
        }
        backupApi = mod.initBackup({ ctx: backupCtx, state, log: logger })
      })
      .catch((error) => {
        logger('[soul] 备份模块加载失败:', error instanceof Error ? error.message : error)
      })
  } catch (error) {
    logger('[soul] 备份 API 注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑨ 对面板/其他模块的 API
  function snapshot() {
    try {
      const config = readConfig()
      const thresholds = thresholdsOf(config)
      const now = Date.now()
      const stage = STAGES.includes(soul.relation.stage) ? soul.relation.stage : 'stranger'
      const nextStage = stageIndex(stage) < STAGES.length - 1 ? STAGES[stageIndex(stage) + 1] : ''
      return {
        identity: {
          name: asString(config.soulName, '').slice(0, 20) || soul.identity.name,
          narrative: soul.identity.narrative,
          interests: soul.identity.interests.slice(),
          strengths: soul.identity.strengths.slice(),
          traits: { ...soul.identity.traits },
          address: { ...soul.identity.address },
          createdAt: soul.identity.createdAt,
        },
        relation: {
          stage,
          stageLabel: stageLabel(stage),
          score: Math.round(soul.relation.score * 10) / 10,
          days: Math.max(1, Math.ceil((now - asNumber(soul.relation.firstMetAt, now)) / 86_400_000)),
          nextAt: nextStage ? thresholds[nextStage] : null,
          nextStage: nextStage || null,
          turns: soul.relation.turns,
          lastUserAt: soul.relation.lastUserAt,
          milestones: soul.relation.milestones.slice(-5),
        },
        emotion: {
          // 兜底块：web.js 优先用 emotion.snapshot()（带 trend 等实时计算），
          // 这里保证 emotion 模块缺席时面板也有四维/基准/历史可渲染。
          label: soul.emotion.transient.label,
          valence: soul.emotion.transient.valence,
          arousal: soul.emotion.transient.arousal,
          affection: soul.emotion.affection,
          energy: soul.emotion.drive.energy,
          intensity: soul.emotion.transient.intensity,
          cause: soul.emotion.transient.cause,
          source: soul.emotion.source,
          updatedAt: soul.emotion.transient.updatedAt,
          baseline: { ...soul.emotion.baseline },
          trend: null,
          history: asArray(soul.emotion.history).slice(-40).map((row) => ({ ...row })),
          lastChange: (() => {
            const last = asArray(soul.emotion.history).slice(-1)[0]
            return last
              ? {
                  at: asNumber(last.at, 0),
                  label: asString(last.label, ''),
                  cause: asString(last.cause, ''),
                  weight: asNumber(last.weight, 1),
                }
              : { at: 0, label: '', cause: '', weight: 0 }
          })(),
        },
        speak: {
          lastAt: soul.speak.lastAt,
          lastSessionId: soul.speak.lastSessionId,
          todayCount: soul.speak.todayCount,
          dayKey: soul.speak.dayKey,
          missStreak: soul.speak.missStreak,
          unanswered: soul.speak.unanswered,
          platformRejects: soul.speak.platformRejects,
          suppressUntil: soul.speak.suppressUntil,
          pausedUntil: soul.speak.pausedUntil,
        },
        explainLog: soul.explainLog.slice(-30),
        growth: listGrowth(soul.growth),
        meta: { ...soul.meta, updatedAt: soul.meta.updatedAt },
      }
    } catch (error) {
      logger('[soul] snapshot 失败:', error instanceof Error ? error.message : error)
      return {}
    }
  }

  function reset(scope = 'all') {
    try {
      if (scope === 'emotion') {
        const d = defaultsSoul()
        soul.emotion = d.emotion
        saveNow({ reason: 'reset', force: true })
        return { ok: true, scope }
      }
      const d = defaultsSoul()
      // 保留：认识时间、身份自述、关系（"重置灵魂"只清情绪与主动状态；记忆在 memory.json 单独保留）
      const keep = {
        v: SOUL_VERSION,
        identity: soul.identity,
        relation: soul.relation,
        growth: soul.growth,
        meta: { ...d.meta, lastSettleDay: soul.meta?.lastSettleDay || '' },
      }
      Object.assign(soul, d, keep)
      saveNow({ reason: 'reset', force: true })
      logger('[soul] 已重置情绪与主动状态（保留关系；记忆在 memory.json 单独保留）')
      return { ok: true, scope }
    } catch (error) {
      logger('[soul] reset 失败:', error instanceof Error ? error.message : error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    version: SOUL_VERSION,
    file: FILE,
    get: () => soul,
    snapshot,
    saveNow,
    saveSoon,
    saveWithBackup,
    grow,
    growthReflection: {
      dispose: () => growthReflection?.dispose?.(),
      disposition: () => growthReflection?.disposition?.() ?? null,
      lastState: () => growthReflection?.lastState?.() ?? null,
      reflect: (options) => growthReflection?.maybeReflect?.(options) ?? Promise.resolve({ ok: false, reason: 'disabled' }),
    },
    listGrowth: (options) => listGrowth(soul.growth, options),
    evolve: evolveSoul,
    explain,
    on,
    onUserMessage,
    onAssistantMessage,
    onTurnEnd,
    renderIdentitySection: (now) => renderIdentitySection(soul, readConfig(), now),
    renderPresenceContext: (now) => renderPresenceContext(soul, readConfig(), now),
    settlement: (now) => settleRelation(soul, readConfig(), now),
    addRelationScore: (delta, now) => addRelationScore(soul, readConfig(), delta, now),
    relation: () => ({
      stage: soul.relation.stage,
      label: stageLabel(soul.relation.stage),
      score: soul.relation.score,
      thresholds: thresholdsOf(readConfig()),
    }),
    reset,
  }
}
