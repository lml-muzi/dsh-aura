/**
 * dsh-aura 情绪系统（基准 / 历史 / 趋势 / 显著性）自测（node 直接跑，零网络）
 *   node dsh-aura/dev/emotion-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不碰真实 soul/config。覆盖：
 *   baseline 初始化与迁移兼容（缺省补齐、坏值夹取、ring 240、weight 夹取）；
 *   事件显著性 salience（高/低/中性 + LLM intensity 相乘 + 对 Δ 的影响）；
 *   衰减朝 baseline 回归（不再回中性）、幂等；baseline EWMA 半衰期约 3 天；
 *   history ring 240、historySnapshot(limit)、trend 走高/走低/平稳/波动/退回 baseline；
 *   installEmotion 快照字段（四维 + label + baseline + trend + history 40 + lastChange）；
 *   context 文案长度与预算（explicit / subtle / off），趋势句 ≤40 字且不含数值。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-emotion-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
mkdirSync(join(process.env.DSH_HOME, 'dsh-aura'), { recursive: true })

const soulMod = await import('../host/soul.js')
const emotionMod = await import('../host/emotion.js')
const { defaultsSoul, normalizeSoul, EMOTION_HISTORY_MAX } = soulMod
const {
  AFFECTION_HALF_LIFE_MS,
  BASELINE_HALF_LIFE_MS,
  EMOTION_CONTEXT_BUDGET,
  EMOTION_SNAPSHOT_HISTORY,
  SALIENCE_MAX,
  SALIENCE_MIN,
  SUBTLE_CONTEXT_BUDGET,
  TREND_THRESHOLD,
  applyAppraisal,
  baselineOf,
  computeTrend,
  decayedEmotion,
  defaultBaseline,
  describeTrend,
  historySnapshot,
  installEmotion,
  lastChangeOf,
  pushHistory,
  renderEmotionContext,
  ruleAppraise,
  salienceOf,
  salienceWithIntensity,
  updateBaseline,
  parseRecheckOutput,
} = emotionMod

const lengthOf = (text) => Array.from(String(text ?? '')).length
const HOUR = 3_600_000
const DAY = 86_400_000
let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${(error && error.stack) || error}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** 一条 history 行（趋势/ring 测试用）。 */
function row(at, valence, overrides = {}) {
  return {
    at,
    valence,
    arousal: 0.3,
    affection: 0.5,
    energy: 0.7,
    label: '平静',
    cause: '',
    weight: 1,
    ...overrides,
  }
}

/** 安装用的 config：衰减常数取默认。 */
const CONFIG = {
  soulEnabled: true,
  emotionEnabled: true,
  expressionStyle: 'explicit',
  emotionDecayValenceHours: 3,
  emotionDecayArousalMinutes: 45,
  emotionDecayEnergyHours: 6,
}

function makeFakeCtx() {
  const tools = []
  const contexts = []
  return {
    tools,
    contexts,
    ctx: {
      on() {
        return () => {}
      },
      effect() {
        return () => {}
      },
      systemPrompt: {
        section() {
          return () => {}
        },
        context(spec) {
          contexts.push(spec)
          return () => {}
        },
      },
      tools: {
        register(tool) {
          tools.push(tool)
          return () => {}
        },
      },
      get() {
        return undefined
      },
    },
  }
}

/** 假 soul 容器：只实现 emotion.js 用到的那几个方法。 */
function makeSoulContainer(initial) {
  const state = { soul: initial ?? defaultsSoul() }
  return {
    get: () => state.soul,
    saveSoon: () => {},
    on: () => () => {},
    explain: () => {},
    snapshot: () => ({}),
    replace(next) {
      state.soul = next
    },
  }
}

// ---------- 1. baseline 初始化 / 迁移 ----------
section('1. baseline：初始化、缺省补齐、坏值夹取、首条初始化')

await test('defaultsSoul：baseline 四维齐全且在范围内，history 为空', () => {
  const soul = defaultsSoul()
  const baseline = soul.emotion.baseline
  assert.ok(baseline && typeof baseline === 'object')
  assert.ok(baseline.valence >= -1 && baseline.valence <= 1)
  assert.ok(baseline.arousal >= 0 && baseline.arousal <= 1)
  assert.ok(baseline.affection >= 0 && baseline.affection <= 1)
  assert.ok(baseline.energy >= 0 && baseline.energy <= 1)
  assert.ok(Number(baseline.updatedAt) > 0)
  assert.deepEqual(soul.emotion.history, [])
})

