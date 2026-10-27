#!/usr/bin/env node
/**
 * QQ 桥离线自测：不联网、不建会话、不发真消息。
 *
 * 覆盖：
 * - splitSegments：空/空白、关闭拆分、默认空行、自定义正则、非法正则回退、段落清理
 * - fitSegments：预算内（同一引用）、正好等于预算、超出合并尾段、budget<1、空数组
 * - deliverText：<skip>/skip/[skip]/SILENCE 吞掉且不吃额度、正文里的 <skip> 摘除后再发、
 *   正常分段发送（seq/msgId）、达到 maxMessages 后丢弃、fitSegments 合并、2000 码点截断
 * - requestRethink（soul_say）：未绑定 / 窗口过期 / cap=0 / 正常 ok + 800ms 后 followup 一次、
 *   followup 的 source.kind=system 与 role=user 形状、hint 透传、超过 cap 拒绝且不排定时器
 * - 旧 say：发送与 seq、额度用尽抛错、cap 内 1200ms 后追加一轮
 *
 * 运行（插件目录下）：node dev/bridge-selftest.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */
import { ChannelBridge, splitSegments, fitSegments } from '../host/bridge.js'

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

const quiet = () => {}

// ---------------------------------------------------------------- fake timers

/** 手动时钟：接管 setTimeout/clearTimeout，交给测试驱动（unref 标记可选记录）。 */
function createClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  const timers = new Map()
  let nextId = 0
  let now = Date.now()
  let installed = false

  const fakeSetTimeout = (fn, ms = 0, ...args) => {
    const id = ++nextId
    const delay = Math.max(0, Number(ms) || 0)
    const entry = { id, fn, args, delay, due: now + delay, cleared: false, fired: false, unrefed: false }
    entry.unref = () => { entry.unrefed = true; return entry }
    timers.set(id, entry)
    return entry
  }

  const fakeClearTimeout = handle => {
    if (!handle) return
    const id = typeof handle === 'object' ? handle.id : handle
    const entry = timers.get(id)
    if (entry) entry.cleared = true
  }

  async function drain() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    await new Promise(resolve => real.setTimeout(resolve, 0))
  }

  return {
    install() {
      if (installed) return
      globalThis.setTimeout = fakeSetTimeout
      globalThis.clearTimeout = fakeClearTimeout
      installed = true
    },
    restore() {
      if (!installed) return
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      installed = false
    },
    reset() {
      timers.clear()
      now = Date.now()
    },
    pending() {
      return [...timers.values()].filter(entry => !entry.cleared && !entry.fired)
    },
    /** 前进指定毫秒，按到期顺序同步触发（含回调里新排的定时器）。 */
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0)
      let guard = 0
      for (;;) {
        const due = [...timers.values()]
          .filter(entry => !entry.cleared && !entry.fired && entry.due <= now)
          .sort((left, right) => left.due - right.due || left.id - right.id)
        if (!due.length) break
        guard += 1
        if (guard > 50) throw new Error('fake timers 触发次数异常')
        const entry = due[0]
        entry.fired = true
        entry.fn(...entry.args)
        await drain()
      }
    },
  }
}

const clock = createClock()

// ---------------------------------------------------------------- fake 环境

const BASE_CONFIG = {
  splitEnabled: true,
  splitRegex: '\\n{2,}',
  maxMessages: 4,
  soulSayMaxRounds: 1,
  steerEnabled: true,
  cwd: '/tmp/dsh-aura-selftest',
}

function makeRig(options = {}) {
  const config = { ...BASE_CONFIG, ...(options.config || {}) }
  const sessions = { ...(options.sessions || {}) }
  const state = {
    readConfig: () => ({ ...config }),
    readSessions: () => sessions,
    writeSessions: map => { for (const [key, value] of Object.entries(map)) sessions[key] = value },
    patchConfig: next => { Object.assign(config, next) },
    configStore: config,
    sessionsStore: sessions,
  }

  const sends = { text: [], media: [] }
  const qq = {
    status: () => ({ online: true }),
    async sendText(payload) { sends.text.push(payload); return { ok: true } },
    async sendMedia(payload) { sends.media.push(payload); return { ok: true } },
  }

  const outbound = []
  const logs = []
  const events = []
  const agents = new Map()
  const disposers = []
  const ctx = {
    on(event, handler, opts) {
      events.push({ event, handler, opts })
      const dispose = () => {}
      disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'workingDirectory') return { defaultDirectory: process.cwd() }
      return undefined
    },
    agents: { get: sessionId => agents.get(sessionId) },
  }

  const bridge = new ChannelBridge({ ctx, state, qq, log: (...args) => logs.push(args.join(' ')) })
  bridge.addOutboundHook(record => { outbound.push(record) })

  return { bridge, ctx, state, qq, sends, outbound, logs, agents, events, config, sessions }
}

