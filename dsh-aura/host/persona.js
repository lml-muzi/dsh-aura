/**
 * dsh-aura 人设模块（Host 半边）
 * ============================================================================
 * 收编已停用的 dsh-soul 的宿主能力：配置模型 / system prompt 注入 / 人设预设 /
 * 变更历史与撤销 / set_persona 工具 / 本机 HTTP 面板 API。
 *
 * 数据完全独立于 Aura 的 soul.json（身份/情绪/关系仍在 soul.json）：
 *   - 配置 + 自建预设：$DSH_HOME/dsh-aura/persona.json
 *   - 变更历史（JSONL） ：$DSH_HOME/dsh-aura/persona-history.jsonl
 * 未设置 DSH_HOME 时回落到 ~/.dsh-native（与部署环境一致）。
 *
 * 本文件保持 Node ESM、零新增依赖；不修改 Aura 其它模块。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ==================== 路径 ====================

export const PERSONA_FILE = 'persona.json'
export const PERSONA_HISTORY_FILE = 'persona-history.jsonl'
export const PERSONA_VERSION = 1
export const PERSONA_API_PREFIX = '/dsh-aura/persona-api'

/** DSH 根目录：优先 DSH_HOME，否则 ~/.dsh-native（本机部署形态）。 */
export function auraHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh-native')
}

export function personaDir() {
  return join(auraHome(), 'dsh-aura')
}

export function personaFilePath() {
  return join(personaDir(), PERSONA_FILE)
}

export function personaHistoryPath() {
  return join(personaDir(), PERSONA_HISTORY_FILE)
}

function historyPathFor(configFile) {
  return join(dirname(configFile), PERSONA_HISTORY_FILE)
}

// ==================== 默认值与合法取值 ====================

/** 默认配置与 dsh-soul 完全一致（含 trail* / requireToolConfirmation / historyMaxEntries）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  nickname: '',
  occupation: '',
  bio: '',
  style: 'professional',
  headingLists: 'default',
  emoji: 'default',
  tables: 'default',
  replyLength: 'normal',
  language: 'zh',
  customInstructions: '',
  requireToolConfirmation: false,
  trailEnabled: true,
  trailColor: '#679EFE',
  trailSpeed: 'slow',
  trailWidth: 'thin',
  historyMaxEntries: 200,
})

export const STYLE_VALUES = ['professional', 'casual', 'humorous', 'roast', 'efficient']
export const TRAIT_VALUES = ['default', 'more', 'less']
export const REPLY_LENGTH_VALUES = ['concise', 'normal', 'detailed']
export const LANGUAGE_VALUES = ['zh', 'en']
export const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
export const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']
export const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

export const HISTORY_MAX_ENTRIES_MIN = 50
export const HISTORY_MAX_ENTRIES_MAX = 500
export const HISTORY_MAX_ENTRIES_DEFAULT = 200

export const FIELD_LIMITS = {
  nickname: 50,
  occupation: 50,
  bio: 500,
  customInstructions: 2000,
}

/** 配置字段全集（白名单）。personas 不属于活动配置，单独管理。 */
export const CONFIG_FIELDS = Object.freeze(Object.keys(DEFAULT_CONFIG))
const CONFIG_FIELD_SET = new Set(CONFIG_FIELDS)
const TEXT_FIELDS = ['nickname', 'occupation', 'bio', 'customInstructions']

/** 变更来源白名单；HTTP 传入未知来源时回落到 web。 */
export const HISTORY_SOURCES = ['web', 'tool', 'preset', 'undo', 'reset', 'service', 'command', 'api']

export const MAX_HISTORY_BYTES = 512 * 1024
export const MAX_HISTORY_LINE_BYTES = 64 * 1024
export const MAX_HISTORY_READ_BYTES = 4 * 1024 * 1024
export const MAX_HISTORY_LINES = 1000

// ==================== 人设预设常量 ====================

/** 「关于你」：使用者本人资料，任何预设都不能覆盖。 */
export const PROFILE_FIELDS = ['nickname', 'occupation', 'bio']

/** 人设预设覆盖字段：只要 Agent 的人格与说话方式，不含「关于你」。 */
export const PERSONA_FIELDS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions']

export const PERSONA_NAME_MAX = 30
const FORBIDDEN_PERSONA_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function cloneConfig(config) {
  const out = {}
  for (const key of CONFIG_FIELDS) out[key] = config[key]
  return out
}

function clonePersonas(personas) {
  const out = {}
  if (!isPlainObject(personas)) return out
  for (const name of Object.keys(personas)) out[name] = { ...personas[name] }
  return out
}

function cloneChanges(changes) {
  const out = {}
  if (!isPlainObject(changes)) return out
  for (const field of Object.keys(changes)) {
    const item = changes[field]
    if (isPlainObject(item)) out[field] = { from: item.from, to: item.to }
  }
  return out
}

function cloneProposal(proposal) {
  if (!proposal) return null
  return { at: proposal.at, source: proposal.source, changes: { ...proposal.changes } }
}

// ==================== 配置校验 / 迁移 ====================

export function clampHistoryMaxEntries(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null
  return Math.min(Math.max(value, HISTORY_MAX_ENTRIES_MIN), HISTORY_MAX_ENTRIES_MAX)
}

/** 旧版 style + tone 合并映射（与 dsh-soul v0.2.0 迁移一致）。 */
const LEGACY_STYLE_TONE_MAP = {
  'professional+formal': 'professional',
  'casual+neutral': 'casual',
  'humorous+informal': 'humorous',
}
const LEGACY_STYLE_MAP = {
  professional: 'professional',
  casual: 'casual',
  friendly: 'casual',
  humorous: 'humorous',
  academic: 'professional',
}

function textOf(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/**
 * 迁移并清洗磁盘上的配置：补默认值、合并旧 style+tone、枚举/布尔/颜色脏数据回退。
 * 只投影 DEFAULT_CONFIG 里的字段，未知键（personas / v / 废弃字段）不会进入配置。
 */
export function migrateConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const config = { ...DEFAULT_CONFIG }
  for (const key of CONFIG_FIELDS) {
    if (hasOwn(source, key)) config[key] = source[key]
  }

  if (typeof source.style === 'string' && typeof source.tone === 'string') {
    const combo = `${source.style}+${source.tone}`
    config.style = LEGACY_STYLE_TONE_MAP[combo] || LEGACY_STYLE_MAP[source.style] || DEFAULT_CONFIG.style
  }
  if (!STYLE_VALUES.includes(config.style)) {
    config.style = LEGACY_STYLE_MAP[config.style] || DEFAULT_CONFIG.style
  }

  if (typeof config.enabled !== 'boolean') config.enabled = DEFAULT_CONFIG.enabled
  if (typeof config.requireToolConfirmation !== 'boolean') config.requireToolConfirmation = DEFAULT_CONFIG.requireToolConfirmation
  if (!TRAIT_VALUES.includes(config.headingLists)) config.headingLists = DEFAULT_CONFIG.headingLists
  if (!TRAIT_VALUES.includes(config.emoji)) config.emoji = DEFAULT_CONFIG.emoji
  if (!TRAIT_VALUES.includes(config.tables)) config.tables = DEFAULT_CONFIG.tables
  if (!REPLY_LENGTH_VALUES.includes(config.replyLength)) config.replyLength = DEFAULT_CONFIG.replyLength
  if (!LANGUAGE_VALUES.includes(config.language)) config.language = DEFAULT_CONFIG.language

  if (typeof config.trailEnabled !== 'boolean') config.trailEnabled = DEFAULT_CONFIG.trailEnabled
  if (!TRAIL_SPEED_VALUES.includes(config.trailSpeed)) config.trailSpeed = DEFAULT_CONFIG.trailSpeed
  if (!TRAIL_WIDTH_VALUES.includes(config.trailWidth)) config.trailWidth = DEFAULT_CONFIG.trailWidth
  if (typeof config.trailColor !== 'string' || !TRAIL_COLOR_PATTERN.test(config.trailColor)) {
    config.trailColor = DEFAULT_CONFIG.trailColor
  } else {
    config.trailColor = config.trailColor.toUpperCase()
  }

  config.nickname = textOf(config.nickname, FIELD_LIMITS.nickname)
  config.occupation = textOf(config.occupation, FIELD_LIMITS.occupation)
  config.bio = textOf(config.bio, FIELD_LIMITS.bio)
  config.customInstructions = textOf(config.customInstructions, FIELD_LIMITS.customInstructions)

  const clamped = clampHistoryMaxEntries(config.historyMaxEntries)
  config.historyMaxEntries = clamped === null ? DEFAULT_CONFIG.historyMaxEntries : clamped
  return config
}

