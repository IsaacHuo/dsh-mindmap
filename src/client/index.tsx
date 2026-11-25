/**
 * Client (web GUI) half of dsh-mindmap: registers the 思维导图 page in the main
 * slot and its entry in the sidebar panel list, and — when the conversation
 * services are present — a right-sidebar tab showing the map next to a
 * conversation, a header button opening it, and the bridge used for
 * node-bound sessions. apply() never throws; a missing service only hides its
 * feature.
 * @module dsh-mindmap/client
 */
import type { ReactNode } from 'react'
import { App } from './App.tsx'
import { installStyles } from './styles.ts'
import { createBridge, setBridge, TAB_KIND, type BesideTarget, type BridgeServices, type ChatBridge } from './bridge.ts'

export const name = 'dsh-mindmap/client'
export const inject = ['slots']

const PANEL_ID = 'dsh-mindmap'
/** Optional services; each feature is mounted only when its services exist. */
const CHAT_SERVICES = ['sessions', 'workspaces', 'uiWorkspace', 'conversation', 'sidebarRight', 'sidebarRightTabs'] as const

type Comp = (props: Record<string, unknown>) => ReactNode
interface SlotsFace {
  inject(slot: string, factory: () => () => void): () => void
  register(meta: Record<string, unknown>, component: Comp): () => void
}
interface SidebarRightTabsFace {
  register(def: { id: string; kind: string; title: (address: string) => string; keepMounted?: boolean }): () => void
}
interface InputActionsFace { insertQuote?(text: string, summary?: string): boolean }
interface ClientContext {
  get?(name: string): unknown
  effect?(fn: () => () => void, label?: string): unknown
  inject?(deps: string[], callback: (ctx: ClientContext) => void): unknown
}

/** Sidebar glyph. */
function MindmapIcon(props: { size?: number }): ReactNode {
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="6" width="4.5" height="4" rx="1" />
      <rect x="10" y="2" width="4.5" height="3.2" rx="1" />
      <rect x="10" y="10.8" width="4.5" height="3.2" rx="1" />
      <path d="M6 8h1.5c1 0 1-4.4 2.5-4.4M7.5 8c1 0 1 4.4 2.5 4.4" />
    </svg>
  )
}

function Page(): ReactNode {
  return <App />
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Body of the right-sidebar tab: the compact editor next to the conversation. */
function makeTab(services: BridgeServices & { conversation?: { input?: { for?(ctx: unknown): InputActionsFace } } }): Comp {
  return function MindmapTab(props) {
    const sessionId = str(props.sessionId)
    const useTabInfo = props.useTabInfo as (() => { tab?: { navigation?: { params?: Record<string, unknown> } } }) | undefined
    const params = useTabInfo?.().tab?.navigation?.params ?? {}
    const initial: BesideTarget = {}
    const docId = str(params.docId)
    const nodeId = str(params.nodeId)
    if (docId !== undefined) initial.docId = docId
    if (nodeId !== undefined) initial.nodeId = nodeId
    const actions = props.inputActions as InputActionsFace | undefined
    const chat: ChatBridge | undefined = sessionId === undefined ? undefined : {
      sessionId,
      insertQuote(text, summary) {
        try {
          if (actions?.insertQuote !== undefined) return actions.insertQuote(text, summary) !== false
          const b = services.sessions?.binding(sessionId)
          const input = b !== undefined ? services.conversation?.input?.for?.(b.ctx) : undefined
          return input?.insertQuote?.(text, summary) !== false && input?.insertQuote !== undefined
        } catch (error) {
          console.warn('[dsh-mindmap] insertQuote failed:', error)
          return false
        }
      },
    }
    return <App key={(docId ?? '') + '/' + (nodeId ?? '')} compact={{ initial, ...(chat !== undefined ? { chat } : {}) }} />
  }
}

/** Header button of a conversation: open the map in its right sidebar. */
function makeHeaderButton(open: (sessionId: string | undefined) => void): Comp {
  return function MindmapHeaderButton(props) {
    return (
      <button type="button" className="mm-hdr-btn" title="在侧边打开思维导图" aria-label="在侧边打开思维导图" onClick={() => open(str(props.sessionId))}>
        <MindmapIcon size={16} />
      </button>
    )
  }
}

function mountChat(c: ClientContext, slots: SlotsFace, disposers: Array<() => void>): void {
  const get = <T,>(n: string): T | undefined => {
    try { return (c.get?.(n) ?? (c as unknown as Record<string, unknown>)[n]) as T | undefined } catch { return undefined }
  }
  const services = {
    sessions: get<BridgeServices['sessions']>('sessions'),
    workspaces: get<BridgeServices['workspaces']>('workspaces'),
    uiWorkspace: get<BridgeServices['uiWorkspace']>('uiWorkspace'),
    conversation: get<BridgeServices['conversation'] & { input?: { for?(ctx: unknown): InputActionsFace } }>('conversation'),
    sidebarRight: get<BridgeServices['sidebarRight']>('sidebarRight'),
  }
  const clean = Object.fromEntries(Object.entries(services).filter(([, v]) => v !== undefined)) as typeof services
  setBridge(createBridge(clean))
  disposers.push(() => setBridge({}))
  const tabs = get<SidebarRightTabsFace>('sidebarRightTabs')
  if (tabs === undefined || services.sidebarRight === undefined) return
  disposers.push(tabs.register({ id: TAB_KIND, kind: TAB_KIND, title: () => '思维导图', keepMounted: true }))
  disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: TAB_KIND }, makeTab(clean))))
  const sidebarRight = services.sidebarRight
  const open = (sessionId: string | undefined): void => {
    try { sidebarRight.openTab(TAB_KIND, { params: sessionId !== undefined ? { sessionId } : {}, revealIfOpened: true }) } catch (error) { console.warn('[dsh-mindmap] open right tab failed:', error) }
  }
  disposers.push(slots.inject('conversation.session.header.utilities', () => slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-mindmap-open', order: -5 }, makeHeaderButton(open))))
}

export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(installStyles())
    const slots = ctx.get?.('slots') as SlotsFace | undefined
    if (slots === undefined) throw new Error('DSH panel service (slots) unavailable')
    disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)))
    disposers.push(slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '思维导图' }, MindmapIcon as Comp)))
    // Conversation integration waits for its services without blocking the page.
    if (typeof ctx.inject === 'function') {
      ctx.inject([...CHAT_SERVICES], chatCtx => {
        const own: Array<() => void> = []
        try { mountChat(chatCtx, slots, own) } catch (error) { console.warn('[dsh-mindmap] conversation integration unavailable:', error) }
        chatCtx.effect?.(() => () => { for (const d of own.splice(0).reverse()) { try { d() } catch (e) { console.warn('[dsh-mindmap] dispose failed:', e) } } }, 'dsh-mindmap: conversation integration')
      })
    } else {
      try { mountChat(ctx, slots, disposers) } catch (error) { console.warn('[dsh-mindmap] conversation integration unavailable:', error) }
    }
  } catch (error) {
    console.error('[dsh-mindmap] client mount failed:', error)
  }
  try {
    ctx.effect?.(() => () => { for (const d of disposers.splice(0).reverse()) { try { d() } catch (e) { console.warn('[dsh-mindmap] dispose failed:', e) } } }, 'dsh-mindmap: client mount')
  } catch (error) {
    console.error('[dsh-mindmap] client effect failed:', error)
  }
}
