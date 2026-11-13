/**
 * Pure, immutable edit operations over an OutlineDoc. Both views call only
 * these, so the outline and the mind map can never disagree. Every op
 * returns a new document (structural sharing) — or the same object when the
 * edit is a no-op, which lets callers skip history/save for no-ops.
 * @module dsh-mindmap/shared/ops
 */
import { buildItems, flatten, isInSubtree, newId, parentMap, type OutlineDoc, type OutlineNode, type TreeItem } from './model.ts'

/** Result of an op that moves the caret. */
export interface EditResult {
  doc: OutlineDoc
  focusId: string
  caret: number
}

/** Replace some nodes (and delete others) in a copy of the doc. */
function patch(doc: OutlineDoc, changed: OutlineNode[], removed: readonly string[] = []): OutlineDoc {
  const nodes = { ...doc.nodes }
  for (const id of removed) delete nodes[id]
  for (const node of changed) nodes[node.id] = node
  return { ...doc, nodes }
}

function node(doc: OutlineDoc, id: string): OutlineNode {
  const n = doc.nodes[id]
  if (n === undefined) throw new Error(`unknown node ${id}`)
  return n
}

// Parent maps are cached per immutable nodes object (every edit makes a new one).
const parentCache = new WeakMap<object, Record<string, string>>()

function parents(doc: OutlineDoc): Record<string, string> {
  let map = parentCache.get(doc.nodes)
  if (map === undefined) {
    map = parentMap(doc)
    parentCache.set(doc.nodes, map)
  }
  return map
}

function parentOf(doc: OutlineDoc, id: string): OutlineNode | undefined {
  const pid = parents(doc)[id]
  return pid === undefined ? undefined : doc.nodes[pid]
}

/** Parent id of 'id' (undefined for the root). */
export function parentIdOf(doc: OutlineDoc, id: string): string | undefined {
  return parents(doc)[id]
}

/** Drop ids whose ancestor is also in the list (keeps order). */
export function topLevelOf(doc: OutlineDoc, ids: readonly string[]): string[] {
  const set = new Set(ids)
  const map = parents(doc)
  return ids.filter(id => {
    let cur = map[id]
    while (cur !== undefined) {
      if (set.has(cur)) return false
      cur = map[cur]
    }
    return doc.nodes[id] !== undefined
  })
}

function subtreeIds(doc: OutlineDoc, id: string): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    out.push(cur)
    stack.push(...(doc.nodes[cur]?.children ?? []))
  }
  return out
}

/** Set a node's text. */
export function setText(doc: OutlineDoc, id: string, text: string): OutlineDoc {
  const n = node(doc, id)
  if (n.text === text) return doc
  return patch(doc, [{ ...n, text }])
}

/** Insert an empty (or given) node as a child of `parentId` at `index`. */
export function insertChild(doc: OutlineDoc, parentId: string, index: number, text = ''): EditResult {
  const parent = node(doc, parentId)
  const id = newId()
  const children = parent.children.slice()
  children.splice(Math.max(0, Math.min(index, children.length)), 0, id)
  return { doc: patch(doc, [{ ...parent, children, collapsed: false }, { id, text, children: [] }]), focusId: id, caret: 0 }
}

/** Insert an empty node right after `id` among its siblings. */
export function insertAfter(doc: OutlineDoc, id: string, text = ''): EditResult {
  const parent = parentOf(doc, id)
  if (parent === undefined) return insertChild(doc, id, 0, text)
  return insertChild(doc, parent.id, parent.children.indexOf(id) + 1, text)
}

/**
 * Enter at `caret` (outliner semantics):
 * - caret at 0 of a non-empty node → an empty sibling is inserted BEFORE, caret stays;
 * - caret at the end of an expanded node with children → new first child;
 * - otherwise the text after the caret moves into a new next sibling.
 * New checklist items inherit the checklist flag (unchecked).
 */
