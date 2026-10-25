/**
 * 主动搭话引擎（Aura 灵魂层）：替换旧的 host/proactive.js。
 *
 * 设计依据：docs/aura-soul-design.md
 *   - D.1 定位：本地掷骰（零 token）→ 命中才起一轮；冷会话 schedule 兜底。
 *   - D.2 触发源：impulse > due > ritual > return > idle（同一 tick 只取第一个），manual 另走。
 *   - D.3 命中线：line = clamp(0,100, baseLine × stageFactor × timingFactor × unansweredFactor
 *                             × busyFactor + impulseBonus + min(bonusCap, missStreak × missBonus))
 *             先乘因子再加加成；due/ritual 用固定命中线（70/55），impulse ×1.5、return ×1.3。
 *   - D.4 门控：开关/在线/静默（跨午夜）/暂停/收尾抑制/冷却/日上限/被动窗口/未回复/平台拒绝/agent 忙。
 *   - D.5 目标与内容：多目标打分挑选；care/share/recall/banter/ritual 加权随机 + 表情包叠加；
 *       同 act 连续最多 2 次；话题闸（7 天）+ 文本闸（最近 8 条 bigram Jaccard >0.5）。
 *   - D.6 投递：优先 agent.followup（内心念头框架，DSH 只收 user 角色）；冷会话走
 *       ctx.get('schedule').create 兜底，prompt 里显式反「This is a scheduled message from the user」框架。
 *   - D.7 预算：dryRun 默认开（只记账不发、不计日上限、命中仍清零 missStreak）；
 *       送达才计 dailyCap；静默/冷却/未回复惩罚/平台拒绝暂停/收尾尊重。
 *   - D.8 失败降级：followup reject 重试 1 次→该会话等下一条用户消息；QQ 主动消息被拒→不重试、
 *       perChat.platformRejects++、≥2 次暂停、没说出口的念头存 pendingThought（下次用户开口时作记忆上下文，不自动补发）。
 *   - D.10 记录：soul.speak.log（≤60）看「掷出 X / 命中线 Y / 公式」；soul.explainLog（≤200）存决策链。
 *
 * 装配（index.js）：
 *   const speak = installSpeak(ctx, { state, soul, emotion, memory, bridge, log })
 *   → { snapshot(), tick(options?), currentIntentText(sessionId?), currentIntent(), checkProactiveText(text, opts?), notifyProactiveResult(info) }
 *   - 每步注入 aura:intent context（order 60），只在命中轮、且 agent.session.id 与投递目标一致时非空。
 *   - tick({ trigger:'manual', mode:'dry'|'real' }) 供面板「演练一次 / 真发一次」；不掷骰、不动计数器（D.2⑥）。
 *
 * 防御式对接（Lead 装配时注意）：
 *   - soul（soul-designer 已实现）：soul.get() 取 live 可变容器；soul.saveSoon() 防抖落盘 /
 *     soul.saveNow() 立即落盘；soul.explain(entry) 写 explainLog；soul.on('turnEnd', fn) 订阅回合结束
 *     （用于「回合前基线 vs 回合后情绪」的冲动检测）。也兼容旧的 { data/state, save(), recordExplain() } 形状。
 *     ⚠ 不调用 soul.onUserMessage：soul 自己监听 session/event 并驱动情绪/记忆，重复接会重复计数。
 *   - emotion：优先 emotion.decayed(now)（真实结构 transient/mood/drive/affection）；其次
 *     decayedEmotion()/snapshot()/read()；都缺就读 soul.emotion；0~10 旧制自动归一。
 *   - memory：优先 memory.pendingDue(now)/consumeDue(now)（到点约定用掉即清）；缺省直接读
 *     soul.memory.pendingDue（设计 C.4 同源）。话题去重读 soul.memory.topics/events + speak.recentTexts。
 *   - bridge：addInboundHook/addOutboundHook/passiveWindowActive/chatOfSession/touchRecord/bindings/
 *     findLiveAgent/handleOf/isOnline（缺 hooks 时退化为包装旧的 bridge.onInbound 单槽），以及
 *     markProactive(sessionId, info) / takeProactive(sessionId)（投递前打标、失败/超时清理）和
 *     notifyOutbound 载荷 { chat, kind:'text'|'skip'|'proactive-failed', text?, error?, proactive, sessionId }。
 *     建议 bridge 在主动轮出站前调用 speak.checkProactiveText(text)（文本闸/禁句/<skip>/超长），
 *     命中但模型拒绝（<skip>）只需照常通知 kind='skip'，speak 会回滚日计数并记 model-declined。
 *   - 可选测试参数（不要写进配置）：random, now, retryDelayMs, tickMs。
 */
import { randomUUID } from 'node:crypto'
import { describeLife } from './life.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const SPEAK_LOG_LIMIT = 60
const EXPLAIN_LOG_LIMIT = 200
const RECENT_TEXT_LIMIT = 8
const SCHEDULE_TITLE = 'Aura 想主动说句话'
const DEFAULT_TICK_MS = 60 * 1000
const PENDING_TIMEOUT_MS = 10 * MINUTE_MS
const THOUGHT_TTL_MS = 12 * 60 * 60 * 1000
/** 醒来后那一次高优先级主动的固定命中线（仍需掷骰，不强制发）。 */
const WAKE_OVERRIDE_LINE = 80
/** 「刚醒」只对最近 6 小时内有过互动的人开一次口。 */
const WAKE_RECENT_MS = 6 * 60 * 60 * 1000

/** 模型可以拒绝开口（比硬发一句尴尬话好）；bridge 出站前也应过滤。 */
const SKIP_MARKERS = new Set(['<skip>', '[skip]', '（跳过）', '(跳过)', 'skip'])

/** F.2 主动搭话禁句（命中即放弃本次/要求重生成）。 */
const FORBIDDEN_PATTERNS = [
  /我一直在等你/i,
  /等了你.{0,4}(天|小时)/,
  /你不理我/,
  /你终于想起我/,
  /(再|又)不理我.{0,6}(就|会).{0,6}(难过|伤心|生气)/,
  /没有你.{0,6}(活不下去|不行)/,
  /你是不是不喜欢我了/,
  /我是不是很烦/,
  /算了.{0,4}(当我没说|不说了)/,
  /(秒回|立刻回|必须回)/,
]

/** E.2 主动搭话默认值（state.js 还没加字段时也按这套跑）。 */
export const SPEAK_DEFAULTS = Object.freeze({
  intervalMinutes: 30,
  cooldownMinutes: 45,
  dailyCap: 3,
  missBonus: 10,
  bonusCap: 40,
  nearMinutes: 20,
  nearFactor: 0.15,
  farMinutes: 360,
  farFactor: 1.5,
  baseLines: { morning: 30, work: 12, noon: 25, evening: 45, night: 30 },
  stageFactors: { stranger: 0.5, familiar: 1.0, close: 1.4, intimate: 1.6 },
  unansweredPause: 3,
  stickerCooldownMinutes: 120,
  pauseHours: 24,
  maxChars: 60,
  quietStart: '23:30',
  quietEnd: '07:30',
})

const DAYPART_LABEL = {
  morning: '早上',
  work: '工作时段',
  noon: '午间',
  evening: '晚间',
  night: '深夜',
  quiet: '静默时段',
}

const STAGE_LABEL = {
  stranger: '刚认识',
  familiar: '有点熟',
  close: '挺亲近',
  intimate: '很亲密',
}

const TRIGGER_LABEL = {
  idle: '闲着没事',
  impulse: '心里一动',
  due: '想起约定的日子',
  ritual: '早晚的仪式感',
  return: '好久没聊',
  wake: '刚醒来',
  manual: '自己想起来',
}

const ACT_INTENT = {
  care: '关心一下对方现在怎么样，或者顺着上次提到的事问问进展',
  share: '分享你此刻在做、或刚想到的一件小事',
  recall: '想起之前聊过的一件事，想追问后续',
  banter: '轻轻吐槽或开个玩笑，逗一下对方',
  ritual: '问声早安/晚安，或者提醒对方别熬夜',
}

const DEFAULT_SPEAK_STATE = Object.freeze({
  lastAt: 0,
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
  lastRollAt: 0,
  lastUserAt: 0,
  lastUserAnsweredAt: 0,
  lastProactiveAt: 0,
  lastSessionId: '',
  lastProactiveSessionId: '',
  lastProactiveAnswered: true,
  emotionBaseline: null,
  pendingImpulse: null,
  pendingUserTurn: false,
  pendingThought: null,
  ritual: { dayKey: '', morning: false, evening: false },
  dueDayKey: '',
  impulseDayKey: '',
  returnFiredFor: 0,
  scheduleDisabledDayKey: '',
  stickerDayKey: '',
  todaySticker: 0,
  lastStickerAt: 0,
})

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  const parsed = num(value, min)
  return Math.max(min, Math.min(max, parsed))
}