/** 建一条活跃绑定：sessionId ↔ (kind/chatId) + 被动窗口上下文。 */
function bindChat(rig, options = {}) {
  const kind = options.kind || 'dm'
  const chatId = options.chatId || '10001'
  const key = `${kind}:${chatId}`
  const sessionId = options.sessionId || 'session-1'
  const msgId = options.msgId === undefined ? 'msg-1' : options.msgId
  const context = {
    key,
    kind,
    chatId,
    msgId,
    seq: options.seq ?? 0,
    expiresAt: Date.now() + (options.expiresInMs ?? 60_000),
    sessionId,
    ...(options.sayRounds === undefined ? {} : { sayRounds: options.sayRounds }),
  }
  rig.bridge.sessionIds.set(sessionId, { kind, chatId, key })
  rig.bridge.contexts.set(key, context)
  const chat = { key, kind, chatId }
  return { chat, context, sessionId }
}

/** 注册一个能接收 followup 的假 agent（session.id 供 bridge 反查）。 */
function attachAgent(rig, sessionId) {
  const calls = []
  const agent = {
    session: { id: sessionId },
    status: 'idle',
    async followup(message) { calls.push(message) },
  }
  rig.agents.set(sessionId, agent)
  return { agent, calls, exec: { agent } }
}

async function expectThrows(name, fn, matcher) {
  try {
    await fn()
    ok(name, false, 'expected throw')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hit = matcher === undefined ? true : (typeof matcher === 'function' ? matcher(message) : message.includes(matcher))
    ok(name, hit, message)
  }
}

// ---------------------------------------------------------------- 纯函数：splitSegments

function testSplitSegments() {
  section('splitSegments')

  eq('空字符串 → []', splitSegments(''), [])
  eq('纯空白 → []', splitSegments('   \n\t  '), [])
  eq('null/undefined → []', [splitSegments(null), splitSegments(undefined)], [[], []])

  eq('默认空行拆分三段', splitSegments('a\n\nb\n\nc'), ['a', 'b', 'c'])
  eq('单个换行不拆（保留原换行）', splitSegments('a\nb'), ['a\nb'])
  eq('首尾空行不产生空段', splitSegments('\n\na\n\nb\n\n'), ['a', 'b'])
  eq('关闭拆分 → 整段一条', splitSegments('a\n\nb', { splitEnabled: false }), ['a\n\nb'])
  eq('自定义正则 \\n 拆分', splitSegments('a\nb\nc', { splitRegex: '\\n' }), ['a', 'b', 'c'])
  eq('空 splitRegex 回退默认空行', splitSegments('a\n\nb', { splitRegex: '' }), ['a', 'b'])
  eq('非法正则回退整段', splitSegments('a\n\nb', { splitRegex: '[' }), ['a\n\nb'])
  eq('非法量词正则回退整段', splitSegments('a\n\nb', { splitRegex: '**' }), ['a\n\nb'])
  eq('拆分后各段 trim', splitSegments('  a  \n\n\t b \t'), ['a', 'b'])
  eq('拆不出两段时返回原文（不返回空数组）', splitSegments(' 只有一段 '), ['只有一段'])
  eq('两段之间隔多个空行也只拆一次', splitSegments('a\n\n\n\nb'), ['a', 'b'])
}

// ---------------------------------------------------------------- 纯函数：fitSegments

function testFitSegments() {
  section('fitSegments')

  const within = ['a', 'b']
  eq('预算内原样返回（同一引用）', fitSegments(within, 4) === within, true)
  eq('正好等于预算也不合并', fitSegments(['a', 'b'], 2), ['a', 'b'])
  eq('超出预算：头部保留、尾部合并到最后一条', fitSegments(['a', 'b', 'c', 'd'], 2), ['a', 'b\n\nc\n\nd'])
  eq('budget<1 视作 1：全部合并', fitSegments(['a', 'b', 'c'], 0), ['a\n\nb\n\nc'])
  eq('budget<1 且只有两段', fitSegments(['a', 'b'], -3), ['a\n\nb'])
  eq('budget=1 三段合并', fitSegments(['a', 'b', 'c'], 1), ['a\n\nb\n\nc'])
  eq('空数组保持空', fitSegments([], 3), [])
  eq('合并后条数等于预算', fitSegments(['a', 'b', 'c', 'd', 'e'], 3).length, 3)
}

