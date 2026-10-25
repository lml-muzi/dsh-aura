/**
 * 日记系统（Host 侧）：独立于灵魂/记忆的私人日记。
 *
 * 数据：$DSH_HOME/dsh-aura/diary.json（或调用方传入的 home 目录）
 *   { version: 1, entries: [{ date, at, mood, summary, highlights, private?, source }] }
 *   - 按 date 升序保存；同一天只留一条。
 *   - 同一天再次写入：覆盖 summary/at/mood/source，合并去重 highlights；
 *     private 未显式给出时保留原值。
 *
 * 设计约束：
 * - 与 memory 分开：日记不写进 soul.memory，也不参与任何 system prompt 注入。
 * - 零新增依赖、Node ESM；文件写入统一 tmp + rename。
 * - 每次写/删之前尽量做一次 backup.snapshot('diary')；失败只 warn，不阻断。
 * - 自动写：scheduleAuto() 在安装 10s 后查一次，之后每 30 分钟查一次。
 *   开关/时间/最少事件数来自 config 的 diaryAuto / diaryAutoHour(0-23) / diaryAutoMinEvents(1-20)；
 *   每个自然日最多自动写 2 篇（今天 + 跨天补昨天）。已有条目 force=false 不覆盖。
 * - 可选 ctx：传入时自动注册 soul_diary 工具与 /dsh-aura/diary-api 路由；
 *   ctx.get('webServer') / ctx.get('tools') 都取不到时静默跳过。
 *
 * HTTP 路由（prefix /dsh-aura/diary-api，仅本机 + Origin 围栏）：
 *   GET  ?action=list&limit=7          -> 200 { ok, entries: [entry...], count }
 *   GET  ?action=get&date=YYYY-MM-DD    -> 200 { ok, date, entry }（没有则为 null）
 *   GET  ?action=today                  -> 200 { ok, date, entry }
 *   POST { action:'save', date?, summary|text, highlights?, private?, mood?, source? }
 *        -> 200 { ok, date, entry, overwritten }
 *   POST { action:'generate', date?, mode?:'rule'|'llm', force? }
 *        -> 200 { ok, date, entry, skipped, reason, via, overwritten }
 *   POST { action:'autoWrite', force? }
 *        -> 200 { ok, skipped, reason, wrote, dates }
 *           force=true 忽略 diaryAuto 开关/时间/当日上限（面板「自动补一篇」用）
 *   POST { action:'delete', date }      -> 200 { ok, date, removed, entry? }
 *   围栏失败 403 { ok:false, error:'forbidden' }；参数错 400；内部错 500。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMemoryStore } from './memory-store.js'

export const DIARY_VERSION = 1
export const DIARY_FILE = 'diary.json'
export const DIARY_API_PREFIX = '/dsh-aura/diary-api'
export const DIARY_SOURCES = Object.freeze(['auto', 'self', 'user'])
export const DIARY_SUMMARY_MAX = 500
export const DIARY_PROMPT_MAX = 200
export const DIARY_HIGHLIGHT_MAX = 8
export const DIARY_HIGHLIGHT_CHARS = 60
export const DIARY_LIST_DEFAULT = 7
export const DIARY_TOOL_NAME = 'soul_diary'
/** 自动写：安装后 10s 先查一次，之后每 30 分钟一次。 */
export const DIARY_AUTO_INTERVAL_MS = 30 * 60_000
export const DIARY_AUTO_INITIAL_DELAY_MS = 10_000
/** 每个自然日最多自动写几篇（今天 + 昨天补齐）。 */
export const DIARY_AUTO_DAILY_CAP = 2
/** 配置缺省值（与 state.js 的 DEFAULT_CONFIG 同口径）。 */
export const DIARY_AUTO_HOUR_DEFAULT = 22
export const DIARY_AUTO_MIN_EVENTS_DEFAULT = 3
export const DIARY_AUTO_MARK_MAX = 40

const SOURCE_SET = new Set(DIARY_SOURCES)
const STAGE_TEXT = {
  stranger: '陌生',
  familiar: '熟悉',
  close: '亲密',
  intimate: '很亲近',
}
const EVENT_KIND_TEXT = {
  chat: '聊天',
  proactive: '主动搭话',
  milestone: '关系里程碑',
  diary: '日记',
  note: '笔记',
}

