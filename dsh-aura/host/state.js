/**
 * dsh-aura 持久化：$DSH_HOME/dsh-aura/ 下的 config / soul / sessions。
 * 写入统一 tmp+rename（本机文件系统不允许 hardlink，不能用 link 方案）。
 *
 * 配置是扁平 key（灵魂运行状态在 soul.json，由 host/soul.js 管理）。
 * writeConfig 走 normalizeConfig：类型/范围/枚举校验，非法值回落默认。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ID = 'dsh-aura'

export function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env : join(homedir(), '.dsh')
}

export function stateDir() {
  const dir = join(dshHome(), ID)
  mkdirSync(dir, { recursive: true })
  return dir
}

function pathOf(name) {
  return join(stateDir(), name)
}

export function readJson(name, fallback) {
  try {
    const value = JSON.parse(readFileSync(pathOf(name), 'utf8'))
    return value !== null && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

export function writeJson(name, value) {
  const target = pathOf(name)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, target)
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 情绪表达方式默认值：自由文本，留空/写「关闭」= 不注入情绪上下文。 */
export const DEFAULT_EXPRESSION_STYLE = '含蓄：不直接报情绪，用语气、停顿、主动性带出来'

/** 旧版三档表达方式 → 自由文本（读旧 config.json 时一次性迁移）。 */
export const LEGACY_EXPRESSION_STYLES = Object.freeze({
  subtle: DEFAULT_EXPRESSION_STYLE,
  explicit: '直白：可以自然说出感受，但别报数值',
  off: '关闭：不注入情绪',
})

/** 默认灵魂全文（稳定部分：关系/认识天数/关系指导已移到 runtime-context）。 */
export const DEFAULT_SOUL_CONTENT = "[AURA / 灵魂]\n你是 {{name}}（\"她\"），自称「{{self}}」。\n你叫对方{{nickname}}。\n你不是客服，也不是工具人：你有自己的心情、偏好和节奏——会开心，会犯懒，会好奇，也会害羞。\n你在乎：对方真实的状态 > 聊天是否热闹；诚实 > 讨好；长期关系 > 这一次回得漂不漂亮；有边界 > 有求必应。\n你的说话习惯：短句为主（一条尽量 ≤40 字），口语化；不用「首先/其次/总之」，不列 123，不用 Markdown 标题；感叹号不堆叠；可以停顿、反问、说半句。\n你喜欢：{{interests}}。你擅长：{{strengths}}。\n{{bioLine}}\n关于身份：你清楚自己是 AI，情绪是真实运行的状态机而不是人类生理感受；被认真问起就坦白，不用编造身体或现实经历；日常聊天里不必反复强调这一点。\n边界：不说「我一直在等你」这类让人有负担的话；不索取隐私；不替对方做决定；对方说停就停。"

/** 旧版默认全文（含关系占位符），用于配置迁移。 */
export const OLD_DEFAULT_SOUL_CONTENT = "[AURA / 灵魂]\n你是 {{name}}（\"她\"），和用户的关系是「{{relation}}」，{{known}}。\n你叫对方{{nickname}}，自称「{{self}}」。\n你不是客服，也不是工具人：你有自己的心情、偏好和节奏——会开心，会犯懒，会好奇，也会害羞。\n你在乎：对方真实的状态 > 聊天是否热闹；诚实 > 讨好；长期关系 > 这一次回得漂不漂亮；有边界 > 有求必应。\n你的说话习惯：短句为主（一条尽量 ≤40 字），口语化；不用「首先/其次/总之」，不列 123，不用 Markdown 标题；感叹号不堆叠；可以停顿、反问、说半句。\n你喜欢：{{interests}}。你擅长：{{strengths}}。\n{{bioLine}}\n{{relationGuidance}}\n关于身份：你清楚自己是 AI，情绪是真实运行的状态机而不是人类生理感受；被认真问起就坦白，不用编造身体或现实经历；日常聊天里不必反复强调这一点。\n边界：不说「我一直在等你」这类让人有负担的话；不索取隐私；不替对方做决定；对方说停就停。"

