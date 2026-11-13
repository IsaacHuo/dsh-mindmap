/**
 * The single tree data model shared by the outline editor, the mind map and
 * the host store. Nodes live in a flat map; each node owns an ordered child-id
 * array. Ids are stable for the life of a node: moves, merges and undo never
 * re-key a node.
 * @module dsh-mindmap/shared/model
 */

/** One outline node. `checked`: undefined/null = plain node, boolean = checklist item. */
export interface OutlineNode {
  id: string
  text: string
  children: string[]
  collapsed?: boolean
  checked?: boolean | null
  /** Optional multi-line note shown under the text (Mubu-style description). */
  note?: string
}

/** Per-document view preferences (stored with the document). */
export interface DocView {
  /** Mind-map layout; default 'both'. */
  mapLayout?: 'right' | 'both'
}

/** A whole document. The root node is invisible; its children are the top level. */
export interface OutlineDoc {
  schema: 1
  id: string
  title: string
  rootId: string
  nodes: Record<string, OutlineNode>
  revision: number
  createdAt: number
  updatedAt: number
  view?: DocView
}

/** Library row for one document. */
export interface DocMeta {
  id: string
  title: string
  folderId: string | null
  favorite: boolean
  createdAt: number
  updatedAt: number
  trashedAt?: number
}

/** One flat folder. */
export interface Folder {
  id: string
  name: string
  createdAt: number
  /** Parent folder (nested folders); null/undefined = top level. */
  parentId?: string | null
}

/** The library index (documents are stored separately). */
export interface Library {
  schema: 1
  folders: Folder[]
  docs: DocMeta[]
}

/** A parsed import item (Markdown / OPML / paste). */
export interface TreeItem {
  text: string
  checked?: boolean | null
  note?: string
  children: TreeItem[]
}

/** Max nesting depth accepted on import (deeper input is rejected, not truncated). */
export const MAX_IMPORT_DEPTH = 200

/** Deepest nesting level of an item forest (1 = flat), computed without recursion. */
export function itemsDepth(items: readonly TreeItem[]): number {
  let max = 0
  const stack: Array<[readonly TreeItem[], number]> = [[items, 1]]
  while (stack.length > 0) {
    const [list, depth] = stack.pop()!
    for (const it of list) {
      if (depth > max) max = depth
      if (it.children.length > 0) stack.push([it.children, depth + 1])
    }
  }
  return max
}

/** Id shape accepted by the host routes. */
export const ID_RE = /^[a-z0-9-]{6,64}$/

/** Max title length. */
export const MAX_TITLE = 200

let counter = 0

/** A new stable, URL-safe id (time + counter + random). */
export function newId(): string {
  counter = (counter + 1) % 1296
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `${Date.now().toString(36)}-${counter.toString(36).padStart(2, '0')}${rand}`
}

/** Clamp and clean a document title. */
export function normalizeTitle(raw: unknown, fallback = '未命名文档'): string {
  const text = typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim() : ''
  return (text.length > 0 ? text : fallback).slice(0, MAX_TITLE)
}

/** Build a fresh document holding `items` (or one empty node when none). */
export function createDoc(title: string, now: number, items: TreeItem[] = [], id = newId()): OutlineDoc {
  const rootId = newId()
  const nodes: Record<string, OutlineNode> = {}
  nodes[rootId] = { id: rootId, text: '', children: [] }
  buildItems(nodes, rootId, items.length > 0 ? items : [{ text: '', children: [] }])
  return { schema: 1, id, title: normalizeTitle(title), rootId, nodes, revision: 0, createdAt: now, updatedAt: now }
}

/** One node built from an import item (no children yet). */
export function nodeFromItem(item: TreeItem): OutlineNode {
  const node: OutlineNode = { id: newId(), text: item.text, children: [] }
  if (typeof item.checked === 'boolean') node.checked = item.checked
  if (typeof item.note === 'string' && item.note.length > 0) node.note = item.note
  return node
}

/**
 * Materialize `items` as new nodes appended to `parentId`'s children (mutates
 * `nodes`; iterative so arbitrarily deep input cannot overflow the stack).
 * Returns the new top-level ids.
 */
export function buildItems(nodes: Record<string, OutlineNode>, parentId: string | null, items: readonly TreeItem[]): string[] {
  const top: string[] = []
  const stack: Array<[TreeItem, string[]]> = []
  for (let i = items.length - 1; i >= 0; i--) stack.push([items[i]!, top])
  const order: Array<[string, string[]]> = []
  while (stack.length > 0) {
    const [item, into] = stack.pop()!
    const node = nodeFromItem(item)
    nodes[node.id] = node
    order.push([node.id, into])
    for (let i = item.children.length - 1; i >= 0; i--) stack.push([item.children[i]!, node.children])
  }
  // pre-order traversal pushes each node after its parent and before later siblings
  for (const [id, into] of order) into.push(id)
  if (parentId !== null) nodes[parentId]!.children.push(...top)
  return top
}

