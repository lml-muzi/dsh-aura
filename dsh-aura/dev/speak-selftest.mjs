/**
 * Aura 主动搭话引擎离线自测：不连 DSH、不联网、不发任何真实消息。
 *
 * 覆盖（对应设计 E.8「纯函数单测」+「假宿主冒烟」）：
 * - 掷骰：命中线公式乘法顺序（先乘因子再加加成）、clamp、due/ritual 固定线、miss 加成封顶；
 * - 时段基线边界、静默时段（跨午夜/相等不启用）、关系阶段倍率、时机远近、未回复惩罚；
 * - 冲动加成/情绪不适、冲动检测阈值；
 * - 反重复：bigram Jaccard、话题闸、禁句表；
 * - 触发源优先级（impulse > due > ritual > return > idle）；
 * - 门控：开关/在线/静默/暂停/收尾抑制/冷却/日上限/被动窗口/未回复暂停/平台拒绝/agent 忙/群白名单/归档；
 * - 干跑：命中只记账不发送、不计日上限、仍清零 missStreak；未中计 missStreak；
 * - 投递：followup 消息形状（user 角色 + source.kind）、prompt context order 60、出站回执；
 * - schedule 冷会话兜底（反框架 prompt、title、去重、失败降级）；
 * - 失败降级：followup reject 重试 1 次→今日停该会话；平台拒绝回滚日计数、pendingThought、≥2 暂停；<skip> 回滚不计拒绝；
 * - 手动：dry 不发送、real 发送但不动计数器、静默时段也能手动演练；
 * - 入站：未回复清零、暂停正则、冲动检测、lastProactiveAnswered。
 *
 * 运行：node dev/speak-selftest.mjs   （可重复执行；退出码 0 = 全通过）
 */
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLife } from '../host/life.js'
import {
  installSpeak,
  inQuietHours,
  daypartOf,
  pickBaseLine,
  stageFactor,
  timingFactor,
  unansweredFactor,
  computeHitLine,
  formatFormula,
  impulseBonus,
  emotionUnsuitable,
  detectImpulse,
  noteKey,
  jaccard,
  tooSimilar,
  forbiddenText,
  inRitualWindow,
  collectRecentTopics,
  pickRecallCandidate,
  actWeights,
  pickAct,
  buildIntentBody,
  buildFollowupText,
  buildSchedulePrompt,
  buildFollowupMessage,
  isSkipText,
  normalizeEmotion,
  localDayKey,
  parseAllowlist,
  evaluateDice,
  emotionImpulseDetail,
  socialNeedOf,
  estimateSocialNeed,
  normalizeDiceTrigger,
  emotionShareFactor,
  shareStrengthFactor,
  withinRecentInteraction,
} from '../host/speak.js'

let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
    return
  }
  failures.push({ name, detail })
  const suffix = detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`  FAIL ${name}${suffix}`)
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

