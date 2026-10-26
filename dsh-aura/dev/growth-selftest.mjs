/**
 * dsh-aura 成长层 + soul_evolve 自测（node 直接跑；Node 25 验证通过）
 *   node dsh-aura/dev/growth-selftest.mjs
 *
 * 临时 DSH_HOME 隔离，不碰真实 soul/config/backup。覆盖：
 *   growth store（add/update/delete/list、去重、40 条裁剪、pinned 优先）；
 *   身份段成长拼接格式 / 单条 60 字 / 最多 8 条 / 预算截断（核心超预算时成长不出现）；
 *   soul_evolve 参数校验、去重、replace、config 白名单；
 *   真实 installSoul（fake ctx + 真 state）+ 真 backup 快照（label=soul-evolve）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-aura-growth-selftest-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
const dataDir = join(process.env.DSH_HOME, 'dsh-aura')
const backupsRoot = join(dataDir, 'backups')
mkdirSync(dataDir, { recursive: true })

const soulMod = await import('../host/soul.js')
const growthMod = await import('../host/growth.js')
const state = await import('../host/state.js')

const {
  buildIdentityText,
  defaultsSoul,
  installSoul,
  normalizeSoul,
  renderIdentitySection,
  sanitizeSoulConfigPatch,
  validateEvolveArgs,
} = soulMod
const {
  GROWTH_HEADER,
  GROWTH_KINDS,
  GROWTH_LIMIT,
  addGrowth,
  deleteGrowth,
  listGrowth,
  normalizeGrowth,
  renderGrowthSection,
  trimGrowth,
  updateGrowth,
} = growthMod

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const lengthOf = (text) => Array.from(String(text ?? '')).length
const growthLines = (text) => String(text).split('\n').filter((line) => line.startsWith('- ['))

let passed = 0
let failed = 0

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

function section(title) {
  console.log(`\n${title}`)
}

function makeFakeCtx() {
  const tools = []
  const sections = []
  const contexts = []
  const disposers = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
      context(spec) {
        contexts.push(spec)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  return {
    ctx,
    tools,
    sections,
    contexts,
    dispose() {
      for (const fn of disposers.reverse()) {
        try {
          fn()
        } catch {
          /* noop */
        }
      }
    },
  }
}

section('1. growth store：兼容缺失 / 去重 / 增改删 / 裁剪')
await test('defaultsSoul 带空 growth，normalizeSoul 兼容旧文件缺失 growth', () => {
  assert.deepEqual(defaultsSoul(NOW).growth, [])
  const old = normalizeSoul({ v: 2, identity: { name: 'Aura' }, relation: { stage: 'stranger' } }, NOW)
  assert.deepEqual(old.growth, [])
  assert.equal(soulMod.SOUL_VERSION, 2)
})

await test('normalizeGrowth 洗坏条、合并同 kind+同文（保留最新 at）', () => {
  const list = normalizeGrowth([
    null,
    { text: '   ', kind: 'trait' },
    { id: 'a', at: 1, kind: 'trait', text: '会承认不确定', source: 'user' },
    { id: 'b', at: 5, kind: 'trait', text: '会承认不确定', source: 'self' },
    { id: 'c', at: 9, kind: 'nope', text: '默认回落 trait', note: 'n'.repeat(500) },
  ], NOW)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'b')
  assert.equal(list[0].at, 5)
  assert.equal(list[1].kind, 'trait')
  assert.equal(lengthOf(list[1].note), 200)
})

await test('addGrowth：默认 kind=trait/source=self、空 text 拒绝、同类同文更新 at', () => {
  const first = addGrowth([], { text: '  接得住停顿  ' }, NOW)
  assert.equal(first.ok, true)
  assert.equal(first.growth.kind, 'trait')
  assert.equal(first.growth.source, 'self')
  assert.equal(first.growth.text, '接得住停顿')
  assert.equal(first.deduped, false)

  const second = addGrowth(first.entries, { text: '接得住停顿', kind: 'trait', pinned: true }, NOW + 1000)
  assert.equal(second.deduped, true)
  assert.equal(second.entries.length, 1)
  assert.equal(second.growth.at, NOW + 1000)
  assert.equal(second.growth.pinned, true)

  const bad = addGrowth(second.entries, { text: '   ' }, NOW)
  assert.equal(bad.ok, false)
})