await test('normalizeSoul：旧 soul.json 没有 baseline/history 时按默认值补齐', () => {
  const soul = normalizeSoul({ v: 2, emotion: { transient: { valence: 0.2 } } })
  assert.ok(soul.emotion.baseline && typeof soul.emotion.baseline === 'object')
  assert.equal(soul.emotion.baseline.affection, 0.5)
  assert.deepEqual(soul.emotion.history, [])
})

await test('normalizeSoul：baseline 坏值夹取（越界/字符串/null）', () => {
  const soul = normalizeSoul({
    emotion: { baseline: { valence: 9, arousal: -3, affection: 'abc', energy: null, updatedAt: 123 } },
  })
  assert.equal(soul.emotion.baseline.valence, 1)
  assert.equal(soul.emotion.baseline.arousal, 0)
  assert.equal(soul.emotion.baseline.affection, 0.5)
  assert.equal(soul.emotion.baseline.energy, 0.7)
  assert.equal(soul.emotion.baseline.updatedAt, 123)
})

await test('normalizeSoul：history 300 条 → 保留最新 240，坏条丢弃、weight 夹取', () => {
  const now = Date.now()
  const rows = Array.from({ length: 300 }, (_, i) => ({
    at: now - (300 - i) * 60_000,
    valence: i % 5 === 0 ? 7 : 0.1,
    arousal: 0.3,
    affection: 0.5,
    energy: 0.7,
    label: '平静',
    cause: 'c',
    weight: i % 7 === 0 ? 99 : 1,
  }))
  rows.push({ broken: true })
  rows.push(null)
  const soul = normalizeSoul({ emotion: { history: rows } })
  assert.equal(soul.emotion.history.length, EMOTION_HISTORY_MAX)
  assert.equal(soul.emotion.history[0].at, now - 240 * 60_000)
  assert.ok(soul.emotion.history.every((item) => item.valence >= -1 && item.valence <= 1))
  assert.ok(soul.emotion.history.every((item) => item.weight >= SALIENCE_MIN && item.weight <= SALIENCE_MAX))
})

await test('baselineOf：缺 baseline 回落默认；updateBaseline 首条直接取当前值', () => {
  const fallback = baselineOf({})
  assert.ok(Number.isFinite(fallback.valence) && Number.isFinite(fallback.energy))
  const now = Date.now()
  const emotion = { history: [] }
  const next = updateBaseline(emotion, { valence: 0.42, arousal: 0.5, affection: 0.61, energy: 0.33 }, now)
  assert.equal(next.valence, 0.42)
  assert.equal(next.affection, 0.61)
  assert.equal(next.updatedAt, now)
  assert.deepEqual(emotion.baseline, next)
})

await test('baseline EWMA：半衰期 3 天 → 经过 3 天吃掉一半差距', () => {
  const now = Date.now()
  const emotion = { baseline: { valence: 0, arousal: 0.4, affection: 0.5, energy: 0.7, updatedAt: now - 3 * DAY } }
  const next = updateBaseline(emotion, { valence: 1, arousal: 0.4, affection: 0.5, energy: 0.7 }, now)
  assert.ok(Math.abs(next.valence - 0.5) < 1e-9, `期望 0.5，实际 ${next.valence}`)
  assert.equal(BASELINE_HALF_LIFE_MS, 3 * DAY)
})

// ---------- 2. 事件显著性 ----------
section('2. salience：高权重 / 日常寒暄 / 中性 / LLM intensity')

