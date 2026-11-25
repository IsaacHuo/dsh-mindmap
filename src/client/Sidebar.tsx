/**
 * Left document navigator: favorites, documents grouped by DSH workspace
 * (工作区, plus 未归类) and the trash. Documents can be dragged onto a
 * workspace group; every row has a hover ⋯ button that opens the same menu as
 * a right click, so all actions are keyboard and touch reachable.
 * @module dsh-mindmap/client/Sidebar
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { flatten, type DocMeta, type Library, type OutlineDoc } from '../shared/model.ts'
import type { SearchHit } from '../shared/search.ts'
import { api } from './api.ts'
import { sortDocs, type SortKey } from './docUtils.ts'
import { renderInline } from './inline.tsx'
import { Icon, relTime, useDialogs, type MenuEntry, type MenuState } from './ui.tsx'
import { groupByWorkspace, type Workspace, type WorkspaceGroup } from './workspaces.ts'

const LS_CLOSED = 'dsh-mindmap:closed-workspaces'
const LS_SORT = 'dsh-mindmap:sort'
const TRASH_DAYS = 30
const DRAG_DOC = 'application/x-dsh-mindmap-doc'
/** Group key: workspace id, '' for 未归类. */
const gKey = (id: string | null | undefined): string => (typeof id === 'string' ? id : '')

/** Document ordering inside a list. */
const SORT_LABEL: Record<SortKey, string> = { updated: '最近编辑', title: '标题', created: '创建时间' }

function lsGet(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* private mode */ }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Drag = { kind: 'doc'; id: string } | null

/** Workspace assignment sent to the host. */
export interface WorkspaceTarget { workspaceId: string | null; workspaceName?: string }
const target = (g: WorkspaceGroup): WorkspaceTarget => (g.id === null ? { workspaceId: null } : { workspaceId: g.id, workspaceName: g.name })

