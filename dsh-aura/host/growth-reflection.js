/**
 * 每日自省 / 成长反思（Host 侧，独立模块）。
 *
 * 目标：每天最多一次（硬上限 2 条/天），从最近的记忆事件里让 LLM 提炼 1 条
 * 「她自己长出来的东西」，批量写进 soul.growth。写入前做一次 soul-reflection 备份，
 * 写入后 system prompt 只变一次，避免频繁改 prompt。
 *
 * 设计约束：
 * - 不依赖 memory.js 实例：memory 可能在 installSoul 之后才创建，所以直接按
 *   state.stateDir() 用 memory-store 只读 memory.json（也允许注入 memory.store）。
 * - 不 import soul.js（避免循环依赖）：成长写入走 soul 句柄的 grow()。
 * - LLM 不可用 / 模型缺失 / 输出非法都只是 skip，不抛错、不影响聊天。
 * - 非 force：今天已反思过、距上次 <20h、最近 24h 事件 <3 条都 skip；
 *   force 跳过时间限制与事件数下限，但「每天最多 2 条」的硬上限仍然生效。
 */
import { createMemoryStore } from './memory-store.js'
import {
  GROWTH_KINDS,
  GROWTH_NOTE_MAX,
  GROWTH_TEXT_MAX,
  codepointSlice,
} from './growth.js'

export const REFLECTION_DAILY_LIMIT = 2
export const REFLECTION_COOLDOWN_MS = 20 * 60 * 60 * 1000
export const REFLECTION_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000
export const REFLECTION_MIN_EVENTS = 3
export const REFLECTION_BACKUP_LABEL = 'soul-reflection'
export const REFLECTION_SOURCE = 'reflection'