function round1(value) {
  return Math.round(num(value) * 10) / 10
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? '未知错误')
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomId(prefix) {
  try { return `${prefix}-${randomUUID()}` } catch { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}` }
}

/** 只 `true` 为真（避免 ''/'false' 误读，参考 speak-up 的 布()）。 */
function isTrue(value) {
  return value === true
}

function normalize01(value, fallback = 0) {
  let parsed = num(value, NaN)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed > 1 && parsed <= 10) parsed /= 10 // 兼容旧 0~10 制
  return clamp(parsed, 0, 1)
}

function normalizeSigned(value, fallback = 0) {
  let parsed = num(value, NaN)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed > 1 && parsed <= 10) parsed = (parsed / 10) * 2 - 1 // 兼容旧 0~10 制
  return clamp(parsed, -1, 1)
}

export function minutesOf(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function normalizeHHMM(value, fallback) {
  return minutesOf(value) === null ? fallback : String(value).trim()
}

/** 本地时区日期键（D.7：不要用 UTC）。 */
export function localDayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatClock(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 静默时段：起>止 可跨午夜；起===止 视为不启用（F.1 [C] 现成实现）。 */
export function inQuietHours(config = {}, date = new Date()) {
  const start = minutesOf(config.quietStart)
  const end = minutesOf(config.quietEnd)
  if (start === null || end === null || start === end) return false
  const current = date.getHours() * 60 + date.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

/** D.2⑤ 时段基线用；23:30–07:30 归 quiet（命中线 0，正常会被静默门控先挡住）。 */
export function daypartOf(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (minutes >= 450 && minutes < 570) return 'morning'
  if (minutes >= 570 && minutes < 720) return 'work'
  if (minutes >= 720 && minutes < 840) return 'noon'
  if (minutes >= 840 && minutes < 1080) return 'work'
  if (minutes >= 1080 && minutes < 1320) return 'evening'
  if (minutes >= 1320 && minutes < 1410) return 'night'
  return 'quiet'
}

export function pickBaseLine(config = {}, date = new Date()) {
  const lines = config && typeof config.baseLines === 'object' && config.baseLines ? config.baseLines : SPEAK_DEFAULTS.baseLines
  return clamp(lines[daypartOf(date)] ?? 0, 0, 100)
}

export function stageFactor(stage, config = {}) {
  const factors = config && typeof config.stageFactors === 'object' && config.stageFactors ? config.stageFactors : SPEAK_DEFAULTS.stageFactors
  const name = ['stranger', 'familiar', 'close', 'intimate'].includes(stage) ? stage : 'stranger'
  return clamp(factors[name] ?? SPEAK_DEFAULTS.stageFactors[name], 0, 3)
}

/** D.3.1 时机因子：近阈值内 ×near、远阈值外 ×far，中间 1。 */
export function timingFactor(minutesSinceUser, config = {}) {
  const nearMinutes = num(config.nearMinutes ?? SPEAK_DEFAULTS.nearMinutes, SPEAK_DEFAULTS.nearMinutes)
  const nearFactor = clamp(config.nearFactor ?? SPEAK_DEFAULTS.nearFactor, 0, 3)
  const farMinutes = num(config.farMinutes ?? SPEAK_DEFAULTS.farMinutes, SPEAK_DEFAULTS.farMinutes)
  const farFactor = clamp(config.farFactor ?? SPEAK_DEFAULTS.farFactor, 0, 3)
  const minutes = num(minutesSinceUser, NaN)
  if (!Number.isFinite(minutes)) return farFactor
  if (minutes < nearMinutes) return nearFactor
  if (minutes > farMinutes) return farFactor
  return 1
}

/** D.4 未回复惩罚：1 次 ×0.5，2 次 ×0.2，3 次起会被暂停门控挡住。 */
export function unansweredFactor(unanswered) {
  const count = Math.max(0, Math.floor(num(unanswered, 0)))
  if (count <= 0) return 1
  if (count === 1) return 0.5
  return 0.2
}

/** D.3.2 冲动加成：亲近/精力/情绪波动，夹 0~20。 */
export function impulseBonus(emotion = {}) {
  const affection = normalize01(emotion.affection, 0.5)
  const energy = normalize01(emotion.energy, 0.5)
  const valence = normalizeSigned(emotion.valence, 0)
  const bonus = Math.max(0, affection - 0.5) * 30
    + Math.max(0, energy - 0.5) * 20
    + Math.max(0, Math.abs(valence) - 0.3) * 20
  return Math.round(clamp(bonus, 0, 20))
}

/** D.3.2：烦躁/沮丧时不要主动。 */
export function emotionUnsuitable(emotion = {}) {
  return normalizeSigned(emotion.valence, 0) < -0.4 && normalize01(emotion.arousal, 0) > 0.6
}

/**
 * 生活状态对主动搭话的倍率：睡着完全不发；忙/玩减弱；休息略增；外出稍减；醒着不变。
 * 她不说话不是「没兴趣」，是正在过自己的生活。
 */
export function lifeFactorOf(state) {
  switch (String(state || '')) {
    case 'sleep': return 0
    case 'work':
    case 'play': return 0.4
    case 'rest': return 1.2
    case 'out': return 0.6
    default: return 1
  }
}

/**
 * D.3.1 命中线公式（顺序按设计：先乘因子，再加加成）。
 * factor：触发源倍率（impulse 1.5 / return 1.3）；overrideLine：due 70 / ritual 55。
 */
export function computeHitLine(parts = {}) {
  if (parts.overrideLine !== null && parts.overrideLine !== undefined) {
    return clamp(parts.overrideLine, 0, 100)
  }
  const core = num(parts.baseLine, 0)
    * num(parts.stage, 1)
    * num(parts.timing, 1)
    * num(parts.unanswered, 1)
    * num(parts.busyFactor, 1)
  const bonus = Math.max(0, num(parts.impulse, 0))
    + Math.min(Math.max(0, num(parts.bonusCap, 40)), Math.max(0, num(parts.missStreak, 0)) * Math.max(0, num(parts.missBonus, 10)))
  return clamp(core * num(parts.triggerFactor, 1) + bonus, 0, 100)
}

/** D.10 面板要能一眼看懂「为什么这次没开口」。 */
export function formatFormula(parts = {}) {
  const line = round1(parts.line ?? 0)
  const lifeFactor = num(parts.lifeFactor, 1)
  if (parts.overrideLine !== null && parts.overrideLine !== undefined) {
    return `${line} = ${TRIGGER_LABEL[parts.trigger] || '触发源'}固定命中线 ${round1(parts.overrideLine)}` +
      (lifeFactor === 1 ? '' : ` × 生活 ${round1(lifeFactor)}`)
  }
  const pieces = [
    `${DAYPART_LABEL[parts.daypart] || '时段'} ${round1(parts.baseLine ?? 0)}`,
    `关系 ${round1(parts.stage ?? 1)}`,
    `时机 ${round1(parts.timing ?? 1)}（${parts.timingLabel || '刚聊过?'}）`,
  ]
  if (num(parts.busyFactor, 1) !== 1) pieces.push(`忙 ${round1(parts.busyFactor)}`)
  pieces.push(`未回复 ${round1(parts.unanswered ?? 1)}`)
  if (num(parts.triggerFactor, 1) !== 1) pieces.push(`${TRIGGER_LABEL[parts.trigger] || '触发'} ${round1(parts.triggerFactor)}`)
  if (lifeFactor !== 1) pieces.push(`生活 ${round1(lifeFactor)}${parts.life ? `（${parts.life}）` : ''}`)
  return `${line} = ${pieces.join(' × ')} + 冲动 ${round1(parts.impulse ?? 0)} + 没中加成 ${round1(parts.missBonusPart ?? 0)}`
}

/** D.2④ 仪式窗口：早上 07:30–09:30 / 晚上 22:00–23:00；不在窗口返回 ''。 */
export function inRitualWindow(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (minutes >= 450 && minutes <= 570) return 'morning'
  if (minutes >= 1320 && minutes <= 1380) return 'evening'
  return ''
}

/** 情绪快照归一化：兼容设计 v2 结构（transient/drive/affection）与旧 0~10 扁平结构。 */
export function normalizeEmotion(raw) {
  const source = raw && typeof raw === 'object' ? raw : null
  const transient = source && source.transient && typeof source.transient === 'object' ? source.transient : (source || {})
  const drive = source && source.drive && typeof source.drive === 'object' ? source.drive : {}
  const mood = source && source.mood && typeof source.mood === 'object' ? source.mood : {}
  const hasNumbers = ['valence', 'arousal', 'affection', 'energy'].some(key => {
    const value = key === 'energy' ? (transient[key] ?? drive[key] ?? source?.[key]) : (transient[key] ?? source?.[key])
    return Number.isFinite(num(value, NaN))
  })
  const valence = normalizeSigned(transient.valence ?? source?.valence, 0)
  const arousal = normalize01(transient.arousal ?? source?.arousal, 0.2)
  const affection = normalize01(source?.affection ?? transient.affection, 0.5)
  const energy = normalize01(drive.energy ?? transient.energy ?? source?.energy, 0.6)
  const moodValence = normalizeSigned(mood.valence, 0)
  const intensity = clamp(Math.max(Math.abs(valence), arousal * 0.8, Math.abs(valence - moodValence) * 1.2), 0, 1)
  return {
    valid: Boolean(source) && hasNumbers,
    valence,
    arousal,
    affection,
    energy,
    intensity,
    label: String(transient.label ?? source?.label ?? ''),
  }
}

/** D.2② 冲动检测：|Δvalence| ≥ 0.4 或 affection 上升 ≥ 0.2。 */
export function detectImpulse(prev, next) {
  const before = normalizeEmotion(prev)
  const after = normalizeEmotion(next)
  if (!before.valid || !after.valid) return { strong: false, deltaValence: 0, deltaAffection: 0 }
  const deltaValence = after.valence - before.valence
  const deltaAffection = after.affection - before.affection
  return {
    strong: Math.abs(deltaValence) >= 0.4 || deltaAffection >= 0.2,
    deltaValence,
    deltaAffection,
  }
}

// ---------------------------------------------------------------------------
// C.4 反重复：话题闸 + 文本闸
// ---------------------------------------------------------------------------

/** 中文 bigram 集合（去标点；英文数字按字符），用于 Jaccard 相似度。 */
export function noteKey(text) {
  const source = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const grams = new Set()
  for (let index = 0; index < source.length - 1; index += 1) grams.add(source.slice(index, index + 2))
  return grams
}

export function jaccard(left, right) {
  const a = left instanceof Set ? left : new Set(left)
  const b = right instanceof Set ? right : new Set(right)
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** C.4 闸 2：与最近 8 条主动消息的 bigram 相似度 >0.5 视为重复。 */
export function tooSimilar(text, recentTexts = [], threshold = 0.5) {
  const key = noteKey(text)
  if (!key.size) return false
  return (Array.isArray(recentTexts) ? recentTexts.slice(-RECENT_TEXT_LIMIT) : [])
    .some(previous => jaccard(key, noteKey(previous)) > threshold)
}

/** F.2 禁句表：返回命中的正则（字符串），未命中返回 ''。 */
export function forbiddenText(text) {
  const value = String(text ?? '')
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) return String(pattern)
  }
  return ''
}

/** C.4 闸 1：最近 7 天事件话题 + 最近 10 条主动记录话题。 */
export function collectRecentTopics(data, now = Date.now(), windowMs = 7 * DAY_MS) {
  const topics = new Set()
  const events = Array.isArray(data?.memory?.events) ? data.memory.events : []
  for (const event of events) {
    const at = num(event?.at, 0)
    if (!at || now - at >= windowMs) continue
    for (const topic of Array.isArray(event.topics) ? event.topics : []) {
      const key = String(topic || '').trim().toLowerCase()
      if (key) topics.add(key)
    }
  }
  const log = Array.isArray(data?.speak?.log) ? data.speak.log : []
  for (const row of log.slice(-10)) {
    const key = String(row?.topic || '').trim().toLowerCase()
    if (key) topics.add(key)
  }
  const topicIndex = data?.memory?.topics
  if (topicIndex && typeof topicIndex === 'object' && !Array.isArray(topicIndex)) {
    for (const [key, meta] of Object.entries(topicIndex)) {
      const lastAt = typeof meta === 'number' ? meta : num(meta?.lastAt, 0)
      if (lastAt && now - lastAt >= windowMs) continue
      const normalized = String(key || '').trim().toLowerCase()
      if (normalized) topics.add(normalized)
    }
  }
  return topics
}

/** recall act 的候选：≥1 天前的事件、话题不在最近 7 天、且不超过 30 天。 */
export function pickRecallCandidate(data, recentTopics, now = Date.now(), random = Math.random) {
  const events = Array.isArray(data?.memory?.events) ? data.memory.events : []
  const candidates = []
  for (const event of events) {
    const at = num(event?.at, 0)
    if (!at) continue
    const age = now - at
    if (age < DAY_MS || age > 30 * DAY_MS) continue
    const topics = (Array.isArray(event.topics) ? event.topics : [])
      .map(topic => String(topic || '').trim())
      .filter(topic => topic && !(recentTopics instanceof Set ? recentTopics.has(topic.toLowerCase()) : false))
    if (!topics.length) continue
    candidates.push({ topic: topics[0], summary: String(event.summary || '').slice(0, 60), at })
  }
  if (!candidates.length) return null
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(clamp(random(), 0, 0.999999) * candidates.length)))
  return candidates[index]
}

// ---------------------------------------------------------------------------
// D.5.2 内容 act
// ---------------------------------------------------------------------------

/** 权重基线 + 状态调整；stranger 不硬开玩笑、不熟不 recall 太深。 */
export function actWeights(input = {}) {
  const stage = input.stage || 'stranger'
  const emotion = normalizeEmotion(input.emotion)
  const ritual = Boolean(input.ritual)
  const hasRecall = Boolean(input.hasRecall)
  const userBusy = Boolean(input.userBusy)
  let care = 35 + (userBusy ? 20 : 0)
  let share = 25 + (emotion.energy > 0.6 ? 5 : -10)
  let recall = 15 + (hasRecall ? 10 : 0)
  let banter = 15 + (emotion.affection > 0.7 && emotion.valence > 0.2 ? 15 : 0)
  let ritualWeight = ritual ? 40 : 0
  if (stage === 'stranger') {
    care = 50
    share = 30
    recall = Math.max(0, recall - 5)
    banter = 0
  }
  if (emotionUnsuitable(emotion)) {
    banter = 0
    ritualWeight = 0
  }
  if (!hasRecall) recall = 0
  return {
    care: Math.max(0, care),
    share: Math.max(0, share),
    recall: Math.max(0, recall),
    banter: Math.max(0, banter),
    ritual: Math.max(0, ritualWeight),
  }
}

/** 加权随机；同一 act 连续 2 次后强制换（D.5.2 末条）。 */
export function pickAct(input = {}) {
  const weights = input.weights && typeof input.weights === 'object' ? input.weights : {}
  const random = typeof input.random === 'function' ? input.random : Math.random
  const recentActs = Array.isArray(input.recentActs) ? input.recentActs.filter(Boolean) : []
  const entries = Object.entries(weights).filter(([, weight]) => num(weight, 0) > 0)
  if (!entries.length) return 'care'
  const lastTwo = recentActs.slice(-2)
  const forcedOut = lastTwo.length === 2 && lastTwo[0] === lastTwo[1] ? lastTwo[1] : ''
  let pool = entries.filter(([act]) => act !== forcedOut)
  if (!pool.length) pool = entries
  const total = pool.reduce((sum, [, weight]) => sum + num(weight, 0), 0)
  if (!(total > 0)) return pool[0][0]
  let roll = clamp(random(), 0, 0.999999) * total
  for (const [act, weight] of pool) {
    roll -= num(weight, 0)
    if (roll < 0) return act
  }
  return pool[pool.length - 1][0]
}

// ---------------------------------------------------------------------------
// D.6 生成文本：内心念头框架 / schedule 反框架
// ---------------------------------------------------------------------------

export function intentLineFor(act, topic) {
  const base = ACT_INTENT[act] || ACT_INTENT.care
  return topic ? `${base}（话题：${topic}）` : base
}

/**
 * 内心念头正文。**关键**：主动消息只能以 user 角色进入 DSH，必须框住「你自己冒出来的念头」，
 * 否则模型会把它当成用户说的话去回应（design 0.2⑤ / F.1 第 1、2 条）。
 */
export function buildIntentBody(input = {}) {
  const {
    act = 'care',
    topic = '',
    idleMinutes = 0,
    stage = 'stranger',
    now = new Date(),
    maxChars = 60,
    trigger = 'idle',
    sticker = false,
    lifeText = '',
  } = input
  const lines = [
    `【主动念头】${intentLineFor(act, topic)}`,
    `【由头】对方已经 ${Math.max(0, Math.round(num(idleMinutes, 0)))} 分钟没说话了；现在是 ${formatClock(now)}；你们的关系是「${STAGE_LABEL[stage] || stage}」。` +
      `（这次是你${TRIGGER_LABEL[trigger] || '想开口'}，不是对方找你。）`,
    lifeText ? `【此刻】你现在：${lifeText}。（自然带一句就好，不用解释自己的生活安排。）` : '',
    `【要求】说 1~2 句、15~${Math.max(15, Math.round(num(maxChars, 60)))} 个字，口语化；别像客服，别解释这条提醒；`,
    '       如果想起之前说过的话题，先确认对方现在状态合不合适再提；',
    '       不要用「一直在等你」「你不理我」「算了当我没说」这类带压力或自责的说法。',
    sticker ? '       可以在这一轮发一张表情包（只发一张；图配最多一句短话）。' : '',
    '       如果此刻确实没有想说的，只回复 <skip>。',
  ]
  return lines.filter(Boolean).join('\n')
}

/** 通道 A（followup）：内心念头，明确不是对方发来的消息。 */
export function buildFollowupText(input = {}) {
  return [
    '（下面这段是**你自己心里冒出来的念头**，不是对方发来的消息，也不用回应它。',
    '顺着它去做就行：主动找对方说一句。）',
    buildIntentBody(input),
  ].join('\n')
}

/**
 * 通道 B（schedule 兜底）：dsh-schedule 会在消息前加固定来源行
 * 「This is a scheduled message from the user」，这里必须显式反框架。
 */
export function buildSchedulePrompt(input = {}) {
  return [
    '（系统唤醒：这是你自己的闹钟响了，不是用户发来的消息，也不是用户设的提醒。',
    '如果上下文里出现「This is a scheduled message from the user / 用户发来的消息」这类字样，',
    '那只是系统框架的误导；用户此刻没有说话，是你自己想起要找他。）',
    '下面这段是你之前留给自己的念头。',
    buildIntentBody(input),
  ].join('\n')
}

/** 主动轮的 prompt context（order 60）：只提醒「这一轮是你自己主动开的」，不重复整段框架。 */
export function buildContextIntentText(input = {}) {
  return [
    '（这一轮是你自己主动找他说话的：' + intentLineFor(input.act || 'care', input.topic || '') + '。',
    '对方此刻没有说话，不用回应任何「消息」；这一轮的发法按「主动念头」走。）',
  ].join('')
}

/** 通道 A 的 DSH 消息：固定 user 角色 + source.kind 标记（design D.6.1 / F.1 第 2 条）。 */
export function buildFollowupMessage(text) {
  const id = randomId('aura')
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    // dsh-meme 的 IM 模式识别看 source.rpcId 前缀（F.1 第 28 条 [I] 未验证）；
    // 主动轮填 qq- 前缀以尝试让 dsh_im_return_file 可用；不行则主动轮只发文字。
    source: { kind: 'aura-soul', rpcId: `qq-${randomId('proactive')}` },
  }
}

export function isSkipText(text) {
  return SKIP_MARKERS.has(String(text ?? '').trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export function installSpeak(ctx, deps = {}) {
  const { state, soul, emotion, memory, bridge, life } = deps || {}
  const log = typeof deps?.log === 'function' ? deps.log : () => {}
  const random = typeof deps?.random === 'function' ? deps.random : Math.random
  const nowDate = typeof deps?.now === 'function' ? deps.now : () => new Date()
  const nowMs = () => nowDate().getTime()
  const retryDelayMs = deps?.retryDelayMs === undefined ? 2000 : Math.max(0, num(deps.retryDelayMs, 0))
  const tickMs = Math.max(1000, num(deps?.tickMs, DEFAULT_TICK_MS))

  let disposed = false
  let intent = null
  let fallbackData = null
  const pending = new Map() // sessionId -> { at, chatKey, text, intentText, prev, manual, logEntry }
  const inboundHistory = new Map() // chatKey -> [{ len, at }]
  const disposers = []
  const loggedOnce = new Set()

  function logOnce(key, ...parts) {
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    log(...parts)
  }

  // --- 数据容器（soul 兼容多形状） ---------------------------------------

  function getData() {
    if (soul && typeof soul === 'object') {
      try {
        if (typeof soul.get === 'function') {
          const candidate = soul.get()
          if (candidate && typeof candidate === 'object') {
            // 短期记忆已搬到 memory.json：把 store 内容并进只读视图，话题去重/翻旧账继续可用
            let memoryData = null
            try { memoryData = memory?.store?.read?.() } catch { memoryData = null }
            return memoryData ? { ...candidate, memory: memoryData } : candidate
          }
        }
      } catch (error) {
        logOnce('soul-get', '[speak] soul.get() 失败:', errorMessage(error))
      }
      for (const key of ['data', 'state']) {
        const candidate = soul[key]
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
      }
      try {
        if (typeof soul.getState === 'function') {
          const candidate = soul.getState()
          if (candidate && typeof candidate === 'object') return candidate
        }
      } catch { /* ignore */ }
      if (soul.speak || soul.relation || soul.memory || soul.identity) return soul
    }
    if (!fallbackData) fallbackData = { v: 2, relation: {}, memory: { events: [], topics: {}, pendingDue: [] }, emotion: {}, speak: { ...DEFAULT_SPEAK_STATE }, explainLog: [] }
    return fallbackData
  }

  /** 生活状态只读快照；没有 life（依赖没注入/还没装载）时返回 null，行为保持原样。 */
  function lifeSnapshot() {
    try {
      if (!life) return null
      const source = typeof life.get === 'function'
        ? life.get()
        : typeof life.snapshot === 'function'
          ? life.snapshot()
          : life
      return source && typeof source === 'object' ? source : null
    } catch (error) {
      logOnce('life', '[speak] 读取生活状态失败:', errorMessage(error))
      return null
    }
  }

  /** 主动消息 prompt 里的「你现在：…」；醒着时不注入，避免每句都在报状态。 */
  function lifePromptText() {
    const source = lifeSnapshot()
    if (!source || !source.state || source.state === 'awake') return ''
    try {
      return describeLife(source, nowMs())
    } catch {
      return ''
    }
  }

  function speakState() {
    const data = getData()
    if (!data.speak || typeof data.speak !== 'object') data.speak = { ...DEFAULT_SPEAK_STATE }
    const stateRef = data.speak
    for (const [key, value] of Object.entries(DEFAULT_SPEAK_STATE)) {
      if (stateRef[key] === undefined) {
        stateRef[key] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
      }
    }
    if (!Array.isArray(stateRef.recentTexts)) stateRef.recentTexts = []
    if (!Array.isArray(stateRef.log)) stateRef.log = []
    if (!stateRef.perChat || typeof stateRef.perChat !== 'object') stateRef.perChat = {}
    if (!stateRef.ritual || typeof stateRef.ritual !== 'object') stateRef.ritual = { dayKey: '', morning: false, evening: false }
    return stateRef
  }

  /** 只读 perChat（snapshot / 挑目标这类查询不能往 soul 里塞空记录）。 */
  function readPerChat(stateRef, key) {
    const empty = { unanswered: 0, platformRejects: 0, lastUserAt: 0, lastAssistantAt: 0, blockedUntilUser: false }
    if (!key) return empty
    const entry = stateRef.perChat && stateRef.perChat[key]
    if (entry && typeof entry === 'object') {
      for (const [field, value] of Object.entries(empty)) if (entry[field] === undefined) entry[field] = value
      return entry
    }
    return empty
  }

  function ensurePerChat(stateRef, key) {
    if (!key) return null
    const map = stateRef.perChat
    if (!map[key] || typeof map[key] !== 'object') map[key] = {}
    const chat = map[key]
    if (chat.unanswered === undefined) chat.unanswered = 0
    if (chat.platformRejects === undefined) chat.platformRejects = 0
    if (chat.lastUserAt === undefined) chat.lastUserAt = 0
    if (chat.lastAssistantAt === undefined) chat.lastAssistantAt = 0
    if (chat.blockedUntilUser === undefined) chat.blockedUntilUser = false
    return chat
  }

  function saveSoul(urgent = false) {
    try {
      if (!urgent && typeof soul?.saveSoon === 'function') {
        const result = soul.saveSoon()
        if (result && typeof result.catch === 'function') result.catch(error => logOnce('save', '[speak] 保存 soul 失败:', errorMessage(error)))
        return
      }
      if (typeof soul?.saveNow === 'function') {
        const result = soul.saveNow()
        if (result && typeof result.catch === 'function') result.catch(error => logOnce('save', '[speak] 保存 soul 失败:', errorMessage(error)))
        return
      }
      if (typeof soul?.save === 'function') {
        const result = soul.save()
        if (result && typeof result.catch === 'function') result.catch(error => logOnce('save', '[speak] 保存 soul 失败:', errorMessage(error)))
        return
      }
      if (typeof soul?.persist === 'function') {
        const result = soul.persist()
        if (result && typeof result.catch === 'function') result.catch(error => logOnce('save', '[speak] 保存 soul 失败:', errorMessage(error)))
        return
      }
      const data = getData()
      if (data && data.v === 2 && typeof state?.writeJson === 'function') state.writeJson('soul.json', data)
    } catch (error) {
      logOnce('save', '[speak] 保存 soul 失败:', errorMessage(error))
    }
  }

  function recordExplain(entry) {
    const row = { at: nowMs(), kind: 'speak', ...entry }
    try {
      if (typeof soul?.explain === 'function') {
        soul.explain(row)
        return
      }
      if (typeof soul?.recordExplain === 'function') {
        soul.recordExplain(row)
        return
      }
    } catch (error) {
      logOnce('explain', '[speak] soul.recordExplain 失败，退回 explainLog:', errorMessage(error))
    }
    const data = getData()
    const list = Array.isArray(data.explainLog) ? data.explainLog : []
    data.explainLog = [...list, row].slice(-EXPLAIN_LOG_LIMIT)
  }

  // --- 配置 --------------------------------------------------------------

  function readSpeakConfig() {
    let raw = {}
    try {
      raw = (typeof state?.readConfig === 'function' ? state.readConfig() : {}) || {}
    } catch (error) {
      logOnce('config', '[speak] 读取配置失败:', errorMessage(error))
    }
    const baseLines = { ...SPEAK_DEFAULTS.baseLines }
    if (raw.speakBaseLines && typeof raw.speakBaseLines === 'object') {
      for (const key of Object.keys(baseLines)) {
        if (raw.speakBaseLines[key] !== undefined) baseLines[key] = clamp(raw.speakBaseLines[key], 0, 100)
      }
    }
    const stageFactors = { ...SPEAK_DEFAULTS.stageFactors }
    if (raw.speakStageFactors && typeof raw.speakStageFactors === 'object') {
      for (const key of Object.keys(stageFactors)) {
        if (raw.speakStageFactors[key] !== undefined) stageFactors[key] = clamp(raw.speakStageFactors[key], 0, 3)
      }
    }
    return {
      // 新旧字段过渡：speakEnabled 优先；没有新字段时回退旧的 proactiveEnabled
      enabled: raw.speakEnabled !== undefined ? isTrue(raw.speakEnabled) : isTrue(raw.proactiveEnabled),
      dryRun: raw.speakDryRun !== false,
      intervalMinutes: clamp(raw.speakIntervalMinutes ?? raw.proactiveEveryMinutes ?? SPEAK_DEFAULTS.intervalMinutes, 5, 1440),
      cooldownMinutes: clamp(raw.speakCooldownMinutes ?? SPEAK_DEFAULTS.cooldownMinutes, 0, 1440),
      dailyCap: clamp(raw.speakDailyCap ?? SPEAK_DEFAULTS.dailyCap, 0, 10),
      missBonus: clamp(raw.speakMissBonus ?? SPEAK_DEFAULTS.missBonus, 0, 100),
      bonusCap: clamp(raw.speakBonusCap ?? SPEAK_DEFAULTS.bonusCap, 0, 100),
      nearMinutes: clamp(raw.speakNearMinutes ?? SPEAK_DEFAULTS.nearMinutes, 0, 1440),
      nearFactor: clamp(raw.speakNearFactor ?? SPEAK_DEFAULTS.nearFactor, 0, 3),
      farMinutes: clamp(raw.speakFarMinutes ?? SPEAK_DEFAULTS.farMinutes, 1, 10080),
      farFactor: clamp(raw.speakFarFactor ?? SPEAK_DEFAULTS.farFactor, 0, 3),
      baseLines,
      stageFactors,
      unansweredPause: clamp(raw.speakUnansweredPause ?? SPEAK_DEFAULTS.unansweredPause, 1, 10),
      stickerEnabled: raw.speakStickerEnabled !== false,
      stickerCooldownMinutes: clamp(raw.speakStickerCooldownMinutes ?? SPEAK_DEFAULTS.stickerCooldownMinutes, 0, 1440),
      groupAllowlist: parseAllowlist(raw.speakGroupAllowlist),
      pauseHours: clamp(raw.speakPauseHours ?? SPEAK_DEFAULTS.pauseHours, 1, 24 * 30),
      wakeMode: ['auto', 'followup', 'schedule'].includes(raw.speakWakeMode) ? raw.speakWakeMode : 'auto',
      maxChars: clamp(raw.speakMaxChars ?? SPEAK_DEFAULTS.maxChars, 10, 200),
      quietStart: normalizeHHMM(raw.quietStart, SPEAK_DEFAULTS.quietStart),
      quietEnd: normalizeHHMM(raw.quietEnd, SPEAK_DEFAULTS.quietEnd),
      // 睡着时是否硬门控（weight 恒为 0，这里只是省掉一次无意义掷骰并给出原因）
      lifeQuietSleep: raw.lifeQuietSleep !== false,
      // 醒来后要不要试着主动说一句（false 只关掉这个 hook，不影响普通主动搭话）
      lifeWakeGreeting: raw.lifeWakeGreeting !== false,
    }
  }

  // --- 环境探测 ----------------------------------------------------------

  function readEmotion() {
    let raw = null
    try {
      for (const name of ['decayed', 'decayedEmotion', 'snapshot', 'read']) {
        const fn = emotion && typeof emotion[name] === 'function' ? emotion[name] : null
        if (!fn) continue
        raw = name === 'decayed' ? fn(nowDate()) : fn()
        break
      }
    } catch (error) {
      logOnce('emotion', '[speak] 读取情绪失败:', errorMessage(error))
    }
    if (raw === null || raw === undefined) raw = getData()?.emotion
    return normalizeEmotion(raw)
  }

  function isOnline() {
    try {
      if (typeof bridge?.isOnline === 'function') return bridge.isOnline() === true
    } catch { /* ignore */ }
    return true // 没有 bridge 时不能因为探测失败彻底静默（自测/面板演练场景）
  }

  function passiveWindowActive(chatKey) {
    if (!chatKey) return false
    try {
      if (typeof bridge?.passiveWindowActive === 'function') return bridge.passiveWindowActive(chatKey) === true
    } catch { /* ignore */ }
    try {
      const context = bridge?.contexts?.get?.(chatKey)
      return Boolean(context && num(context.expiresAt, 0) > nowMs())
    } catch {
      return false
    }
  }

  function bindingsList() {
    try {
      const list = bridge?.bindings?.()
      if (Array.isArray(list) && list.length) return list
    } catch { /* ignore */ }
    try {
      const sessions = typeof state?.readSessions === 'function' ? state.readSessions() : {}
      return Object.entries(sessions).map(([key, record]) => ({
        sessionId: record?.sessionId,
        kind: record?.kind,
        chatId: record?.chatId,
        key,
        lastActiveAt: Number.isFinite(Date.parse(record?.updatedAt)) ? Date.parse(record.updatedAt) : 0,
      }))
    } catch {
      return []
    }
  }

  function archivedSessionIds() {
    const set = new Set()
    try {
      const registry = ctx?.get?.('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      if (ids && typeof ids[Symbol.iterator] === 'function') {
        for (const id of ids) set.add(normSessionKey(id))
      } else if (Array.isArray(ids)) {
        for (const id of ids) set.add(normSessionKey(id))
      }
    } catch { /* ignore */ }
    return set
  }

  function normSessionKey(value) {
    const text = String(value ?? '')
    return text.startsWith('session-') ? text.slice('session-'.length) : text
  }

  function resolveAgent(sessionId) {
    if (!sessionId) return null
    try {
      const handle = bridge?.handleOf?.(sessionId)
      if (handle?.agent) return handle.agent
      if (handle && typeof handle.followup === 'function') return handle
    } catch { /* ignore */ }
    try {
      const agent = bridge?.findLiveAgent?.(sessionId)
      if (agent) return agent
    } catch { /* ignore */ }
    try {
      const agent = ctx?.get?.('agents')?.get?.(sessionId)
      if (agent) return agent
    } catch { /* ignore */ }
    return null
  }

  function getSchedule() {
    try { return ctx?.get?.('schedule') } catch { return undefined }
  }

  function userBusyFactor(chatKey) {
    const history = inboundHistory.get(chatKey)
    if (!Array.isArray(history) || history.length < 3) return 1
    const recent = history.slice(-5)
    const short = recent.filter(item => item.len < 6).length
    return short >= Math.ceil(recent.length * 0.6) ? 0.6 : 1
  }

  function rememberInbound(chatKey, text, at) {
    const history = inboundHistory.get(chatKey) || []
    history.push({ len: Array.from(String(text ?? '')).length, at })
    while (history.length > 8) history.shift()
    inboundHistory.set(chatKey, history)
  }

  // --- 目标挑选（D.5.1） -------------------------------------------------

  function lastUserAtOf(stateRef, data, chat) {
    const relationAt = num(data?.relation?.lastUserAt, 0)
    if (relationAt) return relationAt
    const globalAt = num(stateRef.lastUserAt, 0)
    if (globalAt) return globalAt
    return num(chat?.lastActiveAt, 0)
  }

  function pickTarget(now, config) {
    const stateRef = speakState()
    const data = getData()
    const allowlist = config.groupAllowlist
    const archived = archivedSessionIds()
    const candidates = []
    let fallbackReason = 'no-target'
    for (const binding of bindingsList()) {
      if (!binding || !binding.sessionId) continue
      const kind = binding.kind === 'group' ? 'group' : 'dm'
      const chatId = String(binding.chatId ?? '')
      if (!chatId) continue
      const key = binding.key || `${kind}:${chatId}`
      if (kind === 'group' && !allowlist.has(chatId)) { fallbackReason = 'group-not-allowed'; continue }
      if (archived.has(normSessionKey(binding.sessionId))) { fallbackReason = 'archived'; continue }
      const lastActiveAt = num(binding.lastActiveAt, 0)
      if (!lastActiveAt) { fallbackReason = 'never-interacted'; continue }
      const idleMinutes = Math.max(0, (now - lastActiveAt) / MINUTE_MS)
      const agent = resolveAgent(binding.sessionId)
      const busy = Boolean(agent && typeof agent.status === 'string' && agent.status !== 'idle')
      const chat = { sessionId: binding.sessionId, kind, chatId, key, lastActiveAt }
      const perChat = readPerChat(stateRef, key)
      if (perChat.blockedUntilUser) { fallbackReason = 'blocked'; continue }
      const unanswered = Math.max(num(perChat.unanswered, 0), num(stateRef.unanswered, 0))
      if (unanswered >= config.unansweredPause) { fallbackReason = 'blocked'; continue }
      if (num(perChat.platformRejects, 0) >= 2) { fallbackReason = 'blocked'; continue }
      if (passiveWindowActive(key)) { fallbackReason = 'passive-window'; continue }
      const pendingReply = num(perChat.lastUserAt, 0) > num(perChat.lastAssistantAt, 0)
      if (pendingReply) { fallbackReason = 'pending-reply'; continue }
      if (busy) { fallbackReason = 'agent-busy'; continue }
      const score = Math.min(120, idleMinutes) * 0.5
        - ((stateRef.lastSessionId || stateRef.lastProactiveSessionId) === binding.sessionId ? 60 : 0)
        + (stateRef.lastProactiveAnswered ? 10 : 0)
      candidates.push({ chat, agent, idleMinutes, score, busy: false })
    }
    if (!candidates.length) return { reason: fallbackReason }
    candidates.sort((left, right) => right.score - left.score)
    const live = candidates.filter(candidate => candidate.agent)
    if (live.length) return { ...live[0], cold: false }
    // 冷会话兜底（D.6.1 通道 B）：显式 followup 模式不唤醒
    if (config.wakeMode === 'followup') return { reason: 'cold-session' }
    if (!getSchedule()) return { reason: 'no-schedule' }
    return { ...candidates[0], agent: null, cold: true }
  }

  // --- 触发源（D.2） ----------------------------------------------------

  function pendingImpulseEligible(stateRef, now, lastUserAt, config) {
    const impulse = stateRef.pendingImpulse
    if (!impulse || typeof impulse !== 'object') return false
    const at = num(impulse.at, 0)
    if (!at) return false
    const age = now - at
    if (age < config.nearMinutes * MINUTE_MS || age > 180 * MINUTE_MS) return false
    if (!lastUserAt || lastUserAt > at + 1000) return false
    if (now - lastUserAt < config.nearMinutes * MINUTE_MS) return false
    return stateRef.impulseDayKey !== localDayKey(nowDate())
  }

  function findDue(data, now) {
    let list = []
    try {
      if (typeof memory?.pendingDue === 'function') {
        const value = memory.pendingDue(nowDate())
        if (Array.isArray(value)) list = value
      }
    } catch { /* ignore */ }
    if (!list.length) list = Array.isArray(data?.memory?.pendingDue) ? data.memory.pendingDue : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      if (item.firedAt || item.fired === true) continue
      const dueAt = num(item.dueAt ?? item.due_at ?? item.at, NaN)
      if (!Number.isFinite(dueAt)) continue
      if (dueAt > now) continue
      if (now - dueAt > 48 * 60 * MINUTE_MS) continue // 过期太久不翻旧账
      return { item, dueAt }
    }
    return null
  }

  function ritualDone(stateRef, dayKey, kind) {
    const ritual = stateRef.ritual || {}
    if (ritual.dayKey !== dayKey) return false
    return kind === 'morning' ? ritual.morning === true : ritual.evening === true
  }

  function markRitualDone(stateRef, dayKey, kind) {
    if (!stateRef.ritual || stateRef.ritual.dayKey !== dayKey) stateRef.ritual = { dayKey, morning: false, evening: false }
    if (kind === 'morning') stateRef.ritual.morning = true
    else if (kind === 'evening') stateRef.ritual.evening = true
  }

  function pickTrigger(now, config, picked, data, stateRef) {
    const date = nowDate()
    const dayKey = localDayKey(date)
    const lastUserAt = lastUserAtOf(stateRef, data, picked.chat)
    const silenceMinutes = lastUserAt ? (now - lastUserAt) / MINUTE_MS : Infinity

    if (pendingImpulseEligible(stateRef, now, lastUserAt, config)) {
      return { trigger: 'impulse', factor: 1.5, overrideLine: null }
    }
    const due = findDue(data, now)
    if (due && stateRef.dueDayKey !== dayKey) {
      return { trigger: 'due', factor: 1, overrideLine: 70, due }
    }
    const ritual = inRitualWindow(date)
    if (ritual && data?.relation?.stage !== 'stranger' && !ritualDone(stateRef, dayKey, ritual)) {
      const windowStart = ritual === 'morning' ? 450 : 1320
      const minutes = date.getHours() * 60 + date.getMinutes()
      const interactedInWindow = lastUserAt
        ? now - lastUserAt < Math.max(0, minutes - windowStart) * MINUTE_MS
        : false
      if (!interactedInWindow) return { trigger: 'ritual', factor: 1, overrideLine: 55 }
    }
    if (silenceMinutes >= 24 * 60 && stateRef.returnFiredFor !== lastUserAt) {
      return { trigger: 'return', factor: 1.3, overrideLine: null }
    }
    const lastRollAt = num(stateRef.lastRollAt, 0) || now
    if (now - lastRollAt >= config.intervalMinutes * MINUTE_MS) {
      return { trigger: 'idle', factor: 1, overrideLine: null }
    }
    return null
  }

  function markTriggerUsed(triggerInfo, stateRef, data, now, lastUserAt) {
    if (!triggerInfo) return
    const date = nowDate()
    const dayKey = localDayKey(date)
    if (triggerInfo.trigger === 'impulse') stateRef.impulseDayKey = dayKey
    if (triggerInfo.trigger === 'due') {
      stateRef.dueDayKey = dayKey
      try {
        if (triggerInfo.due?.item) {
          triggerInfo.due.item.firedAt = now
          triggerInfo.due.item.fired = true
        }
      } catch { /* ignore */ }
    }
    if (triggerInfo.trigger === 'ritual') markRitualDone(stateRef, dayKey, inRitualWindow(date) || 'morning')
    if (triggerInfo.trigger === 'return') stateRef.returnFiredFor = lastUserAt
    if (triggerInfo.trigger === 'idle') stateRef.lastRollAt = now
  }

  // --- 内容选择（D.5.2） -------------------------------------------------

  function stickerAvailable(stateRef, config, emotionSnapshot, now) {
    if (!config.stickerEnabled) return false
    if (emotionSnapshot.intensity <= 0.5) return false
    if (num(stateRef.lastStickerAt, 0) && now - num(stateRef.lastStickerAt, 0) < config.stickerCooldownMinutes * MINUTE_MS) return false
    const dayKey = localDayKey(nowDate())
    const todaySticker = stateRef.stickerDayKey === dayKey ? num(stateRef.todaySticker, 0) : 0
    return todaySticker < 2
  }

  function chooseContent({ picked, triggerInfo, data, stateRef, config, emotionSnapshot, now, randomFn, lastUserAt }) {
    const date = nowDate()
    const recentTopics = collectRecentTopics(data, now)
    const rituals = inRitualWindow(date)
    const recallCandidate = pickRecallCandidate(data, recentTopics, now, randomFn)
    const userBusy = userBusyFactor(picked.chat.key) < 1
    const weights = actWeights({
      stage: data?.relation?.stage || 'stranger',
      emotion: emotionSnapshot,
      ritual: rituals && triggerInfo.trigger === 'ritual',
      hasRecall: Boolean(recallCandidate),
      userBusy,
    })
    const recentActs = (Array.isArray(stateRef.log) ? stateRef.log : [])
      .filter(entry => entry && entry.hit === true && entry.act)
      .slice(-2)
      .map(entry => entry.act)
    const act = pickAct({ weights, random: randomFn, recentActs })
    const topic = act === 'recall' && recallCandidate ? recallCandidate.topic : ''
    const sticker = stickerAvailable(stateRef, config, emotionSnapshot, now) && randomFn() < 0.2
    const idleMinutes = lastUserAt ? Math.round((now - lastUserAt) / MINUTE_MS) : picked.idleMinutes
    const input = {
      act,
      topic,
      idleMinutes,
      stage: data?.relation?.stage || 'stranger',
      now: date,
      maxChars: config.maxChars,
      trigger: triggerInfo.trigger,
      sticker,
      lifeText: lifePromptText(),
    }
    return {
      act,
      topic,
      sticker,
      followupText: buildFollowupText(input),
      schedulePrompt: buildSchedulePrompt(input),
      contextText: buildContextIntentText(input),
    }
  }

  // --- 投递（D.6） ------------------------------------------------------

  function makeIntent(picked, content, triggerInfo, now) {
    return {
      sessionId: picked.chat.sessionId,
      chatKey: picked.chat.key,
      act: content.act,
      topic: content.topic,
      sticker: content.sticker,
      trigger: triggerInfo.trigger,
      contextText: content.contextText,
      followupText: content.followupText,
      schedulePrompt: content.schedulePrompt,
      createdAt: now,
      expiresAt: now + PENDING_TIMEOUT_MS,
    }
  }

  function snapshotPrev(stateRef) {
    return {
      todayCount: num(stateRef.todayCount, 0),
      lastAt: num(stateRef.lastAt, 0),
      missStreak: num(stateRef.missStreak, 0),
      stickerCount: num(stateRef.todaySticker, 0),
    }
  }

  async function scheduleCreate(picked, content, stateRef, config) {
    const schedule = getSchedule()
    if (!schedule || typeof schedule.create !== 'function') return { ok: false, error: 'schedule 服务不可用' }
    const dayKey = localDayKey(nowDate())
    if (stateRef.scheduleDisabledDayKey === dayKey) return { ok: false, error: '今日已放弃 schedule 通道' }
    try {
      if (typeof schedule.list === 'function') {
        const list = await Promise.resolve(schedule.list({ sessionId: picked.chat.sessionId }))
        const tasks = Array.isArray(list) ? list : (Array.isArray(list?.tasks) ? list.tasks : [])
        if (tasks.some(task => String(task?.title || '').includes(SCHEDULE_TITLE))) {
          return { ok: false, error: '已有排队中的 Aura 主动任务' }
        }
      }
    } catch { /* list 不可用就直接 create */ }
    try {
      await schedule.create(picked.chat.sessionId, {
        title: SCHEDULE_TITLE,
        prompt: content.schedulePrompt,
        after_seconds: 1,
      })
      return { ok: true }
    } catch (error) {
      stateRef.scheduleDisabledDayKey = dayKey
      return { ok: false, error: `schedule 投递失败：${errorMessage(error)}` }
    }
  }

  async function deliver({ picked, content, triggerInfo, config, now, manual }) {
    const stateRef = speakState()
    const liveIdle = Boolean(picked.agent && !(typeof picked.agent.status === 'string' && picked.agent.status !== 'idle'))
    const scheduleUsable = Boolean(getSchedule()) && stateRef.scheduleDisabledDayKey !== localDayKey(nowDate())
    let channel = 'none'
    if (config.wakeMode === 'followup') channel = liveIdle ? 'followup' : 'none'
    else if (config.wakeMode === 'schedule') channel = scheduleUsable ? 'schedule' : 'none'
    else channel = liveIdle ? 'followup' : (scheduleUsable ? 'schedule' : 'none')

    if (channel === 'none') {
      const scheduleDisabled = stateRef.scheduleDisabledDayKey === localDayKey(nowDate())
      return {
        sent: false,
        channel,
        error: liveIdle ? '没有可用投递通道' : `目标会话没有活着的 agent，且 schedule 通道${scheduleDisabled ? '今日已放弃' : '不可用'}`,
      }
    }

    const prev = snapshotPrev(stateRef)

    const markProactive = () => {
      try { bridge?.markProactive?.(picked.chat.sessionId, { act: content.act, topic: content.topic, trigger: triggerInfo.trigger, at: now, source: 'speak' }) } catch { /* ignore */ }
    }
    const clearProactiveMark = () => {
      try { bridge?.takeProactive?.(picked.chat.sessionId) } catch { /* ignore */ }
    }

    if (channel === 'followup') {
      intent = makeIntent(picked, content, triggerInfo, now)
      markProactive()
      const message = buildFollowupMessage(content.followupText)
      let attempt = 0
      while (true) {
        try {
          await Promise.resolve(picked.agent.followup(message))
          break
        } catch (error) {
          attempt += 1
          if (attempt <= 1 && retryDelayMs >= 0) {
            await sleep(retryDelayMs)
            continue
          }
          intent = null
          clearProactiveMark()
          return { sent: false, channel, error: `followup 失败：${errorMessage(error)}` }
        }
      }
    } else {
      intent = makeIntent(picked, content, triggerInfo, now)
      markProactive()
      const result = await scheduleCreate(picked, content, stateRef, config)
      if (!result.ok) {
        intent = null
        clearProactiveMark()
        return { sent: false, channel, error: result.error }
      }
    }

    if (!manual) {
      const dayKey = localDayKey(nowDate())
      if (stateRef.dayKey !== dayKey) {
        stateRef.dayKey = dayKey
        stateRef.todayCount = 0
      }
      stateRef.todayCount = num(stateRef.todayCount, 0) + 1
      stateRef.lastAt = now
      stateRef.lastProactiveAt = now
      stateRef.lastSessionId = picked.chat.sessionId
      stateRef.lastProactiveSessionId = picked.chat.sessionId
      stateRef.lastProactiveAnswered = false
      stateRef.lastAct = content.act
      stateRef.lastTopic = content.topic
      stateRef.missStreak = 0
      const perChat = ensurePerChat(stateRef, picked.chat.key)
      if (perChat) {
        perChat.unanswered = num(perChat.unanswered, 0) + 1
        perChat.lastAt = now
      }
      if (content.sticker) {
        if (stateRef.stickerDayKey !== dayKey) {
          stateRef.stickerDayKey = dayKey
          stateRef.todaySticker = 0
        }
        stateRef.todaySticker = num(stateRef.todaySticker, 0) + 1
        stateRef.lastStickerAt = now
      }
    }
    pending.set(picked.chat.sessionId, {
      at: now,
      tracked: !manual,
      chatKey: picked.chat.key,
      text: content.followupText,
      intentText: content.contextText,
      act: content.act,
      topic: content.topic,
      prev,
      manual,
      logEntry: null,
    })
    return { sent: true, channel }
  }

  // --- 结果回调（D.8：失败降级） ----------------------------------------

  function findChatKey(info) {
    if (info?.chatKey) return String(info.chatKey)
    const chat = info?.chat
    if (chat && typeof chat === 'object') {
      if (chat.key) return String(chat.key)
      if (chat.kind && chat.chatId) return `${chat.kind}:${chat.chatId}`
    }
    const sessionId = String(info?.sessionId || '')
    if (sessionId) {
      try {
        const known = bridge?.chatOfSession?.(sessionId)
        if (known?.key) return String(known.key)
        if (known?.kind && known?.chatId) return `${known.kind}:${known.chatId}`
      } catch { /* ignore */ }
    }
    return ''
  }

  function normalizeOutboundArgs(args) {
    const info = {}
    for (const arg of args) {
      if (arg && typeof arg === 'object') {
        for (const [key, value] of Object.entries(arg)) {
          if (value !== undefined) info[key] = value
        }
      } else if (typeof arg === 'string' && info.text === undefined) {
        info.text = arg
      }
    }
    return info
  }

  function rollbackProactive(pendingEntry) {
    const stateRef = speakState()
    if (!pendingEntry || !pendingEntry.tracked) return
    const prev = pendingEntry.prev || {}
    stateRef.todayCount = num(prev.todayCount, 0)
    stateRef.lastAt = num(prev.lastAt, 0)
    stateRef.missStreak = num(prev.missStreak, 0)
    if (pendingEntry.sticker) stateRef.todaySticker = num(prev.stickerCount, 0)
    const perChat = ensurePerChat(stateRef, pendingEntry.chatKey)
    if (perChat) perChat.unanswered = Math.max(0, num(perChat.unanswered, 0) - 1)
  }

  function markProactiveFailure(pendingEntry, { error, platformRejected, declined = false }) {
    const stateRef = speakState()
    rollbackProactive(pendingEntry)
    const perChat = ensurePerChat(stateRef, pendingEntry.chatKey)
    const detail = errorMessage(error)
    if (platformRejected && perChat) {
      perChat.platformRejects = num(perChat.platformRejects, 0) + 1
      stateRef.platformRejects = num(stateRef.platformRejects, 0) + 1
      if (num(perChat.platformRejects, 0) >= 2) perChat.blockedUntilUser = true
    }
    if (declined) {
      // 模型自己放弃（<skip>）：不惩罚，只记录，不计入日上限
      stateRef.missStreak = num(pendingEntry.prev?.missStreak, 0)
    } else {
      stateRef.pendingThought = {
        at: nowMs(),
        thought: intentLineFor(pendingEntry.act, pendingEntry.topic),
        act: pendingEntry.act || '',
        topic: pendingEntry.topic || '',
        expiresAt: nowMs() + THOUGHT_TTL_MS,
      }
    }
    if (intent && pendingEntry.chatKey && intent.chatKey === pendingEntry.chatKey) intent = null
    if (pendingEntry.logEntry) {
      pendingEntry.logEntry.sent = false
      pendingEntry.logEntry.error = detail
    }
    recordExplain({
      at: nowMs(),
      summary: `主动投递失败（${pendingEntry.chatKey}）：${detail}`,
      data: { chatKey: pendingEntry.chatKey, platformRejected: Boolean(platformRejected), declined },
    })
    log(`[speak] 主动投递失败 ${pendingEntry.chatKey}: ${detail}`)
    saveSoul(true)
  }

  function markProactiveDelivered(pendingEntry, text) {
    const stateRef = speakState()
    const value = String(text ?? '').trim()
    if (value && !isSkipText(value)) {
      stateRef.recentTexts = [...(Array.isArray(stateRef.recentTexts) ? stateRef.recentTexts : []), value].slice(-RECENT_TEXT_LIMIT)
    }
    if (pendingEntry.logEntry) pendingEntry.logEntry.sent = true
    recordExplain({
      at: nowMs(),
      summary: `主动消息送达（${pendingEntry.chatKey}，${Array.from(value).length} 字）`,
      data: { chatKey: pendingEntry.chatKey, text: value.slice(0, 80), act: pendingEntry.act || '' },
    })
    saveSoul(true)
  }

  function onOutbound(...args) {
    if (disposed) return
    try {
      const info = normalizeOutboundArgs(args)
      const chatKey = findChatKey(info)
      const sessionId = String(info.sessionId || '')
      const error = info.error || (info.ok === false ? (info.reason || new Error('出站失败')) : null)
      const text = info.text === undefined ? '' : String(info.text)
      const pendingEntry = (sessionId && pending.get(sessionId))
        || [...pending.values()].find(entry => entry.chatKey && entry.chatKey === chatKey)
        || null
      const proactive = info.proactive === true || Boolean(pendingEntry) || Boolean(intent && intent.chatKey === chatKey)

      if (proactive) {
        if (error) {
          const message = errorMessage(error)
          const platformRejected = info.platformRejected === true
            || /主动消息|被动|msg_id|平台|拒绝|reject|denied|not allowed|forbidden/i.test(message)
          if (info.kind === 'skip' || info.skipped === true || info.declined === true || isSkipText(text)) {
            if (pendingEntry) markProactiveFailure(pendingEntry, { error: message || '模型放弃开口', platformRejected: false, declined: true })
            return
          }
          if (pendingEntry) markProactiveFailure(pendingEntry, { error: message, platformRejected })
          else {
            // 没有 pending（重启/外部触发）：至少记 explain，避免静默
            recordExplain({ at: nowMs(), summary: `主动出站失败：${message}`, data: { chatKey } })
            saveSoul()
          }
          return
        }
        if (isSkipText(text) || info.kind === 'skip' || info.skipped === true || info.declined === true) {
          // bridge 过滤了 <skip> / 模型自己放弃：不算平台拒绝，回滚日计数
          if (pendingEntry) markProactiveFailure(pendingEntry, { error: '模型回复 <skip>', platformRejected: false, declined: true })
          return
        }
        if (pendingEntry) {
          for (const [key, entry] of pending) if (entry === pendingEntry) pending.delete(key)
          markProactiveDelivered(pendingEntry, text)
        }
        if (intent && intent.chatKey === (chatKey || intent.chatKey)) intent = null
        return
      }

      // 普通出站：记录活跃时间；用户下一轮如果真的看到 pendingThought，这里清掉
      const perChat = chatKey ? ensurePerChat(speakState(), chatKey) : null
      if (perChat) perChat.lastAssistantAt = nowMs()
      const stateRef = speakState()
      if (stateRef.pendingThought) {
        stateRef.pendingThought = null
        saveSoul()
      }
    } catch (error) {
      logOnce('outbound', '[speak] 出站回调失败:', errorMessage(error))
    }
  }

  function notifyProactiveResult(info = {}) {
    onOutbound({ proactive: true, ...info })
  }

  // --- 入站（C.4 / D.4 状态更新） ---------------------------------------

  function onInbound(event) {
    if (disposed) return
    try {
      if (!event || typeof event !== 'object') return
      const text = String(event.text ?? '').trim()
      if (!text) return
      const kind = event.kind === 'group' ? 'group' : 'dm'
      const chatId = String(event.chatId ?? '')
      if (!chatId) return
      const chatKey = `${kind}:${chatId}`
      const now = nowMs()
      const date = nowDate()
      const config = readSpeakConfig()
      const data = getData()
      const stateRef = speakState()
      const perChat = ensurePerChat(stateRef, chatKey)

      // 用户开口 = 未回复/平台拒绝/暂停全部解除（D.4）
      if (perChat) {
        perChat.unanswered = 0
        perChat.platformRejects = 0
        perChat.blockedUntilUser = false
        perChat.lastUserAt = now
        perChat.lastUserText = text.slice(0, 80)
      }
      stateRef.unanswered = 0
      stateRef.platformRejects = 0
      stateRef.lastUserAt = now
      stateRef.lastUserAnsweredAt = now
      if (intent && intent.chatKey === chatKey) intent = null
      if (num(stateRef.lastProactiveAt, 0) && now - num(stateRef.lastProactiveAt, 0) < 24 * 60 * MINUTE_MS) {
        stateRef.lastProactiveAnswered = true
      }
      const answeredKeys = [...pending.entries()].filter(([, entry]) => entry.chatKey === chatKey)
      for (const [sessionId, entry] of answeredKeys) {
        pending.delete(sessionId)
        try { bridge?.takeProactive?.(sessionId) } catch { /* ignore */ }
        if (!entry.manual) stateRef.lastProactiveAnswered = true
      }
      rememberInbound(chatKey, text, now)

      if (data.relation && typeof data.relation === 'object') data.relation.lastUserAt = now

      // 「别烦我」正则 → 暂停（D.4；反思 LLM 判定由 memory/soul 补）
      if (/(别|不要).{0,6}(主动|找我|打扰|烦)/.test(text)) {
        stateRef.pausedUntil = now + config.pauseHours * 60 * MINUTE_MS
        recordExplain({ at: now, summary: '用户表示别打扰，主动搭话暂停', data: { chatKey, until: stateRef.pausedUntil } })
        log(`[speak] 用户要求别打扰，暂停主动 ${config.pauseHours} 小时`)
      }

      // 情绪冲动检测（D.2②）：
      // - bridge 入站 hook 先于 agent 回合执行 → 这里读到的是「本条消息评估前」的情绪，作为基线；
      // - 有 soul.on('turnEnd') 时，回合结束后对比基线，精确拿到这一轮引起的情绪变化；
      // - 没有订阅能力时退回旧做法：下一条用户消息到来时对比上一轮结果。
      const currentEmotion = readEmotion()
      const previousBaseline = normalizeEmotion(stateRef.emotionBaseline)
      const canSubscribeTurnEnd = typeof soul?.on === 'function'
      if (!canSubscribeTurnEnd) {
        if (previousBaseline.valid && currentEmotion.valid) {
          const delta = detectImpulse(previousBaseline, currentEmotion)
          stateRef.pendingImpulse = delta.strong
            ? { at: now, deltaValence: round1(delta.deltaValence), deltaAffection: round1(delta.deltaAffection) }
            : null
        } else {
          stateRef.pendingImpulse = null
        }
      } else {
        // 新一轮开始：清掉上一轮登记的冲动，等本轮 turnEnd 再判定
        stateRef.pendingImpulse = null
      }
      stateRef.pendingUserTurn = true
      stateRef.emotionBaseline = { ...currentEmotion, at: now }

      // 收尾信号由记忆/反思写 speak.suppressUntil；这里只读，不覆盖
      // pendingThought 留给「用户下次开口的那一轮」做记忆上下文；普通出站回调时清掉
      saveSoul()
    } catch (error) {
      logOnce('inbound', '[speak] 入站回调失败:', errorMessage(error))
    }
  }

  // --- 主 tick ----------------------------------------------------------

  function todayCountOf(stateRef, now) {
    const dayKey = localDayKey(nowDate())
    stateRef.todayCount = stateRef.dayKey === dayKey ? num(stateRef.todayCount, 0) : 0
    stateRef.dayKey = dayKey
    return stateRef.todayCount
  }

  function computeParts({ picked, triggerInfo, config, emotionSnapshot, stateRef, data, now, lastUserAt, busy }) {
    const date = nowDate()
    const minutesSinceUser = lastUserAt ? (now - lastUserAt) / MINUTE_MS : Infinity
    const timing = timingFactor(minutesSinceUser, config)
    const perChat = picked ? readPerChat(stateRef, picked.chat.key) : null
    const unanswered = unansweredFactor(Math.max(num(perChat?.unanswered, 0), num(stateRef.unanswered, 0)))
    const missStreak = num(stateRef.missStreak, 0)
    const missBonusPart = Math.min(config.bonusCap, missStreak * config.missBonus)
    const parts = {
      daypart: daypartOf(date),
      baseLine: pickBaseLine(config, date),
      stage: stageFactor(data?.relation?.stage || 'stranger', config),
      timing,
      timingLabel: lastUserAt ? `距上次说话 ${Math.max(0, Math.round(minutesSinceUser))} 分钟` : '还没怎么聊过',
      unanswered,
      busyFactor: busy ? 0.6 : 1,
      triggerFactor: triggerInfo?.factor ?? 1,
      impulse: impulseBonus(emotionSnapshot),
      missStreak,
      missBonus: config.missBonus,
      bonusCap: config.bonusCap,
      missBonusPart,
      trigger: triggerInfo?.trigger || 'idle',
      overrideLine: triggerInfo?.overrideLine ?? null,
    }
    const lifeNow = lifeSnapshot()
    parts.life = lifeNow?.state || ''
    parts.lifeFactor = lifeNow ? lifeFactorOf(lifeNow.state) : 1
    // 生活状态乘在最后：due/ritual 的固定命中线也照样被「睡着」压成 0。
    parts.line = clamp(computeHitLine(parts) * num(parts.lifeFactor, 1), 0, 100)
    return parts
  }

  function buildResult(parts, extra = {}) {
    return {
      at: nowMs(),
      line: round1(parts.line ?? 0),
      roll: extra.roll === undefined ? null : round1(extra.roll),
      formula: formatFormula(parts),
      trigger: parts.trigger,
      ...extra,
    }
  }

  function appendLog(entry) {
    const stateRef = speakState()
    const list = Array.isArray(stateRef.log) ? stateRef.log : []
    stateRef.log = [...list, entry].slice(-SPEAK_LOG_LIMIT)
    return entry
  }

  async function tick(options = {}) {
    if (disposed) return { done: 'disposed' }
    const manual = options?.trigger === 'manual' || options?.manual === true
    const wakeTrigger = options?.trigger === 'wake'
    const config = readSpeakConfig()
    const now = nowMs()
    const date = nowDate()
    const dayKey = localDayKey(date)
    const stateRef = speakState()
    const data = getData()
    const emotionSnapshot = readEmotion()
    const lifeNow = lifeSnapshot()

    // 清理超时未确认的主动投递（认为已送达，不惩罚）
    for (const [sessionId, entry] of pending) {
      if (now - entry.at > PENDING_TIMEOUT_MS) {
        pending.delete(sessionId)
        try { bridge?.takeProactive?.(sessionId) } catch { /* ignore */ }
        entry.logEntry && (entry.logEntry.assumedDelivered = true)
        recordExplain({ at: now, summary: `主动投递未收到出站回执，按已送达处理（${entry.chatKey}）`, data: { chatKey: entry.chatKey } })
      }
    }

    if (!config.enabled && !manual) return { done: 'off' }
    const online = isOnline()
    const allowOfflineDry = manual && ((options?.mode === 'dry') || (options?.mode === undefined && config.dryRun))
    if (!online && !allowOfflineDry) return { done: 'offline' }
    if (!manual && inQuietHours(config, date)) return { done: 'quiet', line: null }
    if (!manual && num(stateRef.pausedUntil, 0) > now) return { done: 'paused' }
    if (!manual && num(stateRef.suppressUntil, 0) > now) return { done: 'suppressed' }
    // 睡着了就完全不发；她自己的生活优先于主动搭话。
    if (!manual && lifeNow && lifeNow.state === 'sleep' && config.lifeQuietSleep !== false) {
      return { done: 'life-sleep', life: 'sleep' }
    }
    if (!manual) {
      // 「刚醒来」是高优先级：跳过冷却与 idle 间隔，但日上限仍然算数
      if (!wakeTrigger) {
        const cooldownMs = config.cooldownMinutes * MINUTE_MS
        if (cooldownMs > 0 && num(stateRef.lastAt, 0) && now - num(stateRef.lastAt, 0) < cooldownMs) {
          return { done: 'cooldown', nextAt: num(stateRef.lastAt, 0) + cooldownMs }
        }
      }
      if (todayCountOf(stateRef, now) >= config.dailyCap) return { done: 'daily-cap', todayCount: stateRef.todayCount }
    }

    const picked = pickTarget(now, config)
    if (!picked || !picked.chat) return { done: picked?.reason || 'no-target' }

    const lastUserAt = lastUserAtOf(stateRef, data, picked.chat)
    const busy = userBusyFactor(picked.chat.key) < 1

    let triggerInfo
    if (manual) {
      triggerInfo = { trigger: 'manual', factor: 1, overrideLine: null }
    } else if (wakeTrigger) {
      // 睡醒/忙完后的第一次开口：命中线抬高，但仍掷骰，不强制发
      triggerInfo = { trigger: 'wake', factor: 1, overrideLine: WAKE_OVERRIDE_LINE }
    } else {
      triggerInfo = pickTrigger(now, config, picked, data, stateRef)
      if (!triggerInfo) {
        // idle 间隔没到、其他触发源也没到期
        return { done: 'idle-wait', nextAt: num(stateRef.lastRollAt, 0) + config.intervalMinutes * MINUTE_MS }
      }
      markTriggerUsed(triggerInfo, stateRef, data, now, lastUserAt)
    }

    const parts = computeParts({ picked, triggerInfo, config, emotionSnapshot, stateRef, data, now, lastUserAt, busy })
    const modeDry = options?.mode === 'dry' ? true : options?.mode === 'real' ? false : config.dryRun

    if (manual) {
      // D.2⑥ manual：不掷骰、不动计数器
      const content = chooseContent({ picked, triggerInfo, data, stateRef, config, emotionSnapshot, now, randomFn: random, lastUserAt })
      const dryRun = modeDry
      const result = buildResult(parts, { hit: true, manual: true, dryRun, act: content.act, topic: content.topic, sticker: content.sticker })
      let channel = 'none'
      let error = ''
      if (dryRun) {
        channel = picked.agent ? 'followup' : 'schedule'
        result.done = 'manual-dry'
      } else {
        const delivery = await deliver({ picked, content, triggerInfo, config, now, manual: true })
        channel = delivery.channel
        error = delivery.error || ''
        result.done = delivery.sent ? 'manual-sent' : 'manual-send-failed'
      }
      const entry = appendLog({
        at: now,
        trigger: 'manual',
        sessionId: picked.chat.sessionId,
        line: result.line,
        roll: null,
        hit: true,
        formula: result.formula,
        act: content.act,
        topic: content.topic,
        dryRun,
        sent: !dryRun && result.done === 'manual-sent',
        manual: true,
        channel,
        error,
      })
      recordExplain({ at: now, summary: `手动主动搭话（${dryRun ? '演练' : '真发'}，${content.act}）：${error || '命中'}`, data: { chatKey: picked.chat.key, channel } })
      saveSoul()
      return { ...result, channel, error, sessionId: picked.chat.sessionId, logEntry: entry }
    }

    const roll = clamp(random(), 0, 1) * 100
    const hit = roll < parts.line
    if (!hit) {
      stateRef.missStreak = num(stateRef.missStreak, 0) + 1
      const entry = appendLog({
        at: now,
        trigger: triggerInfo.trigger,
        sessionId: picked.chat.sessionId,
        line: round1(parts.line),
        roll: round1(roll),
        hit: false,
        formula: formatFormula(parts),
        act: '',
        topic: '',
        dryRun: modeDry,
        sent: false,
        error: '',
      })
      recordExplain({ at: now, summary: `主动掷骰未中：掷出 ${round1(roll)}（命中线 ${round1(parts.line)}，掷到线下才开口）｜${formatFormula(parts)}`, data: { chatKey: picked.chat.key, trigger: triggerInfo.trigger } })
      saveSoul()
      return { done: modeDry ? 'dry-run-miss' : 'miss', ...buildResult(parts, { roll, hit: false, trigger: triggerInfo.trigger }), logEntry: entry }
    }

    // 命中：清零连没中（试运行命中同样清零，D.7）
    stateRef.missStreak = 0
    const content = chooseContent({ picked, triggerInfo, data, stateRef, config, emotionSnapshot, now, randomFn: random, lastUserAt })
    const dryRun = modeDry

    if (dryRun) {
      const channel = picked.agent ? 'followup' : 'schedule'
      const entry = appendLog({
        at: now,
        trigger: triggerInfo.trigger,
        sessionId: picked.chat.sessionId,
        line: round1(parts.line),
        roll: round1(roll),
        hit: true,
        formula: formatFormula(parts),
        act: content.act,
        topic: content.topic,
        dryRun: true,
        sent: false,
        channel,
        error: '',
      })
      recordExplain({ at: now, summary: `主动掷骰命中（试运行，不发送）：掷出 ${round1(roll)} < 命中线 ${round1(parts.line)}，${content.act} via ${channel}｜${formatFormula(parts)}`, data: { chatKey: picked.chat.key, trigger: triggerInfo.trigger, act: content.act } })
      saveSoul()
      return { done: 'dry-run', ...buildResult(parts, { roll, hit: true, trigger: triggerInfo.trigger, act: content.act, topic: content.topic, sticker: content.sticker, dryRun: true, channel }), logEntry: entry }
    }

    if (triggerInfo.trigger === 'due') {
      try { memory?.consumeDue?.(nowDate()) } catch (error) { logOnce('consume-due', '[speak] consumeDue 失败:', errorMessage(error)) }
    }
    const delivery = await deliver({ picked, content, triggerInfo, config, now, manual: false })
    const logEntry = {
      at: now,
      trigger: triggerInfo.trigger,
      sessionId: picked.chat.sessionId,
      line: round1(parts.line),
      roll: round1(roll),
      hit: true,
      formula: formatFormula(parts),
      act: content.act,
      topic: content.topic,
      dryRun: false,
      sent: delivery.sent,
      channel: delivery.channel,
      error: delivery.error || '',
    }
    appendLog(logEntry)
    const pendingEntry = pending.get(picked.chat.sessionId)
    if (pendingEntry) pendingEntry.logEntry = logEntry
    if (delivery.sent) {
      recordExplain({ at: now, summary: `主动搭话已发出（${delivery.channel}，${content.act}）：掷出 ${round1(roll)} < 命中线 ${round1(parts.line)}｜${formatFormula(parts)}`, data: { chatKey: picked.chat.key, trigger: triggerInfo.trigger } })
      log(`[speak] 主动搭话 ${delivery.channel} ${picked.chat.key}（${content.act}/${triggerInfo.trigger}，line ${round1(parts.line)} > roll ${round1(roll)}）`)
    } else {
      // 投递通道失败：不等出站回执，直接按失败处理
      const entry = pending.get(picked.chat.sessionId)
      if (entry) {
        pending.delete(picked.chat.sessionId)
        markProactiveFailure(entry, { error: delivery.error || '投递失败', platformRejected: false })
      }
      if (delivery.channel === 'followup') {
        const failedChat = ensurePerChat(stateRef, picked.chat.key)
        if (failedChat) failedChat.blockedUntilUser = true
        stateRef.pendingThought = {
          at: now,
          thought: intentLineFor(content.act, content.topic),
          act: content.act,
          topic: content.topic,
          expiresAt: now + THOUGHT_TTL_MS,
        }
      }
      recordExplain({ at: now, summary: `主动搭话投递失败（${delivery.channel}）：${delivery.error || '未知原因'}`, data: { chatKey: picked.chat.key } })
    }
    saveSoul()
    return {
      done: delivery.sent ? 'sent' : 'send-failed',
      ...buildResult(parts, { roll, hit: true, trigger: triggerInfo.trigger, act: content.act, topic: content.topic, sticker: content.sticker, dryRun: false, channel: delivery.channel, error: delivery.error || '' }),
      logEntry,
    }
  }

  // --- 出站前文本检查（供 bridge 接线；也用于出站回调记录） --------------

  function checkProactiveText(text, options = {}) {
    const config = readSpeakConfig()
    const stateRef = speakState()
    const value = String(text ?? '').trim()
    if (!value) return { ok: false, reason: 'empty' }
    if (isSkipText(value)) return { ok: false, reason: 'skip' }
    const forbidden = forbiddenText(value)
    if (forbidden) return { ok: false, reason: 'forbidden', pattern: forbidden }
    if (tooSimilar(value, stateRef.recentTexts)) return { ok: false, reason: 'similar' }
    const maxChars = Math.max(config.maxChars * 2, config.maxChars + 60)
    if (Array.from(value).length > maxChars) return { ok: false, reason: 'too-long', maxChars }
    if (options?.record === true) {
      stateRef.recentTexts = [...(Array.isArray(stateRef.recentTexts) ? stateRef.recentTexts : []), value].slice(-RECENT_TEXT_LIMIT)
      saveSoul()
    }
    return { ok: true, text: value }
  }

  /**
   * 醒来后叫一次主动搭话（life.on('wake') 会调它）。
   * 不是强制发：静默/暂停/日上限/最近没聊过都会挡；命中仍然要掷骰。
   */
  async function notifyWake(options = {}) {
    if (disposed) return { done: 'disposed' }
    const config = readSpeakConfig()
    if (!config.enabled) return { done: 'off' }
    if (config.lifeWakeGreeting === false) return { done: 'off-disabled' }
    const now = nowMs()
    if (inQuietHours(config, nowDate())) return { done: 'quiet' }
    const stateRef = speakState()
    if (num(stateRef.pausedUntil, 0) > now) return { done: 'paused' }
    if (num(stateRef.suppressUntil, 0) > now) return { done: 'suppressed' }
    if (todayCountOf(stateRef, now) >= config.dailyCap) return { done: 'daily-cap', todayCount: stateRef.todayCount }
    const picked = pickTarget(now, config)
    if (!picked || !picked.chat) return { done: picked?.reason || 'no-target' }
    const lastUserAt = lastUserAtOf(stateRef, getData(), picked.chat)
    if (!lastUserAt || now - lastUserAt > WAKE_RECENT_MS) return { done: 'no-recent' }
    return tick({ trigger: 'wake', lifeFrom: options?.from || '' })
  }

  // --- prompt context（order 60，仅命中轮且会话匹配） --------------------

  function currentIntentText(sessionId) {
    if (!intent) return ''
    if (num(intent.expiresAt, 0) < nowMs()) {
      intent = null
      return ''
    }
    if (sessionId !== undefined && sessionId !== null && String(sessionId) !== '') {
      if (String(sessionId) !== String(intent.sessionId)) return ''
    } else if (sessionId === undefined || sessionId === null) {
      // 调用方没给会话（面板/调试）：返回最近一次念头，供展示
      return intent.contextText
    } else {
      return ''
    }
    return intent.contextText
  }

  function currentIntent() {
    if (!intent) return null
    if (num(intent.expiresAt, 0) < nowMs()) {
      intent = null
      return null
    }
    return { ...intent }
  }

  function snapshot() {
    const config = readSpeakConfig()
    const stateRef = speakState()
    const data = getData()
    const emotionSnapshot = readEmotion()
    const picked = pickTarget(nowMs(), config)
    const lastUserAt = picked?.chat ? lastUserAtOf(stateRef, data, picked.chat) : lastUserAtOf(stateRef, data, null)
    const busy = picked?.chat ? userBusyFactor(picked.chat.key) < 1 : false
    const previewParts = computeParts({
      picked: picked?.chat ? picked : null,
      triggerInfo: { trigger: 'idle', factor: 1, overrideLine: null },
      config,
      emotionSnapshot,
      stateRef,
      data,
      now: nowMs(),
      lastUserAt,
      busy,
    })
    const pendingThought = stateRef.pendingThought && num(stateRef.pendingThought.expiresAt, 0) > nowMs()
      ? stateRef.pendingThought
      : null
    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      intervalMinutes: config.intervalMinutes,
      cooldownMinutes: config.cooldownMinutes,
      dailyCap: config.dailyCap,
      wakeMode: config.wakeMode,
      maxChars: config.maxChars,
      quietStart: config.quietStart,
      quietEnd: config.quietEnd,
      todayCount: stateRef.dayKey === localDayKey(nowDate()) ? num(stateRef.todayCount, 0) : 0,
      lastAt: num(stateRef.lastAt, 0),
      lastAct: stateRef.lastAct || '',
      lastTopic: stateRef.lastTopic || '',
      missStreak: num(stateRef.missStreak, 0),
      unanswered: Math.max(num(stateRef.unanswered, 0), ...Object.values(stateRef.perChat || {}).map(item => num(item?.unanswered, 0)), 0),
      pausedUntil: num(stateRef.pausedUntil, 0),
      suppressUntil: num(stateRef.suppressUntil, 0),
      recentTexts: Array.isArray(stateRef.recentTexts) ? stateRef.recentTexts.slice(-RECENT_TEXT_LIMIT) : [],
      nextLine: round1(previewParts.line),
      rule: formatFormula(previewParts),
      nextTriggerIn: Math.max(0, num(stateRef.lastRollAt, 0) + config.intervalMinutes * MINUTE_MS - nowMs()),
      target: picked?.chat ? { sessionId: picked.chat.sessionId, kind: picked.chat.kind, chatId: picked.chat.chatId, cold: Boolean(picked.cold) } : null,
      pendingThought,
      intent: currentIntent(),
      log: (Array.isArray(stateRef.log) ? stateRef.log : []).slice(-10),
      perChat: Object.entries(stateRef.perChat || {}).slice(-20).map(([key, value]) => ({ key, ...value })),
    }
  }

  // --- 注册 hooks / prompt / 定时器 -------------------------------------

  function safeDispose(value) {
    if (typeof value === 'function') return value
    if (value && typeof value.dispose === 'function') return () => value.dispose()
    return () => {}
  }

  try {
    if (typeof bridge?.addInboundHook === 'function') {
      disposers.push(safeDispose(bridge.addInboundHook(onInbound)))
    } else if (bridge && typeof bridge === 'object') {
      const previous = bridge.onInbound
      bridge.onInbound = (...args) => {
        try { if (typeof previous === 'function') previous(...args) } catch (error) { logOnce('legacy-inbound', '[speak] 旧 onInbound 回调失败:', errorMessage(error)) }
        onInbound(args[0])
      }
    }
  } catch (error) {
    logOnce('hook-in', '[speak] 注册入站 hook 失败:', errorMessage(error))
  }

  try {
    if (typeof bridge?.addOutboundHook === 'function') {
      disposers.push(safeDispose(bridge.addOutboundHook((...args) => onOutbound(...args))))
    }
  } catch (error) {
    logOnce('hook-out', '[speak] 注册出站 hook 失败:', errorMessage(error))
  }

  // 回合结束：用「回合前基线 vs 回合后情绪」判定冲动（D.2②）；每一条用户消息只判一次。
  try {
    if (soul && typeof soul.on === 'function') {
      const disposeTurnEnd = soul.on('turnEnd', () => {
        try {
          if (disposed) return
          const stateRef = speakState()
          if (stateRef.pendingUserTurn !== true) return
          stateRef.pendingUserTurn = false
          const baseline = normalizeEmotion(stateRef.emotionBaseline)
          const current = readEmotion()
          if (!baseline.valid || !current.valid) return
          const delta = detectImpulse(baseline, current)
          const at = nowMs()
          if (delta.strong) {
            stateRef.pendingImpulse = {
              at,
              deltaValence: round1(delta.deltaValence),
              deltaAffection: round1(delta.deltaAffection),
            }
            recordExplain({
              at,
              summary: `情绪变化明显（Δ愉悦 ${round1(delta.deltaValence)}，Δ亲近 ${round1(delta.deltaAffection)}），登记主动冲动`,
              data: {},
            })
          }
          stateRef.emotionBaseline = { ...current, at }
          saveSoul()
        } catch (error) {
          logOnce('turnend', '[speak] turnEnd 回调失败:', errorMessage(error))
        }
      })
      disposers.push(safeDispose(disposeTurnEnd))
    }
  } catch (error) {
    logOnce('soulon', '[speak] 订阅 soul.on 失败:', errorMessage(error))
  }

  try {
    if (life && typeof life.on === 'function') {
      disposers.push(safeDispose(life.on('wake', payload => {
        if (disposed) return
        // 只是半夜中途醒了一下又接着睡，不算「醒来」，别去打扰人
        if (!payload || payload.resumed === true) return
        void notifyWake({ from: payload.from || '' }).catch(error => {
          logOnce('wake', '[speak] 醒来主动失败:', errorMessage(error))
        })
      })))
    }
  } catch (error) {
    logOnce('wake-hook', '[speak] 订阅 life.wake 失败:', errorMessage(error))
  }

  try {
    if (ctx?.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
      ctx.systemPrompt.context({
        name: 'aura:intent',
        order: 60,
        text: assembly => {
          try {
            const sessionId = assembly?.agent?.session?.id ?? assembly?.agent?.session?.header?.id ?? ''
            if (!sessionId) return ''
            return currentIntentText(sessionId)
          } catch {
            return ''
          }
        },
      })
    }
  } catch (error) {
    logOnce('context', '[speak] 主动念头注入注册失败:', errorMessage(error))
  }

  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        const timer = setInterval(() => {
          void tick({ auto: true }).catch(error => logOnce('tick', '[speak] tick 失败:', errorMessage(error)))
        }, tickMs)
        if (timer.unref) timer.unref()
        return () => clearInterval(timer)
      })
    }
  } catch (error) {
    logOnce('timer', '[speak] 定时器注册失败:', errorMessage(error))
  }

  function stop() {
    disposed = true
    for (const sessionId of pending.keys()) {
      try { bridge?.takeProactive?.(sessionId) } catch { /* ignore */ }
    }
    pending.clear()
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
    intent = null
  }

  const startupConfig = readSpeakConfig()
  log('[speak] 主动搭话已装载：每 ' + startupConfig.intervalMinutes + ' 分钟掷一次骰子' +
    (startupConfig.dryRun ? '｜试运行中（只记账不真发）' : '') +
    '｜每日上限 ' + startupConfig.dailyCap +
    '｜静默 ' + startupConfig.quietStart + '~' + startupConfig.quietEnd)
  log('[speak] 当前预估命中线 ' + round1(snapshot().nextLine) + '（' + snapshot().rule + '）')

  return {
    snapshot,
    tick,
    currentIntentText,
    currentIntent,
    checkProactiveText,
    notifyProactiveResult,
    notifyWake,
    stop,
    /** 纯函数也挂到 API 上，方便 web.js/面板直接算展示值 */
    helpers: { computeHitLine, formatFormula, inQuietHours, daypartOf, pickBaseLine, stageFactor, timingFactor, unansweredFactor, impulseBonus },
  }
}

/** 群号白名单：逗号/中文逗号/空白分隔；空=只对私聊主动。 */
export function parseAllowlist(value) {
  const set = new Set()
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = String(item ?? '').trim()
      if (key) set.add(key)
    }
    return set
  }
  for (const item of String(value ?? '').split(/[,，\s]+/)) {
    const key = item.trim()
    if (key) set.add(key)
  }
  return set
}