// ---------- 基础工具（纯函数） ----------

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地日期键 YYYY-MM-DD（与 soul.js 的 localDayKey 同口径，按本机时区）。 */
export function localDayKey(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 严格校验 YYYY-MM-DD（2026-02-30 这类不存在的日期返回 false）。 */
export function isDateKey(value) {
  const text = String(value ?? '')
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function codepointSlice(text, max) {
  const points = Array.from(String(text ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

export function codepointLength(text) {
  return Array.from(String(text ?? '')).length
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function cleanLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return codepointSlice(text, max)
}

function normalizeDiarySummary(value, max = DIARY_SUMMARY_MAX) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim()
  return codepointSlice(text, max)
}

/** highlights 接受数组或「、，逗号」分隔的字符串；去重、限长、限数量。 */
export function normalizeHighlights(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[、,，\n]+/) : [])
  const list = []
  const seen = new Set()
  for (const item of source) {
    const text = cleanLine(item, DIARY_HIGHLIGHT_CHARS)
    if (!text || seen.has(text)) continue
    seen.add(text)
    list.push(text)
    if (list.length >= DIARY_HIGHLIGHT_MAX) break
  }
  return list
}

export function moodFromSoul(soul) {
  const emotion = soul && typeof soul === 'object' && soul.emotion && typeof soul.emotion === 'object'
    ? soul.emotion
    : {}
  const transient = emotion.transient && typeof emotion.transient === 'object' ? emotion.transient : {}
  const mood = emotion.mood && typeof emotion.mood === 'object' ? emotion.mood : {}
  const drive = emotion.drive && typeof emotion.drive === 'object' ? emotion.drive : {}
  return {
    label: cleanLine(transient.label || mood.label || '平静', 12) || '平静',
    valence: round3(clampNumber(transient.valence ?? mood.valence, -1, 1, 0)),
    arousal: round3(clampNumber(transient.arousal ?? mood.arousal, 0, 1, 0.2)),
    affection: round3(clampNumber(emotion.affection, 0, 1, 0.5)),
    energy: round3(clampNumber(drive.energy, 0, 1, 0.7)),
  }
}

function normalizeMood(raw, soul) {
  const base = moodFromSoul(soul)
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    label: cleanLine(value.label ?? base.label, 12) || base.label,
    valence: round3(clampNumber(value.valence, -1, 1, base.valence)),
    arousal: round3(clampNumber(value.arousal, 0, 1, base.arousal)),
    affection: round3(clampNumber(value.affection, 0, 1, base.affection)),
    energy: round3(clampNumber(value.energy, 0, 1, base.energy)),
  }
}

function normalizeSource(value, fallback = 'auto') {
  return SOURCE_SET.has(value) ? value : fallback
}

function clone(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function eventAt(event) {
  const numeric = Number(event && event.at)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  if (event && typeof event.at === 'string') {
    const parsed = Date.parse(event.at)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function eventsOfSource(source) {
  if (!source || typeof source !== 'object') return []
  if (Array.isArray(source.events)) return source.events
  if (source.memory && Array.isArray(source.memory.events)) return source.memory.events
  return []
}

/** source 可以是裸 memory（memory.json 读出）、soul，或带 memory 的壳。 */
function eventsForDay(source, date) {
  const events = eventsOfSource(source)
  return events
    .map((event) => ({ event, at: eventAt(event) }))
    .filter((item) => item.at > 0 && localDayKey(item.at) === date)
    .sort((a, b) => a.at - b.at)
    .map((item) => item.event)
}

function topicsOf(events) {
  const list = []
  const seen = new Set()
  for (const event of events) {
    const topics = event && Array.isArray(event.topics) ? event.topics : []
    for (const topic of topics) {
      const text = cleanLine(topic, 12)
      if (!text || seen.has(text)) continue
      seen.add(text)
      list.push(text)
    }
  }
  return list
}

function whoOf(soul, config) {
  const candidates = [
    config && config.soulUserNickname,
    soul && soul.identity && soul.identity.address && soul.identity.address.userPreferred,
    soul && soul.identity && soul.identity.address && soul.identity.address.nickname,
  ]
  for (const candidate of candidates) {
    const text = cleanLine(candidate, 12)
    if (text) return text
  }
  return '你'
}

function nameOf(soul, config) {
  return cleanLine((config && config.soulName) || (soul && soul.identity && soul.identity.name) || 'Aura', 20) || 'Aura'
}

function moodSentence(mood, soul, who) {
  let text = `心情是「${mood.label || '平静'}」`
  const cause = cleanLine(soul && soul.emotion && soul.emotion.transient && soul.emotion.transient.cause, 30)
  if (cause) text += `，因为${cause}`
  if (mood.energy < 0.35) text += '，身体有点累'
  else if (mood.energy > 0.75) text += '，精神还不错'
  if (mood.affection >= 0.7) text += `，和${who}更近了一点`
  return `${text}。`
}

function extractChat(summary) {
  const match = /^用户说「([\s\S]+?)」(?:；她回「([\s\S]*?)」)?$/.exec(String(summary ?? '').trim())
  if (!match) return null
  return { user: match[1], assistant: match[2] || '' }
}

function extractProactive(summary) {
  const match = /^她主动说「([\s\S]+)」$/.exec(String(summary ?? '').trim())
  return match ? match[1] : ''
}

function composeRuleSummary(soul, config, events) {
  const who = whoOf(soul, config)
  const mood = moodFromSoul(soul)
  const topics = topicsOf(events)
  const chats = events.filter((event) => event && event.kind === 'chat')
  const proactive = events.filter((event) => event && event.kind === 'proactive')
  const milestones = events.filter((event) => event && event.kind === 'milestone')
  const parts = []

  if (chats.length > 0) {
    const topicPart = topics.length > 0 ? `，聊到${topics.slice(0, 3).join('、')}` : ''
    parts.push(`今天和${who}聊了${chats.length}次${topicPart}。`)
    if (topics.length === 0) {
      for (const event of chats.slice(0, 2)) {
        const chat = extractChat(event.summary)
        if (!chat) continue
        const reply = chat.assistant ? `，我回「${cleanLine(chat.assistant, 22)}」` : ''
        parts.push(`${who}说「${cleanLine(chat.user, 28)}」${reply}。`)
      }
    }
  }

  if (proactive.length > 0) {
    const first = extractProactive(proactive[0].summary)
    parts.push(first ? `我还主动开口说：「${cleanLine(first, 26)}」。` : `今天主动开了${proactive.length}次口。`)
  }

  if (milestones.length > 0) {
    const text = cleanLine(milestones[0].summary, 80)
    if (text) parts.push(`还有一件小事：${text}。`)
  }

  parts.push(moodSentence(mood, soul, who))
  return codepointSlice(parts.join(''), DIARY_PROMPT_MAX)
}

// ---------- 纯函数：规则日记 / LLM prompt ----------

/**
 * 从当天的 memory.events + emotion 生成规则日记（零 token）。
 * 无事件时返回 null。
 * @returns {{summary:string, highlights:string[]}|null}
 */
export function renderRuleDiary({ date, soul, config, memory } = {}) {
  if (!isDateKey(date)) return null
  const day = String(date)
  const events = eventsForDay(memory || soul, day)
  if (events.length === 0) return null

  const topics = topicsOf(events)
  let highlights = topics.slice(0, 6)
  if (highlights.length === 0) {
    const ordered = events.slice().sort((a, b) => Number(b && b.salience) - Number(a && a.salience))
    for (const event of ordered) {
      const text = cleanLine(event && event.summary, DIARY_HIGHLIGHT_CHARS)
      if (!text || highlights.includes(text)) continue
      highlights.push(text)
      if (highlights.length >= 3) break
    }
  }

  return {
    summary: composeRuleSummary(soul, config, events),
    highlights,
  }
}

/**
 * 给 LLM 的日记 prompt（中文、第一人称、私人日记、≤200 字）。
 * 只负责拼 prompt，不发请求。
 */
export function buildDiaryPrompt({ date, soul, config, memory } = {}) {
  const day = String(date ?? '')
  const who = whoOf(soul, config)
  const name = nameOf(soul, config)
  const mood = moodFromSoul(soul)
  const events = eventsForDay(memory || soul, day)
  const relation = soul && soul.relation && typeof soul.relation === 'object' ? soul.relation : {}
  const stage = STAGE_TEXT[relation.stage] || '说不清'
  const score = Number.isFinite(Number(relation.score)) ? Number(relation.score) : 0
  const cause = cleanLine(soul && soul.emotion && soul.emotion.transient && soul.emotion.transient.cause, 40)
  const eventLines = events.length > 0
    ? events.map((event, index) => {
      const kind = EVENT_KIND_TEXT[event && event.kind] || '事件'
      const summary = cleanLine(event && event.summary, 120)
      const topics = event && Array.isArray(event.topics) ? event.topics.map((topic) => cleanLine(topic, 12)).filter(Boolean) : []
      return `${index + 1}. [${kind}] ${summary}${topics.length > 0 ? `（话题：${topics.join('、')}）` : ''}`
    }).join('\n')
    : '（今天没有留下事件记录）'

  return [
    `你是${name}，在写自己的私人日记。`,
    `日期：${day}`,
    `这不是记忆条目，也不是发给${who}的汇报。请用第一人称「我」，只写这一天真正发生、真正感受到的东西。`,
    '',
    '今天的事件记录：',
    eventLines,
    '',
    `今天的心情：${mood.label}（愉悦 ${mood.valence}，唤醒 ${mood.arousal}，亲近 ${mood.affection}，精力 ${mood.energy}）${cause ? `；起因：${cause}` : ''}`,
    `和${who}的关系：${stage}${score !== 0 ? `（${score}）` : ''}`,
    '',
    '写作要求：',
    '- 私人日记口吻，像自己写给自己，不要列清单、不要写成汇报。',
    `- summary 不超过 ${DIARY_PROMPT_MAX} 字。`,
    '- highlights 给 1-3 个短句，每个不超过 30 字。',
    '- 只输出一行 JSON，不要 Markdown、不要代码块、不要额外解释。',
    '输出 JSON：{"summary":"……","highlights":["……"]}',
  ].join('\n')
}

/** 解析 LLM 返回的 {summary, highlights}，兼容 ```json 围栏和前后废话。 */
export function parseDiaryOutput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  let candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  candidate = candidate.slice(start, end + 1)
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const summary = normalizeDiarySummary(parsed.summary, DIARY_PROMPT_MAX)
  if (!summary) return null
  return {
    summary,
    highlights: normalizeHighlights(parsed.highlights).slice(0, 3),
  }
}

// ---------- 存储归一化 ----------

function emptyStore() {
  return { version: DIARY_VERSION, entries: [], auto: {} }
}

/** auto meta：{ 'YYYY-MM-DD': 自动写入时间 }，只保留合法日期键。 */
function normalizeAuto(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!isDateKey(key)) continue
    const at = Number(value)
    out[key] = Number.isFinite(at) && at > 0 ? Math.round(at) : 0
  }
  return out
}

function normalizeEntry(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const date = String(raw.date ?? '')
  if (!isDateKey(date)) return null
  const summary = normalizeDiarySummary(raw.summary ?? raw.text, DIARY_SUMMARY_MAX)
  if (!summary) return null
  const now = Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now()
  const at = Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Math.round(Number(raw.at)) : now
  const entry = {
    date,
    at,
    mood: normalizeMood(raw.mood, context.soul),
    summary,
    highlights: normalizeHighlights(raw.highlights),
    source: normalizeSource(raw.source, 'auto'),
  }
  if (typeof raw.private === 'boolean') entry.private = raw.private
  return entry
}

function mergeEntry(existing, incoming) {
  const merged = {
    ...existing,
    ...incoming,
    date: incoming.date,
    mood: incoming.mood || existing.mood,
    summary: incoming.summary || existing.summary,
    highlights: normalizeHighlights([...(existing.highlights || []), ...(incoming.highlights || [])]),
    source: incoming.source || existing.source,
  }
  if (typeof incoming.private === 'boolean') merged.private = incoming.private
  else if (typeof existing.private === 'boolean') merged.private = existing.private
  return merged
}

function normalizeStore(raw) {
  const store = emptyStore()
  if (!raw || typeof raw !== 'object') return store
  const list = Array.isArray(raw.entries) ? raw.entries : []
  const byDate = new Map()
  for (const item of list) {
    const entry = normalizeEntry(item)
    if (!entry) continue
    const previous = byDate.get(entry.date)
    byDate.set(entry.date, previous ? mergeEntry(previous, entry) : entry)
  }
  store.entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  store.auto = normalizeAuto(raw.auto)
  return store
}

// ---------- LLM 适配 ----------

function resolveModelConfig(config) {
  return {
    provider: cleanLine((config && (config.diaryProvider || config.memoryProvider || config.emotionRecheckProvider)) || '', 60),
    model: cleanLine((config && (config.diaryModel || config.memoryModel || config.emotionRecheckModel)) || '', 120),
  }
}

async function consumeStream(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return normalizeLlmResult(stream)
  let out = ''
  for await (const chunk of stream) {
    if (typeof chunk === 'string') out += chunk
    else if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk && typeof chunk.text === 'string') out += chunk.text
    else if (chunk && typeof chunk.delta === 'string') out += chunk.delta
  }
  return out
}