export function splitAt(doc: OutlineDoc, id: string, caret: number, floorId: string = doc.rootId): EditResult {
  const n = node(doc, id)
  const parent = parentOf(doc, id)
  const checklist = typeof n.checked === 'boolean'
  const fresh = (text: string): OutlineNode => (checklist ? { id: newId(), text, children: [], checked: false } : { id: newId(), text, children: [] })
  if (parent === undefined) return insertChild(doc, id, 0)
  const at = parent.children.indexOf(id)
  // Enter on an empty last child leaves the list level (outdent), like Mubu/Workflowy.
  if (n.text.length === 0 && n.children.length === 0 && parent.id !== floorId && at === parent.children.length - 1) {
    const out = outdent(doc, id, floorId)
    if (out !== doc) return { doc: out, focusId: id, caret: 0 }
  }
  if (caret <= 0 && n.text.length > 0) {
    const created = fresh('')
    const children = parent.children.slice()
    children.splice(at, 0, created.id)
    return { doc: patch(doc, [{ ...parent, children }, created]), focusId: id, caret: 0 }
  }
  const before = n.text.slice(0, caret)
  const after = n.text.slice(caret)
  const created = fresh(after)
  if (after.length === 0 && n.children.length > 0 && !n.collapsed) {
    return { doc: patch(doc, [{ ...n, children: [created.id, ...n.children] }, created]), focusId: created.id, caret: 0 }
  }
  const children = parent.children.slice()
  children.splice(at + 1, 0, created.id)
  return { doc: patch(doc, [{ ...parent, children }, { ...n, text: before }, created]), focusId: created.id, caret: 0 }
}

/** Tab: become the last child of the previous sibling. */
export function indent(doc: OutlineDoc, id: string): OutlineDoc {
  const parent = parentOf(doc, id)
  if (parent === undefined) return doc
  const at = parent.children.indexOf(id)
  if (at <= 0) return doc
  const prev = node(doc, parent.children[at - 1]!)
  return patch(doc, [
    { ...parent, children: parent.children.filter(c => c !== id) },
    { ...prev, children: [...prev.children, id], collapsed: false },
  ])
}

/** Shift+Tab: become the next sibling of the parent. `floorId` (focus root) is never left. */
export function outdent(doc: OutlineDoc, id: string, floorId: string = doc.rootId): OutlineDoc {
  const parent = parentOf(doc, id)
  if (parent === undefined || parent.id === floorId) return doc
  const grand = parentOf(doc, parent.id)
  if (grand === undefined) return doc
  const gChildren = grand.children.slice()
  gChildren.splice(gChildren.indexOf(parent.id) + 1, 0, id)
  return patch(doc, [{ ...parent, children: parent.children.filter(c => c !== id) }, { ...grand, children: gChildren }])
}

/** Remove a node and its whole subtree. */
export function deleteNode(doc: OutlineDoc, id: string): OutlineDoc {
  const parent = parentOf(doc, id)
  if (parent === undefined) return doc
  return patch(doc, [{ ...parent, children: parent.children.filter(c => c !== id) }], subtreeIds(doc, id))
}

/**
 * Backspace at caret 0. Returns null when nothing should happen.
 * - empty leaf → deleted, caret to the end of `prevVisibleId`;
 * - empty node with children → kept (never silently drop a subtree);
 * - text node whose previous sibling is a leaf or collapsed → text appended to
 *   that sibling, children re-parented after the sibling's own children.
 */
