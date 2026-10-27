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
 *   episode 历史（GET ?action=history）：startedAt 倒序、含过期 expired、limit ≤30、fence；
 *   state 快照新增 episodes(active 最近 5)/historyCount；soul_feel 允许只写 note，complex 独立字段（≤20）；
 *   context 文案长度与预算（explicit / subtle / off），趋势句 ≤40 字且不含数值。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
const stateMod = await import('../host/state.js')
const { defaultsSoul, normalizeSoul, EMOTION_HISTORY_MAX } = soulMod
const {
  DEFAULT_CONFIG,
  DEFAULT_EXPRESSION_STYLE,
  STRING_LIMITS,
  normalizeConfig,
} = stateMod
const {
  AFFECTION_HALF_LIFE_MS,
  BASELINE_HALF_LIFE_MS,
  EMOTION_CONTEXT_BUDGET,
  EMOTION_SNAPSHOT_HISTORY,
  SALIENCE_MAX,
  SALIENCE_MIN,
  SUBTLE_CONTEXT_BUDGET,
  TREND_THRESHOLD,
  EMOTION_STATE_EPISODES,
  EPISODE_COMPLEX_MAX,
  EPISODE_HISTORY_LIMIT,
  EPISODE_LEVELS,
  EPISODE_RING,
  EPISODE_TYPES,
  NUDGE_COOLDOWN_MS,
  NUDGE_DAILY_MAX,
  NUDGE_MIN_SALIENCE,
  RULE_EPISODE_COOLDOWN_MS,
  RULE_EPISODE_MIN_SALIENCE,
  activeEpisodes,
  activeNudge,
  addEpisode,
  applyAppraisal,
  baselineOf,
  clearNudge,
  computeTrend,
  decayedEmotion,
  defaultBaseline,
  describeEpisode,
  describeNudge,
  describeTrend,
  ensureEmotionExtras,
  episodeHintOf,
  episodeHistory,
  episodeLevel,
  episodeSnapshot,
  historySnapshot,
  installEmotion,
  lastChangeOf,
  maybeNudge,
  maybeRuleEpisode,
  normalizeEmotionEpisodes,
  normalizeEmotionNudge,
  normalizeStyle,
  expressionGuidance,
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
function makeSoulContainer(initial, options = {}) {
  const state = { soul: initial ?? defaultsSoul() }
  const records = { backups: [], saveSoon: 0 }
  return {
    records,
    get: () => state.soul,
    saveSoon: () => { records.saveSoon += 1 },
    async saveWithBackup(reason) {
      records.backups.push(String(reason || ''))
      if (options.backupThrows) throw new Error('backup failed')
      return { ok: true }
    },
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

// ---------- 7.5 表达方式：自由文本 / 旧值迁移 / soul_evolve ----------
section('7.5 表达方式：自由文本输入、旧值迁移、soul_evolve 可改')

await test('默认值是自由文本（含蓄描述），STRING_LIMITS.expressionStyle = 200', () => {
  assert.equal(DEFAULT_CONFIG.expressionStyle, DEFAULT_EXPRESSION_STYLE)
  assert.ok(DEFAULT_EXPRESSION_STYLE.includes('含蓄'))
  assert.equal(STRING_LIMITS.expressionStyle, 200)
  assert.equal(normalizeConfig({}).expressionStyle, DEFAULT_EXPRESSION_STYLE)
})

await test('旧值迁移：subtle → 默认含蓄句；explicit → 直白；off → 关闭', () => {
  assert.equal(normalizeConfig({ expressionStyle: 'subtle' }).expressionStyle, DEFAULT_EXPRESSION_STYLE)
  assert.match(normalizeConfig({ expressionStyle: 'explicit' }).expressionStyle, /^直白：/)
  assert.match(normalizeConfig({ expressionStyle: 'off' }).expressionStyle, /^关闭：/)
})

await test('自由文本原样保留；空串保留（= 不注入）；超过 200 字截断', () => {
  const custom = '冷静一点：先听我说完，再用你自己的话接'
  assert.equal(normalizeConfig({ expressionStyle: custom }).expressionStyle, custom)
  assert.equal(normalizeConfig({ expressionStyle: '字'.repeat(260) }).expressionStyle.length, 200)
  assert.equal(normalizeConfig({ expressionStyle: '' }).expressionStyle, '')
  assert.equal(normalizeConfig({ expressionStyle: '   ' }).expressionStyle, '')
})

await test('旧 config.json 从磁盘读取时也会迁移表达方式', () => {
  const saved = stateMod.readJson('config.json', null)
  try {
    stateMod.writeJson('config.json', { expressionStyle: 'explicit' })
    assert.match(stateMod.readConfig().expressionStyle, /^直白：/)
    stateMod.writeJson('config.json', { expressionStyle: 'subtle' })
    assert.equal(stateMod.readConfig().expressionStyle, DEFAULT_EXPRESSION_STYLE)
  } finally {
    stateMod.writeJson('config.json', saved && typeof saved === 'object' ? saved : {})
  }
})

await test('soul_evolve 白名单接受 expressionStyle：空串回落默认、超长拒绝', () => {
  assert.ok(soulMod.EVOLVE_CONFIG_FIELDS.includes('expressionStyle'))
  const ok = soulMod.sanitizeSoulConfigPatch({ expressionStyle: '直白但别报数值' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.configPatch, { expressionStyle: '直白但别报数值' })
  assert.equal(soulMod.sanitizeSoulConfigPatch({ expressionStyle: '' }).configPatch.expressionStyle, DEFAULT_EXPRESSION_STYLE)
  assert.equal(soulMod.sanitizeSoulConfigPatch({ expressionStyle: '字'.repeat(201) }).ok, false)
  assert.equal(soulMod.sanitizeSoulConfigPatch({ expressionStyle: 42 }).ok, false)
  const validated = soulMod.validateEvolveArgs({ text: '我学会换一种说法', config: { expressionStyle: '再软一点' } })
  assert.equal(validated.ok, true)
  assert.equal(validated.config.configPatch.expressionStyle, '再软一点')
})

await test('normalizeStyle / expressionGuidance：关闭、直白、其他、旧三档', () => {
  assert.equal(normalizeStyle(''), 'off')
  assert.equal(normalizeStyle('关闭：不注入情绪'), 'off')
  assert.equal(normalizeStyle('off'), 'off')
  assert.equal(normalizeStyle('OFF'), 'off')
  assert.equal(normalizeStyle('none'), 'off')
  assert.equal(normalizeStyle('直白：可以自然说出感受'), 'explicit')
  assert.equal(normalizeStyle('explicit'), 'explicit')
  assert.equal(normalizeStyle('含蓄：用停顿带出来'), 'subtle')
  assert.equal(normalizeStyle('subtle'), 'subtle')
  assert.equal(expressionGuidance('直白：别报数值'), '直白：别报数值')
  assert.equal(expressionGuidance('explicit'), '')
  assert.equal(expressionGuidance('含蓄：用停顿'), '含蓄：用停顿')
})

await test('直白自由文本：explicit 模式，原文进「表达：」，仍保留不报数值约束', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.relation.stage = 'close'
  soul.emotion.transient = { valence: 0.5, arousal: 0.6, label: '开心', intensity: 0.6, cause: '聊得开心', updatedAt: now }
  const text = renderEmotionContext(soul, { ...CONFIG, expressionStyle: '直白：可以自然说出感受，但别报数值' }, now)
  assert.ok(text.startsWith('[情绪]'))
  assert.ok(text.includes('表达：直白：可以自然说出感受，但别报数值'), text)
  assert.ok(text.includes('不要向用户报告这些数值'), text)
  assert.ok(text.endsWith('"我的情绪"。'))
})

await test('含蓄自由文本：只影响语气；显著时注入原文，平静时为空', () => {
  const now = Date.now()
  const loud = defaultsSoul()
  loud.emotion.transient = { valence: 0.75, arousal: 0.8, label: '兴奋', intensity: 0.8, cause: '开心', updatedAt: now }
  const subtle = renderEmotionContext(loud, { ...CONFIG, expressionStyle: '含蓄：用停顿和主动性带出来' }, now)
  assert.ok(subtle.includes('此刻心情'))
  assert.ok(subtle.includes('含蓄：用停顿和主动性带出来'), subtle)
  assert.ok(lengthOf(subtle) <= SUBTLE_CONTEXT_BUDGET)
  const calm = defaultsSoul()
  calm.emotion.transient = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.1, cause: '', updatedAt: now }
  assert.equal(renderEmotionContext(calm, { ...CONFIG, expressionStyle: '含蓄：用停顿和主动性带出来' }, now), '')
})

await test('空 / 关闭 / off / none 一律不注入情绪', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.transient = { valence: 0.8, arousal: 0.8, label: '兴奋', intensity: 0.9, cause: '开心', updatedAt: now }
  for (const value of ['', '   ', '关闭：不注入情绪', 'off', 'OFF', 'none']) {
    assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: value }, now), '', JSON.stringify(value))
  }
})

