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
