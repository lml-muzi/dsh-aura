/**
 * QQ 协议客户端离线自测：不联网、不建真实 WebSocket、不 identify。
 *
 * 覆盖：
 * - 入站解析（私聊/群聊/@ 前缀/字段缺失/无文本/msg_elements 文字/timestamp 兜底）
 * - markdown 方言整理、纯文本回退、2000 码点截断（emoji 不切代理对）
 * - err_code 读取与 markdown 拒绝判定（50055/50056/50057；超时 code=23 不误判）
 * - token 缓存/过期刷新/appId 变更/401 重取重试
 * - sendText：markdown → 纯文本回退、msg_seq、被动 msg_id、主动消息失败错误
 * - sendMedia：file_type 判定、base64 上传、msg_type=7、上传被拒退回 file_type=4
 * - WebSocket：Hello→Identify、心跳、READY、dispatch→onEvent、无文本忽略、op 7 重连、stop 清理
 * - 超时与缺凭据的可读错误
 *
 * 运行（在插件目录下，可重复执行）：node dev/qq-selftest.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */
import {
  QQClient,
  parseInbound,
  cleanQqText,
  prepareQqMarkdown,
  toQqPlainText,
  convertQqTables,
  clampQqMarkdown,
  readQqErrCode,
  isQqMarkdownRejection,
  qqUploadFileType,
  looksLikeImageBytes,
} from '../host/qq-legacy.js'

let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
    return
  }
  failures.push({ name, detail })
  const suffix = detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`  FAIL ${name}${suffix}`)
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

