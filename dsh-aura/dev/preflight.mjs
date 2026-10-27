#!/usr/bin/env node
/** 部署前自检：语法 + 全部 selftest + UI 冒烟。任何一项失败即退出非零。 */
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

let failed = 0
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
console.log(`\n预检通过：${sources.length} 个文件，${tests.length} 个测试`)
