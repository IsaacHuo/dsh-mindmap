/**
 * Mind-map (导图) view over the same document as the outline. Two layouts
 * (两侧 balanced / 向右), branch colours, tapered depth-1 edges, collapse
 * badges, keyboard editing, drag to reparent / reorder, zoom (Ctrl+wheel /
 * buttons) and pan (drag the background or wheel). Every edit goes through
 * the same ops and history as the outline.
 *
 * Performance: pan / zoom never re-render React — the view lives in a ref and
 * a requestAnimationFrame writes the <g transform> directly. The node layer is
 * memoised on (layout, cull rect, editing id) and culls nodes outside an
 * enlarged viewport; selection and drag feedback are separate small overlays.
 * @module dsh-mindmap/client/MindMap
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { OutlineDoc } from '../shared/model.ts'
import * as ops from '../shared/ops.ts'
import {
  canvasMeasure, CHECK_W, checkPos, docMapLayout, edgeFor, FONT_SIZE, GAP_Y, layoutMap, MAX_TEXT_W, PAD_X, PAD_Y, ROOT_FONT_SIZE, STUB, textPos, tickPath, togglePos, TOGGLE_R,
  type MapLayout, type Measure, type MapLayoutMode, type MapNode, type Side,
} from './mapLayout.ts'
import type { DocumentState } from './useDocument.ts'
import { Icon, withSep, type MenuEntry, type MenuState } from './ui.tsx'

const MIN_K = 0.2
const MAX_K = 3
/** Initial fit-to-width never zooms out below this. */
const FIT_MIN_K = 0.5
/** Docs bigger than this open with everything below depth 2 collapsed (view-only). */
const AUTO_COLLAPSE_NODES = 300
const AUTO_COLLAPSE_DEPTH = 2
const DRAG_THRESHOLD = 5
const HINT_KEY = 'dsh-mindmap:map-hint-seen'

interface View { x: number; y: number; k: number }
interface Rect { x0: number; y0: number; x1: number; y1: number }
interface DropView { id: string; target: string | null; pos: ops.DropPosition; ok: boolean; mx: number; my: number }
type ViewDoc = OutlineDoc & { view?: { mapLayout?: MapLayoutMode } & Record<string, unknown> }

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
  /** Extra node-menu entries (AI review, sessions, references), shown before delete. */
  extraMenu?(id: string): MenuEntry[]
}

const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k))
const tf = (v: View): string => 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')'
const hits = (x0: number, y0: number, x1: number, y1: number, r: Rect): boolean => x1 >= r.x0 && x0 <= r.x1 && y1 >= r.y0 && y0 <= r.y1
const branchCls = (n: MapNode): string => (n.branch >= 0 ? ' mm-b' + (n.branch % 8) : '')

/** View-only collapse set for big docs: every node at depth ≥ 2 that has children. */
function autoCollapse(doc: OutlineDoc, rootId: string): ReadonlySet<string> {
  const out = new Set<string>()
  let count = 0
  const probe = [rootId]
  while (probe.length > 0 && count <= AUTO_COLLAPSE_NODES) {
    const n = doc.nodes[probe.pop()!]
    if (n === undefined) continue
    count++
    for (const c of n.children) probe.push(c)
  }
  if (count <= AUTO_COLLAPSE_NODES) return out
  const stack: Array<[string, number]> = [[rootId, 0]]
  while (stack.length > 0) {
    const [id, depth] = stack.pop()!
    const n = doc.nodes[id]
    if (n === undefined || n.children.length === 0) continue
    if (depth >= AUTO_COLLAPSE_DEPTH) { if (n.collapsed !== true) out.add(id); continue }
    if (n.collapsed === true && depth > 0) continue
    for (const c of n.children) stack.push([c, depth + 1])
  }
  return out
}

function readHintSeen(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false }
}