export function backspaceAtStart(doc: OutlineDoc, id: string, prevVisibleId: string | undefined): EditResult | null {
  const n = node(doc, id)
  const parent = parentOf(doc, id)
  if (parent === undefined) return null
  if (n.text.length === 0 && n.children.length === 0) {
    if (prevVisibleId === undefined) return null
    const next = deleteNode(doc, id)
    return { doc: next, focusId: prevVisibleId, caret: next.nodes[prevVisibleId]?.text.length ?? 0 }
  }
  const at = parent.children.indexOf(id)
  const prevSibling = at > 0 ? node(doc, parent.children[at - 1]!) : undefined
  if (prevSibling === undefined || (prevSibling.children.length > 0 && !prevSibling.collapsed)) {
    if (prevVisibleId === undefined) return null
    const above = doc.nodes[prevVisibleId]
    if (above === undefined || above.id === doc.rootId) return null
    if (above.id === parent.id) {
      // First child: merge into the parent line; own children take its place.
      const kids = parent.children.slice()
      kids.splice(at, 1, ...n.children)
      return { doc: patch(doc, [{ ...parent, text: parent.text + n.text, children: kids }], [id]), focusId: parent.id, caret: parent.text.length }
    }
    // Merge into the visible leaf above (e.g. last child of an expanded previous sibling).
    if (above.children.length > 0) return null
    const detached = patch(doc, [{ ...parent, children: parent.children.filter(c => c !== id) }], [id])
    return {
      doc: patch(detached, [{ ...above, text: above.text + n.text, children: n.children.slice(), collapsed: n.collapsed }]),
      focusId: above.id,
      caret: above.text.length,
    }
  }
  const prev = prevSibling
  const merged: OutlineNode = { ...prev, text: prev.text + n.text, children: [...prev.children, ...n.children] }
  return {
    doc: patch(doc, [merged, { ...parent, children: parent.children.filter(c => c !== id) }], [id]),
    focusId: prev.id,
    caret: prev.text.length,
  }
}

/** Delete at the end: pull the next sibling's text (and children) in when this node is a leaf. */
export function deleteAtEnd(doc: OutlineDoc, id: string): EditResult | null {
  const n = node(doc, id)
  const parent = parentOf(doc, id)
  if (parent === undefined || n.children.length > 0) return null
  const at = parent.children.indexOf(id)
  const nextId = parent.children[at + 1]
  if (nextId === undefined) return null
  const next = node(doc, nextId)
  return {
    doc: patch(doc, [{ ...n, text: n.text + next.text, children: next.children.slice(), collapsed: next.collapsed }, { ...parent, children: parent.children.filter(c => c !== nextId) }], [nextId]),
    focusId: id,
    caret: n.text.length,
  }
}

/** Drop position relative to a target node. */
export type DropPosition = 'before' | 'after' | 'inside'

/** Whether `id` may be moved relative to `targetId`. */
export function canMove(doc: OutlineDoc, id: string, targetId: string, position: DropPosition): boolean {
  if (id === doc.rootId || doc.nodes[id] === undefined || doc.nodes[targetId] === undefined) return false
  if (isInSubtree(doc, id, targetId)) return false
  if (position !== 'inside' && targetId === doc.rootId) return false
  return true
}

/** Move a subtree before/after/inside (as last child of) a target. */
export function moveNode(doc: OutlineDoc, id: string, targetId: string, position: DropPosition): OutlineDoc {
  if (!canMove(doc, id, targetId, position)) return doc
  const from = parentOf(doc, id)!
  const detached = patch(doc, [{ ...from, children: from.children.filter(c => c !== id) }])
  if (position === 'inside') {
    const target = node(detached, targetId)
    return patch(detached, [{ ...target, children: [...target.children, id], collapsed: false }])
  }
  const to = parentOf(detached, targetId)!
  const children = to.children.slice()
  children.splice(children.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, id)
  return patch(detached, [{ ...to, children }])
}

/**
 * Alt+↑ / Alt+↓: swap with the neighbouring sibling. At the first/last
 * position the node crosses into the parent's previous sibling (as its last
 * child) or next sibling (as its first child); floorId is never left.
 */
export function moveSibling(doc: OutlineDoc, id: string, delta: -1 | 1, floorId: string = doc.rootId): OutlineDoc {
  const parent = parentOf(doc, id)
  if (parent === undefined) return doc
  const at = parent.children.indexOf(id)
  const to = at + delta
  if (to < 0 || to >= parent.children.length) {
    if (parent.id === floorId) return doc
    const grand = parentOf(doc, parent.id)
    if (grand === undefined) return doc
    const uncleId = grand.children[grand.children.indexOf(parent.id) + delta]
    if (uncleId === undefined) return doc
    const uncle = node(doc, uncleId)
    return patch(doc, [
      { ...parent, children: parent.children.filter(c => c !== id) },
      { ...uncle, children: delta < 0 ? [...uncle.children, id] : [id, ...uncle.children], collapsed: false },
    ])
  }
  const children = parent.children.slice()
  children[at] = children[to]!
  children[to] = id
  return patch(doc, [{ ...parent, children }])
}

