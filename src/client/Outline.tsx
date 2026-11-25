/**
 * Outline (大纲) editor. Each visible node is one row; at most one row at a
 * time holds a <textarea> (the node text or its note being edited), the rest
 * show rendered inline Markdown. All edits go through the pure ops in
 * shared/ops.ts and DocumentState.apply, so undo/redo and autosave see every
 * change; folding is applied with noHistory.
 *
 * Modes: editing (one textarea) and row selection (Esc while editing; rows
 * are role=treeitem with a roving tabIndex). Find/replace and #tag filtering
 * are driven by props from the App.
 *
 * IME: every key handler returns early while composing (isComposing /
 * keyCode 229) so Enter / Backspace / arrows inside a Chinese candidate
 * window are never hijacked.
 * @module dsh-mindmap/client/Outline
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ancestors, flatten, toItems, type OutlineDoc, type OutlineNode, type TreeItem } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import { renderInline, type InlineMark } from './inline.tsx'
import type { DocumentState } from './useDocument.ts'
import { Icon, useDialogs, withSep, type MenuEntry, type MenuState } from './ui.tsx'
import { aiTip, aiViews, type AiView } from './ai.ts'
import { collapsedAncestors, filterRows, findMatches, NODES_MIME, offsetAtX, onFirstLine, onLastLine, rangeIds, replaceAll, replaceMatch, toggleMark, type FindMatch } from './outline/helpers.ts'
import { caretBoxes } from './outline/measure.ts'
import { clipboardItems, selectionItems, selectionMarkdown } from './outline/clipboard.ts'

const INDENT = 24
const DRAG_MIME = 'application/x-dsh-mindmap-node'
const CODE_MARK = '\u0060'

type Drop = { id: string; pos: ops.DropPosition } | null
type Caret = number | 'end' | 'start'
type Field = 'text' | 'note'
interface Sel { anchor: string; head: string }
interface RowMarks { text?: InlineMark[]; note?: InlineMark[] }
interface FindState { query: string; replace: string; cs: boolean; index: number }
const NO_MARKS: RowMarks = {}

interface RowControl {
  startEdit(id: string, caret: Caret): void
  startNote(id: string): void
  toggleFold(id: string): void
  toggleCheck(id: string): void
  bulletClick(e: MouseEvent, id: string): void
  tag(tag: string): void
  key(e: KeyboardEvent<HTMLTextAreaElement>, id: string): void
  noteKey(e: KeyboardEvent<HTMLTextAreaElement>, id: string): void
  change(id: string, value: string, caret: number): void
  noteChange(id: string, value: string): void
  select(id: string, caret: number): void
  paste(e: ClipboardEvent<HTMLTextAreaElement>, id: string): void
  blur(id: string): void
  noteBlur(id: string): void
  treeKey(e: KeyboardEvent<HTMLDivElement>): void
  menu(e: MouseEvent, id: string): void
  sessions(e: MouseEvent, id: string): void
  dragStart(e: DragEvent, id: string): void
  dragOver(e: DragEvent, id: string, depth: number): void
  drop(e: DragEvent): void
  dragEnd(): void
  bindInput(el: HTMLTextAreaElement | null): void
}

/** Caret offset in the source text for a click on rendered text (end when markup hides the mapping). */
function caretFromPoint(container: HTMLElement, x: number, y: number, source: string): number | 'end' {
  const doc = container.ownerDocument as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  let node: Node | null = null
  let offset = 0
  if (typeof doc.caretPositionFromPoint === 'function') {
    const p = doc.caretPositionFromPoint(x, y)
    if (p !== null) { node = p.offsetNode; offset = p.offset }
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y)
    if (r !== null) { node = r.startContainer; offset = r.startOffset }
  }
  if (node === null || !container.contains(node) || container.textContent !== source) return 'end'
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
    if (t === node) return total + offset
    total += t.textContent?.length ?? 0
  }
  return 'end'
}

const isComposing = (e: KeyboardEvent): boolean => e.nativeEvent.isComposing || e.keyCode === 229