// ---------- 8. episode 数据 / normalize / ring ----------
section('8. episode：normalize 旧文件、字段夹取、过期忽略、ring 60')

await test('旧 soul.json 没有 episodes/nudge：ensureEmotionExtras 补默认空数组/null', () => {
  const old = normalizeSoul({ v: 2, emotion: { transient: { valence: 0.2 } } })
  assert.equal(old.emotion.episodes, undefined, 'soul.js 不管新字段，emotion 层负责补')
  const emotion = ensureEmotionExtras(old.emotion, Date.now())
  assert.deepEqual(emotion.episodes, [])
  assert.equal(emotion.nudge, null)
  assert.deepEqual(emotion.nudgeLog, [])
})

await test('normalizeEmotionEpisodes：坏条丢弃、type 非法变 null、长度/枚举夹取', () => {
  const now = Date.now()
  const emotion = {
    episodes: [
      null,
      { broken: true },
      {
        id: 'keep-me',
        type: 'joy',
        intensity: 9,
        level: 'nope',
        cause: 'c'.repeat(200),
        note: 'n'.repeat(200),
        tendency: 'weird',
        source: 'weird',
        startedAt: now - 1000,
        expiresAt: now + 1000,
      },
      { type: 'not-a-type', intensity: -3, cause: '旧事', startedAt: now },
    ],
  }
  const list = normalizeEmotionEpisodes(emotion, now)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'keep-me')
  assert.equal(list[0].type, 'joy')
  assert.equal(list[0].intensity, 1)
  assert.equal(list[0].level, 'heavy')
  assert.equal(lengthOf(list[0].cause), 80)
  assert.equal(lengthOf(list[0].note), 120)
  assert.equal(list[0].tendency, 'none')
  assert.equal(list[0].source, 'rule')
  assert.equal(list[1].type, null)
  assert.equal(list[1].intensity, 0)
  assert.equal(list[1].level, 'light')
  assert.ok(list.every((item) => EPISODE_TYPES.includes(item.type) || item.type === null))
  assert.ok(list.every((item) => EPISODE_LEVELS.includes(item.level)))
})

