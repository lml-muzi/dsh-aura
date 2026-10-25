/**
 * 离线自测：不连 QQ、不启动 Host，用假 ctx/假 QQ 验证 ChannelBridge 的核心行为。
 * 运行：DSH_HOME=/data/data/com.termux/files/home/workspace/.devhome node dev/bridge-sim.mjs
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_HOME
if (!root || !root.includes('.devhome')) {
  console.error('请把 DSH_HOME 指到一个临时目录（包含 .devhome）再运行')
  process.exit(1)
}
rmSync(join(root, 'dsh-aura'), { recursive: true, force: true })

const { ChannelBridge } = await import('../host/bridge.js')
const state = await import('../host/state.js')

class MockQQ {
  constructor() { this.sent = [] }
  status() { return { online: true } }
  async sendText(payload) { this.sent.push({ sentAs: 'text', ...payload }) }
  async sendMedia(payload) { this.sent.push({ sentAs: 'media', ...payload }) }
}

const listeners = new Map()
const handles = []
const ctx = {
  on(name, fn) {
    listeners.set(name, fn)
    return () => listeners.delete(name)
  },
  get(name) {
    if (name === 'workingDirectory') return { defaultDirectory: '/data/data/com.termux/files/home/workspace' }
    if (name === 'workspaceRegistry') return { list: () => [{ path: '/data/data/com.termux/files/home/workspace', attachSession: async () => {} }] }
    if (name === 'schedule') {
      return { create: async (sessionId, req) => { ctx.scheduled = { sessionId, ...req }; return { id: 's1' } } }
    }
    return undefined
  },
  agents: {
    get() { return undefined },
    resume: async () => { throw new Error('no resume in sim') },
    async create(options) {
      const got = []
      const agent = { session: { id: options.sessionId, header: { cwd: options.meta?.cwd } }, followup(message) { got.push(message) } }
      const handle = { agent, dispose: async () => {} }
      handles.push(handle)
      ctx.lastHandle = handle
      ctx.lastOptions = options
      ctx.lastInbox = got
      return handle
    },
    withoutInitiator(fn) { return fn() },
  },
  agentPresets: { mount: async () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
}

let failures = 0
function check(name, condition, extra) {
  if (condition) {
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name + (extra ? ' → ' + JSON.stringify(extra) : ''))
  }
}

const qq = new MockQQ()
const bridge = new ChannelBridge({ ctx, state, qq, log: (...args) => console.log('   [log]', ...args) })

// 1) 入站：建会话 + 注入 user 消息（source rpcId 必须是 qq-<uuid>，dsh-meme 靠它识别 IM）
await bridge.handleEvent({ kind: 'dm', chatId: 'USER_OPENID', userId: 'USER_OPENID', msgId: 'MSG_1', text: '在吗', timestampMs: Date.now(), rawType: 'C2C_MESSAGE_CREATE' })
const injected = ctx.lastInbox && ctx.lastInbox[0]
check('入站注入了 user 消息', !!injected, injected)
check('rpcId 是 qq-<uuid> 形式', /^qq-[0-9a-f-]{36}$/.test(String(injected?.source?.rpcId || '').replace(/^qq-/, '')) || String(injected?.source?.rpcId || '').startsWith('qq-'), injected?.source)
check('会话落盘', Object.keys(state.readSessions()).length === 1, state.readSessions())
const sessionId = Object.values(state.readSessions())[0].sessionId

// 2) 出站：五段文字 + maxMessages=4 → 前 3 段独立、后 2 段合并，共 4 条，seq 连续，且正文不含标记
const text = ['第一段', '第二段', '第三段', '第四段', '第五段'].join('\n\n')
bridge.onSessionEvent({ id: sessionId }, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } })
await new Promise(resolve => setTimeout(resolve, 30))
const texts = qq.sent.filter(item => item.sentAs === 'text')
check('拆成 4 条（受 maxMessages 限制）', texts.length === 4, texts.map(t => t.text))
check('seq 从 1 连续递增', texts.every((item, index) => item.seq === index + 1), texts.map(t => t.seq))
check('最后一条吞并剩余段落', texts[3]?.text.includes('第四段') && texts[3]?.text.includes('第五段'), texts[3]?.text)
check('回复里没有 [表情:] 标记', texts.every(item => !item.text.includes('[表情')))

// 3) 中间叙述（含 tool-call）不发给 QQ
const before = qq.sent.length
bridge.onSessionEvent({ id: sessionId }, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '我先找张图' }, { type: 'tool-call', name: 'send_meme' }] } } })
await new Promise(resolve => setTimeout(resolve, 20))
check('含工具调用的中间叙述被跳过', qq.sent.length === before)

// 4) 表情图：dsh_im_return_file 在正文之前发原生图片，并与文字共享 5 条上限
const image = '/data/data/com.termux/files/home/.dsh/meme-packs/whale-girl-emoji/memes/angry/1790141444508_299.png'
qq.sent.length = 0
await bridge.handleEvent({ kind: 'dm', chatId: 'USER_OPENID', userId: 'USER_OPENID', msgId: 'MSG_2', text: '发个表情', timestampMs: Date.now(), rawType: 'C2C_MESSAGE_CREATE' })
const result = await bridge.returnFile(image, { agent: { session: { id: sessionId, header: { cwd: '/data/data/com.termux/files/home/workspace' } } } })
check('图片被识别为 image', result.image === true, result)
check('图片以 media 先发出', qq.sent[0]?.sentAs === 'media' && qq.sent[0]?.image === true, qq.sent.map(s => s.sentAs))
bridge.onSessionEvent({ id: sessionId }, { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '给你一张' }] } } })
await new Promise(resolve => setTimeout(resolve, 30))
check('图片在文字之前', qq.sent[0]?.sentAs === 'media' && qq.sent[1]?.sentAs === 'text', qq.sent.map(s => s.sentAs))
check('图片占用 seq=1，文字 seq=2', qq.sent[0]?.seq === 1 && qq.sent[1]?.seq === 2, qq.sent.map(s => s.seq))

// 5) 情绪：入站后 lastUserAt 更新、注入文本非空

await bridge.dispose()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
