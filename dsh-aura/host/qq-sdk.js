/**
 * QQ 渠道传输层（腾讯官方 SDK 版）。
 *
 * 只负责「连通性」：WS 长连接、token、收消息、发文字/富媒体、主动消息、断线恢复。
 * 会话、拆句、出站顺序、表情包接缝、主动搭话节奏仍是 Aura 自己的 bridge 逻辑，
 * 因此本文件只把 SDK 的事件/方法翻译成 QQClient 契约（见 host/qq.js 顶部注释）。
 *
 * 依赖：@tencent-connect/qqbot-nodejs（MIT，dsh-im 的 QQ 通道用的同一个 SDK）。
 */
import { QQBot, MediaFileType, MsgType } from '@tencent-connect/qqbot-nodejs'

const READY_TIMEOUT_MS = 20_000

/** QQ 文本里的平台标记：face 表情、@ 提及等，bridge 不需要这些结构。 */
export function cleanInboundText(text) {
  return String(text ?? '')
    .replace(/<faceType=[^>]*>/gi, '')
    .replace(/<@!?[0-9a-zA-Z_-]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 平台入站消息 → Aura bridge 的事件形状。 */
export function mapInboundMessage(message) {
  if (!message || typeof message !== 'object') return undefined
  const kind = message.kind === 'group' ? 'group' : message.kind === 'c2c' ? 'dm' : undefined
  if (!kind) return undefined
  const target = message.replyTarget || {}
  const chatId = String(target.targetId || message.groupOpenid || '')
  if (!chatId) return undefined
  const rawContent = String(message.content ?? '')
  const text = cleanInboundText(rawContent)
  const at = Date.parse(message.timestamp)
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
      .filter(item => item && typeof item.url === 'string' && item.url)
      .map(item => ({
        url: item.url,
        contentType: String(item.content_type || ''),
        filename: String(item.filename || ''),
        size: Number(item.size) || 0,
        asrText: String(item.asr_refer_text || ''),
      }))
    : []
  return {
    kind,
    chatId,
    userId: String(message.senderId || ''),
    msgId: String(message.messageId || ''),
    text,
    attachments,
    faceOnly: text === '' && /<faceType=/i.test(rawContent),
    timestampMs: Number.isFinite(at) ? at : Date.now(),
    rawType: String(message.rawEventType || (kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE')),
  }
}

/** bridge 的 (kind, chatId, msgId) → SDK 的 ReplyTarget（有 msgId 为被动回复，无则主动消息）。 */
export function buildReplyTarget({ kind, chatId, msgId } = {}) {
  if (!chatId) throw new Error('缺少 QQ chatId')
  const scope = kind === 'group' ? 'group' : 'c2c'
  const target = { scope, targetId: String(chatId) }
  if (msgId) target.msgId = String(msgId)
  return target
}

export class QQClient {
  constructor(options = {}) {
    this.options = options
    this.log = typeof options.log === 'function' ? options.log : (...args) => console.log('[dsh-aura]', ...args)
    this.bot = null
    this.ready = false
    this.started = false
    this.startedAt = 0
    this.lastError = ''
    this.lastEventAt = 0
    this._readyWaiter = null
    this._messageHandler = null
    this._startedResolve = null
  }

  status() {
    return {
      online: this.ready === true,
      ready: this.ready === true,
      startedAt: this.startedAt || undefined,
      lastError: this.lastError || undefined,
      lastEventAt: this.lastEventAt || undefined,
      impl: 'sdk',
    }
  }

  _emitStatus() {
    try { this.options.onStatus?.(this.status()) } catch { /* ignore */ }
  }

  async start() {
    if (this.started) return this.status()
    const cfg = typeof this.options.getConfig === 'function' ? this.options.getConfig() : {}
    if (!cfg?.appId || !cfg?.appSecret) throw new Error('尚未配置 QQ 机器人 AppID / AppSecret')
    this.startedAt = Date.now()
    this.started = true
    this.lastError = ''
    // SDK 的 logger 是对象接口（info/error/warn/debug），不是单个函数
    const sdkLogger = {
      info: (msg, meta) => this.log('[qq-sdk]', msg, meta && Object.keys(meta).length ? meta : ''),
      error: (msg, meta) => this.log('[qq-sdk:error]', msg, meta && Object.keys(meta).length ? meta : ''),
      warn: (msg, meta) => this.log('[qq-sdk:warn]', msg, meta && Object.keys(meta).length ? meta : ''),
      debug: () => {},
    }
    const bot = new QQBot({
      appId: String(cfg.appId),
      appSecret: String(cfg.appSecret),
      logger: sdkLogger,
    })
    this.bot = bot
    bot.on('ready', () => {
      this.ready = true
      this._emitStatus()
      this._readyWaiter?.resolve()
      this._readyWaiter = null
    })
    bot.on('resumed', () => {
      this.ready = true
      this._emitStatus()
    })
    bot.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this._emitStatus()
    })
    this._messageHandler = (ctx, message) => {
      this.lastEventAt = Date.now()
      const event = mapInboundMessage(message)
      const hasMedia = Array.isArray(event?.attachments) && event.attachments.length > 0
      if (!event || (!event.text && !hasMedia && !event.faceOnly)) {
        this.log(`[qq] 忽略无文本消息 ${event?.rawType || message?.rawEventType || ''}`)
        return
      }
      try {
        void Promise.resolve(this.options.onEvent?.(event)).catch(error => {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.log('[qq] 事件处理失败:', this.lastError)
        })
      } catch (error) {
        this.log('[qq] 事件处理失败:', error instanceof Error ? error.message : error)
      }
    }
    bot.on('message', this._messageHandler)

    const ready = new Promise((resolve, reject) => {
      this._readyWaiter = { resolve, reject }
    })
    // SDK 的 start() 是长驻连接：到 stop 才结束，所以不 await 它
    void bot.start().catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.ready = false
      this._emitStatus()
      this._readyWaiter?.reject(new Error(this.lastError || 'QQ 连接失败'))
      this._readyWaiter = null
    })
    let timer
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(this.lastError || 'QQ 连接超时（20s 未 READY）')), READY_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this._emitStatus()
      try { bot.stop() } catch { /* ignore */ }
      this.bot = null
      this.started = false
      this.ready = false
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    this._emitStatus()
    return this.status()
  }

  async stop() {
    this.started = false
    this.ready = false
    this._readyWaiter?.reject(new Error('已停止'))
    this._readyWaiter = null
    const bot = this.bot
    this.bot = null
    if (bot) {
      try { bot.stop() } catch (error) {
        this.log('[qq] 停止 SDK 连接失败:', error instanceof Error ? error.message : error)
      }
    }
    this._emitStatus()
  }

  async sendText({ kind, chatId, msgId = null, text } = {}) {
    if (!this.bot) throw new Error('QQ 未连接，无法发送')
    const target = buildReplyTarget({ kind, chatId, msgId })
    const content = String(text ?? '')
    if (!content) return
    try {
      await this.bot.sendText(target, content)
    } catch (error) {
      // markdown 能力被拒时回退纯文本（QQ 平台 50055/50056/50057）
      const code = Number(error?.code ?? error?.errCode ?? error?.status)
      if (code === 50055 || code === 50056 || code === 50057) {
        this.log(`[qq] markdown 被拒（${code}），回退纯文本`)
        await this.bot.send({ target, msgType: MsgType.TEXT, content })
        return
      }
      throw error
    }
  }

  async sendMedia({ kind, chatId, msgId = null, bytes, name, image = false } = {}) {
    if (!this.bot) throw new Error('QQ 未连接，无法发送')
    const target = buildReplyTarget({ kind, chatId, msgId })
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || [])
    if (!buffer.length) throw new Error('媒体内容为空')
    await this.bot.sendMedia({
      target,
      fileType: image ? MediaFileType.IMAGE : MediaFileType.FILE,
      buffer,
      fileName: String(name || (image ? 'image.png' : 'file.bin')),
    })
  }
}
