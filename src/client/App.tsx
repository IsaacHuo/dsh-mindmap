/**
 * 思维导图 page: document navigator on the left, editor (大纲 / 导图) on the
 * right. One document model drives both views.
 * @module dsh-mindplan/client/App
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ancestors, isInSubtree, type DocMeta, type Library, type OutlineDoc } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import { parseMarkdown, toMarkdown } from '../shared/markdown.ts'
import { parseOpml, toOpml } from '../shared/opml.ts'
import type { BackupInfo } from '../shared/api.ts'
import type { SearchHit } from '../shared/search.ts'
import { api } from './api.ts'
import { useDocument } from './useDocument.ts'
import { Outline } from './Outline.tsx'
import { MindMap } from './MindMap.tsx'
import { renderInline } from './inline.tsx'
import { canvasMeasure, layoutMap, mapToSvg, svgToPng, themeColors } from './mapLayout.ts'
import { DialogHost, download, fileName, Icon, PopupMenu, relTime, useDialogs, type MenuEntry, type MenuState } from './ui.tsx'

type ViewMode = 'outline' | 'map'
const LS_LAST = 'dsh-mindplan:last-doc'
const LS_VIEW = 'dsh-mindplan:view'
const LS_FOLDERS = 'dsh-mindplan:open-folders'

function lsGet(key: string): string | null {
  try {
    // Fall back to the pre-release dsh-mindmap:* keys so the last-open doc survives the rename.
    return window.localStorage.getItem(key) ?? window.localStorage.getItem(key.replace(/^dsh-mindplan:/, 'dsh-mindmap:'))
  } catch { return null }
}
function lsSet(key: string, value: string | null): void {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value) } catch { /* storage disabled */ }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Page root. */
export function App(): ReactNode {
  return <DialogHost><Shell /></DialogHost>
}