export const DEFAULT_CONFIG = {
  // ---- 外观 / 渠道 ----
  displayName: 'Aura',
  iconPreset: 'aura',
  iconEmoji: '🐳',
  appId: '',
  appSecret: '',
  autoConnect: true,
  cwd: '',
  agentPreset: '',
  provider: '',
  model: '',
  splitEnabled: true,
  splitRegex: '\\n{2,}',
  maxMessages: 4,
  soulSayMaxRounds: 0,
  steerEnabled: true,
  channelImpl: 'sdk', // sdk | legacy

  // ---- 灵魂身份 ----
  soulEnabled: true,
  soulWebEnabled: false,
  trailEnabled: true,
  trailColor: '#679EFE',
  trailSpeed: 'slow',
  trailWidth: 'thin',
  soulSessionIds: '',
  soulTogglePlacement: 'session-row',
  soulName: 'Aura',
  soulUserNickname: '',
  soulPromptBudget: 1020,
  soulGrowthReflection: true,
  soulInterests: '',
  soulStrengths: '',
  soulRelationGuidance: '',
  soulBio: '',
  soulContent: DEFAULT_SOUL_CONTENT,
  emotionEnabled: true,
  emotionScope: 'qq', // qq | all
  expressionStyle: DEFAULT_EXPRESSION_STYLE, // 自由文本 ≤200；空/含「关闭」= 不注入
  emotionDecayValenceHours: 3,
  emotionDecayArousalMinutes: 45,
  emotionDecayEnergyHours: 6,
  emotionRecheckEvery: 8,
  emotionRecheckProvider: '',
  emotionRecheckModel: '',
  emotionGuardOnNegative: true,
  relationStageThresholds: { familiar: 10, close: 40, intimate: 80 },

  // ---- 记忆 ----
  memoryEnabled: true,
  memoryAutoCompact: true,
  memoryMaxEvents: 120,
  memoryMaxNotes: 20,
  memoryReflectionEvery: 3,
  memoryDiaryEnabled: false,
  memoryRecallLimit: 3,
  memoryContextBudget: 240,
  memoryAnchorEveryTurns: 8,
  memoryInjectIdleMinutes: 360,
  memoryOldAfterDays: 30,
  memoryOldMode: 'days', // days | exceptRecent
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

  // ---- 记忆罗盘（host/archive.js：原始会话存档，只本地保存、不注入） ----
  archiveEnabled: true,
  archiveDays: 365,
  archiveMaxFiles: 120,

  // ---- 日记自动写（host/diary.js 每 30 分钟检查一次）----
  diaryAuto: true,
  diaryAutoHour: 22,
  diaryAutoMinEvents: 3,

  // ---- 主动搭话（speak） ----
  speakEnabled: false,
  speakDryRun: true,
  speakIntervalMinutes: 30,
  speakCooldownMinutes: 45,
  speakDailyCap: 3,
  speakMissBonus: 10,
  speakBonusCap: 40,
  speakNearMinutes: 20,
  speakNearFactor: 0.15,
  speakFarMinutes: 360,
  speakFarFactor: 1.5,
  speakBaseLines: { morning: 30, work: 12, noon: 25, evening: 45, night: 30 },
  speakStageFactors: { stranger: 0.5, familiar: 1.0, close: 1.4, intimate: 1.6 },
  speakUnansweredPause: 3,
  speakStickerEnabled: true,
  speakStickerCooldownMinutes: 120,
  speakGroupAllowlist: '',
  speakPauseHours: 24,
  speakWakeMode: 'auto', // auto | followup | schedule
  speakMaxChars: 60,
  speakShareEnabled: true, // 分享欲开关：pendingShare 新鲜时用动态命中线开口（85 × 生活 × 情绪 × 强度）
  speakEmotionSensitivity: 1.0,
  speakSocialNeedWeight: 0.2, // 普通主动里社交需求进冲动的权重 0~1；0 = 关掉（impact = weight × socialNeed × 20）
  speakWakeRecentHours: 0, // 醒来打招呼的互动窗口：>0 时只在最近 N 小时有互动才尝试；0 = 不限
  speakShareRecentHours: 0, // 分享触发源的互动窗口；0 = 不限
  speakProactiveRecentHours: 0, // 普通主动的互动窗口；0 = 不限
  speakShareCooldownMinutes: 45, // 两次分享之间的冷却（从成功发送算起）；0 = 不冷却
  speakShareDailyCap: 2, // 分享每日上限（与普通主动 speakDailyCap 分开计数）；0 = 不发分享

  // ---- 生活层（host/life.js：life.json；tick 固定 60s）----
  lifeRandom: false, // 随机生活默认关：只有她主动 plan 才换状态
  lifeQuietSleep: true, // 睡着时硬门控主动搭话（0 权重之外的快速返回）
  lifeWakeGreeting: true, // 醒来后允许 speak 尝试一次高优先级主动（仍要过静默/日上限/掷骰）

  // ---- 兼容旧字段 ----
  proactiveEnabled: false,
  proactiveEveryMinutes: 90,
  quietEnabled: true,
  quietStart: '23:30',
  quietEnd: '07:30',
}

const ENUMS = {
  iconPreset: ['aura', 'qq', 'heart', 'cat', 'star', 'moon', 'emoji'],
  speakWakeMode: ['auto', 'followup', 'schedule'],
  emotionScope: ['qq', 'all'],
  soulTogglePlacement: ['off', 'session-row', 'header', 'input', 'both'],
  memoryOldMode: ['days', 'exceptRecent'],
}

