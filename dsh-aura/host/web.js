/**
 * 面板 Host API（同源 HTTP，仅本机/受信来源）。
 *
 * GET  /dsh-aura/api/state         面板总览（config/status/soul/emotion/sessions…）
 * POST /dsh-aura/api/config        写配置（外观/渠道/灵魂/主动搭话字段）
 * POST /dsh-aura/api/connect /disconnect /import
 * GET  /dsh-aura/api/soul/state    完整灵魂快照
 * POST /dsh-aura/api/soul/reset    { scope: 'emotion' | 'all' }
 * POST /dsh-aura/api/soul/pause    { hours } 暂停主动搭话
 * POST /dsh-aura/api/speak/tick    { mode: 'dry' | 'real' } 立即掷一次
 * POST /dsh-aura/api/proactive/tick  旧面板兼容入口
 * POST /dsh-aura/api/voice/utterance { text } 手测语音闭环：这段文本交给 Aura 专用 voice 会话
 * GET  /dsh-aura/api/voice/state    语音通道状态（voiceSessionId/轮询/最后一次 say）
 *
 * 另外把 Aura 会话集合（soulSessionIds + soulWebEnabled）同步给 body：POST /api/aura/sessions，
 * 供身体页的气泡/语音输出范围使用；session-api / config 写入口都会触发，挂载时先推一次。
 */
import { requestJson } from './voice.js'
import { importImConnectQq, redactConfig, writeConfig } from './state.js'
import { renderSoulPreview } from './soul.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostIsLoopback(req) {
  const host = req.headers && req.headers.host
  if (!host) return true
  const text = String(host)
  let name = text
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    name = end >= 0 ? text.slice(0, end + 1) : text
  } else {
    const colon = text.lastIndexOf(':')
    if (colon > 0) name = text.slice(0, colon)
  }
  return LOOPBACK.has(name.toLowerCase())
}