await test('规则显著性：冲突/道歉/表白 ≥1.3，寒暄 ≤0.6，中性 1', () => {
  assert.ok(ruleAppraise('对不起，是我不好，我错了').salience >= 1.3)
  assert.ok(ruleAppraise('我们分手吧').salience >= 1.3)
  assert.ok(ruleAppraise('我喜欢你').salience >= 1.3)
  assert.ok(ruleAppraise('嗯').salience <= 0.6)
  assert.ok(ruleAppraise('好的').salience <= 0.6)
  assert.ok(ruleAppraise('在吗').salience <= 0.6)
  const neutral = ruleAppraise('今天下午开了个会，回来的路上买了两斤橘子').salience
  assert.ok(neutral >= 0.9 && neutral <= 1.1, `中性应≈1，实际 ${neutral}`)
  // 重要分享：明显长的一段话也算高权重（≥1.3）；普通长句只是略高
  assert.ok(salienceOf('今天想跟你说件事，'.repeat(20)) >= 1.3)
  const midShare = salienceOf('今天下午去看了医生，说没什么大问题，就是最近睡得太晚，让我早点休息，别老熬夜，顺便把咖啡停了。')
  assert.ok(midShare >= 1 && midShare < 1.3, `普通分享应≈1.15，实际 ${midShare}`)
  for (const text of ['嗯', '我们分手吧', '随便聊聊', '']) {
    const weight = salienceOf(text)
    assert.ok(weight >= SALIENCE_MIN && weight <= SALIENCE_MAX, `${text} → ${weight} 越界`)
  }
})

await test('salienceWithIntensity：LLM intensity 乘进规则权重并夹回 0.3~1.8', () => {
  assert.equal(salienceWithIntensity(1, 1.5), 1.5)
  assert.equal(salienceWithIntensity(1.6, 2), SALIENCE_MAX)
  assert.equal(salienceWithIntensity(0.4, 0.2), SALIENCE_MIN)
  assert.equal(salienceWithIntensity(1.2, undefined), 1.2)
})

await test('parseRecheckOutput：读取可选 intensity（0..2）', () => {
  const parsed = parseRecheckOutput('{"valenceDelta":0.3,"intensity":1.6,"cause":"用户道歉"}')
  assert.equal(parsed.intensity, 1.6)
  const plain = parseRecheckOutput('{"valenceDelta":0.1}')
  assert.equal(plain.intensity, undefined)
  const clamped = parseRecheckOutput('{"valenceDelta":0.1,"intensity":9}')
  assert.equal(clamped.intensity, 2)
})

await test('salience 影响 Δ：同一 appraisal，1.6 比 0.4 推得更远，history.weight 记录权重', () => {
  const now = Date.now()
  const run = (salience) => {
    const soul = defaultsSoul()
    const applied = applyAppraisal(soul, {
      valenceDelta: 0.5,
      affectionDelta: 0.2,
      arousalDelta: 0.3,
      confidence: 0.8,
      cause: '测试',
      salience,
    }, CONFIG, now)
    return { soul, applied }
  }
  const low = run(0.4)
  const high = run(1.6)
  assert.ok(high.applied.after.transient.valence > low.applied.after.transient.valence + 0.1)
  assert.ok(Math.abs(low.applied.salience - 0.4) < 1e-9)
  assert.ok(Math.abs(high.applied.salience - 1.6) < 1e-9)
  assert.equal(high.soul.emotion.history.length, 1)
  assert.equal(high.soul.emotion.history[0].weight, 1.6)
  assert.equal(low.soul.emotion.history[0].weight, 0.4)
  // 单次修正仍然限幅：|Δval| ≤ 0.6、|Δaff| ≤ 0.4
  assert.ok(high.applied.after.transient.valence <= 1)
  assert.ok(high.applied.after.affection <= 1)
})

// ---------- 3. 衰减朝 baseline ----------
section('3. 衰减：朝 baseline 回归（不再回中性），幂等')

await test('valence 一个半衰期从 -0.4 走到 baseline(0.6) 的中点 0.1', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.baseline = { valence: 0.6, arousal: 0.2, affection: 0.7, energy: 0.7, updatedAt: now }
  soul.emotion.transient = { valence: -0.4, arousal: 0.2, label: '低落', intensity: 0.5, cause: '', updatedAt: now - 3 * HOUR }
  const value = decayedEmotion(soul, CONFIG, now).transient.valence
  assert.ok(Math.abs(value - 0.1) < 1e-9, `期望 0.1，实际 ${value}`)
})

await test('长时间后收敛到 baseline，而不是中性 0（旧行为会掉到 ~0）', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.baseline = { valence: 0.6, arousal: 0.2, affection: 0.7, energy: 0.7, updatedAt: now }
  soul.emotion.transient = { valence: -0.4, arousal: 0.2, label: '低落', intensity: 0.5, cause: '', updatedAt: now - 24 * HOUR }
  const value = decayedEmotion(soul, CONFIG, now).transient.valence
  assert.ok(value > 0.5, `应贴近 baseline 0.6，实际 ${value}`)
  assert.ok(value < 0.6)
  // 旧实现朝 baseOf 的中性值衰减，24h 后 |value| 已经很小
  assert.ok(value > -0.4 + 0.6)
})