function section(title) {
  console.log(`\n[${title}]`)
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

let rand = 0
const random = () => rand

class Clock {
  constructor(ms) { this.ms = ms }
  now() { return new Date(this.ms) }
  advance(ms) { this.ms += ms; return this }
  set(ms) { this.ms = ms; return this }
}

const TZ_OFFSET = '+08:00'
function atLocal(hhmm, day = '2026-10-25') {
  return new Date(`${day}T${hhmm}:00${TZ_OFFSET}`)
}

function defaultSpeakState() {
  return {
    lastAt: 0,
    lastAct: '',
    lastTopic: '',
    dayKey: '',
    todayCount: 0,
    missStreak: 0,
    unanswered: 0,
    platformRejects: 0,
    suppressUntil: 0,
    pausedUntil: 0,
    recentTexts: [],
    log: [],
    perChat: {},
    lastRollAt: 0,
    lastUserAt: 0,
    lastUserAnsweredAt: 0,
    lastProactiveAt: 0,
    lastProactiveSessionId: '',
    lastProactiveAnswered: true,
    emotionBaseline: null,
    pendingImpulse: null,
    pendingThought: null,
    ritual: { dayKey: '', morning: false, evening: false },
    dueDayKey: '',
    impulseDayKey: '',
    returnFiredFor: 0,
    scheduleDisabledDayKey: '',
    stickerDayKey: '',
    todaySticker: 0,
    lastStickerAt: 0,
  }
}

function defaultSoulData() {
  return {
    v: 2,
    identity: { name: 'Aura' },
    relation: { stage: 'familiar', score: 15, lastUserAt: 0 },
    emotion: {
      transient: { valence: 0, arousal: 0.2, label: '平静' },
      mood: { valence: 0, arousal: 0.2 },
      drive: { energy: 0.6 },
      affection: 0.5,
    },
    memory: { events: [], notes: { user: [], us: [], self: [] }, topics: {}, pendingDue: [] },
    speak: defaultSpeakState(),
    explainLog: [],
  }
}

function makeAgent(options = {}) {
  const agent = {
    status: options.status || 'idle',
    calls: 0,
    sent: [],
    failTimes: options.failTimes || 0,
    failError: options.failError,
    async followup(message) {
      agent.calls += 1
      if (agent.calls <= agent.failTimes) throw agent.failError || new Error('followup boom')
      agent.sent.push(message)
    },
  }
  return agent
}

function createHarness(options = {}) {
  const clock = options.clock || new Clock(atLocal('20:00').getTime())
  const bindings = (options.bindings || [{
    sessionId: 'qq:dm:1:u1',
    kind: 'dm',
    chatId: 'u1',
    lastActiveAt: clock.ms - 60 * 60 * 1000,
  }]).map(item => ({ ...item }))
  const agents = options.agents || {
    'qq:dm:1:u1': makeAgent(options.agentOptions),
  }
  const soulData = options.soulData || defaultSoulData()
  if (!options.soulData) {
    soulData.speak.lastRollAt = clock.ms - 31 * 60 * 1000
    soulData.relation.lastUserAt = clock.ms - 60 * 60 * 1000
  }
  const config = {
    quietStart: '23:30',
    quietEnd: '07:30',
    speakEnabled: true,
    speakDryRun: false,
    speakIntervalMinutes: 30,
    speakCooldownMinutes: 45,
    speakDailyCap: 3,
    ...(options.config || {}),
  }
  const schedule = options.schedule || {
    created: [],
    async create(sessionId, task) {
      this.created.push({ sessionId, ...task })
      return { id: 'schedule-1', ...task }
    },
    async list() { return [] },
  }
  const sessionRecords = {}
  for (const binding of bindings) {
    sessionRecords[`${binding.kind}:${binding.chatId}`] = {
      sessionId: binding.sessionId,
      kind: binding.kind,
      chatId: binding.chatId,
      updatedAt: new Date(clock.ms).toISOString(),
    }
  }
  const state = {
    readConfig: () => ({ ...config }),
    writeJson: () => {},
    readSessions: () => ({ ...sessionRecords }),
  }
  const emotionState = {
    valence: 0,
    arousal: 0.2,
    label: '平静',
    affection: 0.5,
    drive: { energy: 0.6 },
  }
  const hooks = { inbound: [], outbound: [] }
  const effects = []
  const contextEntries = []
  const bridge = {
    online: options.online !== false,
    passive: new Set(options.passive || []),
    proactiveMarks: new Map(),
    markProactive(sessionId, info = {}) { this.proactiveMarks.set(String(sessionId), { ...info, at: clock.ms }) },
    takeProactive(sessionId) { const value = this.proactiveMarks.get(String(sessionId)); this.proactiveMarks.delete(String(sessionId)); return value },
    isOnline() { return this.online },
    addInboundHook(fn) { hooks.inbound.push(fn); return () => { const index = hooks.inbound.indexOf(fn); if (index >= 0) hooks.inbound.splice(index, 1) } },
    addOutboundHook(fn) { hooks.outbound.push(fn); return () => { const index = hooks.outbound.indexOf(fn); if (index >= 0) hooks.outbound.splice(index, 1) } },
    passiveWindowActive(key) { return this.passive.has(key) },
    bindings() { return bindings.map(item => ({ ...item })) },
    findLiveAgent(sessionId) { return agents[sessionId] },
    chatOfSession(sessionId) {
      const found = bindings.find(item => item.sessionId === sessionId)
      return found ? { kind: found.kind, chatId: found.chatId, key: `${found.kind}:${found.chatId}`, sessionId } : undefined
    },
    touchRecord() {},
    emitInbound(event) { for (const fn of [...hooks.inbound]) fn(event) },
    emitOutbound(...args) { for (const fn of [...hooks.outbound]) fn(...args) },
  }
  const webRoutes = []
  const registeredTools = []
  const webServer = {
    register(registration) {
      webRoutes.push(registration)
      return () => { const index = webRoutes.indexOf(registration); if (index >= 0) webRoutes.splice(index, 1) }
    },
  }
  const tools = {
    register(tool) {
      registeredTools.push(tool)
      return () => { const index = registeredTools.indexOf(tool); if (index >= 0) registeredTools.splice(index, 1) }
    },
  }
  const ctx = {
    systemPrompt: { context(entry) { contextEntries.push(entry) } },
    get(name) {
      if (name === 'schedule') return schedule
      if (name === 'workspaceRegistry') return { list: () => [], archivedSessionIds: options.archived || [] }
      if (name === 'agents') return { get: sessionId => agents[sessionId] }
      if (name === 'webServer') return webServer
      if (name === 'tools') return tools
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
  }
  let soul
  if (options.variant === 'real') {
    const listeners = {}
    soul = {
      data: soulData,
      saves: 0,
      explains: [],
      listeners,
      get: () => soulData,
      saveSoon() { soul.saves += 1 },
      saveNow() { soul.saves += 1 },
      explain(entry) { soul.explains.push(entry) },
      on(kind, fn) { listeners[kind] = fn; return () => { delete listeners[kind] } },
      emit(kind, payload) { const fn = listeners[kind]; if (fn) fn(payload) },
    }
  } else {
    soul = {
      data: soulData,
      saves: 0,
      explains: [],
      save() { this.saves += 1 },
      recordExplain(entry) { this.explains.push(entry) },
    }
  }
  const memory = options.memory || {
    recentTopics: () => [],
    pendingDue: () => [],
  }
  const emotion = options.variant === 'real'
    ? {
        decayed: () => ({
          transient: { valence: emotionState.valence, arousal: emotionState.arousal, label: emotionState.label, intensity: Math.abs(emotionState.valence) },
          mood: { valence: 0, arousal: 0.2 },
          drive: { energy: emotionState.drive.energy, socialNeed: 0.35 },
          affection: emotionState.affection,
        }),
      }
    : { snapshot: () => ({ ...emotionState, drive: { ...emotionState.drive } }) }
  const logLines = []
  const harness = {
    clock,
    config: () => config,
    setConfig(patch) { Object.assign(config, patch) },
    bindings,
    agents,
    state,
    soul,
    soulData,
    emotionState,
    emotion,
    memory,
    schedule,
    bridge,
    ctx,
    hooks,
    contextEntries,
    logLines,
    effects,
    webRoutes,
    webServer,
    registeredTools,
    tools,
    dispose() {
      for (const disposer of effects.splice(0)) { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
    },
    install(extra = {}) {
      return installSpeak(ctx, {
        state,
        soul,
        emotion,
        memory,
        bridge,
        log: (...parts) => logLines.push(parts.join(' ')),
        random,
        now: () => clock.now(),
        retryDelayMs: 1,
        ...extra,
      })
    },
  }
  return harness
}

const mainBinding = { sessionId: 'qq:dm:1:u1', kind: 'dm', chatId: 'u1' }

async function withHarness(options, run) {
  const harness = createHarness(options)
  const speak = harness.install(options.installOptions || {})
  try {
    return await run({ harness, speak })
  } finally {
    speak.stop()
    harness.dispose()
  }
}

// ---------------------------------------------------------------------------
section('静默时段（跨午夜 / 起止相等不启用 / 非法值）')
// ---------------------------------------------------------------------------
{
  const quiet = { quietStart: '23:30', quietEnd: '07:30' }
  eq('23:59 静默', inQuietHours(quiet, atLocal('23:59')), true)
  eq('02:00 静默（跨午夜）', inQuietHours(quiet, atLocal('02:00')), true)
  eq('07:29 静默', inQuietHours(quiet, atLocal('07:29')), true)
  eq('07:30 不再静默', inQuietHours(quiet, atLocal('07:30')), false)
  eq('12:00 不静默', inQuietHours(quiet, atLocal('12:00')), false)
  eq('23:29 不静默', inQuietHours(quiet, atLocal('23:29')), false)
  eq('起===止视为不启用', inQuietHours({ quietStart: '22:00', quietEnd: '22:00' }, atLocal('22:00')), false)
  eq('非法时间回退不启用', inQuietHours({ quietStart: 'bad', quietEnd: '07:30' }, atLocal('02:00')), false)
}

// ---------------------------------------------------------------------------
section('时段基线边界')
// ---------------------------------------------------------------------------
{
  const config = { baseLines: { morning: 30, work: 12, noon: 25, evening: 45, night: 30 } }
  eq('07:30 morning', daypartOf(atLocal('07:30')), 'morning')
  eq('07:30 基线 30', pickBaseLine(config, atLocal('07:30')), 30)
  eq('09:29 morning', daypartOf(atLocal('09:29')), 'morning')
  eq('09:30 work', daypartOf(atLocal('09:30')), 'work')
  eq('09:30 基线 12', pickBaseLine(config, atLocal('09:30')), 12)
  eq('12:00 noon 25', pickBaseLine(config, atLocal('12:00')), 25)
  eq('14:00 work 12', pickBaseLine(config, atLocal('14:00')), 12)
  eq('18:00 evening 45', pickBaseLine(config, atLocal('18:00')), 45)
  eq('22:00 night 30', pickBaseLine(config, atLocal('22:00')), 30)
  eq('23:30 quiet 0', pickBaseLine(config, atLocal('23:30')), 0)
  eq('凌晨 quiet 0', pickBaseLine(config, atLocal('02:00')), 0)
  eq('配置可覆盖时段基线', pickBaseLine({ baseLines: { evening: 10 } }, atLocal('20:00')), 10)
}

// ---------------------------------------------------------------------------
section('关系阶段倍率 / 时机因子 / 未回复惩罚')
// ---------------------------------------------------------------------------
{
  const defaults = { stageFactors: { stranger: 0.5, familiar: 1.0, close: 1.4, intimate: 1.6 } }
  eq('stranger 0.5', stageFactor('stranger', defaults), 0.5)
  eq('familiar 1.0', stageFactor('familiar', defaults), 1)
  eq('close 1.4', stageFactor('close', defaults), 1.4)
  eq('intimate 1.6', stageFactor('intimate', defaults), 1.6)
  eq('未知阶段按 stranger', stageFactor('nobody', defaults), 0.5)
  eq('配置可覆盖阶段倍率', stageFactor('familiar', { stageFactors: { familiar: 2 } }), 2)

  const timing = { nearMinutes: 20, nearFactor: 0.15, farMinutes: 360, farFactor: 1.5 }
  eq('19 分钟 → near 0.15', timingFactor(19, timing), 0.15)
  eq('20 分钟 → 1', timingFactor(20, timing), 1)
  eq('360 分钟 → 1', timingFactor(360, timing), 1)
  eq('361 分钟 → far 1.5', timingFactor(361, timing), 1.5)
  eq('从未聊过（Infinity）→ far', timingFactor(Infinity, timing), 1.5)

  eq('0 次未回复 ×1', unansweredFactor(0), 1)
  eq('1 次未回复 ×0.5', unansweredFactor(1), 0.5)
  eq('2 次未回复 ×0.2', unansweredFactor(2), 0.2)
  eq('3 次未回复 ×0.2（门控会暂停）', unansweredFactor(3), 0.2)
}

// ---------------------------------------------------------------------------
section('掷骰命中线公式')
// ---------------------------------------------------------------------------
{
  // 先乘因子再加加成：10 × 0.5 × 1 × 1 × 1.5 = 7.5，再加 miss 加成封顶 40 → 47.5
  eq('先乘因子再加加成', computeHitLine({
    baseLine: 10, stage: 0.5, timing: 1, unanswered: 1,
    triggerFactor: 1.5, impulse: 0, missStreak: 4, missBonus: 10, bonusCap: 40,
  }), 47.5)
  eq('due/ritual 固定命中线 70', computeHitLine({ overrideLine: 70, baseLine: 999 }), 70)
  eq('ritual 固定命中线 55', computeHitLine({ overrideLine: 55 }), 55)
  eq('冲动加成参与加法且封顶', computeHitLine({
    baseLine: 0, impulse: 30, missStreak: 0, missBonus: 10, bonusCap: 40,
  }), 30)
  eq('没中加成封顶 40', computeHitLine({
    baseLine: 0, impulse: 0, missStreak: 9, missBonus: 10, bonusCap: 40,
  }), 40)
  eq('命中线封顶 100', computeHitLine({
    baseLine: 100, stage: 1.6, timing: 1.5, unanswered: 1,
    triggerFactor: 1.5, impulse: 20, missStreak: 4, missBonus: 10, bonusCap: 40,
  }), 100)
  eq('命中线下限 0', computeHitLine({ baseLine: 0 }), 0)

  const formula = formatFormula({
    line: 42, daypart: 'evening', baseLine: 45, stage: 1, timing: 1,
    timingLabel: '距上次说话 74 分钟', unanswered: 1, busyFactor: 1,
    triggerFactor: 1, impulse: 5, missBonusPart: 10,
  })
  ok('公式回显包含时段/关系/时机/加成', formula.includes('晚间 45') && formula.includes('关系 1') && formula.includes('时机 1') && formula.includes('冲动 5') && formula.includes('没中加成 10'), formula)
  ok('公式以掷出值开头', formula.startsWith('42 = '), formula)
}

// ---------------------------------------------------------------------------
section('冲动加成 / 情绪不适 / 冲动检测')
// ---------------------------------------------------------------------------
{
  eq('亲近+精力+情绪波动合成冲动加成', impulseBonus({ affection: 0.8, energy: 0.8, valence: 0.5 }), 19)
  eq('平淡情绪无冲动加成', impulseBonus({ affection: 0.5, energy: 0.5, valence: 0 }), 0)
  eq('冲动加成封顶 20', impulseBonus({ affection: 1, energy: 1, valence: 1 }), 20)
  ok('烦躁/沮丧时不主动', emotionUnsuitable({ valence: -0.5, arousal: 0.7 }))
  ok('略低落但唤醒低仍可主动', !emotionUnsuitable({ valence: -0.5, arousal: 0.3 }))

  const strong = detectImpulse({ valence: 0, affection: 0.5 }, { valence: 0.5, affection: 0.5 })
  ok('|Δvalence|≥0.4 触发冲动', strong.strong)
  eq('Δvalence 记录', Math.round(strong.deltaValence * 10) / 10, 0.5)
  const affection = detectImpulse({ valence: 0, affection: 0.5 }, { valence: 0, affection: 0.75 })
  ok('affection 上升≥0.2 触发冲动', affection.strong)
  ok('小幅变化不触发冲动', !detectImpulse({ valence: 0, affection: 0.5 }, { valence: 0.1, affection: 0.55 }).strong)
  ok('缺少基线不误判', !detectImpulse(null, { valence: 0.9 }).strong)
}

// ---------------------------------------------------------------------------
section('反重复：bigram / 话题闸 / 禁句')
// ---------------------------------------------------------------------------
{
  ok('bigram 集合非空', noteKey('周末看海').size === 3)
  eq('相同文本 Jaccard = 1', jaccard(noteKey('周末看海'), noteKey('周末看海')), 1)
  ok('高度相似文本命中文本闸', tooSimilar('周末一起去看海吧', ['周末一起去看海']))
  ok('无关文本不命中文本闸', !tooSimilar('今天天气不错', ['周末一起去看海']))
  ok('空文本不算重复', !tooSimilar('', ['周末一起去看海']))

  ok('禁句：我一直在等你', forbiddenText('我一直在等你回消息') !== '')
  ok('禁句：等了你三天', forbiddenText('等了你三天了') !== '')
  ok('禁句：我是不是很烦', forbiddenText('我是不是很烦啊') !== '')
  ok('正常关心话不命中禁句', forbiddenText('今天忙完了吗？早点休息') === '')

  const now = Date.now()
  const data = {
    memory: { events: [
      { at: now - 3600_000, topics: ['加班'] },
      { at: now - 8 * 86400_000, topics: ['海边'] },
    ] },
    speak: { log: [{ topic: '面试' }, { topic: '' }] },
  }
  const recent = collectRecentTopics(data, now)
  ok('最近 7 天话题进入话题闸', recent.has('加班'))
  ok('主动记录话题进入话题闸', recent.has('面试'))
  ok('7 天前的话题淡出', !recent.has('海边'))

  const events = { memory: { events: [
    { at: now - 2 * 86400_000, topics: ['面试'], summary: '聊到面试' },
    { at: now - 3600_000, topics: ['今天'], summary: '刚聊的' },
  ] } }
  ok('召回候选避开最近话题', pickRecallCandidate(events, new Set(['面试']), now) === null)
  const candidate = pickRecallCandidate(events, new Set(), now)
  eq('召回候选取 1 天前的旧话题', candidate && candidate.topic, '面试')
  const onlyRecent = { memory: { events: [{ at: now - 3600_000, topics: ['今天'], summary: '刚聊的' }] } }
  ok('1 天内事件不作为回忆素材', pickRecallCandidate(onlyRecent, new Set(), now) === null)
}

// ---------------------------------------------------------------------------
section('内容 act 权重 / 加权随机 / 同 act 强制切换 / 仪式窗口')
// ---------------------------------------------------------------------------
{
  const stranger = actWeights({ stage: 'stranger', emotion: { valence: 0, affection: 0.5, energy: 0.6 } })
  eq('stranger 不硬开玩笑', stranger.banter, 0)
  eq('stranger 关心权重最高', stranger.care, 50)
  const familiar = actWeights({ stage: 'familiar', emotion: { valence: 0.5, affection: 0.8, energy: 0.8 }, hasRecall: true })
  ok('熟悉+好心情 joking 权重升高', familiar.banter > 15, familiar)
  ok('有旧话题时 recall 生效', familiar.recall > 0, familiar)
  const noRecall = actWeights({ stage: 'familiar', emotion: {}, hasRecall: false })
  eq('无旧话题时 recall 权重 0', noRecall.recall, 0)
  ok('情绪不适时不 joking', actWeights({ stage: 'familiar', emotion: { valence: -0.5, arousal: 0.7 } }).banter === 0)

  rand = 0
  eq('加权随机：rand=0 取第一项', pickAct({ weights: { care: 10, share: 10 }, random }), 'care')
  rand = 0.999
  eq('加权随机：rand≈1 取最后一项', pickAct({ weights: { care: 10, share: 10 }, random }), 'share')
  eq('全部零权重兜底 care', pickAct({ weights: { care: 0, share: 0 }, random }), 'care')
  rand = 0
  ok('同 act 连续 2 次后强制换', pickAct({ weights: { care: 10, share: 10 }, random, recentActs: ['care', 'care'] }) !== 'care')

  eq('07:30-09:30 早安窗', inRitualWindow(atLocal('08:00')), 'morning')
  eq('09:30 边界仍在窗', inRitualWindow(atLocal('09:30')), 'morning')
  eq('09:31 出窗', inRitualWindow(atLocal('09:31')), '')
  eq('22:00-23:00 晚安窗', inRitualWindow(atLocal('22:30')), 'evening')
  eq('23:00 边界仍在窗', inRitualWindow(atLocal('23:00')), 'evening')
  eq('23:01 出窗', inRitualWindow(atLocal('23:01')), '')
}

// ---------------------------------------------------------------------------
section('生成文本：内心念头框架 / schedule 反框架 / 消息形状')
// ---------------------------------------------------------------------------
{
  const followup = buildFollowupText({ act: 'care', idleMinutes: 74, stage: 'familiar', now: atLocal('20:15'), maxChars: 60, trigger: 'idle' })
  ok('followup：明确是「你自己心里冒出来的念头」', followup.includes('你自己心里冒出来的念头'), followup)
  ok('followup：不是对方发来的消息', followup.includes('不是对方发来的消息'), followup)
  ok('followup：包含由头与字数要求', followup.includes('【由头】') && followup.includes('15~60 个字'), followup)
  ok('followup：允许 <skip>', followup.includes('<skip>'), followup)
  ok('followup：不含 schedule 来源行', !followup.includes('This is a scheduled message from the user'), followup)

  const schedulePrompt = buildSchedulePrompt({ act: 'share', idleMinutes: 60, stage: 'close', now: atLocal('21:00'), trigger: 'idle' })
  ok('schedule：声明是「你自己的闹钟」', schedulePrompt.includes('你自己的闹钟'), schedulePrompt)
  ok('schedule：显式反「用户设的提醒」', schedulePrompt.includes('不是用户设的提醒'), schedulePrompt)
  ok('schedule：点名反框架原文', schedulePrompt.includes('This is a scheduled message from the user'), schedulePrompt)
  ok('schedule：也允许 <skip>', schedulePrompt.includes('<skip>'), schedulePrompt)

  const stickerText = buildIntentBody({ act: 'banter', sticker: true, now: atLocal('20:00') })
  ok('表情包选项写进要求', stickerText.includes('只发一张'), stickerText)

  const message = buildFollowupMessage('测试念头')
  eq('followup 消息 role=user（DSH 只收 user 角色）', message.role, 'user')
  eq('followup source.kind=aura-soul', message.source.kind, 'aura-soul')
  ok('followup source.rpcId 带 qq- 前缀（尝试触发 IM 模式）', String(message.source.rpcId).startsWith('qq-'), message.source)
  eq('followup 内容形状', message.content[0].type, 'text')
  ok('skip 标记识别', isSkipText('<skip>') && isSkipText(' [skip] ') && !isSkipText('晚安'))
  ok('群白名单解析', parseAllowlist('g1, g2，g3 g4').has('g2') && parseAllowlist('').size === 0)
}

// ---------------------------------------------------------------------------
section('干跑：命中只记账不发送，不计日上限，仍清零 missStreak')
// ---------------------------------------------------------------------------
await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.speak.missStreak = 2
  rand = 0 // roll=0 → 命中
  const result = await speak.tick()
  eq('干跑命中 done=dry-run', result.done, 'dry-run')
  eq('干跑命中不算今日送达', soul.speak.todayCount, 0)
  eq('干跑命中清零 missStreak', soul.speak.missStreak, 0)
  eq('干跑不调用 followup', harness.agents[mainBinding.sessionId].calls, 0)
  eq('干跑不创建 schedule', harness.schedule.created.length, 0)
  eq('干跑不设置 active intent', speak.currentIntentText(mainBinding.sessionId), '')
  eq('干跑日志 hit=true/sent=false', soul.speak.log.at(-1).hit, true)
  eq('干跑日志 dryRun=true', soul.speak.log.at(-1).dryRun, true)
  eq('干跑日志 sent=false', soul.speak.log.at(-1).sent, false)
  ok('explain 记录命中公式', harness.soul.explains.some(entry => String(entry.summary).includes('试运行')), harness.soul.explains.length)
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  rand = 0.999 // roll=99.9 → 未中
  const result = await speak.tick()
  eq('干跑未中 done=dry-run-miss', result.done, 'dry-run-miss')
  eq('干跑未中累加 missStreak', harness.soulData.speak.missStreak, 1)
  eq('干跑未中不发送', harness.agents[mainBinding.sessionId].calls, 0)
  ok('explain 记录未中公式', harness.soul.explains.some(entry => String(entry.summary).includes('未中')), harness.soul.explains.length)
})

// ---------------------------------------------------------------------------
section('门控')
// ---------------------------------------------------------------------------
{
  const cases = [
    { name: '关闭总开关', options: { config: { speakEnabled: false } }, done: 'off' },
    { name: 'QQ 离线', options: { online: false }, done: 'offline' },
    { name: '静默时段不掷', options: { clock: new Clock(atLocal('02:00').getTime()) }, done: 'quiet' },
    { name: '冷却中', options: { soulData: (() => { const data = defaultSoulData(); data.speak.lastAt = atLocal('20:00').getTime() - 10 * 60_000; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'cooldown' },
    { name: '每日上限', options: { soulData: (() => { const data = defaultSoulData(); data.speak.dayKey = localDayKey(atLocal('20:00')); data.speak.todayCount = 3; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'daily-cap' },
    { name: '主动暂停', options: { soulData: (() => { const data = defaultSoulData(); data.speak.pausedUntil = atLocal('20:00').getTime() + 3600_000; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'paused' },
    { name: '收尾抑制', options: { soulData: (() => { const data = defaultSoulData(); data.speak.suppressUntil = atLocal('20:00').getTime() + 3600_000; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'suppressed' },
    { name: '被动窗口开着（刚说话）', options: { passive: ['dm:u1'] }, done: 'passive-window' },
    { name: '未回复达暂停线', options: { soulData: (() => { const data = defaultSoulData(); data.speak.perChat = { 'dm:u1': { unanswered: 3 } }; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'blocked' },
    { name: '平台拒绝后暂停', options: { soulData: (() => { const data = defaultSoulData(); data.speak.perChat = { 'dm:u1': { platformRejects: 2 } }; data.speak.lastRollAt = atLocal('20:00').getTime() - 31 * 60_000; return data })() }, done: 'blocked' },
    { name: 'agent 忙', options: { agentOptions: { status: 'running' } }, done: 'agent-busy' },
    { name: '群聊不在白名单', options: { bindings: [{ sessionId: 'qq:group:1:g1', kind: 'group', chatId: 'g1', lastActiveAt: atLocal('20:00').getTime() - 3600_000 }], agents: {} }, done: 'group-not-allowed' },
    { name: '会话已归档', options: { archived: ['qq:dm:1:u1'] }, done: 'archived' },
  ]
  for (const item of cases) {
    await withHarness(item.options, async ({ speak }) => {
      rand = 0
      const result = await speak.tick()
      eq(`门控：${item.name} → ${item.done}`, result.done, item.done)
    })
  }
}

// ---------------------------------------------------------------------------
section('followup 投递（首选通道）')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('真发命中 done=sent', result.done, 'sent')
  eq('投递通道 followup', result.channel, 'followup')
  const agent = harness.agents[mainBinding.sessionId]
  eq('调用一次 followup', agent.calls, 1)
  const message = agent.sent[0]
  eq('消息 role=user', message.role, 'user')
  eq('消息 source.kind=aura-soul', message.source.kind, 'aura-soul')
  ok('消息文本含「你自己心里冒出来的念头」', String(message.content[0].text).includes('你自己心里冒出来的念头'))
  eq('送达计数 +1', harness.soulData.speak.todayCount, 1)
  ok('记录 lastAt', harness.soulData.speak.lastAt > 0)
  eq('lastAct 记录', harness.soulData.speak.lastAct, result.act)
  eq('perChat 未回复 +1', harness.soulData.speak.perChat['dm:u1'].unanswered, 1)
  eq('日志 sent=true', harness.soulData.speak.log.at(-1).sent, true)
  eq('日志 channel=followup', harness.soulData.speak.log.at(-1).channel, 'followup')

  // prompt context 只在命中轮、且会话匹配时非空
  const entry = harness.contextEntries.find(item => item.name === 'aura:intent')
  eq('注册了 aura:intent context', entry && entry.name, 'aura:intent')
  eq('context order 60', entry && entry.order, 60)
  const intentText = entry.text({ agent: { session: { id: mainBinding.sessionId } } })
  ok('命中轮注入主动念头', String(intentText).includes('你自己主动找他说话'), intentText)
  eq('其他会话不注入', entry.text({ agent: { session: { id: 'qq:dm:9:other' } } }), '')
  eq('拿不到会话时不注入', entry.text({}), '')

  // 出站回执：送达 → 清 intent、记录 recentTexts/explain
  harness.bridge.emitOutbound({ proactive: true, sessionId: mainBinding.sessionId, chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' }, text: '晚安，早点睡' })
  eq('出站回执后清空 intent', speak.currentIntentText(mainBinding.sessionId), '')
  ok('送达文本进入最近文本（文本闸）', harness.soulData.speak.recentTexts.includes('晚安，早点睡'), harness.soulData.speak.recentTexts)
  ok('explain 记录送达', harness.soul.explains.some(item => String(item.summary).includes('送达')), harness.soul.explains.map(item => item.summary))
})

// ---------------------------------------------------------------------------
section('followup 失败降级（重试 1 次 → 今日停该会话）')
// ---------------------------------------------------------------------------
await withHarness({ agentOptions: { failTimes: 2 } }, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('followup 连续失败 done=send-failed', result.done, 'send-failed')
  eq('失败只重试 1 次（共 2 次调用）', harness.agents[mainBinding.sessionId].calls, 2)
  eq('未送达不计日上限', harness.soulData.speak.todayCount, 0)
  eq('失败后该会话今日暂停', harness.soulData.speak.perChat['dm:u1'].blockedUntilUser, true)
  eq('日志 sent=false', harness.soulData.speak.log.at(-1).sent, false)
  ok('日志记录失败原因', String(harness.soulData.speak.log.at(-1).error).includes('followup 失败'), harness.soulData.speak.log.at(-1).error)
})

// ---------------------------------------------------------------------------
section('schedule 冷会话兜底（反框架 / title / 去重 / 失败降级）')
// ---------------------------------------------------------------------------
await withHarness({ agents: {} }, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('冷会话走 schedule done=sent', result.done, 'sent')
  eq('通道为 schedule', result.channel, 'schedule')
  eq('创建一条 schedule', harness.schedule.created.length, 1)
  const created = harness.schedule.created[0]
  eq('schedule 标题固定', created.title, 'Aura 想主动说句话')
  eq('schedule after_seconds=1', created.after_seconds, 1)
  eq('schedule 绑定原会话', created.sessionId, mainBinding.sessionId)
  ok('schedule prompt 反框架', String(created.prompt).includes('不是用户设的提醒') && String(created.prompt).includes('你自己的闹钟'), created.prompt)
  eq('冷会话送达也计日上限', harness.soulData.speak.todayCount, 1)
})

await withHarness({
  agents: {},
  schedule: {
    created: [],
    async create(sessionId, task) { this.created.push({ sessionId, ...task }) },
    async list() { return [{ id: 'old', title: 'Aura 想主动说句话' }] },
  },
}, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('已有排队任务时不重复创建', result.done, 'send-failed')
  eq('去重后没有新建 schedule', harness.schedule.created.length, 0)
  ok('去重原因写进日志', String(harness.soulData.speak.log.at(-1).error).includes('排队'), harness.soulData.speak.log.at(-1).error)
})

await withHarness({
  agents: {},
  schedule: {
    created: [],
    async create() { throw new Error('frequency_too_high') },
    async list() { return [] },
  },
}, async ({ harness, speak }) => {
  rand = 0
  const first = await speak.tick()
  eq('schedule 失败 done=send-failed', first.done, 'send-failed')
  ok('记录 schedule 失败原因', String(harness.soulData.speak.log.at(-1).error).includes('frequency_too_high'), harness.soulData.speak.log.at(-1).error)
  eq('失败后当日放弃通道 B', harness.soulData.speak.scheduleDisabledDayKey, localDayKey(atLocal('20:00')))
  harness.clock.advance(31 * 60_000)
  harness.soulData.speak.lastRollAt = harness.clock.ms - 31 * 60_000
  const second = await speak.tick()
  eq('当日不再尝试通道 B', second.done, 'send-failed')
  ok('第二次原因说明通道禁用', String(harness.soulData.speak.log.at(-1).error).includes('放弃'), harness.soulData.speak.log.at(-1).error)
})

// ---------------------------------------------------------------------------
section('平台拒绝：回滚日计数 / pendingThought / ≥2 次暂停 / 不重发')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  const soul = harness.soulData
  eq('先按乐观送达计数', soul.speak.todayCount, 1)
  harness.bridge.emitOutbound({
    proactive: true,
    sessionId: mainBinding.sessionId,
    chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' },
    error: new Error('QQ 主动消息发送失败：当前没有被动回复 msg_id（平台只允许回复最近 5 分钟内的入站消息）'),
  })
  eq('平台拒绝回滚日计数', soul.speak.todayCount, 0)
  eq('平台拒绝回滚 lastAt', soul.speak.lastAt, 0)
  eq('perChat.platformRejects +1', soul.speak.perChat['dm:u1'].platformRejects, 1)
  ok('保存没说出口的念头', soul.speak.pendingThought && String(soul.speak.pendingThought.thought).length > 0, soul.speak.pendingThought)
  eq('失败后清空 intent', speak.currentIntentText(mainBinding.sessionId), '')
  ok('explain 记录失败', harness.soul.explains.some(item => String(item.summary).includes('失败')), harness.soul.explains.map(item => item.summary))
  eq('不自动补发（followup 仍只 1 次）', harness.agents[mainBinding.sessionId].calls, 1)

  // 第二次被拒 → 暂停该会话（等一个掷骰间隔）
  harness.clock.advance(31 * 60_000)
  soul.speak.lastRollAt = harness.clock.ms - 31 * 60_000
  rand = 0
  const second = await speak.tick()
  eq('第二次仍可尝试（未到暂停线）', second.done, 'sent')
  harness.bridge.emitOutbound({ proactive: true, sessionId: mainBinding.sessionId, chat: { key: 'dm:u1' }, error: new Error('主动消息被平台拒绝') })
  eq('被拒 2 次后暂停该会话', soul.speak.perChat['dm:u1'].blockedUntilUser, true)
  rand = 0
  const third = await speak.tick()
  eq('暂停后不再主动', third.done, 'blocked')
})

// ---------------------------------------------------------------------------
section('模型 <skip>：回滚计数、不算平台拒绝')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  const soul = harness.soulData
  harness.bridge.emitOutbound({ proactive: true, sessionId: mainBinding.sessionId, chat: { key: 'dm:u1' }, text: '<skip>' })
  eq('<skip> 回滚日计数', soul.speak.todayCount, 0)
  eq('<skip> 不计平台拒绝', soul.speak.perChat['dm:u1'].platformRejects, 0)
  eq('<skip> 不写 pendingThought', soul.speak.pendingThought || null, null)
  eq('<skip> 清空 intent', speak.currentIntentText(mainBinding.sessionId), '')
})

// ---------------------------------------------------------------------------
section('手动：dry 不发送 / real 发送不动计数器 / 静默时段可演练')
// ---------------------------------------------------------------------------
await withHarness({ clock: new Clock(atLocal('02:00').getTime()), config: { speakDryRun: true } }, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick({ trigger: 'manual', mode: 'dry' })
  eq('静默时段手动演练 done=manual-dry', result.done, 'manual-dry')
  eq('手动演练不发送', harness.agents[mainBinding.sessionId].calls, 0)
  eq('手动演练不动日计数', harness.soulData.speak.todayCount, 0)
  eq('手动演练不动 lastAt', harness.soulData.speak.lastAt, 0)
  eq('手动演练不设 intent', speak.currentIntentText(mainBinding.sessionId), '')
  eq('手动日志 manual=true', harness.soulData.speak.log.at(-1).manual, true)
})

await withHarness({ clock: new Clock(atLocal('02:00').getTime()), config: { speakDryRun: true } }, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick({ trigger: 'manual', mode: 'real' })
  eq('手动真发忽略 dryRun 配置', result.done, 'manual-sent')
  eq('手动真发调用 followup', harness.agents[mainBinding.sessionId].calls, 1)
  eq('手动真发不动日计数', harness.soulData.speak.todayCount, 0)
  eq('手动真发不动 lastAt', harness.soulData.speak.lastAt, 0)
})

await withHarness({ online: false, config: { speakDryRun: true } }, async ({ speak }) => {
  rand = 0
  const result = await speak.tick({ trigger: 'manual', mode: 'dry' })
  eq('离线也能手动演练', result.done, 'manual-dry')
})

await withHarness({ online: false }, async ({ speak }) => {
  rand = 0
  const result = await speak.tick({ trigger: 'manual', mode: 'real' })
  eq('离线不能手动真发', result.done, 'offline')
})

// ---------------------------------------------------------------------------
section('触发源优先级：impulse > due > ritual > return > idle')
// ---------------------------------------------------------------------------
await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  // impulse 与 due 同时到期 → impulse 优先
  const soul = harness.soulData
  soul.speak.pendingImpulse = { at: harness.clock.ms - 30 * 60_000, deltaValence: 0.5 }
  soul.relation.lastUserAt = harness.clock.ms - 30 * 60_000
  soul.speak.lastUserAt = harness.clock.ms - 30 * 60_000
  soul.memory.pendingDue = [{ dueAt: harness.clock.ms - 60_000, text: '面试' }]
  rand = 0
  const result = await speak.tick()
  eq('impulse 优先于 due', result.trigger, 'impulse')
  ok('impulse 命中线乘 1.5', String(result.formula).includes('心里一动 1.5'), result.formula)
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.memory.pendingDue = [{ dueAt: harness.clock.ms - 60_000, text: '面试' }]
  rand = 0
  const result = await speak.tick()
  eq('due 触发', result.trigger, 'due')
  eq('due 固定命中线 70', result.line, 70)
  ok('due 记录 firedAt 防重复', soul.memory.pendingDue[0].firedAt > 0, soul.memory.pendingDue[0])
})

await withHarness({ clock: new Clock(atLocal('08:00').getTime()), config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.relation.lastUserAt = harness.clock.ms - 3 * 3600_000
  rand = 0
  const result = await speak.tick()
  eq('早安仪式触发', result.trigger, 'ritual')
  eq('仪式固定命中线 55', result.line, 55)
  // 同一天同一窗口第二次 → 不再 ritual
  harness.clock.advance(31 * 60_000)
  soul.speak.lastRollAt = harness.clock.ms - 31 * 60_000
  const second = await speak.tick()
  ok('仪式每日一次', second.trigger !== 'ritual', second.trigger)
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.relation.lastUserAt = harness.clock.ms - 25 * 3600_000
  soul.speak.lastUserAt = soul.relation.lastUserAt
  rand = 0
  const result = await speak.tick()
  eq('久别回归触发', result.trigger, 'return')
  ok('return 命中线乘 1.3', String(result.formula).includes('好久没聊 1.3'), result.formula)
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.speak.lastRollAt = harness.clock.ms - 31 * 60_000
  rand = 0
  const result = await speak.tick()
  eq('普通闲置触发 idle', result.trigger, 'idle')
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.speak.lastRollAt = harness.clock.ms - 10 * 60_000 // 间隔没到
  rand = 0
  const result = await speak.tick()
  eq('间隔没到 → idle-wait', result.done, 'idle-wait')
})

// ---------------------------------------------------------------------------
section('入站 hook：未回复清零 / 暂停正则 / 冲动检测 / 已回标记')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  const soul = harness.soulData
  soul.speak.perChat = { 'dm:u1': { unanswered: 2, platformRejects: 2, blockedUntilUser: true, lastUserAt: 0, lastAssistantAt: 0 } }
  soul.speak.lastProactiveAt = harness.clock.ms - 3600_000
  soul.speak.lastProactiveAnswered = false
  harness.bridge.emitInbound({ kind: 'dm', chatId: 'u1', msgId: 'm1', text: '在吗', timestampMs: harness.clock.ms, rawType: 'C2C_MESSAGE_CREATE' })
  eq('入站清零未回复', soul.speak.perChat['dm:u1'].unanswered, 0)
  eq('入站清零平台拒绝', soul.speak.perChat['dm:u1'].platformRejects, 0)
  eq('入站解除暂停', soul.speak.perChat['dm:u1'].blockedUntilUser, false)
  eq('入站标记上次主动已被回应', soul.speak.lastProactiveAnswered, true)
  eq('入站更新 relation.lastUserAt', soul.relation.lastUserAt, harness.clock.ms)
  ok('入站触发 soul.save', harness.soul.saves > 0)

  harness.bridge.emitInbound({ kind: 'dm', chatId: 'u1', msgId: 'm2', text: '最近别主动找我了', timestampMs: harness.clock.ms, rawType: 'C2C_MESSAGE_CREATE' })
  ok('「别主动找我」→ 暂停', soul.speak.pausedUntil > harness.clock.ms, soul.speak.pausedUntil)
  ok('暂停写入 explain', harness.soul.explains.some(item => String(item.summary).includes('别打扰')), harness.soul.explains.map(item => item.summary))

  // 冲动检测：第二条消息处理前情绪从 0 跳到 0.6（模拟 emotion appraisal 已跑）
  harness.emotionState.valence = 0.6
  harness.clock.advance(60_000)
  harness.bridge.emitInbound({ kind: 'dm', chatId: 'u1', msgId: 'm3', text: '我今天升职了！', timestampMs: harness.clock.ms, rawType: 'C2C_MESSAGE_CREATE' })
  ok('情绪大幅变化登记冲动', soul.speak.pendingImpulse && Math.abs(soul.speak.pendingImpulse.deltaValence) >= 0.4, soul.speak.pendingImpulse)
})

// ---------------------------------------------------------------------------
section('checkProactiveText：文本闸 / 禁句 / skip / 超长')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  ok('正常文本通过', speak.checkProactiveText('今天忙完了吗？早点休息').ok === true)
  eq('禁句被拦', speak.checkProactiveText('我一直在等你回消息').reason, 'forbidden')
  eq('skip 被拦', speak.checkProactiveText('<skip>').reason, 'skip')
  eq('空文本被拦', speak.checkProactiveText('   ').reason, 'empty')
  ok('超长被拦', speak.checkProactiveText('好'.repeat(200)).ok === false)
  harness.soulData.speak.recentTexts = ['晚安，早点睡吧']
  const similar = speak.checkProactiveText('晚安早点睡吧')
  ok('与最近主动消息过于相似 → similar', similar.ok === false && similar.reason === 'similar', similar)
  const recorded = speak.checkProactiveText('新的一句话', { record: true })
  ok('record=true 写入最近文本', recorded.ok === true && harness.soulData.speak.recentTexts.includes('新的一句话'), harness.soulData.speak.recentTexts)
})

// ---------------------------------------------------------------------------
section('snapshot / 纯函数挂载')
// ---------------------------------------------------------------------------
await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  const snapshot = speak.snapshot()
  eq('snapshot.enabled', snapshot.enabled, true)
  eq('snapshot.dryRun', snapshot.dryRun, true)
  eq('snapshot.dailyCap', snapshot.dailyCap, 3)
  eq('snapshot.quietStart', snapshot.quietStart, '23:30')
  ok('snapshot 提供 nextLine 与公式', typeof snapshot.nextLine === 'number' && snapshot.rule.includes('晚间 45'), snapshot.rule)
  ok('snapshot.log 是数组', Array.isArray(snapshot.log))
  ok('snapshot.target 指向可主动会话', snapshot.target && snapshot.target.sessionId === mainBinding.sessionId, snapshot.target)
  ok('helpers 暴露纯函数', typeof speak.helpers.computeHitLine === 'function' && typeof speak.helpers.inQuietHours === 'function')
  ok('snapshot.pendingThought 字段存在', 'pendingThought' in snapshot)
})

