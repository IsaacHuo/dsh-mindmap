/**
 * Open-document state: the doc, undo/redo history, which node is being edited,
 * and debounced autosave with optimistic revision checks.
 *
 * Saving never loses local edits: while a save is in flight further edits stay
 * dirty and are sent afterwards; a 409 keeps the local copy and asks the user
 * which version wins; network errors retry with backoff; pagehide /
 * visibilitychange flush immediately (keepalive when small enough).
 * @module dsh-mindmap/client/useDocument
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutlineDoc } from '../shared/model.ts'
import { History, type Selection } from '../shared/history.ts'
import { api, ApiError } from './api.ts'
import { broadcast, onBroadcast, onServerChange } from './sync.ts'
import { mergeDocs } from '../shared/merge.ts'
import { ROUTE_PREFIX } from '../shared/api.ts'

/** Debounce before an autosave. */
export const SAVE_DELAY_MS = 800
const KEEPALIVE_LIMIT = 60_000

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

/** Where the caret should go after an edit (nonce forces re-focus). */
export interface FocusRequest { id: string; caret: number | 'end' | 'start'; nonce: number }

export interface ApplyOptions {
  /** Typing-merge key; same key within 1s merges into one undo step. */
  key?: string
  /** Node + caret to focus after the edit. */
  focus?: { id: string; caret: number | 'end' | 'start' }
  /** Skip history (view-only changes are still persisted). */
  noHistory?: boolean
}

export interface DocumentState {
  doc: OutlineDoc | null
  loading: boolean
  loadError: string | null
  status: SaveStatus
  statusMessage: string | null
  conflict: OutlineDoc | null
  focus: FocusRequest | null
  canUndo: boolean
  canRedo: boolean
  apply(next: OutlineDoc, opts?: ApplyOptions): void
  setSelection(sel: Selection | null): void
  requestFocus(id: string, caret: number | 'end' | 'start'): void
  breakMerge(): void
  undo(): void
  redo(): void
  flush(): Promise<void>
  resolveConflict(which: 'mine' | 'theirs'): void
  reload(): void
}

