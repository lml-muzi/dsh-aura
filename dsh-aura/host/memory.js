/**
 * 记忆层（Host 侧）：短期事件流 / 长期笔记 / 话题索引 / 关键词召回 / 反思 / 记忆工具。
 *
 * 设计依据：docs/aura-soul-design.md 的 C（记忆）、E.4（context order 40）、E.5.2/E.5.3（soul_note/soul_recall）。
 *
 * 状态所有权：记忆数据存在 soul.get().memory 里，由 soul.js 统一落盘。
 * 成本策略：默认**规则反思**（零 token）；只有用户显式打开 memoryReflectionLlm 且宿主有可用模型时才走 LLM 反思，
 * 且失败自动回退规则。绝不为每轮对话起一次模型调用。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  clamp,
  codepointSlice,
  codepointLength,
  isSoulSession,
} from './soul.js'

export const SUMMARY_MAX = 80
export const MEMORY_CONTEXT_BUDGET = 180
export const NOTE_MAX_CHARS = 120
export const NOTE_MAX = 20
export const EVENT_MAX = 40
export const TOPIC_MAX = 60

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

/** 关键词召回笔记（纯函数，不写状态）。 */
export function recallNotes(soul, query, options = {}) {
  const now = asNumber(options.now, Date.now())
  const limit = clamp(asNumber(options.limit, 3), 1, 8)
  const category = options.category
  const memory = soul?.memory ?? {}
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
  if (result.length === 0 && queryGrams.size > 0) {
    // 关键词没命中时，退而给「最重要的长期事实」（≤2 条），避免记忆段整段空掉
    return pool
      .filter((note) => asNumber(note.importance, 0.5) >= 0.75)
      .sort((a, b) => asNumber(b.importance, 0.5) - asNumber(a.importance, 0.5))
      .slice(0, Math.min(2, limit))
  }
  return result
}