// ---------------------------------------------------------------------------
section('真实 API 形状：soul.get/saveSoon/explain/on + emotion.decayed + memory.pendingDue/consumeDue')
// ---------------------------------------------------------------------------
await withHarness({ variant: 'real', config: { speakDryRun: true } }, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('soul.get() 容器里写入主动日志', Array.isArray(harness.soulData.speak.log) && harness.soulData.speak.log.length >= 1, true)
  eq('soul.get() 容器里写入 missStreak=0（干跑命中清零）', harness.soulData.speak.missStreak, 0)
  ok('soul.saveSoon 被调用（防抖落盘）', harness.soul.saves > 0, harness.soul.saves)
  ok('soul.explain 写入 explainLog', harness.soul.explains.length > 0, harness.soul.explains.length)
  ok('emotion.decayed 参与命中线计算', typeof result.line === 'number' && result.line >= 0)
})

// schedule/真的命中时调用 memory.consumeDue（真实 memory 的到点约定用掉即清）
{
  let consumed = 0
  const due = [{ id: 'due-1', at: atLocal('20:00').getTime() - 60_000, text: '明天面试' }]
  const memory = {
    pendingDue: () => due.slice(),
    consumeDue: () => { consumed += 1; due.length = 0 },
    recall: () => [],
  }
  await withHarness({ variant: 'real', memory, config: { speakDryRun: false } }, async ({ harness, speak }) => {
    rand = 0
    const result = await speak.tick()
    eq('真实 memory 的到点事件触发 due', result.trigger, 'due')
    eq('命中后取走到点事件（consumeDue）', consumed, 1)
    eq('due 事件进入 followup', harness.agents[mainBinding.sessionId].calls, 1)
  })
}

