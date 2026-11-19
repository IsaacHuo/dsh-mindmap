/**
 * Mind-map layout and a standalone SVG serializer used for SVG / PNG export.
 * Two layouts: 'right' (root on the left, everything grows to the right) and
 * 'both' (depth-1 branches balanced greedily between the left and the right
 * side by subtree height). Layout is a pure function of the document, the
 * shown root, a text-measuring callback and the options; every pass is
 * iterative (explicit stacks / index order) so very deep documents cannot
 * overflow the call stack.
 * @module dsh-mindmap/client/mapLayout
 */
import type { OutlineDoc } from '../shared/model.ts'
import { plainText } from './plain.ts'

export const LINE_H = 20
export const ROOT_LINE_H = 24
export const FONT_SIZE = 14
export const ROOT_FONT_SIZE = 17
export const PAD_X = 12
export const PAD_Y = 7
export const MAX_TEXT_W = 260
/** Wrapped lines shown per node; the rest is ellipsized (full text in the tooltip). */
export const MAX_LINES = 6
export const GAP_X = 56
export const GAP_Y = 12
/** Horizontal room taken by the checklist box. */
export const CHECK_W = 18
/** Collapse badge: centre distance from the node border, and radius. */
export const TOGGLE_OFF = 10
export const TOGGLE_R = 8
/** Child edges of a node with a badge start beyond the badge. */
export const STUB = TOGGLE_OFF + TOGGLE_R

export type MapLayoutMode = 'right' | 'both'
export type Side = -1 | 1

export interface MapNode {
  id: string
  depth: number
  x: number
  y: number
  w: number
  h: number
  /** Displayed (wrapped, possibly ellipsized) lines. */
  lines: string[]
  /** Plain full text (tooltip when clipped). */
  full: string
  clipped: boolean
  parent: string | null
  /** Visible children in document order. */
  kids: string[]
  hasKids: boolean
  collapsed: boolean
  hidden: number
  done: boolean
  /** Checklist state: null = plain node. */
  check: boolean | null
  /** -1 = left of the root, 1 = right (the root itself is 1). */
  side: Side
  /** Index of the depth-1 ancestor among the root's children (-1 for the root). */
  branch: number
  /** Font size and line height of this node. */
  fs: number
  lh: number
}

export interface MapLayout {
  nodes: MapNode[]
  byId: Map<string, MapNode>
  width: number
  height: number
  mode: MapLayoutMode
}

export interface LayoutOptions {
  /** Default 'right' (backwards compatible). */
  layout?: MapLayoutMode
  /** Extra nodes shown collapsed (view-only, never written to the doc). */
  collapsedOverride?: ReadonlySet<string> | null
}

export type Measure = (text: string, bold: boolean, size?: number) => number

/** Canvas-based measure using the given font family (memoised per text). */
export function canvasMeasure(fontFamily: string): Measure {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = canvas?.getContext('2d') ?? null
  const cache = new Map<string, number>()
  let lastFont = ''
  return (text, bold, size = FONT_SIZE) => {
    if (ctx === null) return text.length * 8 * size / FONT_SIZE
    const key = (bold ? 'b' : 'n') + size + '|' + text
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const font = (bold ? '600 ' : '') + size + 'px ' + fontFamily
    if (font !== lastFont) { ctx.font = font; lastFont = font }
    const w = ctx.measureText(text).width
    if (cache.size > 50000) cache.clear()
    cache.set(key, w)
    return w
  }
}

const TOKEN_RE = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]|[^\s\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]+|\s+/g

