# dsh-message-edit

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-1f6feb.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-DSH%20Web-4c8bf5.svg)](https://github.com/deepseek-ai/deepseek-harness)

**DSH Web 用户消息「编辑重发」插件** —— 在用户气泡的动作行（copy / clock 同一排）插入一个铅笔按钮。点开修改该轮提问，确认后会话**原地变成「第 1..N-1 轮逐字节相同前缀 + 新提问」**，该轮及其之后的旧内容不再出现在会话里。

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

- 按钮只加在 `data-chat-flow-kind="user"` 的行上。steering 行共用同一个组件但 kind 不同；pending 回显气泡没有这个祖先，天然排除。
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

`rewrite` 的失败语义（跨进程多阶段，`step` 指出失败位置）：

- `locate` / `persist`：无副作用（新会话尚未被认领），可直接重试。
- `adopt`：日志已落盘但无人认领，返回的 `sessionId` 是那个孤儿会话，宿主已顺手归档它。
- `prompt`：历史已重建但没重发；**不**归档源会话，用户可在新会话里手动补发。

## 已知限制

- **只支持纯文本**。该消息含图片 / 文件等非 text 块时，`prepare` 返回 `unsupported-content`，点击后弹提示。
- **合成轮不可编辑**（goal continuation、`agent.inject()` 等）：这类 turn 里没有 human 提问，返回 `synthetic-turn`。
- **会话列表会多一条**。这是「无感」的代价 —— sessionId 会变，是宿主能力所限，不是实现取巧。旧会话出现在侧栏「已归档」里，可随时还原。
- **标题尽力而为**：新会话继承原标题（在投递新提问前写入，避免被自动标题抢先）；没有标题的会话留空让官方自动标题发挥。
- **工作区归属尽力而为**：新会话会挂到原会话所在的 workspace；失败只告警。
- 端点没有鉴权，与 DSH 其余本地 HTTP 面一致。
- v1 不做多窗口协同，操作后其它窗口需自行刷新。

## 验证情况

已在本机实际运行（真实宿主代码 + 真实持久化后端 + 真实会话日志 + 真实浏览器）。

**宿主逻辑**

- `locateTurn` 跑遍本机 **66 个会话日志、151 轮**：148 轮可编辑、3 轮正确判为 `synthetic-turn`，**0 处不变量违规**（切点始终早于提问，且独立复算确认「干净」）。
- 其中 **56 个日志、83 个可编辑轮**做完整链路：用真实 `@deepseek-ai/dsh-session-persistence-jsonl` 写入复制前缀并读回，**83/83 前缀逐字节相同**（`inheritedEventCount: 0`），派生消息序列 **83/83 前缀不变、恰好追加 1 条**（最深一例 162 条消息）。
- 两个端点用桩 ctx 单测全部错误分支：`session-not-found` / `synthetic-turn` / `turn-not-found` / `bad-session-id` / `bad-turn-number` / `empty-text` / `text-too-long` / `bad-time-zone` 都返回预期码，非 POST 返回 405。
- `rewrite` 的五条路径实测：正常流程为 `create → append → flush → close → adopt → prompt → archive(源)`；`persist` 失败无副作用；`adopt` 失败会归档孤儿新会话；`prompt` 失败**不**归档源会话；`archive` 失败返回 `archived: false` 但仍算成功。
- 真实端到端跑通一次：`prepare` 取到原文、`rewrite` 返回新 sessionId，磁盘上出现新日志（前缀逐字节相同 + `session/end-seed` + 新提问 + 助手回复），源会话仍完整保留、已进归档集、标题已沿用。

**浏览器半边**

- 按钮注入：9 条用户消息 → 9 个按钮，样式表带 `data-plugin` 标记。
- 编辑器：预填原文、自动聚焦并选中末尾；改动后按钮变「编辑并重发」，清空后禁用；`取消` / `Esc` / 点卡片外都能关闭且无残留 DOM。
- 视觉：截图确认铅笔按钮与官方 copy 同排、卡片浮层布局正常。

**未验证**

- 点「重发」后的**会话切换**（`uiWorkspace.openSession`）：该调用与站内 fork / branch 用的是同一个原语，但本次没有在 UI 上真正提交（那会新建会话并触发一次模型请求），所以未做端到端点击验证。
- 插件被停用 / 卸载时的清理：本机 loader 不暴露 `invalidate`，无法在运行中触发卸载；清理逻辑按 `ctx.effect` 契约编写，并用「孤儿容器恢复」用例验证了 root 回收路径。

## 结构

```
lib/index.js     宿主半边：/dsh-message-edit/prepare 与 /rewrite
lib/client.js    浏览器半边：动作行按钮注入 + 浮动编辑器
cordis.patch.yml bundle 层，插入宿主行
```

## License

[MIT](./LICENSE)