await test('episode ring：65 条只留最近 60，丢的是最旧', () => {
  const now = Date.now()
  const emotion = { episodes: [] }
  for (let i = 0; i < 65; i += 1) {
    addEpisode(emotion, {
      type: 'calm', intensity: 0.2, cause: 'c' + i, source: 'tool',
      startedAt: now + i, expiresAt: now + i + HOUR, updatedAt: now + i,
    }, now + i)
  }
  assert.equal(emotion.episodes.length, EPISODE_RING)
  assert.equal(emotion.episodes[0].cause, 'c5')
  assert.equal(emotion.episodes[emotion.episodes.length - 1].cause, 'c64')
})

await test('过期 episode：activeEpisodes 忽略，但条目留在 ring 里直到被裁', () => {
  const now = Date.now()
  const emotion = { episodes: [] }
  addEpisode(emotion, { type: 'sadness', intensity: 0.4, cause: '过期', startedAt: now - HOUR, expiresAt: now - 1 }, now)
  addEpisode(emotion, { type: 'joy', intensity: 0.6, cause: '还在', startedAt: now - 1000, expiresAt: now + HOUR }, now)
  assert.equal(emotion.episodes.length, 2)
  const active = activeEpisodes(emotion, now)
  assert.equal(active.length, 1)
  assert.equal(active[0].cause, '还在')
})

await test('level 阈值：<0.34 轻、<0.67 中、其余重', () => {
  assert.equal(episodeLevel(0), 'light')
  assert.equal(episodeLevel(0.339), 'light')
  assert.equal(episodeLevel(0.34), 'medium')
  assert.equal(episodeLevel(0.669), 'medium')
  assert.equal(episodeLevel(0.67), 'heavy')
  assert.equal(episodeLevel(1), 'heavy')
})

await test('activeEpisodes 排序：强度高的在前，同强度新的在前', () => {
  const now = Date.now()
  const emotion = { episodes: [] }
  addEpisode(emotion, { type: 'joy', intensity: 0.2, cause: '低', startedAt: now - 5000, expiresAt: now + HOUR }, now)
  addEpisode(emotion, { type: 'anger', intensity: 0.8, cause: '高1', startedAt: now - 4000, expiresAt: now + HOUR }, now)
  addEpisode(emotion, { type: 'fear', intensity: 0.8, cause: '高2', startedAt: now - 1000, expiresAt: now + HOUR }, now)
  assert.deepEqual(activeEpisodes(emotion, now).map((item) => item.cause), ['高2', '高1', '低'])
})

// ---------- 9. soul_feel ----------
section('9. soul_feel：参数校验、写入、备份、心境幅度上限、清 nudge')

const feelCtxBundle = makeFakeCtx()
const feelSoul = makeSoulContainer(defaultsSoul())
const feelApi = installEmotion(feelCtxBundle.ctx, {
  state: { readConfig: () => CONFIG },
  soul: feelSoul,
  log: () => {},
})
const feelTool = feelCtxBundle.tools.find((tool) => tool.name === 'soul_feel')

await test('soul_feel 已注册，output 带 schema/render', () => {
  assert.ok(feelTool, 'soul_feel 没注册')
  assert.ok(feelTool.output && feelTool.output.schema && typeof feelTool.output.render === 'function')
  const text = feelTool.output.render({}, { ok: false, reason: 'x' })[0]
  assert.ok(text && text.type === 'text')
})