/** Wrap a text into lines no wider than MAX_TEXT_W. */
export function wrap(text: string, measure: Measure, bold: boolean, size = FONT_SIZE): string[] {
  const out: string[] = []
  const m = (s: string): number => measure(s, bold, size)
  for (const para of plainText(text).split('\n')) {
    if (m(para) <= MAX_TEXT_W) { out.push(para); continue }
    let line = ''
    for (let token of para.match(TOKEN_RE) ?? []) {
      if (line.length > 0 && m(line + token) > MAX_TEXT_W) {
        out.push(line.trimEnd())
        line = ''
        token = token.trimStart()
      }
      if (m(line + token) <= MAX_TEXT_W) { line += token; continue }
      // A token wider than a whole line (long URL, no spaces): split by character.
      for (const ch of token) {
        if (m(line + ch) > MAX_TEXT_W && line.length > 0) { out.push(line); line = '' }
        line += ch
      }
    }
    out.push(line)
  }
  return out.length === 0 ? [''] : out
}

/** Keep at most `max` lines; the last kept line gets an ellipsis that fits. */
export function ellipsize(lines: string[], measure: Measure, bold: boolean, size = FONT_SIZE, max = MAX_LINES): { lines: string[]; clipped: boolean } {
  if (lines.length <= max) return { lines, clipped: false }
  const kept = lines.slice(0, max)
  const chars = Array.from(kept[max - 1]!.trimEnd())
  while (chars.length > 0 && measure(chars.join('') + '…', bold, size) > MAX_TEXT_W) chars.pop()
  kept[max - 1] = chars.join('') + '…'
  return { lines: kept, clipped: true }
}

/** Number of descendants of a node in the document (iterative). */
export function countDescendants(doc: OutlineDoc, id: string): number {
  let count = 0
  const stack = [...(doc.nodes[id]?.children ?? [])]
  while (stack.length > 0) {
    const c = stack.pop()!
    const n = doc.nodes[c]
    if (n === undefined) continue
    count++
    for (const g of n.children) stack.push(g)
  }
  return count
}