function section(title) {
  console.log(`\n[${title}]`)
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 替换全局 fetch，记录每次请求（url/init/解析后的 JSON body）。 */
function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const entry = { url: String(url), init, body: undefined }
    if (typeof init.body === 'string') {
      try { entry.body = JSON.parse(init.body) } catch { entry.body = init.body }
    }
    calls.push(entry)
    return handler(entry)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const quiet = () => {}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 带 deadline 的等待：AbortSignal.timeout 的计时器是 unref 的，测试里需要 ref 计时器撑住事件循环。 */
function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超过 ${ms}ms 未完成`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

// ---------------------------------------------------------------------------
section('入站解析')
// ---------------------------------------------------------------------------
const dm = parseInbound('C2C_MESSAGE_CREATE', {
  id: 'm1',
  content: '  <@!abc> 你好\r\n世界  ',
  author: { user_openid: 'u1' },
  timestamp: '2026-10-25T08:00:00.000Z',
})
ok('私聊事件非空', Boolean(dm))
eq('私聊 kind', dm?.kind, 'dm')
eq('私聊 chatId 用 user_openid', dm?.chatId, 'u1')
eq('私聊 userId', dm?.userId, 'u1')
eq('私聊 msgId', dm?.msgId, 'm1')
eq('私聊 text 去 <@id> 并统一换行', dm?.text, '你好\n世界')
eq('私聊 timestampMs', dm?.timestampMs, Date.parse('2026-10-25T08:00:00.000Z'))
eq('私聊 rawType', dm?.rawType, 'C2C_MESSAGE_CREATE')

const group = parseInbound('GROUP_AT_MESSAGE_CREATE', {
  id: 'm2',
  content: '@小助手 在吗',
  author: { member_openid: 'mem1', id: 'fallback-id', username: '张三' },
  group_openid: 'grp1',
  timestamp: '2026-10-25T08:01:00.000Z',
})
eq('群聊 kind', group?.kind, 'group')
eq('群聊 chatId 用 group_openid', group?.chatId, 'grp1')
eq('群聊 userId 用 member_openid', group?.userId, 'mem1')
eq('群聊 text 去行首 @昵称', group?.text, '在吗')

ok('字段不全返回 null', parseInbound('C2C_MESSAGE_CREATE', { id: 'x' }) === null)
ok('未知事件类型返回 null', parseInbound('AT_MESSAGE_CREATE', { id: 'x' }) === null)

const mediaOnly = parseInbound('C2C_MESSAGE_CREATE', {
  id: 'm3',
  content: '',
  author: { user_openid: 'u1' },
  timestamp: '2026-10-25T08:00:00.000Z',
})
eq('纯媒体消息 text 为空串', mediaOnly?.text, '')

const elementsOnly = parseInbound('C2C_MESSAGE_CREATE', {
  id: 'm4',
  content: '',
  msg_elements: [{ content: '来自富媒体的文字' }],
  author: { user_openid: 'u1' },
  timestamp: '2026-10-25T08:00:00.000Z',
})
eq('msg_elements 里的文字被提取', elementsOnly?.text, '来自富媒体的文字')

const noStamp = parseInbound('C2C_MESSAGE_CREATE', { id: 'm5', content: 'hi', author: { user_openid: 'u1' } })
ok('无 timestamp 时 timestampMs 兜底为数字', typeof noStamp?.timestampMs === 'number' && noStamp.timestampMs > 0)
eq('cleanQqText 保留正文多行', cleanQqText('第一行\n第二行'), '第一行\n第二行')

// ---------------------------------------------------------------------------
section('markdown 方言 / 纯文本回退 / 截断')
// ---------------------------------------------------------------------------
const sample = '### 三级标题\n\n正文 **粗体**\n\n```js\nconst a = 1\n```\n\n| 名称 | 值 |\n|---|---|\n| 苹果 | 3 |\n| 梨 | 5 |\n'
const md = prepareQqMarkdown(sample)
ok('去代码围栏', !md.includes('```'), md)
ok('代码内容保留', md.includes('const a = 1'), md)
ok('三级标题收成 ##', md.includes('## 三级标题'), md)
ok('表格保留管道（markdown 能渲染）', md.includes('| 名称 | 值 |') && md.includes('| 苹果 | 3 |'), md)
eq('正文里的 ### 不误伤', prepareQqMarkdown('正文 ### 不是标题'), '正文 ### 不是标题')
eq('CRLF 统一成 LF', prepareQqMarkdown('a\r\nb'), 'a\nb')

const plain = toQqPlainText('### 标题\n\n**粗体** 和 `代码`\n\n| 名称 | 值 |\n|---|---|\n| 苹果 | 3 |\n\n[链接](https://example.com/a)\n- 项目')
ok('纯文本去掉标题标记', !plain.includes('#'), plain)
ok('纯文本去粗体标记', plain.includes('粗体') && !plain.includes('**'), plain)
ok('纯文本去反引号', plain.includes('代码') && !plain.includes('`'), plain)
ok('纯文本表格降级成列表', plain.includes('· 名称') && plain.includes('· 苹果（值：3）'), plain)
ok('纯文本链接转括号', plain.includes('链接（https://example.com/a）'), plain)
ok('纯文本列表符号换成 ·', plain.includes('· 项目'), plain)
eq('convertQqTables 保留普通行', convertQqTables('普通一行'), '普通一行')

eq('2000 码点截断', Array.from(clampQqMarkdown('字'.repeat(2500))).length, 2000)
eq('emoji 按码点截断不切代理对', Array.from(clampQqMarkdown('😀'.repeat(2500))).length, 2000)
eq('未超长原样返回', clampQqMarkdown('短文本'), '短文本')

// ---------------------------------------------------------------------------
section('错误码与 markdown 回退判定')
// ---------------------------------------------------------------------------
eq('readQqErrCode 字符串体', readQqErrCode('{"err_code":50056}'), 50056)
eq('readQqErrCode 对象字符串 code', readQqErrCode({ code: '50055' }), 50055)
eq('readQqErrCode 非 JSON 返回 undefined', readQqErrCode('oops'), undefined)
eq('readQqErrCode 非整数 code 返回 undefined', readQqErrCode({ code: 'abc' }), undefined)
ok('50055/50056/50057 判定为 markdown 拒绝', [50055, 50056, 50057].every(code => isQqMarkdownRejection({ errCode: code })))
ok('其他 err_code 不判定为 markdown 拒绝', !isQqMarkdownRejection({ errCode: 50000 }))
ok('超时错误（code=23）不判定为 markdown 拒绝', !isQqMarkdownRejection(Object.assign(new Error('timeout'), { code: 23 })))
ok('无 errCode 的普通错误不判定', !isQqMarkdownRejection(new Error('network')))

// ---------------------------------------------------------------------------
section('富媒体 file_type 判定')
// ---------------------------------------------------------------------------
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
eq('png 魔数 → 1', qqUploadFileType('x.bin', pngHeader), 1)
eq('mp4 魔数 → 2', qqUploadFileType('x.bin', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')])), 2)
eq('jpg 扩展名 → 1', qqUploadFileType('a.JPG', Buffer.from('not-really-image')), 1)
eq('mp4 扩展名 → 2', qqUploadFileType('a.mp4', Buffer.from('...')), 2)
eq('普通文件 → 4', qqUploadFileType('a.pdf', Buffer.from('hello world')), 4)
ok('looksLikeImageBytes 识别 jpeg', looksLikeImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
ok('looksLikeImageBytes 拒绝文本', !looksLikeImageBytes(Buffer.from('plain text')))

// ---------------------------------------------------------------------------
section('token 缓存 / 过期刷新 / appId 变更 / 未启动拦截')
// ---------------------------------------------------------------------------
{
  let config = { appId: 'app-1', appSecret: 'secret-1' }
  let tokenCount = 0
  const fetchState = installFetch(async entry => {
    if (entry.url.includes('getAppAccessToken')) {
      tokenCount += 1
      return jsonResponse({ access_token: `tok-${tokenCount}`, expires_in: 7200 })
    }
    if (entry.url.endsWith('/v2/users/u1/messages')) return jsonResponse({ id: `out-${entry.body.msg_seq}` })
    throw new Error(`unexpected url ${entry.url}`)
  })
  try {
    const client = new QQClient({ getConfig: () => config, log: quiet })
    let blocked = null
    try {
      await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 1, text: 'hi' })
    } catch (error) { blocked = error }
    ok('未连接时发送抛出可读错误', blocked instanceof Error && /未连接/.test(blocked.message), blocked && blocked.message)

    client.stopped = false // 白盒：不 start（会真连 WS），只测出站
    const beforeEmpty = fetchState.calls.length
    await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 1, text: '   ' })
    eq('空白文本不发请求', fetchState.calls.length, beforeEmpty)

    await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 2, text: '**你好**\n\n### 小标题' })
    eq('首次发送取一次 token', tokenCount, 1)
    const first = fetchState.calls.find(call => call.url.endsWith('/v2/users/u1/messages'))
    eq('markdown 走 msg_type=2', first.body.msg_type, 2)
    eq('被动回复带 msg_id', first.body.msg_id, 'm1')
    eq('msg_seq 采用调用方 seq', first.body.msg_seq, 2)
    ok('markdown 内容整理过（### → ##）', first.body.markdown.content.includes('## 小标题'), first.body.markdown.content)
    ok('markdown 保留粗体', first.body.markdown.content.includes('**你好**'), first.body.markdown.content)
    eq('请求带 QQBot 鉴权头', first.init.headers.authorization, 'QQBot tok-1')
    eq('请求 content-type', first.init.headers['content-type'], 'application/json')

    await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 3, text: '第二条' })
    eq('token 缓存复用（不再请求 token）', tokenCount, 1)
    const second = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u1/messages'))[1]
    eq('第二条 msg_seq=3', second.body.msg_seq, 3)

    client.tokenExpireAt = Date.now() - 1
    await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 4, text: '第三条' })
    eq('token 过期后重新获取', tokenCount, 2)

    config = { appId: 'app-2', appSecret: 'secret-2' }
    await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 5, text: '第四条' })
    eq('appId 变更后重新获取 token', tokenCount, 3)
  } finally {
    fetchState.restore()
  }
}

