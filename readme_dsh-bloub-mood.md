# dsh-bloub-mood

**动态心情图标 + 桌面入口** — DeepSeek Harness (DSH) 的会话感知动画形象：favicon、侧边栏字标、首页标题随会话状态播放 bloub 引擎原生小剧场动画，16 种表情可点击切换，形状 / 颜色 / 文字全部在设置页自定义；并内置**桌面启动**子功能，把共用同一后端的 DSH 变成 Dock 里真正的独立 App。

灵感来自 [bloub](https://bloub.vercel.app/)（bloub, avatar SVG animé · [GitHub](https://github.com/jeremy-prt/bloub)）。本插件把它的表情与动画引擎接到 DSH 的会话状态机上——**扫一眼标签页，就知道 agent 在干活、在等你、还是做完了**。

## 效果预览

**设置页**：表情（16 种）/ 形状（8 种）/ 颜色（12 种）/ 文字（4 处）四层自定义，顶部实时大预览与 iOS 风格启停开关，中英双语跟随界面语言：

![设置页 · 表情与形状颜色](docs/settings-expressions.png)

**桌面启动**（设置页底部）：一行开关 + 三个 bloub 形象图标点选，所见即桌面所得：

![设置页 · 桌面启动](docs/settings-desktop-launch.png)

**Dock 里的独立 App** —— 不是浏览器窗口，是真正属于自己的图标、名字与进程：

![Dock · DSH Desktop](docs/dock-icon.png)

**DSH Desktop 主界面** —— 系统原生窗口，无浏览器地址栏，共用当前 `dsh web` 后端（会话、插件、工作区全部同步）：

![DSH Desktop 主界面](docs/desktop-app.png)

## 桌面启动 / Desktop Launch（v2.4.0）

给共用同一后端的 `dsh web` 一个桌面入口，双击即用：**后端在线直接复用；离线自动拉起 `dsh web` 并等待就绪**。壳与 DSH 版本完全解耦——升级 harness 后无需重建入口，打开即最新版。

**macOS 与 Windows 的形态区别**（功能一致，窗口形态不同）：

| | macOS | Windows |
|---|---|---|
| 入口形态 | `~/Applications/DSH Desktop.app`（启动台 / Dock 可见） | 开始菜单项 + 桌面快捷方式 |
| 窗口类型 | **原生独立 App**：系统 WebKit 编译壳（~90KB），Dock 显示自己的图标与名字、独立进程、独立 Cmd+Tab 身份，外链自动转默认浏览器 | Chromium（Edge/Chrome）`--app` 无栏窗口：无地址栏无标签页，但进程归属浏览器 |
| 图标 | `.icns`（三个 bloub 形象之一，设置页点选即换） | `.ico`（插件现场生成，快捷方式使用） |
| 依赖 | Xcode Command Line Tools（编译原生壳；缺失时自动回退浏览器窗口模式，功能不丢） | 无（PowerShell 系统自带，用于建快捷方式） |
| 冷启动后端 | 登录 shell 拉起（继承 nvm 等 PATH；记录的 dsh 绝对路径失效时自动回退 `PATH` 里的 `dsh`） | `start /B` 后台拉起 |
| 失败处理 | 窗口内错误页 + 一键重试（至多 150 秒） | 弹窗提示 + 日志（至多 120 秒） |

三个图标形象（设置页实时预览实际生成图）：

| id | 形象 | 出典 |
|---|---|---|
| `classic` | 经典黑球（默认） | cercle · neutre |
| `joy` | 大笑鹅卵石 | galet · hilare |
| `excite` | 兴奋胶囊 | capsule · excite |

- 持久化：`$DSH_HOME/dsh-bloub-mood/desktop-entry.json`，优先级 持久化 > `config.desktopEntry` > 默认
- 关闭开关 = 移除入口文件；重启后尊重持久化状态，不会擅自重建
- 日志：`~/.dsh/logs/desktop-entry.log`
- Host 路由：`GET /desktop-entry/api/state` · `POST .../enabled` · `POST .../icon` · `GET /desktop-entry/icon/:id.png`（mac/win 之外的平台设置页提示不支持）

## 小剧场（v2.0 引擎原生动画）

自动状态播放从 bloub 引擎逐帧渲染的 **GIF 小剧场**（透明背景，官网导出管线直出）：

| 状态 | 触发 | 小剧场 |
|---|---|---|
| 执行中 | 会话 `running` | 思考转圈 → **彗星冲刺** → 思考 |
| 等你输入 | `pendingInteraction` | 瞪眼 → 警觉 → **通知弹跳** |
| 完成待读 | `completed` | 惊叹 → 通知 → **爆散庆祝** |
| 空闲 | 以上都不是 | 呼吸 → 眨眼 → **六边形变身** |
| 困倦 | 空闲超 2 分钟 | 沉睡 |

优先级：等你输入 > 执行中 > 完成待读 > 空闲。多会话任一命中即触发。

## 点击交互

点击界面上的任何黑球 → **随机切换 16 种表情之一**（平静 / 专注 / 惊讶 / 兴奋 / 开心 / 大笑 / 生气 / 难过 / 害怕 / 怀疑 / 困惑 / 好奇 / 得意 / 羞怯 / 无趣 / 困倦），每个表情带原生 180 帧眨眼动画；下一次会话状态变化自动回归小剧场。设置页「表情」区可指定**默认表情**（空闲时的脸）。

## 安装

```bash
dsh plugin --profile web add dsh-bloub-mood
```

（npm 安装；也可 GitHub 源 `dsh plugin --profile web add github:Yuuhann1999/dsh-bloub-mood`）

重启 `dsh web`，刷新页面，在 **设置 → 心情图标** 挑造型、开桌面启动。

## 可配置项

| 配置 | 选项 | 默认 |
|---|---|---|
| 启用开关 | iOS 滑动开关，停用即完全恢复官方原样 | 启用 |
| 表情 | 16 种（默认表情；点击随机覆盖全池） | 平静 |
| 形状 | 圆形 / 卵石 / 圆角方 / 胶囊 / 三角 / 六边形 / 云朵 / 水滴 | 圆形 |
| 颜色 | 墨黑 / 棕 / 红 / 橙 / 琥珀 / 绿 / 青绿 / 蓝 / 紫 / 玫粉 / 灰 / 奶油 | 墨黑 |
| 主字标 | 侧边栏展开时的名字 | Yuuhann |
| 侧栏徽章 | 名字后的胶囊标签，留空隐藏 | 工作台 |
| 首页标题 | 输入框上方大标题，留空保留官方文案 | （空） |
| 首页徽章 | 标题旁胶囊标签，留空隐藏 | 预览版 |
| 桌面启动 | 开关（开 = 物化入口，关 = 移除） | 开 |
| 桌面图标 | 经典黑球 / 大笑鹅卵石 / 兴奋胶囊 | 经典黑球 |

心情配置存于 localStorage；桌面启动配置存于 `$DSH_HOME/dsh-bloub-mood/desktop-entry.json`，刷新与重启保持。

**双轨素材**：墨色时自动状态播放引擎 GIF 小剧场；切换颜色或点击表情时走 128 个表情 SVG 轨道（可染色、原生眨眼）。

## 特性

- **引擎原生动画**：40 个 GIF 小剧场从 bloub 官网导出管线逐帧渲染（真 Chrome + puppeteer 驱动），透明背景，深浅色主题皆宜
- **favicon 动画**：标签页图标跟随状态变化
- **侧边栏 / 首页 / wordmark 全位替换**：含 SVG 内部手术（鲸鱼 → 动图、字母 → 自定义文字、HARNESS 徽章 → 自定义）
- **macOS 原生桌面壳**：系统 WebKit 编译的独立 App 进程（Dock 自有图标 / 独立 Cmd+Tab / 外链转默认浏览器 / 离线自动拉起后端），零第三方依赖
- **i18n**：设置页全部文案接入 DSH 客户端 locale 服务，中英跟随界面语言实时切换
- **React 共存**：内联 style + 孤儿清扫 + attribute 监听三重自愈，折叠侧栏、路由切换不丢效果
- **即插即用**：纯客户端 + webServer 路由，无 API key、零网络请求

## 换素材（开发者）

- 表情 SVG：jsdom 程序化导出（见仓库 `export-one.mjs`）
- 剧本 GIF：puppeteer 驱动官网时间线导出（透明背景）
- 桌面图标：`assets-appicons/`（`.icns` + 256px PNG，sips + iconutil 生成）
- 重新构建：`node build.mjs` 内嵌全部素材
- 发版：`npm version` → push → `npm publish`

## 致谢

- [bloub](https://bloub.vercel.app/) — 动画引擎与素材（[jeremy-prt/bloub](https://github.com/jeremy-prt/bloub)，MIT）
- [dsh-web-attention-badge](https://github.com/Luaphes/dsh-web-attention-badge) — 状态→favicon 先例
- dsh-dream-skin — 设置页注入模式参考

## License

MIT
