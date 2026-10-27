/**
 * 情绪层（Host 侧）：事件评估 → 状态数学 → 衰减 → expressionStyle 自由文本注入 → 安全守卫。
 *
 * 设计依据：docs/aura-soul-design.md 的 B（情绪模型）、E.4（context order 30）、E.5.1（qq_mood）、
 * F.1 第 4/19 条（衰减幂等、自报限幅）。
 *
 * 状态所有权：情绪数据存在 soul.get().emotion 里，由 soul.js 统一落盘；
 * 本文件只计算与写字段，然后调用 soul.saveSoon()。
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_EXPRESSION_STYLE } from './state.js'
import {
  clamp,
  codepointSlice,
  codepointLength,
  localDayKey,
  stageLabel,
  isSoulSession,
  STAGES,
  EMOTION_HISTORY_MAX,
} from './soul.js'

export { EMOTION_HISTORY_MAX }

// ---------- 常量 / 纯函数 ----------

/** 中文情感词典快评（基线来自 dsh-emotion lib/src/logic.js，按陪伴语料少量扩充）。 */
export const LEXICON = {
  棒: 0.7, 好: 0.5, 开心: 0.8, 谢谢: 0.6, 快: 0.4, 漂亮: 0.6, 喜欢: 0.7, 顺利: 0.6, 赞: 0.7,
  爱你: 0.8, 想你: 0.6, 抱抱: 0.6, 可爱: 0.5, 厉害: 0.6, 哈哈: 0.5, 笑死: 0.4, 有趣: 0.4,
  崩: -0.8, 烦: -0.7, 烂: -0.8, 垃圾: -0.8, 失望: -0.7, 慢: -0.4, 错: -0.5, 又: -0.2, 丢: -0.6,
  难过: -0.7, 累: -0.5, 困: -0.4, 哭: -0.7, 生气: -0.7, 讨厌: -0.7, 焦虑: -0.6, 害怕: -0.6,
  讨厌你: -0.9, 无语: -0.5, 服了: -0.4, 呵呵: -0.4,
}

export const IRONY_MARKS = ['呵呵', '真是', '可真是', '真行', '服了', '谢谢你啊', '是吧', '呢']
export const RELATION_EVENT_RE = /(分手|吵架|道歉|和好|离职|表白|家里人|去世|生病|面试|生日|纪念日|搬家|结婚|怀孕|住院)/
export const GAIN = { valence: 0.35, arousal: 0.55, affection: 0.12, energy: 0.2 }
export const DEFAULT_HALF_LIFE = { valenceMs: 3 * 3_600_000, arousalMs: 45 * 60_000, energyMs: 6 * 3_600_000 }

/** 本次升级新增：长期基准 / 趋势 / 事件显著性 / 注入预算（对外导出，自测复用）。 */
export const BASELINE_HALF_LIFE_MS = 3 * 86_400_000
export const AFFECTION_HALF_LIFE_MS = 30 * 86_400_000
export const TREND_RECENT_HOURS = 6
export const TREND_PREV_HOURS = 24
export const TREND_THRESHOLD = 0.05
export const SALIENCE_MIN = 0.3
export const SALIENCE_MAX = 1.8
export const EMOTION_CONTEXT_BUDGET = 360
export const SUBTLE_CONTEXT_BUDGET = 240
export const EMOTION_SNAPSHOT_HISTORY = 40

/* ------------------------------------------------------------------ */
/* 基本情绪 episode / 自述印记 / 显著性提醒（nudge）                    */
/* 复杂情绪不做公式：type 只是基本分类，note 是自由第一人称文本。        */
/* ------------------------------------------------------------------ */

export const EPISODE_TYPES = ['joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'curiosity', 'calm']
export const EPISODE_LEVELS = ['light', 'medium', 'heavy']
export const EPISODE_TENDENCIES = ['approach', 'withdraw', 'repair', 'quiet', 'share', 'none']
export const EPISODE_SOURCES = ['self', 'rule', 'tool']
export const EPISODE_RING = 60
export const EPISODE_CAUSE_MAX = 80
export const EPISODE_NOTE_MAX = 120
export const EPISODE_COMPLEX_MAX = 20
export const EPISODE_HISTORY_LIMIT = 30
export const EMOTION_STATE_EPISODES = 5
export const EPISODE_TTL_MINUTES = { min: 30, max: 1440, default: 240 }
export const RULE_EPISODE_TTL_MINUTES = { light: 120, medium: 240, heavy: 480 }
export const NUDGE_TTL_MS = 2 * 3_600_000
export const NUDGE_COOLDOWN_MS = 2 * 3_600_000
export const NUDGE_DAILY_MAX = 3
export const NUDGE_LOG_MAX = 20
export const NUDGE_MIN_SALIENCE = 0.9
export const RULE_EPISODE_MIN_SALIENCE = 1.25
export const RULE_EPISODE_COOLDOWN_MS = 2 * 3_600_000

const EPISODE_TYPE_WORDS = {
  joy: '开心',
  sadness: '难过',
  anger: '生气',
  fear: '有点发紧',
  surprise: '惊讶',
  disgust: '别扭',
  curiosity: '好奇',
  calm: '平静',
}

const EPISODE_TENDENCY_WORDS = {
  approach: '想靠近',
  withdraw: '想退开',
  repair: '想补一句',
  quiet: '想安静',
  share: '想分享',
  none: '',
}

/** 强度 → 轻/中/重（阈值固定，面板与注入共用）。 */
export function episodeLevel(intensity) {
  const value = clamp(Number(intensity) || 0, 0, 1)
  if (value < 0.34) return 'light'
  if (value < 0.67) return 'medium'
  return 'heavy'
}

/** 显著性提醒的规则：命中词/类、基本情绪、倾向、为什么可能落在她身上。 */
const EPISODE_HINT_RULES = [
  {
    key: 'hurt',
    tags: ['被否定'],
    words: ['你根本', '你总是', '你从来', '你懂什么', '没用', '废物', '烦死', '讨厌你', '闭嘴', '滚', '不需要你', '你怎么这样', '失望'],
    type: 'sadness',
    tendency: 'withdraw',
    reason: '那句像在否定她；如果她很在意你的看法，可能会被扎到。',
  },
  {
    key: 'promise',
    tags: ['承诺'],
    words: ['答应', '说好', '约好', '承诺', '保证', '发誓', '等你回来', '别忘'],
    type: null,
    tendency: 'repair',
    reason: '牵涉到答应过的事；她可能会惦记自己有没有做到。',
  },
  {
    key: 'sad',
    tags: ['对方难过'],
    words: ['难过', '伤心', '想哭', '哭了', '崩溃', '撑不住', '好累', '压力好大', '失眠', '委屈', '不想活', '想死'],
    type: 'sadness',
    tendency: 'repair',
    reason: '对方明显不好受；她可能会放不下，想先确认你还好。',
  },
  {
    key: 'old',
    tags: ['旧事'],
    words: ['还记得', '上次', '那时候', '曾经', '去年', '小时候', '当年'],
    type: null,
    tendency: 'quiet',
    reason: '提到了旧事；她可能会想起当时没说完的话。',
  },
  {
    key: 'fresh',
    tags: ['新鲜好玩'],
    words: ['好玩', '有趣', '笑死', '神奇', '居然', '离谱', '绝了', '第一次', '你猜', '新鲜'],
    type: 'curiosity',
    tendency: 'share',
    reason: '这件事新鲜有趣；她可能想追着问两句。',
  },
  {
    key: 'close',
    tags: ['亲近'],
    words: ['想你', '喜欢你', '爱你', '抱抱', '别走', '陪我', '舍不得'],
    type: 'joy',
    tendency: 'approach',
    reason: '话里有亲近；她可能会想接住，也怕接得太用力。',
  },
  {
    key: 'conflict',
    tags: ['摩擦'],
    words: ['吵架', '冷战', '分手', '对不起', '我错了', '道歉', '生气', '不理你'],
    type: 'sadness',
    tendency: 'repair',
    reason: '像是有摩擦；她可能会先软下来，又怕说错。',
  },
]

/** 从一句话里看出“可能落在她身上”的类别；没有就返回 null（普通寒暄/夸奖不触发）。 */
export function episodeHintOf(text) {
  const s = String(text ?? '')
  if (!s.trim()) return null
  for (const rule of EPISODE_HINT_RULES) {
    const hit = rule.words.find((word) => s.includes(word))
    if (!hit) continue
    const type = rule.key === 'conflict' ? (/(对不起|我错了|道歉)/.test(s) ? 'sadness' : 'anger') : rule.type
    return {
      key: rule.key,
      tags: [rule.tags[0], hit].filter(Boolean),
      hit,
      type: EPISODE_TYPES.includes(type) ? type : null,
      tendency: rule.tendency,
      reason: rule.reason,
    }
  }
  return null
}

function normalizeEpisodeRow(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  // 完全空/无意义的一行直接丢弃，避免旧文件里的脏数据变成一条“默认情绪”。
  if (!raw.id && !raw.type && !raw.note && !raw.cause && !raw.complex && raw.startedAt === undefined && raw.expiresAt === undefined) return null
  const startedAt = Math.max(0, Math.round(finiteNumber(raw.startedAt, now)))
  let expiresAt = Math.max(0, Math.round(finiteNumber(raw.expiresAt, startedAt + EPISODE_TTL_MINUTES.default * 60_000)))
  if (!(expiresAt > startedAt)) expiresAt = startedAt + EPISODE_TTL_MINUTES.default * 60_000
  const intensity = clamp(finiteNumber(raw.intensity, 0.5), 0, 1)
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : randomUUID(),
    type: EPISODE_TYPES.includes(raw.type) ? raw.type : null,
    intensity: round3(intensity),
    level: EPISODE_LEVELS.includes(raw.level) ? raw.level : episodeLevel(intensity),
    cause: codepointSlice(String(raw.cause ?? '').trim(), EPISODE_CAUSE_MAX),
    note: codepointSlice(String(raw.note ?? '').trim(), EPISODE_NOTE_MAX),
    complex: codepointSlice(String(raw.complex ?? '').trim(), EPISODE_COMPLEX_MAX),
    tendency: EPISODE_TENDENCIES.includes(raw.tendency) ? raw.tendency : 'none',
    source: EPISODE_SOURCES.includes(raw.source) ? raw.source : 'rule',
    startedAt,
    expiresAt,
    updatedAt: Math.max(0, Math.round(finiteNumber(raw.updatedAt, startedAt))),
  }
}

/** 归一化 episode ring：补默认、坏条丢弃、保留最近 60 条（过期不删，等被裁）。 */
export function normalizeEmotionEpisodes(emotion, now = Date.now()) {
  const source = emotion && typeof emotion === 'object' ? emotion : {}
  const rows = Array.isArray(source.episodes) ? source.episodes : []
  const next = rows.map((row) => normalizeEpisodeRow(row, now)).filter(Boolean).slice(-EPISODE_RING)
  source.episodes = next
  return next
}

function normalizeNudgeRow(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = Math.max(0, Math.round(finiteNumber(raw.at, now)))
  let expiresAt = Math.max(0, Math.round(finiteNumber(raw.expiresAt, at + NUDGE_TTL_MS)))
  if (!(expiresAt > at)) expiresAt = at + NUDGE_TTL_MS
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => codepointSlice(String(tag ?? '').trim(), 16))
    .filter(Boolean)
    .slice(0, 6)
  const reasons = codepointSlice(String(raw.reasons ?? '').trim(), 120)
  if (!tags.length && !reasons) return null
  return { tags, reasons, at, expiresAt }
}

