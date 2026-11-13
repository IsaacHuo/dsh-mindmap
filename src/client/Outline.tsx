/**
 * Outline (大纲) editor. Each visible node is one row; exactly one row at a
 * time is a <textarea> (the one being edited), the rest show rendered inline
 * Markdown. All edits go through the pure ops in shared/ops.ts and
 * DocumentState.apply, so undo/redo and autosave see every change.
 *
 * IME: key handling returns early while composing (isComposing / keyCode 229)
 * so Enter / Backspace / arrows inside a Chinese candidate window are never
 * hijacked.
 * @module dsh-mindmap/client/Outline
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ancestors, flatten, toItems, type OutlineDoc, type OutlineNode } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import { parsePasted, toMarkdown } from '../shared/markdown.ts'
import { renderInline } from './inline.tsx'
import type { DocumentState } from './useDocument.ts'
import { Icon, useDialogs, type MenuState } from './ui.tsx'

const INDENT = 24
const DRAG_MIME = 'application/x-dsh-mindmap-node'

type Drop = { id: string; pos: ops.DropPosition } | null

interface RowControl {
  startEdit(id: string, caret: number | 'end'): void
  toggleFold(id: string): void
  toggleCheck(id: string): void
  zoom(id: string): void
  key(e: KeyboardEvent<HTMLTextAreaElement>, id: string): void
  change(id: string, value: string, caret: number): void
  select(id: string, caret: number): void
  paste(e: ClipboardEvent<HTMLTextAreaElement>, id: string): void
  blur(id: string): void
  menu(e: MouseEvent, id: string): void
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

const Row = memo(function Row(props: { node: OutlineNode; depth: number; editing: boolean; drop: ops.DropPosition | null; dragging: boolean; ctl: RowControl }): ReactNode {
  const { node, depth, ctl } = props
  const hasKids = node.children.length > 0
  const textRef = useRef<HTMLDivElement>(null)
  const cls = 'mm-node' + (node.checked === true ? ' mm-done' : '') + (props.drop !== null ? ' mm-drop-' + props.drop : '') + (props.dragging ? ' mm-dragging' : '')
  return (
    <div className={cls} data-node-id={node.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasKids ? !node.collapsed : undefined}
      style={{ paddingLeft: depth * INDENT, ['--mm-drop-left' as string]: depth * INDENT + 40 + 'px' }}
      onDragOver={e => ctl.dragOver(e, node.id, depth)} onDrop={ctl.drop} onContextMenu={e => ctl.menu(e, node.id)}>
      <button type="button" tabIndex={-1} className={'mm-fold' + (node.collapsed === true ? ' mm-closed mm-show' : '')} style={{ visibility: hasKids ? 'visible' : 'hidden' }}
        aria-label={node.collapsed === true ? '展开' : '折叠'} onClick={() => ctl.toggleFold(node.id)}><Icon name="chevron" size={14} /></button>
      <button type="button" tabIndex={-1} className={'mm-bullet' + (hasKids && node.collapsed === true ? ' mm-collapsed' : '')} draggable
        title="点击聚焦，拖动移动" aria-label="聚焦此节点" onClick={() => ctl.zoom(node.id)} onDragStart={e => ctl.dragStart(e, node.id)} onDragEnd={ctl.dragEnd}>
        <span className="mm-dot" />
      </button>
      {typeof node.checked === 'boolean' ? (
        <input type="checkbox" className="mm-check" tabIndex={-1} checked={node.checked} aria-label="完成" onChange={() => ctl.toggleCheck(node.id)} />
      ) : null}
      {props.editing ? (
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
          }}>{renderInline(node.text)}</div>
      )}
    </div>
  )
})

export interface OutlineProps {
  state: DocumentState
  doc: OutlineDoc
  rootId: string
  onZoom(id: string): void
  onMenu(menu: MenuState): void
}

/** The outline editor for one (sub)tree. */
export function Outline(props: OutlineProps): ReactNode {
  const { state, doc, rootId } = props
  const dialogs = useDialogs()
  const [editing, setEditing] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  editingRef.current = editing
  const pendingCaret = useRef<number | 'end' | 'start' | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  const propsRef = useRef(props)
  propsRef.current = props
  const rows = useMemo(() => flatten(doc, rootId, true), [doc, rootId])

  // Focus requests from outside (undo, map, search, structural edits).
  useEffect(() => {
    const f = state.focus
    if (f === null || doc.nodes[f.id] === undefined) return
    pendingCaret.current = f.caret
    setEditing(f.id)
    if (editingRef.current === f.id) placeCaret()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus])

  function placeCaret(): void {
    const el = inputRef.current
    if (el === null) return
    const want = pendingCaret.current
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    if (want !== null) {
      const pos = want === 'end' ? el.value.length : want === 'start' ? 0 : Math.min(want, el.value.length)
      el.setSelectionRange(pos, pos)
      pendingCaret.current = null
    }
    el.scrollIntoView({ block: 'nearest' })
  }

  useLayoutEffect(() => {
    const el = inputRef.current
    if (el !== null) { el.style.height = '0px'; el.style.height = el.scrollHeight + 'px' }
  })
  useLayoutEffect(() => { if (editing !== null) placeCaret() }, [editing])

  const ctl = useMemo<RowControl>(() => {
    const apply = (next: OutlineDoc, focus?: { id: string; caret: number | 'end' | 'start' }, key?: string): void => {
      propsRef.current.state.apply(next, { focus, key })
    }
    const nb = (id: string) => ops.neighbours(docRef.current, propsRef.current.rootId, id)
    const focusNode = (id: string | undefined, caret: number | 'end' | 'start'): void => {
      if (id === undefined) return
      pendingCaret.current = caret
      setEditing(id)
    }
    return {
      startEdit(id, caret) {
        pendingCaret.current = caret
        if (editingRef.current === id) placeCaret()
        setEditing(id)
      },
      toggleFold(id) {
        const d = docRef.current
        propsRef.current.state.apply(ops.setCollapsed(d, id, d.nodes[id]?.collapsed !== true), { noHistory: true })
      },
      toggleCheck(id) { apply(ops.toggleDone(docRef.current, id)) },
      zoom(id) { propsRef.current.onZoom(id) },
      bindInput(el) { inputRef.current = el },
      change(id, value, caret) {
        propsRef.current.state.setSelection({ nodeId: id, caret })
        apply(ops.setText(docRef.current, id, value), undefined, 'text:' + id)
      },
      select(id, caret) { propsRef.current.state.setSelection({ nodeId: id, caret }) },
      blur(id) {
        propsRef.current.state.breakMerge()
        // Defer: a keyboard move already switched editing to another node.
        window.setTimeout(() => { if (editingRef.current === id && document.activeElement !== inputRef.current) setEditing(null) }, 0)
      },
      key(e, id) {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
        if (mod && (k === 'b' || k === 'i')) {
          stop()
          const mark = k === 'b' ? '**' : '*'
          const next = val.slice(0, start) + mark + val.slice(start, end) + mark + val.slice(end)
          apply(ops.setText(d, id, next), { id, caret: end + mark.length * (start === end ? 1 : 2) })
          return
        }
        if (mod && k === '.') { stop(); apply(ops.setCollapsed(d, id, d.nodes[id]?.collapsed !== true), { id, caret: start }); return }
        if (k === 'Enter' && mod) { stop(); apply(ops.toggleDone(d, id), { id, caret: start }); return }
        if (k === 'Enter' && !e.shiftKey && !e.altKey) {
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
        if (k === 'Escape') { stop(); el.blur(); setEditing(null); return }
        if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
          stop()
          const next = ops.moveSibling(d, id, k === 'ArrowUp' ? -1 : 1)
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
        if (k === 'ArrowUp' && start === end && val.lastIndexOf('\n', start - 1) === -1) {
          const prev = nb(id).prev
          if (prev !== undefined) { stop(); const t = d.nodes[prev]!.text; const ls = t.lastIndexOf('\n') + 1; focusNode(prev, Math.min(ls + start, t.length)) }
          return
        }
        if (k === 'ArrowDown' && start === end && val.indexOf('\n', start) === -1) {
          const next = nb(id).next
          if (next !== undefined) { stop(); const col = start - (val.lastIndexOf('\n', start - 1) + 1); const t = d.nodes[next]!.text; const le = t.indexOf('\n'); focusNode(next, Math.min(col, le === -1 ? t.length : le)) }
          return
        }
        if (k === 'ArrowLeft' && start === 0 && end === 0) {
          const prev = nb(id).prev
          if (prev !== undefined) { stop(); focusNode(prev, 'end') }
          return
        }
        if (k === 'ArrowRight' && start === val.length && end === val.length) {
          const next = nb(id).next
          if (next !== undefined) { stop(); focusNode(next, 'start') }
        }
      },
      paste(e, id) {
        const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        if (!text.includes('\n')) return
        const items = parsePasted(text)
        if (items.length === 0 || (items.length === 1 && items[0]!.children.length === 0)) return
        e.preventDefault()
        const d = docRef.current
        const cur = d.nodes[id]!
        let r = ops.insertItems(d, items, { afterId: id })
        let out = r.doc
        if (cur.text.length === 0 && cur.children.length === 0) out = ops.deleteNode(out, id)
        r = { ...r, doc: out }
        apply(r.doc, { id: r.focusId, caret: 'end' })
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
          { kind: 'sep' },
          { label: '缩进', shortcut: 'Tab', onSelect: () => act(() => ops.indent(docRef.current, id)) },
          { label: '取消缩进', shortcut: 'Shift+Tab', onSelect: () => act(() => ops.outdent(docRef.current, id, p.rootId)) },
          { label: '上移', shortcut: 'Alt+↑', onSelect: () => act(() => ops.moveSibling(docRef.current, id, -1)) },
          { label: '下移', shortcut: 'Alt+↓', onSelect: () => act(() => ops.moveSibling(docRef.current, id, 1)) },
          { kind: 'sep' },
          { label: n.children.length === 0 ? '折叠（无子节点）' : n.collapsed === true ? '展开' : '折叠', shortcut: 'Ctrl+.', disabled: n.children.length === 0, onSelect: () => act(() => ops.setCollapsed(docRef.current, id, n.collapsed !== true)) },
          { label: typeof n.checked === 'boolean' ? '取消待办' : '设为待办', onSelect: () => act(() => ops.toggleChecklist(docRef.current, id)) },
          { label: n.checked === true ? '标记为未完成' : '标记为完成', shortcut: 'Ctrl+Enter', onSelect: () => act(() => ops.toggleDone(docRef.current, id)) },
          { label: '聚焦此节点', shortcut: 'Alt+→', onSelect: () => p.onZoom(id) },
          { kind: 'sep' },
          { label: '复制为 Markdown', onSelect: () => copy(toMarkdown({ ...d, nodes: { ...d.nodes, __copy: { id: '__copy', text: '', children: [id] } } }, '__copy', null), '已复制 Markdown（含子节点）') },
          { label: '复制文本', onSelect: () => copy(n.text, '已复制') },
          { kind: 'sep' },
          { label: n.children.length > 0 ? '删除节点及其子节点' : '删除节点', danger: true, onSelect: () => {
            const { prev, next } = nb(id)
            const after = ops.deleteNode(docRef.current, id)
            p.state.apply(after, prev !== undefined ? { focus: { id: prev, caret: 'end' } } : next !== undefined && after.nodes[next] !== undefined ? { focus: { id: next, caret: 0 } } : {})
            dialogs.toast('已删除，可按 Ctrl+Z 撤销')
          } },
        ] })
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
        setDrop(cur => (cur?.id === id && cur.pos === pos ? cur : { id, pos }))
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

  const addFirst = useCallback(() => {
    const r = ops.insertChild(docRef.current, propsRef.current.rootId, docRef.current.nodes[propsRef.current.rootId]?.children.length ?? 0)
    propsRef.current.state.apply(r.doc, { focus: { id: r.focusId, caret: 0 } })
  }, [])

  return (
    <div className="mm-outline" role="tree" aria-label="大纲" onDragLeave={e => { if (e.currentTarget === e.target) setDrop(null) }}>
      {rows.map(r => {
        const node = doc.nodes[r.id]!
        return <Row key={r.id} node={node} depth={r.depth} editing={editing === r.id} drop={drop?.id === r.id ? drop.pos : null} dragging={dragId === r.id} ctl={ctl} />
      })}
      {rows.length === 0 ? (
        <button type="button" className="mm-add" onClick={addFirst}><Icon name="plus" size={14} />添加节点</button>
      ) : (
        <div style={{ height: 40, cursor: 'text' }} onMouseDown={e => {
          e.preventDefault()
          const kids = doc.nodes[rootId]?.children ?? []
          const last = kids[kids.length - 1]
          if (last !== undefined && doc.nodes[last]!.text.length === 0 && doc.nodes[last]!.children.length === 0) ctl.startEdit(last, 'end')
          else addFirst()
        }} />
      )}
    </div>
  )
}
