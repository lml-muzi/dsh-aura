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
    description: '表示“我还想再想一轮”，不会直接发消息。调用后桥会给同一个 agent 排一轮 followup，下一轮再决定说什么，或 <skip> 收住。不要向用户解释你调用了它，也不要说“排了一轮”；想发额外的话请用正常回复里的空行拆分。',
    parameters: {
      hint: { type: 'string', description: '可选：为什么还想再说一轮，≤120 字' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value?.ok ? '（已排队；下一轮直接自然说话，不要解释这个动作）' : '没排上：' + String(value?.error || '') }],
    },
    async execute(args, exec) {
      try {
        return await bridge.requestRethink(exec, args?.hint)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
}

// hmr probe 1792916654
