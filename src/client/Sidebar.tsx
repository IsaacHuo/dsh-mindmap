/**
 * Left document navigator: favorites, nested folders, loose documents and the
 * trash. Documents and folders can be dragged onto folders (or onto 未分类 /
 * the top level); every row has a hover ⋯ button that opens the same menu as
 * a right click, so all actions are keyboard and touch reachable.
 * @module dsh-mindmap/client/Sidebar
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { flatten, type DocMeta, type Folder, type Library, type OutlineDoc } from '../shared/model.ts'
import type { SearchHit } from '../shared/search.ts'
import { api } from './api.ts'
import { folderSubtree, sortDocs, type SortKey } from './docUtils.ts'
import { renderInline } from './inline.tsx'
import { Icon, relTime, useDialogs, type MenuEntry, type MenuState } from './ui.tsx'

const LS_FOLDERS = 'dsh-mindmap:open-folders'
const LS_SORT = 'dsh-mindmap:sort'
const TRASH_DAYS = 30
const DRAG_DOC = 'application/x-dsh-mindmap-doc'
const DRAG_FOLDER = 'application/x-dsh-mindmap-folder'

/** Document ordering inside a list. */
const SORT_LABEL: Record<SortKey, string> = { updated: '最近编辑', title: '标题', created: '创建时间' }

function lsGet(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* private mode */ }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Sort a copy of the documents. */

/** Folder ids in the subtree of id (including id). */

/** "父 / 子" path for menus. */
function folderPath(byId: ReadonlyMap<string, Folder>, id: string): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (let f = byId.get(id); f !== undefined && !seen.has(f.id); f = f.parentId != null ? byId.get(f.parentId) : undefined) { seen.add(f.id); parts.unshift(f.name) }
  return parts.join(' / ')
}

type Drag = { kind: 'doc' | 'folder'; id: string } | null

export interface SidebarProps {
  library: Library | null
  error: string | null
  activeId: string | null
  onOpen(id: string, nodeId?: string | null): void
  onCreate(folderId: string | null, markdown?: string): void
  onPatch(id: string, body: { title?: string; folderId?: string | null; favorite?: boolean }): Promise<void>
  onTrash(id: string): Promise<void>
  onRefresh(): Promise<Library | null>
  onMenu(m: MenuState): void
  onImport(): void
  onBackups(): void
  onChanged(lib: Library): void
}