await test('updateGrowth 替换文本（保留原 kind）与 deleteGrowth', () => {
  const added = addGrowth([], { text: '旧句子', kind: 'bond' }, NOW)
  const id = added.growth.id
  const updated = updateGrowth(added.entries, id, { text: '新句子' }, NOW + 10)
  assert.equal(updated.ok, true)
  assert.equal(updated.growth.text, '新句子')
  assert.equal(updated.growth.kind, 'bond')
  assert.equal(updated.growth.at, NOW + 10)
  assert.equal(updateGrowth(updated.entries, 'missing', { text: 'x' }).ok, false)
  const removed = deleteGrowth(updated.entries, id)
  assert.equal(removed.ok, true)
  assert.equal(removed.entries.length, 0)
})

await test('40 条裁剪：删最旧且未 pinned，pinned 永远保留', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({
    id: `g${i}`,
    at: 1000 + i,
    kind: 'trait',
    text: `成长 ${i}`,
    pinned: i === 0,
    source: 'self',
  }))
  const trimmed = trimGrowth(many)
  assert.equal(trimmed.length, GROWTH_LIMIT)
  assert.ok(trimmed.some((item) => item.id === 'g0'), 'pinned 的 g0 应保留')
  assert.ok(!trimmed.some((item) => item.id === 'g1'), '最旧的未 pinned g1 应被删')
  assert.ok(trimmed.some((item) => item.id === 'g44'))

  let entries = []
  for (let i = 0; i < 41; i += 1) entries = addGrowth(entries, { text: `批量 ${i}` }, 2000 + i).entries
  assert.equal(entries.length, GROWTH_LIMIT)
  assert.ok(!entries.some((item) => item.text === '批量 0'))
})

await test('listGrowth：pinned 在前，其次最新', () => {
  let entries = []
  entries = addGrowth(entries, { text: '最早但 pinned', kind: 'trait', pinned: true }, 1).entries
  entries = addGrowth(entries, { text: '中间', kind: 'trait' }, 2).entries
  entries = addGrowth(entries, { text: '最新', kind: 'trait' }, 3).entries
  const list = listGrowth(entries)
  assert.deepEqual(list.map((item) => item.text), ['最早但 pinned', '最新', '中间'])
})

section('2. 身份段：成长拼接格式 / 上限 / 预算')
const growthSoul = defaultsSoul(NOW)
growthSoul.growth = normalizeGrowth([
  { id: 'g1', at: 10, kind: 'trait', text: '我比想象中更会接住人的停顿', source: 'self' },
  { id: 'g2', at: 20, kind: 'bond', text: '和木子可以安静一会儿也不尴尬', pinned: true, source: 'self' },
])
const growthConfig = { soulPromptBudget: 4000 }

await test('格式：`你已经长出来的部分：` + `- [kind] text`，插在 [END AURA] 之前', () => {
  const text = renderIdentitySection(growthSoul, growthConfig, NOW)
  assert.equal(text, buildIdentityText(growthSoul, growthConfig, NOW))
  assert.ok(text.endsWith('[END AURA]'))
  const block = text.slice(text.indexOf(GROWTH_HEADER))
  assert.equal(
    block,
    '你已经长出来的部分：\n'
    + '- [bond] 和木子可以安静一会儿也不尴尬\n'
    + '- [trait] 我比想象中更会接住人的停顿\n'
    + '[END AURA]',
  )
})

await test('单条 ≤60 字、最多 8 条；pinned 优先', () => {
  let soul = defaultsSoul(NOW)
  for (let i = 0; i < 12; i += 1) {
    soul.growth = addGrowth(soul.growth, { text: `${i} `.padEnd(100, '字') , kind: GROWTH_KINDS[i % GROWTH_KINDS.length] }, i).entries
  }
  soul.growth = addGrowth(soul.growth, { text: '最旧但 pinned 的一条', kind: 'self', pinned: true }, -1).entries
  const text = renderIdentitySection(soul, growthConfig, NOW)
  const lines = growthLines(text)
  assert.equal(lines.length, 8)
  assert.ok(lines[0].includes('最旧但 pinned 的一条'))
  for (const line of lines) {
    const content = line.replace(/^- \[[a-z]+\] /, '')
    assert.ok(lengthOf(content) <= 60, `单条超 60 字：${lengthOf(content)}`)
  }
})