// ---------------------------------------------------------------------------
section('markdown 被拒 → 纯文本回退')
// ---------------------------------------------------------------------------
{
  const fetchState = installFetch(async entry => {
    if (entry.url.includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-md', expires_in: 7200 })
    if (entry.url.endsWith('/v2/users/u2/messages')) {
      if (entry.body.msg_type === 2) return jsonResponse({ err_code: 50056, message: 'markdown not allowed' }, 400)
      return jsonResponse({ id: 'out-plain' })
    }
    throw new Error(`unexpected url ${entry.url}`)
  })
  try {
    const client = new QQClient({ getConfig: () => ({ appId: 'a', appSecret: 's' }), log: quiet })
    client.stopped = false
    await client.sendText({
      kind: 'dm',
      chatId: 'u2',
      msgId: 'm2',
      seq: 1,
      text: '### 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    })
    const messageCalls = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u2/messages'))
    eq('markdown 被拒后共两次请求', messageCalls.length, 2)
    eq('第一次 msg_type=2', messageCalls[0].body.msg_type, 2)
    eq('回退 msg_type=0', messageCalls[1].body.msg_type, 0)
    ok('回退内容无 markdown 标记', !messageCalls[1].body.content.includes('###') && !messageCalls[1].body.content.includes('|'), messageCalls[1].body.content)
    eq('回退保留 msg_id', messageCalls[1].body.msg_id, 'm2')
    eq('回退复用同一 msg_seq', messageCalls[1].body.msg_seq, 1)
    eq('50056 后 markdown 被禁用', client.markdownDisabled, true)

    await client.sendText({ kind: 'dm', chatId: 'u2', msgId: 'm2', seq: 2, text: '第三条' })
    const afterDisable = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u2/messages'))
    eq('禁用后只发一次请求', afterDisable.length, 3)
    eq('禁用后直接 msg_type=0', afterDisable[2].body.msg_type, 0)
  } finally {
    fetchState.restore()
  }
}

// ---------------------------------------------------------------------------
section('群聊路由 / 被动 vs 主动消息 / 401 重试')
// ---------------------------------------------------------------------------
{
  let messageCount = 0
  let tokenCount = 0
  const fetchState = installFetch(async entry => {
    if (entry.url.includes('getAppAccessToken')) {
      tokenCount += 1
      return jsonResponse({ access_token: `tok-${tokenCount}`, expires_in: 7200 })
    }
    if (entry.url.endsWith('/v2/groups/grp1/messages')) return jsonResponse({ id: 'out-group' })
    if (entry.url.endsWith('/v2/users/u3/messages')) {
      messageCount += 1
      if (messageCount === 1) return jsonResponse({ message: 'token expired' }, 401)
      if (messageCount === 2) return jsonResponse({ id: 'out-u3' })
      return jsonResponse({ err_code: 40034101, message: 'no permission' }, 400)
    }
    throw new Error(`unexpected url ${entry.url}`)
  })
  try {
    const client = new QQClient({ getConfig: () => ({ appId: 'a', appSecret: 's' }), log: quiet })
    client.stopped = false

    await client.sendText({ kind: 'group', chatId: 'g:grp1', msgId: 'm3', seq: 1, text: '群消息' })
    const groupCall = fetchState.calls.find(call => call.url.endsWith('/v2/groups/grp1/messages'))
    ok('群聊路径剥掉 g: 前缀', Boolean(groupCall))
    eq('群聊带 msg_id', groupCall.body.msg_id, 'm3')

    // 第一次 401 → 重取 token 后重试，第二次请求成功
    await client.sendText({ kind: 'dm', chatId: 'u3', msgId: 'm4', seq: 1, text: '401 重试' })
    eq('401 后重新取 token', tokenCount, 2)
    eq('401 后重试发送成功', messageCount, 2)
    const retried = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u3/messages'))[1]
    eq('重试请求用新 token', retried.init.headers.authorization, 'QQBot tok-2')

    // 主动消息（无 msg_id）失败要给可读错误
    let error = null
    try {
      await client.sendText({ kind: 'dm', chatId: 'u3', msgId: null, seq: 1, text: '主动消息' })
    } catch (caught) { error = caught }
    ok('主动消息失败抛出可读错误', error instanceof Error, error && error.message)
    ok('错误提示没有被动回复 msg_id', /msg_id/.test(error ? error.message : ''), error && error.message)
    eq('错误保留 errCode', error ? error.errCode : undefined, 40034101)
    const activeCall = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u3/messages'))[2]
    ok('主动消息不带 msg_id 字段', activeCall && activeCall.body.msg_id === undefined, activeCall && activeCall.body)
  } finally {
    fetchState.restore()
  }
}

// ---------------------------------------------------------------------------
section('sendMedia：图片/文件/上传被拒回退')
// ---------------------------------------------------------------------------
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const fetchState = installFetch(async entry => {
    if (entry.url.includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-media', expires_in: 7200 })
    if (entry.url.endsWith('/v2/users/u4/files')) return jsonResponse({ file_info: 'FILE-INFO-1' })
    if (entry.url.endsWith('/v2/users/u4/messages')) return jsonResponse({ id: 'out-media' })
    throw new Error(`unexpected url ${entry.url}`)
  })
  try {
    const client = new QQClient({ getConfig: () => ({ appId: 'a', appSecret: 's' }), log: quiet })
    client.stopped = false
    await client.sendMedia({ kind: 'dm', chatId: 'u4', msgId: 'm4', seq: 4, bytes: png, name: 'face.png', image: true })
    const upload = fetchState.calls.find(call => call.url.endsWith('/v2/users/u4/files'))
    eq('图片 file_type=1', upload.body.file_type, 1)
    eq('上传 srv_send_msg=false', upload.body.srv_send_msg, false)
    eq('上传文件名', upload.body.file_name, 'face.png')
    eq('上传内容 base64 一致', Buffer.from(upload.body.file_data, 'base64').equals(png), true)
    const send = fetchState.calls.find(call => call.url.endsWith('/v2/users/u4/messages'))
    eq('媒体消息 msg_type=7', send.body.msg_type, 7)
    eq('媒体消息带 file_info', send.body.media.file_info, 'FILE-INFO-1')
    eq('媒体消息带 msg_id', send.body.msg_id, 'm4')
    eq('媒体消息带 msg_seq', send.body.msg_seq, 4)

    fetchState.calls.length = 0
    await client.sendMedia({ kind: 'dm', chatId: 'u4', msgId: 'm4', seq: 5, bytes: Buffer.from('plain text file'), name: 'note.txt' })
    const uploads = fetchState.calls.filter(call => call.url.endsWith('/v2/users/u4/files'))
    eq('普通文件 file_type=4', uploads[0].body.file_type, 4)

    let emptyError = null
    try {
      await client.sendMedia({ kind: 'dm', chatId: 'u4', msgId: 'm4', seq: 6, bytes: Buffer.alloc(0), name: 'empty.png', image: true })
    } catch (error) { emptyError = error }
    ok('空内容媒体抛可读错误', emptyError instanceof Error && /为空/.test(emptyError.message), emptyError && emptyError.message)
  } finally {
    fetchState.restore()
  }

  // 上传被拒（file_type=1 失败）→ 退回 file_type=4 重试
  const fallbackState = installFetch(async entry => {
    if (entry.url.includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-fallback', expires_in: 7200 })
    if (entry.url.endsWith('/v2/users/u5/files')) {
      if (entry.body.file_type === 1) return jsonResponse({ err_code: 40034002, message: 'bad image' }, 400)
      return jsonResponse({ file_info: 'FILE-INFO-OK' })
    }
    if (entry.url.endsWith('/v2/users/u5/messages')) return jsonResponse({ id: 'out-fallback' })
    throw new Error(`unexpected url ${entry.url}`)
  })
  try {
    const client = new QQClient({ getConfig: () => ({ appId: 'a', appSecret: 's' }), log: quiet })
    client.stopped = false
    await client.sendMedia({ kind: 'dm', chatId: 'u5', msgId: 'm5', seq: 1, bytes: png, name: 'face.png', image: true })
    const uploads = fallbackState.calls.filter(call => call.url.endsWith('/v2/users/u5/files'))
    eq('上传被拒后重试一次', uploads.length, 2)
    eq('先尝试 file_type=1', uploads[0].body.file_type, 1)
    eq('回退 file_type=4', uploads[1].body.file_type, 4)
    const send = fallbackState.calls.find(call => call.url.endsWith('/v2/users/u5/messages'))
    eq('回退后仍用新 file_info 发 msg_type=7', send.body.media.file_info, 'FILE-INFO-OK')
  } finally {
    fallbackState.restore()
  }
}

// ---------------------------------------------------------------------------
section('配置错误 / 超时')
// ---------------------------------------------------------------------------
{
  const client = new QQClient({ getConfig: () => ({ appId: '', appSecret: '' }), log: quiet })
  let error = null
  try {
    await client.start()
  } catch (caught) { error = caught }
  ok('缺凭据 start 抛出可读错误', error instanceof Error && /AppID|AppSecret/.test(error.message), error && error.message)
  eq('配置错误不排重连', client.reconnectTimer, null)
  eq('配置错误后不算已启动（补好凭据可重连）', client.started, false)
  eq('缺凭据时状态为离线', client.status().online, false)
  await client.stop()
}

{
  const timeoutState = installFetch(entry => new Promise((resolve, reject) => {
    const signal = entry.init && entry.init.signal
    const fail = () => reject(signal && signal.reason ? signal.reason : new DOMException('aborted', 'AbortError'))
    if (!signal) return fail()
    if (signal.aborted) return fail()
    signal.addEventListener('abort', fail, { once: true })
  }))
  try {
    const client = new QQClient({ getConfig: () => ({ appId: 'a', appSecret: 's' }), httpTimeoutMs: 20, log: quiet })
    client.stopped = false
    let error = null
    try {
      await withDeadline(client.ensureToken(), 500, 'token 超时测试')
    } catch (caught) { error = caught }
    ok('token 请求超时抛出可读错误', error instanceof Error && /超时/.test(error.message), error && error.message)
  } finally {
    timeoutState.restore()
  }
}

// ---------------------------------------------------------------------------
section('WebSocket：Hello→Identify / 心跳 / READY / dispatch / op7 重连 / stop')
// ---------------------------------------------------------------------------
class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      if (this.onopen) this.onopen({})
    })
  }

  send(data) {
    const frame = JSON.parse(String(data))
    this.sent.push(frame)
    // 自动回 op 11 ack：测试里不制造假死判定
    if (frame.op === 1) queueMicrotask(() => this.emitServer({ op: 11 }))
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => {
      if (this.onclose) this.onclose({ code, reason })
      for (const listener of this.listeners.get('close') ?? []) listener({ code, reason })
    })
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emitServer(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) })
  }
}