const MAX_PROMPT_EVENTS = 12
const MAX_PROMPT_NOTES = 6
const MAX_PROMPT_GROWTH = 10
/** prompt 里要求 note ≤120 字（growth 层本身允许 200）。 */
const NOTE_PROMPT_MAX = 120
const SYSTEM_PROMPT = '你是陪伴型 AI Aura 的成长整理器。只输出一行 JSON，不要解释，不要 markdown 代码块。'

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, asNumber(value, min)))
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 本地日期键 YYYY-MM-DD（与 soul.js 同口径：每日限制按本机时区）。 */
export function localDayKey(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 洗 soul.growthReflection：{ lastAt, dayKey, count }。 */
export function normalizeReflectionState(raw) {
  const src = asObject(raw)
  const dayKey = asString(src.dayKey, '')
  return {
    lastAt: Math.max(0, Math.round(asNumber(src.lastAt, 0))),
    dayKey: /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : '',
    count: Math.max(0, Math.round(asNumber(src.count, 0))),
  }
}

/**
 * 成长候选 prompt（纯函数，方便自测）。
 * 强调「不是短期记忆 / 用户隐私 / 一次琐事」，只输出 JSON 或 {"skip":true}。
 */
export function buildGrowthReflectionPrompt({
  events = [],
  notes = [],
  growth = [],
  identity = {},
  now = Date.now(),
} = {}) {
  const eventLines = asArray(events).slice(-MAX_PROMPT_EVENTS).map((event) => {
    const at = asNumber(event?.at, now)
    const d = new Date(at)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const bits = [hhmm, codepointSlice(oneLine(event?.summary), 120)]
    if (event?.kind) bits.push(`类型：${asString(event.kind).slice(0, 12)}`)
    const topics = asArray(event?.topics).slice(0, 3).join('、')
    if (topics) bits.push(`话题：${topics}`)
    const mood = asString(event?.mood?.label, '')
    if (mood) bits.push(`心情：${mood}`)
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  const noteLines = asArray(notes).slice(-MAX_PROMPT_NOTES).map((note) => (
    `- [${asString(note?.category, '')}] ${codepointSlice(oneLine(note?.text), 80)}`
  ))
  const growthLines = asArray(growth).slice(-MAX_PROMPT_GROWTH).map((item) => (
    `- [${asString(item?.kind, 'trait')}] ${codepointSlice(oneLine(item?.text), 80)}`
  ))
  const interests = asArray(identity?.interests).slice(0, 4).join('、')
  const strengths = asArray(identity?.strengths).slice(0, 4).join('、')
  return [
    '这是 Aura 的每日自省：从最近的记忆里，提炼出 1 条「她自己长出来的东西」。',
    '',
    '最近 24 小时发生的事：',
    eventLines.join('\n') || '（没有值得看的事件）',
    '',
    '最近的记忆笔记（只作背景，不要把用户隐私写进成长）：',
    noteLines.join('\n') || '（空）',
    '',
    '已经长出来的部分（不要重复、不要换个说法重复）：',
    growthLines.join('\n') || '（空）',
    '',
    `她现在的兴趣：${interests || '（未知）'}；擅长：${strengths || '（未知）'}。`,
    '',
    '只输出一行 JSON，不要解释，不要 markdown 代码块：',
    '{"kind":"trait|interest|habit|bond|self","text":"第一人称，以「我」开头，≤120 字","note":"这条从哪来，≤120 字"}',
    '如果确实没有新的、能长期留下的变化，就输出：{"skip":true}',
    '',
    '规则：',
    '- 写的是性格、兴趣、习惯、默契或自我认识的变化，不是短期记忆、不是用户隐私、不是一次琐事。',
    '- 不要写住址/证件/账号/感情细节；不要复述对话；不要为了写而写。',
    '- 宁可 skip，也不要硬凑。',
  ].join('\n')
}

/**
 * 解析 LLM 输出：容忍 <think>/<reasoning> 包裹与前后废话；非法 JSON / 空 text 返回 null。
 * {"skip":true} 返回 { skip:true }。kind 非法回落 trait（与 addGrowth 同口径）。
 */
export function parseGrowthReflectionOutput(out) {
  const raw = String(out ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.skip === true) return { skip: true }
  const text = codepointSlice(oneLine(parsed.text), GROWTH_TEXT_MAX)
  if (!text) return null
  const kind = GROWTH_KINDS.includes(parsed.kind) ? parsed.kind : 'trait'
  const note = codepointSlice(oneLine(parsed.note), Math.min(GROWTH_NOTE_MAX, NOTE_PROMPT_MAX))
  return { skip: false, kind, text, note }
}

/**
 * 创建每日成长反思器。
 * @param {object} options
 * @param {object} options.ctx Cordis ctx（读 llm / agentDefaultModel）
 * @param {object} options.state host/state.js（stateDir / readConfig / readJson）
 * @param {object} options.soul soul 句柄（get/grow/saveSoon/saveNow）
 * @param {object} [options.memory] 可选 memory 句柄（有 store 就优先用，否则只读 memory.json）
 * @param {Function} [options.log]
 * @returns {{ maybeReflect: Function, disposition: Function, lastState: Function, schedule: Function, dispose: Function }}
 */
export function createGrowthReflection({ ctx, state, soul, memory, log } = {}) {
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  const warn = (message, error) => {
    try {
      logger('[soul] 成长反思：' + message, error instanceof Error ? error.message : (error ?? ''))
    } catch {
      /* 日志失败不影响反思 */
    }
  }

  let disposed = false
  let inflight = null
  let timer = null
  let attempts = 0
  let lastAttemptAt = 0
  let lastState = { at: 0, ok: false, reason: 'never', attempts: 0 }

  const readConfig = () => {
    try {
      return asObject(typeof state?.readConfig === 'function' ? state.readConfig() : {})
    } catch {
      return {}
    }
  }

  /** 原样读 config.json：normalizeConfig 白名单会丢掉 soulGrowthReflection，所以绕过它。 */
  const readRawConfig = () => {
    try {
      if (typeof state?.readJson === 'function') return asObject(state.readJson('config.json', {}))
      return {}
    } catch {
      return {}
    }
  }

  const readSoul = () => {
    try {
      const current = typeof soul?.get === 'function' ? soul.get() : soul
      return asObject(current)
    } catch {
      return {}
    }
  }

  const isEnabled = () => {
    try {
      if (readRawConfig().soulGrowthReflection === false) return false
      if (readConfig().soulGrowthReflection === false) return false
    } catch {
      /* 读不到就当开启 */
    }
    return true
  }

  const dailyLimit = () => {
    try {
      const raw = readRawConfig()
      return clamp(Math.round(asNumber(raw.soulReflectionDailyLimit, REFLECTION_DAILY_LIMIT)), 1, REFLECTION_DAILY_LIMIT)
    } catch {
      return REFLECTION_DAILY_LIMIT
    }
  }

  const memoryStore = () => {
    if (memory?.store && typeof memory.store.read === 'function') return memory.store
    if (memory && typeof memory.read === 'function') return memory
    const home = (() => {
      try {
        return typeof state?.stateDir === 'function' ? state.stateDir() : undefined
      } catch {
        return undefined
      }
    })()
    return createMemoryStore({ home, log: (...args) => warn(...args) })
  }

  /** 只读最近 24h 事件与最近笔记；读不到就返回空，绝不影响主流程。 */
  const readRecent = (now) => {
    let data = {}
    try {
      data = memoryStore().read() || {}
    } catch (error) {
      warn('读取 memory.json 失败（按空记忆继续）', error)
    }
    const events = asArray(data.events).filter((event) => {
      const at = asNumber(event?.at, 0)
      return at > 0 && now - at >= -60_000 && now - at <= REFLECTION_EVENT_WINDOW_MS
    })
    const notes = []
    for (const key of ['user', 'us', 'self']) {
      for (const note of asArray(data.notes?.[key])) notes.push({ ...asObject(note), category: key })
    }
    return { events, notes: notes.slice(-MAX_PROMPT_NOTES) }
  }

  const getLlm = () => {
    try {
      return ctx?.get?.('llm') || ctx?.llm
    } catch {
      return undefined
    }
  }

  const resolveModel = (config) => {
    const raw = readRawConfig()
    const provider = oneLine(
      raw.soulReflectionProvider || config.soulReflectionProvider || raw.memoryProvider || config.memoryProvider
      || config.emotionRecheckProvider || config.provider || '',
    )
    const model = oneLine(
      raw.soulReflectionModel || config.soulReflectionModel || raw.memoryModel || config.memoryModel
      || config.emotionRecheckModel || config.model || '',
    )
    if (provider && model) return { provider, model }
    try {
      const service = ctx?.get?.('agentDefaultModel') || ctx?.agentDefaultModel
      const selection = service?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return { provider: String(selection.provider), model: String(selection.model) }
      }
    } catch {
      /* 没有默认模型就 skip */
    }
    return null
  }

  async function generateCandidate({ events, notes, growth, identity, config }) {
    const llm = getLlm()
    if (!llm || typeof llm.stream !== 'function') return { error: 'no-llm' }
    const target = resolveModel(config)
    if (!target) return { error: 'no-model' }
    const prompt = buildGrowthReflectionPrompt({ events, notes, growth, identity })
    let out = ''
    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 300,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
    } catch (error) {
      return { error: 'llm-failed', message: error instanceof Error ? error.message : String(error) }
    }
    const parsed = parseGrowthReflectionOutput(out)
    if (!parsed) return { error: 'bad-output' }
    return parsed
  }

  function record(result) {
    lastState = {
      at: Date.now(),
      attempts,
      ...result,
      reason: result.reason || (result.ok ? 'written' : 'unknown'),
    }
    return { ...lastState }
  }

  async function run(force) {
    const now = Date.now()
    attempts += 1
    lastAttemptAt = now
    if (disposed) return record({ ok: false, reason: 'disposed', skipped: true })
    const config = readConfig()
    if (!isEnabled()) return record({ ok: false, reason: 'disabled', skipped: true })

    const before = normalizeReflectionState(readSoul().growthReflection)
    const today = localDayKey(now)
    const usedToday = before.dayKey === today ? before.count : 0
    const limit = dailyLimit()
    // 硬上限：force 也不能超过每天 2 条。
    if (usedToday >= limit) {
      return record({ ok: false, reason: 'daily-limit', skipped: true, usedToday, dailyLimit: limit })
    }
    if (!force) {
      if (usedToday >= 1) {
        return record({ ok: false, reason: 'already-today', skipped: true, usedToday, dailyLimit: limit })
      }
      if (before.lastAt > 0 && now - before.lastAt < REFLECTION_COOLDOWN_MS) {
        return record({
          ok: false,
          reason: 'cooldown',
          skipped: true,
          cooldownUntil: before.lastAt + REFLECTION_COOLDOWN_MS,
        })
      }
    }

    const recent = readRecent(now)
    if (!force && recent.events.length < REFLECTION_MIN_EVENTS) {
      return record({
        ok: false,
        reason: 'not-enough-events',
        skipped: true,
        events: recent.events.length,
        minEvents: REFLECTION_MIN_EVENTS,
      })
    }

    const current = readSoul()
    let candidate
    try {
      candidate = await generateCandidate({
        events: recent.events,
        notes: recent.notes,
        growth: asArray(current.growth),
        identity: asObject(current.identity),
        config,
      })
    } catch (error) {
      warn('生成候选失败', error)
      return record({ ok: false, reason: 'llm-failed', message: error instanceof Error ? error.message : String(error) })
    }
    if (!candidate || candidate.error) {
      return record({ ok: false, reason: candidate?.error || 'no-candidate', skipped: true, message: candidate?.message })
    }
    if (candidate.skip) return record({ ok: false, reason: 'llm-skip', skipped: true })
    // LLM 期间被 dispose：不再写入（避免卸载后还改 soul）。
    if (disposed) return record({ ok: false, reason: 'disposed', skipped: true })
    if (typeof soul?.grow !== 'function') return record({ ok: false, reason: 'no-grow' })

    let written
    try {
      written = await soul.grow({
        text: candidate.text,
        kind: candidate.kind,
        note: candidate.note,
        source: REFLECTION_SOURCE,
      })
    } catch (error) {
      warn('写入成长失败（继续运行）', error)
      return record({ ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) })
    }
    if (!written || written.ok === false) {
      return record({ ok: false, reason: written?.reason || 'write-failed' })
    }

    const next = { lastAt: now, dayKey: today, count: usedToday + 1 }
    try {
      const target = readSoul()
      if (target && typeof target === 'object') target.growthReflection = next
      if (typeof soul.saveSoon === 'function') soul.saveSoon()
      if (typeof soul.saveNow === 'function') {
        soul.saveNow({ reason: 'soul-reflection-state', skipBackup: true, force: true })
      }
    } catch (error) {
      warn('保存反思状态失败（成长已写入）', error)
    }
    return record({
      ok: true,
      reason: 'written',
      growth: written.growth,
      state: next,
      usedToday: next.count,
      dailyLimit: limit,
      backupId: written.backupId || '',
    })
  }

  async function maybeReflect(options = {}) {
    const force = options?.force === true
    if (disposed) return { ok: false, reason: 'disposed', skipped: true }
    if (inflight) return { ok: false, reason: 'busy', skipped: true, busy: true }
    const promise = run(force)
      .catch((error) => {
        warn('反思异常', error)
        return record({ ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        if (inflight === promise) inflight = null
      })
    inflight = promise
    return promise
  }

  /** 延迟尝试（install 的 5s 首跑 / turnEnd 后的 0ms 合并）。重复 schedule 只保留一个。 */
  function schedule(delayMs = 0, options = {}) {
    if (disposed) return { ok: false, reason: 'disposed' }
    if (timer) return { ok: true, scheduled: true, already: true }
    const delay = Math.max(0, Math.round(asNumber(delayMs, 0)))
    timer = setTimeout(() => {
      timer = null
      try {
        void maybeReflect(options).catch(() => {})
      } catch (error) {
        warn('定时反思失败', error)
      }
    }, delay)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return { ok: true, scheduled: true, delay }
  }

  function disposition() {
    const now = Date.now()
    const s = normalizeReflectionState(readSoul().growthReflection)
    const today = localDayKey(now)
    const usedToday = s.dayKey === today ? s.count : 0
    const limit = dailyLimit()
    const enabled = isEnabled()
    const onCooldown = s.lastAt > 0 && now - s.lastAt < REFLECTION_COOLDOWN_MS
    let reason = ''
    if (!enabled) reason = 'disabled'
    else if (usedToday >= limit) reason = 'daily-limit'
    else if (usedToday >= 1) reason = 'already-today'
    else if (onCooldown) reason = 'cooldown'
    return {
      enabled,
      lastAt: s.lastAt,
      dayKey: s.dayKey,
      count: s.count,
      todayCount: usedToday,
      dailyLimit: limit,
      remaining: Math.max(0, limit - usedToday),
      cooldownMs: REFLECTION_COOLDOWN_MS,
      cooldownUntil: s.lastAt > 0 ? s.lastAt + REFLECTION_COOLDOWN_MS : 0,
      onCooldown,
      eligible: reason === '',
      reason,
      attempts,
      lastAttemptAt,
      last: { ...lastState },
    }
  }

  function lastStateSnapshot() {
    return { ...lastState }
  }

  function dispose() {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    maybeReflect,
    disposition,
    lastState: lastStateSnapshot,
    schedule,
    dispose,
  }
}