const Row = memo(function Row(props: { node: OutlineNode; depth: number; editing: Field | null; selected: boolean; tabStop: boolean; marks: RowMarks; tags: boolean; filtered?: boolean; drop: ops.DropPosition | null; dragging: boolean; ai?: AiView; ctl: RowControl }): ReactNode {
  const { node, depth, ctl } = props
  const tip = props.ai !== undefined && props.ai !== 'gone' ? aiTip(node) : null
  const hasKids = node.children.length > 0
  const textRef = useRef<HTMLDivElement>(null)
  const onTag = props.tags ? ctl.tag : undefined
  const note = node.note ?? ''
  const cls = 'mm-node' + (node.checked === true ? ' mm-done' : '') + (props.selected ? ' mm-selected' : '') + (props.drop !== null ? ' mm-drop-' + props.drop : '') + (props.dragging ? ' mm-dragging' : '') + (props.ai !== undefined ? ' mm-ai-' + props.ai : '')
  return (
    <div className={cls} data-node-id={node.id} title={tip ?? undefined} role="treeitem" aria-level={depth + 1} aria-expanded={hasKids ? !node.collapsed : undefined} aria-selected={props.selected}
      tabIndex={props.tabStop ? 0 : -1}
      style={{ paddingLeft: depth * INDENT, ['--mm-drop-left' as string]: depth * INDENT + 40 + 'px' }}
      onDragOver={e => ctl.dragOver(e, node.id, depth)} onDrop={ctl.drop} onContextMenu={e => ctl.menu(e, node.id)}>
      <button type="button" tabIndex={-1} className={'mm-fold' + (node.collapsed === true ? ' mm-closed mm-show' : '')} style={{ visibility: hasKids && !props.filtered ? 'visible' : 'hidden' }}
        aria-label={node.collapsed === true ? '展开' : '折叠'} onMouseDown={e => e.preventDefault()} onClick={() => ctl.toggleFold(node.id)}><Icon name="chevron" size={14} /></button>
      <button type="button" tabIndex={-1} className={'mm-bullet' + (hasKids && node.collapsed === true ? ' mm-collapsed' : '')} draggable
        title="点击聚焦，Shift+点击扩展选择，拖动移动" aria-label="聚焦此节点" onClick={e => ctl.bulletClick(e, node.id)} onDragStart={e => ctl.dragStart(e, node.id)} onDragEnd={ctl.dragEnd}>
        <span className="mm-dot" />
      </button>
      {typeof node.checked === 'boolean' ? (
        <input type="checkbox" className="mm-check" tabIndex={-1} checked={node.checked} aria-label="完成" onMouseDown={e => e.preventDefault()} onChange={() => ctl.toggleCheck(node.id)} />
      ) : null}
      <div className="mm-body">
        {props.editing === 'text' ? (
          <textarea ref={ctl.bindInput} className="mm-input" rows={1} value={node.text} spellCheck={false} aria-label="节点内容"
            onChange={e => ctl.change(node.id, e.target.value, e.target.selectionStart)}
            onKeyDown={e => ctl.key(e, node.id)}
            onSelect={e => ctl.select(node.id, e.currentTarget.selectionStart)}
            onPaste={e => ctl.paste(e, node.id)}
            onBlur={() => ctl.blur(node.id)} />
        ) : (
          <div ref={textRef} className="mm-text"
            onMouseDown={e => {
              if (e.button !== 0) return
              e.preventDefault()
              ctl.startEdit(node.id, textRef.current !== null ? caretFromPoint(textRef.current, e.clientX, e.clientY, node.text) : 'end')
            }}>{renderInline(node.text, 'i', { marks: props.marks.text, onTag })}{node.text.endsWith('\n') ? '\u200b' : null}{(node.sessions?.length ?? 0) > 0 ? (
              <button type="button" tabIndex={-1} className="mm-sess-badge" title="关联的会话" aria-label={'关联的会话 ' + node.sessions!.length}
                onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={e => { e.stopPropagation(); ctl.sessions(e, node.id) }}>💬 {node.sessions!.length}</button>
            ) : null}</div>
        )}
        {props.editing === 'note' ? (
          <textarea ref={ctl.bindInput} className="mm-note mm-note-input" rows={1} value={note} spellCheck={false} aria-label="备注"
            onChange={e => ctl.noteChange(node.id, e.target.value)}
            onKeyDown={e => ctl.noteKey(e, node.id)}
            onBlur={() => ctl.noteBlur(node.id)} />
        ) : note.length > 0 ? (
          <div className="mm-note" onMouseDown={e => { if (e.button !== 0) return; e.preventDefault(); ctl.startNote(node.id) }}>{renderInline(note, 'n', { marks: props.marks.note, onTag })}</div>
        ) : null}
      </div>
    </div>
  )
})

export interface OutlineProps {
  state: DocumentState
  doc: OutlineDoc
  rootId: string
  onZoom(id: string): void
  onMenu(menu: MenuState): void
  /** Nonce; each change opens (and focuses) the find/replace bar. */
  findRequest?: number
  /** Active #tag filter (with '#'), or null/undefined for none. */
  tagFilter?: string | null
  /** Set or clear the #tag filter (clicking a #tag, or the chip's ×). */
  onTagFilter?(tag: string | null): void
  /** ArrowUp on the first visual line of the first row. */
  onFocusTitle?(): void
  /** Extra node-menu entries (AI review, sessions, references), shown before delete. */
  extraMenu?(id: string): MenuEntry[]
  /** The 💬 badge of a node with bound sessions was clicked. */
  onSessions?(id: string, x: number, y: number): void
}

