/**
 * 思维导图 page: document navigator on the left, editor (大纲 / 导图) on the
 * right. One document model drives both views. With `compact` it is the
 * right-sidebar view next to a conversation: no navigator, a document picker
 * in the toolbar, and 插入到对话 in the node menu.
 * @module dsh-mindmap/client/App
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ancestors, flatten, isInSubtree, type Library, type OutlineDoc } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import { parseMarkdown, toMarkdown } from '../shared/markdown.ts'
import { parseOpml, toOpml } from '../shared/opml.ts'
import type { BackupInfo, BackupKind, QuarantinedFile } from '../shared/api.ts'
import { api } from './api.ts'
import { onBroadcast, onServerChange } from './sync.ts'
import { ROUTE_PREFIX } from '../shared/api.ts'
import { PendingBadge, useAiActions } from './aiActions.tsx'
import type { BesideTarget, ChatBridge } from './bridge.ts'
import { countTree } from './docUtils.ts'
import { Sidebar } from './Sidebar.tsx'
import { useDocument } from './useDocument.ts'
import { Outline } from './Outline.tsx'
import { MindMap } from './MindMap.tsx'
import { buildMapExport, MapTooLargeError, pngFits, svgToPng } from './mapLayout.ts'
import { DialogHost, DialogOutlet, download, fileName, Icon, PopupMenu, useDialogs, type MenuEntry, type MenuState } from './ui.tsx'

type ViewMode = 'outline' | 'map'
const LS_LAST = 'dsh-mindmap:last-doc'
const LS_VIEW = 'dsh-mindmap:view'

function lsGet(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string | null): void {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value) } catch { /* storage disabled */ }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Options of the right-sidebar (compact) view. */
export interface CompactOptions {
  /** The conversation next to the map. */
  chat?: ChatBridge
  /** Document / node to show first. */
  initial?: BesideTarget
}

/** Page root. */
export function App(props: { compact?: CompactOptions } = {}): ReactNode {
  return <DialogHost><Shell compact={props.compact} /></DialogHost>
}