// ---------------------------------------------------------------- deliverText：沉默词

const SKIP_WORDS = ['<skip>', 'skip', '[skip]', 'SILENCE', 'silence', ' <skip> \n']

async function testDeliverTextSkip() {
  section('deliverText · 沉默词')

  for (const word of SKIP_WORDS) {
    clock.reset()
    const rig = makeRig()
    const { chat, context } = bindChat(rig)
    await rig.bridge.deliverText(chat, word, 'session-1')
    ok(`「${word.trim()}」被吞掉（不发送）`, rig.sends.text.length === 0, rig.sends.text)
    eq(`「${word.trim()}」不消耗消息额度`, context.seq, 0)
    eq(`「${word.trim()}」出站记录为 skip`, rig.outbound.map(item => item.kind), ['skip'])
  }

  // 正文里的 <skip>：摘掉标记继续发，而不是整轮静默
  clock.reset()
  const rig = makeRig()
  const { chat } = bindChat(rig)
  await rig.bridge.deliverText(chat, '先这样 <skip> 我去忙了', 'session-1')
  eq('正文内 <skip> 摘除后仍发送一条', rig.sends.text.length, 1)
  ok('发出的文本不含 <skip>', !rig.sends.text[0].text.includes('<skip>'), rig.sends.text[0].text)
  ok('发出的文本保留正文', rig.sends.text[0].text.includes('我去忙了'), rig.sends.text[0].text)
}

// ---------------------------------------------------------------- deliverText：分段/预算

async function testDeliverTextSplitAndBudget() {
  section('deliverText · 分段与预算')

  clock.reset()
  let rig = makeRig()
  let { chat, context } = bindChat(rig)
  await rig.bridge.deliverText(chat, 'a\n\nb\n\nc', 'session-1')
  eq('默认按空行拆成 3 条', rig.sends.text.map(item => item.text), ['a', 'b', 'c'])
  eq('seq 依次递增 1/2/3', rig.sends.text.map(item => item.seq), [1, 2, 3])
  eq('每条都带被动 msgId', rig.sends.text.map(item => item.msgId), ['msg-1', 'msg-1', 'msg-1'])
  eq('上下文 seq 累计到 3', context.seq, 3)

  // 关闭拆分：整条发
  clock.reset()
  rig = makeRig({ config: { splitEnabled: false } })
  ;({ chat } = bindChat(rig))
  await rig.bridge.deliverText(chat, 'a\n\nb', 'session-1')
  eq('splitEnabled=false 只发一条整段', rig.sends.text.map(item => item.text), ['a\n\nb'])

  // 超出剩余额度：fitSegments 合并尾段，条数不超预算
  clock.reset()
  rig = makeRig({ config: { maxMessages: 2 } })
  ;({ chat } = bindChat(rig))
  await rig.bridge.deliverText(chat, 'a\n\nb\n\nc', 'session-1')
  eq('maxMessages=2：只发 2 条', rig.sends.text.length, 2)
  eq('第 2 条是合并后的尾段', rig.sends.text[1].text, 'b\n\nc')

  // 预算用尽：丢弃，不再发
  clock.reset()
  rig = makeRig({ config: { maxMessages: 2 } })
  ;({ chat, context } = bindChat(rig, { seq: 2 }))
  await rig.bridge.deliverText(chat, '还想说一句', 'session-1')
  eq('预算用尽后丢弃（0 条）', rig.sends.text.length, 0)
  eq('丢弃后 seq 不变', context.seq, 2)
  ok('丢弃会记日志', rig.logs.some(line => line.includes('条数已达上限')), rig.logs)

  // 剩余额度 1：多余段落合并成一条
  clock.reset()
  rig = makeRig({ config: { maxMessages: 4 } })
  ;({ chat } = bindChat(rig, { seq: 3 }))
  await rig.bridge.deliverText(chat, '一\n\n二\n\n三', 'session-1')
  eq('剩余 1 条额度 → 三段合并成 1 条', rig.sends.text.map(item => item.text), ['一\n\n二\n\n三'])

  // 2000 码点截断（emoji 不切代理对）
  clock.reset()
  rig = makeRig()
  ;({ chat } = bindChat(rig))
  await rig.bridge.deliverText(chat, '字'.repeat(2500), 'session-1')
  eq('超长文本压到 2000 码点', Array.from(rig.sends.text[0].text).length, 2000)
  ok('截断后没有孤立代理对', !rig.sends.text[0].text.includes('\uFFFD'), '')

  // 默认 maxMessages（缺省 4）
  clock.reset()
  rig = makeRig({ config: { maxMessages: undefined } })
  ;({ chat } = bindChat(rig))
  await rig.bridge.deliverText(chat, 'a\n\nb\n\nc\n\nd\n\ne', 'session-1')
  eq('缺省 maxMessages 按 4 条', rig.sends.text.length, 4)
}

