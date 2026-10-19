/**
 * dsh-message-edit —— 宿主半边。
 *
 * 做两件官方没有的事：
 *   1. 把某一轮的提问改掉重发，该轮及其之后的内容丢弃；
 *   2. 把某轮 AI 最终回答改掉，该回答及其之后的内容丢弃（不重发，用户之后自行继续）。
 *
 * 官方没有「回退已落盘的会话」的原语：会话日志只追加（`SessionPersistence`
 * 只有 create/open/flush/stat/list，没有 delete），运行中的 Agent/Session 也没有
 * 公开的释放接口（`ctx.agents` / `ctx.sessions` 的移除路径都是模块私有）。
 * 所以这里不原地改写旧日志，而是：
 *
 *   1. 把源会话日志第 0..cut 号事件**逐字节原样**复制进一个**新会话**（新 id，
 *      不设 parentSession、不设 isSeeded 继承标记），
 *   2. 让官方 `sessionController.create` 认领这个新会话（走的是 resume 采用路径），
 *      它从复制的 `request/header`（或更早的 `model/selection`）恢复 provider/model，
 *      并按头部挂载原 agent preset，
 *   3. 用编辑后的文本投递 prompt，
 *   4. 归档源会话（不是删除：日志完整保留，可从侧栏「已归档」找回）。
 *
 * 「逐字节复制前缀」是刻意的：provider 侧的 prompt 缓存按前缀命中，前缀一旦
 * 变形就等于整段失效。因此切点必须落在**干净**的位置：没有未闭合的 turn/step、
 * 没有未答复的 tool 调用、没有未闭合的 compaction，且 inbox 队列为空 ——
 * 否则 resume 会补合成事件、或把旧提问当成待执行输入再跑一遍。
 *
 * @module dsh-message-edit
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-message-edit'

export const inject = [
  'webServer',
  'sessions',
  'sessionController',
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
]

/** 客户端 fetch 的端点。 */
const PREPARE_ROUTE = '/dsh-message-edit/prepare'
const REWRITE_ROUTE = '/dsh-message-edit/rewrite'
const PREPARE_ASSISTANT_ROUTE = '/dsh-message-edit/prepare-assistant'
const REWRITE_ASSISTANT_ROUTE = '/dsh-message-edit/rewrite-assistant'

/** 会话 id 直接参与文件路径拼接，所以只放行 uuid 风格的字面量。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

/** 消息 id 同样只放行 uuid 风格的字面量，避免把任意字符串带进日志查询。 */
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

/** 与 PLAN 一致的长度上限。 */
const MAX_TEXT_LENGTH = 100_000

/** 10 万中文字符的 JSON body 约 300KB，必须大于文本上限对应的序列化体积。 */
const MAX_BODY_BYTES = 512 * 1024

function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new Error('body too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 把一个 user/message 的 content 读成纯文本。
 *
 * v1 只支持纯文本：只要出现非 text 块就拒绝，避免悄悄丢掉附件语义。
 * @param content - 事件里的 content 数组。
 * @returns 文本；含非文本块时返回 undefined。
 */
function textOfContent(content) {
  if (!Array.isArray(content) || content.length === 0) return undefined
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text'
      || typeof block.text !== 'string') return undefined
    parts.push(block.text)
  }
  // 单块是常态：原样返回，保证预填与原文逐字符一致。
  return parts.length === 1 ? parts[0] : parts.join('\n\n')
}

/**
 * 增量跟踪「前缀是否干净」的游标。
 *
 * 干净 = 没有未闭合的 turn / step / compaction，没有未答复的 tool 调用，
 * 且两个 inbox 队列都为空。单遍前向扫描即可，避免对每个候选切点重算。
 */
class PrefixState {
  constructor() {
    this.openTurn = false
    this.openStep = false
    this.openCompaction = false
    this.pendingCalls = new Set()
    this.inbox = { 'next-turn': [], 'next-step': [] }
    this.broken = false
  }