function Shell(props: { compact?: CompactOptions | undefined }): ReactNode {
  const compact = props.compact
  const dialogs = useDialogs()
  const appRef = useRef<HTMLDivElement>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [libError, setLibError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(() => compact?.initial?.docId ?? lsGet(LS_LAST))
  const [view, setViewState] = useState<ViewMode>(() => (lsGet(LS_VIEW) === 'map' ? 'map' : 'outline'))
  const [rootId, setRootId] = useState<string | null>(null)
  const [mapSel, setMapSel] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [sideOpen, setSideOpen] = useState(false)
  const pendingNode = useRef<string | null>(compact?.initial?.nodeId ?? null)
  const lastWarnings = useRef('')
  // A new key per menu: a submenu opened from a menu item remounts, so it is re-clamped and focused.
  const menuKey = useRef(0)
  const lastMenu = useRef<MenuState | null>(null)
  if (menu !== lastMenu.current) { lastMenu.current = menu; menuKey.current++ }

  const refreshLibrary = useCallback(async () => {
    try {
      const r = await api.library()
      setLibrary(r.library)
      setLibError(null)
      // Toast warnings once, not again on every refresh while they persist.
      const w = r.warnings.join('；')
      if (w.length > 0 && w !== lastWarnings.current) dialogs.toast(w)
      lastWarnings.current = w
      return r.library
    } catch (error) {
      setLibError(errText(error))
      return null
    }
  }, [dialogs])
  useEffect(() => { void refreshLibrary() }, [refreshLibrary])
  // Another tab changed the library (or saved a document): refresh the index.
  useEffect(() => onBroadcast(() => { void refreshLibrary() }), [refreshLibrary])
  // The host pushes library changes and AI edits (titles / times in the index).
  useEffect(() => onServerChange(ROUTE_PREFIX + '/events', c => {
    if (c.kind === 'library' || c.source === 'ai') void refreshLibrary()
  }), [refreshLibrary])

  // Open the most recently edited doc when none is selected or the remembered one is gone.
  useEffect(() => {
    if (library === null) return
    const m = activeId === null ? undefined : library.docs.find(d => d.id === activeId)
    if (m === undefined || m.trashedAt !== undefined) {
      const next = library.docs.filter(d => d.trashedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      setActiveId(next?.id ?? null)
    }
  }, [library, activeId])
  useEffect(() => { if (compact === undefined) lsSet(LS_LAST, activeId) }, [activeId, compact])

  const onSaved = useCallback((saved: OutlineDoc) => {
    setLibrary(lib => (lib === null ? lib : { ...lib, docs: lib.docs.map(d => (d.id === saved.id ? { ...d, title: saved.title, updatedAt: saved.updatedAt } : d)) }))
  }, [])
  const state = useDocument(activeId, onSaved)
  const doc = state.doc

  // Reset zoom / selection when the document changes; keep zoom valid after undo.
  useEffect(() => { setRootId(null); setMapSel(null) }, [activeId])
  const effectiveRoot = doc !== null && rootId !== null && doc.nodes[rootId] !== undefined ? rootId : doc?.rootId ?? null

  const setView = (v: ViewMode): void => { setViewState(v); if (compact === undefined) lsSet(LS_VIEW, v) }

  // Undo / redo may restore a node outside the zoomed subtree: zoom out so it is visible.
  useEffect(() => {
    const f = state.focus
    if (doc === null || f === null || rootId === null || doc.nodes[f.id] === undefined) return
    if (!isInSubtree(doc, rootId, f.id)) setRootId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus])

  const [findRequest, setFindRequest] = useState(0)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  useEffect(() => { setTagFilter(null) }, [activeId])
  const showShortcuts = useCallback(() => {
    dialogs.show({ title: '快捷键', body: () => <ShortcutPanel /> })
  }, [dialogs])

  // Reveal a node (expand its ancestors, fix the zoom) and put the caret in it.
  const reveal = useCallback((d: OutlineDoc, id: string) => {
    let next = d
    for (const a of ancestors(d, id)) next = ops.setCollapsed(next, a, false)
    if (next !== d) state.apply(next, { noHistory: true })
    if (effectiveRoot !== null && !isInSubtree(d, effectiveRoot, id)) setRootId(null)
    window.setTimeout(() => state.requestFocus(id, 'end'), 0)
  }, [state, effectiveRoot])

  useEffect(() => {
    if (doc === null || pendingNode.current === null) return
    const id = pendingNode.current
    pendingNode.current = null
    if (doc.nodes[id] !== undefined) { setView('outline'); reveal(doc, id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id])

  const revealRef = useRef(reveal)
  revealRef.current = reveal
  const ai = useAiActions({
    doc, state, dialogs, onMenu: setMenu,
    ...(compact?.chat !== undefined ? { chat: compact.chat } : {}),
    reveal: id => { const d = state.doc; if (d !== null && d.nodes[id] !== undefined) { setView('outline'); revealRef.current(d, id) } },
  })

  const openDoc = useCallback((id: string, nodeId: string | null = null) => {
    setSideOpen(false)
    if (id === activeId) {
      if (nodeId !== null && doc !== null && doc.nodes[nodeId] !== undefined) { setView('outline'); reveal(doc, nodeId) }
      return
    }
    pendingNode.current = nodeId
    setActiveId(id)
  }, [activeId, doc, reveal])

  const createDoc = useCallback(async (body: { folderId?: string | null; markdown?: string; opml?: string; title?: string } = {}) => {
    try {
      const r = await api.createDoc(body)
      setLibrary(lib => (lib === null ? lib : { ...lib, docs: [...lib.docs, r.meta] }))
      setActiveId(r.doc.id)
      setView('outline')
      setSideOpen(false)
      return r.doc
    } catch (error) {
      dialogs.toast('新建失败：' + errText(error))
      return null
    }
  }, [dialogs])

  const patchMeta = useCallback(async (id: string, body: { title?: string; folderId?: string | null; favorite?: boolean }) => {
    // Renaming the open document goes through the editor so it cannot race the autosave.
    if (body.title !== undefined && doc !== null && doc.id === id) {
      const title = body.title.trim()
      if (title.length > 0 && title !== doc.title) state.apply({ ...doc, title })
      const rest = { ...body }
      delete rest.title
      if (Object.keys(rest).length === 0) return
      body = rest
    }
    try {
      const r = await api.patchMeta(id, body)
      setLibrary(lib => (lib === null ? lib : { ...lib, docs: lib.docs.map(d => (d.id === id ? r.meta : d)) }))
    } catch (error) {
      dialogs.toast('操作失败：' + errText(error))
    }
  }, [doc, state, dialogs])

  const trashDoc = useCallback(async (id: string) => {
    try {
      if (id === activeId) await state.flush()
      const meta = await api.trash(id)
      setLibrary(lib => (lib === null ? lib : { ...lib, docs: lib.docs.map(d => (d.id === id ? meta : d)) }))
      dialogs.toast('已移到回收站（30 天后自动永久删除）', { label: '撤销', onClick: () => {
        api.restore(id).then(m => setLibrary(lib => (lib === null ? lib : { ...lib, docs: lib.docs.map(d => (d.id === id ? m : d)) })), error => dialogs.toast('恢复失败：' + errText(error)))
      } })
    } catch (error) {
      dialogs.toast('删除失败：' + errText(error))
    }
  }, [activeId, state, dialogs])

  // ---------- conflict: keep both ----------
  const saveConflictCopy = useCallback(async () => {
    const mine = state.doc
    if (mine === null) return
    const meta = library?.docs.find(d => d.id === mine.id)
    try {
      const r = await api.createDoc({ copy: mine, title: mine.title + ' 副本', folderId: meta?.folderId ?? null })
      state.resolveConflict('theirs')
      setLibrary(lib => (lib === null ? lib : { ...lib, docs: [...lib.docs, r.meta] }))
      setActiveId(r.meta.id)
      dialogs.toast('你的修改已另存为「' + r.meta.title + '」')
    } catch (error) {
      dialogs.toast('另存失败：' + errText(error))
    }
  }, [state, library, dialogs])

  // ---------- export ----------
  const exportAs = useCallback(async (kind: 'md' | 'opml' | 'svg' | 'png' | 'copy-md') => {
    if (doc === null || effectiveRoot === null) return
    const root = effectiveRoot
    const label = root === doc.rootId ? doc.title : doc.nodes[root]!.text.split('\n')[0]!
    try {
      if (kind === 'md' || kind === 'copy-md') {
        const md = toMarkdown(doc, root, label)
        if (kind === 'copy-md') { await navigator.clipboard.writeText(md); dialogs.toast('已复制 Markdown'); return }
        download(fileName(label, 'md'), new Blob([md], { type: 'text/markdown;charset=utf-8' }))
      } else if (kind === 'opml') {
        download(fileName(label, 'opml'), new Blob([toOpml(doc, root, label)], { type: 'text/x-opml;charset=utf-8' }))
      } else {
        const el = appRef.current!
        const out = buildMapExport(doc, root, label, el, { title: null, background: kind === 'png' ? 'theme' : 'transparent' })
        const svgBlob = (): Blob => new Blob([out.svg], { type: 'image/svg+xml;charset=utf-8' })
        if (kind === 'svg') { download(fileName(label, 'svg'), svgBlob()); return }
        const offerSvg = async (): Promise<void> => {
          const yes = await dialogs.confirm({ title: '导图过大，无法导出 PNG', message: '尺寸超过浏览器画布上限，改为导出 SVG？', ok: '导出 SVG' })
          if (yes) download(fileName(label, 'svg'), svgBlob())
        }
        if (!pngFits(out.width, out.height, 2)) { await offerSvg(); return }
        try {
          download(fileName(label, 'png'), await svgToPng(out.svg, out.width, out.height, 2))
        } catch (error) {
          if (error instanceof MapTooLargeError) { await offerSvg(); return }
          throw error
        }
      }
    } catch (error) {
      dialogs.toast('导出失败：' + errText(error))
    }
  }, [doc, effectiveRoot, dialogs])

  const exportItems = (): MenuEntry[] => doc === null ? [] : [
    { kind: 'label', label: effectiveRoot !== doc.rootId ? '导出当前聚焦的节点' : '导出整篇文档' },
    { label: '导出 Markdown (.md)', onSelect: () => void exportAs('md') },
    { label: '导出 OPML (.opml)', onSelect: () => void exportAs('opml') },
    { label: '导出图片 (.png)', onSelect: () => void exportAs('png') },
    { label: '导出矢量图 (.svg)', onSelect: () => void exportAs('svg') },
    { label: '复制为 Markdown', onSelect: () => void exportAs('copy-md') },
  ]

  // ---------- import ----------
  const fileInput = useRef<HTMLInputElement>(null)
  const importFiles = useCallback(async (files: FileList | null) => {
    if (files === null) return
    for (const file of Array.from(files)) {
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MB')
        const text = await file.text()
        const base = file.name.replace(/\.[^.]+$/, '')
        const isOpml = /\.(opml|xml)$/i.test(file.name) || /^\s*<\?xml|^\s*<opml/i.test(text)
        if (isOpml) {
          const parsed = parseOpml(text)
          await createDoc({ opml: text, title: parsed.title ?? base })
        } else {
          const parsed = parseMarkdown(text)
          await createDoc({ markdown: text, title: parsed.title ?? base })
        }
        dialogs.toast('已导入「' + file.name + '」')
      } catch (error) {
        dialogs.toast('导入失败：' + errText(error))
      }
    }
  }, [createDoc, dialogs])

  // ---------- backup ----------
  const openBackups = useCallback(() => {
    dialogs.show({ title: '备份与恢复', body: close => <BackupPanel close={close} onRestored={async () => { close(); await refreshLibrary(); state.reload() }} /> })
  }, [dialogs, refreshLibrary, state])

  // Undo / redo when the focus is not inside a text field.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const t = e.target as HTMLElement
    const mod = e.ctrlKey || e.metaKey
    if (t.closest('.mm-modal') !== null) return
    if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); showShortcuts(); return }
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F' || e.key === 'h' || e.key === 'H') && doc !== null && t.closest('.mm-side') === null) {
      e.preventDefault()
      setView('outline')
      setFindRequest(n => Math.max(n + 1, Date.now()))
      return
    }
    if (t.closest('textarea,input,.mm-map') !== null) return
    if (e.key === '?' && !mod) { e.preventDefault(); showShortcuts(); return }
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) state.redo(); else state.undo() }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); state.redo() }
  }

  const statusText = state.status === 'saved' ? '已保存' : state.status === 'saving' ? '保存中…' : state.status === 'dirty' ? '未保存' : state.status === 'conflict' ? '保存冲突' : '保存失败'
  const meta = library?.docs.find(d => d.id === activeId)

  // Keys typed while focus has fallen back to <body> (after clicking empty space)
  // still reach the app's global shortcuts.
  const keyRef = useRef(onKeyDown)
  keyRef.current = onKeyDown
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.target !== document.body || appRef.current === null || !appRef.current.isConnected) return
      // Never act on the document behind an open dialog.
      if (appRef.current.querySelector('.mm-modal-mask') !== null) return
      keyRef.current(e as unknown as React.KeyboardEvent)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  return (
    <div ref={appRef} className={'mm-app' + (sideOpen ? ' mm-side-open' : '') + (compact !== undefined ? ' mm-compact' : '')} onKeyDown={onKeyDown}>
      <div className="mm-scrim" onClick={() => setSideOpen(false)} />
      {compact !== undefined ? null : <Sidebar library={library} error={libError} activeId={activeId} onOpen={openDoc} onCreate={(folderId, markdown) => void createDoc(markdown === undefined ? { folderId } : { folderId, markdown })}
        onPatch={patchMeta} onTrash={trashDoc} onRefresh={refreshLibrary} onMenu={setMenu} onImport={() => fileInput.current?.click()} onBackups={openBackups}
        onChanged={setLibrary} />}
      <input ref={fileInput} type="file" accept=".md,.markdown,.txt,.opml,.xml" multiple hidden onChange={e => { void importFiles(e.target.files); e.target.value = '' }} />
      <main className="mm-main">
        <div className="mm-toolbar">
          {compact !== undefined ? (
            <select className="mm-doc-pick" aria-label="文档" value={activeId ?? ''} onChange={e => { if (e.target.value.length > 0) openDoc(e.target.value) }}>
              {activeId === null ? <option value="">选择文档…</option> : null}
              {(library?.docs ?? []).filter(d => d.trashedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
          ) : <button type="button" className="mm-icon-btn mm-side-toggle" aria-label="文档列表" onClick={() => setSideOpen(o => !o)}><Icon name="menu" /></button>}
          {doc !== null ? (
            <>
              <div className="mm-seg" role="tablist" aria-label="视图">
                <button type="button" role="tab" aria-selected={view === 'outline'} className={view === 'outline' ? 'mm-on' : ''} onClick={() => setView('outline')}>大纲</button>
                <button type="button" role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'mm-on' : ''} onClick={() => setView('map')}>导图</button>
              </div>
              <span className="mm-sep" />
              <button type="button" className="mm-icon-btn" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!state.canUndo} onMouseDown={e => e.preventDefault()} onClick={state.undo}><Icon name="undo" /></button>
              <button type="button" className="mm-icon-btn" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!state.canRedo} onMouseDown={e => e.preventDefault()} onClick={state.redo}><Icon name="redo" /></button>
              <button type="button" className="mm-icon-btn mm-secondary" title="全部展开" aria-label="全部展开" onClick={() => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, false), { noHistory: true })}><Icon name="expand" /></button>
              <button type="button" className="mm-icon-btn mm-secondary" title="全部折叠" aria-label="全部折叠" onClick={() => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, true), { noHistory: true })}><Icon name="collapse" /></button>
              <span className="mm-grow" />
              <PendingBadge count={ai.pending} onOpen={ai.pendingMenu} />
              <span className={'mm-status' + (state.status === 'error' || state.status === 'conflict' ? ' mm-err' : '')} title={state.statusMessage ?? undefined} aria-live="polite">{statusText}</span>
              <button type="button" className="mm-icon-btn mm-secondary" title="导出" aria-label="导出" onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.right - 180, y: r.bottom + 4, items: exportItems() })
              }}><Icon name="download" /></button>
              <button type="button" className="mm-icon-btn mm-secondary" title="快捷键 (Ctrl+/)" aria-label="快捷键" onClick={showShortcuts}><span aria-hidden="true" style={{ fontWeight: 600, fontSize: 14 }}>?</span></button>
              <button type="button" className="mm-icon-btn" title="更多" aria-label="更多" onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                const m = meta
                setMenu({ x: r.right - 200, y: r.bottom + 4, items: [
                  { label: m?.favorite === true ? '取消收藏' : '收藏', disabled: m === undefined, onSelect: () => m !== undefined && void patchMeta(m.id, { favorite: !m.favorite }) },
                  { label: '查找和替换', shortcut: 'Ctrl+F', onSelect: () => { setView('outline'); setFindRequest(n => Math.max(n + 1, Date.now())) } },
                  { label: '全部展开', onSelect: () => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, false), { noHistory: true }) },
                  { label: '全部折叠', onSelect: () => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, true), { noHistory: true }) },
                  { label: '立即保存', onSelect: () => void state.flush() },
                  { kind: 'sep' },
                  ...exportItems(),
                  { kind: 'sep' },
                  { label: '快捷键', shortcut: 'Ctrl+/', onSelect: showShortcuts },
                  { label: '删除文档', danger: true, onSelect: () => void trashDoc(doc.id) },
                ] })
              }}><Icon name="more" /></button>
            </>
          ) : <span className="mm-grow" />}
        </div>
        {state.conflict !== null ? (
          <div className="mm-banner" role="alert">
            <span className="mm-grow">这篇文档在别处被修改过（例如另一个窗口）。你的修改尚未保存。</span>
            <button type="button" className="mm-btn" onClick={() => state.resolveConflict('theirs')}>载入对方版本</button>
            <button type="button" className="mm-btn" onClick={() => void saveConflictCopy()}>另存为副本</button>
            <button type="button" className="mm-btn mm-primary" onClick={() => state.resolveConflict('mine')}>保留我的</button>
          </div>
        ) : null}
        {state.status === 'error' && state.statusMessage !== null ? <div className="mm-banner" role="alert"><span className="mm-grow">{state.statusMessage}</span><button type="button" className="mm-btn" onClick={() => void state.flush()}>重试</button></div> : null}
        {doc === null || effectiveRoot === null ? (
          <div className="mm-blank">
            {state.loading ? '加载中…' : state.loadError !== null ? <><span>无法打开文档：{state.loadError}</span><button type="button" className="mm-btn" onClick={state.reload}>重试</button></> : (
              <>
                <span>{library !== null && library.docs.some(d => d.trashedAt === undefined) ? '从左侧选择一篇文档' : '还没有文档'}</span>
                <button type="button" className="mm-btn mm-primary" onClick={() => void createDoc()}>新建文档</button>
              </>
            )}
          </div>
        ) : view === 'outline' ? (
          <div className="mm-doc">
            <div className="mm-doc-inner">
              <DocHeader doc={doc} rootId={effectiveRoot} state={state} onZoom={id => setRootId(id === doc.rootId ? null : id)} />
              <Outline state={state} doc={doc} rootId={effectiveRoot} onZoom={id => setRootId(id === doc.rootId ? null : id)} onMenu={setMenu}
                findRequest={findRequest} tagFilter={tagFilter} onTagFilter={setTagFilter}
                extraMenu={ai.extraMenu} onSessions={ai.sessionsMenu}
                onFocusTitle={() => {
                  const el = document.querySelector<HTMLTextAreaElement>('.mm-app .mm-title')
                  if (el !== null) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
                }} />
            </div>
            <StatusBar doc={doc} rootId={effectiveRoot} />
          </div>
        ) : (
          <MindMap state={state} doc={doc} rootId={effectiveRoot} rootLabel={effectiveRoot === doc.rootId ? doc.title : doc.nodes[effectiveRoot]!.text}
            onMenu={setMenu} selected={mapSel} onSelect={setMapSel} extraMenu={ai.extraMenu}
            onEditInOutline={id => { setView('outline'); reveal(doc, id) }} />
        )}
      </main>
      {menu !== null ? <PopupMenu key={menuKey.current} x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
      <DialogOutlet />
    </div>
  )
}

