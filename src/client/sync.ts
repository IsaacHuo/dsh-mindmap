/**
 * Cross-tab awareness: tabs of the 思维导图 page tell each other about saved
 * documents and library changes over a BroadcastChannel, so an idle tab can
 * pick up another tab's edits instead of running into a save conflict.
 * @module dsh-mindmap/client/sync
 */

export type SyncMessage = { kind: 'doc'; docId: string; revision: number } | { kind: 'library' }

const NAME = 'dsh-mindmap'
let chan: BroadcastChannel | null | undefined
const listeners = new Set<(m: SyncMessage) => void>()

function isMessage(v: unknown): v is SyncMessage {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  if (m.kind === 'library') return true
  return m.kind === 'doc' && typeof m.docId === 'string' && typeof m.revision === 'number'
}

function channel(): BroadcastChannel | null {
  if (chan !== undefined) return chan
  try {
    chan = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME)
  } catch {
    chan = null
  }
  if (chan !== null) {
    chan.onmessage = (e: MessageEvent) => {
      if (!isMessage(e.data)) return
      for (const fn of listeners) {
        try { fn(e.data) } catch (error) { console.warn('[dsh-mindmap] sync listener failed:', error) }
      }
    }
  }
  return chan
}

/** Tell the other tabs (never this one). */
export function broadcast(message: SyncMessage): void {
  try { channel()?.postMessage(message) } catch { /* channel closed */ }
}

/** Listen to the other tabs; returns an unsubscriber. */
export function onBroadcast(fn: (m: SyncMessage) => void): () => void {
  channel()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** A change pushed by the host (`/events`), including the AI tool's edits. */
export type ServerChange = { kind: 'doc'; docId: string; revision: number; source: 'user' | 'ai' } | { kind: 'library' }

let source: EventSource | null = null
const serverListeners = new Set<(c: ServerChange) => void>()

function isChange(v: unknown): v is ServerChange {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  if (m.kind === 'library') return true
  return m.kind === 'doc' && typeof m.docId === 'string' && typeof m.revision === 'number'
}

/**
 * Listen to the host's change stream; one EventSource is shared by all
 * listeners and closed when the last one leaves. The browser reconnects by
 * itself; `onReconnect` listeners see a synthetic library change so they can
 * refetch what they may have missed.
 */
export function onServerChange(url: string, fn: (c: ServerChange) => void): () => void {
  serverListeners.add(fn)
  if (source === null && typeof EventSource !== 'undefined') {
    let opened = false
    source = new EventSource(url)
    source.addEventListener('change', (e: MessageEvent) => {
      let data: unknown
      try { data = JSON.parse(String(e.data)) } catch { return }
      if (!isChange(data)) return
      for (const l of serverListeners) {
        try { l(data) } catch (error) { console.warn('[dsh-mindmap] change listener failed:', error) }
      }
    })
    source.addEventListener('open', () => {
      if (opened) for (const l of serverListeners) { try { l({ kind: 'library' }) } catch { /* ignore */ } }
      opened = true
    })
  }
  return () => {
    serverListeners.delete(fn)
    if (serverListeners.size === 0 && source !== null) { source.close(); source = null }
  }
}
