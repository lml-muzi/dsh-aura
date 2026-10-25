/**
 * QQ 渠道传输层的可切换入口。
 *
 *   channelImpl = 'sdk'    → 腾讯官方 @tencent-connect/qqbot-nodejs（默认，协议/重连/媒体交给官方）
 *   channelImpl = 'legacy' → 早期自研 WebSocket 协议实现（host/qq-legacy.js，保留作回退）
 *
 * 两者都实现同一份 QQClient 契约：
 *   new QQClient({ log, getConfig, onEvent, onStatus })
 *   await start() / await stop() / status()
 *   await sendText({ kind, chatId, msgId, seq, text })
 *   await sendMedia({ kind, chatId, msgId, seq, bytes, name, image })
 *
 * bridge 与会话/拆句/出站顺序逻辑不感知实现差异。
 */
import { QQClient as LegacyClient } from './qq-legacy.js'

let sdkModulePromise

async function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('./qq-sdk.js').catch(error => {
      console.warn('[dsh-aura] QQ SDK 适配器不可用，回退 legacy:', error instanceof Error ? error.message : error)
      return undefined
    })
  }
  return sdkModulePromise
}

export class QQClient {
  constructor(options = {}) {
    this.options = options
    this.log = typeof options.log === 'function' ? options.log : (...args) => console.log('[dsh-aura]', ...args)
    this.impl = 'legacy'
    this.inner = new LegacyClient(options)
  }

  _config() {
    try {
      return typeof this.options.getConfig === 'function' ? this.options.getConfig() : {}
    } catch {
      return {}
    }
  }

  status() {
    const status = this.inner?.status?.() || {}
    return { ...status, impl: this.impl }
  }

  async start() {
    const config = this._config()
    const wanted = config?.channelImpl === 'legacy' ? 'legacy' : 'sdk'
    if (wanted === 'legacy') {
      this.impl = 'legacy'
      this.inner = new LegacyClient(this.options)
      await this.inner.start()
      return this.status()
    }
    const sdk = await loadSdk()
    if (sdk?.QQClient) {
      const client = new sdk.QQClient(this.options)
      try {
        await client.start()
        this.inner = client
        this.impl = 'sdk'
        return this.status()
      } catch (error) {
        this.log('[qq] SDK 连接失败，回退 legacy:', error instanceof Error ? error.message : error)
        try { await client.stop() } catch { /* ignore */ }
      }
    }
    this.impl = 'legacy'
    this.inner = new LegacyClient(this.options)
    await this.inner.start()
    return this.status()
  }

  async stop() {
    try {
      await this.inner?.stop?.()
    } catch (error) {
      this.log('[qq] 停止连接失败:', error instanceof Error ? error.message : error)
    }
  }

  async sendText(payload) {
    if (!this.inner) throw new Error('QQ 客户端尚未初始化')
    return this.inner.sendText(payload)
  }

  async sendMedia(payload) {
    if (!this.inner) throw new Error('QQ 客户端尚未初始化')
    return this.inner.sendMedia(payload)
  }
}