/** Lay out the visible tree under rootId. */
export function layoutMap(doc: OutlineDoc, rootId: string, rootLabel: string, measure: Measure, options: LayoutOptions = {}): MapLayout {
  const mode: MapLayoutMode = options.layout ?? 'right'
  const override = options.collapsedOverride ?? null
  const nodes: MapNode[] = []
  const byId = new Map<string, MapNode>()
  const kidIdx: number[][] = []
  const parentIdx: number[] = []

  // 1. Build (pre-order, explicit stack). Children are visited in order, so
  //    a node's index is always greater than its parent's.
  const stack: Array<{ id: string; depth: number; parent: number }> = [{ id: rootId, depth: 0, parent: -1 }]
  while (stack.length > 0) {
    const it = stack.pop()!
    const n = doc.nodes[it.id]
    if (n === undefined || byId.has(it.id)) continue
    const isRoot = it.depth === 0
    const fs = isRoot ? ROOT_FONT_SIZE : FONT_SIZE
    const lh = isRoot ? ROOT_LINE_H : LINE_H
    const label = isRoot ? rootLabel : n.text
    const { lines, clipped } = ellipsize(wrap(label.length > 0 ? label : ' ', measure, isRoot, fs), measure, isRoot, fs)
    const check = !isRoot && typeof n.checked === 'boolean' ? n.checked : null
    let textW = 24
    for (const l of lines) textW = Math.max(textW, measure(l, isRoot, fs))
    const w = Math.ceil(textW) + PAD_X * 2 + (check !== null ? CHECK_W : 0)
    const h = lines.length * lh + PAD_Y * 2
    const collapsed = !isRoot && n.children.length > 0 && (n.collapsed === true || (override !== null && override.has(it.id)))
    const idx = nodes.length
    const m: MapNode = {
      id: it.id, depth: it.depth, x: 0, y: 0, w, h, lines, full: plainText(label), clipped,
      parent: it.parent >= 0 ? nodes[it.parent]!.id : null, kids: [], hasKids: n.children.length > 0,
      collapsed, hidden: 0, done: n.checked === true, check, side: 1, branch: -1, fs, lh,
    }
    nodes.push(m)
    byId.set(it.id, m)
    kidIdx.push([])
    parentIdx.push(it.parent)
    if (it.parent >= 0) { kidIdx[it.parent]!.push(idx); nodes[it.parent]!.kids.push(it.id) }
    if (collapsed) m.hidden = countDescendants(doc, it.id)
    else for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i]!
      if (doc.nodes[c] !== undefined && !byId.has(c)) stack.push({ id: c, depth: it.depth + 1, parent: idx })
    }
  }
  const N = nodes.length
  if (N === 0) return { nodes, byId, width: 0, height: 0, mode }

  // 2. Subtree spans (post-order = reverse index order).
  const span = new Float64Array(N)
  const relTop = new Float64Array(N)
  const offs: number[][] = new Array<number[]>(N)
  const block = (kids: number[]): { o: number[]; K: number; c: number } => {
    const o: number[] = []
    let cur = 0
    for (const j of kids) { o.push(cur); cur += span[j]! + GAP_Y }
    if (kids.length === 0) return { o, K: 0, c: 0 }
    const a = kids[0]!
    const z = kids[kids.length - 1]!
    const ca = o[0]! + relTop[a]! + nodes[a]!.h / 2
    const cz = o[o.length - 1]! + relTop[z]! + nodes[z]!.h / 2
    return { o, K: cur - GAP_Y, c: (ca + cz) / 2 }
  }
  for (let i = N - 1; i >= 0; i--) {
    if (i === 0 && mode === 'both') continue
    const kids = kidIdx[i]!
    const h = nodes[i]!.h
    if (kids.length === 0) { span[i] = h; relTop[i] = 0; offs[i] = []; continue }
    const b = block(kids)
    let top = b.c - h / 2
    let shift = 0
    if (top < 0) { shift = -top; top = 0 }
    offs[i] = shift === 0 ? b.o : b.o.map(v => v + shift)
    relTop[i] = top
    span[i] = Math.max(top + h, shift + b.K)
  }

  // 3. Absolute positions (pre-order: parents before children).
  const subTop = new Float64Array(N)
  const root = nodes[0]!
  const rootKids = kidIdx[0]!
  rootKids.forEach((j, i) => { nodes[j]!.branch = i })
  if (mode === 'both') {
    // Greedy balance: biggest subtrees first onto the lighter side; each side
    // keeps document order top to bottom.
    const order = rootKids.slice().sort((a, b) => span[b]! - span[a]!)
    let tr = 0
    let tl = 0
    for (const j of order) {
      if (tr <= tl) { nodes[j]!.side = 1; tr += span[j]! + GAP_Y } else { nodes[j]!.side = -1; tl += span[j]! + GAP_Y }
    }
    for (const s of [1, -1] as const) {
      const ks = rootKids.filter(j => nodes[j]!.side === s)
      if (ks.length === 0) continue
      const b = block(ks)
      ks.forEach((j, i) => { subTop[j] = b.o[i]! - b.c })
    }
    root.y = -root.h / 2
  } else {
    root.y = relTop[0]!
    const o = offs[0]!
    rootKids.forEach((j, i) => { subTop[j] = o[i]! })
  }
  for (let i = 1; i < N; i++) {
    const m = nodes[i]!
    const p = nodes[parentIdx[i]!]!
    if (m.depth > 1) { m.side = p.side; m.branch = p.branch } else if (mode === 'right') m.side = 1
    m.y = subTop[i]! + relTop[i]!
    m.x = m.side > 0 ? p.x + p.w + GAP_X : p.x - GAP_X - m.w
    const kids = kidIdx[i]!
    const o = offs[i]!
    for (let j = 0; j < kids.length; j++) subTop[kids[j]!] = subTop[i]! + o[j]!
  }

  // 4. Normalise to a (0,0) origin, badges included.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of nodes) {
    let x0 = m.x
    let x1 = m.x + m.w
    if (m.depth > 0 && m.hasKids) { if (m.side > 0) x1 += STUB; else x0 -= STUB }
    if (x0 < minX) minX = x0
    if (x1 > maxX) maxX = x1
    if (m.y < minY) minY = m.y
    if (m.y + m.h > maxY) maxY = m.y + m.h
  }
  for (const m of nodes) { m.x -= minX; m.y -= minY }
  return { nodes, byId, width: maxX - minX, height: maxY - minY, mode }
}