  /**
   * 消费一个事件，推进所有维度。
   * @param event - 下一个事件（seq 递增）。
   */
  observe(event) {
    switch (event.type) {
      case 'turn/start':
        this.openTurn = true
        this.openStep = false
        this.pendingCalls.clear()
        break
      case 'turn/end':
        this.openTurn = false
        this.openStep = false
        this.pendingCalls.clear()
        break
      case 'step/start':
        this.openStep = true
        break
      case 'step/end':
        this.openStep = false
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message?.content ?? []) {
          if (block.type === 'tool-call') this.pendingCalls.add(block.id)
        }
        break
      case 'tool/result':
        this.pendingCalls.delete(event.data.message?.source?.callId)
        break
      case 'compaction/start':
        this.openCompaction = true
        break
      case 'compaction/end':
        this.openCompaction = false
        break
      case 'agent/inbox/spliced': {
        const queue = this.inbox[event.data.target]
        const splice = event.data
        const removed = splice.removedCount ?? 0
        if (queue === undefined
          || !Number.isSafeInteger(splice.start) || splice.start < 0
          || splice.start > queue.length || splice.start + removed > queue.length) {
          // 官方投影会把这种拼接判成损坏日志；这里标记为不干净，切点继续往前退。
          this.broken = true
          break
        }
        queue.splice(splice.start, removed, ...(splice.inserted ?? []))
        break
      }
      default:
        break
    }
  }

  /** @returns 此刻能否作为复制切点。 */
  get clean() {
    return !this.broken
      && !this.openTurn && !this.openStep && !this.openCompaction
      && this.pendingCalls.size === 0
      && this.inbox['next-turn'].length === 0
      && this.inbox['next-step'].length === 0
  }
}

/**
 * 定位「第 N 轮提问」并算出可安全复制的前缀切点。
 *
 * 顺序与直觉相反，这点必须按真实日志来：提问是在 turn **内部**落盘的 ——
 * 驱动先从 inbox 认领它（先前有一条 `agent/inbox/spliced`），再开 turn，然后在
 * step 里 append `user/message`。实测日志里 `turn/start` 在 seq 7，而该轮提问在
 * seq 11。所以「提问 = seq < S 的最后一条 user/message」是错的；正确的是
 * 「turn N 里、第一条 assistant/message 之前的第一条 source.kind === 'user' 的
 * user/message」。
 *
 * 刻意**不**做「提问落在 turn/start 之前」的兜底：扫过本机 66 个会话日志 151 轮，
 * 这种排布一次都没出现；而一旦它为合成轮（goal continuation 等）生效，它会取到
 * **上一轮**的提问，把「拒绝编辑」变成「悄悄改错一轮」。所以取不到就明确报
 * synthetic-turn。
 *
 * @param events - 源日志（seq 从 0 连续）。
 * @param turnNumber - 目标轮号（1 起）。
 * @returns `{ cutSeq, text }`，不可编辑时返回 `{ error }`。
 */
function locateTurn(events, turnNumber) {
  let startSeq
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn === turnNumber) {
      startSeq = event.seq
      break
    }
  }
  if (startSeq === undefined) return { error: 'turn-not-found' }

  // 该轮提问：turn/start 之后、下一条 assistant/message 之前的第一条 human 提问。
  let questionSeq
  for (const event of events) {
    if (event.seq < startSeq) continue
    if (event.type === 'turn/start' && event.data.turn !== turnNumber) break
    if (event.type === 'assistant/message') break
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      questionSeq = event.seq
      break
    }
  }
  // 取不到提问 = 合成轮（goal continuation、agent.inject 之类），不提供编辑。
  if (questionSeq === undefined) return { error: 'synthetic-turn' }

  const question = events.find((event) => event.seq === questionSeq)
  if (question === undefined) return { error: 'turn-not-found' }
  const text = textOfContent(question.data.content)
  if (text === undefined) return { error: 'unsupported-content' }

  // 切点必须早于 turn/start，也早于提问本身。
  const ceiling = Math.min(startSeq, questionSeq)
  const state = new PrefixState()
  let cutSeq = -1
  for (const event of events) {
    if (event.seq >= ceiling) break
    state.observe(event)
    if (state.clean) cutSeq = event.seq
  }
  return { cutSeq, text, questionSeq }
}