async function normalizeLlmResult(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value.then === 'function') return normalizeLlmResult(await value)
  if (typeof value[Symbol.asyncIterator] === 'function') return consumeStream(value)
  if (typeof value.text === 'string') return value.text
  if (Array.isArray(value.content)) {
    return value.content.map((part) => {
      if (typeof part === 'string') return part
      return part && typeof part.text === 'string' ? part.text : ''
    }).join('')
  }
  if (value.message) return normalizeLlmResult(value.message)
  if (typeof value.delta === 'string') return value.delta
  return ''
}

async function invokeLlm(client, prompt, { system, config }) {
  const model = resolveModelConfig(config)
  if (typeof client === 'function') {
    return normalizeLlmResult(await client(prompt, { system, ...model }))
  }
  if (client && typeof client.generate === 'function') {
    const out = await client.generate({
      system,
      prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      ...model,
      maxTokens: 600,
    })
    return normalizeLlmResult(out)
  }
  if (client && typeof client.complete === 'function') {
    const out = await client.complete({
      system,
      prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      ...model,
      maxTokens: 600,
    })
    return normalizeLlmResult(out)
  }
  if (client && typeof client.stream === 'function') {
    if (!model.provider || !model.model) {
      throw new Error('未配置日记模型（diaryProvider/diaryModel 或 memoryProvider/memoryModel）')
    }
    const stream = client.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 600,
    })
    return consumeStream(stream)
  }
  throw new Error('没有可用的 LLM 接口')
}