/**
 * 校验外部传入的配置补丁。返回 { patch, errors }：
 * - patch 只含白名单字段；errors 非空时调用方应整单拒绝（不截断、不部分写入）。
 * - 文本字段 trim；颜色统一大写；historyMaxEntries 夹取到 50..500。
 */
export function sanitizeConfig(raw) {
  const patch = {}
  const errors = {}

  if (!isPlainObject(raw)) return { patch, errors: { _: '配置必须是一个 JSON 对象' } }

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
    else errors.enabled = '必须为布尔值（true / false）'
  }
  if ('requireToolConfirmation' in raw) {
    if (typeof raw.requireToolConfirmation === 'boolean') patch.requireToolConfirmation = raw.requireToolConfirmation
    else errors.requireToolConfirmation = '必须为布尔值（true / false）'
  }
  if ('trailEnabled' in raw) {
    if (typeof raw.trailEnabled === 'boolean') patch.trailEnabled = raw.trailEnabled
    else errors.trailEnabled = '必须为布尔值（true / false）'
  }
  if ('trailColor' in raw) {
    const text = typeof raw.trailColor === 'string' ? raw.trailColor.trim() : ''
    if (text && TRAIL_COLOR_PATTERN.test(text)) patch.trailColor = text.toUpperCase()
    else errors.trailColor = '颜色必须是 6 位十六进制格式（如 #679EFE）'
  }
  if ('historyMaxEntries' in raw) {
    const clamped = clampHistoryMaxEntries(raw.historyMaxEntries)
    if (clamped !== null) patch.historyMaxEntries = clamped
    else errors.historyMaxEntries = `必须是 ${HISTORY_MAX_ENTRIES_MIN} 到 ${HISTORY_MAX_ENTRIES_MAX} 之间的整数`
  }

  for (const key of TEXT_FIELDS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string') {
      errors[key] = '必须为字符串'
      continue
    }
    const text = value.trim()
    if (text.length > FIELD_LIMITS[key]) {
      errors[key] = `长度超过上限 ${FIELD_LIMITS[key]} 字符（当前 ${text.length}）`
      continue
    }
    patch[key] = text
  }

  const ENUM_CHECKS = [
    ['style', STYLE_VALUES, '回复风格和语调'],
    ['headingLists', TRAIT_VALUES, '特质·标题和列表'],
    ['emoji', TRAIT_VALUES, '特质·表情符号'],
    ['tables', TRAIT_VALUES, '特质·表格'],
    ['replyLength', REPLY_LENGTH_VALUES, '回复长度偏好'],
    ['language', LANGUAGE_VALUES, '输出语言'],
    ['trailSpeed', TRAIL_SPEED_VALUES, '光轨流动速度'],
    ['trailWidth', TRAIL_WIDTH_VALUES, '光轨光带粗细'],
  ]
  for (const [key, values, label] of ENUM_CHECKS) {
    if (!(key in raw)) continue
    const text = typeof raw[key] === 'string' ? raw[key].trim() : ''
    if (values.includes(text)) patch[key] = text
    else errors[key] = `${label}必须是 ${values.join(' / ')} 之一`
  }

  return { patch, errors }
}

// ==================== 预设名称 / 归一化 ====================

export function sanitizePersonaName(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > PERSONA_NAME_MAX) return null
  if (FORBIDDEN_PERSONA_NAMES.has(name)) return null
  return name
}

/** 只保留普通对象条目；字段按 PERSONA_FIELDS + updatedAt 白名单过滤。 */
export function normalizePersonas(raw) {
  if (!isPlainObject(raw)) return {}
  const out = {}
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_PERSONA_NAMES.has(key)) continue
    const entry = raw[key]
    if (!isPlainObject(entry)) continue
    const clean = {}
    for (const field of Object.keys(entry)) {
      if (PERSONA_FIELDS.includes(field)) clean[field] = entry[field]
      else if (field === 'updatedAt' && typeof entry[field] === 'string') clean[field] = entry[field]
    }
    out[key] = clean
  }
  return out
}

export function personaSnapshotOf(config) {
  const values = {}
  for (const field of PERSONA_FIELDS) values[field] = config[field]
  return values
}

export function pickPersonaValues(entry) {
  const values = {}
  if (!isPlainObject(entry)) return values
  for (const field of PERSONA_FIELDS) {
    if (hasOwn(entry, field)) values[field] = entry[field]
  }
  return values
}

export function declaredPersonaKeys(entry) {
  if (!isPlainObject(entry)) return []
  return Object.keys(entry).filter((key) => key !== 'updatedAt' && key !== 'builtin' && PERSONA_FIELDS.includes(key))
}

export function personaMatches(entry, config) {
  const keys = declaredPersonaKeys(entry)
  if (keys.length === 0) return false
  return keys.every((key) => entry[key] === config[key])
}

// ==================== 内置人设（从 dsh-soul lib/personas.mjs 原样收编） ====================

