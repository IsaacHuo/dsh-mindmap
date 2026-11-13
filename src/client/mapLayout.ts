/**
 * Horizontal mind-map layout (root on the left, children to the right) and a
 * standalone SVG serializer used for SVG / PNG export. Layout is a pure
 * function of the document, the shown root and a text-measuring callback.
 * @module dsh-mindmap/client/mapLayout
 */
import type { OutlineDoc } from '../shared/model.ts'
import { plainText } from './plain.ts'

export const LINE_H = 20
export const PAD_X = 12
export const PAD_Y = 7
export const MAX_TEXT_W = 260
export const GAP_X = 56
export const GAP_Y = 12

export interface MapNode {
  id: string
  depth: number
  x: number
  y: number
  w: number
  h: number
  lines: string[]
  parent: string | null
  hasKids: boolean
  collapsed: boolean
  hidden: number
  done: boolean
}

export interface MapLayout {
  nodes: MapNode[]
  byId: Map<string, MapNode>
  width: number
  height: number
}

export type Measure = (text: string, bold: boolean) => number

/** Canvas-based measure using the given font family. */
export function canvasMeasure(fontFamily: string): Measure {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = canvas?.getContext('2d') ?? null
  return (text, bold) => {
    if (ctx === null) return text.length * 8
    ctx.font = (bold ? '600 ' : '') + '14px ' + fontFamily
    return ctx.measureText(text).width
  }
}

/** Wrap a text into lines no wider than MAX_TEXT_W. */
export function wrap(text: string, measure: Measure, bold: boolean): string[] {
  const out: string[] = []
  for (const para of plainText(text).split('\n')) {
    if (measure(para, bold) <= MAX_TEXT_W) { out.push(para); continue }
    let line = ''
    for (const token of para.match(/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]|[^\s\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]+|\s+/g) ?? []) {
      if (measure(line + token, bold) <= MAX_TEXT_W || line.length === 0) {
        if (measure(token, bold) > MAX_TEXT_W && line.length === 0) {
          for (const ch of token) {
            if (measure(line + ch, bold) > MAX_TEXT_W && line.length > 0) { out.push(line); line = '' }
            line += ch
          }
        } else line += token
      } else {
        out.push(line.trimEnd())
        line = token.trimStart()
      }
    }
    out.push(line)
  }
  return out.length === 0 ? [''] : out
}

/** Lay out the visible tree under rootId. */
export function layoutMap(doc: OutlineDoc, rootId: string, rootLabel: string, measure: Measure): MapLayout {
  const nodes: MapNode[] = []
  const byId = new Map<string, MapNode>()
  let maxX = 0
  const build = (id: string, depth: number, x: number, top: number, parent: string | null): number => {
    const n = doc.nodes[id]!
    const isRoot = depth === 0
    const label = isRoot ? rootLabel : n.text
    const lines = wrap(label.length > 0 ? label : ' ', measure, isRoot)
    const textW = Math.max(...lines.map(l => measure(l, isRoot)), 24)
    const w = Math.ceil(textW) + PAD_X * 2
    const h = lines.length * LINE_H + PAD_Y * 2
    const kids = isRoot || n.collapsed !== true ? n.children : []
    const m: MapNode = { id, depth, x, y: 0, w, h, lines, parent, hasKids: n.children.length > 0, collapsed: !isRoot && n.collapsed === true && n.children.length > 0, hidden: 0, done: n.checked === true }
    if (m.collapsed) {
      let count = 0
      const walk = (cid: string): void => { for (const c of doc.nodes[cid]?.children ?? []) { count++; walk(c) } }
      walk(id)
      m.hidden = count
    }
    nodes.push(m)
    byId.set(id, m)
    maxX = Math.max(maxX, x + w)
    const childX = x + w + GAP_X
    let cursor = top
    const centers: number[] = []
    for (const c of kids) {
      const used = build(c, depth + 1, childX, cursor, id)
      centers.push(byId.get(c)!.y + byId.get(c)!.h / 2)
      cursor += used + GAP_Y
    }
    const kidsSpan = kids.length > 0 ? cursor - GAP_Y - top : 0
    const span = Math.max(h, kidsSpan)
    const center = centers.length > 0 ? (centers[0]! + centers[centers.length - 1]!) / 2 : top + span / 2
    m.y = center - h / 2
    if (m.y < top) {
      // Taller than its children: push the children block down to centre it.
      const shift = top - m.y
      m.y = top
      const move = (cid: string): void => { const cm = byId.get(cid)!; cm.y += shift; for (const g of (cm.collapsed ? [] : doc.nodes[cid]!.children)) if (byId.has(g)) move(g) }
      for (const c of kids) move(c)
    }
    return Math.max(span, m.y + h - top)
  }
  const total = build(rootId, 0, 0, 0, null)
  return { nodes, byId, width: maxX, height: total }
}