await test('渲染确定性：growth/config 不变则每轮完全一致，写入后才变', () => {
  const a = renderIdentitySection(growthSoul, growthConfig, NOW)
  const b = renderIdentitySection(growthSoul, growthConfig, NOW)
  assert.equal(a, b)
  assert.ok(!a.includes('刚冒出来的新认识'))
  const evolved = { ...growthSoul, growth: addGrowth(growthSoul.growth, { text: '刚冒出来的新认识' }, NOW + 1).entries }
  assert.ok(renderIdentitySection(evolved, growthConfig, NOW).includes('- [trait] 刚冒出来的新认识'))
})

await test('预算：核心放完才放成长；核心超预算时成长完全不出现', () => {
  const bare = defaultsSoul(NOW)
  const core = renderIdentitySection(bare, { soulPromptBudget: 4000 }, NOW)
  const coreLen = lengthOf(core)
  assert.ok(coreLen > 200)

  // 核心刚好占满预算：只有核心（成长不出现）
  assert.equal(renderIdentitySection(growthSoul, { soulPromptBudget: coreLen }, NOW), core)
  // 核心 + 1 码点：仍放不下成长段
  assert.equal(renderIdentitySection(growthSoul, { soulPromptBudget: coreLen + 1 }, NOW), core)
  // 核心超预算：截断到预算，且没有成长段
  const over = renderIdentitySection(growthSoul, { soulPromptBudget: 300 }, NOW)
  assert.equal(lengthOf(over), 300)
  assert.equal(over.includes(GROWTH_HEADER), false)

  // 预算刚好等于 核心 + 换行 + 整个成长段：完整出现
  const block = renderGrowthSection(growthSoul.growth, { budget: 4000 })
  const exactBudget = coreLen + 1 + lengthOf(block)
  const exact = renderIdentitySection(growthSoul, { soulPromptBudget: exactBudget }, NOW)
  assert.equal(lengthOf(exact), exactBudget)
  assert.ok(exact.includes(GROWTH_HEADER))
  assert.equal(growthLines(exact).length, 2)
  // 少 1 码点：不会出现半条成长
  const shy = renderIdentitySection(growthSoul, { soulPromptBudget: exactBudget - 1 }, NOW)
  assert.ok(!shy.includes('我比想象中更会接住人的停顿') || !shy.includes(GROWTH_HEADER))
})

