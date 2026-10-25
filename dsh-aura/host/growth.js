/**
 * 成长层（Host 侧，纯函数）：soul.growth 的归一化 / 增改删 / 排序 / 身份段渲染。
 *
 * 设计约束：
 * - 不 import soul.js（soul.js 依赖本文件），所以码点工具在这里有一份小实现。
 * - 所有函数都不碰磁盘；写入与备份由 soul.js 的 installSoul 统一负责。
 * - `at` 是毫秒时间戳；同 kind + 同 text 视为同一条成长（去重时只更新 at）。
 * - 最多 40 条；超出时先删「最旧且未 pinned」的，全是 pinned 才删最旧的。
 */
import { randomUUID } from 'node:crypto'

export const GROWTH_LIMIT = 40
export const GROWTH_RENDER_LIMIT = 8
/** 写入上限（工具 text 参数）。 */
export const GROWTH_TEXT_MAX = 120
/** 身份段单条显示上限。 */
export const GROWTH_RENDER_TEXT_MAX = 60
export const GROWTH_NOTE_MAX = 200
export const GROWTH_HEADER = '你已经长出来的部分：'
export const GROWTH_KINDS = Object.freeze(['trait', 'interest', 'habit', 'bond', 'self'])
export const GROWTH_SOURCES = Object.freeze(['self', 'reflection', 'user'])

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

/** 按码点截断（与 soul.js 同语义；不切半个代理对）。 */
export function codepointSlice(text, max) {
  const points = Array.from(String(text ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

export function codepointLength(text) {
  return Array.from(String(text ?? '')).length
}

/** 成长是一行文本：折叠换行/连续空白，避免把身份段的行结构撑坏。 */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function growthKey(kind, text) {
  return `${kind}\u0000${text}`
}

/** 洗一条成长记录；没有可用 text 时返回 null。 */
export function normalizeGrowthItem(raw, now = Date.now()) {
  const src = asObject(raw)
  const text = codepointSlice(oneLine(src.text), GROWTH_TEXT_MAX)
  if (!text) return null
  const kind = GROWTH_KINDS.includes(src.kind) ? src.kind : 'trait'
  const source = GROWTH_SOURCES.includes(src.source) ? src.source : 'self'
  const note = codepointSlice(oneLine(src.note), GROWTH_NOTE_MAX)
  const item = {
    id: asId(src.id),
    at: Math.max(0, Math.round(asNumber(src.at, now))),
    kind,
    text,
    pinned: src.pinned === true,
    source,
  }
  if (note) item.note = note
  return item
}

/**
 * 洗一份 growth 数组：坏条丢弃、同 kind+text 合并（保留最新 at，合并 pinned/note）、
 * 最后裁到 GROWTH_LIMIT 条。缺失/非数组一律当空。
 */
export function normalizeGrowth(raw, now = Date.now()) {
  const items = []
  const index = new Map()
  for (const entry of asArray(raw)) {
    const item = normalizeGrowthItem(entry, now)
    if (!item) continue
    const key = growthKey(item.kind, item.text)
    const found = index.get(key)
    if (found === undefined) {
      index.set(key, items.length)
      items.push(item)
      continue
    }
    const prev = items[found]
    if (item.at >= prev.at) {
      prev.at = item.at
      prev.id = item.id
    }
    prev.pinned = prev.pinned || item.pinned
    if (!prev.note && item.note) prev.note = item.note
  }
  return trimGrowth(items)
}

/**
 * 裁到 limit 条：先删最旧且未 pinned 的；全都 pinned 才删最旧的一条。
 * 不修改入参。
 */
export function trimGrowth(entries, limit = GROWTH_LIMIT) {
  const out = asArray(entries).slice()
  const max = Math.max(1, Math.min(GROWTH_LIMIT, Math.round(asNumber(limit, GROWTH_LIMIT))))
  while (out.length > max) {
    let oldest = -1
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] && out[i].pinned === true) continue
      if (oldest < 0 || asNumber(out[i]?.at, 0) < asNumber(out[oldest]?.at, 0)) oldest = i
    }
    if (oldest < 0) {
      oldest = 0
      for (let i = 1; i < out.length; i += 1) {
        if (asNumber(out[i]?.at, 0) < asNumber(out[oldest]?.at, 0)) oldest = i
      }
    }
    out.splice(oldest, 1)
  }
  return out
}