// soul.on('turnEnd')：回合前基线 vs 回合后情绪 → 登记冲动，20 分钟后可触发
await withHarness({ variant: 'real', config: { speakDryRun: true } }, async ({ harness, speak }) => {
  harness.bridge.emitInbound({ kind: 'dm', chatId: 'u1', msgId: 'm1', text: '今天好累', timestampMs: harness.clock.ms, rawType: 'C2C_MESSAGE_CREATE' })
  harness.emotionState.valence = 0.6
  harness.soul.emit('turnEnd', {})
  ok('turnEnd 后登记情绪冲动', harness.soulData.speak.pendingImpulse && Math.abs(harness.soulData.speak.pendingImpulse.deltaValence) >= 0.4, harness.soulData.speak.pendingImpulse)
  eq('turnEnd 后清 pendingUserTurn', harness.soulData.speak.pendingUserTurn, false)

  // 模拟她这一轮正常回复了（出站回执刷新 lastAssistantAt，否则会被 pending-reply 门控挡住）
  harness.bridge.emitOutbound({ sessionId: mainBinding.sessionId, chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' }, text: '那就早点休息吧' })
  harness.clock.advance(30 * 60_000)
  harness.soulData.relation.lastUserAt = harness.clock.ms - 30 * 60_000
  harness.soulData.speak.lastUserAt = harness.soulData.relation.lastUserAt
  harness.soulData.speak.lastRollAt = harness.clock.ms - 31 * 60_000
  rand = 0
  const result = await speak.tick()
  eq('静默 20~180 分钟后冲动触发', result.trigger, 'impulse')
})

// 旧形状仍然可用（向后兼容：soul.data + save + recordExplain；emotion.snapshot）
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  const result = await speak.tick()
  eq('旧形状 soul.data 仍可写入日志', Array.isArray(harness.soulData.speak.log) && harness.soulData.speak.log.length >= 1, true)
  eq('旧形状 soul.save 被调用', harness.soul.saves > 0, true)
  eq('旧形状 explainLog 写入', harness.soul.explains.length > 0, true)
})