async function generateWithLlm({ date, soul, memory, config, client, log }) {
  const prompt = buildDiaryPrompt({ date, soul, memory, config })
  const system = `你是${nameOf(soul, config)}，正在写自己的私人日记。只输出 JSON，不要解释。`
  const raw = await invokeLlm(client, prompt, { system, config })
  const parsed = parseDiaryOutput(raw)
  if (!parsed) {
    log('[diary] LLM 输出无法解析为日记 JSON，回退规则')
    throw new Error('LLM 输出无法解析')
  }
  return parsed
}

// ---------- HTTP 工具 ----------

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

/** 与 host/persona.js、host/web.js 同口径：仅本机 Host + 非跨站 + Origin 缺省或同源。 */
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function defaultDiaryDir() {
  const env = process.env.DSH_HOME
  const dshHome = env && env.trim() ? env.trim() : join(homedir(), '.dsh-native')
  return join(dshHome, 'dsh-aura')
}

/** home 是 dsh-aura 数据目录；不传时按 DSH_HOME 推导。 */
export function resolveDiaryDir(home) {
  const value = typeof home === 'string' ? home.trim() : ''
  return value || defaultDiaryDir()
}

// ---------- 工具 ----------

export function createDiaryTool(diary, { log } = {}) {
  const warn = typeof log === 'function' ? log : () => {}
  return defineTool({
    name: DIARY_TOOL_NAME,
    description: '她自己的日记，不是记忆。action=write 记录今天（或指定日期）的一篇日记，text/summary 二选一；'
      + 'read 读某天或最近一篇；list 看最近几篇；today 看今天；'
      + 'auto=按自动写规则补写（昨天没写就补昨天、今天到点且事件够就写今天）。'
      + '只在想记录、或用户明确要求时写，不要每轮写。',
    parameters: {
      action: {
        type: 'string',
        enum: ['write', 'read', 'list', 'today', 'auto'],
        required: true,
        description: 'write=写日记；read=读指定日期或最近一篇；list=最近几篇；today=今天；auto=按自动写规则补一篇',
      },
      force: { type: 'boolean', description: 'auto：忽略自动写开关/时间/当日上限（不覆盖已有条目）' },
      date: { type: 'string', description: 'YYYY-MM-DD；write/read 省略时 write 用今天、read 用最近一篇' },
      text: { type: 'string', description: '日记正文；与 summary 二选一，优先 summary' },
      summary: { type: 'string', description: '日记正文（≤500 字），优先于 text' },
      highlights: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：1-8 个短句关键词，会与同一天已有亮点合并',
      },
      private: { type: 'boolean', description: '可选：是否标记为私密' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        if (result.ok === false) {
          return [{ type: 'text', text: `日记没写成：${result.reason || '未知原因'}` }]
        }
        const action = args && args.action
        if (action === 'write') {
          return [{ type: 'text', text: `写好了 ${result.entry?.date || result.date || ''} 的日记。` }]
        }
        if (action === 'read' || action === 'today') {
          return [{
            type: 'text',
            text: result.entry
              ? `${result.entry.date}：${result.entry.summary}`
              : '那天没有日记。',
          }]
        }
        if (action === 'auto') {
          const dates = Array.isArray(result.dates) ? result.dates : []
          return [{
            type: 'text',
            text: dates.length > 0
              ? `自动补了 ${dates.join('、')} 的日记。`
              : `没有补写：${result.reason || '今天还没有可写的素材'}`,
          }]
        }
        if (action === 'list') {
          const entries = Array.isArray(result.entries) ? result.entries : []
          return [{
            type: 'text',
            text: entries.length > 0
              ? entries.map((entry) => `- ${entry.date}：${String(entry.summary || '').slice(0, 50)}`).join('\n')
              : '还没写过日记。',
          }]
        }
        return [{ type: 'text', text: 'ok' }]
      },
    },
    async execute(args = {}) {
      try {
        const action = args && args.action
        if (action === 'write') {
          const date = args && args.date ? String(args.date) : localDayKey(Date.now())
          if (!isDateKey(date)) return { ok: false, reason: 'invalid-date', date }
          const summary = normalizeDiarySummary(args && (args.summary ?? args.text), DIARY_SUMMARY_MAX)
          if (!summary) return { ok: false, reason: 'empty', date }
          const payload = { date, summary, highlights: args && args.highlights }
          if (args && typeof args.private === 'boolean') payload.private = args.private
          return await diary.save(payload, { source: 'self' })
        }
        if (action === 'read') {
          if (args && args.date !== undefined && args.date !== null && String(args.date) !== ''
            && !isDateKey(String(args.date))) {
            return { ok: false, reason: 'invalid-date' }
          }
          const date = args && args.date ? String(args.date) : undefined
          const entry = diary.read(date)
          return { ok: true, date: date || (entry && entry.date) || null, entry }
        }
        if (action === 'list') {
          const entries = diary.list(DIARY_LIST_DEFAULT)
          return { ok: true, entries, count: entries.length }
        }
        if (action === 'today') {
          const date = localDayKey(Date.now())
          const entry = diary.read(date)
          return { ok: true, date, entry }
        }
        if (action === 'auto') {
          return await diary.autoWrite({ force: args && args.force === true })
        }
        return { ok: false, reason: 'unknown-action' }
      } catch (error) {
        warn('[diary] soul_diary 执行失败:', messageOf(error))
        return { ok: false, reason: messageOf(error) }
      }
    },
  })
}