/** Collapse / expand. Leaves cannot collapse. */
export function setCollapsed(doc: OutlineDoc, id: string, collapsed: boolean): OutlineDoc {
  const n = node(doc, id)
  if (collapsed && n.children.length === 0) return doc
  if (Boolean(n.collapsed) === collapsed) return doc
  return patch(doc, [{ ...n, collapsed }])
}

/** Collapse or expand every node with children under `rootId`. */
export function setAllCollapsed(doc: OutlineDoc, rootId: string, collapsed: boolean): OutlineDoc {
  const changed: OutlineNode[] = []
  for (const id of subtreeIds(doc, rootId)) {
    if (id === rootId) continue
    const n = doc.nodes[id]!
    if (n.children.length > 0 && Boolean(n.collapsed) !== collapsed) changed.push({ ...n, collapsed })
  }
  return changed.length === 0 ? doc : patch(doc, changed)
}

/** Ctrl+Enter: toggle done (turns a plain node into a checked checklist item). */
export function toggleDone(doc: OutlineDoc, id: string): OutlineDoc {
  const n = node(doc, id)
  return patch(doc, [{ ...n, checked: n.checked !== true }])
}

/** Turn the checklist checkbox on or off for a node. */
export function toggleChecklist(doc: OutlineDoc, id: string): OutlineDoc {
  const n = node(doc, id)
  const next: OutlineNode = { ...n }
  if (typeof n.checked === 'boolean') delete next.checked
  else next.checked = false
  return patch(doc, [next])
}

/** Insert parsed items as siblings after `afterId` (or as children of `parentId` at `index`). */
export function insertItems(doc: OutlineDoc, items: readonly TreeItem[], where: { afterId: string } | { parentId: string; index: number }): EditResult {
  if (items.length === 0) throw new Error('no items')
  const fresh: Record<string, OutlineNode> = {}
  const ids = buildItems(fresh, null, items)
  const created = Object.values(fresh)
  let parent: OutlineNode
  let index: number
  if ('afterId' in where) {
    parent = parentOf(doc, where.afterId) ?? node(doc, doc.rootId)
    index = parent.children.indexOf(where.afterId) + 1
  } else {
    parent = node(doc, where.parentId)
    index = where.index
  }
  const children = parent.children.slice()
  children.splice(index, 0, ...ids)
  const last = created.find(c => c.id === ids[ids.length - 1])!
  return { doc: patch(doc, [...created, { ...parent, children, collapsed: false }]), focusId: last.id, caret: last.text.length }
}

/** Previous / next visible node ids in outline order (within `rootId`). */
export function neighbours(doc: OutlineDoc, rootId: string, id: string): { prev?: string; next?: string } {
  const order = flatten(doc, rootId, true).map(r => r.id)
  const at = order.indexOf(id)
  return { prev: at > 0 ? order[at - 1] : undefined, next: at >= 0 ? order[at + 1] : undefined }
}

/**
 * Paste parsed items into node 'id' replacing the selection [start, end):
 * the first item's text joins the text before the caret, its children go
 * first under that node, the remaining items become following siblings, and
 * the text after the caret is appended to the last pasted line.
 */
