/**
 * 语音闭环最后一跳（Host 半）：身体页 ASR 队列 → Aura 专用会话 → 回复交给身体说。
 *
 * 链路：
 *   body(3082) 唤醒词 → 录音 → 语音服务 ASR，把结果放进 /api/voice/pending（取一次即清空）
 *   → 本模块轮询（默认 1200ms）取走，逐条走 voiceUtterance(text)
 *   → 专用 voice 会话（sessionId `voice:body:<ts>`，不复用 QQ 会话；soul.js 的 isSoulSession 认得
 *     `voice:body:` 前缀，所以情绪/记忆/存档/关系与 QQ 会话一样生效）
 *   → sessionController.prompt(mode: 'queue') 走 Aura 的人格 / system prompt / 工具链
 *   → 监听该会话的 assistant/message（忽略 tool-call 中间消息，按 message id + 文本去重）
 *   → POST /api/say，让身体气泡 + TTS 说出来
 *
 * 失败哲学：body 没起 / 接口还没上时静默跳过（错误日志 5 分钟节流一次），不抛错、不影响 QQ 链路。
 * 会话里 Aura 的回复只走 /api/say，不进 QQ 出站：QQ bridge 只认自己的 sessionIds，天然隔离。
 *
 * 可调（环境变量，重启 dsh web 生效）：
 *   DSH_AURA_VOICE_BODY_URL   body server 根地址，默认 https://127.0.0.1:3082
 *   DSH_AURA_VOICE_POLL_MS    轮询间隔，默认 1200（夹取 300..60000）
 *   DSH_AURA_VOICE_DISABLE    =1 时不启动轮询（/dsh-aura/api/voice/utterance 仍可手测）
 * 也支持在 config.json 里写 voiceBodyBaseUrl / voicePollMs（state.normalizeConfig 会丢掉未知键，
 * 所以这两个键仅作为兜底读取，正式部署用默认值即可）。
 */
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const DEFAULT_BODY_URL = 'https://127.0.0.1:3082'
const DEFAULT_POLL_MS = 1200
const MIN_POLL_MS = 300
const MAX_POLL_MS = 60_000
const PENDING_TIMEOUT_MS = 2000 // 契约：pending 超时 2s
const SAY_TIMEOUT_MS = 5000
const PROMPT_TIMEOUT_MS = 60_000
const REPLY_COALESCE_MS = 500 // 同一回合里连续提交的文本合并成一次 say
const DUP_TEXT_WINDOW_MS = 3000 // 同文本重复 say 的抑制窗口（主要兜底没有 message id 的事件）
const SEEN_MESSAGE_WINDOW_MS = 120_000
const SEEN_MESSAGE_LIMIT = 80
const POLL_ERROR_LOG_INTERVAL_MS = 5 * 60_000 // 轮询失败日志节流，避免刷屏
const MAX_REPLY_CHARS = 2000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function envNumber(name) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** assistant/message 的 content → 纯文本（与 bridge.js 同一套规则，只取 text 部件）。 */
export function partsText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

/** 带 tool-call 的消息是「调工具前的中间叙述」，QQ 不发，语音也不念。 */
export function hasToolCall(content) {
  return Array.isArray(content) && content.some(part => part && (part.type === 'tool-call' || part.type === 'tool_call'))
}

/** 去掉不该念出来的标记：<skip>、表情标记、命令式尖括号块；压缩多余空行。 */
export function cleanSpokenText(text) {
  return String(text ?? '')
    .replace(/<skip>/gi, '')
    .replace(/\[表情[:：]\s*[^\]]+\](?:\(https?:\/\/[^\s)]+\))?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_REPLY_CHARS)
}

/**
 * 访问 body server 的 JSON API。
 * 自签名 HTTPS 用 rejectUnauthorized: false（只在这个 agent 里，不动全局 NODE_TLS_REJECT_UNAUTHORIZED）。
 */