// ---------------------------------------------------------------- requestRethink / soul_say

async function testRequestRethink() {
  section('soul_say / requestRethink')

  // 未绑定 QQ 聊天
  clock.reset()
  let rig = makeRig()
  let { exec } = attachAgent(rig, 'session-x')
  let result = await rig.bridge.requestRethink(exec, '')
  eq('未绑定 → ok:false', result.ok, false)
  ok('未绑定 → 有错误文案', typeof result.error === 'string' && result.error.length > 0, result.error)
  eq('未绑定 → 不排定时器', clock.pending().length, 0)

  // 已绑定但窗口过期
  clock.reset()
  rig = makeRig()
  bindChat(rig, { expiresInMs: -1 })
  ;({ exec } = attachAgent(rig, 'session-1'))
  result = await rig.bridge.requestRethink(exec, '')
  eq('窗口过期 → ok:false', result.ok, false)
  ok('窗口过期 → 错误文案提到窗口', String(result.error || '').includes('窗口'), result.error)
  eq('窗口过期 → 不排定时器', clock.pending().length, 0)

  // 已绑定、窗口在，但 soulSayMaxRounds=0
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: 0 } })
  let bound = bindChat(rig)
  ;({ exec } = attachAgent(rig, bound.sessionId))
  result = await rig.bridge.requestRethink(exec, '')
  eq('soulSayMaxRounds=0 → ok:false', result.ok, false)
  ok('soulSayMaxRounds=0 → 错误文案提到 0', /0/.test(String(result.error || '')), result.error)
  eq('soulSayMaxRounds=0 → 不排定时器', clock.pending().length, 0)
  eq('soulSayMaxRounds=0 → 不消耗轮数', bound.context.sayRounds, undefined)

  // 正常路径：ok + 800ms 后 followup 一次
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: 2 } })
  bound = bindChat(rig)
  let attached = attachAgent(rig, bound.sessionId)
  result = await rig.bridge.requestRethink(attached.exec, '想再补一句')
  eq('正常 → ok:true', result.ok, true)
  eq('正常 → queued:true', result.queued, true)
  eq('正常 → round=1', result.round, 1)
  eq('正常 → cap=2', result.cap, 2)
  eq('初始不发送任何 QQ 消息', rig.sends.text.length, 0)
  eq('排了 1 个定时器', clock.pending().length, 1)
  eq('定时器 800ms', clock.pending()[0].delay, 800)
  eq('定时器已 unref', clock.pending()[0].unrefed, true)

  await clock.advance(799)
  eq('799ms 时还没 followup', attached.calls.length, 0)
  await clock.advance(1)
  eq('800ms 后 followup 恰好一次', attached.calls.length, 1)

  const message = attached.calls[0]
  eq('followup role=user', message.role, 'user')
  eq('followup source.kind=system', message.source.kind, 'system')
  ok('followup source.rpcId 是 qq-rethink 前缀', String(message.source.rpcId).startsWith('qq-rethink-'), message.source.rpcId)
  eq('followup 有唯一 id（同 requestId）', message.id, message.source.rpcId)
  eq('followup 内容是单个 text part', message.content.map(part => part.type), ['text'])
  const followupText = message.content[0].text
  ok('followup 文本含 <skip> 指令', followupText.includes('<skip>'), followupText)
  ok('followup 文本透传 hint', followupText.includes('想再补一句'), followupText)
  ok('followup 文本不再排轮/别解释', /不要解释/.test(followupText), followupText)
  eq('followup 不会让桥发 QQ 文本', rig.sends.text.length, 0)

  // 超过 cap
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: 2 } })
  bound = bindChat(rig)
  attached = attachAgent(rig, bound.sessionId)
  await rig.bridge.requestRethink(attached.exec, '')
  await rig.bridge.requestRethink(attached.exec, '')
  eq('cap=2 时前两次都 ok（round 1/2）', [clock.pending().length, bound.context.sayRounds], [2, 2])
  const third = await rig.bridge.requestRethink(attached.exec, '')
  eq('超过 cap → ok:false', third.ok, false)
  ok('超过 cap → 错误文案提到上限', /上限/.test(String(third.error || '')), third.error)
  eq('超过 cap → 不多排定时器', clock.pending().length, 2)

  await clock.advance(800)
  eq('两个成功轮次各 followup 一次', attached.calls.length, 2)

  // 窗口在排定时器后过期 → 回调静默跳过（Date.now 是真的，手动把窗口改成已过期）
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: 1 } })
  bound = bindChat(rig, { expiresInMs: 60_000 })
  attached = attachAgent(rig, bound.sessionId)
  await rig.bridge.requestRethink(attached.exec, '')
  eq('排定时器时窗口还在', bound.context.expiresAt > Date.now(), true)
  bound.context.expiresAt = Date.now() - 1
  await clock.advance(800)
  eq('定时器触发时窗口已过期 → 不 followup', attached.calls.length, 0)

  // soulSayMaxRounds 缺省（0）时也不追加
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: undefined } })
  bound = bindChat(rig)
  attached = attachAgent(rig, bound.sessionId)
  result = await rig.bridge.requestRethink(attached.exec, '')
  eq('缺省 soulSayMaxRounds → 不追加', result.ok, false)
}