/** Child → parent id map. */
export function parentMap(doc: OutlineDoc): Record<string, string> {
  const parents: Record<string, string> = {}
  for (const node of Object.values(doc.nodes)) for (const child of node.children) parents[child] = node.id
  return parents
}

/**
 * Structural invariant check: the root exists, every node is reachable from
 * the root exactly once (no cycles, no shared children, no orphans) and every
 * child reference resolves. Returns an error message, or null when valid.
 */
export function validateDoc(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'document is not an object'
  const doc = value as OutlineDoc
  if (doc.schema !== 1) return 'unsupported schema'
  if (typeof doc.id !== 'string' || !ID_RE.test(doc.id)) return 'invalid document id'
  if (typeof doc.title !== 'string') return 'invalid title'
  if (typeof doc.revision !== 'number' || !Number.isInteger(doc.revision) || doc.revision < 0) return 'invalid revision'
  if (typeof doc.nodes !== 'object' || doc.nodes === null) return 'invalid nodes'
  if (doc.view !== undefined && (typeof doc.view !== 'object' || doc.view === null)) return 'invalid view'
  const root = doc.nodes[doc.rootId]
  if (root === undefined) return 'root node missing'
  const seen = new Set<string>()
  const stack = [doc.rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) return `node ${id} is referenced more than once`
    seen.add(id)
    const node = doc.nodes[id]
    if (node === undefined) return `dangling child reference ${id}`
    if (node.id !== id) return `node key mismatch ${id}`
    if (typeof node.text !== 'string') return `node ${id} has no text`
    if (node.note !== undefined && typeof node.note !== 'string') return `node ${id} has an invalid note`
    if (!Array.isArray(node.children)) return `node ${id} has no children array`
    for (const child of node.children) {
      if (typeof child !== 'string') return `node ${id} has a non-string child`
      stack.push(child)
    }
  }
  const total = Object.keys(doc.nodes).length
  if (seen.size !== total) return `${total - seen.size} orphan node(s)`
  return null
}

/** Depth-first ids under `rootId` (excluded), honoring collapse when `visibleOnly`. */
export function flatten(doc: OutlineDoc, rootId: string, visibleOnly: boolean): Array<{ id: string; depth: number }> {
  const out: Array<{ id: string; depth: number }> = []
  const start = doc.nodes[rootId]
  if (start === undefined) return out
  const stack: Array<{ id: string; depth: number }> = []
  for (let i = start.children.length - 1; i >= 0; i--) stack.push({ id: start.children[i]!, depth: 0 })
  while (stack.length > 0) {
    const cur = stack.pop()!
    const c = doc.nodes[cur.id]
    if (c === undefined) continue
    out.push(cur)
    if (!visibleOnly || !c.collapsed) for (let i = c.children.length - 1; i >= 0; i--) stack.push({ id: c.children[i]!, depth: cur.depth + 1 })
  }
  return out
}

/** Ancestors of `id` from the root down (root first, `id` excluded). */
export function ancestors(doc: OutlineDoc, id: string): string[] {
  const parents = parentMap(doc)
  const chain: string[] = []
  let cur = parents[id]
  while (cur !== undefined) {
    chain.unshift(cur)
    cur = parents[cur]
  }
  return chain
}

/** Whether `id` lies in the subtree of `ancestorId` (inclusive). */
export function isInSubtree(doc: OutlineDoc, ancestorId: string, id: string): boolean {
  if (ancestorId === id) return true
  return ancestors(doc, id).includes(ancestorId)
}

/** Count nodes excluding the root. */
export function countNodes(doc: OutlineDoc): number {
  return Object.keys(doc.nodes).length - 1
}

/** Convert a subtree into plain import items (for copy / export). */
export function toItems(doc: OutlineDoc, ids: readonly string[]): TreeItem[] {
  const out: TreeItem[] = []
  const stack: Array<[string, TreeItem[]]> = []
  for (let i = ids.length - 1; i >= 0; i--) stack.push([ids[i]!, out])
  while (stack.length > 0) {
    const [id, into] = stack.pop()!
    const node = doc.nodes[id]
    if (node === undefined) continue
    const item: TreeItem = { text: node.text, children: [] }
    if (typeof node.checked === 'boolean') item.checked = node.checked
    if (typeof node.note === 'string' && node.note.length > 0) item.note = node.note
    into.push(item)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i]!, item.children])
  }
  return out
}
