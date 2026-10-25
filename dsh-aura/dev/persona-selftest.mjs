/**
 * dsh-aura 人设模块自测（node 直接跑）
 *   node dsh-aura/dev/persona-selftest.mjs
 *
 * 用临时 HOME / DSH_HOME 隔离，不读写真实的人设配置：
 *   默认值 / sanitize 拒绝非法值 / 提示词 zh/en 差异（昵称不再注入）/ 灵魂关闭不注入 /
 *   历史撤销 / 损坏配置 .corrupt 备份与拒写逃生 / set_persona 审批与待确认提议 /
 *   HTTP 路由 / system prompt 注入段。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as persona from '../host/persona.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-persona-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh-native')

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n${title}`)
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${(error && error.stack) || error}`)
  }
}

function fakeReq(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3080', ...headers }
  return stream
}

function fakeRes() {
  const out = { status: 0, body: null }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(data) {
      out.body = data && data.length ? JSON.parse(String(data)) : null
    },
  }
}

section('1. 默认值与数据路径')
await test('默认配置与 dsh-soul 一致', () => {
  assert.deepEqual(persona.getConfig(), { ...persona.DEFAULT_CONFIG })
  // Aura 里人设默认关闭，避免覆盖 Aura 自己的身份段；用户可在人设页开启
  assert.equal(persona.getConfig().enabled, false)
  assert.equal(persona.getConfig().style, 'professional')
  assert.equal(persona.getConfig().headingLists, 'default')
  assert.equal(persona.getConfig().emoji, 'default')
  assert.equal(persona.getConfig().tables, 'default')
  assert.equal(persona.getConfig().replyLength, 'normal')
  assert.equal(persona.getConfig().language, 'zh')
  assert.equal(persona.getConfig().trailColor, '#679EFE')
  assert.equal(persona.getConfig().trailSpeed, 'slow')
  assert.equal(persona.getConfig().trailWidth, 'thin')
  assert.equal(persona.getConfig().historyMaxEntries, 200)
  assert.equal(persona.personaFilePath(), join(home, '.dsh-native', 'dsh-aura', 'persona.json'))
  assert.equal(persona.personaHistoryPath(), join(home, '.dsh-native', 'dsh-aura', 'persona-history.jsonl'))
})

section('2. sanitize 校验')
await test('非法枚举 / 超长文本 / 坏颜色整单拒绝且不落盘', async () => {
  const before = persona.getConfig()
  const badStyle = await persona.setConfig({ style: 'sarcastic' })
  assert.equal(badStyle.ok, false)
  assert.ok(badStyle.errors.style)
  assert.deepEqual(persona.getConfig(), before)

  const tooLong = await persona.setConfig({ bio: 'x'.repeat(persona.FIELD_LIMITS.bio + 1) })
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.errors.bio)

  const badColor = await persona.setConfig({ trailColor: 'red' })
  assert.equal(badColor.ok, false)
  assert.ok(badColor.errors.trailColor)

  const badBool = await persona.setConfig({ enabled: 'yes' })
  assert.equal(badBool.ok, false)
  assert.ok(badBool.errors.enabled)

  assert.deepEqual(persona.getConfig(), before)
})

await test('historyMaxEntries 夹取到 50..500', async () => {
  const low = await persona.setConfig({ historyMaxEntries: 10 })
  assert.equal(low.ok, true)
  assert.equal(persona.getConfig().historyMaxEntries, 50)
  const high = await persona.setConfig({ historyMaxEntries: 9999 })
  assert.equal(high.ok, true)
  assert.equal(persona.getConfig().historyMaxEntries, 500)
  const bad = await persona.setConfig({ historyMaxEntries: 1.5 })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.historyMaxEntries)
  await persona.setConfig({ historyMaxEntries: 200 })
})

await test('trailColor 统一大写保存', async () => {
  const result = await persona.setConfig({ trailColor: '#abcdef' })
  assert.equal(result.ok, true)
  assert.equal(persona.getConfig().trailColor, '#ABCDEF')
})

section('3. 提示词编译器（zh / en / 禁用 / 关于你）')
await test('zh/en 文案不同，且自定义指令与用户背景都进入提示词', () => {
  const base = { ...persona.DEFAULT_CONFIG, enabled: true, style: 'casual', customInstructions: '保持简短' }
  const zh = persona.compilePersonaPrompt({ ...base, language: 'zh' })
  const en = persona.compilePersonaPrompt({ ...base, language: 'en' })
  assert.ok(zh.includes('[回复风格]'))
  assert.ok(zh.includes('保持简短'))
  assert.ok(en.includes('[Reply style]'))
  assert.ok(en.includes('保持简短'))
  assert.notEqual(zh, en)

  const profile = persona.compilePersonaPrompt({
    ...base,
    language: 'zh',
    nickname: '木子',
    occupation: '测试工程师',
    bio: '喜欢听歌',
  })
  assert.ok(profile.includes('[用户背景]'))
  assert.ok(!profile.includes('木子'))
  assert.ok(!profile.includes('昵称'))
  assert.ok(profile.includes('职业：测试工程师'))
  assert.ok(profile.includes('用户自述：喜欢听歌'))

  // 表达层优先级说明：中文/英文各一份，且位于提示词开头（身份段由灵魂负责）。
  assert.ok(zh.startsWith('以下只描述你说话的方式与你的用户背景'))
  assert.ok(zh.includes('与身份段冲突时以身份段为准'))
  assert.ok(en.startsWith('The following only describes how you speak'))
  assert.ok(en.includes('identity section wins'))

  // 只填昵称：不再产生任何昵称文案。
  const nicknameOnly = persona.compilePersonaPrompt({ ...base, language: 'zh', nickname: '木子', occupation: '', bio: '' })
  assert.ok(!nicknameOnly.includes('木子'))

  assert.equal(persona.compilePersonaPrompt({ ...base, enabled: false }), '')
})

section('4. initPersona / 注入段 / 路由 / 工具注册')
const captured = { sections: [], routes: null, tools: [], effects: 0 }
let approvalService = null
// 模拟 Host 配置：section 文本每次求值都会读一次，便于验证灵魂总开关。
const soulState = {
  soulEnabled: true,
  readConfig() {
    return { soulEnabled: soulState.soulEnabled }
  },
}

const fakeCtx = {
  systemPrompt: {
    section(options) {
      captured.sections.push(options)
      return () => {}
    },
  },
  webServer: {
    register(definition) {
      captured.routes = definition
      return () => {}
    },
  },
  tools: {
    register(tool) {
      captured.tools.push(tool)
      return () => {}
    },
  },
  get(name) {
    return name === 'approval' ? approvalService : undefined
  },
  effect(fn) {
    captured.effects += 1
    return fn()
  },
}

const instance = persona.initPersona({ ctx: fakeCtx, state: soulState, log: () => {} })

await test('返回 { dispose, getConfig, setConfig, snapshot, compilePrompt }', () => {
  assert.equal(typeof instance.dispose, 'function')
  assert.equal(typeof instance.getConfig, 'function')
  assert.equal(typeof instance.setConfig, 'function')
  assert.equal(typeof instance.snapshot, 'function')
  assert.equal(typeof instance.compilePrompt, 'function')
  assert.equal(instance.compilePrompt().length, 0)
})

await test('system prompt 注入段 order=25 已停用（并入灵魂自由内容）', () => {
  assert.equal(captured.sections.length, 1)
  const section = captured.sections[0]
  assert.equal(section.name, 'aura:persona')
  assert.equal(section.order, 25)
  assert.equal(section.interpolate, false)
  // 旧风格注入已停用：section 永远为空，编译器仍供 /preview 使用。
  assert.equal(section.text(), '')
  assert.ok(persona.compilePersonaPrompt({ ...persona.getConfig(), enabled: true }).length > 0)
})

await test('section 停用后无论灵魂开关都不注入', async () => {
  const enabled = await persona.setConfig({ enabled: true })
  assert.equal(enabled.ok, true)
  soulState.soulEnabled = false
  assert.equal(captured.sections[0].text(), '')
  soulState.soulEnabled = true
  assert.equal(captured.sections[0].text(), '')
  await persona.setConfig({ enabled: false })
})

await test('HTTP 注册为 /dsh-aura/persona-api 前缀；set_persona 工具已移除', () => {
  assert.ok(captured.routes)
  assert.equal(captured.routes.kind, 'prefix')
  assert.equal(captured.routes.path, '/dsh-aura/persona-api')
  assert.equal(typeof captured.routes.handler, 'function')
  assert.equal(captured.tools.length, 0)
})

section('5. 人设预设')
await test('保存「关于你」与人格字段', async () => {
  const result = await persona.setConfig({
    nickname: '木子',
    occupation: '测试工程师',
    bio: '喜欢听歌与瞎折腾',
    style: 'casual',
    emoji: 'more',
    language: 'en',
    customInstructions: '保持简短',
  })
  assert.equal(result.ok, true)
  assert.equal(persona.getConfig().nickname, '木子')
})

await test('内置预设 7 个且不可删除 / 不可同名保存', async () => {
  const list = persona.snapshot().presetList.filter((item) => item.builtin)
  assert.equal(list.length, 7)
  assert.deepEqual(
    list.map((item) => item.id),
    ['苏格拉底式提问者', '极简主义者', '资深架构师', '教学型讲解者', '严格代码审阅者', '头脑风暴伙伴', '自驱型协作者'],
  )
  const del = await persona.deletePreset('极简主义者')
  assert.equal(del.ok, false)
  const save = await persona.savePreset('极简主义者')
  assert.equal(save.ok, false)
})

await test('应用内置预设不动昵称 / 职业 / 介绍', async () => {
  const identity = {
    nickname: persona.getConfig().nickname,
    occupation: persona.getConfig().occupation,
    bio: persona.getConfig().bio,
  }
  const result = await persona.applyPreset('极简主义者')
  assert.equal(result.ok, true)
  const config = persona.getConfig()
  assert.equal(config.nickname, identity.nickname)
  assert.equal(config.occupation, identity.occupation)
  assert.equal(config.bio, identity.bio)
  assert.equal(config.style, 'efficient')
  assert.equal(config.replyLength, 'concise')
  assert.equal(result.historyEntry.preset, '极简主义者')
})

await test('自建预设只快照风格 / 特质 / 长度 / 语言 / 自定义指令', async () => {
  await persona.setConfig({
    style: 'humorous',
    headingLists: 'more',
    emoji: 'more',
    tables: 'default',
    replyLength: 'normal',
    language: 'zh',
    customInstructions: '预设指令',
  })
  const saved = await persona.savePreset('我的预设')
  assert.equal(saved.ok, true)

  const entry = persona.snapshot().presets['我的预设']
  assert.ok(entry)
  for (const field of persona.PROFILE_FIELDS) assert.equal(entry[field], undefined)
  assert.equal(entry.style, 'humorous')
  assert.equal(entry.language, 'zh')

  const disk = JSON.parse(readFileSync(persona.personaFilePath(), 'utf8'))
  for (const field of persona.PROFILE_FIELDS) assert.equal(disk.personas['我的预设'][field], undefined)

  await persona.setConfig({ style: 'casual' })
  const applied = await persona.applyPreset('我的预设')
  assert.equal(applied.ok, true)
  assert.equal(persona.getConfig().style, 'humorous')
  assert.equal(persona.getConfig().nickname, '木子')
  assert.equal(persona.getConfig().occupation, '测试工程师')

  const deleted = await persona.deletePreset('我的预设')
  assert.equal(deleted.ok, true)
  assert.equal(persona.snapshot().presets['我的预设'], undefined)
})

section('7. HTTP 路由')
await test('GET /state 返回 config/presets/presetList/historyCount/configError', async () => {
  await persona.setConfig({ style: 'casual' })
  const res = fakeRes()
  await captured.routes.handler(fakeReq('GET', '/dsh-aura/persona-api/state'), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.equal(res.out.body.config.style, 'casual')
  assert.ok(res.out.body.presets['极简主义者'].builtin)
  assert.equal(res.out.body.presetList.filter((item) => item.builtin).length, 7)
  assert.equal(typeof res.out.body.historyCount, 'number')
  assert.equal(res.out.body.configError, null)
  assert.equal(Array.isArray(res.out.body.history), true)
})

await test('POST /preview 用同一编译器编译草稿', async () => {
  const res = fakeRes()
  await captured.routes.handler(fakeReq('POST', '/dsh-aura/persona-api/preview', {
    config: { enabled: true, language: 'en', style: 'humorous' },
  }), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.ok(res.out.body.prompt.includes('[Reply style]'))
  assert.deepEqual(res.out.body.invalid, [])
})

await test('POST /save 保存并返回提示词；非法字段 400', async () => {
  const okRes = fakeRes()
  await captured.routes.handler(fakeReq('POST', '/dsh-aura/persona-api/save', {
    config: { style: 'professional' },
    source: 'web',
  }), okRes)
  assert.equal(okRes.out.status, 200)
  assert.equal(okRes.out.body.ok, true)
  assert.equal(persona.getConfig().style, 'professional')

  const badRes = fakeRes()
  await captured.routes.handler(fakeReq('POST', '/dsh-aura/persona-api/save', {
    config: { style: 'sarcastic' },
  }), badRes)
  assert.equal(badRes.out.status, 400)
  assert.equal(badRes.out.body.ok, false)
  assert.ok(badRes.out.body.errors.style)
})

await test('非本机 Host / 跨站来源被拒绝（403）', async () => {
  const res = fakeRes()
  await captured.routes.handler(fakeReq('GET', '/dsh-aura/persona-api/state', undefined, { host: 'evil.example:80' }), res)
  assert.equal(res.out.status, 403)
})

section('8. 变更历史与撤销')
await test('history 追加 / 撤销目标及其之后的改动 / JSONL 落盘', async () => {
  await persona.setConfig({ requireToolConfirmation: false })
  await persona.resetConfig()
  assert.equal(persona.getConfig().style, 'professional')

  const first = await persona.setConfig({ style: 'casual' })
  assert.equal(first.ok, true)
  const second = await persona.setConfig({ emoji: 'more' })
  assert.equal(second.ok, true)

  const before = persona.snapshot()
  assert.equal(before.history[0].changes.emoji.to, 'more')
  assert.equal(before.history[1].changes.style.to, 'casual')
  assert.equal(typeof before.history[0].at, 'string')
  assert.equal(before.history[0].index, 0)

  const undo = await persona.undoTo(1)
  assert.equal(undo.ok, true)
  assert.equal(undo.reversed, 2)
  assert.equal(persona.getConfig().style, 'professional')
  assert.equal(persona.getConfig().emoji, 'default')
  assert.ok(persona.snapshot().historyCount > before.historyCount)

  assert.equal((await persona.undoTo(-1)).ok, false)
  assert.equal((await persona.undoTo(99999)).ok, false)

  const lines = readFileSync(persona.personaHistoryPath(), 'utf8').trim().split('\n')
  assert.ok(lines.length >= 1)
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(typeof last.at, 'string')
  assert.equal(last.source, 'undo')
  assert.equal(last.changes.style.from, 'casual')
  assert.equal(last.changes.style.to, 'professional')
})

section('9. 损坏配置：备份 .corrupt + 拒绝覆写 + 重置逃生')
await test('非法 JSON 被备份、读取回退默认、保存被拒、reset 移开损坏文件', async () => {
  const corruptHome = join(root, 'corrupt-home')
  process.env.DSH_HOME = corruptHome
  const corruptFile = persona.personaFilePath()
  mkdirSync(join(corruptFile, '..'), { recursive: true })
  const broken = '{ this is not valid json'
  writeFileSync(corruptFile, broken, 'utf8')

  const config = persona.getConfig()
  assert.deepEqual(config, { ...persona.DEFAULT_CONFIG })

  const snap = persona.snapshot()
  assert.ok(snap.configError)
  assert.ok(snap.configError.includes('JSON'))
  assert.ok(existsSync(`${corruptFile}.corrupt`))
  assert.equal(readFileSync(`${corruptFile}.corrupt`, 'utf8'), broken)
  assert.equal(readFileSync(corruptFile, 'utf8'), broken)

  const save = await persona.setConfig({ style: 'casual' })
  assert.equal(save.ok, false)
  assert.ok(save.configError)
  assert.equal(readFileSync(corruptFile, 'utf8'), broken)

  const undo = await persona.undoTo(0)
  assert.equal(undo.ok, false)
  assert.ok(undo.configError)

  const reset = await persona.resetConfig()
  assert.equal(reset.ok, true)
  assert.ok(reset.backupPath)
  assert.equal(persona.snapshot().configError, null)
  assert.equal(JSON.parse(readFileSync(corruptFile, 'utf8')).style, 'professional')
  assert.equal(JSON.parse(readFileSync(corruptFile, 'utf8')).personas['极简主义者'], undefined)
})

section('10. dispose')
await test('dispose 不抛错且可重复调用', () => {
  instance.dispose()
  instance.dispose()
})

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // ignore cleanup failure
}
if (failed > 0) process.exitCode = 1
