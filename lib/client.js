/**
 * dsh-message-edit —— 浏览器半边。
 *
 * 在用户气泡的动作行（与 copy / clock 同一排）里插入一个「编辑并重发」按钮。
 * 点开是浮动编辑器，确认后调宿主 `/dsh-message-edit/rewrite`：会话原地换成
 * 「第 1..N-1 轮逐字节相同前缀 + 新提问」的新会话，然后切过去。
 *
 * 官方没有「用户消息动作」slot：`conversation.chat.assistant-actions` 是
 * assistant 专属（owner 只有 messageId），`extraActions` 也只在 assistant 路径
 * 传入，`conversation.chat.turnTail` 又是回合尾。所以只能做 DOM 注入 —— 与
 * dsh-model-capability-editor 同一条路。
 */
window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const { IconEditOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const STYLE_ID = 'dsh-message-edit-style'
    /** 只能挂在用户消息行上的挂载点标记；也是幂等守卫的判据。 */
    const SLOT_CLASS = 'dsh-me-slot'
    const BTN_CLASS = 'dsh-me-btn'

    /**
     * 必须带 data-plugin：宿主 claimStyles 会把**文档里所有未标记的 <style>**
     * 归属给下一个材质化的插件，那个插件 HMR 时就把我们的样式删了。
     */
    const STYLE = `
.dsh-me-slot{display:contents}
.dsh-me-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px;
  width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border:none;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-me-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-me-btn:disabled{opacity:.4;cursor:not-allowed}
.dsh-me-btn svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}

.dsh-me-card{position:fixed;z-index:60;box-sizing:border-box;
  width:min(460px,calc(100vw - 24px));padding:12px;border-radius:var(--dsw-radius-lg,10px);
  border:1px solid var(--dsw-alias-border-default,#d1d5db);background:var(--dsw-alias-bg-base,#fff);
  box-shadow:0 8px 28px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary,#111827);font-size:13px}
.dsh-me-title{margin:0 0 8px;font-size:13px;font-weight:600}
.dsh-me-input{box-sizing:border-box;width:100%;min-height:96px;max-height:40vh;resize:vertical;
  padding:8px;border-radius:var(--dsw-radius-sm);font:inherit;line-height:1.5;color:inherit;
  border:1px solid var(--dsw-alias-border-default,#d1d5db);background:transparent}
.dsh-me-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2563eb)}
.dsh-me-warn{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-me-err{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-state-danger-border,#dc2626)}
.dsh-me-foot{display:flex;align-items:center;gap:8px;margin-top:10px}
.dsh-me-count{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-me-btn-txt{border:1px solid var(--dsw-alias-border-default,#d1d5db);background:transparent;color:inherit;
  border-radius:var(--dsw-radius-sm);padding:4px 12px;font-size:12px;cursor:pointer}
.dsh-me-btn-txt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-me-btn-txt:disabled{opacity:.45;cursor:not-allowed}
.dsh-me-btn-txt[data-primary="1"]{border-color:var(--dsw-alias-state-business-primary,#2563eb);
  background:var(--dsw-alias-state-business-primary,#2563eb);color:#fff}
.dsh-me-btn-txt[data-primary="1"]:disabled{background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);
  border-color:var(--dsw-alias-border-default,#d1d5db)}
`

    /** 宿主错误码 → 给用户看的中文。返回 undefined 表示交给兜底文案。 */
    function explain(code) {
      switch (code) {
        case 'synthetic-turn': return '这一轮不是由你的提问开始的，无法编辑'
        case 'unsupported-content': return '这条消息含附件或非纯文本内容，暂不支持编辑'
        case 'turn-not-found': return '找不到该轮，请向上滚动加载后再试'
        case 'session-not-found': return '这个会话已经不在了（可能已被删除或归档）'
        case 'session-has-no-cwd': return '该会话没有工作目录，无法重建'
        case 'empty-text': return '内容不能为空'
        case 'text-too-long': return '内容过长（上限 10 万字符）'
        case 'bad-session-id': return '会话标识无效'
        case 'bad-turn-number': return '轮号无效'
        case 'prefix-not-contiguous': return '会话日志异常，无法安全重建'
        case 'persist-failed': return '写入新会话日志失败'
        case 'adopt-failed': return '新会话创建后无法接管'
        case 'prompt-failed': return '历史已重建，但重发失败；请在新会话里手动再发一次'
        default: return undefined
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
        throw new Error('无法连接宿主：' + String(error))
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) {
        // 404 只有一种解释：宿主半边还是旧版本（新端点要重启 dsh web 才注册）。
        if (response.status === 404) throw new Error('宿主端点还没加载，重启 DSH 后再试')
        throw new Error(explain(data.error) || data.message || data.error || ('HTTP ' + response.status))
      }
      return data
    }

    /** 当前正在看的会话 id：容器直接把它写在 DOM 上，是「视图」而不是「已保留」。 */
    function viewedSessionId() {
      const node = document.querySelector('[data-conversation-content]')
      const id = node === null ? undefined : node.getAttribute('data-conversation-session')
      return typeof id === 'string' && id !== '' ? id : undefined
    }

    /**
     * 编辑卡片。`target` 是点击时的按钮，用来把卡片贴着它定位。
     * @param props - React props。
     * @returns 卡片元素。
     */
    function EditCard(props) {
      const { target, sessionId, turnNumber, initialText, onClose, onDone } = props
      const [text, setText] = React.useState(initialText)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const boxRef = React.useRef(null)
      const changed = text !== initialText
      const trimmed = text.trim()
      const tooLong = text.length > 100000
      const canSend = trimmed.length > 0 && !tooLong && !busy

      const [place, setPlace] = React.useState(null)
      React.useEffect(() => {
        const rect = target.getBoundingClientRect()
        const width = Math.min(460, window.innerWidth - 24)
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
        // 优先贴在气泡上方；上方放不下就落到下方。
        const height = 240
        const above = rect.top - height - 10
        setPlace({ left, top: above >= 12 ? above : Math.min(rect.bottom + 10, window.innerHeight - height - 12) })
      }, [target])

      // 聚焦必须等 place 落地之后：首帧是 visibility:hidden，隐藏元素接不了焦点。
      React.useEffect(() => {
        if (place === null) return
        const node = boxRef.current
        if (node === null) return
        node.focus()
        node.setSelectionRange(node.value.length, node.value.length)
      }, [place])

      const submit = React.useCallback(async () => {
        if (!canSend) return
        setBusy(true)
        setError(null)
        try {
          const data = await post('/dsh-message-edit/rewrite', {
            sessionId,
            turnNumber,
            text,
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })
          onDone(data.sessionId, data.archived !== false)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
          setBusy(false)
        }
      }, [canSend, sessionId, turnNumber, text, onDone])

      const onKeyDown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose() }
        // Ctrl/Cmd+Enter 直接提交，与输入框的习惯一致。
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit() }
      }

      return h('div', {
        className: 'dsh-me-card',
        role: 'dialog',
        'aria-label': '编辑用户消息',
        style: place === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: place.left, top: place.top },
      }, [
        h('h4', { className: 'dsh-me-title', key: 't' }, '编辑用户消息'),
        h('textarea', {
          key: 'i',
          ref: boxRef,
          className: 'dsh-me-input',
          value: text,
          disabled: busy,
          spellCheck: false,
          onChange: (event) => { setText(event.target.value) },
          onKeyDown,
        }),
        h('p', { className: 'dsh-me-warn', key: 'w' }, '该轮之后的内容将被丢弃，原会话会被归档。'),
        error === null ? null : h('p', { className: 'dsh-me-err', key: 'e' }, error),
        h('div', { className: 'dsh-me-foot', key: 'f' }, [
          h('span', { className: 'dsh-me-count', key: 'c' }, text.length + ' 字符'),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-me-btn-txt',
            disabled: busy,
            onClick: onClose,
          }, '取消'),
          h('button', {
            key: 'send',
            type: 'button',
            className: 'dsh-me-btn-txt',
            'data-primary': '1',
            disabled: !canSend,
            title: tooLong ? '内容过长（上限 10 万字符）' : undefined,
            onClick: () => { void submit() },
          }, busy ? '处理中…' : (changed ? '编辑并重发' : '重发')),
        ]),
      ])
    }

    return {
      name: 'dsh-message-edit',
      inject: ['uiWorkspace'],
      apply(ctx) {
        // apply 期的 ctx 才能读服务；slot/回调里读 ctx.<service> 会抛。
        const uiWorkspace = ctx.uiWorkspace

        /** 每个用户消息行一个 React root，key = 该行的挂载容器。 */
        const roots = new Map()
        /** 编辑器卡片单独一个 root，全局同时只存在一张。 */
        let card = null
        let disposed = false
        let frame = null
        /** 卡片打开期间挂的「点外面关掉」监听；关闭时一并摘掉。 */
        let onOutsidePointer = null

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
          if (current.target !== null && current.target.isConnected) current.target.disabled = false
        }

        /**
         * 打开编辑器：先向宿主取原文，成功后再显示卡片。
         * @param button - 被点击的按钮，用于定位与 busy 态。
         * @param row - 该按钮所属的用户消息行。
         */
        const openEditor = async (button, row) => {
          const sessionId = viewedSessionId()
          const turnNumber = Number(row.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'))
          if (sessionId === undefined || !Number.isSafeInteger(turnNumber) || turnNumber < 1) return
          closeCard()
          button.disabled = true
          let data
          try {
            data = await post('/dsh-message-edit/prepare', { sessionId, turnNumber })
          } catch (error) {
            button.disabled = false
            if (!disposed) window.alert(String(error && error.message ? error.message : error))
            return
          }
          if (disposed) return
          const container = document.createElement('div')
          container.className = 'dsh-me-card-root'
          document.body.append(container)
          const root = createRoot(container)
          card = { root, container, target: button }
          // 点卡片外面关掉。用捕获阶段，免得先被别处的 handler 吃掉。
          onOutsidePointer = (event) => {
            if (container.contains(event.target)) return
            closeCard()
          }
          document.addEventListener('pointerdown', onOutsidePointer, true)
          root.render(h(EditCard, {
            target: button,
            sessionId,
            turnNumber,
            initialText: typeof data.text === 'string' ? data.text : '',
            onClose: closeCard,
            onDone: (newSessionId) => {
              closeCard()
              // 先切会话再提示：切换本身已经把界面带过去了。
              uiWorkspace.openSession(newSessionId)
            },
          }))
        }

        /**
         * 画一个与官方动作行按钮同尺寸的铅笔按钮。
         *
         * 用 createElement 而不是直接调用组件：图标组件内部用了 useId，
         * 直接调用等于在 React 之外跑 hook。
         * @returns 按钮元素。
         */
        const makeButton = () => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = BTN_CLASS
          button.title = '编辑并重发'
          button.setAttribute('aria-label', '编辑并重发')
          return button
        }

        /** 挂一个按钮到某个用户消息行的动作行上；已挂过就跳过。 */
        const mountRow = (row) => {
          const actions = row.querySelector(':scope [data-clock="start"]')
          if (actions === null) return
          // 幂等守卫：容器存在就说明这一行已经处理过。
          if (actions.querySelector(':scope > .' + SLOT_CLASS) !== null) return
          const container = document.createElement('span')
          container.className = SLOT_CLASS
          const button = makeButton()
          container.append(button)
          actions.append(container)
          const root = createRoot(button)
          root.render(h(IconEditOutlineRegular, { size: 16 }))
          button.addEventListener('click', () => { void openEditor(button, row) })
          roots.set(actions, { root, container })
        }

        /**
         * 扫描并补齐所有用户消息行，同时释放已失效的 root。
         *
         * 只认 `[data-chat-flow-kind="user"]`：steering 行共用同一个组件，
         * 而且回显气泡（pending）没有这个祖先，所以天然被排除。
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
          for (const item of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
            mountRow(item)
          }
          for (const [actions, entry] of roots) {
            if (actions.isConnected && entry.container.isConnected) continue
            roots.delete(actions)
            entry.root.unmount()
          }
          // 卡片所贴的按钮被 React 换掉后，卡片就悬空了，顺手关掉。
          if (card !== null && card.target !== null && !card.target.isConnected) closeCard()
        }

        const schedule = () => {
          if (disposed || frame !== null) return
          frame = requestAnimationFrame(() => {
            frame = null
            scan()
          })
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
            if (frame !== null) cancelAnimationFrame(frame)
            observer.disconnect()
            closeCard()
            for (const [, entry] of roots) {
              entry.root.unmount()
              entry.container.remove()
            }
            roots.clear()
            style.remove()
          }
        }, 'dsh-message-edit: chat injector')
      },
    }
  },
})