/** Left document navigator. */
export function Sidebar(props: SidebarProps): ReactNode {
  const dialogs = useDialogs()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set((lsGet(LS_FOLDERS) ?? '').split(',').filter(Boolean)))
  const [showTrash, setShowTrash] = useState(false)
  const [sort, setSortState] = useState<SortKey>(() => { const v = lsGet(LS_SORT); return v === 'title' || v === 'created' ? v : 'updated' })
  const [over, setOver] = useState<string | null>(null)
  const drag = useRef<Drag>(null)
  const lib = props.library
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => { lsSet(LS_FOLDERS, Array.from(openFolders).join(',')) }, [openFolders])
  const setSort = (k: SortKey): void => { setSortState(k); lsSet(LS_SORT, k) }

  // Search: 250 ms debounce, independent of library refreshes.
  useEffect(() => {
    const q = query.trim()
    if (q.length === 0) { setHits(null); return }
    let alive = true
    const t = window.setTimeout(() => {
      api.search(q).then(r => { if (alive) setHits(r) }, () => { if (alive) setHits([]) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [query])

  const live = useMemo(() => sortDocs((lib?.docs ?? []).filter(d => d.trashedAt === undefined), sort), [lib, sort])
  const trash = useMemo(() => (lib?.docs ?? []).filter(d => d.trashedAt !== undefined).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)), [lib])
  const folders = useMemo(() => [...(lib?.folders ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [lib])
  const byId = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders])
  const childFolders = useMemo(() => {
    const m = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const p = f.parentId != null && byId.has(f.parentId) ? f.parentId : null
      const list = m.get(p) ?? []
      list.push(f)
      m.set(p, list)
    }
    return m
  }, [folders, byId])
  const favorites = live.filter(d => d.favorite)
  const loose = live.filter(d => d.folderId === null || !byId.has(d.folderId))

  // Alt+1…9 opens the n-th favorite.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return
      // Only while the user is in this page, not in other DSH panels.
      const t = e.target
      if (!(t instanceof Element) || (t !== document.body && t.closest('.mm-app') === null)) return
      const m = favorites[Number(e.code.slice(5)) - 1]
      if (m === undefined) return
      e.preventDefault()
      propsRef.current.onOpen(m.id)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [favorites])

  const toggleFolder = (id: string): void => setOpenFolders(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const newFolder = async (parentId: string | null): Promise<void> => {
    const name = await dialogs.prompt({ title: parentId === null ? '新建文件夹' : '新建子文件夹', placeholder: '文件夹名称', ok: '创建' })
    if (name === null || name.trim().length === 0) return
    try {
      const f = await api.createFolder(name.trim(), parentId)
      if (lib !== null) props.onChanged({ ...lib, folders: [...lib.folders, f] })
      setOpenFolders(s => { const n = new Set(s).add(f.id); if (parentId !== null) n.add(parentId); return n })
    } catch (error) { dialogs.toast('创建失败：' + errText(error)) }
  }

  const newFromMarkdown = async (folderId: string | null): Promise<void> => {
    const md = await dialogs.prompt({ title: '从 Markdown 新建', message: '粘贴 Markdown 列表或标题（# 标题、- 要点、缩进表示层级）。按 Ctrl+Enter 创建。', placeholder: '# 2027 个人规划\n- 学习\n  - Rust', ok: '创建', multiline: true })
    if (md === null || md.trim().length === 0) return
    props.onCreate(folderId, md)
  }

  const createMenu = (x: number, y: number, folderId: string | null): void => {
    props.onMenu({ x, y, items: [
      { label: '空白文档', onSelect: () => props.onCreate(folderId) },
      { label: '从粘贴的 Markdown 新建…', onSelect: () => void newFromMarkdown(folderId) },
      { label: '导入文件（.md / .opml）…', onSelect: props.onImport },
      { kind: 'sep' },
      { label: folderId === null ? '新建文件夹' : '新建子文件夹', onSelect: () => void newFolder(folderId) },
    ] })
  }

  const moveFolder = async (id: string, parentId: string | null): Promise<void> => {
    try { await api.moveFolder(id, parentId); await props.onRefresh(); if (parentId !== null) setOpenFolders(s => new Set(s).add(parentId)) } catch (error) { dialogs.toast('移动失败：' + errText(error)) }
  }
  const moveDoc = async (id: string, folderId: string | null): Promise<void> => {
    await props.onPatch(id, { folderId })
    if (folderId !== null) setOpenFolders(s => new Set(s).add(folderId))
  }

  /** `rk` = row key (prefix + id): a favourite doc is listed twice, only the clicked row renames. */
  /** After Enter / Esc in the rename box, keyboard focus returns to the row. */
  const refocusRow = (rk: string): void => {
    requestAnimationFrame(() => { (document.querySelector('[data-rk="' + CSS.escape(rk) + '"]') as HTMLElement | null)?.focus() })
  }
  const docMenu = (m: DocMeta, x: number, y: number, rk: string): void => {
    const items: MenuEntry[] = [
      { label: '打开', onSelect: () => props.onOpen(m.id) },
      { label: '重命名', shortcut: 'F2', onSelect: () => setRenaming(rk) },
      { label: m.favorite ? '取消收藏' : '收藏', onSelect: () => void props.onPatch(m.id, { favorite: !m.favorite }) },
      { kind: 'sep' },
      { kind: 'label', label: '移动到' },
      { label: (m.folderId === null ? '✓ ' : '') + '未分类', disabled: m.folderId === null, onSelect: () => void moveDoc(m.id, null) },
      ...folders.map<MenuEntry>(f => ({ label: (m.folderId === f.id ? '✓ ' : '') + folderPath(byId, f.id), disabled: m.folderId === f.id, onSelect: () => void moveDoc(m.id, f.id) })),
      { kind: 'sep' },
      { label: '移到回收站', shortcut: 'Delete', danger: true, onSelect: () => void props.onTrash(m.id) },
    ]
    props.onMenu({ x, y, items })
  }

  const folderMenu = (f: Folder, x: number, y: number): void => {
    const blocked = folderSubtree(folders, f.id)
    const parent = f.parentId ?? null
    props.onMenu({ x, y, items: [
      { label: '在此新建文档…', onSelect: () => createMenu(x, y, f.id) },
      { label: '新建子文件夹', onSelect: () => void newFolder(f.id) },
      { label: '重命名', onSelect: async () => {
        const next = await dialogs.prompt({ title: '重命名文件夹', value: f.name, ok: '保存' })
        if (next === null || next.trim().length === 0 || next.trim() === f.name) return
        try { const r = await api.renameFolder(f.id, next.trim()); if (lib !== null) props.onChanged({ ...lib, folders: lib.folders.map(x2 => (x2.id === f.id ? r : x2)) }) } catch (error) { dialogs.toast('重命名失败：' + errText(error)) }
      } },
      { kind: 'sep' },
      { kind: 'label', label: '移动到' },
      { label: (parent === null ? '✓ ' : '') + '顶层', disabled: parent === null, onSelect: () => void moveFolder(f.id, null) },
      ...folders.filter(o => !blocked.has(o.id)).map<MenuEntry>(o => ({ label: (parent === o.id ? '✓ ' : '') + folderPath(byId, o.id), disabled: parent === o.id, onSelect: () => void moveFolder(f.id, o.id) })),
      { kind: 'sep' },
      { label: '删除文件夹', danger: true, onSelect: async () => {
        const where = parent === null ? '「未分类」和顶层' : '上一级文件夹「' + (byId.get(parent)?.name ?? '') + '」'
        const ok = await dialogs.confirm({ title: '删除文件夹「' + f.name + '」？', message: '里面的文档和子文件夹不会被删除，会移到' + where + '。', ok: '删除', danger: true })
        if (!ok) return
        try { await api.deleteFolder(f.id); await props.onRefresh() } catch (error) { dialogs.toast('删除失败：' + errText(error)) }
      } },
    ] })
  }

  // ---------- drag & drop ----------
  const startDrag = (e: DragEvent, d: NonNullable<Drag>, label: string): void => {
    drag.current = d
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(d.kind === 'doc' ? DRAG_DOC : DRAG_FOLDER, d.id)
    e.dataTransfer.setData('text/plain', label)
  }
  const canDrop = (target: string | null): boolean => {
    const d = drag.current
    if (d === null) return false
    if (d.kind === 'doc') {
      const m = lib?.docs.find(x => x.id === d.id)
      return m !== undefined && m.folderId !== target
    }
    if (target !== null && folderSubtree(folders, d.id).has(target)) return false
    return (byId.get(d.id)?.parentId ?? null) !== target
  }
  const dropProps = (target: string | null, key: string) => ({
    onDragOver: (e: DragEvent) => { if (!canDrop(target)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key) },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(o => (o === key ? null : o)) },
    onDrop: (e: DragEvent) => {
      const d = drag.current
      drag.current = null
      setOver(null)
      if (d === null || !canDrop(target)) return
      e.preventDefault()
      if (d.kind === 'doc') void moveDoc(d.id, target)
      else void moveFolder(d.id, target)
    },
  })
  const endDrag = (): void => { drag.current = null; setOver(null) }

  const moreButton = (open: (x: number, y: number) => void): ReactNode => (
    <button type="button" className="mm-row-more" aria-label="更多操作" title="更多操作" tabIndex={-1}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); open(r.left, r.bottom + 2) }}><Icon name="more" size={14} /></button>
  )
  const rowKeys = (e: KeyboardEvent<HTMLElement>, open: (x: number, y: number) => void): boolean => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      open(r.left + 24, r.bottom)
      return true
    }
    return false
  }

  const docRow = (m: DocMeta, depth: number, keyPrefix: string, favIndex = -1): ReactNode => {
    const rk = keyPrefix + m.id
    return (
    <div key={rk} data-rk={rk} className={'mm-row' + (m.id === props.activeId ? ' mm-active' : '')} role="button" tabIndex={0} draggable={renaming !== rk}
      style={{ paddingLeft: 8 + depth * 14 }}
      aria-current={m.id === props.activeId ? 'page' : undefined}
      title={favIndex >= 0 && favIndex < 9 ? m.title + '（Alt+' + (favIndex + 1) + '）' : undefined}
      onClick={() => { if (renaming !== rk) props.onOpen(m.id) }}
      onKeyDown={e => {
        if (renaming === rk || rowKeys(e, (x, y) => docMenu(m, x, y, rk))) return
        if (e.key === 'Enter') props.onOpen(m.id)
        else if (e.key === 'F2') { e.preventDefault(); setRenaming(rk) }
        else if (e.key === 'Delete') { e.preventDefault(); void props.onTrash(m.id) }
      }}
      onDoubleClick={() => setRenaming(rk)}
      onDragStart={e => startDrag(e, { kind: 'doc', id: m.id }, m.title)} onDragEnd={endDrag}
      onContextMenu={e => { e.preventDefault(); docMenu(m, e.clientX, e.clientY, rk) }}>
      {renaming === rk ? (
        <RenameInput value={m.title} onDone={(title, byKey) => { setRenaming(null); if (byKey) refocusRow(rk); if (title !== null && title.trim().length > 0 && title.trim() !== m.title) void props.onPatch(m.id, { title: title.trim() }) }} />
      ) : (
        <>
          {m.favorite && keyPrefix !== 'fav-' ? <span className="mm-row-star" aria-label="已收藏"><Icon name="star" size={11} /></span> : null}
          <span className="mm-row-title">{m.title}</span>
          <span className="mm-row-time" title={new Date(sort === 'created' ? m.createdAt : m.updatedAt).toLocaleString()}>{relTime(sort === 'created' ? m.createdAt : m.updatedAt)}</span>
          {moreButton((x, y) => docMenu(m, x, y, rk))}
        </>
      )}
    </div>
  )
  }

  const folderNode = (f: Folder, depth: number, seen: Set<string>): ReactNode => {
    if (seen.has(f.id)) return null
    seen.add(f.id)
    const docs = live.filter(d => d.folderId === f.id)
    const subs = childFolders.get(f.id) ?? []
    const open = openFolders.has(f.id)
    const empty = docs.length === 0 && subs.length === 0
    return (
      <div key={f.id} role="group">
        <div className={'mm-row mm-folder-row' + (over === 'f:' + f.id ? ' mm-drop-into' : '')} role="button" tabIndex={0} aria-expanded={open} draggable
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggleFolder(f.id)}
          onKeyDown={e => {
            if (rowKeys(e, (x, y) => folderMenu(f, x, y))) return
            if (e.key === 'Enter') toggleFolder(f.id)
            else if (e.key === 'ArrowRight' && !open) toggleFolder(f.id)
            else if (e.key === 'ArrowLeft' && open) toggleFolder(f.id)
          }}
          onDragStart={e => startDrag(e, { kind: 'folder', id: f.id }, f.name)} onDragEnd={endDrag}
          {...dropProps(f.id, 'f:' + f.id)}
          onContextMenu={e => { e.preventDefault(); folderMenu(f, e.clientX, e.clientY) }}>
          <span className="mm-folder-arrow" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}><Icon name="chevron" size={12} /></span>
          <Icon name="folder" size={14} />
          <span className="mm-row-title">{f.name}</span>
          <span className="mm-row-time">{docs.length}</span>
          {moreButton((x, y) => folderMenu(f, x, y))}
        </div>
        {open ? (
          <>
            {subs.map(s => folderNode(s, depth + 1, seen))}
            {docs.map(m => docRow(m, depth + 1, 'f-'))}
            {empty ? <div className="mm-empty" style={{ paddingLeft: 22 + (depth + 1) * 14 }}>空文件夹</div> : null}
          </>
        ) : null}
      </div>
    )
  }

  const sortMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    props.onMenu({ x: r.left, y: r.bottom + 2, items: [
      { kind: 'label', label: '排序' },
      ...(Object.keys(SORT_LABEL) as SortKey[]).map<MenuEntry>(k => ({ label: (sort === k ? '✓ ' : '') + SORT_LABEL[k], onSelect: () => setSort(k) })),
    ] })
  }

  const restoreDoc = async (m: DocMeta): Promise<void> => {
    try { const meta = await api.restore(m.id); if (lib !== null) props.onChanged({ ...lib, docs: lib.docs.map(d => (d.id === m.id ? meta : d)) }); dialogs.toast('已恢复「' + m.title + '」') } catch (error) { dialogs.toast('恢复失败：' + errText(error)) }
  }
  const purgeDoc = async (m: DocMeta): Promise<boolean> => {
    const ok = await dialogs.confirm({ title: '永久删除「' + m.title + '」？', message: '删除前会自动做一份备份，可在「备份」里找回。', ok: '永久删除', danger: true })
    if (!ok) return false
    try { await api.purge(m.id); await props.onRefresh(); return true } catch (error) { dialogs.toast('删除失败：' + errText(error)); return false }
  }
  const emptyTrash = async (): Promise<void> => {
    const ok = await dialogs.confirm({ title: '清空回收站？', message: '将永久删除 ' + trash.length + ' 篇文档。删除前会自动做一份备份，可在「备份」里找回。', ok: '清空', danger: true })
    if (!ok) return
    try { const r = await api.emptyTrash(); await props.onRefresh(); dialogs.toast('已永久删除 ' + r.purged + ' 篇文档') } catch (error) { dialogs.toast('清空失败：' + errText(error)) }
  }
  const previewTrashed = (m: DocMeta): void => {
    dialogs.show({ title: m.title, body: close => <TrashPreview meta={m} onRestore={async () => { close(); await restoreDoc(m) }} onPurge={async () => { close(); await purgeDoc(m) }} /> })
  }
  const daysLeft = (m: DocMeta): number => Math.max(0, Math.ceil(((m.trashedAt ?? 0) + TRASH_DAYS * 86_400_000 - Date.now()) / 86_400_000))

  const top = childFolders.get(null) ?? []
  return (
    <aside className="mm-side" aria-label="文档">
      <div className="mm-side-head">
        <span className="mm-side-title">思维导图</span>
        <button type="button" className="mm-icon-btn" title="新建文件夹" aria-label="新建文件夹" onClick={() => void newFolder(null)}><Icon name="folderPlus" /></button>
        <button type="button" className="mm-icon-btn" title="新建文档" aria-label="新建文档" aria-haspopup="menu" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); createMenu(r.left, r.bottom + 4, null) }}><Icon name="plus" /></button>
      </div>
      <label className="mm-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="搜索文档和内容" aria-label="搜索文档和内容" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) setQuery('') }} />
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
                {favorites.map((m, i) => docRow(m, 0, 'fav-', i))}
              </div>
            ) : null}
            {top.length > 0 ? (
              <div className="mm-section">
                <div className={'mm-section-head' + (over === 'top' ? ' mm-drop-into' : '')} {...dropProps(null, 'top')}>文件夹</div>
                {(() => { const seen = new Set<string>(); return top.map(f => folderNode(f, 0, seen)) })()}
              </div>
            ) : null}
            <div className="mm-section" {...dropProps(null, 'loose')}>
              <div className={'mm-section-head' + (over === 'loose' ? ' mm-drop-into' : '')}>
                <span className="mm-grow">{top.length > 0 ? '未分类' : '文档'}</span>
                <button type="button" className="mm-sort-btn" aria-label={'排序：' + SORT_LABEL[sort]} aria-haspopup="menu" onClick={sortMenu}>{SORT_LABEL[sort]}<Icon name="chevron" size={10} /></button>
              </div>
              {loose.length === 0 ? <div className="mm-empty">{live.length === 0 ? '点击右上角 + 新建文档' : '没有未分类的文档'}</div> : loose.map(m => docRow(m, 0, 'd-'))}
            </div>
            {trash.length > 0 ? (
              <div className="mm-section">
                <div className="mm-row" role="button" tabIndex={0} aria-expanded={showTrash} onClick={() => setShowTrash(s => !s)} onKeyDown={e => { if (e.key === 'Enter') setShowTrash(s => !s) }}>
                  <Icon name="trash" size={14} /><span className="mm-row-title" style={{ color: 'var(--mm-sub)' }}>回收站</span><span className="mm-row-time">{trash.length}</span>
                </div>
                {showTrash ? (
                  <>
                    <div className="mm-trash-note">
                      <span className="mm-grow">{TRASH_DAYS} 天后自动永久删除</span>
                      <button type="button" className="mm-link-btn mm-danger" onClick={() => void emptyTrash()}>清空回收站</button>
                    </div>
                    {trash.map(m => (
                      <div key={'t-' + m.id} className="mm-row mm-indent mm-trashed" role="button" tabIndex={0} title="点击预览"
                        onClick={() => previewTrashed(m)} onKeyDown={e => { if (e.key === 'Enter') previewTrashed(m) }}
                        onContextMenu={e => { e.preventDefault(); props.onMenu({ x: e.clientX, y: e.clientY, items: [
                          { label: '预览', onSelect: () => previewTrashed(m) },
                          { label: '恢复', onSelect: () => void restoreDoc(m) },
                          { kind: 'sep' },
                          { label: '永久删除', danger: true, onSelect: () => void purgeDoc(m) },
                        ] }) }}>
                        <span className="mm-row-title">{m.title}</span>
                        <span className="mm-row-time">剩 {daysLeft(m)} 天</span>
                        <button type="button" className="mm-btn mm-mini" onClick={e => { e.stopPropagation(); void restoreDoc(m) }}>恢复</button>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="mm-side-foot">
        <button type="button" className="mm-btn" onClick={props.onImport}><Icon name="upload" size={14} />导入</button>
        <button type="button" className="mm-btn" onClick={props.onBackups}><Icon name="backup" size={14} />备份</button>
      </div>
    </aside>
  )
}

/** Read-only peek into a trashed document. */
function TrashPreview(props: { meta: DocMeta; onRestore(): void; onPurge(): void }): ReactNode {
  const [doc, setDoc] = useState<OutlineDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.doc(props.meta.id).then(setDoc, e => setError(errText(e))) }, [props.meta.id])
  const rows = doc === null ? [] : flatten(doc, doc.rootId, false)
  const LIMIT = 60
  return (
    <div>
      <p style={{ margin: '0 0 8px', color: 'var(--mm-sub)' }}>删除于 {new Date(props.meta.trashedAt ?? 0).toLocaleString()}{doc !== null ? ' · ' + rows.length + ' 个节点' : ''}</p>
      <div className="mm-preview">
        {error !== null ? <div className="mm-empty">无法读取：{error}</div> : doc === null ? <div className="mm-empty">加载中…</div> : rows.length === 0 ? <div className="mm-empty">（空文档）</div> : (
          <>
            {rows.slice(0, LIMIT).map(r => <div key={r.id} className="mm-preview-row" style={{ paddingLeft: r.depth * 16 }}>• {renderInline(doc.nodes[r.id]!.text.split('\n')[0] ?? '')}</div>)}
            {rows.length > LIMIT ? <div className="mm-empty">… 还有 {rows.length - LIMIT} 个节点</div> : null}
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="mm-btn mm-primary" onClick={props.onRestore}>恢复</button>
        <button type="button" className="mm-btn mm-danger" onClick={props.onPurge}>永久删除</button>
      </div>
    </div>
  )
}

function RenameInput(props: { value: string; onDone(value: string | null, byKey: boolean): void }): ReactNode {
  const [v, setV] = useState(props.value)
  const done = useRef(false)
  const finish = (value: string | null, byKey = false): void => { if (!done.current) { done.current = true; props.onDone(value, byKey) } }
  return (
    <input autoFocus value={v} aria-label="文档名称" onFocus={e => e.currentTarget.select()} onClick={e => e.stopPropagation()} onChange={e => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') finish(v, true)
        else if (e.key === 'Escape') finish(null, true)
      }} />
  )
}