await test('soul_feel：至少 type 或 note 之一；非法枚举/数值由 schema 拒绝', async () => {
  const empty = await feelTool.execute({})
  assert.equal(empty.ok, false, '空参数在 execute 里被拒绝')
  await assert.rejects(async () => { await feelTool.execute({ type: 'not-a-type', note: '说不上来' }) }, /invalid arguments|must be one of/)
  await assert.rejects(async () => { await feelTool.execute({ note: '说不上来', tendency: 'weird' }) }, /invalid arguments|must be one of/)
  await assert.rejects(async () => { await feelTool.execute({ note: '说不上来', intensity: 'hot' }) }, /invalid arguments|must be/)
  await assert.rejects(async () => { await feelTool.execute({ note: '说不上来', ttlMinutes: 'long' }) }, /invalid arguments|must be/)
})

await test('soul_feel 写 episode（note-only 合法）+ ttl 下限 + saveWithBackup(soul-feel)', async () => {
  const current = feelSoul.get()
  current.emotion.nudge = { tags: ['旧'], reasons: '旧提醒', at: Date.now(), expiresAt: Date.now() + HOUR }
  const result = await feelTool.execute({ note: '有点闷，说不上来', ttlMinutes: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.episode.type, null)
  assert.equal(result.episode.note, '有点闷，说不上来')
  assert.equal(result.episode.level, 'medium')
  assert.equal(result.episode.source, 'tool')
  assert.equal(result.episode.expiresAt - result.episode.startedAt, 30 * 60_000)
  assert.deepEqual(feelSoul.records.backups, ['soul-feel'])
  assert.equal(current.emotion.nudge, null, 'soul_feel 写入后清 nudge')
  assert.ok(feelApi.snapshot().episodes.some((item) => item.note === '有点闷，说不上来'))
})

await test('soul_feel 心境幅度上限：intensity=1 时四维小 delta（受 intensity 限制）', async () => {
  const current = feelSoul.get()
  const before = {
    valence: Number(current.emotion.transient.valence) || 0,
    arousal: Number(current.emotion.transient.arousal) || 0.2,
    affection: Number(current.emotion.affection) || 0.5,
    energy: Number(current.emotion.drive.energy) || 0.7,
  }
  const result = await feelTool.execute({ type: 'anger', intensity: 1, cause: '被否定' })
  assert.equal(result.ok, true)
  assert.equal(result.level, 'heavy')
  assert.ok(Math.abs(current.emotion.transient.valence - before.valence) <= 0.15 + 1e-9)
  assert.ok(Math.abs(current.emotion.transient.arousal - before.arousal) <= 0.15 + 1e-9)
  assert.ok(Math.abs(current.emotion.affection - before.affection) <= 0.05 + 1e-9)
  assert.ok(Math.abs(current.emotion.drive.energy - before.energy) <= 0.06 + 1e-9)
})

await test('soul_feel ttl 上限 1440 分钟；备份失败仍 ok 且继续 saveSoon', async () => {
  const maxTtl = await feelTool.execute({ type: 'calm', ttlMinutes: 99999 })
  assert.equal(maxTtl.ok, true)
  assert.equal(maxTtl.episode.expiresAt - maxTtl.episode.startedAt, 1440 * 60_000)

  const failCtxBundle = makeFakeCtx()
  const failSoul = makeSoulContainer(defaultsSoul(), { backupThrows: true })
  installEmotion(failCtxBundle.ctx, { state: { readConfig: () => CONFIG }, soul: failSoul, log: () => {} })
  const failTool = failCtxBundle.tools.find((tool) => tool.name === 'soul_feel')
  const result = await failTool.execute({ note: '说不上来' })
  assert.equal(result.ok, true, '备份失败只 warn，不阻止写入')
  assert.deepEqual(failSoul.records.backups, ['soul-feel'])
  assert.ok(failSoul.records.saveSoon >= 1, '备份失败后仍然 saveSoon')
})

// ---------- 10. 规则 episode / nudge ----------
section('10. 显著性：规则 episode 冷却、nudge 触发/冷却/每日上限/清除')

await test('规则强度够 → source=rule episode；2 小时内不重复形成', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  ensureEmotionExtras(soul.emotion, now)
  const appraisal = ruleAppraise('对不起，是我不好，我错了')
  const first = maybeRuleEpisode(soul, appraisal, CONFIG, now)
  assert.ok(first)
  assert.equal(first.source, 'rule')
  assert.equal(first.type, 'sadness')
  assert.equal(maybeRuleEpisode(soul, appraisal, CONFIG, now + 60_000), null)
  assert.ok(maybeRuleEpisode(soul, appraisal, CONFIG, now + RULE_EPISODE_COOLDOWN_MS + 1))
})