// ---------------------------------------------------------------- 旧 say

async function testLegacySay() {
  section('旧 say')

  clock.reset()
  let rig = makeRig({ config: { maxMessages: 2, soulSayMaxRounds: 1 } })
  let bound = bindChat(rig)
  let attached = attachAgent(rig, bound.sessionId)
  const said = await rig.bridge.say('  我再补一句  ', attached.exec)
  eq('say → ok:true', said.ok, true)
  eq('say → seq=1', said.seq, 1)
  eq('say → 文本已 trim', said.text, '我再补一句')
  eq('say 实际发出一条 QQ 文本', rig.sends.text.map(item => item.text), ['我再补一句'])
  eq('say 带被动 msgId 与 seq', [rig.sends.text[0].msgId, rig.sends.text[0].seq], ['msg-1', 1])
  eq('cap>0 时排了追加推理定时器', [clock.pending().length, clock.pending()[0]?.delay], [1, 1200])
  await clock.advance(1200)
  eq('1200ms 后 followup 一次', attached.calls.length, 1)
  ok('say 的 followup 也带 <skip> 指令', attached.calls[0].content[0].text.includes('<skip>'), attached.calls[0].content[0].text)

  // 额度用尽：say 抛错而不是静默
  clock.reset()
  rig = makeRig({ config: { maxMessages: 2 } })
  bound = bindChat(rig, { seq: 2 })
  attached = attachAgent(rig, bound.sessionId)
  await expectThrows('say 额度用尽 → 抛错', () => rig.bridge.say('还发吗', attached.exec), '上限')
  eq('say 额度用尽 → 不发消息', rig.sends.text.length, 0)

  // 空文本
  clock.reset()
  rig = makeRig()
  bound = bindChat(rig)
  attached = attachAgent(rig, bound.sessionId)
  await expectThrows('say 空文本 → 抛错', () => rig.bridge.say('   ', attached.exec), '不能为空')

  // cap=0：照发，但不追加推理
  clock.reset()
  rig = makeRig({ config: { soulSayMaxRounds: 0 } })
  bound = bindChat(rig)
  attached = attachAgent(rig, bound.sessionId)
  const plain = await rig.bridge.say('只说这一句', attached.exec)
  eq('cap=0 → 仍可 say', plain.ok, true)
  eq('cap=0 → 不排定时器', clock.pending().length, 0)

  // 未绑定
  clock.reset()
  rig = makeRig()
  attached = attachAgent(rig, 'session-none')
  await expectThrows('say 未绑定 → 抛错', () => rig.bridge.say('hi', attached.exec), '绑定')
}

// ---------------------------------------------------------------- 收尾

async function main() {
  console.log('QQ 桥离线自测（fake state / fake qq / fake ctx / fake timers）')
  clock.install()
  try {
    testSplitSegments()
    testFitSegments()
    await testDeliverTextSkip()
    await testDeliverTextSplitAndBudget()
    await testRequestRethink()
    await testLegacySay()
  } finally {
    clock.restore()
  }

  const total = passed + failures.length
  console.log('')
  if (failures.length) {
    console.error(`❌ bridge-selftest：${failures.length}/${total} 失败`)
    for (const failure of failures) {
      console.error(`   - ${failure.name}${failure.detail === undefined ? '' : ': ' + JSON.stringify(failure.detail)}`)
    }
    process.exit(1)
  }
  console.log(`✅ bridge-selftest：${passed}/${total} 断言全通过`)
}

await main()
