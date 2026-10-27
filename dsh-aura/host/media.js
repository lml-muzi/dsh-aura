/**
 * 表情包/文件回传接缝。
 *
 * dsh-meme 判断「这一轮在 IM 上」的条件是 ctx.get('dshIm') 存在 + 用户消息 rpcId 带渠道前缀。
 * 我们提供最小的 dshIm 服务占位，它就会走 IM 模式：候选带绝对路径，提示模型调用
 * dsh_im_return_file 而不是写 [表情: 描述] 标记。工具由我们注册，图片由 QQ 客户端
 * 作为原生图片消息发出（在回合文字之前），从而做到「图在前、正文无描述」。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export function installMedia(ctx, { bridge, log }) {
  // 不再提供 dshIm 占位：让 dsh-meme 保持 Web 标记模式（[表情: 描述] 由前端内联渲染），
  // QQ 端由 bridge 解析标记并发送原生图片。

  ctx.tools.register(defineTool({
    name: 'dsh_im_return_file',
    description: 'Register a readable file or generated image for delivery through the current QQ conversation. ' +
      'It is uploaded and sent immediately as a native QQ image (picture files) or file message, before your text reply. ' +
      'Use an absolute path, or a path relative to the current workspace. ' +
      'Do not describe the delivery in your reply and do not write markdown images or local paths in the text.',
    parameters: {
      path: { type: 'string', description: 'Absolute path, or a path relative to the current workspace.', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: 'Sent ' + String(value?.fileName ?? 'file') + ' (' + String(value?.size ?? 0) + ' bytes) as a native QQ ' + (value?.image ? 'image' : 'file') + ' message.',
      }],
    },
    async execute(args, exec) {
      return bridge.returnFile(args?.path, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'soul_say',
    description: '在当前的 QQ 被动回复窗口里追加一条短消息。想分两句说、又不想把正文拆得太碎时用；一次最多 200 字，同回合受 QQ 条数上限约束。不要用它重复你马上要发的正文。',
    parameters: {
      text: { type: 'string', description: '要追加的那一句，≤200 字', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value?.ok ? '已追加第 ' + String(value.seq) + ' 条消息' : '没发出去：' + String(value?.error || '') }],
    },
    async execute(args, exec) {
      try {
        return await bridge.say(args?.text, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
}

// hmr probe 1792916654
