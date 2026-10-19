# dsh-message-edit

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-1f6feb.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-DSH%20Web-4c8bf5.svg)](https://github.com/deepseek-ai/deepseek-harness)

**DSH Web 消息「编辑重发」插件** —— 给用户消息和 AI 最终回答都加上编辑按钮：

- **用户消息**：在用户气泡的动作行（copy / clock 同一排）插入铅笔按钮，点开修改该轮提问，确认后会话变成「第 1..N-1 轮逐字节相同前缀 + 新提问」，该轮及其之后的旧内容不再出现在会话里。
- **AI 消息**：在 AI 回答的动作行（官方 `conversation.chat.assistant-actions` slot，copy / branch 同一排）插入铅笔按钮，点开修改这条回答，确认后会话变成「该回答之前逐字节相同前缀 + 改写后的回答」，该回答之后的内容丢弃；**不自动重发**，之后可以继续对话。
- **待发送消息**：在还没发给模型的 steering 气泡上也插入铅笔按钮，直接改队列里的内容（官方 `session.updateQueue`），不新建会话。

原会话被**归档**而不是删除，日志完整保留，可从侧栏「已归档」随时找回。

```
编辑前                              编辑后
┌────────────────────────┐         ┌────────────────────────┐
│ 第 1 轮提问            │         │ 第 1 轮提问            │
│ 第 1 轮回答            │         │ 第 1 轮回答            │
│ 第 2 轮提问   ✏️       │  ───▶   │ 第 2 轮提问（新文本）  │
│ 第 2 轮回答            │         │ 第 2 轮回答            │
│ 第 3 轮提问            │         │                        │
└────────────────────────┘         └────────────────────────┘
                                   原会话 → 侧栏「已归档」
```

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:lxl8182/dsh-message-edit

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-message-edit
```

然后**重启 web 宿主** —— 客户端模块图只在 boot 时组建一次，HMR 不认新包。最后刷新浏览器。

零构建、零依赖：`lib/index.js` 与 `lib/client.js` 都是手写的普通 JavaScript，宿主只用 Node 内置模块，浏览器只 `require('react')` / `react-dom/client`。

自检（不需要重启）：

```sh
cd ~/.dsh/profiles/web && node --input-type=module \
  -e "const m = await import('dsh-message-edit'); console.log(Object.keys(m))"
# 期望 [ 'apply', 'inject', 'name' ]
```

## 行为

- 用户消息按钮只加在 `data-chat-flow-kind="user"` 的行上。steering 行共用同一个组件但 kind 不同；pending 回显气泡没有这个祖先，天然排除。
- AI 消息按钮通过官方 `conversation.chat.assistant-actions` slot 注册，只出现在已闭合回合的最终回答上（turn-tail）；中间步骤与带 tool-call 的回答不可编辑（宿主会拒绝）。
- 待发送（steering）气泡按 `[data-pending-steering]` 识别，通过官方 `session.updateQueue` 原地改队列内容；含附件/非纯文本时按钮仍显示，点击后用提示说明暂不支持。
- 编辑器预填原文；改过文本按钮显示「编辑并重发」，未改显示「重发」；空白或超 10 万字符时禁用。
- `Ctrl/Cmd + Enter` 直接提交，`Esc` / 点卡片外面 / 点「取消」都能关闭。
- 确认后切到新会话（`ctx.uiWorkspace.openSession`）。
- 卡片上标注「该轮之后的内容将被丢弃，原会话会被归档」。

## 为什么是「新建会话」而不是「回退旧会话」

官方没有任何回退已落盘会话的原语：

- 会话日志只追加。`SessionPersistence` 的全部接口是 `create / open / flush / stat / list`，没有 delete，也没有改写已提交字节的入口（只有崩溃恢复时的尾部截断）。
- 运行中的 Agent / Session 没有公开的释放接口。`ctx.agents` 的移除路径是模块私有的 `detachEntered`，`ctx.sessions.enter()` 对已存在的 id 直接抛错，而唯一能拿到 `AgentHandle.dispose()` 的调用方（`session-controller`）拿到后就把 handle 丢掉了。也没有任何 TTL / LRU 回收。

所以「释放旧会话再用同一个 sessionId 重建」在本机宿主上做不到。本插件改走官方支持的路径：

```
复制前缀到新会话  →  让官方认领会话  →  投递新提问  →  归档旧会话
```

前缀是**逐字节原样复制**的，因为 provider 侧的 prompt 缓存按前缀命中：前缀一旦变形，缓存整段失效。

## 切点规则（决定缓存是否命中）

复制到 `min(turn/start, 该轮提问) - 1`，并且从后往前退到最近一个**干净**位置。干净 = 同时满足：

1. 没有未闭合的 turn / step / compaction；
2. 没有已发出但没结果的 tool 调用；
3. 两个 inbox 队列（next-turn / next-step）都为空。

前三条保证 resume 不会往前缀尾部补合成事件；第四条避免旧提问被新会话当成待执行输入再跑一遍（编辑第 1 轮时必须满足）。

提问的定位方式是「turn N 里、第一条 `assistant/message` 之前的第一条 `source.kind === 'user'` 的 `user/message`」。注意提问是在 turn **内部**落盘的（turn/start 之后、step 里），所以「seq < turn/start 的最后一条 user/message」是错的。

代码里刻意**不做**「提问落在 turn/start 之前」的兜底：扫过本机 66 个会话日志 151 轮，这种排布一次都没出现；而一旦它为合成轮（goal continuation 等）生效，它会取到**上一轮**的提问，把「拒绝编辑」变成「悄悄改错一轮」。所以取不到就明确报 `synthetic-turn`。

## 接口

宿主注册两个 POST 端点：

| 端点 | 入参 | 返回 |
|---|---|---|
| `/dsh-message-edit/prepare` | `{ sessionId, turnNumber }` | `{ ok, text, cutSeq }` 或 `{ ok: false, error }` |
| `/dsh-message-edit/rewrite` | `{ sessionId, turnNumber, text, clientTimeZone? }` | `{ ok, sessionId }` 或 `{ ok: false, step, error, message }` |
| `/dsh-message-edit/prepare-assistant` | `{ sessionId, messageId }` | `{ ok, text }` 或 `{ ok: false, error }` |
| `/dsh-message-edit/rewrite-assistant` | `{ sessionId, messageId, text, clientTimeZone? }` | `{ ok, sessionId }` 或 `{ ok: false, step, error, message }` |

`prepare-assistant` / `rewrite-assistant` 的 `messageId` 就是日志里 `assistant/message.data.message.id`，也是前端 assistant-actions slot 的 owner prop。可编辑条件（不满足时 `error` 分别为 `assistant-message-not-found` / `assistant-message-has-tools` / `assistant-message-not-final` / `turn-not-closed` / `unsupported-content` / `turn-has-pending-input`）：该消息没有 tool-call 块、至少一个 text 块、是该回合最后一条 assistant/message、且回合已闭合。切点固定为该回合的 `turn/end`，前缀逐字节复制，只替换目标消息的 text 块（reasoning 与 message.id/usage/stream 原样保留），**不投递 prompt**。

`turn-has-pending-input` 针对 aborted / error 回合：这类回合结束时 next-step 队列里可能还挂着排队消息，前缀若把它们带进新会话，resume 后会在下一次提问时被当成 user message 注入，违反「该回答之后的内容丢弃」的语义；这种回合没有更早的干净切点，所以明确拒绝而不是悄悄回退。

`rewrite` 的失败语义（跨进程多阶段，`step` 指出失败位置）：

- `locate` / `persist`：无副作用（新会话尚未被认领），可直接重试。
- `adopt`：日志已落盘但无人认领，返回的 `sessionId` 是那个孤儿会话，宿主已顺手归档它。
- `prompt`：历史已重建但没重发；**不**归档源会话，用户可在新会话里手动补发。

## 已知限制

- **只支持纯文本**。该消息含图片 / 文件等非 text 块时，`prepare` 返回 `unsupported-content`，点击后弹提示。
- **AI 消息只支持「最终回答」**：只提供已闭合回合的最后一条 assistant/message；中间步骤、带 tool-call 的回答、未闭合（运行中）回合都不可编辑。编辑 AI 回答后不自动重发，需要用户自己继续对话。
- **待发送消息只在队列里改文本**：`updateQueue` 是官方接口，只对还在 inbox 里的消息有效；消息已被模型认领后按钮会失效并提示。
- **合成轮不可编辑**（goal continuation、`agent.inject()` 等）：这类 turn 里没有 human 提问，返回 `synthetic-turn`。
- **会话列表会多一条**。这是「无感」的代价 —— sessionId 会变，是宿主能力所限，不是实现取巧。旧会话出现在侧栏「已归档」里，可随时还原。
- **标题尽力而为**：新会话继承原标题（在投递新提问前写入，避免被自动标题抢先）；没有标题的会话留空让官方自动标题发挥。
- **工作区归属尽力而为**：新会话会挂到原会话所在的 workspace；失败只告警。
- 端点没有鉴权，与 DSH 其余本地 HTTP 面一致。
- v1 不做多窗口协同，操作后其它窗口需自行刷新。

## 验证情况

已在本机实际运行（真实会话日志 + 真实 React 组件 + jsdom/无头 Chrome）。新代码需要重启宿主才会被加载，因此「真实宿主加载后的点击链路」仍未验证（见文末）。

**宿主逻辑（用户消息）**

- `locateTurn` 跑遍本机 **66 个会话日志、151 轮**：148 轮可编辑、3 轮正确判为 `synthetic-turn`，**0 处不变量违规**（切点始终早于提问，且独立复算确认「干净」）。
- 其中 **56 个日志、83 个可编辑轮**做完整链路：用真实 `@deepseek-ai/dsh-session-persistence-jsonl` 写入复制前缀并读回，**83/83 前缀逐字节相同**（`inheritedEventCount: 0`），派生消息序列 **83/83 前缀不变、恰好追加 1 条**（最深一例 162 条消息）。
- 用户消息的两个端点用桩 ctx 单测全部错误分支：`session-not-found` / `synthetic-turn` / `turn-not-found` / `bad-session-id` / `bad-turn-number` / `empty-text` / `text-too-long` / `bad-time-zone` 都返回预期码，非 POST 返回 405。
- `rewrite` 的五条路径实测：正常流程为 `create → append → flush → close → adopt → prompt → archive(源)`；`persist` 失败无副作用；`adopt` 失败会归档孤儿新会话；`prompt` 失败**不**归档源会话；`archive` 失败返回 `archived: false` 但仍算成功。
- 真实端到端跑通一次：`prepare` 取到原文、`rewrite` 返回新 sessionId，磁盘上出现新日志（前缀逐字节相同 + `session/end-seed` + 新提问 + 助手回复），源会话仍完整保留、已进归档集、标题已沿用。

**宿主逻辑（AI 回答，本次新增）**

- 真实日志（`session-456e6bae…`，1265 事件 / 4 轮）跑通：`prepare-assistant` 取到 turn 1 / turn 4 最终回答原文；`rewrite-assistant` 生成的前缀长度 = 该轮 `turn/end.seq + 1`（1240 / 1264），除目标事件外逐事件与源日志 deep-equal，被替换事件 `content = [原 reasoning, 新 text]`，`message.id / turn / step / usage / stream` 全部保留，**未调用 prompt**，源会话被归档。
- 桩 ctx 单测覆盖：正常路径 + `assistant-message-not-found` / `assistant-message-has-tools` / `assistant-message-not-final` / `turn-not-closed` / `unsupported-content` / `turn-has-pending-input` / `empty-text` / `text-too-long` / `bad-message-id` / 405；用户消息旧端点回归 19 个场景行为与调用序列一致。
- 独立复核扫本机 **325 个 v4 日志 / 8227 条 assistant/message / 652 轮**：message.id 全唯一、无消息落在自己回合的 `turn/end` 之后，定位规则未发现误判；其中 18 个 aborted/error 回合的 next-step 队列非空（新增 `turn-has-pending-input` 拒绝，其中 1 个否则会被误放行）。
- 全量统计：可编辑最终回答 451 轮、含 tool-call 73 轮、reasoning-only 54 轮、未闭合 5 轮，与各错误码分布一致。

**浏览器半边**

- 按钮注入：用户消息 `[data-chat-flow-kind="user"]` 与待发送 `[data-pending-steering]` 气泡都能注入铅笔按钮，重复扫描不重复注入；durable steering 行、无动作行消息不注入。
- jsdom + 真实 React 18 冒烟测试 **93 项全过**：三种入口的按钮注入/幂等、卡片三种模式的标题/副标题/警示/按钮文案、`prepare` / `rewrite` / `updateQueue` 请求体、内联 `role=alert` 错误、toast、`Esc` / 点卡片外 / `Ctrl+Enter`、busy 态、卸载清理。
- 视觉：用 jsdom 渲染真实组件 + 插件样式表，再用无头 Chrome 截图（明/暗两套主题 × 用户/AI/待发送三种模式），确认卡片贴靠消息、圆角/阴影/警示条/按钮层级正常，明暗主题令牌都命中。

**未验证**

- 新代码由真实宿主加载后的端到端点击链路（当前宿主进程承载着开发会话，不能重启；重启 DSH 后才会加载本版本）。
- 点保存后的**会话切换**（`uiWorkspace.openSession`）：该调用与站内 fork / branch 用的是同一个原语，但本次没有在 UI 上真正提交（会新建会话并触发一次模型请求）。
- 插件被停用 / 卸载时的清理：本机 loader 不暴露 `invalidate`，无法在运行中触发卸载；清理逻辑按 `ctx.effect` 契约编写，并用「孤儿容器恢复」用例验证了 root 回收路径。

## 结构

```
lib/index.js     宿主半边：/prepare、/rewrite、/prepare-assistant、/rewrite-assistant
lib/client.js    浏览器半边：用户消息/待发送消息 DOM 注入 + AI 回答 slot + 浮动编辑器
_verify/         本机验证脚本（桩 ctx 单测、真实日志回归、jsdom 冒烟、无头截图；不在发布 files 里）
cordis.patch.yml bundle 层，插入宿主行
```

## License

[MIT](./LICENSE)