/** pinned 在前，其次按 at 新→旧；同一时间保持原顺序（稳定）。 */
export function sortGrowth(entries) {
  return asArray(entries)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pin = (b.item?.pinned === true ? 1 : 0) - (a.item?.pinned === true ? 1 : 0)
      if (pin !== 0) return pin
      const at = asNumber(b.item?.at, 0) - asNumber(a.item?.at, 0)
      if (at !== 0) return at
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

/** 面板/API 用：排序后返回浅拷贝，可按 kind 过滤。 */
export function listGrowth(entries, { limit = GROWTH_LIMIT, kind = '' } = {}) {
  const max = Math.max(0, Math.min(GROWTH_LIMIT, Math.round(asNumber(limit, GROWTH_LIMIT))))
  return sortGrowth(entries)
    .filter((item) => (kind ? item.kind === kind : true))
    .slice(0, max)
    .map((item) => ({ ...item }))
}

/**
 * 新增一条成长。kind 非法回落到 trait；text 空返回 ok:false。
 * 同 kind+同 text 已存在时只更新 at（并按需补 note / pinned），返回 deduped:true。
 */
export function addGrowth(entries, input = {}, now = Date.now()) {
  const list = asArray(entries).slice()
  const text = codepointSlice(oneLine(input.text), GROWTH_TEXT_MAX)
  if (!text) return { ok: false, reason: 'text 不能为空', entries: list, deduped: false }
  const kind = GROWTH_KINDS.includes(input.kind) ? input.kind : 'trait'
  const note = codepointSlice(oneLine(input.note), GROWTH_NOTE_MAX)
  const pinned = input.pinned === true
  const source = GROWTH_SOURCES.includes(input.source) ? input.source : 'self'
  const at = Math.max(0, Math.round(asNumber(now, Date.now())))
  const found = list.find((item) => item && item.kind === kind && item.text === text)
  if (found) {
    const index = list.indexOf(found)
    const item = { ...found, at }
    if (note) item.note = note
    if (pinned) item.pinned = true
    list[index] = item
    return { ok: true, growth: { ...item }, entries: list, deduped: true }
  }
  const item = {
    id: asId(input.id),
    at,
    kind,
    text,
    ...(note ? { note } : {}),
    pinned,
    source,
  }
  list.push(item)
  return { ok: true, growth: { ...item }, entries: trimGrowth(list), deduped: false }
}

/**
 * 替换/修改一条成长（soul_evolve 的 replace 路径）。找不到 id 返回 ok:false。
 * 替换后若与另一条同 kind+text，会删掉另一条（保留这次更新）。
 */
export function updateGrowth(entries, id, patch = {}, now = Date.now()) {
  const list = asArray(entries).slice()
  const index = list.findIndex((item) => item && item.id === id)
  if (index < 0) return { ok: false, reason: '没有这条成长记录', entries: list }
  const prev = list[index]
  const text = codepointSlice(oneLine(asString(patch.text, prev.text)), GROWTH_TEXT_MAX)
  if (!text) return { ok: false, reason: 'text 不能为空', entries: list }
  const kind = GROWTH_KINDS.includes(patch.kind) ? patch.kind : prev.kind
  const item = { ...prev, kind, text, at: Math.max(0, Math.round(asNumber(now, Date.now()))) }
  if (patch.note !== undefined) {
    const note = codepointSlice(oneLine(patch.note), GROWTH_NOTE_MAX)
    if (note) item.note = note
    else delete item.note
  }
  if (typeof patch.pinned === 'boolean') item.pinned = patch.pinned
  const rest = list.filter((entry, i) => i !== index && !(entry && entry.kind === kind && entry.text === text))
  rest.push(item)
  return {
    ok: true,
    growth: { ...item },
    entries: trimGrowth(rest),
    deduped: rest.length < list.length,
  }
}

export function deleteGrowth(entries, id) {
  const list = asArray(entries)
  const next = list.filter((item) => item && item.id !== id)
  return { ok: next.length !== list.length, entries: next }
}

/**
 * 成长段文本（纯函数，确定性；growth 和 config 不变则每轮完全一致）。
 * 格式：`你已经长出来的部分：` + 每条 `- [kind] text`；最多 8 条、单条 ≤60 字。
 * budget 是整段（含标题）的码点上限；放不下任何一条时返回空串。
 */
export function renderGrowthSection(entries, { budget = Infinity, limit = GROWTH_RENDER_LIMIT } = {}) {
  const max = budget === Infinity ? Infinity : Math.max(0, Math.round(asNumber(budget, 0)))
  if (max <= 0) return ''
  const items = sortGrowth(entries).slice(0, Math.max(0, Math.round(asNumber(limit, GROWTH_RENDER_LIMIT))))
  const lines = []
  let out = ''
  for (const item of items) {
    const text = codepointSlice(oneLine(item?.text), GROWTH_RENDER_TEXT_MAX)
    if (!text) continue
    const kind = GROWTH_KINDS.includes(item?.kind) ? item.kind : 'trait'
    const line = `- [${kind}] ${text}`
    const candidate = lines.length === 0 ? `${GROWTH_HEADER}\n${line}` : `${out}\n${line}`
    if (codepointLength(candidate) > max) break
    lines.push(line)
    out = candidate
  }
  return lines.length > 0 ? out : ''
}

/**
 * 身份段拼接：核心身份优先，核心放完才放成长；核心超预算时成长完全不出现。
 * 只做整行追加（不会出现半条成长），成长段插在 closingTag 之前。
 */
export function composeIdentityText(core, entries, budget, closingTag = '[END AURA]') {
  const base = asString(core, '')
  if (!base) return ''
  const max = Math.max(0, Math.round(asNumber(budget, 1020)))
  if (codepointLength(base) >= max) return codepointSlice(base, max)
  const tail = `\n${closingTag}`
  if (!base.endsWith(tail)) return base
  const remaining = max - codepointLength(base) - 1
  if (remaining <= 0) return base
  const block = renderGrowthSection(entries, { budget: remaining })
  if (!block) return base
  return base.slice(0, -tail.length) + '\n' + block + tail
}
