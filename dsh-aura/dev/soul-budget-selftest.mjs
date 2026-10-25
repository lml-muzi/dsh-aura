/**
 * dsh-aura 灵魂身份段预算自测（node 直接跑）
 *   node dsh-aura/dev/soul-budget-selftest.mjs
 *
 * 纯函数测试，不读写任何状态文件：
 *   预算 300/1020/2000 按 config.soulPromptBudget 截断，不再被旧的 620 硬上限截住；
 *   预算夹取到 200..4000；soulEnabled=false 时身份段为空。
 */
import assert from 'node:assert/strict'
import { IDENTITY_BUDGET, buildIdentityText, defaultsSoul, renderIdentitySection } from '../host/soul.js'

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

const lengthOf = (text) => Array.from(String(text ?? '')).length
const identity = (soul, config = {}) => buildIdentityText(soul, config)

/** 默认身份段只有 465 码点，用长兴趣/擅长把全文推过 1020，才能验证不再卡 620。 */
function richSoul() {
  const soul = defaultsSoul()
  const fill = 'x'.repeat(100)
  soul.identity.interests = [fill, fill, fill, fill]
  soul.identity.strengths = [fill, fill, fill, fill]
  return soul
}

console.log('\n1. 别名与默认预算')
await test('buildIdentityText 与 renderIdentitySection 同源，默认 1020 能输出全文', () => {
  assert.equal(buildIdentityText, renderIdentitySection)
  const soul = defaultsSoul()
  const full = identity(soul, { soulPromptBudget: 4000 })
  assert.equal(identity(soul), full)
  assert.equal(identity(soul, { soulPromptBudget: 1020 }), full)
  assert.ok(full.startsWith('[AURA / 灵魂]'))
  assert.ok(full.endsWith('[END AURA]'))
})

console.log('\n2. 预算按 config.soulPromptBudget 生效')
await test('预算 300：按预算截断（旧 620 逻辑会压到 200）', () => {
  const soul = defaultsSoul()
  const text = identity(soul, { soulPromptBudget: 300 })
  assert.equal(lengthOf(text), 300)
  assert.ok(300 > 200)
  assert.ok(lengthOf(identity(soul, { soulPromptBudget: 4000 })) > 300)
})

await test('预算 1020：长身份段不再被 620 硬上限截断', () => {
  const soul = richSoul()
  const full = identity(soul, { soulPromptBudget: 4000 })
  assert.ok(lengthOf(full) > 1020)
  const text = identity(soul, { soulPromptBudget: 1020 })
  assert.equal(lengthOf(text), 1020)
  assert.ok(lengthOf(text) > IDENTITY_BUDGET)
})

await test('预算 2000：完整输出，长度随预算增长而不是固定 620', () => {
  const soul = richSoul()
  const full = identity(soul, { soulPromptBudget: 4000 })
  const text = identity(soul, { soulPromptBudget: 2000 })
  assert.equal(lengthOf(text), lengthOf(full))
  assert.ok(lengthOf(text) > 1020)
  assert.ok(lengthOf(text) > IDENTITY_BUDGET)
  assert.ok(lengthOf(text) > lengthOf(identity(soul, { soulPromptBudget: 1020 })))
})

await test('预算夹取到 200..4000，非法值回落默认 1020', () => {
  const soul = richSoul()
  const full = identity(soul, { soulPromptBudget: 4000 })
  assert.equal(lengthOf(identity(soul, { soulPromptBudget: 1 })), 200)
  assert.equal(lengthOf(identity(soul, { soulPromptBudget: 99999 })), lengthOf(full))
  assert.equal(identity(soul, { soulPromptBudget: 'abc' }), identity(soul, { soulPromptBudget: 1020 }))
})

console.log('\n3. 灵魂总开关')
await test('soulEnabled=false 时身份段返回空串', () => {
  const soul = richSoul()
  for (const soulPromptBudget of [300, 1020, 2000, 4000]) {
    assert.equal(identity(soul, { soulEnabled: false, soulPromptBudget }), '')
  }
  assert.equal(identity(defaultsSoul(), { soulEnabled: false }), '')
})

console.log(`\n${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed > 0) process.exitCode = 1