/**
 * 定位「某轮 AI 最终回答」并算出可安全复制的前缀切点。
 *
 * 前端从官方 `conversation.chat.assistant-actions` slot 拿到的 messageId
 * 就是日志里 `assistant/message.data.message.id`，所以这里按消息 id 反查事件。
 * 可编辑条件（缺一不可，否则明确报错而不是猜）：
 *   1. 该消息没有 tool-call 块（否则改写会破坏工具调用链）；
 *   2. 至少有一个 text 块（纯 reasoning 的消息没有可编辑的可见文本）；
 *   3. 它是所在 turn 的最后一条 assistant/message（中间步骤的改写没有意义）；
 *   4. 该 turn 已闭合（有 turn/end），切点就是那条 turn/end。
 *
 * 切点落在 turn/end 上，所以前缀天然「干净」：没有未闭合 turn/step、没有
 * 未答复的 tool 调用、inbox 队列也已被该轮消费。之后只需把目标事件的内容
 * 替换掉，逐字节复制其余事件即可。
 *
 * @param events - 源日志（seq 从 0 连续）。
 * @param messageId - 目标 assistant 消息 id。
 * @returns `{ cutSeq, targetSeq, text }`，不可编辑时返回 `{ error }`。
 */
function locateAssistant(events, messageId) {
  let targetIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'assistant/message' && event.data?.message?.id === messageId) {
      targetIndex = index
      break
    }
  }
  if (targetIndex < 0) return { error: 'assistant-message-not-found' }

  const target = events[targetIndex]
  const turn = target.data.turn
  const content = Array.isArray(target.data.message.content) ? target.data.message.content : []
  if (content.some((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')) {
    return { error: 'assistant-message-has-tools' }
  }
  const textBlocks = content.filter((block) => block !== null && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string')
  if (textBlocks.length === 0) return { error: 'unsupported-content' }

  // 目标之后必须先遇到本 turn 的 turn/end，且中间不能再有 assistant/message。
  let cutSeq
  for (let index = targetIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'assistant/message' && event.data?.turn === turn) {
      return { error: 'assistant-message-not-final' }
    }
    if (event.type === 'turn/end' && event.data?.turn === turn) {
      cutSeq = event.seq
      break
    }
  }
  if (cutSeq === undefined) return { error: 'turn-not-closed' }

  // turn/end 只在正常结束的回合上是干净切点：aborted/error 回合可能把排队中的
  // next-step 输入留在 inbox 里（日志上就是该 turn/end 时队列非空）。这些输入
  // 若随前缀复制进新会话，resume 后会在下一次提问时被当成 user message 注入，
  // 违反「该回答之后的内容丢弃」的语义。这里复用用户消息编辑的干净判定；
  // 目标消息之后没有更早的干净切点，所以只能拒绝，不能悄悄回退。
  const state = new PrefixState()
  for (const event of events) {
    if (event.seq > cutSeq) break
    state.observe(event)
  }
  if (!state.clean) return { error: 'turn-has-pending-input' }

  return {
    cutSeq,
    targetSeq: target.seq,
    text: textBlocks.length === 1 ? textBlocks[0].text : textBlocks.map((block) => block.text).join('\n\n'),
  }
}

/**
 * 把一条 assistant/message 的可见文本换成编辑后的文本。
 *
 * 只替换 text 块：第一个 text 块的位置放新文本，其余 text 块丢弃；reasoning
 * 块与事件的所有其它字段（seq/time/turn/step/message.id/usage/stream）原样保留，
 * 避免破坏 provider 侧的推理签名与 token 统计。
 *
 * @param event - 目标 assistant/message 事件。
 * @param text - 编辑后的可见文本。
 * @returns 内容已替换的新事件对象。
 */
function withEditedText(event, text) {
  const content = event.data.message.content
  const next = []
  let placed = false
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (!placed) {
        next.push({ ...block, text })
        placed = true
      }
      continue
    }
    next.push(block)
  }
  return {
    ...event,
    data: {
      ...event.data,
      message: { ...event.data.message, content: next },
    },
  }
}

/**
 * 读一个会话的事件日志（内存优先，否则走持久化）。
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 目标会话 id。
 * @returns `{ header, events }`；会话不存在时返回 `{ error: 'session-not-found' }`。
 */
async function observe(ctx, sessionId) {
  let observation
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  } catch (error) {
    // 「找不到」是可预期的用户输入问题，不该翻成 500。
    if (error !== null && typeof error === 'object' && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return { error: 'session-not-found' }
    }
    throw error
  }
  try {
    return { header: observation.header, events: [...observation.events] }
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/**
 * 取源会话最后一个 session/title 的文本。
 * @param events - 源日志。
 * @returns 标题，没有则 undefined。
 */
function titleFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  }
  return undefined
}

