/**
 * QQ 开放平台机器人客户端（自研，替代 @michengai/dsh-im-connect 的 QQ 适配器）。
 *
 * 契约（Host 其余模块只依赖这里）：
 *
 *   const client = new QQClient({ log, getConfig, onEvent, onStatus })
 *   await client.start()        // 取 token → 取 gateway → WS 连接 → identify → 心跳
 *   await client.stop()         // 关闭 WS、停止心跳、清 token
 *   client.status()             // { online, startedAt, lastError, lastEventAt, botOpenId? }
 *
 *   onEvent(evt):  evt = {
 *     kind: 'dm' | 'group',
 *     chatId: string,           // 私聊：用户 openid；群聊：群 openid
 *     userId: string,           // 发送者 openid（群聊里即成员 openid）
 *     msgId: string,            // 本条入站消息 id（被动回复用）
 *     text: string,             // 纯文本内容（富媒体里的文字提取；没有就空串）
 *     timestampMs: number,
 *     rawType: string,          // 平台事件类型，便于日志
 *   }
 *
 *   await client.sendText({ kind, chatId, msgId, seq, text })
 *       被动回复：msgId = 最近一条入站消息 id；seq 从 1 开始、同一 msgId 最多 5 条。
 *       msgId 为 null 时尝试主动消息（无 msgId），失败抛出可读错误。
 *       内部先走 markdown（QQ 官方方言），平台明确拒绝 markdown 时回退纯文本。
 *
 *   await client.sendMedia({ kind, chatId, msgId, seq, bytes, name, image })
 *       图片（image:true）按 QQ 富媒体 file_type=1 上传后 msg_type=7 发出 → 客户端显示为原生图片；
 *       其余按 file_type=4 / 视频 2 发送。bytes 为 Buffer。
 *
 *   失败一律 throw Error(message)，由 bridge 决定提示/重试；不要吞掉。
 *
 * 说明：token 缓存 5 分钟提前刷新；WS 断线按指数退避重连；心跳 op=1，ack/op=11 不阻塞。
 *
 * 实现备注（只依赖 Node 内置能力，不 import 任何第三方包）：
 * - HTTP：POST bots.qq.com/app/getAppAccessToken 取 AccessToken，提前 5 分钟刷新；
 *   401 时清缓存重取并重试一次；api.sgroup.qq.com 用 `Authorization: QQBot <token>`。
 * - WS：GET /gateway → wss 地址；op 10 Hello → op 2 Identify（intents=GROUP_AND_C2C_INTENT，shard [0,1]）；
 *   心跳 op 1（d=最近 s），op 11 只更新时间；连续两个心跳周期没有 ack 视为假死，主动断开重连。
 * - 重连：指数退避（默认 3s 起、封顶 60s），READY 稳定 60s 后把次数清零；op 7 / op 9 / 4004 鉴权失败
 *   都走同一条重连路径（4004 额外清 token）。
 * - 入站只处理纯文本（content；content 为空时从 msg_elements 提取文字）；媒体输入不在本期，附件消息忽略。
 * - 出站 markdown 走 msg_type=2；只有平台明确拒绝 markdown（err_code 50055/50056/50057）才回退 msg_type=0。
 * - 平台业务错误统一 throw Error(message)，并带 errCode / status 便于上层判断；超时是 DOMException
 *   TimeoutError，不会被误判成 markdown 拒绝（它的 code 是 23）。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const GATEWAY_PATH = '/gateway'
/** intents 的「群聊 + 单聊消息」位（GROUP_AND_C2C_INTENT = 1 << 25）。 */
const GROUP_AND_C2C_INTENT = 1 << 25

export const QQ_MARKDOWN_MAX_CODEPOINTS = 2000
const QQ_MARKDOWN_FALLBACK_CODES = new Set([50055, 50056, 50057])

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_HTTP_TIMEOUT_MS = 30_000
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000
const DEFAULT_RECONNECT_BASE_MS = 3_000
const DEFAULT_RECONNECT_MAX_MS = 60_000
const STABLE_RESET_MS = 60_000
const CLOSE_FALLBACK_MS = 5_000

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function formatDuration(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

function trimText(text, max = 200) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  return source.length <= max ? source : `${source.slice(0, max)}…`
}

