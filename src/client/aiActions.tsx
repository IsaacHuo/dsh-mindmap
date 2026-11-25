/**
 * AI and conversation actions of the editor: node-menu entries (review AI
 * changes, start a node-bound session, insert into the chat, copy the AI
 * reference / file path), the bound-session menu and the header badge listing
 * pending AI changes. Every document change goes through DocumentState.apply
 * so it is saved and undoable.
 * @module dsh-mindmap/client/aiActions
 */
import { useCallback, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { OutlineDoc } from '../shared/model.ts'
import { bindSession, nodeRef, pendingAi, reviewAi, unbindSession } from '../shared/aiOps.ts'
import { api } from './api.ts'
import { reviewMenu } from './ai.ts'
import { bridge, onBridge, type ChatBridge, type HostBridge } from './bridge.ts'
import { nodeLabel, nodeQuote, nodeSessionPrompt } from './nodeSession.ts'
import type { DocumentState } from './useDocument.ts'
import type { DialogApi, MenuEntry, MenuState } from './ui.tsx'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const KIND_LABEL = { added: '新增', edited: '修改', deleted: '删除' } as const
const LIST_LIMIT = 30

/** Current host bridge (re-renders when the client entry replaces it). */
export function useBridge(): HostBridge {
  return useSyncExternalStore(onBridge, bridge, bridge)
}

export interface AiActionsInput {
  doc: OutlineDoc | null
  state: DocumentState
  dialogs: DialogApi
  /** Set in the right-sidebar view: the conversation next to the map. */
  chat?: ChatBridge
  onMenu(menu: MenuState): void
  /** Reveal and focus a node (switches to the outline). */
  reveal(id: string): void
}

export interface AiActions {
  /** Entries appended to a node's context menu. */
  extraMenu(id: string): MenuEntry[]
  /** Open the bound-sessions menu of a node at (x, y). */
  sessionsMenu(id: string, x: number, y: number): void
  /** Pending AI changes in the document. */
  pending: number
  /** Open the pending-changes list at (x, y). */
  pendingMenu(x: number, y: number): void
}

/** Hook building the AI / conversation actions for the open document. */
export function useAiActions(input: AiActionsInput): AiActions {
  const host = useBridge()
  const ref = useRef(input)
  ref.current = input
  const hostRef = useRef(host)
  hostRef.current = host

  const copy = useCallback((text: string, done: string): void => {
    void navigator.clipboard.writeText(text).then(() => ref.current.dialogs.toast(done), () => ref.current.dialogs.toast('无法写入剪贴板'))
  }, [])

  /** Apply a document change with an undo toast. */
  const applyWithUndo = useCallback((next: OutlineDoc, message: string): void => {
    const { state, dialogs } = ref.current
    state.apply(next)
    dialogs.toast(message, { label: '撤销', onClick: () => ref.current.state.undo() })
  }, [])

  const startSession = useCallback(async (id: string): Promise<void> => {
    const { doc, state, dialogs, chat } = ref.current
    const h = hostRef.current
    if (doc === null || h.newSession === undefined) return
    try {
      const sid = await h.newSession(nodeSessionPrompt(doc, id), chat?.sessionId)
      const cur = ref.current.state.doc
      if (cur !== null && cur.id === doc.id && cur.nodes[id] !== undefined) {
        state.apply(bindSession(cur, id, { id: sid, title: nodeLabel(cur, id).slice(0, 120), createdAt: Date.now() }))
        await state.flush()
      }
      h.openSession?.(sid)
      // Put the map next to the new conversation once it is on screen.
      const beside = (): boolean => h.openBeside?.({ docId: doc.id, nodeId: id }, sid) ?? false
      window.setTimeout(() => { if (!beside()) window.setTimeout(beside, 900) }, 300)
      dialogs.toast('已新建会话并填好草稿，确认后发送即可')
    } catch (error) {
      dialogs.toast('新建会话失败：' + errText(error))
    }
  }, [])

  const copyPath = useCallback(async (docId: string): Promise<void> => {
    try {
      const info = await api.info()
      const sep = info.docsDir.includes('\\') ? '\\' : '/'
      copy(info.docsDir + sep + docId + '.json', '已复制文件路径（仅供只读参考；请让 AI 用 mindmap 工具修改，直接改文件不会留痕）')
    } catch (error) {
      ref.current.dialogs.toast('获取路径失败：' + errText(error))
    }
  }, [copy])

  const sessionItems = useCallback((id: string): MenuEntry[] => {
    const { doc, state } = ref.current
    const h = hostRef.current
    const links = doc?.nodes[id]?.sessions ?? []
    if (doc === null || links.length === 0) return []
    const title = (l: { id: string; title?: string }): string => h.sessionTitle?.(l.id) ?? l.title ?? l.id
    const items: MenuEntry[] = [{ kind: 'label', label: '关联的会话' }]
    for (const l of links) {
      const gone = h.sessionExists?.(l.id) === false
      items.push({ label: (gone ? '（已不存在）' : '打开：') + title(l), disabled: gone || h.openSession === undefined, onSelect: () => h.openSession?.(l.id) })
    }
    for (const l of links) {
      items.push({ label: '解除关联：' + title(l), onSelect: () => {
        const cur = state.doc
        if (cur !== null) applyWithUndo(unbindSession(cur, id, l.id), '已解除关联')
      } })
    }
    return items
  }, [applyWithUndo])

  const extraMenu = useCallback((id: string): MenuEntry[] => {
    const { doc, chat } = ref.current
    const h = hostRef.current
    if (doc === null) return []
    const items: MenuEntry[] = [...reviewMenu(doc, id, applyWithUndo)]
    if (items.length > 0) items.push({ kind: 'sep' })
    items.push({ kind: 'label', label: 'AI 与会话' })
    if (h.newSession !== undefined) items.push({ label: '以此节点新建会话', onSelect: () => void startSession(id) })
    if (chat !== undefined) items.push({ label: '插入到对话', onSelect: () => {
      const cur = ref.current.state.doc
      if (cur === null || cur.nodes[id] === undefined) return
      const q = nodeQuote(cur, id)
      if (!chat.insertQuote(q.text, q.summary)) copy(q.text, '无法插入输入框，已复制到剪贴板')
    } })
    const sess = sessionItems(id)
    if (sess.length > 0) items.push(...sess)
    items.push({ label: '复制 AI 引用', onSelect: () => copy(nodeRef(doc.id, id === doc.rootId ? undefined : id), '已复制引用；在对话里发给 AI，它会用 mindmap 工具读取') })
    items.push({ label: '复制文档文件路径', onSelect: () => void copyPath(doc.id) })
    return items
  }, [applyWithUndo, startSession, sessionItems, copy, copyPath])

  const sessionsMenu = useCallback((id: string, x: number, y: number): void => {
    const items = sessionItems(id)
    if (items.length > 0) ref.current.onMenu({ x, y, items })
  }, [sessionItems])

  const pendingList = useMemo(() => (input.doc === null ? [] : pendingAi(input.doc)), [input.doc])

  const pendingMenu = useCallback((x: number, y: number): void => {
    const { doc, reveal } = ref.current
    if (doc === null) return
    const list = pendingAi(doc)
    if (list.length === 0) return
    const ids = list.map(p => p.id)
    const items: MenuEntry[] = [{ kind: 'label', label: list.length + ' 处 AI 修改待审阅' }]
    for (const p of list.slice(0, LIST_LIMIT)) {
      items.push({ label: '[' + KIND_LABEL[p.kind] + '] ' + nodeLabel(doc, p.id).slice(0, 40), onSelect: () => reveal(p.id) })
    }
    if (list.length > LIST_LIMIT) items.push({ kind: 'label', label: '……还有 ' + (list.length - LIST_LIMIT) + ' 处' })
    items.push({ kind: 'sep' })
    items.push({ label: '全部接受', onSelect: () => { const cur = ref.current.state.doc; if (cur !== null) applyWithUndo(reviewAi(cur, ids, 'accept'), '已接受全部 AI 修改，可撤销') } })
    items.push({ label: '全部拒绝', danger: true, onSelect: () => { const cur = ref.current.state.doc; if (cur !== null) applyWithUndo(reviewAi(cur, ids, 'reject'), '已拒绝全部 AI 修改，可撤销') } })
    ref.current.onMenu({ x, y, items })
  }, [applyWithUndo])

  return { extraMenu, sessionsMenu, pending: pendingList.length, pendingMenu }
}

/** Header badge: number of pending AI changes; opens the review list. */
export function PendingBadge(props: { count: number; onOpen(x: number, y: number): void }): ReactNode {
  if (props.count === 0) return null
  return (
    <button type="button" className="mm-ai-badge" title="AI 修改待审阅" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); props.onOpen(r.left, r.bottom + 4) }}>
      <span className="mm-ai-dot mm-ai-edited" aria-hidden="true" />AI 修改 {props.count}
    </button>
  )
}