export function pasteItems(doc: OutlineDoc, id: string, start: number, end: number, items: readonly TreeItem[]): EditResult {
  if (items.length === 0) throw new Error('no items')
  const n = node(doc, id)
  const before = n.text.slice(0, start)
  const after = n.text.slice(end)
  const [first, ...rest] = items as [TreeItem, ...TreeItem[]]
  const fresh: Record<string, OutlineNode> = {}
  const kidIds = buildItems(fresh, null, first.children)
  const restIds = buildItems(fresh, null, rest)
  const head: OutlineNode = { ...n, text: before + first.text, children: [...kidIds, ...n.children] }
  if (n.text.length === 0) {
    if (typeof first.checked === 'boolean') head.checked = first.checked
    if (first.note !== undefined && first.note.length > 0 && (n.note ?? '').length === 0) head.note = first.note
  }
  if (kidIds.length > 0) head.collapsed = false
  const changed: OutlineNode[] = []
  let focusId = id
  let caret: number
  if (restIds.length === 0) {
    caret = head.text.length
    head.text += after
  } else {
    const lastId = restIds[restIds.length - 1]!
    const last = fresh[lastId]!
    caret = last.text.length
    fresh[lastId] = { ...last, text: last.text + after }
    const parent = parentOf(doc, id) ?? node(doc, doc.rootId)
    const children = parent.children.slice()
    children.splice(children.indexOf(id) + 1, 0, ...restIds)
    changed.push({ ...parent, children })
    focusId = lastId
  }
  changed.push(head, ...Object.values(fresh))
  return { doc: patch(doc, changed), focusId, caret }
}

/** Set (or clear with '') a node's note. */
export function setNote(doc: OutlineDoc, id: string, note: string): OutlineDoc {
  const n = node(doc, id)
  if ((n.note ?? '') === note) return doc
  const next: OutlineNode = { ...n }
  if (note.length === 0) delete next.note
  else next.note = note
  return patch(doc, [next])
}

/** Indent several nodes (visible order). A node stays when its previous sibling is a selected node that could not move. */
export function indentMany(doc: OutlineDoc, ids: readonly string[]): OutlineDoc {
  const top = topLevelOf(doc, ids)
  const stuck = new Set<string>()
  let cur = doc
  for (const id of top) {
    const parent = parentOf(cur, id)
    if (parent === undefined) { stuck.add(id); continue }
    const at = parent.children.indexOf(id)
    if (at <= 0 || stuck.has(parent.children[at - 1]!)) { stuck.add(id); continue }
    cur = indent(cur, id)
  }
  return cur
}

/** Outdent several nodes, keeping their relative order. */
export function outdentMany(doc: OutlineDoc, ids: readonly string[], floorId: string = doc.rootId): OutlineDoc {
  const top = topLevelOf(doc, ids)
  let cur = doc
  for (let i = top.length - 1; i >= 0; i--) cur = outdent(cur, top[i]!, floorId)
  return cur
}

/** Delete several subtrees. */
export function deleteMany(doc: OutlineDoc, ids: readonly string[]): OutlineDoc {
  let cur = doc
  for (const id of topLevelOf(doc, ids)) cur = deleteNode(cur, id)
  return cur
}

/** Move a contiguous block of selected siblings up/down by one; no-op for other shapes. */
export function moveMany(doc: OutlineDoc, ids: readonly string[], delta: -1 | 1, floorId: string = doc.rootId): OutlineDoc {
  const top = topLevelOf(doc, ids)
  if (top.length === 0) return doc
  if (top.length === 1) return moveSibling(doc, top[0]!, delta, floorId)
  const parent = parentOf(doc, top[0]!)
  if (parent === undefined || top.some(id => parentOf(doc, id) !== parent)) return doc
  const idx = top.map(id => parent.children.indexOf(id)).sort((a, b) => a - b)
  if (idx[idx.length - 1]! - idx[0]! !== idx.length - 1) return doc
  const from = idx[0]!
  const to = from + delta
  if (to < 0 || to + idx.length > parent.children.length) return doc
  const children = parent.children.slice()
  const block = children.splice(from, idx.length)
  children.splice(to, 0, ...block)
  return patch(doc, [{ ...parent, children }])
}

/** Apply a per-node op to several nodes. */
export function applyMany(doc: OutlineDoc, ids: readonly string[], op: (d: OutlineDoc, id: string) => OutlineDoc): OutlineDoc {
  let cur = doc
  for (const id of ids) if (cur.nodes[id] !== undefined) cur = op(cur, id)
  return cur
}

/** Set a document view preference. */
export function setView(doc: OutlineDoc, view: NonNullable<OutlineDoc['view']>): OutlineDoc {
  const next = { ...(doc.view ?? {}), ...view }
  if (JSON.stringify(next) === JSON.stringify(doc.view ?? {})) return doc
  return { ...doc, view: next }
}

export { parentMap }
