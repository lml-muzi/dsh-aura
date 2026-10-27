/**
 * QQ ↔ DSH 会话桥：入站消息驱动 agent 回合，出站把助手回复拆句/发图回 QQ。
 *
 * 关键设计：
 * - 一个 QQ 聊天绑定一个 DSH 会话；会话里 user/message 的 source.rpcId 用 `qq-<uuid>`，
 *   这样 dsh-meme 的 IM 识别（IM_RPC_ID_RE）会命中，它会把候选图路径交给
 *   dsh_im_return_file，而不是让模型写 [表情: 描述] 标记。
 * - 出站不等回合彻底结束：assistant/message 一提交就发，保证「先图后文」的图能在
 *   dsh_im_return_file 执行时立刻发出（QQ 被动回复同一 msgId 最多 5 条，用 seq 计数）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extractMemeMarkers } from './meme-index.js'
import { basename, isAbsolute, resolve as resolvePath, sep } from 'node:path'

const PASSIVE_WINDOW_MS = 5 * 60 * 1000
const QQ_TEXT_LIMIT = 2000 // QQ markdown 上限：按码点 2000
const MAX_FILE_BYTES = 30 * 1024 * 1024
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

function codepointClamp(text, max = QQ_TEXT_LIMIT) {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

function partsText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

function hasToolCall(content) {
  return Array.isArray(content) && content.some(part => part && (part.type === 'tool-call' || part.type === 'tool_call'))
}

export function splitSegments(text, config = {}) {
  const source = String(text ?? '').trim()
  if (!source) return []
  if (config.splitEnabled === false) return [source]
  let pieces
  try {
    pieces = source.split(new RegExp(config.splitRegex || '\\n{2,}', 'g'))
  } catch {
    pieces = [source]
  }
  const cleaned = pieces.map(piece => piece.trim()).filter(Boolean)
  return cleaned.length > 1 ? cleaned : [source]
}

/** 段数超过本轮剩余条数时，把多出来的段落并进最后一条，避免被 QQ 拒绝。 */
export function fitSegments(segments, budget) {
  const limit = Math.max(1, budget)
  if (segments.length <= limit) return segments
  const head = segments.slice(0, limit - 1)
  const merged = segments.slice(limit - 1).join('\n\n')
  return [...head, merged]
}

/** 把入站图片下载到工作区，返回本地路径（失败记入 failures）。 */
async function downloadAttachments(attachments, cwd, log) {
  const paths = []
  const failures = []
  if (!Array.isArray(attachments) || attachments.length === 0) return { paths, failures }
  const dir = resolvePath(cwd, '.dsh-aura-incoming')
  try { mkdirSync(dir, { recursive: true }) } catch (error) {
    log('[qq] 创建入站图片目录失败:', error instanceof Error ? error.message : error)
    return { paths, failures: attachments.map(() => 'directory') }
  }
  let index = 0
  for (const item of attachments) {
    index += 1
    try {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('empty')
      const type = String(item.contentType || '')
      const extension = type.includes('png') ? '.png'
        : type.includes('gif') ? '.gif'
          : type.includes('webp') ? '.webp'
            : type.includes('jpeg') || type.includes('jpg') ? '.jpg'
              : (item.filename && /.[a-z0-9]{2,5}$/i.test(item.filename) ? item.filename.slice(item.filename.lastIndexOf('.')) : '.jpg')
      const name = 'qq-' + Date.now() + '-' + index + extension
      const target = resolvePath(dir, name)
      writeFileSync(target, bytes)
      paths.push(target)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      log('[qq] 入站图片下载失败:', error instanceof Error ? error.message : error)
    }
  }
  return { paths, failures }
}

