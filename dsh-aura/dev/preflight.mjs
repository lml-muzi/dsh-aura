#!/usr/bin/env node
/**
 * 部署前自检：语法 + 全部 selftest + UI 冒烟。任何一项失败即退出非零。
 *
 * CI 不安装 dsh-aura 的 peer/运行时依赖，可设 DSH_AURA_PREFLIGHT_OFFLINE=1：
 * 只跳过因缺少外部包而无法 import 的测试，其余照常跑；
 * 缺少内部文件、断言失败等仍然算失败，不会被跳过逻辑吞掉。
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const files = readdirSync(here)
const tests = files.filter(name => /-(selftest|ui-sim)\.mjs$/.test(name)).sort()
const sources = [
  'client.js', 'index.js',
  'host/soul.js', 'host/emotion.js', 'host/memory.js', 'host/memory-store.js',
  'host/speak.js', 'host/life.js', 'host/diary.js', 'host/archive.js',
  'host/backup.js', 'host/bridge.js', 'host/media.js', 'host/config-tool.js',
  'host/web.js', 'host/meme.js', 'host/persona.js',
]

/** 由 DSH profile / npm 提供、本仓库不自带的外部包。 */
const EXTERNAL_PACKAGES = new Set([
  '@deepseek-ai/dsh-tools',
  '@tencent-connect/qqbot-nodejs',
])
const offline = process.env.DSH_AURA_PREFLIGHT_OFFLINE === '1'

function missingExternalPackage(output) {
  const match = /Cannot find package '([^']+)'/.exec(String(output || ''))
  return match && EXTERNAL_PACKAGES.has(match[1]) ? match[1] : ''
}

let failed = 0
let skipped = 0
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe', encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    console.error(`❌ syntax ${file}\n${result.stderr || result.stdout}`)
  }
}
console.log(`语法检查：${sources.length - failed}/${sources.length}`)

for (const test of tests) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: 'pipe', encoding: 'utf8' })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    const missing = offline
      ? missingExternalPackage((result.stdout || '') + (result.stderr || ''))
      : ''
    if (missing) {
      skipped += 1
      console.log(`⏭️ ${test} (${elapsed}s) 跳过：缺少外部包 ${missing}`)
      continue
    }
    failed += 1
    console.error(`❌ ${test} (${elapsed}s)\n${(result.stdout || '') + (result.stderr || '')}`)
  } else {
    const tail = String(result.stdout || '').trim().split('\n').slice(-1)[0] || 'ok'
    console.log(`✅ ${test} (${elapsed}s) ${tail}`)
  }
}

if (failed > 0) {
  console.error(`\n预检失败：${failed} 项`)
  process.exit(1)
}
const skippedNote = skipped > 0 ? `，跳过 ${skipped} 个依赖外部包的测试` : ''
console.log(`\n预检通过${offline ? '（离线）' : ''}：${sources.length} 个文件，${tests.length - skipped} 个测试${skippedNote}`)