export interface SidebarProps {
  library: Library | null
  error: string | null
  activeId: string | null
  onOpen(id: string, nodeId?: string | null): void
  /** Live DSH workspaces, or null when DSH does not provide them. */
  known: Workspace[] | null
  /** Create a document; `where` undefined = default workspace. */
  onCreate(where: WorkspaceTarget | undefined, markdown?: string): void
  onPatch(id: string, body: { title?: string; favorite?: boolean; workspaceId?: string | null; workspaceName?: string }): Promise<void>
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
  // Groups are open by default; remember the closed ones ('' = 未归类 is stored as '-').
  const [closed, setClosed] = useState<Set<string>>(() => new Set((lsGet(LS_CLOSED) ?? '').split(',').filter(Boolean).map(k => (k === '-' ? '' : k))))
  const [showTrash, setShowTrash] = useState(false)
  const [sort, setSortState] = useState<SortKey>(() => { const v = lsGet(LS_SORT); return v === 'title' || v === 'created' ? v : 'updated' })
  const [over, setOver] = useState<string | null>(null)
  const drag = useRef<Drag>(null)
  const lib = props.library
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => { lsSet(LS_CLOSED, Array.from(closed).map(k => (k === '' ? '-' : k)).join(',')) }, [closed])
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
  const groups = useMemo(() => groupByWorkspace(live, props.known), [live, props.known])
  /** Group a document is shown in (unknown workspaces fall into 未归类). */
  const groupOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) for (const d of g.docs) m.set(d.id, gKey(g.id))
    return m
  }, [groups])
  const favorites = live.filter(d => d.favorite)

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

  const toggleGroup = (k: string): void => setClosed(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const openGroup = (k: string): void => setClosed(s => { if (!s.has(k)) return s; const n = new Set(s); n.delete(k); return n })

  const newFromMarkdown = async (where: WorkspaceTarget | undefined): Promise<void> => {
    const md = await dialogs.prompt({ title: '从 Markdown 新建', message: '粘贴 Markdown 列表或标题（# 标题、- 要点、缩进表示层级）。按 Ctrl+Enter 创建。', placeholder: '# 2027 个人规划\n- 学习\n  - Rust', ok: '创建', multiline: true })
    if (md === null || md.trim().length === 0) return
    props.onCreate(where, md)
  }

  const createMenu = (x: number, y: number, g?: WorkspaceGroup): void => {
    const where = g === undefined ? undefined : target(g)
    props.onMenu({ x, y, items: [
      ...(g !== undefined ? [{ kind: 'label', label: '新建到「' + g.name + '」' } as MenuEntry] : []),
      { label: '空白文档', onSelect: () => props.onCreate(where) },
      { label: '从粘贴的 Markdown 新建…', onSelect: () => void newFromMarkdown(where) },
      { label: '导入文件（.md / .opml）…', onSelect: props.onImport },
      // From the header: empty workspaces are not listed, so offer them here.
      ...(g === undefined && groups.some(w => w.id !== null) ? [
        { kind: 'sep' } as MenuEntry,
        { kind: 'label', label: '新建空白文档到工作区' } as MenuEntry,
        ...groups.filter(w => w.id !== null).map<MenuEntry>(w => ({ label: w.name + (w.docs.length === 0 ? '（空）' : ''), onSelect: () => { openGroup(gKey(w.id)); props.onCreate(target(w)) } })),
      ] : []),
    ] })
  }

  const moveDoc = async (id: string, g: WorkspaceGroup): Promise<void> => {
    await props.onPatch(id, target(g))
    openGroup(gKey(g.id))
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
      { kind: 'label', label: '移动到工作区' },
      ...groups.map<MenuEntry>(g => {
        const here = groupOf.get(m.id) === gKey(g.id)
        return { label: (here ? '✓ ' : '') + g.name, disabled: here, onSelect: () => void moveDoc(m.id, g) }
      }),
      { kind: 'sep' },
      { label: '移到回收站', shortcut: 'Delete', danger: true, onSelect: () => void props.onTrash(m.id) },
    ]
    props.onMenu({ x, y, items })
  }

  // ---------- drag & drop (documents onto a workspace group) ----------
  const startDrag = (e: DragEvent, d: NonNullable<Drag>, label: string): void => {
    drag.current = d
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_DOC, d.id)
    e.dataTransfer.setData('text/plain', label)
  }
  const canDrop = (g: WorkspaceGroup): boolean => {
    const d = drag.current
    return d !== null && groupOf.has(d.id) && groupOf.get(d.id) !== gKey(g.id)
  }
  const dropProps = (g: WorkspaceGroup) => {
    const key = 'g:' + gKey(g.id)
    return {
      onDragOver: (e: DragEvent) => { if (!canDrop(g)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key) },
      onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(o => (o === key ? null : o)) },
      onDrop: (e: DragEvent) => {
        const d = drag.current
        drag.current = null
        setOver(null)
        if (d === null || !canDrop(g)) return
        e.preventDefault()
        void moveDoc(d.id, g)
      },
    }
  }
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

  const groupMenu = (g: WorkspaceGroup, x: number, y: number): void => createMenu(x, y, g)

  const groupNode = (g: WorkspaceGroup): ReactNode => {
    const k = gKey(g.id)
    const open = !closed.has(k)
    const docs = sortDocs(g.docs, sort)
    return (
      <div key={'g:' + k} role="group" aria-label={g.name} {...dropProps(g)}>
        <div className={'mm-row mm-folder-row mm-ws-row' + (over === 'g:' + k ? ' mm-drop-into' : '') + (g.id === null ? ' mm-ws-loose' : '')} role="button" tabIndex={0} aria-expanded={open}
          title={g.id === null ? '没有归属工作区的文档' : '工作区「' + g.name + '」'}
          onClick={() => toggleGroup(k)}
          onKeyDown={e => {
            if (rowKeys(e, (x, y) => groupMenu(g, x, y))) return
            if (e.key === 'Enter') toggleGroup(k)
            else if (e.key === 'ArrowRight' && !open) toggleGroup(k)
            else if (e.key === 'ArrowLeft' && open) toggleGroup(k)
          }}
          onContextMenu={e => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY) }}>
          <span className="mm-folder-arrow" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}><Icon name="chevron" size={12} /></span>
          <Icon name="folder" size={14} />
          <span className="mm-row-title">{g.name}</span>
          <span className="mm-row-time">{docs.length}</span>
          <button type="button" className="mm-row-more" aria-label={'在「' + g.name + '」新建文档'} title="在此新建文档" tabIndex={-1}
            onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); createMenu(r.left, r.bottom + 2, g) }}><Icon name="plus" size={14} /></button>
        </div>
        {open ? (docs.length > 0 ? docs.map(m => docRow(m, 1, 'w-')) : <div className="mm-empty" style={{ paddingLeft: 36 }}>{g.id === null ? '没有未归类的文档' : '还没有文档，可把文档拖到这里'}</div>) : null}
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

  // Only groups that hold documents are listed; an empty workspace appears once a document is created in or moved to it.
  const shown = groups.filter(g => g.docs.length > 0)
  return (
    <aside className="mm-side" aria-label="文档">
      <div className="mm-side-head">
        <span className="mm-side-title">思维导图</span>
        <button type="button" className="mm-icon-btn" title="新建文档" aria-label="新建文档" aria-haspopup="menu" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); createMenu(r.left, r.bottom + 4) }}><Icon name="plus" /></button>
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
            <div className="mm-section">
              <div className="mm-section-head">
                <span className="mm-grow">工作区</span>
                <button type="button" className="mm-sort-btn" aria-label={'排序：' + SORT_LABEL[sort]} aria-haspopup="menu" onClick={sortMenu}>{SORT_LABEL[sort]}<Icon name="chevron" size={10} /></button>
              </div>
              {shown.length === 0 ? <div className="mm-empty">点击右上角 + 新建文档</div> : shown.map(groupNode)}
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
