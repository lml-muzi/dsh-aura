/**
 * soul_config：给 Aura 一个受控的配置口。
 * 只允许改节奏/主动/记忆/日记这类运行参数；灵魂身份、QQ 凭据、Aura 模式开关不在白名单。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const FIELDS = {
  speakEnabled: 'boolean',
  speakDryRun: 'boolean',
  speakIntervalMinutes: 'number',
  speakCooldownMinutes: 'number',
  speakDailyCap: 'number',
  quietEnabled: 'boolean',
  quietStart: 'string',
  quietEnd: 'string',
  speakWakeRecentHours: 'number',
  speakShareRecentHours: 'number',
  speakProactiveRecentHours: 'number',
  speakShareCooldownMinutes: 'number',
  speakShareDailyCap: 'number',
  speakSocialNeedWeight: 'number',
  speakShareEnabled: 'boolean',
  speakEmotionSensitivity: 'number',
  lifeRandom: 'boolean',
  lifeQuietSleep: 'boolean',
  lifeWakeGreeting: 'boolean',
  memoryEnabled: 'boolean',
  memoryContextBudget: 'number',
  memoryAnchorEveryTurns: 'number',
  memoryInjectIdleMinutes: 'number',
  memoryOldAfterDays: 'number',
  memoryOldMode: 'string',
  memoryOldRecentDays: 'number',
  memoryOldEveryTurns: 'number',
  memoryOldChance: 'number',
  memoryAttentionCount: 'number',
  memoryAttentionThreshold: 'number',
  diaryAuto: 'boolean',
  diaryAutoHour: 'number',
  diaryAutoMinEvents: 'number',
  expressionStyle: 'string',
  archiveEnabled: 'boolean',
  archiveDays: 'number',
}

const LABELS = {
  speakEnabled: '主动搭话',
  speakDryRun: '试运行',
  speakIntervalMinutes: '主动间隔（分钟）',
  speakCooldownMinutes: '主动冷却（分钟）',
  speakDailyCap: '主动每日上限',
  quietEnabled: '静默时段',
  quietStart: '静默开始',
  quietEnd: '静默结束',
  speakWakeRecentHours: '醒来互动窗口（小时）',
  speakShareRecentHours: '分享互动窗口（小时）',
  speakProactiveRecentHours: '普通主动互动窗口（小时）',
  speakShareCooldownMinutes: '分享冷却（分钟）',
  speakShareDailyCap: '分享每日上限',
  speakSocialNeedWeight: '社交需求权重',
  speakShareEnabled: '允许分享欲',
  speakEmotionSensitivity: '情绪权重',
  lifeRandom: '随机生活',
  lifeQuietSleep: '睡觉不打扰',
  lifeWakeGreeting: '醒来打招呼',
  memoryEnabled: '记忆',
  memoryContextBudget: '记忆上下文预算',
  memoryAnchorEveryTurns: '记忆锚点间隔（轮）',
  memoryInjectIdleMinutes: '久别刷新（分钟）',
  memoryOldAfterDays: '旧事门槛（天）',
  memoryOldMode: '旧事模式',
  memoryOldRecentDays: '除最近天数',
  memoryOldEveryTurns: '旧事间隔（轮）',
  memoryOldChance: '旧事概率',
  memoryAttentionCount: '注意力条数',
  memoryAttentionThreshold: '注意力阈值',
  diaryAuto: '自动写日记',
  diaryAutoHour: '自动写日记时间（点）',
  diaryAutoMinEvents: '日记最少事件',
  expressionStyle: '表达方式',
  archiveEnabled: '记忆罗盘',
  archiveDays: '存档保留天数',
}

function subset(config) {
  const out = {}
  for (const key of Object.keys(FIELDS)) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

export function installConfigTool({ ctx, state, log } = {}) {
  const logger = typeof log === 'function' ? log : (...args) => console.log('[dsh-aura]', ...args)
  if (!ctx || !state) return { ok: false }

  let dispose = null
  try {
    dispose = ctx.tools?.register?.(defineTool({
      name: 'soul_config',
      description: '调整你自己的运行节奏（主动搭话、静默、分享、记忆注入、日记等）。只在真的需要改变节奏时用；一次改一到几项；不要把参数数值报给用户。灵魂身份和 QQ 凭据不在这里。',
      parameters: {
        action: { type: 'string', description: 'get 查看当前；set 修改', enum: ['get', 'set'], required: true },
        patch: {
          type: 'object',
          description: 'set 时传要改的字段，例如 { "speakIntervalMinutes": 45 }；字段名用当前面板里的配置名',
          additionalProperties: true,
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok === false
            ? `配置未改：${value.reason || ''}`
            : `配置已更新：${Object.entries(value?.changed || {}).map(([k, v]) => `${LABELS[k] || k}=${v}`).join('，') || '无变化'}`,
        }],
      },
      async execute(args = {}) {
        const action = String(args.action || 'get')
        const config = state.readConfig()
        if (action === 'get') return { ok: true, config: subset(config) }
        if (action !== 'set') return { ok: false, reason: 'action 只能是 get 或 set' }
        const patch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch : {}
        const keys = Object.keys(patch)
        if (!keys.length) return { ok: false, reason: 'patch 不能为空' }
        const unknown = keys.filter(key => !(key in FIELDS))
        if (unknown.length) return { ok: false, reason: `不支持的字段：${unknown.join('、')}` }
        const save = {}
        for (const key of keys) {
          const expected = FIELDS[key]
          const value = patch[key]
          if (expected === 'boolean' && typeof value !== 'boolean') return { ok: false, reason: `${key} 需要 true/false` }
          if (expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, reason: `${key} 需要数字` }
          if (expected === 'string' && typeof value !== 'string') return { ok: false, reason: `${key} 需要字符串` }
          save[key] = value
        }
        try {
          const backup = await import('./backup.js')
          await backup.snapshot('config', { reason: 'soul-config' })
        } catch (error) {
          logger('[soul_config] 配置备份失败（继续）:', error instanceof Error ? error.message : error)
        }
        state.writeConfig(save)
        const after = state.readConfig()
        const changed = {}
        for (const key of keys) changed[key] = after[key]
        return { ok: true, changed, config: subset(after) }
      },
    }))
  } catch (error) {
    logger('[soul_config] 注册失败:', error instanceof Error ? error.message : error)
  }
  return { ok: Boolean(dispose), dispose }
}
