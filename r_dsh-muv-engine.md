# ⚙️ dsh-muv-engine

DSH 原生 MUV 引擎 —— 酒馆伴生插件。

> 🔗 依赖 [dsh-muv-table](https://github.com/chen731215-dev/dsh-muv-table)，配合 [dsh-tavern-v2](https://github.com/chen731215-dev/dsh-tavern-v2) 使用。

## 🆕 v0.4.3 更新内容（2026-10-17）

### 状态栏数值与角色卡完整性

- **`[0]` 数组路径**：`_.set('系统.时间[0]', …)` 落成 `{系统:{时间:['…']}}`，卡里
  `_.get(sys,'时间')[0]` 能读到；旧版存成字面键 `"时间[0]"` ⇒ 状态栏全「未知」。
- **三参 `_.set(path, 旧值, 新值)`** 取第三参为新值（`{scope}` 选项对象仍取第二参）。
- **卡脚本父页遮罩**：沙箱 iframe 内把 `parent`/`top` 指向自身（ST 顶层文档语义），
  宿主通信走 `__muvRealParent`；修掉 `SecurityError` 导致状态栏脚本中断。
- **会话 id 用 `retainedBy.mainView`**：切会话后不再拿到旧 id、拿错卡。
- **initvar 播种**：空会话用卡自带 `initvarData` 播种，角色表完整（已有数据的会话不动）。
- **era 补推 + 自动状态栏**：切回会话/漏标记也能拿到变量、补出状态栏。

> 升级后请重启 DSH（变量状态是内存态，会按消息重新回灌）。

## 🆕 v0.4.0 更新内容

> 注：当前包版本 **0.4.2 是纯文档修正版**——运行时代码与依赖声明均未改动，仅版本号抬到 0.4.2；
> 0.4.1 只改了依赖声明，功能内容止于 v0.4.0，所以下面的要点仍以 v0.4.0 为准。

### 状态栏两笔修复

- **真卡状态栏围栏不剥**（状态栏不显示 / 整段 HTML 裸奔之根）：真卡的状态栏脚本常见这种形态——
  **无语言标记的裸 ``` 围栏包着一整个 `<head>…<body>…</body>` 文档**（没有 `<!doctype>`、也没有
  `<html>` 包裹）。而「这算不算一整个 HTML 文档」的判定只认 `<!doctype` / `<html` 开头
  ⇒ 围栏不剥、正文不转 iframe，围栏残留成多余代码块、整段 HTML 裸奔。
  现在判定补第三条路：`<head` 与 `<body` **同时出现即认**（单个出现仍不算，片段 / 教程代码块不误伤）。
- **空状态栏（全 `未知`）刷屏根治**：补占位符不再「卡认就补」，收紧为「卡认标记 **且**
  （消息带内联变量块 或 会话有变量树）」——消息信号看 `<UpdateVariable>` / `<initvar>` /
  `<VariableEdit>` / `<era_data>`，会话级要求 ERA 变量缓存归属当前会话、**空树则不补**。
  有数据的卡状态栏照常显示；真没数据的楼不再挂字段全是兜底 `未知` 的空卡。
  ⚠️ 一个不能省的细节：**取数在途时乐观放行**（防首帧竞态把先头几楼的状态栏灭灯）——
  改动这条判据时不要反向收紧成「必须已有数据才补」。
- **导入路径修复确认**（issue #1）：主分支已无 `../../muv-table` 形态的引用。

> 注：这批在 CHANGELOG 里挂在「未发布（产品修复 · 2026-10-10）」标题下，**属标题滞后**——
> 它们已随 0.4.0 的 tarball 发出（实测包内 `muvIsPageSourceText` 由 0.3.11 的 2 文件 / 4 处
> 变为 0.4.0 的 3 文件 / 7 处）。

## 🆕 v0.3.4 更新内容

本次是一个**大修版**，修的都是「不报错但结果不对」的静默失败；同时新增了诊断工具。

### 状态栏渲染

- **行动选项不再整段消失**：三级解析器（yaml / free / loose）对选项标记的支持范围
  不一致，导致 `A.` `B.` `C.` 这种最常用的写法被静默丢弃。现在统一支持
  `A.` `A、` `1.` `1、` `-` `•` 以及无前缀的裸选项。
- **支持任意字段**：以前只认 `名字/行动/内心/衣着` 四个字段，卡片实际给出的
  `穿搭/小穴/胸部/肛门/阳具/最近性行为` 等**全部丢失**。现在按 `标签: "值"` 通用提取，
  卡片写什么就渲染什么。
- **条目不再要求从行首开始**：`用户列表: - 用户: 名字: "…"` 这种带前缀的写法以前会
  导致**整条角色丢失**，只剩一个头部条。
- 选项标题兼容英文 `Options` / `Choices` / `Actions` / `Select`；兼容 `## 行动选项`
  这类 markdown 装饰；章节标签不再重复渲染；选项挤在一行时也能正确拆分。

### 消息渲染

- **修复插画不显示、原始标签糊满屏幕**：取角色卡时只用 sessionId 定位，三种兜底
  全落空时会拿到**别人的卡**，于是卡里的正则**全部静默不执行**——`<img>` 不被替换、
  隐藏块不生效。现在优先使用酒馆界面上的当前预设。
- **纯 `<choices>` 回复**（没有状态栏、只有剧情+选项）以前会被入口闸门跳过，现在能渲染。
- **变量块**：识别 `<VariableInsert>` / `<VariableEdit>` / `<VariableThink>` / `<Abstract>`，
  收进折叠卡片而不是把 JSON 糊在屏幕上。
- 消息定位改用**形状匹配 + 块级子节点判定**，不再依赖会随 DSH 重建变化的 CSS Modules
  哈希，也不会误伤同名的文件类型图标。

### 新增诊断工具 `diag.mjs`

一条命令查完：服务器是否加载了新代码、每个预设绑的哪张卡、SillyTavern PNG 卡库、
实时 API 返回，还能**把一段消息过一遍渲染管线**（报用了哪张卡、正则是否命中、
有无残留标签、外链图片是否可达）。

```bash
node diag.mjs                 # 全量体检
node diag.mjs --tests         # 附带跑回归
node diag.mjs --preset <id> --msg-file msg.txt   # 测一条消息
```

> 回归测试从 46 项增至 **84 项**（`tests/test-status-cascade.mjs`）。

## 是什么

替代 MagVarUpdate 的 DSH 原生实现，v0.3.0 起融合了 dsh-visual-render：

### 🎮 变量与状态
- **正则引擎**：执行角色卡 `regex_scripts`，实时替换 LLM 输出
- **变量追踪**：跨对话轮次追踪变量状态，自动提取 `<UpdateVariable>` 块
- **状态栏渲染**：提取 `<StatusPlaceHolderImpl/>` 的 HTML，iframe 沙箱渲染

### 🎲 宏展开
聊天输入框内直接写宏，按 Enter 自动展开后发送给 AI：

```
{[random::去酒楼::去坊市::去洞府]}     → 每次随机选一个
{[pick::宝箱::灵石x50::剑谱::丹药]}    → 固定结果，缓存为「宝箱」
{[roll::2d6+3]}                       → 掷 2d6 加 3 调整值
```

- 支持调整值：`{[roll::1d20+5]}`、`{[roll::3d6-1]}`
- pick 缓存可用 `_tavernRerollPick('key')` 重抽（浏览器控制台）
- 控制台调试：`_tavernExpandMacros('...')` / `_tavernListPicks()`

### 🏷️ 标签渲染
AI 输出自动美化（`_tavernRenderTags` 钩子），支持**转义形态**（`&lt;标签&gt;`）：

| 标签 | 效果 |
|---|---|
| `<speech>` | 斜体灰色对白 |
| `<action>` | 绿色斜体动作 |
| `<thought>` / `<thinking>` | 紫色斜体内心 |
| `<char>` / `<character>` | 金色粗体角色名 |
| `<dialogue>` | 蓝色左边框 |
| `<赏令接取>` ~ `<自由开局>` | 独立配色游戏卡片（金/紫/青/蓝/青绿/橙） |
| `<Drama>` | 暗红渐变戏剧卡片（含 `.mys` 内容区样式） |
| `<choices>` | 选项按钮（按行解析，支持 `A、`/`1.`/`•`/无前缀） |
| `<style>` | 自动剥离（世界书模板 CSS 不展示） |
| `<inventory>` / `<背包>` / `<skill>` | 折叠列表卡片 |
| `<quote>` / `<引用>` | 引用块 |

### 🖼️ visual 代码块渲染（融合 dsh-visual-render）
聊天里 `` ```visual `` 代码块自动渲染为沙箱 HTML 界面：

- 信纸 / 终端 / 报纸 / 手机 / 浏览器组件
- `options` 代码块 → 可点击剧情选项按钮
- `aside` 代码块 → 淡色旁白
- `scene` 代码块 → 场景标题卡
- iframe `sandbox` 隔离，安全运行

### 🌠 LaTeX 渲染
`\(...\)` 公式自动渲染（含 array/fcolorbox/colorbox/textcolor/rule 等）。

## 🧪 开发与测试

脚本按用途分家：`tests/`（可断言的测试）、`tools/verify/`（门禁）、`tools/repro/`（复现探针）。

```bash
npm test            # 逐文件独立跑 tests/，独立判红；**空跑即失败**（报告器在场却 0 项断言 ⇒ ❔）
npm run test:all    # 再加上 tools/verify/ 与 tools/repro/（多数需要真卡 / 真会话 / 真浏览器）
npm run check       # 全仓语法：lib/ + tests/ + tools/，按 ESM 解析
npm run check:hygiene   # 仓库卫生：不许出现凭据 / 会话记录 / 本机路径 / 临时产物
npm run ci:local        # 与 CI 工作流同一组命令、同一顺序
node tools/verify/<脚本名>.mjs   # 单跑某个门禁
```

> 本机没装 `npm` 时，用等价命令：`node tools/run-each-test.mjs` / `node --no-warnings --experimental-vm-modules tools/check-syntax.mjs`。
> 想启用提交前卫生检查（每个克隆做一次）：`git config core.hooksPath .githooks`。

## 安装

```bash
dsh plugin --profile web add dsh-muv-engine
```

## API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/muv-engine/expand-macros` | POST | 服务端展开宏（random/pick/roll） |
| `/api/muv-engine/reroll-pick` | POST | 清除 pick 缓存 |
| `/api/muv-engine/apply-regex` | POST | 对文本执行正则脚本 |
| `/api/muv-engine/apply-regex-card` | POST | 从卡片 JSON 执行正则（生效脚本集 = 全局先 + 卡级后） |
| `/api/muv-engine/global-regex` | GET/POST/DELETE | 全局正则脚本库：列出 / 导入（ST 导出件宽容解析）/ 删除 |
| `/api/muv-engine/state` | GET/POST | 获取/更新变量状态 |
| `/api/muv-engine/extract` | POST | 提取 `<initvar>` 并生成 MUV 块 |
| `/api/muv-engine/generate` | POST | 编辑后生成 MUV 块 |
| `/api/muv-engine/status-bar` | POST | 提取状态栏 HTML |

## 协议

PolyForm-Noncommercial-Copyleft-1.0.0 — 详见 [LICENSE](./LICENSE)