/**
 * 把源会话标题写回新会话。
 *
 * 必须在投递新 prompt **之前**做：用户改名会把标题钉住，之后自动标题 provider
 * 不再覆盖；反过来先投递就可能被自动标题抢先。
 * @param ctx - 宿主 Cordis 上下文。
 * @param newId - 新会话 id。
 * @param sourceEvents - 源日志，用于取原标题。
 */
function restoreTitle(ctx, newId, sourceEvents) {
  const titles = ctx.get('sessionTitle')
  if (titles === undefined) return
  const live = ctx.sessions.get(newId)
  if (live === undefined) return
  const title = titleFromEvents(sourceEvents)
  if (title === undefined) return
  try {
    titles.rename(live, title)
  } catch (error) {
    // 标题只是观感：拿不到就留空让官方自动标题发挥，不算重写失败。
    ctx.logger.warn('[dsh-message-edit] could not restore the session title:', error)
  }
}

/**
 * 把新会话挂到源会话所在的 workspace 上（侧栏/工作区分组才看得到）。
 *
 * 只是可见性问题：失败不影响重写本身，所以只告警。
 * @param ctx - 宿主 Cordis 上下文。
 * @param sourceId - 源会话 id。
 * @param newId - 新会话 id。
 */
async function attachWorkspace(ctx, sourceId, newId) {
  try {
    const owner = ctx.workspaceRegistry.list().find((ws) => ws.sessionIds.includes(sourceId))
    if (owner === undefined) return
    await owner.attachSession(newId)
  } catch (error) {
    ctx.logger.warn('[dsh-message-edit] new session created but not attached to its workspace:', error)
  }
}

/**
 * 把源会话日志的干净前缀原样写成一个新会话的持久日志。
 *
 * 写完立刻关闭句柄：紧接着的认领走 persistence 的 write open，同一 id 的第二个
 * 写句柄会被 SessionAlreadyOwnedError 挡掉。
 * @param ctx - 宿主 Cordis 上下文。
 * @param header - 源会话头部（提供 version / cwd / agentPreset）。
 * @param newId - 新会话 id。
 * @param prefix - 要逐字节复制的 0..cutSeq 事件。
 * @returns 失败时抛出。
 */
async function persistPrefix(ctx, header, newId, prefix) {
  const handle = await ctx.sessionPersistence.create({
    version: header.version,
    id: newId,
    createdAt: Date.now(),
    cwd: header.cwd,
    isSeeded: false,
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  })
  try {
    if (prefix.length > 0) await handle.append(prefix)
    await handle.flush()
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  await handle.close()
}

/**
 * prepare：给编辑器预填原文，并确认这一轮可编辑。
 * @param ctx - 宿主 Cordis 上下文。
 * @param body - 已校验的 `{ sessionId, turnNumber }`。
 * @returns 结果载荷。
 */
async function prepare(ctx, body) {
  const observed = await observe(ctx, body.sessionId)
  if (observed.error !== undefined) return { ok: false, error: observed.error }
  const located = locateTurn(observed.events, body.turnNumber)
  if (located.error !== undefined) return { ok: false, error: located.error }
  return { ok: true, text: located.text, cutSeq: located.cutSeq }
}


/**
 * 取 0..cutSeq 的前缀事件，并确认 seq 从 0 连续。
 * @param events - 源日志。
 * @param cutSeq - 包含式切点。
 * @returns 前缀事件；不连续时返回 undefined。
 */
function copyPrefix(events, cutSeq) {
  const prefix = events.slice(0, cutSeq + 1)
  return prefix.some((event, index) => event.seq !== index) ? undefined : prefix
}

/**
 * 重建会话：复制前缀 → 新建并认领新会话 →（可选）投递新提问 → 归档源会话。
 *
 * 失败语义按步骤回报：
 *   - persist 失败：无副作用（新会话尚未被认领），可直接重试。
 *   - adopt 失败：日志已落盘但无人认领，顺手归档孤儿会话，不留脏条目。
 *   - prompt 失败：历史已重建但没重发，用户可手动补发；此时**不**归档源会话。
 *   - archive 失败：功能已生效，只是源会话还在列表里，单独告知。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param options - 源会话、源日志、头部、要复制的前缀，以及可选的待投递提问。
 * @returns 结果载荷。
 */
async function rebuild(ctx, options) {
  const { sourceSessionId, sourceEvents, header, prefix, prompt } = options
  const newId = `session-${randomUUID()}`
  try {
    await persistPrefix(ctx, header, newId, prefix)
  } catch (error) {
    return { ok: false, step: 'persist', error: 'persist-failed', message: String(error) }
  }

  try {
    await ctx.sessionController.create({ sessionId: newId, cwd: header.cwd })
  } catch (error) {
    // 日志已落盘但没被认领：归档掉，免得列表里多出一条半成品会话。
    await ctx.workspaceRegistry.archiveSession(newId, { stopActivity: true }).catch(() => {})
    return { ok: false, step: 'adopt', error: 'adopt-failed', sessionId: newId, message: String(error) }
  }

  restoreTitle(ctx, newId, sourceEvents)
  await attachWorkspace(ctx, sourceSessionId, newId)

  if (prompt !== undefined) {
    try {
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: newId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt.text }],
        ...prompt.clientTimeZone === undefined ? {} : { clientTimeZone: prompt.clientTimeZone },
      }, new AbortController().signal)
    } catch (error) {
      return { ok: false, step: 'prompt', error: 'prompt-failed', sessionId: newId, message: String(error) }
    }
  }

  try {
    await ctx.workspaceRegistry.archiveSession(sourceSessionId, { stopActivity: true })
  } catch (error) {
    ctx.logger.warn('[dsh-message-edit] could not archive the source session:', error)
    return { ok: true, sessionId: newId, archived: false }
  }
  return { ok: true, sessionId: newId }
}

