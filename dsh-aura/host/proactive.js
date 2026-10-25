/**
 * 主动打扰（v1）：闲太久了就让 agent 主动找用户说一句。
 *
 * 做法：不用插件自己造消息，而是借宿主 schedule 服务往绑定会话投一条「该说话了」的提醒，
 * agent 正常起一轮、生成一句人话；它的 assistant/message 会被 bridge 投递给 QQ。
 * 若被动回复窗口已过，QQ 客户端会尝试主动消息（平台可能拒绝），失败只记日志不打扰用户。
 */
const TICK_MS = 60_000
const STATE_FILE = 'proactive.json'

function minutesOf(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function inQuietHours(config, now = new Date()) {
  const start = minutesOf(config.quietStart)
  const end = minutesOf(config.quietEnd)
  if (start === null || end === null || start === end) return false
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

/** 给模型看的刺激文本：明确这是系统提醒、不是用户消息。 */
function wakePrompt(minutes) {
  return [
    '（系统提醒，不是用户发来的消息）',
    '你已经 ' + minutes + ' 分钟没和用户说话了。现在你想主动找他聊一句：可以分享你此刻的心情或想到的小事，也可以关心一下他在做什么。',
    '要求：15～60 个字，口语化，别像客服，别重复你上次说过的话题，不要解释这条提醒。',
    '如果想配一张表情包，可以照常走表情包流程。',
  ].join('\n')
}

export function installProactive(ctx, { state, bridge, log }) {
  const readState = () => state.readJson(STATE_FILE, {})
  const writeState = (value) => state.writeJson(STATE_FILE, value)
  let timer = null

  function snapshot() {
    const config = state.readConfig()
    const saved = readState()
    return {
      enabled: config.proactiveEnabled === true,
      everyMinutes: Number(config.proactiveEveryMinutes) || 90,
      quietStart: config.quietStart,
      quietEnd: config.quietEnd,
      lastProactiveAt: saved.lastProactiveAt || 0,
      lastReason: saved.lastReason || '',
    }
  }

  async function tick() {
    const config = state.readConfig()
    if (config.proactiveEnabled !== true) return
    if (typeof bridge?.isOnline === 'function' && !bridge.isOnline()) return
    const schedule = ctx.get?.('schedule')
    if (!schedule || typeof schedule.create !== 'function') return
    const target = bridge?.pickProactiveTarget?.()
    if (!target) return
    const everyMinutes = Math.max(5, Number(config.proactiveEveryMinutes) || 90)
    const idleMinutes = (Date.now() - (target.lastActiveAt || 0)) / 60_000
    if (idleMinutes < everyMinutes) return
    if (inQuietHours(config)) return
    const saved = readState()
    if (saved.lastProactiveAt && Date.now() - saved.lastProactiveAt < everyMinutes * 60_000) return
    try {
      await schedule.create(target.sessionId, {
        title: '主动找用户说句话',
        prompt: wakePrompt(Math.round(idleMinutes)),
        after_seconds: 1,
      })
      writeState({ lastProactiveAt: Date.now(), lastSessionId: target.sessionId, lastReason: 'idle-' + Math.round(idleMinutes) + 'm' })
      log(`[qq] 主动打扰：会话 ${target.sessionId}（闲置 ${Math.round(idleMinutes)} 分钟）`)
    } catch (error) {
      log('[qq] 主动打扰投递失败:', error instanceof Error ? error.message : error)
    }
  }

  ctx.effect(() => {
    timer = setInterval(() => {
      void tick().catch(error => log('[qq] 主动打扰检查失败:', error instanceof Error ? error.message : error))
    }, TICK_MS)
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  })

  return { snapshot, tick }
}