// ---------------------------------------------------------------------------
section('真实 bridge 对接：markProactive / notifyOutbound 三种载荷')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  ok('投递前已 bridge.markProactive(sessionId)', harness.bridge.proactiveMarks.has(mainBinding.sessionId), [...harness.bridge.proactiveMarks.keys()])
  const mark = harness.bridge.proactiveMarks.get(mainBinding.sessionId)
  eq('markProactive 带上 act', mark.act, harness.soulData.speak.lastAct)
  // 真实 bridge 的主动送达载荷
  harness.bridge.emitOutbound({ chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' }, kind: 'text', text: '晚安，早点睡', proactive: true, sessionId: mainBinding.sessionId })
  eq('主动送达载荷清空 intent', speak.currentIntentText(mainBinding.sessionId), '')
  ok('主动送达载荷记录 recentTexts', harness.soulData.speak.recentTexts.includes('晚安，早点睡'), harness.soulData.speak.recentTexts)
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  const soul = harness.soulData
  // 真实 bridge 的 <skip> 载荷：kind='skip', proactive=false，无 text/sessionId
  harness.bridge.emitOutbound({ chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' }, kind: 'skip', proactive: false })
  eq('skip 载荷回滚日计数', soul.speak.todayCount, 0)
  eq('skip 载荷不算平台拒绝', soul.speak.perChat['dm:u1'].platformRejects, 0)
  eq('skip 载荷清空 intent', speak.currentIntentText(mainBinding.sessionId), '')
  eq('skip 载荷不写 pendingThought', soul.speak.pendingThought || null, null)
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  const soul = harness.soulData
  // 真实 bridge 的主动失败载荷
  harness.bridge.emitOutbound({
    chat: { key: 'dm:u1', kind: 'dm', chatId: 'u1' },
    kind: 'proactive-failed',
    error: 'QQ 主动消息发送失败：当前没有被动回复 msg_id（平台只允许回复最近 5 分钟内的入站消息）',
    proactive: true,
    sessionId: mainBinding.sessionId,
  })
  eq('proactive-failed 回滚日计数', soul.speak.todayCount, 0)
  eq('proactive-failed 记平台拒绝', soul.speak.perChat['dm:u1'].platformRejects, 1)
  ok('proactive-failed 保存 pendingThought', soul.speak.pendingThought && soul.speak.pendingThought.thought.length > 0, soul.speak.pendingThought)
})

await withHarness({ agentOptions: { failTimes: 2 } }, async ({ harness, speak }) => {
  rand = 0
  await speak.tick()
  eq('followup 失败后清掉 bridge 主动标记', harness.bridge.proactiveMarks.size, 0)
})

// ---------------------------------------------------------------------------
section('evaluateDice 纯函数（与旧公式逐位一致）')
// ---------------------------------------------------------------------------
{
  const now = atLocal('20:00').getTime()
  const soul = {
    relation: { stage: 'familiar', lastUserAt: now - 60 * 60_000 },
    speak: { unanswered: 0, missStreak: 1, perChat: { 'dm:u1': { unanswered: 1 } } },
  }
  const config = {
    nearMinutes: 20, nearFactor: 0.15, farMinutes: 360, farFactor: 1.5,
    missBonus: 10, bonusCap: 40,
  }
  const emotion = { valence: 0.4, arousal: 0.3, affection: 0.8, energy: 0.7 }
  const before = JSON.stringify(soul)
  const result = evaluateDice({ config, soul, emotion, life: { state: 'work' }, now, trigger: 'idle' })
  // 45 × 1 × 1 × 0.5 × 1 + 冲动 15 + 社交 0.9 + 没中 10 = 48.4；生活 work ×0.4 → 19.36
  ok('命中线 = 旧公式 + 社交需求加成', Math.abs(result.line - 19.36) < 1e-9, result.line)
  ok('概率 = 命中线 / 100', Math.abs(result.probability - 0.1936) < 1e-9, result.probability)
  eq('trigger 归一', result.trigger, 'idle')
  eq('parts.base/stage/timing/unanswered/life/impulse/miss', [
    result.parts.base, result.parts.stage, result.parts.timing,
    result.parts.unanswered, result.parts.life, result.parts.impulse, result.parts.miss,
  ], [45, 1, 1, 0.5, 0.4, 15, 10])
  eq('parts 关键字段类型', Object.keys(result.parts).every(key => result.parts[key] !== undefined), true)
  ok('社交需求 impact = 0.2 × socialNeed × 20', Math.abs(result.parts.socialNeedImpact - 0.9) < 1e-9, result.parts.socialNeedImpact)
  ok('socialNeed 从距上次互动估算', Math.abs(result.parts.socialNeed - 0.2167) < 0.001, result.parts.socialNeed)
  ok('note 含时段基线与生活倍率', result.note.includes('晚间 45') && result.note.includes('生活 0.4'), result.note)
  eq('纯函数不修改 soul', JSON.stringify(soul), before)

  const objectTrigger = evaluateDice({ config, soul, emotion, life: { state: 'work' }, now, trigger: { trigger: 'idle', factor: 1, overrideLine: null } })
  eq('对象 trigger 与字符串等价', objectTrigger.line, result.line)

  const wake = evaluateDice({ config, soul, emotion, life: 'awake', now, trigger: 'wake' })
  eq('wake 线 = 80 × 情绪（正向情绪 clamp 到 100）', wake.line, 100)
  ok('wake 情绪倍率 > 1', wake.parts.shareEmotionFactor > 1, wake.parts.shareEmotionFactor)
  const due = evaluateDice({ config, soul, emotion, life: 'awake', now, trigger: 'due' })
  eq('due 固定线 70', due.line, 70)
  const ritual = evaluateDice({ config, soul, emotion, life: 'awake', now, trigger: 'ritual' })
  eq('ritual 固定线 55', ritual.line, 55)
  const share = evaluateDice({ config, soul, emotion, life: 'awake', now, trigger: 'share' })
  eq('share 线 = 85 × 生活 × 情绪 × 强度（正向情绪 clamp 到 100）', share.line, 100)
  eq('share 默认强度倍率 1.0', share.parts.shareStrengthFactor, 1)
  const impulse = evaluateDice({ config, soul, emotion, life: 'awake', now, trigger: 'impulse' })
  ok('impulse 用 ×1.5', impulse.line > result.line * 2, { impulse: impulse.line, idle: result.line })
  const sleep = evaluateDice({ config, soul, emotion, life: { state: 'sleep' }, now, trigger: 'idle' })
  eq('sleep 命中线 0', sleep.line, 0)
  eq('sleep note 标注生活状态', sleep.note.includes('在睡'), true)
  eq('normalizeDiceTrigger share', normalizeDiceTrigger('share').overrideLine, 85)
}

// ---------------------------------------------------------------------------
section('情绪加权 / 分享强度 / 互动窗口（纯函数）')
// ---------------------------------------------------------------------------
{
  const HOUR_MS = 60 * 60 * 1000
  const neutral = { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6 }
  eq('无情绪数据 → 1.0', emotionShareFactor({}, []), 1)
  eq('中性情绪 → 1.0', emotionShareFactor(neutral), 1)
  ok('正向 valence/affection/energy 提高', emotionShareFactor({ valence: 0.6, arousal: 0.4, affection: 0.85, energy: 0.85 }) > 1)
  ok('负向 valence 降低', emotionShareFactor({ ...neutral, valence: -0.6 }) < 1)
  const episode = (type, level = 'medium', intensity = 0.6, expiresAt = Date.now() + HOUR_MS) => ({ type, level, intensity, expiresAt })
  ok('好奇 episode 提高', emotionShareFactor(neutral, [episode('curiosity')]) > 1)
  ok('开心 episode 提高', emotionShareFactor(neutral, [episode('joy')]) > 1)
  ok('悲伤 episode 降低', emotionShareFactor(neutral, [episode('sadness')]) < 1)
  ok('愤怒 episode 降低', emotionShareFactor(neutral, [episode('anger')]) < 1)
  ok('恐惧 episode 降低', emotionShareFactor(neutral, [episode('fear')]) < 1)
  eq('上限 1.6', emotionShareFactor({ valence: 1, arousal: 0.5, affection: 1, energy: 1 }, [episode('joy', 'heavy', 1)]), 1.6)
  eq('下限 0.2', emotionShareFactor({ valence: -1, arousal: 0.5, affection: 0, energy: 0 }, [episode('sadness', 'heavy', 1)]), 0.2)
  eq('过期 episode 不参与', emotionShareFactor(neutral, [episode('sadness', 'heavy', 1, Date.now() - 1)]), 1)

  eq('strength 0.6（默认）→ 1.0', shareStrengthFactor(0.6), 1)
  ok('strength 高 → 倍率更高', shareStrengthFactor(0.9) > 1)
  ok('strength 低 → 倍率更低', shareStrengthFactor(0.3) < 1)
  eq('strength 上限 1.3', shareStrengthFactor(1), 1.3)
  eq('strength 下限 0.7', shareStrengthFactor(0), 0.7)

  const nowAt = Date.now()
  eq('互动窗口 0 = 不限', withinRecentInteraction(nowAt - 10 * HOUR_MS, nowAt, 0), true)
  eq('互动窗口内命中', withinRecentInteraction(nowAt - 5 * HOUR_MS, nowAt, 6), true)
  eq('互动窗口外拒绝', withinRecentInteraction(nowAt - 7 * HOUR_MS, nowAt, 6), false)
  eq('从没互动过 + 窗口 >0 拒绝', withinRecentInteraction(0, nowAt, 6), false)
}

// ---------------------------------------------------------------------------
section('情绪分解 / 权重倍率 / 不合适标记')
// ---------------------------------------------------------------------------
{
  const detail = emotionImpulseDetail({ affection: 0.8, energy: 0.8, valence: 0.5 })
  ok('亲近分项 9', Math.abs(detail.affectionPart - 9) < 1e-9, detail.affectionPart)
  ok('精力分项 6', Math.abs(detail.energyPart - 6) < 1e-9, detail.energyPart)
  ok('愉悦分项 4', Math.abs(detail.valencePart - 4) < 1e-9, detail.valencePart)
  eq('总冲动 19', detail.total, 19)
  eq('与 impulseBonus 一致', detail.total, impulseBonus({ affection: 0.8, energy: 0.8, valence: 0.5 }))
  eq('倍率 2 → 封顶 20', emotionImpulseDetail({ affection: 0.8, energy: 0.8, valence: 0.5 }, 2).total, 20)
  eq('倍率 0 → 冲动 0', emotionImpulseDetail({ affection: 0.8, energy: 0.8, valence: 0.5 }, 0).total, 0)

  const now = atLocal('20:00').getTime()
  const soul = { relation: { stage: 'familiar', lastUserAt: now - 60 * 60_000 }, speak: {} }
  const base = evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6 }, now, trigger: 'idle' })
  const moreAffection = evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.9, energy: 0.6 }, now, trigger: 'idle' })
  const moreEnergy = evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.95 }, now, trigger: 'idle' })
  const moreValence = evaluateDice({ soul, emotion: { valence: 0.8, arousal: 0.2, affection: 0.5, energy: 0.6 }, now, trigger: 'idle' })
  ok('affection 单调性', moreAffection.line > base.line, { base: base.line, more: moreAffection.line })
  ok('energy 单调性', moreEnergy.line > base.line)
  ok('|valence| 单调性', moreValence.line > base.line)
  eq('emotionParts 四元组', ['affection', 'valence', 'energy', 'socialNeed'].every(key => Number.isFinite(base.emotionParts[key])), true)
  eq('没有 socialNeed 时按距上次互动估算', Math.abs(base.emotionParts.socialNeed - estimateSocialNeed({ lastUserAt: now - 60 * 60_000, now })) < 1e-9, true)
  eq('socialNeed 直接读取', socialNeedOf({ socialNeed: 0.9 }), 0.9)
  eq('socialNeed 优先级高于估算', evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6, socialNeed: 0.93 }, now, trigger: 'idle' }).emotionParts.socialNeed, 0.93)

  const bad = evaluateDice({ soul, emotion: { valence: -0.8, arousal: 0.9, affection: 0.5, energy: 0.6 }, now, trigger: 'idle' })
  eq('负向高唤醒标记不合适', bad.emotionBlocked, true)
  ok('标记但命中线不硬归零（行为不变）', bad.line > 0 && bad.note.includes('不适合'), bad.note)

  const lowSocial = evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6, socialNeed: 0 }, now, trigger: 'idle' })
  const highSocial = evaluateDice({ soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6, socialNeed: 0.9 }, now, trigger: 'idle' })
  ok('社交需求进冲动：0.2 × 0.9 × 20 = 3.6', Math.abs((highSocial.line - lowSocial.line) - 3.6) < 1e-9, highSocial.line - lowSocial.line)
  eq('社交 impact 写进 parts', highSocial.parts.socialNeedImpact, 3.6)
  const zeroWeight = evaluateDice({ config: { socialNeedWeight: 0 }, soul, emotion: { valence: 0, arousal: 0.2, affection: 0.5, energy: 0.6, socialNeed: 0.9 }, now, trigger: 'idle' })
  ok('权重 0 → 社交不加成', Math.abs(zeroWeight.line - lowSocial.line) < 1e-9, zeroWeight.line)
}