export const BUILTIN_PERSONAS = {
  '苏格拉底式提问者': {
    emoji: 'default',
    tables: 'default',
    replyLength: 'normal',
    style: 'professional',
    headingLists: 'less',
    customInstructions:
      '用提问推进对话，而不是直接给答案。' +
      '先用自己的话复述你对问题的理解，确认无误后再提出 1-2 个能暴露关键假设的追问；' +
      '追问要具体、指向可验证的事实，不要问「你确定吗」这类空泛问题。' +
      '只有当用户明确要求结论，或已经追问过两轮时，才给出答案——此时要一并说明结论依赖哪些前提。',
  },
  '极简主义者': {
    style: 'efficient',
    headingLists: 'less',
    emoji: 'less',
    tables: 'less',
    replyLength: 'concise',
    customInstructions:
      '只给结论和必要依据，砍掉一切铺垫、客套与重复。' +
      '能用一句话说清就不要用三句；不主动扩展话题，也不追加未被问及的注意事项。' +
      '若信息不足以回答，只问一个最关键的问题，不要罗列一串待确认项。',
  },
  '资深架构师': {
    emoji: 'default',
    style: 'professional',
    headingLists: 'more',
    tables: 'more',
    replyLength: 'detailed',
    customInstructions:
      '以系统设计视角回答：先说清约束、假设与规模量级，再给方案。' +
      '至少对比两条技术路线，用表格列出权衡维度（复杂度、可维护性、性能、迁移成本、团队门槛）。' +
      '主动指出边界条件、失败模式与长期演进风险；' +
      '涉及取舍时给出明确推荐并说明理由，不要以「都可以，看需求」收尾。',
  },
  '教学型讲解者': {
    emoji: 'default',
    tables: 'default',
    style: 'casual',
    headingLists: 'more',
    replyLength: 'detailed',
    customInstructions:
      '按「是什么 → 为什么 → 怎么用」的顺序讲解，先建立直觉再引入术语。' +
      '开头用一个具体例子或类比，结尾用一句话总结关键点。' +
      '遇到专业名词先解释含义，不要假设用户已掌握前置知识；' +
      '但每个概念只讲一遍，不要为了周全而反复换说法重复同一件事。',
  },
  '严格代码审阅者': {
    style: 'professional',
    headingLists: 'more',
    tables: 'more',
    emoji: 'less',
    replyLength: 'detailed',
    customInstructions:
      '按代码审阅者的标准挑问题，按严重度分组：正确性 / 安全 / 性能 / 可维护性 / 风格。' +
      '每条指出具体位置、触发条件与修复方向，不要只说「这里可能有问题」。' +
      '优先报告会导致错误结果、数据损坏或安全风险的问题。' +
      '没有发现问题时，明确说明检查过哪些方面，不要为凑数编造无关痛痒的意见。',
  },
  '头脑风暴伙伴': {
    emoji: 'default',
    tables: 'default',
    replyLength: 'normal',
    style: 'casual',
    headingLists: 'more',
    customInstructions:
      '先发散再收敛：一次性给出若干方向明显不同的方案，而不是同一方案的变体。' +
      '每个方案用一句话说清核心思路与主要代价。' +
      '发散阶段不要否定任何想法；给出方案后再标出你个人最看好的一个及理由。' +
      '避免只给显而易见的选项，至少包含一个不常规但有可行性的思路。',
  },
  '自驱型协作者': {
    tables: 'default',
    replyLength: 'normal',
    style: 'professional',
    headingLists: 'more',
    emoji: 'more',
    customInstructions:
      '先自己动手再开口：把能读的读了、能查的查了、能验证的验证掉——读文件、看上下文、检索资料都算；' +
      '确实卡住才提问，并把已排查的范围与还缺什么一并说明，目标是带着方案回来而不是带着问题。' +
      '给出明确判断：比较方案时指明你更推荐哪一条及理由，不以「都可以，看需求」收尾；有不同意见就直接讲，摆出分歧点与依据。' +
      '以可核实的依据为准：涉及事实、接口、参数、版本时先查证再断言，查不到就明说「不确定」，不用听起来合理的说法填空。' +
      '实质优先于形式：直接从结论或第一步行动开始，不复述用户已经说清的需求，也不用「好问题」「我很乐意帮忙」这类开场垫话——' +
      '礼貌体现在措辞上，不体现在铺垫上。' +
      '区分两类动作：读文件、检索、整理这类内部动作大胆做；发消息、提交、发布、删除这类对外动作先确认。不发送未经整理的回复。',
  },
}

export function builtinPersonaNames() {
  return Object.keys(BUILTIN_PERSONAS)
}

export function isBuiltinPersona(name) {
  return typeof name === 'string' && hasOwn(BUILTIN_PERSONAS, name)
}

/** 内置优先；同名用户条目被遮蔽。返回 { [name]: entry, builtin? }。 */
export function mergePersonas(userPersonas) {
  const out = {}
  for (const name of builtinPersonaNames()) {
    out[name] = { ...BUILTIN_PERSONAS[name], builtin: true }
  }
  if (isPlainObject(userPersonas)) {
    for (const name of Object.keys(userPersonas)) {
      if (isBuiltinPersona(name)) continue
      out[name] = { ...userPersonas[name] }
    }
  }
  return out
}

export function resolvePersona(name, userPersonas) {
  if (typeof name !== 'string') return null
  if (isBuiltinPersona(name)) return { ...BUILTIN_PERSONAS[name] }
  if (isPlainObject(userPersonas) && hasOwn(userPersonas, name)) return { ...userPersonas[name] }
  return null
}

export function presetList(userPersonas) {
  const view = mergePersonas(userPersonas)
  const list = []
  for (const name of Object.keys(view)) {
    const entry = view[name]
    const item = { id: name, name, builtin: entry.builtin === true, ...pickPersonaValues(entry) }
    if (typeof entry.updatedAt === 'string') item.updatedAt = entry.updatedAt
    list.push(item)
  }
  return list
}

export function findActivePreset(config, userPersonas) {
  const view = mergePersonas(userPersonas)
  for (const name of Object.keys(view).sort()) {
    if (personaMatches(view[name], config)) return name
  }
  return null
}

// ==================== 提示词文案与编译器 ====================

const PROMPT_TEXT = {
  zh: {
    roleHeader: '[角色设定]',
    profileHeader: '[用户背景]',
    profileDisclaimer: '以下信息描述的是与你对话的用户本人，不是你的身份；不要把用户的职业、技术背景或自述当成你自己的设定。',
    profileNickname: (n) => `- 昵称：${n}（回复时使用这个称呼）`,
    profileOccupation: (o) => `- 职业：${o}`,
    profileBio: (b) => `- 用户自述：${b}`,
    styleHeader: '[回复风格]',
    styleLabel: '回复风格和语调：',
    styles: {
      professional: '专业严谨、注重逻辑和准确性、正式礼貌',
      casual: '轻松自然、像朋友一样交流、中性客观',
      humorous: '幽默风趣、适当使用比喻和玩笑、口语化',
      roast: '吐槽达人、犀利幽默、爱调侃但无恶意、口语化',
      efficient: '高效干练、直击要点、简洁明了、不绕弯子',
    },
    headingLists: {
      more: '采用清晰的格式和列表结构组织回答，善用标题和列表',
      less: '使用更多段落文本，减少标题和列表的使用',
    },
    emoji: {
      more: '在回复中使用较多表情符号',
      less: '尽量减少使用表情符号',
    },
    tables: {
      more: '在呈现对比、多字段信息或结构化内容时优先使用表格',
      less: '避免使用表格，改用列表或段落文本呈现',
    },
    replyLength: {
      concise: '回答尽量简洁，直击要点，不展开无关内容',
      detailed: '回答尽量详尽，充分展开背景、步骤与推理过程',
    },
    replyLanguage: {
      zh: '必须使用简体中文回复',
      en: '必须使用英语（English）回复',
    },
    joiner: '，',
    rulesHeader: '[执行规则]',
    rules: '你必须在每一条回复中严格遵守以上角色设定和回复风格；涉及用户背景时，用它来理解用户、贴合用户的需求和水平作答，而不是把它当作你自己的身份。包括但不限于：代码解释、技术问答、日常闲聊、知识科普等所有场景。违反此规则视为失败。',
    toolUpdated: '已更新个性化设置',
    toolNoChanges: '没有要更改的设置',
    toolValidationFailed: '配置校验失败：',
    toolProposal: '已收到人设变更请求（确认模式已开启，尚未生效）：',
    toolRejected: '你在审批面板中拒绝了这次人设变更，未做任何修改。',
    toolApprovalDisabled: '说明：本次会话的审批通道已被禁用（approval policy = never），因此没有弹出确认面板；这不代表你做了拒绝操作。',
    toolProposalHint: '在用户确认前不会生效；可通过面板确认或拒绝。',
  },
  en: {
    roleHeader: '[Role]',
    profileHeader: '[User profile]',
    profileDisclaimer: 'The information below describes the user you are talking to — it is NOT your own identity; do not treat the user\'s occupation, background or self-description as your persona.',
    profileNickname: (n) => `- Nickname: ${n} (address the user by this name in replies)`,
    profileOccupation: (o) => `- Occupation: ${o}`,
    profileBio: (b) => `- Self-description: ${b}`,
    styleHeader: '[Reply style]',
    styleLabel: 'Reply style & tone: ',
    styles: {
      professional: 'Rigorous and professional, focused on logic and accuracy, formal and courteous',
      casual: 'Relaxed and natural, chatting like a friend, neutral and objective',
      humorous: 'Humorous, apt with analogies and jokes, colloquial',
      roast: 'Playful roaster, sharp and witty but never mean, colloquial',
      efficient: 'Efficient and straight to the point, concise, no beating around the bush',
    },
    headingLists: {
      more: 'Organize answers with clear formatting, headings and lists',
      less: 'Use more paragraph text; minimize headings and lists',
    },
    emoji: {
      more: 'Use emojis fairly often in replies',
      less: 'Keep emoji usage to a minimum',
    },
    tables: {
      more: 'Prefer tables when presenting comparisons, multi-field or structured information',
      less: 'Avoid tables; use lists or paragraph text instead',
    },
    replyLength: {
      concise: 'Keep answers concise: hit the key points and skip unrelated elaboration',
      detailed: 'Give detailed answers: fully expand on background, steps and reasoning',
    },
    replyLanguage: {
      zh: '必须使用简体中文回复',
      en: 'You must reply in English.',
    },
    joiner: '; ',
    rulesHeader: '[Execution rules]',
    rules: 'You must strictly follow the role setup and reply style above in EVERY reply; when user background is involved, use it to understand the user and tailor your answers to their needs and level — never treat it as your own identity. This covers all scenarios including code explanation, technical Q&A, casual chat and knowledge sharing. Violating this rule counts as failure.',
    toolUpdated: 'Personalization settings updated',
    toolNoChanges: 'No settings to change',
    toolValidationFailed: 'Config validation failed: ',
    toolProposal: 'Persona change requested (confirmation mode is on — not applied yet):',
    toolRejected: 'You rejected this persona change in the approval panel — nothing was modified.',
    toolApprovalDisabled: 'Note: the approval channel is disabled in this session (approval policy = never), so no confirmation panel appeared; this does not mean you rejected anything.',
    toolProposalHint: 'It stays pending until the user confirms or rejects it.',
  },
}

