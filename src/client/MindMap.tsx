/**
 * Mind-map (导图) view over the same document as the outline. Horizontal tree,
 * bezier connectors, collapse toggles, zoom (Ctrl+wheel / buttons), pan (drag
 * the background or wheel), fit / centre / 100 %. Nodes are edited in place
 * (double-click, F2 or typing) and every edit goes through the same ops and
 * history as the outline.
 * @module dsh-mindplan/client/MindMap
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { OutlineDoc } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import { canvasMeasure, edgePath, layoutMap, LINE_H, PAD_X, PAD_Y, type MapLayout } from './mapLayout.ts'
import type { DocumentState } from './useDocument.ts'
import { Icon, type MenuState } from './ui.tsx'

const MIN_K = 0.2
const MAX_K = 3

interface View { x: number; y: number; k: number }

export interface MindMapProps {
  state: DocumentState
  doc: OutlineDoc
  rootId: string
  rootLabel: string
  onMenu(menu: MenuState): void
  /** Switch to the outline with this node focused. */
  onEditInOutline(id: string): void
  /** Selected node, shared with the outline focus. */
  selected: string | null
  onSelect(id: string | null): void
}

const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k))

export function MindMap(props: MindMapProps): ReactNode {
  const { doc, rootId, state } = props
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 })
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null)
  const fitted = useRef<string | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const [font, setFont] = useState('')
  useLayoutEffect(() => { if (box.current !== null) setFont(getComputedStyle(box.current).fontFamily || 'sans-serif') }, [])
  const measure = useMemo(() => canvasMeasure(font || 'sans-serif'), [font])
  const layout: MapLayout = useMemo(() => layoutMap(doc, rootId, props.rootLabel, measure), [doc, rootId, props.rootLabel, measure])
  const selected = props.selected !== null && layout.byId.has(props.selected) ? props.selected : null

  const size = (): { w: number; h: number } => {
    const r = box.current?.getBoundingClientRect()
    return { w: r?.width ?? 800, h: r?.height ?? 600 }
  }
  const fit = useCallback(() => {
    const { w, h } = size()
    const k = clampK(Math.min((w - 80) / Math.max(layout.width + 40, 1), (h - 80) / Math.max(layout.height, 1), 1))
    setView({ k, x: (w - (layout.width + 20) * k) / 2, y: (h - layout.height * k) / 2 })
  }, [layout])
  const centerOn = useCallback((id: string, k = viewRef.current.k) => {
    const n = layout.byId.get(id)
    if (n === undefined) return
    const { w, h } = size()
    setView({ k, x: w / 2 - (n.x + n.w / 2) * k, y: h / 2 - (n.y + n.h / 2) * k })
  }, [layout])
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const v = viewRef.current
    const { w, h } = size()
    const px = cx ?? w / 2
    const py = cy ?? h / 2
    const k = clampK(v.k * factor)
    setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k })
  }, [])

  // Fit once per opened document / root.
  useLayoutEffect(() => {
    if (font === '') return
    const key = doc.id + ':' + rootId
    if (fitted.current !== key) { fitted.current = key; fit() }
  }, [doc.id, rootId, fit, font])

  // Keep the selected node in view after structural edits.
  useEffect(() => {
    if (selected === null) return
    const n = layout.byId.get(selected)!
    const v = viewRef.current
    const { w, h } = size()
    const sx = v.x + n.x * v.k
    const sy = v.y + n.y * v.k
    const m = 24
    let dx = 0
    let dy = 0
    if (sx < m) dx = m - sx
    else if (sx + n.w * v.k > w - m) dx = w - m - (sx + n.w * v.k)
    if (sy < m) dy = m - sy
    else if (sy + n.h * v.k > h - m) dy = h - m - (sy + n.h * v.k)
    if (dx !== 0 || dy !== 0) setView({ ...v, x: v.x + dx, y: v.y + dy })
  }, [selected, layout])

  // Native non-passive wheel listener (React's is passive).
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      else setView(v => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const commitEdit = useCallback((cur: { id: string; text: string } | null) => {
    setEditing(null)
    if (cur === null) return
    if (cur.id === rootId && rootId === doc.rootId) {
      if (cur.text.trim() !== doc.title) state.apply({ ...doc, title: cur.text.replace(/\n/g, ' ').trim() || doc.title })
    } else if (doc.nodes[cur.id] !== undefined && doc.nodes[cur.id]!.text !== cur.text) {
      state.apply(ops.setText(doc, cur.id, cur.text))
    }
    box.current?.focus({ preventScroll: true })
  }, [doc, rootId, state])

  const startEdit = (id: string, initial?: string): void => {
    const text = id === doc.rootId ? doc.title : doc.nodes[id]?.text ?? ''
    props.onSelect(id)
    setEditing({ id, text: initial ?? text })
  }

  const addChild = (id: string): void => {
    const n = doc.nodes[id]!
    const opened = ops.setCollapsed(doc, id, false)
    const r = ops.insertChild(opened, id, n.children.length)
    state.apply(r.doc)
    props.onSelect(r.focusId)
    setEditing({ id: r.focusId, text: '' })
  }
  const addSibling = (id: string): void => {
    if (id === rootId) { addChild(id); return }
    const r = ops.insertAfter(doc, id)
    state.apply(r.doc)
    props.onSelect(r.focusId)
    setEditing({ id: r.focusId, text: '' })
  }
  const remove = (id: string): void => {
    if (id === rootId) return
    const n = layout.byId.get(id)
    const parent = n?.parent ?? null
    const sibs = parent !== null ? doc.nodes[parent]!.children : []
    const i = sibs.indexOf(id)
    const nextSel = sibs[i + 1] ?? sibs[i - 1] ?? parent
    state.apply(ops.deleteNode(doc, id))
    props.onSelect(nextSel)
  }
  const toggle = (id: string): void => {
    const n = doc.nodes[id]
    if (n === undefined || n.children.length === 0 || id === rootId) return
    state.apply(ops.setCollapsed(doc, id, n.collapsed !== true), { noHistory: true })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (editing !== null || e.target !== e.currentTarget) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) state.redo(); else state.undo(); return }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); state.redo(); return }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(1.2); return }
    if (mod && k === '-') { e.preventDefault(); zoomAt(1 / 1.2); return }
    if (mod && k === '0') { e.preventDefault(); fit(); return }
    const sel = selected ?? rootId
    const n = layout.byId.get(sel)
    if (n === undefined) return
    if (k === 'Tab') { e.preventDefault(); addChild(sel); return }
    if (k === 'Enter') { e.preventDefault(); addSibling(sel); return }
    if (k === 'F2') { e.preventDefault(); startEdit(sel); return }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); remove(sel); return }
    if (k === ' ') { e.preventDefault(); toggle(sel); return }
    if (k === 'Escape') { props.onSelect(null); return }
    if (k === 'ArrowLeft') { e.preventDefault(); if (n.parent !== null) props.onSelect(n.parent); return }
    if (k === 'ArrowRight') {
      e.preventDefault()
      if (n.collapsed) { toggle(sel); return }
      const first = doc.nodes[sel]?.children.find(c => layout.byId.has(c))
      if (first !== undefined) props.onSelect(first)
      return
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault()
      // Nearest node above / below in screen space among the same depth, else any.
      const dir = k === 'ArrowUp' ? -1 : 1
      const cy = n.y + n.h / 2
      let best: string | null = null
      let bestScore = Infinity
      for (const o of layout.nodes) {
        if (o.id === sel) continue
        const oy = o.y + o.h / 2
        if ((oy - cy) * dir <= 0) continue
        const score = Math.abs(oy - cy) + Math.abs(o.x - n.x) * 2 + (o.depth === n.depth ? 0 : 400)
        if (score < bestScore) { bestScore = score; best = o.id }
      }
      if (best !== null) props.onSelect(best)
      return
    }
    if (!mod && !e.altKey && k.length === 1 && sel !== rootId) { e.preventDefault(); startEdit(sel, k) }
  }

  const menuFor = (id: string, x: number, y: number): void => {
    props.onSelect(id)
    const n = doc.nodes[id]!
    const isRoot = id === rootId
    props.onMenu({ x, y, items: [
      { label: '编辑', shortcut: 'F2', onSelect: () => startEdit(id) },
      { label: '添加子节点', shortcut: 'Tab', onSelect: () => addChild(id) },
      { label: '添加同级节点', shortcut: 'Enter', disabled: isRoot, onSelect: () => addSibling(id) },
      { label: n.collapsed === true ? '展开' : '折叠', shortcut: '空格', disabled: isRoot || n.children.length === 0, onSelect: () => toggle(id) },
      { label: '在大纲中编辑', disabled: isRoot && rootId === doc.rootId, onSelect: () => props.onEditInOutline(id) },
      { label: '以此为中心', onSelect: () => centerOn(id) },
      { kind: 'sep' },
      { label: n.children.length > 0 ? '删除节点及其子节点' : '删除节点', shortcut: 'Delete', danger: true, disabled: isRoot, onSelect: () => remove(id) },
    ] })
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as Element).closest('[data-map-node],.mm-map-ctrl,.mm-map-edit') !== null) return
    drag.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    if (d !== null && !d.moved) props.onSelect(null)
  }

  const editNode = editing !== null ? layout.byId.get(editing.id) : undefined
  return (
    <div ref={box} className={'mm-map' + (panning ? ' mm-panning' : '')} tabIndex={0} role="application" aria-label="思维导图"
      onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onContextMenu={e => { if ((e.target as Element).closest('[data-map-node]') === null) e.preventDefault() }}>
      <svg>
        <g transform={'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'}>
          {layout.nodes.map(n => (n.parent === null ? null : <path key={'e' + n.id} className="mm-map-edge" d={edgePath(layout.byId.get(n.parent)!, n)} />))}
          {layout.nodes.map(n => {
            const cls = 'mm-map-node' + (n.depth === 0 ? ' mm-root' : n.depth === 1 ? ' mm-depth1' : '') + (n.done ? ' mm-done' : '') + (selected === n.id ? ' mm-sel' : '')
            return (
              <g key={n.id} className={cls} data-map-node={n.id}
                onMouseDown={e => { if (e.button === 0) { e.stopPropagation(); props.onSelect(n.id); box.current?.focus({ preventScroll: true }) } }}
                onDoubleClick={e => { e.stopPropagation(); startEdit(n.id) }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); menuFor(n.id, e.clientX, e.clientY) }}>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} />
                {editing?.id === n.id ? null : n.lines.map((line, i) => (
                  <text key={i} x={n.x + PAD_X} y={n.y + PAD_Y + LINE_H * i + LINE_H / 2} xmlSpace="preserve">{line}</text>
                ))}
              </g>
            )
          })}
          {layout.nodes.map(n => (n.depth === 0 || !n.hasKids ? null : (
            <g key={'t' + n.id} className="mm-map-toggle" data-map-node={n.id} role="button" aria-label={n.collapsed ? '展开' : '折叠'}
              onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); toggle(n.id) }}>
              <circle cx={n.x + n.w + 10} cy={n.y + n.h / 2} r={8} />
              <text x={n.x + n.w + 10} y={n.y + n.h / 2}>{n.collapsed ? (n.hidden > 99 ? '99+' : String(n.hidden)) : '−'}</text>
            </g>
          )))}
        </g>
      </svg>
      {editing !== null && editNode !== undefined ? (
        <MapEditor key={editing.id} value={editing.text}
          left={view.x + editNode.x * view.k} top={view.y + editNode.y * view.k} width={Math.max(editNode.w, 160)} scale={view.k}
          onChange={text => setEditing({ id: editing.id, text })}
          onCommit={() => commitEdit(editing)}
          onCancel={() => { setEditing(null); box.current?.focus({ preventScroll: true }) }}
          onTab={() => {
            // Commit the text and add a child in one undo step.
            const id = editing.id
            let d = doc
            if (id === doc.rootId) d = { ...doc, title: editing.text.replace(/\n/g, ' ').trim() || doc.title }
            else if (doc.nodes[id] !== undefined) d = ops.setText(doc, id, editing.text)
            const r = ops.insertChild(ops.setCollapsed(d, id, false), id, d.nodes[id]!.children.length)
            state.apply(r.doc)
            props.onSelect(r.focusId)
            setEditing({ id: r.focusId, text: '' })
          }} />
      ) : null}
      <div className="mm-map-hint mm-hide-narrow">双击编辑 · Tab 子节点 · Enter 同级 · 空格折叠 · 拖动画布平移 · Ctrl+滚轮缩放</div>
      <div className="mm-map-ctrl" onPointerDown={e => e.stopPropagation()}>
        <button type="button" className="mm-icon-btn" title="缩小" aria-label="缩小" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" /></button>
        <span aria-live="polite">{Math.round(view.k * 100)}%</span>
        <button type="button" className="mm-icon-btn" title="放大" aria-label="放大" onClick={() => zoomAt(1.2)}><Icon name="plus" /></button>
        <button type="button" className="mm-btn" style={{ height: 26, padding: '0 8px', border: 0 }} title="实际大小" onClick={() => centerOn(selected ?? rootId, 1)}>100%</button>
        <button type="button" className="mm-icon-btn" title="适应窗口" aria-label="适应窗口" onClick={fit}><Icon name="fit" /></button>
        <button type="button" className="mm-icon-btn" title="居中" aria-label="居中" onClick={() => centerOn(selected ?? rootId)}><Icon name="center" /></button>
      </div>
    </div>
  )
}

function MapEditor(props: { value: string; left: number; top: number; width: number; scale: number; onChange(text: string): void; onCommit(): void; onCancel(): void; onTab(): void }): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    if (end > 1) el.select(); else el.setSelectionRange(end, end)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el !== null) { el.style.height = '0px'; el.style.height = el.scrollHeight + 'px' }
  })
  const finish = (fn: () => void): void => { if (done.current) return; done.current = true; fn() }
  return (
    <textarea ref={ref} className="mm-map-edit" rows={1} value={props.value} spellCheck={false} aria-label="编辑节点"
      style={{ left: props.left, top: props.top, width: props.width, transform: 'scale(' + props.scale + ')' }}
      onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
      onChange={e => props.onChange(e.target.value)}
      onBlur={() => finish(props.onCommit)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(props.onCommit) }
        else if (e.key === 'Escape') { e.preventDefault(); finish(props.onCancel) }
        else if (e.key === 'Tab') { e.preventDefault(); finish(props.onTab) }
      }} />
  )
}