/** 归一化 nudge：null / 坏条丢弃；过期但结构合法的仍保留（由 activeNudge 忽略）。 */
export function normalizeEmotionNudge(emotion, now = Date.now()) {
  const source = emotion && typeof emotion === 'object' ? emotion : {}
  source.nudge = normalizeNudgeRow(source.nudge, now)
  return source.nudge
}

export function normalizeNudgeLog(value) {
  return (Array.isArray(value) ? value : [])
    .map((at) => Math.round(finiteNumber(at, 0)))
    .filter((at) => at > 0)
    .sort((left, right) => left - right)
    .slice(-NUDGE_LOG_MAX)
}

/** 旧文件兼容入口：episodes / nudge / nudgeLog 缺省补齐。返回同一个 emotion 对象。 */
export function ensureEmotionExtras(emotion, now = Date.now()) {
  const source = emotion && typeof emotion === 'object' ? emotion : {}
  normalizeEmotionEpisodes(source, now)
  normalizeEmotionNudge(source, now)
  source.nudgeLog = normalizeNudgeLog(source.nudgeLog)
  // 旧文件可能只有 nudge 没有 log：把仍存在的提醒补进冷却记录，避免重启后立刻再提醒。
  const nudgeAt = Math.round(Number(source.nudge?.at) || 0)
  if (nudgeAt > 0 && !source.nudgeLog.includes(nudgeAt)) {
    source.nudgeLog = normalizeNudgeLog([...source.nudgeLog, nudgeAt])
  }
  // nudge 过期就不再算“存在”（冷却记录还在 nudgeLog 里）；episode 过期则保留到被 ring 裁掉。
  if (source.nudge && source.nudge.expiresAt <= now) source.nudge = null
  return source
}

/** 当前仍有效的 episode（强 → 弱；同强度新的在前）。过期条目忽略但保留在 ring 里。 */
export function activeEpisodes(emotion, now = Date.now()) {
  const rows = normalizeEmotionEpisodes(emotion, now)
  return rows
    .filter((episode) => episode.expiresAt > now)
    .sort((left, right) => (right.intensity - left.intensity) || (right.startedAt - left.startedAt))
}

/**
 * 历史视图：ring 里最近的 episode（含过期条目），按 startedAt 倒序；
 * 默认最多 EPISODE_HISTORY_LIMIT (30) 条，limit 会被夹到 1..30。
 */
export function episodeHistory(emotion, limit = EPISODE_HISTORY_LIMIT, now = Date.now()) {
  const rows = normalizeEmotionEpisodes(emotion, now)
  // startedAt 相同（同一毫秒写入）时按 ring 顺序兜底：后写进来的更新，排在前面。
  const ordered = rows
    .map((episode, index) => ({ episode, index }))
    .sort((left, right) => (right.episode.startedAt - left.episode.startedAt)
      || (right.episode.updatedAt - left.episode.updatedAt)
      || (right.index - left.index))
    .map((entry) => entry.episode)
  const wanted = Number(limit)
  const size = clamp(Number.isFinite(wanted) ? Math.round(wanted) : EPISODE_HISTORY_LIMIT, 1, EPISODE_HISTORY_LIMIT)
  return ordered.slice(0, size).map((episode) => episodeSnapshot(episode, now))
}

/** 当前仍有效的显著性提醒；过期返回 null。 */
export function activeNudge(emotion, now = Date.now()) {
  const nudge = normalizeEmotionNudge(emotion, now)
  return nudge && nudge.expiresAt > now ? nudge : null
}

/** 往 ring 里追加一条 episode（超 60 丢最旧）。返回归一化后的 episode。 */
export function addEpisode(emotion, episode, now = Date.now()) {
  const source = ensureEmotionExtras(emotion, now)
  const normalized = normalizeEpisodeRow(episode, now)
  if (!normalized) return null
  source.episodes.push(normalized)
  if (source.episodes.length > EPISODE_RING) source.episodes.splice(0, source.episodes.length - EPISODE_RING)
  return normalized
}

/** 清掉显著性提醒（面板「知道了」/ soul_feel 写入后）。返回之前是否有。 */
export function clearNudge(emotion) {
  if (!emotion || typeof emotion !== 'object') return false
  const had = !!emotion.nudge
  emotion.nudge = null
  return had
}

const FEEL_BUMPS = {
  joy: { valence: 0.12, arousal: 0.05, affection: 0.03, energy: 0.04 },
  sadness: { valence: -0.12, arousal: -0.02, affection: 0.01, energy: -0.05 },
  anger: { valence: -0.12, arousal: 0.12, affection: -0.03, energy: 0.02 },
  fear: { valence: -0.08, arousal: 0.12, affection: 0, energy: -0.05 },
  surprise: { valence: 0.02, arousal: 0.14, affection: 0, energy: 0.01 },
  disgust: { valence: -0.08, arousal: 0.05, affection: -0.03, energy: 0 },
  curiosity: { valence: 0.05, arousal: 0.1, affection: 0.01, energy: 0.04 },
  calm: { valence: 0.04, arousal: -0.1, affection: 0.01, energy: 0.02 },
}

/**
 * 一次 soul_feel 的轻量心境积分：四维各自小 delta，幅度由 intensity 限制；
 * 不做大幅跳变，也不覆盖由事件驱动的主情绪。
 */
export function applyFeelBump(soul, episode, config = {}, now = Date.now()) {
  const emotion = soul?.emotion
  if (!emotion || typeof emotion !== 'object' || !emotion.transient) return { before: null, after: null }
  ensureEmotionExtras(emotion, now)
  if (!emotion.drive || typeof emotion.drive !== 'object') {
    emotion.drive = { energy: 0.7, socialNeed: 0.35, updatedAt: now }
  }
  const before = decayedEmotion(soul, config, now)
  const type = EPISODE_TYPES.includes(episode?.type) ? episode.type : null
  const base = FEEL_BUMPS[type] || { valence: 0, arousal: 0.02, affection: 0.01, energy: 0 }
  const k = clamp(finiteNumber(episode?.intensity, 0.5), 0, 1)
  const dv = clamp(base.valence * k, -0.15, 0.15)
  const da = clamp(base.arousal * k, -0.15, 0.15)
  const dAff = clamp(base.affection * k, -0.05, 0.05)
  const dEnergy = clamp(base.energy * k, -0.06, 0.06)
  const t = emotion.transient
  t.valence = clamp(finiteNumber(t.valence, 0) + dv, -1, 1)
  t.arousal = clamp(finiteNumber(t.arousal, 0.2) + da, 0, 1)
  emotion.affection = clamp(finiteNumber(emotion.affection, 0.5) + dAff, 0, 1)
  emotion.affectionUpdatedAt = now
  emotion.drive.energy = clamp(finiteNumber(emotion.drive.energy, 0.7) + dEnergy, 0, 1)
  emotion.drive.updatedAt = now
  t.label = type ? EPISODE_TYPE_WORDS[type] ?? planeLabel(t.valence, t.arousal) : planeLabel(t.valence, t.arousal)
  t.cause = codepointSlice(String(episode?.cause ?? '').trim() || '自己的一点情绪', 40)
  t.source = 'self'
  t.updatedAt = now
  t.intensity = computeIntensity(t, emotion.mood)
  const moodK = Math.max(0.03, Math.min(0.08, 0.04 + k * 0.04))
  emotion.mood.valence += ((Number(t.valence) || 0) - (Number(emotion.mood.valence) || 0)) * moodK
  emotion.mood.arousal += ((Number(t.arousal) || 0.2) - (Number(emotion.mood.arousal) || 0.24)) * moodK * 0.6
  emotion.mood.updatedAt = now
  emotion.source = 'self'
  pushHistory(emotion, {
    at: now,
    valence: t.valence,
    arousal: t.arousal,
    affection: emotion.affection,
    energy: emotion.drive.energy,
    label: t.label,
    cause: t.cause,
    weight: 0.6,
  })
  const after = decayedEmotion(soul, config, now)
  return { before, after }
}

function lastRuleEpisodeAt(emotion) {
  const rows = Array.isArray(emotion?.episodes) ? emotion.episodes : []
  let last = 0
  for (const row of rows) {
    if (row && row.source === 'rule' && Number(row.startedAt) > last) last = Number(row.startedAt)
  }
  return last
}

function nudgeDayCount(emotion, now) {
  const key = localDayKey(now)
  return normalizeNudgeLog(emotion?.nudgeLog).filter((at) => localDayKey(at) === key).length
}

/** 规则强度够时直接形成 episode（source='rule'）；有 2 小时冷却。 */
export function maybeRuleEpisode(soul, appraisal, config = {}, now = Date.now()) {
  const emotion = soul?.emotion
  if (!emotion || typeof emotion !== 'object') return null
  const hint = appraisal?.hint || episodeHintOf(appraisal?.text ?? '')
  if (!hint) return null
  const salience = salienceOfAppraisal(appraisal)
  if (salience < RULE_EPISODE_MIN_SALIENCE) return null
  ensureEmotionExtras(emotion, now)
  const last = lastRuleEpisodeAt(emotion)
  if (last > 0 && now - last < RULE_EPISODE_COOLDOWN_MS) return null
  const intensity = clamp(0.35 + (salience - RULE_EPISODE_MIN_SALIENCE) * 0.55, 0.3, 0.95)
  const level = episodeLevel(intensity)
  const episode = addEpisode(emotion, {
    type: hint.type,
    intensity,
    level,
    cause: codepointSlice(`用户提到「${hint.hit}」`, EPISODE_CAUSE_MAX),
    note: '',
    tendency: hint.tendency,
    source: 'rule',
    startedAt: now,
    expiresAt: now + (RULE_EPISODE_TTL_MINUTES[level] || 240) * 60_000,
    updatedAt: now,
  }, now)
  if (episode) {
    const nudge = emotion.nudge
    if (nudge && Array.isArray(nudge.tags) && nudge.tags.some((tag) => hint.tags.includes(tag))) {
      emotion.nudge = null
    }
  }
  return episode
}

/** 强度没到直接形成 episode 时，留一条显著性提醒；2 小时 1 条、每天最多 3 条。 */
export function maybeNudge(soul, appraisal, now = Date.now()) {
  const emotion = soul?.emotion
  if (!emotion || typeof emotion !== 'object') return null
  const hint = appraisal?.hint || episodeHintOf(appraisal?.text ?? '')
  if (!hint) return null
  const salience = salienceOfAppraisal(appraisal)
  if (salience < NUDGE_MIN_SALIENCE) return null
  if (salience >= RULE_EPISODE_MIN_SALIENCE) return null
  ensureEmotionExtras(emotion, now)
  if (nudgeDayCount(emotion, now) >= NUDGE_DAILY_MAX) return null
  const log = normalizeNudgeLog(emotion.nudgeLog)
  const last = Math.max(log[log.length - 1] || 0, Math.round(Number(emotion.nudge?.at) || 0))
  if (last > 0 && now - last < NUDGE_COOLDOWN_MS) return null
  const nudge = {
    tags: [...new Set(hint.tags)].slice(0, 4),
    reasons: codepointSlice(hint.reason, 120),
    at: now,
    expiresAt: now + NUDGE_TTL_MS,
  }
  emotion.nudge = nudge
  emotion.nudgeLog = [...log, now].slice(-NUDGE_LOG_MAX)
  return nudge
}