await test('形成同类 episode 后清掉 nudge；普通寒暄/夸奖不触发 nudge', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  ensureEmotionExtras(soul.emotion, now)
  soul.emotion.nudge = { tags: ['摩擦', '对不起'], reasons: '像是有摩擦', at: now, expiresAt: now + HOUR }
  const episode = maybeRuleEpisode(soul, ruleAppraise('对不起，我错了'), CONFIG, now)
  assert.ok(episode)
  assert.equal(soul.emotion.nudge, null)

  const quiet = defaultsSoul()
  ensureEmotionExtras(quiet.emotion, now)
  assert.equal(maybeNudge(quiet, ruleAppraise('你好厉害'), now), null)
  assert.equal(maybeNudge(quiet, ruleAppraise('嗯'), now), null)
  assert.equal(maybeNudge(quiet, ruleAppraise('今天下午开了个会'), now), null)
})

await test('nudge：低强度命中类别时触发，2 小时冷却、每天最多 3 条', () => {
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const now = noon.getTime()
  const soul = defaultsSoul()
  ensureEmotionExtras(soul.emotion, now)
  const appraisal = ruleAppraise('上次那件事我还记得，有点难过')
  assert.ok(appraisal.salience >= NUDGE_MIN_SALIENCE)
  assert.ok(appraisal.salience < RULE_EPISODE_MIN_SALIENCE)
  const first = maybeNudge(soul, appraisal, now)
  assert.ok(first)
  assert.ok(first.tags.includes('对方难过'))
  assert.equal(first.expiresAt - first.at, NUDGE_COOLDOWN_MS)
  assert.equal(maybeNudge(soul, appraisal, now + HOUR), null, '2 小时内不再提醒')
  const second = maybeNudge(soul, appraisal, now + NUDGE_COOLDOWN_MS + 1)
  assert.ok(second)
  const third = maybeNudge(soul, appraisal, now + NUDGE_COOLDOWN_MS * 2 + 2)
  assert.ok(third)
  assert.equal(maybeNudge(soul, appraisal, now + NUDGE_COOLDOWN_MS * 3 + 3), null, '当天第 4 条被日上限挡住')
  assert.ok(NUDGE_DAILY_MAX === 3)
})

await test('onUserMessage 接入规则：低强度命中写入 nudge，clearNudge 清掉', () => {
  const now = Date.now()
  const bundle = makeFakeCtx()
  const soul = makeSoulContainer(defaultsSoul())
  const api = installEmotion(bundle.ctx, { state: { readConfig: () => CONFIG }, soul, log: () => {} })
  api.onUserMessage({ text: '上次那件事我还记得，有点难过', at: now })
  const nudge = activeNudge(soul.get().emotion, now)
  assert.ok(nudge, 'onUserMessage 应留下 nudge')
  assert.ok(nudge.tags.includes('对方难过'))
  assert.equal(api.clearNudge(), true)
  assert.equal(activeNudge(soul.get().emotion, now), null)
  api.onUserMessage({ text: '我们分手吧', at: now + 1 })
  assert.ok(soul.get().emotion.episodes.some((episode) => episode.source === 'rule'), '高强度 + 类别命中应形成 rule episode')
})

await test('nudge 过期忽略、可清除；activeNudge/clearNudge 行为正确', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  ensureEmotionExtras(soul.emotion, now)
  maybeNudge(soul, ruleAppraise('上次那件事'), now)
  const nudge = activeNudge(soul.emotion, now)
  assert.ok(nudge)
  assert.equal(activeNudge(soul.emotion, nudge.expiresAt + 1), null, '过期后忽略')
  assert.equal(clearNudge(soul.emotion), true)
  assert.equal(soul.emotion.nudge, null)
  assert.equal(clearNudge(soul.emotion), false)
  assert.deepEqual(normalizeEmotionNudge({ nudge: { tags: 'bad', reasons: '' } }, now), null)
})

await test('emotion-api：POST clearNudge 可用，cross-site 被 fence 拒绝', async () => {
  let registration = null
  const ctx = {
    on() {},
    systemPrompt: { context() {} },
    effect(fn) { fn(); return () => {} },
    get(name) {
      if (name === 'webServer') return { register(route) { registration = route; return () => {} } }
      return undefined
    },
    tools: { register() {} },
  }
  const state = defaultsSoul()
  const now = Date.now()
  state.emotion.nudge = { tags: ['旧事'], reasons: '想起旧事', at: now, expiresAt: now + HOUR }
  const soul = makeSoulContainer(state)
  installEmotion(ctx, { state: { readConfig: () => CONFIG }, soul, log: () => {} })
  assert.ok(registration && registration.path === '/dsh-aura/emotion-api')

  const call = (headers, body) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/dsh-aura/emotion-api'
    req.headers = headers
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(payload) { this.body = String(payload); resolve(res) },
    }
    registration.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })

  const ok = await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, { action: 'clearNudge' })
  assert.equal(ok.status, 200)
  const parsed = JSON.parse(ok.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cleared, true)
  assert.equal(state.emotion.nudge, null)

  state.emotion.nudge = { tags: ['旧事'], reasons: '再次提醒', at: now, expiresAt: now + HOUR }
  const blocked = await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, { action: 'clearNudge' })
  assert.equal(blocked.status, 403)
  assert.ok(state.emotion.nudge, 'fence 拒绝时不要改动状态')
})

