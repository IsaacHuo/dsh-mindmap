/**
 * Pure, immutable edit operations over an OutlineDoc. Both views call only
 * these, so the outline and the mind map can never disagree. Every op
 * returns a new document (structural sharing) — or the same object when the
 * edit is a no-op, which lets callers skip history/save for no-ops.
 * @module dsh-mindplan/shared/ops
 */
import { isInSubtree, newId, parentMap, type OutlineDoc, type OutlineNode, type TreeItem } from './model.ts'

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

function parentOf(doc: OutlineDoc, id: string): OutlineNode | undefined {
  for (const n of Object.values(doc.nodes)) if (n.children.includes(id)) return n
  return undefined
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
export function splitAt(doc: OutlineDoc, id: string, caret: number): EditResult {
  const n = node(doc, id)
  const parent = parentOf(doc, id)
  const checklist = typeof n.checked === 'boolean'
  const fresh = (text: string): OutlineNode => (checklist ? { id: newId(), text, children: [], checked: false } : { id: newId(), text, children: [] })
  if (parent === undefined) return insertChild(doc, id, 0)
  const at = parent.children.indexOf(id)
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
    // A leaf merges into the visible line above when that line is a leaf too
    // (e.g. the last child of an expanded previous sibling).
    if (n.children.length > 0 || prevVisibleId === undefined || prevVisibleId === parent.id) return null
    const above = doc.nodes[prevVisibleId]
    if (above === undefined || above.children.length > 0) return null
    const without = deleteNode(doc, id)
    return {
      doc: patch(without, [{ ...without.nodes[above.id]!, text: above.text + n.text }], []),
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

/** Alt+↑ / Alt+↓: swap with the neighbouring sibling. */
export function moveSibling(doc: OutlineDoc, id: string, delta: -1 | 1): OutlineDoc {
  const parent = parentOf(doc, id)
  if (parent === undefined) return doc
  const at = parent.children.indexOf(id)
  const to = at + delta
  if (to < 0 || to >= parent.children.length) return doc
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
  const created: OutlineNode[] = []
  const build = (item: TreeItem): string => {
    const id = newId()
    const n: OutlineNode = { id, text: item.text, children: [] }
    if (typeof item.checked === 'boolean') n.checked = item.checked
    created.push(n)
    n.children = item.children.map(build)
    return id
  }
  const ids = items.map(build)
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
  const order: string[] = []
  const walk = (pid: string): void => {
    for (const c of doc.nodes[pid]?.children ?? []) {
      order.push(c)
      if (!doc.nodes[c]?.collapsed) walk(c)
    }
  }
  walk(rootId)
  const at = order.indexOf(id)
  return { prev: at > 0 ? order[at - 1] : undefined, next: at >= 0 ? order[at + 1] : undefined }
}

export { parentMap }
