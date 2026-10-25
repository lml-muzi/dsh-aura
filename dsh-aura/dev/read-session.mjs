/**
 * 读 DSH v4 会话日志（多 zstd frame 拼接格式），打印事件摘要并检索关键字。
 * 用法：node dev/read-session.mjs <session.v4.jsonl.zstd> [关键字1,关键字2,...]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at ' + offset)
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

const file = process.argv[2]
const probes = (process.argv[3] || '').split(',').filter(Boolean)
const buffer = readFileSync(file)
let text = ''
for (const frame of scanFrames(buffer)) text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
const events = text.trim().split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
console.log('events:', events.length)
for (const event of events) {
  const type = event.type
  if (type === 'user/message') {
    const content = event.data?.message?.content ?? event.data?.content
    console.log('USER  ', JSON.stringify(content).slice(0, 300), '| source:', JSON.stringify(event.data?.source))
  } else if (type === 'assistant/message') {
    const content = event.data?.message?.content ?? event.data?.content
    console.log('ASSIST ', JSON.stringify(content).slice(0, 600))
  } else if (type === 'tool/call') {
    console.log('TOOL  ', event.data?.name, JSON.stringify(event.data?.arguments).slice(0, 200))
  } else if (type === 'tool/result') {
    console.log('RESULT', JSON.stringify(event.data?.message?.content ?? event.data).slice(0, 300))
  } else if (type === 'turn/start' || type === 'turn/end') {
    console.log(type, JSON.stringify(event.data).slice(0, 200))
  }
}
for (const probe of probes) console.log('probe', JSON.stringify(probe), '→', text.includes(probe))