/** Node border x where edges to children on `side` attach. */
const borderX = (p: MapNode, side: Side): number => (side > 0 ? p.x + p.w : p.x)

/** Thin edge from parent to child (horizontal cubic, starting beyond the parent's badge). */
export function edgePath(p: MapNode, c: MapNode): string {
  const s = c.side
  const y1 = p.y + p.h / 2
  const y2 = c.y + c.h / 2
  const xb = borderX(p, s)
  const x1 = p.depth > 0 ? xb + s * STUB : xb
  const x2 = s > 0 ? c.x : c.x + c.w
  const mx = (x1 + x2) / 2
  return (x1 !== xb ? 'M' + xb + ',' + y1 + ' H' + x1 : 'M' + x1 + ',' + y1) + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
}

/** Tapered filled edge (root → depth-1): wide at the root, thin at the child. */
export function taperPath(p: MapNode, c: MapNode, w0 = 4, w1 = 1): string {
  const s = c.side
  const x1 = borderX(p, s) - s * 2
  const y1 = p.y + p.h / 2
  const x2 = s > 0 ? c.x : c.x + c.w
  const y2 = c.y + c.h / 2
  const mx = (x1 + x2) / 2
  const f = (v: number): string => String(Math.round(v * 100) / 100)
  return 'M' + f(x1) + ',' + f(y1 - w0) + ' C' + f(mx) + ',' + f(y1 - w0) + ' ' + f(mx) + ',' + f(y2 - w1) + ' ' + f(x2) + ',' + f(y2 - w1) +
    ' L' + f(x2) + ',' + f(y2 + w1) + ' C' + f(mx) + ',' + f(y2 + w1) + ' ' + f(mx) + ',' + f(y1 + w0) + ' ' + f(x1) + ',' + f(y1 + w0) + ' Z'
}

/** Path for the edge into `c` (tapered for depth-1). */
export const edgeFor = (p: MapNode, c: MapNode): string => (c.depth === 1 ? taperPath(p, c) : edgePath(p, c))

/** Centre of a node's collapse badge. */
export const togglePos = (n: MapNode): { cx: number; cy: number } => ({ cx: n.side > 0 ? n.x + n.w + TOGGLE_OFF : n.x - TOGGLE_OFF, cy: n.y + n.h / 2 })

/** Checkbox origin (12×12) for a checklist node. */
export const checkPos = (n: MapNode): { x: number; y: number } => ({ x: n.x + PAD_X, y: n.y + PAD_Y + n.lh / 2 - 6 })

/** Tick inside a 12×12 box at (x, y). */
export const tickPath = (x: number, y: number): string => 'M' + (x + 2.5) + ',' + (y + 6.2) + ' L' + (x + 5) + ',' + (y + 8.7) + ' L' + (x + 9.5) + ',' + (y + 3.5)

/** First text baseline-centre and x for line i. */
export const textPos = (n: MapNode, i: number): { x: number; y: number } => ({ x: n.x + PAD_X + (n.check !== null ? CHECK_W : 0), y: n.y + PAD_Y + n.lh * i + n.lh / 2 })

// ---------- colours ----------

/** 8-colour branch palettes (edge stroke + node border; tint derived). */
export const BRANCH_LIGHT = ['#3964fe', '#f08c00', '#0ca678', '#e64980', '#7048e8', '#1098ad', '#e03131', '#66a80f'] as const
export const BRANCH_DARK = ['#7b9bff', '#ffc078', '#38d9a9', '#f783ac', '#9775fa', '#3bc9db', '#ff8787', '#a9e34b'] as const
export const TINT_LIGHT = 0.1
export const TINT_DARK = 0.2

export function branchColor(branch: number, dark: boolean): string {
  const p = dark ? BRANCH_DARK : BRANCH_LIGHT
  return p[((branch % p.length) + p.length) % p.length]!
}