function promptTextOf(config) {
  return PROMPT_TEXT[config && config.language === 'en' ? 'en' : 'zh']
}

function buildUserProfile(config, T) {
  const lines = []
  if (config.nickname) lines.push(T.profileNickname(config.nickname))
  if (config.occupation) lines.push(T.profileOccupation(config.occupation))
  if (config.bio) lines.push(T.profileBio(config.bio))
  return lines.join('\n')
}

function buildBehavior(config, T) {
  const parts = []
  if (config.style && T.styles[config.style]) parts.push(`${T.styleLabel}${T.styles[config.style]}`)
  if (config.headingLists && T.headingLists[config.headingLists]) parts.push(T.headingLists[config.headingLists])
  if (config.emoji && T.emoji[config.emoji]) parts.push(T.emoji[config.emoji])
  if (config.tables && T.tables[config.tables]) parts.push(T.tables[config.tables])
  if (config.replyLength && T.replyLength[config.replyLength]) parts.push(T.replyLength[config.replyLength])
  if (config.language && T.replyLanguage[config.language]) parts.push(T.replyLanguage[config.language])
  return parts.join(T.joiner)
}

/**
 * 人设提示词编译器：注入段、提示词预览与测试共用同一份实现。
 * - enabled=false 返回空串（完全不注入）。
 * - 未提供的字段按 DEFAULT_CONFIG 补齐；未知/非法取值不产生对应文案。
 */
export function compilePersonaPrompt(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(isPlainObject(config) ? config : {}) }
  if (!cfg.enabled) return ''

  const T = promptTextOf(cfg)
  const identity = (typeof cfg.customInstructions === 'string' ? cfg.customInstructions : '').trim()
  const profile = buildUserProfile(cfg, T)
  const behavior = buildBehavior(cfg, T)
  if (!identity && !behavior && !profile) return ''

  const parts = []
  if (identity) parts.push(`${T.roleHeader} ${identity}`)
  if (profile) parts.push(`${T.profileHeader} ${T.profileDisclaimer}\n${profile}`)
  if (behavior) parts.push(`${T.styleHeader} ${behavior}`)
  parts.push(`${T.rulesHeader} ${T.rules}`)
  return parts.join('\n')
}

// ==================== 文件读取 / 损坏备份 ====================

