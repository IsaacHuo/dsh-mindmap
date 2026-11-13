/**
 * Pure helpers for the outline editor (no DOM, unit-tested): mark toggling,
 * visual-line caret logic, #tag filter rows and find/replace matching.
 * @module dsh-mindmap/client/outline/helpers
 */
import { flatten, type OutlineDoc } from '../../shared/model.ts'
import * as ops from '../../shared/ops.ts'

// ---------------------------------------------------------------- marks

/** Text + selection after a mark toggle. */
export interface MarkResult { text: string; start: number; end: number }

function runBefore(text: string, at: number, ch: string): number {
  let n = 0
  while (at - n - 1 >= 0 && text[at - n - 1] === ch) n++
  return n
}
function runAfter(text: string, at: number, ch: string): number {
  let n = 0
  while (at + n < text.length && text[at + n] === ch) n++
  return n
}

/** Whether a run of 'ch' of length n carries 'mark' (italic '*' = odd run, bold '**' = run >= 2). */
function carries(mark: string, n: number): boolean {
  if (mark === '*') return n % 2 === 1
  return n >= mark.length
}

/**
 * Toggle an inline mark ('**', '*', '~~', '`') around [start, end): unwraps when
 * the selection is already wrapped (marks just outside it, or included at
 * its edges), otherwise wraps (empty selection: inserts the pair, caret inside).
 */
export function toggleMark(text: string, start: number, end: number, mark: string): MarkResult {
  const ch = mark[0]!
  const m = mark.length
  // Marks just outside the selection.
  const b = runBefore(text, start, ch)
  const a = runAfter(text, end, ch)
  if (carries(mark, b) && carries(mark, a) && b >= m && a >= m) {
    return { text: text.slice(0, start - m) + text.slice(start, end) + text.slice(end + m), start: start - m, end: end - m }
  }
  // Marks included at the edges of the selection.
  if (end - start >= 2 * m) {
    const inner = text.slice(start, end)
    const ib = runAfter(inner, 0, ch)
    const ia = runBefore(inner, inner.length, ch)
    if (ib < inner.length && carries(mark, ib) && carries(mark, ia) && ib >= m && ia >= m) {
      return { text: text.slice(0, start) + inner.slice(m, inner.length - m) + text.slice(end), start, end: end - 2 * m }
    }
  }
  return { text: text.slice(0, start) + mark + text.slice(start, end) + mark + text.slice(end), start: start + m, end: end + m }
}

// ---------------------------------------------------------- visual lines

/** Layout of each caret offset 0..len (top/left in px, relative to the text box). */
export interface CaretBox { top: number; left: number }

/** Caret at 'caret' sits on the first visual line. */
export function onFirstLine(boxes: readonly CaretBox[], caret: number): boolean {
  const c = boxes[caret]
  const f = boxes[0]
  return c === undefined || f === undefined || c.top <= f.top + 1
}

/** Caret at 'caret' sits on the last visual line. */
export function onLastLine(boxes: readonly CaretBox[], caret: number): boolean {
  const c = boxes[caret]
  const l = boxes[boxes.length - 1]
  return c === undefined || l === undefined || c.top >= l.top - 1
}