/** Load + edit + autosave one document. */
export function useDocument(docId: string | null, onSaved: (doc: OutlineDoc) => void): DocumentState {
  const [doc, setDoc] = useState<OutlineDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<OutlineDoc | null>(null)
  const [focus, setFocus] = useState<FocusRequest | null>(null)
  const [, setTick] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)

  const docRef = useRef<OutlineDoc | null>(null)
  const baseRev = useRef({ rev: 0 })
  /** Last version known to match the server: the merge base for outside edits. */
  const baseDoc = useRef<OutlineDoc | null>(null)
  const sentRef = useRef<OutlineDoc | null>(null)
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const retry = useRef(0)
  const blocked = useRef(false)
  const selection = useRef<Selection | null>(null)
  const history = useRef(new History<OutlineDoc>(200))
  const nonce = useRef(0)
  const onSavedRef = useRef(onSaved)
  const commitRef = useRef<(next: OutlineDoc) => void>(() => {})
  onSavedRef.current = onSaved

  const runSave = useCallback(async (keepalive: boolean): Promise<void> => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (saving.current !== null) { await saving.current; if (dirty.current && !blocked.current) await runSave(keepalive); return }
    const sent = docRef.current
    if (sent === null || !dirty.current || blocked.current) return
    const box = baseRev.current
    const body = { ...sent, revision: box.rev }
    const small = keepalive && JSON.stringify(body).length < KEEPALIVE_LIMIT
    setStatus('saving')
    sentRef.current = sent
    const task = (async () => {
      try {
        const saved = await api.saveDoc(body, box.rev, small)
        box.rev = saved.revision
        onSavedRef.current(saved)
        broadcast({ kind: 'doc', docId: saved.id, revision: saved.revision })
        if (baseRev.current !== box) return
        baseDoc.current = saved
        retry.current = 0
        setStatusMessage(null)
        if (docRef.current === sent) {
          dirty.current = false
          setStatus('saved')
        } else {
          setStatus('dirty')
        }
      } catch (error) {
        if (baseRev.current !== box) { console.warn('[dsh-mindmap] save of a closed document failed:', error); return }
        if (error instanceof ApiError && error.code === 'conflict' && error.current !== undefined && baseDoc.current !== null && docRef.current !== null && error.current.id === docRef.current.id) {
          // Someone else (usually the AI tool) saved first: merge and save again.
          const theirs = error.current
          let merged: ReturnType<typeof mergeDocs> | null = null
          try { merged = mergeDocs(baseDoc.current, docRef.current, theirs) } catch (e) { console.warn('[dsh-mindmap] merge failed:', e) }
          if (merged !== null) {
            history.current.record(docRef.current, selection.current, null)
            box.rev = theirs.revision
            baseDoc.current = theirs
            docRef.current = merged.doc
            setDoc(merged.doc)
            onSavedRef.current(theirs)
            setStatus('dirty')
            setStatusMessage(merged.conflicts > 0 ? `已合并外部修改；${merged.conflicts} 处冲突保留了本地内容` : '已合并外部修改')
            setTick(t => t + 1)
            return
          }
        }
        if (error instanceof ApiError && error.code === 'conflict' && error.current !== undefined) {
          blocked.current = true
          setConflict(error.current)
          setStatus('conflict')
          setStatusMessage(error.message)
        } else if (error instanceof ApiError && error.code === 'invalid_input') {
          blocked.current = true
          setStatus('error')
          setStatusMessage('保存被拒绝：' + error.message)
        } else {
          setStatus('error')
          setStatusMessage((error instanceof Error ? error.message : String(error)) + '，稍后自动重试')
          retry.current = Math.min(retry.current + 1, 6)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => { void runSave(false) }, 1000 * 2 ** retry.current)
        }
      }
    })()
    saving.current = task
    try { await task } finally { saving.current = null; sentRef.current = null }
    if (dirty.current && !blocked.current && docRef.current !== sent && timer.current === undefined) {
      timer.current = window.setTimeout(() => { void runSave(false) }, SAVE_DELAY_MS)
    }
  }, [])

  const flush = useCallback(() => runSave(false), [runSave])

  // Load on doc change; flush the previous one first.
  useEffect(() => {
    let alive = true
    window.clearTimeout(timer.current)
    timer.current = undefined
    history.current.clear()
    blocked.current = false
    dirty.current = false
    retry.current = 0
    docRef.current = null
    baseDoc.current = null
    setDoc(null)
    setConflict(null)
    setFocus(null)
    setStatus('saved')
    setStatusMessage(null)
    setLoadError(null)
    if (docId === null) { setLoading(false); return }
    setLoading(true)
    api.doc(docId).then(d => {
      if (!alive) return
      docRef.current = d
      baseDoc.current = d
      baseRev.current = { rev: d.revision }
      setDoc(d)
      setLoading(false)
    }, (error: unknown) => {
      if (!alive) return
      setLoadError(error instanceof Error ? error.message : String(error))
      setLoading(false)
    })
    return () => {
      alive = false
      // Flush the closing document independently of the refs the next load resets.
      const closing = docRef.current
      const box = baseRev.current
      const inflight = saving.current
      const covered = inflight !== null && sentRef.current === closing
      if (closing !== null && dirty.current && !blocked.current && !covered) {
        void (async () => {
          if (inflight !== null) await inflight.catch(() => {})
          try {
            const saved = await api.saveDoc({ ...closing, revision: box.rev }, box.rev, JSON.stringify(closing).length < KEEPALIVE_LIMIT)
            box.rev = saved.revision
            onSavedRef.current(saved)
            broadcast({ kind: 'doc', docId: saved.id, revision: saved.revision })
          } catch (error) {
            console.warn('[dsh-mindmap] flush on close failed:', error)
          }
        })()
      }
      baseRev.current = { rev: 0 }
    }
  }, [docId, reloadKey, runSave])

  useEffect(() => {
    const hidden = (): void => { if (document.visibilityState === 'hidden' && dirty.current) void runSave(true) }
    const hide = (): void => { if (dirty.current) void runSave(true) }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', hide)
    window.addEventListener('beforeunload', hide)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('beforeunload', hide)
    }
  }, [runSave])

  // Pick up another tab's saved edits while this copy is clean: on a
  // broadcast from that tab, and whenever this tab becomes visible again.
  // A dirty copy is left alone; its next save meets the 409 flow instead.
  useEffect(() => {
    if (docId === null) return
    let alive = true
    const idle = (): boolean => !dirty.current && !blocked.current && saving.current === null && docRef.current !== null
    const check = async (rev?: number): Promise<void> => {
      if (!idle() || (rev !== undefined && rev <= baseRev.current.rev)) return
      try {
        const fresh = await api.doc(docId)
        if (!alive || !idle() || fresh.id !== docRef.current?.id || fresh.revision <= baseRev.current.rev) return
        baseRev.current.rev = fresh.revision
        history.current.clear()
        docRef.current = fresh
        baseDoc.current = fresh
        setDoc(fresh)
        onSavedRef.current(fresh)
        setTick(t => t + 1)
      } catch (error) {
        console.warn('[dsh-mindmap] refetch failed:', error)
      }
    }
    // A dirty copy with no save in flight merges the outside edit right away,
    // so AI changes show up while the user keeps typing.
    const mergeIn = async (rev: number): Promise<void> => {
      if (rev <= baseRev.current.rev || blocked.current || saving.current !== null) return
      try {
        const fresh = await api.doc(docId)
        const mine = docRef.current
        const base = baseDoc.current
        if (!alive || mine === null || base === null || blocked.current || saving.current !== null || fresh.id !== mine.id || fresh.revision <= baseRev.current.rev) return
        const merged = mergeDocs(base, mine, fresh)
        history.current.record(mine, selection.current, null)
        baseRev.current.rev = fresh.revision
        baseDoc.current = fresh
        onSavedRef.current(fresh)
        commitRef.current(merged.doc)
        if (merged.conflicts > 0) setStatusMessage(`已合并外部修改；${merged.conflicts} 处冲突保留了本地内容`)
        setTick(t => t + 1)
      } catch (error) {
        console.warn('[dsh-mindmap] merge of an outside edit failed:', error)
      }
    }
    const off = onBroadcast(m => { if (m.kind === 'doc' && m.docId === docId) void check(m.revision) })
    const offServer = onServerChange(ROUTE_PREFIX + '/events', c => {
      if (c.kind === 'library') { void check(); return }
      if (c.docId !== docId) return
      if (!dirty.current) void check(c.revision); else void mergeIn(c.revision)
    })
    const visible = (): void => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      off()
      offServer()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [docId, reloadKey])

  const commit = useCallback((next: OutlineDoc) => {
    docRef.current = next
    setDoc(next)
    dirty.current = true
    if (!blocked.current) {
      setStatus(s => (s === 'saving' ? s : 'dirty'))
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { void runSave(false) }, SAVE_DELAY_MS)
    }
  }, [runSave])
  commitRef.current = commit

  const requestFocus = useCallback((id: string, caret: number | 'end' | 'start') => {
    nonce.current++
    setFocus({ id, caret, nonce: nonce.current })
  }, [])

  const apply = useCallback((next: OutlineDoc, opts: ApplyOptions = {}) => {
    const cur = docRef.current
    if (cur === null || next === cur) return
    if (opts.noHistory !== true) history.current.record(cur, selection.current, opts.key ?? null)
    commit(next)
    if (opts.focus !== undefined) requestFocus(opts.focus.id, opts.focus.caret)
    setTick(t => t + 1)
  }, [commit, requestFocus])

  const restore = useCallback((which: 'undo' | 'redo') => {
    const cur = docRef.current
    if (cur === null) return
    const entry = which === 'undo' ? history.current.undo(cur, selection.current) : history.current.redo(cur, selection.current)
    if (entry === null) return
    commit({ ...entry.state, revision: cur.revision })
    const sel = entry.selection
    if (sel !== null && entry.state.nodes[sel.nodeId] !== undefined) requestFocus(sel.nodeId, sel.caret)
    setTick(t => t + 1)
  }, [commit, requestFocus])

  const resolveConflict = useCallback((which: 'mine' | 'theirs') => {
    setConflict(current => {
      if (current === null) return null
      blocked.current = false
      baseRev.current.rev = current.revision
      baseDoc.current = current
      setStatusMessage(null)
      if (which === 'theirs') {
        history.current.clear()
        dirty.current = false
        docRef.current = current
        setDoc(current)
        setStatus('saved')
      } else {
        dirty.current = true
        setStatus('dirty')
        window.setTimeout(() => { void runSave(false) }, 0)
      }
      return null
    })
  }, [runSave])

  return {
    doc, loading, loadError, status, statusMessage, conflict, focus,
    canUndo: history.current.canUndo(),
    canRedo: history.current.canRedo(),
    apply,
    setSelection: sel => { selection.current = sel },
    requestFocus,
    breakMerge: () => history.current.breakMerge(),
    undo: () => restore('undo'),
    redo: () => restore('redo'),
    flush,
    resolveConflict,
    reload: () => setReloadKey(k => k + 1),
  }
}