export function MindMap(props: MindMapProps): ReactNode {
  const { doc, rootId, state } = props
  const select = props.onSelect
  const box = useRef<HTMLDivElement>(null)
  const gRef = useRef<SVGGElement>(null)
  const zoomRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const viewRef = useRef<View>({ x: 40, y: 40, k: 1 })
  const sizeRef = useRef({ w: 800, h: 600 })
  const raf = useRef(0)
  const [cull, setCull] = useState<Rect | null>(null)
  const cullRef = useRef<Rect | null>(cull)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  /** Live box of the in-place editor (map units); the node is drawn at this size while editing. */
  const [editBox, setEditBox] = useState<EditBox | null>(null)
  const [panning, setPanning] = useState(false)
  const pan = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null)
  const nodeDrag = useRef<{ id: string; px: number; py: number; started: boolean } | null>(null)
  const [drop, setDrop] = useState<DropView | null>(null)
  const dropRef = useRef<DropView | null>(null)
  /** Node just created by Tab/Enter: dropped again (via undo) if left empty. */
  const fresh = useRef<{ id: string; doc: OutlineDoc; prevSel: string | null } | null>(null)
  const fitted = useRef<string | null>(null)
  const needFit = useRef(false)
  const anchor = useRef<{ key: string; x: number; y: number } | null>(null)
  const [hintSeen, setHintSeen] = useState(readHintSeen)
  const [font, setFont] = useState('')
  useLayoutEffect(() => { if (box.current !== null) setFont(getComputedStyle(box.current).fontFamily || 'sans-serif') }, [])
  const measure = useMemo(() => canvasMeasure(font || 'sans-serif'), [font])
  const mode = docMapLayout(doc)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const viewKey = doc.id + ':' + rootId

  // View-only collapse override, recomputed once per opened document / root.
  const ovRef = useRef<{ key: string; set: ReadonlySet<string> }>({ key: '', set: new Set() })
  if (ovRef.current.key !== viewKey) ovRef.current = { key: viewKey, set: autoCollapse(doc, rootId) }
  const [, setOvTick] = useState(0)
  const override = ovRef.current.set
  const setOverride = (s: ReadonlySet<string>): void => { ovRef.current = { key: viewKey, set: s }; setOvTick(t => t + 1) }

  const layout: MapLayout = useMemo(
    () => layoutMap(doc, rootId, props.rootLabel, measure, { layout: mode, collapsedOverride: override }),
    [doc, rootId, props.rootLabel, measure, mode, override],
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const selected = props.selected !== null && layout.byId.has(props.selected) ? props.selected : null

  // ---------- view (ref + rAF, no React render per frame) ----------
  const applyView = useCallback(() => {
    const v = viewRef.current
    gRef.current?.setAttribute('transform', tf(v))
    if (zoomRef.current !== null) zoomRef.current.textContent = Math.round(v.k * 100) + '%'
    const ed = editorRef.current
    if (ed !== null && ed.dataset.nx !== undefined) {
      ed.style.left = v.x + Number(ed.dataset.nx) * v.k + 'px'
      ed.style.top = v.y + Number(ed.dataset.ny) * v.k + 'px'
      ed.style.transform = 'scale(' + v.k + ')'
    }
    const { w, h } = sizeRef.current
    const vr: Rect = { x0: -v.x / v.k, y0: -v.y / v.k, x1: (w - v.x) / v.k, y1: (h - v.y) / v.k }
    const c = cullRef.current
    const vArea = (vr.x1 - vr.x0) * (vr.y1 - vr.y0)
    const stale = c === null || vr.x0 < c.x0 || vr.y0 < c.y0 || vr.x1 > c.x1 || vr.y1 > c.y1 || (c.x1 - c.x0) * (c.y1 - c.y0) > vArea * 9
    if (stale) {
      const mx = (vr.x1 - vr.x0) * 0.5 + 120 / v.k
      const my = (vr.y1 - vr.y0) * 0.5 + 120 / v.k
      const next = { x0: vr.x0 - mx, y0: vr.y0 - my, x1: vr.x1 + mx, y1: vr.y1 + my }
      cullRef.current = next
      setCull(next)
    }
  }, [])
  const scheduleView = useCallback((v: View) => {
    viewRef.current = v
    if (raf.current === 0) raf.current = requestAnimationFrame(() => { raf.current = 0; applyView() })
  }, [applyView])
  const setViewNow = useCallback((v: View) => { viewRef.current = v; applyView() }, [applyView])
  useEffect(() => () => { if (raf.current !== 0) cancelAnimationFrame(raf.current) }, [])

  useLayoutEffect(() => {
    const el = box.current
    if (el === null) return
    const read = (): void => { const r = el.getBoundingClientRect(); sizeRef.current = { w: r.width || 800, h: r.height || 600 } }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { read(); applyView() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [applyView])

  const fitWidth = useCallback(() => {
    const L = layoutRef.current
    const root = L.nodes[0]
    const { w, h } = sizeRef.current
    const k = clampK(Math.max(FIT_MIN_K, Math.min(1, (w - 80) / Math.max(L.width, 1))))
    const x = L.width * k <= w - 80 || root === undefined ? (w - L.width * k) / 2
      // 向右: everything grows rightwards, so start at the left edge rather than centring the root.
      : modeRef.current === 'right' ? 40 - root.x * k
      : w / 2 - (root.x + root.w / 2) * k
    const y = L.height * k <= h - 80 || root === undefined ? (h - L.height * k) / 2 : h / 2 - (root.y + root.h / 2) * k
    setViewNow({ k, x, y })
  }, [setViewNow])
  const fitAll = useCallback(() => {
    const L = layoutRef.current
    const { w, h } = sizeRef.current
    const k = clampK(Math.min((w - 80) / Math.max(L.width, 1), (h - 80) / Math.max(L.height, 1), 1))
    scheduleView({ k, x: (w - L.width * k) / 2, y: (h - L.height * k) / 2 })
  }, [scheduleView])
  const centerOn = useCallback((id: string, k = viewRef.current.k) => {
    const n = layoutRef.current.byId.get(id)
    if (n === undefined) return
    const { w, h } = sizeRef.current
    scheduleView({ k, x: w / 2 - (n.x + n.w / 2) * k, y: h / 2 - (n.y + n.h / 2) * k })
  }, [scheduleView])
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const v = viewRef.current
    const { w, h } = sizeRef.current
    const px = cx ?? w / 2
    const py = cy ?? h / 2
    const k = clampK(v.k * factor)
    scheduleView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k })
  }, [scheduleView])

  // Fit once per opened document / root (and after a layout switch); otherwise
  // keep the root fixed on screen while the layout reflows around it.
  useLayoutEffect(() => {
    if (font === '') return
    const root = layout.byId.get(rootId)
    if (fitted.current !== viewKey || needFit.current) {
      fitted.current = viewKey
      needFit.current = false
      fitWidth()
    } else if (root !== undefined && anchor.current !== null && anchor.current.key === viewKey) {
      const v = viewRef.current
      const dx = (root.x - anchor.current.x) * v.k
      const dy = (root.y - anchor.current.y) * v.k
      if (dx !== 0 || dy !== 0) setViewNow({ ...v, x: v.x - dx, y: v.y - dy })
      else applyView()
    }
    if (root !== undefined) anchor.current = { key: viewKey, x: root.x, y: root.y }
  }, [layout, viewKey, rootId, font, fitWidth, setViewNow, applyView])

  // Bring a newly selected node into view (not on every relayout: that would
  // fight the user panning away while something stays selected).
  const shownSel = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (selected === shownSel.current) return
    shownSel.current = selected
    if (selected === null) return
    const n = layout.byId.get(selected)!
    const v = viewRef.current
    const { w, h } = sizeRef.current
    const sx = v.x + n.x * v.k
    const sy = v.y + n.y * v.k
    const m = 24
    let dx = 0
    let dy = 0
    if (n.w * v.k > w - 2 * m || sx < m) dx = m - sx
    else if (sx + n.w * v.k > w - m) dx = w - m - (sx + n.w * v.k)
    if (n.h * v.k > h - 2 * m || sy < m) dy = m - sy
    else if (sy + n.h * v.k > h - m) dy = h - m - (sy + n.h * v.k)
    if (dx !== 0 || dy !== 0) scheduleView({ ...v, x: v.x + dx, y: v.y + dy })
  }, [selected, layout, scheduleView])

  // Native non-passive wheel listener (React's is passive).
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // Firefox reports lines (1) or pages (2) for mouse wheels; normalise to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sizeRef.current.h : 1
      const dx = e.deltaX * unit
      const dy = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-dy * 0.0025), e.clientX - r.left, e.clientY - r.top)
      else {
        const v = viewRef.current
        scheduleView({ ...v, x: v.x - (e.shiftKey ? dy : dx), y: v.y - (e.shiftKey ? 0 : dy) })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, scheduleView])

  const markSeen = (): void => {
    if (hintSeen) return
    setHintSeen(true)
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* storage unavailable */ }
  }
  const refocus = (): void => { box.current?.focus({ preventScroll: true }) }
  const clearSelection = (): void => { const s = window.getSelection(); if (s !== null && !s.isCollapsed) s.removeAllRanges() }

  // ---------- edits ----------
  const dropFresh = (): void => {
    const f = fresh.current
    fresh.current = null
    if (f === null) return
    if (doc === f.doc) state.undo()
    else if (doc.nodes[f.id] !== undefined) state.apply(ops.deleteNode(doc, f.id))
    select(f.prevSel !== null && f.prevSel !== f.id ? f.prevSel : null)
  }

  /** `back` = return focus to the map (false when focus moved elsewhere on purpose). */
  const commitEdit = (cur: { id: string; text: string } | null, back = true): void => {
    setEditing(null)
    if (cur === null) return
    const focusMap = back ? refocus : () => {}
    const f = fresh.current
    if (f !== null && f.id === cur.id) {
      if (cur.text.trim() === '') { dropFresh(); focusMap(); return }
      fresh.current = null
    }
    if (cur.id === rootId && rootId === doc.rootId) {
      if (cur.text.trim() !== doc.title) state.apply({ ...doc, title: cur.text.replace(/\n/g, ' ').trim() || doc.title })
    } else if (doc.nodes[cur.id] !== undefined && doc.nodes[cur.id]!.text !== cur.text) {
      state.apply(ops.setText(doc, cur.id, cur.text))
    }
    focusMap()
  }
  const cancelEdit = (): void => {
    const cur = editing
    setEditing(null)
    if (cur !== null && fresh.current !== null && fresh.current.id === cur.id) dropFresh()
    refocus()
  }

  const startEdit = (id: string, initial?: string): void => {
    const text = id === doc.rootId ? doc.title : doc.nodes[id]?.text ?? ''
    select(id)
    setEditing({ id, text: initial ?? text })
  }

  /** Expand a node (doc and view-only override) inside d. */
  const expandIn = (d: OutlineDoc, id: string): OutlineDoc => {
    if (override.has(id)) { const s = new Set(override); s.delete(id); setOverride(s) }
    return d.nodes[id]?.collapsed === true ? ops.setCollapsed(d, id, false) : d
  }
  const created = (r: ops.EditResult, prevSel: string | null): void => {
    state.apply(r.doc)
    fresh.current = { id: r.focusId, doc: r.doc, prevSel }
    select(r.focusId)
    setEditing({ id: r.focusId, text: '' })
  }
  /** Drop view-only collapse overrides of ids (a node just moved into them must be visible). */
  const unhide = (ids: (string | undefined)[]): void => {
    const hit = ids.filter((i): i is string => i !== undefined && override.has(i))
    if (hit.length === 0) return
    const s = new Set(override)
    for (const i of hit) s.delete(i)
    setOverride(s)
  }
  const parentIn = (d: OutlineDoc, id: string): string | undefined => {
    for (const n of Object.values(d.nodes)) if (n.children.includes(id)) return n.id
    return undefined
  }
  const addChildIn = (d: OutlineDoc, id: string): void => {
    const opened = expandIn(d, id)
    created(ops.insertChild(opened, id, opened.nodes[id]!.children.length), id)
  }
  const addSibling = (id: string): void => {
    if (id === rootId) { addChildIn(doc, id); return }
    created(ops.insertAfter(doc, id), id)
  }
  const remove = (id: string): void => {
    if (id === rootId) return
    const parent = layout.byId.get(id)?.parent ?? null
    const sibs = parent !== null ? layout.byId.get(parent)!.kids : []
    const i = sibs.indexOf(id)
    const nextSel = sibs[i + 1] ?? sibs[i - 1] ?? parent
    state.apply(ops.deleteNode(doc, id))
    select(nextSel)
  }
  const toggle = (id: string): void => {
    const n = doc.nodes[id]
    if (n === undefined || n.children.length === 0 || id === rootId) return
    if (override.has(id)) {
      const s = new Set(override)
      s.delete(id)
      setOverride(s)
      if (n.collapsed === true) state.apply(ops.setCollapsed(doc, id, false), { noHistory: true })
      return
    }
    state.apply(ops.setCollapsed(doc, id, n.collapsed !== true), { noHistory: true })
  }
  const outdent = (id: string): void => {
    if (id === rootId) return
    const next = ops.outdent(doc, id, rootId)
    if (next !== doc) state.apply(next)
  }
  const moveSibling = (id: string, delta: -1 | 1): void => {
    if (id === rootId) return
    // Floor at the zoomed root: never move a node out of the zoomed subtree.
    const next = ops.moveSibling(doc, id, delta, rootId)
    if (next !== doc) { unhide([parentIn(next, id)]); state.apply(next) }
  }
  const toggleDone = (id: string): void => {
    if (id === doc.rootId || doc.nodes[id] === undefined) return
    state.apply(ops.toggleDone(doc, id))
  }
  const setMode = (m: MapLayoutMode): void => {
    if (m === mode) return
    needFit.current = true
    const vd = doc as ViewDoc
    state.apply({ ...vd, view: { ...(vd.view ?? {}), mapLayout: m } } as OutlineDoc, { noHistory: true })
  }

  // ---------- keyboard navigation by visual position ----------
  const nearestKid = (n: MapNode, side: Side | null): string | null => {
    const cy = n.y + n.h / 2
    let best: string | null = null
    let bd = Infinity
    for (const c of n.kids) {
      const m = layout.byId.get(c)
      if (m === undefined || (side !== null && m.side !== side)) continue
      const d = Math.abs(m.y + m.h / 2 - cy)
      if (d < bd) { bd = d; best = c }
    }
    return best
  }
  const vertical = (n: MapNode, dir: -1 | 1): string | null => {
    if (n.parent !== null) {
      const sibs = layout.byId.get(n.parent)!.kids.filter(c => layout.byId.get(c)?.side === n.side)
      const t = sibs[sibs.indexOf(n.id) + dir]
      if (t !== undefined) return t
    }
    const cy = n.y + n.h / 2
    const cx = n.side > 0 ? n.x : n.x + n.w
    let best: string | null = null
    let bestScore = Infinity
    for (const o of layout.nodes) {
      if (o.id === n.id || (n.depth > 0 && o.depth > 0 && o.side !== n.side)) continue
      const dy = (o.y + o.h / 2 - cy) * dir
      if (dy <= 0) continue
      const ox = o.side > 0 ? o.x : o.x + o.w
      const score = dy + Math.abs(ox - cx) * 2 + Math.abs(o.depth - n.depth) * 200
      if (score < bestScore) { bestScore = score; best = o.id }
    }
    return best
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    markSeen()
    if (e.key === 'Escape' && nodeDrag.current !== null) { e.preventDefault(); nodeDrag.current = null; setDropBoth(null); return }
    if (editing !== null || e.target !== e.currentTarget) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      // An IME starts composing on a selected node: open the editor so the text lands there.
      if (!e.nativeEvent.isComposing && selected !== null && selected !== rootId) startEdit(selected, '')
      return
    }
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) state.redo(); else state.undo(); return }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); state.redo(); return }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(1.2); return }
    if (mod && k === '-') { e.preventDefault(); zoomAt(1 / 1.2); return }
    if (mod && k === '0') { e.preventDefault(); fitAll(); return }
    const sel = selected ?? rootId
    const n = layout.byId.get(sel)
    if (n === undefined) return
    if (mod && k === 'ArrowUp') { e.preventDefault(); moveSibling(sel, -1); return }
    if (mod && k === 'ArrowDown') { e.preventDefault(); moveSibling(sel, 1); return }
    if (mod && k === 'Enter') { e.preventDefault(); toggleDone(sel); return }
    if (k === 'Tab' && e.shiftKey) { e.preventDefault(); outdent(sel); return }
    if (k === 'Tab') { e.preventDefault(); addChildIn(doc, sel); return }
    if (k === 'Enter') { e.preventDefault(); addSibling(sel); return }
    if (k === 'F2') { e.preventDefault(); startEdit(sel); return }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); remove(sel); return }
    if (k === ' ') { e.preventDefault(); toggle(sel); return }
    if (k === 'Escape') { select(null); return }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault()
      const dirX: Side = k === 'ArrowRight' ? 1 : -1
      if (n.depth === 0) { const t = nearestKid(n, dirX); if (t !== null) select(t); return }
      if (dirX === n.side) {
        if (n.collapsed) { toggle(sel); return }
        const t = nearestKid(n, null)
        if (t !== null) select(t)
      } else if (n.parent !== null) select(n.parent)
      return
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault()
      const t = vertical(n, k === 'ArrowUp' ? -1 : 1)
      if (t !== null) select(t)
      return
    }
    if (!mod && !e.altKey && k.length === 1 && sel !== rootId) { e.preventDefault(); startEdit(sel, k) }
  }

  const menuFor = (id: string, x: number, y: number): void => {
    select(id)
    const n = doc.nodes[id]!
    const isRoot = id === rootId
    props.onMenu({ x, y, items: [
      { label: '编辑', shortcut: 'F2', onSelect: () => startEdit(id) },
      { label: '添加子节点', shortcut: 'Tab', onSelect: () => addChildIn(doc, id) },
      { label: '添加同级节点', shortcut: 'Enter', disabled: isRoot, onSelect: () => addSibling(id) },
      { label: n.checked === true ? '取消完成' : '标记完成', shortcut: 'Ctrl+Enter', disabled: id === doc.rootId, onSelect: () => toggleDone(id) },
      { label: n.collapsed === true || override.has(id) ? '展开' : '折叠', shortcut: '空格', disabled: isRoot || n.children.length === 0, onSelect: () => toggle(id) },
      { label: '在大纲中编辑', disabled: isRoot && rootId === doc.rootId, onSelect: () => props.onEditInOutline(id) },
      { label: '以此为中心', onSelect: () => centerOn(id) },
      ...withSep(props.extraMenu?.(id) ?? []),
      { kind: 'sep' },
      { label: n.children.length > 0 ? '删除节点及其子节点' : '删除节点', shortcut: 'Delete', danger: true, disabled: isRoot, onSelect: () => remove(id) },
    ] })
  }

  // ---------- pointer: pan, node drag ----------
  const toMap = (cx: number, cy: number): { x: number; y: number } => {
    const r = box.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k }
  }
  const hitNode = (x: number, y: number): MapNode | null => {
    const ns = layout.nodes
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!
      if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n
    }
    return null
  }
  const setDropBoth = (d: DropView | null): void => { dropRef.current = d; setDrop(d) }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    markSeen()
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('.mm-map-ctrl,.mm-map-edit,.mm-map-hint,[data-map-toggle]') !== null) return
    const nodeEl = t.closest('[data-map-node]')
    if (nodeEl !== null) {
      const id = nodeEl.getAttribute('data-map-node')!
      if (id !== rootId && editing === null) nodeDrag.current = { id, px: e.clientX, py: e.clientY, started: false }
      return
    }
    // Cancel the default so the press cannot begin a text selection; focus by hand.
    e.preventDefault()
    clearSelection()
    refocus()
    const v = viewRef.current
    pan.current = { px: e.clientX, py: e.clientY, vx: v.x, vy: v.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const nd = nodeDrag.current
    if (nd !== null && e.buttons === 0) { nodeDrag.current = null; setDropBoth(null); return }
    if (nd !== null) {
      if (!nd.started) {
        if (Math.abs(e.clientX - nd.px) + Math.abs(e.clientY - nd.py) < DRAG_THRESHOLD) return
        nd.started = true
        clearSelection()
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const p = toMap(e.clientX, e.clientY)
      const hit = hitNode(p.x, p.y)
      if (hit === null || hit.id === nd.id) { setDropBoth({ id: nd.id, target: null, pos: 'inside', ok: false, mx: p.x, my: p.y }); return }
      const rel = (p.y - hit.y) / hit.h
      const pos: ops.DropPosition = hit.depth === 0 ? 'inside' : rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'inside'
      setDropBoth({ id: nd.id, target: hit.id, pos, ok: ops.canMove(doc, nd.id, hit.id, pos), mx: p.x, my: p.y })
      return
    }
    const d = pan.current
    if (d === null) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    scheduleView({ ...viewRef.current, x: d.vx + dx, y: d.vy + dy })
  }
  const onPointerUp = (): void => {
    const nd = nodeDrag.current
    if (nd !== null) {
      nodeDrag.current = null
      const d = dropRef.current
      setDropBoth(null)
      if (nd.started && d !== null && d.ok && d.target !== null) {
        const next = ops.moveNode(doc, nd.id, d.target, d.pos)
        if (next !== doc) { unhide([d.pos === 'inside' ? d.target : undefined, parentIn(next, nd.id)]); state.apply(next); select(nd.id) }
      }
      return
    }
    const d = pan.current
    pan.current = null
    setPanning(false)
    if (d !== null && !d.moved) select(null)
  }

  // ---------- delegated node events ----------
  const nodeOf = (e: ReactMouseEvent): { id: string; toggle: boolean } | null => {
    const t = e.target as Element
    const tg = t.closest('[data-map-toggle]')
    if (tg !== null) return { id: tg.getAttribute('data-map-toggle')!, toggle: true }
    const el = t.closest('[data-map-node]')
    return el !== null ? { id: el.getAttribute('data-map-node')!, toggle: false } : null
  }
  const svgHandlers = {
    onMouseDown: (e: ReactMouseEvent) => {
      const hit = nodeOf(e)
      if (hit === null || e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      if (!hit.toggle) { select(hit.id); refocus() }
    },
    onClick: (e: ReactMouseEvent) => { const hit = nodeOf(e); if (hit?.toggle === true) { e.stopPropagation(); toggle(hit.id); refocus() } },
    onDoubleClick: (e: ReactMouseEvent) => { const hit = nodeOf(e); if (hit !== null && !hit.toggle) { e.stopPropagation(); startEdit(hit.id) } },
    onContextMenu: (e: ReactMouseEvent) => { const hit = nodeOf(e); if (hit !== null) { e.preventDefault(); e.stopPropagation(); menuFor(hit.id, e.clientX, e.clientY) } },
  }

  const editNode = editing !== null ? layout.byId.get(editing.id) : undefined
  const selNode = selected !== null ? layout.byId.get(selected) : undefined
  const v = viewRef.current
  return (
    <div ref={box} className={'mm-map' + (panning ? ' mm-panning' : '') + (drop !== null ? ' mm-dragging' : '')} tabIndex={0} role="application" aria-label="思维导图"
      onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onContextMenu={e => { if ((e.target as Element).closest('[data-map-node]') === null) e.preventDefault() }}>
      <svg {...svgHandlers}>
        <g ref={gRef} transform={tf(v)}>
          <NodeLayer layout={layout} cull={cull} editingId={editing?.id ?? null} />
          {editNode !== undefined && editBox !== null && editBox.id === editNode.id ? <EditBackdrop n={editNode} box={editBox} />
            : selNode !== undefined && editing === null ? <SelectionRing n={selNode} /> : null}
          {drop !== null ? <DropOverlay drop={drop} layout={layout} /> : null}
        </g>
      </svg>
      {editing !== null && editNode !== undefined ? (
        <MapEditor key={editing.id} value={editing.text} elRef={editorRef} n={editNode} view={v} measure={measure}
          onBox={setEditBox}
          onChange={text => setEditing({ id: editing.id, text })}
          onCommit={back => commitEdit(editing, back)}
          onCancel={cancelEdit}
          onTab={() => {
            // Commit the text (own undo step), then add a child (own step).
            const id = editing.id
            setEditing(null)
            let d = doc
            if (fresh.current !== null && fresh.current.id === id) fresh.current = null
            if (id === doc.rootId) d = { ...doc, title: editing.text.replace(/\n/g, ' ').trim() || doc.title }
            else if (doc.nodes[id] !== undefined && doc.nodes[id]!.text !== editing.text) d = ops.setText(doc, id, editing.text)
            if (d !== doc) state.apply(d)
            addChildIn(d, id)
          }} />
      ) : null}
      {!hintSeen ? <div className="mm-map-hint mm-hide-narrow">双击编辑 · Tab 子节点 · Enter 同级 · 空格折叠 · 拖动节点改层级 · 拖动画布平移 · Ctrl+滚轮缩放</div> : null}
      <div className="mm-map-ctrl" onPointerDown={e => e.stopPropagation()}>
        <div className="mm-map-seg" role="group" aria-label="导图布局">
          <button type="button" aria-pressed={mode === 'right'} title="分支全部向右展开" onClick={() => setMode('right')}>向右</button>
          <button type="button" aria-pressed={mode === 'both'} title="分支分布在中心两侧" onClick={() => setMode('both')}>两侧</button>
        </div>
        <button type="button" className="mm-icon-btn" title="缩小" aria-label="缩小" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" /></button>
        <button ref={zoomRef} type="button" className="mm-map-zoom" title="恢复 100%" aria-label="缩放比例，点击恢复 100%" onClick={() => centerOn(selected ?? rootId, 1)}>{Math.round(v.k * 100) + '%'}</button>
        <button type="button" className="mm-icon-btn" title="放大" aria-label="放大" onClick={() => zoomAt(1.2)}><Icon name="plus" /></button>
        <button type="button" className="mm-icon-btn" title="适应窗口" aria-label="适应窗口" onClick={fitAll}><Icon name="fit" /></button>
        <button type="button" className="mm-icon-btn" title="居中" aria-label="居中" onClick={() => centerOn(selected ?? rootId)}><Icon name="center" /></button>
      </div>
    </div>
  )
}

// ---------- layers ----------

function nodeClass(n: MapNode): string {
  return 'mm-map-node' + (n.depth === 0 ? ' mm-root' : n.depth === 1 ? ' mm-d1' : ' mm-dn') + branchCls(n) + (n.done ? ' mm-done' : '') + (n.ai !== null ? ' mm-ai-' + n.ai : '')
}

function Toggle(props: { n: MapNode }): ReactNode {
  const { n } = props
  const t = togglePos(n)
  return (
    <g className={'mm-map-toggle' + (n.collapsed ? '' : ' mm-open')} data-map-toggle={n.id} role="button" aria-label={n.collapsed ? '展开' : '折叠'}>
      <circle cx={t.cx} cy={t.cy} r={TOGGLE_R} />
      <text x={t.cx} y={t.cy}>{n.collapsed ? (n.hidden > 99 ? '99+' : String(n.hidden)) : '−'}</text>
    </g>
  )
}

function NodeView(props: { n: MapNode; editing: boolean }): ReactNode {
  const { n } = props
  const k = n.check !== null ? checkPos(n) : null
  return (
    <g className={nodeClass(n)} data-map-node={n.id}>
      {n.depth === 1 ? <rect className="mm-under" x={n.x} y={n.y} width={n.w} height={n.h} rx={6} /> : null}
      <rect className="mm-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={6} />
      {k !== null ? (n.check === true
        ? <><rect className="mm-map-check-on" x={k.x} y={k.y} width={12} height={12} rx={3} /><path className="mm-map-tick" d={tickPath(k.x, k.y)} /></>
        : <rect className="mm-map-check-off" x={k.x + 0.5} y={k.y + 0.5} width={11} height={11} rx={3} />) : null}
      {props.editing ? null : n.lines.map((line, i) => {
        const p = textPos(n, i)
        return <text key={i} x={p.x} y={p.y} xmlSpace="preserve">{line}</text>
      })}
      {n.aiTip !== null ? <title>{(n.clipped ? n.full + '\n\n' : '') + n.aiTip}</title> : n.clipped ? <title>{n.full}</title> : null}
      {n.depth > 0 && n.hasKids ? <Toggle n={n} /> : null}
    </g>
  )
}

/** All edges + nodes, culled to `cull` (map coordinates; null = everything). */
const NodeLayer = memo(function NodeLayer(props: { layout: MapLayout; cull: Rect | null; editingId: string | null }): ReactNode {
  const { layout, cull } = props
  const edges: ReactNode[] = []
  const items: ReactNode[] = []
  for (const n of layout.nodes) {
    if (n.parent !== null) {
      const p = layout.byId.get(n.parent)!
      if (cull === null || hits(Math.min(p.x, n.x), Math.min(p.y, n.y), Math.max(p.x + p.w, n.x + n.w), Math.max(p.y + p.h, n.y + n.h), cull)) {
        edges.push(<path key={'e' + n.id} className={'mm-map-edge' + branchCls(n) + (n.depth === 1 ? ' mm-taper' : '')} d={edgeFor(p, n)} />)
      }
    }
    if (cull !== null && !hits(n.x - STUB, n.y, n.x + n.w + STUB, n.y + n.h, cull)) continue
    items.push(<NodeView key={n.id} n={n} editing={props.editingId === n.id} />)
  }
  return <>{edges}{items}</>
})

function SelectionRing(props: { n: MapNode }): ReactNode {
  const { n } = props
  return (
    <g className={'mm-map-selection' + branchCls(n)} data-map-node={n.id}>
      <rect className="mm-map-selring" x={n.x - 3} y={n.y - 3} width={n.w + 6} height={n.h + 6} rx={8} />
      {n.depth > 0 && n.hasKids && !n.collapsed ? <Toggle n={n} /> : null}
    </g>
  )
}

function DropOverlay(props: { drop: DropView; layout: MapLayout }): ReactNode {
  const { drop, layout } = props
  const src = layout.byId.get(drop.id)
  const t = drop.target !== null ? layout.byId.get(drop.target) : undefined
  let mark: ReactNode = null
  if (t !== undefined) {
    const bad = drop.ok ? '' : ' mm-map-drop-bad'
    if (drop.pos === 'inside') mark = <rect className={'mm-map-drop-inside' + bad} x={t.x - 4} y={t.y - 4} width={t.w + 8} height={t.h + 8} rx={9} />
    else {
      const y = drop.pos === 'before' ? t.y - GAP_Y / 2 : t.y + t.h + GAP_Y / 2
      mark = <line className={'mm-map-drop-line' + bad} x1={t.x} y1={y} x2={t.x + t.w} y2={y} />
    }
  }
  return (
    <>
      {mark}
      {src !== undefined ? (
        <g className="mm-map-ghost" transform={'translate(' + (drop.mx + 10) + ',' + (drop.my + 10) + ')'}>
          <rect x={0} y={0} width={Math.min(src.w, 220)} height={34} rx={6} />
          <text x={12} y={17}>{(src.lines[0] ?? '').slice(0, 24)}</text>
        </g>
      ) : null}
    </>
  )
}

/** Box of the in-place editor, in map units. */
interface EditBox { id: string; x: number; w: number; h: number }

/** The node drawn at the editor's live size, with the selection ring around it. */
function EditBackdrop(props: { n: MapNode; box: EditBox }): ReactNode {
  const { n, box } = props
  const m: MapNode = { ...n, x: box.x, w: box.w, h: box.h }
  const k = m.check !== null ? checkPos(m) : null
  return (
    <g className={nodeClass(m) + ' mm-map-editing'} data-map-node={n.id}>
      {m.depth === 1 ? <rect className="mm-under" x={m.x} y={m.y} width={m.w} height={m.h} rx={6} /> : null}
      <rect className="mm-box" x={m.x} y={m.y} width={m.w} height={m.h} rx={6} />
      {k !== null ? (m.check === true
        ? <><rect className="mm-map-check-on" x={k.x} y={k.y} width={12} height={12} rx={3} /><path className="mm-map-tick" d={tickPath(k.x, k.y)} /></>
        : <rect className="mm-map-check-off" x={k.x + 0.5} y={k.y + 0.5} width={11} height={11} rx={3} />) : null}
      <rect className="mm-map-selring" x={m.x - 3} y={m.y - 3} width={m.w + 6} height={m.h + 6} rx={8} />
    </g>
  )
}

/**
 * In-place editor: a borderless, transparent textarea laid exactly over the
 * node's text, so typing happens inside the node's own box (drawn by
 * EditBackdrop, which grows with the text). No second frame.
 */
function MapEditor(props: {
  value: string; n: MapNode; view: View; measure: Measure
  elRef: { current: HTMLTextAreaElement | null }
  onBox(box: EditBox): void
  onChange(text: string): void; onCommit(back: boolean): void; onCancel(): void; onTab(): void
}): ReactNode {
  const { n } = props
  const ref = props.elRef
  const done = useRef(false)
  const root = n.depth === 0
  const size = root ? ROOT_FONT_SIZE : FONT_SIZE
  const indent = n.check !== null ? CHECK_W : 0
  // Width: the node's own width, grown to fit the longest typed line (capped like layout).
  let textW = 0
  for (const line of props.value.split('\n')) textW = Math.max(textW, props.measure(line, root, size))
  const w = Math.max(n.w, Math.ceil(Math.min(textW, MAX_TEXT_W)) + PAD_X * 2 + indent + 2)
  // Left-side branches grow leftwards, away from their parent.
  const x = n.depth > 0 && n.side < 0 ? n.x + n.w - w : n.x
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    if (end > 1) el.select(); else el.setSelectionRange(end, end)
    return () => { ref.current = null }
  }, [ref])
  const { onBox } = props
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    el.style.height = '0px'
    const h = Math.max(n.h, el.scrollHeight)
    el.style.height = h + 'px'
    onBox({ id: n.id, x, w, h })
  }, [props.value, n.id, n.h, x, w, ref, onBox])
  const finish = (fn: () => void): void => { if (done.current) return; done.current = true; fn() }
  const v = props.view
  return (
    <textarea ref={el => { ref.current = el }} className={'mm-map-edit' + (root ? ' mm-root-edit' : '')} rows={1} value={props.value} spellCheck={false} aria-label="编辑节点"
      data-nx={x} data-ny={n.y}
      style={{
        left: v.x + x * v.k, top: v.y + n.y * v.k, width: w, transform: 'scale(' + v.k + ')',
        padding: PAD_Y + 'px ' + PAD_X + 'px ' + PAD_Y + 'px ' + (PAD_X + indent) + 'px',
        lineHeight: n.lh + 'px', fontSize: size + 'px',
      }}
      onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
      onChange={e => props.onChange(e.target.value)}
      onBlur={e => {
        // Window lost focus (alt-tab, devtools): keep editing; focus comes back here.
        if (!document.hasFocus()) return
        // Focus moved somewhere else on purpose: commit, but do not pull focus back.
        const to = e.relatedTarget as Node | null
        const back = to === null || (e.currentTarget.parentElement?.contains(to) ?? false)
        finish(() => props.onCommit(back))
      }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(() => props.onCommit(true)) }
        else if (e.key === 'Escape') { e.preventDefault(); finish(props.onCancel) }
        else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); finish(props.onTab) }
      }} />
  )
}