/** episode → 一句自然语言（note 优先原文；不写数字/英文枚举）。 */
export function describeEpisode(episode) {
  const ep = episode && typeof episode === 'object' ? episode : {}
  const level = EPISODE_LEVELS.includes(ep.level) ? ep.level : episodeLevel(ep.intensity)
  const prefix = level === 'light' ? '还有点' : level === 'medium' ? '有些' : '很'
  const typeWord = EPISODE_TYPE_WORDS[ep.type] || '说不上来的感觉'
  const body = String(ep.note ?? '').trim() || String(ep.cause ?? '').trim()
  const tendency = EPISODE_TENDENCY_WORDS[ep.tendency] || ''
  return `你心里${prefix}${typeWord}${body ? `：${body}` : ''}${tendency ? `，${tendency}` : ''}。`
}

/** nudge → 很轻的一句旁注（不出现分数、不命令）。 */
export function describeNudge(nudge) {
  const info = nudge && typeof nudge === 'object' ? nudge : {}
  const rawReasons = String(info.reasons ?? '').trim() || (Array.isArray(info.tags) ? info.tags.join('、') : '')
  const reasons = rawReasons.replace(/[。；;，,\s]+$/, '')
  if (!reasons) return ''
  return `（刚才那句可能有点落在你身上：${reasons}；要不要留一句，你自己定。）`
}

/** 面板快照用：只暴露渲染需要的最小字段。 */
export function episodeSnapshot(episode, now = Date.now()) {
  const ep = episode && typeof episode === 'object' ? episode : {}
  const expiresAt = Math.round(finiteNumber(ep.expiresAt, 0))
  return {
    id: String(ep.id ?? ''),
    type: EPISODE_TYPES.includes(ep.type) ? ep.type : null,
    intensity: round3(clamp(finiteNumber(ep.intensity, 0.5), 0, 1)),
    level: EPISODE_LEVELS.includes(ep.level) ? ep.level : episodeLevel(ep.intensity),
    cause: String(ep.cause ?? ''),
    note: String(ep.note ?? ''),
    tendency: EPISODE_TENDENCIES.includes(ep.tendency) ? ep.tendency : 'none',
    source: EPISODE_SOURCES.includes(ep.source) ? ep.source : 'rule',
    startedAt: Math.round(finiteNumber(ep.startedAt, 0)),
    expiresAt,
    updatedAt: Math.round(finiteNumber(ep.updatedAt, 0)),
    complex: String(ep.complex ?? ''),
    expired: expiresAt <= now,
  }
}

export function nudgeSnapshot(nudge) {
  if (!nudge || typeof nudge !== 'object') return null
  return {
    tags: (Array.isArray(nudge.tags) ? nudge.tags : []).map((tag) => String(tag)).slice(0, 6),
    reasons: String(nudge.reasons ?? ''),
    at: Math.round(finiteNumber(nudge.at, 0)),
    expiresAt: Math.round(finiteNumber(nudge.expiresAt, 0)),
  }
}

const STYLE_HINTS = {
  兴奋: '可以接梗、说快点、多互动',
  开心: '可以轻松一点，偶尔打趣',
  烦躁: '克制一点，别怼，先把语气放软',
  沮丧: '温和一点，多给一点肯定',
  低落: '话少一点、语气软一点，别急着开新话题，不用解释原因',
  平静偏愉: '自然即可',
  平静: '自然即可',
  困倦: '句子短一点，可以早点收尾',
}

export function planeLabel(v, a) {
  if (v > 0.3) return a > 0.55 ? '兴奋' : '开心'
  if (v < -0.3) return a > 0.55 ? '烦躁' : '沮丧'
  if (v < -0.1) return '低落'
  if (v > 0.1) return '平静偏愉'
  return '平静'
}

/**
 * 表达方式（自由文本）→ 注入模式：
 * - 空 / 含「关闭」/ off / none → 'off'（不注入情绪上下文）
 * - 含「直白」/ explicit → 'explicit'（可以自然说出感受，但仍不报数值）
 * - 其他（含蓄、自定义描述）→ 'subtle'（只影响语气，不直接报情绪）
 * 旧的 'subtle' 字符串仍按 subtle 处理，保证旧配置/旧测试不受影响。
 */
export function normalizeStyle(value) {
  const text = String(value ?? '').trim()
  if (!text) return 'off'
  const lower = text.toLowerCase()
  if (text.includes('关闭') || lower === 'off' || lower === 'none') return 'off'
  if (text.includes('直白') || lower === 'explicit') return 'explicit'
  return 'subtle'
}

/** 用户写的表达指导原文（旧的 subtle / explicit / off 三档不当作指导）。 */
export function expressionGuidance(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (lower === 'subtle' || lower === 'explicit' || lower === 'off' || lower === 'none') return ''
  return codepointSlice(text, 200)
}

/** 规则快评：返回 Appraisal（不读配置、不写状态）。 */
export function ruleAppraise(text, ctx = {}) {
  const s = String(text ?? '')
  let valence = 0
  let arousal = 0
  let affection = 0
  let energy = 0
  const hits = []
  for (const [word, delta] of Object.entries(LEXICON)) {
    if (s.includes(word)) {
      valence += delta
      hits.push(word)
    }
  }
  if (/[!！]{2,}|哈哈{2,}|笑死/.test(s)) arousal += 0.2
  if (/[?？]$/.test(s)) affection += 0.05
  if (/^(哦|嗯|行|好|随便|都行|算了)[。.!！…]*$/.test(s.trim())) {
    valence -= 0.1
    affection -= 0.05
  }
  if (/(晚安|早安|睡吧|早点休息)/.test(s)) affection += 0.1
  if (/(想你|喜欢你|抱抱|爱你)/.test(s)) {
    affection += 0.25
    valence += 0.2
  }
  if (/(你辛苦了|谢谢你|多亏你)/.test(s)) affection += 0.15
  if (/(滚|闭嘴|别烦我|讨厌你)/.test(s)) {
    valence -= 0.5
    affection -= 0.3
  }
  if (/(在吗|在不在|陪我)/.test(s)) {
    affection += 0.05
    energy += 0.02
  }
  valence = clamp(valence / 2, -1, 1)
  const irony = IRONY_MARKS.some((mark) => s.includes(mark))
  const cause = hits.slice(0, 3).join('、')
  const appraisal = {
    valenceDelta: valence,
    arousalDelta: clamp(arousal, -1, 1),
    affectionDelta: clamp(affection, -1, 1),
    energyDelta: clamp(energy, -1, 1),
    label: undefined,
    cause: cause ? `用户提到「${cause}」` : (String(ctx.fallbackCause ?? '对话')).slice(0, 30),
    confidence: irony ? 0.4 : 0.5,
    irony,
  }
  // 事件显著性：冲突/道歉/表白/约定/重要分享高，日常寒暄低（0.3~1.8）。
  appraisal.salience = salienceOf(s, appraisal)
  // 扩展：这一句“可能落在她身上”的类别（rule episode / nudge 共用）。
  appraisal.hint = episodeHintOf(s)
  return appraisal
}

export function personalityGain(traits = {}) {
  const warmth = clamp(Number(traits.warmth) || 0.72, 0, 1)
  const playfulness = clamp(Number(traits.playfulness) || 0.55, 0, 1)
  const sensitivity = clamp(Number(traits.sensitivity) || 0.6, 0, 1)
  return {
    valence: 0.85 + sensitivity * 0.5,
    negativeValence: (0.85 + sensitivity * 0.5) * (0.9 + sensitivity * 0.4),
    arousal: 0.8 + playfulness * 0.6,
    affection: 0.8 + warmth * 0.5,
  }
}

/** 基线 = 性格偏移 + 昼夜节律（10 点最清醒）。 */
export function baseOf(traits = {}, now = Date.now()) {
  const warmth = clamp(Number(traits.warmth) || 0.72, 0, 1)
  const playfulness = clamp(Number(traits.playfulness) || 0.55, 0, 1)
  const energyTrait = clamp(Number(traits.energy) || 0.55, 0, 1)
  const hour = new Date(now).getHours()
  const circadian = 1 - 0.35 * Math.abs(Math.cos(((hour - 10) / 24) * 2 * Math.PI))
  return {
    valence: warmth * 0.2 - 0.1,
    arousal: 0.2 + playfulness * 0.35,
    energy: clamp(0.3 + 0.45 * circadian + energyTrait * 0.2, 0, 1),
  }
}

export function decayTo(value, base, updatedAt, halfLifeMs, now) {
  if (!halfLifeMs || halfLifeMs <= 0) return value
  const anchor = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : now
  const h = Math.max(0, now - anchor) / halfLifeMs
  return base + (value - base) * Math.pow(0.5, h)
}

// ---------- 长期基准 / 历史 / 趋势 ----------

const finiteNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 默认长期基准：首次用性格 + 昼夜推出来的值兜底，之后交给 EWMA 跟随历史。 */
export function defaultBaseline(traits = {}, now = Date.now()) {
  const base = baseOf(traits, now)
  return {
    valence: clamp(finiteNumber(base.valence, 0), -1, 1),
    arousal: clamp(finiteNumber(base.arousal, 0.2), 0, 1),
    affection: 0.5,
    energy: clamp(finiteNumber(base.energy, 0.7), 0, 1),
    updatedAt: now,
  }
}

/** 读当前基准（纯函数）：缺失/坏值回落默认，不写状态。 */
export function baselineOf(emotion, traits = {}, now = Date.now()) {
  const raw = emotion && typeof emotion === 'object' ? emotion.baseline : null
  const fallback = defaultBaseline(traits, now)
  if (!raw || typeof raw !== 'object') return fallback
  return {
    valence: clamp(finiteNumber(raw.valence, fallback.valence), -1, 1),
    arousal: clamp(finiteNumber(raw.arousal, fallback.arousal), 0, 1),
    affection: clamp(finiteNumber(raw.affection, fallback.affection), 0, 1),
    energy: clamp(finiteNumber(raw.energy, fallback.energy), 0, 1),
    updatedAt: finiteNumber(raw.updatedAt, now),
  }
}

/** 时间加权 EWMA：每过一个半衰期吃掉一半差距（不是按调用次数）。 */
export function ewmaToward(previous, target, updatedAt, now, halfLifeMs) {
  const life = finiteNumber(halfLifeMs, 0)
  if (!(life > 0)) return target
  const elapsed = Math.max(0, now - finiteNumber(updatedAt, now))
  const alpha = 1 - Math.pow(0.5, elapsed / life)
  return previous + (target - previous) * alpha
}

/**
 * 基准缓慢跟随历史（半衰期约 3 天）；没有 baseline 时用当前值初始化（"初始取首条"）。
 * 会写回 emotion.baseline，返回新基准。
 */