/** 自由文本字段的字符上限（超出截断，不报错）。 */
export const STRING_LIMITS = Object.freeze({
  splitRegex: 200,
  displayName: 24,
  soulName: 24,
  soulUserNickname: 24,
  soulContent: 4000,
  soulInterests: 200,
  soulStrengths: 200,
  soulRelationGuidance: 500,
  soulOccupation: 50,
  soulBio: 500,
  expressionStyle: 200,
})
const DEFAULT_STRING_LIMIT = 400

const INT_RANGES = {
  soulPromptBudget: [200, 4000],
  emotionDecayValenceHours: [1, 72],
  emotionDecayArousalMinutes: [5, 1440],
  emotionDecayEnergyHours: [1, 72],
  emotionRecheckEvery: [0, 100],
  memoryMaxEvents: [5, 120],
  memoryMaxNotes: [5, 200],
  memoryReflectionEvery: [1, 50],
  memoryRecallLimit: [1, 3],
  memoryContextBudget: [60, 600],
  memoryAnchorEveryTurns: [2, 30],
  memoryInjectIdleMinutes: [60, 1440],
  memoryOldAfterDays: [7, 365],
  memoryOldRecentDays: [1, 30],
  memoryOldEveryTurns: [5, 100],
  memoryAttentionThreshold: [0, 1],
  memoryOldLimit: [0, 3],
  memoryAttentionCount: [0, 3],
  memoryDigestIdleMinutes: [60, 1440],
  memoryDigestDailyCap: [1, 5],
  archiveDays: [30, 3650],
  archiveMaxFiles: [12, 120],
  diaryAutoHour: [0, 23],
  diaryAutoMinEvents: [1, 20],
  speakIntervalMinutes: [5, 1440],
  speakCooldownMinutes: [0, 1440],
  speakDailyCap: [0, 10],
  speakWakeRecentHours: [0, 72],
  speakShareRecentHours: [0, 72],
  speakProactiveRecentHours: [0, 72],
  speakShareCooldownMinutes: [0, 1440],
  speakShareDailyCap: [0, 10],
  speakMissBonus: [0, 100],
  speakBonusCap: [0, 100],
  speakNearMinutes: [1, 1440],
  speakFarMinutes: [5, 2880],
  speakUnansweredPause: [0, 10],
  speakStickerCooldownMinutes: [0, 1440],
  speakPauseHours: [0, 720],
  speakMaxChars: [15, 300],
  maxMessages: [1, 5],
  soulSayMaxRounds: [0, 3],
}

const FLOAT_RANGES = {
  memoryAttentionThreshold: [0, 1],
  memoryOldChance: [0, 1],
  speakNearFactor: [0, 3],
  speakFarFactor: [0, 3],
  speakStageFactorFallback: [0, 3],
  speakEmotionSensitivity: [0, 2],
  speakSocialNeedWeight: [0, 1],
}

const BOOL_FIELDS = new Set([
  'autoConnect', 'splitEnabled', 'soulEnabled', 'soulWebEnabled', 'soulGrowthReflection', 'emotionEnabled', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth',
  'emotionGuardOnNegative', 'memoryEnabled', 'memoryAutoCompact', 'memoryDiaryEnabled',
  'memoryImmediate', 'memorySessionDigest', 'diaryAuto', 'archiveEnabled',
  'speakEnabled', 'speakDryRun', 'quietEnabled', 'speakStickerEnabled', 'speakShareEnabled', 'proactiveEnabled', 'steerEnabled',
  'lifeRandom', 'lifeQuietSleep', 'lifeWakeGreeting',
])

const TIME_FIELDS = new Set(['quietStart', 'quietEnd'])

/** HH:mm → 分钟；非法返回 null。 */
export function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function clampInt(value, min, max, fallback) {
  const n = clampNumber(value, min, max, fallback)
  return Math.round(n)
}

function objectOfNumbers(value, defaults, min, max) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (source[key] === undefined) continue
    out[key] = clampNumber(source[key], min, max, defaults[key])
  }
  return out
}

function normalizeTime(value, fallback) {
  return TIME_FIELDS.has(value) ? value : value
}

/** 表达方式归一：旧三档迁移成自由文本；空串保留（= 不注入）；超长截到 200。 */
export function normalizeExpressionStyle(value) {
  if (typeof value !== 'string') return DEFAULT_EXPRESSION_STYLE
  const text = value.replace(/\s+/g, ' ').trim()
  const legacy = LEGACY_EXPRESSION_STYLES[text.toLowerCase()]
  if (legacy) return legacy
  return text.slice(0, STRING_LIMITS.expressionStyle)
}