function qqRequestError(message, detail = {}) {
  const error = new Error(message)
  if (detail.status !== undefined) error.status = detail.status
  if (detail.errCode !== undefined) error.errCode = detail.errCode
  return error
}

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/** 统一换行并去掉 `<@!openid>`、行首 `@昵称` 这类 @ 前缀；不破坏正文的多行结构。 */
export function cleanQqText(text) {
  return normalizeNewlines(text)
    .replace(/<@!?\w+>/g, '')
    .replace(/^\s*@\S+\s+/, '')
    .trim()
}

/** 按码点截断（String.length 数的是 UTF-16 单元，emoji 会被算成 2）。 */
export function clampQqMarkdown(text, max = QQ_MARKDOWN_MAX_CODEPOINTS) {
  const source = String(text ?? '')
  const points = Array.from(source)
  return points.length <= max ? source : points.slice(0, max).join('')
}

function normalizeSeq(seq) {
  const number = Number(seq)
  return Number.isInteger(number) && number > 0 ? number : 1
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  throw new Error('QQ 媒体内容必须是 Buffer / Uint8Array')
}

// ---------------------------------------------------------------------------
// QQ markdown 方言（出站）与错误码
// ---------------------------------------------------------------------------

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/
const CODE_FENCE = /^\s{0,3}```/
const DEEP_HEADING = /^(\s{0,3})#{3,6}/

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
}

function appendQqTable(out, lines, index) {
  const headers = tableCells(lines[index] ?? '')
  out.push(`- ${headers[0] ?? ''}`)
  let row = index + 2
  while (row < lines.length && TABLE_ROW.test(lines[row] ?? '')) {
    const cells = tableCells(lines[row] ?? '')
    const rest = cells
      .slice(1)
      .map((cell, column) => (headers[column + 1] ? `${headers[column + 1]}：${cell}` : cell))
      .join('；')
    out.push(`  · ${cells[0] ?? ''}${rest ? `（${rest}）` : ''}`)
    row += 1
  }
  return row
}

/** 把管道表格降级成列表（只在纯文本回退时用；markdown 里 QQ 能自己渲染表格）。 */
export function convertQqTables(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = lines[index + 1] ?? ''
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(next)) {
      index = appendQqTable(out, lines, index) - 1
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 整理成 QQ 能渲染的 markdown：去掉代码围栏（QQ 不渲染成代码块），三级及更深标题收成 `##`。
 * 表格保持不变；不根据 `**` / `__` 决定是否走 markdown。
 */
export function prepareQqMarkdown(text) {
  const lines = normalizeNewlines(text).split('\n')
  const out = []
  const prose = []
  let inCode = false
  const flush = () => {
    if (!prose.length) return
    out.push(prose.splice(0).map(line => line.replace(DEEP_HEADING, '$1##')).join('\n'))
  }
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      flush()
      inCode = !inCode
      continue
    }
    if (inCode) {
      flush()
      out.push(line)
      continue
    }
    prose.push(line)
  }
  flush()
  return out.join('\n')
}

