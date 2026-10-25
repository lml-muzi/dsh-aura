/**
 * dsh-aura Host 半：自研 QQ 渠道 + 灵魂层（身份/情绪/记忆/主动搭话）+ 面板 API。
 * Client 半（client.js）负责左侧栏全局面板与可自定义外观。
 */
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import * as state from './host/state.js'
import { QQClient } from './host/qq.js'
import { ChannelBridge } from './host/bridge.js'
import { installMedia } from './host/media.js'
import { installSoul } from './host/soul.js'
import { installEmotion } from './host/emotion.js'
import { installMemory } from './host/memory.js'
import { installSpeak } from './host/speak.js'
import { registerPanelApi } from './host/web.js'

export const name = 'dsh-aura'

export const inject = ['tools', 'webServer', 'agents', 'agentPresets', 'agentDefaultModel', 'systemPrompt']

export function apply(ctx, config = {}) {
  const logFile = join(state.stateDir(), 'run.log')
  const log = (...parts) => {
    const line = new Date().toISOString() + ' ' + parts.map(part => {
      if (part instanceof Error) return part.stack || part.message
      if (typeof part === 'string') return part
      try { return JSON.stringify(part) } catch { return String(part) }
    }).join(' ')
    console.log('[dsh-aura]', line)
    try {
      if (statSync(logFile).size > 2 * 1024 * 1024) truncateSync(logFile, 0)
    } catch { /* 文件还不存在 */ }
    try { appendFileSync(logFile, line + '\n') } catch { /* 日志失败不影响运行 */ }
  }

  const safe = (fn, label) => {
    try {
      return fn()
    } catch (error) {
      log(`[aura] ${label} 失败:`, error instanceof Error ? error.message : error)
      return undefined
    }
  }

  // ---- 灵魂层：soul 是唯一观察 session/event 的地方，emotion/memory 订阅它的事件 ----
  const soul = installSoul(ctx, { state, log })
  const disposers = []
  safe(() => disposers.push(soul.on('user', payload => {
    safe(() => emotion.onUserMessage?.(payload), 'emotion.onUserMessage')
    safe(() => memory.onUserMessage?.(payload), 'memory.onUserMessage')
  })), 'soul user listener')
  safe(() => disposers.push(soul.on('assistant', payload => {
    safe(() => emotion.onAssistantMessage?.(payload), 'emotion.onAssistantMessage')
    safe(() => memory.onAssistantMessage?.(payload), 'memory.onAssistantMessage')
  })), 'soul assistant listener')
  safe(() => disposers.push(soul.on('turnEnd', payload => {
    safe(() => memory.onTurnEnd?.(payload), 'memory.onTurnEnd')
  })), 'soul turnEnd listener')

  // ---- QQ 通道 ----
  let bridge
  const qq = new QQClient({
    log,
    getConfig: () => state.readConfig(),
    onEvent: (event) => {
      if (!bridge) return
      void bridge.handleEvent(event).catch(error => {
        log('[aura] 事件处理失败:', error instanceof Error ? error.message : error)
      })
    },
    onStatus: (status) => {
      log(`[aura] 连接状态 ${status?.online ? 'online' : 'offline'}${status?.lastError ? ` (${status.lastError})` : ''}`)
    },
  })
  bridge = new ChannelBridge({ ctx, state, qq, log })
  installMedia(ctx, { bridge, log })

  // ---- 情绪 / 记忆 / 主动搭话 ----
  const emotion = installEmotion(ctx, { state, soul, bridge, log })
  const memory = installMemory(ctx, { state, soul, log })
  const speak = installSpeak(ctx, { state, soul, emotion, memory, bridge, log })
  safe(() => bridge.setTextFilter((text, options) => speak.checkProactiveText?.(text, options)), 'bridge.setTextFilter')

  let starting = null
  const status = () => ({
    ...qq.status(),
    bridge: bridge.stats(),
    configured: !!(state.readConfig().appId && state.readConfig().appSecret),
    soul: safe(() => soul.snapshot(), undefined),
    speak: safe(() => speak.snapshot(), undefined),
  })
  const start = async () => {
    const cfg = state.readConfig()
    if (!cfg.appId || !cfg.appSecret) throw new Error('尚未配置 QQ 机器人 AppID / AppSecret')
    if (starting) return starting
    starting = qq.start().then(() => status()).finally(() => { starting = null })
    return starting
  }
  const stop = async () => {
    starting = null
    await qq.stop()
  }

  const service = Object.freeze({
    start,
    stop,
    status,
    config: () => state.redactConfig(state.readConfig()),
    soul: () => safe(() => soul.snapshot(), {}),
    speak: () => safe(() => speak.snapshot(), {}),
    memory: () => safe(() => memory.snapshot(), {}),
  })

  try {
    ctx.effect(() => {
      const dispose = ctx.provide('dshAura', service)
      return () => { if (typeof dispose === 'function') dispose() }
    })
  } catch (error) {
    log('[aura] 注册 dshAura 服务失败:', error instanceof Error ? error.message : error)
  }

  registerPanelApi(ctx, { state, service, soul, emotion, memory, speak, bridge, log })

  const cfg = state.readConfig()
  if (cfg.autoConnect !== false && cfg.appId && cfg.appSecret) {
    start().catch(error => log('[aura] 自动连接失败:', error instanceof Error ? error.message : error))
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) safe(dispose, 'dispose soul listener')
    safe(() => speak.stop?.(), 'speak.stop')
    void stop()
    void bridge.dispose()
    safe(() => soul.saveNow?.(), 'soul.saveNow')
  })

  log(`[aura] 已挂载（${cfg.appId ? '已配置凭据' : '等待配置'}）`)
}