/** #rrggbb + alpha → rgba(). */
export function rgba(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16)
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')'
}

export interface MapColors { bg: string; text: string; sub: string; border: string; accent: string; panel: string; card: string; font: string; dark?: boolean }

/** Light colours used when exporting onto a white background from a dark theme. */
export const LIGHT_COLORS: Omit<MapColors, 'font'> = { bg: '#ffffff', text: '#1f2329', sub: '#8a8f99', border: '#c9ccd1', accent: '#3964fe', panel: '#f7f7f8', card: '#ffffff', dark: false }

export type ExportBackground = 'transparent' | 'white' | 'theme'

export interface ExportOptions {
  /** Title drawn above the map; omit / null for none. */
  title?: string | null
  /** Default 'theme'. */
  background?: ExportBackground
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TITLE_H = 44

/** Standalone SVG document for export (all colours inlined, same visuals as the screen). */
export function mapToSvg(layout: MapLayout, colors: MapColors, opts: ExportOptions = {}): { svg: string; width: number; height: number } {
  const M = 32
  const bgMode = opts.background ?? 'theme'
  // A transparent export is usually pasted onto a light page: light-theme colours too.
  const c: MapColors = bgMode !== 'theme' && colors.dark === true ? { ...LIGHT_COLORS, font: colors.font } : colors
  const dark = c.dark === true
  const title = opts.title !== undefined && opts.title !== null && opts.title.trim() !== '' ? opts.title.trim() : null
  const titleH = title !== null ? TITLE_H : 0
  const width = Math.ceil(layout.width + M * 2)
  const height = Math.ceil(layout.height + M * 2 + titleH)
  const tint = dark ? TINT_DARK : TINT_LIGHT
  const parts: string[] = []
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" font-family="' + esc(c.font) + '" font-size="14">')
  if (bgMode !== 'transparent') parts.push('<rect width="100%" height="100%" fill="' + esc(bgMode === 'white' ? '#ffffff' : c.bg) + '"/>')
  if (title !== null) parts.push('<text x="' + M + '" y="' + (M + 10) + '" font-size="20" font-weight="600" dominant-baseline="central" fill="' + esc(c.text) + '" xml:space="preserve">' + esc(title) + '</text>')
  parts.push('<g transform="translate(' + M + ',' + (M + titleH) + ')">')
  for (const n of layout.nodes) {
    if (n.parent === null) continue
    const p = layout.byId.get(n.parent)!
    const bc = branchColor(n.branch, dark)
    if (n.depth === 1) parts.push('<path d="' + taperPath(p, n) + '" fill="' + bc + '"/>')
    else parts.push('<path d="' + edgePath(p, n) + '" fill="none" stroke="' + bc + '" stroke-width="1.5"/>')
  }
  for (const n of layout.nodes) {
    const root = n.depth === 0
    const bc = root ? c.accent : branchColor(n.branch, dark)
    const fill = root ? c.accent : n.depth === 1 ? rgba(bc, tint) : c.card
    const strokeAttrs = root ? ' stroke="' + esc(c.accent) + '"' : n.depth === 1 ? ' stroke="' + bc + '" stroke-width="1.5"' : ' stroke="' + bc + '" stroke-opacity="0.55"'
    const color = root ? '#ffffff' : n.done ? c.sub : c.text
    if (n.depth === 1 && bgMode === 'transparent') parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="6" fill="' + esc(c.card) + '"/>')
    parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="6" fill="' + esc(fill) + '"' + strokeAttrs + '/>')
    if (n.check !== null) {
      const k = checkPos(n)
      if (n.check) parts.push('<rect x="' + k.x + '" y="' + k.y + '" width="12" height="12" rx="3" fill="' + bc + '"/><path d="' + tickPath(k.x, k.y) + '" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>')
      else parts.push('<rect x="' + (k.x + 0.5) + '" y="' + (k.y + 0.5) + '" width="11" height="11" rx="3" fill="none" stroke="' + esc(c.sub) + '"/>')
    }
    n.lines.forEach((line, i) => {
      const t = textPos(n, i)
      parts.push('<text x="' + t.x + '" y="' + t.y + '" font-size="' + n.fs + '" dominant-baseline="central" fill="' + esc(color) + '"' + (root ? ' font-weight="600"' : '') + (n.done ? ' text-decoration="line-through"' : '') + ' xml:space="preserve">' + esc(line) + '</text>')
    })
    if (n.collapsed) {
      const t = togglePos(n)
      parts.push('<circle cx="' + t.cx + '" cy="' + t.cy + '" r="' + TOGGLE_R + '" fill="' + esc(c.card) + '" stroke="' + bc + '"/>')
      parts.push('<text x="' + t.cx + '" y="' + t.cy + '" font-size="10" text-anchor="middle" dominant-baseline="central" fill="' + esc(c.sub) + '">' + (n.hidden > 99 ? '99+' : n.hidden) + '</text>')
    }
  }
  parts.push('</g></svg>')
  return { svg: parts.join(''), width, height }
}

// ---------- PNG ----------

export const MAX_CANVAS_SIDE = 16384
export const MAX_CANVAS_AREA = 120_000_000

/** Whether a width×height image rasterises at `scale` within browser canvas limits. */
export function pngFits(width: number, height: number, scale = 2): boolean {
  const W = Math.ceil(width * scale)
  const H = Math.ceil(height * scale)
  return W <= MAX_CANVAS_SIDE && H <= MAX_CANVAS_SIDE && W * H <= MAX_CANVAS_AREA
}

/** Thrown by svgToPng when the image exceeds the canvas limits (suggest SVG instead). */
export class MapTooLargeError extends Error {
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    super('导图过大（' + width + '×' + height + '），无法导出 PNG，请改用 SVG')
    this.name = 'MapTooLargeError'
    this.width = width
    this.height = height
  }
}