// ---------- 11. 注入文案 ----------
section('11. 注入：episode 自然语言、note/倾向优先、无数字、预算内')

await test('describeEpisode：note 原文优先、倾向映射、不出现数字/英文枚举', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  addEpisode(soul.emotion, {
    type: null, intensity: 0.5, level: 'medium', cause: '忘了答应她的事',
    note: '有点闷，说不上来', tendency: 'repair', source: 'tool',
    startedAt: now, expiresAt: now + HOUR, updatedAt: now,
  }, now)
  const episode = activeEpisodes(soul.emotion, now)[0]
  const text = describeEpisode(episode)
  assert.ok(text.includes('有点闷，说不上来'), '有 note 时优先用 note 原文')
  assert.ok(text.includes('想补一句'), 'repair → 想补一句')
  assert.ok(!/[0-9]/.test(text), '不写数字：' + text)
  assert.ok(!/sadness|anger|repair|approach|withdraw|quiet|share|none/.test(text), '不写英文枚举：' + text)
})

await test('renderEmotionContext explicit：追加 episode，保留四维/尾部指令/预算', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.transient = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.1, cause: '', updatedAt: now }
  addEpisode(soul.emotion, {
    type: 'sadness', intensity: 0.5, level: 'medium', cause: '忘了答应她的事',
    note: '有点闷，说不上来', tendency: 'repair', source: 'tool',
    startedAt: now, expiresAt: now + HOUR, updatedAt: now,
  }, now)
  const text = renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'explicit' }, now)
  assert.ok(text.startsWith('[情绪]'))
  assert.ok(text.includes('愉悦=') && text.includes('亲近='), '四维还在')
  assert.ok(text.includes('有点闷，说不上来') && text.includes('想补一句'))
  assert.ok(text.endsWith('"我的情绪"。'), '尾部指令不被 episode 挤掉')
  assert.ok(lengthOf(text) <= EMOTION_CONTEXT_BUDGET, '长度 ' + lengthOf(text))
})

await test('renderEmotionContext subtle：平静但有 episode 也注入；nudge 很轻且不命令', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.transient = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.1, cause: '', updatedAt: now }
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'subtle' }, now), '', '没 episode/nudge 仍为空')
  addEpisode(soul.emotion, {
    type: 'sadness', intensity: 0.5, level: 'medium', cause: '忘了答应她的事',
    note: '有点闷，说不上来', tendency: 'quiet', source: 'tool',
    startedAt: now, expiresAt: now + HOUR, updatedAt: now,
  }, now)
  const subtle = renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'subtle' }, now)
  assert.ok(subtle.includes('此刻心情') && subtle.includes('有点闷，说不上来'))
  assert.ok(subtle.includes('想安静'))
  assert.ok(lengthOf(subtle) <= SUBTLE_CONTEXT_BUDGET)

  soul.emotion.nudge = {
    tags: ['被否定'], reasons: '那句像在否定她；如果她很在意你的看法，可能会被扎到。',
    at: now, expiresAt: now + NUDGE_COOLDOWN_MS,
  }
  const withNudge = renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'subtle' }, now)
  assert.ok(withNudge.includes('刚才那句可能有点落在你身上'))
  assert.ok(withNudge.includes('要不要留一句，你自己定'))
  assert.ok(!/[0-9]/.test(describeNudge(soul.emotion.nudge)), 'nudge 文案不出现数字')
  assert.ok(!/必须|应该|你要/.test(describeNudge(soul.emotion.nudge)), 'nudge 不命令')
})

await test('episode/nudge 过期后注入自动消失', () => {
  const now = Date.now()
  const soul = defaultsSoul()
  soul.emotion.transient = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.1, cause: '', updatedAt: now }
  addEpisode(soul.emotion, {
    type: 'joy', intensity: 0.5, cause: '过期', startedAt: now - HOUR, expiresAt: now - 1,
  }, now)
  soul.emotion.nudge = { tags: ['旧事'], reasons: '过期提醒', at: now - HOUR, expiresAt: now - 1 }
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'subtle' }, now), '')
  assert.equal(renderEmotionContext(soul, { ...CONFIG, expressionStyle: 'explicit' }, now).includes('过期'), false)
})

await test('episodeHintOf：扎到/承诺/难过/旧事/新鲜/亲近/摩擦都能识别', () => {
  assert.equal(episodeHintOf('你根本不懂').key, 'hurt')
  assert.equal(episodeHintOf('你答应我的').key, 'promise')
  assert.equal(episodeHintOf('我今天好难过').key, 'sad')
  assert.equal(episodeHintOf('还记得上次吗').key, 'old')
  assert.equal(episodeHintOf('这个好好玩').key, 'fresh')
  assert.equal(episodeHintOf('好想你').key, 'close')
  assert.equal(episodeHintOf('对不起').key, 'conflict')
  assert.equal(episodeHintOf('今天天气不错'), null)
})