/** Title (or zoomed node) header with breadcrumb. */
function DocHeader(props: { doc: OutlineDoc; rootId: string; state: ReturnType<typeof useDocument>; onZoom(id: string): void }): ReactNode {
  const { doc, rootId, state } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  const zoomed = rootId !== doc.rootId
  const value = zoomed ? doc.nodes[rootId]!.text : doc.title
  const [draft, setDraft] = useState(value)
  const editingTitle = useRef(false)
  useEffect(() => { if (!editingTitle.current) setDraft(value) }, [value])
  useEffect(() => {
    const el = ref.current
    if (el !== null) { el.style.height = '0px'; el.style.height = el.scrollHeight + 'px' }
  })
  // Re-fit the height when the width changes (window resize, drawer toggle).
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      el.style.height = '0px'; el.style.height = el.scrollHeight + 'px'
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // New, untitled, empty document: put the caret in the title.
  useEffect(() => {
    const only = doc.nodes[doc.rootId]!.children
    if (!zoomed && doc.title === '未命名文档' && only.length === 1 && doc.nodes[only[0]!]!.text === '' && doc.revision === 0) {
      ref.current?.focus()
      ref.current?.select()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])
  const commit = (text: string): void => {
    if (zoomed) state.apply(ops.setText(doc, rootId, text), { key: 'text:' + rootId })
    else state.apply({ ...doc, title: text }, { key: 'title' })
  }
  const goFirst = (): void => {
    const kids = doc.nodes[rootId]!.children
    if (kids.length > 0) state.requestFocus(kids[0]!, 'end')
    else { const r = ops.insertChild(doc, rootId, 0); state.apply(r.doc, { focus: { id: r.focusId, caret: 0 } }) }
  }
  const crumbs = zoomed ? [...ancestors(doc, rootId)] : []
  return (
    <>
      {zoomed ? (
        <nav className="mm-crumbs" aria-label="路径">
          {crumbs.map((id, i) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {i > 0 ? <Icon name="chevronRight" size={12} /> : null}
              <button type="button" onClick={() => props.onZoom(id)}>{id === doc.rootId ? doc.title : (doc.nodes[id]!.text.split('\n')[0] || '（空）')}</button>
            </span>
          ))}
        </nav>
      ) : null}
      <textarea ref={ref} className={zoomed ? 'mm-title mm-zoom-title' : 'mm-title'} rows={1} value={zoomed ? value : draft} placeholder={zoomed ? '（空节点）' : '文档标题'} aria-label={zoomed ? '节点内容' : '文档标题'} spellCheck={false}
        onFocus={() => { editingTitle.current = true }}
        onBlur={() => {
          editingTitle.current = false
          state.breakMerge()
          if (!zoomed && draft.trim().length === 0) setDraft(doc.title)
        }}
        onChange={e => {
          const v = zoomed ? e.target.value : e.target.value.replace(/\n/g, ' ')
          if (!zoomed) { setDraft(v); if (v.trim().length > 0) commit(v) } else commit(v)
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goFirst() }
          else if (e.key === 'ArrowDown') { const el = e.currentTarget; if (el.selectionStart === el.value.length) { e.preventDefault(); goFirst() } }
        }} />
    </>
  )
}