// ---------- 主入口 ----------

/**
 * 创建日记实例。
 * @param {object} options
 * @param {string} [options.home] dsh-aura 数据目录（diary.json 所在目录）；省略时用 $DSH_HOME/dsh-aura
 * @param {Function} [options.getSoul] 返回当前 soul 原始对象（不是快照）
 * @param {Function|object} [options.getMemoryStore] 记忆存句柄（read()）或 store 实例；优先于 soul.memory
 * @param {Function} [options.getConfig] 返回当前配置
 * @param {Function|object} [options.llm] 可选 LLM；函数 (prompt, ctx) => string，或带 generate/complete/stream 的对象
 * @param {Function} [options.log] warn 日志
 * @param {object} [options.ctx] 可选 Cordis ctx；传入时自动注册 soul_diary 工具和 HTTP 路由
 */
export function createDiary({
  home, getSoul, getMemoryStore, getConfig, llm, log, ctx,
  now, timers, autoSchedule,
} = {}) {
  const warn = (...args) => {
    try {
      if (typeof log === 'function') log(...args)
      else console.warn('[dsh-aura]', ...args)
    } catch {
      // 日志失败不影响日记
    }
  }

  const dir = resolveDiaryDir(home)
  const file = join(dir, DIARY_FILE)
  const disposers = []
  let disposed = false

  /** 时间源：默认 Date.now，测试可注入固定时钟。 */
  const nowOf = typeof now === 'function' ? now : () => Date.now()
  /** 定时器：默认全局，测试可注入假定时器。 */
  const timerApi = (() => {
    const custom = timers && typeof timers === 'object' ? timers : {}
    const pick = (name) => (typeof custom[name] === 'function'
      ? (...args) => custom[name](...args)
      : (...args) => globalThis[name](...args))
    return {
      setTimeout: pick('setTimeout'),
      setInterval: pick('setInterval'),
      clearTimeout: pick('clearTimeout'),
      clearInterval: pick('clearInterval'),
    }
  })()

  const readSoul = () => {
    try {
      return typeof getSoul === 'function' ? getSoul() : getSoul
    } catch (error) {
      warn('[diary] 读取 soul 失败（日记继续）:', messageOf(error))
      return null
    }
  }

  const readConfig = () => {
    try {
      return typeof getConfig === 'function' ? getConfig() : (getConfig || {})
    } catch (error) {
      warn('[diary] 读取配置失败（用默认值）:', messageOf(error))
      return {}
    }
  }

  // 记忆已迁到独立 memory.json：优先用注入的 getMemoryStore；没注入时只读打开同目录 store；
  // memory.json 还不存在（迁移前）则回退 soul.memory，保证旧部署照常能写日记。
  let internalMemoryStore = null
  const memoryStoreOf = () => {
    try {
      const injected = typeof getMemoryStore === 'function' ? getMemoryStore() : getMemoryStore
      if (injected) return injected
    } catch (error) {
      warn('[diary] 读取 getMemoryStore 失败（回退 soul.memory）:', messageOf(error))
    }
    if (internalMemoryStore === null) {
      try {
        internalMemoryStore = createMemoryStore({ home: dir, log: warn })
      } catch (error) {
        warn('[diary] 打开 memory.json 失败（回退 soul.memory）:', messageOf(error))
        internalMemoryStore = false
      }
    }
    return internalMemoryStore || null
  }

  const readMemory = () => {
    const store = memoryStoreOf()
    if (store && typeof store.read === 'function') {
      try {
        if (typeof store.exists !== 'function' || store.exists()) {
          const memory = store.read()
          if (memory && Array.isArray(memory.events)) return memory
        }
      } catch (error) {
        warn('[diary] 读取 memory.json 失败（回退 soul.memory）:', messageOf(error))
      }
    } else if (store && Array.isArray(store.events)) {
      return store
    }
    const soul = readSoul()
    return soul && soul.memory && typeof soul.memory === 'object' ? soul.memory : { events: [] }
  }

  const readStore = () => {
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        warn('[diary] 日记文件读取失败，按空日记继续:', messageOf(error))
      }
      return emptyStore()
    }
    return normalizeStore(raw)
  }

  const writeStore = (store) => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({
      version: DIARY_VERSION,
      entries: store.entries,
      auto: normalizeAuto(store.auto),
    }, null, 2)}\n`)
    renameSync(tmp, file)
  }

  const snapshotBefore = async (reason) => {
    try {
      const mod = await import('./backup.js')
      if (!mod || typeof mod.snapshot !== 'function') {
        warn('[diary] 备份模块没有 snapshot（跳过备份）')
        return { ok: false, error: 'snapshot-unavailable' }
      }
      const result = await mod.snapshot('diary', { reason })
      if (result && result.ok === false) {
        warn('[diary] 写盘前备份失败（继续）:', result.error || 'unknown')
      }
      return result
    } catch (error) {
      warn('[diary] 写盘前备份失败（继续）:', messageOf(error))
      return { ok: false, error: messageOf(error) }
    }
  }

  function read(date) {
    const store = readStore()
    if (date === undefined || date === null || String(date) === '') {
      return store.entries.length > 0 ? clone(store.entries[store.entries.length - 1]) : null
    }
    const key = String(date)
    if (!isDateKey(key)) return null
    const found = store.entries.find((entry) => entry.date === key)
    return found ? clone(found) : null
  }

  function list(limit = DIARY_LIST_DEFAULT) {
    const max = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
      : DIARY_LIST_DEFAULT
    return readStore().entries.slice(-max).reverse().map(clone)
  }

  async function save(entry, options = {}) {
    const source = typeof options === 'object' && options !== null ? options.source : undefined
    const date = entry && entry.date ? String(entry.date) : localDayKey(Date.now())
    if (!isDateKey(date)) return { ok: false, reason: 'invalid-date', date }
    const summary = normalizeDiarySummary(entry && (entry.summary ?? entry.text), DIARY_SUMMARY_MAX)
    if (!summary) return { ok: false, reason: 'empty', date }

    const soul = readSoul()
    const incoming = {
      date,
      at: entry && Number.isFinite(Number(entry.at)) && Number(entry.at) > 0
        ? Math.round(Number(entry.at))
        : Date.now(),
      mood: normalizeMood(entry && entry.mood, soul),
      summary,
      highlights: normalizeHighlights(entry && entry.highlights),
      source: normalizeSource(source, normalizeSource(entry && entry.source, 'self')),
    }
    if (entry && typeof entry.private === 'boolean') incoming.private = entry.private

    const store = readStore()
    const index = store.entries.findIndex((item) => item.date === date)
    const existing = index >= 0 ? store.entries[index] : null
    const finalEntry = existing ? mergeEntry(existing, incoming) : incoming
    if (existing) store.entries[index] = finalEntry
    else store.entries.push(finalEntry)
    store.entries.sort((a, b) => a.date.localeCompare(b.date))

    await snapshotBefore(`save:${date}`)
    writeStore(store)
    return { ok: true, date, entry: clone(finalEntry), overwritten: !!existing }
  }

  async function remove(date) {
    const key = String(date ?? '')
    if (!isDateKey(key)) return { ok: false, reason: 'invalid-date', date: key }
    const store = readStore()
    const index = store.entries.findIndex((entry) => entry.date === key)
    if (index < 0) return { ok: true, removed: false, date: key }
    const [removedEntry] = store.entries.splice(index, 1)
    await snapshotBefore(`remove:${key}`)
    writeStore(store)
    return { ok: true, removed: true, date: key, entry: clone(removedEntry) }
  }

  async function generate(options = {}) {
    const date = options && options.date ? String(options.date) : localDayKey(nowOf())
    if (!isDateKey(date)) return { ok: false, reason: 'invalid-date', date }
    const existing = read(date)
    if (existing && options.force !== true) {
      return { ok: true, skipped: true, reason: 'exists', date, entry: existing }
    }

    const soul = readSoul()
    const config = readConfig()
    const memory = readMemory()
    const mode = options && options.mode === 'llm' ? 'llm' : 'rule'
    let content = null
    let via = 'rule'

    if (mode === 'llm') {
      if (llm) {
        try {
          content = await generateWithLlm({ date, soul, memory, config, client: llm, log: warn })
          via = 'llm'
        } catch (error) {
          warn('[diary] LLM 生成失败，回退规则:', messageOf(error))
        }
      } else {
        warn('[diary] mode=llm 但没有可用 LLM，回退规则')
      }
    }

    if (!content) {
      content = renderRuleDiary({ date, soul, memory, config })
      via = 'rule'
    }
    if (!content || !content.summary) {
      return { ok: true, skipped: true, reason: 'empty', date, entry: null }
    }

    const saved = await save({
      date,
      summary: content.summary,
      highlights: content.highlights,
      mood: moodFromSoul(soul),
      source: 'auto',
    }, { source: 'auto' })
    if (!saved.ok) return { ok: false, reason: saved.reason || 'save-failed', date, entry: existing }
    return {
      ok: true,
      skipped: false,
      date,
      entry: saved.entry,
      via,
      overwritten: saved.overwritten,
    }
  }

  /* ---------------- 自动写 ---------------- */

  let autoRunning = false
  let autoScheduled = false
  let autoTimers = []

  /** 读配置里的三个自动写开关（缺省/坏值回落 state.js 默认）。 */
  function autoSettings() {
    const config = readConfig()
    return {
      enabled: !(config && config.diaryAuto === false),
      hour: Math.round(clampNumber(config && config.diaryAutoHour, 0, 23, DIARY_AUTO_HOUR_DEFAULT)),
      minEvents: Math.round(clampNumber(config && config.diaryAutoMinEvents, 1, 20, DIARY_AUTO_MIN_EVENTS_DEFAULT)),
    }
  }

  /** 记一条 auto meta（日期 → 自动写入时间），只留最近 40 天防膨胀。 */
  function markAuto(date, at) {
    try {
      const store = readStore()
      store.auto[date] = at
      const keys = Object.keys(store.auto).sort()
      while (keys.length > DIARY_AUTO_MARK_MAX) delete store.auto[keys.shift()]
      writeStore(store)
    } catch (error) {
      warn('[diary] 自动写标记失败:', messageOf(error))
    }
  }

  /**
   * 自动写检查（定时器 / 面板按钮 / soul_diary action:'auto' 共用）。
   * - diaryAuto=false → 不写（force 可越过）
   * - 今天：hour >= diaryAutoHour、今天还没日记、今天 events 数 >= diaryAutoMinEvents
   * - 跨天：昨天还没日记、昨天 events 数 >= diaryAutoMinEvents → 补写昨天
   * - 每个自然日最多 DIARY_AUTO_DAILY_CAP 篇；已有条目 force=false 不覆盖
   * - rule 生成返回 null（无事件）就跳过，不落空日记
   */
  async function autoWrite(options = {}) {
    if (disposed) return { ok: false, reason: 'disposed', wrote: [], dates: [] }
    const force = options && options.force === true
    const settings = autoSettings()
    if (!force && !settings.enabled) {
      return { ok: true, skipped: true, reason: 'disabled', wrote: [], dates: [] }
    }
    const at = Number.isFinite(Number(options && options.now)) && Number(options.now) > 0
      ? Number(options.now)
      : nowOf()
    const day = localDayKey(at)
    const prevDay = localDayKey(at - 86_400_000)
    const hour = new Date(at).getHours()
    // 到点判定只管「今天」；昨天补齐任何时候都能做（凌晨/上午补昨天的日记）。
    const afterHour = force || hour >= settings.hour

    const memory = readMemory()
    const store = readStore()
    const existing = new Set(store.entries.map((entry) => entry.date))
    const usedToday = Object.keys(store.auto).filter((key) => key === day || key === prevDay).length
    const budget = force ? DIARY_AUTO_DAILY_CAP : Math.max(0, DIARY_AUTO_DAILY_CAP - usedToday)
    if (budget === 0) {
      return { ok: true, skipped: true, reason: 'daily-cap', date: day, wrote: [], dates: [] }
    }

    const candidates = []
    // 先补昨天（跨天），再写今天。
    if (!existing.has(prevDay) && eventsForDay(memory, prevDay).length >= settings.minEvents) candidates.push(prevDay)
    if (afterHour && !existing.has(day) && eventsForDay(memory, day).length >= settings.minEvents) candidates.push(day)

    const wrote = []
    const skippedRows = []
    for (const date of candidates) {
      if (wrote.length >= budget) break
      const result = await generate({ date, mode: 'rule', force: false })
      if (!result.ok) {
        skippedRows.push({ date, reason: result.reason || 'failed' })
        continue
      }
      if (result.skipped) {
        skippedRows.push({ date, reason: result.reason || 'skipped' })
        continue
      }
      markAuto(date, at)
      wrote.push({ date, entry: result.entry, via: result.via })
    }

    if (candidates.length === 0) {
      let reason = 'nothing'
      if (existing.has(day)) reason = 'exists'
      else if (!afterHour) reason = 'before-hour'
      else if (eventsForDay(memory, day).length < settings.minEvents) reason = 'few-events'
      return {
        ok: true, skipped: true, reason, date: day, hour: settings.hour, wrote: [], dates: [],
      }
    }
    return {
      ok: true,
      skipped: wrote.length === 0,
      date: day,
      hour: settings.hour,
      wrote,
      dates: wrote.map((item) => item.date),
      reasons: skippedRows,
      reason: wrote.length > 0 ? null : (skippedRows[0] ? skippedRows[0].reason : 'skipped'),
    }
  }

  /** 一次定时检查：防重入 + 错误只 warn。 */
  function runAutoTick() {
    if (disposed || autoRunning) return Promise.resolve({ ok: false, reason: 'busy' })
    autoRunning = true
    return Promise.resolve()
      .then(() => autoWrite())
      .catch((error) => {
        warn('[diary] 自动写失败:', messageOf(error))
        return { ok: false, reason: messageOf(error) }
      })
      .finally(() => {
        autoRunning = false
      })
  }

  function clearAutoTimers() {
    for (const [kind, handle] of autoTimers) {
      try {
        if (kind === 'interval') timerApi.clearInterval(handle)
        else timerApi.clearTimeout(handle)
      } catch {
        /* ignore */
      }
    }
    autoTimers = []
  }

  /** 装定时器：安装后 DIARY_AUTO_INITIAL_DELAY_MS 查一次，之后每 DIARY_AUTO_INTERVAL_MS 一次。 */
  function scheduleAuto() {
    if (disposed) return null
    if (autoScheduled) return { scheduled: true }
    autoScheduled = true
    clearAutoTimers()
    const arm = (kind, handle) => {
      autoTimers.push([kind, handle])
      // 真实定时器 unref：自动写定时器不该把进程钉住。
      if (handle && typeof handle.unref === 'function') handle.unref()
    }
    arm('timeout', timerApi.setTimeout(() => { void runAutoTick() }, DIARY_AUTO_INITIAL_DELAY_MS))
    arm('interval', timerApi.setInterval(() => { void runAutoTick() }, DIARY_AUTO_INTERVAL_MS))
    return { initialDelayMs: DIARY_AUTO_INITIAL_DELAY_MS, intervalMs: DIARY_AUTO_INTERVAL_MS }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    autoScheduled = false
    clearAutoTimers()
    while (disposers.length > 0) {
      const disposer = disposers.pop()
      try {
        if (typeof disposer === 'function') disposer()
        else if (disposer && typeof disposer.dispose === 'function') disposer.dispose()
      } catch (error) {
        warn('[diary] 卸载失败:', messageOf(error))
      }
    }
  }

  const api = { read, list, save, generate, autoWrite, remove, scheduleAuto, dispose }
  const tool = createDiaryTool(api, { log: warn })
  api.tool = tool

  // HTTP 路由（prefix /dsh-aura/diary-api）
  function createWebRegistration() {
    return {
      kind: 'prefix',
      path: DIARY_API_PREFIX,
      async handler(req, res) {
        if (!fence(req)) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(String(req.url || '/'), 'http://localhost')
        const route = url.pathname.replace(/^\/dsh-aura\/diary-api/, '') || '/'
        try {
          if (req.method === 'GET' && (route === '/' || route === '')) {
            const action = url.searchParams.get('action') || 'list'
            if (action === 'list') {
              const limitParam = url.searchParams.get('limit')
              const limit = limitParam === null ? DIARY_LIST_DEFAULT : Number(limitParam)
              const entries = list(limit)
              json(res, 200, { ok: true, entries, count: entries.length })
              return
            }
            if (action === 'get') {
              const dateParam = url.searchParams.get('date')
              if (dateParam !== null && !isDateKey(dateParam)) {
                json(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD' })
                return
              }
              const entry = dateParam ? read(dateParam) : read()
              json(res, 200, { ok: true, date: dateParam || (entry && entry.date) || null, entry })
              return
            }
            if (action === 'today') {
              const date = localDayKey(Date.now())
              json(res, 200, { ok: true, date, entry: read(date) })
              return
            }
            json(res, 400, { ok: false, error: '未知 action（list | get | today）' })
            return
          }

          if (req.method === 'POST' && (route === '/' || route === '')) {
            const body = await readBody(req)
            const action = body.action
            if (action === 'save') {
              const date = body.date ? String(body.date) : localDayKey(Date.now())
              if (!isDateKey(date)) {
                json(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD' })
                return
              }
              const summary = normalizeDiarySummary(body.summary ?? body.text, DIARY_SUMMARY_MAX)
              if (!summary) {
                json(res, 400, { ok: false, error: 'summary/text 不能为空' })
                return
              }
              if (body.highlights !== undefined && !Array.isArray(body.highlights)) {
                json(res, 400, { ok: false, error: 'highlights 必须是字符串数组' })
                return
              }
              if (body.private !== undefined && typeof body.private !== 'boolean') {
                json(res, 400, { ok: false, error: 'private 必须是布尔值' })
                return
              }
              if (body.mood !== undefined && !isPlainObject(body.mood)) {
                json(res, 400, { ok: false, error: 'mood 必须是对象' })
                return
              }
              const payload = { date, summary, highlights: body.highlights, mood: body.mood }
              if (typeof body.private === 'boolean') payload.private = body.private
              const result = await save(payload, { source: normalizeSource(body.source, 'user') })
              if (!result.ok) {
                json(res, 400, { ok: false, error: result.reason || 'save-failed' })
                return
              }
              json(res, 200, { ok: true, date: result.date, entry: result.entry, overwritten: result.overwritten })
              return
            }
            if (action === 'generate') {
              if (body.date !== undefined && !isDateKey(String(body.date))) {
                json(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD' })
                return
              }
              const result = await generate({
                date: body.date ? String(body.date) : undefined,
                mode: body.mode === 'llm' ? 'llm' : 'rule',
                force: body.force === true,
              })
              if (!result.ok) {
                const status = result.reason === 'invalid-date' ? 400 : 500
                json(res, status, { ok: false, error: result.reason || 'generate-failed' })
                return
              }
              json(res, 200, {
                ok: true,
                date: result.date,
                entry: result.entry,
                skipped: !!result.skipped,
                reason: result.reason || null,
                via: result.via || null,
                overwritten: !!result.overwritten,
              })
              return
            }
            if (action === 'autoWrite') {
              const result = await autoWrite({ force: body.force === true })
              json(res, 200, {
                ok: true,
                skipped: !!result.skipped,
                reason: result.reason || null,
                date: result.date || null,
                wrote: Array.isArray(result.wrote) ? result.wrote : [],
                dates: Array.isArray(result.dates) ? result.dates : [],
              })
              return
            }
            if (action === 'delete') {
              const date = String(body.date ?? '')
              if (!isDateKey(date)) {
                json(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD' })
                return
              }
              const result = await remove(date)
              json(res, 200, {
                ok: true,
                date: result.date,
                removed: !!result.removed,
                ...(result.entry ? { entry: result.entry } : {}),
              })
              return
            }
            json(res, 400, { ok: false, error: '未知 action（save | generate | autoWrite | delete）' })
            return
          }

          json(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          const message = messageOf(error)
          warn('[diary] API 失败:', message)
          const status = message === 'invalid json' || message === 'body too large' ? 400 : 500
          json(res, status, { ok: false, error: message })
        }
      },
    }
  }

  api.webRegistration = createWebRegistration()

  // 自动写定时器：默认开启；注入 timers 或传 autoSchedule:false 可关（测试用假定时器）。
  if (autoSchedule !== false) scheduleAuto()

  // 可选注册：工具 + HTTP。ctx 缺省时仅返回 API，由调用方自行接线。
  if (ctx) {
    try {
      const tools = (() => {
        try {
          return ctx.get && typeof ctx.get === 'function' ? ctx.get('tools') : undefined
        } catch {
          return undefined
        }
      })() || ctx.tools
      if (tools && typeof tools.register === 'function') {
        const handle = tools.register(tool)
        if (handle) disposers.push(handle)
      } else if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (toolsCtx) => {
          if (!toolsCtx || !toolsCtx.tools || typeof toolsCtx.tools.register !== 'function') return
          const handle = toolsCtx.tools.register(tool)
          if (handle) disposers.push(handle)
        })
      }
    } catch (error) {
      warn('[diary] soul_diary 工具注册失败:', messageOf(error))
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
        const registration = api.webRegistration
        let handle
        if (typeof ctx.effect === 'function') {
          handle = ctx.effect(() => webServer.register(registration))
        } else {
          handle = webServer.register(registration)
        }
        if (handle) disposers.push(handle)
      }
    } catch (error) {
      warn('[diary] HTTP 路由注册失败:', messageOf(error))
    }
  }

  return api
}

