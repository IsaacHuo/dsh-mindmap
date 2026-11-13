/**
 * Client (web GUI) half of dsh-mindmap: registers the 思维导图 page in the main
 * slot and its entry in the sidebar panel list. apply() never throws.
 * @module dsh-mindmap/client
 */
import type { ReactNode } from 'react'
import { App } from './App.tsx'
import { installStyles } from './styles.ts'

export const name = 'dsh-mindmap/client'
export const inject = ['slots']

const PANEL_ID = 'dsh-mindmap'

interface SlotsFace {
  inject(slot: string, factory: () => () => void): () => void
  register(meta: Record<string, unknown>, component: (props: { size?: number }) => ReactNode): () => void
}
interface ClientContext {
  get?(name: string): unknown
  effect?(fn: () => () => void, label?: string): unknown
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

export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(installStyles())
    const slots = ctx.get?.('slots') as SlotsFace | undefined
    if (slots === undefined) throw new Error('DSH panel service (slots) unavailable')
    disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)))
    disposers.push(slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '思维导图' }, MindmapIcon)))
  } catch (error) {
    console.error('[dsh-mindmap] client mount failed:', error)
  }
  try {
    ctx.effect?.(() => () => { for (const d of disposers.splice(0).reverse()) { try { d() } catch (e) { console.warn('[dsh-mindmap] dispose failed:', e) } } }, 'dsh-mindmap: client mount')
  } catch (error) {
    console.error('[dsh-mindmap] client effect failed:', error)
  }
}