function BackupPanel(props: { close(): void; onRestored(): Promise<void> }): ReactNode {
  const dialogs = useDialogs()
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = useCallback(() => { api.backups().then(setList, error => dialogs.toast('读取备份失败：' + errText(error))) }, [dialogs])
  useEffect(load, [load])
  const [quarantined, setQuarantined] = useState<QuarantinedFile[]>([])
  useEffect(() => { api.quarantine().then(setQuarantined, () => setQuarantined([])) }, [])
  const restore = async (fn: () => Promise<{ docs: number; preRestore: string }>, what: string): Promise<void> => {
    const yes = await dialogs.confirm({ title: '恢复备份', message: '用' + what + '覆盖当前所有文档？\n恢复前会自动备份当前数据，可以再恢复回来。', ok: '恢复', danger: true })
    if (!yes) return
    setBusy(true)
    try {
      const r = await fn()
      dialogs.toast('已恢复 ' + r.docs + ' 篇文档；原数据已备份为 ' + r.preRestore)
      await props.onRestored()
    } catch (error) {
      dialogs.toast('恢复失败：' + errText(error))
    } finally { setBusy(false) }
  }
  return (
    <div>
      <p style={{ margin: '0 0 10px', color: 'var(--mm-sub)' }}>每天首次保存前自动备份一次（保留 14 份）；另保留最近 10 份手动备份、5 份恢复前备份和 5 份永久删除前备份。数据保存在本机 ~/.dsh/dsh-mindmap。</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button type="button" className="mm-btn mm-primary" disabled={busy} onClick={async () => { setBusy(true); try { const b = await api.backupNow(); dialogs.toast('已备份：' + b.name); load() } catch (error) { dialogs.toast('备份失败：' + errText(error)) } finally { setBusy(false) } }}>立即备份</button>
        <button type="button" className="mm-btn" disabled={busy} onClick={() => fileRef.current?.click()}>从文件恢复…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f === undefined) return
          let data: unknown
          try { data = JSON.parse(await f.text()) } catch { dialogs.toast('不是有效的备份文件'); return }
          await restore(() => api.restoreFile(data), '文件「' + f.name + '」')
        }} />
      </div>
      {list === null ? <div className="mm-empty">加载中…</div> : list.length === 0 ? <div className="mm-empty">还没有备份</div> : list.map(b => (
        <div key={b.name} className="mm-backup-row">
          <span title={b.name}>{new Date(b.createdAt).toLocaleString()}<br /><small style={{ color: 'var(--mm-sub)' }}>{BACKUP_KIND_LABEL[b.kind ?? 'manual']} · {(b.size / 1024).toFixed(1)} KB</small></span>
          <a className="mm-btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={api.backupUrl(b.name)} download={b.name}>下载</a>
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void restore(() => api.restoreBackup(b.name), '备份 ' + b.name)}>恢复</button>
        </div>
      ))}
      {quarantined.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="mm-menu-label" style={{ padding: '4px 0' }}>已隔离的损坏文件（未删除，可手动检查）</div>
          {quarantined.map(q => <div key={q.name} className="mm-backup-row"><span><code className="mm-code">{q.name}</code><br /><small style={{ color: 'var(--mm-sub)' }}>{new Date(q.createdAt).toLocaleString()} · {(q.size / 1024).toFixed(1)} KB</small></span></div>)}
        </div>
      ) : null}
    </div>
  )
}

