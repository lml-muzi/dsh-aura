/**
 * Aura 表面作用域：把 Aura 的 prompt 段 / soul_* 工具限制在 Aura 会话里。
 *
 * DSH 的 prompt 段和工具是宿主全局注册的；对非 Aura 会话，这里用
 * `agent.ctx`（agent 作用域）做两件事：
 *   1. 以同名注册空 section/context —— DSH 允许 per-agent override，覆盖全局段；
 *   2. `agent.ctx.tools.restrict({ deny: AURA_TOOLS })` 隐藏 Aura 工具 schema。
 *
 * 只对「当前非 Aura」的 agent 生效；会话被切换成 Aura 后会撤掉覆盖/限制。
 */
import { isSoulSession } from './soul.js'

const AURA_SECTIONS = ['aura:soul-identity', 'aura:meme']
const AURA_CONTEXTS = ['aura:growth', 'aura:presence', 'aura:memory', 'aura:emotion', 'aura:intent', 'aura:meme-mode', 'aura:multi-message']
const AURA_TOOLS = [
  'soul_archive', 'soul_config', 'soul_diary', 'soul_evolve', 'soul_feel', 'soul_life',
  'soul_memory', 'soul_mood', 'soul_recall', 'soul_say', 'soul_share',
  'send_meme', 'learn_meme',
]

export function installSurfaceScope({ ctx, state, log = () => {}, getConfig = () => ({}) }) {
  const applied = new Map() // sessionId -> disposers[]
  let syncTimer = null
  let disposed = false

  function sessionOf(agent) {
    return agent && agent.session ? agent.session : null
  }

  function isAuraAgent(agent) {
    const session = sessionOf(agent)
    const id = String((session && session.id) || '')
    if (!id) return false
    return isSoulSession(getConfig() || {}, id, session && session.header && session.header.agentPreset)
  }

  function serviceOf(agent, name) {
    try {
      const services = agent && agent.ctx
      if (!services) return undefined
      const value = typeof services.get === 'function' ? services.get(name) : services[name]
      return value
    } catch {
      return undefined
    }
  }

  function blankPrompt(agent) {
    const disposers = []
    const prompt = serviceOf(agent, 'systemPrompt')
    if (!prompt) return disposers
    for (const name of AURA_SECTIONS) {
      try {
        disposers.push(prompt.section({ name, order: 20, interpolate: false, text: '' }))
      } catch (error) {
        log('[surface] 覆盖 section 失败 ' + name + ':', error instanceof Error ? error.message : String(error))
      }
    }
    for (const name of AURA_CONTEXTS) {
      try {
        disposers.push(prompt.context({ name, order: 45, text: '' }))
      } catch (error) {
        log('[surface] 覆盖 context 失败 ' + name + ':', error instanceof Error ? error.message : String(error))
      }
    }
    return disposers
  }

  function restrictTools(agent) {
    const tools = serviceOf(agent, 'tools')
    if (!tools || typeof tools.restrict !== 'function') return []
    let names = AURA_TOOLS
    try {
      const schemas = typeof tools.schemas === 'function' ? tools.schemas(agent) : null
      if (Array.isArray(schemas)) {
        const have = new Set(schemas.map((item) => item && item.name).filter(Boolean))
        names = AURA_TOOLS.filter((name) => have.has(name))
      }
    } catch { /* 保持原列表 */ }
    if (!names.length) return []
    try {
      return [tools.restrict({ deny: names })]
    } catch (error) {
      log('[surface] 隐藏 Aura 工具失败:', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  function applyFor(agent) {
    const session = sessionOf(agent)
    const id = String((session && session.id) || '')
    if (!id || disposed) return
    const aura = isAuraAgent(agent)
    const previous = applied.get(id)
    if (!aura) {
      if (previous) return
      const disposers = [...blankPrompt(agent), ...restrictTools(agent)]
      if (disposers.length) {
        applied.set(id, disposers)
        log('[surface] 非 Aura 会话已隐藏 Aura 段/工具: ' + id.slice(0, 28))
      }
      return
    }
    if (previous) {
      for (const dispose of previous) {
        try { dispose?.() } catch { /* ignore */ }
      }
      applied.delete(id)
      log('[surface] Aura 会话恢复 Aura 段/工具: ' + id.slice(0, 28))
    }
  }

  function sync() {
    if (disposed) return
    let agents = []
    try {
      agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    } catch { agents = [] }
    const seen = new Set()
    for (const agent of agents) {
      const id = String((agent?.session && agent.session.id) || '')
      if (!id) continue
      seen.add(id)
      applyFor(agent)
    }
    for (const [id, disposers] of applied) {
      if (seen.has(id)) continue
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* ignore */ }
      }
      applied.delete(id)
    }
  }

  function scheduleSync() {
    if (syncTimer || disposed) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      try { sync() } catch (error) {
        log('[surface] sync 失败:', error instanceof Error ? error.message : String(error))
      }
    }, 500)
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
  }

  // 新会话 / 会话切换都跟着 sync；另加低频兜底
  let offEvent = null
  try {
    offEvent = ctx.on('session/event', () => scheduleSync(), { global: true })
  } catch { /* ignore */ }
  const interval = setInterval(() => { try { sync() } catch { /* ignore */ } }, 5000)
  if (typeof interval.unref === 'function') interval.unref()
  sync()

  return {
    sync,
    dispose() {
      disposed = true
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = null
      clearInterval(interval)
      try { offEvent?.() } catch { /* ignore */ }
      for (const disposers of applied.values()) {
        for (const dispose of disposers) {
          try { dispose?.() } catch { /* ignore */ }
        }
      }
      applied.clear()
    },
  }
}