/** 围栏：本机 Host + 非跨站 + Origin 缺省或同源。灵魂数据比配置敏感，需要更严。 */
function fence(req) {
  if (!hostIsLoopback(req)) return false
  const site = req.headers['sec-fetch-site']
  if (site && String(site).toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
  if (origin) {
    try {
      const url = new URL(String(origin))
      if (!LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }
  return true
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  })
  res.end(data)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function safeCall(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback
  } catch {
    return fallback
  }
}

/* ---------------------------------------------------------------- Aura 会话集同步到 body */

const AURA_SESSIONS_SYNC_INTERVAL_MS = 5000
const AURA_SYNC_ERROR_LOG_INTERVAL_MS = 5 * 60_000
const DEFAULT_BODY_URL = 'https://127.0.0.1:3082'
let auraSessionsSyncKey = ''
let auraSessionsSyncInflight = null
let auraSessionsSyncFailureAt = 0

function bodyBaseUrl(state) {
  const env = String(process.env.DSH_AURA_VOICE_BODY_URL || '').trim()
  if (env) return env.replace(/\/+$/, '')
  try {
    const raw = state?.readJson?.('config.json', {}) ?? {}
    const configured = String(raw?.voiceBodyBaseUrl || '').trim()
    if (configured) return configured.replace(/\/+$/, '')
  } catch { /* ignore */ }
  return DEFAULT_BODY_URL
}

/** 当前 Aura 会话集：白名单 soulSessionIds + 全局 soulWebEnabled。 */
export function auraSessionsPayload(state) {
  const cfg = state.readConfig()
  const sessions = String(cfg.soulSessionIds || '').split(',').map(part => part.trim()).filter(Boolean)
  return { sessions, global: cfg.soulWebEnabled === true }
}

/**
 * 把 Aura 会话集合同步给 body（POST /api/aura/sessions）。
 * 内容没变就跳过；body 没起 / 接口还没上时只节流记日志，绝不阻断面板操作。
 */
export function syncAuraSessionsToBody(state, log, { force = false } = {}) {
  const payload = auraSessionsPayload(state)
  const key = `${payload.global ? '1' : '0'}|${payload.sessions.join(',')}`
  if (!force && key === auraSessionsSyncKey) return Promise.resolve({ ok: true, skipped: true, payload })
  if (auraSessionsSyncInflight) return auraSessionsSyncInflight
  const url = bodyBaseUrl(state) + '/api/aura/sessions'
  auraSessionsSyncInflight = requestJson(url, { method: 'POST', body: payload, timeoutMs: 2000 })
    .then(result => {
      auraSessionsSyncKey = key
      log?.(`[aura] 已同步 Aura 会话集到 body：${payload.sessions.length} 个会话，global=${payload.global}`)
      return { ok: true, payload, result }
    })
    .catch(error => {
      auraSessionsSyncKey = ''
      const message = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      if (!auraSessionsSyncFailureAt || now - auraSessionsSyncFailureAt > AURA_SYNC_ERROR_LOG_INTERVAL_MS) {
        auraSessionsSyncFailureAt = now
        log?.('[aura] 同步 Aura 会话集到 body 失败（静默重试）:', message)
      }
      return { ok: false, payload, error: message }
    })
    .finally(() => { auraSessionsSyncInflight = null })
  return auraSessionsSyncInflight
}

/** 兜底轮询：面板外入口（config-tool 等）改了白名单/全局开关时也能同步过去。 */
export function installAuraSessionsSync({ state, log }) {
  const timer = setInterval(() => { void syncAuraSessionsToBody(state, log) }, AURA_SESSIONS_SYNC_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

export function registerPanelApi(ctx, { state, service, soul, emotion, memory, speak, bridge, voice, log }) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log('[aura] 没有 webServer，面板 API 未注册')
    return
  }

  function soulPayload() {
    if (!soul) return undefined
    const snap = safeCall(() => soul.snapshot(), undefined)
    if (!snap) return undefined
    const emotionSnap = safeCall(() => emotion?.snapshot?.(), undefined) || snap.emotion
    const speakSnap = safeCall(() => speak?.snapshot?.(), undefined) || snap.speak
    const rawMemory = safeCall(() => memory?.store?.read?.(), undefined) || safeCall(() => soul.get?.()?.memory, undefined) || {}
    const memorySnap = safeCall(() => memory?.snapshot?.(), undefined) || {}
    const notes = rawMemory.notes && typeof rawMemory.notes === 'object' ? rawMemory.notes : {}
    const pickNotes = (list) => (Array.isArray(list) ? list.slice(-10) : [])
    return {
      identity: snap.identity || { name: state.readConfig().soulName, userNickname: state.readConfig().soulUserNickname },
      relation: snap.relation || { stage: 'stranger', score: 0 },
      emotion: emotionSnap,
      memory: {
        events: (Array.isArray(rawMemory.events) ? rawMemory.events : []).slice(-20).map(event => ({
          at: event.at,
          kind: event.kind,
          summary: event.summary || event.text || '',
        })),
        notes: {
          user: pickNotes(notes.user),
          us: pickNotes(notes.us),
          self: pickNotes(notes.self),
        },
        topics: Object.keys(rawMemory.topics && typeof rawMemory.topics === 'object' ? rawMemory.topics : {}).slice(0, 30),
        eventCount: memorySnap.eventCount,
        pendingDue: memorySnap.pendingDue,
      },
      speak: speakSnap,
      growth: Array.isArray(snap.growth) ? snap.growth : [],
      explainLog: Array.isArray(snap.explainLog) ? snap.explainLog.slice(-50) : [],
    }
  }

  // 会话级 Aura 开关：只改 config.soulSessionIds（逗号分隔）
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/dsh-aura/session-api',
    async handler(req, res) {
      if (!fence(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const url = new URL(String(req.url || '/'), 'http://localhost')
          const sessionId = String(url.searchParams.get('sessionId') || '')
          const cfg = state.readConfig()
          const ids = String(cfg.soulSessionIds || '').split(',').map(s => s.trim()).filter(Boolean)
          return json(res, 200, { ok: true, sessionId, soul: ids.includes(sessionId), global: cfg.soulWebEnabled === true })
        }
        if (req.method === 'POST') {
          const body = await readBody(req, 64 * 1024)
          const sessionId = String(body.sessionId || '').trim()
          if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId required' })
          const cfg = state.readConfig()
          const set = new Set(String(cfg.soulSessionIds || '').split(',').map(s => s.trim()).filter(Boolean))
          if (body.soul === true) set.add(sessionId); else set.delete(sessionId)
          state.writeConfig({ soulSessionIds: [...set].join(',') })
          // 会话白名单变了：立刻同步给 body（气泡/语音范围），失败不影响本次切换
          const synced = await syncAuraSessionsToBody(state, log, { force: true })
          const cfgAfter = state.readConfig()
          return json(res, 200, {
            ok: true,
            sessionId,
            soul: body.soul === true,
            global: cfgAfter.soulWebEnabled === true,
            sessions: [...set],
            synced: synced.ok === true,
          })
        }
        return json(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/dsh-aura/api',
    async handler(req, res) {
      if (!fence(req)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const route = url.pathname.replace(/^\/dsh-aura\/api/, '') || '/'
      try {
        if (req.method === 'GET' && route === '/state') {
          json(res, 200, {
            ok: true,
            config: redactConfig(state.readConfig()),
            auraSessions: auraSessionsPayload(state),
            status: service.status(),
            soul: soulPayload(),
            meme: safeCall(() => service.meme?.(), undefined),
            proactive: safeCall(() => speak?.snapshot?.(), undefined),
            sessions: Object.values(state.readSessions()),
            bridge: bridge ? bridge.stats() : undefined,
          })
          return
        }
        if (route === '/soul/preview' && (req.method === 'GET' || req.method === 'POST')) {
          let cfg = state.readConfig()
          if (req.method === 'POST') {
            const body = await readBody(req)
            const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
            cfg = { ...cfg }
            for (const key of ['soulName', 'soulUserNickname', 'soulEnabled', 'soulPromptBudget', 'soulBio', 'soulContent', 'soulInterests', 'soulStrengths', 'soulRelationGuidance']) {
              if (Object.prototype.hasOwnProperty.call(patch, key)) cfg[key] = patch[key]
            }
          }
          const text = renderSoulPreview(soul.get(), cfg)
          json(res, 200, { ok: true, text, chars: Array.from(text).length, budget: cfg.soulPromptBudget })
          return
        }
        if (req.method === 'GET' && route === '/soul/state') {
          json(res, 200, { ok: true, soul: soulPayload(), config: redactConfig(state.readConfig()) })
          return
        }
        if (req.method === 'POST' && route === '/config') {
          const patch = await readBody(req)
          writeConfig(patch)
          await syncAuraSessionsToBody(state, log)
          json(res, 200, { ok: true, config: redactConfig(state.readConfig()), status: service.status() })
          return
        }
        if (req.method === 'POST' && route === '/connect') {
          const patch = await readBody(req)
          if (Object.keys(patch).length) writeConfig(patch)
          await syncAuraSessionsToBody(state, log)
          const result = await service.start()
          json(res, 200, { ok: true, config: redactConfig(state.readConfig()), status: result })
          return
        }
        if (req.method === 'POST' && route === '/disconnect') {
          await service.stop()
          json(res, 200, { ok: true, config: redactConfig(state.readConfig()), status: service.status() })
          return
        }
        if (req.method === 'POST' && route === '/import') {
          const credentials = ctx.get?.('credentials')
          const imported = await importImConnectQq(credentials)
          if (!imported) {
            json(res, 200, { ok: false, error: '没有找到可导入的 QQ 凭据' })
            return
          }
          writeConfig(imported)
          await syncAuraSessionsToBody(state, log)
          json(res, 200, { ok: true, config: redactConfig(state.readConfig()), imported: { appId: imported.appId, hasSecret: !!imported.appSecret } })
          return
        }
        if (req.method === 'POST' && route === '/soul/reset') {
          const body = await readBody(req)
          const scope = body.scope === 'all' ? 'all' : body.scope === 'memory' ? 'memory' : 'emotion'
          const result = scope === 'memory'
            ? safeCall(() => memory?.clear?.(), { ok: false, error: 'memory 模块不可用' })
            : safeCall(() => soul?.reset?.(scope), { ok: false, error: 'soul 模块不可用' })
          json(res, 200, { ok: true, reset: scope, result, soul: soulPayload() })
          return
        }
        if (req.method === 'POST' && route === '/soul/pause') {
          const body = await readBody(req)
          const hours = Math.max(0, Math.min(720, Number(body.hours) || 0))
          const result = safeCall(() => soul?.pause?.(hours), { ok: false, error: 'soul 模块不可用' })
          json(res, 200, { ok: true, pausedHours: hours, result })
          return
        }
        if (req.method === 'GET' && route === '/debug/loader') {
          const loader = ctx.get?.('loader')
          let entries = []
          try { entries = loader?.entries?.() ?? [] } catch { entries = [] }
          const summary = entries.map(entry => ({
            name: entry?.options?.name,
            baseUrl: entry?.options?.baseUrl,
            keys: entry?.options ? Object.keys(entry.options) : [],
          }))
          const aura = entries.find(entry => String(entry?.options?.name || '') === 'dsh-aura')
          const info = { ok: true, total: entries.length, hasLoader: !!loader, aura: !!aura, names: summary.filter(item => String(item.name || '').includes('aura')) }
          if (aura) {
            info.auraOptions = Object.fromEntries(Object.entries(aura.options || {}).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
            const internal = loader?.internal
            info.hasInternal = !!internal && typeof internal.resolveSync === 'function'
            info.internalVersion = internal?.version
            if (info.hasInternal) {
              try {
                const baseUrl = aura.options?.baseUrl || loader?.baseUrl || import.meta.url
                const result = internal.version === 'v2'
                  ? internal.resolveSync(baseUrl, { specifier: 'dsh-aura', attributes: {} })
                  : internal.resolveSync('dsh-aura', baseUrl, {})
                info.resolve = result && { url: result.url, version: result.version }
              } catch (error) {
                info.resolveError = error instanceof Error ? error.message : String(error)
              }
              try {
                info.profileBase = loader?.baseUrl
              } catch { /* ignore */ }
            }
          }
          json(res, 200, info)
          return
        }
        if (req.method === 'GET' && route === '/debug/client') {
          const modules = ctx.get?.('clientModules')
          const graph = modules?.graph?.()
          json(res, 200, {
            ok: true,
            path: modules?.clientPath?.('dsh-aura'),
            entries: graph?.entries?.map(entry => ({ id: entry.id, url: entry.url, rev: entry.rev })),
            batches: graph?.batches,
            rev: graph?.rev,
          })
          return
        }
        if (req.method === 'POST' && route === '/debug/media') {
          // 本机调试：把一张图/文件按“当前 QQ 被动回复上下文”发出去，验证媒体链路。
          const body = await readBody(req)
          const path = String(body.path || '')
          if (!path) {
            json(res, 400, { ok: false, error: '缺少 path' })
            return
          }
          const records = Object.values(state.readSessions())
          const record = records[records.length - 1]
          if (!record?.sessionId) {
            json(res, 400, { ok: false, error: '还没有绑定 QQ 会话' })
            return
          }
          const exec = { agent: { session: { id: record.sessionId, header: { cwd: record.cwd || process.cwd() } } } }
          try {
            const result = await bridge.returnFile(path, exec)
            json(res, 200, { ok: true, result })
          } catch (error) {
            json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method === 'POST' && (route === '/speak/tick' || route === '/proactive/tick')) {
          const body = await readBody(req)
          const mode = body.mode === 'real' ? 'real' : body.mode === 'dry' ? 'dry' : undefined
          const result = await speak?.tick?.({ mode, manual: true, trigger: 'manual' })
          json(res, 200, { ok: true, result, soul: soulPayload(), status: service.status() })
          return
        }
        // ---- 语音闭环（唤醒词→ASR→Aura→身体说话）手测入口 ----
        if (req.method === 'GET' && route === '/voice/state') {
          let bodyVoice
          try {
            if (voice && typeof voice.bodyVoiceConfig === 'function') bodyVoice = await voice.bodyVoiceConfig()
          } catch { /* body 不可达时只看通道自身状态 */ }
          json(res, 200, {
            ...(voice ? safeCall(() => voice.snapshot(), { ok: false }) : { ok: false, error: 'voice 模块未安装' }),
            bodyVoice,
          })
          return
        }
        if (req.method === 'POST' && route === '/voice/utterance') {
          if (!voice || typeof voice.voiceUtterance !== 'function') {
            json(res, 503, { ok: false, error: 'voice 模块未安装' })
            return
          }
          const body = await readBody(req)
          const text = String(body?.text ?? '').trim()
          if (!text) {
            json(res, 400, { ok: false, error: 'text required' })
            return
          }
          const result = await voice.voiceUtterance(text, { source: 'web-test' })
          json(res, 200, { ok: result?.ok !== false, result, voice: safeCall(() => voice.snapshot(), undefined) })
          return
        }
        json(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        log('[aura] 面板 API 失败:', error instanceof Error ? error.message : error)
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