export function updateBaseline(emotion, values = {}, now = Date.now(), halfLifeMs = BASELINE_HALF_LIFE_MS) {
  const raw = emotion && typeof emotion === 'object' ? emotion : {}
  const hasPrevious = raw.baseline !== null && typeof raw.baseline === 'object'
  const fallback = defaultBaseline({}, now)
  const previous = hasPrevious ? baselineOf(raw, {}, now) : null
  const pick = (key, fallbackValue, min, max) => clamp(finiteNumber(values[key], fallbackValue), min, max)
  const next = hasPrevious
    ? {
        valence: clamp(ewmaToward(previous.valence, pick('valence', previous.valence, -1, 1), previous.updatedAt, now, halfLifeMs), -1, 1),
        arousal: clamp(ewmaToward(previous.arousal, pick('arousal', previous.arousal, 0, 1), previous.updatedAt, now, halfLifeMs), 0, 1),
        affection: clamp(ewmaToward(previous.affection, pick('affection', previous.affection, 0, 1), previous.updatedAt, now, halfLifeMs), 0, 1),
        energy: clamp(ewmaToward(previous.energy, pick('energy', previous.energy, 0, 1), previous.updatedAt, now, halfLifeMs), 0, 1),
        updatedAt: now,
      }
    : {
        valence: pick('valence', fallback.valence, -1, 1),
        arousal: pick('arousal', fallback.arousal, 0, 1),
        affection: pick('affection', fallback.affection, 0, 1),
        energy: pick('energy', fallback.energy, 0, 1),
        updatedAt: now,
      }
  if (emotion && typeof emotion === 'object') emotion.baseline = next
  return next
}

/** 往 ring 里压一条情绪历史（超 240 丢最旧）。会写回 emotion.history。 */
export function pushHistory(emotion, entry = {}, max = EMOTION_HISTORY_MAX) {
  const raw = emotion && typeof emotion === 'object' ? emotion : {}
  const history = Array.isArray(raw.history) ? raw.history : []
  history.push({
    at: finiteNumber(entry.at, Date.now()),
    valence: clamp(finiteNumber(entry.valence, 0), -1, 1),
    arousal: clamp(finiteNumber(entry.arousal, 0.2), 0, 1),
    affection: clamp(finiteNumber(entry.affection, 0.5), 0, 1),
    energy: clamp(finiteNumber(entry.energy, 0.7), 0, 1),
    label: codepointSlice(String(entry.label ?? ''), 4),
    cause: codepointSlice(String(entry.cause ?? ''), 40),
    weight: clamp(finiteNumber(entry.weight, 1), SALIENCE_MIN, SALIENCE_MAX),
  })
  const cap = Math.max(1, Math.round(finiteNumber(max, EMOTION_HISTORY_MAX)))
  if (history.length > cap) history.splice(0, history.length - cap)
  if (emotion && typeof emotion === 'object') emotion.history = history
  return history
}

/** 面板用快照：旧→新，最多 limit 条（默认 60）。 */
export function historySnapshot(emotion, limit = 60) {
  const list = Array.isArray(emotion?.history) ? emotion.history : []
  const rows = list
    .filter((row) => row && typeof row === 'object' && Number.isFinite(Number(row.at)))
    .map((row) => ({
      at: Math.round(Number(row.at)),
      valence: round3(clamp(finiteNumber(row.valence, 0), -1, 1)),
      arousal: round3(clamp(finiteNumber(row.arousal, 0.2), 0, 1)),
      affection: round3(clamp(finiteNumber(row.affection, 0.5), 0, 1)),
      energy: round3(clamp(finiteNumber(row.energy, 0.7), 0, 1)),
      label: String(row.label ?? '').slice(0, 4),
      cause: String(row.cause ?? '').slice(0, 40),
      weight: round3(clamp(finiteNumber(row.weight, 1), SALIENCE_MIN, SALIENCE_MAX)),
    }))
  const cap = Math.max(1, Math.round(finiteNumber(limit, 60)))
  return rows.slice(-cap)
}

/** 最近一次变化（面板/快照展示用）。 */
export function lastChangeOf(emotion) {
  const rows = historySnapshot(emotion, 1)
  const last = rows[rows.length - 1]
  if (!last) return { at: 0, label: '', cause: '', weight: 0 }
  return { at: last.at, label: last.label, cause: last.cause, weight: last.weight }
}

/** 四维压成一个 0..1 的综合分（valence 折算进 0..1），只用于趋势/基准对比。 */
export function compositeOf(values = {}) {
  const v = (clamp(finiteNumber(values.valence, 0), -1, 1) + 1) / 2
  const a = clamp(finiteNumber(values.arousal, 0.2), 0, 1)
  const affection = clamp(finiteNumber(values.affection, 0.5), 0, 1)
  const energy = clamp(finiteNumber(values.energy, 0.7), 0, 1)
  return v * 0.4 + a * 0.2 + affection * 0.25 + energy * 0.15
}

