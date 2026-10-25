/**
 * 情绪层（Host 侧）：事件评估 → 状态数学 → 衰减 → expressionStyle 三档注入 → 安全守卫。
 *
 * 设计依据：docs/aura-soul-design.md 的 B（情绪模型）、E.4（context order 30）、E.5.1（qq_mood）、
 * F.1 第 4/19 条（衰减幂等、自报限幅）。
 *
 * 状态所有权：情绪数据存在 soul.get().emotion 里，由 soul.js 统一落盘；
 * 本文件只计算与写字段，然后调用 soul.saveSoon()。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  clamp,
  codepointSlice,
  codepointLength,
  localDayKey,
  stageLabel,
  isSoulSession,
  STAGES,
} from './soul.js'

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

export function normalizeStyle(value) {
  return value === 'explicit' || value === 'off' ? value : 'subtle'
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
  return {
    valenceDelta: valence,
    arousalDelta: clamp(arousal, -1, 1),
    affectionDelta: clamp(affection, -1, 1),
    energyDelta: clamp(energy, -1, 1),
    label: undefined,
    cause: cause ? `用户提到「${cause}」` : (String(ctx.fallbackCause ?? '对话')).slice(0, 30),
    confidence: irony ? 0.4 : 0.5,
    irony,
  }
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
  const base = baseOf(traits, now)
  const halfLife = halfLivesOf(config)
  const updatedAt = Number(t.updatedAt) || now
  const valence = clamp(decayTo(clamp(Number(t.valence) || 0, -1, 1), base.valence, updatedAt, halfLife.valenceMs, now), -1, 1)
  const arousal = clamp(decayTo(clamp(Number(t.arousal) || 0.2, 0, 1), base.arousal, updatedAt, halfLife.arousalMs, now), 0, 1)
  const energy = clamp(decayTo(clamp(Number(drive.energy) || 0.7, 0, 1), base.energy, Number(drive.updatedAt) || now, halfLife.energyMs, now), 0, 1)
  // 心情标签：保留 LLM/自报的自由标签 2 小时内，否则按平面重算
  const source = String(t.source ?? 'rule')
  const freeRecent = (source === 'llm' || source === 'self') && now - updatedAt < 2 * 3_600_000
  const label = freeRecent && t.label ? String(t.label).slice(0, 4) : planeLabel(valence, arousal)
  const moodView = {
    valence: clamp(decayTo(clamp(Number(mood.valence) || 0, -1, 1), base.valence, Number(mood.updatedAt) || now, halfLife.valenceMs * 3, now), -1, 1),
    arousal: clamp(decayTo(clamp(Number(mood.arousal) || 0.24, 0, 1), base.arousal, Number(mood.updatedAt) || now, halfLife.arousalMs * 3, now), 0, 1),
  }
  let affection = clamp(Number(raw.affection) || 0.5, 0, 1)
  if (affection > 0.85) {
    affection = clamp(decayTo(affection, 0.85, Number(raw.affectionUpdatedAt) || now, 30 * 86_400_000, now), 0, 1)
  }
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
 * 把一次 Appraisal 落到 soul.emotion（会写状态）。返回 {before, after}。
 * 单次修正限幅：|Δval| ≤ 0.6、|Δaff| ≤ 0.4（LLM 复核必过这里）。
 */