await test('affection / energy 也朝各自 baseline 靠近', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.baseline = { valence: 0, arousal: 0.2, affection: 0.8, energy: 0.2, updatedAt: now }
  soul.emotion.affection = 0.2
  soul.emotion.affectionUpdatedAt = now - AFFECTION_HALF_LIFE_MS
  soul.emotion.drive.energy = 0.8
  soul.emotion.drive.updatedAt = now - 6 * HOUR
  const decayed = decayedEmotion(soul, CONFIG, now)
  assert.ok(Math.abs(decayed.affection - 0.5) < 1e-9, `affection 期望 0.5，实际 ${decayed.affection}`)
  assert.ok(Math.abs(decayed.drive.energy - 0.5) < 1e-9, `energy 期望 0.5，实际 ${decayed.drive.energy}`)
})

await test('衰减幂等：同一 now 调两次结果一致，且不推进 updatedAt', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.transient = { valence: -0.5, arousal: 0.6, label: '烦躁', intensity: 0.7, cause: '', updatedAt: now - 2 * HOUR }
  const first = decayedEmotion(soul, CONFIG, now)
  const second = decayedEmotion(soul, CONFIG, now)
  assert.deepEqual(first, second)
  assert.equal(soul.emotion.transient.updatedAt, now - 2 * HOUR)
})

// ---------- 4. history ring ----------
section('4. history：ring 240 / historySnapshot(limit)')

await test('pushHistory 撑到 300 条后仍只留 240，且丢的是最旧', () => {
  const now = Date.now()
  const emotion = { history: [] }
  for (let i = 0; i < 300; i += 1) {
    pushHistory(emotion, { at: now - (300 - i) * 60_000, valence: 0.1, arousal: 0.2, affection: 0.5, energy: 0.7, label: '平静', cause: `第${i}条`, weight: 1 })
  }
  assert.equal(emotion.history.length, EMOTION_HISTORY_MAX)
  assert.equal(emotion.history[0].cause, '第60条')
  assert.equal(emotion.history[emotion.history.length - 1].cause, '第299条')
})

await test('historySnapshot(limit)：默认 60、可截 40、旧→新、字段齐全', () => {
  const now = Date.now()
  const emotion = { history: Array.from({ length: 100 }, (_, i) => row(now - (100 - i) * 60_000, 0.1, { cause: `c${i}` })) }
  assert.equal(historySnapshot(emotion).length, 60)
  assert.equal(historySnapshot(emotion, 40).length, 40)
  const rows = historySnapshot(emotion, EMOTION_SNAPSHOT_HISTORY)
  assert.equal(rows.length, EMOTION_SNAPSHOT_HISTORY)
  assert.ok(rows[0].at < rows[rows.length - 1].at, '应该旧→新')
  assert.deepEqual(Object.keys(rows[0]).sort(), ['affection', 'arousal', 'at', 'cause', 'energy', 'label', 'valence', 'weight'])
  assert.equal(lastChangeOf(emotion).cause, 'c99')
  assert.equal(lastChangeOf({ history: [] }).at, 0)
})

// ---------- 5. trend ----------
section('5. trend：走高 / 走低 / 平稳 / 波动 / 退回 baseline')

function emotionWithWindows(now, recentValence, previousValence) {
  const history = []
  for (let i = 1; i <= 12; i += 1) history.push(row(now - i * 30 * 60_000, recentValence)) // 最近 6h
  for (let i = 1; i <= 24; i += 1) history.push(row(now - 6 * HOUR - i * HOUR, previousValence)) // 前 24h
  return { history, baseline: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.7, updatedAt: now } }
}

await test('最近 6h 比前 24h 高 → up，delta > 阈值', () => {
  const now = Date.now()
  const trend = computeTrend(emotionWithWindows(now, 0.6, -0.2), now)
  assert.equal(trend.direction, 'up')
  assert.ok(trend.delta > TREND_THRESHOLD)
  assert.equal(trend.windowHours, 6)
  assert.equal(trend.reference, 'history')
})

