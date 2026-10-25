/** dsh-aura Client 半：左侧栏入口（名字/图标可自定义）+ 全局面板（状态 / 凭据 / 消息 / 情绪 / 主动打扰 / 外观）。 */
window.__ModuleLoader__.load({
  id: 'dsh-aura',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-aura/api'
    const NS = 'dsh-aura'
    /** 面板可见时轮询状态的间隔。 */
    const POLL_MS = 5000
    /** QQ 被动回复每条入站消息的上限。 */
    const MAX_REPLIES = 5
    const EVERY_MIN = 5
    const EVERY_MAX = 24 * 60

    /** 内置单色 SVG 图标；emoji 走文字渲染。 */
    const ICON_PRESETS = ['aura', 'qq', 'heart', 'cat', 'star', 'moon']
    /** 图标选择网格的完整选项：6 个内置 SVG + emoji。 */
    const ICON_CHOICES = ICON_PRESETS.concat(['emoji'])
    const DEFAULT_DISPLAY_NAME = 'Aura'
    const DEFAULT_EMOJI = '🐳'
    const DISPLAY_NAME_MAX = 24

    /**
     * 模块级外观状态：侧栏名字和图标不依赖面板是否打开。
     * - 侧栏 label thunk 每次解析时读 appearance.displayName；
     * - 图标组件通过 subscribeAppearance 重渲染；
     * - 名字变化时重新注册 panellist 条目，让侧栏重算 metadata。
     */
    let appearance = {
      displayName: DEFAULT_DISPLAY_NAME,
      iconPreset: 'aura',
      iconEmoji: DEFAULT_EMOJI,
    }
    const appearanceListeners = new Set()

    /** 把 Host config 收敛成外观三元组（缺失/非法值都回落到默认）。 */
    function configToAppearance(config) {
      const cfg = config && typeof config === 'object' ? config : {}
      const name = typeof cfg.displayName === 'string' ? cfg.displayName.trim().slice(0, DISPLAY_NAME_MAX) : ''
      const candidate = typeof cfg.iconPreset === 'string' ? cfg.iconPreset : ''
      const emoji = typeof cfg.iconEmoji === 'string' ? (Array.from(cfg.iconEmoji.trim())[0] || '') : ''
      return {
        displayName: name || DEFAULT_DISPLAY_NAME,
        iconPreset: ICON_CHOICES.includes(candidate) ? candidate : 'aura',
        iconEmoji: emoji || DEFAULT_EMOJI,
      }
    }

    function appearanceKey(value) {
      return JSON.stringify([value.displayName, value.iconPreset, value.iconEmoji])
    }

    /** 更新模块级外观；只有真的变了才通知订阅者。 */
    function setAppearance(config) {
      const next = configToAppearance(config)
      if (appearanceKey(next) === appearanceKey(appearance)) return
      appearance = next
      for (const listener of [...appearanceListeners]) {
        try {
          listener(appearance)
        } catch (error) {
          console.error('[dsh-aura] 外观订阅回调失败：', error)
        }
      }
    }

    function subscribeAppearance(listener) {
      appearanceListeners.add(listener)
      return () => {
        appearanceListeners.delete(listener)
      }
    }

    /** 简体中文文案（也是缺词时的兜底）。 */
    const ZH = {
      'title': 'Aura',
      'subtitle': 'Aura · 自研 QQ 渠道 · 原生表情图 · 正则拆句 · 情绪与主动打扰',
      'status.online': '已连接',
      'status.offline': '未连接',
      'status.unconfigured': '未配置',
      'section.status': '运行状态',
      'row.connection': '连接状态',
      'row.connection.configuredHint': 'AppID 与 AppSecret 已保存',
      'row.connection.unconfiguredHint': '还没有填写 AppID / AppSecret',
      'row.startedAt': '本次运行',
      'row.uptime': '已运行',
      'row.lastError': '最近错误',
      'section.credentials': '机器人凭据',
      'row.appId': 'AppID',
      'row.appId.hint': 'QQ 开放平台机器人的 AppID',
      'row.appSecret': 'AppSecret',
      'row.appSecret.saved': '已保存，留空则保持不变',
      'row.appSecret.placeholder': '在 QQ 开放平台获取',
      'section.messages': '消息与拆句',
      'row.splitEnabled': '按正则拆句',
      'row.splitEnabled.hint': '把一段回复拆成多条 QQ 消息，更像真人在聊天',
      'row.splitRegex': '拆句正则',
      'row.splitRegex.hint': '默认按空行拆句；关闭开关后整段发送',
      'row.maxMessages': '每回合最多消息条数',
      'row.maxMessages.hint': '含图片；QQ 被动回复每条入站消息上限 5 条',
      'row.cwd': '会话工作区',
      'row.cwd.placeholder': '/data/data/com.termux/files/home/workspace',
      'row.cwd.hint': '留空则使用默认工作区',
      'section.mood': '情绪',
      'row.mood.note': '最近印象',
      'row.mood.updated': '更新于 {time}',
      'mood.valence': '愉悦',
      'mood.arousal': '唤醒',
      'mood.affection': '亲近',
      'mood.energy': '精力',
      'mood.empty': '还没有情绪记录。聊几句之后，模型会自己更新心情。',
      'section.proactive': '主动打扰',
      'row.proactiveEnabled': '开启主动打扰',
      'row.proactiveEnabled.hint': '空闲太久时，模型可以主动找你聊一句',
      'row.proactiveEvery': '空闲间隔',
      'row.proactiveEvery.hint': '5–1440 分钟，按分钟计算闲置时长',
      'row.proactiveEvery.suffix': '分钟',
      'row.quiet': '静默时段',
      'row.quiet.hint': '静默时段内不会主动发消息；留空表示不设静默时段',
      'row.quiet.to': '至',
      'row.lastProactive': '上次主动',
      'row.lastProactive.never': '还没有主动打扰过',
      'row.lastProactive.reason': '原因：{reason}',
      'section.sessions': '已绑定会话',
      'sessions.empty': '还没有 QQ 会话。机器人连上后，收到的私聊和群聊会出现在这里。',
      'sessions.group': '群聊',
      'sessions.direct': '私聊',
      'sessions.count': '{count} 个',
      'button.save': '保存',
      'button.connect': '保存并连接',
      'button.disconnect': '断开',
      'button.import': '从 IM Connect 导入',
      'busy.save': '保存中…',
      'busy.connect': '连接中…',
      'busy.disconnect': '断开中…',
      'busy.import': '导入中…',
      'notice.saved': '已保存',
      'notice.connected': '已连接',
      'notice.disconnected': '已断开',
      'notice.imported': '已导入凭据',
      'notice.importedNoSecret': '已导入 AppID，没找到 AppSecret，请手动填写',
      'error.quietFormat': '静默时段格式应为 HH:MM，例如 23:30',
      'error.load': '读取状态失败',
      'error.connect': '连接失败',
      'loading': '正在读取状态…',
      'note.footer': '表情图片由 dsh_im_return_file 在正文之前作为原生图片发送；每条入站消息最多回复 5 条；被动回复窗口过期后，主动消息可能被平台拒绝。',
      'section.appearance': '外观',
      'row.displayName': '显示名',
      'row.displayName.hint': '左侧栏入口和面板标题都用这个名字（1–24 字）',
      'row.icon': '图标',
      'row.iconEmoji': 'Emoji',
      'row.iconEmoji.hint': '单字符，选中 Emoji 图标时生效',
      'row.preview': '预览',
      'button.lookSave': '保存外观',
      'busy.look': '保存中…',
      'notice.lookSaved': '外观已更新',
      'error.displayName': '显示名不能为空',
      'error.soulName': '灵魂名字不能为空',
      'error.emoji': '请填一个 emoji 字符',
      'icon.aura': '光环',
      'icon.qq': 'QQ',
      'icon.heart': '爱心',
      'icon.cat': '猫',
      'icon.star': '星星',
      'icon.moon': '月亮',
      'icon.emoji': 'Emoji',
      'look.untitled': '未命名',
      'section.soul': '灵魂',
      'row.soulName': '灵魂名字',
      'row.soulName.hint': '她对自己的称呼，用于自我叙事（1–20 字）',
      'row.soulUserNickname': '对你的昵称',
      'row.soulUserNickname.hint': '她怎么叫你；留空就用「你」',
      'row.soulUserNickname.placeholder': '例如：小鲸鱼',
      'row.soulEnabled': '启用灵魂层',
      'row.soulEnabled.hint': '关闭后不注入身份 / 情绪 / 记忆上下文',
      'row.soulHonestyLine': '诚实边界',
      'row.soulHonestyLine.hint': '提示她承认自己是 AI、情绪是模拟状态',
      'row.soulBudget': '提示词预算',
      'soul.budgetValue': '约 {n} 字（软上限）',
      'soul.budgetUnknown': '未设置',
      'soul.identityName': '自我认知名字',
      'button.soulSave': '保存灵魂设置',
      'notice.soulSaved': '灵魂设置已保存',
      'section.emotion': '情绪',
      'row.expressionStyle': '表达方式',
      'row.expressionStyle.hint': '含蓄只影响语气 · 直白会说出感受 · 关闭则不注入情绪',
      'style.subtle': '含蓄',
      'style.explicit': '直白',
      'style.off': '关闭',
      'row.emotionLastChange': '最近一次变化',
      'emotion.empty': '还没有情绪数据（灵魂层启动后会自动记录）',
      'button.emotionSave': '保存情绪设置',
      'notice.emotionSaved': '情绪设置已保存',
      'section.relation': '关系',
      'relation.stage': '当前阶段',
      'relation.score': '{score} 分',
      'relation.hint': '关系分 0–100，靠日常互动累积，长期失联会缓慢回退',
      'relation.milestones': '最近里程碑',
      'relation.noMilestones': '还没有里程碑，慢慢聊就会有了',
      'soul.stage.stranger': '陌生',
      'soul.stage.familiar': '熟悉',
      'soul.stage.close': '亲密',
      'soul.stage.intimate': '很亲近',
      'section.memory': '记忆',
      'memory.events': '最近事件',
      'memory.eventsEmpty': '还没有事件',
      'memory.notes': '笔记',
      'memory.note.user': '关于你',
      'memory.note.us': '关于我们',
      'memory.note.self': '关于她自己',
      'memory.notesCount': '{count} 条',
      'memory.topics': '聊到的话题',
      'memory.topicsEmpty': '还没有话题',
      'memory.empty': '还没有记忆',
      'memory.emptyHint': '她会在聊天中慢慢记下值得记住的事',
      'memory.reset': '清空记忆',
      'memory.resetConfirm': '再点一次确认清空',
      'memory.resetNotice': '记忆已清空',
      'memory.resetWarning': '会删除事件、笔记和话题，且不可恢复',
      'section.speak': '主动搭话',
      'row.speakEnabled': '开启主动搭话',
      'row.speakEnabled.hint': '她会在你安静太久时自己开口',
      'row.speakDryRun': '试运行（只记账不真发）',
      'row.speakDryRun.hint': '建议先开试运行观察频率，稳定后再关掉真发',
      'row.speakInterval': '基础间隔',
      'row.speakInterval.hint': '多久评估一次（5–1440 分钟）',
      'row.speakCooldown': '冷却',
      'row.speakCooldown.hint': '自己开口后多久不再评估（0 表示不冷却）',
      'row.speakDailyCap': '每日上限',
      'row.speakDailyCap.hint': '每天最多主动几次（0–10）',
      'row.speakSticker': '主动时允许发表情包',
      'row.speakSticker.hint': '两次表情包至少间隔 2 小时',
      'row.speakLast': '上次主动',
      'row.speakToday': '今日已开口',
      'speak.todayValue': '{count} / {cap} 次',
      'speak.lastNever': '还没有主动开口过',
      'speak.unitMinutes': '分钟',
      'speak.unitTimes': '次',
      'button.speakSave': '保存主动搭话',
      'notice.speakSaved': '主动搭话设置已保存',
      'button.speakTick': '立即掷一次',
      'busy.speakTick': '投掷中…',
      'speak.tickHit': '掷中：这条会发出去',
      'speak.tickMiss': '未命中：这次不出声',
      'speak.log': '最近主动记录',
      'speak.logEmpty': '还没有主动记录',
      'speak.logHit': '命中',
      'speak.logMiss': '未中',
      'speak.logDry': '试运行',
      'section.timeline': '解释时间线',
      'timeline.expand': '展开',
      'timeline.collapse': '收起',
      'timeline.collapsed': '共 {count} 条，点「展开」查看',
      'timeline.empty': '还没有解释记录',
      'notice.configNotApplied': '已提交，但 Host 还没接受这些字段（等 Host 更新后再试）',
      'empty.soulPending': '灵魂层数据还没准备好（Host 更新后自动出现）',
      'row.emotionNow': '此刻心情',
      'relation.metaInfo': '认识 {days} 天 · 聊过 {turns} 轮',
      'relation.nextStage': '再 +{score} 分进入「{stage}」',
      'memory.resetUnsupported': 'Host 还不支持只清空记忆（本次请求被当作重置情绪）',
      'common.unknown': '—',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{minutes} 分钟前',
      'time.hoursAgo': '{hours} 小时前',
      'time.daysAgo': '{days} 天前',
      'duration.lessMinute': '不到 1 分钟',
      'duration.minutes': '{minutes} 分钟',
      'duration.hoursMinutes': '{hours} 小时 {minutes} 分钟',
    }

    /** English copy. */
    const EN = {
      'title': 'Aura',
      'subtitle': 'Aura · self-hosted QQ channel · native sticker images · regex split replies · mood and proactive pings',
      'status.online': 'Connected',
      'status.offline': 'Disconnected',
      'status.unconfigured': 'Not configured',
      'section.status': 'Status',
      'row.connection': 'Connection',
      'row.connection.configuredHint': 'AppID and AppSecret are saved',
      'row.connection.unconfiguredHint': 'AppID / AppSecret not filled in yet',
      'row.startedAt': 'Connected at',
      'row.uptime': 'Uptime',
      'row.lastError': 'Last error',
      'section.credentials': 'Bot credentials',
      'row.appId': 'AppID',
      'row.appId.hint': 'The AppID of your QQ Open Platform bot',
      'row.appSecret': 'AppSecret',
      'row.appSecret.saved': 'Saved; leave empty to keep it',
      'row.appSecret.placeholder': 'Find it on the QQ Open Platform',
      'section.messages': 'Messages and splitting',
      'row.splitEnabled': 'Split replies with a regex',
      'row.splitEnabled.hint': 'Break one reply into several QQ messages, closer to a real chat',
      'row.splitRegex': 'Split regex',
      'row.splitRegex.hint': 'Blank lines split by default; turn the switch off to send as one block',
      'row.maxMessages': 'Max messages per turn',
      'row.maxMessages.hint': 'Images included; QQ caps passive replies at 5 per inbound message',
      'row.cwd': 'Session workspace',
      'row.cwd.placeholder': '/data/data/com.termux/files/home/workspace',
      'row.cwd.hint': 'Leave empty to use the default workspace',
      'section.mood': 'Mood',
      'row.mood.note': 'Last impression',
      'row.mood.updated': 'Updated {time}',
      'mood.valence': 'Pleasure',
      'mood.arousal': 'Arousal',
      'mood.affection': 'Closeness',
      'mood.energy': 'Energy',
      'mood.empty': 'No mood recorded yet. The model updates it as you chat.',
      'section.proactive': 'Proactive pings',
      'row.proactiveEnabled': 'Enable proactive pings',
      'row.proactiveEnabled.hint': 'When you have been idle for a while, the model may reach out first',
      'row.proactiveEvery': 'Idle interval',
      'row.proactiveEvery.hint': '5–1440 minutes of idle time between pings',
      'row.proactiveEvery.suffix': 'min',
      'row.quiet': 'Quiet hours',
      'row.quiet.hint': 'No proactive pings during quiet hours; leave both empty to disable them',
      'row.quiet.to': 'to',
      'row.lastProactive': 'Last ping',
      'row.lastProactive.never': 'No proactive ping yet',
      'row.lastProactive.reason': 'Reason: {reason}',
      'section.sessions': 'Bound sessions',
      'sessions.empty': 'No QQ sessions yet. Direct and group chats show up here once the bot is connected.',
      'sessions.group': 'Group',
      'sessions.direct': 'Direct',
      'sessions.count': '{count}',
      'button.save': 'Save',
      'button.connect': 'Save and connect',
      'button.disconnect': 'Disconnect',
      'button.import': 'Import from IM Connect',
      'busy.save': 'Saving…',
      'busy.connect': 'Connecting…',
      'busy.disconnect': 'Disconnecting…',
      'busy.import': 'Importing…',
      'notice.saved': 'Saved',
      'notice.connected': 'Connected',
      'notice.disconnected': 'Disconnected',
      'notice.imported': 'Credentials imported',
      'notice.importedNoSecret': 'Imported the AppID, but no AppSecret was found; fill it in manually',
      'error.quietFormat': 'Quiet hours must use HH:MM, for example 23:30',
      'error.load': 'Could not read status',
      'error.connect': 'Connection failed',
      'loading': 'Reading status…',
      'note.footer': 'Sticker images are sent by dsh_im_return_file as native images before the text; each inbound message gets at most 5 replies; once the passive-reply window closes, proactive messages may be rejected by the platform.',
      'section.appearance': 'Appearance',
      'row.displayName': 'Display name',
      'row.displayName.hint': 'Shown on the sidebar entry and as the panel title (1–24 chars)',
      'row.icon': 'Icon',
      'row.iconEmoji': 'Emoji',
      'row.iconEmoji.hint': 'One character, used when the Emoji icon is selected',
      'row.preview': 'Preview',
      'button.lookSave': 'Save appearance',
      'busy.look': 'Saving…',
      'notice.lookSaved': 'Appearance updated',
      'error.displayName': 'Display name cannot be empty',
      'error.soulName': 'Soul name cannot be empty',
      'error.emoji': 'Enter one emoji character',
      'icon.aura': 'Aura',
      'icon.qq': 'QQ',
      'icon.heart': 'Heart',
      'icon.cat': 'Cat',
      'icon.star': 'Star',
      'icon.moon': 'Moon',
      'icon.emoji': 'Emoji',
      'look.untitled': 'Untitled',
      'section.soul': 'Soul',
      'row.soulName': 'Soul name',
      'row.soulName.hint': 'How she calls herself in her self-narrative (1–20 chars)',
      'row.soulUserNickname': 'Your nickname',
      'row.soulUserNickname.hint': 'How she addresses you; empty means plain “you”',
      'row.soulUserNickname.placeholder': 'e.g. little whale',
      'row.soulEnabled': 'Enable the soul layer',
      'row.soulEnabled.hint': 'When off, identity / emotion / memory context is not injected',
      'row.soulHonestyLine': 'Honesty line',
      'row.soulHonestyLine.hint': 'Reminds her to admit she is an AI and her feelings are simulated',
      'row.soulBudget': 'Prompt budget',
      'soul.budgetValue': 'about {n} chars (soft cap)',
      'soul.budgetUnknown': 'not set',
      'soul.identityName': 'Self-name',
      'button.soulSave': 'Save soul settings',
      'notice.soulSaved': 'Soul settings saved',
      'section.emotion': 'Emotion',
      'row.expressionStyle': 'Expression style',
      'row.expressionStyle.hint': 'subtle shifts tone · explicit says it out loud · off injects nothing',
      'style.subtle': 'Subtle',
      'style.explicit': 'Explicit',
      'style.off': 'Off',
      'row.emotionLastChange': 'Last change',
      'emotion.empty': 'No emotion data yet (the soul layer records it once running)',
      'button.emotionSave': 'Save emotion settings',
      'notice.emotionSaved': 'Emotion settings saved',
      'section.relation': 'Relationship',
      'relation.stage': 'Stage',
      'relation.score': '{score}',
      'relation.hint': 'Score runs 0–100, grows through interaction and drifts down after long silence',
      'relation.milestones': 'Recent milestones',
      'relation.noMilestones': 'No milestones yet; they come with time',
      'soul.stage.stranger': 'Stranger',
      'soul.stage.familiar': 'Familiar',
      'soul.stage.close': 'Close',
      'soul.stage.intimate': 'Intimate',
      'section.memory': 'Memory',
      'memory.events': 'Recent events',
      'memory.eventsEmpty': 'No events yet',
      'memory.notes': 'Notes',
      'memory.note.user': 'About you',
      'memory.note.us': 'About us',
      'memory.note.self': 'About her',
      'memory.notesCount': '{count}',
      'memory.topics': 'Topics',
      'memory.topicsEmpty': 'No topics yet',
      'memory.empty': 'No memory yet',
      'memory.emptyHint': 'She will remember what is worth remembering as you talk',
      'memory.reset': 'Clear memory',
      'memory.resetConfirm': 'Click again to confirm',
      'memory.resetNotice': 'Memory cleared',
      'memory.resetWarning': 'Deletes events, notes and topics; cannot be undone',
      'section.speak': 'Proactive pings',
      'row.speakEnabled': 'Enable proactive pings',
      'row.speakEnabled.hint': 'She may speak up when you have been quiet too long',
      'row.speakDryRun': 'Dry run (log only, never send)',
      'row.speakDryRun.hint': 'Watch the frequency first, then turn dry run off',
      'row.speakInterval': 'Base interval',
      'row.speakInterval.hint': 'How often to roll the dice (5–1440 min)',
      'row.speakCooldown': 'Cooldown',
      'row.speakCooldown.hint': 'No rolls for this long after she speaks (0 = no cooldown)',
      'row.speakDailyCap': 'Daily cap',
      'row.speakDailyCap.hint': 'How many proactive pings per day (0–10)',
      'row.speakSticker': 'Allow stickers when proactive',
      'row.speakSticker.hint': 'At least two hours between proactive stickers',
      'row.speakLast': 'Last ping',
      'row.speakToday': 'Today',
      'speak.todayValue': '{count} / {cap}',
      'speak.lastNever': 'No proactive ping yet',
      'speak.unitMinutes': 'min',
      'speak.unitTimes': '',
      'button.speakSave': 'Save proactive pings',
      'notice.speakSaved': 'Proactive settings saved',
      'button.speakTick': 'Roll once now',
      'busy.speakTick': 'Rolling…',
      'speak.tickHit': 'Hit: this one would be sent',
      'speak.tickMiss': 'Missed: no ping this time',
      'speak.log': 'Recent pings',
      'speak.logEmpty': 'No pings yet',
      'speak.logHit': 'Hit',
      'speak.logMiss': 'Miss',
      'speak.logDry': 'Dry',
      'section.timeline': 'Explanation timeline',
      'timeline.expand': 'Expand',
      'timeline.collapse': 'Collapse',
      'timeline.collapsed': '{count} entries; click Expand to view',
      'timeline.empty': 'No explanation entries yet',
      'notice.configNotApplied': 'Submitted, but the Host has not accepted these fields yet (retry after the host update)',
      'empty.soulPending': 'Soul data is not ready yet (it appears once the Host update lands)',
      'row.emotionNow': 'Current mood',
      'relation.metaInfo': 'Known for {days} days · {turns} turns',
      'relation.nextStage': '+{score} to reach “{stage}”',
      'memory.resetUnsupported': 'The Host cannot clear memory only yet (this request was treated as an emotion reset)',
      'common.unknown': '—',
      'time.justNow': 'just now',
      'time.minutesAgo': '{minutes} min ago',
      'time.hoursAgo': '{hours} h ago',
      'time.daysAgo': '{days} d ago',
      'duration.lessMinute': 'under a minute',
      'duration.minutes': '{minutes} min',
      'duration.hoursMinutes': '{hours} h {minutes} min',
    }

    /** Fallback dictionary: Chinese, so the panel reads correctly even before locale registration. */
    const FALLBACK = ZH

    /** Tokens-only stylesheet, namespaced so it cannot collide with host styles. */
    const CSS = `
.qqn-page{width:100%;height:100%;min-width:0;min-height:0;display:flex;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;overflow:hidden}
.qqn-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.qqn-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.qqn-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:24px}
.qqn-heading h1{flex:0 1 auto;min-width:0;max-width:100%;margin:0;font-size:20px;font-weight:500;line-height:28px}
.qqn-sub{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin-top:4px}
.qqn-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;flex:none}
.qqn-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.qqn-dot-ok{background:var(--dsw-alias-state-success-primary)}
.qqn-dot-err{background:var(--dsw-alias-state-error-primary)}
.qqn-section{margin-bottom:28px}
.qqn-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;line-height:20px;margin:0 0 8px 10px}
.qqn-section-title span{flex:none}
.qqn-rows{display:flex;flex-direction:column;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px}
.qqn-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:48px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.qqn-rows>.qqn-row:last-child{border-bottom:0}
.qqn-row-text{flex:1;min-width:0;padding:10px 0}
.qqn-row-label{font-size:14px;line-height:22px}
.qqn-row-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px;overflow-wrap:anywhere}
.qqn-row-control{flex:0 0 auto;max-width:60%;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 0}
.qqn-input{box-sizing:border-box;width:240px;max-width:100%;height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none;transition:border-color .15s}
.qqn-input:hover{border-color:var(--dsw-alias-border-l2)}
.qqn-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.qqn-input:focus-visible{outline:none}
.qqn-input::placeholder{color:var(--dsw-alias-label-caption)}
.qqn-input:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.qqn-input-narrow{width:96px;text-align:center;font-variant-numeric:tabular-nums}
.qqn-input-time{width:80px;text-align:center;font-variant-numeric:tabular-nums}
.qqn-unit{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}
.qqn-checkbox{width:16px;height:16px;margin:0;flex:none;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer}
.qqn-checkbox:disabled{cursor:default}
.qqn-seg{display:flex;align-items:center;gap:4px}
.qqn-seg-button{height:28px;min-width:28px;padding:0 8px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:22px;cursor:pointer;transition:background .15s,color .15s}
.qqn-seg-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.qqn-seg-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qqn-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}
.qqn-button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.qqn-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.qqn-button:disabled{color:var(--dsw-alias-label-caption);cursor:default;border-color:transparent}
.qqn-button-primary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.qqn-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.qqn-button-primary:disabled{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-caption)}
.qqn-button-quiet{border-color:transparent}
.qqn-feedback{margin-top:10px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.qqn-feedback-error{color:var(--dsw-alias-state-error-primary)}
.qqn-error{margin-top:12px;padding:10px 14px;border-radius:10px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.qqn-mood{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:16px 0}
.qqn-mood-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.qqn-mood-value{margin-top:2px;font-size:20px;font-weight:500;line-height:28px;font-variant-numeric:tabular-nums}
.qqn-mood-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);margin-top:8px;overflow:hidden}
.qqn-mood-fill{height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.qqn-mood-note{padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.qqn-mood-empty{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.qqn-session{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.qqn-rows>.qqn-session:last-child{border-bottom:0}
.qqn-session-left{display:flex;flex-direction:column;gap:2px;min-width:0}
.qqn-session-title{display:flex;align-items:center;gap:8px;min-width:0}
.qqn-session-kind{flex:none;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px}
.qqn-session-chat{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.qqn-session-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.qqn-session-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.qqn-empty{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.qqn-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 20px;padding:4px;border-radius:12px;background:var(--dsw-specific-sidebar-fill);width:fit-content;max-width:100%}
.qqn-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:6px 14px;border-radius:9px;cursor:pointer;line-height:20px}
.qqn-tab:hover{color:var(--dsw-alias-label-primary)}
.qqn-tab-active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.qqn-notice{display:flex;gap:9px;margin-top:28px;padding:12px 14px;border-radius:10px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.qqn-loading{padding:24px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.qqn-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qqn-input:focus-visible{outline:none}
.qqn-look{display:flex;flex-direction:column;gap:10px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.qqn-look-title{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.qqn-look-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.qqn-look-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0;padding:8px 2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.qqn-look-tile:hover{background:var(--dsw-alias-interactive-bg-hover)}
.qqn-look-tile[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qqn-look-glyph{display:flex;align-items:center;justify-content:center;width:24px;height:24px;color:inherit}
.qqn-look-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px}
.qqn-look-emoji{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qqn-input-emoji{width:96px;text-align:center;font-size:16px}
.qqn-look-preview{display:inline-flex;align-items:center;gap:8px;max-width:100%;height:32px;padding:0 10px;border-radius:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary)}
.qqn-look-preview-glyph{display:flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none}
.qqn-look-preview-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.qqn-relation{padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.qqn-relation-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.qqn-relation-track{height:6px;margin-top:10px}
.qqn-stage{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px}
.qqn-dot-familiar{background:var(--dsw-alias-state-business-primary)}
.qqn-dot-close{background:var(--dsw-alias-state-success-primary)}
.qqn-dot-intimate{background:var(--dsw-alias-brand-primary)}
.qqn-event-list{display:flex;flex-direction:column;padding:6px 0}
.qqn-event{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:13px;line-height:20px}
.qqn-event-time{flex:none;min-width:64px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}
.qqn-event-text{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.qqn-memory-block{display:flex;flex-direction:column;gap:8px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.qqn-memory-block:last-child{border-bottom:0}
.qqn-memory-group{display:flex;flex-direction:column;gap:2px}
.qqn-memory-group-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.qqn-memory-item{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.qqn-chip-list{display:flex;flex-wrap:wrap;gap:6px}
.qqn-tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:11px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.qqn-log-list{display:flex;flex-direction:column;padding:6px 0}
.qqn-log-row{display:flex;align-items:flex-start;gap:8px;padding:5px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.qqn-log-time{flex:none;min-width:64px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.qqn-log-badge{flex:none;height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.qqn-log-badge-hit{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-success-primary)}
.qqn-log-reason{flex:1;min-width:0;overflow-wrap:anywhere}
.qqn-button-danger{color:var(--dsw-alias-state-error-primary)}
.qqn-mood-value small{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
@media (max-width:640px){
.qqn-row{flex-direction:column;align-items:stretch;gap:0;padding:10px 0}
.qqn-row-control{max-width:none;justify-content:flex-start;padding:0 0 4px}
.qqn-input{width:100%}
.qqn-mood{grid-template-columns:repeat(2,minmax(0,1fr))}
.qqn-look-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
.qqn-event-time,.qqn-log-time{min-width:52px}
}
`

    function interpolate(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Prefer the locale seat, fall back to the bundled Chinese copy. */
    function makeT(t) {
      return (key, params) => {
        if (typeof t === 'function') {
          const value = t(key, params)
          if (typeof value === 'string' && value !== key) return value
        }
        const fallback = FALLBACK[key] === undefined ? key : FALLBACK[key]
        return interpolate(fallback, params)
      }
    }

    async function api(path, body) {
      const response = await fetch(API + path, body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    /** 加载时同步一次外观，让侧栏名字/图标不用等面板打开就正确。 */
    async function primeAppearance() {
      try {
        const response = await fetch(API + '/state')
        if (!response.ok) return
        const value = await response.json()
        if (value && value.config) setAppearance(value.config)
      } catch {
        // 首次同步失败时保留默认外观；面板轮询/保存成功后还会再同步。
      }
    }

    function clampInt(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.max(min, Math.min(max, Math.round(n)))
    }

    /** Accept "HH:MM" only; returns minutes since midnight, or null when the text is empty/invalid. */
    function minutesOf(text) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
      if (!match) return null
      const hours = Number(match[1])
      const minutes = Number(match[2])
      if (hours > 23 || minutes > 59) return null
      return hours * 60 + minutes
    }

    function formatRelative(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const delta = Math.max(0, Date.now() - ms)
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutesAgo', { minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { hours })
      return t('time.daysAgo', { days: Math.floor(hours / 24) })
    }

    function formatUptime(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('duration.lessMinute')
      const total = Math.floor(ms / 60000)
      if (total < 1) return t('duration.lessMinute')
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours < 1) return t('duration.minutes', { minutes })
      return t('duration.hoursMinutes', { hours, minutes })
    }

    function formatClock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** 6 个内置图标的 64×64 单色 path；stroke 项是光环的同心圆。 */
    const ICON_PATHS = {
      aura: [
        { d: 'M32 4a28 28 0 1 0 0 56 28 28 0 0 0 0-56z', fill: 'none', stroke: 'currentColor', strokeWidth: 3, opacity: 0.28 },
        { d: 'M32 13a19 19 0 1 0 0 38 19 19 0 0 0 0-38z', fill: 'none', stroke: 'currentColor', strokeWidth: 3, opacity: 0.62 },
        { d: 'M32 25a7 7 0 1 0 0 14 7 7 0 0 0 0-14z' },
      ],
      qq: [{
        // 企鹅剪影 + 两只眼睛用 evenodd 镂空，保持单色 currentColor，任何背景都成立。
        d: 'M32 6c-11.6 0-20 8.6-20 19.6 0 5.2 1.6 9.1 3.6 13.4-2.6 1.6-4.6 3.8-4.6 6.2 0 2.2 1.8 3.8 4.4 4.6.8 2.8 2.4 5.2 4.6 6.6-1.2.8-2 1.8-2 2.8 0 2.4 3.6 4.2 8 4.2 2.8 0 5.2-.7 6.8-1.8 1.6 1.1 4 1.8 6.8 1.8 4.4 0 8-1.8 8-4.2 0-1-.8-2-2-2.8 2.2-1.4 3.8-3.8 4.6-6.6 2.6-.8 4.4-2.4 4.4-4.6 0-2.4-2-4.6-4.6-6.2 2-4.3 3.6-8.2 3.6-13.4C52 14.6 43.6 6 32 6zM24 23.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4zM40 23.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4z',
        fillRule: 'evenodd',
      }],
      heart: [{
        d: 'M32 53.5c-2.6-2-21.5-14.4-21.5-29C10.5 16 16.2 10 24 10c3.4 0 6.4 1.6 8 4.2 1.6-2.6 4.6-4.2 8-4.2 7.8 0 13.5 6 13.5 14.5 0 14.6-18.9 27-21.5 29z',
      }],
      cat: [{
        // 猫头 + 两只耳朵，眼睛同样用 evenodd 镂空。
        d: 'M32 12c-3.2 0-6.2.6-8.9 1.7L13 8l2.5 10.4C13.6 21.9 12 25.9 12 30c0 11.6 8.9 21 20 21s20-9.4 20-21c0-4.1-1.6-8.1-3.5-11.6L51 8l-10.1 5.7C38.2 12.6 35.2 12 32 12zM25 25.6a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2zm14 0a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2z',
        fillRule: 'evenodd',
      }],
      star: [{
        d: 'M32 7l7.3 15.6 17 2.3-12.4 11.9 3.1 16.9L32 45.7 17 53.7l3.1-16.9L7.7 24.9l17-2.3z',
      }],
      moon: [{
        // 两个重叠圆做 evenodd 挖出月牙。
        d: 'M32 8a24 24 0 1 0 0 48 24 24 0 0 0 0-48zM46 2a22 22 0 1 0 0 44 22 22 0 0 0 0-44z',
        fillRule: 'evenodd',
      }],
    }

    /** 渲染一个预设图标；emoji 预设渲染成文字，其余是 currentColor 单色 SVG。 */
    function IconGlyph({ preset, emoji, size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18
      const kind = ICON_CHOICES.includes(preset) ? preset : 'aura'
      if (kind === 'emoji') {
        const text = Array.from(String(emoji || DEFAULT_EMOJI))[0] || DEFAULT_EMOJI
        return h('span', {
          'data-preset': 'emoji',
          'aria-hidden': true,
          style: { display: 'block', fontSize: Math.round(edge * 0.92), lineHeight: 1, textAlign: 'center' },
        }, text)
      }
      return h('svg', {
        'data-preset': kind,
        viewBox: '0 0 64 64',
        width: edge,
        height: edge,
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', color: 'inherit' },
      }, (ICON_PATHS[kind] || ICON_PATHS.aura).map((shape, index) => h('path', {
        key: index,
        d: shape.d,
        fill: shape.fill === undefined ? 'currentColor' : shape.fill,
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth,
        opacity: shape.opacity,
        fillRule: shape.fillRule,
      })))
    }

    /** 订阅模块级外观；保存/轮询更新后调用方重渲染。 */
    function useAppearance() {
      const [value, setValue] = React.useState(appearance)
      React.useEffect(() => subscribeAppearance(setValue), [])
      return value
    }

    /** 侧栏图标：订阅外观状态，保存外观后立即换成新图标（无需刷新）。 */
    function SidebarIcon(props) {
      const current = useAppearance()
      const edge = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h(IconGlyph, { preset: current.iconPreset, emoji: current.iconEmoji, size: edge })
    }

    function Row({ label, hint, control }) {
      return h('div', { className: 'qqn-row' },
        h('div', { className: 'qqn-row-text' },
          h('div', { className: 'qqn-row-label' }, label),
          hint ? h('div', { className: 'qqn-row-hint' }, hint) : null,
        ),
        control ? h('div', { className: 'qqn-row-control' }, control) : null,
      )
    }

    function Section({ title, action, children }) {
      const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
      return h('section', { className: 'qqn-section' },
        h('h2', { className: 'qqn-section-title' }, h('span', null, title), action || null),
        ...list,
      )
    }

    function Button({ variant, disabled, onClick, children }) {
      return h('button', {
        type: 'button',
        className: 'qqn-button' + (variant ? ' qqn-button-' + variant : ''),
        disabled: disabled === true,
        onClick,
      }, children)
    }

    const EMPTY_FORM = {
      appId: '',
      appSecret: '',
      splitEnabled: true,
      splitRegex: '',
      maxMessages: 4,
      cwd: '',
      proactiveEnabled: false,
      proactiveEveryMinutes: 90,
      quietStart: '',
      quietEnd: '',
    }

    function buildForm(config) {
      const cfg = config && typeof config === 'object' ? config : {}
      return {
        appId: typeof cfg.appId === 'string' ? cfg.appId : '',
        appSecret: '',
        splitEnabled: cfg.splitEnabled !== false,
        splitRegex: typeof cfg.splitRegex === 'string' ? cfg.splitRegex : '',
        maxMessages: clampInt(cfg.maxMessages, 1, MAX_REPLIES, 4),
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
        proactiveEnabled: cfg.proactiveEnabled === true,
        proactiveEveryMinutes: clampInt(cfg.proactiveEveryMinutes, EVERY_MIN, EVERY_MAX, 90),
        quietStart: typeof cfg.quietStart === 'string' ? cfg.quietStart : '',
        quietEnd: typeof cfg.quietEnd === 'string' ? cfg.quietEnd : '',
      }
    }

    function formKey(form) {
      return JSON.stringify({
        appId: form.appId.trim(),
        splitEnabled: form.splitEnabled === true,
        splitRegex: form.splitRegex,
        maxMessages: clampInt(form.maxMessages, 1, MAX_REPLIES, 4),
        cwd: form.cwd.trim(),
        proactiveEnabled: form.proactiveEnabled === true,
        proactiveEveryMinutes: clampInt(form.proactiveEveryMinutes, EVERY_MIN, EVERY_MAX, 90),
        quietStart: form.quietStart.trim(),
        quietEnd: form.quietEnd.trim(),
      })
    }

    /* ---------------- 灵魂层：数据读取与表单（全部防御式） ---------------- */
    const SOUL_STAGES = ['stranger', 'familiar', 'close', 'intimate']
    const EXPRESSION_STYLES = ['subtle', 'explicit', 'off']

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    /**
     * 0~1 归一。情绪快照里 valence 是 -1~1（host/emotion.js），用 signed=true 做 (v+1)/2；
     * arousal/affection/energy 本身是 0~1，直接 clamp。
     */
    function unitValue(value, signed) {
      let n = Number(value)
      if (!Number.isFinite(n)) return 0
      if (signed) n = (n + 1) / 2
      return Math.max(0, Math.min(1, n))
    }

    function clampScore(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return 0
      return Math.max(0, Math.min(100, n))
    }

    /** 统一时间戳：number(ms) / ISO 字符串 / 0。 */
    function timeOf(value) {
      if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
      if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      }
      return 0
    }

    function draftKey(draft) {
      const source = asObject(draft)
      return JSON.stringify(Object.keys(source).sort().map(key => [key, source[key]]))
    }

    /** 按时间倒序；行可以是字符串或对象。 */
    function rowsNewest(rows, key) {
      return asArray(rows)
        .filter(row => row !== null && row !== undefined)
        .slice()
        .sort((left, right) => timeOf(asObject(right)[key]) - timeOf(asObject(left)[key]))
    }

    function rowText(row, ...keys) {
      if (typeof row === 'string') return row
      const source = asObject(row)
      for (const key of keys) {
        if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim()
      }
      return ''
    }

    function milestoneRows(value) {
      return asArray(value).map(row => ({
        at: timeOf(asObject(row).at || asObject(row).createdAt),
        text: rowText(row, 'text', 'summary', 'label', 'title', 'note'),
      })).filter(row => row.text)
    }

    function timelineRows(value) {
      return asArray(value).map(row => {
        const source = asObject(row)
        return {
          at: timeOf(source.at),
          kind: typeof source.kind === 'string' ? source.kind : (typeof source.type === 'string' ? source.type : ''),
          summary: rowText(row, 'summary', 'text', 'detail', 'reason', 'message'),
        }
      }).filter(row => row.summary || row.kind)
    }

    function speakLogRows(value) {
      return asArray(value).map(row => {
        const source = asObject(row)
        const hit = source.hit === true || source.sent === true
        return {
          at: timeOf(source.at),
          hit,
          dryRun: source.dryRun === true,
          reason: rowText(row, 'reason', 'done', 'formula', 'error', 'act', 'trigger'),
        }
      }).filter(row => row.at > 0 || row.reason)
    }

    function topicRows(value) {
      if (Array.isArray(value)) {
        return value.map(row => {
          if (typeof row === 'string') return { label: row, hits: 0 }
          const source = asObject(row)
          return {
            label: rowText(row, 'topic', 'label', 'key', 'text', 'name'),
            hits: Number(source.hits) || 0,
          }
        }).filter(row => row.label)
      }
      return Object.entries(asObject(value)).map(([label, meta]) => ({
        label,
        hits: Number(asObject(meta).hits) || 0,
      })).filter(row => row.label)
    }

    function stageOf(value) {
      return SOUL_STAGES.includes(value) ? value : 'stranger'
    }

    function styleOf(value) {
      return EXPRESSION_STYLES.includes(value) ? value : 'subtle'
    }

    /** 情绪四维：优先 soul.emotion（0~1），退回旧 emotion（0~10）。 */
    function moodUnit(soulValue, legacyValue, signed) {
      const soulNumber = Number(soulValue)
      if (Number.isFinite(soulNumber)) return unitValue(soulNumber, signed)
      const legacyNumber = Number(legacyValue)
      if (Number.isFinite(legacyNumber)) return Math.max(0, Math.min(1, legacyNumber / 10))
      return 0
    }

    function lastChangeInfo(value) {
      if (!value) return { at: 0, text: '' }
      if (typeof value === 'string') return { at: 0, text: value }
      const source = asObject(value)
      return {
        at: timeOf(source.at || source.updatedAt || source.createdAt),
        text: rowText(value, 'summary', 'cause', 'text', 'detail', 'label'),
      }
    }

    function buildSoulForm(config) {
      const cfg = asObject(config)
      const name = typeof cfg.soulName === 'string' ? cfg.soulName.trim().slice(0, 20) : ''
      return {
        soulName: name || 'Aura',
        soulUserNickname: typeof cfg.soulUserNickname === 'string' ? cfg.soulUserNickname.trim().slice(0, 20) : '',
        soulEnabled: cfg.soulEnabled !== false,
        soulHonestyLine: cfg.soulHonestyLine !== false,
      }
    }

    function buildEmotionForm(config) {
      const cfg = asObject(config)
      return { expressionStyle: styleOf(cfg.expressionStyle) }
    }

    function buildSpeakForm(config) {
      const cfg = asObject(config)
      return {
        speakEnabled: cfg.speakEnabled === true,
        speakDryRun: cfg.speakDryRun !== false,
        speakIntervalMinutes: clampInt(cfg.speakIntervalMinutes, 5, 1440, 30),
        speakCooldownMinutes: clampInt(cfg.speakCooldownMinutes, 0, 1440, 45),
        speakDailyCap: clampInt(cfg.speakDailyCap, 0, 10, 3),
        quietStart: typeof cfg.quietStart === 'string' ? cfg.quietStart : '23:30',
        quietEnd: typeof cfg.quietEnd === 'string' ? cfg.quietEnd : '07:30',
        speakStickerEnabled: cfg.speakStickerEnabled !== false,
      }
    }

    /** 保存后对比 Host 回显，判断字段是否真的被接受（Host 未更新时给出提示）。 */
    function payloadApplied(config, payload) {
      const cfg = asObject(config)
      return Object.keys(payload).every(key => {
        const expected = payload[key]
        const actual = cfg[key]
        if (typeof expected === 'number') return Math.abs(Number(actual) - expected) < 1e-6 || actual === expected
        if (typeof expected === 'boolean') return actual === expected
        return String(actual) === String(expected)
      })
    }

    /** Host 可能只实现 soul 快照而还没加 config 字段：用 soul 补齐草稿的缺省。 */
    function configForDrafts(snapshot) {
      const cfg = { ...asObject(snapshot && snapshot.config) }
      const soul = asObject(snapshot && snapshot.soul)
      const identity = asObject(soul.identity)
      const soulEmotion = asObject(soul.emotion)
      const soulSpeak = asObject(soul.speak)
      if (cfg.soulName === undefined && typeof identity.name === 'string') cfg.soulName = identity.name
      if (cfg.soulUserNickname === undefined && typeof identity.userNickname === 'string') cfg.soulUserNickname = identity.userNickname
      if (cfg.expressionStyle === undefined && typeof soulEmotion.style === 'string') cfg.expressionStyle = soulEmotion.style
      if (cfg.speakEnabled === undefined && typeof soulSpeak.enabled === 'boolean') cfg.speakEnabled = soulSpeak.enabled
      if (cfg.speakDryRun === undefined && typeof soulSpeak.dryRun === 'boolean') cfg.speakDryRun = soulSpeak.dryRun
      return cfg
    }

    function Panel(props) {
      const t = makeT(props && props.t)
      const currentLook = useAppearance()
      const [snap, setSnap] = React.useState(null)
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [baseline, setBaseline] = React.useState(EMPTY_FORM)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [pollError, setPollError] = React.useState('')
      const [tab, setTab] = React.useState('soul')
      const [loading, setLoading] = React.useState(true)
      const [look, setLook] = React.useState(configToAppearance(appearance))
      const [lookBaseline, setLookBaseline] = React.useState(configToAppearance(appearance))
      const [lookBusy, setLookBusy] = React.useState(false)
      const [lookError, setLookError] = React.useState('')
      const [lookNotice, setLookNotice] = React.useState('')
      const [soulForm, setSoulForm] = React.useState(() => buildSoulForm({}))
      const [soulBaseline, setSoulBaseline] = React.useState(() => buildSoulForm({}))
      const [emotionForm, setEmotionForm] = React.useState(() => buildEmotionForm({}))
      const [emotionBaseline, setEmotionBaseline] = React.useState(() => buildEmotionForm({}))
      const [speakForm, setSpeakForm] = React.useState(() => buildSpeakForm({}))
      const [speakBaseline, setSpeakBaseline] = React.useState(() => buildSpeakForm({}))
      const [blocks, setBlocks] = React.useState({})
      const [resetArmed, setResetArmed] = React.useState(false)
      const [timelineOpen, setTimelineOpen] = React.useState(false)

      const mounted = React.useRef(true)
      const inflight = React.useRef(false)
      const busyRef = React.useRef('')
      const noticeTimer = React.useRef(null)
      const lookTimer = React.useRef(null)
      const lookRef = React.useRef(look)
      const lookBaselineRef = React.useRef(lookBaseline)
      const soulRef = React.useRef(soulForm)
      const soulBaselineRef = React.useRef(soulBaseline)
      const emotionRef = React.useRef(emotionForm)
      const emotionBaselineRef = React.useRef(emotionBaseline)
      const speakRef = React.useRef(speakForm)
      const speakBaselineRef = React.useRef(speakBaseline)
      const blocksRef = React.useRef(blocks)
      const blockTimers = React.useRef({})
      const resetTimer = React.useRef(null)

      React.useEffect(() => {
        lookRef.current = look
      }, [look])
      React.useEffect(() => {
        lookBaselineRef.current = lookBaseline
      }, [lookBaseline])
      React.useEffect(() => {
        soulRef.current = soulForm
      }, [soulForm])
      React.useEffect(() => {
        soulBaselineRef.current = soulBaseline
      }, [soulBaseline])
      React.useEffect(() => {
        emotionRef.current = emotionForm
      }, [emotionForm])
      React.useEffect(() => {
        emotionBaselineRef.current = emotionBaseline
      }, [emotionBaseline])
      React.useEffect(() => {
        speakRef.current = speakForm
      }, [speakForm])
      React.useEffect(() => {
        speakBaselineRef.current = speakBaseline
      }, [speakBaseline])
      React.useEffect(() => {
        blocksRef.current = blocks
      }, [blocks])

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (noticeTimer.current !== null) {
            clearTimeout(noticeTimer.current)
            noticeTimer.current = null
          }
          if (lookTimer.current !== null) {
            clearTimeout(lookTimer.current)
            lookTimer.current = null
          }
          for (const timer of Object.values(blockTimers.current)) {
            if (timer !== null) clearTimeout(timer)
          }
          blockTimers.current = {}
          if (resetTimer.current !== null) {
            clearTimeout(resetTimer.current)
            resetTimer.current = null
          }
        }
      }, [])

      const syncForm = React.useCallback((config) => {
        const next = buildForm(config)
        setForm(next)
        setBaseline(next)
      }, [])

      /** 服务端外观 -> 外观草稿；force=false 时只在用户没改过草稿时覆盖。 */
      const syncLook = React.useCallback((config, force) => {
        const next = configToAppearance(config)
        const untouched = appearanceKey(lookRef.current) === appearanceKey(lookBaselineRef.current)
        if (!force && !untouched) return
        setLook(next)
        setLookBaseline(next)
      }, [])

      /** 灵魂表单同步（同样尊重用户正在编辑的草稿）。 */
      const syncSoul = React.useCallback((config, force) => {
        const next = buildSoulForm(config)
        const untouched = draftKey(soulRef.current) === draftKey(soulBaselineRef.current)
        if (!force && !untouched) return
        setSoulForm(next)
        setSoulBaseline(next)
      }, [])

      const syncEmotion = React.useCallback((config, force) => {
        const next = buildEmotionForm(config)
        const untouched = draftKey(emotionRef.current) === draftKey(emotionBaselineRef.current)
        if (!force && !untouched) return
        setEmotionForm(next)
        setEmotionBaseline(next)
      }, [])

      const syncSpeak = React.useCallback((config, force) => {
        const next = buildSpeakForm(config)
        const untouched = draftKey(speakRef.current) === draftKey(speakBaselineRef.current)
        if (!force && !untouched) return
        setSpeakForm(next)
        setSpeakBaseline(next)
      }, [])

      const syncDrafts = React.useCallback((config, force) => {
        syncLook(config, force)
        syncSoul(config, force)
        syncEmotion(config, force)
        syncSpeak(config, force)
      }, [syncLook, syncSoul, syncEmotion, syncSpeak])

      const flash = React.useCallback((text) => {
        setNotice(text)
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => {
          noticeTimer.current = null
          if (mounted.current) setNotice('')
        }, 3000)
      }, [])

      const load = React.useCallback(async (initial) => {
        if (inflight.current) return
        inflight.current = true
        try {
          const value = await api('/state')
          if (!mounted.current) return
          setSnap(value)
          setPollError('')
          if (value && value.config) {
            setAppearance(value.config)
            if (initial) {
              syncForm(value.config)
              syncDrafts(configForDrafts(value), true)
            } else {
              syncDrafts(configForDrafts(value), false)
            }
          }
        } catch (error) {
          if (mounted.current) setPollError(error instanceof Error ? error.message : String(error))
        } finally {
          inflight.current = false
          if (mounted.current) setLoading(false)
        }
      }, [syncForm, syncDrafts])

      React.useEffect(() => {
        void load(true)
        let timer = null
        const stop = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
        const tick = () => {
          if (!visible()) return
          void load(false)
        }
        const start = () => {
          stop()
          timer = setInterval(tick, POLL_MS)
        }
        const onVisibility = () => {
          if (visible()) {
            tick()
            start()
          } else {
            stop()
          }
        }
        if (visible()) start()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      const setField = (key, value) => {
        setForm(prev => ({ ...prev, [key]: value }))
      }

      const patch = () => ({
        appId: form.appId.trim(),
        appSecret: form.appSecret.trim(),
        splitEnabled: form.splitEnabled === true,
        splitRegex: form.splitRegex,
        maxMessages: clampInt(form.maxMessages, 1, MAX_REPLIES, 4),
        cwd: form.cwd.trim(),
        proactiveEnabled: form.proactiveEnabled === true,
        proactiveEveryMinutes: clampInt(form.proactiveEveryMinutes, EVERY_MIN, EVERY_MAX, 90),
        quietStart: form.quietStart.trim(),
        quietEnd: form.quietEnd.trim(),
      })

      const run = async (name, task, successMessage) => {
        if (busyRef.current) return
        if (name === 'save' || name === 'connect') {
          const start = form.quietStart.trim()
          const end = form.quietEnd.trim()
          if ((start && minutesOf(start) === null) || (end && minutesOf(end) === null)) {
            setActionError(t('error.quietFormat'))
            return
          }
        }
        busyRef.current = name
        setBusy(name)
        setActionError('')
        setNotice('')
        try {
          const value = await task()
          if (!mounted.current) return
          setSnap(prev => {
            const next = { ...(prev || {}) }
            if (value && value.config) next.config = value.config
            if (value && value.status) next.status = value.status
            if (value && value.imported) next.imported = value.imported
            return next
          })
          if (value && value.config) {
            syncForm(value.config)
            setAppearance(value.config)
            syncDrafts(value.config, false)
          }
          if (name === 'import' && value && value.imported && value.imported.hasSecret === false) {
            setActionError(t('notice.importedNoSecret'))
          } else if (successMessage) {
            flash(successMessage)
          }
        } catch (error) {
          if (mounted.current) setActionError(error instanceof Error ? error.message : String(error))
        } finally {
          busyRef.current = ''
          if (mounted.current) setBusy('')
        }
      }

      /** 外观单独保存：只提交三个字段，不掺进主表单的 dirty 逻辑。 */
      const saveLook = async () => {
        if (lookBusy) return
        const displayName = look.displayName.trim().slice(0, DISPLAY_NAME_MAX)
        if (!displayName) {
          setLookError(t('error.displayName'))
          return
        }
        const emojiChars = Array.from(String(look.iconEmoji || '').trim())
        const iconEmoji = emojiChars[0] || (look.iconPreset === 'emoji' ? '' : DEFAULT_EMOJI)
        if (look.iconPreset === 'emoji' && !iconEmoji) {
          setLookError(t('error.emoji'))
          return
        }
        setLookBusy(true)
        setLookError('')
        setLookNotice('')
        try {
          const value = await api('/config', { displayName, iconPreset: look.iconPreset, iconEmoji })
          if (!mounted.current) return
          if (value && value.config) {
            setSnap(prev => {
              const next = { ...(prev || {}) }
              next.config = value.config
              if (value.status) next.status = value.status
              return next
            })
            setAppearance(value.config)
            syncLook(value.config, true)
          }
          setLookNotice(t('notice.lookSaved'))
          if (lookTimer.current !== null) clearTimeout(lookTimer.current)
          lookTimer.current = setTimeout(() => {
            lookTimer.current = null
            if (mounted.current) setLookNotice('')
          }, 3000)
        } catch (error) {
          if (mounted.current) setLookError(error instanceof Error ? error.message : String(error))
        } finally {
          if (mounted.current) setLookBusy(false)
        }
      }

      /* ---------------- 分区保存 / 记忆清空 / 手动掷骰 ---------------- */
      const blockBusy = key => asObject(blocksRef.current[key]).busy === true
      const blockInfo = key => asObject(blocks[key])

      const setBlock = (key, patch) => {
        setBlocks(prev => ({ ...prev, [key]: { ...asObject(prev[key]), ...patch } }))
      }

      const clearBlockTimer = key => {
        const timer = blockTimers.current[key]
        if (timer !== undefined && timer !== null) clearTimeout(timer)
        delete blockTimers.current[key]
      }

      const flashBlock = (key, text) => {
        setBlock(key, { busy: false, error: '', notice: text })
        clearBlockTimer(key)
        blockTimers.current[key] = setTimeout(() => {
          delete blockTimers.current[key]
          if (mounted.current) setBlocks(prev => {
            const next = { ...prev }
            const current = asObject(prev[key])
            if (current.notice === text) next[key] = { ...current, notice: '' }
            return next
          })
        }, 3200)
      }

      const failBlock = (key, error) => {
        setBlock(key, { busy: false, notice: '', error: error instanceof Error ? error.message : String(error) })
      }

      const mergeConfig = config => {
        setSnap(prev => {
          const next = { ...(prev || {}) }
          next.config = config
          return next
        })
      }

      /** 通用分区保存：POST /config -> 合并回显 -> 同步草稿 -> 反馈。 */
      const saveBlock = async (key, payload, noticeKey) => {
        if (blockBusy(key)) return
        setBlock(key, { busy: true, error: '', notice: '' })
        try {
          const value = await api('/config', payload)
          if (!mounted.current) return
          if (value && value.config) {
            mergeConfig(value.config)
            setAppearance(value.config)
            syncDrafts(value.config, false)
            // 保存成功的分区强制把草稿对齐到服务端值，避免 dirty 卡住。
            if (key === 'soul') syncSoul(value.config, true)
            else if (key === 'emotion') syncEmotion(value.config, true)
            else if (key === 'speak') syncSpeak(value.config, true)
          }
          if (value && value.config && !payloadApplied(value.config, payload)) {
            failBlock(key, t('notice.configNotApplied'))
            return
          }
          flashBlock(key, t(noticeKey))
        } catch (error) {
          if (mounted.current) failBlock(key, error)
        }
      }

      const quietHoursInvalid = () => {
        const start = speakForm.quietStart.trim()
        const end = speakForm.quietEnd.trim()
        return (start && minutesOf(start) === null) || (end && minutesOf(end) === null)
      }

      const saveSoul = () => {
        const name = soulForm.soulName.trim().slice(0, 20)
        if (!name) {
          setBlock('soul', { busy: false, notice: '', error: t('error.soulName') })
          return
        }
        void saveBlock('soul', {
          soulName: name,
          soulUserNickname: soulForm.soulUserNickname.trim().slice(0, 20),
          soulEnabled: soulForm.soulEnabled === true,
          soulHonestyLine: soulForm.soulHonestyLine === true,
        }, 'notice.soulSaved')
      }

      const saveEmotion = () => {
        void saveBlock('emotion', { expressionStyle: styleOf(emotionForm.expressionStyle) }, 'notice.emotionSaved')
      }

      const saveSpeak = () => {
        if (quietHoursInvalid()) {
          setBlock('speak', { busy: false, notice: '', error: t('error.quietFormat') })
          return
        }
        void saveBlock('speak', {
          speakEnabled: speakForm.speakEnabled === true,
          speakDryRun: speakForm.speakDryRun === true,
          speakIntervalMinutes: clampInt(speakForm.speakIntervalMinutes, 5, 1440, 30),
          speakCooldownMinutes: clampInt(speakForm.speakCooldownMinutes, 0, 1440, 45),
          speakDailyCap: clampInt(speakForm.speakDailyCap, 0, 10, 3),
          quietStart: speakForm.quietStart.trim(),
          quietEnd: speakForm.quietEnd.trim(),
          speakStickerEnabled: speakForm.speakStickerEnabled === true,
        }, 'notice.speakSaved')
      }

      const disarmReset = () => {
        if (resetTimer.current !== null) {
          clearTimeout(resetTimer.current)
          resetTimer.current = null
        }
        setResetArmed(false)
      }

      const resetMemory = async () => {
        if (blockBusy('memory')) return
        setBlock('memory', { busy: true, error: '', notice: '' })
        try {
          const value = await api('/soul/reset', { scope: 'memory' })
          if (!mounted.current) return
          if (value && value.reset !== 'memory') {
            failBlock('memory', t('memory.resetUnsupported'))
            void load(false)
            return
          }
          flashBlock('memory', t('memory.resetNotice'))
          void load(false)
        } catch (error) {
          if (mounted.current) failBlock('memory', error)
        }
      }

      const armReset = () => {
        if (resetArmed) {
          disarmReset()
          void resetMemory()
          return
        }
        setResetArmed(true)
        if (resetTimer.current !== null) clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null
          if (mounted.current) setResetArmed(false)
        }, 4000)
      }

      const runSpeakTick = async () => {
        if (blockBusy('speakTick')) return
        setBlock('speakTick', { busy: true, error: '', notice: '' })
        try {
          const value = await api('/speak/tick', {})
          if (!mounted.current) return
          const result = asObject((value && (value.result || value.tick)) || value)
          const hit = result.hit === true || result.sent === true || result.wouldSpeak === true
          const reason = rowText(result, 'reason', 'done', 'summary', 'message', 'error')
          flashBlock('speakTick', reason || t(hit ? 'speak.tickHit' : 'speak.tickMiss'))
          void load(false)
        } catch (error) {
          if (mounted.current) failBlock('speakTick', error)
        }
      }

      const config = (snap && snap.config) || {}
      const status = (snap && snap.status) || {}
      const emotion = (snap && snap.emotion) || null
      const proactive = (snap && snap.proactive) || {}
      const sessions = Array.isArray(snap && snap.sessions)
        ? snap.sessions.slice().sort((left, right) => {
            const a = Date.parse((left && left.updatedAt) || '') || 0
            const b = Date.parse((right && right.updatedAt) || '') || 0
            return b - a
          })
        : []

      const online = status.online === true
      const configured = !!(config.appId && config.appSecret)
      const lastError = typeof status.lastError === 'string' ? status.lastError : ''
      const dirty = formKey(form) !== formKey(baseline) || form.appSecret.trim() !== ''
      const lookDirty = appearanceKey(look) !== appearanceKey(lookBaseline)
      const busyAny = busy !== ''
      const statusText = online ? t('status.online') : configured ? t('status.offline') : t('status.unconfigured')
      const startedAt = Number(status.startedAt) || 0
      const uptime = online && startedAt ? formatUptime(Date.now() - startedAt, t) : ''
      const lastProactiveAt = Number(proactive.lastProactiveAt) || 0
      const lastReason = typeof proactive.lastReason === 'string' ? proactive.lastReason : ''
      const moodKeys = ['valence', 'arousal', 'affection', 'energy']
      const updatedAt = Number(emotion && emotion.updatedAt) || 0

      /* ---- 灵魂层快照（Host 未就绪时全部走空态） ---- */
      const soulData = asObject(snap && snap.soul)
      const soulPresent = Object.keys(soulData).length > 0
      const soulIdentity = asObject(soulData.identity)
      const soulName = typeof soulIdentity.name === 'string' && soulIdentity.name.trim() ? soulIdentity.name.trim() : (config.soulName || soulForm.soulName || 'Aura')
      const soulUserNickname = typeof soulIdentity.userNickname === 'string' ? soulIdentity.userNickname : (config.soulUserNickname || '')
      const relation = asObject(soulData.relation)
      const relationStage = stageOf(relation.stage)
      const relationScore = clampScore(relation.score)
      const relationDays = Number(relation.days) > 0 ? Math.round(Number(relation.days)) : 0
      const relationTurns = Number(relation.turns) > 0 ? Math.round(Number(relation.turns)) : 0
      const relationNextAt = Number(relation.nextAt)
      const relationNextStage = relation.nextStage ? stageOf(relation.nextStage) : ''
      const milestones = milestoneRows(relation.milestones).slice(0, 3)
      const soulEmotion = asObject(soulData.emotion)
      const legacyEmotion = asObject(emotion)
      const moodValues = {
        valence: moodUnit(soulEmotion.valence, legacyEmotion.valence, true),
        arousal: moodUnit(soulEmotion.arousal, legacyEmotion.arousal, false),
        affection: moodUnit(soulEmotion.affection, legacyEmotion.affection, false),
        energy: moodUnit(soulEmotion.energy, legacyEmotion.energy, false),
      }
      const lastChangeRaw = lastChangeInfo(soulEmotion.lastChange)
      const lastChange = (lastChangeRaw.text || lastChangeRaw.at)
        ? lastChangeRaw
        : {
            at: timeOf(soulEmotion.updatedAt),
            text: typeof soulEmotion.cause === 'string' ? soulEmotion.cause : '',
          }
      const memory = asObject(soulData.memory)
      const memoryEvents = rowsNewest(memory.events, 'at').slice(0, 10).map(row => ({
        at: timeOf(asObject(row).at || asObject(row).createdAt),
        text: rowText(row, 'summary', 'text', 'note', 'content'),
      })).filter(row => row.text)
      const noteGroups = ['user', 'us', 'self'].map(category => {
        const items = asArray(asObject(memory.notes)[category]).map(row => ({
          at: timeOf(asObject(row).at || asObject(row).createdAt || asObject(row).updatedAt),
          text: rowText(row, 'text', 'content', 'note', 'summary'),
        })).filter(row => row.text)
        return { category, items }
      })
      const noteCount = noteGroups.reduce((total, group) => total + group.items.length, 0)
      const topics = topicRows(memory.topics).slice(0, 24)
      const speakState = asObject(soulData.speak)
      const legacyProactive = asObject(proactive)
      const speakLog = speakLogRows(speakState.log).slice(0, 8)
      const timelineAll = timelineRows(soulData.explainLog)
      const timeline = timelineAll.slice(0, 20)
      const speakLastAt = timeOf(speakState.lastAt) || timeOf(legacyProactive.lastAt) || timeOf(legacyProactive.lastProactiveAt)
      const speakTodayCount = Number(speakState.todayCount) || 0
      const soulBudget = clampInt(config.soulPromptBudget, 0, 100000, 0)
      const soulDirty = draftKey(soulForm) !== draftKey(soulBaseline)
      const emotionDirty = draftKey(emotionForm) !== draftKey(emotionBaseline)
      const speakDirty = draftKey(speakForm) !== draftKey(speakBaseline)
      const blockFeedback = key => {
        const info = asObject(blocks[key])
        if (info.error) {
          return h('div', { className: 'qqn-feedback qqn-feedback-error', role: 'status', 'aria-live': 'polite' }, info.error)
        }
        if (info.notice) {
          return h('div', { className: 'qqn-feedback', role: 'status', 'aria-live': 'polite' }, info.notice)
        }
        return null
      }

      const header = h('header', { className: 'qqn-heading' },
        h('div', null,
          h('h1', null, currentLook.displayName || DEFAULT_DISPLAY_NAME),
          h('div', { className: 'qqn-sub' }, t('subtitle')),
        ),
        h('span', { className: 'qqn-chip' },
          h('span', { className: 'qqn-dot' + (online ? ' qqn-dot-ok' : '') + (lastError && !online ? ' qqn-dot-err' : '') }),
          statusText,
        ),
      )

      if (loading && !snap) {
        return h(React.Fragment, null,
          h('style', { key: 'qqn-css' }, CSS),
          h('section', { className: 'qqn-page' },
            h('div', { className: 'qqn-scroll' },
              h('div', { className: 'qqn-content' },
                header,
                h('div', { className: 'qqn-loading' }, t('loading')),
              ),
            ),
          ),
        )
      }

      const appearanceSection = h(Section, { title: t('section.appearance') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: t('row.displayName'),
            hint: t('row.displayName.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: look.displayName,
              maxLength: DISPLAY_NAME_MAX,
              placeholder: DEFAULT_DISPLAY_NAME,
              spellCheck: false,
              onChange: event => setLook(prev => ({ ...prev, displayName: event.target.value })),
            }),
          }),
          h('div', { className: 'qqn-look' },
            h('div', { className: 'qqn-look-title' }, t('row.icon')),
            h('div', { className: 'qqn-look-grid', role: 'group', 'aria-label': t('row.icon') },
              ICON_CHOICES.map(preset => h('button', {
                key: preset,
                type: 'button',
                className: 'qqn-look-tile',
                title: t('icon.' + preset),
                'aria-pressed': look.iconPreset === preset,
                onClick: () => setLook(prev => ({ ...prev, iconPreset: preset })),
              },
                h('span', { className: 'qqn-look-glyph' }, h(IconGlyph, { preset, emoji: look.iconEmoji, size: 22 })),
                h('span', { className: 'qqn-look-name' }, t('icon.' + preset)),
              )),
            ),
            h('div', { className: 'qqn-look-emoji' },
              h('span', { className: 'qqn-unit' }, t('row.iconEmoji')),
              h('input', {
                className: 'qqn-input qqn-input-emoji',
                value: look.iconEmoji,
                maxLength: 4,
                disabled: look.iconPreset !== 'emoji',
                placeholder: DEFAULT_EMOJI,
                'aria-label': t('row.iconEmoji'),
                spellCheck: false,
                onChange: event => setLook(prev => {
                  const next = Array.from(String(event.target.value))[0]
                  return { ...prev, iconEmoji: next || prev.iconEmoji }
                }),
              }),
              h('span', { className: 'qqn-row-hint', style: { marginTop: 0 } }, t('row.iconEmoji.hint')),
            ),
          ),
          h(Row, {
            label: t('row.preview'),
            control: h('span', { className: 'qqn-look-preview' },
              h('span', { className: 'qqn-look-preview-glyph' }, h(IconGlyph, { preset: look.iconPreset, emoji: look.iconEmoji, size: 18 })),
              h('span', { className: 'qqn-look-preview-name' }, look.displayName.trim() || t('look.untitled')),
            ),
          }),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: lookBusy || !lookDirty,
            onClick: () => void saveLook(),
          }, lookBusy ? t('busy.look') : t('button.lookSave')),
        ),
        lookError || lookNotice
          ? h('div', {
              className: 'qqn-feedback' + (lookError ? ' qqn-feedback-error' : ''),
              role: 'status',
              'aria-live': 'polite',
            }, lookError || lookNotice)
          : null,
      )

      const statusRows = h('div', { className: 'qqn-rows' },
        h(Row, {
          label: t('row.connection'),
          hint: configured ? t('row.connection.configuredHint') : t('row.connection.unconfiguredHint'),
          control: h('span', { className: 'qqn-chip' },
            h('span', { className: 'qqn-dot' + (online ? ' qqn-dot-ok' : '') + (lastError && !online ? ' qqn-dot-err' : '') }),
            statusText,
          ),
        }),
        online && startedAt
          ? h(Row, {
              label: t('row.startedAt'),
              control: h('span', { className: 'qqn-unit' },
                (formatClock(startedAt) ? formatClock(startedAt) + ' · ' : '') + t('row.uptime') + ' ' + uptime,
              ),
            })
          : null,
      )

      const credentialsSection = h(Section, { title: t('section.credentials') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: t('row.appId'),
            hint: t('row.appId.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: form.appId,
              placeholder: '1900000000',
              inputMode: 'numeric',
              spellCheck: false,
              onChange: event => setField('appId', event.target.value),
            }),
          }),
          h(Row, {
            label: t('row.appSecret'),
            hint: configured ? t('row.appSecret.saved') : null,
            control: h('input', {
              className: 'qqn-input',
              type: 'password',
              value: form.appSecret,
              placeholder: configured ? '' : t('row.appSecret.placeholder'),
              spellCheck: false,
              onChange: event => setField('appSecret', event.target.value),
            }),
          }),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: busyAny || !dirty,
            onClick: () => void run('save', () => api('/config', patch()), t('notice.saved')),
          }, busy === 'save' ? t('busy.save') : t('button.save')),
          h(Button, {
            disabled: busyAny,
            onClick: () => void run('connect', () => api('/connect', patch()), t('notice.connected')),
          }, busy === 'connect' ? t('busy.connect') : t('button.connect')),
          h(Button, {
            variant: 'quiet',
            disabled: busyAny || !online,
            onClick: () => void run('disconnect', () => api('/disconnect', {}), t('notice.disconnected')),
          }, busy === 'disconnect' ? t('busy.disconnect') : t('button.disconnect')),
          h(Button, {
            variant: 'quiet',
            disabled: busyAny,
            onClick: () => void run('import', () => api('/import', {}), t('notice.imported')),
          }, busy === 'import' ? t('busy.import') : t('button.import')),
        ),
        actionError || notice
          ? h('div', {
              className: 'qqn-feedback' + (actionError ? ' qqn-feedback-error' : ''),
              role: 'status',
              'aria-live': 'polite',
            }, actionError || notice)
          : null,
      )

      const messagesSection = h(Section, { title: t('section.messages') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: t('row.splitEnabled'),
            hint: t('row.splitEnabled.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: form.splitEnabled === true,
              onChange: event => setField('splitEnabled', event.target.checked),
            }),
          }),
          h(Row, {
            label: t('row.splitRegex'),
            hint: t('row.splitRegex.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: form.splitRegex,
              placeholder: '\\n{2,}',
              disabled: form.splitEnabled !== true,
              spellCheck: false,
              onChange: event => setField('splitRegex', event.target.value),
            }),
          }),
          h(Row, {
            label: t('row.maxMessages'),
            hint: t('row.maxMessages.hint'),
            control: h('div', { className: 'qqn-seg', role: 'group', 'aria-label': t('row.maxMessages') },
              Array.from({ length: MAX_REPLIES }, (_unused, index) => index + 1).map(value => h('button', {
                key: value,
                type: 'button',
                className: 'qqn-seg-button',
                'aria-pressed': clampInt(form.maxMessages, 1, MAX_REPLIES, 4) === value,
                onClick: () => setField('maxMessages', value),
              }, String(value))),
            ),
          }),
          h(Row, {
            label: t('row.cwd'),
            hint: t('row.cwd.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: form.cwd,
              placeholder: t('row.cwd.placeholder'),
              spellCheck: false,
              onChange: event => setField('cwd', event.target.value),
            }),
          }),
        ),
      )

      const soulSection = h(Section, { title: t('section.soul') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: t('row.soulName'),
            hint: t('row.soulName.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: soulForm.soulName,
              maxLength: 20,
              placeholder: 'Aura',
              spellCheck: false,
              onChange: event => setSoulForm(prev => ({ ...prev, soulName: event.target.value })),
            }),
          }),
          h(Row, {
            label: t('row.soulUserNickname'),
            hint: t('row.soulUserNickname.hint'),
            control: h('input', {
              className: 'qqn-input',
              value: soulForm.soulUserNickname,
              maxLength: 20,
              placeholder: t('row.soulUserNickname.placeholder'),
              spellCheck: false,
              onChange: event => setSoulForm(prev => ({ ...prev, soulUserNickname: event.target.value })),
            }),
          }),
          h(Row, {
            label: t('row.soulEnabled'),
            hint: t('row.soulEnabled.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: soulForm.soulEnabled === true,
              onChange: event => setSoulForm(prev => ({ ...prev, soulEnabled: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.soulHonestyLine'),
            hint: t('row.soulHonestyLine.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: soulForm.soulHonestyLine === true,
              onChange: event => setSoulForm(prev => ({ ...prev, soulHonestyLine: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.soulBudget'),
            control: h('span', { className: 'qqn-unit' }, soulBudget ? t('soul.budgetValue', { n: soulBudget }) : t('soul.budgetUnknown')),
          }),
          soulPresent ? null : h('div', { className: 'qqn-mood-empty' }, t('empty.soulPending')),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: blockInfo('soul').busy || !soulDirty,
            onClick: saveSoul,
          }, blockInfo('soul').busy ? t('busy.save') : t('button.soulSave')),
        ),
        blockFeedback('soul'),
      )

      const emotionSection = h(Section, { title: t('section.emotion') },
        h('div', { className: 'qqn-rows' },
          h('div', { className: 'qqn-mood' },
            moodKeys.map(key => h('div', { key },
              h('div', { className: 'qqn-mood-label' }, t('mood.' + key)),
              h('div', { className: 'qqn-mood-value' }, moodValues[key].toFixed(2)),
              h('div', { className: 'qqn-mood-track' },
                h('div', { className: 'qqn-mood-fill', style: { width: (moodValues[key] * 100) + '%' } }),
              ),
            )),
          ),
          typeof soulEmotion.label === 'string' && soulEmotion.label
            ? h(Row, { label: t('row.emotionNow'), control: h('span', { className: 'qqn-unit' }, soulEmotion.label) })
            : null,
          h(Row, {
            label: t('row.expressionStyle'),
            hint: t('row.expressionStyle.hint'),
            control: h('div', { className: 'qqn-seg', role: 'group', 'aria-label': t('row.expressionStyle') },
              EXPRESSION_STYLES.map(style => h('button', {
                key: style,
                type: 'button',
                className: 'qqn-seg-button',
                'aria-pressed': styleOf(emotionForm.expressionStyle) === style,
                onClick: () => setEmotionForm(prev => ({ ...prev, expressionStyle: style })),
              }, t('style.' + style))),
            ),
          }),
          lastChange.text || lastChange.at
            ? h('div', { className: 'qqn-mood-note' },
                t('row.emotionLastChange') + '：' + (lastChange.text || '') +
                  (lastChange.at ? '（' + formatRelative(lastChange.at, t) + '）' : ''),
              )
            : h('div', { className: 'qqn-mood-empty' }, t('emotion.empty')),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: blockInfo('emotion').busy || !emotionDirty,
            onClick: saveEmotion,
          }, blockInfo('emotion').busy ? t('busy.save') : t('button.emotionSave')),
        ),
        blockFeedback('emotion'),
      )

      const relationSection = h(Section, { title: t('section.relation') },
        h('div', { className: 'qqn-rows' },
          h('div', { className: 'qqn-relation' },
            h('div', { className: 'qqn-relation-head' },
              h('span', { className: 'qqn-stage' },
                h('span', { className: 'qqn-dot qqn-dot-' + relationStage }),
                t('soul.stage.' + relationStage),
              ),
              h('span', { className: 'qqn-unit' }, t('relation.score', { score: relationScore.toFixed(0) })),
            ),
            h('div', { className: 'qqn-mood-track qqn-relation-track' },
              h('div', { className: 'qqn-mood-fill', style: { width: relationScore + '%' } }),
            ),
            relationDays || relationTurns
              ? h('div', { className: 'qqn-row-hint', style: { marginTop: 6 } }, t('relation.metaInfo', { days: relationDays || 1, turns: relationTurns || 0 }))
              : null,
            Number.isFinite(relationNextAt)
              ? h('div', { className: 'qqn-row-hint', style: { marginTop: 6 } }, t('relation.nextStage', {
                  score: Math.max(0, Math.round(relationNextAt - relationScore)),
                  stage: t('soul.stage.' + (relationNextStage || 'stranger')),
                }))
              : null,
            h('div', { className: 'qqn-row-hint', style: { marginTop: 8 } }, t('relation.hint')),
          ),
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('relation.milestones')),
            milestones.length
              ? h('div', { className: 'qqn-event-list' }, milestones.map((row, index) => h('div', {
                  key: 'milestone-' + index,
                  className: 'qqn-event',
                },
                  h('span', { className: 'qqn-event-time' }, formatRelative(row.at, t)),
                  h('span', { className: 'qqn-event-text' }, row.text),
                )))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('relation.noMilestones') : t('empty.soulPending')),
          ),
        ),
      )

      const memorySection = h(Section, {
        title: t('section.memory'),
        action: soulPresent && noteCount ? h('span', null, t('memory.notesCount', { count: noteCount })) : null,
      },
        h('div', { className: 'qqn-rows' },
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('memory.events')),
            memoryEvents.length
              ? h('div', { className: 'qqn-event-list' }, memoryEvents.map((row, index) => h('div', {
                  key: 'event-' + index,
                  className: 'qqn-event',
                },
                  h('span', { className: 'qqn-event-time' }, formatRelative(row.at, t)),
                  h('span', { className: 'qqn-event-text' }, row.text),
                )))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.eventsEmpty') : t('empty.soulPending')),
          ),
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('memory.notes')),
            noteCount === 0
              ? h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.emptyHint') : t('empty.soulPending'))
              : noteGroups.filter(group => group.items.length > 0).map(group => h('div', { key: group.category, className: 'qqn-memory-group' },
                  h('div', { className: 'qqn-memory-group-title' }, t('memory.note.' + group.category) + ' · ' + t('memory.notesCount', { count: group.items.length })),
                  group.items.slice(0, 4).map((row, index) => h('div', {
                    key: 'note-' + group.category + '-' + index,
                    className: 'qqn-memory-item',
                  }, '· ' + row.text)),
                )),
          ),
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('memory.topics')),
            topics.length
              ? h('div', { className: 'qqn-chip-list' }, topics.map((row, index) => h('span', {
                  key: 'topic-' + index,
                  className: 'qqn-tag',
                }, row.label)))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.topicsEmpty') : t('empty.soulPending')),
          ),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'danger',
            disabled: blockInfo('memory').busy,
            onClick: armReset,
          }, blockInfo('memory').busy ? t('busy.save') : (resetArmed ? t('memory.resetConfirm') : t('memory.reset'))),
          h('span', { className: 'qqn-row-hint', style: { marginTop: 0, marginLeft: 4 } }, t('memory.resetWarning')),
        ),
        blockFeedback('memory'),
      )

      const speakSection = h(Section, { title: t('section.speak') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: t('row.speakEnabled'),
            hint: t('row.speakEnabled.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: speakForm.speakEnabled === true,
              onChange: event => setSpeakForm(prev => ({ ...prev, speakEnabled: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.speakDryRun'),
            hint: t('row.speakDryRun.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: speakForm.speakDryRun === true,
              onChange: event => setSpeakForm(prev => ({ ...prev, speakDryRun: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.speakInterval'),
            hint: t('row.speakInterval.hint'),
            control: h(React.Fragment, null,
              h('input', {
                className: 'qqn-input qqn-input-narrow',
                type: 'number',
                min: 5,
                max: 1440,
                step: 5,
                value: speakForm.speakIntervalMinutes,
                onChange: event => setSpeakForm(prev => ({
                  ...prev,
                  speakIntervalMinutes: event.target.value === '' ? '' : Number(event.target.value),
                })),
              }),
              h('span', { className: 'qqn-unit' }, t('speak.unitMinutes')),
            ),
          }),
          h(Row, {
            label: t('row.speakCooldown'),
            hint: t('row.speakCooldown.hint'),
            control: h(React.Fragment, null,
              h('input', {
                className: 'qqn-input qqn-input-narrow',
                type: 'number',
                min: 0,
                max: 1440,
                step: 5,
                value: speakForm.speakCooldownMinutes,
                onChange: event => setSpeakForm(prev => ({
                  ...prev,
                  speakCooldownMinutes: event.target.value === '' ? '' : Number(event.target.value),
                })),
              }),
              h('span', { className: 'qqn-unit' }, t('speak.unitMinutes')),
            ),
          }),
          h(Row, {
            label: t('row.speakDailyCap'),
            hint: t('row.speakDailyCap.hint'),
            control: h(React.Fragment, null,
              h('input', {
                className: 'qqn-input qqn-input-narrow',
                type: 'number',
                min: 0,
                max: 10,
                step: 1,
                value: speakForm.speakDailyCap,
                onChange: event => setSpeakForm(prev => ({
                  ...prev,
                  speakDailyCap: event.target.value === '' ? '' : Number(event.target.value),
                })),
              }),
              h('span', { className: 'qqn-unit' }, t('speak.unitTimes')),
            ),
          }),
          h(Row, {
            label: t('row.quiet'),
            hint: t('row.quiet.hint'),
            control: h(React.Fragment, null,
              h('input', {
                className: 'qqn-input qqn-input-time',
                value: speakForm.quietStart,
                placeholder: '23:30',
                maxLength: 5,
                spellCheck: false,
                onChange: event => setSpeakForm(prev => ({ ...prev, quietStart: event.target.value })),
              }),
              h('span', { className: 'qqn-unit' }, t('row.quiet.to')),
              h('input', {
                className: 'qqn-input qqn-input-time',
                value: speakForm.quietEnd,
                placeholder: '07:30',
                maxLength: 5,
                spellCheck: false,
                onChange: event => setSpeakForm(prev => ({ ...prev, quietEnd: event.target.value })),
              }),
            ),
          }),
          h(Row, {
            label: t('row.speakSticker'),
            hint: t('row.speakSticker.hint'),
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: speakForm.speakStickerEnabled === true,
              onChange: event => setSpeakForm(prev => ({ ...prev, speakStickerEnabled: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.speakLast'),
            control: h('span', { className: 'qqn-unit' }, speakLastAt ? formatRelative(speakLastAt, t) : t('speak.lastNever')),
          }),
          soulPresent
            ? h(Row, {
                label: t('row.speakToday'),
                control: h('span', { className: 'qqn-unit' },
                  t('speak.todayValue', {
                    count: speakTodayCount,
                    cap: clampInt(speakForm.speakDailyCap, 0, 10, 3),
                  }),
                ),
              })
            : null,
          soulPresent
            ? h('div', { className: 'qqn-memory-block' },
                h('div', { className: 'qqn-look-title' }, t('speak.log')),
                speakLog.length
                  ? h('div', { className: 'qqn-log-list' }, speakLog.map((row, index) => h('div', {
                      key: 'speak-log-' + index,
                      className: 'qqn-log-row',
                    },
                      h('span', { className: 'qqn-log-time' }, formatRelative(row.at, t)),
                      h('span', { className: 'qqn-log-badge' + (row.hit ? ' qqn-log-badge-hit' : '') }, row.hit ? t('speak.logHit') : t('speak.logMiss')),
                      row.dryRun ? h('span', { className: 'qqn-log-badge' }, t('speak.logDry')) : null,
                      h('span', { className: 'qqn-log-reason' }, row.reason || t('common.unknown')),
                    )))
                  : h('div', { className: 'qqn-mood-empty' }, t('speak.logEmpty')),
              )
            : null,
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: blockInfo('speak').busy || !speakDirty,
            onClick: saveSpeak,
          }, blockInfo('speak').busy ? t('busy.save') : t('button.speakSave')),
          h(Button, {
            disabled: blockInfo('speakTick').busy,
            onClick: () => void runSpeakTick(),
          }, blockInfo('speakTick').busy ? t('busy.speakTick') : t('button.speakTick')),
        ),
        blockFeedback('speak'),
        blockFeedback('speakTick'),
      )

      const timelineSection = h(Section, {
        title: t('section.timeline'),
        action: h('button', {
          type: 'button',
          className: 'qqn-seg-button',
          'aria-expanded': timelineOpen,
          onClick: () => setTimelineOpen(open => !open),
        }, timelineOpen ? t('timeline.collapse') : t('timeline.expand')),
      },
        h('div', { className: 'qqn-rows' },
          timelineOpen
            ? (timeline.length
                ? h('div', { className: 'qqn-log-list' }, timeline.map((row, index) => h('div', {
                    key: 'timeline-' + index,
                    className: 'qqn-log-row',
                  },
                    h('span', { className: 'qqn-log-time' }, formatRelative(row.at, t)),
                    row.kind ? h('span', { className: 'qqn-log-badge' }, row.kind) : null,
                    h('span', { className: 'qqn-log-reason' }, row.summary || t('common.unknown')),
                  )))
                : h('div', { className: 'qqn-mood-empty' }, t('timeline.empty')))
            : h('div', { className: 'qqn-mood-empty' }, t('timeline.collapsed', { count: timelineAll.length })),
        ),
      )

      const sessionsSection = h(Section, {
        title: t('section.sessions'),
        action: sessions.length ? h('span', null, t('sessions.count', { count: sessions.length })) : null,
      },
        h('div', { className: 'qqn-rows' },
          sessions.length === 0
            ? h('div', { className: 'qqn-empty' }, t('sessions.empty'))
            : sessions.map((item, index) => h('div', { key: (item && item.sessionId) || 'session-' + index, className: 'qqn-session' },
                h('div', { className: 'qqn-session-left' },
                  h('div', { className: 'qqn-session-title' },
                    h('span', { className: 'qqn-session-kind' }, item && item.kind === 'group' ? t('sessions.group') : t('sessions.direct')),
                    h('span', { className: 'qqn-session-chat' }, (item && item.chatId) || ''),
                  ),
                  h('div', { className: 'qqn-session-meta' },
                    [(item && item.sessionId) || '', item && item.cwd ? String(item.cwd) : ''].filter(Boolean).join(' · '),
                  ),
                ),
                h('span', { className: 'qqn-session-time' }, item ? formatRelative(Date.parse(item.updatedAt || ''), t) : ''),
              )),
        ),
      )

      const tabDefs = [
        ['soul', '灵魂'],
        ['emotion', '情绪'],
        ['memory', '记忆'],
        ['speak', '主动'],
        ['appearance', '外观'],
        ['connect', '连接'],
        ['debug', '调试'],
      ]
      const tabNav = h('div', { className: 'qqn-tabs' },
        tabDefs.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          className: 'qqn-tab' + (tab === id ? ' qqn-tab-active' : ''),
          onClick: () => setTab(id),
        }, label)),
      )

      return h(React.Fragment, null,
        h('style', { key: 'qqn-css' }, CSS),
        h('section', { className: 'qqn-page' },
          h('div', { className: 'qqn-scroll' },
            h('div', { className: 'qqn-content' },
              header,
              pollError ? h('div', { className: 'qqn-error' }, t('error.load') + '：' + pollError) : null,
              tabNav,
              tab === 'soul' ? soulSection : null,
              tab === 'emotion' ? h(React.Fragment, null, emotionSection, relationSection) : null,
              tab === 'memory' ? memorySection : null,
              tab === 'speak' ? speakSection : null,
              tab === 'appearance' ? appearanceSection : null,
              tab === 'connect' ? h(React.Fragment, null,
                h(Section, { title: t('section.status') },
                  statusRows,
                  lastError ? h('div', { className: 'qqn-error' }, t('row.lastError') + '：' + lastError) : null,
                ),
                credentialsSection,
                messagesSection,
                sessionsSection,
              ) : null,
              tab === 'debug' ? h(React.Fragment, null, timelineSection) : null,
              h('div', { className: 'qqn-notice' }, t('note.footer')),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        void primeAppearance()
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            try {
              return locale.register(NS, { zh: ZH, en: EN })
            } catch (error) {
              // 命名空间已注册（热重载等）时继续用内置中文兜底，不阻断面板。
              console.warn('[dsh-aura] 面板文案注册失败，使用内置兜底：', error)
              return undefined
            }
          }, 'dsh-aura: panel dictionaries')
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-aura',
          locale: NS,
        }, Panel))
        // 侧栏名字：label 是 thunk，每次解析 metadata 时读当前 appearance。
        // 侧栏只在 slot 变更/语言切换时重算 metadata，所以名字变了要重新注册这条入口；
        // 图标本身由 SidebarIcon 内部订阅外观，不必重注册。
        ctx.slots.inject('sidebar.panellist', () => {
          const mount = () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-aura',
            order: 40,
            label: () => appearance.displayName,
          }, SidebarIcon)
          let dispose = mount()
          let labelled = appearance.displayName
          const unsubscribe = subscribeAppearance(next => {
            if (next.displayName === labelled) return
            labelled = next.displayName
            try {
              dispose()
              dispose = mount()
            } catch (error) {
              console.warn('[dsh-aura] 侧栏名字刷新失败：', error)
            }
          })
          return () => {
            unsubscribe()
            dispose()
          }
        })
      },
    }
  },
})