/** Edge path from parent to child (horizontal cubic). */
export function edgePath(p: MapNode, c: MapNode): string {
  const x1 = p.x + p.w
  const y1 = p.y + p.h / 2
  const x2 = c.x
  const y2 = c.y + c.h / 2
  const mx = (x1 + x2) / 2
  return 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
}

export interface MapColors { bg: string; text: string; sub: string; border: string; accent: string; panel: string; card: string; font: string }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Standalone SVG document for export (all colours inlined). */
export function mapToSvg(layout: MapLayout, colors: MapColors): { svg: string; width: number; height: number } {
  const M = 32
  const width = Math.ceil(layout.width + M * 2 + 40)
  const height = Math.ceil(layout.height + M * 2)
  const parts: string[] = []
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" font-family="' + esc(colors.font) + '" font-size="14">')
  parts.push('<rect width="100%" height="100%" fill="' + esc(colors.bg) + '"/>')
  parts.push('<g transform="translate(' + M + ',' + M + ')">')
  for (const n of layout.nodes) {
    if (n.parent === null) continue
    parts.push('<path d="' + edgePath(layout.byId.get(n.parent)!, n) + '" fill="none" stroke="' + esc(colors.border) + '" stroke-width="1.5"/>')
  }
  for (const n of layout.nodes) {
    const root = n.depth === 0
    const fill = root ? colors.accent : n.depth === 1 ? colors.panel : colors.card
    const stroke = root ? colors.accent : colors.border
    const color = root ? '#ffffff' : n.done ? colors.sub : colors.text
    parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="6" fill="' + esc(fill) + '" stroke="' + esc(stroke) + '"/>')
    n.lines.forEach((line, i) => {
      parts.push('<text x="' + (n.x + PAD_X) + '" y="' + (n.y + PAD_Y + LINE_H * i + LINE_H / 2) + '" dominant-baseline="central" fill="' + esc(color) + '"' + (root ? ' font-weight="600"' : '') + (n.done ? ' text-decoration="line-through"' : '') + ' xml:space="preserve">' + esc(line) + '</text>')
    })
    if (n.collapsed) {
      const cx = n.x + n.w + 10
      const cy = n.y + n.h / 2
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="' + esc(colors.card) + '" stroke="' + esc(colors.border) + '"/>')
      parts.push('<text x="' + cx + '" y="' + cy + '" font-size="10" text-anchor="middle" dominant-baseline="central" fill="' + esc(colors.sub) + '">' + (n.hidden > 99 ? '99+' : n.hidden) + '</text>')
    }
  }
  parts.push('</g></svg>')
  return { svg: parts.join(''), width, height }
}

/** Rasterise an SVG string to a PNG blob at the given scale. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('图片渲染失败')); img.src = url })
    const max = 16000
    const s = Math.min(scale, max / width, max / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(width * s))
    canvas.height = Math.max(1, Math.floor(height * s))
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('无法创建画布')
    ctx.scale(s, s)
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b !== null ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
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
  }
}
