/**
 * 语音闭环最后一跳（Host 半）：身体页 ASR 队列 → Aura 专用会话 → 回复交给身体说。
 *
 * 链路：
 *   body(3082) 唤醒词 → 录音 → 语音服务 ASR，把结果放进 /api/voice/pending（取一次即清空）
 *   → 本模块轮询（默认 1200ms）取走，逐条走 voiceUtterance(text)
 *   → 专用 voice 会话（sessionId `voice:body:<ts>`，不复用 QQ 会话；soul.js 的 isSoulSession 认得
 *     `voice:body:` 前缀，所以情绪/记忆/存档/关系与 QQ 会话一样生效）
 *   → sessionController.prompt(mode: 'queue') 走 Aura 的人格 / system prompt / 工具链
 *   → 监听所有会话的 assistant/message（忽略 tool-call 中间消息，按 message id + 文本去重）
 *   → 按 body 的 tts.replyScope 判断该会话要不要念（all/aura/web/channel，默认 aura）
 *   → 再按 tts.replyMode（auto/prefer-call/call-only/off）决定自动说还是跳过
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
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

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
const BODY_CONFIG_TTL_MS = 5000 // body tts.replyMode/replyScope 缓存
const SKIP_LOG_INTERVAL_MS = 60_000 // off/call-only 跳过日志节流
/** 视为「Aura 已显式让身体说话」的工具（prefer-call 模式据此抑制自动 say）。 */
const EXPLICIT_SAY_TOOLS = new Set(['body_say', 'soul_say', 'soul_voice'])

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
  constructor({ ctx, state, log = () => {}, getConfig = () => ({}), resolveMeme = null }) {
    this.resolveMeme = typeof resolveMeme === 'function' ? resolveMeme : null
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
    this.seenMessages = new Map()
    this.lastPollLogAt = 0
    this.bodyUrl = ''
    this.pollIntervalMs = 0
    this.eventFloor = 0 // resume 时回放的历史 assistant/message（event.time 更早）不念
    this.lastSay = { text: '', at: 0 }
    this.lastExplicitBySession = new Map() // sessionId -> 最近一次显式 body_say/soul_say/soul_voice 时间
    this.lastEventTimeBySession = new Map() // sessionId -> 已见过的最新事件时间（过滤 resume 回放）
    this.replyBuckets = new Map() // sessionId -> { texts, timer }：同回合合并，不同会话分开
    this.lastSayBySession = new Map() // sessionId -> { text, at }：同文本重复 say 去重
    this.lastSkipLogAt = 0
    this.bodyConfigCache = null
    this.stats = {
      startedAt: Date.now(),
      polls: 0,
      items: 0,
      utterances: 0,
      replies: 0,
      says: 0,
      skippedByScope: 0,
      skippedByMode: 0,
      skippedByAge: 0,
      lastReplyScope: 'aura',
      lastReplyMode: 'auto',
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
    for (const bucket of this.replyBuckets.values()) {
      if (bucket.timer) clearTimeout(bucket.timer)
      bucket.timer = null
    }
    this.replyBuckets.clear()
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

  /* ---------------------------------------------------------------- 回复捕获（全会话 + 输出范围） */

  isChannelSession(sessionId) {
    return typeof sessionId === 'string' && (sessionId.startsWith('qq:') || sessionId.startsWith('voice:'))
  }

  /**
   * tts.replyScope 判定（Aura 自己算，不问 body）：
   *   channel = qq: / voice: 会话
   *   webAura = soulSessionIds 包含该会话，或全局 soulWebEnabled 且不是渠道会话
   *   aura（默认）= channel || webAura；all = 全部
   */
  sessionMatchesScope(sessionId, scope) {
    const id = String(sessionId || '')
    if (!id) return false
    if (scope === 'all') return true
    const channel = this.isChannelSession(id)
    if (scope === 'channel') return channel
    const config = this.getConfig() || {}
    const ids = String(config.soulSessionIds || '').split(',').map(part => part.trim()).filter(Boolean)
    const webAura = ids.includes(id) || (config.soulWebEnabled === true && !channel)
    if (scope === 'web') return webAura && !channel
    return channel || webAura
  }

  /** 记一次「Aura 显式让身体说话」（prefer-call 模式 12s 内不再自动 say）。 */
  markExplicit(sessionId) {
    const key = String(sessionId || '')
    if (!key) return
    const now = Date.now()
    this.lastExplicitBySession.set(key, now)
    if (this.lastExplicitBySession.size > 512) {
      for (const [id, at] of this.lastExplicitBySession) {
        if (now - at > 120_000) this.lastExplicitBySession.delete(id)
      }
    }
  }

  /** body 的语音输出配置（tts.replyMode / tts.replyScope），缓存 5s；body 不可达时 fail-open。 */
  async bodyVoiceConfig() {
    const now = Date.now()
    if (this.bodyConfigCache && now - this.bodyConfigCache.at < BODY_CONFIG_TTL_MS) return this.bodyConfigCache.value
    const value = { mode: 'auto', scope: 'aura' }
    try {
      const cfg = await requestJson(this.bodyBaseUrl() + '/api/config', { timeoutMs: 2000 })
      const mode = String(cfg?.tts?.replyMode || 'auto')
      const scope = String(cfg?.tts?.replyScope || 'aura')
      if (['auto', 'prefer-call', 'call-only', 'off'].includes(mode)) value.mode = mode
      if (['all', 'aura', 'web', 'channel'].includes(scope)) value.scope = scope
    } catch { /* body 不在：保持默认 */ }
    this.bodyConfigCache = { at: now, value }
    return value
  }

  /** 兼容旧调用：只取回复模式。 */
  async replyMode() {
    return (await this.bodyVoiceConfig()).mode
  }

  /** 把一张本地图片推给 body 页面显示（表情包） */
  async pushMemePath(path, sessionId, caption = '') {
    const now = Date.now()
    if (this.memeSentAt && this.memeSentAt.get(path) && now - this.memeSentAt.get(path) < 10000) return
    try {
      const buf = await readFile(path)
      if (!buf.length || buf.length > 8 * 1024 * 1024) return
      const ext = extname(path).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif'
          : ext === '.webp' ? 'image/webp'
            : ext === '.bmp' ? 'image/bmp' : 'image/png'
      await requestJson(this.bodyBaseUrl() + '/api/meme', {
        method: 'POST',
        body: { imageBase64: buf.toString('base64'), mimeType: mime, caption: String(caption || '').slice(0, 200), sessionId },
        timeoutMs: 5000,
      })
      if (!this.memeSentAt) this.memeSentAt = new Map()
      this.memeSentAt.set(path, now)
      if (this.memeSentAt.size > 200) {
        for (const [key, at] of this.memeSentAt) if (now - at > 60000) this.memeSentAt.delete(key)
      }
      this.log('[voice] 表情包已同步给身体：' + path.slice(-40))
    } catch { /* 发图失败不影响主链路 */ }
  }

  /** dsh_im_return_file / 发图工具把本地图片同步给身体页（Q表情包显示） */
  async forwardMemeImage(event, sessionId) {
    const name = String(event && event.data && event.data.name || '')
    if (name !== 'dsh_im_return_file') return
    let args = event && event.data && event.data.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { return }
    }
    if (!args || typeof args !== 'object') return
    const path = String(args.path || args.file || args.filePath || args.imagePath || '').trim()
    if (!path || path.length > 500) return
    await this.pushMemePath(path, sessionId, args.caption || '')
  }

  onSessionEvent(session, event) {
    if (this.disposed || !event || typeof event.type !== 'string') return
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    if (!sessionId) return
    if (event.type === 'tool/call') {
      if (EXPLICIT_SAY_TOOLS.has(event?.data?.name)) this.markExplicit(sessionId)
      if (event?.data?.name === 'dsh_im_return_file') void this.forwardMemeImage(event, sessionId)
      return
    }
    if (event.type !== 'assistant/message') return
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    // 过滤历史/回放：早于本次挂载、早于 resume 起点、或早于该会话已见过的最新事件都不念
    const eventTime = typeof event.time === 'string' ? Date.parse(event.time) : Number(event.time)
    if (Number.isFinite(eventTime)) {
      const floor = Math.max(this.stats.startedAt - 60_000, sessionId === this.sessionId ? this.eventFloor : 0)
      const previous = this.lastEventTimeBySession.get(sessionId) || 0
      if (eventTime < floor || eventTime < previous) {
        this.stats.skippedByAge = (this.stats.skippedByAge || 0) + 1
        return
      }
      this.lastEventTimeBySession.set(sessionId, Math.max(previous, eventTime))
    }
    const message = event?.data?.message ?? {}
    const content = message.content
    // 助手消息里带 body_say 等显式说话工具：记一次（prefer-call 用）
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue
        const isCall = part.type === 'tool-call' || part.type === 'tool_call'
        if (isCall && EXPLICIT_SAY_TOOLS.has(part.name)) this.markExplicit(sessionId)
      }
    }
    if (hasToolCall(content)) return // 工具调用前的中间叙述：不念
    const rawText = partsText(content)
    const markerRe = /\[表情[:：]\s*([^\]]{1,80})\]/g
    const markers = []
    let m
    while ((m = markerRe.exec(rawText)) !== null) markers.push(m[1].trim())
    if (markers.length && this.resolveMeme) {
      for (const desc of markers) {
        void this.resolveMeme(desc).then((hit) => {
          if (hit && hit.path) this.pushMemePath(hit.path, sessionId, hit.caption || desc)
        }).catch(() => {})
      }
    }
    const text = cleanSpokenText(rawText)
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
    void this.handleReply(sessionId, text)
  }

  /** 判定某会话的这条最终文本要不要念（scope + mode），再进合并队列。 */
  async handleReply(sessionId, text) {
    if (this.disposed) return
    try {
      const cfg = await this.bodyVoiceConfig()
      this.stats.lastReplyScope = cfg.scope
      this.stats.lastReplyMode = cfg.mode
      if (!this.sessionMatchesScope(sessionId, cfg.scope)) {
        this.stats.skippedByScope = (this.stats.skippedByScope || 0) + 1
        return
      }
      if (cfg.mode === 'off' || cfg.mode === 'call-only') {
        this.stats.skippedByMode = (this.stats.skippedByMode || 0) + 1
        const now = Date.now()
        if (!this.lastSkipLogAt || now - this.lastSkipLogAt > SKIP_LOG_INTERVAL_MS) {
          this.lastSkipLogAt = now
          this.log(`[voice] 回复模式 ${cfg.mode}，跳过自动说话`)
        }
        return
      }
      if (cfg.mode === 'prefer-call') {
        const explicitAt = this.lastExplicitBySession.get(String(sessionId || '')) || 0
        if (explicitAt && Date.now() - explicitAt < 12000) {
          this.stats.skippedByMode = (this.stats.skippedByMode || 0) + 1
          return
        }
      }
      this.queueReply(sessionId, text)
    } catch (error) {
      this.log('[voice] 回复判定失败（忽略）:', messageOf(error))
    }
  }

  /** 同一会话同一回合里 500ms 内连续提交的文本合并成一次 say；不同会话分开。 */
  queueReply(sessionId, text) {
    const key = String(sessionId || '')
    let bucket = this.replyBuckets.get(key)
    if (!bucket) {
      bucket = { texts: [], timer: null }
      this.replyBuckets.set(key, bucket)
    }
    bucket.texts.push(text)
    if (bucket.timer) return
    bucket.timer = setTimeout(() => {
      bucket.timer = null
      const raw = bucket.texts.join('\n')
      bucket.texts = []
      if (this.replyBuckets.get(key) === bucket) this.replyBuckets.delete(key)
      void this.flushReplies(raw, key)
    }, REPLY_COALESCE_MS)
    if (typeof bucket.timer.unref === 'function') bucket.timer.unref()
  }

  async flushReplies(rawText, sessionId = '') {
    if (this.disposed) return
    const text = cleanSpokenText(rawText)
    if (!text) return
    const key = String(sessionId || '')
    const now = Date.now()
    // 同一条回复重复 say（事件重放 / 多监听）只念一次；按会话分别去重
    const last = this.lastSayBySession.get(key)
    if (last && last.text === text && now - last.at < DUP_TEXT_WINDOW_MS) return
    this.lastSayBySession.set(key, { text, at: now })
    if (this.lastSayBySession.size > 256) {
      for (const [id, item] of this.lastSayBySession) {
        if (now - item.at > 600_000) this.lastSayBySession.delete(id)
      }
    }
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
      pendingReplies: [...this.replyBuckets.values()].reduce((sum, bucket) => sum + bucket.texts.length, 0),
      lastReplyScope: this.stats.lastReplyScope,
      lastReplyMode: this.stats.lastReplyMode,
      skipped: {
        scope: this.stats.skippedByScope,
        mode: this.stats.skippedByMode,
        age: this.stats.skippedByAge,
      },
      lastSay: this.lastSay.text ? { text: this.lastSay.text, at: this.lastSay.at } : null,
      stats: { ...this.stats },
    }
  }
}

/** index.js 入口：挂载即启动轮询；返回的实例带 dispose()。 */
export function installVoice({ ctx, state, log, getConfig, resolveMeme }) {
  const channel = new VoiceChannel({ ctx, state, log, getConfig, resolveMeme })
  channel.start()
  return channel
}