function Shell(): ReactNode {
  const dialogs = useDialogs()
  const appRef = useRef<HTMLDivElement>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [libError, setLibError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(() => lsGet(LS_LAST))
  const [view, setViewState] = useState<ViewMode>(() => (lsGet(LS_VIEW) === 'map' ? 'map' : 'outline'))
  const [rootId, setRootId] = useState<string | null>(null)
  const [mapSel, setMapSel] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [sideOpen, setSideOpen] = useState(false)
  const pendingNode = useRef<string | null>(null)

  const refreshLibrary = useCallback(async () => {
    try {
      const r = await api.library()
      setLibrary(r.library)
      setLibError(null)
      if (r.warnings.length > 0) dialogs.toast(r.warnings.join('；'))
      return r.library
    } catch (error) {
      setLibError(errText(error))
      return null
    }
  }, [dialogs])
  useEffect(() => { void refreshLibrary() }, [refreshLibrary])

  // Open the most recently edited doc when none is selected or the remembered one is gone.
  useEffect(() => {
    if (library === null) return
    const m = activeId === null ? undefined : library.docs.find(d => d.id === activeId)
    if (m === undefined || m.trashedAt !== undefined) {
      const next = library.docs.filter(d => d.trashedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      setActiveId(next?.id ?? null)
    }
  }, [library, activeId])
  useEffect(() => { lsSet(LS_LAST, activeId) }, [activeId])

  const onSaved = useCallback((saved: OutlineDoc) => {
    setLibrary(lib => (lib === null ? lib : { ...lib, docs: lib.docs.map(d => (d.id === saved.id ? { ...d, title: saved.title, updatedAt: saved.updatedAt } : d)) }))
  }, [])
  const state = useDocument(activeId, onSaved)
  const doc = state.doc

  // Reset zoom / selection when the document changes; keep zoom valid after undo.
  useEffect(() => { setRootId(null); setMapSel(null) }, [activeId])
  const effectiveRoot = doc !== null && rootId !== null && doc.nodes[rootId] !== undefined ? rootId : doc?.rootId ?? null

  const setView = (v: ViewMode): void => { setViewState(v); lsSet(LS_VIEW, v) }

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
      dialogs.toast('已移到回收站')
    } catch (error) {
      dialogs.toast('删除失败：' + errText(error))
    }
  }, [activeId, state, dialogs])

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
        const colors = themeColors(el)
        const layout = layoutMap(doc, root, label, canvasMeasure(colors.font))
        const out = mapToSvg(layout, colors)
        if (kind === 'svg') download(fileName(label, 'svg'), new Blob([out.svg], { type: 'image/svg+xml;charset=utf-8' }))
        else download(fileName(label, 'png'), await svgToPng(out.svg, out.width, out.height, 2))
      }
    } catch (error) {
      dialogs.toast('导出失败：' + errText(error))
    }
  }, [doc, effectiveRoot, dialogs])

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
    if (t.closest('textarea,input,.mm-map,.mm-modal') !== null) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) state.redo(); else state.undo() }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); state.redo() }
  }

  const statusText = state.status === 'saved' ? '已保存' : state.status === 'saving' ? '保存中…' : state.status === 'dirty' ? '未保存' : state.status === 'conflict' ? '保存冲突' : '保存失败'
  const meta = library?.docs.find(d => d.id === activeId)

  return (
    <div ref={appRef} className={'mm-app' + (sideOpen ? ' mm-side-open' : '')} onKeyDown={onKeyDown}>
      <div className="mm-scrim" onClick={() => setSideOpen(false)} />
      <Sidebar library={library} error={libError} activeId={activeId} onOpen={openDoc} onCreate={folderId => void createDoc({ folderId })}
        onPatch={patchMeta} onTrash={trashDoc} onRefresh={refreshLibrary} onMenu={setMenu} onImport={() => fileInput.current?.click()} onBackups={openBackups}
        onChanged={setLibrary} />
      <input ref={fileInput} type="file" accept=".md,.markdown,.txt,.opml,.xml" multiple hidden onChange={e => { void importFiles(e.target.files); e.target.value = '' }} />
      <main className="mm-main">
        <div className="mm-toolbar">
          <button type="button" className="mm-icon-btn mm-side-toggle" aria-label="文档列表" onClick={() => setSideOpen(o => !o)}><Icon name="menu" /></button>
          {doc !== null ? (
            <>
              <div className="mm-seg" role="tablist" aria-label="视图">
                <button type="button" role="tab" aria-selected={view === 'outline'} className={view === 'outline' ? 'mm-on' : ''} onClick={() => setView('outline')}>大纲</button>
                <button type="button" role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'mm-on' : ''} onClick={() => setView('map')}>导图</button>
              </div>
              <span className="mm-sep" />
              <button type="button" className="mm-icon-btn" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!state.canUndo} onMouseDown={e => e.preventDefault()} onClick={state.undo}><Icon name="undo" /></button>
              <button type="button" className="mm-icon-btn" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!state.canRedo} onMouseDown={e => e.preventDefault()} onClick={state.redo}><Icon name="redo" /></button>
              <button type="button" className="mm-icon-btn" title="全部展开" aria-label="全部展开" onClick={() => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, false), { noHistory: true })}><Icon name="expand" /></button>
              <button type="button" className="mm-icon-btn" title="全部折叠" aria-label="全部折叠" onClick={() => effectiveRoot !== null && state.apply(ops.setAllCollapsed(doc, effectiveRoot, true), { noHistory: true })}><Icon name="collapse" /></button>
              <span className="mm-grow" />
              <span className={'mm-status' + (state.status === 'error' || state.status === 'conflict' ? ' mm-err' : '')} title={state.statusMessage ?? undefined} aria-live="polite">{statusText}</span>
              <button type="button" className="mm-icon-btn" title="导出" aria-label="导出" onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.right - 180, y: r.bottom + 4, items: [
                  { kind: 'label', label: effectiveRoot !== doc.rootId ? '导出当前聚焦的节点' : '导出整篇文档' },
                  { label: '导出 Markdown (.md)', onSelect: () => void exportAs('md') },
                  { label: '导出 OPML (.opml)', onSelect: () => void exportAs('opml') },
                  { label: '导出图片 (.png)', onSelect: () => void exportAs('png') },
                  { label: '导出矢量图 (.svg)', onSelect: () => void exportAs('svg') },
                  { kind: 'sep' },
                  { label: '复制为 Markdown', onSelect: () => void exportAs('copy-md') },
                ] })
              }}><Icon name="download" /></button>
              <button type="button" className="mm-icon-btn" title="更多" aria-label="更多" onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                const m = meta
                setMenu({ x: r.right - 180, y: r.bottom + 4, items: [
                  { label: m?.favorite === true ? '取消收藏' : '收藏', disabled: m === undefined, onSelect: () => m !== undefined && void patchMeta(m.id, { favorite: !m.favorite }) },
                  { label: '立即保存', onSelect: () => void state.flush() },
                  { kind: 'sep' },
                  { label: '删除文档', danger: true, onSelect: () => void trashDoc(doc.id) },
                ] })
              }}><Icon name="more" /></button>
            </>
          ) : <span className="mm-grow" />}
        </div>
        {state.conflict !== null ? (
          <div className="mm-banner" role="alert">
            <span className="mm-grow">这篇文档在别处被修改过（例如另一个窗口）。你的修改尚未保存。</span>
            <button type="button" className="mm-btn" onClick={() => state.resolveConflict('theirs')}>使用磁盘上的版本</button>
            <button type="button" className="mm-btn mm-primary" onClick={() => state.resolveConflict('mine')}>保留我的修改</button>
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
              <Outline state={state} doc={doc} rootId={effectiveRoot} onZoom={id => setRootId(id === doc.rootId ? null : id)} onMenu={setMenu} />
            </div>
          </div>
        ) : (
          <MindMap state={state} doc={doc} rootId={effectiveRoot} rootLabel={effectiveRoot === doc.rootId ? doc.title : doc.nodes[effectiveRoot]!.text}
            onMenu={setMenu} selected={mapSel} onSelect={setMapSel}
            onEditInOutline={id => { setView('outline'); reveal(doc, id) }} />
        )}
      </main>
      {menu !== null ? <PopupMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
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

/** Left document navigator. */
function Sidebar(props: {
  library: Library | null
  error: string | null
  activeId: string | null
  onOpen(id: string, nodeId?: string | null): void
  onCreate(folderId: string | null): void
  onPatch(id: string, body: { title?: string; folderId?: string | null; favorite?: boolean }): Promise<void>
  onTrash(id: string): Promise<void>
  onRefresh(): Promise<Library | null>
  onMenu(m: MenuState): void
  onImport(): void
  onBackups(): void
  onChanged(lib: Library): void
}): ReactNode {
  const dialogs = useDialogs()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set((lsGet(LS_FOLDERS) ?? '').split(',').filter(Boolean)))
  const [showTrash, setShowTrash] = useState(false)
  const lib = props.library

  useEffect(() => { lsSet(LS_FOLDERS, Array.from(openFolders).join(',')) }, [openFolders])
  useEffect(() => {
    const q = query.trim()
    if (q.length === 0) { setHits(null); return }
    let alive = true
    const t = window.setTimeout(() => {
      api.search(q).then(r => { if (alive) setHits(r) }, () => { if (alive) setHits([]) })
    }, 220)
    return () => { alive = false; window.clearTimeout(t) }
  }, [query, lib])

  const live = useMemo(() => (lib?.docs ?? []).filter(d => d.trashedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt), [lib])
  const trash = useMemo(() => (lib?.docs ?? []).filter(d => d.trashedAt !== undefined).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)), [lib])
  const folders = useMemo(() => [...(lib?.folders ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [lib])

  const toggleFolder = (id: string): void => setOpenFolders(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const newFolder = async (): Promise<void> => {
    const name = await dialogs.prompt({ title: '新建文件夹', placeholder: '文件夹名称', ok: '创建' })
    if (name === null || name.trim().length === 0) return
    try {
      const f = await api.createFolder(name.trim())
      if (lib !== null) props.onChanged({ ...lib, folders: [...lib.folders, f] })
      setOpenFolders(s => new Set(s).add(f.id))
    } catch (error) { dialogs.toast('创建失败：' + errText(error)) }
  }

  const docMenu = (m: DocMeta, x: number, y: number): void => {
    const items: MenuEntry[] = [
      { label: '打开', onSelect: () => props.onOpen(m.id) },
      { label: '重命名', onSelect: () => setRenaming(m.id) },
      { label: m.favorite ? '取消收藏' : '收藏', onSelect: () => void props.onPatch(m.id, { favorite: !m.favorite }) },
      { kind: 'sep' },
      { kind: 'label', label: '移动到' },
      { label: (m.folderId === null ? '✓ ' : '') + '未分类', disabled: m.folderId === null, onSelect: () => void props.onPatch(m.id, { folderId: null }) },
      ...folders.map<MenuEntry>(f => ({ label: (m.folderId === f.id ? '✓ ' : '') + f.name, disabled: m.folderId === f.id, onSelect: () => void props.onPatch(m.id, { folderId: f.id }) })),
      { kind: 'sep' },
      { label: '删除', danger: true, onSelect: () => void props.onTrash(m.id) },
    ]
    props.onMenu({ x, y, items })
  }

  const folderMenu = (id: string, name: string, x: number, y: number): void => {
    props.onMenu({ x, y, items: [
      { label: '在此新建文档', onSelect: () => props.onCreate(id) },
      { label: '重命名', onSelect: async () => {
        const next = await dialogs.prompt({ title: '重命名文件夹', value: name, ok: '保存' })
        if (next === null || next.trim().length === 0 || next.trim() === name) return
        try { const f = await api.renameFolder(id, next.trim()); if (lib !== null) props.onChanged({ ...lib, folders: lib.folders.map(x2 => (x2.id === id ? f : x2)) }) } catch (error) { dialogs.toast('重命名失败：' + errText(error)) }
      } },
      { label: '删除文件夹', danger: true, onSelect: async () => {
        const ok = await dialogs.confirm({ title: '删除文件夹「' + name + '」？', message: '文件夹里的文档不会被删除，会移到「未分类」。', ok: '删除', danger: true })
        if (!ok) return
        try { await api.deleteFolder(id); await props.onRefresh() } catch (error) { dialogs.toast('删除失败：' + errText(error)) }
      } },
    ] })
  }

  const docRow = (m: DocMeta, indent: boolean, keyPrefix: string): ReactNode => (
    <div key={keyPrefix + m.id} className={'mm-row' + (indent ? ' mm-indent' : '') + (m.id === props.activeId ? ' mm-active' : '')} role="button" tabIndex={0}
      aria-current={m.id === props.activeId ? 'page' : undefined}
      onClick={() => { if (renaming !== m.id) props.onOpen(m.id) }}
      onKeyDown={e => { if (e.key === 'Enter' && renaming !== m.id) props.onOpen(m.id); else if (e.key === 'F2') setRenaming(m.id) }}
      onDoubleClick={() => setRenaming(m.id)}
      onContextMenu={e => { e.preventDefault(); docMenu(m, e.clientX, e.clientY) }}>
      {renaming === m.id ? (
        <RenameInput value={m.title} onDone={title => { setRenaming(null); if (title !== null && title.trim().length > 0 && title.trim() !== m.title) void props.onPatch(m.id, { title: title.trim() }) }} />
      ) : (
        <>
          <span className="mm-row-title" title={m.title}>{m.title}</span>
          <span className="mm-row-time" title={new Date(m.updatedAt).toLocaleString()}>{relTime(m.updatedAt)}</span>
        </>
      )}
    </div>
  )

  const favorites = live.filter(d => d.favorite)
  const loose = live.filter(d => d.folderId === null)
  return (
    <aside className="mm-side" aria-label="文档">
      <div className="mm-side-head">
        <span className="mm-side-title">思维导图</span>
        <button type="button" className="mm-icon-btn" title="新建文件夹" aria-label="新建文件夹" onClick={() => void newFolder()}><Icon name="folderPlus" /></button>
        <button type="button" className="mm-icon-btn" title="新建文档" aria-label="新建文档" onClick={() => props.onCreate(null)}><Icon name="plus" /></button>
      </div>
      <label className="mm-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="搜索文档和内容" aria-label="搜索文档和内容" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
      </label>
      <div className="mm-side-scroll">
        {props.error !== null ? <div className="mm-empty">无法读取文档列表：{props.error} <button type="button" className="mm-btn" onClick={() => void props.onRefresh()}>重试</button></div> : null}
        {hits !== null ? (
          <div className="mm-section">
            <div className="mm-section-head">搜索结果 · {hits.length}</div>
            {hits.length === 0 ? <div className="mm-empty">没有匹配的内容</div> : hits.map((h, i) => (
              <div key={i} className="mm-hit" role="button" tabIndex={0} onClick={() => props.onOpen(h.docId, h.nodeId)} onKeyDown={e => { if (e.key === 'Enter') props.onOpen(h.docId, h.nodeId) }}>
                <div className="mm-hit-title">{h.title}</div>
                {h.nodeId !== null ? <div className="mm-hit-snip">{renderInline(h.snippet)}</div> : null}
              </div>
            ))}
          </div>
        ) : lib === null && props.error === null ? <div className="mm-empty">加载中…</div> : (
          <>
            {favorites.length > 0 ? (
              <div className="mm-section">
                <div className="mm-section-head">收藏</div>
                {favorites.map(m => docRow(m, false, 'fav-'))}
              </div>
            ) : null}
            {folders.length > 0 ? (
              <div className="mm-section">
                <div className="mm-section-head">文件夹</div>
                {folders.map(f => {
                  const docs = live.filter(d => d.folderId === f.id)
                  const open = openFolders.has(f.id)
                  return (
                    <div key={f.id}>
                      <div className="mm-row" role="button" tabIndex={0} aria-expanded={open} onClick={() => toggleFolder(f.id)} onKeyDown={e => { if (e.key === 'Enter') toggleFolder(f.id) }}
                        onContextMenu={e => { e.preventDefault(); folderMenu(f.id, f.name, e.clientX, e.clientY) }}>
                        <span style={{ display: 'inline-flex', transform: open ? 'none' : 'rotate(-90deg)', color: 'var(--mm-sub)' }}><Icon name="chevron" size={12} /></span>
                        <Icon name="folder" size={14} />
                        <span className="mm-row-title">{f.name}</span>
                        <span className="mm-row-time">{docs.length}</span>
                      </div>
                      {open ? (docs.length === 0 ? <div className="mm-empty mm-indent">空文件夹</div> : docs.map(m => docRow(m, true, 'f-'))) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
            <div className="mm-section">
              <div className="mm-section-head"><span className="mm-grow">{folders.length > 0 ? '未分类' : '文档'}</span><span>最近编辑</span></div>
              {loose.length === 0 ? <div className="mm-empty">{live.length === 0 ? '点击右上角 + 新建文档' : '没有未分类的文档'}</div> : loose.map(m => docRow(m, false, 'd-'))}
            </div>
            {trash.length > 0 ? (
              <div className="mm-section">
                <div className="mm-row" role="button" tabIndex={0} aria-expanded={showTrash} onClick={() => setShowTrash(s => !s)} onKeyDown={e => { if (e.key === 'Enter') setShowTrash(s => !s) }}>
                  <Icon name="trash" size={14} /><span className="mm-row-title" style={{ color: 'var(--mm-sub)' }}>回收站</span><span className="mm-row-time">{trash.length}</span>
                </div>
                {showTrash ? trash.map(m => (
                  <div key={'t-' + m.id} className="mm-row mm-indent" onContextMenu={e => e.preventDefault()}>
                    <span className="mm-row-title" style={{ color: 'var(--mm-sub)' }} title={m.title}>{m.title}</span>
                    <button type="button" className="mm-btn" style={{ height: 22, padding: '0 6px', fontSize: 12 }} onClick={async () => {
                      try { const meta = await api.restore(m.id); if (lib !== null) props.onChanged({ ...lib, docs: lib.docs.map(d => (d.id === m.id ? meta : d)) }) } catch (error) { dialogs.toast('恢复失败：' + errText(error)) }
                    }}>恢复</button>
                    <button type="button" className="mm-btn mm-danger" style={{ height: 22, padding: '0 6px', fontSize: 12 }} onClick={async () => {
                      const ok = await dialogs.confirm({ title: '永久删除「' + m.title + '」？', message: '此操作无法撤销（每日备份中仍可能保留旧版本）。', ok: '永久删除', danger: true })
                      if (!ok) return
                      try { await api.purge(m.id); await props.onRefresh() } catch (error) { dialogs.toast('删除失败：' + errText(error)) }
                    }}>删除</button>
                  </div>
                )) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="mm-side-head" style={{ borderTop: '1px solid var(--mm-border)', padding: '8px 12px' }}>
        <button type="button" className="mm-btn" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={props.onImport}><Icon name="upload" size={14} />导入</button>
        <button type="button" className="mm-btn" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={props.onBackups}><Icon name="backup" size={14} />备份</button>
      </div>
    </aside>
  )
}

function RenameInput(props: { value: string; onDone(value: string | null): void }): ReactNode {
  const [v, setV] = useState(props.value)
  const done = useRef(false)
  const finish = (value: string | null): void => { if (!done.current) { done.current = true; props.onDone(value) } }
  return (
    <input autoFocus value={v} aria-label="文档名称" onFocus={e => e.currentTarget.select()} onClick={e => e.stopPropagation()} onChange={e => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') finish(v)
        else if (e.key === 'Escape') finish(null)
      }} />
  )
}

function BackupPanel(props: { close(): void; onRestored(): Promise<void> }): ReactNode {
  const dialogs = useDialogs()
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = useCallback(() => { api.backups().then(setList, error => dialogs.toast('读取备份失败：' + errText(error))) }, [dialogs])
  useEffect(load, [load])
  const restore = async (fn: () => Promise<{ docs: number; preRestore: string }>, what: string): Promise<void> => {
    if (!window.confirm('用' + what + '覆盖当前所有文档？\n恢复前会自动备份当前数据，可以再恢复回来。')) return
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
      <p style={{ margin: '0 0 10px', color: 'var(--mm-sub)' }}>每天首次保存时自动备份一次，保留最近 30 份。数据保存在本机 ~/.dsh/dsh-mindplan。</p>
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
          <span title={b.name}>{new Date(b.createdAt).toLocaleString()}<br /><small style={{ color: 'var(--mm-sub)' }}>{b.name} · {(b.size / 1024).toFixed(1)} KB</small></span>
          <a className="mm-btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={api.backupUrl(b.name)} download={b.name}>下载</a>
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void restore(() => api.restoreBackup(b.name), '备份 ' + b.name)}>恢复</button>
        </div>
      ))}
    </div>
  )
}