/** 召回最近事件（纯函数）。 */
export function recallEvents(soul, query, limit = 2, now = Date.now()) {
  const events = asArray(soul?.memory?.events)
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

function recentTopics(soul, limit = 3, now = Date.now()) {
  const topics = asObject(soul?.memory?.topics)
  return Object.entries(topics)
    .map(([key, value]) => ({ key, lastAt: asNumber(value?.lastAt, 0), count: asNumber(value?.count, 1) }))
    .filter((item) => now - item.lastAt < 14 * 86_400_000)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
}

/** 记忆上下文段（context order 40）。默认 ≤180 字；没有可说的就返回空串。 */
export function renderMemoryContext(soul, config = {}, options = {}) {
  if (config?.soulEnabled === false) return ''
  const now = asNumber(options.now, Date.now())
  const query = String(options.lastUserText ?? soul?.relation?.lastUserText ?? '')
  const limit = clamp(asNumber(config?.memoryRecallLimit, 3), 1, 3)
  const parts = []

  const notes = recallNotes(soul, query, { limit, now })
  if (notes.length > 0) {
    const line = notes.map((note) => note.text).join('；')
    parts.push(`（关于对方/你们，你记得：${line}）`)
  } else {
    const events = recallEvents(soul, query, 2, now)
    if (events.length > 0) {
      parts.push(`（最近：${events.map((event) => event.summary).join('；')}）`)
    }
  }

  const pendingThought = soul?.speak?.pendingThought
  if (pendingThought && typeof pendingThought === 'object' && asNumber(pendingThought.expiresAt, 0) > now) {
    const thought = String(pendingThought.text ?? pendingThought.summary ?? '').trim()
    if (thought) parts.push(`（你上次想说但没说出口的念头：${thought.slice(0, 80)}）`)
  }

  const topics = recentTopics(soul, 3, now)
  if (topics.length > 0 && parts.join('').length < 120) {
    parts.push(`（最近聊过：${topics.map((item) => item.key).join('、')}）`)
  }

  return codepointSlice(parts.join(''), MEMORY_CONTEXT_BUDGET)
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

// ---------- 安装 ----------

export function installMemory(ctx, { state, soul, log } = {}) {
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  if (!soul || typeof soul.get !== 'function') {
    logger('[soul] memory 未收到 soul 容器，本模块跳过安装')
    return {
      snapshot: () => ({}),
      renderContext: () => '',
      recall: () => [],
      pendingDue: () => [],
      note: () => ({ ok: false }),
      reflect: async () => ({ ok: false }),
      onUserMessage: () => {},
      onAssistantMessage: () => {},
      onTurnEnd: () => {},
    }
  }
  const localDefaults = {
    soulEnabled: true,
    emotionScope: 'qq',
    memoryMaxEvents: EVENT_MAX,
    memoryMaxNotes: NOTE_MAX,
    memoryReflectionEvery: 3,
    memoryDiaryEnabled: false,
    memoryRecallLimit: 3,
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
  const readSoul = () => soul.get()
  let pending = null
  let reflectBuffer = []
  let reflecting = false
  let lastReflectAttempt = 0

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
          if (!isSoulSession(config, sessionId)) return ''
          return renderMemoryContext(readSoul(), config)
        } catch (error) {
          logger('[soul] memory context 渲染失败:', error instanceof Error ? error.message : error)
          return ''
        }
      },
    })
  } catch (error) {
    logger('[soul] memory context 注册失败:', error instanceof Error ? error.message : error)
  }

  // ② 事件流 / 话题索引写入
  function pushEvent(event) {
    const current = readSoul()
    const config = readConfig()
    // 去重：同一事件（同 kind + 摘要 + 会话）在 1.5 秒内重复出现，多半是
    // session/event 在 agent resume/replay 时被再次投递；不要重复记账。
    const last = current.memory.events[current.memory.events.length - 1]
    if (last
      && last.kind === event.kind
      && last.summary === event.summary
      && String(last.sessionId ?? '') === String(event.sessionId ?? '')
      && Math.abs(Number(last.at ?? 0) - Number(event.at ?? 0)) < 1500) {
      return last
    }
    current.memory.events.push(event)
    current.memory.events = trimEvents(current.memory.events, clamp(asNumber(config.memoryMaxEvents, EVENT_MAX), 5, 200))
    for (const topic of asArray(event.topics)) {
      const key = String(topic).slice(0, 8)
      if (!key) continue
      const entry = asObject(current.memory.topics[key])
      current.memory.topics[key] = { lastAt: event.at, count: asNumber(entry.count, 0) + 1 }
    }
    const keys = Object.keys(current.memory.topics)
    if (keys.length > TOPIC_MAX) {
      const keep = keys
        .sort((a, b) => asNumber(current.memory.topics[b]?.lastAt, 0) - asNumber(current.memory.topics[a]?.lastAt, 0))
        .slice(0, TOPIC_MAX)
      current.memory.topics = Object.fromEntries(keep.map((key) => [key, current.memory.topics[key]]))
    }
    soul.saveSoon()
    return event
  }

  function makeEvent({ kind, summary, topics, salience, sessionId, at, source }) {
    return {
      id: newId('evt'),
      at: asNumber(at, Date.now()),
      kind: ['chat', 'proactive', 'milestone', 'diary', 'note'].includes(kind) ? kind : 'chat',
      summary: codepointSlice(String(summary ?? '').trim(), SUMMARY_MAX),
      salience: clamp(asNumber(salience, 0.3), 0, 1),
      topics: asArray(topics).map((topic) => String(topic).slice(0, 8)).filter(Boolean).slice(0, 4),
      mood: {
        label: readSoul()?.emotion?.transient?.label ?? '',
        valence: Number(readSoul()?.emotion?.transient?.valence) || 0,
      },
      source: source || 'rule',
      sessionId: String(sessionId ?? ''),
    }
  }

  // ③ 回合配对
  function onUserMessage(payload = {}) {
    try {
      const text = String(payload.text ?? '').trim()
      if (!text) return
      pending = {
        userText: text,
        at: asNumber(payload.at, Date.now()),
        sessionId: String(payload.sessionId ?? ''),
        assistantText: '',
      }
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
      const intensity = Number(current.emotion?.transient?.intensity) || 0
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
      const every = clamp(asNumber(config.memoryReflectionEvery, 3), 1, 20)
      const immediate = SELF_DISCLOSURE_RE.test(turn.userText) || CONFLICT_RE.test(turn.userText) || MAKE_UP_RE.test(turn.userText)
      if (reflectBuffer.length >= every || immediate) {
        void reflect({ reason: immediate ? 'immediate' : 'every-n' })
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
      soul.saveSoon()
    } catch (error) {
      logger('[soul] memory onStage 失败:', error instanceof Error ? error.message : error)
    }
  }

  // ⑤ 反思应用（规则或 LLM）
  function applyReflection(result, source) {
    if (!result) return { ok: false }
    const current = readSoul()
    const config = readConfig()
    const now = Date.now()
    const maxNotes = clamp(asNumber(config.memoryMaxNotes, NOTE_MAX), 5, 50)
    for (const note of asArray(result.newNotes)) {
      if (!note || !note.text) continue
      const list = current.memory.notes[note.category] ?? current.memory.notes.user
      mergeNote(list, note, maxNotes)
      if (note.dueAt) {
        current.memory.pendingDue.push({ id: newId('due'), noteId: note.id, at: note.dueAt, text: note.text })
        current.memory.pendingDue = current.memory.pendingDue.slice(-20)
      }
    }
    for (const topic of asArray(result.topics)) {
      const key = String(topic).slice(0, 8)
      if (!key) continue
      const entry = asObject(current.memory.topics[key])
      current.memory.topics[key] = { lastAt: now, count: asNumber(entry.count, 0) + 1 }
    }
    if (result.relationDelta) {
      const change = soul.addRelationScore(result.relationDelta, now)
      if (change.changed) logger(`[soul] 反思推动关系 ${change.from} → ${change.to}`)
    }
    if (result.addressPreferred) current.identity.address.userPreferred = String(result.addressPreferred).slice(0, 20)
    if (result.userState) current.memory.userState = { label: result.userState, at: now }
    if (result.closer) {
      current.speak.suppressUntil = Math.max(asNumber(current.speak.suppressUntil, 0), now + 12 * 3_600_000)
    }
    if (result.milestone) {
      pushEvent(makeEvent({ kind: 'milestone', summary: result.milestone, topics: result.topics, salience: 0.9, at: now, source }))
    }
    current.memory.lastReflectAt = now
    current.meta.lastConsolidateAt = now
    soul.saveSoon()
    return { ok: true, notes: asArray(result.newNotes).length, relationDelta: result.relationDelta }
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
    const existingNotes = []
    for (const key of ['user', 'us', 'self']) {
      for (const note of asArray(current.memory.notes[key])) existingNotes.push(note)
    }
    const prompt = buildReflectionPrompt({
      turns,
      emotion: current.emotion,
      relation: current.relation,
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
        const current = readSoul()
        const lastEvent = current.memory.events[current.memory.events.length - 1]
        if (lastEvent && !lastEvent.summary) lastEvent.summary = result.summary
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
      const current = readSoul()
      const config = readConfig()
      const maxNotes = clamp(asNumber(config.memoryMaxNotes, NOTE_MAX), 5, 50)
      const key = ['user', 'us', 'self'].includes(category) ? category : 'user'
      const made = makeNote(key, clean, clamp(asNumber(importance, 0.6), 0, 1), Date.now(), dueAt)
      if (!made) return { ok: false, reason: '文本为空' }
      const merged = mergeNote(current.memory.notes[key], made, maxNotes)
      if (made.dueAt) {
        current.memory.pendingDue.push({ id: newId('due'), noteId: made.id, at: made.dueAt, text: made.text })
        current.memory.pendingDue = current.memory.pendingDue.slice(-20)
      }
      current.memory.lastReflectAt = Date.now()
      soul.saveSoon()
      return { ok: true, merged: merged.merged, note: merged.note ?? made, count: current.memory.notes[key].length }
    } catch (error) {
      logger('[soul] soul_note 失败:', error instanceof Error ? error.message : error)
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function recall(query, options = {}) {
    try {
      const now = Date.now()
      const limit = clamp(asNumber(options.limit, 5), 1, 8)
      const notes = recallNotes(readSoul(), query, { now, category: options.category, limit })
      const events = recallEvents(readSoul(), query, limit, now)
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
      name: 'soul_note',
      description: '把值得长期记住的东西写进你的记忆。category：user=关于对方的事实/偏好/边界，'
        + 'us=你们之间的约定和共同经历，self=你对自己的认识。text ≤120 字；重复的会自动合并。',
      parameters: {
        category: { type: 'string', description: 'user | us | self', required: true },
        text: { type: 'string', description: '≤120 字，一句话', required: true },
        importance: { type: 'number', description: '0..1，越重要越不容易被淘汰' },
        dueAt: { type: 'string', description: '可选：到时要问的约定，填 ISO 时间（如"面试是明天"）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value?.ok ? '记住了' : `没记住：${String(value?.reason ?? '')}` }],
      },
      async execute(args = {}) {
        let dueAt = 0
        if (typeof args?.dueAt === 'string' && args.dueAt.trim()) {
          const parsed = Date.parse(args.dueAt)
          if (Number.isFinite(parsed) && parsed > Date.now()) dueAt = parsed
        }
        return note(args?.category, args?.text, args?.importance, dueAt)
      },
    }))
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
        render: (_args, value) => [{
          type: 'text',
          text: Array.isArray(value?.items) && value.items.length > 0
            ? value.items.map((item) => `- ${item.text}`).join('\n')
            : '（想不起来了）',
        }],
      },
      async execute(args = {}) {
        const items = recall(args?.query, { category: args?.category, limit: args?.limit })
        return { items, count: items.length }
      },
    }))
  } catch (error) {
    logger('[soul] 记忆工具注册失败:', error instanceof Error ? error.message : error)
  }

  // ⑧ API
  function snapshot() {
    try {
      const current = readSoul()
      const notes = current.memory.notes
      const counts = { user: asArray(notes.user).length, us: asArray(notes.us).length, self: asArray(notes.self).length }
      return {
        eventCount: asArray(current.memory.events).length,
        notes: counts,
        topics: Object.keys(asObject(current.memory.topics)).length,
        pendingDue: asArray(current.memory.pendingDue).length,
        lastReflectAt: current.memory.lastReflectAt || 0,
        recent: asArray(current.memory.events).slice(-5).map((event) => ({
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
        userState: current.memory.userState ?? null,
        reflectionLlm: readConfig().memoryReflectionLlm === true,
      }
    } catch (error) {
      logger('[soul] memory snapshot 失败:', error instanceof Error ? error.message : error)
      return {}
    }
  }

  function clear() {
    try {
      const current = readSoul()
      current.memory.events = []
      current.memory.notes = { user: [], us: [], self: [] }
      current.memory.topics = {}
      current.memory.pendingDue = []
      current.memory.diary = []
      current.memory.lastReflectAt = 0
      current.memory.userState = null
      reflectBuffer = []
      soul.saveSoon()
      logger('[soul] 记忆已清空（事件/笔记/话题/待办）')
      return { ok: true }
    } catch (error) {
      logger('[soul] 清空记忆失败:', error instanceof Error ? error.message : error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function pendingDue(now = Date.now()) {
    try {
      const list = asArray(readSoul().memory.pendingDue)
        .filter((item) => item && asNumber(item.at, 0) > 0 && asNumber(item.at, 0) <= now)
        .sort((a, b) => asNumber(a.at, 0) - asNumber(b.at, 0))
      return list
    } catch {
      return []
    }
  }

  function consumeDue(now = Date.now()) {
    const due = pendingDue(now)
    try {
      const current = readSoul()
      const dueIds = new Set(due.map((item) => item.id))
      current.memory.pendingDue = asArray(current.memory.pendingDue).filter((item) => !dueIds.has(item.id))
      soul.saveSoon()
    } catch {
      /* ignore */
    }
    return due
  }

  return {
    snapshot,
    renderContext: (now) => {
      try {
        return renderMemoryContext(readSoul(), readConfig(), { now: asNumber(now, Date.now()) })
      } catch {
        return ''
      }
    },
    recall,
    note,
    reflect,
    pendingDue,
    consumeDue,
    clear,
    addEvent: (event) => pushEvent(event),
    onUserMessage,
    onAssistantMessage,
    onTurnEnd,
    constants: { TOPIC_VOCAB, SUMMARY_MAX, MEMORY_CONTEXT_BUDGET },
  }
}