/** 平台拒绝 markdown 时的纯文本兜底：表格先降级，再去掉 markdown 标记。 */
export function toQqPlainText(text) {
  return convertQqTables(text)
    .replace(/^[ \t]*```[^\n]*\n?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
}

/** 从响应体/对象读取官方 err_code（也容忍字符串形式的 code）。不读 error.code，避免误判系统错误码。 */
export function readQqErrCode(body) {
  let source = body
  if (typeof body === 'string') {
    try { source = JSON.parse(body) } catch { return undefined }
  }
  if (!source || typeof source !== 'object') return undefined
  const raw = source.err_code ?? source.code
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw)
  return undefined
}

/** 只有 markdown 内容无效/未开通/模板冲突（50055/50056/50057）才允许回退纯文本。 */
export function isQqMarkdownRejection(error) {
  if (!error || typeof error !== 'object') return false
  return typeof error.errCode === 'number' && QQ_MARKDOWN_FALLBACK_CODES.has(error.errCode)
}

function describeQqError(data, errCode) {
  const parts = []
  if (errCode !== undefined) parts.push(`err_code=${errCode}`)
  if (data && typeof data === 'object') {
    const message = data.message ?? data.msg
    if (message) parts.push(trimText(message, 160))
  }
  return parts.length ? `（${parts.join(' ')}）` : ''
}

// ---------------------------------------------------------------------------
// 富媒体类型判定
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v'])

function matchesBytes(data, offset, bytes) {
  if (!data || data.length < offset + bytes.length) return false
  return bytes.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data, offset, text) {
  if (!data || data.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

export function looksLikeImageBytes(data) {
  return matchesBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // png
    || matchesBytes(data, 0, [0xff, 0xd8, 0xff]) // jpg
    || matchesAscii(data, 0, 'GIF87a')
    || matchesAscii(data, 0, 'GIF89a')
    || (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP'))
}

function looksLikeVideoBytes(data) {
  return matchesAscii(data, 4, 'ftyp') // mp4/mov（ISO BMFF）
}

/** QQ 富媒体上传的 file_type：1 图片、2 视频、4 文件。先看魔数再看扩展名（文件可能被改名）。 */
export function qqUploadFileType(name, data) {
  if (looksLikeImageBytes(data)) return 1
  if (looksLikeVideoBytes(data)) return 2
  const dot = String(name ?? '').lastIndexOf('.')
  const extension = dot < 0 ? '' : String(name).slice(dot).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 1
  if (VIDEO_EXTENSIONS.has(extension)) return 2
  return 4
}

// ---------------------------------------------------------------------------
// 入站解析
// ---------------------------------------------------------------------------

/** 从消息体提取纯文本：优先 content；为空时从 msg_elements 里的文字拼出（媒体输入本期不处理）。 */
function extractInboundText(data) {
  const content = typeof data.content === 'string' ? cleanQqText(data.content) : ''
  if (content) return content
  const elements = Array.isArray(data.msg_elements) ? data.msg_elements.slice(0, 20) : []
  const pieces = []
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    // 嵌套 msg_elements 是引用历史，别把历史正文当成本条消息
    if (Array.isArray(element.msg_elements) && element.msg_elements.length) continue
    if (typeof element.content !== 'string') continue
    const cleaned = cleanQqText(element.content)
    if (cleaned) pieces.push(cleaned)
  }
  return pieces.join('\n')
}

/**
 * 把网关 dispatch 解析成契约里的事件形状。
 * 只认 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE；字段不全返回 null。
 * text 可能为空串，调用方自行决定忽略。
 */
export function parseInbound(rawType, data) {
  const type = String(rawType ?? '')
  if (type !== 'C2C_MESSAGE_CREATE' && type !== 'GROUP_AT_MESSAGE_CREATE') return null
  if (!data || typeof data !== 'object') return null
  const isGroup = type === 'GROUP_AT_MESSAGE_CREATE'
  const author = data.author && typeof data.author === 'object' ? data.author : {}
  const chatId = String(isGroup ? (data.group_openid ?? '') : (author.user_openid ?? author.id ?? ''))
  const userId = String(isGroup
    ? (author.member_openid ?? author.id ?? '')
    : (author.user_openid ?? author.id ?? ''))
  const msgId = String(data.id ?? '')
  if (!chatId || !userId || !msgId) return null
  const stamp = Date.parse(String(data.timestamp ?? ''))
  return {
    kind: isGroup ? 'group' : 'dm',
    chatId,
    userId,
    msgId,
    text: extractInboundText(data),
    timestampMs: Number.isFinite(stamp) ? stamp : Date.now(),
    rawType: type,
  }
}

// ---------------------------------------------------------------------------
// 出站目标
// ---------------------------------------------------------------------------

/** kind 决定路由；chatId 允许带 `g:` 前缀（渠道重启后仍能自描述群聊），这里容忍并剥掉。 */
function resolveTarget(kind, chatId) {
  const raw = String(chatId ?? '').trim()
  if (!raw) throw new Error('缺少 QQ 会话 chatId')
  const hinted = String(kind ?? '')
  const openid = raw.replace(/^g:/, '')
  if (!openid) throw new Error(`QQ 会话 chatId 无效：${raw}`)
  const group = hinted === 'group' || (hinted !== 'dm' && raw.startsWith('g:'))
  const root = `${group ? '/v2/groups' : '/v2/users'}/${encodeURIComponent(openid)}`
  return {
    group,
    openid,
    root,
    messagesPath: `${root}/messages`,
    filesPath: `${root}/files`,
    label: group ? '群聊' : '单聊',
  }
}

// ---------------------------------------------------------------------------
// QQClient
// ---------------------------------------------------------------------------

const WS_OPEN = 1

export class QQClient {
  constructor(options = {}) {
    this.options = options && typeof options === 'object' ? options : {}
    this.log = typeof this.options.log === 'function' ? this.options.log : () => {}
    this.getConfig = typeof this.options.getConfig === 'function' ? this.options.getConfig : () => ({})
    this.onEvent = typeof this.options.onEvent === 'function' ? this.options.onEvent : null
    this.onStatus = typeof this.options.onStatus === 'function' ? this.options.onStatus : null

    // 允许测试注入更短的超时/退避；生产默认值见文件顶部常量。
    this.httpTimeoutMs = positiveNumber(this.options.httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS)
    this.uploadTimeoutMs = positiveNumber(this.options.uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS)
    this.reconnectBaseMs = positiveNumber(this.options.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS)
    this.reconnectMaxMs = positiveNumber(this.options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS)

    this.started = false
    this.stopped = true // 未 start 前不允许发送
    this.ready = false
    this.startedAt = 0
    this.lastError = ''
    this.lastEventAt = 0
    this.botOpenId = ''

    this.ws = null
    this.lifecycle = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.stableTimer = null
    this.closeFallback = null
    this.reconnectAttempts = 0
    this.lastSeq = null
    this.lastAckAt = 0

    this.token = ''
    this.tokenAppId = ''
    this.tokenExpireAt = 0
    this.tokenPromise = null
    this.markdownDisabled = false
  }

  // --- 状态 ---------------------------------------------------------------

  status() {
    return {
      online: Boolean(this.ready && this.ws),
      ready: Boolean(this.ready),
      startedAt: this.startedAt || undefined,
      lastError: this.lastError || undefined,
      lastEventAt: this.lastEventAt || undefined,
      ...(this.botOpenId ? { botOpenId: this.botOpenId } : {}),
    }
  }

  emitStatus() {
    if (!this.onStatus) return
    try {
      this.onStatus(this.status())
    } catch (error) {
      this.log('[qq] onStatus 回调失败:', errorMessage(error))
    }
  }

  assertRunning(action) {
    if (this.stopped) throw new Error(`QQ 客户端未连接（请先连接），无法${action}`)
  }

  // --- 凭据 / token -------------------------------------------------------

  readCredentials() {
    let config
    try {
      config = this.getConfig() || {}
    } catch (error) {
      throw new Error(`读取 QQ 配置失败：${errorMessage(error)}`)
    }
    const appId = String(config.appId ?? '').trim()
    const appSecret = String(config.appSecret ?? '').trim()
    if (!appId || !appSecret) {
      // 缺凭据属于配置错误：不要进入无限重连，等用户填好再手动连接
      const error = new Error('未配置 QQ 机器人 AppID / AppSecret，请先在面板填写或点「导入」')
      error.configError = true
      throw error
    }
    return { appId, appSecret }
  }

  async ensureToken(force = false) {
    const { appId, appSecret } = this.readCredentials()
    if (this.tokenAppId && this.tokenAppId !== appId) {
      // 面板换了机器人：旧 token 不能再用于新 appId
      this.token = ''
      this.tokenExpireAt = 0
    }
    if (!force && this.token && Date.now() < this.tokenExpireAt) return this.token
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchAccessToken(appId, appSecret).finally(() => {
        this.tokenPromise = null
      })
    }
    return this.tokenPromise
  }

  async fetchAccessToken(appId, appSecret) {
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    }, this.httpTimeoutMs, '获取 AccessToken')

    const bodyText = await response.text().catch(() => '')
    let data = null
    if (bodyText) {
      try { data = JSON.parse(bodyText) } catch { data = null }
    }
    const token = data && typeof data.access_token === 'string' ? data.access_token : ''
    if (!response.ok || !token) {
      const code = data && (data.code ?? data.errcode)
      const message = data && (data.message ?? data.msg)
      const detail = [code !== undefined ? `code=${code}` : '', message ? trimText(message, 160) : '']
        .filter(Boolean)
        .join(' ')
      throw new Error(`获取 AccessToken 失败：HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
    }
    const expiresIn = Number(data.expires_in)
    const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200
    this.token = token
    this.tokenAppId = appId
    this.tokenExpireAt = Date.now() + Math.max(60_000, ttlSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS)
    this.log(`[qq] AccessToken 已获取（有效期 ${ttlSeconds}s，提前 5 分钟刷新）`)
    return this.token
  }

  // --- HTTP 基础 ----------------------------------------------------------

  /** fetch 包装：合并超时与 stop() 生命周期信号，并把底层错误转成可读文案。 */
  async request(url, init, timeoutMs, label) {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (this.lifecycle) signals.push(this.lifecycle.signal)
    try {
      return await fetch(url, { ...init, signal: AbortSignal.any(signals) })
    } catch (error) {
      if (this.stopped) throw new Error(`${label}已中止：QQ 客户端已停止`)
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`${label}超时（${formatDuration(timeoutMs)}）`)
      }
      throw new Error(`${label}网络错误：${errorMessage(error)}`)
    }
  }

  /** QQ OpenAPI 调用：自动带 token、401 重取 token 重试一次、把 err_code 挂到 Error 上。 */
  async qqFetch(path, init = {}, options = {}) {
    const timeoutMs = positiveNumber(options.timeoutMs, this.httpTimeoutMs)
    const name = options.label || `QQ 接口 ${path}`
    const send = async () => {
      const token = await this.ensureToken()
      if (this.stopped) throw new Error(`${name}已中止：QQ 客户端已停止`)
      return this.request(`${API_BASE}${path}`, {
        ...init,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
      }, timeoutMs, name)
    }

    let response = await send()
    if (response.status === 401) {
      this.log(`[qq] ${name} 返回 401，刷新 AccessToken 后重试`)
      this.token = ''
      this.tokenExpireAt = 0
      response = await send()
    }

    const bodyText = await response.text().catch(() => '')
    let data = null
    if (bodyText) {
      try { data = JSON.parse(bodyText) } catch { data = null }
    }
    const errCode = readQqErrCode(data ?? bodyText)
    if (!response.ok) {
      throw qqRequestError(`${name}失败：HTTP ${response.status}${describeQqError(data, errCode)}`, {
        status: response.status,
        errCode,
      })
    }
    if (errCode !== undefined && errCode !== 0) {
      throw qqRequestError(`${name}被平台拒绝${describeQqError(data, errCode)}`, { errCode })
    }
    return data
  }

  // --- 连接生命周期 -------------------------------------------------------

  async start() {
    if (this.started) return this.status()
    this.started = true
    this.stopped = false
    this.startedAt = Date.now()
    this.lastError = ''
    this.reconnectAttempts = 0
    this.markdownDisabled = false
    this.lifecycle = new AbortController()
    this.emitStatus()

    try {
      await this.connect()
    } catch (error) {
      this.lastError = errorMessage(error)
      this.emitStatus()
      this.log(`[qq] 连接失败: ${this.lastError}`)
      if (error && error.configError) {
        // 配置错误不算「已启动」：用户补好凭据再点连接时要能重新走完整流程
        this.started = false
        this.stopped = true
        this.startedAt = 0
        this.lifecycle = null
      } else if (!this.stopped) {
        // 首连失败也排重连：token/网关抖动不该让机器人一直离线；调用方仍拿到可读错误
        this.scheduleReconnect()
      }
      throw error instanceof Error ? error : new Error(this.lastError)
    }
    return this.status()
  }

  async connect() {
    if (this.stopped) return
    const gateway = await this.qqFetch(GATEWAY_PATH, { method: 'GET' }, { label: '获取 QQ 网关' })
    if (this.stopped) return
    const url = gateway && typeof gateway.url === 'string' ? gateway.url : ''
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      throw new Error('QQ 网关返回的地址无效（缺少 wss://）')
    }
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 运行时没有全局 WebSocket，无法连接 QQ 网关')
    }

    const socket = new WebSocket(url)
    this.ws = socket
    this.ready = false
    this.lastSeq = null
    this.lastAckAt = 0

    socket.onopen = () => {
      if (this.ws !== socket || this.stopped) return
      this.log('[qq] 网关已连接，等待 Hello')
      this.emitStatus()
    }
    socket.onmessage = event => this.onGatewayMessage(socket, event)
    socket.onerror = () => {
      if (this.ws !== socket || this.stopped) return
      this.lastError = 'QQ 网关连接错误'
      this.emitStatus()
      // 有些实现只发 error 不发 close；兜底走一次重连（closeFallback 保证最终收敛）
      this.reconnectSocket(socket, 4005, 'socket-error')
    }
    socket.onclose = event => this.onGatewayClose(socket, event)
  }

  onGatewayMessage(socket, event) {
    if (this.ws !== socket || this.stopped) return
    let payload
    try {
      payload = JSON.parse(String(event && event.data !== undefined ? event.data : ''))
    } catch {
      this.log('[qq] 收到无法解析的网关消息')
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (typeof payload.s === 'number') this.lastSeq = payload.s

    const op = Number(payload.op)
    if (op === 10) {
      this.onHello(socket, payload.d)
      return
    }
    if (op === 11) {
      this.lastAckAt = Date.now()
      return
    }
    if (op === 0) {
      this.onDispatch(payload.t, payload.d)
      return
    }
    if (op === 7) {
      this.log('[qq] 网关要求重连，主动断开旧连接')
      this.lastError = '网关要求重连'
      this.reconnectSocket(socket, 4000, 'server-reconnect')
      return
    }
    if (op === 9) {
      this.log('[qq] 网关会话失效，重新鉴权')
      this.lastError = '网关会话失效'
      this.lastSeq = null
      this.reconnectSocket(socket, 4001, 'session-invalid')
    }
  }

  onHello(socket, data) {
    const interval = Math.max(1000, Math.round(Number(data && data.heartbeat_interval)) || 30_000)
    this.heartbeatInterval = interval
    this.lastAckAt = Date.now()
    const identify = {
      op: 2,
      d: {
        token: `QQBot ${this.token}`,
        intents: GROUP_AND_C2C_INTENT,
        shard: [0, 1],
      },
    }
    try {
      socket.send(JSON.stringify(identify))
    } catch (error) {
      this.log('[qq] 发送 Identify 失败:', errorMessage(error))
      this.reconnectSocket(socket, 4002, 'identify-failed')
      return
    }
    this.startHeartbeat(socket, interval)
    this.log('[qq] 已收到 Hello，正在鉴权')
  }

  startHeartbeat(socket, interval) {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== socket || this.stopped) return
      if (this.lastAckAt && Date.now() - this.lastAckAt > interval * 2) {
        this.log('[qq] 心跳超时（连续两个周期没有 ack），主动重连')
        this.lastError = '心跳超时'
        this.reconnectSocket(socket, 4009, 'heartbeat-timeout')
        return
      }
      try {
        socket.send(JSON.stringify({ op: 1, d: this.lastSeq }))
      } catch (error) {
        this.log('[qq] 发送心跳失败:', errorMessage(error))
        this.reconnectSocket(socket, 4003, 'heartbeat-failed')
      }
    }, interval)
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  markStable() {
    this.clearStableTimer()
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      this.reconnectAttempts = 0
    }, STABLE_RESET_MS)
    if (this.stableTimer.unref) this.stableTimer.unref()
  }

  clearStableTimer() {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  onDispatch(rawType, data) {
    const type = String(rawType ?? '')
    if (type === 'READY') {
      this.ready = true
      this.lastError = ''
      const user = data && typeof data.user === 'object' && data.user ? data.user : {}
      this.botOpenId = String(user.id ?? user.openid ?? user.username ?? '') || this.botOpenId
      this.lastAckAt = Date.now()
      this.markStable()
      this.log(`[qq] 网关就绪${this.botOpenId ? `（bot ${this.botOpenId}）` : ''}`)
      this.emitStatus()
      return
    }
    if (type === 'RESUMED') {
      this.ready = true
      this.lastError = ''
      this.markStable()
      this.emitStatus()
      return
    }
    if (type !== 'C2C_MESSAGE_CREATE' && type !== 'GROUP_AT_MESSAGE_CREATE') return

    const event = parseInbound(type, data)
    if (!event) {
      this.log(`[qq] 忽略字段不全的入站事件 ${type}`)
      return
    }
    if (!event.text) {
      this.log(`[qq] 忽略无文本消息 ${type} ${event.msgId}`)
      return
    }
    this.lastEventAt = Date.now()
    try {
      const result = this.onEvent ? this.onEvent(event) : undefined
      if (result && typeof result.then === 'function') {
        result.then(undefined, error => this.log('[qq] 入站回调失败:', errorMessage(error)))
      }
    } catch (error) {
      this.log('[qq] 入站回调失败:', errorMessage(error))
    }
  }

  reconnectSocket(socket, code = 4000, reason = 'reconnect') {
    if (this.ws !== socket) return
    try {
      socket.close(code, reason)
    } catch (error) {
      this.log('[qq] 关闭连接失败:', errorMessage(error))
    }
    // 正常情况 onclose 会立刻到来；个别实现关闭握手卡住时兜底收敛，避免状态卡死
    if (this.closeFallback) clearTimeout(this.closeFallback)
    this.closeFallback = setTimeout(() => {
      this.closeFallback = null
      if (this.ws === socket) this.onGatewayClose(socket, { code })
    }, CLOSE_FALLBACK_MS)
    if (this.closeFallback.unref) this.closeFallback.unref()
  }

  onGatewayClose(socket, event) {
    if (this.ws !== socket) return
    this.ws = null
    this.ready = false
    this.stopHeartbeat()
    this.clearStableTimer()
    if (this.closeFallback) {
      clearTimeout(this.closeFallback)
      this.closeFallback = null
    }
    this.emitStatus()

    if (this.stopped) return
    const code = Number(event && event.code) || 0
    if (code === 4004) {
      // 鉴权失败：token 可能被吊销，清掉后重连会重新取
      this.token = ''
      this.tokenExpireAt = 0
      this.lastError = 'QQ 网关鉴权失败（4004），将刷新 AccessToken 后重连'
    } else if (code === 4008) {
      this.lastError = 'QQ 网关频率限制（4008），将延迟重连'
    } else if (code === 4009) {
      this.lastError = 'QQ 网关会话超时（4009），将重连'
    } else {
      this.lastError = `QQ 网关连接断开（code ${code || 'unknown'}）`
    }
    this.log(`[qq] ${this.lastError}`)
    this.emitStatus()
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(this.reconnectBaseMs * (2 ** this.reconnectAttempts), this.reconnectMaxMs)
    this.reconnectAttempts += 1
    this.log(`[qq] ${formatDuration(delay)} 后重连（第 ${this.reconnectAttempts} 次）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      this.connect().catch(error => {
        if (this.stopped) return
        this.lastError = errorMessage(error)
        this.emitStatus()
        this.log(`[qq] 重连失败: ${this.lastError}`)
        this.scheduleReconnect()
      })
    }, delay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  async stop() {
    const wasStarted = this.started
    this.stopped = true
    this.started = false
    this.ready = false
    this.botOpenId = ''
    this.clearReconnectTimer()
    this.stopHeartbeat()
    this.clearStableTimer()
    if (this.closeFallback) {
      clearTimeout(this.closeFallback)
      this.closeFallback = null
    }
    this.lifecycle?.abort()
    this.lifecycle = null

    const socket = this.ws
    this.ws = null
    if (socket) {
      await new Promise(resolve => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(done, 2000)
        if (timer.unref) timer.unref()
        try {
          socket.addEventListener('close', done, { once: true })
        } catch {
          done()
          return
        }
        try {
          socket.close(1000, 'shutdown')
        } catch {
          done()
        }
      })
    }

    this.token = ''
    this.tokenAppId = ''
    this.tokenExpireAt = 0
    this.tokenPromise = null
    this.lastSeq = null
    this.lastEventAt = 0
    this.startedAt = 0
    this.lastError = ''
    this.markdownDisabled = false
    if (wasStarted) this.log('[qq] 客户端已停止')
    this.emitStatus()
  }

  // --- 出站：文本 ---------------------------------------------------------

  wrapOutboundError(error, { passiveId, action }) {
    const detail = errorMessage(error)
    const passiveHint = !passiveId && action !== '上传媒体'
      ? '；当前没有被动回复 msg_id（平台只允许回复最近 5 分钟内的入站消息）'
      : ''
    const wrapped = new Error(`QQ ${action}失败：${detail}${passiveHint}`)
    if (error instanceof Error) wrapped.cause = error
    if (error && typeof error === 'object') {
      if (error.errCode !== undefined) wrapped.errCode = error.errCode
      if (error.status !== undefined) wrapped.status = error.status
    }
    return wrapped
  }

  async sendText({ kind, chatId, msgId = null, seq, text } = {}) {
    this.assertRunning('发送文本')
    const target = resolveTarget(kind, chatId)
    const markdown = clampQqMarkdown(prepareQqMarkdown(text))
    // 空白内容没有意义，也避免白占一条被动回复名额
    if (!markdown.trim()) return

    const passiveId = msgId ? String(msgId) : ''
    const messageSeq = normalizeSeq(seq)
    const post = body => this.qqFetch(target.messagesPath, {
      method: 'POST',
      body: JSON.stringify(passiveId ? { ...body, msg_id: passiveId } : body),
    }, { label: `${target.label}发送消息` })

    const sendPlain = async source => {
      const plain = clampQqMarkdown(toQqPlainText(source))
      try {
        await post({ content: plain, msg_type: 0, msg_seq: messageSeq })
      } catch (error) {
        throw this.wrapOutboundError(error, { passiveId, action: '发送文本消息' })
      }
    }

    if (this.markdownDisabled) {
      await sendPlain(markdown)
      return
    }
    try {
      await post({ markdown: { content: markdown }, msg_type: 2, msg_seq: messageSeq })
      return
    } catch (error) {
      if (!isQqMarkdownRejection(error)) {
        throw this.wrapOutboundError(error, { passiveId, action: '发送文本消息' })
      }
      // 50056 = 未开通 markdown 能力：本实例后续都直接走纯文本
      if (error.errCode === 50056) this.markdownDisabled = true
      this.log(`[qq] markdown 被平台拒绝（err_code=${error.errCode}），回退纯文本`)
      await sendPlain(markdown)
    }
  }

  // --- 出站：媒体 ---------------------------------------------------------

  async sendMedia({ kind, chatId, msgId = null, seq, bytes, name, image } = {}) {
    this.assertRunning('发送媒体')
    const target = resolveTarget(kind, chatId)
    const data = toBuffer(bytes)
    if (!data.length) throw new Error('QQ 媒体内容为空，无法发送')

    const fileName = String(name || (image ? 'image.png' : 'file.bin'))
    const passiveId = msgId ? String(msgId) : ''
    const messageSeq = normalizeSeq(seq)
    const uploadType = image === true ? 1 : qqUploadFileType(fileName, data)
    const upload = type => this.qqFetch(target.filesPath, {
      method: 'POST',
      body: JSON.stringify({
        file_type: type,
        file_data: data.toString('base64'),
        file_name: fileName,
        srv_send_msg: false,
      }),
    }, { timeoutMs: this.uploadTimeoutMs, label: `${target.label}上传媒体` })

    let uploaded
    try {
      uploaded = await upload(uploadType)
    } catch (error) {
      if (uploadType === 4) throw this.wrapOutboundError(error, { passiveId, action: '上传媒体' })
      // 平台可能不接受该富媒体类型：退回「文件」重试一次
      this.log(`[qq] 富媒体上传被拒（file_type=${uploadType}），退回文件类型重试`)
      try {
        uploaded = await upload(4)
      } catch (fallbackError) {
        throw this.wrapOutboundError(fallbackError, { passiveId, action: '上传媒体' })
      }
    }

    const fileInfo = uploaded && typeof uploaded.file_info === 'string' ? uploaded.file_info : ''
    if (!fileInfo) throw new Error('QQ 富媒体上传没有返回 file_info')

    const body = {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: messageSeq,
      ...(passiveId ? { msg_id: passiveId } : {}),
    }
    try {
      await this.qqFetch(target.messagesPath, {
        method: 'POST',
        body: JSON.stringify(body),
      }, { label: `${target.label}发送媒体` })
    } catch (error) {
      throw this.wrapOutboundError(error, { passiveId, action: '发送媒体消息' })
    }
  }
}