/** Rasterise an SVG string to a PNG blob at the given scale. Throws MapTooLargeError when too big. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  if (!pngFits(width, height, scale)) throw new MapTooLargeError(Math.ceil(width * scale), Math.ceil(height * scale))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('图片渲染失败')); img.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(width * scale))
    canvas.height = Math.max(1, Math.ceil(height * scale))
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('无法创建画布')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b !== null ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Whether the host page is in its dark theme. */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined' || document.body === null) return false
  const v = document.body.getAttribute('data-ds-dark-theme')
  return v !== null && v !== 'false'
}

/** Resolve the theme colours from a mounted .mm-app element. */
export function themeColors(el: Element): MapColors {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--mm-bg', '#ffffff'),
    text: v('--mm-text', '#1f2329'),
    sub: v('--mm-sub', '#8a8f99'),
    border: v('--mm-border-strong', '#c9ccd1'),
    accent: v('--mm-accent', '#3964fe'),
    panel: v('--mm-panel', '#f7f7f8'),
    card: v('--mm-elev', '#ffffff'),
    font: cs.fontFamily || 'sans-serif',
    dark: isDarkTheme(),
  }
}

/** The doc's saved map layout (default 'right'). Tolerates docs without `view`. */
export function docMapLayout(doc: OutlineDoc): MapLayoutMode {
  const v = (doc as OutlineDoc & { view?: { mapLayout?: unknown } }).view
  return v?.mapLayout === 'both' ? 'both' : 'right'
}

/**
 * One-call export: lay out with the doc's saved layout and theme colours of
 * `el` (the mounted .mm-app), then serialise. Check `pngFits(width, height, scale)`
 * before rasterising.
 */
export function buildMapExport(doc: OutlineDoc, rootId: string, rootLabel: string, el: Element, opts: ExportOptions = {}): { svg: string; width: number; height: number } {
  const colors = themeColors(el)
  const layout = layoutMap(doc, rootId, rootLabel, canvasMeasure(colors.font), { layout: docMapLayout(doc) })
  return mapToSvg(layout, colors, opts)
}