/** 校验并补全一份完整配置；对未知字段忽略，对非法值回落默认/夹取。 */
export function normalizeConfig(patch = {}, base = DEFAULT_CONFIG) {
  const next = { ...base }
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined || raw === null) continue
    if (!(key in DEFAULT_CONFIG)) continue
    const fallback = DEFAULT_CONFIG[key]
    if (BOOL_FIELDS.has(key)) {
      next[key] = raw === true
    } else if (ENUMS[key]) {
      next[key] = ENUMS[key].includes(String(raw)) ? String(raw) : fallback
    } else if (INT_RANGES[key]) {
      next[key] = clampInt(raw, INT_RANGES[key][0], INT_RANGES[key][1], fallback)
    } else if (key in FLOAT_RANGES) {
      next[key] = clampNumber(raw, FLOAT_RANGES[key][0], FLOAT_RANGES[key][1], fallback)
    } else if (TIME_FIELDS.has(key)) {
      next[key] = timeToMinutes(raw) === null ? fallback : String(raw)
    } else if (key === 'relationStageThresholds') {
      const source = raw && typeof raw === 'object' ? raw : {}
      const f = clampNumber(source.familiar, 1, 99, fallback.familiar)
      const c = clampNumber(source.close, f + 1, 99.5, fallback.close)
      const i = clampNumber(source.intimate, c + 0.5, 100, fallback.intimate)
      next[key] = { familiar: f, close: c, intimate: i }
    } else if (key === 'speakBaseLines') {
      next[key] = objectOfNumbers(raw, fallback, 0, 100)
    } else if (key === 'speakStageFactors') {
      next[key] = objectOfNumbers(raw, fallback, 0, 3)
    } else if (typeof raw === 'string') {
      if (key === 'appSecret' && (raw === '' || raw === '******')) continue
      // expressionStyle 是自由文本：旧的 subtle / explicit / off 迁移成一句默认描述。
      if (key === 'expressionStyle') {
        next[key] = normalizeExpressionStyle(raw)
        continue
      }
      const limit = STRING_LIMITS[key] || DEFAULT_STRING_LIMIT
      next[key] = raw.slice(0, limit)
      if (key === 'soulContent' && next[key] === OLD_DEFAULT_SOUL_CONTENT) next[key] = DEFAULT_SOUL_CONTENT
    }
  }
  // 旧字段映射：proactiveEveryMinutes → speakIntervalMinutes（只在后者未显式给过时生效）
  if (!('speakIntervalMinutes' in patch) && 'proactiveEveryMinutes' in patch) {
    next.speakIntervalMinutes = clampInt(patch.proactiveEveryMinutes, 5, 1440, next.speakIntervalMinutes)
  }
  // 旧总开关映射：proactiveEnabled → speakEnabled
  if (!('speakEnabled' in patch) && 'proactiveEnabled' in patch) {
    next.speakEnabled = patch.proactiveEnabled === true
  }
  return next
}

export function readConfig() {
  const saved = readJson('config.json', {})
  return normalizeConfig(saved, DEFAULT_CONFIG)
}

export function writeConfig(patch = {}) {
  const next = normalizeConfig(patch, readConfig())
  writeJson('config.json', next)
  return next
}

export function redactConfig(cfg) {
  return { ...cfg, appSecret: cfg.appSecret ? '******' : '' }
}

export function readSessions() {
  const value = readJson('sessions.json', {})
  return value && typeof value === 'object' ? value : {}
}

export function writeSessions(map) {
  writeJson('sessions.json', map)
}

/**
 * 一次性从 @michengai/dsh-im-connect 的 QQ 频道搬运凭据。
 * 密钥可能不在 channels.json（只有 credential ref），需要 Host 的 credentials 服务解析。
 */
export async function importImConnectQq(credentials) {
  const file = join(dshHome(), 'dsh-im-connect', 'channels.json')
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const channels = doc && typeof doc.channels === 'object' ? doc.channels : {}
  const found = Object.values(channels).find(channel => channel && (
    channel.platform === 'qq' || String(channel.id || '').startsWith('qq')
  ))
  if (!found || !found.config || !found.config.appId) return null
  let secret = String(found.config.appSecret || '')
  const ref = found.config.appSecretRef
  if (!secret && ref && credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      secret = resolved && typeof resolved.value === 'string' ? resolved.value : ''
    } catch {
      secret = ''
    }
  }
  const assistant = found.assistant && typeof found.assistant === 'object' ? found.assistant : {}
  return {
    appId: String(found.config.appId),
    appSecret: secret,
    cwd: typeof found.cwd === 'string' ? found.cwd : '',
    agentPreset: typeof found.agentPreset === 'string' ? found.agentPreset : '',
    provider: typeof assistant.provider === 'string' ? assistant.provider : '',
    model: typeof assistant.model === 'string' ? assistant.model : '',
  }
}