function backupCorruptFile(file) {
  const target = `${file}.corrupt`
  try {
    copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/** 把损坏文件移开（重置逃生口）；目标已存在时覆盖。 */
function moveAsideCorruptFile(file) {
  const target = `${file}.corrupt`
  try {
    renameSync(file, target)
    return target
  } catch {
    try {
      copyFileSync(file, target)
      rmSync(file, { force: true })
      return target
    } catch {
      return null
    }
  }
}

function readConfigFileSync(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { value: null, exists: false, failure: null }
    return {
      value: null,
      exists: true,
      failure: {
        code: 'unreadable',
        message: `人设配置读取失败（${(error && error.code) || 'unknown'}）：${(error && error.message) || error}`,
        backupPath: null,
      },
    }
  }
  try {
    return { value: JSON.parse(text), exists: true, failure: null }
  } catch (error) {
    return {
      value: null,
      exists: true,
      failure: {
        code: 'invalid-json',
        message: `人设配置不是合法的 JSON（${(error && error.message) || error}）`,
        backupPath: backupCorruptFile(file),
      },
    }
  }
}

function describeFailure(failure) {
  if (!failure) return null
  const backup = failure.backupPath ? `（原文件已备份到 ${failure.backupPath}）` : ''
  return `${failure.message}${backup}`
}

function writeRefusal(failure, file) {
  if (!failure) return null
  return `${describeFailure(failure)}。为避免覆盖，本次写入已拒绝；请修复或删除 ${file} 后重试。`
}

// ==================== 模块状态（按文件路径隔离，便于测试与多 HOME） ====================

const STATES = new Map()

function getState() {
  const file = personaFilePath()
  let state = STATES.get(file)
  if (!state) {
    state = {
      file,
      loaded: false,
      config: { ...DEFAULT_CONFIG },
      personas: {},
      failure: null,
      historyLoaded: false,
      history: [],
      historyDropped: 0,
      historyError: null,
      pendingProposal: null,
      queue: Promise.resolve(),
    }
    STATES.set(file, state)
  }
  return state
}

function ensureLoaded(state) {
  if (state.loaded) return state
  state.loaded = true
  const read = readConfigFileSync(state.file)
  if (read.failure) {
    state.failure = read.failure
    state.config = { ...DEFAULT_CONFIG }
    state.personas = {}
    return state
  }
  if (!read.exists) {
    state.config = { ...DEFAULT_CONFIG }
    state.personas = {}
    return state
  }
  const raw = read.value
  if (!isPlainObject(raw)) {
    const backupPath = backupCorruptFile(state.file)
    state.failure = {
      code: 'invalid-shape',
      message: '人设配置文件内容不是 JSON 对象',
      backupPath,
    }
    state.config = { ...DEFAULT_CONFIG }
    state.personas = {}
    return state
  }
  const configRaw = isPlainObject(raw.config) ? raw.config : raw
  state.config = migrateConfig(configRaw)
  state.personas = normalizePersonas(raw.personas)
  return state
}

function enqueue(state, task) {
  const run = state.queue.then(task)
  state.queue = run.then(() => {}, () => {})
  return run
}

function writeStateFile(state, config, personas) {
  const refusal = writeRefusal(state.failure, state.file)
  if (refusal) throw new Error(refusal)
  mkdirSync(dirname(state.file), { recursive: true })
  const doc = { v: PERSONA_VERSION, ...cloneConfig(config), personas: clonePersonas(personas) }
  const tmp = `${state.file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  renameSync(tmp, state.file)
  state.config = cloneConfig(config)
  state.personas = clonePersonas(personas)
}

// ==================== 变更历史（JSONL） ====================

function isHistoryValue(value) {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.at !== 'string' || raw.at.length > 40 || !Number.isFinite(Date.parse(raw.at))) return null
  const source = typeof raw.source === 'string' ? raw.source.trim() : ''
  if (!source || source.length > 40) return null
  if (!isPlainObject(raw.changes)) return null

  const changes = {}
  for (const field of Object.keys(raw.changes)) {
    if (!CONFIG_FIELD_SET.has(field)) continue
    const item = raw.changes[field]
    if (!isPlainObject(item) || !hasOwn(item, 'from') || !hasOwn(item, 'to')) continue
    if (!isHistoryValue(item.from) || !isHistoryValue(item.to)) continue
    changes[field] = { from: item.from, to: item.to }
  }
  if (Object.keys(changes).length === 0) return null

  const entry = { at: raw.at, source, changes }
  if (typeof raw.preset === 'string' && raw.preset.trim() && raw.preset.length <= 80) {
    entry.preset = raw.preset.trim()
  }
  return entry
}

function readHistoryText(file) {
  let info
  try {
    info = statSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: '', error: null }
    return { text: '', error: `变更记录读取失败（${(error && error.code) || 'unknown'}）：${(error && error.message) || error}` }
  }
  if (info.isDirectory()) return { text: '', error: `变更记录路径是一个目录，无法读取：${file}` }
  if (info.size <= 0) return { text: '', error: null }

  try {
    if (info.size > MAX_HISTORY_READ_BYTES) {
      const fd = openSync(file, 'r')
      try {
        const start = info.size - MAX_HISTORY_READ_BYTES
        const buffer = Buffer.alloc(MAX_HISTORY_READ_BYTES)
        let filled = 0
        while (filled < buffer.length) {
          const bytes = readSync(fd, buffer, filled, buffer.length - filled, start + filled)
          if (bytes <= 0) break
          filled += bytes
        }
        let text = buffer.subarray(0, filled).toString('utf8')
        const cut = text.indexOf('\n')
        text = cut >= 0 ? text.slice(cut + 1) : ''
        return { text, error: null }
      } finally {
        closeSync(fd)
      }
    }
    return { text: readFileSync(file, 'utf8'), error: null }
  } catch (error) {
    return { text: '', error: `变更记录读取失败：${(error && error.message) || error}` }
  }
}

function pruneHistory(state) {
  const max = clampHistoryMaxEntries(state.config.historyMaxEntries) ?? HISTORY_MAX_ENTRIES_DEFAULT
  if (state.history.length > max) state.history = state.history.slice(state.history.length - max)
  return max
}

function ensureHistory(state) {
  if (state.historyLoaded) return
  state.historyLoaded = true
  ensureLoaded(state)

  const read = readHistoryText(historyPathFor(state.file))
  if (read.error) {
    state.history = []
    state.historyError = read.error
    return
  }
  state.historyError = null

  const lines = read.text.length ? read.text.split('\n') : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let dropped = 0
  let window = lines
  if (lines.length > MAX_HISTORY_LINES) {
    dropped += lines.length - MAX_HISTORY_LINES
    window = lines.slice(lines.length - MAX_HISTORY_LINES)
  }

  const entries = []
  for (const line of window) {
    const row = line.trim()
    if (!row) continue
    if (Buffer.byteLength(row, 'utf8') > MAX_HISTORY_LINE_BYTES) {
      dropped += 1
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(row)
    } catch {
      dropped += 1
      continue
    }
    const entry = normalizeHistoryEntry(parsed)
    if (entry) entries.push(entry)
    else dropped += 1
  }

  state.history = entries
  state.historyDropped = dropped
  pruneHistory(state)
}

function persistHistory(state, appended) {
  const file = historyPathFor(state.file)
  mkdirSync(dirname(file), { recursive: true })
  const max = pruneHistory(state)

  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  const pruned = state.history.length >= max
  if (appended && size <= MAX_HISTORY_BYTES && !pruned) {
    appendFileSync(file, `${JSON.stringify(appended)}\n`, 'utf8')
  } else {
    const tmp = `${file}.${process.pid}.tmp`
    const body = state.history.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileSync(tmp, state.history.length ? `${body}\n` : '', 'utf8')
    renameSync(tmp, file)
  }
  state.historyError = null
}

function sanitizeSource(source, fallback = 'web') {
  if (typeof source !== 'string') return fallback
  const text = source.trim()
  return HISTORY_SOURCES.includes(text) ? text : fallback
}

function appendHistoryEntry(state, changes, source, preset) {
  ensureHistory(state)
  const entry = {
    at: new Date().toISOString(),
    source: sanitizeSource(source),
    changes: cloneChanges(changes),
  }
  if (typeof preset === 'string' && preset.trim()) entry.preset = preset.trim().slice(0, 80)
  if (Object.keys(entry.changes).length === 0) return null

  state.history.push(entry)
  // 先判重写：达到上限时只保留最新 max 条（丢最老的）。
  const max = clampHistoryMaxEntries(state.config.historyMaxEntries) ?? HISTORY_MAX_ENTRIES_DEFAULT
  const willPrune = state.history.length > max
  if (willPrune) state.history = state.history.slice(state.history.length - max)
  persistHistory(state, willPrune ? null : entry)
  return entry
}

function getHistoryView(state, limit = 200) {
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200
  const entries = state.history.slice(-size).reverse()
  return entries.map((entry, index) => ({
    index,
    at: entry.at,
    source: entry.source,
    changes: cloneChanges(entry.changes),
    ...(entry.preset ? { preset: entry.preset } : {}),
  }))
}

// ==================== 对外读取 API ====================

export function getConfig() {
  const state = getState()
  ensureLoaded(state)
  return cloneConfig(state.config)
}

export function snapshot() {
  const state = getState()
  ensureLoaded(state)
  ensureHistory(state)
  const config = cloneConfig(state.config)
  return {
    config,
    presets: mergePersonas(state.personas),
    presetList: presetList(state.personas),
    activeId: findActivePreset(config, state.personas),
    history: getHistoryView(state),
    historyCount: state.history.length,
    historyDropped: state.historyDropped,
    historyError: state.historyError,
    configError: describeFailure(state.failure),
    pendingProposal: cloneProposal(state.pendingProposal),
  }
}

export function getHistory(limit = 200) {
  const state = getState()
  ensureLoaded(state)
  ensureHistory(state)
  return getHistoryView(state, limit)
}

export function getPendingProposal() {
  const state = getState()
  ensureLoaded(state)
  return cloneProposal(state.pendingProposal)
}

// ==================== 配置写入 ====================

function failureResult(state) {
  return {
    ok: false,
    error: writeRefusal(state.failure, state.file),
    configError: describeFailure(state.failure),
    config: cloneConfig(state.config),
  }
}

function commitPatch(state, patch, options) {
  if (state.failure) return failureResult(state)
  const next = { ...state.config, ...patch }
  const changes = diffConfig(state.config, next)
  if (Object.keys(changes).length === 0) {
    return { ok: true, config: cloneConfig(state.config), changed: [], unchanged: true }
  }

  try {
    writeStateFile(state, next, state.personas)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), config: cloneConfig(state.config) }
  }

  let historyEntry = null
  let historyError = null
  try {
    historyEntry = appendHistoryEntry(state, changes, options && options.source, options && options.preset)
  } catch (error) {
    historyError = String((error && error.message) || error)
    state.historyError = historyError
  }

  const result = { ok: true, config: cloneConfig(state.config), changed: Object.keys(changes), historyEntry }
  if (historyError) result.historyError = historyError
  return result
}

function diffConfig(previous, next) {
  const changes = {}
  for (const field of CONFIG_FIELDS) {
    if (previous[field] === next[field]) continue
    if (previous[field] === undefined && next[field] === undefined) continue
    changes[field] = { from: previous[field], to: next[field] }
  }
  return changes
}

function optionsOf(options) {
  if (typeof options === 'string') return { source: options }
  return isPlainObject(options) ? options : {}
}

/**
 * 修改配置（部分补丁）。
 * @param {object} rawPatch 配置字段子集；未知字段丢弃，任一字段非法则整单拒绝。
 * @param {object|string} [options] { source?: string, preset?: string }
 * @returns {Promise<{ok:boolean, config:object, changed:string[], errors?:object, error?:string}>}
 */
export async function setConfig(rawPatch, options = {}) {
  const state = getState()
  ensureLoaded(state)
  const opts = optionsOf(options)
  const { patch, errors } = sanitizeConfig(rawPatch)
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, config: cloneConfig(state.config) }
  }
  return enqueue(state, () => commitPatch(state, patch, opts))
}

/**
 * 重置配置为默认值（保留自建预设与变更历史）。配置损坏时先备份/移开 .corrupt 再写默认值。
 */
export async function resetConfig() {
  const state = getState()
  ensureLoaded(state)
  return enqueue(state, () => {
    let backupPath = null
    if (state.failure) {
      if (existsSync(state.file)) {
        backupPath = moveAsideCorruptFile(state.file)
        if (!backupPath) {
          return { ok: false, error: `无法移开损坏的人设配置：${state.file}`, configError: describeFailure(state.failure) }
        }
      }
      state.failure = null
    }

    const next = { ...DEFAULT_CONFIG }
    const changes = diffConfig(state.config, next)
    try {
      writeStateFile(state, next, state.personas)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }

    let historyEntry = null
    let historyError = null
    if (Object.keys(changes).length > 0) {
      try {
        historyEntry = appendHistoryEntry(state, changes, 'reset')
      } catch (error) {
        historyError = String((error && error.message) || error)
        state.historyError = historyError
      }
    }
    const result = { ok: true, config: cloneConfig(state.config), changed: Object.keys(changes), historyEntry }
    if (backupPath) result.backupPath = backupPath
    if (historyError) result.historyError = historyError
    return result
  })
}

/**
 * 撤销到某条变更之前：index 是从最新一条起算的位置（0 = 最新）。
 * 会撤销该条以及它之后的所有改动（与 dsh-soul 的撤销语义一致），并记录一条 source=undo 的变更。
 */
export async function undoTo(index) {
  const state = getState()
  ensureLoaded(state)
  ensureHistory(state)
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: 'index 必须是从最新一条起算的非负整数（0 = 最新）' }
  }
  return enqueue(state, () => {
    if (state.failure) return failureResult(state)
    const list = state.history
    if (list.length === 0) return { ok: false, error: '还没有变更记录' }
    if (index >= list.length) return { ok: false, error: `index 超出范围（0..${list.length - 1}）` }

    // 最新在前：index=0 对应 chrono=list.length-1；目标之前 = 连目标一起撤销。
    const target = list.length - 1 - index
    const working = cloneConfig(state.config)
    for (let position = list.length - 1; position >= target; position -= 1) {
      const entry = list[position]
      for (const field of Object.keys(entry.changes)) {
        const change = entry.changes[field]
        if (working[field] !== change.to) {
          return {
            ok: false,
            error: `当前配置与变更记录不一致（字段 ${field}），已拒绝撤销`,
            diverged: true,
            field,
          }
        }
        working[field] = change.from
      }
    }

    const { patch, errors } = sanitizeConfig(working)
    if (Object.keys(errors).length > 0) {
      return { ok: false, error: '撤销后的配置未通过校验', errors }
    }
    const next = { ...DEFAULT_CONFIG, ...patch }
    const changes = diffConfig(state.config, next)
    if (Object.keys(changes).length === 0) {
      return { ok: true, config: cloneConfig(state.config), changed: [], unchanged: true, reversed: index + 1 }
    }

    try {
      writeStateFile(state, next, state.personas)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }

    let historyEntry = null
    let historyError = null
    try {
      historyEntry = appendHistoryEntry(state, changes, 'undo')
    } catch (error) {
      historyError = String((error && error.message) || error)
      state.historyError = historyError
    }
    const result = {
      ok: true,
      config: cloneConfig(state.config),
      changed: Object.keys(changes),
      reversed: index + 1,
      historyEntry,
    }
    if (historyError) result.historyError = historyError
    return result
  })
}

// ==================== 人设预设 CRUD ====================

export async function applyPreset(id) {
  const state = getState()
  ensureLoaded(state)
  const name = sanitizePersonaName(id)
  if (!name) return { ok: false, error: `预设名称无效（1-${PERSONA_NAME_MAX} 个字符）` }

  return enqueue(state, () => {
    if (state.failure) return failureResult(state)
    const entry = resolvePersona(name, state.personas)
    if (!entry) return { ok: false, error: `预设不存在：${name}` }

    const { patch, errors } = sanitizeConfig(pickPersonaValues(entry))
    const invalid = Object.keys(errors)
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: `预设「${name}」没有可应用的合法字段`, invalid }
    }
    const result = commitPatch(state, patch, { source: 'preset', preset: name })
    return { ...result, preset: name, applied: Object.keys(patch).length, invalid }
  })
}

/** 保存当前人格字段为自建预设（不含 nickname/occupation/bio）。 */
export async function savePreset(rawName) {
  const state = getState()
  ensureLoaded(state)
  const name = sanitizePersonaName(rawName)
  if (!name) return { ok: false, error: `预设名称无效（1-${PERSONA_NAME_MAX} 个字符）` }
  if (isBuiltinPersona(name)) return { ok: false, error: `「${name}」是内置预设，请换一个名称` }

  return enqueue(state, () => {
    if (state.failure) return failureResult(state)
    const personas = clonePersonas(state.personas)
    personas[name] = { ...personaSnapshotOf(state.config), updatedAt: new Date().toISOString() }
    try {
      writeStateFile(state, state.config, personas)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
    return { ok: true, presets: mergePersonas(state.personas), presetList: presetList(state.personas), saved: name }
  })
}

export async function deletePreset(id) {
  const state = getState()
  ensureLoaded(state)
  const name = sanitizePersonaName(id)
  if (!name) return { ok: false, error: `预设名称无效（1-${PERSONA_NAME_MAX} 个字符）` }
  if (isBuiltinPersona(name)) return { ok: false, error: `「${name}」是内置预设，无法删除` }

  return enqueue(state, () => {
    if (state.failure) return failureResult(state)
    if (!hasOwn(state.personas, name)) return { ok: false, error: `预设不存在：${name}` }
    const personas = clonePersonas(state.personas)
    delete personas[name]
    try {
      writeStateFile(state, state.config, personas)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
    return { ok: true, presets: mergePersonas(state.personas), presetList: presetList(state.personas), deleted: name }
  })
}

// ==================== 待确认提议 ====================

export async function confirmPendingProposal() {
  const state = getState()
  ensureLoaded(state)
  return enqueue(state, () => {
    if (state.failure) return failureResult(state)
    const proposal = state.pendingProposal
    if (!proposal) return { ok: false, error: '没有待确认的人设提议' }
    const result = commitPatch(state, { ...proposal.changes }, { source: 'tool' })
    if (result.ok) state.pendingProposal = null
    return result
  })
}

export function rejectPendingProposal() {
  const state = getState()
  ensureLoaded(state)
  const had = !!state.pendingProposal
  state.pendingProposal = null
  return { ok: true, rejected: had }
}

// ==================== 审批（set_persona 确认模式） ====================

function approvalPolicy(approval, agent) {
  try {
    const session = agent && agent.session
    if (typeof approval.overrideOf === 'function' && session) {
      const override = approval.overrideOf(session)
      if (override === 'never' || override === 'ask') return override
    }
    const configured = approval.config && approval.config.policy
    if (configured === 'never' || configured === 'ask') return configured
  } catch {
    // 读策略失败时按 ask 处理：失败方向是「多问一次」，而不是静默改动。
  }
  return 'ask'
}

/**
 * 请求宿主原生审批。返回 'allowed' | 'rejected' | 'unavailable'。
 * approval policy=never 归入 unavailable（不能谎称用户拒绝），退化到待确认提议。
 */
async function requestToolApproval(ctx, exec, changes) {
  try {
    const agent = exec && exec.agent
    if (!agent) return 'unavailable'
    const candidates = []
    if (agent.ctx && typeof agent.ctx.get === 'function') candidates.push(agent.ctx)
    if (ctx && typeof ctx.get === 'function') candidates.push(ctx)

    let approval
    for (const candidate of candidates) {
      const found = candidate.get('approval')
      if (found && typeof found.request === 'function') {
        approval = found
        break
      }
    }
    if (!approval) return 'unavailable'
    if (approvalPolicy(approval, agent) === 'never') return 'unavailable'

    const detail = Object.entries(changes)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(', ')
    const outcome = await approval.request({
      agent,
      toolName: 'set_persona',
      ...(exec && exec.callId !== undefined ? { callId: exec.callId } : {}),
      ...(exec && exec.signal !== undefined ? { signal: exec.signal } : {}),
      reason: '人设变更需要你的确认',
      displayReason: {
        en: 'Persona change requires your confirmation',
        zh: '人设变更需要你的确认',
        'zh-Hans': '人设变更需要你的确认',
      },
      detail,
    })
    if (outcome === 'allowed-once') return 'allowed'
    if (outcome === 'rejected') return 'rejected'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function formatFieldErrors(errors) {
  return Object.entries(errors || {})
    .map(([field, message]) => `${field}: ${message}`)
    .join('; ')
}

function formatChangeValues(changes) {
  return Object.entries(changes || {})
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join(', ')
}

async function executeSetPersona(args, exec, ctx) {
  const current = getConfig()
  const T = promptTextOf(current)
  const { patch, errors } = sanitizeConfig(args)
  if (Object.keys(errors).length > 0) {
    return { ok: false, message: T.toolValidationFailed + formatFieldErrors(errors) }
  }

  const proposed = {}
  for (const field of Object.keys(patch)) {
    if (current[field] !== patch[field]) proposed[field] = patch[field]
  }
  if (Object.keys(proposed).length === 0) {
    return { ok: true, message: T.toolNoChanges, changes: {} }
  }

  if (current.requireToolConfirmation) {
    const verdict = await requestToolApproval(ctx, exec, proposed)
    if (verdict === 'rejected') return { ok: false, message: T.toolRejected }
    if (verdict === 'unavailable') {
      const state = getState()
      ensureLoaded(state)
      const proposal = {
        at: new Date().toISOString(),
        source: 'tool',
        changes: { ...proposed },
      }
      state.pendingProposal = proposal
      const note = approvalPolicyNote(exec, ctx) ? `${T.toolApprovalDisabled}\n` : ''
      return {
        ok: false,
        pending: true,
        proposal,
        message: `${T.toolProposal}\n${formatChangeValues(proposed)}\n${note}${T.toolProposalHint}`,
      }
    }
  }

  const result = await setConfig(proposed, { source: 'tool' })
  if (!result.ok) {
    const reason = result.error || (result.errors ? T.toolValidationFailed + formatFieldErrors(result.errors) : 'failed')
    return { ok: false, message: reason }
  }
  if (!result.changed || result.changed.length === 0) {
    return { ok: true, message: T.toolNoChanges, changes: {} }
  }
  return {
    ok: true,
    message: T.toolUpdated,
    changes: Object.fromEntries(result.changed.map((field) => [field, result.config[field]])),
  }
}

/** 仅用于给「审批通道禁用」补一句准确说明；拿不到 approval 服务时返回 false。 */
function approvalPolicyNote(exec, ctx) {
  try {
    const agent = exec && exec.agent
    if (!agent) return false
    const candidates = []
    if (agent.ctx && typeof agent.ctx.get === 'function') candidates.push(agent.ctx)
    if (ctx && typeof ctx.get === 'function') candidates.push(ctx)
    for (const candidate of candidates) {
      const approval = candidate.get('approval')
      if (approval && typeof approval.request === 'function' && approvalPolicy(approval, agent) === 'never') return true
    }
  } catch {
    // ignore
  }
  return false
}

// ==================== 工具注册 ====================

const TOOL_DESCRIPTION =
  '调整当前人设与个性化设置（称呼、回复风格和语调、特质、回复长度、回复语言、自定义指令）。' +
  '当用户明确要求改变称呼、语气、风格、长度、语言或角色时使用。' +
  '只需要传入要修改的字段，未提供的字段保持不变。\n' +
  'Adjust the current persona and personalization settings (nickname, reply style & tone, traits, reply length, language, custom instructions). ' +
  'Use it when the user explicitly asks to change how they are addressed, the tone, style, length, language, or the role. ' +
  'Pass only the fields to change; omitted fields keep their current values.'

const TOOL_PARAMETERS = {
  nickname: { type: 'string', description: '用户昵称，回复时会使用这个称呼。/ The nickname to address the user by.' },
  occupation: { type: 'string', description: '用户的职业。/ The user’s occupation.' },
  bio: { type: 'string', description: '关于用户的介绍。/ Background about the user.' },
  style: {
    type: 'string',
    enum: STYLE_VALUES,
    description: '回复风格和语调：professional=专业严谨，casual=轻松自然，humorous=幽默风趣，roast=吐槽达人，efficient=高效干练。/ Reply style & tone.',
  },
  language: {
    type: 'string',
    enum: LANGUAGE_VALUES,
    description: '回复语言：zh=简体中文，en=English。/ Reply language.',
  },
  headingLists: {
    type: 'string',
    enum: TRAIT_VALUES,
    description: '特质·标题和列表：default=默认，more=增强，less=减弱（更多段落文本）。/ Headings & lists.',
  },
  emoji: {
    type: 'string',
    enum: TRAIT_VALUES,
    description: '特质·表情符号：default=默认，more=较多，less=尽量少。/ Emoji usage.',
  },
  tables: {
    type: 'string',
    enum: TRAIT_VALUES,
    description: '特质·表格：default=默认，more=优先表格，less=避免表格。/ Table usage.',
  },
  replyLength: {
    type: 'string',
    enum: REPLY_LENGTH_VALUES,
    description: '回复长度：concise=简洁，normal=适中，detailed=详尽。/ Reply length preference.',
  },
  customInstructions: {
    type: 'string',
    description: '额外的自定义指令，用于覆盖或补充当前人设。/ Extra custom instructions that override or extend the current persona.',
  },
}

function installPersonaTool(ctx, warn) {
  let dispose = null
  let installed = false

  const install = (toolsCtx) => {
    if (installed) return
    if (!toolsCtx || !toolsCtx.tools || typeof toolsCtx.tools.register !== 'function') return
    installed = true
    try {
      const tool = defineTool({
        name: 'set_persona',
        description: TOOL_DESCRIPTION,
        parameters: TOOL_PARAMETERS,
        output: {
          schema: { type: 'json' },
          render: (_args, value) => {
            const text = typeof value?.message === 'string' && value.message.length > 0
              ? value.message
              : (value?.ok === true ? 'ok' : 'failed')
            return [{ type: 'text', text }]
          },
        },
        async execute(args, exec) {
          return executeSetPersona(args, exec, ctx)
        },
      })
      const handle = toolsCtx.tools.register(tool)
      if (typeof handle === 'function') dispose = handle
      else if (handle && typeof handle.dispose === 'function') dispose = () => handle.dispose()
    } catch (error) {
      warn('[aura] set_persona 工具注册失败:', (error && error.message) || error)
    }
  }

  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    install(ctx)
  } else if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], install)
    } catch (error) {
      warn('[aura] set_persona 工具注入失败:', (error && error.message) || error)
    }
  }

  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // ignore
    }
    dispose = null
  }
}

// ==================== HTTP 路由 ====================

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostIsLoopback(req) {
  const host = req.headers && req.headers.host
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
  return LOOPBACK.has(name.toLowerCase())
}

/** 与 host/web.js 同口径：仅本机 Host + 非跨站 + Origin 缺省或同源。 */
function fence(req) {
  if (!hostIsLoopback(req)) return false
  const site = req.headers['sec-fetch-site']
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
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

function readBody(req, limit = 64 * 1024) {
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
        resolve(isPlainObject(value) ? value : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function publicConfig(config) {
  // 人设配置没有密钥字段；返回拷贝即可（保留「redacted」命名以贴合状态响应契约）。
  return cloneConfig(config)
}

function errorStatus(result) {
  if (result && result.configError) return 409
  if (result && result.errors) return 400
  return 500
}

function routeFailure(res, result) {
  const status = errorStatus(result)
  json(res, status, {
    ok: false,
    error: (result && result.error) || '操作失败',
    ...(result && result.errors ? { errors: result.errors } : {}),
    ...(result && result.configError ? { configError: result.configError } : {}),
    ...(result && result.invalid ? { invalid: result.invalid } : {}),
  })
}

function createWebRegistration(ctx, warn) {
  return {
    kind: 'prefix',
    path: PERSONA_API_PREFIX,
    async handler(req, res) {
      if (!fence(req)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const route = url.pathname.replace(/^\/dsh-aura\/persona-api/, '') || '/'
      try {
        if (req.method === 'GET' && route === '/state') {
          const snap = snapshot()
          json(res, 200, {
            ok: true,
            config: publicConfig(snap.config),
            presets: snap.presets,
            userPresets: clonePersonas(getState().personas),
            presetList: snap.presetList,
            activeId: snap.activeId,
            historyCount: snap.historyCount,
            history: snap.history,
            historyDropped: snap.historyDropped,
            historyError: snap.historyError,
            configError: snap.configError,
            pendingProposal: snap.pendingProposal,
          })
          return
        }

        if (req.method === 'POST' && route === '/save') {
          const body = await readBody(req)
          if (!isPlainObject(body.config)) {
            json(res, 400, { ok: false, error: '缺少 config 对象' })
            return
          }
          const result = await setConfig(body.config, { source: body.source })
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            config: publicConfig(result.config),
            changed: result.changed,
            unchanged: !!result.unchanged,
            historyEntry: result.historyEntry || null,
            ...(result.historyError ? { historyError: result.historyError } : {}),
            prompt: compilePersonaPrompt(result.config),
          })
          return
        }

        if (req.method === 'POST' && route === '/reset') {
          const result = await resetConfig()
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            config: publicConfig(result.config),
            changed: result.changed,
            ...(result.backupPath ? { backupPath: result.backupPath } : {}),
            ...(result.historyError ? { historyError: result.historyError } : {}),
            prompt: compilePersonaPrompt(result.config),
          })
          return
        }

        if (req.method === 'POST' && route === '/preset/apply') {
          const body = await readBody(req)
          const result = await applyPreset(body.id ?? body.name)
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            config: publicConfig(result.config),
            changed: result.changed,
            unchanged: !!result.unchanged,
            preset: result.preset,
            applied: result.applied,
            invalid: result.invalid,
            ...(result.historyError ? { historyError: result.historyError } : {}),
            prompt: compilePersonaPrompt(result.config),
          })
          return
        }

        if (req.method === 'POST' && route === '/preset/save') {
          const body = await readBody(req)
          const result = await savePreset(body.name ?? body.id)
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            presets: result.presets,
            presetList: result.presetList,
            saved: result.saved,
          })
          return
        }

        if (req.method === 'POST' && route === '/preset/delete') {
          const body = await readBody(req)
          const result = await deletePreset(body.id ?? body.name)
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            presets: result.presets,
            presetList: result.presetList,
            deleted: result.deleted,
          })
          return
        }

        if (req.method === 'POST' && route === '/history/undo') {
          const body = await readBody(req)
          if (!Number.isInteger(body.index)) {
            json(res, 400, { ok: false, error: 'index 必须是整数（0 = 最新一条）' })
            return
          }
          const result = await undoTo(body.index)
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, {
            ok: true,
            config: publicConfig(result.config),
            changed: result.changed,
            unchanged: !!result.unchanged,
            reversed: result.reversed,
            ...(result.historyError ? { historyError: result.historyError } : {}),
            prompt: compilePersonaPrompt(result.config),
          })
          return
        }

        if (req.method === 'POST' && route === '/preview') {
          const body = await readBody(req)
          const current = getConfig()
          let draft = current
          let invalid = []
          if (isPlainObject(body.config)) {
            const { patch, errors } = sanitizeConfig(body.config)
            invalid = Object.keys(errors)
            draft = { ...current, ...patch }
          }
          json(res, 200, {
            ok: true,
            prompt: compilePersonaPrompt(draft),
            enabled: draft.enabled,
            invalid,
          })
          return
        }

        if (req.method === 'GET' && route === '/pending') {
          json(res, 200, { ok: true, proposal: getPendingProposal() })
          return
        }

        if (req.method === 'POST' && route === '/pending/confirm') {
          const result = await confirmPendingProposal()
          if (!result.ok) {
            routeFailure(res, result)
            return
          }
          json(res, 200, { ok: true, config: publicConfig(result.config), changed: result.changed })
          return
        }

        if (req.method === 'POST' && route === '/pending/reject') {
          json(res, 200, { ok: true, ...rejectPendingProposal() })
          return
        }

        json(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        const message = String((error && error.message) || error)
        warn('[aura] 人设 API 失败:', message)
        const status = message === 'invalid json' || message === 'body too large' ? 400 : 500
        json(res, status, { ok: false, error: message })
      }
    },
  }
}

// ==================== 初始化 ====================

/**
 * 初始化人设模块。
 * @param {{ ctx?: any, state?: any, log?: Function }} options
 * @returns {{ dispose: Function, getConfig: Function, setConfig: Function, snapshot: Function, compilePrompt: Function }}
 */
export function initPersona({ ctx, state, log } = {}) {
  const warn = (...args) => {
    try {
      if (typeof log === 'function') log(...args)
    } catch {
      // 日志失败不影响功能
    }
  }

  const boot = getState()
  ensureLoaded(boot)
  if (boot.failure) warn('[aura] 人设配置损坏：', describeFailure(boot.failure))

  const disposers = []
  let disposed = false
  const addDisposer = (value) => {
    if (typeof value === 'function') disposers.push(value)
    else if (value && typeof value.dispose === 'function') disposers.push(() => value.dispose())
  }

  // 1) system prompt 注入：section 优先，宿主没有 section 时用 context。order=25。
  try {
    const promptApi = ctx && ctx.systemPrompt
    const options = {
      name: 'aura:persona',
      order: 25,
      interpolate: false,
      text: () => {
        try {
          return compilePersonaPrompt(getConfig())
        } catch (error) {
          warn('[aura] 人设提示词渲染失败:', (error && error.message) || error)
          return ''
        }
      },
    }
    if (promptApi && typeof promptApi.section === 'function') {
      addDisposer(promptApi.section(options))
    } else if (promptApi && typeof promptApi.context === 'function') {
      addDisposer(promptApi.context(options))
    }
  } catch (error) {
    warn('[aura] 人设注入段注册失败:', (error && error.message) || error)
  }

  // 2) 本机 HTTP API：贴 /dsh-aura/persona-api 前缀。
  try {
    if (ctx && ctx.webServer && typeof ctx.webServer.register === 'function') {
      const registration = createWebRegistration(ctx, warn)
      if (typeof ctx.effect === 'function') {
        addDisposer(ctx.effect(() => ctx.webServer.register(registration)))
      } else {
        addDisposer(ctx.webServer.register(registration))
      }
    }
  } catch (error) {
    warn('[aura] 人设 API 注册失败:', (error && error.message) || error)
  }

  // 3) Agent 工具 set_persona。
  try {
    addDisposer(installPersonaTool(ctx, warn))
  } catch (error) {
    warn('[aura] set_persona 工具安装失败:', (error && error.message) || error)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.reverse()) {
      try {
        disposer()
      } catch {
        // ignore
      }
    }
    disposers.length = 0
  }

  return {
    dispose,
    getConfig: () => getConfig(),
    setConfig: (patch, options) => setConfig(patch, options),
    snapshot: () => snapshot(),
    compilePrompt: (config) => compilePersonaPrompt(config === undefined ? getConfig() : config),
  }
}