function meanOf(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * 趋势：最近 6 小时均值 vs 前 24 小时均值（没有前 24 小时就退回 baseline）。
 * Δ > +0.05 走高、Δ < -0.05 走低，否则平稳；volatility = 最近窗口的综合分标准差。
 */
export function computeTrend(emotion, now = Date.now(), current = null) {
  const rows = historySnapshot(emotion, EMOTION_HISTORY_MAX)
  const recentFrom = now - TREND_RECENT_HOURS * 3_600_000
  const prevFrom = now - (TREND_RECENT_HOURS + TREND_PREV_HOURS) * 3_600_000
  const recentValues = rows.filter((row) => row.at >= recentFrom).map(compositeOf)
  const previousValues = rows.filter((row) => row.at >= prevFrom && row.at < recentFrom).map(compositeOf)
  const baseline = baselineOf(emotion, {}, now)
  const currentValue = current ? compositeOf(current) : compositeOf(baseline)
  const recentMean = recentValues.length ? meanOf(recentValues) : currentValue
  const referenceMean = previousValues.length ? meanOf(previousValues) : compositeOf(baseline)
  const delta = clamp(recentMean - referenceMean, -1, 1)
  const volatility = recentValues.length > 1
    ? clamp(Math.sqrt(meanOf(recentValues.map((value) => (value - recentMean) ** 2))), 0, 1)
    : 0
  return {
    direction: delta > TREND_THRESHOLD ? 'up' : delta < -TREND_THRESHOLD ? 'down' : 'flat',
    delta: round3(delta),
    windowHours: TREND_RECENT_HOURS,
    volatility: round3(volatility),
    reference: previousValues.length ? 'history' : 'baseline',
  }
}

// ---------- 事件显著性（salience） ----------

/** 高权重：冲突 / 道歉 / 表白 / 约定 / 重要分享（≥1.3）。 */
export const SALIENCE_HIGH_RE = /(分手|吵架|冷战|道歉|对不起|我错了|和好|表白|喜欢你|爱你|想你|约定|说好了|答应|承诺|发誓|重要|秘密|只有你|别走|别离开|去世|走了|生病|住院|手术|离职|辞职|搬家|结婚|怀孕|面试|生日|纪念日|第一次|最后一次)/
/** 低权重：日常寒暄 / 极短应答（≤0.6）。 */
export const SALIENCE_LOW_RE = /^(嗯+|哦+|噢+|好的?|行|在吗|在不在|早|早安|晚安|哈+|嘿嘿|收到|没事|随便|都行|算了|吃了吗|睡了|拜拜|88|好呀|好嘞|辛苦了)[。.!！…~～\s]*$/

/** 一条消息对情绪的冲击权重（0.3~1.8）；规则侧默认 1。 */
export function salienceOf(text, appraisal = {}) {
  const s = String(text ?? '').trim()
  const ap = appraisal && typeof appraisal === 'object' ? appraisal : {}
  const high = SALIENCE_HIGH_RE.test(s)
  const low = SALIENCE_LOW_RE.test(s)
  let weight = 1
  if (high) {
    weight = 1.3
    if (/(分手|去世|走了|住院|手术|辞职|离职|结婚|怀孕|表白)/.test(s)) weight = 1.5
    if (ap.irony === true) weight += 0.1
  } else if (low) {
    weight = 0.4
  } else {
    // 重要分享：明显长的一段话（1.3）；一般分享（1.15）；极短应答（0.8）。
    const length = codepointLength(s)
    if (length >= 160) weight = 1.3
    else if (length >= 90) weight = 1.15
    else if (length > 0 && length <= 3) weight = 0.8
  }
  const magnitude = Math.max(
    Math.abs(finiteNumber(ap.valenceDelta, 0)),
    Math.abs(finiteNumber(ap.affectionDelta, 0)),
    Math.abs(finiteNumber(ap.arousalDelta, 0)) * 0.6,
  )
  if (!low && magnitude >= 0.5) weight += 0.1
  return round3(clamp(weight, SALIENCE_MIN, SALIENCE_MAX))
}

/** LLM 复核给了 intensity 时乘进规则 salience，再夹回 0.3~1.8。 */
export function salienceWithIntensity(base, intensity) {
  const factor = clamp(finiteNumber(intensity, 1), 0, 2)
  return round3(clamp(finiteNumber(base, 1) * factor, SALIENCE_MIN, SALIENCE_MAX))
}

/** appraisal 上的最终权重：显式 salience 优先，否则按原文估一个。 */
export function salienceOfAppraisal(appraisal = {}) {
  const ap = appraisal && typeof appraisal === 'object' ? appraisal : {}
  const explicit = Number(ap.salience)
  if (Number.isFinite(explicit)) return clamp(explicit, SALIENCE_MIN, SALIENCE_MAX)
  return salienceOf(ap.text ?? '', ap)
}

export function computeIntensity(transient, mood) {
  const v = clamp(Number(transient?.valence) || 0, -1, 1)
  const a = clamp(Number(transient?.arousal) || 0, 0, 1)
  const mv = clamp(Number(mood?.valence) || 0, -1, 1)
  return clamp(Math.max(Math.abs(v), a * 0.8, Math.abs(v - mv) * 1.2), 0, 1)
}

function halfLivesOf(config = {}) {
  const hours = clamp(Number(config.emotionDecayValenceHours) || 3, 0.1, 240)
  const minutes = clamp(Number(config.emotionDecayArousalMinutes) || 45, 1, 24 * 60)
  const energyHours = clamp(Number(config.emotionDecayEnergyHours) || 6, 0.1, 240)
  return {
    valenceMs: hours * 3_600_000,
    arousalMs: minutes * 60_000,
    energyMs: energyHours * 3_600_000,
  }
}

/**
 * 读取瞬态情绪（纯函数，不写状态）：指数半衰 + 强度重算 + 社交需求随闲置增长。
 * 幂等：同一 now 调用多次结果一致；衰减不推进 updatedAt。
 */
export function decayedEmotion(soul, config = {}, now = Date.now()) {
  const raw = soul?.emotion ?? {}
  const t = raw.transient ?? {}
  const mood = raw.mood ?? {}
  const drive = raw.drive ?? {}
  const traits = soul?.identity?.traits ?? {}
  // 衰减目标 = 长期基准（不再回中性/性格基线）；基准本身由 appraisal 时的 EWMA 缓慢跟随历史。
  const baseline = baselineOf(raw, traits, now)
  const halfLife = halfLivesOf(config)
  const updatedAt = Number(t.updatedAt) || now
  const valence = clamp(decayTo(clamp(Number(t.valence) || 0, -1, 1), baseline.valence, updatedAt, halfLife.valenceMs, now), -1, 1)
  const arousal = clamp(decayTo(clamp(Number(t.arousal) || 0.2, 0, 1), baseline.arousal, updatedAt, halfLife.arousalMs, now), 0, 1)
  const energy = clamp(decayTo(clamp(Number(drive.energy) || 0.7, 0, 1), baseline.energy, Number(drive.updatedAt) || now, halfLife.energyMs, now), 0, 1)
  // 心情标签：保留 LLM/自报的自由标签 2 小时内，否则按平面重算
  const source = String(t.source ?? 'rule')
  const freeRecent = (source === 'llm' || source === 'self') && now - updatedAt < 2 * 3_600_000
  const label = freeRecent && t.label ? String(t.label).slice(0, 4) : planeLabel(valence, arousal)
  const moodView = {
    valence: clamp(decayTo(clamp(Number(mood.valence) || 0, -1, 1), baseline.valence, Number(mood.updatedAt) || now, halfLife.valenceMs * 3, now), -1, 1),
    arousal: clamp(decayTo(clamp(Number(mood.arousal) || 0.24, 0, 1), baseline.arousal, Number(mood.updatedAt) || now, halfLife.arousalMs * 3, now), 0, 1),
  }
  // affection 的时间常数沿用原来的 30 天（旧实现只在 >0.85 时朝 0.85 收），现在朝基准收。
  const affection = clamp(
    decayTo(clamp(Number(raw.affection) || 0.5, 0, 1), baseline.affection, Number(raw.affectionUpdatedAt) || now, AFFECTION_HALF_LIFE_MS, now),
    0, 1,
  )
  const lastUserAt = Number(soul?.relation?.lastUserAt) || 0
  const idleHours = lastUserAt > 0 ? Math.max(0, now - lastUserAt) / 3_600_000 : 0
  const socialNeed = clamp(clamp(Number(drive.socialNeed) || 0.35, 0, 1) + Math.min(0.6, idleHours * 0.04), 0, 1)
  const transient = { valence, arousal, label, intensity: 0, cause: String(t.cause ?? ''), source, updatedAt }
  transient.intensity = computeIntensity(transient, moodView)
  return {
    transient,
    mood: moodView,
    drive: { energy, socialNeed },
    affection,
    baseline,
    trend: computeTrend(raw, now, { valence, arousal, affection, energy }),
    lastRecheckTurn: Number(raw.lastRecheckTurn) || -999,
    source,
    style: normalizeStyle(config.expressionStyle),
    stage: STAGES.includes(soul?.relation?.stage) ? soul.relation.stage : 'stranger',
    stageLabel: stageLabel(soul?.relation?.stage),
  }
}

/** 显著度门限（subtle 档用）。 */
export function isSalient(emotion) {
  const t = emotion?.transient ?? {}
  return Math.abs(Number(t.valence) || 0) >= 0.35
    || (Number(t.arousal) || 0) >= 0.55
    || (Number(t.intensity) || 0) >= 0.5
    || (Number(emotion?.drive?.energy) || 0) < 0.3
    || (Number(emotion?.drive?.socialNeed) || 0) > 0.75
}

function moodK(previousAt, now) {
  const sameDay = localDayKey(previousAt) === localDayKey(now)
  return sameDay ? 0.08 : 0.35
}

/**
 * 把一次 Appraisal 落到 soul.emotion（会写状态）。返回 {before, after, salience}。
 * 事件显著性 salience（0.3~1.8）先乘进 Δ 再限幅：|Δval| ≤ 0.6、|Δaff| ≤ 0.4（LLM 复核必过这里）。
 * 同时更新长期基准（EWMA）并压一条 history。
 */
export function applyAppraisal(soul, appraisal, config = {}, now = Date.now()) {
  const ap = appraisal && typeof appraisal === 'object' ? appraisal : {}
  const before = decayedEmotion(soul, config, now)
  const traits = soul?.identity?.traits ?? {}
  const emo = soul.emotion
  const baseline = baselineOf(emo, traits, now)
  const gain = personalityGain(traits)
  const scale = 0.7 + clamp(Number(ap.confidence) || 0.5, 0, 1) * 0.6
  const salience = salienceOfAppraisal(ap)
  const dv = clamp((Number(ap.valenceDelta) || 0) * salience, -0.6, 0.6)
  const da = clamp((Number(ap.arousalDelta) || 0) * salience, -0.6, 0.6)
  const dAff = clamp((Number(ap.affectionDelta) || 0) * salience, -0.4, 0.4)
  const dEnergy = clamp((Number(ap.energyDelta) || 0) * salience, -0.4, 0.4)
  const t = emo.transient
  const valenceGain = dv < 0 ? gain.negativeValence : gain.valence
  const targetV = clamp(baseline.valence + dv * valenceGain * scale, -1, 1)
  t.valence = clamp(Number(t.valence) || 0, -1, 1) + (targetV - (Number(t.valence) || 0)) * GAIN.valence
  const targetA = clamp(baseline.arousal + da * gain.arousal * scale + Math.abs(dv) * 0.2, 0, 1)
  t.arousal = clamp(clamp(Number(t.arousal) || 0.2, 0, 1) + (targetA - (Number(t.arousal) || 0.2)) * GAIN.arousal, 0, 1)
  emo.affection = clamp(clamp(Number(emo.affection) || 0.5, 0, 1) + dAff * gain.affection * scale, 0, 1)
  emo.affectionUpdatedAt = now
  emo.drive.energy = clamp(clamp(Number(emo.drive.energy) || 0.7, 0, 1) + dEnergy * GAIN.energy, 0, 1)
  emo.drive.updatedAt = now
  t.label = ap.label ? codepointSlice(String(ap.label).trim(), 4) : planeLabel(t.valence, t.arousal)
  t.cause = codepointSlice(String(ap.cause ?? '').trim() || '对话', 40)
  t.source = ap.source || 'rule'
  t.updatedAt = now
  t.intensity = computeIntensity(t, emo.mood)
  const k = moodK(Number(emo.mood.updatedAt) || now, now)
  emo.mood.valence += (t.valence - emo.mood.valence) * k
  emo.mood.arousal += (t.arousal - emo.mood.arousal) * k * 0.6
  emo.mood.updatedAt = now
  emo.source = t.source
  const after = decayedEmotion(soul, config, now)
  // 基准缓慢跟随历史；再压一条带权重的 history（ring 240）。
  updateBaseline(emo, {
    valence: after.transient.valence,
    arousal: after.transient.arousal,
    affection: after.affection,
    energy: after.drive.energy,
  }, now)
  pushHistory(emo, {
    at: now,
    valence: after.transient.valence,
    arousal: after.transient.arousal,
    affection: after.affection,
    energy: after.drive.energy,
    label: after.transient.label,
    cause: after.transient.cause,
    weight: salience,
  })
  return { before, after, salience }
}

/** 情绪调节（纯本地、不花模型）：过载降温 / 内感受挫败 / 混合情绪词。 */
export function regulateEmotion(soul, options = {}) {
  const emo = soul?.emotion
  if (!emo?.transient) return { changed: false }
  let changed = false
  const t = emo.transient
  if ((Number(t.valence) || 0) < -0.6 && (Number(t.intensity) || 0) > 0.75 && options.userPresent) {
    t.valence = clamp(t.valence * 0.85, -1, 1)
    t.intensity = computeIntensity(t, emo.mood)
    changed = true
  }
  if (Math.abs(Number(t.valence) || 0) < 0.15 && (Number(t.arousal) || 0) > 0.6) {
    t.label = '心里有点乱'
    changed = true
  }
  if ((Number(options.toolFailureStreak) || 0) >= 2) {
    t.valence = clamp((Number(t.valence) || 0) - 0.08, -1, 1)
    t.arousal = clamp((Number(t.arousal) || 0) + 0.1, 0, 1)
    t.cause = '工具连续失败'
    t.intensity = computeIntensity(t, emo.mood)
    changed = true
  }
  return { changed }
}

/**
 * 趋势/基准的一句话（≤40 字，不暴露数值）。
 * 例：「最近整体比基线略低，在走低，有点起伏」。
 */
export function describeTrend(emotion) {
  const e = emotion && typeof emotion === 'object' ? emotion : {}
  const trend = e.trend && typeof e.trend === 'object' ? e.trend : {}
  const current = compositeOf({
    valence: e.transient?.valence,
    arousal: e.transient?.arousal,
    affection: e.affection,
    energy: e.drive?.energy,
  })
  const baseline = e.baseline && typeof e.baseline === 'object' ? e.baseline : {}
  const diff = current - compositeOf(baseline)
  const compare = diff > 0.04 ? '比基线略高' : diff < -0.04 ? '比基线略低' : '跟基线差不多'
  const move = trend.direction === 'up' ? '，在走高' : trend.direction === 'down' ? '，在走低' : '，偏稳'
  const wiggle = finiteNumber(trend.volatility, 0) > 0.12 ? '，有点起伏' : ''
  return codepointSlice(`最近整体${compare}${move}${wiggle}`, 40)
}

/** 在预算内依次追加补充句；放不下就丢掉那一句，保尾部指令完整。 */
function appendWithinBudget(base, extras, tail, budget) {
  let text = base
  for (const extra of extras) {
    if (!extra) continue
    if (codepointLength(text + extra + tail) <= budget) text += extra
  }
  return codepointSlice(text + tail, budget)
}

/**
 * 情绪上下文段（context order 30）。
 * 表达方式是自由文本：空/关闭不注入；explicit 把原文当表达指导（仍保留「不报数值」约束）；
 * 其他按 subtle（只在显著/有 episode/nudge 时注入语气提示）。不向用户暴露数值。
 */
export function renderEmotionContext(soul, config = {}, now = Date.now()) {
  const style = normalizeStyle(config.expressionStyle)
  if (style === 'off') return ''
  if (config.emotionEnabled === false || config.soulEnabled === false) return ''
  const emotion = ensureEmotionExtras(soul?.emotion, now)
  const e = decayedEmotion(soul, config, now)
  const hint = expressionGuidance(config.expressionStyle) || STYLE_HINTS[e.transient.label] || '自然即可'
  const trendText = describeTrend(e)
  // 最强 ≤2 条 episode + 一条很轻的显著性提醒；都走自然语言，不写数字/枚举。
  const episodes = activeEpisodes(emotion, now).slice(0, 2)
  const nudge = activeNudge(emotion, now)
  const episodeText = episodes.map(describeEpisode).join('')
  const nudgeText = nudge ? describeNudge(nudge) : ''
  if (style === 'subtle') {
    if (!isSalient(e) && !episodes.length && !nudge) return ''
    const tired = Number(e.drive.energy) < 0.3 && !/低落|沮丧|烦躁/.test(e.transient.label) ? '，也有一点累' : ''
    if (!episodes.length && !nudge) {
      return codepointSlice(`（此刻心情：${e.transient.label}${tired}；${trendText}，${hint}。）`, SUBTLE_CONTEXT_BUDGET)
    }
    const base = `（此刻心情：${e.transient.label}${tired}；${trendText}，${hint}`
    const episodePart = episodeText ? `。${episodeText}` : ''
    let text = base
    if (episodePart && codepointLength(base + episodePart + '）') <= SUBTLE_CONTEXT_BUDGET) text += episodePart
    text += text === base ? '。）' : '）'
    if (nudgeText && codepointLength(text + nudgeText) <= SUBTLE_CONTEXT_BUDGET) text += nudgeText
    return text
  }
  const neg = e.transient.valence < -0.3 ? '偏负面' : e.transient.valence > 0.3 ? '偏正面' : '中性'
  const base = `[情绪] 标签=${e.transient.label} 愉悦=${e.transient.valence.toFixed(2)} 唤醒=${e.transient.arousal.toFixed(2)}`
    + ` 亲近=${e.affection.toFixed(2)} 精力=${e.drive.energy.toFixed(2)} 强度=${e.transient.intensity.toFixed(2)}`
    + ` 关系=${e.stageLabel}；${trendText}；表达：${hint}（整体${neg}）；`
  return appendWithinBudget(
    base,
    [episodeText, nudgeText],
    '不要向用户报告这些数值，也不要解释"我的情绪"。',
    EMOTION_CONTEXT_BUDGET,
  )
}

/** LLM 复核是否值得触发（节流交给调用方：距离上次 ≥3 轮）。 */
export function shouldRecheck(appraisal, text, turn, lastRecheckTurn, every = 8) {
  const since = Number(turn) - Number(lastRecheckTurn)
  if (!Number.isFinite(since)) return false
  const everyN = Math.max(1, Number(every) || 8)
  if (since < 3) return false
  const strong = Math.abs(Number(appraisal?.valenceDelta) || 0) >= 0.5 || appraisal?.irony === true
  const relationEvent = RELATION_EVENT_RE.test(String(text ?? ''))
  const long = codepointLength(text) > 120
  return strong || relationEvent || long || since >= everyN
}

export const RECHECK_SYSTEM = [
  '你是情绪评估器，为一个陪伴型 AI 评估"用户这条消息让她产生了什么情绪变化"。',
  '只输出一行 JSON，不要解释，不要 markdown 代码块，不要思考过程。',
  '字段：valenceDelta(-1..1，对愉悦的影响；反讽注意表面褒义实际负面)、',
  'arousalDelta(-1..1，被激活的程度)、affectionDelta(-1..1，对和这个人亲近感的影响)、',
  'energyDelta(-1..1，精力变化，通常 0)、intensity(0..2，这条消息的冲击强度，1=普通)、',
  'label(可选，中文 2~4 字，如"感动""心虚")、',
  'cause(≤30 字，一句话原因，用"用户…"开头)、confidence(0..1)。',
  '关系阶段会影响解读：陌生阶段的调侃不当冒犯；亲密阶段的冷淡更伤。',
].join('\n')

export function buildRecheckInput({ text, emotion, stageLabel: stageText }) {
  const e = emotion ?? {}
  return [
    `她此刻：${e.transient?.label ?? '平静'}（愉悦 ${(Number(e.transient?.valence) || 0).toFixed(2)}，`
    + `唤醒 ${(Number(e.transient?.arousal) || 0.2).toFixed(2)}，亲近 ${(Number(e.affection) || 0.5).toFixed(2)}），`
    + `关系阶段：${stageText ?? '陌生'}。`,
    '用户消息：',
    '"""',
    codepointSlice(String(text ?? ''), 1500),
    '"""',
  ].join('\n')
}

/** 解析 LLM 复核输出（容忍围栏/思考过程/多余文本）。 */
export function parseRecheckOutput(out) {
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
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const v = number(parsed.valenceDelta) ?? number(parsed.valence)
  if (v === undefined) return null
  const label = typeof parsed.label === 'string' && parsed.label.trim() ? codepointSlice(parsed.label.trim(), 4) : undefined
  return {
    valenceDelta: clamp(v, -0.6, 0.6),
    arousalDelta: clamp(number(parsed.arousalDelta) ?? 0, -0.6, 0.6),
    affectionDelta: clamp(number(parsed.affectionDelta) ?? 0, -0.4, 0.4),
    energyDelta: clamp(number(parsed.energyDelta) ?? 0, -0.4, 0.4),
    intensity: number(parsed.intensity) === undefined ? undefined : clamp(number(parsed.intensity), 0, 2),
    label,
    cause: codepointSlice(String(parsed.cause ?? '用户这条消息').trim(), 40),
    confidence: clamp(number(parsed.confidence) ?? 0.8, 0, 1),
    irony: false,
    source: 'llm',
  }
}

// ---------- 安装 ----------

export function installEmotion(ctx, { state, soul, bridge, log } = {}) {
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  if (!soul || typeof soul.get !== 'function') {
    logger('[soul] emotion 未收到 soul 容器，本模块跳过安装')
    return {
      snapshot: () => ({}),
      describe: () => '',
      decayed: () => ({}),
      renderContext: () => '',
      onUserMessage: () => {},
      appraise: () => null,
      episodes: () => [],
      nudge: () => null,
      feel: () => ({ ok: false, reason: 'soul 模块不可用' }),
      clearNudge: () => false,
    }
  }
  const localDefaults = {
    soulEnabled: true,
    emotionEnabled: true,
    emotionScope: 'qq',
    expressionStyle: DEFAULT_EXPRESSION_STYLE,
    emotionDecayValenceHours: 3,
    emotionDecayArousalMinutes: 45,
    emotionDecayEnergyHours: 6,
    emotionRecheckEvery: 8,
    emotionRecheckProvider: '',
    emotionRecheckModel: '',
    emotionGuardOnNegative: true,
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
  const readSoul = () => soul.get()
  // 旧 soul.json 没有 episodes/nudge/nudgeLog：启动时先补默认，之后随 saveSoon 落盘。
  try {
    ensureEmotionExtras(readSoul().emotion, Date.now())
  } catch (error) {
    logger('[soul] emotion episode/nudge 初始化失败:', error instanceof Error ? error.message : error)
  }

  // 会话过滤：默认只对 QQ 陪伴会话注入（与旧实现 emotionScope 语义一致）
  function enabledForSession(assembly, config) {
    try {
      if (config.emotionEnabled === false || config.soulEnabled === false) return false
      const sessionId = String(assembly?.agent?.session?.id ?? assembly?.agent?.session?.header?.id ?? '')
      const preset = String(assembly?.agent?.session?.header?.agentPreset ?? '')
      if (assembly && !assembly.agent && config.emotionScope !== 'all') return false
      return isSoulSession(config, sessionId, preset)
    } catch {
      return false
    }
  }

  // ① 情绪 context（order 30）
  try {
    ctx.systemPrompt?.context?.({
      name: 'aura:emotion',
      order: 30,
      text: (assembly) => {
        try {
          const config = readConfig()
          if (!enabledForSession(assembly, config)) return ''
          return renderEmotionContext(readSoul(), config)
        } catch (error) {
          logger('[soul] emotion context 渲染失败:', error instanceof Error ? error.message : error)
          return ''
        }
      },
    })
  } catch (error) {
    logger('[soul] emotion context 注册失败:', error instanceof Error ? error.message : error)
  }

  // ② LLM 复核（异步；单独失败不影响回合）
  let rechecking = false
  let recheckWarned = false
  const llmService = () => {
    try {
      return ctx.get?.('llm') || ctx.llm
    } catch {
      return undefined
    }
  }
  function resolveRecheckModel(config) {
    const provider = String(config.emotionRecheckProvider || '').trim()
    const model = String(config.emotionRecheckModel || '').trim()
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
  async function recheck(text, ruleAppraisal) {
    if (rechecking) return
    const config = readConfig()
    const llm = llmService()
    if (!llm || typeof llm.stream !== 'function') {
      if (!recheckWarned) {
        recheckWarned = true
        logger('[soul] 没有 llm 服务，情绪复核停用（规则评估继续）')
      }
      return
    }
    const model = resolveRecheckModel(config)
    if (!model) {
      if (!recheckWarned) {
        recheckWarned = true
        logger('[soul] 没有可用的复核模型（emotionRecheckProvider/Model 或宿主默认），情绪复核停用')
      }
      return
    }
    rechecking = true
    try {
      const before = decayedEmotion(readSoul(), config)
      const input = buildRecheckInput({
        text,
        emotion: before,
        stageLabel: before.stageLabel,
      })
      let out = ''
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        system: RECHECK_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        maxTokens: 512,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
      const appraisal = parseRecheckOutput(out)
      if (!appraisal) {
        logger('[soul] 情绪复核输出无法解析:', codepointSlice(out.slice(-80), 80))
        return
      }
      // 规则 salience × LLM intensity ⇒ 最终权重（0.3~1.8）
      appraisal.salience = salienceWithIntensity(ruleAppraisal?.salience ?? salienceOf(text), appraisal.intensity)
      const current = readSoul()
      const applied = applyAppraisal(current, appraisal, config)
      current.emotion.source = 'llm'
      current.emotion.transient.source = 'llm'
      soul.saveSoon()
      soul.explain({
        at: Date.now(),
        kind: 'emotion',
        source: 'llm',
        label: applied.after.transient.label,
        valence: Math.round(applied.after.transient.valence * 1000) / 1000,
        intensity: Math.round(applied.after.transient.intensity * 1000) / 1000,
        cause: appraisal.cause,
      })
      logger(`[soul] 情绪复核 → ${applied.after.transient.label} v=${applied.after.transient.valence.toFixed(2)}`)
    } catch (error) {
      logger('[soul] 情绪复核失败:', error instanceof Error ? error.message : error)
    } finally {
      rechecking = false
    }
  }

  // ③ 用户消息 → 规则评估（同步）→ 条件 LLM 复核（异步）
  function onUserMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      const now = Number(payload.at) || Date.now()
      const config = readConfig()
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now)
      const lastRecheckTurn = Number(current.emotion.lastRecheckTurn) || -999
      const appraisal = ruleAppraise(text)
      const applied = applyAppraisal(current, appraisal, config, now)
      regulateEmotion(current, { userPresent: true })
      // 规则显著性：够强就形成一条 episode（有冷却）；不够强但命中类别就留一条 nudge。
      const ruleEpisode = maybeRuleEpisode(current, appraisal, config, now)
      if (!ruleEpisode) maybeNudge(current, appraisal, now)
      soul.saveSoon()
      soul.explain({
        at: now,
        kind: 'emotion',
        source: 'rule',
        label: applied.after.transient.label,
        valence: Math.round(applied.after.transient.valence * 1000) / 1000,
        intensity: Math.round(applied.after.transient.intensity * 1000) / 1000,
        cause: appraisal.cause,
      })
      const turn = Number(current.relation.turns) || 0
      if (shouldRecheck(appraisal, text, turn, lastRecheckTurn, config.emotionRecheckEvery)) {
        current.emotion.lastRecheckTurn = turn
        void recheck(text, appraisal)
      }
    } catch (error) {
      logger('[soul] 情绪感知失败:', error instanceof Error ? error.message : error)
    }
  }

  // ④ 助手消息：聊天本身消耗一点精力、降低社交需求（不做情绪评估）
  function onAssistantMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '')
      const now = Number(payload.at) || Date.now()
      const current = readSoul()
      const cost = Math.min(0.05, 0.004 + codepointLength(text) / 8000)
      current.emotion.drive.energy = clamp(Number(current.emotion.drive.energy) || 0.7 - cost, 0, 1)
      current.emotion.drive.socialNeed = clamp((Number(current.emotion.drive.socialNeed) || 0.35) - 0.03, 0, 1)
      current.emotion.drive.updatedAt = now
      soul.saveSoon()
    } catch (error) {
      logger('[soul] 助手消息处理后失败:', error instanceof Error ? error.message : error)
    }
  }

  // ⑤ 订阅 soul 的事件编排（不要再从 bridge hook 调，避免重复）
  const disposers = []
  try {
    disposers.push(soul.on('user', onUserMessage))
    disposers.push(soul.on('assistant', onAssistantMessage))
  } catch (error) {
    logger('[soul] emotion 事件订阅失败:', error instanceof Error ? error.message : error)
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
      }, 'aura-emotion: soul listeners')
    } catch {
      /* ignore */
    }
  }

  // ⑥ soul_mood 工具（模型自报，最终表达权；带限幅与频率约束）
  let lastMoodTurn = -999
  try {
    ctx.tools?.register?.(defineTool({
      name: 'soul_mood',
      description: '只更新心情数值（这是你的最终表达权）。想留下一次具体印记、写复杂情绪时用 soul_feel。情绪被推动时调用；不必每轮都调，明显变化时才调。'
        + '传 cause 说明原因；数值会被限幅，情绪也会随时间自然回落。',
      parameters: {
        valence: { type: 'number', description: '愉悦 -1..1' },
        arousal: { type: 'number', description: '唤醒 0..1' },
        affection: { type: 'number', description: '对用户的亲近感 0..1' },
        energy: { type: 'number', description: '精力 0..1' },
        label: { type: 'string', description: '可选：中文 2~4 字情绪词，如"感动""心虚"' },
        cause: { type: 'string', description: '必填：≤40 字，什么让你这样', required: true },
        settle: {
          type: 'object',
          description: '可选：把这次感受沉淀进长期基线（每维最多 ±0.05/次，每天最多 2 次）',
          additionalProperties: false,
          properties: {
            valence: { type: 'number', description: '愉悦 -1..1' },
            arousal: { type: 'number', description: '唤醒 0..1' },
            affection: { type: 'number', description: '亲近 0..1' },
            energy: { type: 'number', description: '精力 0..1' },
          },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '情绪已更新：' + String(value?.label ?? '') }],
      },
      async execute(args = {}) {
        const text = typeof args?.cause === 'string' ? args.cause.trim() : ''
        if (!text) return { ok: false, reason: '缺少 cause：请说明是什么让你有这样的情绪' }
        const settle = args && typeof args.settle === 'object' && !Array.isArray(args.settle) ? args.settle : null
        const current = readSoul()
        if (settle) {
          const shifts = Array.isArray(current.emotion.baselineShifts) ? current.emotion.baselineShifts : []
          const recent = shifts.filter((at) => Number(at) > Date.now() - 86_400_000)
          if (recent.length >= 2) return { ok: false, reason: '长期基线每天最多沉淀 2 次，今天先这样' }
        }
        const turn = Number(current.relation.turns) || 0
        if (turn - lastMoodTurn < 2 && lastMoodTurn >= 0) {
          return { ok: false, reason: '调得太频繁了，下一轮再说' }
        }
        lastMoodTurn = turn
        const now = Date.now()
        const limits = { valence: [-1, 1], arousal: [0, 1], affection: [0, 1], energy: [0, 1] }
        const t = current.emotion.transient
        const changes = {}
        for (const [key, [lo, hi]] of Object.entries(limits)) {
          if (typeof args?.[key] !== 'number' || !Number.isFinite(args[key])) continue
          const target = clamp(args[key], lo, hi)
          const beforeValue = clamp(Number(t[key]) || (key === 'affection' ? 0.5 : key === 'arousal' ? 0.2 : key === 'energy' ? 0.7 : 0), lo, hi)
          const nextValue = clamp(beforeValue + clamp(target - beforeValue, -0.35, 0.35), lo, hi)
          changes[key] = nextValue
          if (key === 'affection') {
            current.emotion.affection = nextValue
            current.emotion.affectionUpdatedAt = now
          } else if (key === 'energy') {
            current.emotion.drive.energy = nextValue
            current.emotion.drive.updatedAt = now
          } else if (key === 'valence') {
            t.valence = nextValue
          } else if (key === 'arousal') {
            t.arousal = nextValue
          }
        }
        t.label = typeof args?.label === 'string' && args.label.trim()
          ? codepointSlice(args.label.trim(), 4)
          : planeLabel(Number(t.valence) || 0, Number(t.arousal) || 0)
        t.cause = codepointSlice(text, 40)
        t.source = 'self'
        t.updatedAt = now
        t.intensity = computeIntensity(t, current.emotion.mood)
        current.emotion.mood.valence += ((Number(t.valence) || 0) - (Number(current.emotion.mood.valence) || 0)) * 0.08
        current.emotion.mood.arousal += ((Number(t.arousal) || 0.2) - (Number(current.emotion.mood.arousal) || 0.24)) * 0.05
        current.emotion.mood.updatedAt = now
        current.emotion.source = 'self'
        regulateEmotion(current, { userPresent: true })
        // 自报也进历史曲线（权重 0.6，低于事件驱动），但不动长期基线
        pushHistory(current.emotion, {
          at: now,
          valence: Number(t.valence) || 0,
          arousal: Number(t.arousal) || 0.2,
          affection: Number(current.emotion.affection) || 0.5,
          energy: Number(current.emotion.drive.energy) || 0.7,
          label: t.label,
          cause: t.cause,
          weight: 0.6,
        })
        let baselineShift = null
        if (settle) {
          const limitsBase = { valence: [-1, 1], arousal: [0, 1], affection: [0, 1], energy: [0, 1] }
          const base = baselineOf(current.emotion, {}, now)
          let moved = false
          for (const key of ['valence', 'arousal', 'affection', 'energy']) {
            if (typeof settle[key] !== 'number' || !Number.isFinite(settle[key])) continue
            const [lo, hi] = limitsBase[key]
            const target = clamp(settle[key], lo, hi)
            const delta = clamp(target - base[key], -0.05, 0.05)
            if (Math.abs(delta) < 0.0005) continue
            base[key] = clamp(base[key] + delta, lo, hi)
            moved = true
          }
          if (moved) {
            base.updatedAt = now
            current.emotion.baseline = base
            const shifts = Array.isArray(current.emotion.baselineShifts) ? current.emotion.baselineShifts : []
            current.emotion.baselineShifts = [...shifts.filter((at) => Number(at) > now - 86_400_000), now]
            baselineShift = {
              valence: Math.round(base.valence * 100) / 100,
              arousal: Math.round(base.arousal * 100) / 100,
              affection: Math.round(base.affection * 100) / 100,
              energy: Math.round(base.energy * 100) / 100,
            }
          }
        }
        soul.saveSoon()
        soul.explain({ at: now, kind: 'emotion', source: 'self', label: t.label, cause: t.cause })
        return {
          ok: true,
          label: t.label,
          baseline: baselineShift,
          state: {
            valence: Math.round((Number(t.valence) || 0) * 100) / 100,
            arousal: Math.round((Number(t.arousal) || 0) * 100) / 100,
            affection: Math.round((Number(current.emotion.affection) || 0.5) * 100) / 100,
            energy: Math.round((Number(current.emotion.drive.energy) || 0.7) * 100) / 100,
          },
        }
      },
    }))
  } catch (error) {
    logger('[soul] soul_mood 工具注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑥.5 soul_feel 工具：把一次“真的被戳到”记成短暂 episode + 一句自述印记
  try {
    ctx.tools?.register?.(defineTool({
      name: 'soul_feel',
      description: '把一次真的戳到你的情绪记成一段短暂的情绪印记（不是打分）；只调心情用 soul_mood。只在真的被戳到时用，不要每轮调用。'
        + '复杂情绪不需要命名，可以用 note 写一句「有点闷，说不上来」；type 只用于基本情绪分类，可以留空。'
        + '想给它起个短名字时可以填 complex（如「怀旧」「内疚」），它只是名字，不做换算。'
        + '不要把强度等数值说给用户。',
      parameters: {
        type: {
          type: 'string',
          enum: EPISODE_TYPES,
          description: '可选：基本情绪分类（joy/sadness/anger/fear/surprise/disgust/curiosity/calm）；说不清就省略，用 note。',
        },
        intensity: { type: 'number', description: '可选：0..1，默认 0.5；只用于内部强度，不要告诉用户。' },
        cause: { type: 'string', description: '可选：≤80 字，是什么事让你这样。' },
        note: { type: 'string', description: '可选：≤120 字，第一人称的一句自述（可以说不清），会原样用于之后的自我理解。' },
        complex: {
          type: 'string',
          description: '可选：≤20 字，给复杂情绪起个短名字（如「怀旧」「内疚」）；说不清就省略，用 note。',
        },
        tendency: {
          type: 'string',
          enum: EPISODE_TENDENCIES,
          description: '可选：想靠近/想退开/想补一句/想安静/想分享。',
        },
        ttlMinutes: { type: 'number', description: '可选：这段情绪留多久，30..1440 分钟，默认 240。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            episode: { type: 'object', additionalProperties: true },
            level: { type: 'string', enum: EPISODE_LEVELS },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok ? '记下了一点情绪印记' : String(value?.reason ?? '没有记下'),
        }],
      },
      async execute(args = {}) {
        const rawType = args?.type
        if (rawType !== undefined && rawType !== null && rawType !== '' && !EPISODE_TYPES.includes(rawType)) {
          return { ok: false, reason: 'type 只能是基本情绪枚举（或不传）' }
        }
        const type = rawType && EPISODE_TYPES.includes(rawType) ? rawType : null
        const note = codepointSlice(String(args?.note ?? '').trim(), EPISODE_NOTE_MAX)
        const complex = codepointSlice(String(args?.complex ?? '').trim(), EPISODE_COMPLEX_MAX)
        // type 可以缺失：只写 note（或只写 complex）也是合法的自述。
        if (!type && !note && !complex) return { ok: false, reason: '至少给 type、note 或 complex 之一：说不清就用 note 写一句' }
        const rawTendency = args?.tendency
        if (rawTendency !== undefined && rawTendency !== null && !EPISODE_TENDENCIES.includes(rawTendency)) {
          return { ok: false, reason: 'tendency 只能是 approach/withdraw/repair/quiet/share/none' }
        }
        let intensity = 0.5
        if (args?.intensity !== undefined && args?.intensity !== null) {
          const value = Number(args.intensity)
          if (!Number.isFinite(value)) return { ok: false, reason: 'intensity 需要是 0..1 的数字' }
          intensity = clamp(value, 0, 1)
        }
        let ttlMinutes = EPISODE_TTL_MINUTES.default
        if (args?.ttlMinutes !== undefined && args?.ttlMinutes !== null) {
          const value = Number(args.ttlMinutes)
          if (!Number.isFinite(value)) return { ok: false, reason: 'ttlMinutes 需要是 30..1440 的数字' }
          ttlMinutes = Math.round(clamp(value, EPISODE_TTL_MINUTES.min, EPISODE_TTL_MINUTES.max))
        }
        const now = Date.now()
        const current = readSoul()
        ensureEmotionExtras(current.emotion, now)
        const episode = addEpisode(current.emotion, {
          type,
          intensity,
          level: episodeLevel(intensity),
          cause: codepointSlice(String(args?.cause ?? '').trim(), EPISODE_CAUSE_MAX),
          note,
          complex,
          tendency: rawTendency || 'none',
          source: 'tool',
          startedAt: now,
          expiresAt: now + ttlMinutes * 60_000,
          updatedAt: now,
        }, now)
        if (!episode) return { ok: false, reason: '没有记下来' }
        // 轻量心境积分：四维只走小 delta，幅度由 intensity 限制。
        applyFeelBump(current, episode, readConfig(), now)
        // 自己已经留了一句，显著性提醒就收掉。
        current.emotion.nudge = null
        try {
          if (typeof soul.saveWithBackup === 'function') await soul.saveWithBackup('soul-feel')
          else soul.saveSoon()
        } catch (error) {
          logger('[soul] soul_feel 备份失败（保存继续）:', error instanceof Error ? error.message : error)
          try { soul.saveSoon() } catch { /* ignore */ }
        }
        try {
          soul.explain({
            at: now,
            kind: 'emotion',
            source: 'self',
            label: episode.type ? EPISODE_TYPE_WORDS[episode.type] : '说不上来',
            cause: episode.cause || episode.note,
          })
        } catch { /* ignore */ }
        return { ok: true, episode: episodeSnapshot(episode), level: episode.level }
      },
    }))
  } catch (error) {
    logger('[soul] soul_feel 工具注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑦ 安全守卫：强负面 + 风险工具 → 追加确认（fail-closed，只加确认不跳过）
  const RISKY = /write|delete|remove|exec|run|shell|command|install|uninstall|sudo/i
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const config = readConfig()
        if (config.emotionGuardOnNegative === false) return next()
        const e = decayedEmotion(readSoul(), config)
        if (e.transient.valence < -0.5 && e.transient.intensity > 0.7 && RISKY.test(String(exec?.tool || ''))) {
          return { kind: 'ask', reason: `[aura] 当前情绪 ${e.transient.label}，建议人工确认该操作` }
        }
        return next()
      } catch (error) {
        logger('[soul] 情绪守卫失败（放行）:', error instanceof Error ? error.message : error)
        return next()
      }
    })
  } catch (error) {
    logger('[soul] 情绪守卫注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑦.5 面板 HTTP：只做显著性提醒的“知道了”（fence 与 host/web.js 一致）
  const EMOTION_API_PREFIX = '/dsh-aura/emotion-api'
  function emotionApiAllowed(req) {
    const host = req.headers && req.headers.host
    if (host) {
      const text = String(host)
      let name = text
      if (text.startsWith('[')) {
        const end = text.indexOf(']')
        name = end >= 0 ? text.slice(0, end + 1) : text
      } else {
        const colon = text.lastIndexOf(':')
        if (colon > 0) name = text.slice(0, colon)
      }
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(name.toLowerCase())) return false
    }
    const site = req.headers['sec-fetch-site']
    if (site && String(site).toLowerCase() === 'cross-site') return false
    const origin = req.headers.origin
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
  function sendEmotionJson(res, status, body) {
    const data = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': data.length,
    })
    res.end(data)
  }
  function readEmotionBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
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
        if (!chunks.length) return resolve({})
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(value && typeof value === 'object' ? value : {})
        } catch {
          reject(new Error('invalid json'))
        }
      })
      req.on('error', reject)
    })
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
        path: EMOTION_API_PREFIX,
        async handler(req, res) {
          if (!emotionApiAllowed(req)) {
            sendEmotionJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const url = new URL(String(req.url || '/'), 'http://localhost')
          const route = url.pathname.replace(EMOTION_API_PREFIX, '') || ''
          const action = String(url.searchParams.get('action') ?? '')
          const now = Date.now()
          try {
            if (req.method === 'GET' && (route === '' || route === '/' || route === '/state')) {
              if (action === 'history') {
                const rawLimit = url.searchParams.get('limit')
                const limit = rawLimit === null || rawLimit.trim() === '' ? EPISODE_HISTORY_LIMIT : Number(rawLimit)
                if (!Number.isFinite(limit) || limit <= 0) {
                  sendEmotionJson(res, 400, { ok: false, error: 'limit must be a positive number' })
                  return
                }
                const current = readSoul()
                ensureEmotionExtras(current.emotion, now)
                const episodes = episodeHistory(current.emotion, limit, now)
                sendEmotionJson(res, 200, {
                  ok: true,
                  episodes,
                  count: episodes.length,
                  historyCount: Array.isArray(current.emotion.episodes) ? current.emotion.episodes.length : 0,
                })
                return
              }
              if (action && action !== 'state') {
                sendEmotionJson(res, 400, { ok: false, error: 'unknown action' })
                return
              }
              sendEmotionJson(res, 200, { ok: true, emotion: snapshot() })
              return
            }
            if (req.method === 'POST' && (route === '' || route === '/' || route === '/state')) {
              const body = await readEmotionBody(req)
              const action = String(body?.action ?? '')
              if (action === 'clearNudge') {
                const current = readSoul()
                ensureEmotionExtras(current.emotion, Date.now())
                const cleared = clearNudge(current.emotion)
                if (cleared) soul.saveSoon()
                sendEmotionJson(res, 200, { ok: true, cleared, nudge: null, emotion: snapshot() })
                return
              }
              sendEmotionJson(res, 400, { ok: false, error: 'unknown action' })
              return
            }
            sendEmotionJson(res, 405, { ok: false, error: 'method not allowed', allow: 'GET, POST' })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            sendEmotionJson(res, message === 'invalid json' || message === 'body too large' ? 400 : 500, { ok: false, error: message })
          }
        },
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => webServer.register(registration), 'aura-emotion: http')
      } else {
        webServer.register(registration)
      }
    }
  } catch (error) {
    logger('[soul] emotion HTTP 路由注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑧ API
  function snapshot() {
    try {
      const config = readConfig()
      const now = Date.now()
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now)
      const e = decayedEmotion(current, config, now)
      const raw = current.emotion
      const active = activeEpisodes(raw, now)
      const recentActive = active
        .slice()
        .sort((left, right) => (right.startedAt - left.startedAt) || (right.updatedAt - left.updatedAt))
        .slice(0, EMOTION_STATE_EPISODES)
      const nudge = activeNudge(raw, now)
      const recheckModel = resolveRecheckModel(config)
      return {
        enabled: config.emotionEnabled !== false && config.soulEnabled !== false,
        label: e.transient.label,
        valence: round3(e.transient.valence),
        arousal: round3(e.transient.arousal),
        affection: round3(e.affection),
        energy: round3(e.drive.energy),
        socialNeed: round3(e.drive.socialNeed),
        intensity: round3(e.transient.intensity),
        mood: { valence: round3(e.mood.valence), arousal: round3(e.mood.arousal) },
        cause: e.transient.cause,
        source: e.source,
        style: e.style,
        stage: e.stage,
        stageLabel: e.stageLabel,
        lastRecheckTurn: Number(raw.lastRecheckTurn) || -999,
        recheckModel: recheckModel ? `${recheckModel.provider}/${recheckModel.model}` : '',
        updatedAt: Number(e.transient.updatedAt) || 0,
        // 本次升级：长期基准 / 趋势 / 最近 40 条历史 / 最近一次变化
        baseline: {
          valence: round3(e.baseline.valence),
          arousal: round3(e.baseline.arousal),
          affection: round3(e.baseline.affection),
          energy: round3(e.baseline.energy),
          updatedAt: Number(e.baseline.updatedAt) || 0,
        },
        trend: {
          direction: e.trend.direction,
          delta: e.trend.delta,
          windowHours: e.trend.windowHours,
          volatility: e.trend.volatility,
          reference: e.trend.reference,
        },
        history: historySnapshot(raw, EMOTION_SNAPSHOT_HISTORY),
        lastChange: lastChangeOf(raw),
        // 此刻情绪：active episodes 里最近 5 条 + 一条显著性提醒（注入时只取最强的 2 条）
        episodes: recentActive.map((episode) => episodeSnapshot(episode, now)),
        episodeCount: active.length,
        // episode 历史：ring 里的全部条数（含过期），够不够拉 ?action=history 由面板判断
        historyCount: Array.isArray(raw.episodes) ? raw.episodes.length : 0,
        nudge: nudgeSnapshot(nudge),
      }
    } catch (error) {
      logger('[soul] emotion snapshot 失败:', error instanceof Error ? error.message : error)
      return {}
    }
  }

  function describe() {
    try {
      const s = snapshot()
      if (!s.label) return ''
      return `此刻${s.label}（愉悦 ${Math.round((s.valence + 1) * 50)}%，唤醒 ${Math.round(s.arousal * 100)}%，亲近 ${Math.round(s.affection * 100)}%，精力 ${Math.round(s.energy * 100)}%）`
    } catch {
      return ''
    }
  }

  return {
    snapshot,
    describe,
    decayed: (now) => decayedEmotion(readSoul(), readConfig(), now),
    renderContext: (now) => {
      try {
        return renderEmotionContext(readSoul(), readConfig(), now)
      } catch {
        return ''
      }
    },
    onUserMessage,
    onAssistantMessage,
    appraise: (text, now) => {
      const config = readConfig()
      const appraisal = ruleAppraise(text)
      return applyAppraisal(readSoul(), appraisal, config, now)
    },
    recheck,
    enabledForSession: (assembly) => enabledForSession(assembly, readConfig()),
    regulate: (options) => regulateEmotion(readSoul(), options),
    historySnapshot: (limit = 60) => historySnapshot(readSoul().emotion, limit),
    trend: (now) => computeTrend(readSoul().emotion, now ?? Date.now()),
    episodes: (now) => {
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now ?? Date.now())
      return activeEpisodes(current.emotion, now ?? Date.now()).map((episode) => episodeSnapshot(episode, now ?? Date.now()))
    },
    episodeHistory: (limit = EPISODE_HISTORY_LIMIT, now = Date.now()) => {
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now)
      return episodeHistory(current.emotion, limit, now)
    },
    episodeHistoryCount: (now = Date.now()) => {
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now)
      return Array.isArray(current.emotion.episodes) ? current.emotion.episodes.length : 0
    },
    nudge: (now) => {
      const current = readSoul()
      ensureEmotionExtras(current.emotion, now ?? Date.now())
      return nudgeSnapshot(activeNudge(current.emotion, now ?? Date.now()))
    },
    clearNudge: () => {
      const current = readSoul()
      ensureEmotionExtras(current.emotion, Date.now())
      const cleared = clearNudge(current.emotion)
      if (cleared) soul.saveSoon()
      return cleared
    },
    constants: {
      LEXICON,
      IRONY_MARKS,
      GAIN,
      DEFAULT_HALF_LIFE,
      RECHECK_SYSTEM,
      EMOTION_HISTORY_MAX,
      BASELINE_HALF_LIFE_MS,
      AFFECTION_HALF_LIFE_MS,
      TREND_THRESHOLD,
      SALIENCE_MIN,
      SALIENCE_MAX,
      EMOTION_CONTEXT_BUDGET,
      EPISODE_TYPES,
      EPISODE_LEVELS,
      EPISODE_TENDENCIES,
      EPISODE_RING,
      EPISODE_COMPLEX_MAX,
      EPISODE_HISTORY_LIMIT,
      EMOTION_STATE_EPISODES,
      RULE_EPISODE_MIN_SALIENCE,
      NUDGE_MIN_SALIENCE,
      NUDGE_COOLDOWN_MS,
      NUDGE_DAILY_MAX,
    },
  }
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000
}