export function applyAppraisal(soul, appraisal, config = {}, now = Date.now()) {
  const ap = appraisal && typeof appraisal === 'object' ? appraisal : {}
  const before = decayedEmotion(soul, config, now)
  const traits = soul?.identity?.traits ?? {}
  const base = baseOf(traits, now)
  const gain = personalityGain(traits)
  const scale = 0.7 + clamp(Number(ap.confidence) || 0.5, 0, 1) * 0.6
  const dv = clamp(Number(ap.valenceDelta) || 0, -0.6, 0.6)
  const da = clamp(Number(ap.arousalDelta) || 0, -0.6, 0.6)
  const dAff = clamp(Number(ap.affectionDelta) || 0, -0.4, 0.4)
  const dEnergy = clamp(Number(ap.energyDelta) || 0, -0.4, 0.4)
  const emo = soul.emotion
  const t = emo.transient
  const valenceGain = dv < 0 ? gain.negativeValence : gain.valence
  const targetV = clamp(base.valence + dv * valenceGain * scale, -1, 1)
  t.valence = clamp(Number(t.valence) || 0, -1, 1) + (targetV - (Number(t.valence) || 0)) * GAIN.valence
  const targetA = clamp(base.arousal + da * gain.arousal * scale + Math.abs(dv) * 0.2, 0, 1)
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
  return { before, after }
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

/** 情绪上下文段（context order 30）。off 返回空串；subtle 只在显著时注入；不向用户暴露数值。 */
export function renderEmotionContext(soul, config = {}, now = Date.now()) {
  const style = normalizeStyle(config.expressionStyle)
  if (style === 'off') return ''
  if (config.emotionEnabled === false || config.soulEnabled === false) return ''
  const e = decayedEmotion(soul, config, now)
  const hint = STYLE_HINTS[e.transient.label] ?? '自然即可'
  if (style === 'subtle') {
    if (!isSalient(e)) return ''
    const tired = Number(e.drive.energy) < 0.3 && !/低落|沮丧|烦躁/.test(e.transient.label) ? '，也有一点累' : ''
    return codepointSlice(`（此刻心情：${e.transient.label}${tired}，${hint}。）`, 60)
  }
  const neg = e.transient.valence < -0.3 ? '偏负面' : e.transient.valence > 0.3 ? '偏正面' : '中性'
  return codepointSlice(
    `[情绪] 标签=${e.transient.label} 愉悦=${e.transient.valence.toFixed(2)} 唤醒=${e.transient.arousal.toFixed(2)}`
    + ` 亲近=${e.affection.toFixed(2)} 精力=${e.drive.energy.toFixed(2)} 强度=${e.transient.intensity.toFixed(2)}`
    + ` 关系=${e.stageLabel}；表达：${hint}（整体${neg}）；不要向用户报告这些数值，也不要解释"我的情绪"。`,
    140,
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
  'energyDelta(-1..1，精力变化，通常 0)、label(可选，中文 2~4 字，如"感动""心虚")、',
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
    }
  }
  const localDefaults = {
    soulEnabled: true,
    emotionEnabled: true,
    emotionScope: 'qq',
    expressionStyle: 'subtle',
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

  // 会话过滤：默认只对 QQ 陪伴会话注入（与旧实现 emotionScope 语义一致）
  function enabledForSession(assembly, config) {
    try {
      if (config.emotionEnabled === false || config.soulEnabled === false) return false
      const sessionId = String(assembly?.agent?.session?.id ?? assembly?.agent?.session?.header?.id ?? '')
      if (assembly && !assembly.agent && config.emotionScope !== 'all') return false
      return isSoulSession(config, sessionId)
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
      const lastRecheckTurn = Number(current.emotion.lastRecheckTurn) || -999
      const appraisal = ruleAppraise(text)
      const applied = applyAppraisal(current, appraisal, config, now)
      regulateEmotion(current, { userPresent: true })
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

  // ⑥ qq_mood 工具（模型自报，最终表达权；带限幅与频率约束）
  let lastMoodTurn = -999
  try {
    ctx.tools?.register?.(defineTool({
      name: 'qq_mood',
      description: '更新你自己此刻的情绪（这是你的最终表达权）。情绪被这段对话推动时调用；不必每轮都调，明显变化时才调。'
        + '传 cause 说明原因；数值会被限幅，情绪也会随时间自然回落。',
      parameters: {
        valence: { type: 'number', description: '愉悦 -1..1' },
        arousal: { type: 'number', description: '唤醒 0..1' },
        affection: { type: 'number', description: '对用户的亲近感 0..1' },
        energy: { type: 'number', description: '精力 0..1' },
        label: { type: 'string', description: '可选：中文 2~4 字情绪词，如"感动""心虚"' },
        cause: { type: 'string', description: '必填：≤40 字，什么让你这样', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '情绪已更新：' + String(value?.label ?? '') }],
      },
      async execute(args = {}) {
        const text = typeof args?.cause === 'string' ? args.cause.trim() : ''
        if (!text) return { ok: false, reason: '缺少 cause：请说明是什么让你有这样的情绪' }
        const current = readSoul()
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
        soul.saveSoon()
        soul.explain({ at: now, kind: 'emotion', source: 'self', label: t.label, cause: t.cause })
        return {
          ok: true,
          label: t.label,
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
    logger('[soul] qq_mood 工具注册失败:', error instanceof Error ? error.message : error)
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

  // ⑧ API
  function snapshot() {
    try {
      const config = readConfig()
      const e = decayedEmotion(readSoul(), config)
      const raw = readSoul().emotion
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
    constants: { LEXICON, IRONY_MARKS, GAIN, DEFAULT_HALF_LIFE, RECHECK_SYSTEM },
  }
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000
}
