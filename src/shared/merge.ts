/**
 * Three-way merge of outline documents. Used when the document changed on
 * disk (typically an AI edit through the `mindmap` tool) while the user had
 * unsaved edits: `base` is the last version both sides share, `mine` the
 * local editor state, `theirs` the saved version.
 *
 * Rules, per node:
 * - fields (text, note, checked, collapsed, ai, sessions): the side that
 *   changed a field wins; if both changed it differently, mine wins and the
 *   field counts as a conflict;
 * - a node deleted on one side survives if the other side changed it, or if
 *   a surviving node is placed under it;
 * - parent: mine if mine moved the node, else theirs;
 * - sibling order: taken from the side that reordered, with the other side's
 *   new children inserted after their previous sibling.
 * Nodes left unreachable by conflicting moves are re-attached to the root, so
 * nothing is lost. The result carries theirs' revision so it can be saved
 * on top of the saved version.
 * @module dsh-mindmap/shared/merge
 */
import { parentMap, type OutlineDoc, type OutlineNode } from './model.ts'

export interface MergeResult {
  doc: OutlineDoc
  /** Fields both sides changed differently (mine was kept). */
  conflicts: number
}

const FIELDS = ['text', 'note', 'checked', 'collapsed', 'ai', 'sessions'] as const
type Field = typeof FIELDS[number]

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function contentChanged(n: OutlineNode, b: OutlineNode): boolean {
  return FIELDS.some(f => !same(n[f], b[f]))
}

/** Merge `mine` and `theirs`, both derived from `base`. */
export function mergeDocs(base: OutlineDoc, mine: OutlineDoc, theirs: OutlineDoc): MergeResult {
  let conflicts = 0
  const pick = <T>(b: T, m: T, t: T): T => {
    if (same(m, b)) return t
    if (!same(t, b) && !same(m, t)) conflicts++
    return m
  }
  const rootId = mine.rootId
  const pb = parentMap(base)
  const pm = parentMap(mine)
  const pt = parentMap(theirs)

  // Which nodes survive.
  const alive = new Set<string>()
  const ids = new Set([...Object.keys(mine.nodes), ...Object.keys(theirs.nodes)])
  for (const id of ids) {
    const m = mine.nodes[id]
    const t = theirs.nodes[id]
    const b = base.nodes[id]
    if (m !== undefined && t !== undefined) alive.add(id)
    else if (b === undefined) alive.add(id) // added on one side
    else if (contentChanged((m ?? t)!, b)) alive.add(id) // deleted on one side, changed on the other
  }
  alive.add(rootId)

  const parentOf = (id: string): string | undefined => {
    if (id === rootId) return undefined
    const inM = mine.nodes[id] !== undefined
    const inT = theirs.nodes[id] !== undefined
    if (inM && inT) return pm[id] !== pb[id] ? pm[id] : pt[id]
    return inM ? pm[id] : pt[id]
  }

  // A surviving node keeps its parent alive (resurrect deleted ancestors).
  const parent = new Map<string, string>()
  const queue = [...alive]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (id === rootId || parent.has(id)) continue
    let p = parentOf(id)
    if (p === undefined || (mine.nodes[p] === undefined && theirs.nodes[p] === undefined)) p = rootId
    parent.set(id, p)
    if (!alive.has(p)) { alive.add(p); queue.push(p) }
  }

  // Children lists.
  const kidsOf = new Map<string, string[]>()
  for (const [id, p] of parent) {
    const list = kidsOf.get(p)
    if (list === undefined) kidsOf.set(p, [id]); else list.push(id)
  }
  const orderFor = (p: string): string[] => {
    const assigned = new Set(kidsOf.get(p) ?? [])
    if (assigned.size === 0) return []
    const sm = mine.nodes[p]?.children
    const st = theirs.nodes[p]?.children
    const sb = base.nodes[p]?.children
    const mineReordered = sm !== undefined && !same(sm, sb)
    const primary = (mineReordered ? sm : st ?? sm) ?? []
    const secondary = (mineReordered ? st : sm) ?? []
    const out = primary.filter(id => assigned.has(id))
    const placed = new Set(out)
    for (let i = 0; i < secondary.length; i++) {
      const id = secondary[i]!
      if (!assigned.has(id) || placed.has(id)) continue
      let at = 0
      for (let j = i - 1; j >= 0; j--) {
        const k = out.indexOf(secondary[j]!)
        if (k >= 0) { at = k + 1; break }
      }
      out.splice(at, 0, id)
      placed.add(id)
    }
    for (const id of assigned) if (!placed.has(id)) out.push(id)
    return out
  }

  // Node bodies.
  const nodes: Record<string, OutlineNode> = {}
  for (const id of alive) {
    const m = mine.nodes[id]
    const t = theirs.nodes[id]
    const b = base.nodes[id]
    const node: OutlineNode = { id, text: '', children: orderFor(id) }
    for (const f of FIELDS) {
      const value = m !== undefined && t !== undefined
        ? (b !== undefined ? pick<unknown>(b[f], m[f], t[f]) : m[f])
        : (m ?? t)![f]
      if (value !== undefined) (node as unknown as Record<Field, unknown>)[f] = value
    }
    if (typeof node.text !== 'string') node.text = ''
    nodes[id] = node
  }

  // Re-attach anything a move cycle cut off from the root.
  const reached = new Set<string>()
  const walk = (start: string): void => {
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (reached.has(id)) continue
      reached.add(id)
      for (const k of nodes[id]!.children) stack.push(k)
    }
  }
  walk(rootId)
  for (const id of Object.keys(nodes)) {
    if (reached.has(id)) continue
    const p = parent.get(id)
    if (p !== undefined) nodes[p]!.children = nodes[p]!.children.filter(k => k !== id)
    nodes[rootId]!.children.push(id)
    parent.set(id, rootId)
    walk(id)
  }

  const doc: OutlineDoc = {
    ...theirs,
    title: pick(base.title, mine.title, theirs.title),
    nodes,
    rootId,
    revision: theirs.revision,
    updatedAt: Math.max(mine.updatedAt, theirs.updatedAt),
  }
  const view = pick(base.view, mine.view, theirs.view)
  if (view !== undefined) doc.view = view; else delete doc.view
  return { doc, conflicts }
}