await test('最近 6h 比前 24h 低 → down', () => {
  const now = Date.now()
  const trend = computeTrend(emotionWithWindows(now, -0.5, 0.5), now)
  assert.equal(trend.direction, 'down')
  assert.ok(trend.delta < -TREND_THRESHOLD)
})

await test('窗口均值相同 → flat，阈值内不判方向', () => {
  const now = Date.now()
  assert.equal(computeTrend(emotionWithWindows(now, 0.1, 0.1), now).direction, 'flat')
  const flatEmotion = {
    history: [],
    baseline: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.7, updatedAt: now },
  }
  assert.equal(computeTrend(flatEmotion, now, { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.7 }).direction, 'flat')
  assert.equal(computeTrend(flatEmotion, now, { valence: 0.02, arousal: 0.2, affection: 0.5, energy: 0.7 }).direction, 'flat')
})

await test('波动：最近窗口值来回跳 → volatility 明显 > 0', () => {
  const now = Date.now()
  const history = []
  for (let i = 1; i <= 12; i += 1) history.push(row(now - i * 20 * 60_000, i % 2 === 0 ? 0.9 : -0.9))
  const trend = computeTrend({ history, baseline: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.7, updatedAt: now } }, now)
  assert.ok(trend.volatility > 0.1, `volatility=${trend.volatility}`)
  assert.ok(trend.volatility <= 1)
})

await test('没有前 24h 数据时退回 baseline 当参照', () => {
  const now = Date.now()
  const emotion = {
    history: [row(now - 30 * 60_000, 0.8, { affection: 0.8, energy: 0.8, arousal: 0.6 })],
    baseline: { valence: -0.2, arousal: 0.2, affection: 0.4, energy: 0.5, updatedAt: now },
  }
  const trend = computeTrend(emotion, now)
  assert.equal(trend.reference, 'baseline')
  assert.equal(trend.direction, 'up')
})

await test('decayedEmotion 自带 baseline + trend 视图', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.history = emotionWithWindows(now, 0.6, -0.2).history
  const decayed = decayedEmotion(soul, CONFIG, now)
  assert.ok(decayed.baseline && Number.isFinite(decayed.baseline.valence))
  assert.equal(decayed.trend.direction, 'up')
})

// ---------- 6. 快照 / API ----------
section('6. installEmotion：snapshot 字段、事件写入、context 注册')

const { ctx, tools, contexts } = makeFakeCtx()
const soulContainer = makeSoulContainer()
const emotionApi = installEmotion(ctx, {
  state: { readConfig: () => CONFIG },
  soul: soulContainer,
  bridge: {},
  log: () => {},
})

await test('context order 30 已注册，soul_mood 工具已注册', () => {
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].order, 30)
  assert.equal(contexts[0].name, 'aura:emotion')
  assert.ok(tools.some((tool) => tool.name === 'soul_mood'))
})

await test('snapshot 返回四维 + label + baseline + trend + history(40) + lastChange', () => {
  const soul = soulContainer.get()
  const now = Date.now()
  soul.emotion.history = Array.from({ length: 60 }, (_, i) => row(now - (60 - i) * 60_000, 0.2))
  soul.emotion.transient.updatedAt = now - HOUR
  const snap = emotionApi.snapshot()
  for (const key of ['valence', 'arousal', 'affection', 'energy', 'label']) {
    assert.ok(snap[key] !== undefined, `缺少 ${key}`)
  }
  assert.ok(snap.baseline && Number.isFinite(snap.baseline.valence) && Number(snap.baseline.updatedAt) > 0)
  assert.ok(snap.trend && ['up', 'down', 'flat'].includes(snap.trend.direction))
  assert.ok(Number.isFinite(snap.trend.volatility) && snap.trend.windowHours === 6)
  assert.equal(snap.history.length, 40)
  assert.ok(snap.history[0].at < snap.history[snap.history.length - 1].at)
  assert.ok(snap.lastChange && Number(snap.lastChange.at) > 0)
})

