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

    /** 表情包 Host API（dsh-aura 自有路由，不再依赖已停用的 dsh-meme 前端）。 */
    const MEME_API = '/dsh-aura/memes-api'
    const MEME_BASE = '/dsh-aura/memes'
    /** 人设 Host API（收编 dsh-soul）。 */
    const PERSONA_API = '/dsh-aura/persona-api'
    /** 日记 Host API（本机同源；mode=rule 零 token）。 */
    const DIARY_API = '/dsh-aura/diary-api'
    /** 事实卡/实体卡只读接口（Host 单独开的路由，web.js 的 /state 不透传这两块）。 */
    const MEMORY_API = '/dsh-aura/memory-api'
    /** 人设保存成功后广播的 window 事件：光轨等常驻组件据此立即刷新配置。 */
    const PERSONA_SAVED_EVENT = 'aura:persona-saved'
    const MEME_TAG_LABELS = {
      angry: '生气',
      happy: '开心',
      sad: '难过',
      shy: '害羞',
      confused: '困惑',
      daily: '日常',
      surprised: '惊讶',
      sleep: '睡觉',
      like: '喜欢',
      work: '上班',
      baka: '笨蛋',
      fool: '傻瓜',
      color: '彩色',
      cpu: 'CPU',
      givemoney: '给钱',
      meow: '喵喵',
      morning: '早上好',
      see: '看看',
      sigh: '叹气',
    }
    /** 事实卡/实体卡的类型白名单（和 Host 的 ENTITY_TYPES 对齐）。 */
    const MEMORY_ENTITY_TYPES = ['person', 'pet', 'place', 'project', 'other']
    const PERSONA_TRAIL_COLOR_DEFAULT = '#679EFE'
    const PERSONA_STYLES = [
      ['professional', '专业严谨'],
      ['casual', '轻松自然'],
      ['humorous', '幽默风趣'],
      ['roast', '吐槽犀利'],
      ['efficient', '高效干练'],
    ]
    const PERSONA_TRAITS = [
      ['default', '默认'],
      ['more', '更多'],
      ['less', '更少'],
    ]
    const PERSONA_REPLY_LENGTHS = [
      ['concise', '简短'],
      ['normal', '适中'],
      ['detailed', '详细'],
    ]
    const PERSONA_LANGUAGES = [
      ['zh', '简体中文'],
      ['en', 'English'],
    ]
    const PERSONA_TRAIL_SPEEDS = [
      ['slow', '慢'],
      ['normal', '中'],
      ['fast', '快'],
    ]
    const PERSONA_TRAIL_WIDTHS = [
      ['thin', '细'],
      ['normal', '中'],
      ['thick', '粗'],
    ]
    const PERSONA_SOURCE_LABELS = {
      web: '网页',
      tool: '工具',
      preset: '预设',
      undo: '撤销',
      reset: '重置',
      service: '服务',
      command: '命令',
      api: '接口',
    }
    const PERSONA_FIELD_LABELS = {
      enabled: '启用',
      nickname: '昵称',
      occupation: '职业',
      bio: '介绍',
      style: '回复风格',
      headingLists: '标题列表',
      emoji: '表情符号',
      tables: '表格',
      replyLength: '回复长度',
      language: '语言',
      customInstructions: '自定义指令',
      trailEnabled: '光轨',
      trailColor: '光轨颜色',
      trailSpeed: '光轨速度',
      trailWidth: '光轨粗细',
      requireToolConfirmation: '工具确认',
      historyMaxEntries: '历史上限',
    }

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
      'subtitle': 'Aura · 灵魂与关系 · 情绪与成长 · 记忆与日记 · 原生表情包',
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
      'note.footer': '灵魂身份全局注入，情绪与记忆只在 QQ 会话；表情包由 send_meme 选图，QQ 发原生图、网页内联渲染；每条入站消息最多回复 5 条，被动窗口过期后主动消息可能被拒绝。',
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
      'soul.budgetHint': '身份段上限 = {n} 字',
      'section.expression': '表达方式',
      'section.expression.hint': '这是你说话的方式，不改变身份与边界；跟上面的灵魂开关一起生效',
      'section.trail': '光轨',
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
      'emotion.baseline': '基准',
      'emotion.trend.up': '走高',
      'emotion.trend.down': '走低',
      'emotion.trend.flat': '平稳',
      'emotion.volatility': '波动 {value}',
      'emotion.window': '近 {hours} 小时',
      'emotion.chart.title': '情绪曲线',
      'emotion.chart.empty': '历史还不够，聊几句就有曲线了',
      'emotion.chart.valence': '愉悦',
      'emotion.chart.affection': '亲近',
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
      'memory.facts': '事实卡',
      'memory.factsEmpty': '还没有事实卡',
      'memory.factConfidence': '{value}%',
      'memory.entities': '实体卡',
      'memory.entitiesEmpty': '还没有实体卡',
      'memory.entityAliases': '别名：{names}',
      'memory.entity.person': '人物',
      'memory.entity.pet': '宠物',
      'memory.entity.place': '地点',
      'memory.entity.project': '项目',
      'memory.entity.other': '其他',
      'memory.relations': '关系',
      'memory.relationsEmpty': '还没有关系；多聊聊人和事，她会自己连起来',
      'memory.relationWeight': '{value}%',
      'memory.empty': '还没有记忆',
      'memory.emptyHint': '她会在聊天中慢慢记下值得记住的事',
      'memory.reset': '清空记忆',
      'memory.resetConfirm': '再点一次确认清空',
      'memory.resetNotice': '记忆已清空',
      'memory.resetWarning': '会删除事件、笔记、话题和事实/实体卡，且不可恢复',
      'memory.settings': '记忆设置',
      'memory.enabled': '启用记忆',
      'memory.enabled.hint': '关闭后不再把记忆注入对话上下文；已记下的内容仍保留在本地',
      'memory.autoCompact': '自动整理',
      'memory.autoCompact.hint': '每天第一次对话后自动整理事实卡/实体图；关闭后只能手动点「立即整理」',
      'memory.immediate': '立即记忆',
      'memory.immediate.hint': '聊到「记住/别忘/答应/约定」或名字/生日/住址/宠物/好恶时立刻写一条，不用等这轮结束',
      'memory.sessionDigest': '会话整理',
      'memory.sessionDigest.hint': '安静一段时间后自动把这段会话整理成一条摘要；关闭后仍可手动整理',
      'memory.digestIdle': '空闲分钟',
      'memory.digestIdle.hint': '多久没活动算空闲，到点自动整理这段会话（60–1440 分钟）',
      'memory.digestDailyCap': '每日整理上限',
      'memory.digestDailyCap.hint': '自动会话整理每天最多几次（1–5）',
      'memory.digest': '整理这段会话',
      'memory.digesting': '整理中…',
      'memory.digestNotice': '会话整理完成',
      'memory.digestResult': '写了 {notes} 条笔记 · 事件 {events} 条 · 新增事实 {facts} 条',
      'memory.digestTopics': '聊到：{topics}',
      'memory.digestEmpty': '这段没有新内容可整理',
      'memory.digestNoSession': '还没有可整理的会话',
      'memory.maxEvents': '事件上限',
      'memory.maxEvents.hint': '短期事件保留条数（5–40），超出的最旧事件会压实成笔记',
      'memory.maxNotes': '笔记上限',
      'memory.maxNotes.hint': '长期笔记上限（5–200）；记忆库单类硬上限为 30 条',
      'memory.recallLimit': '召回条数',
      'memory.recallLimit.hint': '每次注入记忆上下文时最多带几条笔记（1–3）',
      'memory.reflectionEvery': '反思间隔',
      'memory.reflectionEvery.hint': '每多少轮对话做一次记忆反思（1–50）',
      'memory.unitCount': '条',
      'memory.unitRounds': '轮',
      'memory.unitMinutes': '分钟',
      'memory.unitTimes': '次',
      'memory.save': '保存记忆设置',
      'memory.compact': '立即整理',
      'memory.compacting': '整理中…',
      'memory.compactNotice': '整理完成',
      'memory.compactBefore': '整理前：事件 {events} · 笔记 {notes} · 事实 {facts} · 实体 {entities} · 关系 {relations}',
      'memory.compactAfter': '整理后：事件 {events} · 笔记 {notes} · 事实 {facts} · 实体 {entities} · 关系 {relations}',
      'memory.delete': '删除',
      'memory.deleteFactConfirm': '确定删除这张事实卡？',
      'memory.deleteEntityConfirm': '确定删除这个实体？以它为端点的关系边会一起删除。',
      'memory.deleted': '已删除',
      'memory.deleteUnsupported': '这条记录没有 id，旧 Host 暂不支持删除',
      'memory.unsaved': '记忆设置有改动，记得保存',
      'notice.memorySettingsSaved': '记忆设置已保存',
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
      'subtitle': 'Aura · soul and bond · emotion and growth · memory and diary · native stickers',
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
      'note.footer': 'Soul identity is global; emotion and memory apply to QQ sessions only. send_meme picks stickers (native on QQ, inline on web); each inbound message gets at most 5 replies, and proactive messages may be rejected once the passive window closes.',
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
      'soul.budgetHint': 'Identity section cap = {n} chars',
      'section.expression': 'Expression',
      'section.expression.hint': 'How you speak; this does not change identity or boundaries, and it takes effect together with the soul switch above',
      'section.trail': 'Light trail',
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
      'emotion.baseline': 'Baseline',
      'emotion.trend.up': 'Rising',
      'emotion.trend.down': 'Falling',
      'emotion.trend.flat': 'Steady',
      'emotion.volatility': 'Volatility {value}',
      'emotion.window': 'Last {hours}h',
      'emotion.chart.title': 'Emotion curve',
      'emotion.chart.empty': 'Not enough history yet; chat a bit and the curve shows up',
      'emotion.chart.valence': 'Pleasure',
      'emotion.chart.affection': 'Closeness',
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
      'memory.facts': 'Fact cards',
      'memory.factsEmpty': 'No fact cards yet',
      'memory.factConfidence': '{value}%',
      'memory.entities': 'Entity cards',
      'memory.entitiesEmpty': 'No entity cards yet',
      'memory.entityAliases': 'Aliases: {names}',
      'memory.entity.person': 'Person',
      'memory.entity.pet': 'Pet',
      'memory.entity.place': 'Place',
      'memory.entity.project': 'Project',
      'memory.entity.other': 'Other',
      'memory.relations': 'Relations',
      'memory.relationsEmpty': 'No relations yet - mention people and things and she will link them',
      'memory.relationWeight': '{value}%',
      'memory.empty': 'No memory yet',
      'memory.emptyHint': 'She will remember what is worth remembering as you talk',
      'memory.reset': 'Clear memory',
      'memory.resetConfirm': 'Click again to confirm',
      'memory.resetNotice': 'Memory cleared',
      'memory.resetWarning': 'Deletes events, notes, topics and fact/entity cards; cannot be undone',
      'memory.settings': 'Memory settings',
      'memory.enabled': 'Enable memory',
      'memory.enabled.hint': 'When off, memory context is no longer injected; existing memories stay on disk',
      'memory.autoCompact': 'Auto-organize',
      'memory.autoCompact.hint': 'Runs once on the first turn of each day; off means manual "Organize now" only',
      'memory.immediate': 'Immediate memory',
      'memory.immediate.hint': 'Writes at once when you say remember/promise, or share a name, birthday, address, pet or strong like',
      'memory.sessionDigest': 'Session digest',
      'memory.sessionDigest.hint': 'After a quiet spell, summarizes this conversation into one note; off still allows manual digests',
      'memory.digestIdle': 'Idle minutes',
      'memory.digestIdle.hint': 'How long counts as idle before digesting this session (60-1440 minutes)',
      'memory.digestDailyCap': 'Daily digest cap',
      'memory.digestDailyCap.hint': 'Maximum automatic session digests per day (1-5)',
      'memory.digest': 'Digest this session',
      'memory.digesting': 'Digesting...',
      'memory.digestNotice': 'Session digested',
      'memory.digestResult': 'Wrote {notes} note(s) · {events} event(s) · {facts} new fact(s)',
      'memory.digestTopics': 'Talked about: {topics}',
      'memory.digestEmpty': 'Nothing new in this session to digest',
      'memory.digestNoSession': 'No session to digest yet',
      'memory.maxEvents': 'Event limit',
      'memory.maxEvents.hint': 'Short-term events kept (5-40); oldest ones are compacted into notes',
      'memory.maxNotes': 'Note limit',
      'memory.maxNotes.hint': 'Long-term notes (5-200); the store still caps each category at 30',
      'memory.recallLimit': 'Recall count',
      'memory.recallLimit.hint': 'Notes injected into each memory context (1-3)',
      'memory.reflectionEvery': 'Reflection interval',
      'memory.reflectionEvery.hint': 'Turns between memory reflections (1-50)',
      'memory.unitCount': 'items',
      'memory.unitRounds': 'turns',
      'memory.unitMinutes': 'min',
      'memory.unitTimes': 'times',
      'memory.save': 'Save memory settings',
      'memory.compact': 'Organize now',
      'memory.compacting': 'Organizing...',
      'memory.compactNotice': 'Organized',
      'memory.compactBefore': 'Before: events {events} · notes {notes} · facts {facts} · entities {entities} · relations {relations}',
      'memory.compactAfter': 'After: events {events} · notes {notes} · facts {facts} · entities {entities} · relations {relations}',
      'memory.delete': 'Delete',
      'memory.deleteFactConfirm': 'Delete this fact card?',
      'memory.deleteEntityConfirm': 'Delete this entity? Relations touching it will be removed too.',
      'memory.deleted': 'Deleted',
      'memory.deleteUnsupported': 'This record has no id; older Hosts cannot delete it',
      'memory.unsaved': 'Memory settings changed - remember to save',
      'notice.memorySettingsSaved': 'Memory settings saved',
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

    /* ---------------- 输入框光轨样式（运行时与面板共用同一份字符串） ----------------
       光轨组件挂在输入框卡片上、面板可能根本没打开，所以这份 CSS 会由 apply() 单独
       注入一个常驻 <style>；同时它也被拼进下面的面板 CSS，避免两份实现漂移。 */
    const TRAIL_CSS = `
.aura-trail-svg{position:absolute;display:block;pointer-events:none;contain:strict;overflow:hidden;margin:0;padding:0;border:0}
.aura-trail-anchor{position:absolute;inset:0 0 auto;height:0;pointer-events:none}
.aura-trail-layer{fill:none;stroke:var(--aura-trail-color,#679EFE);stroke-width:2.5;stroke-linecap:butt;animation-name:aura-trail-run-0;animation-duration:3.6s;animation-timing-function:linear;animation-iteration-count:infinite}
.aura-trail-layer[data-layer="0"]{opacity:1;stroke-linecap:round}
.aura-trail-layer[data-layer="1"]{animation-name:aura-trail-run-1;opacity:.87}
.aura-trail-layer[data-layer="2"]{animation-name:aura-trail-run-2;opacity:.74}
.aura-trail-layer[data-layer="3"]{animation-name:aura-trail-run-3;opacity:.61}
.aura-trail-layer[data-layer="4"]{animation-name:aura-trail-run-4;opacity:.47}
.aura-trail-layer[data-layer="5"]{animation-name:aura-trail-run-5;opacity:.34}
.aura-trail-layer[data-layer="6"]{animation-name:aura-trail-run-6;opacity:.21}
.aura-trail-layer[data-layer="7"]{animation-name:aura-trail-run-7;opacity:.08}
@keyframes aura-trail-run-0{from{stroke-dashoffset:0px}to{stroke-dashoffset:-100px}}
@keyframes aura-trail-run-1{from{stroke-dashoffset:2.2px}to{stroke-dashoffset:-97.8px}}
@keyframes aura-trail-run-2{from{stroke-dashoffset:4.4px}to{stroke-dashoffset:-95.6px}}
@keyframes aura-trail-run-3{from{stroke-dashoffset:6.6px}to{stroke-dashoffset:-93.4px}}
@keyframes aura-trail-run-4{from{stroke-dashoffset:8.8px}to{stroke-dashoffset:-91.2px}}
@keyframes aura-trail-run-5{from{stroke-dashoffset:11px}to{stroke-dashoffset:-89px}}
@keyframes aura-trail-run-6{from{stroke-dashoffset:13.2px}to{stroke-dashoffset:-86.8px}}
@keyframes aura-trail-run-7{from{stroke-dashoffset:15.4px}to{stroke-dashoffset:-84.6px}}
[data-aura-trail-speed="slow"] .aura-trail-layer{animation-duration:4.8s}
[data-aura-trail-speed="fast"] .aura-trail-layer{animation-duration:2.4s}
[data-aura-trail-width="thin"] .aura-trail-layer{stroke-width:1.5}
[data-aura-trail-width="thick"] .aura-trail-layer{stroke-width:4}
[data-aura-trail="off"] .aura-trail-svg{display:none}
[data-composer-card][data-aura-trail="on"]{--dsw-elevation-stroke-color:transparent}
`
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
.aura-emotion-baseline{display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.aura-emotion-baseline-label{flex:none;font-variant-numeric:tabular-nums}
.aura-emotion-baseline-track{position:relative;flex:1;min-width:20px;height:2px;border-radius:1px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.aura-emotion-baseline-fill{height:100%;border-radius:1px;background:var(--dsw-alias-label-tertiary);opacity:.5}
.aura-emotion-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 0 10px}
.aura-emotion-badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:11px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}
.aura-emotion-badge-up{color:var(--dsw-alias-state-success-primary)}
.aura-emotion-badge-down{color:var(--dsw-alias-state-error-primary)}
.aura-emotion-badge-flat,.aura-emotion-badge-quiet{color:var(--dsw-alias-label-tertiary)}
.aura-emotion-chart{padding:6px 0 2px;border-top:.5px solid var(--dsw-alias-border-l3);margin-top:2px}
.aura-emotion-chart svg{display:block;width:100%;height:92px;overflow:visible}
.aura-emotion-chart-empty{border-top:0;padding-top:10px}
.aura-emotion-axis{stroke:var(--dsw-alias-border-l3);stroke-width:1;vector-effect:non-scaling-stroke}
.aura-emotion-line{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.aura-emotion-line-valence{stroke:var(--dsw-alias-state-business-primary)}
.aura-emotion-line-affection{stroke:var(--dsw-alias-state-success-primary)}
.aura-emotion-legend{display:flex;flex-wrap:wrap;gap:14px;padding-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.aura-emotion-swatch{display:inline-block;width:10px;height:2px;margin-right:5px;vertical-align:middle}
.aura-emotion-swatch-valence{background:var(--dsw-alias-state-business-primary)}
.aura-emotion-swatch-affection{background:var(--dsw-alias-state-success-primary)}
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
.aura-soul-editor{width:100%;min-height:220px;resize:vertical;font-family:inherit;line-height:1.7}
.aura-soul-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
.aura-soul-card{padding:10px 12px;border-radius:10px;background:var(--dsw-specific-sidebar-fill);min-width:0}
.aura-soul-card-title{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.aura-soul-card-body{white-space:pre-wrap;font-size:13px;line-height:1.7;word-break:break-word}
.aura-soul-preview{margin:0;padding:12px 14px;border-radius:10px;background:var(--dsw-specific-sidebar-fill);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
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
.aura-memory-fact-list,.aura-memory-entity-list{display:flex;flex-direction:column;gap:6px}
.aura-memory-fact{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3)}
.aura-memory-fact-text{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.aura-memory-fact-meta{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.aura-memory-entity{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.aura-memory-entity-type{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.aura-memory-entity-aliases{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.aura-memory-delete{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:0 2px;cursor:pointer}
.aura-memory-delete:hover{color:var(--dsw-alias-state-error-primary)}
.aura-memory-delete:disabled{opacity:.45;cursor:default}
.aura-memory-compact-stats{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.aura-memory-relation-list{display:flex;flex-direction:column;gap:6px}
.aura-memory-relation{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.aura-memory-relation-type{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.aura-memory-relation-weight{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
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
.aura-field-select{width:auto;min-width:120px;padding:0 10px;cursor:pointer}
.aura-meme-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}
.aura-meme-search{flex:1 1 180px;width:auto;min-width:140px}
.aura-meme-select{flex:0 0 auto;width:auto;min-width:104px;padding:0 8px;cursor:pointer}
.aura-meme-upload{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}
.aura-meme-upload .qqn-input{flex:1 1 140px;width:auto;min-width:120px}
.aura-meme-packs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 12px}
.aura-meme-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;margin-right:2px}
.aura-meme-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.aura-meme-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.aura-meme-chip:disabled{cursor:default;opacity:.6}
.aura-meme-chip-on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aura-meme-chip-count{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}
.aura-meme-status{min-height:20px;margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.aura-meme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;padding:2px 0 4px}
.aura-meme-card{display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background .15s,border-color .15s}
.aura-meme-card:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.aura-meme-thumb{display:block;width:100%;height:100px;object-fit:contain;border-radius:8px;background:var(--dsw-specific-sidebar-fill)}
.aura-meme-caption{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aura-meme-tag{display:inline-flex;align-items:center;width:fit-content;height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.aura-meme-editor-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.45)}
.aura-meme-editor{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(420px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 18px 60px rgba(0,0,0,.35)}
.aura-meme-editor-img{display:block;width:100%;max-height:200px;object-fit:contain;border-radius:10px;background:var(--dsw-specific-sidebar-fill)}
.aura-meme-field{display:flex;flex-direction:column;gap:4px}
.aura-meme-field>span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.aura-meme-field .qqn-input{width:100%}
.aura-meme-editor-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}
.aura-persona-textarea{box-sizing:border-box;width:100%;height:auto;min-height:64px;padding:8px 12px;line-height:20px;resize:vertical}
.aura-persona-inline{display:flex;align-items:center;justify-content:flex-end;gap:8px;width:100%}
.aura-persona-color{width:44px;height:32px;padding:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer}
.aura-persona-presets{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 0}
.aura-persona-presets .qqn-input{flex:1 1 120px;width:auto;min-width:120px}
.aura-persona-history{display:flex;flex-direction:column;padding:6px 0}
.aura-persona-history-row{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.aura-persona-history-row:last-child{border-bottom:0}
.aura-persona-history-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.aura-persona-history-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.aura-persona-history-changes{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.aura-persona-history-row .qqn-button{flex:none;height:28px;padding:0 10px;border-radius:14px;font-size:12px}
.aura-growth-list{display:flex;flex-direction:column;padding:6px 0}
.aura-growth-row{padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.aura-growth-row:last-child{border-bottom:0}
.aura-growth-head{display:flex;align-items:center;gap:6px;min-width:0}
.aura-growth-badge{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px}
.aura-growth-pin{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:20px}
.aura-growth-time{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.aura-growth-text{margin-top:4px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.aura-persona-prompt{max-height:320px;margin:0;padding:12px 14px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:640px){
.aura-meme-grid{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}
.aura-meme-thumb{height:84px}
.aura-meme-editor-backdrop{padding:12px}
.aura-meme-editor{max-height:calc(100vh - 24px)}
.aura-persona-history-row{flex-direction:column}
.aura-persona-history-row .qqn-button{align-self:flex-end}
}
${TRAIL_CSS}
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

    /** growth.kind 的中文徽标映射（Host 只读快照；本轮不提供编辑）。 */
    const GROWTH_KIND_LABELS = {
      trait: '性格',
      interest: '兴趣',
      habit: '习惯',
      bond: '默契',
      self: '自省',
    }

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

    /** 情绪历史（Host 的 soul.emotion.history，旧→新）→ 折线用的行。 */
    function emotionHistoryRows(value) {
      return asArray(value)
        .map(row => {
          const source = asObject(row)
          return {
            at: timeOf(source.at),
            valence: Number(source.valence),
            affection: Number(source.affection),
            label: typeof source.label === 'string' ? source.label : '',
          }
        })
        .filter(row => row.at > 0 && Number.isFinite(row.valence) && Number.isFinite(row.affection))
    }

    /** 趋势徽标数据：宿主没给 trend（旧 Host）时返回 null。 */
    function emotionTrendInfo(value) {
      if (!value || typeof value !== 'object') return null
      const source = asObject(value)
      const direction = source.direction === 'up' || source.direction === 'down' ? source.direction : 'flat'
      const volatility = Number(source.volatility)
      const delta = Number(source.delta)
      const hours = Number(source.windowHours)
      return {
        direction,
        delta: Number.isFinite(delta) ? delta : 0,
        volatility: Number.isFinite(volatility) ? Math.max(0, Math.min(1, volatility)) : 0,
        hours: Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 6,
      }
    }

    /**
     * 双色折线（愉悦 / 亲近），无第三方库：
     * viewBox 0 0 100 40 + preserveAspectRatio=none，宽高跟着容器走；
     * vector-effect 保持线宽不随拉伸变形。少于 2 条时给占位文案。
     */
    function emotionChart(rows, labels) {
      const data = Array.isArray(rows) ? rows : []
      const text = asObject(labels)
      if (data.length < 2) {
        return h('div', { className: 'aura-emotion-chart aura-emotion-chart-empty qqn-mood-empty' }, text.empty || '')
      }
      const points = (key, signed) => data.map((row, index) => {
        const raw = Number(row[key])
        const safe = Number.isFinite(raw) ? raw : 0
        const value = signed ? Math.max(-1, Math.min(1, safe)) / 2 + 0.5 : Math.max(0, Math.min(1, safe))
        const x = Math.round((index / (data.length - 1)) * 10000) / 100
        const y = Math.round((1 - value) * 4000) / 100
        return x + ',' + y
      }).join(' ')
      return h('div', { className: 'aura-emotion-chart' },
        h('svg', {
          viewBox: '0 0 100 40',
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': text.title || 'emotion',
        },
          h('line', { x1: 0, y1: 20, x2: 100, y2: 20, className: 'aura-emotion-axis' }),
          h('polyline', {
            className: 'aura-emotion-line aura-emotion-line-valence',
            points: points('valence', true),
            vectorEffect: 'non-scaling-stroke',
          }),
          h('polyline', {
            className: 'aura-emotion-line aura-emotion-line-affection',
            points: points('affection', false),
            vectorEffect: 'non-scaling-stroke',
          }),
        ),
        h('div', { className: 'aura-emotion-legend' },
          h('span', null, h('span', { className: 'aura-emotion-swatch aura-emotion-swatch-valence' }), text.valence || ''),
          h('span', null, h('span', { className: 'aura-emotion-swatch aura-emotion-swatch-affection' }), text.affection || ''),
        ),
      )
    }

    /** 实际注入预算：内容写长了自动抬到够用（最多 4000），避免“写了却被截断”。 */
    function effectiveSoulBudget(content, configured) {
      const length = Array.from(String(content || '')).length
      return clampInt(Math.max(clampInt(configured, 200, 4000, 1020), length + 600), 200, 4000)
    }

    /** 把自由灵魂内容按 Markdown 标题解析成卡片；没有标题就整段一张。 */
    function parseSoulSections(text) {
      const source = String(text || '')
      const lines = source.split(/\r?\n/)
      const sections = []
      let current = null
      for (const line of lines) {
        const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
        if (match) {
          current = { title: match[1].trim(), body: [] }
          sections.push(current)
          continue
        }
        if (!current) {
          current = { title: '全部', body: [] }
          sections.push(current)
        }
        current.body.push(line)
      }
      return sections
        .map(section => ({ title: section.title, body: section.body.join('\n').trim() }))
        .filter(section => section.title || section.body)
    }

    function buildSoulForm(config) {
      const cfg = asObject(config)
      const name = typeof cfg.soulName === 'string' ? cfg.soulName.trim().slice(0, 20) : ''
      return {
        soulName: name || 'Aura',
        soulUserNickname: typeof cfg.soulUserNickname === 'string' ? cfg.soulUserNickname.trim().slice(0, 20) : '',
        soulEnabled: cfg.soulEnabled !== false,
        soulPromptBudget: clampInt(cfg.soulPromptBudget, 200, 4000, 1020),
        soulBio: typeof cfg.soulBio === 'string' ? cfg.soulBio.slice(0, 500) : '',
        soulContent: typeof cfg.soulContent === 'string' ? cfg.soulContent.slice(0, 4000) : '',
        soulGrowthReflection: cfg.soulGrowthReflection !== false,
        soulInterests: typeof cfg.soulInterests === 'string' ? cfg.soulInterests.slice(0, 200) : '',
        soulStrengths: typeof cfg.soulStrengths === 'string' ? cfg.soulStrengths.slice(0, 200) : '',
        soulRelationGuidance: typeof cfg.soulRelationGuidance === 'string' ? cfg.soulRelationGuidance.slice(0, 500) : '',
      }
    }

    function buildEmotionForm(config) {
      const cfg = asObject(config)
      return {
        expressionStyle: styleOf(cfg.expressionStyle),
        emotionScope: cfg.emotionScope === 'all' ? 'all' : 'qq',
        emotionDecayValenceHours: clampInt(cfg.emotionDecayValenceHours, 1, 72, 3),
        emotionDecayArousalMinutes: clampInt(cfg.emotionDecayArousalMinutes, 5, 1440, 45),
        emotionDecayEnergyHours: clampInt(cfg.emotionDecayEnergyHours, 1, 72, 6),
        emotionRecheckEvery: clampInt(cfg.emotionRecheckEvery, 0, 100, 8),
        emotionGuardOnNegative: cfg.emotionGuardOnNegative !== false,
      }
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

    function buildMemoryForm(config) {
      const cfg = asObject(config)
      return {
        memoryEnabled: cfg.memoryEnabled !== false,
        memoryAutoCompact: cfg.memoryAutoCompact !== false,
        memoryMaxEvents: clampInt(cfg.memoryMaxEvents, 5, 40, 40),
        memoryMaxNotes: clampInt(cfg.memoryMaxNotes, 5, 200, 20),
        memoryRecallLimit: clampInt(cfg.memoryRecallLimit, 1, 3, 3),
        memoryReflectionEvery: clampInt(cfg.memoryReflectionEvery, 1, 50, 3),
        memoryImmediate: cfg.memoryImmediate !== false,
        memorySessionDigest: cfg.memorySessionDigest !== false,
        memoryDigestIdleMinutes: clampInt(cfg.memoryDigestIdleMinutes, 60, 1440, 360),
        memoryDigestDailyCap: clampInt(cfg.memoryDigestDailyCap, 1, 5, 2),
      }
    }

    /** compact 接口回显的 counts → 文案占位。 */
    function memoryCountParams(counts) {
      const source = asObject(counts)
      return {
        events: Number(source.events) || 0,
        notes: Number(source.notes) || 0,
        facts: Number(source.facts) || 0,
        entities: Number(source.entities) || 0,
        relations: Number(source.relations) || 0,
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

    /* ---------------- 表情包 / 人设：通用小工具 ---------------- */
    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function memeTagLabel(tag) {
      const key = String(tag || '')
      return MEME_TAG_LABELS[key] || key
    }

    /** 图片地址：优先 Host 回显的 url，否则按 /dsh-aura/memes/<pack>/<relPath> 拼。 */
    function memeSrc(row) {
      const source = asObject(row)
      if (typeof source.url === 'string' && source.url) return source.url
      const pack = String(source.pack || '')
      const relPath = String(source.relPath || '')
      if (!pack || !relPath) return ''
      const rel = relPath.split('/').map(segment => encodeURIComponent(segment)).join('/')
      return MEME_BASE + '/' + encodeURIComponent(pack) + '/' + rel
    }

    /** 同源 JSON 请求；Host 的 {ok:false, error} 统一抛成 Error。 */
    async function fetchJson(url, body) {
      const response = await fetch(url, body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) {
        const detail = value.error || (value.errors && Object.values(value.errors)[0]) || ('HTTP ' + response.status)
        throw new Error(String(detail))
      }
      return value
    }

    /** 事实/实体卡：/state 只带 events/notes/topics，这两块单独拉只读接口。 */
    async function fetchMemoryCards() {
      try {
        const value = await fetchJson(MEMORY_API + '/state?limit=50')
        return {
          facts: Array.isArray(value?.facts) ? value.facts : [],
          entities: Array.isArray(value?.entities) ? value.entities : [],
          relations: Array.isArray(value?.relations) ? value.relations : [],
        }
      } catch {
        return null
      }
    }

    /** 把 memory 接口的 facts/entities 并进 /state 的 soul.memory；旧 Host 缺失时静默跳过。 */
    function mergeMemoryCards(value, cards) {
      if (!cards || !value || typeof value !== 'object') return value
      const soul = asObject(value.soul)
      const hasCards = cards.facts.length > 0 || cards.entities.length > 0 || cards.relations.length > 0
      if (Object.keys(soul).length === 0 && !hasCards) return value
      const memory = asObject(soul.memory)
      if ((!Array.isArray(memory.facts) || memory.facts.length === 0) && cards.facts.length > 0) {
        memory.facts = cards.facts
      } else if (!Array.isArray(memory.facts)) {
        memory.facts = []
      }
      if ((!Array.isArray(memory.entities) || memory.entities.length === 0) && cards.entities.length > 0) {
        memory.entities = cards.entities
      } else if (!Array.isArray(memory.entities)) {
        memory.entities = []
      }
      if ((!Array.isArray(memory.relations) || memory.relations.length === 0) && cards.relations.length > 0) {
        memory.relations = cards.relations
      } else if (!Array.isArray(memory.relations)) {
        memory.relations = []
      }
      soul.memory = memory
      value.soul = soul
      return value
    }

    /** 本地时区的 YYYY-MM-DD，和日记 API 的 date 对齐。 */
    function diaryDateKey(ms) {
      const date = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now())
      const pad = value => String(value).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    function clipText(value, max) {
      const text = String(value === undefined || value === null ? '' : value)
      if (text.length <= max) return text
      return text.slice(0, max) + '…'
    }

    function diaryMoodLabel(entry) {
      const mood = asObject(asObject(entry).mood)
      return typeof mood.label === 'string' ? mood.label : ''
    }

    /** highlights 正常是字符串数组；坏数据也接受 {text} 之类的对象。 */
    function diaryHighlights(value) {
      return asArray(value)
        .map(item => (typeof item === 'string' ? item.trim() : rowText(item, 'text', 'summary', 'note', 'label')))
        .filter(Boolean)
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        if (!file || typeof FileReader !== 'function') {
          reject(new Error('当前环境不支持读取文件'))
          return
        }
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
    }

    /** 统一的下拉框写法（React.createElement 风格）。 */
    function selectField(options, value, onChange, label) {
      return h('select', {
        className: 'qqn-input aura-field-select',
        value,
        'aria-label': label,
        onChange: event => onChange(event.target.value),
      }, asArray(options).map(option => {
        const pair = Array.isArray(option) ? option : [option, option]
        return h('option', { key: String(pair[0]), value: pair[0] }, pair[1])
      }))
    }

    function memeTagOptions(tags, extra) {
      const values = []
      for (const item of [...asArray(tags), ...asArray(extra)]) {
        const text = String(item || '').trim()
        if (text && !values.includes(text)) values.push(text)
      }
      if (values.length === 0) values.push('daily')
      return values
    }

    /* ---------------- 人设：表单与展示 ---------------- */
    function personaText(value, limit) {
      return typeof value === 'string' ? value.slice(0, limit) : ''
    }

    function personaOption(value, options, fallback) {
      const text = String(value || '')
      return options.some(option => option[0] === text) ? text : fallback
    }

    function personaColorOf(value) {
      const text = String(value || '').trim()
      return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : PERSONA_TRAIL_COLOR_DEFAULT
    }

    /**
     * 人设落盘成功后通知订阅者（输入框光轨等）立即刷新，不必等下一轮 15s 轮询。
     * 用 window 事件而不是共享 store：光轨常驻在 composer 里，人设页可能从未打开过。
     */
    function notifyPersonaSaved() {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
      if (typeof CustomEvent !== 'function') return
      try {
        window.dispatchEvent(new CustomEvent(PERSONA_SAVED_EVENT))
      } catch (error) {
        // 派发失败不影响保存结果
        console.warn('[dsh-aura] 人设已保存事件派发失败：', error)
      }
    }

    function buildPersonaForm(config) {
      const cfg = asObject(config)
      return {
        occupation: personaText(cfg.occupation, 50),
        bio: personaText(cfg.bio, 500),
        style: personaOption(cfg.style, PERSONA_STYLES, 'professional'),
        headingLists: personaOption(cfg.headingLists, PERSONA_TRAITS, 'default'),
        emoji: personaOption(cfg.emoji, PERSONA_TRAITS, 'default'),
        tables: personaOption(cfg.tables, PERSONA_TRAITS, 'default'),
        replyLength: personaOption(cfg.replyLength, PERSONA_REPLY_LENGTHS, 'normal'),
        language: personaOption(cfg.language, PERSONA_LANGUAGES, 'zh'),
        customInstructions: personaText(cfg.customInstructions, 2000),
        trailEnabled: cfg.trailEnabled !== false,
        trailColor: personaColorOf(cfg.trailColor),
        trailSpeed: personaOption(cfg.trailSpeed, PERSONA_TRAIL_SPEEDS, 'slow'),
        trailWidth: personaOption(cfg.trailWidth, PERSONA_TRAIL_WIDTHS, 'thin'),
      }
    }

    /** 预设列表：优先 presetList，退回 presets 对象。 */
    function buildPresetList(snapshot) {
      const data = asObject(snapshot)
      if (asArray(data.presetList).length > 0) {
        return data.presetList.map(item => {
          const row = asObject(item)
          const id = String(row.id || row.name || '')
          return { id, name: String(row.name || row.id || ''), builtin: row.builtin === true }
        }).filter(item => item.id)
      }
      if (Array.isArray(data.presets)) {
        return data.presets.map(item => {
          const row = asObject(item)
          const id = String(row.id || row.name || '')
          return { id, name: String(row.name || row.id || ''), builtin: row.builtin === true }
        }).filter(item => item.id)
      }
      const presets = asObject(data.presets)
      return Object.keys(presets).map(id => ({
        id,
        name: id,
        builtin: asObject(presets[id]).builtin === true,
      }))
    }

    function personaValueText(value) {
      if (Array.isArray(value)) return String(value.length) + ' 项'
      if (value && typeof value === 'object') return '…'
      if (typeof value === 'boolean') return value ? '开' : '关'
      if (value === null || value === undefined || value === '') return '空'
      const text = String(value)
      return text.length > 16 ? text.slice(0, 16) + '…' : text
    }

    function personaChangesText(changes) {
      const source = asObject(changes)
      const fields = Object.keys(source)
      if (fields.length === 0) return '无字段变化'
      const parts = fields.slice(0, 3).map(key => {
        const item = asObject(source[key])
        return (PERSONA_FIELD_LABELS[key] || key) + '：' + personaValueText(item.from) + ' → ' + personaValueText(item.to)
      })
      if (fields.length > 3) parts.push('等 ' + fields.length + ' 项')
      return parts.join('；')
    }

    function personaSourceLabel(source) {
      const key = String(source || '')
      return PERSONA_SOURCE_LABELS[key] || key || '未知'
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
      const [soulPreview, setSoulPreview] = React.useState({ text: '', chars: 0, budget: 0, error: '' })
      const [soulBaseline, setSoulBaseline] = React.useState(() => buildSoulForm({}))
      const [emotionForm, setEmotionForm] = React.useState(() => buildEmotionForm({}))
      const [emotionBaseline, setEmotionBaseline] = React.useState(() => buildEmotionForm({}))
      const [speakForm, setSpeakForm] = React.useState(() => buildSpeakForm({}))
      const [speakBaseline, setSpeakBaseline] = React.useState(() => buildSpeakForm({}))
      const [memoryForm, setMemoryForm] = React.useState(() => buildMemoryForm({}))
      const [memoryBaseline, setMemoryBaseline] = React.useState(() => buildMemoryForm({}))
      const [memoryCompactResult, setMemoryCompactResult] = React.useState(null)
      const [memoryDigestResult, setMemoryDigestResult] = React.useState(null)
      const [blocks, setBlocks] = React.useState({})
      const [resetArmed, setResetArmed] = React.useState(false)
      const [timelineOpen, setTimelineOpen] = React.useState(false)
      const [memeRows, setMemeRows] = React.useState([])
      const [memePacks, setMemePacks] = React.useState([])
      const [memeTags, setMemeTags] = React.useState([])
      const [memeLoading, setMemeLoading] = React.useState(false)
      const [memeLoaded, setMemeLoaded] = React.useState(false)
      const [memeError, setMemeError] = React.useState('')
      const [memeNotice, setMemeNotice] = React.useState('')
      const [memeBusy, setMemeBusy] = React.useState('')
      const [memeQuery, setMemeQuery] = React.useState('')
      const [memeTag, setMemeTag] = React.useState('')
      const [memeSendMode, setMemeSendMode] = React.useState('auto')
      const [memeUploadName, setMemeUploadName] = React.useState('')
      const [memeUploadTag, setMemeUploadTag] = React.useState('daily')
      const [memeEdit, setMemeEdit] = React.useState(null)
      const [persona, setPersona] = React.useState(null)
      const [personaLoading, setPersonaLoading] = React.useState(false)
      const [personaError, setPersonaError] = React.useState('')
      const [personaNotice, setPersonaNotice] = React.useState('')
      const [personaBusy, setPersonaBusy] = React.useState('')
      const [personaForm, setPersonaForm] = React.useState(() => buildPersonaForm({}))
      const [personaBaseline, setPersonaBaseline] = React.useState(() => buildPersonaForm({}))
      const [personaPresetId, setPersonaPresetId] = React.useState('')
      const [personaPresetName, setPersonaPresetName] = React.useState('')
      const [personaPreviewOpen, setPersonaPreviewOpen] = React.useState(false)
      const [personaPreview, setPersonaPreview] = React.useState('')
      const [diaryEntries, setDiaryEntries] = React.useState([])
      const [diaryLoading, setDiaryLoading] = React.useState(false)
      const [diaryLoaded, setDiaryLoaded] = React.useState(false)
      const [diaryError, setDiaryError] = React.useState('')
      const [diaryNotice, setDiaryNotice] = React.useState('')
      const [diaryBusy, setDiaryBusy] = React.useState('')
      const [diaryOpenDate, setDiaryOpenDate] = React.useState('')
      const [diaryComposeOpen, setDiaryComposeOpen] = React.useState(false)
      const [diaryDraft, setDiaryDraft] = React.useState('')
      const [diaryToday, setDiaryToday] = React.useState(null)
      const [diaryTodayChecked, setDiaryTodayChecked] = React.useState(false)

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
      const memoryRef = React.useRef(memoryForm)
      const memoryBaselineRef = React.useRef(memoryBaseline)
      const blocksRef = React.useRef(blocks)
      const blockTimers = React.useRef({})
      const resetTimer = React.useRef(null)
      const memeTimer = React.useRef(null)
      const personaTimer = React.useRef(null)
      const memeFileRef = React.useRef(null)
      const memeImportRef = React.useRef(null)
      const personaRef = React.useRef(personaForm)
      const personaBaselineRef = React.useRef(personaBaseline)
      const diaryTimer = React.useRef(null)
      const diaryLoadingRef = React.useRef(false)

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
        memoryRef.current = memoryForm
      }, [memoryForm])
      React.useEffect(() => {
        memoryBaselineRef.current = memoryBaseline
      }, [memoryBaseline])
      React.useEffect(() => {
        blocksRef.current = blocks
      }, [blocks])
      React.useEffect(() => {
        personaRef.current = personaForm
      }, [personaForm])
      React.useEffect(() => {
        personaBaselineRef.current = personaBaseline
      }, [personaBaseline])

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
          if (memeTimer.current !== null) {
            clearTimeout(memeTimer.current)
            memeTimer.current = null
          }
          if (personaTimer.current !== null) {
            clearTimeout(personaTimer.current)
            personaTimer.current = null
          }
          if (diaryTimer.current !== null) {
            clearTimeout(diaryTimer.current)
            diaryTimer.current = null
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

      const syncMemory = React.useCallback((config, force) => {
        const next = buildMemoryForm(config)
        const untouched = draftKey(memoryRef.current) === draftKey(memoryBaselineRef.current)
        if (!force && !untouched) return
        setMemoryForm(next)
        setMemoryBaseline(next)
      }, [])

      const syncDrafts = React.useCallback((config, force) => {
        syncLook(config, force)
        syncSoul(config, force)
        syncEmotion(config, force)
        syncSpeak(config, force)
        syncMemory(config, force)
      }, [syncLook, syncSoul, syncEmotion, syncSpeak, syncMemory])

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
          const [value, cards] = await Promise.all([api('/state'), fetchMemoryCards()])
          if (!mounted.current) return
          setSnap(mergeMemoryCards(value, cards))
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

      /* ---------------- 表情包 / 人设：加载与操作 ---------------- */
      const flashMeme = React.useCallback(text => {
        setMemeNotice(text)
        if (memeTimer.current !== null) clearTimeout(memeTimer.current)
        memeTimer.current = setTimeout(() => {
          memeTimer.current = null
          if (mounted.current) setMemeNotice('')
        }, 3000)
      }, [])

      const flashPersona = React.useCallback(text => {
        setPersonaNotice(text)
        if (personaTimer.current !== null) clearTimeout(personaTimer.current)
        personaTimer.current = setTimeout(() => {
          personaTimer.current = null
          if (mounted.current) setPersonaNotice('')
        }, 3000)
      }, [])

      /* ---------------- 日记：列表 / 今天 / 补写 / 手写 / 删除 ---------------- */
      const flashDiary = React.useCallback(text => {
        setDiaryNotice(text)
        if (diaryTimer.current !== null) clearTimeout(diaryTimer.current)
        diaryTimer.current = setTimeout(() => {
          diaryTimer.current = null
          if (mounted.current) setDiaryNotice('')
        }, 3500)
      }, [])

      const loadDiary = React.useCallback(async () => {
        if (diaryLoadingRef.current) return
        diaryLoadingRef.current = true
        setDiaryLoading(true)
        setDiaryError('')
        try {
          const value = await fetchJson(DIARY_API + '?action=list&limit=7')
          if (!mounted.current) return
          const rows = asArray(value.entries).slice()
          rows.sort((left, right) => String(asObject(right).date || '').localeCompare(String(asObject(left).date || '')))
          setDiaryEntries(rows.slice(0, 7))
          setDiaryLoaded(true)
        } catch (error) {
          if (mounted.current) setDiaryError(errorMessage(error))
        } finally {
          diaryLoadingRef.current = false
          if (mounted.current) setDiaryLoading(false)
        }
      }, [])

      const loadDiaryToday = React.useCallback(async () => {
        if (diaryBusy) return
        setDiaryBusy('today')
        setDiaryError('')
        setDiaryNotice('')
        try {
          const date = diaryDateKey()
          const value = await fetchJson(DIARY_API + '?action=get&date=' + encodeURIComponent(date))
          if (!mounted.current) return
          const entry = value && value.entry ? asObject(value.entry) : null
          setDiaryTodayChecked(true)
          setDiaryToday(entry)
          flashDiary(entry ? '今天的日记在下面' : '今天还没有日记，可以补写一篇')
        } catch (error) {
          if (mounted.current) setDiaryError(errorMessage(error))
        } finally {
          if (mounted.current) setDiaryBusy('')
        }
      }, [diaryBusy, flashDiary])

      const generateDiary = React.useCallback(async () => {
        if (diaryBusy) return
        setDiaryBusy('generate')
        setDiaryError('')
        setDiaryNotice('')
        try {
          const date = diaryDateKey()
          const value = await fetchJson(DIARY_API, { action: 'generate', date, mode: 'rule' })
          if (!mounted.current) return
          if (value && value.skipped) {
            flashDiary('没写成：' + (rowText(value, 'reason') || '今天没有可写的素材'))
            return
          }
          if (!value || !value.entry) {
            flashDiary('今天没有可写的素材，先空着')
            return
          }
          setDiaryToday(asObject(value.entry))
          setDiaryTodayChecked(true)
          flashDiary(value.overwritten === true ? '今天的日记已重写' : '补写好了')
          await loadDiary()
        } catch (error) {
          if (mounted.current) setDiaryError(errorMessage(error))
        } finally {
          if (mounted.current) setDiaryBusy('')
        }
      }, [diaryBusy, flashDiary, loadDiary])

      const saveDiaryDraft = React.useCallback(async () => {
        const text = diaryDraft.trim()
        if (!text) {
          setDiaryError('先写点什么再保存')
          return
        }
        if (diaryBusy) return
        setDiaryBusy('save')
        setDiaryError('')
        setDiaryNotice('')
        try {
          const date = diaryDateKey()
          const value = await fetchJson(DIARY_API, { action: 'save', date, summary: text, highlights: [], source: 'user' })
          if (!mounted.current) return
          setDiaryDraft('')
          setDiaryComposeOpen(false)
          if (value && value.entry) {
            setDiaryToday(asObject(value.entry))
            setDiaryTodayChecked(true)
          }
          flashDiary(value && value.overwritten === true ? '已覆盖今天的日记' : '写好了')
          await loadDiary()
        } catch (error) {
          if (mounted.current) setDiaryError(errorMessage(error))
        } finally {
          if (mounted.current) setDiaryBusy('')
        }
      }, [diaryBusy, diaryDraft, flashDiary, loadDiary])

      const removeDiary = React.useCallback(async date => {
        const key = String(date || '')
        if (!key || diaryBusy) return
        let confirmed = true
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          confirmed = window.confirm('删除 ' + key + ' 的日记？')
        }
        if (!confirmed) return
        setDiaryBusy('delete:' + key)
        setDiaryError('')
        setDiaryNotice('')
        try {
          const value = await fetchJson(DIARY_API, { action: 'delete', date: key })
          if (!mounted.current) return
          setDiaryEntries(previous => previous.filter(item => String(asObject(item).date || '') !== key))
          setDiaryOpenDate(previous => (previous === key ? '' : previous))
          setDiaryToday(previous => (previous && String(asObject(previous).date || '') === key ? null : previous))
          flashDiary(value && value.removed === false ? '那天本来就没有日记' : '已删除')
        } catch (error) {
          if (mounted.current) setDiaryError(errorMessage(error))
        } finally {
          if (mounted.current) setDiaryBusy('')
        }
      }, [diaryBusy, flashDiary])

      /** 人设表单同步：默认不覆盖用户正在编辑的草稿。 */
      const syncPersona = React.useCallback((config, force) => {
        const next = buildPersonaForm(config)
        const untouched = draftKey(personaRef.current) === draftKey(personaBaselineRef.current)
        if (!force && !untouched) return
        setPersonaForm(next)
        setPersonaBaseline(next)
      }, [])

      const loadMemes = React.useCallback(async (query, tag) => {
        setMemeLoading(true)
        setMemeError('')
        try {
          const params = new URLSearchParams({ action: 'list' })
          const text = String(query || '').trim()
          if (text) params.set('query', text)
          if (tag) params.set('tag', tag)
          const value = await fetchJson(MEME_API + '?' + params.toString())
          if (!mounted.current) return
          setMemeRows(asArray(value.memes))
          setMemePacks(asArray(value.packs))
          if (asArray(value.tags).length > 0) setMemeTags(value.tags.map(item => String(item)))
          if (typeof value.sendMode === 'string') setMemeSendMode(value.sendMode)
          setMemeLoaded(true)
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeLoading(false)
        }
      }, [])

      const loadPersona = React.useCallback(async force => {
        setPersonaLoading(true)
        try {
          const value = await fetchJson(PERSONA_API + '/state')
          if (!mounted.current) return
          setPersona(value)
          setPersonaError('')
          if (value && value.config) syncPersona(value.config, force === true)
          const list = buildPresetList(value)
          setPersonaPresetId(previous => {
            if (list.some(item => item.id === previous)) return previous
            return String((value && value.activeId) || '') || (list[0] && list[0].id) || ''
          })
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaLoading(false)
        }
      }, [syncPersona])

      React.useEffect(() => {
        if (tab !== 'meme') return undefined
        const timer = setTimeout(() => {
          void loadMemes(memeQuery, memeTag)
        }, 300)
        return () => clearTimeout(timer)
      }, [tab, memeQuery, memeTag, loadMemes])

      /* 首次挂载就和 /api/state 一起拉取人设，之后只在保存/预设操作后主动刷新，避免切 tab 覆盖草稿。 */
      React.useEffect(() => {
        void loadPersona(true)
      }, [loadPersona])

      React.useEffect(() => {
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const value = await fetchJson(API + '/soul/preview', {
                soulName: soulForm.soulName,
                soulUserNickname: soulForm.soulUserNickname,
                soulEnabled: soulForm.soulEnabled === true,
                      soulPromptBudget: effectiveSoulBudget(soulForm.soulContent, soulForm.soulPromptBudget),
                soulBio: soulForm.soulBio,
                soulContent: soulForm.soulContent,
                soulInterests: soulForm.soulInterests,
                soulStrengths: soulForm.soulStrengths,
                soulRelationGuidance: soulForm.soulRelationGuidance,
              })
              if (mounted.current) setSoulPreview({ text: String(value.text || ''), chars: Number(value.chars) || 0, budget: Number(value.budget) || 0, error: '' })
            } catch (error) {
              if (mounted.current) setSoulPreview(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
            }
          })()
        }, 350)
        return () => clearTimeout(timer)
      }, [soulForm.soulName, soulForm.soulUserNickname, soulForm.soulEnabled, soulForm.soulPromptBudget, soulForm.soulBio, soulForm.soulContent, soulForm.soulInterests, soulForm.soulStrengths, soulForm.soulRelationGuidance])

      /* 切到日记 tab 时拉最近 7 篇；不进日记页就不发请求。 */
      React.useEffect(() => {
        if (tab !== 'diary') return undefined
        void loadDiary()
        return undefined
      }, [tab, loadDiary])

      const toggleMemePack = async pack => {
        const packId = String((pack && pack.id) || '')
        if (!packId || memeBusy) return
        setMemeBusy('pack:' + packId)
        setMemeError('')
        setMemeNotice('')
        try {
          await fetchJson(MEME_API, { action: 'setPack', packId, enabled: !(pack.enabled === true) })
          setMemePacks(previous => previous.map(item => item.id === packId
            ? { ...item, enabled: !(item.enabled === true) }
            : item))
          flashMeme('图库开关已更新')
          await loadMemes(memeQuery, memeTag)
          refreshInlineMemeIndex()
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      const changeMemeSendMode = async mode => {
        if (memeBusy) return
        const previous = memeSendMode
        setMemeBusy('sendMode')
        setMemeError('')
        setMemeNotice('')
        try {
          const value = await fetchJson(MEME_API, { action: 'setSendMode', mode })
          if (mounted.current) setMemeSendMode(typeof value.sendMode === 'string' ? value.sendMode : mode)
          flashMeme('发送方式已更新')
        } catch (error) {
          if (mounted.current) {
            setMemeSendMode(previous)
            setMemeError(errorMessage(error))
          }
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      const uploadMemeFile = async event => {
        const input = event && event.target
        const file = input && input.files && input.files[0]
        if (input) input.value = ''
        if (!file || memeBusy) return
        if (file.type && !/^image\//.test(file.type)) {
          setMemeError('请选择图片文件')
          return
        }
        if (file.size > 8 * 1024 * 1024) {
          setMemeError('图片不能超过 8MB')
          return
        }
        setMemeBusy('upload')
        setMemeError('')
        setMemeNotice('')
        try {
          const data = await readFileBase64(file)
          const name = memeUploadName.trim() || file.name
          await fetchJson(MEME_API, {
            action: 'upload',
            data,
            name,
            tag: memeUploadTag || 'daily',
            caption: memeUploadName.trim(),
            keywords: '',
          })
          setMemeUploadName('')
          flashMeme('已上传')
          await loadMemes(memeQuery, memeTag)
          refreshInlineMemeIndex()
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      /** 导出图库 ZIP：页面没有单独的 pack 筛选，优先导出第一个启用的图库。 */
      const exportMemePack = async () => {
        if (memeBusy) return
        const pack = memePacks.find(item => item.enabled === true) || memePacks[0]
        const packId = String((pack && pack.id) || '')
        if (!packId) {
          setMemeError('还没有可导出的图库')
          return
        }
        setMemeBusy('export')
        setMemeError('')
        setMemeNotice('')
        try {
          const response = await fetch(MEME_API + '?action=export&pack=' + encodeURIComponent(packId))
          if (!response.ok) {
            const value = await response.json().catch(() => ({}))
            throw new Error(String(value.error || ('HTTP ' + response.status)))
          }
          const blob = await response.blob()
          const stamp = new Date().toISOString().slice(0, 10)
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'dsh-aura-pack-' + packId + '-' + stamp + '.zip'
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 60000)
          flashMeme('已导出「' + String(pack.name || packId) + '」的 ZIP')
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      /** 导入图库 ZIP：读成 base64 → POST import → 重拉列表。 */
      const importMemeFile = async event => {
        const input = event && event.target
        const file = input && input.files && input.files[0]
        if (input) input.value = ''
        if (!file || memeBusy) return
        if (file.size > 100 * 1024 * 1024) {
          setMemeError('压缩包不能超过 100MB')
          return
        }
        setMemeBusy('import')
        setMemeError('')
        setMemeNotice('')
        try {
          const dataUrl = await readFileBase64(file)
          const comma = dataUrl.indexOf(',')
          const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
          const name = String(file.name || '').replace(/\.zip$/i, '')
          const value = await fetchJson(MEME_API, { action: 'import', data, name })
          if (asArray(value.packs).length > 0) setMemePacks(value.packs)
          flashMeme(String(value.message || '已导入'))
          await loadMemes(memeQuery, memeTag)
          refreshInlineMemeIndex()
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      const openMemeEditor = row => {
        const source = asObject(row)
        setMemeEdit({
          pack: String(source.pack || ''),
          relPath: String(source.relPath || ''),
          src: memeSrc(source),
          caption: String(source.caption || ''),
          tag: String(source.tag || 'daily'),
          keywords: String(source.keywords || ''),
        })
      }

      const saveMemeEdit = async () => {
        if (!memeEdit || memeBusy) return
        setMemeBusy('update')
        setMemeError('')
        setMemeNotice('')
        try {
          await fetchJson(MEME_API, {
            action: 'update',
            pack: memeEdit.pack,
            relPath: memeEdit.relPath,
            tag: memeEdit.tag,
            caption: memeEdit.caption,
            keywords: memeEdit.keywords,
          })
          setMemeEdit(null)
          flashMeme('已保存')
          await loadMemes(memeQuery, memeTag)
          refreshInlineMemeIndex()
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      const deleteMemeEdit = async () => {
        if (!memeEdit || memeBusy) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('删除这张表情包？此操作不可恢复。')) return
        setMemeBusy('delete')
        setMemeError('')
        setMemeNotice('')
        try {
          await fetchJson(MEME_API, {
            action: 'delete',
            pack: memeEdit.pack,
            relPath: memeEdit.relPath,
          })
          setMemeEdit(null)
          flashMeme('已删除')
          await loadMemes(memeQuery, memeTag)
          refreshInlineMemeIndex()
        } catch (error) {
          if (mounted.current) setMemeError(errorMessage(error))
        } finally {
          if (mounted.current) setMemeBusy('')
        }
      }

      /* ---------------- 人设操作 ---------------- */
      /* 昵称只留灵魂层的 soulUserNickname；启用人设跟随灵魂开关。 */
      const personaPayload = () => ({
        enabled: soulForm.soulEnabled === true,
        occupation: personaForm.occupation.trim(),
        bio: personaForm.bio.trim(),
        style: personaForm.style,
        headingLists: personaForm.headingLists,
        emoji: personaForm.emoji,
        tables: personaForm.tables,
        replyLength: personaForm.replyLength,
        language: personaForm.language,
        customInstructions: personaForm.customInstructions.trim(),
        trailEnabled: personaForm.trailEnabled === true,
        trailColor: personaColorOf(personaForm.trailColor),
        trailSpeed: personaForm.trailSpeed,
        trailWidth: personaForm.trailWidth,
      })

      const applyPersonaConfig = config => {
        if (!config) return null
        const next = buildPersonaForm(config)
        setPersonaForm(next)
        setPersonaBaseline(next)
        return config
      }

      const refreshPersonaPreview = async (config, quiet) => {
        if (!quiet) {
          setPersonaBusy('preview')
          setPersonaError('')
        }
        try {
          const value = await fetchJson(PERSONA_API + '/preview', { config: config || personaPayload() })
          if (mounted.current) setPersonaPreview(typeof value.prompt === 'string' ? value.prompt : '')
        } catch (error) {
          if (mounted.current && !quiet) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current && !quiet) setPersonaBusy('')
        }
      }

      const savePersona = async () => {
        if (personaBusy) return
        const payload = personaPayload()
        setPersonaBusy('save')
        setPersonaError('')
        setPersonaNotice('')
        let savedConfig = null
        try {
          const value = await fetchJson(PERSONA_API + '/save', { config: payload })
          notifyPersonaSaved()
          if (!mounted.current) return
          savedConfig = applyPersonaConfig(value && value.config)
          if (value && Array.isArray(value.changed) && value.changed.length === 0) flashPersona('没有需要保存的改动')
          else flashPersona('人设已保存')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
        if (savedConfig && personaPreviewOpen) void refreshPersonaPreview(savedConfig, true)
      }

      const resetPersona = async () => {
        if (personaBusy) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('把人设重置为默认值？自定义指令等字段会清空。')) return
        setPersonaBusy('reset')
        setPersonaError('')
        setPersonaNotice('')
        let resetConfig = null
        try {
          const value = await fetchJson(PERSONA_API + '/reset', {})
          notifyPersonaSaved()
          if (!mounted.current) return
          resetConfig = applyPersonaConfig(value && value.config)
          flashPersona('已重置为默认人设')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
        if (resetConfig && personaPreviewOpen) void refreshPersonaPreview(resetConfig, true)
      }

      const applyPersonaPreset = async () => {
        if (personaBusy || !personaPresetId) return
        setPersonaBusy('apply')
        setPersonaError('')
        setPersonaNotice('')
        let appliedConfig = null
        try {
          const value = await fetchJson(PERSONA_API + '/preset/apply', { id: personaPresetId })
          notifyPersonaSaved()
          if (!mounted.current) return
          appliedConfig = applyPersonaConfig(value && value.config)
          flashPersona('预设已应用')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
        if (appliedConfig && personaPreviewOpen) void refreshPersonaPreview(appliedConfig, true)
      }

      const savePersonaPreset = async () => {
        if (personaBusy) return
        const name = personaPresetName.trim()
        if (!name) {
          setPersonaError('给预设起个名字')
          return
        }
        setPersonaBusy('savePreset')
        setPersonaError('')
        setPersonaNotice('')
        try {
          // /preset/save 拍的是“已保存配置”的快照；草稿有改动时先落盘，避免另存为拿到旧人设。
          if (personaDirty) {
            const saved = await fetchJson(PERSONA_API + '/save', { config: personaPayload() })
            notifyPersonaSaved()
            if (saved && saved.config) applyPersonaConfig(saved.config)
          }
          const value = await fetchJson(PERSONA_API + '/preset/save', { name })
          notifyPersonaSaved()
          if (!mounted.current) return
          if (value && value.saved) setPersonaPresetId(String(value.saved))
          setPersonaPresetName('')
          flashPersona('预设已保存')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
      }

      const deletePersonaPreset = async () => {
        if (personaBusy || !personaPresetId) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('删除预设「' + personaPresetId + '」？')) return
        setPersonaBusy('deletePreset')
        setPersonaError('')
        setPersonaNotice('')
        try {
          await fetchJson(PERSONA_API + '/preset/delete', { id: personaPresetId })
          if (!mounted.current) return
          setPersonaPresetId('')
          flashPersona('预设已删除')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
      }

      const undoPersona = async entry => {
        const index = Number(entry && entry.index)
        if (personaBusy || !Number.isInteger(index)) return
        setPersonaBusy('undo')
        setPersonaError('')
        setPersonaNotice('')
        let undoneConfig = null
        try {
          const value = await fetchJson(PERSONA_API + '/history/undo', { index })
          notifyPersonaSaved()
          if (!mounted.current) return
          undoneConfig = applyPersonaConfig(value && value.config)
          flashPersona('已撤销')
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) setPersonaError(errorMessage(error))
        } finally {
          if (mounted.current) setPersonaBusy('')
        }
        if (undoneConfig && personaPreviewOpen) void refreshPersonaPreview(undoneConfig, true)
      }

      const togglePersonaPreview = () => {
        const next = !personaPreviewOpen
        setPersonaPreviewOpen(next)
        if (next) void refreshPersonaPreview()
      }

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
          const trailValue = await fetchJson(PERSONA_API + '/save', {
            config: {
              trailEnabled: personaForm.trailEnabled === true,
              trailColor: personaForm.trailColor,
              trailSpeed: personaForm.trailSpeed,
              trailWidth: personaForm.trailWidth,
            },
          })
          if (trailValue && trailValue.config) syncPersona(trailValue.config, true)
          notifyPersonaSaved()
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
            else if (key === 'memorySettings') syncMemory(value.config, true)
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

      /**
       * 灵魂 tab 的统一保存：灵魂字段走 /config，表达方式走 persona-api。
       * 两边都成功才对草稿基线并提示成功；任一边失败都保持 dirty，等用户重试。
       */
      const saveSoul = async () => {
        if (blockBusy('soul') || personaBusy) return
        const name = soulForm.soulName.trim().slice(0, 20)
        if (!name) {
          setBlock('soul', { busy: false, notice: '', error: t('error.soulName') })
          return
        }
        const soulPayload = {
          soulName: name,
          soulUserNickname: soulForm.soulUserNickname.trim().slice(0, 20),
          soulEnabled: soulForm.soulEnabled === true,
          soulPromptBudget: effectiveSoulBudget(soulForm.soulContent, soulForm.soulPromptBudget),
          soulBio: String(soulForm.soulBio || '').slice(0, 500),
          soulContent: String(soulForm.soulContent || '').slice(0, 4000),
          soulGrowthReflection: soulForm.soulGrowthReflection !== false,
          soulInterests: String(soulForm.soulInterests || '').slice(0, 200),
          soulStrengths: String(soulForm.soulStrengths || '').slice(0, 200),
          soulRelationGuidance: String(soulForm.soulRelationGuidance || '').slice(0, 500),
        }
        setBlock('soul', { busy: true, error: '', notice: '' })
        setPersonaError('')
        setPersonaNotice('')
        let nextSoul = null
        let nextPersona = null
        try {
          const soulValue = await api('/config', soulPayload)
          if (!mounted.current) return
          nextSoul = (soulValue && soulValue.config) || null
          if (nextSoul && !payloadApplied(nextSoul, soulPayload)) {
            throw new Error(t('notice.configNotApplied'))
          }
          // 表达方式已并入自由灵魂内容；这里只保留光轨外观字段。
          const personaValue = await fetchJson(PERSONA_API + '/save', {
            config: {
              trailEnabled: personaForm.trailEnabled === true,
              trailColor: personaForm.trailColor,
              trailSpeed: personaForm.trailSpeed,
              trailWidth: personaForm.trailWidth,
              enabled: soulForm.soulEnabled === true,
            },
          })
          if (!mounted.current) return
          nextPersona = (personaValue && personaValue.config) || null
          notifyPersonaSaved()
          if (nextSoul) {
            mergeConfig(nextSoul)
            setAppearance(nextSoul)
            syncDrafts(nextSoul, false)
            syncSoul(nextSoul, true)
          }
          if (nextPersona) applyPersonaConfig(nextPersona)
          flashBlock('soul', t('notice.soulSaved'))
          await loadPersona(true)
        } catch (error) {
          if (mounted.current) failBlock('soul', error)
        } finally {
          if (mounted.current) setBlock('soul', { busy: false })
        }
        if (nextPersona && personaPreviewOpen) void refreshPersonaPreview(nextPersona, true)
      }

      const saveEmotion = () => {
        void saveBlock('emotion', {
          expressionStyle: styleOf(emotionForm.expressionStyle),
          emotionScope: emotionForm.emotionScope === 'all' ? 'all' : 'qq',
          emotionDecayValenceHours: clampInt(emotionForm.emotionDecayValenceHours, 1, 72, 3),
          emotionDecayArousalMinutes: clampInt(emotionForm.emotionDecayArousalMinutes, 5, 1440, 45),
          emotionDecayEnergyHours: clampInt(emotionForm.emotionDecayEnergyHours, 1, 72, 6),
          emotionRecheckEvery: clampInt(emotionForm.emotionRecheckEvery, 0, 100, 8),
          emotionGuardOnNegative: emotionForm.emotionGuardOnNegative !== false,
        }, 'notice.emotionSaved')
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

      const saveMemory = () => {
        void saveBlock('memorySettings', {
          memoryEnabled: memoryForm.memoryEnabled === true,
          memoryAutoCompact: memoryForm.memoryAutoCompact === true,
          memoryMaxEvents: clampInt(memoryForm.memoryMaxEvents, 5, 40, 40),
          memoryMaxNotes: clampInt(memoryForm.memoryMaxNotes, 5, 200, 20),
          memoryRecallLimit: clampInt(memoryForm.memoryRecallLimit, 1, 3, 3),
          memoryReflectionEvery: clampInt(memoryForm.memoryReflectionEvery, 1, 50, 3),
          memoryImmediate: memoryForm.memoryImmediate !== false,
          memorySessionDigest: memoryForm.memorySessionDigest !== false,
          memoryDigestIdleMinutes: clampInt(memoryForm.memoryDigestIdleMinutes, 60, 1440, 360),
          memoryDigestDailyCap: clampInt(memoryForm.memoryDigestDailyCap, 1, 5, 2),
        }, 'notice.memorySettingsSaved')
      }

      const compactMemory = async () => {
        if (blockBusy('memoryCompact')) return
        setBlock('memoryCompact', { busy: true, error: '', notice: '' })
        try {
          const value = await fetchJson(MEMORY_API, { action: 'compact' })
          if (!mounted.current) return
          setMemoryCompactResult({ before: asObject(value.before), after: asObject(value.after) })
          flashBlock('memoryCompact', t('memory.compactNotice'))
          void load(false)
        } catch (error) {
          if (mounted.current) failBlock('memoryCompact', error)
        }
      }

      const digestMemory = async () => {
        if (blockBusy('memoryDigest')) return
        setBlock('memoryDigest', { busy: true, error: '', notice: '' })
        try {
          const value = await fetchJson(MEMORY_API, { action: 'digest' })
          if (!mounted.current) return
          setMemoryDigestResult({
            sessionId: String(value && value.sessionId ? value.sessionId : ''),
            note: asObject(value && value.note),
            facts: Array.isArray(value && value.facts) ? value.facts : [],
            window: asObject(value && value.window),
          })
          flashBlock('memoryDigest', t('memory.digestNotice'))
          void load(false)
        } catch (error) {
          if (!mounted.current) return
          const message = errorMessage(error)
          if (message === 'empty' || message === 'no-session') {
            flashBlock('memoryDigest', t(message === 'empty' ? 'memory.digestEmpty' : 'memory.digestNoSession'))
          } else {
            failBlock('memoryDigest', error)
          }
        }
      }

      const deleteMemoryFact = async (fact) => {
        if (blockBusy('memory') || !fact.id) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('memory.deleteFactConfirm'))) return
        setBlock('memory', { busy: true, error: '', notice: '' })
        try {
          await fetchJson(MEMORY_API, { action: 'deleteFact', id: fact.id })
          if (!mounted.current) return
          flashBlock('memory', t('memory.deleted'))
          void load(false)
        } catch (error) {
          if (mounted.current) failBlock('memory', error)
        }
      }

      const deleteMemoryEntity = async (entity) => {
        if (blockBusy('memory') || !entity.id) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('memory.deleteEntityConfirm'))) return
        setBlock('memory', { busy: true, error: '', notice: '' })
        try {
          await fetchJson(MEMORY_API, { action: 'deleteEntity', id: entity.id })
          if (!mounted.current) return
          flashBlock('memory', t('memory.deleted'))
          void load(false)
        } catch (error) {
          if (mounted.current) failBlock('memory', error)
        }
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
      /* 基准四维 / 趋势徽标 / 折线历史：旧 Host 缺字段时整块降级，不报错。 */
      const emotionBaselineRaw = asObject(soulEmotion.baseline)
      const hasBaseline = moodKeys.every(key => Number.isFinite(Number(emotionBaselineRaw[key])))
      const baselineValues = hasBaseline
        ? {
            valence: unitValue(emotionBaselineRaw.valence, true),
            arousal: unitValue(emotionBaselineRaw.arousal, false),
            affection: unitValue(emotionBaselineRaw.affection, false),
            energy: unitValue(emotionBaselineRaw.energy, false),
          }
        : null
      const emotionTrend = emotionTrendInfo(soulEmotion.trend)
      const emotionHistory = emotionHistoryRows(soulEmotion.history).slice(-40)
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
      /* ---- 事实卡 / 实体卡（superseded 不显示；面板各最多 12 条） ---- */
      const memoryFacts = asArray(memory.facts)
        .map(row => asObject(row))
        .filter(row => !row.supersededBy && String(row.value || '').trim())
        .map((row, index) => ({
          key: String(row.id || '') || ('fact-' + index + '-' + String(row.lastSeenAt || '')),
          id: String(row.id || ''),
          subject: String(row.subject || '').trim(),
          predicate: String(row.predicate || '').trim(),
          value: String(row.value || '').trim(),
          confidence: Number.isFinite(Number(row.confidence))
            ? Math.max(0, Math.min(1, Number(row.confidence)))
            : 0.6,
          lastSeenAt: timeOf(row.lastSeenAt || row.firstSeenAt),
        }))
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, 12)
      const memoryEntities = asArray(memory.entities)
        .map(row => asObject(row))
        .filter(row => String(row.name || '').trim())
        .map((row, index) => ({
          key: String(row.id || '') || ('entity-' + index + '-' + String(row.lastSeenAt || '')),
          id: String(row.id || ''),
          name: String(row.name || '').trim(),
          type: MEMORY_ENTITY_TYPES.includes(row.type) ? row.type : 'other',
          aliases: asArray(row.aliases)
            .map(alias => String(alias || '').trim())
            .filter(Boolean)
            .slice(0, 8),
          lastSeenAt: timeOf(row.lastSeenAt || row.firstSeenAt),
        }))
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, 12)
      /* ---- 关系（实体图边；面板最多 12 条，weight 高的在前；空状态给提示） ---- */
      const memoryEntitiesById = new Map()
      for (const row of asArray(memory.entities).map(item => asObject(item))) {
        const id = String(row.id || '').trim()
        if (id) memoryEntitiesById.set(id, String(row.name || '').trim())
      }
      const memoryRelations = asArray(memory.relations)
        .map(row => asObject(row))
        .filter(row => String(row.from || '').trim() && String(row.to || '').trim() && row.from !== row.to)
        .map((row, index) => {
          const weight = Number.isFinite(Number(row.weight))
            ? Math.max(0, Math.min(1, Number(row.weight)))
            : 0
          return {
            key: String(row.id || '') || ('relation-' + index + '-' + String(row.lastSeenAt || '')),
            fromName: String(row.fromName || memoryEntitiesById.get(String(row.from)) || row.from).trim(),
            toName: String(row.toName || memoryEntitiesById.get(String(row.to)) || row.to).trim(),
            typeLabel: String(row.type || '').trim() || 'co',
            weight,
            lastSeenAt: timeOf(row.lastSeenAt || row.firstSeenAt),
          }
        })
        .sort((left, right) => (right.weight - left.weight) || (right.lastSeenAt - left.lastSeenAt))
        .slice(0, 12)
      /* ---- 成长：她自己长出来的部分（只读；宿主暂未开放编辑 HTTP） ---- */
      const growthAll = rowsNewest(soulData.growth, 'at')
      const growthTotal = growthAll.length
      const growthRows = growthAll.slice(0, 8).map((row, index) => {
        const source = asObject(row)
        return {
          key: String(source.id || '') || ('growth-' + index + '-' + String(source.at || '')),
          at: timeOf(source.at),
          kind: typeof source.kind === 'string' ? source.kind : '',
          text: rowText(row, 'text', 'note', 'summary'),
          pinned: source.pinned === true,
        }
      }).filter(row => row.text)
      const speakState = asObject(soulData.speak)
      const legacyProactive = asObject(proactive)
      const speakLog = speakLogRows(speakState.log).slice(0, 8)
      const timelineAll = timelineRows(soulData.explainLog)
      const timeline = timelineAll.slice(0, 20)
      const speakLastAt = timeOf(speakState.lastAt) || timeOf(legacyProactive.lastAt) || timeOf(legacyProactive.lastProactiveAt)
      const speakTodayCount = Number(speakState.todayCount) || 0
      const soulDirty = draftKey(soulForm) !== draftKey(soulBaseline)
      const emotionDirty = draftKey(emotionForm) !== draftKey(emotionBaseline)
      const speakDirty = draftKey(speakForm) !== draftKey(speakBaseline)
      const memoryDirty = draftKey(memoryForm) !== draftKey(memoryBaseline)
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
            disabled: lookBusy || !(lookDirty
              || personaForm.trailEnabled !== personaBaseline.trailEnabled
              || personaForm.trailColor !== personaBaseline.trailColor
              || personaForm.trailSpeed !== personaBaseline.trailSpeed
              || personaForm.trailWidth !== personaBaseline.trailWidth),
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
            label: '介绍',
            hint: '关于你的补充说明（≤500 字）',
            control: h('textarea', {
              className: 'qqn-input aura-persona-textarea',
              rows: 3,
              maxLength: 500,
              value: soulForm.soulBio,
              onChange: event => setSoulForm(previous => ({ ...previous, soulBio: event.target.value })),
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
            label: '每日自省',
            hint: '每天最多一次，从最近的记忆里提炼一条成长；写前自动备份',
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: soulForm.soulGrowthReflection !== false,
              onChange: event => setSoulForm(prev => ({ ...prev, soulGrowthReflection: event.target.checked })),
            }),
          }),
          h(Row, {
            label: t('row.soulBudget'),
            hint: '身份段上限 = ' + effectiveSoulBudget(soulForm.soulContent, soulForm.soulPromptBudget) + ' 字（内容超过时会自动抬高，最多 4000）',
            control: h('input', {
              className: 'qqn-input qqn-input-narrow',
              type: 'number',
              min: 200,
              max: 4000,
              step: 10,
              value: soulForm.soulPromptBudget,
              onChange: event => setSoulForm(prev => ({ ...prev, soulPromptBudget: event.target.value })),
            }),
          }),
          soulPresent ? null : h('div', { className: 'qqn-mood-empty' }, t('empty.soulPending')),
        ),
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
              baselineValues
                ? h('div', { className: 'aura-emotion-baseline' },
                    h('span', { className: 'aura-emotion-baseline-label' }, t('emotion.baseline') + ' ' + baselineValues[key].toFixed(2)),
                    h('div', { className: 'aura-emotion-baseline-track' },
                      h('div', { className: 'aura-emotion-baseline-fill', style: { width: (baselineValues[key] * 100) + '%' } }),
                    ),
                  )
                : null,
            )),
          ),
          emotionTrend
            ? h('div', { className: 'aura-emotion-head' },
                h('span', { className: 'aura-emotion-badge aura-emotion-badge-' + emotionTrend.direction }, t('emotion.trend.' + emotionTrend.direction)),
                h('span', { className: 'aura-emotion-badge' }, t('emotion.volatility', { value: emotionTrend.volatility.toFixed(2) })),
                h('span', { className: 'aura-emotion-badge aura-emotion-badge-quiet' }, t('emotion.window', { hours: emotionTrend.hours })),
              )
            : null,
          emotionChart(emotionHistory, {
            empty: t('emotion.chart.empty'),
            title: t('emotion.chart.title'),
            valence: t('emotion.chart.valence'),
            affection: t('emotion.chart.affection'),
          }),
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
          h(Row, {
            label: '作用范围',
            hint: '只在 QQ 陪伴会话，还是所有会话都注入情绪',
            control: h('select', {
              className: 'qqn-input',
              value: emotionForm.emotionScope,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionScope: event.target.value })),
            },
              h('option', { value: 'qq' }, '仅 QQ 会话'),
              h('option', { value: 'all' }, '所有会话'),
            ),
          }),
          h(Row, {
            label: '愉悦半衰期',
            hint: '多少小时回落到一半（1–72）',
            control: h('input', {
              className: 'qqn-input qqn-input-narrow',
              type: 'number', min: 1, max: 72,
              value: emotionForm.emotionDecayValenceHours,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionDecayValenceHours: event.target.value })),
            }),
          }),
          h(Row, {
            label: '唤醒半衰期',
            hint: '多少分钟回落到一半（5–1440）',
            control: h('input', {
              className: 'qqn-input qqn-input-narrow',
              type: 'number', min: 5, max: 1440,
              value: emotionForm.emotionDecayArousalMinutes,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionDecayArousalMinutes: event.target.value })),
            }),
          }),
          h(Row, {
            label: '精力半衰期',
            hint: '多少小时回落到一半（1–72）',
            control: h('input', {
              className: 'qqn-input qqn-input-narrow',
              type: 'number', min: 1, max: 72,
              value: emotionForm.emotionDecayEnergyHours,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionDecayEnergyHours: event.target.value })),
            }),
          }),
          h(Row, {
            label: 'LLM 复核间隔',
            hint: '每多少轮让模型复核一次情绪，0 = 关闭',
            control: h('input', {
              className: 'qqn-input qqn-input-narrow',
              type: 'number', min: 0, max: 100,
              value: emotionForm.emotionRecheckEvery,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionRecheckEvery: event.target.value })),
            }),
          }),
          h(Row, {
            label: '负面情绪守卫',
            hint: '强负面时对高风险工具加确认，不跳过工具',
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: emotionForm.emotionGuardOnNegative !== false,
              onChange: event => setEmotionForm(prev => ({ ...prev, emotionGuardOnNegative: event.target.checked })),
            }),
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
          h('div', { className: 'qqn-memory-block aura-memory-settings' },
            h('div', { className: 'qqn-look-title' }, t('memory.settings')),
            h(Row, {
              label: t('memory.enabled'),
              hint: t('memory.enabled.hint'),
              control: h('input', {
                className: 'qqn-checkbox',
                type: 'checkbox',
                checked: memoryForm.memoryEnabled === true,
                onChange: event => setMemoryForm(prev => ({ ...prev, memoryEnabled: event.target.checked })),
              }),
            }),
            h(Row, {
              label: t('memory.autoCompact'),
              hint: t('memory.autoCompact.hint'),
              control: h('input', {
                className: 'qqn-checkbox',
                type: 'checkbox',
                checked: memoryForm.memoryAutoCompact === true,
                onChange: event => setMemoryForm(prev => ({ ...prev, memoryAutoCompact: event.target.checked })),
              }),
            }),
            h(Row, {
              label: t('memory.immediate'),
              hint: t('memory.immediate.hint'),
              control: h('input', {
                className: 'qqn-checkbox',
                type: 'checkbox',
                checked: memoryForm.memoryImmediate !== false,
                onChange: event => setMemoryForm(prev => ({ ...prev, memoryImmediate: event.target.checked })),
              }),
            }),
            h(Row, {
              label: t('memory.sessionDigest'),
              hint: t('memory.sessionDigest.hint'),
              control: h('input', {
                className: 'qqn-checkbox',
                type: 'checkbox',
                checked: memoryForm.memorySessionDigest !== false,
                onChange: event => setMemoryForm(prev => ({ ...prev, memorySessionDigest: event.target.checked })),
              }),
            }),
            h(Row, {
              label: t('memory.digestIdle'),
              hint: t('memory.digestIdle.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 60,
                  max: 1440,
                  step: 1,
                  value: memoryForm.memoryDigestIdleMinutes,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryDigestIdleMinutes: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitMinutes')),
              ),
            }),
            h(Row, {
              label: t('memory.digestDailyCap'),
              hint: t('memory.digestDailyCap.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 1,
                  max: 5,
                  step: 1,
                  value: memoryForm.memoryDigestDailyCap,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryDigestDailyCap: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitTimes')),
              ),
            }),
            h(Row, {
              label: t('memory.maxEvents'),
              hint: t('memory.maxEvents.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 5,
                  max: 40,
                  step: 1,
                  value: memoryForm.memoryMaxEvents,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryMaxEvents: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitCount')),
              ),
            }),
            h(Row, {
              label: t('memory.maxNotes'),
              hint: t('memory.maxNotes.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 5,
                  max: 200,
                  step: 1,
                  value: memoryForm.memoryMaxNotes,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryMaxNotes: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitCount')),
              ),
            }),
            h(Row, {
              label: t('memory.recallLimit'),
              hint: t('memory.recallLimit.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 1,
                  max: 3,
                  step: 1,
                  value: memoryForm.memoryRecallLimit,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryRecallLimit: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitCount')),
              ),
            }),
            h(Row, {
              label: t('memory.reflectionEvery'),
              hint: t('memory.reflectionEvery.hint'),
              control: h(React.Fragment, null,
                h('input', {
                  className: 'qqn-input qqn-input-narrow',
                  type: 'number',
                  min: 1,
                  max: 50,
                  step: 1,
                  value: memoryForm.memoryReflectionEvery,
                  onChange: event => setMemoryForm(prev => ({
                    ...prev,
                    memoryReflectionEvery: event.target.value === '' ? '' : Number(event.target.value),
                  })),
                }),
                h('span', { className: 'qqn-unit' }, t('memory.unitRounds')),
              ),
            }),
            h('div', { className: 'qqn-actions' },
              h(Button, {
                variant: 'primary',
                disabled: blockBusy('memorySettings') || !memoryDirty,
                onClick: saveMemory,
              }, blockBusy('memorySettings') ? t('busy.save') : t('memory.save')),
              h(Button, {
                disabled: blockBusy('memoryCompact'),
                onClick: () => void compactMemory(),
              }, blockBusy('memoryCompact') ? t('memory.compacting') : t('memory.compact')),
              h(Button, {
                disabled: blockBusy('memoryDigest'),
                onClick: () => void digestMemory(),
              }, blockBusy('memoryDigest') ? t('memory.digesting') : t('memory.digest')),
            ),
            memoryDirty ? h('div', { className: 'qqn-row-hint' }, t('memory.unsaved')) : null,
            blockFeedback('memorySettings'),
            blockFeedback('memoryCompact'),
            blockFeedback('memoryDigest'),
            memoryCompactResult
              ? h('div', { className: 'aura-memory-compact-stats' },
                  h('div', null, t('memory.compactBefore', memoryCountParams(memoryCompactResult.before))),
                  h('div', null, t('memory.compactAfter', memoryCountParams(memoryCompactResult.after))),
                )
              : null,
            memoryDigestResult
              ? h('div', { className: 'aura-memory-compact-stats' },
                  h('div', null, t('memory.digestResult', {
                    notes: memoryDigestResult.note && memoryDigestResult.note.text ? 1 : 0,
                    events: Number(memoryDigestResult.window.events) || 0,
                    facts: memoryDigestResult.facts.length,
                  })),
                  memoryDigestResult.note && memoryDigestResult.note.text
                    ? h('div', null, memoryDigestResult.note.text)
                    : null,
                  Array.isArray(memoryDigestResult.window.topics) && memoryDigestResult.window.topics.length
                    ? h('div', null, t('memory.digestTopics', { topics: memoryDigestResult.window.topics.join('、') }))
                    : null,
                )
              : null,
          ),
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
            h('div', { className: 'qqn-look-title' }, t('memory.facts')),
            memoryFacts.length
              ? h('div', { className: 'aura-memory-fact-list' }, memoryFacts.map(fact => h('div', {
                  key: fact.key,
                  className: 'aura-memory-fact',
                },
                  h('div', { className: 'aura-memory-fact-text' },
                    [fact.subject, fact.predicate, fact.value].filter(Boolean).join(' · ')),
                  h('div', { className: 'aura-memory-fact-meta' },
                    h('span', null, t('memory.factConfidence', { value: Math.round(fact.confidence * 100) })),
                    fact.lastSeenAt ? h('span', null, formatRelative(fact.lastSeenAt, t)) : null,
                    h('button', {
                      type: 'button',
                      className: 'aura-memory-delete',
                      disabled: !fact.id || blockBusy('memory'),
                      title: fact.id ? t('memory.delete') : t('memory.deleteUnsupported'),
                      onClick: () => void deleteMemoryFact(fact),
                    }, t('memory.delete')),
                  ),
                )))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.factsEmpty') : t('empty.soulPending')),
          ),
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('memory.entities')),
            memoryEntities.length
              ? h('div', { className: 'aura-memory-entity-list' }, memoryEntities.map(entity => h('div', {
                  key: entity.key,
                  className: 'aura-memory-entity',
                },
                  h('span', { className: 'qqn-tag' }, entity.name),
                  h('span', { className: 'aura-memory-entity-type' }, t('memory.entity.' + entity.type)),
                  entity.aliases.length
                    ? h('span', { className: 'aura-memory-entity-aliases' }, t('memory.entityAliases', { names: entity.aliases.join('、') }))
                    : null,
                  h('button', {
                    type: 'button',
                    className: 'aura-memory-delete',
                    disabled: !entity.id || blockBusy('memory'),
                    title: entity.id ? t('memory.delete') : t('memory.deleteUnsupported'),
                    onClick: () => void deleteMemoryEntity(entity),
                  }, t('memory.delete')),
                )))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.entitiesEmpty') : t('empty.soulPending')),
          ),
          h('div', { className: 'qqn-memory-block' },
            h('div', { className: 'qqn-look-title' }, t('memory.relations')),
            memoryRelations.length
              ? h('div', { className: 'aura-memory-relation-list' }, memoryRelations.map(relation => h('div', {
                  key: relation.key,
                  className: 'aura-memory-relation',
                },
                  h('span', { className: 'aura-memory-relation-from' }, relation.fromName),
                  h('span', { className: 'aura-memory-relation-type' }, '—' + relation.typeLabel + '→'),
                  h('span', { className: 'aura-memory-relation-to' }, relation.toName),
                  h('span', { className: 'aura-memory-relation-weight' }, t('memory.relationWeight', { value: Math.round(relation.weight * 100) })),
                )))
              : h('div', { className: 'qqn-mood-empty' }, soulPresent ? t('memory.relationsEmpty') : t('empty.soulPending')),
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

      /* ---------------- 表情包 tab ---------------- */
      const memeFiltering = memeQuery.trim() !== '' || memeTag !== ''
      const memeStatusText = memeError
        ? ''
        : (!memeLoaded
            ? '正在读取表情包…'
            : (memeLoading
                ? '正在刷新…'
                : (memeRows.length === 0
                    ? (memeFiltering ? '没有匹配的表情包' : '图库还是空的，先上传一张吧')
                    : '共 ' + memeRows.length + ' 张')))
      const memeTagChoices = memeTagOptions(memeTags, memeTag ? [memeTag] : [])
      const memeUploadTagChoices = memeTagOptions(memeTags, memeUploadTag)
      const memeSection = h(React.Fragment, null,
        h(Section, {
          title: '表情包',
          action: h('span', { className: 'qqn-unit' }, memeRows.length > 0 ? '共 ' + memeRows.length + ' 张' : ''),
        },
          h('div', { className: 'aura-meme-toolbar' },
            h('input', {
              className: 'qqn-input aura-meme-search',
              value: memeQuery,
              placeholder: '搜索描述 / 关键词，回车立即搜',
              spellCheck: false,
              'aria-label': '搜索表情包',
              onChange: event => setMemeQuery(event.target.value),
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void loadMemes(memeQuery, memeTag)
              },
            }),
            h('select', {
              className: 'qqn-input aura-meme-select',
              value: memeTag,
              'aria-label': '按情绪筛选',
              onChange: event => setMemeTag(event.target.value),
            },
              h('option', { value: '' }, '全部情绪'),
              memeTagChoices.map(tag => h('option', { key: tag, value: tag }, memeTagLabel(tag))),
            ),
            h('select', {
              className: 'qqn-input aura-meme-select',
              value: memeSendMode,
              disabled: memeBusy !== '',
              'aria-label': '发送方式',
              onChange: event => {
                const mode = event.target.value
                setMemeSendMode(mode)
                void changeMemeSendMode(mode)
              },
            },
              h('option', { value: 'auto' }, '发送：自动'),
              h('option', { value: 'text' }, '发送：纯文字'),
              h('option', { value: 'image' }, '发送：图片'),
            ),
            h(Button, {
              disabled: memeBusy !== '' || memePacks.length === 0,
              title: '导出第一个启用的图库（ZIP）',
              onClick: () => void exportMemePack(),
            }, memeBusy === 'export' ? '导出中…' : '导出'),
            h(Button, {
              disabled: memeBusy !== '',
              title: '导入图库 ZIP',
              onClick: () => {
                if (memeImportRef.current) memeImportRef.current.click()
              },
            }, memeBusy === 'import' ? '导入中…' : '导入'),
            h('input', {
              type: 'file',
              accept: '.zip,application/zip',
              ref: memeImportRef,
              style: { display: 'none' },
              onChange: event => void importMemeFile(event),
            }),
          ),
          h('div', { className: 'aura-meme-upload' },
            h('input', {
              className: 'qqn-input',
              value: memeUploadName,
              placeholder: '上传名字（可选）',
              maxLength: 40,
              spellCheck: false,
              'aria-label': '上传名字',
              onChange: event => setMemeUploadName(event.target.value),
            }),
            h('select', {
              className: 'qqn-input aura-meme-select',
              value: memeUploadTag,
              'aria-label': '上传情绪分类',
              onChange: event => setMemeUploadTag(event.target.value),
            }, memeUploadTagChoices.map(tag => h('option', { key: tag, value: tag }, memeTagLabel(tag)))),
            h(Button, {
              disabled: memeBusy !== '',
              onClick: () => {
                if (memeFileRef.current) memeFileRef.current.click()
              },
            }, memeBusy === 'upload' ? '上传中…' : '选择图片上传'),
            h('input', {
              type: 'file',
              accept: 'image/*',
              ref: memeFileRef,
              style: { display: 'none' },
              onChange: event => void uploadMemeFile(event),
            }),
          ),
          memePacks.length > 0
            ? h('div', { className: 'aura-meme-packs' },
                h('span', { className: 'aura-meme-label' }, '图库'),
                memePacks.map(pack => h('button', {
                  key: String(pack.id || ''),
                  type: 'button',
                  className: 'aura-meme-chip' + (pack.enabled === true ? ' aura-meme-chip-on' : ''),
                  'aria-pressed': pack.enabled === true,
                  disabled: memeBusy !== '',
                  onClick: () => void toggleMemePack(pack),
                },
                  String(pack.title || pack.name || pack.id || ''),
                  h('span', { className: 'aura-meme-chip-count' }, String(Number(pack.count) || 0)),
                )),
              )
            : null,
          memeError
            ? h('div', { className: 'qqn-feedback qqn-feedback-error', role: 'status', 'aria-live': 'polite' }, memeError)
            : (memeNotice ? h('div', { className: 'qqn-feedback', role: 'status', 'aria-live': 'polite' }, memeNotice) : null),
          h('div', { className: 'aura-meme-status' }, memeStatusText),
          memeRows.length > 0
            ? h('div', { className: 'aura-meme-grid' }, memeRows.map((row, index) => {
                const source = asObject(row)
                const caption = String(source.caption || source.file_name || source.relPath || '')
                return h('button', {
                  key: String(source.pack || '') + '/' + String(source.relPath || index),
                  type: 'button',
                  className: 'aura-meme-card',
                  title: caption,
                  onClick: () => openMemeEditor(source),
                },
                  h('img', {
                    className: 'aura-meme-thumb',
                    src: memeSrc(source),
                    alt: caption || '表情包',
                    loading: 'lazy',
                    decoding: 'async',
                  }),
                  h('span', { className: 'aura-meme-caption' }, caption),
                  source.tag ? h('span', { className: 'aura-meme-tag' }, memeTagLabel(source.tag)) : null,
                )
              }))
            : null,
        ),
        memeEdit
          ? h('div', {
              className: 'aura-meme-editor-backdrop',
              onClick: event => {
                if (event.target === event.currentTarget) setMemeEdit(null)
              },
            },
              h('div', { className: 'aura-meme-editor', role: 'dialog', 'aria-label': '编辑表情包' },
                h('img', { className: 'aura-meme-editor-img', src: memeEdit.src, alt: memeEdit.caption || '表情包' }),
                h('label', { className: 'aura-meme-field' },
                  h('span', null, '描述'),
                  h('input', {
                    className: 'qqn-input',
                    value: memeEdit.caption,
                    maxLength: 200,
                    spellCheck: false,
                    onChange: event => setMemeEdit(previous => ({ ...previous, caption: event.target.value })),
                  }),
                ),
                h('label', { className: 'aura-meme-field' },
                  h('span', null, '情绪'),
                  h('select', {
                    className: 'qqn-input',
                    value: memeEdit.tag,
                    onChange: event => setMemeEdit(previous => ({ ...previous, tag: event.target.value })),
                  }, memeTagOptions(memeTags, memeEdit.tag).map(tag => h('option', { key: tag, value: tag }, memeTagLabel(tag)))),
                ),
                h('label', { className: 'aura-meme-field' },
                  h('span', null, '关键词'),
                  h('input', {
                    className: 'qqn-input',
                    value: memeEdit.keywords,
                    maxLength: 200,
                    spellCheck: false,
                    onChange: event => setMemeEdit(previous => ({ ...previous, keywords: event.target.value })),
                  }),
                ),
                h('div', { className: 'aura-meme-editor-actions' },
                  h(Button, {
                    variant: 'primary',
                    disabled: memeBusy !== '',
                    onClick: () => void saveMemeEdit(),
                  }, memeBusy === 'update' ? '保存中…' : '保存'),
                  h(Button, {
                    variant: 'danger',
                    disabled: memeBusy !== '',
                    onClick: () => void deleteMemeEdit(),
                  }, memeBusy === 'delete' ? '删除中…' : '删除'),
                  h(Button, {
                    variant: 'quiet',
                    disabled: memeBusy !== '',
                    onClick: () => setMemeEdit(null),
                  }, '关闭'),
                ),
              ),
            )
          : null,
      )

      /* ---------------- 人设片段（已并入灵魂 tab） ---------------- */
      const personaData = asObject(persona)
      const personaConfigError = typeof personaData.configError === 'string' ? personaData.configError : ''
      const personaPresetOptions = buildPresetList(personaData)
      const personaHistoryRows = Array.isArray(personaData.history) ? personaData.history : []
      const personaDirty = draftKey(personaForm) !== draftKey(personaBaseline)
      const personaSelectedPreset = personaPresetOptions.find(item => item.id === personaPresetId) || null
      const personaFeedback = personaError
        ? h('div', { className: 'qqn-feedback qqn-feedback-error', role: 'status', 'aria-live': 'polite' }, personaError)
        : (personaNotice ? h('div', { className: 'qqn-feedback', role: 'status', 'aria-live': 'polite' }, personaNotice) : null)
      const growthSection = h(Section, {
        title: '成长',
        action: h('span', null, '共 ' + growthTotal + ' 条'),
      },
        h('div', { className: 'qqn-row-hint', style: { marginTop: 0, marginBottom: 8 } }, '她可以自己长出来的部分；写入会触发一次提示词刷新'),
        growthRows.length > 0
          ? h('div', { className: 'aura-growth-list' }, growthRows.map(row => h('div', { key: row.key, className: 'aura-growth-row' },
              h('div', { className: 'aura-growth-head' },
                h('span', { className: 'aura-growth-badge' }, GROWTH_KIND_LABELS[row.kind] || row.kind || '其他'),
                row.pinned ? h('span', { className: 'aura-growth-pin' }, '置顶') : null,
                h('span', { className: 'aura-growth-time' }, row.at > 0 ? formatRelative(row.at, t) : '—'),
              ),
              h('div', { className: 'aura-growth-text' }, row.text),
            )))
          : h('div', { className: 'qqn-mood-empty' }, '还没长出新东西'),
      )

      const soulContentSection = h(Section, {
        title: '灵魂内容',
        action: h('span', null, Array.from(String(soulForm.soulContent || '')).length + ' / 4000 字'),
      },
        h('div', { className: 'qqn-row-hint', style: { marginTop: 0, marginBottom: 8 } }, '随便写：性格、爱好、在意的事、说话习惯。模板里的 {{...}} 会被下面这些字段替换，也可以直接写死。'),
        h('div', { className: 'qqn-rows', style: { marginBottom: 10 } },
          h(Row, {
            label: '喜欢的事',
            hint: '替换 {{interests}}；顿号或逗号分隔，留空用默认值',
            control: h('input', {
              className: 'qqn-input',
              value: soulForm.soulInterests,
              maxLength: 200,
              placeholder: '听歌、看别人折腾项目、深夜瞎想',
              spellCheck: false,
              onChange: event => setSoulForm(previous => ({ ...previous, soulInterests: event.target.value })),
            }),
          }),
          h(Row, {
            label: '擅长的事',
            hint: '替换 {{strengths}}；顿号或逗号分隔，留空用默认值',
            control: h('input', {
              className: 'qqn-input',
              value: soulForm.soulStrengths,
              maxLength: 200,
              placeholder: '记得住细节、接话自然',
              spellCheck: false,
              onChange: event => setSoulForm(previous => ({ ...previous, soulStrengths: event.target.value })),
            }),
          }),
          h(Row, {
            label: '关系表达',
            hint: '替换 {{relationGuidance}}；留空则按关系阶段自动生成',
            control: h('textarea', {
              className: 'qqn-input aura-persona-textarea',
              rows: 2,
              maxLength: 500,
              value: soulForm.soulRelationGuidance,
              placeholder: '留空 = 自动（按关系阶段给一句）',
              onChange: event => setSoulForm(previous => ({ ...previous, soulRelationGuidance: event.target.value })),
            }),
          }),
        ),
        h('textarea', {
          className: 'qqn-input aura-soul-editor',
          rows: 12,
          maxLength: 4000,
          value: soulForm.soulContent,
          placeholder: '## 性格\n嘴硬心软，怕冷场。\n\n## 爱好\n听歌、看别人折腾奇怪的项目、深夜瞎想。',
          spellCheck: false,
          onChange: event => setSoulForm(previous => ({ ...previous, soulContent: event.target.value })),
        }),
      )

      const soulPreviewSection = h(Section, {
        title: '完整灵魂',
        action: h('span', null, soulPreview.chars + (soulPreview.budget ? ' / ' + soulPreview.budget : '') + ' 字'),
      },
        h('div', { className: 'qqn-row-hint', style: { marginTop: 0, marginBottom: 8 } }, '现在实际注入的全文：核心身份 + 关于你 + 自由内容 + 成长。改动会实时预览。'),
        soulPreview.error ? h('div', { className: 'qqn-error' }, soulPreview.error) : null,
        h('pre', { className: 'aura-soul-preview' }, soulPreview.text || '（还没有内容）'),
      )

      const trailSection = h(Section, { title: t('section.trail') },
        h('div', { className: 'qqn-rows' },
          h(Row, {
            label: '光轨动画',
            hint: '聊天里流动的光轨；跟灵魂总开关一起生效',
            control: h('input', {
              className: 'qqn-checkbox',
              type: 'checkbox',
              checked: personaForm.trailEnabled === true,
              onChange: event => setPersonaForm(previous => ({ ...previous, trailEnabled: event.target.checked })),
            }),
          }),
          h(Row, {
            label: '光轨颜色',
            control: h('div', { className: 'aura-persona-inline' },
              h('input', {
                type: 'color',
                className: 'aura-persona-color',
                value: personaForm.trailColor,
                'aria-label': '光轨颜色',
                onChange: event => setPersonaForm(previous => ({ ...previous, trailColor: personaColorOf(event.target.value) })),
              }),
              h('span', { className: 'qqn-unit' }, personaForm.trailColor),
            ),
          }),
          h(Row, {
            label: '光轨速度',
            control: selectField(PERSONA_TRAIL_SPEEDS, personaForm.trailSpeed, value => setPersonaForm(previous => ({ ...previous, trailSpeed: value })), '光轨速度'),
          }),
          h(Row, {
            label: '光轨粗细',
            control: selectField(PERSONA_TRAIL_WIDTHS, personaForm.trailWidth, value => setPersonaForm(previous => ({ ...previous, trailWidth: value })), '光轨粗细'),
          }),
        ),
      )

      const soulActions = h('div', { className: 'qqn-actions' },
        h(Button, {
          variant: 'primary',
          disabled: blockInfo('soul').busy || personaBusy !== '' || !(soulDirty || personaDirty),
          onClick: () => void saveSoul(),
        }, blockInfo('soul').busy ? t('busy.save') : t('button.soulSave')),
      )

      const personaSection = h(React.Fragment, null,
        h(Section, { title: t('section.expression') },
          h('div', { className: 'qqn-row-hint', style: { marginTop: 0, marginBottom: 8 } }, t('section.expression.hint')),
          personaConfigError
            ? h('div', { className: 'qqn-error' }, '人设配置有问题：' + personaConfigError)
            : null,
          personaLoading && !persona
            ? h('div', { className: 'qqn-loading' }, '正在读取人设…')
            : null,
          h('div', { className: 'qqn-rows' },
            h(Row, {
              label: '回复风格',
              hint: '影响语气和用词',
              control: selectField(PERSONA_STYLES, personaForm.style, value => setPersonaForm(previous => ({ ...previous, style: value })), '回复风格'),
            }),
            h(Row, {
              label: '标题与列表',
              hint: '更多 = 更爱用标题/列表；更少 = 更多段落',
              control: selectField(PERSONA_TRAITS, personaForm.headingLists, value => setPersonaForm(previous => ({ ...previous, headingLists: value })), '标题与列表'),
            }),
            h(Row, {
              label: '表情符号',
              hint: '更多 = 更常用 emoji',
              control: selectField(PERSONA_TRAITS, personaForm.emoji, value => setPersonaForm(previous => ({ ...previous, emoji: value })), '表情符号'),
            }),
            h(Row, {
              label: '表格',
              hint: '更多 = 优先用表格整理信息',
              control: selectField(PERSONA_TRAITS, personaForm.tables, value => setPersonaForm(previous => ({ ...previous, tables: value })), '表格'),
            }),
            h(Row, {
              label: '回复长度',
              control: selectField(PERSONA_REPLY_LENGTHS, personaForm.replyLength, value => setPersonaForm(previous => ({ ...previous, replyLength: value })), '回复长度'),
            }),
            h(Row, {
              label: '语言',
              control: selectField(PERSONA_LANGUAGES, personaForm.language, value => setPersonaForm(previous => ({ ...previous, language: value })), '语言'),
            }),
            h(Row, {
              label: '自定义指令',
              hint: '追加在人设提示词末尾（≤2000 字）',
              control: h('textarea', {
                className: 'qqn-input aura-persona-textarea',
                rows: 4,
                maxLength: 2000,
                value: personaForm.customInstructions,
                onChange: event => setPersonaForm(previous => ({ ...previous, customInstructions: event.target.value })),
              }),
            }),
          ),
        ),
        growthSection,
        h(Section, {
          title: '预设',
          action: personaData.activeId ? h('span', null, '当前：' + personaData.activeId) : null,
        },
          h('div', { className: 'aura-persona-presets' },
            personaPresetOptions.length > 0
              ? h('select', {
                  className: 'qqn-input',
                  value: personaPresetId,
                  'aria-label': '人设预设',
                  onChange: event => setPersonaPresetId(event.target.value),
                }, personaPresetOptions.map(item => h('option', { key: item.id, value: item.id }, item.name + (item.builtin ? '（内置）' : ''))))
              : h('span', { className: 'qqn-unit' }, '没有可用预设'),
            h(Button, {
              disabled: personaBusy !== '' || !personaPresetId,
              onClick: () => void applyPersonaPreset(),
            }, personaBusy === 'apply' ? '应用中…' : '应用'),
            h('input', {
              className: 'qqn-input',
              value: personaPresetName,
              placeholder: '新预设名字',
              maxLength: 40,
              spellCheck: false,
              'aria-label': '新预设名字',
              onChange: event => setPersonaPresetName(event.target.value),
            }),
            h(Button, {
              disabled: personaBusy !== '' || !personaPresetName.trim(),
              onClick: () => void savePersonaPreset(),
            }, personaBusy === 'savePreset' ? '保存中…' : '另存为'),
            h(Button, {
              variant: 'danger',
              disabled: personaBusy !== '' || !personaSelectedPreset || personaSelectedPreset.builtin === true,
              onClick: () => void deletePersonaPreset(),
            }, personaBusy === 'deletePreset' ? '删除中…' : '删除'),
          ),
        ),
        h(Section, {
          title: '最近变更',
          action: h('span', null, personaHistoryRows.length > 0 ? personaHistoryRows.length + ' 条' : ''),
        },
          personaHistoryRows.length > 0
            ? h('div', { className: 'aura-persona-history' }, personaHistoryRows.map(entry => {
                const row = asObject(entry)
                const at = timeOf(row.at)
                const stamp = [formatRelative(at, t), formatClock(at)].filter(Boolean).join(' ') || '—'
                const meta = [personaSourceLabel(row.source), stamp, row.preset ? '预设：' + row.preset : ''].filter(Boolean).join(' · ')
                return h('div', { key: 'persona-history-' + String(row.index) + '-' + String(row.at || ''), className: 'aura-persona-history-row' },
                  h('div', { className: 'aura-persona-history-main' },
                    h('div', { className: 'aura-persona-history-meta' }, meta),
                    h('div', { className: 'aura-persona-history-changes' }, personaChangesText(row.changes)),
                  ),
                  h(Button, {
                    disabled: personaBusy !== '',
                    onClick: () => void undoPersona(row),
                  }, '撤销到这条之前'),
                )
              }))
            : h('div', { className: 'qqn-mood-empty' }, personaLoading ? '加载中…' : '还没有变更记录'),
        ),
        h(Section, {
          title: '提示词预览',
          action: h('button', {
            type: 'button',
            className: 'qqn-seg-button',
            'aria-expanded': personaPreviewOpen,
            onClick: togglePersonaPreview,
          }, personaPreviewOpen ? '收起' : '展开'),
        },
          personaPreviewOpen
            ? (personaBusy === 'preview' && !personaPreview
                ? h('div', { className: 'qqn-mood-empty' }, '生成中…')
                : (personaPreview
                    ? h('pre', { className: 'aura-persona-prompt' }, personaPreview)
                    : h('div', { className: 'qqn-mood-empty' }, '当前还没有可预览的提示词')))
            : h('div', { className: 'qqn-mood-empty' }, '展开后可查看当前表单编译出的提示词'),
        ),
        h(Section, { title: t('section.trail') },
          h('div', { className: 'qqn-rows' },
            h(Row, {
              label: '光轨动画',
              hint: '聊天里流动的光轨；跟灵魂总开关一起生效',
              control: h('input', {
                className: 'qqn-checkbox',
                type: 'checkbox',
                checked: personaForm.trailEnabled === true,
                onChange: event => setPersonaForm(previous => ({ ...previous, trailEnabled: event.target.checked })),
              }),
            }),
            h(Row, {
              label: '光轨颜色',
              control: h('div', { className: 'aura-persona-inline' },
                h('input', {
                  type: 'color',
                  className: 'aura-persona-color',
                  value: personaForm.trailColor,
                  'aria-label': '光轨颜色',
                  onChange: event => setPersonaForm(previous => ({ ...previous, trailColor: personaColorOf(event.target.value) })),
                }),
                h('span', { className: 'qqn-unit' }, personaForm.trailColor),
              ),
            }),
            h(Row, {
              label: '光轨速度',
              control: selectField(PERSONA_TRAIL_SPEEDS, personaForm.trailSpeed, value => setPersonaForm(previous => ({ ...previous, trailSpeed: value })), '光轨速度'),
            }),
            h(Row, {
              label: '光轨粗细',
              control: selectField(PERSONA_TRAIL_WIDTHS, personaForm.trailWidth, value => setPersonaForm(previous => ({ ...previous, trailWidth: value })), '光轨粗细'),
            }),
          ),
        ),
        h('div', { className: 'qqn-actions' },
          h(Button, {
            variant: 'primary',
            disabled: blockInfo('soul').busy || personaBusy !== '' || !(soulDirty || personaDirty),
            onClick: () => void saveSoul(),
          }, blockInfo('soul').busy ? t('busy.save') : t('button.soulSave')),
          h(Button, {
            disabled: blockInfo('soul').busy || personaBusy !== '',
            onClick: () => void resetPersona(),
          }, personaBusy === 'reset' ? '重置中…' : '重置'),
        ),
        blockFeedback('soul'),
        personaFeedback,
      )

      /* ---------------- 日记 tab ---------------- */
      const diaryTodayDate = diaryDateKey()
      const diaryFeedback = diaryError
        ? h('div', { className: 'qqn-error', role: 'status', 'aria-live': 'polite' }, '日记：' + diaryError)
        : (diaryNotice ? h('div', { className: 'qqn-feedback', role: 'status', 'aria-live': 'polite' }, diaryNotice) : null)

      const diaryTodayHighlights = diaryHighlights(diaryToday && diaryToday.highlights)
      const diaryTodayCard = diaryTodayChecked
        ? (diaryToday
            ? h('div', { className: 'qqn-rows', style: { marginBottom: 12 } },
                h('div', { className: 'qqn-memory-block' },
                  h('div', { className: 'qqn-memory-group' },
                    h('div', { className: 'qqn-memory-group-title' },
                      diaryTodayDate
                        + ' · ' + (diaryMoodLabel(diaryToday) || '无情绪')
                        + (diaryToday.source === 'user' ? ' · 你写的' : '')),
                    h('div', { className: 'qqn-memory-item' }, String(diaryToday.summary || '（没有摘要）')),
                    diaryTodayHighlights.length > 0
                      ? h('div', { className: 'qqn-chip-list' }, diaryTodayHighlights.map((text, index) => h('span', { key: 'diary-today-hl-' + index, className: 'qqn-tag' }, text)))
                      : null,
                  ),
                ),
              )
            : h('div', { className: 'qqn-mood-empty' }, '今天还没有日记；点「补写今天的日记」让她用规则写一篇'))
        : null

      const diaryList = diaryEntries.length > 0
        ? h('div', { className: 'aura-persona-history' }, diaryEntries.map((entry, index) => {
            const row = asObject(entry)
            const date = String(row.date || '')
            const open = date !== '' && diaryOpenDate === date
            const mood = diaryMoodLabel(row)
            const summary = String(row.summary || '')
            const highlights = diaryHighlights(row.highlights)
            const meta = [
              date || '未知日期',
              mood,
              row.source === 'user' ? '你写的' : '',
              open ? '收起 ▴' : '展开 ▾',
            ].filter(Boolean).join(' · ')
            return h('div', { key: 'diary-' + (date || index), className: 'aura-persona-history-row' },
              h('div', {
                className: 'aura-persona-history-main',
                role: 'button',
                tabIndex: 0,
                'aria-expanded': open,
                title: open ? '点击收起' : '点击展开',
                style: { cursor: 'pointer' },
                onClick: () => { if (date) setDiaryOpenDate(open ? '' : date) },
                onKeyDown: event => {
                  if (!date) return
                  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                    event.preventDefault()
                    setDiaryOpenDate(open ? '' : date)
                  }
                },
              },
                h('div', { className: 'aura-persona-history-meta' }, meta),
                h('div', { className: 'aura-persona-history-changes' }, summary ? (open ? summary : clipText(summary, 60)) : '（没有摘要）'),
                open && highlights.length > 0
                  ? h('div', { className: 'qqn-memory-group', style: { marginTop: 6 } },
                      h('div', { className: 'qqn-memory-group-title' }, '亮点'),
                      highlights.map((text, number) => h('div', { key: 'diary-hl-' + number, className: 'qqn-memory-item' }, '· ' + text)),
                    )
                  : null,
              ),
              h(Button, {
                variant: 'danger',
                disabled: diaryBusy !== '' || !date,
                onClick: () => { void removeDiary(date) },
              }, diaryBusy === 'delete:' + date ? '删除中…' : '删除'),
            )
          }))
        : null

      const diarySection = h(Section, { title: '日记' },
        h('div', { className: 'qqn-row-hint', style: { marginTop: 0, marginBottom: 10 } }, '她自己的记录，不是记忆；不会自动注入提示词'),
        h('div', { className: 'qqn-actions', style: { marginTop: 0, marginBottom: 12 } },
          h('span', { className: 'qqn-unit', style: { marginRight: 'auto' } }, '今天 ' + diaryTodayDate),
          h(Button, { disabled: diaryBusy !== '', onClick: () => { void loadDiaryToday() } }, diaryBusy === 'today' ? '读取中…' : '看看今天'),
          h(Button, { disabled: diaryBusy !== '', onClick: () => { void generateDiary() } }, diaryBusy === 'generate' ? '补写中…' : '补写今天的日记'),
          h(Button, { disabled: diaryBusy !== '', onClick: () => setDiaryComposeOpen(previous => !previous) }, diaryComposeOpen ? '收起手写' : '写一篇'),
        ),
        diaryFeedback,
        diaryComposeOpen
          ? h('div', { className: 'qqn-rows', style: { marginBottom: 12 } },
              h('div', { className: 'qqn-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: '10px 0' } },
                h('textarea', {
                  className: 'qqn-input aura-persona-textarea',
                  rows: 4,
                  maxLength: 500,
                  placeholder: '今天想记下什么…（≤500 字）',
                  value: diaryDraft,
                  disabled: diaryBusy === 'save',
                  onChange: event => setDiaryDraft(event.target.value),
                }),
                h('div', { className: 'qqn-actions' },
                  h(Button, { variant: 'primary', disabled: diaryBusy !== '' || !diaryDraft.trim(), onClick: () => { void saveDiaryDraft() } }, diaryBusy === 'save' ? '保存中…' : '保存'),
                  h(Button, { disabled: diaryBusy !== '', onClick: () => setDiaryComposeOpen(false) }, '取消'),
                ),
              ),
            )
          : null,
        diaryTodayCard,
        diaryLoading && !diaryLoaded ? h('div', { className: 'qqn-loading' }, '正在读取日记…') : null,
        !diaryLoading && diaryLoaded && diaryEntries.length === 0
          ? h('div', { className: 'qqn-mood-empty' }, '最近 7 天还没有日记。')
          : null,
        diaryList,
      )

      const tabDefs = [
        ['soul', '灵魂'],
        ['emotion', '情绪'],
        ['memory', '记忆'],
        ['diary', '日记'],
        ['speak', '主动'],
        ['meme', '表情包'],
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
              tab === 'soul' ? h(React.Fragment, null, soulSection, soulContentSection, soulPreviewSection, growthSection, soulActions, blockFeedback('soul')) : null,
              tab === 'emotion' ? h(React.Fragment, null, emotionSection, relationSection) : null,
              tab === 'memory' ? memorySection : null,
              tab === 'diary' ? diarySection : null,
              tab === 'meme' ? memeSection : null,
              tab === 'speak' ? speakSection : null,
              tab === 'appearance' ? h(React.Fragment, null, appearanceSection, trailSection) : null,
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

    /* ---------------- 输入框光轨（Agent 回复中时输入框边框流光） ----------------
       匀速原理：沿「卡片边框」画一个 SVG 圆角矩形，pathLength 归一化到 100，用
       stroke-dashoffset 线性推进 —— 按弧长运动，圆角与直边线速度一致。渐隐拖尾：
       8 层等长 dash 依次错位、透明度递减叠加，头部各层重叠最亮、向后递减；所有层
       共用同一时长，整体仍严格匀速。描边中心线压在宿主边框盒边缘（外半圈由
       TRAIL_PAD 外扩盒容纳），光轨开启时隐藏宿主自身细边框，边界上只留一条线。

       ⚠️ 隔离不变量：环是「写在宿主内部、尺寸随宿主变化」的绝对定位元素。一旦它
       进入宿主布局流（样式被更具体选择器或 !important 覆盖），就会闭合成尺寸正
       反馈环（卡片变高 → ResizeObserver → 改 SVG → 再变高 …）。故用三层手段保证
       它绝不参与宿主任何尺寸测量：
         1) 挂载点优先选卡片内那个 position:absolute;height:0 的 overlay 锚点；
         2) 关键几何（position/left/top/width/height/contain）全部内联；
         3) contain:strict + 墨迹收进自身盒内，尺寸/布局/绘制与外部彻底隔离。 */

    const TRAIL_DASH = 12
    const TRAIL_LAYERS = 8
    const TRAIL_LAYER_STEP = 2.2
    const TRAIL_RADIUS = 22
    const TRAIL_COLOR_FALLBACK = '#679EFE'
    const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
    const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
    const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']
    /** 最粗描边（4px）的一半：外盒每边外扩这么多，描边外半圈才落在 SVG 自身盒内。 */
    const TRAIL_PAD = 2
    /** 失控熔断：输入框卡片不可能到这个量级，命中即停止同步并隐藏。 */
    const TRAIL_MAX_SIDE = 20000
    /** 配置轮询间隔；人设页保存成功会 dispatch 事件，无需等这一轮。 */
    const TRAIL_POLL_MS = 15000
    const TRAIL_DEFAULT_CONFIG = Object.freeze({
      enabled: true,
      color: TRAIL_COLOR_FALLBACK,
      speed: 'slow',
      width: 'thin',
    })

    /** 颜色容错：输入中途（如只打了 #6）回退默认色；统一大写好与调色板取值比较。 */
    function safeTrailColor(value) {
      if (typeof value !== 'string') return TRAIL_COLOR_FALLBACK
      const text = value.trim()
      return TRAIL_COLOR_PATTERN.test(text) ? text.toUpperCase() : TRAIL_COLOR_FALLBACK
    }

    function trailOption(value, allowed, fallback) {
      const text = String(value || '')
      return allowed.includes(text) ? text : fallback
    }

    /** 从 persona payload 取光轨四项；灵魂总开关关闭时整体不显示。 */
    function trailConfigOf(payload, soulPayload) {
      const data = payload && typeof payload === 'object' ? payload : null
      const cfg = data && data.config && typeof data.config === 'object' ? data.config : null
      const soulEnabled = !(soulPayload && soulPayload.config && soulPayload.config.soulEnabled === false)
      if (!cfg || !soulEnabled) return { ...TRAIL_DEFAULT_CONFIG, enabled: false }
      return {
        enabled: cfg.trailEnabled !== false,
        color: safeTrailColor(cfg.trailColor),
        speed: trailOption(cfg.trailSpeed, TRAIL_SPEED_VALUES, 'slow'),
        width: trailOption(cfg.trailWidth, TRAIL_WIDTH_VALUES, 'thin'),
      }
    }

    function createSvgNode(tag, attrs) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      return node
    }

    /** 构建拖尾环；层数、dash 长度与错位步长与 CSS keyframes 一一对应。 */
    function buildTrailSvg() {
      const svg = createSvgNode('svg', { class: 'aura-trail-svg', 'aria-hidden': 'true' })
      for (let layer = 0; layer < TRAIL_LAYERS; layer++) {
        svg.appendChild(createSvgNode('rect', {
          class: 'aura-trail-layer',
          'data-layer': String(layer),
          fill: 'none',
          pathLength: '100',
          'stroke-dasharray': `${TRAIL_DASH} ${100 - TRAIL_DASH}`,
          'stroke-dashoffset': String(layer * TRAIL_LAYER_STEP),
        }))
      }
      return svg
    }

    /** 外盒相对挂载锚点的偏移：锚点与宿主 padding box 原点重合，故减去边框宽与 PAD。 */
    function trailBoxOffset(host) {
      let borderLeft = 0
      let borderTop = 0
      try {
        const style = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(host) : null
        if (style) {
          borderLeft = parseFloat(style.borderLeftWidth) || 0
          borderTop = parseFloat(style.borderTopWidth) || 0
        }
      } catch {
        // 取不到计算样式按无边框处理（DSH 输入框卡片 border:0）
      }
      return { left: -borderLeft - TRAIL_PAD, top: -borderTop - TRAIL_PAD }
    }

    /** 让环与宿主「边框盒」逐像素对齐；尺寸未变时不重复写样式。 */
    function sizeTrailSvg(svg, host, width, height) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
      const boxWidth = width + TRAIL_PAD * 2
      const boxHeight = height + TRAIL_PAD * 2
      const offset = trailBoxOffset(host)
      const key = `${width}x${height}@${offset.left},${offset.top}`
      if (svg.dataset.trailKey === key) return false
      svg.dataset.trailKey = key
      svg.style.left = `${offset.left}px`
      svg.style.top = `${offset.top}px`
      svg.style.width = `${boxWidth}px`
      svg.style.height = `${boxHeight}px`
      svg.setAttribute('viewBox', `0 0 ${boxWidth} ${boxHeight}`)
      for (const rect of svg.querySelectorAll('.aura-trail-layer')) {
        rect.setAttribute('x', String(TRAIL_PAD))
        rect.setAttribute('y', String(TRAIL_PAD))
        rect.setAttribute('width', String(width))
        rect.setAttribute('height', String(height))
        rect.setAttribute('rx', String(TRAIL_RADIUS))
      }
      return true
    }

    /** 解析环在卡片内的挂载点：优先「卡片直接子元素的零高度容器」。 */
    function resolveTrailMountPoint(card, anchor) {
      if (anchor && anchor.parentElement === card) return anchor
      const parent = anchor && anchor.parentElement
      if (!parent) return card
      let node = parent
      while (node !== card && node.parentElement && node.parentElement !== card) node = node.parentElement
      if (node !== card && node.parentElement === card) return node
      return card
    }

    /** 把环挂到卡片（内部锚点）上并跟随宿主尺寸；返回 { svg, setVisible, unmount }。 */
    function mountTrailRing(host, anchor) {
      const svg = buildTrailSvg()
      // 关键几何内联：样式表若把 position 覆盖回常规流，环会触发尺寸正反馈，
      // 后果是整页布局被撑爆，所以不能只依赖类规则
      svg.style.cssText = [
        'position:absolute',
        'display:none',
        'pointer-events:none',
        'contain:strict',
        'overflow:hidden',
        'margin:0',
        'padding:0',
        'border:0',
        'transform:none',
        'animation:none',
        'max-width:none',
        'max-height:none',
      ].join(';')
      ;(anchor || host).appendChild(svg)

      let stopped = false
      let observer = null
      let geometryChecked = false

      // 停用并留下线索：与其画出错位图形或拖垮布局，不如安静退出
      const disable = reason => {
        stopped = true
        svg.style.display = 'none'
        if (observer) observer.disconnect()
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-aura] 已停用输入框光轨：' + reason)
        }
      }

      const sync = () => {
        if (stopped) return
        // 用 offsetWidth/Height（边框盒）而非 clientWidth/Height（内边距盒）
        const width = host.offsetWidth
        const height = host.offsetHeight
        if (width > TRAIL_MAX_SIDE || height > TRAIL_MAX_SIDE) {
          disable('输入框尺寸异常（疑似尺寸正反馈）')
          return
        }
        if (!sizeTrailSvg(svg, host, width, height)) return
        if (geometryChecked) return
        geometryChecked = true
        // 自检：样式表若把 position 改回常规流，环就会重新参与宿主排版，此时主动停用
        if (typeof globalThis.getComputedStyle !== 'function') return
        let position = 'absolute'
        try {
          position = globalThis.getComputedStyle(svg).position
        } catch {
          return
        }
        if (position !== 'absolute') disable('光轨样式被第三方样式表覆盖（position: ' + position + '）')
      }

      sync()
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(sync)
        observer.observe(host)
      } else if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('resize', sync)
      }
      if (stopped && observer) observer.disconnect()

      // 显隐也走内联，不只靠 [data-aura-trail="off"] 规则
      const setVisible = visible => {
        if (stopped) return
        svg.style.display = visible ? 'block' : 'none'
      }

      return {
        svg,
        setVisible,
        unmount: () => {
          stopped = true
          if (observer) observer.disconnect()
          else if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', sync)
          svg.remove()
        },
      }
    }

    /** 光轨样式必须常驻（面板没打开时光轨也在动）：注入一次，随插件卸载移除。 */
    let trailStyleEl = null

    function ensureTrailStyle() {
      if (typeof document === 'undefined' || trailStyleEl) return trailStyleEl
      try {
        const el = document.createElement('style')
        el.id = 'aura-trail-style'
        el.textContent = TRAIL_CSS
        ;(document.head || document.documentElement).appendChild(el)
        trailStyleEl = el
      } catch (error) {
        console.warn('[dsh-aura] 光轨样式注入失败：', error)
      }
      return trailStyleEl
    }

    function disposeTrailStyle() {
      if (trailStyleEl && trailStyleEl.parentNode) trailStyleEl.parentNode.removeChild(trailStyleEl)
      trailStyleEl = null
    }

    /**
     * 输入框光轨运行时：注册在 conversation.input.overlay（输入框卡片内部）。
     * 组件本身不渲染可见内容 —— 它在最近的 [data-composer-card] 上挂一层 SVG 环，
     * 用会话运行态（SessionSnapshot.running）+ 光轨开关控制显隐；没有卡片时安静不挂载。
     */
    function AuraTrail(props) {
      const useSession = props && props.useSession
      const running = typeof useSession === 'function'
        ? useSession(snapshot => snapshot.running === true)
        : false
      const [trail, setTrail] = React.useState(TRAIL_DEFAULT_CONFIG)
      const anchorRef = React.useRef(null)
      const mountedRef = React.useRef(null)

      // 配置来源：人设 Host 的 config.trailXxx。面板没打开也要跟上，所以组件自己轮询；
      // 人设页保存成功时 dispatch 'aura:persona-saved'，这里立刻补一次，不必等下一轮。
      React.useEffect(() => {
        let alive = true
        const refresh = async () => {
          try {
            const [value, soulValue] = await Promise.all([
              fetchJson(PERSONA_API + '/state'),
              fetchJson('/dsh-aura/api/state'),
            ])
            if (alive) setTrail(trailConfigOf(value, soulValue))
          } catch {
            // 取不到就保持默认配置，安静不报错
          }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, TRAIL_POLL_MS)
        const onSaved = () => { void refresh() }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener(PERSONA_SAVED_EVENT, onSaved)
        }
        return () => {
          alive = false
          clearInterval(timer)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener(PERSONA_SAVED_EVENT, onSaved)
          }
        }
      }, [])

      // 挂环：锚点 → closest('[data-composer-card]')，避免全局查询误命中
      React.useEffect(() => {
        const anchor = anchorRef.current
        if (!anchor) return undefined
        const card = typeof anchor.closest === 'function' ? anchor.closest('[data-composer-card]') : null
        if (!card) return undefined
        const mountPoint = resolveTrailMountPoint(card, anchor)
        const mounted = mountTrailRing(card, mountPoint)
        mountedRef.current = { card, mounted }
        // 效果在首帧绘制后执行：先置隐藏，避免挂载瞬间闪出一帧光轨
        card.setAttribute('data-aura-trail', 'off')
        mounted.setVisible(false)
        return () => {
          const current = mountedRef.current
          mountedRef.current = null
          if (!current) return
          current.mounted.unmount()
          current.card.removeAttribute('data-aura-trail')
          current.card.removeAttribute('data-aura-trail-speed')
          current.card.removeAttribute('data-aura-trail-width')
          current.card.style.removeProperty('--aura-trail-color')
        }
      }, [])

      // 显隐与外观：只有「Agent 回复中 + 光轨开关开启」才显示
      React.useEffect(() => {
        const current = mountedRef.current
        if (!current) return
        const { card, mounted } = current
        const visible = running === true && trail.enabled === true
        card.setAttribute('data-aura-trail', visible ? 'on' : 'off')
        card.setAttribute('data-aura-trail-speed', trail.speed)
        card.setAttribute('data-aura-trail-width', trail.width)
        card.style.setProperty('--aura-trail-color', trail.color)
        mounted.setVisible(visible)
      }, [running, trail])

      return h('span', { ref: anchorRef, className: 'aura-trail-anchor', hidden: true, 'aria-hidden': true })
    }

    /* ---------------- 聊天内联 [表情: 描述] 渲染（独立于 dsh-meme） ---------------- */
    const MEME_INLINE_RE = /\[表情[:：]\s*([^\]]+)\](?:\((https?:\/\/[^\s)]+)\))?/g
    const MEME_INLINE_TEST = /\[表情[:：]\s*([^\]]+)\](?:\((https?:\/\/[^\s)]+)\))?/
    /** 聊天内容区探测顺序：DSH 0.2 的消息内容槽 → 老版 flow 标记 → 常见容器。 */
    const MEME_CHAT_SELECTORS = [
      '[data-slot="conversation.chat.node"]',
      '[data-chat-flow-key]',
      '[data-chat-flow]',
      '[data-conversation-scroll]',
      '.dsh-chat',
    ]
    const MEME_CHAT_SELECTOR = MEME_CHAT_SELECTORS.join(',')
    const MEME_INLINE_CSS = `
.aura-inline-meme{max-height:160px;max-width:100%;border-radius:10px;vertical-align:middle;object-fit:contain;cursor:zoom-in;margin:2px 4px;display:inline-block}
.aura-meme-zoom{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.78);cursor:zoom-out;box-sizing:border-box}
.aura-meme-zoom-img{max-width:100%;max-height:100%;border-radius:12px;object-fit:contain;box-shadow:0 18px 60px rgba(0,0,0,.6)}
`
    /** 面板里改完图库后，让聊天索引立即重拉。 */
    const inlineMemeRefreshers = new Set()

    function refreshInlineMemeIndex() {
      for (const refresh of [...inlineMemeRefreshers]) {
        try {
          refresh()
        } catch (error) {
          console.warn('[dsh-aura] 聊天表情索引刷新失败：', error)
        }
      }
    }

    function memeFoldCaption(value) {
      return String(value || '').trim()
        .replace(/[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u00ab\u00bb]/g, '"')
        .replace(/\s+/g, ' ')
    }

    function memeLooseCaption(value) {
      return memeFoldCaption(value).replace(/["'\s]/g, '')
    }

    /** 按中英文标点切词；两字以下太泛，不参与兜底匹配。 */
    function memeSplitTokens(value) {
      return memeFoldCaption(value)
        .split(/[\s,.!?;:、，。！？；：""''()（）\[\]【】《》…·～~\-]+/)
        .map(token => token.replace(/["']/g, ''))
        .filter(token => token.length >= 2)
        .sort((left, right) => right.length - left.length)
    }

    function memeAddKey(map, key, src) {
      const raw = String(key || '').trim()
      if (!raw) return
      map.set(raw, src)
      const folded = memeFoldCaption(raw)
      if (folded) map.set(folded, src)
      const loose = memeLooseCaption(raw)
      if (loose) map.set(loose, src)
    }

    function memeBuildIndex(rows) {
      const map = new Map()
      const search = []
      for (const row of asArray(rows)) {
        const source = asObject(row)
        const src = memeSrc(source)
        if (!src) continue
        const caption = String(source.caption || '')
        const fileName = String(source.file_name || '')
        const keywords = String(source.keywords || '')
        for (const key of [caption, fileName, keywords, caption.slice(0, 80), caption.slice(0, 100)]) {
          memeAddKey(map, key, src)
        }
        // 关键词常是空格分隔的短词，单独入精确表，像「晕」这种单字也能命中。
        for (const keyword of keywords.split(/\s+/)) {
          const text = keyword.trim()
          if (text) memeAddKey(map, text, src)
        }
        const hay = []
        const parts = []
        for (const text of [caption, keywords, fileName]) {
          const folded = memeFoldCaption(text)
          if (!folded) continue
          const loose = memeLooseCaption(text)
          hay.push(folded)
          if (loose && loose !== folded) hay.push(loose)
          parts.push(text)
        }
        const tokens = [...new Set(memeSplitTokens(parts.join(' ')))]
        search.push({ hay, tokens, src })
      }
      return { map, search }
    }

    /** 组合匹配：精确（原文/折叠/紧凑）→ 分词在 caption/关键词里双向包含。 */
    function memeMatchDesc(desc, index) {
      if (!index) return ''
      const raw = String(desc || '').trim()
      const exact = index.map.get(raw) || index.map.get(memeFoldCaption(raw)) || index.map.get(memeLooseCaption(raw))
      if (exact) return exact
      const needles = [...new Set(memeSplitTokens(desc).map(memeLooseCaption).filter(Boolean))]
      let best = ''
      let bestLength = 0
      let bestCount = 0
      for (const row of index.search) {
        let longest = 0
        let count = 0
        for (const needle of needles) {
          let length = row.hay.some(hay => hay.includes(needle)) ? needle.length : 0
          for (const token of row.tokens) {
            const loose = memeLooseCaption(token)
            if (loose && (needle.includes(loose) || loose.includes(needle))) {
              length = Math.max(length, Math.min(needle.length, loose.length))
            }
          }
          if (length) {
            longest = Math.max(longest, length)
            count++
          }
        }
        if (longest > bestLength || (longest === bestLength && count > bestCount)) {
          best = row.src
          bestLength = longest
          bestCount = count
        }
      }
      return best
    }

    /**
     * 创建聊天内联表情渲染器。返回 { start, dispose }：
     * - 拉一次 /dsh-aura/memes-api?action=list 建本地索引；
     * - MutationObserver 监听 body，只处理聊天内容区里带标记的文本节点；
     * - 注入图/隐藏 ghost（保留 textContent 原文）并加 data-aura-meme 防重复；
     * - dispose 时清 observer、样式、点击放大遮罩和监听。
     */
    function createInlineMemeRenderer() {
      if (typeof document === 'undefined') {
        return { start() {}, dispose() {} }
      }

      let styleEl = null
      let observer = null
      let disposed = false
      let index = null
      let loading = false
      let attempts = 0
      let retryAt = 0
      let warned = false
      let controller = null
      let scanTimer = null
      let zoomBox = null
      let zoomImage = null

      const report = error => {
        if (warned) return
        warned = true
        console.warn('[dsh-aura] 聊天表情索引加载失败，稍后自动重试：', error && error.message ? error.message : error)
      }

      const loadIndex = () => {
        if (disposed || index || loading || Date.now() < retryAt) return
        loading = true
        attempts++
        const ac = typeof AbortController === 'function' ? new AbortController() : null
        controller = ac
        const timeout = ac ? setTimeout(() => {
          try {
            ac.abort()
          } catch {
            // ignore
          }
        }, 15000) : 0
        fetch(MEME_API + '?action=list', ac ? { signal: ac.signal } : undefined)
          .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(value => {
            if (disposed) return
            if (!value || value.ok === false || !Array.isArray(value.memes)) {
              throw new Error((value && value.error) || '无效的表情包索引')
            }
            index = memeBuildIndex(value.memes)
            attempts = 0
            retryAt = 0
            scheduleScan(0)
          })
          .catch(error => {
            if (disposed) return
            retryAt = Date.now() + Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempts - 1)))
            report(error)
          })
          .finally(() => {
            if (timeout) clearTimeout(timeout)
            if (!disposed) loading = false
            if (controller === ac) controller = null
          })
      }

      const refresh = () => {
        if (disposed) return
        if (controller) {
          try {
            controller.abort()
          } catch {
            // ignore
          }
          controller = null
        }
        loading = false
        index = null
        attempts = 0
        retryAt = 0
        loadIndex()
      }

      const collectScopes = () => {
        for (const selector of MEME_CHAT_SELECTORS) {
          let list = []
          try {
            list = document.querySelectorAll(selector)
          } catch {
            list = []
          }
          if (list.length) return list
        }
        return []
      }

      const makeGhost = raw => {
        const ghost = document.createElement('span')
        ghost.setAttribute('data-aura-meme', 'ghost')
        ghost.style.display = 'none'
        ghost.textContent = raw
        return ghost
      }

      const acceptable = node => {
        const parent = node && node.parentElement
        if (!parent || !node.isConnected) return false
        if (!parent.closest(MEME_CHAT_SELECTOR)) return false
        if (parent.closest('input,textarea,[contenteditable="true"],pre,code,[data-variant="think"],[data-variant="others"],[data-chat-flow-kind="turn-process"]')) return false
        if (parent.closest('[data-aura-meme="ghost"]')) return false
        const text = node.nodeValue || ''
        if (text.indexOf('[') < 0) return false
        MEME_INLINE_TEST.lastIndex = 0
        return MEME_INLINE_TEST.test(text)
      }

      const cleanupMarkers = () => {
        let list = []
        try {
          list = document.querySelectorAll('[data-aura-meme="done"]')
        } catch {
          list = []
        }
        for (const element of list) {
          if (element.querySelector('img[data-aura-meme="img"],span[data-aura-meme="ghost"]')) continue
          element.removeAttribute('data-aura-meme')
        }
      }

      const decorateTextNode = node => {
        const parent = node.parentElement
        if (!parent) return false
        const text = node.nodeValue || ''
        MEME_INLINE_RE.lastIndex = 0
        const matches = []
        let match
        while ((match = MEME_INLINE_RE.exec(text))) matches.push(match)
        if (matches.length === 0) return false
        if (!index) {
          loadIndex()
          return false
        }
        const fragment = document.createDocumentFragment()
        let last = 0
        let rendered = 0
        for (const hit of matches) {
          if (hit.index > last) fragment.appendChild(document.createTextNode(text.slice(last, hit.index)))
          const raw = hit[0]
          const desc = String(hit[1] || '').trim()
          const external = hit[2] && /^https?:\/\//.test(hit[2]) ? hit[2] : ''
          const src = external || memeMatchDesc(desc, index)
          if (src) {
            const image = document.createElement('img')
            image.className = 'aura-inline-meme'
            image.src = src
            image.alt = desc
            image.title = desc
            image.loading = 'lazy'
            image.decoding = 'async'
            image.setAttribute('data-aura-meme', 'img')
            fragment.appendChild(image)
            fragment.appendChild(makeGhost(raw))
            rendered++
          } else {
            // 匹配不到时只显示描述，方括号藏进 ghost，textContent 仍与原文逐字一致。
            const at = raw.indexOf(desc)
            fragment.appendChild(makeGhost(at > 0 ? raw.slice(0, at) : ''))
            fragment.appendChild(document.createTextNode(desc))
            fragment.appendChild(makeGhost(at > 0 ? raw.slice(at + desc.length) : ''))
          }
          last = hit.index + raw.length
        }
        if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
        parent.replaceChild(fragment, node)
        parent.setAttribute('data-aura-meme', 'done')
        return rendered > 0
      }

      const scan = () => {
        if (disposed) return
        if (!index) {
          loadIndex()
          return
        }
        cleanupMarkers()
        for (const scope of collectScopes()) {
          let walker = null
          try {
            walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
          } catch {
            continue
          }
          const nodes = []
          let current = null
          while ((current = walker.nextNode())) nodes.push(current)
          for (const node of nodes) {
            if (!node.isConnected || !acceptable(node)) continue
            decorateTextNode(node)
          }
        }
      }

      const scheduleScan = delay => {
        if (disposed || scanTimer !== null) return
        scanTimer = setTimeout(() => {
          scanTimer = null
          scan()
        }, typeof delay === 'number' ? delay : 120)
      }

      const touchesChat = record => {
        const nodes = []
        if (record.target) nodes.push(record.target)
        for (const added of record.addedNodes || []) nodes.push(added)
        for (const node of nodes) {
          const element = node.nodeType === 1 ? node : (node.parentElement || null)
          if (!element) continue
          try {
            if (element.closest && element.closest(MEME_CHAT_SELECTOR)) return true
            if (element.querySelector && element.querySelector(MEME_CHAT_SELECTOR)) return true
          } catch {
            // 忽略探测失败
          }
        }
        return false
      }

      const onMutations = records => {
        for (const record of records) {
          if (record.type === 'characterData') {
            const element = record.target && record.target.parentElement
            if (element && element.closest && element.closest(MEME_CHAT_SELECTOR)) {
              scheduleScan()
              return
            }
            continue
          }
          if (touchesChat(record)) {
            scheduleScan()
            return
          }
        }
      }

      const closeZoom = () => {
        if (zoomBox) zoomBox.style.display = 'none'
      }

      const ensureZoom = () => {
        if (zoomBox) return zoomBox
        zoomBox = document.createElement('div')
        zoomBox.className = 'aura-meme-zoom'
        zoomBox.setAttribute('data-aura-meme', 'zoom')
        zoomBox.style.display = 'none'
        zoomImage = document.createElement('img')
        zoomImage.className = 'aura-meme-zoom-img'
        zoomImage.alt = ''
        zoomBox.appendChild(zoomImage)
        zoomBox.addEventListener('click', event => {
          if (event.target === zoomBox) closeZoom()
        })
        document.body.appendChild(zoomBox)
        return zoomBox
      }

      const onClick = event => {
        const target = event.target
        if (!target || target.tagName !== 'IMG' || !target.classList) return
        if (!target.classList.contains('aura-inline-meme')) return
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        ensureZoom()
        zoomImage.src = target.currentSrc || target.src
        zoomImage.alt = target.alt || ''
        zoomBox.style.display = 'flex'
      }

      const onKeyDown = event => {
        if (event.key === 'Escape') closeZoom()
      }

      const boot = () => {
        if (disposed || observer || !document.body) return
        if (typeof MutationObserver !== 'function') {
          inlineMemeRefreshers.add(refresh)
          loadIndex()
          scheduleScan(0)
          return
        }
        observer = new MutationObserver(onMutations)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        inlineMemeRefreshers.add(refresh)
        loadIndex()
        scheduleScan(0)
      }

      const start = () => {
        if (disposed) return
        if (!styleEl) {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin', 'dsh-aura')
          styleEl.textContent = MEME_INLINE_CSS
          ;(document.head || document.documentElement).appendChild(styleEl)
        }
        document.addEventListener('click', onClick, true)
        document.addEventListener('keydown', onKeyDown, true)
        if (document.body) boot()
        else document.addEventListener('DOMContentLoaded', boot, { once: true })
      }

      const dispose = () => {
        if (disposed) return
        disposed = true
        inlineMemeRefreshers.delete(refresh)
        if (scanTimer !== null) {
          clearTimeout(scanTimer)
          scanTimer = null
        }
        if (observer) {
          try {
            observer.disconnect()
          } catch {
            // ignore
          }
          observer = null
        }
        if (controller) {
          try {
            controller.abort()
          } catch {
            // ignore
          }
          controller = null
        }
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('DOMContentLoaded', boot)
        if (zoomBox && zoomBox.parentNode) zoomBox.parentNode.removeChild(zoomBox)
        zoomBox = null
        zoomImage = null
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
        styleEl = null
      }

      return { start, dispose }
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

        // 聊天内联 [表情: 描述]：独立渲染器，不依赖 dsh-meme，随插件卸载一起 dispose。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const renderer = createInlineMemeRenderer()
            renderer.start()
            return () => renderer.dispose()
          }, 'dsh-aura: inline meme rendering')
        } else {
          createInlineMemeRenderer().start()
        }

        // 输入框光轨：常驻样式 + 卡片内 overlay 槽位。
        // 槽位注册在 ctx.slots.inject 里，插件 dispose 时由 slots 自己清理。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            ensureTrailStyle()
            return () => disposeTrailStyle()
          }, 'dsh-aura: input trail styles')
        } else {
          ensureTrailStyle()
        }
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'aura-trail',
          order: 50,
        }, AuraTrail))

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
