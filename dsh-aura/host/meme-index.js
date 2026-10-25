/**
 * 把模型写的 [表情: 描述] 解析成 dsh-meme 图库里的真实文件路径。
 *
 * 用途：Web 端仍由 dsh-meme 的前端把标记渲染成内联图片；QQ 端由 Aura bridge
 * 把同一段描述解析成本地文件，用腾讯 SDK 发原生图片，然后把标记从 QQ 文本里摘掉。
 * 匹配算法照抄 dsh-meme client（精确 → 折叠 → 紧凑 → 分词双向包含）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const packCache = new Map()

const foldCaption = (s) => String(s || '').trim()
  .replace(/[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f«»]/g, '"')
  .replace(/\s+/g, ' ')
const looseCaption = (s) => foldCaption(s).replace(/["'\s]/g, '')
const splitDescTokens = (s) => foldCaption(s)
  .split(/[\s,.!?;:、，。！？；：""''()（）\[\]【】《》…·～~\-]+/)
  .map((t) => t.replace(/["']/g, ''))
  .filter((t) => t.length >= 2)
  .sort((a, b) => b.length - a.length)

function readJson(file, fallback) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function memeHome() {
  // dsh-meme 用的是 ~/.dsh（和 DSH_HOME 可能不同）
  return process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'dsh-expression.json'))
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function expressionConfig() {
  return readJson(join(memeHome(), 'dsh-expression.json'), {})
}

/** 内置图库在 dsh-meme 包目录；用户图库在 ~/.dsh/meme-packs。 */
function packDirs(packId) {
  const dirs = []
  const home = join(homedir(), '.dsh', 'meme-packs', packId)
  dirs.push(home)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) dirs.push(join(profileDir, 'node_modules', 'dsh-meme', 'memes', packId))
  // 兜底扫 profile
  try {
    const base = join(homedir(), '.dsh-native', 'profiles')
    for (const name of readdirSync(base)) {
      dirs.push(join(base, name, 'node_modules', 'dsh-meme', 'memes', packId))
    }
  } catch { /* ignore */ }
  return dirs.filter(dir => existsSync(join(dir, 'index.db')))
}

function rowsOf(root) {
  try {
    const dbPath = join(root, 'index.db')
    const mtime = statSync(dbPath).mtimeMs
    const cached = packCache.get(dbPath)
    if (cached && cached.mtime === mtime) return cached.rows
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT path, caption, keywords, file_name FROM memes').all()
    db.close()
    const mapped = rows.map(row => ({ ...row, file: join(root, row.path) }))
    packCache.set(dbPath, { mtime, rows: mapped })
    return mapped
  } catch {
    return []
  }
}

function indexRows() {
  const config = expressionConfig()
  const packs = Array.isArray(config.enabledPacks) && config.enabledPacks.length
    ? config.enabledPacks
    : [config.packId].filter(Boolean)
  const roots = []
  if (config.memeRoot) roots.push(config.memeRoot)
  for (const pack of packs) roots.push(...packDirs(pack))
  const seen = new Set()
  const rows = []
  for (const root of roots) {
    if (!root || seen.has(root)) continue
    seen.add(root)
    for (const row of rowsOf(root)) if (row.file && existsSync(row.file)) rows.push(row)
  }
  return rows
}

const exactKey = (s) => [String(s || '').trim(), foldCaption(s), looseCaption(s)].filter(Boolean)

function searchRows(rows) {
  return rows.map(row => {
    const hay = []
    const parts = []
    for (const value of [row.caption, row.keywords, row.file_name]) {
      const folded = foldCaption(value)
      if (!folded) continue
      const loose = looseCaption(value)
      hay.push(folded, ...(loose && loose !== folded ? [loose] : []))
      parts.push(value)
    }
    const tokens = [...new Set(splitDescTokens(parts.join(' ')))]
    return { row, hay, tokens }
  })
}

/** 描述 → 本地图片绝对路径；找不到返回 null。 */
export function resolveMemeFile(description) {
  try {
    const rows = indexRows()
    if (!rows.length) return null
    const raw = String(description || '').trim()
    if (!raw) return null
    const exact = new Map()
    for (const row of rows) {
      for (const key of exactKey(row.caption)) if (key && !exact.has(key)) exact.set(key, row.file)
      for (const key of exactKey(row.file_name)) if (key && !exact.has(key)) exact.set(key, row.file)
    }
    for (const key of exactKey(raw)) if (exact.has(key)) return exact.get(key)

    const needles = [...new Set(splitDescTokens(raw).map(looseCaption).filter(Boolean))]
    if (!needles.length) return null
    const search = searchRows(rows)
    let best = null
    let bestLength = 0
    let bestCount = 0
    for (const item of search) {
      let longest = 0
      let count = 0
      for (const needle of needles) {
        let length = item.hay.some(hay => hay.includes(needle)) ? needle.length : 0
        for (const token of item.tokens) {
          const loose = looseCaption(token)
          if (loose && (needle.includes(loose) || loose.includes(needle))) {
            length = Math.max(length, Math.min(needle.length, loose.length))
          }
        }
        if (length) {
          longest = Math.max(longest, length)
          count += 1
        }
      }
      if (longest > bestLength || (longest === bestLength && count > bestCount)) {
        best = item.row.file
        bestLength = longest
        bestCount = count
      }
    }
    return best
  } catch {
    return null
  }
}

/** 解析一段助手文本里的所有 [表情: 描述] 标记。 */
export function extractMemeMarkers(text) {
  const re = /\[表情[:：]\s*([^\]]+)\](?:\(https?:\/\/[^\s)]+\))?/g
  const markers = []
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const description = String(match[1] || '').trim()
    markers.push({ raw: match[0], description, file: resolveMemeFile(description) })
  }
  return markers
}