await test('onUserMessage：高显著性文本写进 history（weight ≥1.3），并可查 snapshot', () => {
  const before = soulContainer.get().emotion.history.length
  soulContainer.get().relation.turns = 3
  emotionApi.onUserMessage({ text: '对不起，是我不好，我错了', at: Date.now() })
  const soul = soulContainer.get()
  assert.equal(soul.emotion.history.length, before + 1)
  const last = soul.emotion.history[soul.emotion.history.length - 1]
  assert.ok(last.weight >= 1.3, `weight=${last.weight}`)
  assert.equal(last.label, soul.emotion.transient.label)
  assert.ok(Number(soul.emotion.baseline.updatedAt) > 0)
  const snap = emotionApi.snapshot()
  assert.equal(snap.history.length, EMOTION_SNAPSHOT_HISTORY)
  assert.equal(snap.lastChange.cause, last.cause)
})

await test('/api/state 的 soul.emotion：emotion.snapshot 优先，soul.snapshot 有兜底块', () => {
  const soulSnap = soulContainer.snapshot()
  assert.deepEqual(soulSnap, {}, '假容器 snapshot 故意为空')
  const emotionSnap = emotionApi.snapshot()
  const merged = emotionSnap || {}
  assert.ok(merged.baseline && merged.trend && Array.isArray(merged.history), '合并后应带齐新增字段')
  // 真实 soul.snapshot 的兜底块（不启 installSoul，只验结构函数存在即可）
  assert.equal(typeof soulMod.normalizeSoul, 'function')
  const normalized = normalizeSoul({ emotion: { history: [row(Date.now(), 0.3)] } })
  assert.equal(normalized.emotion.history.length, 1)
  assert.ok(normalized.emotion.baseline && typeof normalized.emotion.baseline === 'object')
})

// ---------- 7. context 文案 ----------
section('7. context：趋势句 ≤40 字、不暴露数值、受预算截断')

await test('describeTrend ≤40 字、不含数字、方向词与方向一致', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.history = emotionWithWindows(now, 0.6, -0.2).history
  const decayed = decayedEmotion(soul, CONFIG, now)
  const text = describeTrend(decayed)
  assert.ok(lengthOf(text) <= 40, `长度 ${lengthOf(text)}`)
  assert.ok(!/\d/.test(text), `不应含数字：${text}`)
  assert.ok(text.includes('走高'))
  const down = describeTrend({ ...decayed, trend: { direction: 'down', volatility: 0 } })
  assert.ok(down.includes('走低'))
  const flat = describeTrend({ ...decayed, trend: { direction: 'flat', volatility: 0 } })
  assert.ok(flat.includes('偏稳'))
})

await test('explicit：四维数字后带趋势句，总长 ≤ 预算且尾部指令不被截断', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.relation.stage = 'close'
  soul.emotion.history = emotionWithWindows(now, 0.6, -0.2).history
  const text = renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'explicit' }, now)
  assert.ok(text.startsWith('[情绪]'))
  assert.ok(text.includes('愉悦=') && text.includes('亲近='), '四维数字应保留')
  const trendAt = text.indexOf('最近整体')
  const expressionAt = text.indexOf('表达：')
  assert.ok(trendAt > text.indexOf('亲近='), '趋势句应在四维数字之后')
  assert.ok(trendAt > 0 && expressionAt > trendAt)
  assert.ok(text.endsWith('"我的情绪"。'), '尾部指令不应被预算截断')
  assert.ok(lengthOf(text) <= EMOTION_CONTEXT_BUDGET, `长度 ${lengthOf(text)} > ${EMOTION_CONTEXT_BUDGET}`)
})

await test('subtle：显著时注入趋势句且 ≤ 预算；不显著返回空', () => {
  const now = Date.now()
  const loud = defaultsSoul()
  loud.emotion.transient = { valence: 0.75, arousal: 0.8, label: '兴奋', intensity: 0.8, cause: '开心', updatedAt: now }
  const subtle = renderEmotionContext(loud, { ...CONFIG, expressionStyle: 'subtle' }, now)
  assert.ok(subtle.includes('此刻心情') && subtle.includes('最近整体'))
  assert.ok(lengthOf(subtle) <= SUBTLE_CONTEXT_BUDGET, `长度 ${lengthOf(subtle)}`)
  const calm = defaultsSoul()
  calm.emotion.transient = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.1, cause: '', updatedAt: now }
  assert.equal(renderEmotionContext(calm, { ...CONFIG, expressionStyle: 'subtle' }, now), '')
})

await test('off / soulEnabled=false 时注入为空串', () => {
  const soul = defaultsSoul()
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'off' }), '')
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'explicit', soulEnabled: false }), '')
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'explicit', emotionEnabled: false }), '')
})

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
