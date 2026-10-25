/**
 * QQ SDK 适配器离线自测：不连网、不启动 Host。
 * 运行：DSH_HOME=/data/data/com.termux/files/home/workspace/.devhome node dev/qq-sdk-selftest.mjs
 */
let failures = 0
const check = (name, ok, extra) => {
  if (ok) console.log('  ok  ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')) }
}

const { mapInboundMessage, buildReplyTarget, QQClient: SdkClient } = await import('../host/qq-sdk.js')
const { QQClient: Dispatcher } = await import('../host/qq.js')

const c2c = mapInboundMessage({
  kind: 'c2c',
  content: '在干嘛',
  messageId: 'MSG_1',
  senderId: 'USER_1',
  timestamp: '2026-10-25T14:00:00.000Z',
  rawEventType: 'C2C_MESSAGE_CREATE',
  replyTarget: { scope: 'c2c', targetId: 'USER_1', msgId: 'MSG_1' },
})
check('私聊入站映射', c2c?.kind === 'dm' && c2c.chatId === 'USER_1' && c2c.msgId === 'MSG_1' && c2c.text === '在干嘛', c2c)
check('入站时间戳解析', Number.isFinite(c2c?.timestampMs) && c2c.timestampMs > 0, c2c?.timestampMs)

const group = mapInboundMessage({
  kind: 'group',
  content: ' 大家好 ',
  messageId: 'MSG_2',
  senderId: 'USER_2',
  groupOpenid: 'GROUP_1',
  timestamp: 'not-a-date',
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  replyTarget: { scope: 'group', targetId: 'GROUP_1', msgId: 'MSG_2' },
})
check('群聊入站映射', group?.kind === 'group' && group.chatId === 'GROUP_1' && group.text === '大家好', group)
check('坏时间戳回退', Number.isFinite(group?.timestampMs), group?.timestampMs)
check('guild 消息忽略', mapInboundMessage({ kind: 'guild', content: 'x' }) === undefined)
check('空 chatId 忽略', mapInboundMessage({ kind: 'c2c', content: 'x', replyTarget: {} }) === undefined)

const passive = buildReplyTarget({ kind: 'dm', chatId: 'USER_1', msgId: 'MSG_1' })
check('被动回复 target', passive.scope === 'c2c' && passive.targetId === 'USER_1' && passive.msgId === 'MSG_1', passive)
const active = buildReplyTarget({ kind: 'group', chatId: 'GROUP_1', msgId: null })
check('主动消息 target 无 msgId', active.scope === 'group' && active.targetId === 'GROUP_1' && active.msgId === undefined, active)
let targetThrew = false
try { buildReplyTarget({ kind: 'dm', chatId: '' }) } catch { targetThrew = true }
check('缺 chatId 抛错', targetThrew)

const fakeLog = () => {}
const sdk = new SdkClient({ log: fakeLog, getConfig: () => ({ appId: '1', appSecret: 'x' }) })
check('SDK 客户端初始离线', sdk.status().online === false && sdk.status().impl === 'sdk', sdk.status())
const dispatcher = new Dispatcher({ log: fakeLog, getConfig: () => ({ channelImpl: 'legacy' }) })
check('legacy 开关生效', dispatcher.status().impl === 'legacy', dispatcher.status())

// SDK 能真正构造（不 start，不发网络请求）
const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
const bot = new QQBot({ appId: '1', appSecret: 'x', logger: fakeLog })
check('SDK QQBot 可构造', !!bot && typeof bot.start === 'function' && typeof bot.sendText === 'function')
check('SDK 提供主动消息与媒体', typeof bot.sendWakeup === 'function' && typeof bot.sendMedia === 'function')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