/** Offset on the first or last visual line whose x is closest to 'x'. */
export function offsetAtX(boxes: readonly CaretBox[], line: 'first' | 'last', x: number): number {
  if (boxes.length === 0) return 0
  const top = line === 'first' ? boxes[0]!.top : boxes[boxes.length - 1]!.top
  let best = line === 'first' ? 0 : boxes.length - 1
  let bestD = Infinity
  for (let i = 0; i < boxes.length; i++) {
    const bx = boxes[i]!
    if (Math.abs(bx.top - top) > 1) continue
    const d = Math.abs(bx.left - x)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// ------------------------------------------------------------- tag filter

const TAG_RE = /(?:^|(?<=\s))#[^\s#]{1,40}/g

/** #tags in a text (with the leading '#'). */
export function tagsOf(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map(m => m[0])
}

/** Whether the node's text or note carries the tag (case-insensitive). */
export function hasTag(text: string, note: string | undefined, tag: string): boolean {
  const want = tag.toLowerCase()
  return tagsOf(text).some(t => t.toLowerCase() === want) || (note !== undefined && tagsOf(note).some(t => t.toLowerCase() === want))
}

/**
 * Rows shown while filtering by a tag: matching nodes plus their ancestors
 * (virtually expanded, the doc's collapse state is ignored). Ids in 'keep'
 * (the node being edited) stay visible too.
 */
export function filterRows(doc: OutlineDoc, rootId: string, tag: string, keep: readonly string[] = []): Array<{ id: string; depth: number }> {
  const all = flatten(doc, rootId, false)
  const show = new Set<string>()
  const mark = (id: string): void => {
    let cur: string | undefined = id
    while (cur !== undefined && cur !== rootId && !show.has(cur)) { show.add(cur); cur = ops.parentIdOf(doc, cur) }
  }
  for (const r of all) {
    const n = doc.nodes[r.id]!
    if (hasTag(n.text, n.note, tag)) mark(r.id)
  }
  const inRoot = new Set(all.map(r => r.id))
  for (const id of keep) if (inRoot.has(id)) mark(id)
  return all.filter(r => show.has(r.id))
}

// ---------------------------------------------------------- find/replace

/** One find match in a node's text or note. */
export interface FindMatch { id: string; field: 'text' | 'note'; start: number; end: number }

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Match ranges of 'query' in one string. */
export function matchRanges(text: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  if (query.length === 0) return []
  const re = new RegExp(escapeRe(query), caseSensitive ? 'gu' : 'giu')
  const out: Array<[number, number]> = []
  for (const m of text.matchAll(re)) if (m[0].length > 0) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  return out
}

/** All matches under rootId (collapsed subtrees included), in outline order, text before note. */
export function findMatches(doc: OutlineDoc, rootId: string, query: string, caseSensitive: boolean): FindMatch[] {
  const out: FindMatch[] = []
  if (query.length === 0) return out
  for (const r of flatten(doc, rootId, false)) {
    const n = doc.nodes[r.id]!
    for (const [s, e] of matchRanges(n.text, query, caseSensitive)) out.push({ id: r.id, field: 'text', start: s, end: e })
    if (n.note !== undefined) for (const [s, e] of matchRanges(n.note, query, caseSensitive)) out.push({ id: r.id, field: 'note', start: s, end: e })
  }
  return out
}

function replaceIn(text: string, ranges: ReadonlyArray<readonly [number, number]>, replacement: string): string {
  let out = text
  const sorted = [...ranges].sort((x, y) => y[0] - x[0])
  for (const [s, e] of sorted) out = out.slice(0, s) + replacement + out.slice(e)
  return out
}

/** Replace one match (no-op if the match is stale). */
export function replaceMatch(doc: OutlineDoc, m: FindMatch, replacement: string): OutlineDoc {
  const n = doc.nodes[m.id]
  if (n === undefined) return doc
  const src = m.field === 'text' ? n.text : (n.note ?? '')
  if (m.end > src.length) return doc
  const next = replaceIn(src, [[m.start, m.end]], replacement)
  return m.field === 'text' ? ops.setText(doc, m.id, next) : ops.setNote(doc, m.id, next)
}

/** Replace every match in one pass (a single new doc → one undo step). */
export function replaceAll(doc: OutlineDoc, matches: readonly FindMatch[], replacement: string): OutlineDoc {
  const by = new Map<string, Array<[number, number]>>()
  for (const m of matches) {
    const k = m.id + '\u0000' + m.field
    let list = by.get(k)
    if (list === undefined) { list = []; by.set(k, list) }
    list.push([m.start, m.end])
  }
  let cur = doc
  for (const [k, ranges] of by) {
    const [id, field] = k.split('\u0000') as [string, 'text' | 'note']
    const n = cur.nodes[id]
    if (n === undefined) continue
    if (field === 'text') cur = ops.setText(cur, id, replaceIn(n.text, ranges, replacement))
    else cur = ops.setNote(cur, id, replaceIn(n.note ?? '', ranges, replacement))
  }
  return cur
}

/** Ids (under rootId) that must be expanded to reveal 'id'. */
export function collapsedAncestors(doc: OutlineDoc, rootId: string, id: string): string[] {
  const out: string[] = []
  let cur = ops.parentIdOf(doc, id)
  while (cur !== undefined && cur !== rootId) {
    if (doc.nodes[cur]?.collapsed === true) out.push(cur)
    cur = ops.parentIdOf(doc, cur)
  }
  return out
}

// ------------------------------------------------------------ selection

/** Visible ids between anchor and head (inclusive, outline order). */
export function rangeIds(order: readonly string[], anchor: string, head: string): string[] {
  const a = order.indexOf(anchor)
  const h = order.indexOf(head)
  if (a === -1 || h === -1) return h === -1 ? [] : [head]
  return order.slice(Math.min(a, h), Math.max(a, h) + 1)
}

/** Custom clipboard MIME for exact node trees. */
export const NODES_MIME = 'application/x-dsh-mindmap+json'