// ---------- 12. episode 历史 / state 视图 / complex ----------
section('12. episode 历史：排序/过期/limit；state 只读字段；soul_feel complex')

await test('episodeHistory：startedAt 倒序、含过期、limit 夹到 1..30', () => {
  const now = Date.now()
  const emotion = { episodes: [] }
  for (let i = 0; i < 35; i += 1) {
    addEpisode(emotion, {
      type: 'calm', intensity: 0.2, cause: 'e' + i, source: 'tool',
      startedAt: now - (35 - i) * 60_000, expiresAt: now + HOUR,
    }, now)
  }
  const all = episodeHistory(emotion, 999, now)
  assert.equal(all.length, EPISODE_HISTORY_LIMIT, '最多 30 条')
  assert.equal(all[0].cause, 'e34', '最新的在最前')
  assert.equal(all[EPISODE_HISTORY_LIMIT - 1].cause, 'e5')
  assert.ok(all.every((row) => row.expired === false))
  assert.ok(all.every((row, i) => i === 0 || all[i - 1].startedAt > row.startedAt), '按 startedAt 倒序')

  assert.deepEqual(episodeHistory(emotion, 2, now).map((row) => row.cause), ['e34', 'e33'])
  assert.equal(episodeHistory(emotion, 0, now).length, 1, 'limit 下限 1')
  assert.equal(episodeHistory(emotion, EPISODE_HISTORY_LIMIT + 5, now).length, EPISODE_HISTORY_LIMIT, 'limit 上限 30')

  const expiredEmotion = { episodes: [] }
  addEpisode(expiredEmotion, {
    type: 'joy', note: '已经过期的那条', startedAt: now - 2 * HOUR, expiresAt: now - HOUR,
  }, now)
  addEpisode(expiredEmotion, {
    type: 'calm', note: '还在的一条', startedAt: now - 60_000, expiresAt: now + HOUR,
  }, now)
  const withExpired = episodeHistory(expiredEmotion, 30, now)
  assert.equal(withExpired.length, 2)
  assert.equal(withExpired[0].note, '还在的一条')
  assert.equal(withExpired[0].expired, false)
  assert.equal(withExpired[1].note, '已经过期的那条', '过期条目仍留在历史里')
  assert.equal(withExpired[1].expired, true, '过期标记')
  const fields = ['id', 'type', 'level', 'intensity', 'cause', 'note', 'tendency', 'source', 'startedAt', 'expiresAt', 'expired', 'complex']
  assert.ok(fields.every((key) => key in withExpired[0]), '历史字段齐全')
})

await test('episode complex：normalize 20 字上限、缺省空串、快照保留', () => {
  const now = Date.now()
  const emotion = {
    episodes: [
      { type: 'sadness', note: '说不上来', complex: '怀旧', startedAt: now, expiresAt: now + HOUR },
      { type: 'sadness', note: '说不上来', complex: '怀'.repeat(30), startedAt: now + 1, expiresAt: now + 1 + HOUR },
      { type: 'calm', note: '没事', startedAt: now + 2, expiresAt: now + 2 + HOUR },
    ],
  }
  const list = normalizeEmotionEpisodes(emotion, now)
  assert.equal(list.length, 3)
  assert.equal(list[0].complex, '怀旧')
  assert.equal(lengthOf(list[1].complex), EPISODE_COMPLEX_MAX, '超过 20 字被截断')
  assert.equal(list[2].complex, '', '没有 complex 时为空串')
  const snap = episodeSnapshot(list[0], now)
  assert.equal(snap.complex, '怀旧')
  assert.equal(snap.expired, false)
  assert.equal(episodeSnapshot({ ...list[0], expiresAt: now - 1 }, now).expired, true)
})

await test('soul_feel：type 可缺失（只写 note）；complex 独立字段、不冒充基本情绪', async () => {
  const bundle = makeFakeCtx()
  const soul = makeSoulContainer(defaultsSoul())
  const api = installEmotion(bundle.ctx, { state: { readConfig: () => CONFIG }, soul, log: () => {} })
  const tool = bundle.tools.find((item) => item.name === 'soul_feel')
  assert.ok(tool)
  assert.equal(tool.parameters.properties.complex.type, 'string', 'schema 暴露 complex')
  assert.equal(tool.parameters.properties.type.enum.length, EPISODE_TYPES.length)

  const noteOnly = await tool.execute({ note: '有点闷，说不上来' })
  assert.equal(noteOnly.ok, true)
  assert.equal(noteOnly.episode.type, null, 'type 缺失不拒绝')
  assert.equal(noteOnly.episode.level, 'medium')
  assert.equal(noteOnly.episode.complex, '')

  const named = await tool.execute({ note: '想起小时候', complex: '怀旧', tendency: 'quiet' })
  assert.equal(named.ok, true)
  assert.equal(named.episode.complex, '怀旧')
  assert.equal(named.episode.note, '想起小时候')
  assert.equal(named.episode.tendency, 'quiet')
  assert.equal(named.episode.type, null, 'complex 不冒充基本情绪')
  assert.deepEqual(Object.keys(named.episode).sort(), [
    'cause', 'complex', 'expired', 'expiresAt', 'id', 'intensity', 'level', 'note',
    'source', 'startedAt', 'tendency', 'type', 'updatedAt',
  ])

  const longName = await tool.execute({ complex: '内'.repeat(50) })
  assert.equal(longName.ok, true)
  assert.equal(lengthOf(longName.episode.complex), EPISODE_COMPLEX_MAX, 'complex 截到 20 字')
  assert.equal(longName.episode.note, '', '只有 complex 也能写')

  assert.equal((await tool.execute({})).ok, false, 'type/note/complex 全空仍拒绝')
  const stored = soul.get().emotion.episodes
  assert.ok(stored.some((row) => row.complex === '怀旧'))
  assert.ok(api.episodeHistory(1).some((row) => row.complex === '内'.repeat(20)))
  assert.equal(api.episodeHistoryCount(), stored.length)
  assert.equal(api.episodeHistory(99).length, Math.min(stored.length, EPISODE_HISTORY_LIMIT))
})