export function requestJson(urlText, { method = 'GET', body, timeoutMs = PENDING_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(String(urlText))
    } catch (error) {
      reject(new Error(`非法 URL：${urlText}`))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`不支持的协议：${url.protocol}`))
      return
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method,
      timeout: timeoutMs,
      rejectUnauthorized: false,
      headers: {
        accept: 'application/json',
        ...(payload
          ? { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length }
          : {}),
      },
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size <= 1_000_000) chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = {}
        try {
          json = text ? JSON.parse(text) : {}
        } catch {
          json = { raw: text.slice(0, 300) }
        }
        const status = Number(response.statusCode) || 0
        if (status >= 200 && status < 300) resolve(json)
        else reject(new Error(`HTTP ${status}${json && json.message ? ' ' + json.message : ''}`))
      })
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

/**
 * 语音通道：轮询 body 队列 + 专用 Aura 会话 + 回复回传 /api/say。
 * 由 index.js installVoice({ctx, state, log, getConfig}) 创建并 start()，dispose() 清理。
 */
export class VoiceChannel {
  constructor({ ctx, state, log = () => {}, getConfig = () => ({}) }) {
    this.ctx = ctx
    this.state = state
    this.log = typeof log === 'function' ? log : () => {}
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.disposed = false
    this.sessionId = ''
    this.handle = null
    this.creating = null
    this.chain = Promise.resolve()
    this.pollTimer = null
    this.polling = false
    this.flushTimer = null
    this.pendingReplies = []
    this.seenMessages = new Map()
    this.lastPollLogAt = 0
    this.bodyUrl = ''
    this.pollIntervalMs = 0
    this.eventFloor = 0 // resume 时回放的历史 assistant/message（event.time 更早）不念
    this.lastSay = { text: '', at: 0 }
    this.stats = {
      startedAt: Date.now(),
      polls: 0,
      items: 0,
      utterances: 0,
      replies: 0,
      says: 0,
      lastPollAt: 0,
      lastPollOkAt: 0,
      lastPollError: '',
      lastPollErrorAt: 0,
      lastItemAt: 0,
      lastUtteranceAt: 0,
      lastUtteranceText: '',
      lastRequestId: '',
      lastReplyAt: 0,
      lastReplyText: '',
      lastSayAt: 0,
      lastSayText: '',
      lastSayError: '',
      lastSayErrorAt: 0,
      promptError: '',
      promptErrorAt: 0,
      sessionCreatedAt: 0,
    }
    // global：voice 会话由本模块 agents.create 创建，不在当前插件作用域里也要收到事件
    this.offSessionEvent = ctx.on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.log('[voice] 处理 session 事件失败:', messageOf(error))
      }
    }, { global: true })
  }

  /* ---------------------------------------------------------------- 配置 */

  /** 缓存解析结果：body 地址/轮询间隔在进程生命周期内固定（改 env 需重启 dsh web）。 */
  bodyBaseUrl() {
    if (!this.bodyUrl) this.bodyUrl = this.resolveBodyBaseUrl()
    return this.bodyUrl
  }

  resolveBodyBaseUrl() {
    const env = String(process.env.DSH_AURA_VOICE_BODY_URL || '').trim()
    if (env) return env.replace(/\/+$/, '')
    try {
      const raw = this.state?.readJson?.('config.json', {}) ?? {}
      const configured = String(raw?.voiceBodyBaseUrl || '').trim()
      if (configured) return configured.replace(/\/+$/, '')
    } catch { /* 配置读不到就用默认 */ }
    return DEFAULT_BODY_URL
  }

  pollMs() {
    if (!this.pollIntervalMs) this.pollIntervalMs = this.resolvePollMs()
    return this.pollIntervalMs
  }

  resolvePollMs() {
    const env = envNumber('DSH_AURA_VOICE_POLL_MS')
    if (env) return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(env)))
    try {
      const raw = this.state?.readJson?.('config.json', {}) ?? {}
      const configured = Number(raw?.voicePollMs)
      if (Number.isFinite(configured) && configured > 0) {
        return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(configured)))
      }
    } catch { /* ignore */ }
    return DEFAULT_POLL_MS
  }

  /* ---------------------------------------------------------------- 生命周期 */

  start() {
    if (this.disposed || this.pollTimer) return
    if (String(process.env.DSH_AURA_VOICE_DISABLE || '') === '1') {
      this.log('[voice] DSH_AURA_VOICE_DISABLE=1，跳过轮询（可手测 /dsh-aura/api/voice/utterance）')
      return
    }
    const interval = this.pollMs()
    this.pollTimer = setInterval(() => { void this.poll() }, interval)
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref()
    this.log(`[voice] 已启动轮询 ${this.bodyBaseUrl()}/api/voice/pending（${interval}ms）`)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingReplies = []
    try {
      this.offSessionEvent?.()
    } catch { /* ignore */ }
    this.offSessionEvent = null
    const handle = this.handle
    this.handle = null
    if (handle && typeof handle.dispose === 'function') {
      try {
        const pending = handle.dispose()
        if (pending && typeof pending.catch === 'function') {
          pending.catch(error => this.log('[voice] 释放语音会话失败:', messageOf(error)))
        }
      } catch (error) {
        this.log('[voice] 释放语音会话失败:', messageOf(error))
      }
    }
    this.log('[voice] 已停止')
  }

  /* ---------------------------------------------------------------- 轮询 */

  async poll() {
    if (this.disposed || this.polling) return
    this.polling = true
    const at = Date.now()
    try {
      const data = await requestJson(this.bodyBaseUrl() + '/api/voice/pending', { timeoutMs: PENDING_TIMEOUT_MS })
      this.stats.polls += 1
      this.stats.lastPollAt = at
      this.stats.lastPollOkAt = Date.now()
      this.stats.lastPollError = ''
      const items = Array.isArray(data?.items) ? data.items : []
      if (items.length) {
        this.stats.lastItemAt = Date.now()
        this.log(`[voice] 取到 ${items.length} 条语音文本`)
      }
      for (const item of items) {
        const text = cleanSpokenText(item?.text)
        if (!text) continue
        this.stats.items += 1
        this.enqueue(text, {
          id: String(item?.id ?? ''),
          model: item?.model,
          asrMs: item?.asrMs,
          at: item?.at,
          source: 'poll',
        })
      }
    } catch (error) {
      const message = messageOf(error)
      this.stats.lastPollError = message
      this.stats.lastPollErrorAt = at
      if (!this.lastPollLogAt || at - this.lastPollLogAt > POLL_ERROR_LOG_INTERVAL_MS) {
        this.lastPollLogAt = at
        this.log('[voice] 轮询 body 语音队列失败（静默重试）:', message)
      }
    } finally {
      this.polling = false
    }
  }

  /* ---------------------------------------------------------------- 入 Aura */

  /** 串行排队：一条语音说完/送进 Aura 后再处理下一条，保持顺序。 */
  enqueue(text, meta = {}) {
    this.chain = this.chain
      .then(() => this.voiceUtterance(text, meta))
      .catch(error => {
        this.stats.promptError = messageOf(error)
        this.stats.promptErrorAt = Date.now()
        this.log('[voice] 语音文本处理失败:', messageOf(error))
      })
    return this.chain
  }

  /**
   * 一条语音文本 → Aura 专用会话。
   * 返回 { ok, sessionId, requestId }（prompt 被接受即返回，不等整轮结束；回复由 session/event 捕获）。
   */
  async voiceUtterance(rawText, meta = {}) {
    const text = cleanSpokenText(rawText)
    if (!text) return { ok: false, error: 'text 不能为空' }
    if (this.disposed) return { ok: false, error: 'voice 通道已卸载' }
    const binding = await this.ensureSession()
    const controller = this.getController()
    if (!controller || typeof controller.prompt !== 'function') {
      throw new Error('没有 sessionController，无法把语音文本交给 Aura')
    }
    const requestId = 'voice-' + randomUUID()
    this.stats.lastRequestId = requestId
    this.stats.lastUtteranceAt = Date.now()
    this.stats.lastUtteranceText = text
    await controller.prompt({
      requestId,
      sessionId: binding.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
    this.stats.utterances += 1
    this.log(`[voice] 语音文本进入 Aura ${binding.sessionId}：${Array.from(text).length} 字${meta?.source === 'web-test' ? '（手测）' : ''}`)
    return { ok: true, sessionId: binding.sessionId, requestId }
  }

  /** web.js 只调一个入口；别名保持 voiceUtterance 命名与需求一致。 */
  async utterance(text, meta = {}) {
    return this.voiceUtterance(text, meta)
  }

  getController() {
    try {
      return this.ctx.get?.('sessionController')
    } catch {
      return undefined
    }
  }

  /* ---------------------------------------------------------------- 专用会话 */

  findLiveAgent(sessionId) {
    if (!sessionId) return undefined
    try {
      return this.ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  defaultCwd() {
    try {
      const config = this.getConfig() || {}
      if (typeof config.cwd === 'string' && config.cwd) return config.cwd
      const working = this.ctx.get?.('workingDirectory')
      if (working && typeof working.defaultDirectory === 'string' && working.defaultDirectory) {
        return working.defaultDirectory
      }
    } catch { /* 继续用进程目录 */ }
    return process.cwd()
  }

  /** 复用 bridge.js 的模型解析：配置优先，否则用 Chat 当前默认模型。 */
  resolveAgentOptions(config) {
    let provider = config.provider || ''
    let model = config.model || ''
    if (!provider || !model) {
      try {
        const selection = this.ctx.agentDefaultModel?.currentSelection?.()
        provider = provider || selection?.provider || ''
        model = model || selection?.model || ''
      } catch { /* ignore */ }
    }
    if (!provider || !model) {
      throw new Error('没有可用的默认模型：请先在 Chat 里选一个模型，或在面板填写 provider/model')
    }
    return { provider, model }
  }

  /** 复用 bridge.js 的预设挂载：语音会话和 QQ 会话用同一个 agentPreset（默认不挂）。 */
  presetSetup(config) {
    const preset = typeof config?.agentPreset === 'string' ? config.agentPreset.trim() : ''
    // 注意：宿主的 agent loop 会执行 (await setup(...))?.commit()，setup 必须返回 undefined 或带 commit() 的对象。
    return async (agentCtx) => {
      try {
        if (this.ctx.agentPresets?.mount) await this.ctx.agentPresets.mount(agentCtx, preset || undefined)
      } catch (error) {
        this.log('[voice] 挂载 Agent 预设失败:', messageOf(error))
      }
    }
  }

  withInitiator(call) {
    try {
      if (this.ctx.agents?.withoutInitiator) return this.ctx.agents.withoutInitiator(call)
    } catch { /* 没这个包装就直接建 */ }
    return call()
  }

  async ensureSession() {
    if (this.sessionId) {
      const live = this.findLiveAgent(this.sessionId)
      if (live) return { sessionId: this.sessionId, agent: live }
    }
    if (this.creating) return this.creating
    this.creating = this.createOrResumeSession().finally(() => { this.creating = null })
    return this.creating
  }

  async createOrResumeSession() {
    const config = this.getConfig() || {}
    const agentOptions = this.resolveAgentOptions(config)
    const setup = this.presetSetup(config)
    // 先尝试恢复上次的 voice 会话；进程重启后 agent 不在了走重建。
    if (this.sessionId) {
      const resumeId = this.sessionId
      const resumeStartedAt = Date.now()
      try {
        const handle = await this.withInitiator(() => this.ctx.agents.resume({
          resumeSessionId: resumeId,
          agentOptions,
          setup,
        }))
        if (!handle?.agent) throw new Error('恢复结果没有 agent')
        this.handle = handle
        // resume 会把会话历史里的 assistant/message 重新投递一遍：低于这个时间点的旧消息不念
        this.eventFloor = resumeStartedAt
        this.log(`[voice] 恢复语音会话 ${resumeId}`)
        return { sessionId: resumeId, agent: handle.agent }
      } catch (error) {
        this.log('[voice] 恢复语音会话失败（将重建）:', messageOf(error))
        this.sessionId = ''
        this.handle = null
      }
    }
    const sessionId = `voice:body:${Date.now()}`
    const cwd = this.defaultCwd()
    const preset = typeof config.agentPreset === 'string' ? config.agentPreset.trim() : ''
    const handle = await this.withInitiator(() => this.ctx.agents.create({
      sessionId,
      meta: {
        cwd,
        ...(preset ? { agentPreset: preset } : {}),
      },
      agentOptions,
      setup,
    }))
    if (!handle?.agent) throw new Error('创建语音会话没有返回 agent')
    this.handle = handle
    this.sessionId = sessionId
    this.stats.sessionCreatedAt = Date.now()
    this.log(`[voice] 新建语音会话 ${sessionId}`)
    return { sessionId, agent: handle.agent }
  }

  /* ---------------------------------------------------------------- 回复捕获 */

  onSessionEvent(session, event) {
    if (this.disposed || !event || event.type !== 'assistant/message') return
    if (!this.sessionId) return
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    if (sessionId !== this.sessionId) return
    // resume 回放：旧事件的 time 早于本次 resume 起点，不重复念
    const eventTime = typeof event.time === 'string' ? Date.parse(event.time) : Number(event.time)
    if (this.eventFloor && Number.isFinite(eventTime) && eventTime < this.eventFloor) return
    const message = event?.data?.message ?? {}
    const content = message.content
    if (hasToolCall(content)) return // 工具调用前的中间叙述：不念
    const text = cleanSpokenText(partsText(content))
    if (!text) return
    // 同一个 message 在 replay/多监听下会重复投递：按 id 去重（没 id 的按文本+时间窗兜底）
    const messageId = String(message.id ?? message.messageId ?? event?.data?.id ?? '')
    const now = Date.now()
    if (messageId) {
      const seenAt = this.seenMessages.get(messageId)
      if (seenAt && now - seenAt < SEEN_MESSAGE_WINDOW_MS) return
      this.seenMessages.set(messageId, now)
      if (this.seenMessages.size > SEEN_MESSAGE_LIMIT) {
        for (const [key, at] of this.seenMessages) {
          if (now - at > SEEN_MESSAGE_WINDOW_MS) this.seenMessages.delete(key)
        }
      }
    } else if (this.lastReplyText === text && now - this.lastReplyAt < 3000) {
      return
    }
    this.stats.replies += 1
    this.stats.lastReplyAt = now
    this.stats.lastReplyText = text
    this.queueReply(text)
  }

  queueReply(text) {
    this.pendingReplies.push(text)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushReplies()
    }, REPLY_COALESCE_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  async flushReplies() {
    if (this.disposed) return
    const raw = this.pendingReplies.join('\n')
    this.pendingReplies = []
    const text = cleanSpokenText(raw)
    if (!text) return
    const now = Date.now()
    // 同一条回复重复 say（事件重放 / 多监听）只念一次
    if (this.lastSay.text === text && now - this.lastSay.at < DUP_TEXT_WINDOW_MS) return
    this.lastSay = { text, at: now }
    await this.say(text)
  }

  async say(text) {
    const url = this.bodyBaseUrl() + '/api/say'
    try {
      const result = await requestJson(url, {
        method: 'POST',
        body: { text, source: 'aura' },
        timeoutMs: SAY_TIMEOUT_MS,
      })
      this.stats.says += 1
      this.stats.lastSayAt = Date.now()
      this.stats.lastSayText = text
      this.stats.lastSayError = ''
      if (result && result.ok === false) {
        const error = String(result.message || result.reason || 'blocked')
        this.stats.lastSayError = error
        this.stats.lastSayErrorAt = Date.now()
        this.log('[voice] /api/say 被拒:', error)
        return { ok: false, error }
      }
      this.log(`[voice] 身体说：${Array.from(text).length} 字`)
      return { ok: true, result }
    } catch (error) {
      this.stats.lastSayError = messageOf(error)
      this.stats.lastSayErrorAt = Date.now()
      this.log('[voice] /api/say 失败（忽略）:', this.stats.lastSayError)
      return { ok: false, error: this.stats.lastSayError }
    }
  }

  /* ---------------------------------------------------------------- 排查 */

  snapshot() {
    const sessionId = this.sessionId || ''
    const agent = this.findLiveAgent(sessionId)
    return {
      ok: !this.disposed,
      enabled: !this.disposed && !!this.pollTimer,
      bodyUrl: this.bodyBaseUrl(),
      pollMs: this.pollMs(),
      sessionId: sessionId || null,
      hasAgent: !!agent,
      pendingReplies: this.pendingReplies.length,
      lastSay: this.lastSay.text ? { text: this.lastSay.text, at: this.lastSay.at } : null,
      stats: { ...this.stats },
    }
  }
}

/** index.js 入口：挂载即启动轮询；返回的实例带 dispose()。 */
export function installVoice({ ctx, state, log, getConfig }) {
  const channel = new VoiceChannel({ ctx, state, log, getConfig })
  channel.start()
  return channel
}