/**
 * rewrite：编辑用户提问并重发。
 * @param ctx - 宿主 Cordis 上下文。
 * @param body - 已校验的 `{ sessionId, turnNumber, text, clientTimeZone? }`。
 * @returns 结果载荷。
 */
async function rewrite(ctx, body) {
  const observed = await observe(ctx, body.sessionId)
  if (observed.error !== undefined) return { ok: false, step: 'locate', error: observed.error }
  const { header, events } = observed
  const located = locateTurn(events, body.turnNumber)
  if (located.error !== undefined) return { ok: false, step: 'locate', error: located.error }
  if (header.cwd === undefined) return { ok: false, step: 'locate', error: 'session-has-no-cwd' }
  const prefix = copyPrefix(events, located.cutSeq)
  if (prefix === undefined) return { ok: false, step: 'locate', error: 'prefix-not-contiguous' }
  return rebuild(ctx, {
    sourceSessionId: body.sessionId,
    sourceEvents: events,
    header,
    prefix,
    prompt: {
      text: body.text,
      ...body.clientTimeZone === undefined ? {} : { clientTimeZone: body.clientTimeZone },
    },
  })
}

/**
 * prepare-assistant：给编辑器预填 AI 回答原文，并确认这条回答可编辑。
 * @param ctx - 宿主 Cordis 上下文。
 * @param body - 已校验的 `{ sessionId, messageId }`。
 * @returns 结果载荷。
 */
async function prepareAssistant(ctx, body) {
  const observed = await observe(ctx, body.sessionId)
  if (observed.error !== undefined) return { ok: false, error: observed.error }
  const located = locateAssistant(observed.events, body.messageId)
  if (located.error !== undefined) return { ok: false, error: located.error }
  return { ok: true, text: located.text }
}

/**
 * rewrite-assistant：改写某轮 AI 最终回答，该回答之后的内容丢弃；不重发。
 * @param ctx - 宿主 Cordis 上下文。
 * @param body - 已校验的 `{ sessionId, messageId, text }`。
 * @returns 结果载荷。
 */
async function rewriteAssistant(ctx, body) {
  const observed = await observe(ctx, body.sessionId)
  if (observed.error !== undefined) return { ok: false, step: 'locate', error: observed.error }
  const { header, events } = observed
  const located = locateAssistant(events, body.messageId)
  if (located.error !== undefined) return { ok: false, step: 'locate', error: located.error }
  if (header.cwd === undefined) return { ok: false, step: 'locate', error: 'session-has-no-cwd' }
  const prefix = copyPrefix(events, located.cutSeq)
  if (prefix === undefined) return { ok: false, step: 'locate', error: 'prefix-not-contiguous' }
  const edited = prefix.map((event) => (event.seq === located.targetSeq
    ? withEditedText(event, body.text)
    : event))
  return rebuild(ctx, {
    sourceSessionId: body.sessionId,
    sourceEvents: events,
    header,
    prefix: edited,
  })
}