/** The outline editor for one (sub)tree. */
export function Outline(props: OutlineProps): ReactNode {
  const { state, doc, rootId } = props
  const dialogs = useDialogs()
  const [editing, setEditing] = useState<string | null>(null)
  const [field, setField] = useState<Field>('text')
  const [sel, setSel] = useState<Sel | null>(null)
  const [find, setFind] = useState<FindState | null>(null)
  const [drop, setDrop] = useState<Drop>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  editingRef.current = editing
  const fieldRef = useRef<Field>(field)
  fieldRef.current = field
  const selRef = useRef<Sel | null>(sel)
  selRef.current = sel
  const pendingCaret = useRef<Caret | null>(null)
  /** Keep the x column when moving between rows by visual line. */
  const pendingX = useRef<{ id: string; line: 'first' | 'last'; x: number } | null>(null)
  /** Selection to restore after a mark toggle re-renders the textarea. */
  const pendingRange = useRef<{ id: string; text: string; start: number; end: number } | null>(null)
  const clip = useRef<{ text: string; json: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  const propsRef = useRef(props)
  propsRef.current = props
  const dialogsRef = useRef(dialogs)
  dialogsRef.current = dialogs

  const tag = props.tagFilter ?? null
  const keep = tag !== null ? editing : null
  const ai = useMemo(() => aiViews(doc, rootId), [doc, rootId])
  const rows = useMemo(() => tag !== null ? filterRows(doc, rootId, tag, keep !== null ? [keep] : []) : flatten(doc, rootId, true), [doc, rootId, tag, keep])
  const order = useMemo(() => rows.map(r => r.id), [rows])
  const orderRef = useRef(order)
  orderRef.current = order
  const selected = useMemo(() => new Set(sel !== null ? rangeIds(order, sel.anchor, sel.head) : []), [sel, order])

  // ------------------------------------------------------------ find state
  const matches = useMemo<FindMatch[]>(() => (find !== null && find.query.length > 0 ? findMatches(doc, rootId, find.query, find.cs) : []), [doc, rootId, find?.query, find?.cs])
  const curIndex = find !== null && matches.length > 0 ? Math.min(find.index, matches.length - 1) : -1
  const cur = curIndex >= 0 ? matches[curIndex] : undefined
  const marksById = useMemo(() => {
    const out = new Map<string, RowMarks>()
    matches.forEach((m, i) => {
      let rm = out.get(m.id)
      if (rm === undefined) { rm = {}; out.set(m.id, rm) }
      const list = (rm[m.field] ??= [])
      list.push({ start: m.start, end: m.end, current: i === curIndex })
    })
    return out
  }, [matches, curIndex])
  const curKey = cur !== undefined ? cur.id + ':' + cur.field + ':' + cur.start : null
  const scrolledKey = useRef<string | null>(null)

  // Reveal the current match (expand collapsed ancestors without history).
  useEffect(() => {
    if (cur === undefined) return
    const d = docRef.current
    const up = collapsedAncestors(d, propsRef.current.rootId, cur.id)
    if (up.length > 0) propsRef.current.state.apply(ops.applyMany(d, up, (x, id) => ops.setCollapsed(x, id, false)), { noHistory: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey])
  useLayoutEffect(() => {
    if (curKey === null) { scrolledKey.current = null; return }
    if (scrolledKey.current === curKey || cur === undefined) return
    const row = treeRef.current?.querySelector<HTMLElement>('[data-node-id="' + cur.id + '"]')
    if (row === null || row === undefined) return
    scrolledKey.current = curKey
    const hit = row.querySelector<HTMLElement>('.mm-find-cur') ?? row
    hit.scrollIntoView({ block: 'nearest' })
  })

  // Open the find bar when the nonce changes.
  // findRequest is a timestamp. A request made just before this view mounted
  // (Ctrl+F in the map switches here first) still counts.
  const lastFindReq = useRef(props.findRequest !== undefined && Date.now() - props.findRequest < 1500 ? -1 : props.findRequest)
  /** Where the caret was when the find bar opened; restored by closeFind. */
  const findReturn = useRef<{ id: string; caret: number } | null>(null)
  useEffect(() => {
    if (props.findRequest === undefined || props.findRequest === lastFindReq.current) return
    lastFindReq.current = props.findRequest
    const el = inputRef.current
    if (el !== null && editingRef.current !== null && fieldRef.current === 'text') findReturn.current = { id: editingRef.current, caret: el.selectionStart }
    const picked = el !== null && el.selectionStart !== el.selectionEnd ? el.value.slice(el.selectionStart, el.selectionEnd) : ''
    const seed = picked.includes('\n') ? '' : picked
    setSel(null)
    setFind(f => (f === null ? { query: seed, replace: '', cs: false, index: 0 } : seed.length > 0 ? { ...f, query: seed, index: 0 } : f))
    window.requestAnimationFrame(() => { const i = findInputRef.current; if (i !== null) { i.focus(); i.select() } })
  }, [props.findRequest])

  // ------------------------------------------------------------ focus logic
  // Focus requests from outside (undo, map, search, structural edits).
  useEffect(() => {
    const f = state.focus
    if (f === null || doc.nodes[f.id] === undefined) return
    pendingCaret.current = f.caret
    setSel(null)
    setField('text')
    setEditing(f.id)
    if (editingRef.current === f.id && fieldRef.current === 'text') placeCaret()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus])

  function placeCaret(): void {
    const el = inputRef.current
    if (el === null) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    const px = pendingX.current
    if (px !== null) {
      pendingX.current = null
      if (px.id === editingRef.current && fieldRef.current === 'text') {
        const boxes = caretBoxes(el)
        if (boxes !== null) {
          const pos = offsetAtX(boxes, px.line, px.x - el.getBoundingClientRect().left)
          el.setSelectionRange(pos, pos)
          pendingCaret.current = null
        }
      }
    }
    const want = pendingCaret.current
    if (want !== null) {
      const pos = want === 'end' ? el.value.length : want === 'start' ? 0 : Math.min(want, el.value.length)
      el.setSelectionRange(pos, pos)
      pendingCaret.current = null
    }
    el.scrollIntoView({ block: 'nearest' })
  }

  // Re-fit the editing textarea when its width changes (window / drawer resize).
  useEffect(() => {
    const el = inputRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      el.style.height = '0px'; el.style.height = el.scrollHeight + 'px'
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [editing, field])
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el !== null) { el.style.height = '0px'; el.style.height = el.scrollHeight + 'px' }
    const pr = pendingRange.current
    if (pr !== null && el !== null && editingRef.current === pr.id && el.value === pr.text) {
      pendingRange.current = null
      el.setSelectionRange(pr.start, pr.end)
    }
  })
  useLayoutEffect(() => { if (editing !== null) placeCaret() }, [editing, field])

  // Selection mode: keep DOM focus on the head row; drop stale selections.
  useLayoutEffect(() => {
    if (sel === null) return
    if (!orderRef.current.includes(sel.head)) { setSel(null); return }
    if (!orderRef.current.includes(sel.anchor)) { setSel({ anchor: sel.head, head: sel.head }); return }
    const row = treeRef.current?.querySelector<HTMLElement>('[data-node-id="' + sel.head + '"]')
    if (row === null || row === undefined) return
    if (document.activeElement !== row) row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const ctl = useMemo<RowControl>(() => {
    const apply = (next: OutlineDoc, focus?: { id: string; caret: Caret }, key?: string): void => {
      propsRef.current.state.apply(next, { focus, key })
    }
    const nb = (id: string): { prev?: string; next?: string } => {
      const o = orderRef.current
      const i = o.indexOf(id)
      if (i === -1) return ops.neighbours(docRef.current, propsRef.current.rootId, id)
      return { prev: o[i - 1], next: o[i + 1] }
    }
    const edit = (id: string | undefined, caret: Caret, f: Field = 'text'): void => {
      if (id === undefined) return
      pendingCaret.current = caret
      setSel(null)
      setField(f)
      setEditing(id)
      if (editingRef.current === id && fieldRef.current === f) placeCaret()
    }
    const fold = (id: string, collapsed: boolean): void => {
      const d = docRef.current
      const n = d.nodes[id]
      if (n === undefined || n.children.length === 0 || (n.collapsed === true) === collapsed) return
      propsRef.current.state.apply(ops.setCollapsed(d, id, collapsed), { noHistory: true })
    }
    const toast = (msg: string): void => dialogsRef.current.toast(msg)
    /** Delete several rows (one undo step) and select a neighbour. */
    const removeRows = (ids: readonly string[], message: string | null): void => {
      const d = docRef.current
      const o = orderRef.current
      const after = ops.deleteMany(d, ids)
      if (after === d) return
      const first = o.indexOf(ids[0]!)
      const last = o.indexOf(ids[ids.length - 1]!)
      let target: string | undefined
      for (let j = first - 1; j >= 0 && target === undefined; j--) if (after.nodes[o[j]!] !== undefined) target = o[j]
      for (let j = last + 1; j < o.length && target === undefined; j++) if (after.nodes[o[j]!] !== undefined) target = o[j]
      apply(after)
      setSel(target !== undefined ? { anchor: target, head: target } : null)
      if (message !== null) dialogsRef.current.toast(message, { label: '撤销', onClick: () => propsRef.current.state.undo() })
    }
    const copyRows = (ids: readonly string[], cut: boolean): void => {
      const d = docRef.current
      const payload = { text: selectionMarkdown(d, ids), json: JSON.stringify(selectionItems(d, ids)) }
      clip.current = payload
      let ok = false
      try { ok = document.execCommand('copy') } catch { ok = false }
      if (!ok || clip.current !== null) {
        // The copy event did not run (no user activation); plain text only.
        clip.current = null
        void navigator.clipboard?.writeText(payload.text).catch(() => toast('无法写入剪贴板'))
      }
      const n = ops.topLevelOf(d, ids).length
      if (cut) removeRows(ids, '已剪切 ' + n + ' 个节点')
      else toast('已复制 ' + n + ' 个节点')
    }
    return {
      startEdit(id, caret) { edit(id, caret) },
      startNote(id) { edit(id, 'end', 'note') },
      toggleFold(id) {
        const d = docRef.current
        propsRef.current.state.apply(ops.setCollapsed(d, id, d.nodes[id]?.collapsed !== true), { noHistory: true })
      },
      toggleCheck(id) { apply(ops.toggleDone(docRef.current, id)) },
      bulletClick(e, id) {
        if (e.shiftKey) {
          e.preventDefault()
          const s = selRef.current
          const anchor = s !== null ? s.anchor : editingRef.current ?? id
          setEditing(null)
          setSel({ anchor, head: id })
          return
        }
        propsRef.current.onZoom(id)
      },
      tag(t) { propsRef.current.onTagFilter?.(t) },
      bindInput(el) { inputRef.current = el },
      change(id, value, caret) {
        propsRef.current.state.setSelection({ nodeId: id, caret })
        apply(ops.setText(docRef.current, id, value), undefined, 'text:' + id)
      },
      noteChange(id, value) {
        apply(ops.setNote(docRef.current, id, value.replace(/\r\n?/g, '\n')), undefined, 'note:' + id)
      },
      select(id, caret) { propsRef.current.state.setSelection({ nodeId: id, caret }) },
      blur(id) {
        propsRef.current.state.breakMerge()
        // Defer: a keyboard move already switched editing to another node.
        window.setTimeout(() => { if (editingRef.current === id && document.activeElement !== inputRef.current) setEditing(null) }, 0)
      },
      noteBlur(id) {
        const d = docRef.current
        const note = d.nodes[id]?.note
        if (note !== undefined && note.trim().length === 0) apply(ops.setNote(d, id, ''), undefined, 'note:' + id)
        propsRef.current.state.breakMerge()
        window.setTimeout(() => {
          if (editingRef.current === id && fieldRef.current === 'note' && document.activeElement !== inputRef.current) { setEditing(null); setField('text') }
        }, 0)
      },
      noteKey(e, id) {
        if (isComposing(e)) return
        const mod = e.ctrlKey || e.metaKey
        const k = e.key
        const stop = (): void => { e.preventDefault(); e.stopPropagation() }
        if (mod && !e.altKey && (k === 'z' || k === 'Z')) { stop(); if (e.shiftKey) propsRef.current.state.redo(); else propsRef.current.state.undo(); return }
        if (mod && !e.altKey && (k === 'y' || k === 'Y')) { stop(); propsRef.current.state.redo(); return }
        // Tab must not move focus out of the note (and lose the edit).
        if (k === 'Tab') { stop(); return }
        if (k === 'Escape' || (k === 'Enter' && e.shiftKey && !mod && !e.altKey)) {
          stop()
          const d = docRef.current
          const note = d.nodes[id]?.note
          if (note !== undefined && note.trim().length === 0) apply(ops.setNote(d, id, ''), undefined, 'note:' + id)
          propsRef.current.state.breakMerge()
          edit(id, 'end', 'text')
        }
      },
      key(e, id) {
        if (isComposing(e)) return
        const el = e.currentTarget
        const d = docRef.current
        const root = propsRef.current.rootId
        const start = el.selectionStart
        const end = el.selectionEnd
        const val = el.value
        const mod = e.ctrlKey || e.metaKey
        const k = e.key
        const stop = (): void => { e.preventDefault(); e.stopPropagation() }
        propsRef.current.state.setSelection({ nodeId: id, caret: start })
        if (mod && !e.altKey && (k === 'z' || k === 'Z')) { stop(); if (e.shiftKey) propsRef.current.state.redo(); else propsRef.current.state.undo(); return }
        if (mod && !e.altKey && (k === 'y' || k === 'Y')) { stop(); propsRef.current.state.redo(); return }
        if (mod && e.shiftKey && !e.altKey && k === 'Backspace') {
          stop()
          const { prev, next } = nb(id)
          const after = ops.deleteNode(d, id)
          if (after === d) return
          if (prev !== undefined && after.nodes[prev] !== undefined) apply(after, { id: prev, caret: 'end' })
          else if (next !== undefined && after.nodes[next] !== undefined) apply(after, { id: next, caret: 0 })
          else { apply(after); setEditing(null) }
          return
        }
        const lower = k.length === 1 ? k.toLowerCase() : k
        // Ctrl+A: first press selects this node's text (browser default); a
        // second press (text already fully selected, or empty) selects every row.
        if (mod && !e.altKey && !e.shiftKey && lower === 'a' && start === 0 && end === val.length) {
          const o = orderRef.current
          if (o.length === 0) return
          stop()
          propsRef.current.state.breakMerge()
          setEditing(null)
          setSel({ anchor: o[0]!, head: o[o.length - 1]! })
          return
        }
        const mark = !mod || e.altKey ? null
          : !e.shiftKey && lower === 'b' ? '**'
          : !e.shiftKey && lower === 'i' ? '*'
          : !e.shiftKey && lower === 'e' ? CODE_MARK
          : e.shiftKey && lower === 's' ? '~~'
          : null
        if (mark !== null) {
          stop()
          const r = toggleMark(val, start, end, mark)
          pendingRange.current = { id, text: r.text, start: r.start, end: r.end }
          propsRef.current.state.breakMerge()
          apply(ops.setText(d, id, r.text))
          return
        }
        if (mod && !e.altKey && !e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) { stop(); fold(id, k === 'ArrowUp'); return }
        if (mod && k === '.') { stop(); fold(id, d.nodes[id]?.collapsed !== true); return }
        if (k === 'Enter' && mod) { stop(); apply(ops.toggleDone(d, id), { id, caret: start }); return }
        if (k === 'Enter' && e.altKey) {
          stop()
          apply(ops.setText(d, id, val.slice(0, start) + '\n' + val.slice(end)), { id, caret: start + 1 }, 'text:' + id)
          return
        }
        if (k === 'Enter' && e.shiftKey) { stop(); edit(id, 'end', 'note'); return }
        if (k === 'Enter') {
          stop()
          const base = start !== end ? ops.setText(d, id, val.slice(0, start) + val.slice(end)) : d
          const r = ops.splitAt(base, id, start)
          apply(r.doc, { id: r.focusId, caret: r.caret })
          return
        }
        if (k === 'Tab' && !mod && !e.altKey) {
          stop()
          const next = e.shiftKey ? ops.outdent(d, id, root) : ops.indent(d, id)
          if (next !== d) apply(next, { id, caret: start })
          return
        }
        if (k === 'Escape') {
          stop()
          propsRef.current.state.breakMerge()
          setEditing(null)
          setSel({ anchor: id, head: id })
          return
        }
        if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
          stop()
          const next = ops.moveSibling(d, id, k === 'ArrowUp' ? -1 : 1, root)
          if (next !== d) apply(next, { id, caret: start })
          return
        }
        if (e.altKey && !mod && k === 'ArrowRight') { stop(); propsRef.current.onZoom(id); return }
        if (e.altKey && !mod && k === 'ArrowLeft') {
          stop()
          if (root !== d.rootId) { const up = ancestors(d, root); propsRef.current.onZoom(up[up.length - 1] ?? d.rootId) }
          return
        }
        if (e.altKey || mod || e.shiftKey) return
        if (k === 'Backspace' && start === 0 && end === 0) {
          const r = ops.backspaceAtStart(d, id, nb(id).prev)
          if (r !== null) { stop(); apply(r.doc, { id: r.focusId, caret: r.caret }) }
          return
        }
        if (k === 'Delete' && start === val.length && end === val.length) {
          const r = ops.deleteAtEnd(d, id)
          if (r !== null) { stop(); apply(r.doc, { id: r.focusId, caret: r.caret }) }
          return
        }
        if ((k === 'ArrowUp' || k === 'ArrowDown') && start === end) {
          const up = k === 'ArrowUp'
          const boxes = caretBoxes(el)
          const edge = boxes !== null
            ? (up ? onFirstLine(boxes, start) : onLastLine(boxes, start))
            : (up ? val.lastIndexOf('\n', start - 1) === -1 : val.indexOf('\n', start) === -1)
          if (!edge) return
          const target = up ? nb(id).prev : nb(id).next
          if (target === undefined) {
            const onTitle = propsRef.current.onFocusTitle
            if (up && onTitle !== undefined && orderRef.current[0] === id) { stop(); propsRef.current.state.breakMerge(); setEditing(null); onTitle() }
            return
          }
          stop()
          // Logical-line column as fallback when the target cannot be measured.
          const col = start - (val.lastIndexOf('\n', start - 1) + 1)
          const t = d.nodes[target]!.text
          let caret: number
          if (up) { const ls = t.lastIndexOf('\n') + 1; caret = Math.min(ls + col, t.length) } else { const le = t.indexOf('\n'); caret = Math.min(col, le === -1 ? t.length : le) }
          const box = boxes?.[start]
          pendingX.current = box !== undefined ? { id: target, line: up ? 'last' : 'first', x: el.getBoundingClientRect().left + box.left } : null
          edit(target, caret)
          return
        }
        if (k === 'ArrowLeft' && start === 0 && end === 0) {
          const prev = nb(id).prev
          if (prev !== undefined) { stop(); edit(prev, 'end') }
          return
        }
        if (k === 'ArrowRight' && start === val.length && end === val.length) {
          const next = nb(id).next
          if (next !== undefined) { stop(); edit(next, 'start') }
        }
      },
      paste(e, id) {
        const items = clipboardItems(type => e.clipboardData.getData(type), true)
        if (items === null) return
        e.preventDefault()
        const el = e.currentTarget
        const r = ops.pasteItems(docRef.current, id, el.selectionStart, el.selectionEnd, items)
        propsRef.current.state.breakMerge()
        apply(r.doc, { id: r.focusId, caret: r.caret })
      },
      treeKey(e) {
        if (isComposing(e)) return
        const s = selRef.current
        const t = e.target as HTMLElement
        if (s === null || !t.classList.contains('mm-node')) return
        const d = docRef.current
        const root = propsRef.current.rootId
        const o = orderRef.current
        const ids = rangeIds(o, s.anchor, s.head)
        if (ids.length === 0) return
        const mod = e.ctrlKey || e.metaKey
        const k = e.key
        const lower = k.length === 1 ? k.toLowerCase() : k
        const stop = (): void => { e.preventDefault(); e.stopPropagation() }
        if (mod && !e.altKey && lower === 'z') { stop(); if (e.shiftKey) propsRef.current.state.redo(); else propsRef.current.state.undo(); return }
        if (mod && !e.altKey && lower === 'y') { stop(); propsRef.current.state.redo(); return }
        if (mod && !e.altKey && !e.shiftKey && lower === 'a') { stop(); if (o.length > 0) setSel({ anchor: o[0]!, head: o[o.length - 1]! }); return }
        if (mod && !e.altKey && (lower === 'c' || lower === 'x')) { stop(); copyRows(ids, lower === 'x'); return }
        if (k === 'Escape') { stop(); setSel(null); t.blur(); return }
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          const delta = k === 'ArrowUp' ? -1 : 1
          if (e.altKey && !mod) {
            stop()
            const next = ops.moveMany(d, ids, delta, root)
            if (next !== d) apply(next)
            setSel({ ...s })
            return
          }
          if (mod) return
          stop()
          const h = o[o.indexOf(s.head) + delta]
          if (h !== undefined) setSel(e.shiftKey ? { anchor: s.anchor, head: h } : { anchor: h, head: h })
          return
        }
        if ((k === 'Enter' || k === 'F2') && !mod && !e.altKey && !e.shiftKey) { stop(); edit(s.head, 'end'); return }
        if (k === 'Tab' && !mod && !e.altKey) {
          stop()
          const next = e.shiftKey ? ops.outdentMany(d, ids, root) : ops.indentMany(d, ids)
          if (next !== d) apply(next)
          setSel({ ...s })
          return
        }
        if ((k === 'Delete' || k === 'Backspace') && !mod && !e.altKey) {
          stop()
          removeRows(ids, '已删除 ' + ops.topLevelOf(d, ids).length + ' 个节点')
        }
      },
      menu(e, id) {
        e.preventDefault()
        const p = propsRef.current
        const d = docRef.current
        const n = d.nodes[id]!
        const act = (fn: () => OutlineDoc, focusId: string = id): void => { const next = fn(); if (next !== docRef.current) apply(next, { id: focusId, caret: 'end' }) }
        const copy = (text: string, done: string): void => {
          void navigator.clipboard.writeText(text).then(() => dialogs.toast(done), () => dialogs.toast('无法写入剪贴板'))
        }
        p.onMenu({ x: e.clientX, y: e.clientY, items: [
          { label: '在下方添加节点', shortcut: 'Enter', onSelect: () => { const r = ops.insertAfter(docRef.current, id); apply(r.doc, { id: r.focusId, caret: 0 }) } },
          { label: '添加子节点', onSelect: () => { const r = ops.insertChild(docRef.current, id, n.children.length); apply(r.doc, { id: r.focusId, caret: 0 }) } },
          { label: (n.note ?? '').length > 0 ? '编辑备注' : '添加备注', shortcut: 'Shift+Enter', onSelect: () => edit(id, 'end', 'note') },
          { kind: 'sep' },
          { label: '缩进', shortcut: 'Tab', onSelect: () => act(() => ops.indent(docRef.current, id)) },
          { label: '取消缩进', shortcut: 'Shift+Tab', onSelect: () => act(() => ops.outdent(docRef.current, id, p.rootId)) },
          { label: '上移', shortcut: 'Alt+↑', onSelect: () => act(() => ops.moveSibling(docRef.current, id, -1, p.rootId)) },
          { label: '下移', shortcut: 'Alt+↓', onSelect: () => act(() => ops.moveSibling(docRef.current, id, 1, p.rootId)) },
          { kind: 'sep' },
          { label: n.children.length === 0 ? '折叠（无子节点）' : n.collapsed === true ? '展开' : '折叠', shortcut: n.collapsed === true ? 'Ctrl+↓' : 'Ctrl+↑', disabled: n.children.length === 0, onSelect: () => fold(id, n.collapsed !== true) },
          { label: typeof n.checked === 'boolean' ? '取消待办' : '设为待办', onSelect: () => act(() => ops.toggleChecklist(docRef.current, id)) },
          { label: n.checked === true ? '标记为未完成' : '标记为完成', shortcut: 'Ctrl+Enter', onSelect: () => act(() => ops.toggleDone(docRef.current, id)) },
          { label: '聚焦此节点', shortcut: 'Alt+→', onSelect: () => p.onZoom(id) },
          { kind: 'sep' },
          { label: '复制为 Markdown', onSelect: () => copy(selectionMarkdown(d, [id]), '已复制 Markdown（含子节点）') },
          { label: '复制文本', onSelect: () => copy(n.text, '已复制') },
          ...withSep(p.extraMenu?.(id) ?? []),
          { kind: 'sep' },
          { label: n.children.length > 0 ? '删除节点及其子节点' : '删除节点', shortcut: 'Ctrl+Shift+⌫', danger: true, onSelect: () => {
            const { prev, next } = nb(id)
            const after = ops.deleteNode(docRef.current, id)
            if (after === docRef.current) return
            if (editingRef.current === id) setEditing(null)
            p.state.apply(after, prev !== undefined && after.nodes[prev] !== undefined ? { focus: { id: prev, caret: 'end' } } : next !== undefined && after.nodes[next] !== undefined ? { focus: { id: next, caret: 0 } } : {})
            dialogs.toast('已删除，可按 Ctrl+Z 撤销')
          } },
        ] })
      },
      sessions(e, id) {
        propsRef.current.onSessions?.(id, e.clientX, e.clientY)
      },
      dragStart(e, id) {
        const d = docRef.current
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(DRAG_MIME, id)
        e.dataTransfer.setData('text/plain', toItems(d, [id]).map(i => i.text).join('\n'))
        const row = (e.currentTarget as HTMLElement).closest('.mm-node')
        if (row !== null) e.dataTransfer.setDragImage(row, 20, 15)
        dragIdRef.current = id
        setDragId(id)
        setEditing(null)
        setSel(null)
      },
      dragOver(e, id, depth) {
        const src = dragIdRef.current
        if (src === null) return
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const y = (e.clientY - rect.top) / rect.height
        const x = e.clientX - rect.left - depth * INDENT
        const d = docRef.current
        const target = d.nodes[id]!
        let pos: ops.DropPosition = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside'
        if (pos === 'after' && x > 64 && (target.children.length === 0 || target.collapsed === true)) pos = 'inside'
        if (pos === 'after' && target.children.length > 0 && target.collapsed !== true) pos = 'inside'
        if (!ops.canMove(d, src, id, pos)) { dropRef.current = null; setDrop(null); return }
        dropRef.current = { id, pos }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDrop(c => (c?.id === id && c.pos === pos ? c : { id, pos }))
      },
      drop(e) {
        const src = dragIdRef.current
        const target = dropRef.current
        dragIdRef.current = null
        dropRef.current = null
        setDrop(null)
        setDragId(null)
        if (src === null || target === null) return
        e.preventDefault()
        const d = docRef.current
        let next = target.pos === 'inside' ? ops.setCollapsed(d, target.id, false) : d
        next = ops.moveNode(next, src, target.id, target.pos)
        if (target.pos === 'inside') {
          // moveNode appends inside; put it first, like dropping onto the parent line.
          const kids = next.nodes[target.id]!.children
          if (kids[kids.length - 1] === src && kids.length > 1) next = ops.moveNode(next, src, kids[0]!, 'before')
        }
        if (next !== d) apply(next)
      },
      dragEnd() { dragIdRef.current = null; dropRef.current = null; setDrop(null); setDragId(null) },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dragIdRef = useRef<string | null>(null)
  dragIdRef.current = dragId
  const dropRef = useRef<Drop>(null)
  dropRef.current = drop

  // Row-selection copy / cut / paste via the native clipboard events.
  useEffect(() => {
    const onCopy = (e: globalThis.ClipboardEvent): void => {
      const c = clip.current
      if (c === null || e.clipboardData === null) return
      clip.current = null
      e.clipboardData.setData('text/plain', c.text)
      e.clipboardData.setData(NODES_MIME, c.json)
      e.preventDefault()
    }
    const onPaste = (e: globalThis.ClipboardEvent): void => {
      const s = selRef.current
      const a = document.activeElement
      const dt = e.clipboardData
      if (s === null || dt === null || !(a instanceof HTMLElement) || !a.classList.contains('mm-node') || treeRef.current?.contains(a) !== true) return
      const items: TreeItem[] | null = clipboardItems(type => dt.getData(type), false)
      if (items === null) return
      e.preventDefault()
      const d = docRef.current
      const top = ops.topLevelOf(d, rangeIds(orderRef.current, s.anchor, s.head))
      const last = top[top.length - 1]
      if (last === undefined) return
      const r = ops.insertItems(d, items, { afterId: last })
      propsRef.current.state.apply(r.doc)
      setSel({ anchor: r.focusId, head: r.focusId })
    }
    document.addEventListener('copy', onCopy, true)
    document.addEventListener('cut', onCopy, true)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy, true)
      document.removeEventListener('cut', onCopy, true)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  const addFirst = useCallback(() => {
    const r = ops.insertChild(docRef.current, propsRef.current.rootId, docRef.current.nodes[propsRef.current.rootId]?.children.length ?? 0)
    propsRef.current.state.apply(r.doc, { focus: { id: r.focusId, caret: 0 } })
  }, [])

  // ------------------------------------------------------------- find bar
  const stepFind = (delta: number): void => {
    if (matches.length === 0) return
    const i = ((curIndex < 0 ? 0 : curIndex) + delta + matches.length) % matches.length
    scrolledKey.current = null
    setFind(f => (f === null ? f : { ...f, index: i }))
  }
  const closeFind = (): void => {
    setFind(null)
    const back = findReturn.current
    findReturn.current = null
    const el = inputRef.current
    if (el !== null && editingRef.current !== null) el.focus({ preventScroll: true })
    // The find input took focus and editing ended: go back to where the caret was.
    else if (back !== null && doc.nodes[back.id] !== undefined) ctl.startEdit(back.id, Math.min(back.caret, doc.nodes[back.id]!.text.length))
  }
  const replaceOne = (): void => {
    if (find === null || cur === undefined) return
    const next = replaceMatch(doc, cur, find.replace)
    if (next !== doc) state.apply(next)
  }
  const replaceEvery = (): void => {
    if (find === null || matches.length === 0) return
    const next = replaceAll(doc, matches, find.replace)
    if (next === doc) return
    const n = matches.length
    state.apply(next)
    dialogs.toast('已替换 ' + n + ' 处', { label: '撤销', onClick: () => propsRef.current.state.undo() })
  }
  const findKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(e)) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); return }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); stepFind(e.shiftKey ? -1 : 1) }
  }

  const tabStopId = sel !== null ? sel.head : editing ?? order[0]
  const tags = props.onTagFilter !== undefined

  return (
    <>
      {find !== null ? (
        <div className="mm-findbar" role="search" aria-label="查找与替换">
          <input ref={findInputRef} className="mm-findbar-input" type="text" placeholder="查找" aria-label="查找" value={find.query} spellCheck={false}
            onChange={e => { const q = e.target.value; scrolledKey.current = null; setFind(f => (f === null ? f : { ...f, query: q, index: 0 })) }} onKeyDown={findKey} />
          <input className="mm-findbar-input" type="text" placeholder="替换为" aria-label="替换为" value={find.replace} spellCheck={false}
            onChange={e => { const r = e.target.value; setFind(f => (f === null ? f : { ...f, replace: r })) }} onKeyDown={findKey} />
          <button type="button" className={'mm-findbar-btn' + (find.cs ? ' mm-on' : '')} aria-pressed={find.cs} title="区分大小写"
            onClick={() => setFind(f => (f === null ? f : { ...f, cs: !f.cs, index: 0 }))}>Aa</button>
          <span className={'mm-findbar-count' + (find.query.length > 0 && matches.length === 0 ? ' mm-none' : '')} aria-live="polite">
            {find.query.length === 0 ? '' : matches.length === 0 ? '0/0' : (curIndex + 1) + '/' + matches.length}
          </span>
          <button type="button" className="mm-findbar-btn" title="上一个 (Shift+Enter)" aria-label="上一个" disabled={matches.length === 0} onClick={() => stepFind(-1)}>↑</button>
          <button type="button" className="mm-findbar-btn" title="下一个 (Enter)" aria-label="下一个" disabled={matches.length === 0} onClick={() => stepFind(1)}>↓</button>
          <button type="button" className="mm-findbar-btn" disabled={cur === undefined} onClick={replaceOne}>替换</button>
          <button type="button" className="mm-findbar-btn" disabled={matches.length === 0} onClick={replaceEvery}>全部替换</button>
          <button type="button" className="mm-findbar-btn" title="关闭 (Esc)" aria-label="关闭查找" onClick={closeFind}>×</button>
        </div>
      ) : null}
      {tag !== null ? (
        <div className="mm-tagbar">
          <span>筛选</span>
          <button type="button" className="mm-tagchip" title="取消筛选" aria-label={'取消筛选 ' + tag} onClick={() => props.onTagFilter?.(null)}>{tag}<span aria-hidden="true">×</span></button>
        </div>
      ) : null}
      <div ref={treeRef} className="mm-outline" role="tree" aria-label="大纲" aria-multiselectable="true" onKeyDown={ctl.treeKey}
        onBlur={() => window.setTimeout(() => {
          const a = document.activeElement
          if (selRef.current !== null && a !== null && a !== document.body && treeRef.current?.contains(a) !== true) setSel(null)
        }, 0)}
        onDragLeave={e => { if (e.currentTarget === e.target) setDrop(null) }}>
        {rows.map(r => {
          const node = doc.nodes[r.id]!
          return <Row key={r.id} node={node} depth={r.depth} editing={editing === r.id ? field : null} selected={selected.has(r.id)} tabStop={tabStopId === r.id}
            marks={marksById.get(r.id) ?? NO_MARKS} tags={tags} filtered={tag !== null} drop={drop?.id === r.id ? drop.pos : null} dragging={dragId === r.id} ai={ai.get(r.id)} ctl={ctl} />
        })}
        {rows.length === 0 && tag === null ? (
          <button type="button" className="mm-add" onClick={addFirst}><Icon name="plus" size={14} />添加节点</button>
        ) : rows.length === 0 ? (
          <div className="mm-empty">没有带 #{tag} 标签的节点</div>
        ) : tag !== null ? null : (
          <div style={{ height: 40, cursor: 'text' }} onMouseDown={e => {
            e.preventDefault()
            const kids = doc.nodes[rootId]?.children ?? []
            const last = kids[kids.length - 1]
            if (last !== undefined && doc.nodes[last]!.text.length === 0 && doc.nodes[last]!.children.length === 0) ctl.startEdit(last, 'end')
            else addFirst()
          }} />
        )}
      </div>
    </>
  )
}