/** 按字节判断图片真实类型（QQ 的 content_type 经常是 octet-stream 或错的）。 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const head = bytes.subarray(0, 6).toString('ascii')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

function extensionOfMediaType(mediaType, fallbackName = '') {
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/gif') return '.gif'
  if (mediaType === 'image/webp') return '.webp'
  const match = /\.[a-z0-9]{2,5}$/i.exec(String(fallbackName || ''))
  return match ? match[0].toLowerCase() : '.bin'
}

/** 下载入站附件并嗅探类型；图片返回可直接交给 Host prompt API 的 base64 部件。 */
async function readIncomingAttachments(attachments, log) {
  const images = []
  const files = []
  const failures = []
  if (!Array.isArray(attachments) || attachments.length === 0) return { images, files, failures }
  let index = 0
  for (const item of attachments) {
    index += 1
    try {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('empty')
      const mediaType = sniffImageMediaType(bytes)
      const declared = String(item.contentType || '')
      if (mediaType) {
        images.push({
          type: 'image',
          data: bytes.toString('base64'),
          mediaType,
          name: item.filename || ('qq-' + Date.now() + '-' + index + extensionOfMediaType(mediaType)),
        })
      } else {
        files.push({ bytes, name: item.filename || ('qq-' + Date.now() + '-' + index + extensionOfMediaType(declared, item.filename)) })
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      log('[qq] 入站附件下载失败:', error instanceof Error ? error.message : error)
    }
  }
  return { images, files, failures }
}

function samePath(left, right) {
  if (!left || !right) return false
  const norm = path => path.replace(/[\\/]+$/, '')
  return sep === '\\'
    ? norm(left).toLowerCase() === norm(right).toLowerCase()
    : norm(left) === norm(right)
}

function looksLikeImage(name, bytes) {
  const dot = String(name).lastIndexOf('.')
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : ''
  if (IMAGE_EXT.has(ext)) return true
  if (!bytes || bytes.length < 12) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true // png
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true // jpg
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true // gif
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return true
  return false
}

export class ChannelBridge {
  constructor({ ctx, state, qq, log }) {
    this.ctx = ctx
    this.state = state
    this.qq = qq
    this.log = log
    this.disposed = false
    this.contexts = new Map() // chatKey -> { kind, chatId, msgId, seq, expiresAt, sessionId }
    this.sessionIds = new Map() // sessionId -> { kind, chatId, key }
    this.handles = new Map() // sessionId -> agent handle
    this.lastEventAt = 0
    this.lastAssistantAt = 0
    this.lastActiveByKey = new Map()
    this.mediaSentAt = new Map() // sessionId -> 最近一次工具发图时间（避免 marker 重复发）
    // hooks 集合（取代单槽 onInbound，避免多个模块互相覆盖）
    this.inboundHooks = new Set()
    this.outboundHooks = new Set()
    this.onInbound = null // 兼容旧 emotion.js；新模块一律用 addInboundHook
    this.pendingProactive = new Map() // sessionId -> { at, reason }
    this.textFilter = null // 主动轮出站前的文本闸（由 speak.checkProactiveText 注入）
    this.offSessionEvent = ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    }, { global: true })
  }

  addInboundHook(fn) {
    if (typeof fn !== 'function') return () => {}
    this.inboundHooks.add(fn)
    return () => this.inboundHooks.delete(fn)
  }

  addOutboundHook(fn) {
    if (typeof fn !== 'function') return () => {}
    this.outboundHooks.add(fn)
    return () => this.outboundHooks.delete(fn)
  }

  /** 标记“这一轮是主动搭话触发的”，出站回调与失败降级据此区分。 */
  markProactive(sessionId, info = {}) {
    if (!sessionId) return
    this.pendingProactive.set(String(sessionId), { at: Date.now(), ...info })
  }

  takeProactive(sessionId) {
    const value = this.pendingProactive.get(String(sessionId))
    if (value) this.pendingProactive.delete(String(sessionId))
    return value
  }

  setTextFilter(fn) {
    this.textFilter = typeof fn === 'function' ? fn : null
  }

  notifyOutbound(payload) {
    for (const hook of this.outboundHooks) {
      try { hook(payload) } catch (error) {
        this.log('[qq] outbound hook 失败:', error instanceof Error ? error.message : error)
      }
    }
  }

  handleOf(sessionId) {
    const agent = this.findLiveAgent(sessionId) || this.handles.get(sessionId)?.agent
    const chat = this.chatOfSession(sessionId)
    return agent && chat ? { agent, chat, sessionId } : undefined
  }

  passiveWindowActive(chatKey) {
    const context = this.contexts.get(chatKey)
    return !!(context && context.expiresAt > Date.now())
  }

  recentChats() {
    return this.bindings().sort((left, right) => (right.lastActiveAt || 0) - (left.lastActiveAt || 0))
  }

  chatOfSession(sessionId) {
    const known = this.sessionIds.get(sessionId)
    if (known) return known
    try {
      for (const [key, record] of Object.entries(this.state.readSessions())) {
        if (!record || record.sessionId !== sessionId) continue
        const chat = { kind: record.kind || 'dm', chatId: record.chatId || '', key }
        this.sessionIds.set(sessionId, chat)
        return chat
      }
    } catch { /* ignore */ }
    return undefined
  }

  /** 更新会话活跃时间，主动打扰用它判断“多久没聊了”。 */
  touchRecord(chat) {
    try {
      const sessions = this.state.readSessions()
      const record = sessions[chat.key]
      if (!record) return
      record.updatedAt = new Date().toISOString()
      this.state.writeSessions(sessions)
    } catch { /* ignore */ }
  }

  stats() {
    return {
      sessions: this.sessionIds.size,
      contexts: this.contexts.size,
      lastEventAt: this.lastEventAt || undefined,
      lastAssistantAt: this.lastAssistantAt || undefined,
    }
  }

  isOnline() {
    try {
      return this.qq.status?.()?.online === true
    } catch {
      return false
    }
  }

  bindings() {
    const out = [...this.sessionIds.entries()].map(([sessionId, chat]) => ({
      sessionId,
      kind: chat.kind,
      chatId: chat.chatId,
      key: chat.key,
      lastActiveAt: this.lastActiveByKey.get(chat.key) || this.lastEventAt || 0,
    }))
    // 重启后内存映射是空的：把 sessions.json 里绑过的聊天也纳入（冷会话，speak 用 schedule 兜底）
    try {
      const seen = new Set(out.map(item => item.sessionId))
      for (const [key, record] of Object.entries(this.state.readSessions())) {
        if (!record || typeof record.sessionId !== 'string' || !record.sessionId || seen.has(record.sessionId)) continue
        out.push({
          sessionId: record.sessionId,
          kind: record.kind || 'dm',
          chatId: record.chatId || '',
          key,
          lastActiveAt: Number.isFinite(Date.parse(record.updatedAt)) ? Date.parse(record.updatedAt) : 0,
          cold: true,
        })
      }
    } catch { /* ignore */ }
    return out
  }

  /** 主动打扰挑一个会话：优先内存里最近互动的；重启后没有内存绑定就回退到 sessions.json。 */
  pickProactiveTarget() {
    let best = null
    for (const entry of this.bindings()) {
      if (!best || entry.lastActiveAt > best.lastActiveAt) best = entry
    }
    if (best) return best
    try {
      for (const [key, record] of Object.entries(this.state.readSessions())) {
        if (!record || typeof record.sessionId !== 'string' || !record.sessionId) continue
        const lastActiveAt = Number.isFinite(Date.parse(record.updatedAt)) ? Date.parse(record.updatedAt) : 0
        const entry = { sessionId: record.sessionId, kind: record.kind || 'dm', chatId: record.chatId || '', lastActiveAt }
        if (!best || lastActiveAt > best.lastActiveAt) best = entry
      }
    } catch { /* ignore */ }
    return best
  }

  /** QQ 客户端回调入口：一条入站私聊/群聊消息。 */
  async handleEvent(event) {
    if (this.disposed) return
    const kind = event.kind === 'group' ? 'group' : 'dm'
    const chatId = String(event.chatId || '')
    if (!chatId) return
    const rawText = String(event.text || '').trim()
    const attachments = Array.isArray(event.attachments) ? event.attachments : []
    const faceOnly = event.faceOnly === true
    if (!rawText && attachments.length === 0 && !faceOnly) {
      this.log(`[qq] 忽略无文本消息 ${event.rawType || ''}`)
      return
    }
    const key = `${kind}:${chatId}`
    this.lastEventAt = Date.now()
    let text = rawText
    let incoming = { images: [], files: [], failures: [] }
    if (attachments.length > 0) incoming = await readIncomingAttachments(attachments, this.log)
    if (faceOnly && !text && incoming.images.length === 0 && incoming.files.length === 0) text = '（用户发来一个 QQ 表情）'
    const title = [...(rawText || (attachments.length ? '[图片]' : '表情'))].slice(0, 20).join('')
    this.lastActiveByKey.set(key, this.lastEventAt)
    this.contexts.set(key, {
      key,
      kind,
      chatId,
      msgId: event.msgId,
      seq: 0,
      expiresAt: Date.now() + PASSIVE_WINDOW_MS,
      sessionId: undefined,
    })
    try {
      const chat = { key, kind, chatId }
      if (typeof this.onInbound === 'function') this.onInbound(event, chat)
      for (const hook of this.inboundHooks) {
        try { hook(event, chat) } catch (error) {
          this.log('[qq] inbound hook 失败:', error instanceof Error ? error.message : error)
        }
      }
    } catch (error) {
      this.log('[qq] 入站 hook 失败:', error instanceof Error ? error.message : error)
    }
    try {
      const binding = await this.getOrCreateBinding(kind, chatId, title)
      const context = this.contexts.get(key)
      if (context) context.sessionId = binding.sessionId
      const requestId = `qq-${randomUUID()}`
      const bridgeConfig = this.state.readConfig()
      const steerEnabled = bridgeConfig.steerEnabled !== false
      const running = binding.agent?.status === 'running'
      const steer = steerEnabled && running && typeof binding.agent?.steer === 'function'
      let accepted = false
      // 有图片时走 Host 的 prompt 附件通道：图片以 image content part 进入上下文，
      // Host 负责校验/归一化/持久化（和 im-connect、dsh-im 的做法一致），而不是丢一个路径给模型。
      if (incoming.images.length > 0) {
        let controller
        try { controller = this.ctx.get?.('sessionController') } catch { controller = undefined }
        if (controller && typeof controller.prompt === 'function') {
          const content = []
          const caption = [text, incoming.failures.length ? `（有 ${incoming.failures.length} 张图片下载失败）` : ''].filter(Boolean).join('\n')
          if (caption) content.push({ type: 'text', text: caption })
          content.push(...incoming.images)
          try {
            await controller.prompt({ requestId, sessionId: binding.sessionId, mode: steer ? 'steer' : 'queue', content }, AbortSignal.timeout(30_000))
            accepted = true
          } catch (error) {
            const reason = error?.details?.reason
            this.log('[qq] 图片 prompt 被拒:', reason || (error instanceof Error ? error.message : error))
            if (reason !== 'MODEL_DOES_NOT_SUPPORT_IMAGES') throw error
          }
        }
      }
      if (!accepted) {
        // 兜底：模型不支持视觉 / 没有 sessionController 时，落盘 + 路径文本（扩展名用字节嗅探结果）
        if (incoming.images.length > 0 || incoming.files.length > 0) {
          const dir = resolvePath(this.defaultCwd(), '.dsh-aura-incoming')
          try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
          const saved = []
          for (const image of incoming.images) {
            try {
              const name = 'qq-' + Date.now() + '-' + saved.length + extensionOfMediaType(image.mediaType)
              const target = resolvePath(dir, name)
              writeFileSync(target, Buffer.from(image.data, 'base64'))
              saved.push(target)
            } catch (error) {
              this.log('[qq] 图片落盘失败:', error instanceof Error ? error.message : error)
            }
          }
          for (const file of incoming.files) {
            try {
              const target = resolvePath(dir, String(file.name || ('qq-' + Date.now())))
              writeFileSync(target, file.bytes)
              saved.push(target)
            } catch (error) {
              this.log('[qq] 文件落盘失败:', error instanceof Error ? error.message : error)
            }
          }
          const parts = [text]
          if (saved.length > 0) {
            parts.push(`（用户发来 ${saved.length} 个附件，已保存到：`)
            parts.push(...saved.map(path => '- ' + path))
            parts.push('需要时用 read_image 查看。）')
          }
          if (incoming.failures.length > 0) parts.push(`（有 ${incoming.failures.length} 个附件下载失败）`)
          text = parts.filter(Boolean).join('\n')
        }
        const message = {
          id: requestId,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: requestId },
        }
        // 正在回复时插队：steer 会插到当前回合的下一个 step，而不是排到下一轮。
        if (steer) {
          try {
            binding.agent.steer(message)
            this.log(`[qq] 插队消息已进入当前回合 ${chat.key}`)
          } catch (error) {
            this.log('[qq] 插队失败，改为排队:', error instanceof Error ? error.message : error)
            await binding.agent.followup(message)
          }
        } else {
          // followup 可能同步抛错或返回 rejected promise：不 await + catch 会变成 unhandled rejection
          await binding.agent.followup(message)
        }
      }
      this.touchRecord({ key, kind, chatId })
      this.log(`[qq] 入站 ${kind}/${chatId} → ${binding.sessionId}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[qq] 入站处理失败: ${detail}`, error instanceof Error ? error.stack : '')
      await this.sendNotice(kind, chatId, `处理失败：${detail}`).catch(() => undefined)
    }
  }

  async sendNotice(kind, chatId, text) {
    const context = this.contexts.get(`${kind}:${chatId}`)
    const seq = context ? ++context.seq : 1
    await this.qq.sendText({ kind, chatId, msgId: context?.msgId ?? null, seq, text })
  }

  onSessionEvent(session, event) {
    if (this.disposed || !event || event.type !== 'assistant/message') return
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const chat = this.chatOfSession(sessionId)
    if (!chat) return
    const content = event?.data?.message?.content
    if (hasToolCall(content)) return // 工具调用前的中间叙述不发到 QQ
    const text = partsText(content).trim()
    if (!text) return
    this.deliverText(chat, text, sessionId).catch(error => {
      this.log('[qq] 出站失败:', error instanceof Error ? error.message : error)
    })
  }

  async deliverText(chat, text, sessionId = '') {
    const config = this.state.readConfig()
    const raw = String(text ?? '')
    // 模型可以用 <skip> 表示“这一轮不想说话”
    if (/^<?(skip|silence)>?$|^\[skip\]$/i.test(raw.trim())) {
      this.log(`[qq] 模型选择沉默（<skip>） ${chat.key}`)
      if (sessionId) this.takeProactive(sessionId)
      this.notifyOutbound({ chat, kind: 'skip', proactive: false })
      return
    }
    const cleaned = raw.replace(/<skip>/gi, '').trim()
    if (!cleaned) return
    const proactive = sessionId ? this.takeProactive(sessionId) : undefined
    // 表情标记：[表情: 描述] 在 Web 端由 dsh-meme 前端渲染成内联图；
    // QQ 端在这里解析成图库文件、用原生图片发出，然后把标记从 QQ 文本里摘掉。
    let qqText = cleaned
    const markers = extractMemeMarkers(cleaned)
    if (markers.length) {
      qqText = cleaned.replace(/\[表情[:：]\s*[^\]]+\](?:\(https?:\/\/[^\s)]+\))?/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      const sentByTool = sessionId ? this.mediaSentAt.get(sessionId) : undefined
      const skipMarkerMedia = Number.isFinite(sentByTool) && Date.now() - sentByTool < 120000
      for (const marker of markers) {
        if (skipMarkerMedia) continue
        if (!marker.file) {
          this.log('[qq] 表情标记没有匹配到图库文件:', marker.description)
          continue
        }
        try {
          const bytes = readFileSync(marker.file)
          const name = basename(marker.file)
          const current = this.contexts.get(chat.key)
          if (current && current.expiresAt > Date.now()) {
            const seq = ++current.seq
            await this.qq.sendMedia({ kind: chat.kind, chatId: chat.chatId, msgId: current.msgId, seq, bytes, name, image: true })
          } else {
            await this.qq.sendMedia({ kind: chat.kind, chatId: chat.chatId, msgId: null, seq: 1, bytes, name, image: true })
          }
          this.lastAssistantAt = Date.now()
          this.lastActiveByKey.set(chat.key, this.lastAssistantAt)
          this.touchRecord(chat)
          this.log(`[qq] 出站表情 ${name} → ${chat.kind}/${chat.chatId}`)
          this.notifyOutbound({ chat, kind: 'media', path: marker.file, proactive: !!proactive, sessionId })
        } catch (error) {
          this.log('[qq] 出站表情发送失败:', error instanceof Error ? error.message : error)
        }
      }
      if (!qqText) {
        if (sessionId) this.takeProactive(sessionId)
        this.notifyOutbound({ chat, kind: 'media-only', proactive: !!proactive, sessionId })
        return
      }
    }
    const context = this.contexts.get(chat.key)
    if (!context || context.expiresAt < Date.now()) {
      // 主动消息：QQ 平台可能拒绝（没有被动回复窗口），记录而不是静默丢
      this.log(`[qq] 没有被动回复上下文，尝试主动消息 ${chat.key}`)
      let outgoing = codepointClamp(qqText, 200)
      if (typeof this.textFilter === 'function') {
        try {
          const verdict = this.textFilter(outgoing, { proactive: true, record: true })
          if (verdict && verdict.ok === false) {
            this.log(`[qq] 主动文本被闸掉（${verdict.reason || 'filter'}），不发 ${chat.key}`)
            if (sessionId) this.takeProactive(sessionId)
            this.notifyOutbound({ chat, kind: 'skip', reason: verdict.reason || 'filter', proactive: true, sessionId })
            return
          }
          if (verdict && typeof verdict.text === 'string' && verdict.text.trim()) outgoing = verdict.text
        } catch (error) {
          this.log('[qq] 主动文本过滤失败（放行）:', error instanceof Error ? error.message : error)
        }
      }
      try {
        await this.qq.sendText({ kind: chat.kind, chatId: chat.chatId, msgId: null, seq: 1, text: outgoing })
        this.lastAssistantAt = Date.now()
        this.lastActiveByKey.set(chat.key, this.lastAssistantAt)
        this.touchRecord(chat)
        this.log(`[qq] 主动消息已发出 ${chat.key}`)
        this.notifyOutbound({ chat, kind: 'text', text: outgoing, proactive: true, sessionId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`[qq] 主动消息被平台拒绝 ${chat.key}: ${message}`)
        this.notifyOutbound({ chat, kind: 'proactive-failed', error: message, proactive: true, sessionId })
        throw error
      }
      return
    }
    const budget = Math.max(1, Number(config.maxMessages) || 4) - context.seq
    if (budget <= 0) {
      this.log(`[qq] 本回合消息条数已达上限，丢弃出站文本 ${chat.key}`)
      return
    }
    const segments = fitSegments(splitSegments(qqText, config), budget)
    for (const segment of segments) {
      const seq = ++context.seq
      const outgoing = codepointClamp(segment)
      await this.qq.sendText({ kind: chat.kind, chatId: chat.chatId, msgId: context.msgId, seq, text: outgoing })
      this.lastAssistantAt = Date.now()
      this.lastActiveByKey.set(chat.key, this.lastAssistantAt)
      this.touchRecord(chat)
      this.log(`[qq] 出站文字 seq=${seq} ${Array.from(outgoing).length} 字 → ${chat.kind}/${chat.chatId}`)
      this.notifyOutbound({ chat, kind: 'text', text: outgoing, proactive: !!proactive, sessionId })
    }
  }

  /** soul_say：在同一被动窗口里追加一条短消息（消耗 maxMessages 额度）。 */
  async say(text, exec) {
    const session = exec?.agent?.session
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const chat = this.chatOfSession(sessionId)
    if (!chat) throw new Error('当前会话没有绑定 QQ 聊天，soul_say 只在 QQ 会话可用')
    const context = this.contexts.get(chat.key)
    if (!context || context.expiresAt <= Date.now()) throw new Error('被动回复窗口已关闭，先等对方说话')
    const config = this.state.readConfig()
    const budget = Math.max(1, Number(config.maxMessages) || 4) - context.seq
    if (budget <= 0) throw new Error('本回合消息条数已达上限，这条不发了')
    const outgoing = String(text ?? '').trim().slice(0, 400)
    if (!outgoing) throw new Error('text 不能为空')
    const seq = ++context.seq
    await this.qq.sendText({ kind: chat.kind, chatId: chat.chatId, msgId: context.msgId, seq, text: outgoing })
    this.lastAssistantAt = Date.now()
    this.lastActiveByKey.set(chat.key, this.lastAssistantAt)
    this.touchRecord(chat)
    this.log(`[qq] soul_say seq=${seq} ${Array.from(outgoing).length} 字 → ${chat.kind}/${chat.chatId}`)
    this.notifyOutbound({ chat, kind: 'text', text: outgoing, proactive: false, sessionId })
    const cap = Math.max(0, Number(config.soulSayMaxRounds) || 0)
    if (cap > 0) {
      context.sayRounds = (Number(context.sayRounds) || 0) + 1
      if (context.sayRounds <= cap) {
        const timer = setTimeout(() => { this.rethinkAfterSay(chat, sessionId).catch(() => {}) }, 1200)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    }
    return { ok: true, seq, text: outgoing }
  }

  /** soul_say：不发送，只给同一个 agent 排一轮 followup。 */
  async requestRethink(exec, hint = '') {
    const session = exec?.agent?.session
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const chat = this.chatOfSession(sessionId)
    if (!chat) return { ok: false, error: '当前会话没有绑定 QQ 聊天' }
    const context = this.contexts.get(chat.key)
    if (!context || context.expiresAt <= Date.now()) return { ok: false, error: '被动回复窗口已关闭，先等对方说话' }
    const config = this.state.readConfig()
    const cap = Math.max(0, Number(config.soulSayMaxRounds) || 0)
    if (cap <= 0) return { ok: false, error: '追加推理轮数为 0，先到连接页打开' }
    context.sayRounds = (Number(context.sayRounds) || 0) + 1
    if (context.sayRounds > cap) return { ok: false, error: '本回合追加轮数已到上限' }
    const timer = setTimeout(() => { this.rethinkAfterSay(chat, sessionId, hint).catch(() => {}) }, 800)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return { ok: true, queued: true, round: context.sayRounds, cap }
  }

  /** soul_say 的追加推理：给同一个 agent 排下一轮，让它决定要不要再说。 */
  async rethinkAfterSay(chat, sessionId, hint = '') {
    const context = this.contexts.get(chat.key)
    if (!context || context.expiresAt <= Date.now()) return
    const agent = this.findLiveAgent(sessionId) || this.handles.get(sessionId)?.agent
    if (!agent || typeof agent.followup !== 'function') return
    const requestId = `qq-rethink-${randomUUID()}`
    const message = {
      id: requestId,
      role: 'user',
      content: [{ type: 'text', text: `（内部续话：你想再想一轮。${hint ? '原因：' + String(hint).slice(0, 120) : ''} 想说什么就自然说；不想就回复 <skip>，不要重复刚才的话。）` }],
      source: { kind: 'system', rpcId: requestId },
    }
    try {
      await agent.followup(message)
    } catch (error) {
      this.log('[qq] 追加推理 followup 失败:', error instanceof Error ? error.message : error)
    }
  }

  /** dsh_im_return_file 工具的实现：把表情图/文件作为 QQ 原生消息发出（当回合、文字之前）。 */
  async returnFile(rawPath, exec) {
    const session = exec?.agent?.session
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    const chat = this.chatOfSession(sessionId)
    if (!chat) throw new Error('当前会话没有绑定 QQ 聊天，取消文件回传')
    const cwd = String(session?.header?.cwd || exec?.agent?.session?.header?.cwd || this.defaultCwd())
    const absolute = rawPath && isAbsolute(rawPath) ? rawPath : resolvePath(cwd, String(rawPath || ''))
    const info = statSync(absolute)
    if (!info.isFile()) throw new Error('不是一个普通文件')
    if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 30 MB，QQ 无法发送')
    const bytes = readFileSync(absolute)
    const name = basename(absolute)
    const image = looksLikeImage(name, bytes)
    const context = this.contexts.get(chat.key)
    const config = this.state.readConfig()
    if (context && context.expiresAt > Date.now()) {
      const budget = Math.max(1, Number(config.maxMessages) || 4) - context.seq
      if (budget <= 0) throw new Error('本回合 QQ 消息条数已达上限，稍后再发图片')
      const seq = ++context.seq
      await this.qq.sendMedia({ kind: chat.kind, chatId: chat.chatId, msgId: context.msgId, seq, bytes, name, image })
    } else {
      await this.qq.sendMedia({ kind: chat.kind, chatId: chat.chatId, msgId: null, seq: 1, bytes, name, image })
    }
    // 网页会话只渲染 session log：把这次出站媒体登记成 deliverables，
    // 网页那一轮就会显示成附件卡片（QQ 侧本来就是原生图片）。
    try {
      if (exec?.callId) {
        const projections = this.ctx.get?.('sessionProjections')
        const boundary = projections?.stateOf?.(session, 'turnBoundary')
        const turn = boundary?.lastTurn
        if (Number.isSafeInteger(turn) && typeof session.append === 'function') {
          session.append('deliverables/presented', {
            turn,
            callId: exec.callId,
            files: [{ path: absolute, description: image ? 'QQ 表情' : name }],
          })
        }
      }
    } catch (error) {
      this.log('[qq] 登记出站附件失败:', error instanceof Error ? error.message : error)
    }
    if (sessionId) this.mediaSentAt.set(sessionId, Date.now())
    return { fileName: name, size: info.size, image }
  }

  defaultCwd() {
    try {
      const config = this.state.readConfig()
      if (config.cwd) return config.cwd
      const working = this.ctx.get?.('workingDirectory')
      if (working && typeof working.defaultDirectory === 'string' && working.defaultDirectory) return working.defaultDirectory
    } catch { /* 继续用进程目录 */ }
    return process.cwd()
  }

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
    if (!provider || !model) throw new Error('没有可用的默认模型：请先在 Chat 里选一个模型，或在面板填写 provider/model')
    return { provider, model }
  }

  presetSetup(config) {
    // 注意：宿主的 agent loop 会执行 (await setup(...))?.commit()，setup 必须返回 undefined
    // 或带 commit() 的激活对象；返回 agent 会直接抛 "?.commit is not a function"。
    return async (agentCtx) => {
      try {
        if (this.ctx.agentPresets?.mount) await this.ctx.agentPresets.mount(agentCtx, config.agentPreset || undefined)
      } catch (error) {
        this.log('[qq] 挂载 Agent 预设失败:', error instanceof Error ? error.message : error)
      }
    }
  }

  async getOrCreateBinding(kind, chatId, title = '') {
    const key = `${kind}:${chatId}`
    const sessions = this.state.readSessions()
    const record = sessions[key]
    if (record && record.sessionId) {
      const live = this.findLiveAgent(record.sessionId)
      if (live) {
        this.sessionIds.set(record.sessionId, { kind, chatId, key })
        return { sessionId: record.sessionId, agent: live, record }
      }
      const resumed = await this.resumeBinding(kind, chatId, record)
      if (resumed) return resumed
    }
    return this.createBinding(kind, chatId, title)
  }

  findLiveAgent(sessionId) {
    try {
      return this.ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  async resumeBinding(kind, chatId, record) {
    const config = this.state.readConfig()
    if (!record.title) record.title = ''
    try {
      const call = () => this.ctx.agents.resume({
        resumeSessionId: record.sessionId,
        agentOptions: this.resolveAgentOptions(config),
        setup: this.presetSetup(config),
      })
      const handle = await (this.ctx.agents.withoutInitiator ? this.ctx.agents.withoutInitiator(call) : call())
      const agent = handle?.agent
      if (!agent) throw new Error('恢复结果没有 agent')
      this.handles.set(record.sessionId, handle)
      this.sessionIds.set(record.sessionId, { kind, chatId, key: `${kind}:${chatId}` })
      await this.attachWorkspace(record.sessionId, record.cwd || this.defaultCwd())
      this.log(`[qq] 恢复会话 ${record.sessionId}`)
      return { sessionId: record.sessionId, agent, record }
    } catch (error) {
      this.log(`[qq] 恢复会话失败（将新建）${record.sessionId}:`, error instanceof Error ? error.message : error)
      return undefined
    }
  }

  async createBinding(kind, chatId, title = '') {
    const config = this.state.readConfig()
    const cwd = config.cwd || this.defaultCwd()
    const stamp = Date.now()
    const sessionId = `qq:${kind}:${stamp}:${chatId}`
    const create = () => this.ctx.agents.create({
      sessionId,
      meta: {
        cwd,
        ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
      },
      agentOptions: this.resolveAgentOptions(config),
      setup: this.presetSetup(config),
    })
    const handle = await (this.ctx.agents.withoutInitiator ? this.ctx.agents.withoutInitiator(create) : create())
    if (!handle?.agent) throw new Error('创建会话没有返回 agent')
    this.handles.set(sessionId, handle)
    const key = `${kind}:${chatId}`
    this.sessionIds.set(sessionId, { kind, chatId, key })
    const sessions = this.state.readSessions()
    sessions[key] = {
      sessionId,
      kind,
      chatId,
      cwd,
      title,
      updatedAt: new Date().toISOString(),
    }
    this.state.writeSessions(sessions)
    await this.attachWorkspace(sessionId, cwd)
    this.log(`[qq] 新建会话 ${sessionId}`)
    return { sessionId, agent: handle.agent, record: sessions[key] }
  }

  async attachWorkspace(sessionId, cwd) {
    let workspaces = []
    try {
      workspaces = this.ctx.get?.('workspaceRegistry')?.list?.() ?? []
    } catch {
      workspaces = []
    }
    if (!workspaces.length) return
    const preferred = workspaces.find(workspace => samePath(workspace.path, cwd)) || workspaces[0]
    try {
      await preferred.attachSession(sessionId)
    } catch (error) {
      this.log('[qq] 会话挂载工作区失败:', error instanceof Error ? error.message : error)
    }
  }

  async dispose() {
    this.disposed = true
    try {
      this.offSessionEvent?.()
    } catch { /* ignore */ }
    for (const [sessionId, handle] of this.handles) {
      try {
        await handle?.dispose?.()
      } catch (error) {
        this.log(`[qq] 释放会话失败 ${sessionId}:`, error instanceof Error ? error.message : error)
      }
    }
    this.handles.clear()
    this.sessionIds.clear()
    this.contexts.clear()
  }
}