section('3. config 白名单与参数校验（纯函数）')
await test('sanitizeSoulConfigPatch：8 字段白名单、长度/范围校验', () => {
  const ok = sanitizeSoulConfigPatch({
    soulName: ' Aura ',
    soulUserNickname: ' 木子 ',
    soulEnabled: false,
    soulPromptBudget: 900,
    soulBio: '在做项目',
    soulContent: '## 性格\n嘴硬心软',
    interests: [' 听歌 ', '看代码'],
    strengths: ['记得住细节'],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.configPatch.soulName, 'Aura')
  assert.equal(ok.configPatch.soulUserNickname, '木子')
  assert.equal(ok.configPatch.soulPromptBudget, 900)
  assert.deepEqual(ok.identityPatch.interests, ['听歌', '看代码'])
  assert.deepEqual(ok.changed, ['soulName', 'soulUserNickname', 'soulEnabled', 'soulPromptBudget', 'soulBio', 'soulContent', 'interests', 'strengths'])

  const bads = [
    { hack: 1 },
    { soulName: '' },
    { soulName: 'x'.repeat(21) },
    { soulUserNickname: 'x'.repeat(21) },
    { soulPromptBudget: 199 },
    { soulPromptBudget: 4001 },
    { soulPromptBudget: 'abc' },
    { soulEnabled: 'yes' },
    { interests: [] },
    { interests: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { interests: ['x'.repeat(13)] },
    { interests: [1] },
  ]
  for (const bad of bads) assert.equal(sanitizeSoulConfigPatch(bad).ok, false, JSON.stringify(bad))
  assert.deepEqual(sanitizeSoulConfigPatch(undefined), { ok: true, configPatch: {}, identityPatch: {}, changed: [] })
})

await test('validateEvolveArgs：text/note 长度、kind/pin 类型、replace 原样带回', () => {
  assert.equal(validateEvolveArgs({}).ok, false)
  assert.equal(validateEvolveArgs({ text: '   ' }).ok, false)
  assert.equal(validateEvolveArgs({ text: 'x'.repeat(121) }).ok, false)
  assert.equal(validateEvolveArgs({ text: 'ok', note: 'n'.repeat(201) }).ok, false)
  assert.equal(validateEvolveArgs({ text: 'ok', kind: 'nope' }).ok, false)
  assert.equal(validateEvolveArgs({ text: 'ok', pin: 'yes' }).ok, false)
  const fine = validateEvolveArgs({ text: ' ok ', kind: 'habit', note: '因为', pin: true, replace: 'abc' })
  assert.equal(fine.ok, true)
  assert.equal(fine.text, 'ok')
  assert.equal(fine.kind, 'habit')
  assert.equal(fine.replace, 'abc')
  assert.equal(fine.pin, true)
  assert.equal(validateEvolveArgs({ text: 'ok' }).kind, undefined, '未给 kind 时应保留原值')
})

section('4. soul_evolve 工具（fake ctx + 真 state + 真 backup）')
const fake = makeFakeCtx()
const logs = []
const installed = installSoul(fake.ctx, { state, log: (...parts) => logs.push(parts.join(' ')) })
const evolve = fake.tools.find((tool) => tool.name === 'soul_evolve')
const identitySection = fake.contexts.find((spec) => spec.name === 'aura:growth')

await test('工具已注册：parameters 是每属性 spec，config 收窄白名单', () => {
  assert.ok(evolve, '应注册 soul_evolve')
  assert.deepEqual(evolve.parameters.required, ['text'])
  assert.equal(evolve.parameters.properties.config.type, 'object')
  assert.equal(evolve.parameters.properties.config.additionalProperties, false)
  assert.deepEqual(evolve.parameters.properties.kind.enum, [...GROWTH_KINDS])
  assert.ok(identitySection && typeof identitySection.text === 'function')
  assert.equal(identitySection.text().includes(GROWTH_HEADER), false)
  assert.deepEqual(installed.get().growth, [])
})

await test('写入：返回 growth/configChanged/backupId，落盘 soul.json，身份段立即变化', async () => {
  const result = await evolve.execute({
    text: '我比自己以为的更能承认不确定',
    kind: 'self',
    note: '聊到写代码失败时',
    pin: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.growth.kind, 'self')
  assert.equal(result.growth.pinned, true)
  assert.equal(result.growth.source, 'self')
  assert.equal(result.growth.note, '聊到写代码失败时')
  assert.deepEqual(result.configChanged, [])
  assert.equal(result.total, 1)
  assert.ok(typeof result.backupId === 'string' && result.backupId.endsWith('-soul-evolve'))

  const disk = JSON.parse(readFileSync(join(dataDir, 'soul.json'), 'utf8'))
  assert.equal(disk.growth.length, 1)
  assert.equal(disk.growth[0].text, '我比自己以为的更能承认不确定')
  assert.equal(disk.growth[0].pinned, true)

  const text = identitySection.text()
  assert.ok(text.includes(GROWTH_HEADER))
  assert.ok(text.includes('- [self] 我比自己以为的更能承认不确定'))
  const identityText = fake.sections.find((spec) => spec.name === 'aura:soul-identity').text()
  assert.ok(identityText.endsWith('[END AURA]'))
  assert.equal(text, identitySection.text(), '无改动时每轮渲染应一致')

  const manifest = JSON.parse(readFileSync(join(backupsRoot, result.backupId, 'manifest.json'), 'utf8'))
  assert.equal(manifest.label, 'soul-evolve')
  assert.ok(manifest.files.some((file) => file.name === 'soul.json'))
  assert.equal(installed.listGrowth().length, 1)
})

await test('去重：同 kind+同文只更新 at，不新增', async () => {
  const before = installed.listGrowth()
  const result = await evolve.execute({ text: '我比自己以为的更能承认不确定', kind: 'self' })
  assert.equal(result.ok, true)
  assert.equal(result.deduped, true)
  assert.equal(result.total, before.length)
  assert.equal(result.growth.id, before[0].id)
  assert.ok(result.growth.at >= before[0].at)
})

await test('replace：替换指定 id 的文本并保留 kind/source', async () => {
  const target = installed.listGrowth()[0]
  const result = await evolve.execute({ text: '我原来怕承认不确定，现在能说出口了', replace: target.id })
  assert.equal(result.ok, true)
  assert.equal(result.growth.id, target.id)
  assert.equal(result.growth.text, '我原来怕承认不确定，现在能说出口了')
  assert.equal(result.growth.kind, 'self')
  assert.equal(result.growth.source, target.source)
  assert.equal(installed.listGrowth().length, 1)
  assert.ok(identitySection.text().includes('我原来怕承认不确定'))
  assert.equal((await evolve.execute({ text: 'x', replace: 'missing-id' })).ok, false)
})

await test('config：通过 state.writeConfig 写 config.json，interests/strengths 落到 soul.identity', async () => {
  const result = await evolve.execute({
    text: '我开始喜欢看别人折腾奇怪的项目',
    kind: 'interest',
    config: {
      soulName: 'Aura',
      soulUserNickname: '木子',
      soulEnabled: true,
      soulPromptBudget: 880,
      soulBio: '在做项目',
      soulContent: '## 性格\n嘴硬心软',
      interests: ['听歌', '看人折腾项目'],
      strengths: ['记得住细节'],
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    [...result.configChanged].sort(),
    ['interests', 'soulEnabled', 'soulBio', 'soulContent', 'soulName', 'soulPromptBudget', 'soulUserNickname', 'strengths'].sort(),
  )
  const cfg = state.readConfig()
  assert.equal(cfg.soulName, 'Aura')
  assert.equal(cfg.soulUserNickname, '木子')
  assert.equal(cfg.soulPromptBudget, 880)
  assert.equal(cfg.soulEnabled, true)
  assert.deepEqual(installed.get().identity.interests, ['听歌', '看人折腾项目'])
  assert.deepEqual(installed.get().identity.strengths, ['记得住细节'])
  const text = fake.sections.find((spec) => spec.name === 'aura:soul-identity').text()
  assert.ok(text.includes('## 性格'))
  assert.ok(text.includes('嘴硬心软'))
  assert.ok(text.length <= 880)
})

await test('再次写入后，备份里会出现 config.json（先快照后写盘）', async () => {
  const result = await evolve.execute({ text: '克制也算一种表达', config: { soulContent: '## 性格\n克制也算一种表达' } })
  assert.equal(result.ok, true)
  const ids = readdirSync(backupsRoot).filter((id) => id.endsWith('-soul-evolve'))
  assert.ok(ids.length >= 5, `应有多次 soul-evolve 快照，实际 ${ids.length}`)
  const manifests = ids.map((id) => JSON.parse(readFileSync(join(backupsRoot, id, 'manifest.json'), 'utf8')))
  assert.ok(manifests.some((manifest) => manifest.files.some((file) => file.name === 'config.json')))
  assert.ok(String(state.readConfig().soulContent).includes('克制也算一种表达'))
  assert.equal(identitySection.text().includes('关于身份：'), false)
})

await test('参数校验：text 空/超长、非法 config 范围都拒绝且不写入', async () => {
  const before = installed.listGrowth().length
  assert.equal((await evolve.execute({ text: '   ' })).ok, false)
  assert.equal((await evolve.execute({ text: 'x'.repeat(121) })).ok, false)
  assert.equal((await evolve.execute({ text: 'ok', note: 'n'.repeat(201) })).ok, false)
  assert.equal((await evolve.execute({ text: 'ok', config: { soulPromptBudget: 199 } })).ok, false)
  assert.equal((await evolve.execute({ text: 'ok', config: { soulName: '' } })).ok, false)
  assert.equal((await evolve.execute({ text: 'ok', config: { soulPromptBudget: 5000 } })).ok, false)
  // 白名单外的 key / 非法 enum 由 defineTool 的 JSON Schema 直接拒绝（additionalProperties:false）
  await assert.rejects(() => evolve.execute({ text: 'ok', config: { hack: 1 } }), /invalid arguments/)
  await assert.rejects(() => evolve.execute({ text: 'ok', kind: 'nope' }), /invalid arguments/)
  assert.equal(installed.listGrowth().length, before)
})

await test('调试日志里没有未捕获异常', () => {
  const errors = logs.filter((line) => line.includes('工具注册失败') || line.includes('写 config 失败'))
  assert.deepEqual(errors, [])
})

await test('重新装载：growth 从 soul.json 恢复，reset 不清成长', () => {
  const again = makeFakeCtx()
  const reloaded = installSoul(again.ctx, { state, log: () => {} })
  assert.equal(reloaded.listGrowth().length, installed.listGrowth().length)
  const section = again.contexts.find((spec) => spec.name === 'aura:growth')
  assert.ok(section.text().includes(GROWTH_HEADER))
  const before = reloaded.listGrowth().length
  reloaded.reset('all')
  assert.equal(reloaded.listGrowth().length, before)
  again.dispose()
})

fake.dispose()
await new Promise((resolve) => setTimeout(resolve, 50))
rmSync(root, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