// ---------------------------------------------------------------------------
section('simulate：形状 / 状态 / 时段 / 情绪 / 触发源 / 日上限')
// ---------------------------------------------------------------------------
await withHarness({ installOptions: { life: { get: () => ({ state: 'awake', activity: '' }) } } }, async ({ harness, speak }) => {
  const saves = harness.soul.saves
  const agentCalls = harness.agents[mainBinding.sessionId].calls
  const sim = speak.simulate({ now: harness.clock.ms })
  eq('simulate 不写盘', harness.soul.saves, saves)
  eq('simulate 不发送', harness.agents[mainBinding.sessionId].calls, agentCalls)
  eq('顶层 ok', sim.ok, true)
  eq('current 字段齐全', ['line', 'probability', 'parts', 'emotionParts', 'trigger'].every(key => sim.current[key] !== undefined), true)
  eq('byState 六种生活状态', Object.keys(sim.byState).sort(), ['awake', 'out', 'play', 'rest', 'sleep', 'work'])
  eq('byDaypart 五个时段', Object.keys(sim.byDaypart).sort(), ['evening', 'morning', 'night', 'noon', 'work'])
  eq('byValence 11 个点（-1~1 步长 0.2）', sim.byValence.length, 11)
  eq('byValence 首尾', [sim.byValence[0].x, sim.byValence[10].x], [-1, 1])
  eq('byTrigger 六个触发源', Object.keys(sim.byTrigger).sort(), ['due', 'idle', 'impulse', 'return', 'ritual', 'share'])
  eq('daily 字段', ['intervalMinutes', 'ticksPerDay', 'pAtLeastOne', 'cap'].every(key => sim.daily[key] !== undefined), true)
  eq('daily interval', sim.daily.intervalMinutes, 30)
  eq('daily ticksPerDay', sim.daily.ticksPerDay, 48)
  eq('daily cap', sim.daily.cap, 3)
  ok('daily pAtLeastOne 0~1', sim.daily.pAtLeastOne > 0 && sim.daily.pAtLeastOne < 1, sim.daily.pAtLeastOne)

  ok('生活状态单调：rest > awake > work', sim.byState.rest.probability > sim.byState.awake.probability
    && sim.byState.awake.probability > sim.byState.work.probability, sim.byState)
  eq('work = play', sim.byState.work.probability, sim.byState.play.probability)
  ok('out 在 work 与 awake 之间', sim.byState.out.probability > sim.byState.work.probability
    && sim.byState.out.probability < sim.byState.awake.probability)
  eq('sleep 概率 0', sim.byState.sleep.probability, 0)
  ok('傍晚 > 工作时段基线', sim.byDaypart.evening.probability > sim.byDaypart.work.probability, sim.byDaypart)
  ok('valence 正侧单调不减（0 → 1）', sim.byValence.slice(5).every((point, index, list) => index === 0 || point.probability >= list[index - 1].probability), sim.byValence.slice(5))
  ok('|valence|=1 比 0 更容易', sim.byValence[10].probability > sim.byValence[5].probability)
  eq('byTrigger share 用动态线（中性情绪 = 85）', sim.byTrigger.share.line, 85)
  eq('没有 pendingShare 时 share 不可用', sim.byTrigger.share.available, false)
  eq('share 卡片 enabled', sim.share.enabled, true)
  eq('share.factors 三项', ['life', 'emotion', 'strength'].every(key => typeof sim.share.factors[key] === 'number'), true)
  eq('share.factors 中性值', [sim.share.factors.life, sim.share.factors.emotion, sim.share.factors.strength], [1, 1, 1])
  eq('daily.shareDaily 字段', ['cap', 'count', 'dayKey'].every(key => sim.daily.shareDaily[key] !== undefined), true)
  eq('daily.shareDaily cap 默认 2', sim.daily.shareDaily.cap, 2)
  eq('byTrigger.share 带 factors', typeof sim.byTrigger.share.factors.emotion, 'number')

  const sleepSim = speak.simulate({ now: harness.clock.ms, stateOverride: 'sleep' })
  eq('stateOverride 改生活状态', sleepSim.current.parts.lifeState, 'sleep')
  eq('stateOverride sleep 命中线 0', sleepSim.current.line, 0)
  eq('stateOverride sleep 门控标记', sleepSim.gates.sleep, true)
  const emotionSim = speak.simulate({ now: harness.clock.ms, emotionOverride: { valence: 0.9, affection: 0.95 } })
  eq('emotionOverride 覆盖 valence', emotionSim.current.emotionParts.valence, 0.9)
  eq('emotionOverride 覆盖 affection', emotionSim.current.emotionParts.affection, 0.95)
  ok('正向情绪抬高分享线', emotionSim.share.line > 85, emotionSim.share)
  ok('分享线 factors 跟着情绪变', emotionSim.share.factors.emotion > 1, emotionSim.share.factors)
})