{
  FakeWebSocket.instances = []
  const realWebSocket = globalThis.WebSocket
  const realFetch = globalThis.fetch
  const events = []
  const statuses = []
  const gatewayCalls = []

  globalThis.WebSocket = FakeWebSocket
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-ws', expires_in: 7200 })
    if (target.endsWith('/gateway')) {
      gatewayCalls.push(target)
      return jsonResponse({ url: 'wss://gateway.test/websocket/' })
    }
    throw new Error(`unexpected url ${target}`)
  }

  const client = new QQClient({
    getConfig: () => ({ appId: 'a', appSecret: 's' }),
    onEvent: event => events.push(event),
    onStatus: status => statuses.push(status),
    log: quiet,
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
    httpTimeoutMs: 500,
  })

  try {
    await client.start()
    await tick(5)
    eq('建立了 1 个 WS 连接', FakeWebSocket.instances.length, 1)
    const socket = FakeWebSocket.instances[0]
    eq('连接的是 /gateway 返回的 wss 地址', socket.url, 'wss://gateway.test/websocket/')
    eq('/gateway 只取一次', gatewayCalls.length, 1)

    socket.emitServer({ op: 10, d: { heartbeat_interval: 50 } })
    eq('收到 Hello 后发送 Identify（op=2）', socket.sent[0]?.op, 2)
    eq('Identify token 带 QQBot 前缀', socket.sent[0]?.d?.token, 'QQBot tok-ws')
    eq('Identify intents = 1<<25', socket.sent[0]?.d?.intents, 1 << 25)
    eq('Identify shard = [0,1]', socket.sent[0]?.d?.shard, [0, 1])

    await tick(1100) // 心跳间隔有 1000ms 下限（防呆），等一个周期多一点
    const heartbeats = socket.sent.filter(frame => frame.op === 1)
    ok('已发送心跳 op=1', heartbeats.length >= 1, { heartbeats: heartbeats.length })
    eq('心跳 d 为最近 s（尚无 dispatch 时为 null）', heartbeats[0]?.d, null)

    socket.emitServer({ op: 0, s: 7, t: 'READY', d: { user: { id: 'bot-openid-1' } } })
    eq('READY 后 ready=true', client.status().ready, true)
    eq('READY 后 online=true', client.status().online, true)
    eq('记录 botOpenId', client.status().botOpenId, 'bot-openid-1')
    ok('状态回调通知过 online=true', statuses.some(status => status.online === true))

    socket.emitServer({
      op: 0,
      s: 8,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'in-1', content: '你好', author: { user_openid: 'user-1' }, timestamp: '2026-10-25T08:00:00.000Z' },
    })
    await tick(5)
    eq('私聊 dispatch 交给 onEvent', events.length, 1)
    eq('事件 kind=dm', events[0]?.kind, 'dm')
    eq('事件 chatId', events[0]?.chatId, 'user-1')
    eq('事件 text', events[0]?.text, '你好')
    ok('事件更新 lastEventAt', client.status().lastEventAt > 0)

    socket.emitServer({
      op: 0,
      s: 9,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'in-2',
        content: '@机器人 在吗',
        author: { member_openid: 'member-1' },
        group_openid: 'group-1',
        timestamp: '2026-10-25T08:01:00.000Z',
      },
    })
    await tick(5)
    eq('群聊 dispatch 交给 onEvent', events.length, 2)
    eq('群聊事件 kind=group', events[1]?.kind, 'group')
    eq('群聊事件 chatId=group_openid', events[1]?.chatId, 'group-1')

    socket.emitServer({
      op: 0,
      s: 10,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'in-3', content: '   ', author: { user_openid: 'user-1' }, timestamp: '2026-10-25T08:02:00.000Z' },
    })
    await tick(5)
    eq('无文本消息被忽略（onEvent 不触发）', events.length, 2)

    socket.emitServer({ op: 7 })
    await tick(10)
    eq('op 7 后旧连接被关闭', socket.readyState, 3)
    eq('op 7 后 ready 复位', client.status().ready, false)
    ok('op 7 后已安排重连', client.reconnectTimer !== null || FakeWebSocket.instances.length === 2)
    await tick(80)
    eq('自动重连出第二个 WS 连接', FakeWebSocket.instances.length, 2)
    eq('重连后 ready 复位', client.status().ready, false)

    const socket2 = FakeWebSocket.instances[1]
    socket2.emitServer({ op: 10, d: { heartbeat_interval: 10_000 } })
    socket2.emitServer({ op: 0, s: 11, t: 'READY', d: { user: { id: 'bot-openid-1' } } })
    eq('重连后重新 READY', client.status().ready, true)

    await client.stop()
    await tick(10)
    eq('stop 后 online=false', client.status().online, false)
    eq('stop 后 ready=false', client.status().ready, false)
    eq('stop 后 ws 引用清空', client.ws, null)
    eq('stop 后心跳定时器清空', client.heartbeatTimer, null)
    eq('stop 后重连定时器清空', client.reconnectTimer, null)
    eq('stop 后 token 清空', client.token, '')
    eq('stop 关闭了 socket', socket2.readyState, 3)

    let sendAfterStop = null
    try {
      await client.sendText({ kind: 'dm', chatId: 'u1', msgId: 'm1', seq: 1, text: 'hi' })
    } catch (error) { sendAfterStop = error }
    ok('stop 后发送被拦截', sendAfterStop instanceof Error && /未连接/.test(sendAfterStop.message), sendAfterStop && sendAfterStop.message)
  } finally {
    globalThis.WebSocket = realWebSocket
    globalThis.fetch = realFetch
    await client.stop().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
const total = passed + failures.length
console.log(`\n${failures.length ? '❌' : '✅'} 自测完成：${passed}/${total} 通过，${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}${failure.detail === undefined ? '' : `: ${JSON.stringify(failure.detail)}`}`)
  }
  process.exitCode = 1
}