const BACKUP_KIND_LABEL: Record<BackupKind, string> = { daily: '每日自动', manual: '手动', 'pre-restore': '恢复前', purge: '永久删除前' }


function StatusBar(props: { doc: OutlineDoc; rootId: string }): ReactNode {
  const c = useMemo(() => countTree(props.doc, props.rootId), [props.doc, props.rootId])
  return (
    <div className="mm-statusbar" aria-label="统计">
      <span>{c.nodes} 个节点</span>
      <span>{c.chars} 字</span>
      {c.todo > 0 ? <span>待办 {c.done}/{c.todo}</span> : null}
    </div>
  )
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['编辑', [['Enter', '新建同级节点（在光标处拆分）'], ['Tab / Shift+Tab', '缩进 / 取消缩进'], ['Shift+Enter', '添加或编辑备注'], ['Alt+Enter', '节点内换行'], ['Backspace（行首）', '与上一节点合并'], ['Delete（行尾）', '合并下一节点'], ['Ctrl+Shift+Backspace', '删除当前节点'], ['Ctrl+Enter', '标记完成'], ['Ctrl+B / Ctrl+I', '粗体 / 斜体'], ['Ctrl+E / Ctrl+Shift+S', '代码 / 删除线']]],
  ['移动与折叠', [['↑ / ↓', '上 / 下一行'], ['Alt+↑ / Alt+↓', '上移 / 下移节点'], ['Ctrl+.', '折叠 / 展开'], ['Ctrl+↑ / Ctrl+↓', '折叠 / 展开'], ['Alt+→ / Alt+←', '聚焦节点 / 返回上一级']]],
  ['选择', [['Esc', '退出编辑并选中节点'], ['Shift+↑ / Shift+↓', '扩展选择'], ['Ctrl+C / Ctrl+X / Ctrl+V', '复制 / 剪切 / 粘贴节点']]],
  ['全局', [['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'], ['Ctrl+F', '查找和替换'], ['Alt+1…9', '打开第 n 篇收藏'], ['Ctrl+/ 或 ?', '显示快捷键']]],
  ['导图', [['Tab / Enter', '添加子 / 同级节点'], ['F2 或 Space', '编辑节点'], ['方向键', '在节点间移动'], ['Delete', '删除节点'], ['拖动空白处 / 滚轮', '平移 / 缩放']]],
]

function ShortcutPanel(): ReactNode {
  return (
    <div className="mm-shortcuts">
      {SHORTCUTS.map(([group, rows]) => (
        <section key={group}>
          <h4>{group}</h4>
          <dl>{rows.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        </section>
      ))}
    </div>
  )
}