await withHarness({ config: { speakShareEnabled: false }, installOptions: { life: { get: () => ({ state: 'awake' }) } } }, async ({ harness, speak }) => {
  const sim = speak.simulate({ now: harness.clock.ms })
  eq('分享欲关闭：byTrigger.share = 0', sim.byTrigger.share.probability, 0)
  eq('分享欲关闭：share.enabled false', sim.share.enabled, false)
})

// ---------------------------------------------------------------------------
section('pendingShare：入队 / 消费 / 过期 / 优先级 / 门控')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  const queued = speak.queueShare({ text: '刚听到一首歌，想分你一半', reason: '单曲循环', strength: 0.8, ttlMinutes: 60, source: 'test' })
  eq('queueShare ok', queued.ok, true)
  const stored = harness.soulData.speak.pendingShare
  eq('pendingShare 文本', stored.text, '刚听到一首歌，想分你一半')
  eq('pendingShare 强度', stored.strength, 0.8)
  eq('pendingShare source', stored.source, 'test')
  eq('ttl 60 分钟', stored.expiresAt - stored.createdAt, 60 * 60_000)
  eq('snapshot 暴露 pendingShare', speak.snapshot().pendingShare.text, stored.text)
  eq('snapshot 暴露概率', typeof speak.snapshot().nextProbability, 'number')

  // 冲动也满足，但 share 优先级更高
  const now = harness.clock.ms
  const lastUserAt = now - 40 * 60_000
  harness.soulData.relation.lastUserAt = lastUserAt
  harness.soulData.speak.lastUserAt = lastUserAt
  harness.soulData.speak.pendingImpulse = { at: lastUserAt, deltaValence: 0.6, deltaAffection: 0.1 }
  harness.soulData.speak.impulseDayKey = ''
  const result = await speak.tick()
  eq('share 优先于 impulse', result.trigger, 'share')
  eq('share 命中线 = 85 × 强度 1.3（0.8 强度）→ clamp 100', result.line, 100)
  eq('share 命中', result.hit, true)
  const sent = harness.agents[mainBinding.sessionId].sent.at(-1)
  ok('prompt 带分享内容', sent.content[0].text.includes('刚听到一首歌'), sent.content[0].text.slice(0, 200))
  eq('发送成功后消费', harness.soulData.speak.pendingShare, null)
})

await withHarness({ config: { speakDryRun: true } }, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '试运行不消费', ttlMinutes: 60 })
  const result = await speak.tick()
  eq('dry-run 命中 share', result.done, 'dry-run')
  eq('dry-run 不消费 pendingShare', harness.soulData.speak.pendingShare.text, '试运行不消费')
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '过期了', ttlMinutes: 60 })
  harness.soulData.speak.pendingShare.expiresAt = harness.clock.ms - 1000
  eq('过期 snapshot.active false', speak.snapshot().pendingShare.active, false)
  const result = await speak.tick()
  ok('过期不触发 share', result.trigger !== 'share', result)
  eq('过期 consumeShare 返回 null', speak.consumeShare(), null)
  eq('过期 consumeShare 清掉记录', harness.soulData.speak.pendingShare, null)
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '日上限不消费', ttlMinutes: 60 })
  harness.soulData.speak.dayKey = localDayKey(harness.clock.now())
  harness.soulData.speak.todayCount = 3
  const result = await speak.tick()
  eq('日上限挡住', result.done, 'daily-cap')
  eq('日上限不消费', harness.soulData.speak.pendingShare.text, '日上限不消费')
})

await withHarness({ installOptions: { life: { get: () => ({ state: 'sleep' }) } } }, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '睡着不消费', ttlMinutes: 60 })
  const result = await speak.tick()
  eq('sleep 门控优先', result.done, 'life-sleep')
  eq('sleep 不消费 pendingShare', harness.soulData.speak.pendingShare.text, '睡着不消费')
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '静默别开口', ttlMinutes: 60 })
  harness.clock.set(atLocal('02:00').getTime())
  const result = await speak.tick()
  eq('静默时段挡住 share', result.done, 'quiet')
  eq('静默不消费 pendingShare', harness.soulData.speak.pendingShare.text, '静默别开口')
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  harness.setConfig({ speakShareEnabled: false })
  const off = speak.queueShare({ text: '关了就别塞', ttlMinutes: 60 })
  eq('关闭时 queueShare 拒绝', off.ok, false)
  // 绕过 queueShare 直接塞一条，验证 tick 不消费 share 触发
  harness.soulData.speak.pendingShare = { text: '遗留', createdAt: harness.clock.ms, expiresAt: harness.clock.ms + 60_000, strength: 0.6, source: 'test' }
  const result = await speak.tick()
  ok('关闭时 tick 不选 share', result.trigger !== 'share', result.trigger)
  eq('关闭时也不消费', harness.soulData.speak.pendingShare.text, '遗留')

  const cleared = speak.clearShare()
  eq('clearShare 清掉', cleared.cleared, true)
  eq('clearShare 后面板为空', speak.pendingShare(), null)
})

