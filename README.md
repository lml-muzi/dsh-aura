# dsh-aura

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的一个「有灵魂的陪伴层」插件：自研 QQ 渠道、情绪、关系、长期记忆、日记、表情包和可自定义的左侧栏面板。

> Aura 不是一个客服机器人，她有自己的情绪基线、会慢慢长出自己的性格，会在 QQ 上主动找你，也会睡觉、摸鱼、玩。

## 功能

- **灵魂**：自由文本灵魂内容（`#` 标题分节）、长期成长层、每日自省自动长出新东西、版本快照与回滚
- **情绪**：四维（愉悦/唤醒/亲近/精力）、长期基线、趋势与历史曲线、事件显著性权重、主动情绪调节（限幅）
- **关系**：陌生 → 熟悉 → 亲密 → 亲密以上，靠互动累积，长期失联会缓慢回退
- **记忆**：事件流、分类笔记、事实卡、实体卡、实体图与 1 跳召回、每日整理、会话整理、重要信息立即入记忆
- **日记**：独立于记忆，每天自动写（可调时间/最少事件），面板可补写、手写、删除
- **表情包**：合并本地图库 + 内置图库，搜索/上传/编辑/删除/导入导出，QQ 发原生图，网页内联渲染
- **生活**：醒着/忙/玩/休息/睡/出门，自然醒/随机窗口/闹钟，中途醒再睡；生活状态影响在场感和主动搭话
- **主动搭话**：掷骰子式主动消息，受关系、状态、静默时段、每日上限约束
- **QQ 渠道**：腾讯官方 `@tencent-connect/qqbot-nodejs` SDK，支持私聊/群聊、图片、表情包、消息插队（`steer`）
- **面板**：灵魂 / 情绪 / 记忆 / 日记 / 生活 / 表情包 / 外观 / 连接 / 调试

## 安装

要求：

- DeepSeek Harness（Web profile）
- Node.js ≥ 22.13
- 可选：QQ 机器人 AppID / AppSecret（要用 QQ 时才需要）

```bash
git clone https://github.com/lml-muzi/dsh-aura.git
cd dsh-aura
# 让 DSH 把 dsh-aura/ 作为本地 bundle 安装（或把 dsh-aura/ 复制到 profile 的 node_modules 后手动启用）
dsh plugin --profile web add "$PWD/dsh-aura"
```

装好后打开面板左侧栏的 **Aura**：

1. 「连接」填 QQ AppID / AppSecret，点连接
2. 「灵魂」里写名字、称呼和灵魂内容
3. 「情绪」「记忆」「日记」「生活」按需要调
4. 主动搭话默认关闭；要她主动找你，在「生活」页打开

> 插件依赖 `@tencent-connect/qqbot-nodejs`，安装时由包管理器拉取。不需要 QQ 时可以不填凭据，只用面板和其他能力。

## 数据与隐私

运行时状态在 `$DSH_HOME/dsh-aura/`（默认 `~/.dsh-native/dsh-aura/`）：

- `config.json` 配置（含 QQ 凭据，**不会**进仓库）
- `soul.json` 灵魂/情绪/关系/成长
- `memory.json` 事件/笔记/事实/实体/关系
- `diary.json` 日记
- `life.json` 生活状态
- `backups/` 版本快照（默认保留 30 份）

这些文件都在本机；仓库里只有源码和文档。写操作前有快照，可在面板或 `/dsh-aura/backup-api` 回滚。

## 开发

```bash
cd dsh-aura
node dev/meme-selftest.mjs
node dev/memory-selftest.mjs
node dev/emotion-selftest.mjs
node dev/life-selftest.mjs
node dev/speak-selftest.mjs
```

每个模块都有独立的离线自测（不联网、不需要 QQ）。

## 许可与第三方

- 本项目：MIT
- `dsh-aura/host/meme-store.js` 改编自 [dsh-meme](https://github.com/yyh-001/dsh-meme)（MIT），文件头保留原始版权说明
- 内置表情图库 `dsh-aura/memes/dafeiyu-001` 来自 dsh-meme（MIT）

## 备注

这是「她」的生活层，不是任务管理器。主动消息可能受 QQ 平台被动回复窗口限制，不保证每条都能送达。
