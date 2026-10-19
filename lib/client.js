/**
 * dsh-message-edit —— 浏览器半边。
 *
 * 三个编辑入口，共用同一张浮动编辑器卡片：
 *   1. 用户消息（DOM 注入）：动作行里的铅笔按钮 → /prepare → /rewrite，改完重发；
 *   2. AI 最终回答（官方 slot conversation.chat.assistant-actions）：铅笔按钮 →
 *      /prepare-assistant → /rewrite-assistant，改完不重发，用户之后自行继续；
 *   3. 待发送 / steering 消息（DOM 注入 [data-pending-steering]）：铅笔按钮 →
 *      用官方 ISession.updateQueue 直接改队列内容，消息还没发给模型。
 *
 * 为什么用户消息和待发送消息只能 DOM 注入：官方没有「用户消息动作」slot，
 * conversation.chat.assistant-actions 是 assistant 专属（owner 只有 messageId），
 * extraActions 也只在 assistant 路径传入，turnTail 又在回合尾。只有 AI 回答
 * 有官方动作位，其余两个用与 dsh-model-capability-editor 相同的 DOM 注入方式。
 *
 * 编辑器是 position:fixed 的浮层，贴靠被点按钮：优先下方，放不下翻上方，
 * 左右钳到视口内 12px。所有颜色只取 --dsw-alias-* 主题令牌（带 fallback），
 * 明暗主题自动适配。root / 监听 / 样式全部挂在 ctx.effect 的清理函数里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const IconEditOutlineRegular = primitives.IconEditOutlineRegular
    const IconCloseOutlineRegular = primitives.IconCloseOutlineRegular
    const Tooltip = primitives.Tooltip
    const h = React.createElement

    const STYLE_ID = 'dsh-message-edit-style'
    /** 只能挂在消息动作行上的挂载点标记；也是幂等守卫的判据。 */
    const SLOT_CLASS = 'dsh-me-slot'
    const BTN_CLASS = 'dsh-me-btn'

    const CARD_WIDTH = 480
    const CARD_GAP = 10
    const VIEWPORT_MARGIN = 12
    const MIN_TEXTAREA_HEIGHT = 120
    const MAX_TEXTAREA_HEIGHT_RATIO = 0.4
    const MAX_TEXT_LENGTH = 100000
    const TOAST_DURATION = 4600

    /**
     * 必须带 data-plugin：宿主 claimStyles 会把**文档里所有未标记的 style**
     * 归属给下一个材质化的插件，那个插件 HMR 时就把我们的样式删了。
     */
    const STYLE = `
/* 动作行按钮：尺寸/间距对齐官方 copy / branch 图标按钮。 */
.dsh-me-slot{display:contents}
.dsh-me-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px;
  width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;
  color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;
  transition:background-color 120ms ease,color 120ms ease}
.dsh-me-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-me-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:1px}
.dsh-me-btn:disabled{opacity:.4;cursor:not-allowed}
.dsh-me-btn svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
/* assistant 动作行是 clock=end，官方 copy / branch 的图标在这里大两像素。 */
.dsh-me-btn-assistant svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}

/* 浮动编辑器卡片：圆角 12px、1px 主题描边、柔和阴影，贴靠被点按钮。 */
.dsh-me-card{position:fixed;z-index:80;box-sizing:border-box;
  width:min(480px,calc(100vw - 24px));
  display:flex;flex-direction:column;gap:10px;
  padding:14px 16px 12px;border-radius:var(--dsw-radius-md,12px);
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-default,#e3e6ec));
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base,#fff)));
  box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 12px 32px rgba(0,0,0,.12));
  color:var(--dsw-alias-label-primary,#1f2430);
  font-size:var(--dsh-content-font-size-secondary,13px);
  animation:dsh-me-pop 140ms cubic-bezier(.2,.8,.3,1)}
@keyframes dsh-me-pop{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dsh-me-card{animation:none}}

/* 头部：铅笔图标 + 标题/副标题 + 关闭按钮。 */
.dsh-me-head{display:flex;align-items:flex-start;gap:9px}
.dsh-me-head-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:24px;height:24px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-me-head-icon svg{width:15px;height:15px}
.dsh-me-head-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dsh-me-title{margin:0;font-size:var(--dsh-content-font-size,14px);font-weight:600;line-height:20px;color:inherit}
.dsh-me-subtitle{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-me-close{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;padding:0;margin:-1px -2px 0 0;border:none;
  border-radius:var(--dsw-radius-sm,8px);background:transparent;
  color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;
  transition:background-color 120ms ease,color 120ms ease}
.dsh-me-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-me-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:1px}
.dsh-me-close:disabled{opacity:.4;cursor:not-allowed}
.dsh-me-close svg{width:14px;height:14px}

/* 输入框：自适应高度（min 120px，max 40vh），聚焦时用主题强调色描边。 */
.dsh-me-input{box-sizing:border-box;width:100%;min-height:120px;max-height:40vh;resize:none;
  padding:9px 11px;border-radius:var(--dsw-radius-sm,8px);font:inherit;line-height:1.55;
  color:var(--dsw-alias-label-primary,#1f2430);
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-default,#d8dde6));
  background:var(--dsw-alias-bg-base,#fff);overflow-y:auto;
  transition:border-color 120ms ease,box-shadow 120ms ease}
.dsh-me-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2f6fed);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#2f6fed) 16%,transparent)}
.dsh-me-input:disabled{opacity:.65}

/* 破坏性提示：浅色警示条。 */
.dsh-me-warn{display:flex;align-items:flex-start;gap:7px;margin:0;
  padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-state-warn-tertiary,#fff7e6);
  color:var(--dsw-alias-state-warn-label,#92400e);
  font-size:11px;line-height:16px}
.dsh-me-warn-icon{flex:none;font-weight:700;line-height:16px;opacity:.85}

/* 错误：内联在卡片里，role=alert；不再用 window.alert。 */
.dsh-me-error{margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm,8px);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 8%,transparent);
  color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-danger-border,#dc2626));
  font-size:12px;line-height:17px;word-break:break-word}

/* 底部：左侧字数 + 快捷键提示，右侧取消 + 主按钮。 */
.dsh-me-foot{display:flex;align-items:flex-end;gap:10px}
.dsh-me-meta{display:flex;flex-direction:column;gap:1px;margin-right:auto;min-width:0}
.dsh-me-count{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#6b7280);font-variant-numeric:tabular-nums}
.dsh-me-hint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#9aa1ad)}
.dsh-me-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsh-me-btn-txt{box-sizing:border-box;height:30px;padding:0 14px;
  border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-default,#d8dde6));
  background:transparent;color:var(--dsw-alias-label-primary,#1f2430);
  font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;
  transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
.dsh-me-btn-txt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.dsh-me-btn-txt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6fed);outline-offset:1px}
.dsh-me-btn-txt:disabled{opacity:.5;cursor:not-allowed}
.dsh-me-btn-txt[data-primary="1"]{border-color:transparent;
  background:var(--dsw-alias-state-business-primary,#2f6fed);
  color:var(--dsw-alias-label-primary-inverted,#fff)}
.dsh-me-btn-txt[data-primary="1"]:hover:not(:disabled){filter:brightness(1.06)}
.dsh-me-btn-txt[data-primary="1"]:disabled{background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));
  color:var(--dsw-alias-label-tertiary,#6b7280)}

/* 轻量 toast：卡片打开前的失败原因（准备端点报错、定位不到队列行等）。 */
.dsh-me-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;
  box-sizing:border-box;max-width:min(520px,calc(100vw - 32px));
  padding:9px 14px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-default,#d8dde6));
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base,#fff)));
  box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.08));
  color:var(--dsw-alias-label-primary,#1f2430);font-size:12px;line-height:18px;
  animation:dsh-me-toast-in 140ms ease-out}
@keyframes dsh-me-toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){.dsh-me-toast{animation:none}}
`

    /** 宿主错误码 → 给用户看的中文。返回 undefined 表示交给兜底文案。 */
    function explain(code) {
      switch (code) {
        // 用户消息（/prepare、/rewrite）
        case 'synthetic-turn': return '这一轮不是由你的提问开始的，无法编辑'
        case 'turn-not-found': return '找不到该轮，请向上滚动加载后再试'
        case 'prefix-not-contiguous': return '会话日志异常，无法安全重建'
        case 'empty-text': return '内容不能为空'
        case 'text-too-long': return '内容过长（上限 10 万字符）'
        // AI 回答（/prepare-assistant、/rewrite-assistant）
        case 'assistant-message-not-found': return '找不到这条回答，可能已被清理或会话已更新'
        case 'assistant-message-has-tools': return '这条回答包含工具调用，暂不支持编辑'
        case 'assistant-message-not-final': return '只能编辑该轮最后一条回答'
        case 'turn-not-closed': return '这一轮还没结束，等回答完成后再试'
        case 'turn-has-pending-input': return '这一轮结束时还有排队消息，无法安全编辑'
        case 'unsupported-content': return '这条消息含附件或非纯文本内容，暂不支持编辑'
        // 共用
        case 'session-not-found': return '这个会话已经不在了（可能已被删除或归档）'
        case 'session-has-no-cwd': return '该会话没有工作目录，无法重建'
        case 'persist-failed': return '写入新会话日志失败，请重试'
        case 'adopt-failed': return '新会话创建后无法接管，请重试'
        case 'prompt-failed': return '历史已重建，但重发失败；请在新会话里手动再发一次'
        case 'bad-request': return '请求参数无效'
        case 'bad-session-id': return '会话标识无效'
        case 'bad-message-id': return '消息标识无效'
        case 'bad-turn-number': return '轮号无效'
        case 'bad-time-zone': return '客户端时区无效'
        case 'method-not-allowed': return '宿主端点不接受这个请求'
        default: return undefined
      }
    }

    /** 官方 updateQueue 的业务错误码 → 中文。 */
    function explainQueue(code) {
      switch (code) {
        case 'session/queue-item-not-found': return '这条消息已经不在队列里了（可能已发出）'
        case 'session/attachment-invalid': return '这条待发送消息含附件，暂不支持编辑'
        case 'gateway/bad-request': return '内容不能为空'
        case 'gateway/cancelled': return '操作已取消'
        case 'gateway/internal': return '保存失败，请稍后重试'
        case 'session/not-found': return '这个会话已经不在了'
        default: return undefined
      }
    }

    /** 任意异常 → 可读文案。 */
    function errorText(error) {
      if (error === null || error === undefined) return '操作失败，请稍后重试'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /** 浏览器时区；取不到就不带（宿主按本地时区处理）。 */
    function clientTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return typeof zone === 'string' && zone !== '' ? zone : undefined
      } catch (error) {
        return undefined
      }
    }

    /** POST 一个宿主端点；非 ok 的载荷翻成可读错误。 */
    async function post(path, body) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        throw new Error('无法连接宿主：' + errorText(error))
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data === null || typeof data !== 'object' || data.ok !== true) {
        // 404 只有一种解释：宿主半边还是旧版本（新端点要重启 dsh web 才注册）。
        if (response.status === 404) throw new Error('宿主端点还没加载，重启 DSH 后再试')
        const code = data !== null && typeof data === 'object' && typeof data.error === 'string'
          ? data.error
          : undefined
        const message = data !== null && typeof data === 'object' && typeof data.message === 'string'
          ? data.message
          : undefined
        throw new Error(explain(code) || message || code || ('HTTP ' + response.status))
      }
      return data
    }

    /** 当前正在看的会话 id：容器直接把它写在 DOM 上，是「视图」而不是「已保留」。 */
    function viewedSessionId() {
      const node = document.querySelector('[data-conversation-content]')
      const id = node === null ? undefined : node.getAttribute('data-conversation-session')
      if (typeof id === 'string' && id !== '') return id
      const fallback = document.querySelector('[data-conversation-session]')
      const alt = fallback === null ? undefined : fallback.getAttribute('data-conversation-session')
      return typeof alt === 'string' && alt !== '' ? alt : undefined
    }

    /** 数值钳位。 */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /** 空白归一化：匹配队列行文本时忽略排版差异。 */
    function collapseWhitespace(text) {
      return String(text).replace(/\s+/gu, ' ').trim()
    }

    /** 克隆气泡并去掉动作行（时间、copy 等），得到用户能看到的正文。 */
    function bubbleTextOf(row) {
      const clone = row.cloneNode(true)
      for (const node of clone.querySelectorAll('[data-clock]')) node.remove()
      return clone.textContent || ''
    }

    /**
     * 读队列行 content 的纯文本。含非文本块时 textOnly=false —— 这种行不允许编辑，
     * 因为 updateQueue 的 edit 只接受文本，静默丢附件比报错更糟。
     */
    function contentTextOf(content) {
      if (!Array.isArray(content)) return { text: '', textOnly: false }
      let text = ''
      let textOnly = true
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text'
          && typeof block.text === 'string') {
          text += block.text
        } else {
          textOnly = false
        }
      }
      return { text, textOnly }
    }

    /**
     * 气泡文本与队列行文本的匹配层级：0 完全相同（trim 后）> 1 归一化空白相等
     * > 2 气泡包含正文（正文前后被渲染出额外装饰时）。都不匹配返回 null。
     */
    function matchTier(rawBubble, collapsedBubble, contentText) {
      if (contentText === '') return collapsedBubble === '' ? 2 : null
      if (rawBubble.trim() === contentText) return 0
      const collapsedContent = collapseWhitespace(contentText)
      if (collapsedContent === '') return null
      if (collapsedBubble === collapsedContent) return 1
      if (collapsedBubble.includes(collapsedContent)) return 2
      return null
    }

    /**
     * 在 inbox 投影的 next-step 队列里定位这条待发送消息。
     * @returns { itemId, text }，定位失败或不可编辑时返回 { error }。
     */
    function resolvePendingItem(inbox, bubbleText) {
      const rows = inbox !== null && typeof inbox === 'object' && Array.isArray(inbox['next-step'])
        ? inbox['next-step']
        : []
      const rawBubble = String(bubbleText)
      const collapsedBubble = collapseWhitespace(rawBubble)
      let best = null
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const source = row.source
        if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
        const parts = contentTextOf(row.content)
        const tier = matchTier(rawBubble, collapsedBubble, parts.text)
        if (tier === null) continue
        if (best === null || tier < best.tier) {
          best = { row, tier, text: parts.text, textOnly: parts.textOnly }
          // 完全相同已是最优，且「多个匹配按出现顺序」取第一条。
          if (tier === 0) break
        }
      }
      if (best === null) return { error: '消息还在发送或已经变化，无法定位，请稍后重试' }
      if (!best.textOnly) return { error: '这条待发送消息含附件，暂不支持编辑' }
      if (typeof best.row.id !== 'string' || best.row.id === '') {
        return { error: '无法定位这条待发送消息，请稍后重试' }
      }
      return { itemId: best.row.id, text: best.text }
    }

    /** 读 inbox 投影快照；没有绑定或读不到时返回 undefined。 */
    function readInbox(session) {
      try {
        const face = session.projections.faceOf('inbox')
        if (face === null || face === undefined || typeof face.getSnapshot !== 'function') return undefined
        const snapshot = face.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
      } catch (error) {
        // 投影读失败与「队列为空」是两回事，但都只能提示用户稍后再试。
        return undefined
      }
    }

    /**
     * 计算卡片位置：贴靠被点按钮，优先下方，放不下翻上方，左右钳到视口内。
     * @param anchor - 被点按钮（可能已脱链）。
     * @param height - 卡片高度（首帧用估计值，挂载后按真实高度重算）。
     * @returns { left, top }（视口坐标，px）。
     */
    function placeCard(anchor, height) {
      const vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1024)
      const vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 768)
      const width = Math.min(CARD_WIDTH, vw - VIEWPORT_MARGIN * 2)
      let rect = null
      if (anchor !== null && anchor !== undefined && typeof anchor.getBoundingClientRect === 'function') {
        try {
          rect = anchor.getBoundingClientRect()
        } catch (error) {
          rect = null
        }
      }
      // 量不到（脱链 / 测试环境返回全 0）：落到视口底部居中，仍然可用。
      if (rect === null || typeof rect.top !== 'number' || typeof rect.left !== 'number'
        || (rect.width === 0 && rect.height === 0)) {
        return {
          left: Math.round((vw - width) / 2),
          top: Math.round(Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height)),
        }
      }
      const left = clamp(rect.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - width))
      const belowTop = rect.bottom + CARD_GAP
      const aboveTop = rect.top - CARD_GAP - height
      const spaceBelow = vh - VIEWPORT_MARGIN - belowTop
      const spaceAbove = rect.top - CARD_GAP - VIEWPORT_MARGIN
      let top
      if (spaceBelow >= height) top = belowTop
      else if (spaceAbove >= height) top = aboveTop
      else if (spaceBelow >= spaceAbove) top = belowTop
      else top = aboveTop
      top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height))
      return { left: Math.round(left), top: Math.round(top) }
    }

    /** 每种模式的标题、副标题、破坏性提示与主按钮文案。 */
    const MODE_SPEC = {
      user: {
        title: '编辑用户消息',
        subtitle: '改好后从这一轮重新开始，前面的对话原样保留',
        warning: '该轮之后的内容会被丢弃，原会话会被归档。',
        primary: (changed) => (changed ? '编辑并重发' : '重发'),
      },
      assistant: {
        title: '编辑 AI 消息',
        subtitle: '只改这条回答的可见文本，前面的对话原样保留',
        warning: '这条回答之后的内容会被丢弃，原会话会被归档；保存后可继续对话。',
        primary: () => '保存修改',
      },
      pending: {
        title: '编辑待发送消息',
        subtitle: '这条消息还在队列里，尚未发给模型',
        warning: '这条消息还没发给模型，保存后直接替换队列中的内容。',
        primary: () => '保存',
      },
    }

    /** 有 Tooltip 就用（与官方动作行一致），没有就退回原生 title。 */
    function wrapTooltip(label, node) {
      return typeof Tooltip === 'function'
        ? h(Tooltip, { label, side: 'bottom' }, node)
        : node
    }

    /**
     * 浮动编辑器卡片。submit 由调用方按模式注入：用户 / AI 走宿主端点，
     * 待发送走官方 updateQueue。成功后的收尾（关闭、切会话）由 onSuccess 决定。
     * @param props - React props。
     * @returns 卡片元素。
     */
    function EditCard(props) {
      const { mode, initialText, anchor, submit, onSuccess, onClose, onBusyChange } = props
      const spec = MODE_SPEC[mode] === undefined ? MODE_SPEC.user : MODE_SPEC[mode]
      const baseline = typeof initialText === 'string' ? initialText : ''
      const [text, setText] = React.useState(baseline)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [place, setPlace] = React.useState(() => placeCard(anchor, 300))
      const inputRef = React.useRef(null)
      const cardRef = React.useRef(null)

      const changed = text !== baseline
      const tooLong = text.length > MAX_TEXT_LENGTH
      const canSubmit = !busy && !tooLong && text.trim().length > 0

      /** textarea 自适应高度：min 120px，max 40vh。 */
      const grow = React.useCallback(() => {
        const node = inputRef.current
        if (node === null) return
        const max = Math.max(
          MIN_TEXTAREA_HEIGHT,
          Math.floor((window.innerHeight || 768) * MAX_TEXTAREA_HEIGHT_RATIO),
        )
        node.style.height = 'auto'
        node.style.height = clamp(node.scrollHeight || 0, MIN_TEXTAREA_HEIGHT, max) + 'px'
      }, [])

      // 挂载后：撑开高度、聚焦、把光标放到末尾（编辑长文时最常用）。
      React.useLayoutEffect(() => {
        const node = inputRef.current
        if (node === null) return
        grow()
        node.focus({ preventScroll: true })
        const end = node.value.length
        try {
          node.setSelectionRange(end, end)
        } catch (failure) {
          // 某些嵌入环境不支持选区；不影响输入与提交。
        }
      }, [grow])

      // 卡片高度随内容变化，位置跟着重算（下方放不下就翻到上方）。
      React.useLayoutEffect(() => {
        const node = cardRef.current
        if (node === null) return
        const height = node.getBoundingClientRect().height || node.offsetHeight || 0
        if (!(height > 0)) return
        const next = placeCard(anchor, height)
        setPlace((previous) => (
          previous.left === next.left && previous.top === next.top ? previous : next
        ))
      })

      // 让 apply 侧知道卡片是否 busy：busy 时不允许点外面关掉。
      React.useEffect(() => {
        onBusyChange(busy)
      }, [busy, onBusyChange])

      const submitNow = React.useCallback(async () => {
        if (busy || tooLong || text.trim().length === 0) return
        setBusy(true)
        setError(null)
        try {
          const result = await submit(text)
          onSuccess(result)
        } catch (failure) {
          setError(errorText(failure))
          setBusy(false)
        }
      }, [busy, tooLong, text, submit, onSuccess])

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (!busy) onClose()
          return
        }
        // Ctrl/Cmd+Enter 直接提交，与输入框的习惯一致。
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void submitNow()
        }
      }

      return h('div', {
        ref: cardRef,
        className: 'dsh-me-card',
        role: 'dialog',
        'aria-label': spec.title,
        'data-mode': mode,
        style: { left: place.left, top: place.top },
        onKeyDown,
      },
        h('div', { className: 'dsh-me-head', key: 'head' },
          h('span', { className: 'dsh-me-head-icon', 'aria-hidden': 'true', key: 'icon' },
            h(IconEditOutlineRegular, { size: 15 })),
          h('div', { className: 'dsh-me-head-text', key: 'text' },
            h('h4', { className: 'dsh-me-title' }, spec.title),
            h('p', { className: 'dsh-me-subtitle' }, spec.subtitle)),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-me-close',
            'aria-label': '关闭',
            title: '关闭',
            disabled: busy,
            onClick: onClose,
          }, h(IconCloseOutlineRegular, { size: 14 }))),
        h('textarea', {
          key: 'input',
          ref: inputRef,
          className: 'dsh-me-input',
          value: text,
          rows: 4,
          disabled: busy,
          spellCheck: false,
          'aria-label': '消息内容',
          placeholder: '输入要发送的内容…',
          onChange: (event) => {
            setText(event.target.value)
            setError(null)
            grow()
          },
        }),
        h('div', { className: 'dsh-me-warn', role: 'note', key: 'warn' },
          h('span', { className: 'dsh-me-warn-icon', 'aria-hidden': 'true' }, '!'),
          h('span', null, spec.warning)),
        tooLong
          ? h('p', { className: 'dsh-me-error', role: 'alert', key: 'too-long' }, '内容过长（上限 10 万字符）')
          : null,
        error === null
          ? null
          : h('p', { className: 'dsh-me-error', role: 'alert', key: 'error' }, error),
        h('div', { className: 'dsh-me-foot', key: 'foot' },
          h('div', { className: 'dsh-me-meta', key: 'meta' },
            h('span', { className: 'dsh-me-count' }, text.length + ' 字符'),
            h('span', { className: 'dsh-me-hint' }, 'Ctrl/⌘+Enter 提交 · Esc 取消')),
          h('div', { className: 'dsh-me-actions', key: 'actions' },
            h('button', {
              type: 'button',
              className: 'dsh-me-btn-txt',
              disabled: busy,
              onClick: onClose,
            }, '取消'),
            h('button', {
              type: 'button',
              className: 'dsh-me-btn-txt',
              'data-primary': '1',
              disabled: !canSubmit,
              title: tooLong
                ? '内容过长（上限 10 万字符）'
                : text.trim().length === 0 ? '内容不能为空' : undefined,
              onClick: () => { void submitNow() },
            }, busy ? '处理中…' : spec.primary(changed)))))
    }

    return {
      name: 'dsh-message-edit',
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        // apply 期的 ctx 才能读服务；slot/回调里读 ctx.<service> 会抛。
        const uiWorkspace = ctx.uiWorkspace
        const sessions = ctx.sessions

        /** 每个消息动作行一个 React root，key = 该行的动作行元素。 */
        const roots = new Map()
        /** 编辑器卡片单独一个 root，全局同时只存在一张。 */
        let card = null
        let disposed = false
        let frame = null
        /** 卡片打开期间挂的「点外面关掉」监听；关闭时一并摘掉。 */
        let onOutsidePointer = null
        /** 轻量 toast：同一时刻只留一条。 */
        let toast = null

        const removeToast = () => {
          if (toast === null) return
          window.clearTimeout(toast.timer)
          toast.element.remove()
          toast = null
        }

        /** 打开失败原因不用 window.alert，改成页面底部的轻量提示。 */
        const showToast = (message) => {
          if (disposed) return
          removeToast()
          const element = document.createElement('div')
          element.className = 'dsh-me-toast'
          element.setAttribute('role', 'alert')
          element.textContent = message
          document.body.append(element)
          const timer = window.setTimeout(() => {
            element.remove()
            if (toast !== null && toast.element === element) toast = null
          }, TOAST_DURATION)
          toast = { element, timer }
        }

        const closeCard = () => {
          if (card === null) return
          const current = card
          card = null
          if (onOutsidePointer !== null) {
            document.removeEventListener('pointerdown', onOutsidePointer, true)
            onOutsidePointer = null
          }
          current.root.unmount()
          current.container.remove()
          if (current.anchor !== null && current.anchor.isConnected) {
            try {
              current.anchor.disabled = false
            } catch (error) {
              // 已脱链或非原生按钮；没有需要恢复的 busy 态。
            }
          }
        }

        /**
         * 打开编辑器卡片。
         * @param options.anchor - 被点按钮，用于定位与 busy 态。
         * @param options.mode - 'user' | 'assistant' | 'pending'。
         * @param options.initialText - 预填文本。
         * @param options.submit - 保存动作；失败时抛错，卡片内联展示。
         * @param options.onSuccess - 保存成功后的收尾（关闭、切会话）。
         */
        const openEditor = (options) => {
          if (disposed) return
          closeCard()
          const anchor = options.anchor === undefined ? null : options.anchor
          if (anchor !== null) {
            try {
              anchor.disabled = true
            } catch (error) {
              // 非原生按钮没有 disabled；定位仍可用。
            }
          }
          const container = document.createElement('div')
          container.className = 'dsh-me-card-root'
          document.body.append(container)
          const root = createRoot(container)
          const entry = { root, container, anchor, locked: false }
          card = entry
          // 点卡片外面关掉。用捕获阶段，免得先被别处的 handler 吃掉。
          onOutsidePointer = (event) => {
            if (card !== entry || entry.locked) return
            if (container.contains(event.target)) return
            closeCard()
          }
          document.addEventListener('pointerdown', onOutsidePointer, true)
          root.render(h(EditCard, {
            mode: options.mode,
            initialText: options.initialText,
            anchor,
            submit: options.submit,
            onSuccess: (result) => {
              closeCard()
              if (typeof options.onSuccess === 'function') options.onSuccess(result)
            },
            onClose: closeCard,
            onBusyChange: (value) => { entry.locked = value === true },
          }))
        }

        /**
         * 用户消息：先向宿主取原文（顺带确认这一轮可编辑），成功后再显示卡片。
         * @param button - 被点击的按钮。
         * @param row - 该按钮所属的用户消息行。
         */
        const openUserEditor = async (button, row) => {
          const sessionId = viewedSessionId()
          const turnRow = row.closest('[data-chat-turn]')
          const turnNumber = Number(turnRow === null ? NaN : turnRow.getAttribute('data-chat-turn'))
          if (sessionId === undefined || !Number.isSafeInteger(turnNumber) || turnNumber < 1) {
            showToast('找不到这一轮的位置，请向上滚动加载后再试')
            return
          }
          if (disposed) return
          closeCard()
          try {
            button.disabled = true
          } catch (error) {
            // 原生按钮一定可写；这里只防御非按钮锚点。
          }
          let data
          try {
            data = await post('/dsh-message-edit/prepare', { sessionId, turnNumber })
          } catch (failure) {
            if (!disposed) {
              try {
                button.disabled = false
              } catch (error) {
                // 按钮已脱链，不需要恢复。
              }
              showToast(errorText(failure))
            }
            return
          }
          if (disposed) return
          openEditor({
            anchor: button,
            mode: 'user',
            initialText: data.text,
            submit: (text) => post('/dsh-message-edit/rewrite', {
              sessionId,
              turnNumber,
              text,
              clientTimeZone: clientTimeZone(),
            }),
            onSuccess: (result) => {
              const nextSessionId = result !== null && typeof result === 'object'
                && typeof result.sessionId === 'string' ? result.sessionId : undefined
              if (nextSessionId !== undefined) uiWorkspace.openSession(nextSessionId)
            },
          })
        }

        /**
         * AI 回答：messageId 由官方 slot 提供，宿主按消息 id 反查日志。
         * @param button - slot 里被点击的按钮。
         * @param sessionId - slot 标准 props 里的会话 id。
         * @param messageId - owner props 里的 assistant 消息 id。
         */
        const openAssistantEditor = async (button, sessionId, messageId) => {
          if (typeof sessionId !== 'string' || sessionId === ''
            || typeof messageId !== 'string' || messageId === '') {
            showToast('无法定位这条回答，请刷新页面后再试')
            return
          }
          if (disposed) return
          closeCard()
          try {
            button.disabled = true
          } catch (error) {
            // 同上：只防御非按钮锚点。
          }
          let data
          try {
            data = await post('/dsh-message-edit/prepare-assistant', { sessionId, messageId })
          } catch (failure) {
            if (!disposed) {
              try {
                button.disabled = false
              } catch (error) {
                // 按钮已脱链，不需要恢复。
              }
              showToast(errorText(failure))
            }
            return
          }
          if (disposed) return
          openEditor({
            anchor: button,
            mode: 'assistant',
            initialText: data.text,
            submit: (text) => post('/dsh-message-edit/rewrite-assistant', {
              sessionId,
              messageId,
              text,
              clientTimeZone: clientTimeZone(),
            }),
            onSuccess: (result) => {
              const nextSessionId = result !== null && typeof result === 'object'
                && typeof result.sessionId === 'string' ? result.sessionId : undefined
              if (nextSessionId !== undefined) uiWorkspace.openSession(nextSessionId)
            },
          })
        }

        /**
         * 待发送 / steering 消息：消息还在 inbox 队列里，直接改队列内容。
         * itemId 只能靠「气泡文本 ↔ 队列行 content 文本」匹配来定位。
         * @param button - 被点击的按钮。
         * @param row - [data-pending-steering] 气泡。
         */
        const openPendingEditor = (button, row) => {
          if (disposed) return
          const sessionId = viewedSessionId()
          if (sessionId === undefined) {
            showToast('当前会话还没准备好，稍后再试')
            return
          }
          const binding = sessions.binding(sessionId)
          const session = binding === null || binding === undefined ? undefined : binding.session
          if (session === undefined || session === null) {
            showToast('当前会话还没准备好，稍后再试')
            return
          }
          const inbox = readInbox(session)
          if (inbox === undefined) {
            showToast('读不到待发送队列，稍后再试')
            return
          }
          const resolved = resolvePendingItem(inbox, bubbleTextOf(row))
          if (resolved.error !== undefined) {
            showToast(resolved.error)
            return
          }
          openEditor({
            anchor: button,
            mode: 'pending',
            initialText: resolved.text,
            submit: async (text) => {
              const result = await session.updateQueue(resolved.itemId, {
                kind: 'edit',
                content: [{ type: 'text', text }],
              })
              if (result === null || typeof result !== 'object' || result.ok !== true) {
                const failure = result !== null && typeof result === 'object'
                  && result.error !== null && typeof result.error === 'object' ? result.error : null
                const code = failure !== null && typeof failure.code === 'string' ? failure.code : undefined
                const message = failure !== null && typeof failure.message === 'string' ? failure.message : undefined
                throw new Error(explainQueue(code) || message || '保存失败，请稍后重试')
              }
              return result
            },
            onSuccess: () => {
              // 队列投影（inbox）会自动刷新气泡，这里不需要额外动作。
            },
          })
        }

        /**
         * 画一个与官方动作行按钮同尺寸的铅笔按钮。
         *
         * 用 createElement 而不是直接调用组件：图标组件内部用了 useId，
         * 直接调用等于在 React 之外跑 hook。
         * @param actions - 动作行元素。
         * @param title - 按钮文案（同时作为 aria-label 与原生 title）。
         * @param onActivate - 点击回调。
         */
        const mountActions = (actions, title, onActivate) => {
          // 幂等守卫：容器存在就说明这一行已经处理过。
          if (actions.querySelector(':scope > .' + SLOT_CLASS) !== null) return
          const container = document.createElement('span')
          container.className = SLOT_CLASS
          const button = document.createElement('button')
          button.type = 'button'
          button.className = BTN_CLASS
          button.title = title
          button.setAttribute('aria-label', title)
          container.append(button)
          actions.append(container)
          const root = createRoot(button)
          root.render(h(IconEditOutlineRegular, { size: 16 }))
          button.addEventListener('click', () => { onActivate(button) })
          roots.set(actions, { root, container })
        }

        /** 用户消息行：动作行里的「编辑并重发」。 */
        const mountUserRow = (row) => {
          const actions = row.querySelector(':scope [data-clock="start"]')
          if (actions === null) return
          mountActions(actions, '编辑并重发', (button) => { void openUserEditor(button, row) })
        }

        /** 待发送 steering 气泡：动作行里的「编辑待发送消息」。 */
        const mountPendingRow = (row) => {
          const actions = row.querySelector(':scope [data-clock="start"]')
          if (actions === null) return
          mountActions(actions, '编辑待发送消息', (button) => { openPendingEditor(button, row) })
        }

        /**
         * 扫描并补齐所有可编辑消息，同时释放已失效的 root。
         *
         * 用户消息只认 [data-chat-flow-kind="user"]（steering 行共用同一个组件但
         * kind 不同，天然排除）；待发送消息认 [data-pending-steering]（官方
         * PendingSteeringBubble，没有 data-chat-turn，也不在 user 流程项下）。
         *
         * 失效判定同时看动作行和容器：React 重渲染时可能把整行换掉（动作行脱链），
         * 也可能只把我们塞进去的容器丢掉（动作行还在、容器已脱链）——后者若不处理，
         * 下一轮扫描会再建一个 root，而旧 root 永远没人 unmount。
         *
         * 这里**不**按「当前是否在会话视图里」早退：切到空态时聊天区节点消失，
         * 早退会让那些 root 一直挂着没人回收。多跑一轮空 querySelectorAll 很便宜。
         */
        const scan = () => {
          if (disposed) return
          // 先回收失效 root，再补齐新按钮：顺序反过来时，若 React 只丢掉了我们塞进去的
          // 容器（动作行还在），mountActions 会用同一个动作行 key 覆盖 Map 里的旧条目，
          // 旧 root 就再也没人 unmount 了。
          for (const [actions, entry] of roots) {
            if (actions.isConnected && entry.container.isConnected) continue
            roots.delete(actions)
            entry.root.unmount()
            entry.container.remove()
          }
          for (const item of document.querySelectorAll('[data-chat-flow-kind="user"]')) mountUserRow(item)
          for (const item of document.querySelectorAll('[data-pending-steering]')) mountPendingRow(item)
          // 卡片所贴的按钮被 React 换掉后，卡片就悬空了，顺手关掉。
          if (card !== null && card.anchor !== null && !card.anchor.isConnected) closeCard()
        }

        const schedule = () => {
          if (disposed || frame !== null) return
          frame = requestAnimationFrame(() => {
            frame = null
            scan()
          })
        }

        /** AI 回答的官方动作入口：与 copy / branch 同排、同尺寸。 */
        const AssistantEditAction = (props) => {
          const onClick = (event) => {
            event.preventDefault()
            event.stopPropagation()
            void openAssistantEditor(event.currentTarget, props.sessionId, props.messageId)
          }
          return wrapTooltip('编辑这条回答', h('button', {
            type: 'button',
            className: BTN_CLASS + ' dsh-me-btn-assistant',
            'aria-label': '编辑这条回答',
            onClick,
          }, h(IconEditOutlineRegular)))
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.setAttribute('data-plugin', 'dsh-message-edit')
          style.textContent = STYLE
          document.head.append(style)
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          schedule()
          return () => {
            // 先落 disposed：排队中的扫描与在途请求续体不得再创建 root。
            disposed = true
            if (frame !== null) {
              cancelAnimationFrame(frame)
              frame = null
            }
            observer.disconnect()
            closeCard()
            removeToast()
            for (const [, entry] of roots) {
              entry.root.unmount()
              entry.container.remove()
            }
            roots.clear()
            style.remove()
          }
        }, 'dsh-message-edit: chat injector')

        // AI 回答的编辑按钮走官方 slot；slot 声明缺失时会等，卸载时自动摘掉。
        ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-message-edit',
          order: 20,
          inject: () => ({}),
        }, AssistantEditAction)), 'dsh-message-edit: assistant actions')
      },
    }
  },
})