/**
 * 注册用户消息与 AI 消息四个端点（prepare / rewrite / prepare-assistant / rewrite-assistant）。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  // 两次重写并发会同时读写同一批会话日志，一次只放行一个。
  let tail = Promise.resolve()
  const serial = (operation) => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * `{ sessionId, turnNumber }` 的共用校验：两个端点都要定位同一轮。
   * @param body - 请求体。
   * @returns 校验后的入参，或 `{ error }`。
   */
  const common = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad-request' }
    if (typeof body.sessionId !== 'string' || !SESSION_ID_RE.test(body.sessionId)) {
      return { error: 'bad-session-id' }
    }
    if (!Number.isSafeInteger(body.turnNumber) || body.turnNumber < 1) {
      return { error: 'bad-turn-number' }
    }
    return { sessionId: body.sessionId, turnNumber: body.turnNumber }
  }

  /**
   * `{ sessionId, messageId }` 的共用校验：assistant 端点按消息 id 定位。
   * @param body - 请求体。
   * @returns 校验后的入参，或 `{ error }`。
   */
  const commonAssistant = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad-request' }
    if (typeof body.sessionId !== 'string' || !SESSION_ID_RE.test(body.sessionId)) {
      return { error: 'bad-session-id' }
    }
    if (typeof body.messageId !== 'string' || !MESSAGE_ID_RE.test(body.messageId)) {
      return { error: 'bad-message-id' }
    }
    return { sessionId: body.sessionId, messageId: body.messageId }
  }

  /**
   * 一个只接受 JSON POST 的端点外壳：校验、串行化、统一错误回报。
   * @param path - 端点路径。
   * @param label - 出错日志与 step 用的操作名。
   * @param validate - 取出并校验入参。
   * @param operate - 校验通过后的实际操作。
   * @returns webServer 路由声明。
   */
  const route = (path, label, validate, operate) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      let parsed
      try {
        parsed = validate(await readJsonBody(req))
      } catch {
        respond(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      if (parsed.error !== undefined) {
        respond(res, 400, { ok: false, error: parsed.error })
        return
      }
      try {
        const result = await serial(() => operate(ctx, parsed))
        respond(res, result.ok ? 200 : 409, result)
      } catch (error) {
        ctx.logger.warn('[dsh-message-edit] ' + label + ' failed:', error)
        respond(res, 500, { ok: false, step: label, error: label + '-failed', message: String(error) })
      }
    },
  })

  ctx.effect(() => ctx.webServer.register(route(
    PREPARE_ROUTE,
    'prepare',
    common,
    prepare,
  )), 'dsh-message-edit: prepare route')

  ctx.effect(() => ctx.webServer.register(route(
    REWRITE_ROUTE,
    'rewrite',
    (body) => {
      const base = common(body)
      if (base.error !== undefined) return base
      if (typeof body.text !== 'string' || body.text.trim().length === 0) return { error: 'empty-text' }
      if (body.text.length > MAX_TEXT_LENGTH) return { error: 'text-too-long' }
      if (body.clientTimeZone !== undefined && typeof body.clientTimeZone !== 'string') {
        return { error: 'bad-time-zone' }
      }
      return {
        ...base,
        text: body.text,
        ...body.clientTimeZone === undefined ? {} : { clientTimeZone: body.clientTimeZone },
      }
    },
    rewrite,
  )), 'dsh-message-edit: rewrite route')

  ctx.effect(() => ctx.webServer.register(route(
    PREPARE_ASSISTANT_ROUTE,
    'prepare-assistant',
    commonAssistant,
    prepareAssistant,
  )), 'dsh-message-edit: prepare-assistant route')

  ctx.effect(() => ctx.webServer.register(route(
    REWRITE_ASSISTANT_ROUTE,
    'rewrite-assistant',
    (body) => {
      const base = commonAssistant(body)
      if (base.error !== undefined) return base
      if (typeof body.text !== 'string' || body.text.trim().length === 0) return { error: 'empty-text' }
      if (body.text.length > MAX_TEXT_LENGTH) return { error: 'text-too-long' }
      if (body.clientTimeZone !== undefined && typeof body.clientTimeZone !== 'string') {
        return { error: 'bad-time-zone' }
      }
      return {
        ...base,
        text: body.text,
        ...body.clientTimeZone === undefined ? {} : { clientTimeZone: body.clientTimeZone },
      }
    },
    rewriteAssistant,
  )), 'dsh-message-edit: rewrite-assistant route')
}