await test('emotion-api：GET history（limit/倒序/过期/fence）+ state 新字段不破坏旧字段', async () => {
  let registration = null
  const ctx = {
    on() {},
    systemPrompt: { context() {} },
    effect(fn) { fn(); return () => {} },
    get(name) {
      if (name === 'webServer') return { register(route) { registration = route; return () => {} } }
      return undefined
    },
    tools: { register() {} },
  }
  const state = defaultsSoul()
  const now = Date.now()
  for (let i = 0; i < 8; i += 1) {
    addEpisode(state.emotion, {
      type: 'calm', intensity: 0.3, cause: 'h' + i, note: '', source: 'tool',
      startedAt: now - (8 - i) * 60_000, expiresAt: now + HOUR,
    }, now)
  }
  addEpisode(state.emotion, {
    type: 'joy', cause: 'old', note: '过期', startedAt: now - 3 * HOUR, expiresAt: now - HOUR,
  }, now)
  const soul = makeSoulContainer(state)
  installEmotion(ctx, { state: { readConfig: () => CONFIG }, soul, log: () => {} })
  assert.ok(registration && registration.path === '/dsh-aura/emotion-api')

  const get = (url, headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = url
    req.headers = headers
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(payload) { this.body = String(payload); resolve(res) },
    }
    registration.handler(req, res)
  })

  const limited = await get('/dsh-aura/emotion-api?action=history&limit=3')
  assert.equal(limited.status, 200)
  const limitedBody = JSON.parse(limited.body)
  assert.equal(limitedBody.ok, true)
  assert.equal(limitedBody.count, 3)
  assert.deepEqual(limitedBody.episodes.map((row) => row.cause), ['h7', 'h6', 'h5'])
  assert.equal(limitedBody.historyCount, 9, 'historyCount 含过期')
  assert.ok(limitedBody.episodes.every((row) => row.expired === false))

  const all = JSON.parse((await get('/dsh-aura/emotion-api?action=history&limit=99')).body)
  assert.equal(all.episodes.length, 9, '上限 30 内返回全部 9 条')
  assert.equal(all.episodes[all.episodes.length - 1].cause, 'old')
  assert.equal(all.episodes[all.episodes.length - 1].expired, true, '历史包含过期条目')

  const stateRes = await get('/dsh-aura/emotion-api?action=state')
  assert.equal(stateRes.status, 200)
  const stateBody = JSON.parse(stateRes.body)
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.emotion.episodes.length, EMOTION_STATE_EPISODES, 'active 最近 5 条')
  assert.deepEqual(stateBody.emotion.episodes.map((row) => row.cause), ['h7', 'h6', 'h5', 'h4', 'h3'])
  assert.equal(stateBody.emotion.episodeCount, 8, 'episodeCount 仍是 active 总数')
  assert.equal(stateBody.emotion.historyCount, 9, 'historyCount 含过期')
  for (const key of ['label', 'valence', 'arousal', 'affection', 'energy', 'mood', 'baseline', 'trend', 'history', 'lastChange', 'nudge']) {
    assert.ok(key in stateBody.emotion, '旧字段 ' + key + ' 还在')
  }

  const legacy = await get('/dsh-aura/emotion-api')
  assert.equal(legacy.status, 200)
  assert.equal(typeof JSON.parse(legacy.body).emotion, 'object', '不带 action 仍是旧 state 行为')
  assert.equal((await get('/dsh-aura/emotion-api?action=nope')).status, 400)
  assert.equal((await get('/dsh-aura/emotion-api?action=history&limit=0')).status, 400)
  assert.equal((await get('/dsh-aura/emotion-api?action=history&limit=abc')).status, 400)
  const blocked = await get('/dsh-aura/emotion-api?action=history', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
  assert.equal(blocked.status, 403, 'history 也走同一 fence')
})

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