// ---------------------------------------------------------------------------
section('分享/普通主动窗口 / 分享冷却 / 分享日上限 / 醒来情绪不适合')
// ---------------------------------------------------------------------------
await withHarness({ config: { speakShareRecentHours: 6 } }, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '窗口外的分享', ttlMinutes: 60 })
  harness.soulData.relation.lastUserAt = harness.clock.ms - 7 * 60 * 60_000
  harness.soulData.speak.lastUserAt = harness.soulData.relation.lastUserAt
  const result = await speak.tick()
  ok('分享互动窗口外不选 share', result.trigger !== 'share', result.trigger)
  eq('窗口外 pendingShare 保留', (harness.soulData.speak.pendingShare || {}).text, '窗口外的分享')
})

await withHarness({ config: { speakShareRecentHours: 0 } }, async ({ harness, speak }) => {
  rand = 0
  harness.soulData.relation.lastUserAt = harness.clock.ms - 7 * 60 * 60_000
  harness.soulData.speak.lastUserAt = harness.soulData.relation.lastUserAt
  speak.queueShare({ text: '窗口 0 = 不限', ttlMinutes: 60 })
  const result = await speak.tick()
  eq('窗口 0 保持旧行为（可以分享）', result.trigger, 'share')
  eq('分享发出后消费', harness.soulData.speak.pendingShare, null)
})

await withHarness({ config: { speakProactiveRecentHours: 6 } }, async ({ harness, speak }) => {
  rand = 0
  harness.soulData.relation.lastUserAt = harness.clock.ms - 7 * 60 * 60_000
  harness.soulData.speak.lastUserAt = harness.soulData.relation.lastUserAt
  const result = await speak.tick()
  eq('普通主动窗口外 no-recent', result.done, 'no-recent')
  eq('普通主动窗口外不发送', harness.agents[mainBinding.sessionId].sent.length, 0)
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  speak.queueShare({ text: '第一次分享', strength: 0.6, ttlMinutes: 120 })
  const first = await speak.tick()
  eq('第一次分享命中', first.trigger, 'share')
  eq('分享单独记 shareCount', harness.soulData.speak.shareCount, 1)
  eq('分享不占普通主动 todayCount', harness.soulData.speak.todayCount, 0)
  eq('冷却从成功发送时算', harness.soulData.speak.lastShareAt, harness.clock.ms)
  eq('分享成功后消费 pendingShare', harness.soulData.speak.pendingShare, null)

  speak.queueShare({ text: '冷却内的第二条', ttlMinutes: 120 })
  const second = await speak.tick()
  ok('分享冷却内不再选 share', second.trigger !== 'share', second.trigger)
  eq('冷却内 pendingShare 不消费', harness.soulData.speak.pendingShare.text, '冷却内的第二条')
})

await withHarness({ config: { speakShareDailyCap: 1 } }, async ({ harness, speak }) => {
  rand = 0
  harness.soulData.speak.shareDayKey = localDayKey(harness.clock.now())
  harness.soulData.speak.shareCount = 1
  harness.soulData.speak.lastShareAt = 0
  speak.queueShare({ text: '额度用完的那条', ttlMinutes: 120 })
  const result = await speak.tick()
  ok('分享日上限挡住 share', result.trigger !== 'share', result.trigger)
  eq('到达分享日上限不消费 pendingShare', harness.soulData.speak.pendingShare.text, '额度用完的那条')
})

await withHarness({}, async ({ harness, speak }) => {
  rand = 0
  harness.emotionState.valence = -0.8
  harness.emotionState.arousal = 0.9
  const result = await speak.notifyWake()
  eq('醒来遇明显不适合 → emotion-unsuitable', result.done, 'emotion-unsuitable')
  eq('醒来不适合时不发送', harness.agents[mainBinding.sessionId].sent.length, 0)
})

// ---------------------------------------------------------------------------
section('queueShare 参数校验 / 默认值')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness, speak }) => {
  eq('空文本拒绝', speak.queueShare({ text: '   ' }).ok, false)
  eq('超长拒绝', speak.queueShare({ text: '字'.repeat(121) }).ok, false)
  const clamped = speak.queueShare({ text: '默认值', strength: 9, ttlMinutes: 1 })
  eq('strength 夹到 1', clamped.pendingShare.strength, 1)
  eq('ttl 最小 5 分钟', clamped.pendingShare.expiresAt - clamped.pendingShare.createdAt, 5 * 60_000)
  eq('source 默认 tool', clamped.pendingShare.source, 'tool')
  const overwritten = speak.queueShare({ text: '覆盖上一条' })
  eq('再次入队覆盖', overwritten.pendingShare.text, '覆盖上一条')
  eq('只保留一条', typeof harness.soulData.speak.pendingShare.text, 'string')
})

// ---------------------------------------------------------------------------
section('speak-api：simulate / preview / clearShare / fence')
// ---------------------------------------------------------------------------
async function callSpeakApi(harness, method, path, body, headers = {}) {
  const route = harness.webRoutes[0]
  if (!route) throw new Error('没有注册 speak-api')
  const stream = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  stream.method = method
  stream.url = path
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  const res = {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(text) { this.body = text ? JSON.parse(text) : null },
  }
  await route.handler(stream, res)
  return { status: res.status, body: res.body }
}

await withHarness({ installOptions: { life: { get: () => ({ state: 'awake' }) } } }, async ({ harness, speak }) => {
  const route = harness.webRoutes[0]
  ok('注册 prefix /dsh-aura/speak-api', route && route.kind === 'prefix' && route.path === '/dsh-aura/speak-api', route && { kind: route.kind, path: route.path })

  let out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'simulate', now: harness.clock.ms, stateOverride: 'play', emotionOverride: { valence: 0.6 } })
  eq('POST simulate 200', out.status, 200)
  eq('POST simulate ok', out.body.ok, true)
  eq('POST simulate 带 current/byState', ['current', 'byState', 'byDaypart', 'byValence', 'byTrigger', 'daily'].every(key => out.body[key] !== undefined), true)

  const saves = harness.soul.saves
  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'simulate' })
  eq('simulate 只读不写盘', harness.soul.saves, saves)

  out = await callSpeakApi(harness, 'GET', '/dsh-aura/speak-api?action=preview')
  eq('GET preview 200', out.status, 200)
  eq('GET preview 有 current', typeof out.body.current.line, 'number')

  speak.queueShare({ text: '面板清除我', ttlMinutes: 60 })
  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'clearShare' })
  eq('clearShare 200', out.status, 200)
  eq('clearShare cleared', out.body.cleared, true)
  eq('clearShare 后为空', out.body.share.pendingShare, null)

  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'nope' })
  eq('未知 action 400', out.status, 400)
  out = await callSpeakApi(harness, 'GET', '/dsh-aura/speak-api?action=nope')
  eq('未知 GET action 400', out.status, 400)
  out = await callSpeakApi(harness, 'PUT', '/dsh-aura/speak-api')
  eq('PUT 405', out.status, 405)
  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'simulate' }, { origin: 'http://evil.example' })
  eq('跨站 Origin 403', out.status, 403)
  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', { action: 'simulate' }, { host: 'evil.example:3080' })
  eq('非 loopback Host 403', out.status, 403)
  out = await callSpeakApi(harness, 'POST', '/dsh-aura/speak-api', 'not json')
  eq('坏 JSON 400', out.status, 400)
})

// ---------------------------------------------------------------------------
section('soul_share 工具')
// ---------------------------------------------------------------------------
await withHarness({}, async ({ harness }) => {
  const tool = harness.registeredTools.find(item => item.name === 'soul_share')
  ok('注册 soul_share', Boolean(tool), harness.registeredTools.map(item => item.name))

  let result = await tool.execute({ text: '刚看到一只猫，很像你', reason: '突然想到', strength: 0.7, ttlMinutes: 30 })
  eq('soul_share ok', result.ok, true)
  eq('工具写入 pendingShare', harness.soulData.speak.pendingShare.text, '刚看到一只猫，很像你')
  eq('工具 source', harness.soulData.speak.pendingShare.source, 'tool')
  eq('工具 strength', harness.soulData.speak.pendingShare.strength, 0.7)

  eq('工具拒绝空文本', (await tool.execute({ text: '' })).ok, false)
  eq('工具拒绝超长', (await tool.execute({ text: '字'.repeat(121) })).ok, false)
  harness.setConfig({ speakShareEnabled: false })
  eq('工具尊重分享欲开关', (await tool.execute({ text: '关了' })).ok, false)
})

// ---------------------------------------------------------------------------
section('life 钩子：plan/wake → queueShare')
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-aura-speak-share-'))
  const config = { speakShareEnabled: true }
  const fakeSpeak = {
    calls: [],
    queueShare(args) { this.calls.push(args); return { ok: true } },
  }
  const lifeState = { readConfig: () => ({ ...config }) }
  const lifeCtx = { get: () => undefined }
  const timers = { setInterval: () => 1, clearInterval: () => {} }
  const fixedNow = atLocal('20:00').getTime()
  const life = initLife({
    ctx: lifeCtx,
    state: lifeState,
    log: () => {},
    dir,
    now: () => fixedNow,
    random: () => 0,
    timers,
    autoSchedule: false,
    getSpeak: () => fakeSpeak,
  })
  try {
    life.plan({ state: 'play', activity: '听歌', wakeMode: 'open' })
    eq('plan 玩 + activity 入队', fakeSpeak.calls.length, 1)
    eq('分享强度 0.6', fakeSpeak.calls[0].strength, 0.6)
    eq('分享 ttl 120 分钟', fakeSpeak.calls[0].ttlMinutes, 120)
    eq('分享 source life', fakeSpeak.calls[0].source, 'life')
    ok('分享文本带活动', fakeSpeak.calls[0].text.includes('听歌'), fakeSpeak.calls[0].text)

    life.wake({ source: 'auto' })
    eq('wake 也入队', fakeSpeak.calls.length, 2)
    ok('wake 分享文案', fakeSpeak.calls[1].text.includes('刚醒'), fakeSpeak.calls[1].text)

    life.plan({ state: 'work', wakeMode: 'open' })
    eq('work 无 activity 不入队', fakeSpeak.calls.length, 2)

    life.plan({ state: 'awake', activity: '发呆', wakeMode: 'open' })
    eq('有 activity 就入队', fakeSpeak.calls.length, 3)

    config.speakShareEnabled = false
    life.plan({ state: 'play', activity: '听歌', wakeMode: 'open' })
    eq('分享欲关闭时 life 不入队', fakeSpeak.calls.length, 3)
  } finally {
    life.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
const total = passed + failures.length
console.log(`\n${failures.length ? '❌' : '✅'} 主动搭话自测完成：${passed}/${total} 通过，${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}${failure.detail === undefined ? '' : `: ${JSON.stringify(failure.detail)}`}`)
  }
  process.exitCode = 1
}
